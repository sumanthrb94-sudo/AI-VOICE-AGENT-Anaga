// scripts/test-stt.mjs
//
// QA for speech-to-text: the Sarvam Saaras adapter (api/_lib/stt.js) and the
// audio half of POST /api/anaga/turn.
//
// ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────
// The browser used to transcribe with the Web Speech API, which cannot do echo
// cancellation. It heard Anaga through the phone's own speaker, answered her,
// and the call became a loop — shipped three times, with three different
// heuristics stacked on top to guess which voice was which. The fix was to
// capture through getUserMedia with echoCancellation and send those bytes to a
// server-side recogniser, which is the path under test here.
//
// The guarantees, in the order they matter:
//
//   1. A failed transcription is NEVER silence. Silence on a live call is the
//      agent ignoring a prospect, so every failure surfaces as an error or an
//      explicit `ignored` reason — it never quietly becomes an empty turn.
//   2. Nothing that is not speech reaches the vendor, because every request is
//      billed and a door closing costs money to be told it was a door.
//   3. …but the floor is on DURATION, which is what the endpointer measured,
//      not on byte length, which measures loudness. See §3.
//   4. The key stays server-side and out of every URL and log line.
//
// ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
// That Saaras is reachable or that it transcribes Telugu well. Every network
// call is stubbed so this runs in CI with no keys and no egress. Reachability
// is a deploy question, answered by GET /api/integrations/health.
//
// Run: node --experimental-detect-module scripts/test-stt.mjs

import assert from 'node:assert';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log('\n' + s); }

// ---------------------------------------------------------------------------
// fetch stub — records what the vendor was ASKED FOR, which is our half
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let routes = [];
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  // Multipart, so the body is a FormData — kept as-is and read field by field.
  calls.push({ url: u, init, form: init.body instanceof FormData ? init.body : null });
  for (const r of routes) if (r.match.test(u)) return r.reply(u, init);
  throw new Error('unstubbed fetch: ' + u);
};
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0), headers: new Map(),
});
function reset() { routes = []; calls = []; tts.clearSynthCache(); }

const ENV_KEYS = ['STT_PROVIDER', 'SARVAM_API_KEY', 'SARVAM_STT_MODEL', 'SARVAM_STT_MODE',
  'STT_TIMEOUT_MS', 'STT_MIN_MS', 'STT_MIN_BYTES',
  'TTS_PROVIDER', 'LLM_PROVIDER', 'GEMINI_API_KEY', 'RATE_LIMIT_TURN',
  'SARVAM_STREAM', 'SARVAM_TTS_MODEL', 'RATE_LIMIT_BACKCHANNEL',
  'DEEPGRAM_API_KEY', 'DEEPGRAM_MODEL', 'DEEPGRAM_FALLBACK_LANG',
  'STT_PROVIDER_EN_IN', 'STT_PROVIDER_TE_IN', 'STT_PROVIDER_HI_IN'];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
clearEnv();

const stt = await import('../api/_lib/stt.js');
// The synth cache is process-wide by design, so a test that expects the vendor
// to be called has to start from an empty one.
const tts = await import('../api/_lib/tts.js');

/** The field values Sarvam was actually sent, for the last multipart call. */
function lastForm() {
  // The LAST call is not always the STT one — a full turn calls the brain
  // afterwards, with a JSON body — so search backwards for the multipart.
  const c = [...calls].reverse().find((x) => x.form);
  if (!c) return null;
  const out = {};
  for (const [k, v] of c.form.entries()) {
    out[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size };
  }
  return out;
}

// Real-ish bytes. Content is irrelevant to the adapter (it forwards them) but
// LENGTH is not — the byte floor is a guard under test.
const audio = (n) => Buffer.alloc(n, 7);

// ===========================================================================
section('§1 configuration — what this deployment can actually hear');
// ===========================================================================

await t('with no key configured, STT is not available', () => {
  clearEnv();
  assert.equal(stt.sttReady('sarvam'), false);
  assert.equal(stt.sttAvailable(), false);
});

await t('the Sarvam key is the only thing it needs', () => {
  clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  assert.equal(stt.sttReady('sarvam'), true);
  assert.equal(stt.sttAvailable(), true);
});

await t('an unknown provider name is never "ready"', () => {
  clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.STT_PROVIDER = 'whisper';
  assert.equal(stt.sttReady('whisper'), false);
  assert.equal(stt.sttAvailable(), false, 'a typo in STT_PROVIDER must fail closed, not fall through');
});

await t('sttStatus reports the chain and the model, and no secret', () => {
  clearEnv();
  process.env.SARVAM_API_KEY = 'super-secret';
  const s = stt.sttStatus();
  // The chain NAMES both vendors; only the one with a key is ready. A chain
  // that hid the unconfigured vendor would make a missing key look like a
  // design decision.
  assert.deepEqual(s.chain, ['sarvam', 'deepgram']);
  assert.deepEqual(s.ready, ['sarvam'], 'no Deepgram key, so it cannot serve');
  assert.equal(s.model, 'saaras:v3');
  // With Deepgram unconfigured, English falls to Saaras — and health says so
  // rather than reporting the intended routing as if it were the real one.
  assert.equal(s.byLang['en-IN'].serves, 'sarvam');
  assert.deepEqual(s.byLang['en-IN'].chain, ['deepgram', 'sarvam']);
  assert.equal(s.byLang['te-IN'].serves, 'sarvam');
  assert.doesNotMatch(JSON.stringify(s), /super-secret/, 'health output must never carry the key');
});

// ===========================================================================
section('§2 the request Sarvam actually receives');
// ===========================================================================

await t('one multipart POST, keyed by header — never by URL', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k-123';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'ok', language_code: 'te-IN' }) });

  await stt.transcribe({ audio: audio(4096), mime: 'audio/webm;codecs=opus' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sarvam.ai/speech-to-text');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['api-subscription-key'], 'k-123');
  // A key in the query string ends up in every proxy log and every browser
  // history between here and Sarvam.
  assert.doesNotMatch(calls[0].url, /k-123/, 'the key must never travel in the URL');
  assert.ok(calls[0].form, 'the body must be multipart — Saaras takes a file, not JSON');
});

await t('the transcript and the DETECTED language both come back', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({
    match: /speech-to-text/,
    reply: () => json({ request_id: 'r1', transcript: '  నాకు మూడు బెడ్‌రూమ్‌లు కావాలి  ', language_code: 'te-IN' }),
  });
  const out = await stt.transcribe({ audio: audio(4096) });
  assert.equal(out.text, 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి', 'the transcript is trimmed');
  assert.equal(out.lang, 'te-IN');
  assert.equal(out.provider, 'sarvam');
});

await t('LANGUAGE IS AUTO-DETECTED by default', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'yes' }) });
  await stt.transcribe({ audio: audio(4096) });
  // A prospect who answers a Telugu call in English is ordinary here. Pinning
  // the language transcribes them as gibberish.
  assert.equal(lastForm().language_code, 'unknown');
});

await t('…but a language we support is passed through', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'yes' }) });
  await stt.transcribe({ audio: audio(4096), lang: 'te-IN' });
  assert.equal(lastForm().language_code, 'te-IN');
});

await t('an unsupported language falls back to auto-detect, not to an error', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'yes' }) });
  await stt.transcribe({ audio: audio(4096), lang: 'fr-FR' });
  assert.equal(lastForm().language_code, 'unknown',
    'a language Saaras cannot do must degrade to detection, not drop the utterance');
});

await t('the model and mode are the transcribing pair, and are overridable', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'yes' }) });

  await stt.transcribe({ audio: audio(4096) });
  let f = lastForm();
  assert.equal(f.model, 'saaras:v3');
  // "transcribe" keeps the prospect's own language and normalises numbers, so a
  // budget or a phone number arrives as digits rather than spelled out.
  assert.equal(f.mode, 'transcribe');

  process.env.SARVAM_STT_MODEL = 'saaras:v2';
  process.env.SARVAM_STT_MODE = 'codemix';
  await stt.transcribe({ audio: audio(4096) });
  f = lastForm();
  assert.equal(f.model, 'saaras:v2');
  assert.equal(f.mode, 'codemix');
});

await t('THE CONTAINER THE BROWSER PRODUCED IS THE ONE DECLARED', async () => {
  // Chrome gives WebM/Opus, Safari gives MP4. Declaring one and sending the
  // other is how "it works on my phone" happens.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'yes' }) });

  const cases = [
    ['audio/webm;codecs=opus', 'utterance.webm', 'audio/webm'],
    ['audio/mp4', 'utterance.m4a', 'audio/mp4'],
    ['audio/ogg;codecs=opus', 'utterance.ogg', 'audio/ogg'],
    ['audio/wav', 'utterance.wav', 'audio/wav'],
  ];
  for (const [mime, name, type] of cases) {
    await stt.transcribe({ audio: audio(4096), mime });
    const f = lastForm();
    assert.equal(f.file.name, name, `${mime} should be sent as ${name}`);
    assert.equal(f.file.type, type, 'the codec parameter is stripped; the type is not invented');
  }

  // No mime at all is the common browser case, not an error.
  await stt.transcribe({ audio: audio(4096) });
  assert.equal(lastForm().file.name, 'utterance.webm');
});

await t('the bytes are forwarded whole — nothing re-encodes them here', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'yes' }) });
  await stt.transcribe({ audio: audio(9001), mime: 'audio/webm' });
  assert.equal(lastForm().file.size, 9001);
});

// ===========================================================================
section('§3 failure — because silence is the one answer that must never happen');
// ===========================================================================

await t('NOTHING CONFIGURED THROWS. It does not return an empty transcript', async () => {
  reset(); clearEnv();
  await assert.rejects(() => stt.transcribe({ audio: audio(4096) }), /stt_unavailable/);
  assert.equal(calls.length, 0, 'and it must not have called anybody');
});

await t('empty audio throws rather than billing a request for nothing', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  await assert.rejects(() => stt.transcribe({ audio: Buffer.alloc(0) }), /stt_audio_required/);
  await assert.rejects(() => stt.transcribe({}), /stt_audio_required/);
  assert.equal(calls.length, 0);
});

await t("A VENDOR ERROR CARRIES THE VENDOR'S OWN SENTENCE", async () => {
  // "[object Object]" in this position cost days on the TTS side: Sarvam nests
  // the real reason under error.message, and the adapter was stringifying the
  // wrapper. Every call failed and the log said nothing about why.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({
    match: /speech-to-text/,
    reply: () => json({ error: { message: 'Invalid model saaras:v9' } }, 400),
  });
  await assert.rejects(() => stt.transcribe({ audio: audio(4096) }), (err) => {
    assert.match(err.message, /stt_failed/);
    assert.match(String(err.detail), /Invalid model saaras:v9/,
      'the vendor sentence must survive to the log');
    assert.doesNotMatch(String(err.detail), /\[object Object\]/);
    return true;
  });
});

await t('a non-JSON error body still reports the status', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({
    match: /speech-to-text/,
    reply: () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }),
  });
  await assert.rejects(() => stt.transcribe({ audio: audio(4096) }), (err) => {
    assert.match(String(err.detail), /HTTP 502/);
    return true;
  });
});

await t('a network failure is reported as one, not as silence', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(() => stt.transcribe({ audio: audio(4096) }), (err) => {
    assert.match(String(err.detail), /sarvam_stt_network/);
    return true;
  });
});

await t('a hung vendor times out instead of holding the call open', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.STT_TIMEOUT_MS = '60';
  routes.push({
    match: /speech-to-text/,
    reply: (_u, init) => new Promise((_ok, no) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; no(e);
      });
    }),
  });
  await assert.rejects(() => stt.transcribe({ audio: audio(4096) }), (err) => {
    assert.match(String(err.detail), /sarvam_stt_timeout/);
    return true;
  });
});

await t('an empty transcript is returned as empty — the adapter does not guess', async () => {
  // Deciding what silence MEANS is the caller's job (see §4). The adapter's job
  // is to report what came back.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: '', language_code: 'te-IN' }) });
  const out = await stt.transcribe({ audio: audio(4096) });
  assert.equal(out.text, '');
});

// ===========================================================================
section('§4 the audio turn — POST /api/anaga/turn with an utterance');
// ===========================================================================

const turn = (await import('../api/anaga/turn.js')).default;

function call(body, query = {}) {
  const req = {
    method: 'POST', body, query,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  let done;
  const p = new Promise((r) => { done = r; });
  const res = {
    statusCode: 200,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { done({ status: this.statusCode, body: o }); return this; },
    send(o) { done({ status: this.statusCode, body: o }); return this; },
    end(o) { done({ status: this.statusCode, body: o }); return this; },
  };
  return Promise.resolve(turn(req, res)).then(() => p);
}

/** A brain that answers, so a turn that gets past STT has somewhere to go. */
function stubBrain(say = 'Are you looking to live in it, or to invest?') {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'g';
  routes.push({
    match: /generativelanguage\.googleapis/,
    reply: () => json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ say, end: false, disposition: 'qualifying' }) }] } }],
    }),
  });
}

const b64 = (n) => audio(n).toString('base64');

await t('AUDIO IN, TRANSCRIPT AND REPLY OUT — one round trip for the whole turn', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'none';
  routes.push({
    match: /speech-to-text/,
    reply: () => json({ transcript: 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి', language_code: 'te-IN' }),
  });
  stubBrain();

  const r = await call({ history: [], lang: 'te-IN', direction: 'outbound', audio: b64(4096), mime: 'audio/webm', ms: 900 });
  assert.equal(r.status, 200);
  assert.equal(r.body.heard, 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి',
    'the browser never knew the words — it has to be told what it said');
  assert.equal(r.body.say, 'Are you looking to live in it, or to invest?');
  assert.equal(r.body.lang, 'te-IN');
});

await t('THE TRANSCRIPT IS APPENDED TO THE HISTORY THE MODEL SEES', async () => {
  // The caller sends the history WITHOUT the utterance, because it did not know
  // the words yet. If it is not appended here, Anaga answers the turn before.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'none';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'three bedrooms' }) });
  stubBrain();

  await call({ history: [{ role: 'agent', text: 'How many bedrooms?' }], lang: 'en-IN', audio: b64(4096), ms: 900 });
  const brain = calls.find((c) => /generativelanguage/.test(c.url));
  assert.ok(brain, 'the brain must have been asked');
  assert.match(String(brain.init.body), /three bedrooms/);
});

await t('A COUGH NEVER REACHES THE VENDOR — the duration floor is checked first', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  const r = await call({ history: [], lang: 'te-IN', audio: b64(4096), mime: 'audio/webm', ms: 120 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, 'too_short');
  assert.equal(r.body.say, null, 'and she says nothing rather than answering a cough');
  assert.equal(calls.length, 0, 'a door closing must cost nothing');
});

await t('A LONG QUIET CLIP IS NOT DROPPED — the floor is duration, not bytes', async () => {
  // THE REGRESSION THIS TEST EXISTS FOR. The floor used to be 1200 BYTES, and
  // byte length is not duration: Opus with DTX encodes near-silence to almost
  // nothing, so the check measured how much SOUND there was rather than how
  // long somebody spoke. A short quiet "అవును" — the single most consequential
  // word in a qualifying call — landed under a kilobyte and was thrown away
  // without ever reaching Saaras.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'none';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'అవును' }) });
  stubBrain();

  const r = await call({ history: [], lang: 'te-IN', audio: b64(700), mime: 'audio/webm', ms: 600 });
  assert.equal(r.body.heard, 'అవును');
  assert.ok(calls.some((c) => /speech-to-text/.test(c.url)), 'it must have been transcribed');
});

await t('bytes too few to be a container at all are still refused', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  const r = await call({ history: [], lang: 'te-IN', audio: b64(40), mime: 'audio/webm', ms: 5000 });
  assert.equal(r.body.ignored, 'too_short');
  assert.equal(calls.length, 0);
});

await t('a caller that reports no duration is judged on bytes alone', async () => {
  // The call leg and any third-party client may not have an endpointer to ask.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'none';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'hello' }) });
  stubBrain();
  const r = await call({ history: [], lang: 'en-IN', audio: b64(4096), mime: 'audio/webm' });
  assert.equal(r.body.heard, 'hello');
});

await t('SILENCE IS ANSWERED WITH SILENCE, not with an invented reply', async () => {
  // The model will happily produce a warm, plausible sentence in response to an
  // empty string. On a live call that is Anaga talking over a prospect who has
  // not said anything yet.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: '   ' }) });
  stubBrain();

  const r = await call({ history: [], lang: 'te-IN', audio: b64(4096), ms: 900 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, 'no_speech');
  assert.equal(r.body.say, null);
  assert.ok(!calls.some((c) => /generativelanguage/.test(c.url)),
    'the brain must never be asked to reply to silence — it is a billed call for a wrong answer');
});

await t('STT DOWN IS 503, never a silently empty turn', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /speech-to-text/, reply: () => json({ error: { message: 'upstream boom' } }, 500) });
  stubBrain();

  const r = await call({ history: [], lang: 'te-IN', audio: b64(4096), ms: 900 });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'stt_unavailable');
  assert.ok(!calls.some((c) => /generativelanguage/.test(c.url)));
});

await t('STT UNCONFIGURED IS 503 — it fails closed, it does not guess', async () => {
  reset(); clearEnv();
  process.env.TTS_PROVIDER = 'none';
  stubBrain();
  const r = await call({ history: [], lang: 'te-IN', audio: b64(4096), ms: 900 });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'stt_unavailable');
});

await t('a turn with NO audio is unaffected — text callers still work', async () => {
  // The call leg sends text it transcribed itself. It must not acquire a
  // dependency on STT being configured.
  reset(); clearEnv();
  process.env.TTS_PROVIDER = 'none';
  stubBrain();
  const r = await call({ history: [{ role: 'user', text: 'I want three bedrooms' }], lang: 'en-IN' });
  assert.equal(r.status, 200);
  assert.ok(r.body.say);
  assert.equal('heard' in r.body, false, 'nothing was transcribed, so nothing is reported as heard');
});

await t('the language picked for the call is the language STT is asked for', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'none';
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'हाँ' }) });
  stubBrain();
  await call({ history: [], lang: 'hi-IN', audio: b64(4096), ms: 900 });
  assert.equal(lastForm().language_code, 'hi-IN');
});

// ===========================================================================
section('§4b Deepgram — a second recogniser, and the chain that reaches it');
// ===========================================================================

const dgOk = (transcript, detected) => json({
  results: { channels: [{ alternatives: [{ transcript }], ...(detected ? { detected_language: detected } : {}) }] },
});

await t('ENGLISH GOES TO DEEPGRAM, TELUGU DOES NOT — by default', async () => {
  // Not a preference. Deepgram cannot code-switch into Telugu, so a Telugu
  // call must pin `te`, and a prospect answering in English is then run
  // through a Telugu model. Saaras auto-detects. English is the other way
  // round: Nova-3's `multi` handles English/Hindi mixing natively.
  reset(); clearEnv();
  process.env.DEEPGRAM_API_KEY = 'k';
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('english please') });
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'తెలుగు', language_code: 'te-IN' }) });

  assert.equal((await stt.transcribe({ audio: audio(4096), lang: 'en-IN' })).provider, 'deepgram');
  assert.equal((await stt.transcribe({ audio: audio(4096), lang: 'te-IN' })).provider, 'sarvam');
  assert.equal((await stt.transcribe({ audio: audio(4096), lang: 'hi-IN' })).provider, 'sarvam');
});

await t('each language is still a CHAIN — one vendor down is not a dead call', async () => {
  reset(); clearEnv();
  process.env.DEEPGRAM_API_KEY = 'k';
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => json({ err_msg: 'down' }, 500) });
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'rescued' }) });
  const out = await stt.transcribe({ audio: audio(4096), lang: 'en-IN' });
  assert.equal(out.provider, 'sarvam', 'English must fall through to Saaras');
});

await t('a language with no Deepgram key quietly routes to the one that works', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';        // no DEEPGRAM_API_KEY
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'ok' }) });
  const out = await stt.transcribe({ audio: audio(4096), lang: 'en-IN' });
  assert.equal(out.provider, 'sarvam');
  // …and health says so, because invisible routing is routing nobody notices
  // has broken.
  assert.equal(stt.sttStatus().byLang['en-IN'].serves, 'sarvam');
});

await t('a per-language override beats the default', async () => {
  reset(); clearEnv();
  process.env.DEEPGRAM_API_KEY = 'k';
  process.env.SARVAM_API_KEY = 'k';
  process.env.STT_PROVIDER_TE_IN = 'deepgram';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('సరే') });
  const out = await stt.transcribe({ audio: audio(4096), lang: 'te-IN' });
  assert.equal(out.provider, 'deepgram');
  delete process.env.STT_PROVIDER_TE_IN;
});

await t('THE CHAIN ACTUALLY DISPATCHES ON THE PROVIDER', async () => {
  // It walked the chain and then called Sarvam every time regardless. Harmless
  // with one adapter; a silent lie with two — health would report Deepgram
  // while the audio went to Sarvam.
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram';
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('three bedrooms') });

  const out = await stt.transcribe({ audio: audio(4096), lang: 'en-IN' });
  assert.equal(out.provider, 'deepgram');
  assert.equal(out.text, 'three bedrooms');
  assert.ok(calls.every((c) => !/sarvam/.test(c.url)), 'nothing may reach Sarvam here');
});

await t('the key travels as an Authorization header, never in the URL', async () => {
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram';
  process.env.DEEPGRAM_API_KEY = 'dg-secret';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('ok') });
  await stt.transcribe({ audio: audio(4096), mime: 'audio/webm;codecs=opus', lang: 'en-IN' });

  assert.equal(calls[0].init.headers.Authorization, 'Token dg-secret');
  assert.doesNotMatch(calls[0].url, /dg-secret/, 'a key in the query string lands in every proxy log');
  // The codec parameter is stripped; the container is not invented.
  assert.equal(calls[0].init.headers['Content-Type'], 'audio/webm');
});

await t('TELUGU IS PINNED, because Deepgram cannot code-switch into it', async () => {
  // `language=multi` covers English and Hindi and NOT Telugu, so a Telugu call
  // has to name the language. This is the real cost of the swap: Saaras
  // auto-detects across all three and Deepgram cannot.
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram';
  process.env.DEEPGRAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('సరే') });

  await stt.transcribe({ audio: audio(4096), lang: 'te-IN' });
  assert.match(calls[0].url, /language=te(&|$)/, `expected language=te, got ${calls[0].url}`);
  assert.match(calls[0].url, /model=nova-3/);
});

await t('…and an unknown language asks for code-switching rather than guessing', async () => {
  // Guessing Telugu wrong produces fluent nonsense rather than an obvious
  // failure, which is the worst shape a transcription error can take.
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram';
  process.env.DEEPGRAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('hello', 'hi') });
  const out = await stt.transcribe({ audio: audio(4096) });
  assert.match(calls[0].url, /language=multi/);
  assert.equal(out.lang, 'hi', 'what it detected under multi is what comes back');
});

await t('a pinned language is reported back, not null', async () => {
  // Deepgram reports detected_language only under multi. The caller uses this
  // to decide which voice answers, so null would silently change her language.
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram';
  process.env.DEEPGRAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => dgOk('సరే') });
  const out = await stt.transcribe({ audio: audio(4096), lang: 'te-IN' });
  assert.equal(out.lang, 'te-IN');
});

await t('DEEPGRAM DOWN FALLS THROUGH TO SARVAM, and says so', async () => {
  // The whole point of a chain. One vendor's outage must not be a dead call.
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram,sarvam';
  process.env.DEEPGRAM_API_KEY = 'k';
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => json({ err_msg: 'upstream boom' }, 500) });
  routes.push({ match: /speech-to-text/, reply: () => json({ transcript: 'rescued', language_code: 'te-IN' }) });

  const out = await stt.transcribe({ audio: audio(4096), lang: 'te-IN' });
  assert.equal(out.provider, 'sarvam');
  assert.equal(out.text, 'rescued');
});

await t("a Deepgram error carries the vendor's own sentence", async () => {
  reset(); clearEnv();
  process.env.STT_PROVIDER = 'deepgram';
  process.env.DEEPGRAM_API_KEY = 'k';
  routes.push({ match: /api\.deepgram\.com/, reply: () => json({ err_msg: 'Unknown model nova-9' }, 400) });
  await assert.rejects(() => stt.transcribe({ audio: audio(4096) }), (err) => {
    assert.match(String(err.detail), /Unknown model nova-9/);
    assert.doesNotMatch(String(err.detail), /\[object Object\]/);
    return true;
  });
});

await t('an unconfigured Deepgram is not "ready", and health names the model', () => {
  clearEnv();
  assert.equal(stt.sttReady('deepgram'), false);
  process.env.DEEPGRAM_API_KEY = 'dg-secret';
  assert.equal(stt.sttReady('deepgram'), true);
  const s = stt.sttStatus();
  assert.equal(s.deepgramModel, 'nova-3');
  assert.doesNotMatch(JSON.stringify(s), /dg-secret/, 'health must never carry the key');
});

// ===========================================================================
section('§5 speaking before the model has finished thinking');
// ===========================================================================

const llm = await import('../api/_lib/llm.js');

/** An SSE body that dribbles a JSON answer out one piece at a time. */
function sseStream(pieces) {
  const enc = new TextEncoder();
  const frames = pieces.map((p) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  frames.push('data: [DONE]\n\n');
  let i = 0;
  return {
    ok: true, status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < frames.length
          ? { value: enc.encode(frames[i++]), done: false }
          : { value: undefined, done: true }),
      }),
    },
  };
}

await t('THE OPENING PHRASE ARRIVES BEFORE THE ANSWER DOES', async () => {
  // Synthesis needs the first few words, not the whole line. Handing them over
  // as the model writes them overlaps the two slowest legs of the turn instead
  // of queueing one behind the other.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  const seen = [];
  routes.push({
    match: /chat\/completions/,
    reply: () => sseStream([
      '{"say":"Are you look', 'ing to live in it, or to inv',
      'est?","end":false,"disposition":"qualifying"}',
    ]),
  });

  const out = await llm.generate({
    user: 'go', json: true, onFirstClause: (h) => seen.push(h),
  });
  assert.deepEqual(seen, ['Are you looking to live in it,'],
    'exactly once, and it must be the phrase the splitter would have cut');
  assert.equal(out.say, 'Are you looking to live in it, or to invest?',
    'and the full answer is unchanged — this only moves WHEN we learn the start');
  assert.equal(out.disposition, 'qualifying');
});

await t('streaming is asked for ONLY when somebody is waiting on it', async () => {
  // The summary endpoint has no listener and no use for a partial answer.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({
    match: /chat\/completions/,
    reply: () => json({ choices: [{ message: { content: '{"say":"hello","end":false}' } }] }),
  });
  await llm.generate({ user: 'go', json: true });
  assert.equal(JSON.parse(calls[0].init.body).stream, undefined);
});

await t('a callback that throws never takes the turn down with it', async () => {
  // Starting a synthesis early is an optimisation. The line still has to come
  // back, and it does.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({
    match: /chat\/completions/,
    reply: () => sseStream(['{"say":"Okay, that helps a lot here."}']),
  });
  const out = await llm.generate({
    user: 'go', json: true, onFirstClause: () => { throw new Error('boom'); },
  });
  assert.equal(out.say, 'Okay, that helps a lot here.');
});

await t('a stream that never yields a clause still answers', async () => {
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  const seen = [];
  routes.push({
    match: /chat\/completions/,
    reply: () => sseStream(['{"say":"Yes"', ',"end":true}']),
  });
  const out = await llm.generate({
    user: 'go', json: true, onFirstClause: (h) => seen.push(h),
  });
  assert.equal(out.say, 'Yes');
  assert.deepEqual(seen, ['Yes'], 'the whole short line is its own first phrase');
});

await t('A STALLED STREAM ENDS THE TURN INSTEAD OF HANGING FOREVER', async () => {
  // THE BUG THIS EXISTS FOR, found by an in-region measurement: ten of twenty
  // turns produced no audio and no error, reported as "the turn never
  // completed". clearTimeout() sat in a `finally` on the fetch, and fetch()
  // resolves when the HEADERS arrive — so on a STREAMED response the body read
  // had no deadline at all. A stream that stopped mid-completion hung forever.
  //
  // On a measurement that is a missing sample. On a live call it is worse than
  // an error: she stops mid-conversation and never speaks again, and nothing
  // knows the turn is still waiting.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  process.env.LLM_STREAM_STALL_MS = '120';        // so the test is not slow

  const enc = new TextEncoder();
  routes.push({
    match: /chat\/completions/,
    reply: () => ({
      ok: true, status: 200,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: (opts) => {
              if (!sent) {
                sent = true;
                return Promise.resolve({
                  value: enc.encode('data: {"choices":[{"delta":{"content":"{\\"say\\":\\"Hello there, "}}]}\n\n'),
                  done: false,
                });
              }
              // Then nothing, ever — the stall this must survive.
              return new Promise((_, reject) => {
                setTimeout(() => {
                  const e = new Error('aborted');
                  e.name = 'AbortError';
                  reject(e);
                }, 400);
              });
            },
          };
        },
      },
    }),
  });

  const began = Date.now();
  let threw = null;
  try {
    await llm.generate({ user: 'go', json: true, onFirstClause: () => {} });
  } catch (err) { threw = err; }

  assert.ok(threw, 'a stalled stream must throw, not resolve and not hang');
  // The chain wraps it as llm_unavailable — correct, a stalled provider is one
  // to fall past — but the REASON has to survive, or this is indistinguishable
  // in a log from a missing key.
  assert.match(String(threw.detail || ''), /stall/i,
    `the reason must name the stall, got detail: ${threw.detail}`);
  assert.ok(Date.now() - began < 3000,
    'it must give up in about the stall window, not wait for a caller to time out');
  delete process.env.LLM_STREAM_STALL_MS;
});

// ===========================================================================
section('§6 the backchannel — what she says while she is thinking');
// ===========================================================================

function get(query = {}) {
  const req = { method: 'GET', query, headers: {}, socket: { remoteAddress: '10.0.0.2' } };
  let done;
  const p = new Promise((r) => { done = r; });
  const res = {
    statusCode: 200,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { done({ status: this.statusCode, body: o }); return this; },
  };
  return Promise.resolve(turn(req, res)).then(() => p);
}

await t('THE OPENING RESPONSE CARRIES THE ACKNOWLEDGEMENT LINES', async () => {
  // Three vendor calls run in series after a prospect stops talking, and until
  // the first audio returns nothing happens at all — measured at three to five
  // seconds. A person makes a sound within about 200ms. These are what she says
  // in that gap; they carry no information, which is why they can be said
  // before the model has decided anything.
  reset(); clearEnv();
  process.env.TTS_PROVIDER = 'none';
  const r = await get({ lang: 'te-IN', direction: 'outbound' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.backchannel) && r.body.backchannel.length,
    'the client must not have to invent a line a prospect will hear');
  assert.ok(r.body.backchannel.every((s) => typeof s === 'string' && s.length && s.length < 40));
});

await t('they are FLOW DATA, in the language of the call', async () => {
  // Versioned wording, not a constant in a browser script — same rule as the
  // greeting. A Telugu "సరే" in an English call is worse than saying nothing.
  reset(); clearEnv();
  process.env.TTS_PROVIDER = 'none';
  const te = (await get({ lang: 'te-IN' })).body.backchannel;
  const en = (await get({ lang: 'en-IN' })).body.backchannel;
  const hi = (await get({ lang: 'hi-IN' })).body.backchannel;
  assert.notDeepEqual(te, en, 'each language needs its own');
  assert.notDeepEqual(hi, en);
  assert.ok(te.some((s) => /[ఀ-౿]/.test(s)), 'the Telugu set must be in Telugu script');

  const fs = await import('node:fs');
  const flow = JSON.parse(fs.readFileSync(
    new URL('../caller-agent/flows/real-estate-qualify.flow.json', import.meta.url), 'utf8'));
  assert.deepEqual(te, flow.globals.backchannel.lines['te-IN'].map((s) => s.trim()),
    'served from the flow file, not from a constant in the handler');
});

await t('no vendor is called to fetch them — the opening must stay fast', async () => {
  reset(); clearEnv();
  process.env.TTS_PROVIDER = 'none';
  await get({ lang: 'te-IN' });
  assert.equal(calls.length, 0,
    'four synths in front of the one line that has to be fast defeats the purpose');
});

await t('ALL OF THEM COME BACK RENDERED, IN ONE REQUEST', async () => {
  // Four separate fetches put four hits per call into a bucket capped at 60.
  // That is fine for one person on one line and wrong behind a carrier NAT,
  // where several prospects share an address and the fourth is rate limited
  // into silence — which this suite reproduced before the shape changed.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  // The batch endpoint answers JSON; the stream endpoint answers raw bytes.
  // Pin batch so one stub shape is the right one.
  process.env.SARVAM_STREAM = '0';
  routes.push({ match: /sarvam\.ai\/text-to-speech/, reply: () => json({ audios: ['QUJD'] }) });

  const r = await get({ backchannel: '1', lang: 'te-IN' });
  assert.equal(r.status, 200);
  assert.ok(r.body.lines.length >= 2, 'more than one, or every gap sounds identical');
  assert.ok(r.body.lines.every((l) => l.text && l.audio && l.mime));
  assert.equal(r.body.lang, 'te-IN');
});

await t('a synthesis outage costs the acknowledgement and nothing else', async () => {
  // She goes back to being silent through the gap, which is where this started.
  // A 503 here would take out a call over a noise.
  reset(); clearEnv();
  process.env.SARVAM_API_KEY = 'k';
  routes.push({ match: /sarvam\.ai/, reply: () => json({ error: { message: 'down' } }, 500) });
  const r = await get({ backchannel: '1', lang: 'en-IN' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lines, []);
});

await t('the page renders them ONCE and never writes them into the transcript', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../web/assets/demo-call.js', import.meta.url), 'utf8');
  assert.match(src, /function primeAcks/);
  assert.match(src, /function acknowledge/);
  assert.match(src, /backchannel=1/, 'one request for the set, not one per line');
  // It is a noise, not a turn. A model shown "okay" as its own previous line
  // starts treating it as one and answering it.
  const ack = src.slice(src.indexOf('function acknowledge'), src.indexOf('function acknowledge') + 900);
  assert.doesNotMatch(ack, /history\.push|bubble\(/,
    'an acknowledgement must never become a turn in the transcript or the history');
  // Its own element: sharing the reply's would swap the src out from under a
  // line she is still speaking and resolve the wrong promise in speak().
  assert.match(src, /ackElement\(\)/);
});

// ===========================================================================
section('§7 the browser sends what the server needs to judge');
// ===========================================================================

await t('the call page reports the measured utterance length with the audio', async () => {
  // Without it the server is back to guessing duration from byte length, which
  // is the bug in §4. This is a one-line contract and it is easy to drop.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../web/assets/demo-call.js', import.meta.url), 'utf8');
  assert.match(src, /audio: b64, mime: u\.mime, ms: u\.ms/,
    'the utterance duration must be posted alongside the audio');
});

await t('the microphone hands the duration over with the blob', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../web/assets/mic.js', import.meta.url), 'utf8');
  assert.match(src, /onUtterance\(\{ blob: blob, mime: mime, ms: ms \}\)/);
});

globalThis.fetch = realFetch;
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
