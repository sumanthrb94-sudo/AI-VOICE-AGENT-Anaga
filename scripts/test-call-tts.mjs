// scripts/test-call-tts.mjs
//
// QA for Bulbul on the CALL leg — caller-agent/src/providers/speech.js, not the
// browser demo.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// Every suite in the repo passed while this path was broken in three separate
// ways at once, because nothing exercised it:
//
//   1. It sent enable_preprocessing to bulbul:v3, which rejects it. Every line
//      of every real call would have 4xx'd.
//   2. Its default speaker was 'anushka' — a bulbul:v2 name — against a v3
//      default model. v2 and v3 share no speakers.
//   3. It framed the WAV *including its 44-byte header* as if the header were
//      samples, so every utterance opened with a burst of noise.
//
// None of that is visible from a unit test of the transport, and none of it is
// visible until a stranger picks up a phone. So: assert the exact bytes that go
// out, and the exact audio that comes back.
//
// Run: node --experimental-detect-module scripts/test-call-tts.mjs

import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const { createTTS, wrapWav, parseWav } = await import(`${ROOT}/caller-agent/src/providers/speech.js`);

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

const realFetch = globalThis.fetch;
let sent = null, sentUrl = '', reply = null;
globalThis.fetch = async (url, init = {}) => {
  sentUrl = String(url);
  sent = JSON.parse(init.body);
  return reply();
};

const binary = (buf) => () => ({
  ok: true, status: 200,
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  json: async () => ({}),
});
const jsonB64 = (buf) => () => ({
  ok: true, status: 200,
  json: async () => ({ audios: [buf.toString('base64')] }),
  arrayBuffer: async () => new ArrayBuffer(0),
});

/** `seconds` of a 440Hz tone at `rate`, as a real WAV file. */
function wavTone(rate, seconds = 0.2) {
  const n = Math.floor(rate * seconds);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16000);
  return wrapWav(Buffer.from(s.buffer), rate);
}

const ENV = ['SARVAM_API_KEY', 'SARVAM_TTS_MODEL', 'TTS_SPEAKER', 'SARVAM_STREAM',
  'TELEPHONY_SAMPLE_RATE', 'TTS_PROVIDER'];
function clearEnv() { for (const k of ENV) delete process.env[k]; }
clearEnv();
process.env.SARVAM_API_KEY = 'k';

// ===========================================================================
section('§1 the request — what v3 will actually accept');
// ===========================================================================

await t('v3 IS NOT SENT enable_preprocessing', async () => {
  reply = binary(wavTone(8000));
  await createTTS({ provider: 'sarvam' }).synth('నమస్కారం', 'te-IN');
  assert.equal(sent.model, 'bulbul:v3');
  assert.equal('enable_preprocessing' in sent, false,
    'v3 rejects it — this 4xx\'d every line of every call');
});

await t('the default speaker belongs to the default MODEL', async () => {
  // 'anushka' is v2. A v2 name against v3 is not a fallback, it is a 400.
  assert.equal(sent.speaker, 'pooja');
  const v3 = ['shubh', 'ritu', 'priya', 'neha', 'pooja', 'simran', 'kavya'];
  assert.ok(v3.includes(sent.speaker), `${sent.speaker} is not a bulbul:v3 speaker`);
});

await t('pinning v2 restores its v2-only parameters and its own speaker', async () => {
  process.env.SARVAM_TTS_MODEL = 'bulbul:v2';
  reply = binary(wavTone(8000));
  await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');
  assert.equal(sent.model, 'bulbul:v2');
  assert.equal(sent.speaker, 'anushka');
  assert.equal(sent.enable_preprocessing, true);
  delete process.env.SARVAM_TTS_MODEL;
});

await t('TTS_SPEAKER overrides, and is sent verbatim', async () => {
  process.env.TTS_SPEAKER = 'kavya';
  reply = binary(wavTone(8000));
  await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');
  assert.equal(sent.speaker, 'kavya');
  delete process.env.TTS_SPEAKER;
});

// ===========================================================================
section('§2 the endpoint — streamed WAV, not batched MP3');
// ===========================================================================

await t('it uses the STREAM endpoint and asks for WAV', async () => {
  reply = binary(wavTone(8000));
  await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');
  assert.match(sentUrl, /\/text-to-speech\/stream$/,
    'the stream endpoint is ~400ms sooner to first byte');
  assert.equal(sent.output_audio_codec, 'wav',
    'without this the stream endpoint answers MP3, which this repo cannot decode');
});

await t('SARVAM_STREAM=0 falls back to the batch endpoint and its base64 shape', async () => {
  process.env.SARVAM_STREAM = '0';
  reply = jsonB64(wavTone(8000));
  const out = await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');
  assert.match(sentUrl, /\/text-to-speech$/);
  assert.equal('output_audio_codec' in sent, false, 'the batch endpoint takes no codec');
  assert.ok(out.audio.length > 0, 'the base64 branch must still produce audio');
  delete process.env.SARVAM_STREAM;
});

// ===========================================================================
section('§3 the audio — the header is not a sound');
// ===========================================================================

await t('THE WAV HEADER NEVER REACHES THE PHONE LINE', async () => {
  const wav = wavTone(8000, 0.2);
  reply = binary(wav);
  const out = await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');

  // 44 bytes of "RIFF….WAVEfmt….data" played as 16-bit samples is a burst of
  // noise before the first syllable — on every single line she speaks.
  assert.equal(out.audio.length, parseWav(wav).data.length,
    'the returned audio must be the SAMPLES, not the file');
  assert.equal(out.audio.subarray(0, 4).toString('latin1') === 'RIFF', false);
  assert.equal(out.frames[0].subarray(0, 4).toString('latin1') === 'RIFF', false);
});

await t('audio Sarvam returns at the WRONG rate is resampled, not replayed fast', async () => {
  // Asking for 8000 does not guarantee 8000 comes back. Handing 24kHz samples
  // to a transport that believes they are 8kHz plays Anaga three times too fast
  // to a stranger, and throws nothing.
  process.env.TELEPHONY_SAMPLE_RATE = '8000';
  reply = binary(wavTone(24000, 0.3));
  const out = await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');
  const expected = Math.round(0.3 * 8000) * 2;               // 8kHz, 16-bit
  assert.ok(Math.abs(out.audio.length - expected) <= 8,
    `expected ~${expected} bytes at 8kHz, got ${out.audio.length}`);
  delete process.env.TELEPHONY_SAMPLE_RATE;
});

await t('frames are 20ms of TELEPHONY audio, so barge-in stops mid-word', async () => {
  reply = binary(wavTone(8000, 0.2));
  const out = await createTTS({ provider: 'sarvam' }).synth('x', 'te-IN');
  assert.equal(out.frames[0].length, 320, '8000Hz × 2 bytes × 20ms = 320');
  assert.equal(out.frames.length, Math.ceil(out.audio.length / 320));
});

await t('an empty body is an error, not silence on the call', async () => {
  reply = binary(Buffer.alloc(0));
  await assert.rejects(() => createTTS({ provider: 'sarvam' }).synth('x', 'te-IN'),
    /sarvam_tts_empty/);
});

await t('an upstream failure carries its status', async () => {
  reply = () => ({ ok: false, status: 429, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => createTTS({ provider: 'sarvam' }).synth('x', 'te-IN'),
    /sarvam_tts_429/);
});

globalThis.fetch = realFetch;
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
