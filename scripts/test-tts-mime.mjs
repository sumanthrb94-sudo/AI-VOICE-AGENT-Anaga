// scripts/test-tts-mime.mjs
//
// Does synth() tell the truth about what format it is handing back?
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// A deployed call failed like this, in Telugu, on the first sentence:
//
//   event=disclosure_not_delivered lang=te-IN
//   reason=voice returned audio/mpeg, which is not PCM
//
// It read like a vendor problem. It was ours. viaSarvam()'s streaming branch
// returned `mime: 'audio/mpeg'` UNCONDITIONALLY. MP3 is only the stream
// endpoint's DEFAULT — send output_audio_codec and it returns that codec
// instead, and the call leg always sends one. So Sarvam handed back correct
// raw PCM and we labelled it MP3.
//
// unwrapFor() then did exactly the right thing: raw PCM carries no WAV header,
// so the label is all there is, and it refused to play "MP3" as samples rather
// than putting a burst of noise on a live call. The disclosure could not be
// spoken, and an outbound call that cannot disclose fails closed — so the whole
// call hung up.
//
// Every existing suite passed throughout. Nothing asserted the mime.
//
// The second test guards the same failure arriving intermittently: cacheKey()
// did not include the codec or the sample rate, so a browser turn (MP3, 24kHz)
// and a call turn (linear16, 16kHz) shared a cache entry and whichever spoke
// the sentence first won.
//
// Run: node --experimental-detect-module scripts/test-tts-mime.mjs

import assert from 'node:assert';

process.env.SARVAM_API_KEY = 'test-key-not-a-real-one';
process.env.TTS_PROVIDER = 'sarvam';
process.env.SARVAM_STREAM = '1';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const { synth } = await import(`${ROOT}/api/_lib/tts.js`);
const { unwrapFor } = await import(`${ROOT}/shared/wav.js`);

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

// ── the vendor, stubbed ─────────────────────────────────────────────────────
// Answers with the codec it was ASKED for, which is what Sarvam's stream
// endpoint actually does. The bug was never in the bytes.
let lastBody = null;
let contentType = '';                    // '' = vendor declares nothing
// The pieces the "network" delivers. Deliberately ODD-sized by default: a real
// chunk boundary does not respect 16-bit samples, and that is the case most
// likely to be got wrong.
let pieces = [new Uint8Array(255).fill(1), new Uint8Array(385).fill(2)];
globalThis.fetch = async (_url, init = {}) => {
  lastBody = JSON.parse(init.body);
  const headers = new Map();
  if (contentType) headers.set('content-type', contentType);
  const whole = Buffer.concat(pieces.map((p) => Buffer.from(p)));
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () => whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.length),
    // An async iterable, which is what undici's res.body is.
    body: (async function* () { for (const p of pieces) yield Buffer.from(p); })(),
  };
};

console.log('\n═══ TTS MIME HONESTY ═══\n');

await t('a linear16 request is NOT labelled audio/mpeg', async () => {
  const out = await synth({ text: 'హలో', lang: 'te-IN', codec: 'linear16', sampleRate: 16000 });
  assert.equal(lastBody.output_audio_codec, 'linear16', 'we must ask for the codec');
  assert.notEqual(out.mime, 'audio/mpeg',
    'this is the deployed bug: correct PCM bytes labelled as MP3');
  assert.match(out.mime, /l16|linear16|pcm|octet-stream/i);
});

await t('and the call leg therefore accepts it', async () => {
  // The real consumer, not a re-implementation of its rules.
  const out = await synth({ text: 'నమస్తే', lang: 'te-IN', codec: 'linear16', sampleRate: 16000 });
  const buf = Buffer.from(out.audio, 'base64');
  const samples = unwrapFor(buf, out.mime, { encoding: 'linear16', sampleRate: 16000 });
  assert.equal(samples.length, 640, 'the samples must survive unwrapping intact');
});

await t('a mulaw request is labelled as mu-law, and the phone leg accepts it', async () => {
  const out = await synth({ text: 'hello there', lang: 'en-IN', codec: 'mulaw', sampleRate: 8000 });
  assert.equal(lastBody.output_audio_codec, 'mulaw');
  const buf = Buffer.from(out.audio, 'base64');
  assert.doesNotThrow(() => unwrapFor(buf, out.mime, { encoding: 'mulaw', sampleRate: 8000 }));
});

await t('with NO codec requested it is still audio/mpeg — the browser path is unchanged', async () => {
  const out = await synth({ text: 'browser turn, no codec', lang: 'en-IN' });
  assert.equal(lastBody.output_audio_codec, undefined, 'no codec should be sent');
  assert.equal(out.mime, 'audio/mpeg', 'MP3 is the stream default and is right here');
});

await t('a Content-Type from the vendor outranks what we guessed', async () => {
  contentType = 'audio/wav; codecs=1';
  const out = await synth({ text: 'vendor declares its own type', lang: 'en-IN', codec: 'linear16', sampleRate: 16000 });
  assert.equal(out.mime, 'audio/wav', 'the response header is more authoritative than our request');
  contentType = '';
});

console.log('\n═══ CACHE KEYED BY FORMAT ═══\n');

await t('a browser turn and a call turn do not share a cache entry', async () => {
  const text = 'the very same sentence';
  const browser = await synth({ text, lang: 'te-IN' });                                  // MP3
  const call = await synth({ text, lang: 'te-IN', codec: 'linear16', sampleRate: 16000 });
  assert.notEqual(call.cached, true,
    'the call turn was served the browser MP3 from cache — the same failure, intermittently');
  assert.equal(browser.mime, 'audio/mpeg');
  assert.match(call.mime, /l16|linear16|pcm|octet-stream/i);
});

await t('but an identical request still hits the cache', async () => {
  const args = { text: 'repeat me exactly', lang: 'en-IN', codec: 'linear16', sampleRate: 16000 };
  await synth(args);
  const second = await synth({ ...args });
  assert.equal(second.cached, true, 'caching must still work, or every turn pays the vendor twice');
});

await t('a different sample rate is a different entry', async () => {
  const text = 'same words, different line';
  await synth({ text, lang: 'en-IN', codec: 'linear16', sampleRate: 16000 });
  const phone = await synth({ text, lang: 'en-IN', codec: 'linear16', sampleRate: 8000 });
  assert.notEqual(phone.cached, true,
    '16kHz audio served to an 8kHz line plays at the wrong speed and pitch');
});

console.log('\n═══ FORWARDED AS IT ARRIVES ═══\n');

// This endpoint emits audio AS IT IS GENERATED and we called arrayBuffer() on
// it, which waits for the last byte — the repo's own note beside the URL
// records `stream ttfb 1.02s / total 1.44s`, and we paid 1.44s. Posting to a
// streaming endpoint and buffering the response is the whole cost with none of
// the benefit.

await t('raw PCM reaches the caller in chunks, before the response is finished', async () => {
  const got = [];
  const out = await synth({
    text: 'stream this', lang: 'te-IN', codec: 'linear16', sampleRate: 16000,
    onChunk: (c) => got.push(Buffer.from(c)),
  });
  assert.ok(got.length >= 2, `expected several chunks, got ${got.length}`);
  assert.equal(out.streamed, true, 'the caller must be told the audio already went out');
});

await t('no chunk splits a 16-bit sample', async () => {
  // A network chunk can end halfway through a sample. Forwarding an odd byte
  // count shifts every sample after it by one byte, which is not a glitch —
  // it is white noise for the rest of the phrase.
  const got = [];
  await synth({
    text: 'odd boundaries', lang: 'te-IN', codec: 'linear16', sampleRate: 16000,
    onChunk: (c) => got.push(Buffer.from(c)),
  });
  for (const [i, c] of got.entries()) {
    assert.equal(c.length % 2, 0, `chunk ${i} is ${c.length} bytes — half a sample`);
  }
});

await t('the chunks reassemble to exactly the audio that is returned', async () => {
  // Nothing dropped by the carry, nothing duplicated. The returned buffer is
  // what gets cached, so a mismatch means the cache and the wire disagree.
  const got = [];
  const out = await synth({
    text: 'reassemble me', lang: 'te-IN', codec: 'linear16', sampleRate: 16000,
    onChunk: (c) => got.push(Buffer.from(c)),
  });
  assert.deepEqual(Buffer.concat(got), Buffer.from(out.audio, 'base64'));
});

await t('MP3 is NOT streamed — a partial frame is noise, and a WAV prefix is a header', async () => {
  const got = [];
  const out = await synth({ text: 'browser turn', lang: 'en-IN', onChunk: (c) => got.push(c) });
  assert.equal(out.mime, 'audio/mpeg');
  assert.equal(got.length, 0, 'MP3 must buffer');
  assert.notEqual(out.streamed, true);
});

await t('a cache hit reports streamed:false, because nothing was emitted', async () => {
  // `streamed` is a fact about THIS call, not about the clip. A stored `true`
  // surviving into a cache hit means the caller plays nothing at all.
  const args = { text: 'cached and streamed', lang: 'te-IN', codec: 'linear16', sampleRate: 16000 };
  await synth({ ...args, onChunk: () => {} });
  const got = [];
  const second = await synth({ ...args, onChunk: (c) => got.push(c) });
  assert.equal(second.cached, true, 'the second call should hit the cache');
  assert.equal(second.streamed, false, 'and must NOT claim the audio already went out');
  assert.equal(got.length, 0);
});

await t('a caller whose transport has gone away does not truncate the clip', async () => {
  // onChunk throwing must not abort the read: the buffer is what gets cached,
  // and a half-read clip would be cached as if it were the whole phrase.
  const out = await synth({
    text: 'transport died', lang: 'te-IN', codec: 'linear16', sampleRate: 16000,
    onChunk: () => { throw new Error('socket closed'); },
  });
  assert.equal(Buffer.from(out.audio, 'base64').length, 255 + 385);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
