// scripts/test-call-record.mjs
//
// QA for what a finished call LEAVES BEHIND: the recording, the transcript, the
// lead score, and the script the agent was supposed to follow.
//
// Every one of these had a hole in it that looked like a working feature:
//
//   - no telephony adapter implemented recording(), so the guard in session.js
//     skipped it on every call and the entire storage path was unreachable;
//   - recordCall() existed in store.js and was called by nothing, so the
//     transcript was discarded when the request returned;
//   - the score was a number the LLM invented, so the same call scored
//     differently on two reviews;
//   - the flow file called itself the source of truth and was read by nothing.
//
// The tests below are written to fail if any of those reappear.
//
// Run: node --experimental-detect-module scripts/test-call-record.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

process.env.INTEGRATIONS_API_KEY = 'call-record-suite-key-00000000';
process.env.TELEPHONY_SAMPLE_RATE = '8000';

const { createCallRecorder } = await import(`${ROOT}/caller-agent/src/media/recorder.js`);
const { createMediaTransport } = await import(`${ROOT}/caller-agent/src/media/transport.js`);
const { createSTT, createTTS, parseWav } = await import(`${ROOT}/caller-agent/src/providers/speech.js`);
const { runCall } = await import(`${ROOT}/caller-agent/src/session.js`);
const { loadFlow, loadPersona } = await import(`${ROOT}/api/_lib/flow.js`);
const { scoreLead, explainScore, bucketVocabulary } = await import(`${ROOT}/api/_lib/scoring.js`);
const { sylRules, summaryPrompt } = await import(`${ROOT}/api/_lib/prompts.js`);

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

/** 16-bit mono PCM at a constant amplitude — easy to assert on after mixing. */
function tone(samples, amplitude) {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(amplitude, i * 2);
  return b;
}

console.log('\n═══ CALL RECORD QA ═══');

// ---------------------------------------------------------------------------
section('the recording — both legs, on one timeline');

await t('a recording contains BOTH what they said and what we said', () => {
  const r = createCallRecorder({ sampleRate: 8000, maxSeconds: 10 });
  r.outbound(tone(800, 1000), 0);      // 100ms of us
  r.inbound(tone(800, 2000), 100);     // 100ms of them, straight after
  const wav = r.wav();
  const { data, sampleRate, channels } = parseWav(wav);
  assert.equal(sampleRate, 8000);
  assert.equal(channels, 1);
  assert.equal(data.length / 2, 1600, 'both legs should be on the timeline');
  assert.equal(data.readInt16LE(0), 1000, 'our audio first');
  assert.equal(data.readInt16LE(800 * 2), 2000, 'theirs second');
});

await t('simultaneous speech is MIXED, not appended', () => {
  // Appending would produce a recording in which nobody ever interrupts
  // anybody — which is exactly what these recordings exist to review.
  const r = createCallRecorder({ sampleRate: 8000, maxSeconds: 10 });
  r.outbound(tone(800, 1000), 0);
  r.inbound(tone(800, 2000), 0);       // same instant: talking over us
  const { data } = parseWav(r.wav());
  assert.equal(data.length / 2, 800, 'overlapping audio must not extend the timeline');
  assert.equal(data.readInt16LE(0), 3000, 'the two legs should sum');
});

await t('a loud overlap clips rather than wrapping', () => {
  const r = createCallRecorder({ sampleRate: 8000, maxSeconds: 10 });
  r.outbound(tone(10, 30000), 0);
  r.inbound(tone(10, 30000), 0);
  const { data } = parseWav(r.wav());
  assert.equal(data.readInt16LE(0), 32767, 'wrapping would turn an overlap into a bang');
});

await t('silence between turns is kept — the pauses are evidence too', () => {
  const r = createCallRecorder({ sampleRate: 8000, maxSeconds: 10 });
  r.inbound(tone(80, 500), 0);
  r.inbound(tone(80, 500), 1000);      // a full second later
  const { data } = parseWav(r.wav());
  assert.ok(data.length / 2 >= 8000, 'the gap must survive into the recording');
  assert.equal(data.readInt16LE(4000 * 2), 0, 'the middle of the pause should be silent');
});

await t('a call that outruns the ceiling is truncated and SAYS so', () => {
  const r = createCallRecorder({ sampleRate: 8000, maxSeconds: 1 });
  r.inbound(tone(8000, 100), 0);
  r.inbound(tone(8000, 100), 1000);    // past the ceiling
  assert.equal(r.stats().truncated, true, 'evidence with a hole in it must not look complete');
  assert.ok(r.stats().droppedSamples > 0);
});

await t('a call with no audio yields no recording, not an empty file', () => {
  assert.equal(createCallRecorder({ sampleRate: 8000 }).wav(), null);
});

// ---------------------------------------------------------------------------
section('the transport captures the call it is actually having');

/** A transport on an injected clock whose vendors are doubles. */
function harness({ recording = true } = {}) {
  let clock = 0;
  const tr = createMediaTransport({
    stt: { async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' ').trim(); } },
    tts: { async synth() { return { frames: [tone(160, 4000), tone(160, 4000)] }; } },
    audioOut: () => {},
    now: () => clock,
    frameMs: 20,
    sleep: async (ms) => { clock += ms; },
    ...(recording ? {} : { recorder: null }),
  });
  return { tr, advance(ms) { clock += ms; } };
}

await t('what we SAY lands in the recording', async () => {
  const h = harness();
  await h.tr.say('hello there');
  const wav = h.tr.recording();
  assert.ok(wav, 'speaking should produce audio in the recording');
  assert.ok(parseWav(wav).data.length > 0);
});

await t('what THEY say lands in the recording', async () => {
  const h = harness();
  h.tr.pushAudio(tone(160, 3000), { hasVoice: true });
  const wav = h.tr.recording();
  assert.ok(wav);
  assert.equal(parseWav(wav).data.readInt16LE(0), 3000);
});

await t('the recording can be switched off, and then there is none', async () => {
  const h = harness({ recording: false });
  await h.tr.say('hello there');
  assert.equal(h.tr.recording(), null);
});

await t('THE REGRESSION: the media transport implements recording()', () => {
  // The bug this whole module exists for: session.js has always ended with
  // `if (typeof telephony.recording === 'function')` and nothing satisfied it,
  // so every call silently produced no audio.
  const h = harness();
  assert.equal(typeof h.tr.recording, 'function');
});

await t('a finished call hands its audio to the recording store', async () => {
  const stored = [];
  const h = harness();
  const telephony = {
    async dial() { return { answered: true }; },
    async say(text) { await h.tr.say(text); return true; },
    async listen() { return { text: null, hangup: true, silent: false }; },
    async hangup() { return { ended: true }; },
    recording: () => h.tr.recording(),
  };
  const brain = {
    async nextTurn() { return { say: 'ok', end: true }; },
    async reportOutcome(p) { stored.push(p); return { ok: true }; },
  };
  const res = await runCall({ job: { callId: 'rec1', lead: { phone: '+919000000000' } }, telephony, brain, persona: {} });
  // No S3 configured in this suite, so the upload fails — but it was ATTEMPTED
  // with real audio, which is the thing that was never happening.
  assert.equal(res.recordingRef, null, 'no store configured, so no ref');
  assert.ok(stored.length, 'the outcome is still reported');
});

// ---------------------------------------------------------------------------
section('lead potency — a number a closer can argue with');

await t('a fully qualified booked call scores hot', () => {
  const s = scoreLead({
    qualification: { purpose: 'end-use', budget: 'in-range', config: 'match', timeline: 'immediate' },
    disposition: 'booked',
  });
  assert.ok(s.score >= 75, `expected hot, got ${s.score}`);
  assert.equal(s.band, 'hot');
  assert.equal(s.coverage, 100);
});

await t('the SAME call always scores the same', () => {
  const input = { qualification: { budget: 'in-range', timeline: 'exploring' }, disposition: 'callback' };
  const a = scoreLead(input);
  const b = scoreLead(input);
  assert.deepEqual(a, b, 'a score a sales team cannot reproduce is a score they stop trusting');
});

await t('an opt-out is cold however well they qualified first', () => {
  const s = scoreLead({
    qualification: { purpose: 'end-use', budget: 'above-range', config: 'match', timeline: 'immediate' },
    disposition: 'opt-out',
  });
  assert.equal(s.score, 0);
  assert.equal(s.cappedBy, 'opt-out');
});

await t('coverage separates a well-answered 70 from a lucky one', () => {
  const full = scoreLead({ qualification: { purpose: 'end-use', budget: 'in-range', config: 'match', timeline: '3-6-months' } });
  const thin = scoreLead({ qualification: { budget: 'in-range' } });
  assert.equal(full.coverage, 100);
  assert.ok(thin.coverage < 50, 'one answer out of four is not a qualified lead');
});

await t('an unanswered question scores low rather than being ignored', () => {
  const s = scoreLead({ qualification: {} });
  assert.ok(s.score > 0 && s.score < 40, `silence is a fact about the lead, got ${s.score}`);
  assert.equal(s.answered, 0);
});

await t('a bucket the reviewer invented earns nothing', () => {
  const real = scoreLead({ qualification: { timeline: 'immediate' } });
  const fake = scoreLead({ qualification: { timeline: 'extremely-hot-buy-now' } });
  assert.ok(fake.score < real.score, 'a model must not be able to invent points');
  assert.equal(fake.fields.find((f) => f.id === 'timeline').bucket, 'unclear');
});

await t('the score explains itself in one line', () => {
  const s = scoreLead({ qualification: { budget: 'in-range' }, disposition: 'callback' });
  const text = explainScore(s);
  assert.ok(text.includes('/100'), text);
  assert.ok(/Budget range/.test(text), 'the breakdown should name the questions');
  assert.ok(/1 of 4/.test(text), 'and how much of the call was actually qualified');
});

await t('the reviewer is only offered buckets the flow defines', () => {
  const vocab = bucketVocabulary();
  const { system } = summaryPrompt([{ role: 'user', text: 'hi' }]);
  for (const [field, buckets] of Object.entries(vocab)) {
    assert.ok(system.includes(`"${field}"`), `${field} should be asked for`);
    for (const b of buckets) assert.ok(system.includes(`"${b}"`), `${b} should be offered`);
  }
});

await t('the reviewer is told NOT to invent a score', () => {
  const { system } = summaryPrompt([{ role: 'user', text: 'hi' }]);
  assert.ok(/Do NOT return a score/i.test(system));
  assert.ok(!/"score":\s+number/.test(system), 'score must not still be a requested field');
});

// ---------------------------------------------------------------------------
section('the script is the flow file, not a copy of it');

await t('the flow file is actually loaded', () => {
  const f = loadFlow();
  assert.equal(f.id, 'real-estate-qualify');
  assert.ok(f.steps.length > 5);
  assert.equal(f.qualification.fields.length, 4);
});

await t('every qualification field is asked by a real step in the flow', () => {
  for (const f of loadFlow().qualification.fields) {
    assert.ok(f.ask, `${f.id} has a weight but no step asks it — the score and the script disagree`);
  }
});

await t('THE REGRESSION: editing the flow changes the prompt', () => {
  // The whole point. The script used to be hand-copied into a prose constant,
  // so the flow file was decorative and the two had already drifted.
  const flow = loadFlow();
  const edited = {
    ...flow,
    project: { name: 'Marina Heights', city: 'Chennai' },
    goal: 'Book a virtual tour.',
    qualification: {
      ...flow.qualification,
      fields: [{ id: 'pets', label: 'Do they have pets', weight: 1, buckets: { yes: 100, unclear: 0 }, ask: 'Do you have pets?' }],
    },
  };
  const rules = sylRules(edited, loadPersona());
  assert.ok(rules.includes('Marina Heights'), 'the project must come from the flow');
  assert.ok(rules.includes('Book a virtual tour.'), 'the goal must come from the flow');
  assert.ok(rules.includes('Do you have pets?'), 'the questions must come from the flow');
  assert.ok(!rules.includes('Skyline Villaments'), 'nothing may be hardcoded from the old flow');
});

await t('the disclosure in the prompt is the reviewed sentence, quoted', () => {
  const rules = sylRules();
  assert.ok(rules.includes(loadPersona().disclosure['en-IN']),
    'the sentence that makes the call legal must be shown verbatim, not paraphrased');
});

await t('the opt-out triggers come from the flow', () => {
  const rules = sylRules();
  for (const trig of loadFlow().optOutTriggers) {
    assert.ok(rules.includes(`"${trig}"`), `${trig} missing from the ruleset`);
  }
});

await t('a broken flow still produces a compliant ruleset', () => {
  // A mistyped JSON key must not be able to strip the disclosure rule out of
  // the prompt. The floor fails toward saying MORE, not less.
  const rules = sylRules({
    project: {}, goal: '', steps: [], optOutTriggers: ['do not call'],
    qualification: { fields: [], dispositionCeiling: {}, bands: [] },
  }, loadPersona());
  assert.ok(/DISCLOSURE & CONSENT/.test(rules));
  assert.ok(/OPT-OUT/.test(rules));
  assert.ok(/NEVER claim to close/.test(rules), 'the hard limits must survive an empty flow');
});

await t('the flow and the shared opt-out detector agree', async () => {
  // shared/optout.js says its triggers come from the flow's globals. If they
  // drift, the agent is told one list and the enforcement uses another.
  const { detectOptOut } = await import(`${ROOT}/shared/optout.js`);
  for (const trig of loadFlow().optOutTriggers) {
    assert.equal(detectOptOut(`yeah ${trig} please`).optOut, true,
      `the flow advertises "${trig}" but the detector does not honour it`);
  }
});

// ---------------------------------------------------------------------------
section('the transcript survives the call');

// A Firestore double. The REAL store and firestore.js run against it — service
// account JWT, token exchange, typed-value encoding and all — because the thing
// most likely to break here is the encoding of a nested transcript array, and a
// mocked store would prove nothing about that.
const db = new Map();
const realFetch = globalThis.fetch;

{
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account',
    project_id: 'vaak-test',
    client_email: 'test@vaak-test.iam.gserviceaccount.com',
    private_key: privateKey,
  });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (status, data) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  if (u.includes('oauth2') || u.includes('token')) {
    return json(200, { access_token: 'test-token', expires_in: 3600 });
  }

  if (u.includes('firestore.googleapis.com')) {
    const path = decodeURIComponent(u.split('/documents/')[1] || '').split('?')[0];
    if (opts.method === 'PATCH') {
      db.set(path, JSON.parse(opts.body).fields);
      return json(200, { name: path });
    }
    if (!opts.method || opts.method === 'GET') {
      if (u.includes(':runQuery')) return json(200, []);
      const fields = db.get(path);
      return fields ? json(200, { name: path, fields }) : json(404, { error: 'not found' });
    }
    if (opts.method === 'POST') {
      const id = `auto_${db.size}`;
      db.set(`${path}/${id}`, JSON.parse(opts.body).fields);
      return json(200, { name: `${path}/${id}` });
    }
  }
  return realFetch(url, opts);
};

const outcomeHandler = (await import(`${ROOT}/api/calls/outcome.js`)).default;
const transcriptHandler = (await import(`${ROOT}/api/calls/transcript.js`)).default;

function mkRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

const AUTH = { authorization: `Bearer ${process.env.INTEGRATIONS_API_KEY}` };
const CONVERSATION = [
  { role: 'agent', text: "Hi, I'm Anaga, an AI voice assistant from Vaak. Is now a good time?" },
  { role: 'user', text: 'Yes, go ahead.' },
  { role: 'agent', text: 'Are you looking for a home to live in, or as an investment?' },
  { role: 'user', text: 'To live in. Budget is about one and a half crore, 3BHK, buying in two months.' },
  { role: 'agent', text: 'Could I book you a site visit this weekend?' },
  { role: 'user', text: 'Saturday works.' },
];

async function reportCall(callId, { history = CONVERSATION, review, disposition = 'booked' } = {}) {
  const res = mkRes();
  await outcomeHandler({
    method: 'POST', headers: AUTH, query: {},
    body: JSON.stringify({
      call: { id: callId, startedAt: '2026-08-09T10:00:00.000Z', durationSec: 96, disposition },
      lead: { phone: '+919812345678', name: 'Test Lead', source: 'meta', sourceId: 'lead_1', crmRecordId: 'crm_1' },
      history,
      review: review || {
        interested: true, disposition, summary: 'Qualified end-user, booked Saturday.',
        nextAction: 'Assign a closer.', comment: 'Serious buyer.',
        qualification: { purpose: 'end-use', budget: 'in-range', config: 'match', timeline: '3-6-months' },
      },
    }),
  }, res);
  return res;
}

async function readCall(query) {
  const res = mkRes();
  await transcriptHandler({ method: 'GET', headers: AUTH, query }, res);
  return res;
}

await t('THE REGRESSION: a finished call persists its transcript', async () => {
  // recordCall() existed in store.js and was called by nothing. A finished call
  // left a summary event and the conversation itself was thrown away.
  const out = await reportCall('call_t1');
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.transcript.stored, true, 'the transcript must be written');
  assert.equal(out.body.transcript.turns, CONVERSATION.length);
});

await t('and it can be read back, turn for turn', async () => {
  await reportCall('call_t2');
  const res = await readCall({ callId: 'call_t2' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.call.transcript, CONVERSATION,
    'the conversation must survive the round trip through Firestore encoding');
});

await t('the stored score is the computed one, with its breakdown', async () => {
  await reportCall('call_t3');
  const { call } = (await readCall({ callId: 'call_t3' })).body;
  const expected = scoreLead({
    qualification: { purpose: 'end-use', budget: 'in-range', config: 'match', timeline: '3-6-months' },
    disposition: 'booked',
  });
  assert.equal(call.score, expected.score);
  assert.equal(call.band, expected.band);
  assert.equal(call.scoring.answered, 4);
  assert.ok(call.scoring.explain.includes('/100'));
});

await t('a score the model invented is ignored', async () => {
  await reportCall('call_t4', {
    review: {
      interested: true, disposition: 'callback', score: 99,
      summary: 's', nextAction: 'n', comment: 'c',
      qualification: { timeline: 'exploring' },
    },
  });
  const { call } = (await readCall({ callId: 'call_t4' })).body;
  assert.notEqual(call.score, 99, 'the model does not get to set the number');
  assert.equal(call.score, scoreLead({ qualification: { timeline: 'exploring' }, disposition: 'callback' }).score);
});

await t('an opt-out is stored cold and flagged', async () => {
  await reportCall('call_t5', {
    disposition: 'opt-out',
    history: [...CONVERSATION, { role: 'user', text: 'actually please remove me from your list' }],
    review: {
      interested: true, disposition: 'booked', summary: 's', nextAction: 'n', comment: 'c',
      qualification: { purpose: 'end-use', budget: 'in-range', config: 'match', timeline: 'immediate' },
    },
  });
  const { call } = (await readCall({ callId: 'call_t5' })).body;
  assert.equal(call.optOut, true);
  assert.equal(call.disposition, 'opt-out');
  assert.equal(call.score, 0, 'an opt-out cannot be stored as a warm lead');
});

await t('the number is masked at rest and on the way out', async () => {
  await reportCall('call_t6');
  const { call } = (await readCall({ callId: 'call_t6' })).body;
  assert.ok(call.lead.phoneMasked, 'a masked number should be present');
  assert.ok(!call.lead.phoneMasked.includes('812345678'), `leaked: ${call.lead.phoneMasked}`);

  for (const [path, fields] of db) {
    if (!path.startsWith('calls/')) continue;
    assert.ok(!JSON.stringify(fields).includes('+919812345678'),
      `${path} stores the full number; the call record links by crmRecordId, not by phone`);
  }
});

await t('the suppression list is the ONLY place a full number is kept', () => {
  // It has to be: a do-not-call register that cannot match a number does not
  // block anyone. This test pins down that it is the only such place, so a
  // future writer that starts storing raw numbers elsewhere fails here.
  const holders = [...db.entries()]
    .filter(([, fields]) => JSON.stringify(fields).includes('+919812345678'))
    .map(([path]) => path.split('/')[0]);
  assert.deepEqual([...new Set(holders)], ['suppression'],
    `unexpected collections hold a raw number: ${[...new Set(holders)].join(', ')}`);
});

await t('reading a transcript requires the operator key', async () => {
  const res = mkRes();
  await transcriptHandler({ method: 'GET', headers: {}, query: { callId: 'call_t2' } }, res);
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `got ${res.statusCode}`);
});

await t('a call that does not exist is a 404, not an empty transcript', async () => {
  const res = await readCall({ callId: 'no_such_call' });
  assert.equal(res.statusCode, 404);
});

await t('the list view does NOT hand out transcripts in bulk', async () => {
  const res = await readCall({ limit: 50 });
  assert.equal(res.statusCode, 200);
  for (const c of res.body.calls || []) {
    assert.ok(!('transcript' in c), 'fifty conversations in one response is an exfiltration shape');
  }
});

await t('the recording reference is returned, never a playable URL', async () => {
  await reportCall('call_t7');
  const { call } = (await readCall({ callId: 'call_t7' })).body;
  const ref = call.recordingRef;
  assert.ok(ref === null || ref.startsWith('s3://'), `got ${ref}`);
  assert.ok(!JSON.stringify(call).includes('https://'), 'audio must only be reachable via /api/calls/recording');
});

globalThis.fetch = realFetch;

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
