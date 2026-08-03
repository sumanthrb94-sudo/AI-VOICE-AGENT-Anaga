// scripts/test-e2e.mjs
//
// END-TO-END QA. Drives the ENTIRE product path in one process, through the
// real handlers and the real caller-agent session — no re-implementations:
//
//   signed Meta webhook
//     -> Graph lead fetch (stubbed transport, real mapping code)
//     -> normalize -> compliance gate -> CRM upsert -> dial job
//     -> caller agent verifies the signature, re-checks the calling window
//     -> disclosure -> turn loop -> outcome
//     -> /api/calls/outcome -> suppression list + CRM writeback
//     -> operator console summary reflects it
//
// The only things faked are the network edges we genuinely do not own: the
// Meta Graph API, the LLM, the CRM, and the phone network. Every line of OUR
// logic runs for real.
//
// Run: node --experimental-detect-module scripts/test-e2e.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

// ---------------------------------------------------------------------------
// environment: a deployment configured to actually dial
// ---------------------------------------------------------------------------
const KEY = 'e2e-integrations-key-0000000000';
const QUEUE_SECRET = 'e2e-dial-queue-secret';
const APP_SECRET = 'e2e-meta-app-secret';

process.env.INTEGRATIONS_API_KEY = KEY;
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_VERIFY_TOKEN = 'e2e-verify';
process.env.META_PAGE_ACCESS_TOKEN = 'e2e-page-token';
process.env.DIAL_QUEUE_SECRET = QUEUE_SECRET;
process.env.DIAL_QUEUE_URL = 'http://queue.invalid/jobs';   // intercepted below
process.env.DND_SCRUB_URL = 'http://dnd.invalid/scrub';
process.env.DND_SCRUB_API_KEY = 'e2e-dnd-key';
process.env.SUPPRESSION_LIST_URL = 'http://dnc.invalid/list';
process.env.CRM_PROVIDER = 'webhook';
process.env.CRM_WEBHOOK_URL = 'http://crm.invalid/hook';
process.env.CRM_WEBHOOK_SECRET = 'e2e-crm-secret';
process.env.OUTBOUND_CALLER_ID = '+911600000000';
process.env.COMPLIANCE_MODE = 'strict';       // the real gate, not dev mode
process.env.VAAK_API_BASE_URL = 'http://vaak.invalid';
process.env.TELEPHONY_PROVIDER = 'mock';
process.env.BRAIN_OUTCOME_RETRIES = '1';      // keep the suite fast

// ---------------------------------------------------------------------------
// fake network edges — everything else is real code
// ---------------------------------------------------------------------------
const world = {
  dnd: new Set(),                 // numbers registered DND
  suppressed: new Set(),          // our do-not-call list (durable store)
  crmEvents: [],                  // what the CRM webhook received
  queuedJobs: [],                 // what the API handed to the dial queue
  llmDown: false,
  crmDown: false,
  suppressionDown: false,
  turnScript: null,               // (history) => { say, end, disposition }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  const json = (status, data) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  // --- Meta Graph: return a realistic lead record ------------------------
  if (u.startsWith('https://graph.facebook.com/')) {
    const id = decodeURIComponent(u.split('/').pop().split('?')[0]);
    return json(200, {
      id,
      created_time: new Date().toISOString(),
      platform: 'facebook',
      campaign_name: 'Skyline Villaments — Aug',
      ad_id: 'ad_1', form_id: 'form_1',
      field_data: [
        { name: 'full_name', values: [world.leadName || 'Ravi Kumar'] },
        { name: 'phone_number', values: [world.leadPhone || '+919876543210'] },
        { name: 'what_is_your_budget?', values: ['1-2 Cr'] },
        { name: 'preferred_bhk', values: ['3BHK'] },
      ],
    });
  }

  // --- DND registry ------------------------------------------------------
  if (u.startsWith('http://dnd.invalid/')) {
    const phone = new URL(u).searchParams.get('phone');
    return json(200, { dnd: world.dnd.has(phone) });
  }

  // --- suppression list --------------------------------------------------
  if (u.startsWith('http://dnc.invalid/')) {
    if (world.suppressionDown) return json(500, { error: 'down' });
    if (opts.method === 'POST') { world.suppressed.add(body.phone); return json(200, { ok: true }); }
    const phone = new URL(u).searchParams.get('phone');
    return json(200, { suppressed: world.suppressed.has(phone) });
  }

  // --- CRM webhook -------------------------------------------------------
  if (u.startsWith('http://crm.invalid/')) {
    if (world.crmDown) return json(503, { error: 'crm_down' });
    // Verify OUR signature the way a real consumer would.
    const sig = opts.headers?.['X-Vaak-Signature-256'] || '';
    const expect = 'sha256=' + crypto.createHmac('sha256', 'e2e-crm-secret').update(opts.body).digest('hex');
    assert.equal(sig, expect, 'CRM webhook signature must verify');
    world.crmEvents.push(body);
    return json(200, { recordId: 'crm-' + world.crmEvents.length });
  }

  // --- dial queue: capture the job AND verify its signature --------------
  if (u.startsWith('http://queue.invalid/')) {
    const sig = opts.headers?.['X-Vaak-Signature-256'] || '';
    const expect = 'sha256=' + crypto.createHmac('sha256', QUEUE_SECRET).update(opts.body).digest('hex');
    assert.equal(sig, expect, 'dial job must be signed with DIAL_QUEUE_SECRET');
    world.queuedJobs.push({ job: body, raw: opts.body, signature: sig });
    return json(200, { callId: 'queued-' + world.queuedJobs.length });
  }

  // --- the Vaak API, called by the caller agent --------------------------
  if (u.startsWith('http://vaak.invalid/api/anaga/turn')) {
    if (world.llmDown) return json(503, { error: 'llm_unavailable' });
    return json(200, world.turnScript(body.history));
  }
  if (u.startsWith('http://vaak.invalid/api/calls/outcome')) {
    assert.equal(opts.headers?.Authorization, `Bearer ${KEY}`, 'outcome must be authenticated');
    const res = mkRes();
    await outcomeHandler({ method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body }, res);
    return json(res.statusCode, res.body);
  }

  if (u.startsWith('https://generativelanguage.googleapis.com/')) {
    return json(503, { error: 'no key in e2e' });
  }
  return realFetch(url, opts);
};

// ---------------------------------------------------------------------------
// real modules under test
// ---------------------------------------------------------------------------
const metaHandler    = (await import(`${ROOT}/api/integrations/meta/leads.js`)).default;
const outcomeHandler = (await import(`${ROOT}/api/calls/outcome.js`)).default;
const summaryHandler = (await import(`${ROOT}/api/console/summary.js`)).default;
const intakeHandler  = (await import(`${ROOT}/api/leads/intake.js`)).default;
const { handleJob, verifyJobSignature, validateJob, withinCallingWindow } =
  await import(`${ROOT}/caller-agent/src/server.js`);
const { createMockTelephony } = await import(`${ROOT}/caller-agent/src/providers/telephony/mock.js`);
const { detectOptOut } = await import(`${ROOT}/caller-agent/src/optout.js`);

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
function mkRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

/** Fire a properly-signed Meta leadgen webhook, as Meta would. */
async function fireMetaWebhook(leadgenId = 'lead_' + Math.random().toString(36).slice(2)) {
  const payload = {
    object: 'page',
    entry: [{
      id: 'PAGE_1', time: Math.floor(Date.now() / 1000),
      changes: [{ field: 'leadgen', value: {
        leadgen_id: leadgenId, page_id: 'PAGE_1', form_id: 'form_1',
        created_time: Math.floor(Date.now() / 1000),
      } }],
    }],
  };
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  const res = mkRes();
  await metaHandler({
    method: 'POST',
    headers: { 'x-hub-signature-256': sig },
    body: payload,
    rawBody: raw,
  }, res);
  return res;
}

/** Run the queued job through the REAL caller agent with a scripted prospect. */
async function runQueuedCall(job, mockOpts) {
  return handleJob({ ...job, _mock: mockOpts });
}

const HAPPY_PATH = (history) => {
  const asked = history.filter((h) => h.role === 'agent').length;
  if (asked >= 5) return { say: 'Perfect — booked for Saturday. Thank you!', end: true, disposition: 'booked' };
  return { say: `Question ${asked}: tell me more?`, end: false, disposition: 'qualifying' };
};

// ===========================================================================
console.log('\n═══ VAAK END-TO-END QA ═══');

// --- 0. preflight ----------------------------------------------------------
section('0. preflight');
await t('the calling window is open (suite requires it)', () => {
  if (!withinCallingWindow()) {
    throw new Error(`outside 09:00-21:00 IST — the E2E dial path cannot be exercised right now. `
      + `This is correct behaviour, not a bug. Set CALLING_WINDOW_START_IST=0 CALLING_WINDOW_END_IST=24 to force.`);
  }
});

// --- 1. happy path: Meta lead all the way to a booked site visit -----------
section('1. happy path — Meta lead to booked site visit');
world.turnScript = HAPPY_PATH;
world.leadPhone = '+919876500001';
world.leadName = 'Ravi Kumar';

let happyJob = null;
await t('signed Meta webhook is accepted and the lead reaches the dial queue', async () => {
  const before = world.queuedJobs.length;
  const res = await fireMetaWebhook();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 1);
  assert.equal(world.queuedJobs.length, before + 1, 'a dial job should have been queued');
  happyJob = world.queuedJobs.at(-1).job;
});

await t('the dial job carries the gate verdict that authorized it', () => {
  assert.equal(happyJob.compliance.allowed, true);
  assert.equal(happyJob.compliance.checks.dnd, true);
  assert.equal(happyJob.compliance.checks.suppression, true);
  assert.equal(happyJob.lead.phone, '+919876500001');
  assert.equal(happyJob.telephony.callerId, '+911600000000');
});

await t('the form answers ride along so Anaga skips what she already knows', () => {
  assert.equal(happyJob.lead.known.budget, '1-2 Cr');
  assert.equal(happyJob.lead.known.configuration, '3BHK');
});

await t('the CRM received lead.received before the call', () => {
  assert.ok(world.crmEvents.some((e) => e.event === 'lead.received'));
});

let happyResult = null;
await t('the caller agent runs the call and books', async () => {
  happyResult = await runQueuedCall(happyJob, {
    outcome: 'answered',
    replies: ['Yes, I have a minute.', 'To live in.', 'Around 2 crore.', '3BHK.', 'Saturday works.'],
  });
  assert.equal(happyResult.disposition, 'booked');
  assert.equal(happyResult.endReason, 'agent_ended');
  assert.equal(happyResult.reported, true);
});

await t('DISCLOSURE was the first thing said on the call', () => {
  const first = happyResult.history.find((h) => h.role === 'agent');
  assert.match(first.text, /\bAI\b/i, `first line must disclose AI, got: ${first.text}`);
});

await t('the outcome reached the CRM with a review', () => {
  const done = world.crmEvents.filter((e) => e.event === 'call.completed');
  assert.ok(done.length >= 1);
  assert.equal(done.at(-1).review.disposition, 'booked');
});

// --- 2. opt-out: the path that must never fail ----------------------------
section('2. opt-out — the path that must never fail');
world.leadPhone = '+919876500002';
world.leadName = 'Priya Sharma';

const OPT_OUT_UTTERANCES = [
  'please remove me from your list',                 // English
  'do not call me again',                            // English
  'mujhe call mat karo',                             // romanized Hindi
  'naaku interest ledu, call cheyyakandi',           // romanized Telugu
  'कॉल मत करो',                                       // Devanagari
  'ఇష్టం లేదు',                                        // Telugu script
];

for (const utterance of OPT_OUT_UTTERANCES) {
  await t(`detector catches: "${utterance}"`, () => {
    assert.equal(detectOptOut(utterance).optOut, true);
  });
}

await t('a question about opting out is NOT treated as an opt-out', () => {
  assert.equal(detectOptOut('how do I opt out if I want to later?').optOut, false);
});

let optOutJob = null;
await t('opt-out mid-call ends the call and suppresses the number', async () => {
  await fireMetaWebhook();
  optOutJob = world.queuedJobs.at(-1).job;

  // The brain would happily keep selling — the session must not let it.
  world.turnScript = () => ({ say: 'But let me tell you about our offer!', end: false, disposition: 'qualifying' });

  const result = await runQueuedCall(optOutJob, {
    outcome: 'answered',
    replies: ['Yes ok.', 'mujhe call mat karo'],
  });

  assert.equal(result.disposition, 'opt-out');
  assert.equal(result.endReason, 'opt_out');
  assert.ok(result.optOutMatched, 'the matching pattern should be recorded');
  assert.ok(world.suppressed.has('+919876500002'), 'number must be on the suppression list');
});

await t('the brain never got to keep selling AFTER the opt-out', async () => {
  // The sales line legitimately appears BEFORE the opt-out — the prospect had
  // not objected yet. What must never happen is another sales turn after it.
  // So: assert on ordering, not on absence.
  const last = world.crmEvents.filter((e) => e.event === 'call.completed').at(-1);
  assert.equal(last.review.disposition, 'opt-out');

  const h = last.call.history;
  const optOutIdx = h.findIndex((turn) => turn.role === 'user' && detectOptOut(turn.text).optOut);
  assert.ok(optOutIdx >= 0, 'the opt-out utterance should be in the transcript');

  const after = h.slice(optOutIdx + 1).filter((turn) => turn.role === 'agent');
  assert.equal(after.length, 1, 'exactly one agent turn may follow an opt-out: the acknowledgement');
  assert.match(after[0].text, /do-not-call list/i, `expected the opt-out acknowledgement, got: ${after[0].text}`);
  assert.ok(!/offer|tell you about/i.test(after[0].text), 'no selling after an opt-out');
});

await t('the CRM was told to flag do-not-call', () => {
  assert.ok(world.crmEvents.some((e) => e.event === 'lead.optout'));
});

await t('a suppressed number is refused on the NEXT lead — the loop closes', async () => {
  const before = world.queuedJobs.length;
  const res = mkRes();
  await intakeHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}` },
    body: {
      phone: '+919876500002', name: 'Priya Sharma', source: 'meta_lead_ads',
      consent: { granted: true, basis: 'lead_form', at: new Date().toISOString() },
    },
  }, res);
  assert.equal(res.body.results[0].reason, 'blocked:suppressed');
  assert.equal(world.queuedJobs.length, before, 'no new dial job may be queued');
});

await t('the API is the last line of defence: an Indic opt-out in a reported transcript is caught', async () => {
  // A third-party dialer (or a future media server) posts a transcript where
  // the prospect opted out in Telugu but the reported disposition says
  // otherwise. The API must override it and suppress the number itself.
  const res = mkRes();
  await outcomeHandler({
    method: 'POST', headers: { authorization: `Bearer ${KEY}` },
    body: {
      call: { id: 'third-party-1', disposition: 'callback' },   // wrong on purpose
      lead: { phone: '+919876500077', name: 'Third Party Lead' },
      history: [
        { role: 'agent', text: 'Hi, I am Anaga, an AI assistant from Vaak.' },
        { role: 'user', text: 'కాల్ చేయకండి' },
      ],
    },
  }, res);
  assert.equal(res.body.optOut, true, 'the API must catch the Telugu opt-out');
  assert.equal(res.body.review.disposition, 'opt-out');
  assert.ok(world.suppressed.has('+919876500077'), 'the API must suppress it itself');
});

// --- 3. the gate refuses what it should -----------------------------------
section('3. the compliance gate refuses');
await t('a DND-registered number never reaches the queue', async () => {
  world.dnd.add('+919876500003');
  const before = world.queuedJobs.length;
  const res = mkRes();
  await intakeHandler({
    method: 'POST', headers: { authorization: `Bearer ${KEY}` },
    body: { phone: '+919876500003', consent: { granted: true, basis: 'lead_form', at: new Date().toISOString() } },
  }, res);
  assert.equal(res.body.results[0].reason, 'blocked:dnd_registered');
  assert.equal(world.queuedJobs.length, before);
});

await t('a lead with no consent basis never reaches the queue', async () => {
  const before = world.queuedJobs.length;
  const res = mkRes();
  await intakeHandler({
    method: 'POST', headers: { authorization: `Bearer ${KEY}` },
    body: { phone: '+919876500004' },
  }, res);
  assert.match(res.body.results[0].reason, /^blocked:no_consent/);
  assert.equal(world.queuedJobs.length, before);
});

await t('the scrub going down blocks dials rather than allowing them', async () => {
  const savedUrl = process.env.DND_SCRUB_URL;
  process.env.DND_SCRUB_URL = 'http://unreachable.invalid/scrub';
  const before = world.queuedJobs.length;
  const res = mkRes();
  await intakeHandler({
    method: 'POST', headers: { authorization: `Bearer ${KEY}` },
    body: { phone: '+919876500005', consent: { granted: true, basis: 'lead_form', at: new Date().toISOString() } },
  }, res);
  process.env.DND_SCRUB_URL = savedUrl;
  assert.equal(res.body.results[0].reason, 'blocked:dnd_unverified');
  assert.equal(world.queuedJobs.length, before);
});

// --- 4. the caller agent refuses what it should ---------------------------
section('4. the caller agent refuses');
await t('an unsigned job is rejected', () => {
  assert.equal(verifyJobSignature('{}', undefined).ok, false);
});
await t('a tampered job is rejected', () => {
  const raw = JSON.stringify({ type: 'outbound_call' });
  const sig = 'sha256=' + crypto.createHmac('sha256', QUEUE_SECRET).update(raw).digest('hex');
  assert.equal(verifyJobSignature(raw + ' ', sig).ok, false);
});
await t('a job without a gate verdict is refused even when correctly signed', () => {
  const v = validateJob({ type: 'outbound_call', lead: { phone: '+919876543210' } });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'no_compliance_authorization');
});
await t('a job with a non-E.164 number is refused', () => {
  assert.equal(validateJob({
    type: 'outbound_call', lead: { phone: '9876543210' }, compliance: { allowed: true },
  }).error, 'invalid_phone');
});

// --- 5. failure paths -----------------------------------------------------
section('5. failure paths');
world.turnScript = HAPPY_PATH;

await t('no-answer still reports an outcome', async () => {
  const r = await runQueuedCall(happyJob, { outcome: 'no_answer' });
  assert.equal(r.disposition, 'no-answer');
  assert.equal(r.reported, true);
});

await t('callee hangup mid-call still reports an outcome', async () => {
  const r = await runQueuedCall(happyJob, {
    outcome: 'answered', replies: ['Yes ok.'], hangupAfterTurns: 1,
  });
  assert.equal(r.endReason, 'callee_hangup');
  assert.equal(r.reported, true);
});

await t('a dead brain closes the call politely instead of leaving dead air', async () => {
  world.llmDown = true;
  const r = await runQueuedCall(happyJob, { outcome: 'answered', replies: ['Yes, go ahead.'] });
  world.llmDown = false;
  assert.equal(r.endReason, 'brain_unavailable');
  assert.equal(r.disposition, 'callback');
  const last = r.history.filter((h) => h.role === 'agent').at(-1);
  assert.match(last.text, /call you back/i);
  assert.equal(r.reported, true);
});

await t('silence ends the call after bounded nudges', async () => {
  const r = await runQueuedCall(happyJob, { outcome: 'answered', replies: [] });
  assert.equal(r.endReason, 'silence');
  assert.ok(r.turns <= 6, `expected a short call, got ${r.turns} turns`);
});

await t('a CRM outage does not stop the call or lose the opt-out', async () => {
  world.crmDown = true;
  world.turnScript = () => ({ say: 'ok', end: false, disposition: 'qualifying' });
  const r = await runQueuedCall(happyJob, {
    outcome: 'answered', replies: ['stop calling me'],
  });
  world.crmDown = false;
  assert.equal(r.disposition, 'opt-out');
  assert.ok(world.suppressed.has(happyJob.lead.phone), 'suppression must survive a CRM outage');
});

await t('a duplicate Meta webhook does not queue a second call', async () => {
  world.leadPhone = '+919876500009';
  world.turnScript = HAPPY_PATH;
  const id = 'dupe_lead_1';
  await fireMetaWebhook(id);
  const after1 = world.queuedJobs.length;
  const res2 = await fireMetaWebhook(id);
  assert.equal(world.queuedJobs.length, after1, 'the retry must not queue a second dial');
  assert.equal(res2.body.results[0].reason, 'duplicate_lead');
});

await t('an unsigned Meta webhook causes no call', async () => {
  const before = world.queuedJobs.length;
  const res = mkRes();
  await metaHandler({ method: 'POST', headers: {}, body: { object: 'page', entry: [] } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(world.queuedJobs.length, before);
});

// --- 6. hard limits -------------------------------------------------------
section('6. hard limits');
await t('a chatty prospect cannot produce an unbounded call', async () => {
  world.turnScript = () => ({ say: 'and another thing', end: false, disposition: 'qualifying' });
  const r = await runQueuedCall(happyJob, {
    outcome: 'answered',
    replies: Array.from({ length: 200 }, (_, i) => `reply ${i}`),
  });
  assert.equal(r.endReason, 'max_turns');
  assert.ok(r.turns <= 60, `turns should be bounded, got ${r.turns}`);
});

// --- 7. the console reflects reality --------------------------------------
section('7. operator console reflects what happened');
await t('the console funnel shows the real calls, opt-outs and blocks', async () => {
  const res = mkRes();
  await summaryHandler({ method: 'GET', headers: { authorization: `Bearer ${KEY}` }, query: {} }, res);
  const f = res.body.funnel;
  assert.ok(f.counts.received > 0);
  assert.ok(f.counts.blocked > 0, 'blocked leads must appear');
  assert.ok(f.counts.completed > 0, 'completed calls must appear');
  assert.ok(f.counts.optOut > 0, 'opt-outs must appear');
  assert.equal(res.body.store.durable, false, 'the console must stay honest about durability');
});

await t('no unmasked phone number anywhere in the console payload', async () => {
  const res = mkRes();
  await summaryHandler({ method: 'GET', headers: { authorization: `Bearer ${KEY}` }, query: {} }, res);
  const s = JSON.stringify(res.body);
  for (const n of ['9876500001', '9876500002', '9876500009']) {
    assert.ok(!s.includes(n), `raw phone ${n} leaked into the console payload`);
  }
});

await t('no secret leaks into any CRM event or dial job', () => {
  const s = JSON.stringify({ crm: world.crmEvents, jobs: world.queuedJobs.map((j) => j.job) });
  for (const secret of [KEY, QUEUE_SECRET, APP_SECRET, 'e2e-page-token', 'e2e-dnd-key']) {
    assert.ok(!s.includes(secret), `secret leaked: ${secret.slice(0, 8)}…`);
  }
});

// ===========================================================================
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
