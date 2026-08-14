// scripts/test-firestore.mjs
//
// Firestore durability QA. Two halves:
//
//   OFFLINE (always runs) — encoding, and the behaviour that matters most:
//   what the compliance gate does when the datastore is UNREACHABLE. It must
//   block. A billing lapse, a suspended project, or a network partition can
//   never read as permission to call someone who opted out.
//
//   LIVE (runs only when FIREBASE_SERVICE_ACCOUNT is set) — round-trips real
//   documents against the real project: suppression, atomic dedupe, events.
//
// Run:  node --experimental-detect-module scripts/test-firestore.mjs
// Live: FIREBASE_SERVICE_ACCOUNT="$(cat .secrets/firebase-adminsdk.json)" node ...
//       (or put the same JSON in FIREBASE_SERVICE_ACCOUNT_LIVE)
//
// ⚠️ The live half WRITES to the real project. Every document it creates is
// named qa_probe/…-<timestamp> so it can be told apart from real traffic.

import assert from 'node:assert';
import crypto from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

// Captured BEFORE the offline half swaps in malformed credentials and then
// deletes the variable. Reading it later gets whatever the last offline test
// left behind, which is the bug that kept the live half from ever running.
const SERVICE_ACCOUNT_AT_STARTUP = process.env.FIREBASE_SERVICE_ACCOUNT || null;

let pass = 0, fail = 0, skipped = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function skip(name, why) { skipped++; console.log('  ⊘', name, `(${why})`); }
function section(s) { console.log(`\n${s}`); }

console.log('\n═══ FIRESTORE DURABILITY QA ═══');

// ---------------------------------------------------------------------------
section('value encoding (offline)');

const fsMod = await import(`${ROOT}/api/_lib/firestore.js`);

await t('scalars round-trip through the typed-value format', () => {
  const cases = [
    ['hello', 'stringValue'], [42, 'integerValue'], [3.5, 'doubleValue'],
    [true, 'booleanValue'], [null, 'nullValue'],
  ];
  for (const [v, kind] of cases) {
    const enc = fsMod.toValue(v);
    assert.ok(kind in enc, `${JSON.stringify(v)} should encode as ${kind}`);
    assert.deepEqual(fsMod.fromValue(enc), v);
  }
});

await t('nested maps and arrays round-trip', () => {
  const obj = { a: 1, b: { c: 'x', d: [1, 2, 3] }, e: [{ f: true }] };
  assert.deepEqual(fsMod.fromFields(fsMod.toFields(obj)), obj);
});

await t('undefined fields are dropped rather than encoded as null', () => {
  const fields = fsMod.toFields({ a: 1, b: undefined });
  assert.ok(!('b' in fields), 'undefined must not become a stored null');
});

// ---------------------------------------------------------------------------
section('the gate when the datastore is unreachable — THE critical case');

// A REAL keypair, so the JWT signs successfully and the failure happens where
// the scenario says it does — at the network — rather than in the crypto layer.
const { privateKey: realKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

await t('a Firestore outage BLOCKS the dial, it never allows it', async () => {
  // Exactly what a suspended project or a lapsed billing account looks like:
  // valid credentials, every request failing.
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: 'unreachable-project',
    client_email: 'x@example.com',
    private_key: realKey,
  });
  process.env.COMPLIANCE_MODE = 'strict';
  delete process.env.SUPPRESSION_LIST_URL;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  // Fresh module graph so the credential cache is not reused.
  const bust = `?t=${Date.now()}`;
  const compliance = await import(`${ROOT}/api/_lib/compliance.js${bust}`);
  const { normalizeLead } = await import(`${ROOT}/api/_lib/integrations/lead.js${bust}`);

  const lead = normalizeLead({ phone: '9876500123' }, {
    source: 'test',
    consent: { granted: true, basis: 'lead_form', at: new Date().toISOString() },
  });

  const gate = await compliance.checkDialable(lead, { ignoreWindow: true });
  globalThis.fetch = realFetch;

  assert.equal(gate.allowed, false, 'an unreachable datastore MUST block the dial');
  assert.match(gate.reason, /suppression_unverified|dnd_unverified/,
    `expected an unverified-block, got: ${gate.reason}`);
});

await t('an outage does not silently drop an opt-out — it reports non-durable', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

  const compliance = await import(`${ROOT}/api/_lib/compliance.js?t=${Date.now()}b`);
  const r = await compliance.addToSuppression('+919876500124', 'opt_out');
  globalThis.fetch = realFetch;

  assert.equal(r.durable, false, 'a failed write must report durable:false, not success');
});

await t('MALFORMED credentials block the dial rather than crashing the request', async () => {
  // This is what caught a real bug: accessToken() throws on an unparseable key,
  // and nothing caught it, so the gate crashed instead of returning "blocked".
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    project_id: 'p', client_email: 'x@example.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
  });
  const compliance = await import(`${ROOT}/api/_lib/compliance.js?t=${Date.now()}c`);
  const { normalizeLead } = await import(`${ROOT}/api/_lib/integrations/lead.js?t=${Date.now()}c`);
  const lead = normalizeLead({ phone: '9876500125' }, {
    source: 'test', consent: { granted: true, basis: 'lead_form', at: new Date().toISOString() },
  });

  let gate;
  try {
    gate = await compliance.checkDialable(lead, { ignoreWindow: true });
  } catch (err) {
    assert.fail(`the gate threw instead of deciding: ${err.message}`);
  }
  assert.equal(gate.allowed, false, 'malformed credentials must block');
});

delete process.env.FIREBASE_SERVICE_ACCOUNT;

// ---------------------------------------------------------------------------
section('live project (requires FIREBASE_SERVICE_ACCOUNT)');

// Accept the credential from EITHER variable. This used to read only
// FIREBASE_SERVICE_ACCOUNT_LIVE and copy it across — but the way this file
// documents itself is to pass the JSON in FIREBASE_SERVICE_ACCOUNT, which the
// offline half deletes above. So the documented invocation ran the live half
// against an empty credential, the store fell back to 'memory', and all five
// tests failed in a way that looked like a broken project rather than a broken
// harness. Which is to say: this half had never actually run.
const CREDENTIAL = looksLikeCredential(process.env.FIREBASE_SERVICE_ACCOUNT_LIVE)
  ? process.env.FIREBASE_SERVICE_ACCOUNT_LIVE
  : SERVICE_ACCOUNT_AT_STARTUP;

function looksLikeCredential(v) {
  if (typeof v !== 'string' || v.length < 32) return false;
  return v.trim().startsWith('{') || /^[A-Za-z0-9+/=\s]+$/.test(v.trim());
}

if (!CREDENTIAL) {
  skip('live round-trips', 'set FIREBASE_SERVICE_ACCOUNT to run');
} else {
  process.env.FIREBASE_SERVICE_ACCOUNT = CREDENTIAL;
  const store = await import(`${ROOT}/api/_lib/store.js?live=1`);
  const fsdb = await import(`${ROOT}/api/_lib/firestore.js?live=1`);
  const stamp = Date.now();

  // Everything this half writes is registered here and removed at the end.
  // A suite that leaves rows behind in a REAL project is not a neutral
  // observer: fake leads and fake events land in the operator console's funnel
  // and the numbers a human reads become part-fiction. (Found the hard way —
  // four runs left 60 probe documents in the live project.)
  const litter = [];
  const wrote = (collection, id) => { litter.push([collection, id]); return id; };

  await t('the store reports itself as durable and reachable', async () => {
    const s = await store.storeStatus();
    assert.equal(s.backend, 'firestore');
    assert.equal(s.reachable, true, `store unreachable: ${s.error}`);
    assert.ok(s.projectId, 'a project id should be reported');
  });

  await t('the persistence verifier writes, reads, and proves its probe was deleted', async () => {
    const verified = await store.verifyStorePersistence();
    assert.equal(verified.backend, 'firestore');
    assert.equal(verified.verified, true, `persistence was not certified: ${verified.error}`);
    assert.equal(verified.cleaned, true, 'the verifier must prove its temporary event was removed');
  });

  await t('a suppressed number reads back as suppressed', async () => {
    const phone = wrote('suppression', `+9199000${String(stamp).slice(-5)}`);
    const before = await store.isSuppressed(phone);
    assert.equal(before.suppressed, false);
    assert.equal(before.known, true, 'a reachable store must return known:true');

    const w = await store.suppress(phone, { reason: 'qa_probe' });
    assert.equal(w.durable, true);

    const after = await store.isSuppressed(phone);
    assert.equal(after.suppressed, true, 'the opt-out must survive the round trip');
    assert.ok(after.at, 'the suppression should carry a timestamp');
  });

  await t('suppression is idempotent — re-suppressing does not duplicate', async () => {
    const phone = wrote('suppression', `+9199001${String(stamp).slice(-5)}`);
    await store.suppress(phone, { reason: 'first' });
    await store.suppress(phone, { reason: 'second' });
    const r = await store.isSuppressed(phone);
    assert.equal(r.suppressed, true);
  });

  await t('lead dedupe is ATOMIC across instances', async () => {
    const lead = { id: wrote('leads', `qa:${stamp}`), source: 'qa', sourceId: String(stamp), phone: '+919876543210' };
    // Two concurrent claims, as two serverless instances would race.
    const [a, b] = await Promise.all([store.claimLead(lead), store.claimLead(lead)]);
    const created = [a, b].filter((r) => r.created).length;
    assert.equal(created, 1, `exactly one claim may win, got ${created}`);
  });

  await t('events append and read back newest-first', async () => {
    const e1 = await store.recordEvent('qa.probe', { stamp, n: 1 });
    const e2 = await store.recordEvent('qa.probe', { stamp, n: 2 });
    for (const e of [e1, e2]) if (e.id) wrote('events', e.id);
    const r = await store.recentEvents(20);
    assert.equal(r.ok, true, `query failed: ${r.error}`);
    assert.ok(r.docs.length >= 2, 'both events should be readable');
    // Newest first: the first doc's timestamp is >= the second's.
    if (r.docs.length >= 2) {
      assert.ok(r.docs[0].at >= r.docs[1].at, 'events must come back newest-first');
    }
  });

  await t('a call record survives the round trip, transcript and all', async () => {
    // The encoding most likely to break is the transcript: an array of maps,
    // nested inside a document, through Firestore's typed-value format. Proving
    // it offline against a double proves the double.
    const callId = wrote('calls', `qa_probe_call_${stamp}`);
    const history = [
      { role: 'agent', text: "Hi, I'm Anaga, an AI voice assistant from Vaak." },
      { role: 'user', text: 'Haan bolo — 3BHK, around 1.5 crore, buying in two months.' },
      { role: 'agent', text: 'Could I book you a site visit this weekend?' },
    ];
    const w = await store.recordCall(callId, {
      callId, disposition: 'booked', score: 87, band: 'hot',
      qualification: { purpose: 'end-use', budget: 'in-range' },
      transcript: history, turns: history.length,
      lead: { phoneMasked: '+9198XXXXXX78', crmRecordId: 'qa_probe' },
    });
    assert.equal(w.durable, true, `the call was not stored: ${w.error}`);

    const r = await store.getCall(callId);
    assert.equal(r.found, true, 'the call must be readable back');
    assert.deepEqual(r.data.transcript, history, 'the conversation must survive the encoding');
    assert.equal(r.data.score, 87);
    assert.equal(r.data.qualification.budget, 'in-range', 'nested maps must survive too');
    assert.ok(!JSON.stringify(r.data).includes('+919812345678'), 'no full number at rest');
  });

  await t('no composite index is required by any query this app runs', async () => {
    // The shapes the console and gate actually use. A 400 here means an index
    // is missing and the deploy would fail at runtime, not slowly.
    const a = await store.recentEvents(10);
    const b = await store.recentSuppressions(10);
    const c = await store.recentCalls(10);
    for (const [name, r] of [['events', a], ['suppressions', b], ['calls', c]]) {
      assert.equal(r.ok, true, `${name} query needs an index: ${r.error}`);
    }
  });

  await t('the suite leaves the project as it found it', async () => {
    const failed = [];
    for (const [collection, id] of litter) {
      const r = await fsdb.deleteDoc(collection, id);
      if (!r.ok) failed.push(`${collection}/${id}: ${r.error}`);
    }
    assert.deepEqual(failed, [], `probe documents left behind:\n  ${failed.join('\n  ')}`);

    // Prove it, rather than trusting a 200 — Firestore answers 200 for a
    // delete that matched nothing, which is exactly how an earlier cleanup
    // appeared to work while removing nothing at all.
    for (const [collection, id] of litter) {
      if (collection === 'calls') {
        const still = await store.getCall(id);
        assert.equal(still.found, false, `${collection}/${id} survived the delete`);
      }
      if (collection === 'suppression') {
        const still = await store.isSuppressed(id);
        assert.equal(still.suppressed, false, `${collection}/${id} survived the delete`);
      }
    }
  });
}

console.log(`\n═══ ${pass} passed, ${fail} failed, ${skipped} skipped ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
