// scripts/test-voice.mjs
//
// QA for the voice + translation providers.
//
// ── WHAT THIS PROVES ──────────────────────────────────────────────────────
// Provider selection, the fallback chain, the honesty rules (a provider that
// cannot speak as a man must not claim it did), language normalisation, the
// chunker, and that translation fails SOFT — a translation outage returns the
// original text rather than silence.
//
// ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
// That any provider is reachable. Every network call here is stubbed, so this
// runs in CI with no keys and no egress. Whether Google Cloud TTS is enabled on
// a given project is a deploy question, answered by GET /api/integrations/health.
//
// Run: node --experimental-detect-module scripts/test-voice.mjs

import assert from 'node:assert';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log('\n' + s); }

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let routes = [];
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  for (const r of routes) if (r.match.test(u)) return r.reply(u, init);
  throw new Error('unstubbed fetch: ' + u);
};
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0), headers: new Map(),
});
const bin = (bytes, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => ({}), text: async () => '',
  arrayBuffer: async () => new Uint8Array(bytes).buffer, headers: new Map(),
});
function reset() { routes = []; calls = []; }

// Modules read env at call time, so each test can set its own world.
const ENV_KEYS = ['TTS_PROVIDER', 'SARVAM_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_SERVICE_ACCOUNT',
  'FIREBASE_SERVICE_ACCOUNT', 'TRANSLATE_PROVIDER', 'VOICESTUDIO_URL', 'VOICESTUDIO_API_KEY',
  'VOICESTUDIO_MODEL', 'VOICESTUDIO_VOICE_MALE', 'VOICESTUDIO_VOICE_FEMALE', 'SARVAM_STREAM',
  'SARVAM_TTS_MODEL', 'SARVAM_SPEAKERS', 'INDICF5_URL', 'INDICF5_VOICE_MALE', 'INDICF5_VOICE_FEMALE'];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
clearEnv();

const tts = await import('../api/_lib/tts.js');
const tr = await import('../api/_lib/translate.js');

// ===========================================================================
section('§1 language helpers');
// ===========================================================================

await t('normalizeLang fills in the Indian region for bare tags', () => {
  assert.equal(tts.normalizeLang('hi'), 'hi-IN');
  assert.equal(tts.normalizeLang('te'), 'te-IN');
  assert.equal(tts.normalizeLang('en'), 'en-IN');
});

await t('normalizeLang preserves an explicit region and fixes its case', () => {
  assert.equal(tts.normalizeLang('en-us'), 'en-US');
  assert.equal(tts.normalizeLang('hi_IN'), 'hi-IN');
});

await t('shortLang strips the region for the Google Translate voice', () => {
  assert.equal(tts.shortLang('hi-IN'), 'hi');
  assert.equal(tts.shortLang('en'), 'en');
});

await t('toTranslateCode reduces a locale to the bare language subtag', () => {
  assert.equal(tr.toTranslateCode('hi-IN'), 'hi');
  assert.equal(tr.toTranslateCode('TE-in'), 'te');
  assert.equal(tr.toTranslateCode('auto'), 'auto');
  assert.equal(tr.toTranslateCode(''), 'auto');
});

// ===========================================================================
section('§2 provider readiness — what this deployment can actually do');
// ===========================================================================

await t('the Google Translate voice needs no credential at all', () => {
  clearEnv();
  assert.equal(tts.providerReady('gtranslate'), true);
  // …which is the point: a fresh deploy has a real voice before anyone
  // touches a billing console.
  assert.equal(tts.ttsAvailable(), true);
});

await t('Cloud TTS is ready on an API key OR a service account', () => {
  clearEnv();
  assert.equal(tts.providerReady('google'), false);
  process.env.GOOGLE_API_KEY = 'k';
  assert.equal(tts.providerReady('google'), true);
  delete process.env.GOOGLE_API_KEY;
  process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"p","private_key":"x","client_email":"e"}';
  assert.equal(tts.providerReady('google'), true);
  clearEnv();
});

await t('maleCapable reflects what the providers can really do', () => {
  clearEnv();
  // Nothing configured: only gtranslate can run, and it has one voice per
  // language, so a male voice cannot be served and the UI must not promise one.
  assert.equal(tts.ttsStatus().maleCapable, false);

  process.env.GOOGLE_API_KEY = 'k';
  assert.equal(tts.ttsStatus().maleCapable, true, 'Cloud TTS resolves by ssmlGender');
  clearEnv();

  // CORRECTED: this used to assert Sarvam was never male-capable, which was a
  // belief of mine and not a fact. Probing bulbul:v2 with a live key shows
  // abhilash, karun and hitesh all return audio in en-IN, hi-IN and te-IN. The
  // test was encoding the mistake, so the fix is here as well as in the code.
  process.env.TTS_PROVIDER = 'sarvam';
  process.env.SARVAM_API_KEY = 's';
  assert.equal(tts.ttsStatus().maleCapable, true, 'Sarvam has male speakers');
  clearEnv();
});

await t('TTS_PROVIDER is a chain, and ready[] lists only what can run', () => {
  clearEnv();
  process.env.TTS_PROVIDER = 'google, gtranslate ,sarvam';
  const s = tts.ttsStatus();
  assert.deepEqual(s.chain, ['google', 'gtranslate', 'sarvam']);
  assert.deepEqual(s.ready, ['gtranslate']);
  clearEnv();
});

await t('REGRESSION: the keyless fallback is LAST, so a paid voice is reached', () => {
  clearEnv();
  const chain = tts.providerChain();
  assert.equal(chain[chain.length - 1], 'gtranslate',
    'gtranslate needs no credential — anywhere but last, nothing after it runs');
  assert.ok(chain.indexOf('sarvam') < chain.indexOf('gtranslate'),
    'Sarvam must be tried before the free fallback');

  // The bug this encodes: with a Sarvam key set and gtranslate ordered first,
  // production served the free Google Translate voice on every line while the
  // paid key sat unused. Confirmed live before the fix.
  process.env.SARVAM_API_KEY = 's';
  const ready = tts.ttsStatus().ready;
  assert.equal(ready[0], 'sarvam', `expected sarvam to be first ready, got ${ready.join(',')}`);
  clearEnv();
});

await t('and with a Sarvam key set, sarvam actually answers', async () => {
  clearEnv(); reset();
  process.env.SARVAM_API_KEY = 's';
  routes = [
    { match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53, 0x41]) },
    { match: /translate_tts/, reply: () => bin([0xff, 0xfb, 0x00]) },
  ];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  assert.equal(out.provider, 'sarvam', 'the paid voice must win over the free fallback');
  assert.equal(calls.some((c) => /translate_tts/.test(c.url)), false,
    'gtranslate should not even be called when sarvam succeeds');
  clearEnv();
});

await t('Sarvam uses the STREAM endpoint by default, and MP3 not WAV', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'sarvam';
  process.env.SARVAM_API_KEY = 's';
  let url = null;
  routes = [{ match: /api\.sarvam\.ai/, reply: (u) => { url = u; return bin([0xff, 0xfb, 0x53]); } }];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  // Measured: stream ttfb 1.02s / 52KB vs batch 1.20s / 204KB for one sentence.
  assert.match(url, /\/text-to-speech\/stream$/, 'the streaming endpoint is the default');
  assert.equal(out.mime, 'audio/mpeg');
  clearEnv();
});

await t('SARVAM_STREAM=0 falls back to the batch endpoint and WAV', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'sarvam';
  process.env.SARVAM_API_KEY = 's';
  process.env.SARVAM_STREAM = '0';
  let url = null;
  routes = [{ match: /api\.sarvam\.ai/, reply: (u) => { url = u; return json({ audios: ['U0FS'] }); } }];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  assert.doesNotMatch(url, /\/stream$/);
  assert.equal(out.mime, 'audio/wav');
  delete process.env.SARVAM_STREAM;
  clearEnv();
});

await t('a male Sarvam speaker is reported as male, not assumed female', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'sarvam';
  process.env.SARVAM_API_KEY = 's';
  routes = [{ match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53]) }];
  process.env.SARVAM_TTS_MODEL = 'bulbul:v2';     // these are v2 speaker names
  assert.equal((await tts.synth({ text: 'x', lang: 'en-IN', speaker: 'abhilash' })).gender, 'male');
  assert.equal((await tts.synth({ text: 'x', lang: 'en-IN', speaker: 'karun' })).gender, 'male');
  assert.equal((await tts.synth({ text: 'x', lang: 'en-IN', speaker: 'anushka' })).gender, 'female');
  clearEnv();
});

await t('A VERSION BUMP MUST NOT CHANGE SOMEBODY\'S GENDER', async () => {
  // v2's speakers are not v3's. A deployment carrying TTS_SPEAKER=anushka (a
  // woman) through the upgrade used to get "shubh" — a man — on every line,
  // with a 200 and nothing to say so. Same failure as serving a woman behind an
  // "Arjun" preset, arriving through a version bump instead of a missing profile.
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'sarvam';
  process.env.SARVAM_API_KEY = 's';
  routes = [{ match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53]) }];

  const her = await tts.synth({ text: 'x', lang: 'en-IN', speaker: 'anushka' });   // v2 female
  assert.equal(her.gender, 'female', 'a female speaker must not become a man on upgrade');
  assert.notEqual(her.voice, 'anushka', 'and it must actually substitute, not send a name v3 rejects');

  const him = await tts.synth({ text: 'x', lang: 'en-IN', speaker: 'abhilash' });  // v2 male
  assert.equal(him.gender, 'male');
  clearEnv();
});

await t('an unconfigured provider in the chain changes nothing', () => {
  clearEnv();
  const s = tts.ttsStatus();
  // Every paid/self-hosted provider is inert until its own env exists, so the
  // chain ORDER can be changed on cost grounds without affecting a deployment
  // that has only configured one of them.
  assert.equal(s.ready.includes('voicestudio'), false);
  assert.equal(s.ready.includes('indicf5'), false);
  assert.deepEqual(s.ready, ['gtranslate'], 'a bare deploy has exactly one usable voice');
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  assert.ok(tts.ttsStatus().ready.includes('voicestudio'));
  clearEnv();
});

await t('VoiceStudio claims a gender only when a profile id backs it', () => {
  clearEnv();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  // Configured but with no pinned voices: it can run, and can serve neither
  // gender. Those are different facts and the status must keep them apart.
  assert.equal(tts.providerReady('voicestudio'), true);
  assert.equal(tts.genderReady('voicestudio', 'male'), false);
  assert.equal(tts.genderReady('voicestudio', 'female'), false);
  assert.equal(tts.ttsStatus().maleCapable, false);

  process.env.VOICESTUDIO_VOICE_MALE = 'prof_arjun';
  assert.equal(tts.genderReady('voicestudio', 'male'), true);
  assert.equal(tts.ttsStatus().maleCapable, true, 'a pinned male clone makes the chain male-capable');
  clearEnv();
});

await t('the Translate voice is never male-capable; Sarvam is', () => {
  clearEnv();
  process.env.SARVAM_API_KEY = 's';
  assert.equal(tts.genderReady('sarvam', 'male'), true, 'abhilash/karun/hitesh');
  assert.equal(tts.genderReady('sarvam', 'female'), true, 'anushka/manisha/vidya/arya');
  // gtranslate really does have exactly one voice per language.
  assert.equal(tts.genderReady('gtranslate', 'male'), false);
  assert.equal(tts.genderReady('gtranslate', 'female'), true);
  clearEnv();
});

await t('every probed bulbul:v2 speaker is accepted, and an unknown one falls back', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'sarvam';
  process.env.SARVAM_API_KEY = 's';
  process.env.SARVAM_TTS_MODEL = 'bulbul:v2';   // this test is about v2's names
  let sent = null;
  routes = [{ match: /api\.sarvam\.ai/, reply: (_u, init) => { sent = JSON.parse(init.body); return bin([0xff, 0xfb, 0x53]); } }];

  for (const spk of ['anushka', 'manisha', 'vidya', 'arya', 'abhilash', 'karun', 'hitesh']) {
    await tts.synth({ text: 'x', lang: 'te-IN', speaker: spk });
    assert.equal(sent.speaker, spk, `${spk} must be passed through, not silently replaced`);
  }
  // A name the API would reject must not reach it.
  await tts.synth({ text: 'x', lang: 'te-IN', speaker: 'not-a-real-speaker' });
  assert.equal(sent.speaker, 'anushka');
  clearEnv();
});

// ===========================================================================
section('§3 synthesis and the fallback chain');
// ===========================================================================

await t('Cloud TTS returns MP3 and reports the male voice it resolved', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'google';
  routes = [
    { match: /\/v1\/voices/, reply: () => json({ voices: [
      { name: 'hi-IN-Standard-A', ssmlGender: 'FEMALE' },
      { name: 'hi-IN-Standard-B', ssmlGender: 'MALE' },
      { name: 'hi-IN-Wavenet-C', ssmlGender: 'MALE' },
    ] }) },
    { match: /text:synthesize/, reply: () => json({ audioContent: 'QUJD' }) },
  ];
  const out = await tts.synth({ text: 'Namaste', lang: 'hi-IN', gender: 'male' });
  assert.equal(out.provider, 'google');
  assert.equal(out.gender, 'male');
  assert.equal(out.mime, 'audio/mpeg');
  // Wavenet outranks Standard, and both outrank picking the first match.
  assert.equal(out.voice, 'hi-IN-Wavenet-C');
  clearEnv();
});

await t('an unreachable voice catalogue still honours the gender', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'google';
  let sentVoice = null;
  routes = [
    { match: /\/v1\/voices/, reply: () => json({ error: { message: 'boom' } }, 500) },
    { match: /text:synthesize/, reply: (_u, init) => {
      sentVoice = JSON.parse(init.body).voice;
      return json({ audioContent: 'QUJD' });
    } },
  ];
  // te-IN, not hi-IN: the voice catalogue is cached for 12h by design, so
  // reusing a language another test already populated would test the cache
  // rather than the unreachable-catalogue path.
  const out = await tts.synth({ text: 'hello', lang: 'te-IN', gender: 'male' });
  // Naming no voice is fine; asking Google to pick a MALE one is the point.
  assert.equal(sentVoice.ssmlGender, 'MALE');
  assert.equal(sentVoice.name, undefined);
  assert.equal(out.gender, 'male');
  clearEnv();
});

await t('VoiceStudio speaks OpenAI /v1/audio/speech and returns the pinned clone', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'voicestudio';
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900/';   // trailing slash on purpose
  process.env.VOICESTUDIO_VOICE_MALE = 'prof_arjun';
  process.env.VOICESTUDIO_API_KEY = 'vs-key';
  let sent = null, sentUrl = null, sentAuth = null;
  routes = [{ match: /audio\/speech/, reply: (u, init) => {
    sentUrl = u; sent = JSON.parse(init.body); sentAuth = init.headers.Authorization;
    return bin([0xff, 0xfb, 0x01, 0x02]);
  } }];
  const out = await tts.synth({ text: 'Namaste', lang: 'hi-IN', gender: 'male', pace: 1.1 });
  assert.equal(sentUrl, 'http://10.0.0.4:3900/v1/audio/speech', 'the trailing slash must not double up');
  assert.equal(sentAuth, 'Bearer vs-key');
  assert.equal(sent.voice, 'prof_arjun');
  assert.equal(sent.language, 'hi');          // the endpoint wants the bare subtag
  assert.equal(sent.response_format, 'mp3');
  assert.equal(sent.speed, 1.1);
  assert.equal(out.provider, 'voicestudio');
  assert.equal(out.gender, 'male');
  assert.equal(out.voice, 'prof_arjun');
  clearEnv();
});

await t('THE HONESTY RULE: an unpinned gender is refused, not approximated', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'voicestudio,sarvam';
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';      // no male clone pinned
  process.env.SARVAM_API_KEY = 's';
  routes = [
    { match: /audio\/speech/, reply: () => bin([0xff, 0xfb, 0x01]) },
    { match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53, 0x41]) },
  ];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN', gender: 'male' });
  // It must NOT synthesize a male request against the female clone. Every engine
  // will happily produce something; that something is how "Arjun" becomes a woman.
  assert.equal(out.provider, 'sarvam');
  // UPDATED: this asserted 'female'. That was correct when Sarvam's no-speaker
  // default was hardcoded to "anushka", so a male request landed on a woman and
  // the most this rule could do was make the UI admit it. Sarvam has male
  // speakers and the resolver now honours the REQUESTED gender, so the right
  // outcome is no longer "a woman, honestly labelled" — it is a man.
  assert.equal(out.gender, 'male', 'Sarvam can speak as a man; a male request should get one');
  assert.equal(calls.some((c) => /audio\/speech/.test(c.url)), false,
    'VoiceStudio should not have been called at all for an unpinned gender');
  clearEnv();
});

await t('a VoiceStudio box that is down costs one hop', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'voicestudio,gtranslate';
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';
  routes = [
    { match: /audio\/speech/, reply: () => { throw new Error('ECONNREFUSED'); } },
    { match: /translate_tts/, reply: () => bin([0xff, 0xfb, 0x00]) },
  ];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  // A self-hosted box being cold or down is the NORMAL failure here. It must
  // read as "try the next provider", never as an outage on the call.
  assert.equal(out.provider, 'gtranslate');
  clearEnv();
});

await t('A SILENT FALLBACK IS AN INCIDENT: the failure is carried out, not swallowed', async () => {
  // The bug this exists for: when the premium provider failed, the loop moved
  // on and returned 200 with the free voice. The errors were collected into an
  // array and then thrown away, so a deployment serving the fallback voice to
  // every real prospect looked identical to a healthy one — 200s in the log,
  // nothing in the error stream, and the readiness probe still calling the
  // premium provider "ready" because readiness only means "the key is set".
  // The only symptom that reached a human was "the voice sounds terrible".
  clearEnv(); reset();
  process.env.SARVAM_API_KEY = 'expired-key';
  process.env.TTS_PROVIDER = 'sarvam,gtranslate';
  routes = [
    { match: /api\.sarvam\.ai/, reply: () => json({ error: 'invalid api key' }, 403) },
    { match: /translate_tts/, reply: () => bin([0xff, 0xfb, 0x00]) },
  ];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  assert.equal(out.provider, 'gtranslate', 'the fallback still has to produce audio');
  assert.ok(Array.isArray(out.fellBackFrom) && out.fellBackFrom.length,
    'the request succeeded, but the premium voice failed and that must not vanish');
  assert.ok(/sarvam/.test(out.fellBackFrom.join(' ')), 'it must name the provider that dropped out');
  clearEnv();
});

await t('a clean success carries no fallback marker', async () => {
  clearEnv(); reset();
  process.env.SARVAM_API_KEY = 's';
  process.env.TTS_PROVIDER = 'sarvam,gtranslate';
  routes = [{ match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53]) }];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  assert.equal(out.provider, 'sarvam');
  assert.equal(out.fellBackFrom, undefined, 'a healthy request must not look like a degraded one');
  clearEnv();
});

await t('the endpoint logs the fallback and does NOT leak it to the caller', async () => {
  clearEnv(); reset();
  process.env.SARVAM_API_KEY = 'expired-key';
  process.env.TTS_PROVIDER = 'sarvam,gtranslate';
  routes = [
    { match: /api\.sarvam\.ai/, reply: () => json({ error: 'invalid api key' }, 403) },
    { match: /translate_tts/, reply: () => bin([0xff, 0xfb, 0x00]) },
  ];
  const handler = (await import('../api/tts.js?fallback=1')).default;
  const logged = [];
  const realError = console.error;
  console.error = (line) => logged.push(String(line));
  const res = { statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, setHeader() {} };
  try {
    await handler({ method: 'POST', headers: {}, body: { text: 'hello', lang: 'en-IN' } }, res);
  } finally {
    console.error = realError;
  }

  assert.equal(res.statusCode, 200, 'the caller still gets audio');
  const event = logged.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e && e.event === 'tts_fell_back');
  assert.ok(event, `no tts_fell_back logged; got: ${logged.join(' | ')}`);
  assert.equal(event.served, 'gtranslate');
  assert.equal(event.severity, 'high', 'serving the fallback voice to prospects is an incident');
  assert.ok(!('fellBackFrom' in res.body), 'internal provider errors must not reach the client');
  clearEnv();
});

await t('the default chain is cheapest-first, with the free voice LAST', async () => {
  clearEnv(); reset();
  const chain = tts.providerChain();
  assert.deepEqual(chain, ['sarvam', 'google', 'indicf5', 'voicestudio', 'gtranslate']);
  assert.equal(chain[chain.length - 1], 'gtranslate',
    'gtranslate needs no credential, so anything after it is unreachable');
  clearEnv();
});

await t('indicf5 is inert until a box is configured', async () => {
  clearEnv(); reset();
  assert.equal(tts.providerReady('indicf5'), false, 'no URL must mean no attempt');
  process.env.INDICF5_URL = 'http://gpu.invalid:8080';
  assert.equal(tts.providerReady('indicf5'), true);
  clearEnv();
});

await t('indicf5 refuses a gender it has no reference clip for', async () => {
  clearEnv(); reset();
  process.env.INDICF5_URL = 'http://gpu.invalid:8080';
  process.env.INDICF5_VOICE_FEMALE = 'anaga_te_f';
  assert.equal(tts.genderReady('indicf5', 'female'), true);
  // The model will clone SOMETHING for a missing reference. Refusing is what
  // stops a male preset being served in a woman's voice.
  assert.equal(tts.genderReady('indicf5', 'male'), false);
  clearEnv();
});

await t('indicf5 speaks, and reports itself honestly', async () => {
  clearEnv(); reset();
  process.env.INDICF5_URL = 'http://gpu.invalid:8080';
  process.env.INDICF5_VOICE_FEMALE = 'anaga_te_f';
  process.env.TTS_PROVIDER = 'indicf5,gtranslate';
  let sent = null;
  routes = [
    { match: /gpu\.invalid/, reply: (_u, init) => { sent = JSON.parse(init.body); return bin([0x52, 0x49, 0x46, 0x46]); } },
    { match: /translate_tts/, reply: () => bin([0xff, 0xfb]) },
  ];
  const out = await tts.synth({ text: 'నమస్కారం', lang: 'te-IN' });
  assert.equal(out.provider, 'indicf5');
  assert.equal(out.mime, 'audio/wav');
  assert.equal(out.voice, 'anaga_te_f');
  assert.equal(sent.language, 'te', 'the bare subtag, as the server contract expects');
  assert.equal(sent.voice, 'anaga_te_f', 'the reference NAME, never a clip');
  clearEnv();
});

await t('a cold GPU costs one hop, not the call', async () => {
  clearEnv(); reset();
  process.env.INDICF5_URL = 'http://gpu.invalid:8080';
  process.env.INDICF5_VOICE_FEMALE = 'anaga_te_f';
  process.env.SARVAM_API_KEY = 's';
  process.env.TTS_PROVIDER = 'indicf5,sarvam';
  routes = [
    { match: /gpu\.invalid/, reply: () => { throw new Error('ECONNREFUSED'); } },
    { match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53]) },
  ];
  const out = await tts.synth({ text: 'hello', lang: 'te-IN' });
  assert.equal(out.provider, 'sarvam', 'a box that is down or cold must not end the call');
  assert.ok(out.fellBackFrom.join(' ').includes('indicf5'), 'and the fallback must be reported');
  clearEnv();
});

await t('THE HONESTY RULE: the Translate voice never claims to be male', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'gtranslate';
  routes = [{ match: /translate_tts/, reply: () => bin([0xff, 0xfb, 0x00, 0x00]) }];
  const out = await tts.synth({ text: 'Namaste', lang: 'hi-IN', gender: 'male' });
  assert.equal(out.provider, 'gtranslate');
  // This endpoint has one voice per language and it is not a man's. Echoing the
  // request back would put "Arjun" on screen over a woman's voice.
  assert.equal(out.gender, 'female');
  clearEnv();
});

await t('a failing provider costs one hop, not the whole call', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  process.env.SARVAM_API_KEY = 's';
  process.env.TTS_PROVIDER = 'google,gtranslate,sarvam';
  routes = [
    { match: /\/v1\/voices/, reply: () => json({ error: { message: 'nope' } }, 403) },
    { match: /text:synthesize/, reply: () => json({ error: { message: 'nope' } }, 403) },
    { match: /translate_tts/, reply: () => json({}, 503) },
    { match: /api\.sarvam\.ai/, reply: () => bin([0xff, 0xfb, 0x53, 0x41]) },
  ];
  const out = await tts.synth({ text: 'hello', lang: 'en-IN' });
  assert.equal(out.provider, 'sarvam');
  assert.equal(out.mime, 'audio/mpeg');   // streaming endpoint returns MP3
  clearEnv();
});

await t('every provider failing throws with the reasons attached', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'gtranslate';
  routes = [{ match: /translate_tts/, reply: () => json({}, 500) }];
  await assert.rejects(
    () => tts.synth({ text: 'hi', lang: 'en-IN' }),
    (err) => {
      assert.equal(err.message, 'tts_all_providers_failed');
      // The detail is what turns a silent 503 into a diagnosable one.
      assert.match(err.detail, /gtranslate/);
      return true;
    },
  );
  clearEnv();
});

await t("Google's /sorry/ bot check reads as a rate limit, not a mystery", async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'gtranslate';
  // A 302 to /sorry/index is how Google rate-limits a datacentre IP. Following
  // it reports a failure on a host we never called.
  routes = [{ match: /translate_tts/, reply: () => ({ ok: false, status: 302, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }) }];
  await assert.rejects(
    () => tts.synth({ text: 'hi', lang: 'en-IN' }),
    (err) => { assert.match(err.detail, /rate_limited/); return true; },
  );
  clearEnv();
});

await t('long text is chunked for the Translate voice and rejoined as one clip', async () => {
  clearEnv(); reset();
  process.env.TTS_PROVIDER = 'gtranslate';
  let n = 0;
  routes = [{ match: /translate_tts/, reply: () => { n++; return bin([0xff, 0xfb, n]); } }];
  const long = ('This is a sentence about the property. ').repeat(20);   // ~760 chars
  const out = await tts.synth({ text: long, lang: 'en-IN' });
  assert.ok(n > 1, `expected several chunks, got ${n}`);
  assert.equal(Buffer.from(out.audio, 'base64').length, n * 3);
  clearEnv();
});

await t('modulation is mapped into each provider\'s own units', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'google';
  let cfg = null;
  routes = [
    { match: /\/v1\/voices/, reply: () => json({ voices: [] }) },
    { match: /text:synthesize/, reply: (_u, init) => { cfg = JSON.parse(init.body).audioConfig; return json({ audioContent: 'QQ==' }); } },
  ];
  await tts.synth({ text: 'x', lang: 'en-IN', pitch: 0.5, pace: 1.2, loudness: 1 });
  assert.equal(cfg.pitch, 4);                 // our -1..1 -> Google's semitones
  assert.equal(cfg.speakingRate, 1.2);
  assert.equal(cfg.volumeGainDb, 0);          // loudness 1 == 0 dB gain
  clearEnv();
});

await t('an out-of-range pitch is clamped, not passed through', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  process.env.TTS_PROVIDER = 'google';
  let cfg = null;
  routes = [
    { match: /\/v1\/voices/, reply: () => json({ voices: [] }) },
    { match: /text:synthesize/, reply: (_u, init) => { cfg = JSON.parse(init.body).audioConfig; return json({ audioContent: 'QQ==' }); } },
  ];
  await tts.synth({ text: 'x', lang: 'en-IN', pitch: 99, pace: 99, loudness: 99 });
  assert.equal(cfg.pitch, 20);
  assert.equal(cfg.speakingRate, 4);
  assert.ok(cfg.volumeGainDb <= 16);
  clearEnv();
});

await t('empty text is refused before any provider is called', async () => {
  clearEnv(); reset();
  await assert.rejects(() => tts.synth({ text: '   ', lang: 'en-IN' }), /tts_text_required/);
  assert.equal(calls.length, 0, 'no network call should have been made');
});

// ===========================================================================
section('§4 translation');
// ===========================================================================

await t('Cloud Translation is preferred when the project has it', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  routes = [{ match: /translation\.googleapis\.com/, reply: () => json({
    data: { translations: [{ translatedText: 'क्या आप घर देख रहे हैं?', detectedSourceLanguage: 'en' }] },
  }) }];
  const out = await tr.translate({ text: 'Are you looking for a home?', to: 'hi-IN', from: 'en-IN' });
  assert.equal(out.provider, 'cloud');
  assert.equal(out.text, 'क्या आप घर देख रहे हैं?');
  clearEnv();
});

await t('a disabled Translation API falls through to the free endpoint', async () => {
  clearEnv(); reset();
  process.env.GOOGLE_API_KEY = 'k';
  routes = [
    { match: /translation\.googleapis\.com/, reply: () => json({
      error: { message: 'Cloud Translation API has not been used in project 1 before or it is disabled.' },
    }, 403) },
    { match: /translate_a\/single/, reply: () => json([[['नमस्ते', 'hello', null, null, 3]], null, 'en']) },
  ];
  const out = await tr.translate({ text: 'hello', to: 'hi', from: 'en' });
  assert.equal(out.provider, 'free');
  assert.equal(out.text, 'नमस्ते');
  clearEnv();
});

await t('FAIL SOFT: a total outage returns the ORIGINAL text, never silence', async () => {
  clearEnv(); reset();
  routes = [{ match: /translate_a\/single/, reply: () => json({}, 500) }];
  const out = await tr.translate({ text: 'What is your budget?', to: 'hi', from: 'en' });
  assert.equal(out.provider, 'none');
  assert.equal(out.text, 'What is your budget?');
  // A translation outage must degrade to "she speaks English", not to a mute
  // agent on a live call.
  clearEnv();
});

await t('the /sorry/ redirect is reported as rate_limited', async () => {
  clearEnv(); reset();
  routes = [{ match: /translate_a\/single/, reply: () => ({ ok: false, status: 302, json: async () => ({}), text: async () => '' }) }];
  // Text no earlier test used — successful translations are cached on purpose,
  // and a cache hit here would hide the redirect entirely.
  const out = await tr.translate({ text: 'shall we book a site visit', to: 'hi', from: 'en' });
  assert.equal(out.provider, 'none');
  assert.equal(out.error, 'rate_limited');
  clearEnv();
});

await t('same-language in and out is not a round trip through a translator', async () => {
  clearEnv(); reset();
  const out = await tr.translate({ text: 'hello', to: 'en-IN', from: 'en' });
  assert.equal(out.provider, 'none');
  assert.equal(out.text, 'hello');
  assert.equal(calls.length, 0, 'nothing should have been called');
});

await t('repeat lines are served from cache — Anaga says the same things a lot', async () => {
  clearEnv(); reset();
  routes = [{ match: /translate_a\/single/, reply: () => json([[['नमस्ते', 'hello']], null, 'en']) }];
  await tr.translate({ text: 'hello there', to: 'hi', from: 'en' });
  const n = calls.length;
  const second = await tr.translate({ text: 'hello there', to: 'hi', from: 'en' });
  assert.equal(calls.length, n, 'the second call must not hit the network');
  assert.equal(second.cached, true);
  clearEnv();
});

await t('a multi-segment free response is stitched back together in order', async () => {
  clearEnv(); reset();
  routes = [{ match: /translate_a\/single/, reply: () => json([[['पहला ', 'first '], ['दूसरा', 'second']], null, 'en']) }];
  const out = await tr.translate({ text: 'first second', to: 'hi', from: 'en' });
  assert.equal(out.text, 'पहला दूसरा');
  clearEnv();
});

await t('the chunker splits on sentence ends, including the Devanagari danda', () => {
  const parts = tr.chunk('पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।', 20);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 20), `oversized chunk: ${JSON.stringify(parts)}`);
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), 'पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।');
});

await t('a single sentence longer than the limit is still cut, not dropped', () => {
  const parts = tr.chunk('x'.repeat(45), 20);
  assert.equal(parts.length, 3);
  assert.equal(parts.join('').length, 45);
});

// ===========================================================================
section('§5 the disclosure is versioned data, never machine output');
// ===========================================================================

await t('the persona carries a MALE disclosure with correct Hindi agreement', async () => {
  const fs = await import('node:fs');
  const p = JSON.parse(fs.readFileSync(new URL('../caller-agent/flows/anaga.persona.json', import.meta.url), 'utf8'));
  const male = p.disclosure.male;
  assert.ok(male, 'a male disclosure variant must exist');
  for (const lang of ['en-IN', 'hi-IN', 'te-IN']) {
    assert.ok(typeof male[lang] === 'string' && male[lang].trim(), `${lang} missing`);
    assert.match(male[lang], /\bAI\b/, `${lang} must still disclose AI`);
  }
  // Hindi marks the speaker's gender on the verb. "sakti" in a man's voice is
  // the feminine form and lands as broken Hindi.
  assert.match(p.disclosure['hi-IN'], /sakti hoon/, 'the default (female) line should stay feminine');
  assert.match(male['hi-IN'], /sakta hoon/, 'the male line must use the masculine form');
  assert.doesNotMatch(male['hi-IN'], /sakti hoon/);
});

await t('the browser ships the same gendered pair', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../web/assets/app.js', import.meta.url), 'utf8');
  assert.match(src, /ANAGA_LINES_BY_GENDER/);
  assert.match(src, /बात कर सकती हूँ/, 'feminine Hindi greeting missing');
  assert.match(src, /बात कर सकता हूँ/, 'masculine Hindi greeting missing');
});

await t('translation is never pointed at the disclosure', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../web/assets/app.js', import.meta.url), 'utf8');
  // The disclosure is spoken from the versioned line, so it must reach
  // speakText directly rather than through TranslateKit.out().
  assert.match(app, /speakText\(anagaLine\(/,
    'the sample disclosure must be spoken from the versioned line');
  const lib = fs.readFileSync(new URL('../api/_lib/translate.js', import.meta.url), 'utf8');
  assert.match(lib, /disclosure/i, 'the rule must be written down where someone will read it');
});

globalThis.fetch = realFetch;
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
