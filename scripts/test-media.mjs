// scripts/test-media.mjs
//
// QA for the audio leg — endpointing, barge-in, and framing. These are the two
// behaviours that decide whether a voice agent feels human or feels broken, and
// they are testable without a phone line: the transport is fed synthetic audio
// frames on an injected clock, so every timing case is deterministic.
//
// What this does NOT prove: that real 8kHz μ-law telephony audio transcribes
// correctly. That needs the WP-1 spike against a live line. See LAUNCH.md.
//
// Run: node --experimental-detect-module scripts/test-media.mjs

import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const { createMediaTransport } = await import(`${ROOT}/caller-agent/src/media/transport.js`);
const { createSTT, createTTS, frameAudio } = await import(`${ROOT}/caller-agent/src/providers/speech.js`);

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

/** A transport on a controllable clock, with mock STT/TTS. */
function harness({ silenceMs = 900, maxUtteranceMs } = {}) {
  let clock = 0;
  const out = [];
  const tr = createMediaTransport({
    stt: createSTT({ provider: 'mock' }),
    tts: createTTS({ provider: 'mock' }),
    audioOut: (f) => out.push(f),
    now: () => clock,
    silenceMs,
    maxUtteranceMs,
  });
  return {
    tr, out,
    advance(ms) { clock += ms; tr.tick(); },
    speak(text, ms = 300) { clock += ms; tr.pushAudio(Buffer.from(text, 'utf8'), { hasVoice: true }); },
    silence(ms) { clock += ms; tr.pushAudio(Buffer.alloc(0), { hasVoice: false }); tr.tick(); },
  };
}

console.log('\n═══ MEDIA LEG QA ═══');

section('endpointing');

await t('an utterance resolves only after the silence threshold', async () => {
  const h = harness({ silenceMs: 900 });
  const listening = h.tr.listen();
  h.speak('I am looking for a 3BHK');

  // 500ms of silence: an Indian-English speaker is still mid-sentence.
  h.silence(500);
  const early = await Promise.race([listening, Promise.resolve('PENDING')]);
  assert.equal(early, 'PENDING', 'must not endpoint at 500ms — that cuts people off mid-sentence');

  h.silence(500);   // now past 900ms total
  const heard = await listening;
  assert.equal(heard.text, 'I am looking for a 3BHK');
});

await t('a mid-sentence pause does not split one utterance into two', async () => {
  const h = harness({ silenceMs: 900 });
  const listening = h.tr.listen();
  h.speak('I am looking for');
  h.silence(600);              // the natural pause code-mixed speech has
  h.speak('a 3BHK in Gachibowli');
  h.silence(1000);
  const heard = await listening;
  assert.equal(heard.text, 'I am looking for a 3BHK in Gachibowli',
    'a 600ms pause must not end the turn');
});

await t('a rambling caller is cut off at the max-utterance ceiling', async () => {
  const h = harness({ silenceMs: 900, maxUtteranceMs: 2000 });
  const listening = h.tr.listen();
  // Continuous speech with no pause long enough to endpoint naturally.
  for (let i = 0; i < 12; i++) h.speak(`part${i}`, 250);
  const heard = await listening;
  assert.ok(heard.text.includes('part0'), 'should still return what was said');
});

await t('a too-short blip is not treated as an utterance', async () => {
  const h = harness({ silenceMs: 900 });
  const listening = h.tr.listen();
  h.speak('uh', 50);            // below MIN_SPEECH_MS
  h.silence(950);
  const early = await Promise.race([listening, Promise.resolve('PENDING')]);
  assert.equal(early, 'PENDING', 'a 50ms cough must not end the turn');
});

section('barge-in — the safety-critical one');

await t('SUSTAINED prospect speech cancels playback', async () => {
  // Barge-in now requires a sustained voice run rather than a single frame.
  // That is deliberate: one frame was enough for our OWN echo to cancel our own
  // utterance (see scripts/test-echo.mjs). A human interrupting speaks for
  // longer than the threshold; an echo burst does not.
  const h = harness();
  const speaking = h.tr.say('This is a long pitch. It has several sentences. And it keeps going.');
  for (let i = 0; i < 4; i++) h.speak('wait stop', 100);   // 300ms of continuous voice
  await speaking;
  assert.ok(h.out.length < 3, `playback should have been cut short, sent ${h.out.length} frames`);
});

await t('a SINGLE frame does not cancel playback (echo protection)', async () => {
  const h = harness();
  const speaking = h.tr.say('One. Two. Three.');
  h.tr.pushAudio(Buffer.from('blip', 'utf8'), { hasVoice: true });   // one frame only
  await speaking;
  assert.ok(h.out.length >= 3, `a lone frame must not barge in, sent ${h.out.length} frames`);
});

await t('an interrupted agent is no longer marked as speaking', async () => {
  const h = harness();
  const speaking = h.tr.say('One. Two. Three.');
  for (let i = 0; i < 4; i++) h.speak('stop talking', 100);
  await speaking;
  assert.equal(h.tr._isSpeaking(), false);
});

await t('an interruption that is an OPT-OUT still reaches the session', async () => {
  // The scenario that matters most: someone talking over the agent to say stop.
  // The interrupting audio must be buffered, transcribed, and returned — not
  // discarded as "just barge-in".
  const h = harness({ silenceMs: 500 });
  const speaking = h.tr.say('Let me tell you about the offer.');
  const listening = h.tr.listen();
  // Sustained, as a person cutting in actually is.
  for (let i = 0; i < 3; i++) h.speak('do not call me again', 120);
  await speaking;
  h.silence(600);
  const heard = await listening;
  // Fed as a sustained run, so the mock STT concatenates the repeats. What
  // matters is that the opt-out survived barge-in and reached the session —
  // not the exact string.
  assert.ok(heard.text && heard.text.includes('do not call me again'),
    `the interrupting utterance must reach the session, got: ${heard.text}`);

  const { detectOptOut } = await import(`${ROOT}/shared/optout.js`);
  assert.equal(detectOptOut(heard.text).optOut, true);
});

section('framing');

await t('audio is framed at ~20ms so barge-in stops mid-sentence', () => {
  // 8kHz, 16-bit, 1 second of audio = 16000 bytes -> 50 frames of 320 bytes.
  const frames = frameAudio(Buffer.alloc(16000), { sampleRate: 8000, bytesPerSample: 2, frameMs: 20 });
  assert.equal(frames.length, 50);
  assert.equal(frames[0].length, 320);
});

await t('framing handles a non-multiple length without dropping audio', () => {
  const frames = frameAudio(Buffer.alloc(16050), { sampleRate: 8000, bytesPerSample: 2, frameMs: 20 });
  const total = frames.reduce((n, f) => n + f.length, 0);
  assert.equal(total, 16050, 'no audio may be lost in framing');
});

section('failure paths');

await t('an STT failure is treated as silence, never as a hangup', async () => {
  let clock = 0;
  const tr = createMediaTransport({
    stt: { async transcribe() { throw new Error('stt down'); } },
    tts: createTTS({ provider: 'mock' }),
    audioOut: () => {},
    now: () => clock,
  });
  const listening = tr.listen();
  clock += 300; tr.pushAudio(Buffer.from('hello'), { hasVoice: true });
  clock += 1000; tr.tick();
  const heard = await listening;
  assert.equal(heard.hangup, false, 'a dead STT must not drop the call');
  assert.equal(heard.silent, true);
});

await t('a TTS failure returns false rather than throwing into the session', async () => {
  const tr = createMediaTransport({
    stt: createSTT({ provider: 'mock' }),
    tts: { async synth() { throw new Error('tts down'); } },
    audioOut: () => {},
  });
  assert.equal(await tr.say('hello'), false);
});

await t('close() resolves a pending listen as a hangup', async () => {
  const h = harness();
  const listening = h.tr.listen();
  h.tr.close('test');
  const heard = await listening;
  assert.equal(heard.hangup, true);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
