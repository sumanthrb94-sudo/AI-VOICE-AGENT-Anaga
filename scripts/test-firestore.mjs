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

import assert from 'node:assert';
import crypto from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

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

const LIVE = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_LIVE);
if (!LIVE) {
  skip('live round-trips', 'set FIREBASE_SERVICE_ACCOUNT_LIVE to run');
} else {
  process.env.FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT_LIVE;
  const store = await import(`${ROOT}/api/_lib/store.js?live=1`);
  const stamp = Date.now();

  await t('the store reports itself as durable and reachable', async () => {
    const s = await store.storeStatus();
    assert.equal(s.backend, 'firestore');
    assert.equal(s.reachable, true, `store unreachable: ${s.error}`);
    assert.ok(s.projectId, 'a project id should be reported');
  });

  await t('a suppressed number reads back as suppressed', async () => {
    const phone = `+9199000${String(stamp).slice(-5)}`;
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
    const phone = `+9199001${String(stamp).slice(-5)}`;
    await store.suppress(phone, { reason: 'first' });
    await store.suppress(phone, { reason: 'second' });
    const r = await store.isSuppressed(phone);
    assert.equal(r.suppressed, true);
  });

  await t('lead dedupe is ATOMIC across instances', async () => {
    const lead = { id: `qa:${stamp}`, source: 'qa', sourceId: String(stamp), phone: '+919876543210' };
    // Two concurrent claims, as two serverless instances would race.
    const [a, b] = await Promise.all([store.claimLead(lead), store.claimLead(lead)]);
    const created = [a, b].filter((r) => r.created).length;
    assert.equal(created, 1, `exactly one claim may win, got ${created}`);
  });

  await t('events append and read back newest-first', async () => {
    await store.recordEvent('qa.probe', { stamp, n: 1 });
    await store.recordEvent('qa.probe', { stamp, n: 2 });
    const r = await store.recentEvents(20);
    assert.equal(r.ok, true, `query failed: ${r.error}`);
    assert.ok(r.docs.length >= 2, 'both events should be readable');
    // Newest first: the first doc's timestamp is >= the second's.
    if (r.docs.length >= 2) {
      assert.ok(r.docs[0].at >= r.docs[1].at, 'events must come back newest-first');
    }
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
}

console.log(`\n═══ ${pass} passed, ${fail} failed, ${skipped} skipped ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
