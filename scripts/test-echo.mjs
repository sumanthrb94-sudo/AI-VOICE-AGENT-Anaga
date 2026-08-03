// scripts/test-echo.mjs
//
// Regression tests for self-echo, built from a REAL failure observed on the
// deployed demo (voice-agent-anaga.vercel.app, on speakerphone).
//
// Anaga said:  "Are you looking for a home to live in, or more as an investment?"
// The transcript recorded, as the CALLER:
//   "why you why you looking why you looking why you looking for why you
//    looking for why you looking for a why you looking for a home why you
//    looking for a home to why you looking for a home to live in"
//
// Two separate faults in one string:
//   1. ACOUSTIC ECHO   — the mic heard the speaker; those are her words.
//   2. HYPOTHESIS STACKING — the growing prefixes are STT re-finalising
//      overlapping segments, blindly concatenated.
//
// Downstream damage was real: the call review scored the lead "Not interested,
// 45/100" off a transcript that contained nothing the human said.
//
// Run: node --experimental-detect-module scripts/test-echo.mjs

import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const { createEchoGuard, appendUtterance, overlapScore, relation } =
  await import(`${ROOT}/shared/echo-guard.js`);
const { createMediaTransport } = await import(`${ROOT}/caller-agent/src/media/transport.js`);

let pass = 0, fail = 0;
const failures = [];
const TIMEOUT_MS = 5000;
async function t(name, fn) {
  try {
    // A test that hangs is a failure, not a reason for CI to sit forever.
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS).unref()),
    ]);
    pass++; console.log('  ✓', name);
  }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

const ANAGA_LINE = 'Are you looking for a home to live in, or more as an investment?';
const OBSERVED_GARBAGE = 'why you why you looking why you looking why you looking for why you '
  + 'looking for why you looking for a why you looking for a home why you '
  + 'looking for a home to why you looking for a home to live in';

console.log('\n═══ SELF-ECHO REGRESSION ═══');

// ---------------------------------------------------------------------------
section('the exact string from the production screenshot');

await t('the observed garbage is recognised as her own speech', () => {
  const guard = createEchoGuard({ now: () => 1000 });
  guard.noteSpoken(ANAGA_LINE, 1000);
  const v = guard.check(OBSERVED_GARBAGE, 1500);
  assert.equal(v.isEcho, true, `should be echo, scored ${v.score.toFixed(2)}`);
});

await t('a clipped fragment of her line is still caught', () => {
  const guard = createEchoGuard({ now: () => 0 });
  guard.noteSpoken(ANAGA_LINE, 0);
  for (const frag of ['looking for a home to live in', 'or more as an investment', 'home to live in']) {
    assert.equal(guard.check(frag, 200).isEcho, true, `missed fragment: "${frag}"`);
  }
});

await t('a REAL answer to that question is NOT suppressed', () => {
  // The critical false-positive check. Over-eager rejection makes the agent
  // deaf, which is worse than the bug it fixes.
  const guard = createEchoGuard({ now: () => 0 });
  guard.noteSpoken(ANAGA_LINE, 0);
  for (const real of [
    'to live in',                      // short: judged on timing, not content
    'investment mainly',
    'we want a 3BHK around two crore',
    'actually please remove me from your list',
  ]) {
    // Not during playback — a human answering after she finished.
    assert.equal(guard.check(real, 300, { duringPlayback: false }).isEcho, false,
      `wrongly suppressed: "${real}"`);
  }
});

await t('an OPT-OUT is never mistaken for echo', () => {
  // The one false positive we can absolutely not afford.
  const guard = createEchoGuard({ now: () => 0 });
  guard.noteSpoken('I am adding your number to our do-not-call list now.', 0);
  guard.noteSpoken(ANAGA_LINE, 0);
  for (const optOut of [
    'do not call me again', 'please remove me', 'stop calling',
    'mujhe call mat karo', 'కాల్ చేయకండి', 'not interested',
  ]) {
    assert.equal(guard.check(optOut, 100).isEcho, false, `opt-out suppressed as echo: "${optOut}"`);
  }
});

await t('her line stops being echo-able once the memory window passes', () => {
  const guard = createEchoGuard({ windowMs: 5000, now: () => 0 });
  guard.noteSpoken(ANAGA_LINE, 0);
  assert.equal(guard.check('looking for a home to live in', 1000).isEcho, true);
  // Same words 30s later are far more likely to be a human genuinely saying it.
  assert.equal(guard.check('looking for a home to live in', 30000).isEcho, false);
});

// ---------------------------------------------------------------------------
section('hypothesis stacking — the growing-prefix garbage');

await t('relation() classifies the prefix chain', () => {
  assert.equal(relation('why you', 'why you looking'), 'extends');
  assert.equal(relation('why you looking', 'why you'), 'duplicate');
  assert.equal(relation('why you', 'why you'), 'duplicate');
  assert.equal(relation('hello there', 'goodbye now'), 'distinct');
});

await t('appending the real prefix chain yields the FINAL hypothesis, not the pile', () => {
  const chain = [
    'why you', 'why you looking', 'why you looking for', 'why you looking for a',
    'why you looking for a home', 'why you looking for a home to',
    'why you looking for a home to live in',
  ];
  const out = chain.reduce((acc, next) => appendUtterance(acc, next), '');
  assert.equal(out, 'why you looking for a home to live in');
  assert.ok(out.length < OBSERVED_GARBAGE.length / 3,
    'the stacked version should be far longer than the corrected one');
});

await t('genuinely distinct sentences are still concatenated', () => {
  let u = '';
  u = appendUtterance(u, 'I want a 3BHK');
  u = appendUtterance(u, 'around two crore');
  u = appendUtterance(u, 'in Gachibowli');
  assert.equal(u, 'I want a 3BHK around two crore in Gachibowli');
});

await t('naive concatenation reproduces the observed shape', () => {
  // The real string repeats some hypotheses (STT re-finalising the same
  // segment more than once), so the chain is not a clean strictly-growing one.
  const chain = ['why you', 'why you looking', 'why you looking', 'why you looking for'];
  const naive = chain.join(' ');
  assert.ok(OBSERVED_GARBAGE.startsWith(naive),
    `production string should start with the naive concatenation:\n  got: ${OBSERVED_GARBAGE.slice(0, 60)}`);
  // And the fix collapses that same chain to one clean hypothesis.
  assert.equal(chain.reduce((a, n) => appendUtterance(a, n), ''), 'why you looking for');
});

// ---------------------------------------------------------------------------
section('the transport rejects echo end to end');

/** Drive the real transport on a controllable clock. */
function harness({ bargeInMinMs = 240 } = {}) {
  let clock = 0;
  const out = [];
  const tr = createMediaTransport({
    stt: { async transcribe(chunks) { return chunks.map((c) => c.toString('utf8')).join(' ').trim(); } },
    tts: { async synth(text) { return { frames: [Buffer.from(text, 'utf8')] }; } },
    audioOut: (f) => out.push(f),
    now: () => clock,
    silenceMs: 400,
    frameMs: 5,
    bargeInMinMs,
    sleep: async (ms) => { clock += ms; },
  });
  return {
    tr, out,
    at: () => clock,
    // async: the echo-discard path re-arms the pending listener inside a
    // promise, so the next utterance must not be fed in the same microtask.
    async feed(text, ms = 300) {
      clock += ms; tr.pushAudio(Buffer.from(text, 'utf8'), { hasVoice: true });
      await new Promise((r) => setImmediate(r));
    },
    async quiet(ms) {
      clock += ms; tr.pushAudio(Buffer.alloc(0), { hasVoice: false }); tr.tick();
      await new Promise((r) => setImmediate(r));
    },
  };
}

await t('her own words coming back do not resolve as a caller turn', async () => {
  const h = harness();
  await h.tr.say(ANAGA_LINE);
  const listening = h.tr.listen();

  await h.feed('looking for a home to live in');    // the echo
  await h.quiet(600);

  const early = await Promise.race([listening, Promise.resolve('PENDING')]);
  assert.equal(early, 'PENDING', 'echo must not be handed to the session as speech');
  assert.ok(h.tr._echoDiscards() > 0, 'the discard should be recorded');
});

await t('a real reply after the echo still gets through', async () => {
  const h = harness();
  await h.tr.say(ANAGA_LINE);
  const listening = h.tr.listen();

  await h.feed('looking for a home to live in');    // echo — discarded
  await h.quiet(600);
  await h.feed('we want a 3BHK around two crore');  // the human
  await h.quiet(600);

  const heard = await listening;
  assert.equal(heard.text, 'we want a 3BHK around two crore');
});

await t('persistent echo does not hang the session forever', async () => {
  const h = harness();
  await h.tr.say(ANAGA_LINE);
  const listening = h.tr.listen();
  for (let i = 0; i < 8; i++) {
    await h.feed('looking for a home to live in');
    await h.quiet(600);
  }
  const heard = await listening;
  assert.equal(heard.silent, true, 'should report silence so the session can progress');
  assert.equal(heard.hangup, false);
});

await t('a single echo frame no longer cancels her own utterance', async () => {
  const h = harness({ bargeInMinMs: 240 });
  const speaking = h.tr.say('One. Two. Three. Four. Five.');
  h.tr.pushAudio(Buffer.from('blip', 'utf8'), { hasVoice: true });   // one frame only
  await speaking;
  assert.equal(h.out.length, 1, 'a lone frame must not trigger barge-in');
});

await t('a human interrupting for longer DOES still barge in', async () => {
  let clock = 0;
  const out = [];
  const tr = createMediaTransport({
    stt: { async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' '); } },
    tts: { async synth(text) { return { frames: text.split(' ').map((w) => Buffer.from(w)) }; } },
    audioOut: (f) => out.push(f),
    now: () => clock,
    bargeInMinMs: 100,
    frameMs: 50,
    sleep: async (ms) => { clock += ms; },
  });
  const speaking = tr.say('one two three four five six seven eight');
  // Sustained speech across several frames — a person, not an echo blip.
  for (let i = 0; i < 5; i++) { clock += 40; tr.pushAudio(Buffer.from('stop talking please'), { hasVoice: true }); }
  await speaking;
  assert.ok(out.length < 8, `playback should have been cut short, sent ${out.length}/8 frames`);
});

// ---------------------------------------------------------------------------
section('false-interruption resume (pattern from livekit/agents)');

await t('a false interruption resumes the rest of the sentence', async () => {
  // Barge-in used to CANCEL outright, so one burst of noise permanently ate the
  // remainder of Anaga's line. Now it pauses, and resumes when the interruption
  // proves false.
  let clock = 0;
  const out = [];
  const tr = createMediaTransport({
    stt: { async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' ').trim(); } },
    tts: { async synth(text) { return { frames: text.split(' ').map((w) => Buffer.from(w)) }; } },
    audioOut: (f) => out.push(f.toString('utf8')),
    now: () => clock,
    bargeInMinMs: 100,
    frameMs: 50,
    falseInterruptionTimeoutMs: 500,
    sleep: async (ms) => { clock += ms; },
  });

  const speaking = tr.say('one two three four five six seven eight');
  for (let i = 0; i < 4; i++) { clock += 40; tr.pushAudio(Buffer.from('noise'), { hasVoice: true }); }
  await speaking;

  const paused = tr._pausedSpeech();
  assert.ok(paused && paused.remaining > 0, 'the remainder should be held, not discarded');

  // No transcript arrives -> false interruption -> resume.
  clock += 600;
  tr.tick();
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setImmediate(r));

  assert.equal(tr._pausedSpeech(), null, 'the paused speech should have been resumed');
  assert.ok(out.includes('eight'), `the sentence should have finished, got: ${out.join(' ')}`);
});

await t('a REAL interruption discards the remainder (no talking over them)', async () => {
  let clock = 0;
  const out = [];
  const tr = createMediaTransport({
    stt: { async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' ').trim(); } },
    tts: { async synth(text) { return { frames: text.split(' ').map((w) => Buffer.from(w)) }; } },
    audioOut: (f) => out.push(f.toString('utf8')),
    now: () => clock,
    bargeInMinMs: 100, frameMs: 50, silenceMs: 300,
    sleep: async (ms) => { clock += ms; },
  });

  const speaking = tr.say('one two three four five six seven eight');
  const listening = tr.listen();
  for (let i = 0; i < 4; i++) { clock += 40; tr.pushAudio(Buffer.from('I am not interested in this'), { hasVoice: true }); }
  await speaking;
  clock += 400; tr.pushAudio(Buffer.alloc(0), { hasVoice: false }); tr.tick();

  const heard = await listening;
  assert.ok(heard.text, 'the real interruption must reach the session');
  assert.equal(tr._pausedSpeech(), null, 'the remainder must be dropped, not resumed over them');
  assert.ok(!out.includes('eight'), 'we must not finish the sentence over a person');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
