// scripts/test-voicestudio.mjs
//
// QA for the self-hosted voice engine on the CALL leg — the caller-agent
// adapters, not the browser demo.
//
// ── WHAT THIS PROVES ──────────────────────────────────────────────────────
// The sample-rate path, which is where this integration would break on its
// first real call and break *quietly*: a TTS engine renders at 24kHz, a phone
// line is 8kHz, and handing 24kHz samples to a transport that believes they are
// 8kHz does not throw — it plays Anaga three times too fast to a stranger. Also
// the WAV chunk walk (real encoders insert LIST/fact chunks), the refusal of an
// unpinned gender, and that STT sends a container the server can trust.
//
// ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
// That any of it sounds good, or that a real box answers. Every network call is
// stubbed. Whether Hindi and Telugu hold up against Sarvam is a listening test
// with native speakers — see engineering/VOICESTUDIO_REFERENCE.md §6.
//
// Run: node --experimental-detect-module scripts/test-voicestudio.mjs

import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const speech = await import(`${ROOT}/caller-agent/src/providers/speech.js`);
const { createSTT, createTTS, wrapWav, parseWav, resamplePcm16, toTelephonyPcm } = speech;

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let routes = [], calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  for (const r of routes) if (r.match.test(u)) return r.reply(u, init);
  throw new Error('unstubbed fetch: ' + u);
};
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
});
const binary = (buf, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => ({}), text: async () => '',
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
});
function reset() { routes = []; calls = []; }

const ENV = ['VOICESTUDIO_URL', 'VOICESTUDIO_API_KEY', 'VOICESTUDIO_VOICE_MALE',
  'VOICESTUDIO_VOICE_FEMALE', 'VOICESTUDIO_MODEL', 'TTS_GENDER', 'TELEPHONY_SAMPLE_RATE',
  'VOICESTUDIO_ASR_MODEL'];
function clearEnv() { for (const k of ENV) delete process.env[k]; }
clearEnv();

/** A one-second sine at `rate`, as 16-bit mono PCM. */
function tone(rate, seconds = 1, hz = 440) {
  const n = Math.floor(rate * seconds);
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 16000);
  return Buffer.from(s.buffer);
}

// ===========================================================================
section('§1 WAV parsing — the header is the only trustworthy source of rate');
// ===========================================================================

await t('wrapWav round-trips through parseWav', () => {
  const pcm = tone(8000, 0.1);
  const w = parseWav(wrapWav(pcm, 8000));
  assert.equal(w.sampleRate, 8000);
  assert.equal(w.channels, 1);
  assert.equal(w.bitsPerSample, 16);
  assert.equal(w.format, 1);
  assert.equal(w.data.length, pcm.length);
});

await t('the data chunk is FOUND, not assumed to start at byte 44', () => {
  // Real encoders insert LIST/fact chunks between fmt and data. Trusting the
  // fixed offset splices that metadata into the audio as a burst of noise.
  const pcm = tone(16000, 0.05);
  const base = wrapWav(pcm, 16000);
  const fmt = base.subarray(12, 36);                 // the fmt chunk
  const list = Buffer.alloc(8 + 10);
  list.write('LIST', 0); list.writeUInt32LE(10, 4); list.write('INFOxxxxxx', 8);
  const dataChunk = Buffer.alloc(8);
  dataChunk.write('data', 0); dataChunk.writeUInt32LE(pcm.length, 4);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0); head.writeUInt32LE(4 + fmt.length + list.length + 8 + pcm.length, 4); head.write('WAVE', 8);
  const w = parseWav(Buffer.concat([head, fmt, list, dataChunk, pcm]));
  assert.equal(w.sampleRate, 16000);
  assert.equal(w.data.length, pcm.length);
  assert.equal(w.data[0], pcm[0], 'the data must be the audio, not the LIST chunk');
});

await t('a non-WAV body is rejected rather than played as noise', () => {
  assert.throws(() => parseWav(Buffer.from('this is an mp3, honest')), /not_a_wav/);
});

await t('24-bit or compressed WAV fails LOUDLY', () => {
  const pcm = tone(24000, 0.02);
  const w = wrapWav(pcm, 24000);
  w.writeUInt16LE(24, 34);                            // claim 24-bit
  assert.throws(() => toTelephonyPcm(w, 8000), /unsupported_wav_format/);
  // A silent mis-decode reaches the prospect's ear; an exception costs one hop.
});

// ===========================================================================
section('§2 resampling — the chipmunk bug');
// ===========================================================================

await t('24kHz down to 8kHz yields a THIRD of the samples', () => {
  const src = new Int16Array(24000);
  const out = resamplePcm16(src, 24000, 8000);
  assert.equal(out.length, 8000);
  // If this were skipped, one second of speech would play in 0.33s — Anaga at
  // three times speed on a live call, with nothing in any log to say why.
});

await t('a matching rate is passed through untouched', () => {
  const src = new Int16Array([1, 2, 3, 4]);
  assert.equal(resamplePcm16(src, 8000, 8000), src);
});

await t('resampling preserves the waveform, not just the length', () => {
  const rate = 24000, hz = 200;
  const n = rate;
  const src = new Int16Array(n);
  for (let i = 0; i < n; i++) src[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 16000);
  const out = resamplePcm16(src, rate, 8000);
  // 200Hz over one second = 200 zero-crossing pairs, whatever the rate.
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
  assert.ok(Math.abs(crossings - 400) <= 4, `expected ~400 crossings, got ${crossings}`);
});

await t('toTelephonyPcm converts a 24kHz WAV to 8kHz raw PCM', () => {
  const out = toTelephonyPcm(wrapWav(tone(24000, 1), 24000), 8000);
  assert.equal(out.length, 8000 * 2, 'one second at 8kHz, 16-bit');
});

await t('stereo is averaged to mono, not half-dropped', () => {
  const frames = 100;
  const inter = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { inter[i * 2] = 1000; inter[i * 2 + 1] = 3000; }
  const wav = wrapWav(Buffer.from(inter.buffer), 8000, 2);
  const out = toTelephonyPcm(wav, 8000);
  const samples = new Int16Array(out.buffer, out.byteOffset, out.length / 2);
  assert.equal(samples.length, frames);
  assert.equal(samples[0], 2000, 'the two channels should average, not one win');
});

// ===========================================================================
section('§3 TTS on the call leg');
// ===========================================================================

await t('synth returns 8kHz frames from a 24kHz engine', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';
  let sent = null;
  routes = [{ match: /audio\/speech/, reply: (_u, init) => {
    sent = JSON.parse(init.body);
    return binary(wrapWav(tone(24000, 1), 24000));
  } }];
  const tts = createTTS({ provider: 'voicestudio' });
  const out = await tts.synth('Namaste', 'hi-IN');

  assert.equal(sent.response_format, 'wav', 'WAV carries the true rate; headerless PCM is a guess');
  assert.equal(sent.voice, 'prof_aria');
  assert.equal(sent.language, 'hi');
  assert.equal(out.audio.length, 16000, 'one second at 8kHz 16-bit');
  // 20ms frames at 8kHz 16-bit = 320 bytes; one second = 50 of them.
  assert.equal(out.frames.length, 50);
  assert.equal(out.frames[0].length, 320);
  clearEnv();
});

await t('TELEPHONY_SAMPLE_RATE is honoured end to end', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';
  process.env.TELEPHONY_SAMPLE_RATE = '16000';
  routes = [{ match: /audio\/speech/, reply: () => binary(wrapWav(tone(24000, 1), 24000)) }];
  const out = await createTTS({ provider: 'voicestudio' }).synth('hello', 'en-IN');
  assert.equal(out.audio.length, 32000, 'one second at 16kHz 16-bit');
  assert.equal(out.frames[0].length, 640, '20ms at 16kHz');
  clearEnv();
});

await t('THE HONESTY RULE: an unpinned gender is refused on the call leg too', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';   // no male clone
  process.env.TTS_GENDER = 'male';
  routes = [{ match: /audio\/speech/, reply: () => binary(wrapWav(tone(24000, 0.1), 24000)) }];
  await assert.rejects(
    () => createTTS({ provider: 'voicestudio' }).synth('hello', 'en-IN'),
    /voicestudio_no_male_voice/,
  );
  assert.equal(calls.length, 0, 'it must not synthesize against the wrong clone');
  clearEnv();
});

await t('a missing VOICESTUDIO_URL is a clear error, not a bad fetch', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';
  await assert.rejects(
    () => createTTS({ provider: 'voicestudio' }).synth('hello', 'en-IN'),
    /VOICESTUDIO_URL not configured/,
  );
  clearEnv();
});

await t('the API key is sent when set, and omitted when not', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  process.env.VOICESTUDIO_VOICE_FEMALE = 'prof_aria';
  routes = [{ match: /audio\/speech/, reply: () => binary(wrapWav(tone(8000, 0.05), 8000)) }];
  await createTTS({ provider: 'voicestudio' }).synth('hi', 'en-IN');
  assert.equal(calls.at(-1).init.headers.Authorization, undefined);

  process.env.VOICESTUDIO_API_KEY = 'vs-secret';
  await createTTS({ provider: 'voicestudio' }).synth('hi', 'en-IN');
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer vs-secret');
  clearEnv();
});

// ===========================================================================
section('§4 STT on the call leg');
// ===========================================================================

await t('raw telephony PCM is wrapped in a WAV before it is sent', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  let form = null;
  routes = [{ match: /audio\/transcriptions/, reply: (_u, init) => {
    form = init.body;
    return json({ text: 'do not call me again' });
  } }];
  const stt = createSTT({ provider: 'voicestudio' });
  const text = await stt.transcribe([tone(8000, 0.2)], 'hi-IN');
  assert.equal(text, 'do not call me again');

  const file = form.get('file');
  const head = Buffer.from(await file.arrayBuffer()).subarray(0, 44);
  assert.equal(head.toString('ascii', 0, 4), 'RIFF', 'the server must not have to guess the format');
  assert.equal(head.readUInt32LE(24), 8000, 'and must not have to guess the rate — 8kHz misread is gibberish');
  assert.equal(form.get('language'), 'hi');
  clearEnv();
});

await t('an empty buffer transcribes to nothing without a round trip', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  const text = await createSTT({ provider: 'voicestudio' }).transcribe([], 'en-IN');
  assert.equal(text, '');
  assert.equal(calls.length, 0);
  clearEnv();
});

await t('a server error surfaces with its status', async () => {
  clearEnv(); reset();
  process.env.VOICESTUDIO_URL = 'http://10.0.0.4:3900';
  routes = [{ match: /audio\/transcriptions/, reply: () => json({}, 503) }];
  await assert.rejects(
    () => createSTT({ provider: 'voicestudio' }).transcribe([tone(8000, 0.1)], 'en-IN'),
    /voicestudio_stt_503/,
  );
  clearEnv();
});

// ===========================================================================
section('§5 the deployment cannot quietly expose the box');
// ===========================================================================

await t('the compose file binds loopback only, and says why', async () => {
  const fs = await import('node:fs');
  const yml = fs.readFileSync(new URL('../deploy/voicestudio/docker-compose.yml', import.meta.url), 'utf8');
  const maps = yml.match(/^\s*-\s*"[^"]*:3900"/gm) || [];
  assert.ok(maps.length >= 2, 'expected a port mapping per profile');
  for (const m of maps) {
    assert.match(m, /127\.0\.0\.1:3900:3900/,
      `VoiceStudio ships NO auth — every mapping must be loopback-only, got: ${m.trim()}`);
  }
  assert.match(yml, /NO AUTHENTICATION/i, 'the reason must be written where someone about to change it will read it');
  assert.match(yml, /AGPL/, 'the licence boundary belongs in the deployment file too');
});

globalThis.fetch = realFetch;
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
