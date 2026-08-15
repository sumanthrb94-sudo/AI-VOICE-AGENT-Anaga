// scripts/test-wav.mjs
//
// shared/wav.js — what is actually inside the audio a provider returned.
//
// The call leg used to strip a WAV header and throw away the two fields that
// decide whether the bytes will play correctly: the format tag and the SAMPLE
// RATE. Handing 24kHz samples to an 8kHz phone line does not throw — it plays
// her three times too slow and pitched down, which sounds like a broken agent
// rather than a failed provider, and nothing anywhere reports it.
//
// IndicF5 hardcoded 24000 and never read the transport's rate, so that was not
// hypothetical.
//
// Run: node --experimental-detect-module scripts/test-wav.mjs

import assert from 'node:assert';
import { readWav, unwrapFor, WAVE_FORMAT } from '../shared/wav.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

/** Build a real WAV file so the parser is tested against bytes, not a mock. */
function wav({ format = WAVE_FORMAT.PCM, sampleRate = 16000, channels = 1, bits = 16, samples = 64, dataSize = null }) {
  const body = Buffer.alloc(samples, 0x11);
  const fmtSize = 16;
  const buf = Buffer.alloc(12 + 8 + fmtSize + 8 + body.length);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(buf.length - 8, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(fmtSize, o); o += 4;
  buf.writeUInt16LE(format, o); o += 2;
  buf.writeUInt16LE(channels, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), o); o += 4;  // byte rate
  buf.writeUInt16LE(channels * (bits / 8), o); o += 2;               // block align
  buf.writeUInt16LE(bits, o); o += 2;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataSize === null ? body.length : dataSize, o); o += 4;
  body.copy(buf, o);
  return buf;
}

const PHONE   = { encoding: 'mulaw', sampleRate: 8000 };
const BROWSER = { encoding: 'linear16', sampleRate: 16000 };

console.log('\n═══ WAV ═══\n');
console.log('─── parsing ───\n');

t('a PCM header is read correctly', () => {
  const info = readWav(wav({ sampleRate: 16000 }));
  assert.equal(info.wrapped, true);
  assert.equal(info.format, WAVE_FORMAT.PCM);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.samples.length, 64);
});

t('a mu-law header is read correctly', () => {
  const info = readWav(wav({ format: WAVE_FORMAT.MULAW, sampleRate: 8000, bits: 8 }));
  assert.equal(info.format, WAVE_FORMAT.MULAW);
  assert.equal(info.sampleRate, 8000);
});

t('a buffer with no RIFF header reports wrapped:false rather than lying', () => {
  const info = readWav(Buffer.alloc(200, 7));
  assert.equal(info.wrapped, false);
  assert.equal(info.samples.length, 200, 'raw bytes come back untouched');
});

t('garbage never throws', () => {
  for (const b of [Buffer.alloc(0), Buffer.alloc(4), Buffer.from('RIFFnope'), Buffer.from('not a wav at all')]) {
    const info = readWav(b);
    assert.equal(info.wrapped, false);
  }
});

t('a streamed WAV with an unknown data size takes the rest of the buffer', () => {
  // Writers that cannot know the length in advance put 0 or 0xFFFFFFFF here.
  // Returning nothing would be silence that looks like success.
  const info = readWav(wav({ dataSize: 0 }));
  assert.equal(info.samples.length, 64);
  const info2 = readWav(wav({ dataSize: 0xffffffff }));
  assert.equal(info2.samples.length, 64);
});

console.log('\n─── what may reach the line ───\n');

t('matching PCM passes through', () => {
  const out = unwrapFor(wav({ sampleRate: 16000 }), 'audio/wav', BROWSER);
  assert.equal(out.length, 64, 'the header must be gone');
  assert.equal(out[0], 0x11);
});

t('matching mu-law passes through', () => {
  const out = unwrapFor(wav({ format: WAVE_FORMAT.MULAW, sampleRate: 8000, bits: 8 }), 'audio/wav', PHONE);
  assert.equal(out.length, 64);
});

t('THE RATE MISMATCH IS REFUSED — the bug that played her slow', () => {
  // IndicF5 hardcoded 24000. On an 8kHz phone line those samples play three
  // times too slow and an octave and a half down. It used to be accepted.
  assert.throws(
    () => unwrapFor(wav({ format: WAVE_FORMAT.MULAW, sampleRate: 24000, bits: 8 }), 'audio/wav', PHONE),
    /24000Hz audio for a 8000Hz line/,
  );
  assert.throws(
    () => unwrapFor(wav({ sampleRate: 24000 }), 'audio/wav', BROWSER),
    /wrong speed and pitch/,
  );
});

t('the WRONG CODEC is refused even when the mime says wav', () => {
  // The header describes the bytes; the mime only claims something about them.
  assert.throws(
    () => unwrapFor(wav({ sampleRate: 8000, bits: 8 }), 'audio/wav', PHONE),
    /needs mu-law/,
  );
  assert.throws(
    () => unwrapFor(wav({ format: WAVE_FORMAT.MULAW, sampleRate: 16000, bits: 8 }), 'audio/wav', BROWSER),
    /needs linear PCM/,
  );
});

t('stereo and 8-bit PCM are refused', () => {
  assert.throws(() => unwrapFor(wav({ channels: 2 }), 'audio/wav', BROWSER), /2 channels/);
  assert.throws(() => unwrapFor(wav({ bits: 8 }), 'audio/wav', BROWSER), /8-bit/);
});

t('MP3 is refused on both transports — this is the silence bug', () => {
  // A provider that answers MP3 on a call leg produces silence plus a
  // transcript that says she spoke. It must fail, and say why.
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]);
  assert.throws(() => unwrapFor(mp3, 'audio/mpeg', PHONE), /not mu-law/);
  assert.throws(() => unwrapFor(mp3, 'audio/mpeg', BROWSER), /not PCM/);
});

t('headerless raw audio is still accepted on the mime alone', () => {
  // Sarvam's stream endpoint returns bare samples in the requested codec.
  const raw = Buffer.alloc(160, 0x7f);
  assert.equal(unwrapFor(raw, 'audio/l16', BROWSER).length, 160);
  assert.equal(unwrapFor(raw, 'audio/basic', PHONE).length, 160);
  assert.equal(unwrapFor(raw, 'application/octet-stream', BROWSER).length, 160);
});

t('a rate of zero disables only the rate check, not the others', () => {
  // Callers that genuinely do not care about rate still get codec safety.
  const ok = unwrapFor(wav({ sampleRate: 44100 }), 'audio/wav', { encoding: 'linear16', sampleRate: 0 });
  assert.equal(ok.length, 64);
  assert.throws(
    () => unwrapFor(wav({ format: WAVE_FORMAT.MULAW, bits: 8 }), 'audio/wav', { encoding: 'linear16', sampleRate: 0 }),
    /needs linear PCM/,
  );
});

console.log('\n─── the adapters that produced the bug ───\n');

t('IndicF5 asks for the TRANSPORT rate, not a constant', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/_lib/tts.js', import.meta.url), 'utf8');
  assert.match(src, /sample_rate: Number\(opts\.sampleRate \|\|/,
    'IndicF5 hardcoded 24000 and ignored the line it was speaking on');
});

t('Google can serve the call leg at all', async () => {
  // One word — always saying MP3 — is why the phone leg had no fallback: the
  // composition root refuses MP3, so a Sarvam hiccup was silence.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/_lib/tts.js', import.meta.url), 'utf8');
  assert.match(src, /opts\.codec === 'mulaw' \? 'MULAW'/);
  assert.match(src, /opts\.codec === 'linear16' \? 'LINEAR16'/);
  assert.match(src, /sampleRateHertz: Number\(opts\.sampleRate\)/);
  assert.match(src, /wrapped \? 'audio\/wav' : 'audio\/mpeg'/,
    'LINEAR16 and MULAW come back in a WAV container and the mime must say so');
});

t('the call leg no longer hand-rolls its own header stripping', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../caller-agent/src/agent/main.js', import.meta.url), 'utf8');
  assert.match(src, /unwrapFor\(buf, mime, \{ encoding: codec, sampleRate: rate \}\)/);
  assert.doesNotMatch(src, /function stripWavHeader/,
    'the version that discarded the sample rate must be gone, not merely unused');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
