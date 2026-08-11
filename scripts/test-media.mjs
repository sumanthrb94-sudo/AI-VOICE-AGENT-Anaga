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
const { createSTT, createTTS, frameAudio, splitForSpeech, withSynthCache } =
  await import(`${ROOT}/caller-agent/src/providers/speech.js`);
const { runCall, FIXED_LINES, DEFAULT_DISCLOSURE } = await import(`${ROOT}/caller-agent/src/session.js`);

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

// ---------------------------------------------------------------------------
// LATENCY
// ---------------------------------------------------------------------------
//
// Everything below is about the gap between a prospect finishing a sentence and
// hearing a reply. The two mechanisms tested here buy that time by overlapping
// work — never by shortening the endpointing window, because that buys latency
// by talking over people.

section('speculative transcription — spending the endpointing wait');

/** Like harness(), but the STT records every call so we can count what we paid. */
function speculating({ silenceMs = 900, speculateMs = 400, maxSpeculations = 2, transcribe } = {}) {
  let clock = 0;
  const calls = [];
  const tr = createMediaTransport({
    stt: {
      async transcribe(chunks) {
        const text = chunks.map((c) => c.toString('utf8')).join(' ').trim();
        calls.push(text);
        return transcribe ? transcribe(text, calls.length) : text;
      },
    },
    tts: createTTS({ provider: 'mock' }),
    audioOut: () => {},
    now: () => clock,
    silenceMs, speculateMs, maxSpeculations,
  });
  return {
    tr, calls,
    speak(text, ms = 300) { clock += ms; tr.pushAudio(Buffer.from(text, 'utf8'), { hasVoice: true }); },
    silence(ms) { clock += ms; tr.pushAudio(Buffer.alloc(0), { hasVoice: false }); tr.tick(); },
  };
}

await t('a pause inside the window starts transcribing before the window closes', async () => {
  const h = speculating();
  const listening = h.tr.listen();
  h.speak('I am looking for a 3BHK');

  h.silence(500);              // past speculateMs, still well inside the 900ms window
  assert.equal(h.calls.length, 1, 'the wait should already be paying for itself');
  assert.equal(h.tr._speculating(), true);

  const early = await Promise.race([listening, Promise.resolve('PENDING')]);
  assert.equal(early, 'PENDING', 'guessing early must not end the turn early');

  h.silence(500);              // now past 900ms
  const heard = await listening;
  assert.equal(heard.text, 'I am looking for a 3BHK');
  assert.equal(h.calls.length, 1, 'the guess should be reused, not transcribed a second time');
});

await t('a caller who carries on invalidates the guess', async () => {
  const h = speculating();
  const listening = h.tr.listen();
  h.speak('I am looking for');
  h.silence(500);
  assert.equal(h.calls.length, 1, 'we guessed at the half sentence');

  h.speak('a 3BHK in Gachibowli');
  h.silence(1000);
  const heard = await listening;
  assert.equal(heard.text, 'I am looking for a 3BHK in Gachibowli',
    'a transcript of half the sentence must never become the turn');
  assert.equal(h.calls.length, 2);
});

await t('a rambling caller is not billed for a guess at every pause', async () => {
  const h = speculating({ maxSpeculations: 1 });
  const listening = h.tr.listen();
  h.speak('so');       h.silence(500);
  h.speak('basically'); h.silence(500);
  h.speak('what I want is a 3BHK'); h.silence(500);
  assert.equal(h.calls.length, 1, 'speculation is capped, not one call per pause');
  h.silence(500);
  await listening;
});

await t('a failed guess costs a retry, not the turn', async () => {
  const h = speculating({
    transcribe: (text, n) => (n === 1 ? Promise.reject(new Error('stt blip')) : text),
  });
  const listening = h.tr.listen();
  h.speak('a 3BHK in Gachibowli');
  h.silence(500);
  h.silence(500);
  const heard = await listening;
  assert.equal(heard.text, 'a 3BHK in Gachibowli', 'a failed guess must not read as silence');
  assert.equal(h.calls.length, 2);
});

await t('speculation can be switched off entirely', async () => {
  const h = speculating({ speculateMs: 0 });
  const listening = h.tr.listen();
  h.speak('hello');
  h.silence(500);
  assert.equal(h.calls.length, 0, 'nothing should be sent before the window closes');
  h.silence(500);
  await listening;
  assert.equal(h.calls.length, 1);
});

section('chunked synthesis — first audio before the last word is rendered');

await t('playback starts before the whole line has been rendered', async () => {
  const events = [];
  const tr = createMediaTransport({
    stt: createSTT({ provider: 'mock' }),
    tts: {
      async synth(text) {
        events.push({ kind: 'synth_start', text });
        await new Promise((r) => setTimeout(r, 20));
        events.push({ kind: 'synth_end', text });
        return { frames: [Buffer.from(text, 'utf8')] };
      },
    },
    audioOut: (f) => events.push({ kind: 'audio', text: f.toString('utf8') }),
    sleep: async () => {},
  });

  await tr.say('Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?');

  const synths = events.filter((e) => e.kind === 'synth_start');
  assert.ok(synths.length > 1, 'the line should have been split into phrases');
  const firstAudio = events.findIndex((e) => e.kind === 'audio');
  const lastRender = events.map((e, i) => [e, i]).filter(([e]) => e.kind === 'synth_end').pop()[1];
  assert.ok(firstAudio < lastRender,
    'the first phrase must reach the ear before the last one has finished rendering');
});

await t('a line marked atomic is rendered whole and never split', async () => {
  const rendered = [];
  const tr = createMediaTransport({
    stt: createSTT({ provider: 'mock' }),
    tts: { async synth(text) { rendered.push(text); return { frames: [Buffer.from(text)] }; } },
    audioOut: () => {},
    sleep: async () => {},
  });
  const line = 'Hi, I am Anaga, an AI voice assistant from Vaak. Is now a good time to talk?';
  await tr.say(line, { atomic: true });
  assert.deepEqual(rendered, [line],
    'a disclosure that can be split is a disclosure that can be half-spoken');
});

await t('a phrase failing after the first was spoken truncates but does not drop the call', async () => {
  const out = [];
  let n = 0;
  const tr = createMediaTransport({
    stt: createSTT({ provider: 'mock' }),
    tts: {
      async synth(text) {
        if (++n === 2) throw new Error('tts down');
        return { frames: [Buffer.from(text)] };
      },
    },
    audioOut: (f) => out.push(f.toString('utf8')),
    sleep: async () => {},
  });
  const ok = await tr.say('Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli.');
  assert.equal(ok, true, 'words already spoken mean the line succeeded, however partially');
  assert.equal(out.length, 1, 'the first phrase was still delivered');
});

await t('a barge-in before a word is spoken holds the phrases that were never rendered', async () => {
  let clock = 0;
  const out = [];
  const line = 'Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?';
  const tr = createMediaTransport({
    stt: { async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' ').trim(); } },
    tts: { async synth(text) { return { frames: [Buffer.from(text)] }; } },
    audioOut: (f) => out.push(f.toString('utf8')),
    now: () => clock,
    bargeInMinMs: 100, frameMs: 50, falseInterruptionTimeoutMs: 500,
    sleep: async (ms) => { clock += ms; },
  });

  const speaking = tr.say(line);
  for (let i = 0; i < 4; i++) { clock += 40; tr.pushAudio(Buffer.from('noise'), { hasVoice: true }); }
  await speaking;

  const paused = tr._pausedSpeech();
  assert.ok(paused, 'the line must be held, not dropped');
  assert.equal(paused.pendingParts, 2,
    'the phrases that had not been rendered yet must be remembered, not lost');

  clock += 600;
  tr.tick();
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setImmediate(r));

  assert.equal(tr._pausedSpeech(), null, 'the paused speech should have been resumed');
  assert.equal(out.join(' '), line, 'the WHOLE line must be spoken, not just the rendered phrase');
});

section('phrase splitting');

await t('a multi-sentence line splits at sentences', () => {
  assert.deepEqual(
    splitForSpeech('Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli.'),
    ['Hello, this is Anaga from Vaak.', 'I have a three BHK in Gachibowli.']
  );
});

await t('Hindi ends sentences with a danda, and the splitter knows it', () => {
  // A splitter that only knows "." leaves an entire Hindi turn as one chunk,
  // which is exactly the language where the latency hurts most.
  const parts = splitForSpeech('नमस्ते, मैं वाक् से अनागा बोल रही हूँ। क्या अभी बात करने का सही समय है।');
  assert.equal(parts.length, 2, `expected two phrases, got ${parts.length}`);
});

await t('a short line is left alone', () => {
  assert.deepEqual(splitForSpeech('Yes, of course.'), ['Yes, of course.']);
});

await t('a runt fragment is merged rather than costing its own round trip', () => {
  const parts = splitForSpeech('Sure. I have a three BHK in Gachibowli that fits what you described.');
  assert.equal(parts.length, 1, `"Sure." is not worth a network round trip, got: ${JSON.stringify(parts)}`);
});

await t('THE FIRST PHRASE IS CUT SHORT — it is the only one anybody waits for', () => {
  // Synthesis time tracks length almost linearly (production: 21 chars 908 ms,
  // 53 chars 2.4 s, 114 chars 4.2 s). Every phrase after the first renders
  // while earlier audio plays, so its length is free; the first one IS the
  // wait. Cutting it at the first clause roughly halves time-to-first-word.
  const parts = splitForSpeech('Are you looking to live in it, or to invest?');
  assert.equal(parts.length, 2, `expected a head split, got ${JSON.stringify(parts)}`);
  assert.ok(parts[0].length < 36, `head is ${parts[0].length} chars: ${parts[0]}`);
  assert.equal(parts.join(' '), 'Are you looking to live in it, or to invest?',
    'the head split must not lose or reorder a word');
});

await t('…in Telugu too, where the character floor is the wrong ruler', () => {
  const parts = splitForSpeech('మీరు ఉండటానికా, లేక పెట్టుబడి కోసమా చూస్తున్నారు?');
  assert.equal(parts.length, 2);
  assert.equal(parts.join(' '), 'మీరు ఉండటానికా, లేక పెట్టుబడి కోసమా చూస్తున్నారు?');
});

await t('a first phrase already short enough is left alone', () => {
  // Splitting it further would buy nothing and spend a round trip.
  assert.deepEqual(splitForSpeech('What budget are you working with?'),
    ['What budget are you working with?']);
});

await t('a first phrase with no clause boundary is NOT cut mid-word', () => {
  // Bulbul pronounces a fragment cut mid-word as two separate words. A long
  // unpunctuated sentence stays whole rather than being butchered for latency.
  const one = 'I have a three BHK in Gachibowli that fits exactly what you described to me';
  assert.deepEqual(splitForSpeech(one), [one]);
});

await t('the head is never a two-syllable runt', () => {
  // "Sure," alone is a network round trip for nothing, and Bulbul gives a very
  // short fragment a clipped, falling delivery that reads as a glitch.
  const parts = splitForSpeech('Sure, I have a three BHK in Gachibowli, with parking, ready in March.');
  assert.ok(parts[0].length >= 12, `head too short: "${parts[0]}"`);
});

await t('THE STREAMING SCAN AND THE SPLITTER AGREE — on every line', async () => {
  // The turn hands Bulbul the opening phrase while the model is still writing
  // the rest, which means guessing where the splitter WILL cut before the text
  // exists. The browser splits the full line itself and renders phrases 1..n,
  // so a disagreement repeats or drops a phrase. The server checks and falls
  // back, but a scan that is usually wrong silently costs the whole saving.
  const { firstClauseOf } = await import(`${ROOT}/api/_lib/llm.js`);
  const lines = [
    'Are you looking to live in it, or to invest?',
    'What budget are you working with?',
    'మీరు ఉండటానికా, లేక పెట్టుబడి కోసమా చూస్తున్నారు?',
    'నమస్కారం, నేను అనగా, వాక్ నుంచి ఒక AI వాయిస్ అసిస్టెంట్.',
    'नमस्ते, मैं वाक् से अनगा बोल रही हूँ। क्या अभी बात करने का सही समय है?',
    'Theek hai.',
    'Sure, I have a three BHK in Gachibowli, ready in March.',
    'Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli.',
    'I have a three BHK in Gachibowli that fits exactly what you described to me',
    'Got it.',
  ];
  for (const say of lines) {
    assert.equal(firstClauseOf(say, true), splitForSpeech(say)[0],
      `disagreed on: ${say}`);
  }
});

await t('…and it decides EARLY, before the line is finished', async () => {
  // The entire point. If it only ever answered once the text was complete it
  // would be a correct function that saves nothing.
  const { firstClauseOf } = await import(`${ROOT}/api/_lib/llm.js`);
  const full = 'Are you looking to live in it, or to invest?';
  const head = 'Are you looking to live in it,';
  // The model has written the comma and four more words — nothing past that
  // can change where the first phrase ends.
  assert.equal(firstClauseOf(`${head} or to inv`, false), head);
  // …but it must NOT answer while the opening could still turn out short.
  assert.equal(firstClauseOf('Are you looking', false), null);
  assert.equal(firstClauseOf(full, true), head);
});

await t('a long sentence with no full stop still splits, at clauses', () => {
  const long = 'I have a three BHK in Gachibowli with two covered parking spaces, '
    + 'a clubhouse, and possession in March, which is about the budget you mentioned earlier';
  const parts = splitForSpeech(long, { maxChars: 60 });
  assert.ok(parts.length > 1, 'a long clause-only sentence must still be broken up');
  assert.equal(parts.join(' '), long, 'splitting must not lose or reorder a word');
});

await t('splitting never drops text', () => {
  const line = 'Hello. I have a flat. Would you like details? Great!';
  assert.equal(splitForSpeech(line).join(' '), line);
});

section('the fixed lines are rendered once, not once per call');

function countingTts() {
  let n = 0;
  return { tts: { id: 'test', async synth(text) { n++; return { frames: [Buffer.from(text)] }; } }, renders: () => n };
}

await t('the same line is rendered once and served from cache after that', async () => {
  const { tts, renders } = countingTts();
  const cached = withSynthCache(tts);
  await cached.synth('I completely understand.', 'en-IN');
  await cached.synth('I completely understand.', 'en-IN');
  assert.equal(renders(), 1);
  assert.equal(cached._cacheStats().hits, 1);
});

await t('the same words in another language are another rendering', async () => {
  const { tts, renders } = countingTts();
  const cached = withSynthCache(tts);
  await cached.synth('hello', 'en-IN');
  await cached.synth('hello', 'te-IN');
  assert.equal(renders(), 2);
});

await t('the voice is part of the key — a woman must not answer for a male preset', async () => {
  const { tts, renders } = countingTts();
  const cached = withSynthCache(tts);
  const before = process.env.TTS_SPEAKER;
  try {
    process.env.TTS_SPEAKER = 'anushka';
    await cached.synth('hello', 'en-IN');
    process.env.TTS_SPEAKER = 'abhilash';
    await cached.synth('hello', 'en-IN');
    assert.equal(renders(), 2);
  } finally {
    if (before === undefined) delete process.env.TTS_SPEAKER; else process.env.TTS_SPEAKER = before;
  }
});

await t('prewarm makes the line that follows it free', async () => {
  const { tts, renders } = countingTts();
  const cached = withSynthCache(tts);
  const warmed = await cached.prewarm(['line one', 'line two'], 'en-IN');
  assert.equal(warmed, 2);
  assert.equal(renders(), 2);
  await cached.synth('line one', 'en-IN');
  assert.equal(renders(), 2, 'the prewarmed line must not be rendered again');
});

await t('a prewarm that fails costs latency and nothing else', async () => {
  const cached = withSynthCache({ id: 'x', async synth() { throw new Error('vendor down'); } });
  assert.equal(await cached.prewarm(['a', 'b'], 'en-IN'), 0);
});

await t('the cache is bounded — it is for fixed lines, not a transcript archive', async () => {
  const { tts } = countingTts();
  const cached = withSynthCache(tts, { max: 2 });
  await cached.synth('a', 'en-IN');
  await cached.synth('b', 'en-IN');
  await cached.synth('c', 'en-IN');
  assert.equal(cached._cacheStats().size, 2);
});

section('the session spends the ring time and protects the lines it must not truncate');

/** A telephony double that records how each line was said. */
function fakeTelephony({ heard = [] } = {}) {
  const said = [];
  const prewarmed = [];
  let dialled = false;
  let prewarmedBeforeDial = false;
  const queue = [...heard];
  return {
    said, prewarmed,
    prewarmedBeforeDial: () => prewarmedBeforeDial,
    adapter: {
      prewarm(lines) {
        prewarmedBeforeDial = !dialled;
        prewarmed.push(...lines);
        return Promise.resolve(lines.length);
      },
      async dial() { dialled = true; return { answered: true }; },
      async say(text, opts) { said.push({ text, atomic: Boolean(opts && opts.atomic) }); return true; },
      async listen() {
        return queue.length ? { text: queue.shift(), hangup: false, silent: false }
          : { text: null, hangup: true, silent: false };
      },
      async hangup() { return { ended: true }; },
    },
  };
}

const quietBrain = {
  async nextTurn() { return { say: 'Tell me a bit about your budget.', end: false }; },
  async reportOutcome() { return { ok: true }; },
};

await t('the lines we already know are rendered while the phone is still ringing', async () => {
  const f = fakeTelephony();
  await runCall({ job: { callId: 'c1', lead: { phone: '+919999999999' } }, telephony: f.adapter, brain: quietBrain, persona: {} });
  assert.ok(f.prewarmed.includes(DEFAULT_DISCLOSURE), 'the disclosure is turn one — render it during the ring');
  assert.ok(f.prewarmed.includes(FIXED_LINES.optOut), 'the opt-out acknowledgement must never be the slow line');
  assert.ok(f.prewarmedBeforeDial(), 'prewarming after the dial wastes the only free seconds on the call');
});

await t('the disclosure and the opt-out acknowledgement are said whole', async () => {
  const f = fakeTelephony({ heard: ['please remove me from your list'] });
  const res = await runCall({
    job: { callId: 'c2', lead: { phone: '+919999999999' } },
    telephony: f.adapter, brain: quietBrain, persona: {},
  });
  assert.equal(res.disposition, 'opt-out');
  const [disclosure, optOut] = f.said;
  assert.equal(disclosure.atomic, true, 'a half-spoken AI disclosure is a compliance failure');
  assert.equal(optOut.text, FIXED_LINES.optOut);
  assert.equal(optOut.atomic, true, 'a half-spoken promise to stop calling is worse than a slow one');
});

await t('a normal agent line is NOT atomic — that is where the latency win is', async () => {
  const f = fakeTelephony({ heard: ['I am looking for a 3BHK'] });
  await runCall({
    job: { callId: 'c3', lead: { phone: '+919999999999' } },
    telephony: f.adapter, brain: quietBrain, persona: {},
  });
  const brainLine = f.said.find((s) => s.text === 'Tell me a bit about your budget.');
  assert.ok(brainLine, 'the brain line should have been spoken');
  assert.equal(brainLine.atomic, false);
});

await t('a session against a transport with no prewarm still runs', async () => {
  // The mock telephony provider has no prewarm(); an optional optimisation must
  // never be a hard dependency of the call loop.
  const f = fakeTelephony();
  delete f.adapter.prewarm;
  const res = await runCall({ job: { callId: 'c4', lead: { phone: '+919999999999' } }, telephony: f.adapter, brain: quietBrain, persona: {} });
  assert.equal(res.reported, true);
});

// ===========================================================================
section('§ what she SAID, versus what she was given');
// ===========================================================================
//
// These diverge the moment somebody talks over her, and the difference is not
// cosmetic. The transcript is what the brain reads back as "what I already
// asked", what the scorer scores, and what a compliance reviewer reads as the
// record of the call. say() reports success even when the line was cut off
// part-way — the call is still live, so it is not a failure — and the session
// used to record the GENERATED text on the strength of that boolean.

/** A transport whose clock and sleep are injected, so a barge-in lands at an
 *  exact frame instead of at whatever the event loop felt like. */
function spoken({ perFrame = 'part' } = {}) {
  let clock = 0;
  const out = [];
  const tr = createMediaTransport({
    stt: { async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' ').trim(); } },
    tts: {
      async synth(text) {
        return perFrame === 'char'
          ? { frames: String(text).split('').map((ch) => Buffer.from(ch)) }
          : { frames: [Buffer.from(text)] };
      },
    },
    audioOut: (f) => out.push(f.toString('utf8')),
    now: () => clock,
    bargeInMinMs: 100, frameMs: 50, falseInterruptionTimeoutMs: 5000,
    sleep: async (ms) => { clock += ms; },
  });
  return {
    tr, out,
    // Synchronous: lands before a single frame has left, which is the common
    // case — somebody talking as she starts.
    interrupt(n = 4) { for (let i = 0; i < n; i++) { clock += 40; tr.pushAudio(Buffer.from('noise'), { hasVoice: true }); } },
    // Lands MID-PHRASE. Each frame is emitted after one `await sleep(...)`, so
    // one microtask yield lets roughly one frame out — that is what makes the
    // cut land inside a phrase rather than before it.
    async interruptAfter(frames, n = 4) {
      for (let k = 0; k < frames; k++) await Promise.resolve();
      for (let i = 0; i < n; i++) {
        clock += 40;
        tr.pushAudio(Buffer.from('noise'), { hasVoice: true });
        await Promise.resolve();
      }
    },
  };
}

await t('an uninterrupted line is recorded verbatim', async () => {
  const h = spoken();
  const line = 'Are you looking to live in it, or to invest?';
  await h.tr.say(line);
  assert.equal(h.tr.spokenText(), line);
});

await t('SHE DOES NOT CLAIM THE HALF SHE NEVER SAID', async () => {
  const h = spoken();
  const line = 'Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?';
  const speaking = h.tr.say(line);
  h.interrupt();
  await speaking;

  const said = h.tr.spokenText();
  assert.ok(!said.includes('Would you like the details'),
    `a phrase that never left the speaker must not be in the record, got "${said}"`);
  assert.ok(said.length < line.length, 'the record must be shorter than the script');
  // And it matches what actually went out on the wire.
  assert.equal(said.replace(/\s*…\[cut off\]/, ''), h.out.join(' '),
    'the record and the audio must agree');
});

await t('a line cut MID-PHRASE is MARKED, not silently trimmed', async () => {
  // We know which frames went out; we do not know which WORD the cut landed
  // on. Trimming to a guessed word boundary would be the same lie in a smaller
  // font, so the phrase is kept with a marker instead.
  const h = spoken({ perFrame: 'char' });
  const speaking = h.tr.say('Just so you know, I am an AI voice agent from Vaak.');
  await h.interruptAfter(6);
  await speaking;
  assert.match(h.tr.spokenText(), /\[cut off\]/,
    'a half-spoken phrase must say that it was half-spoken');
});

await t('THE SESSION RECORDS THE SPOKEN TEXT, not the generated text', async () => {
  // The bug, end to end: history.push({ text }) on the strength of say()
  // returning true. She then reads that back as "already asked" and moves on
  // without the answer.
  const h = spoken();
  const line = 'Hello, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?';
  const telephony = {
    async dial() { return { answered: true }; },
    async say(text) { const p = h.tr.say(text); h.interrupt(); return p; },
    spokenText: () => h.tr.spokenText(),
    async listen() { return { text: null, hangup: true, silent: false }; },
    async hangup() { return { ended: true }; },
  };
  const brain = {
    async nextTurn() { return { say: line, end: true }; },
    async reportOutcome() { return { ok: true }; },
  };
  const res = await runCall({
    job: { callId: 'spoken-1', lead: { phone: '+919000000000' } },
    telephony, brain, persona: {},
  });
  const agentLines = (res.history || []).filter((x) => x.role === 'agent').map((x) => x.text);
  assert.ok(agentLines.length, 'she must have said something');
  assert.ok(!agentLines.join(' ').includes('Would you like the details'),
    `the transcript claims a phrase she never spoke: ${JSON.stringify(agentLines)}`);
});

await t('THE PHRASE SPLIT IS NOT SCRIPT-BIASED', () => {
  // The call leg carried the same Latin bias the browser demo did: a 24-CHAR
  // floor merged whole Hindi sentences back into one blob, and a word floor
  // would swallow Telugu instead. Both failures land on the two languages this
  // product actually sells in — and on the phone leg they cost first-audio on
  // every line of every call.
  const cases = {
    'en-IN': 'Namaste, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?',
    'hi-IN': 'नमस्ते, मैं अनगा हूँ। मेरे पास गाचीबौली में एक थ्री बीएचके है। क्या आप जानना चाहेंगे?',
    'te-IN': 'నమస్కారం, నేను అనగా. మీరు అడిగిన ఇంటి గురించి మాట్లాడటానికి కాల్ చేశాను. ఇప్పుడు మాట్లాడవచ్చా?',
  };
  for (const [lang, line] of Object.entries(cases)) {
    const parts = splitForSpeech(line);
    assert.equal(parts.length, 3, `${lang} must split into its three sentences, got ${parts.length}`);
    assert.equal(parts.join(' '), line, `${lang}: splitting must not drop or reorder a word`);
  }
});

await t('a runt is short by BOTH measures, and only then', () => {
  assert.deepEqual(splitForSpeech('Theek hai.'), ['Theek hai.']);
  assert.deepEqual(splitForSpeech('Yes.'), ['Yes.']);
  // Two Telugu words that carry a whole question are NOT a runt.
  const te = splitForSpeech('ఇప్పుడు మాట్లాడవచ్చా? మీ బడ్జెట్ ఎంత వరకు ఉంది?');
  assert.equal(te.length, 2, 'an agglutinative two-word question deserves its own phrase');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
