// scripts/test-early-clause.mjs
//
// Does she start speaking before the model has finished writing?
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// The first live measurement, taken in asia-south1, put a caller's wait at
// 3665ms p50 — of which 2476ms was the model. api/_lib/llm.js has streamed the
// opening phrase for a long time, and api/anaga/turn.js — the HTTP path — has
// used it for a long time. The STREAMING path, the one whose entire reason for
// existing is to be fast, called think() and waited for the whole completion
// before making a sound.
//
// Overlapping the two slowest legs is the single largest saving available, and
// it is also the change most able to break a call in ways that are hard to
// hear: the same phrase spoken twice, a word dropped between instalments, a
// barge-in that no longer stops her, or a transcript that records a line she
// only half said. This suite is about those, not about the saving.
//
// Run: node --experimental-detect-module scripts/test-early-clause.mjs

import assert from 'node:assert';

const { createBridge } = await import('../caller-agent/src/agent/bridge.js');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 40; i++) await tick(); };

function fakeSTT() {
  const api = { fire: null };
  api.open = (opts) => {
    api.fire = opts.onEvent;
    return { send() {}, finish() {}, close() {}, isOpen: () => true };
  };
  return api;
}

/** A line whose splitter output starts with exactly this head. */
const LINE = 'Are you looking to live in it, or is this an investment?';
const HEAD = 'Are you looking to live in it,';

/**
 * A think() that hands over the opening phrase, then keeps "generating" until
 * released — the real shape, where the rest of the line arrives later.
 */
function build(over = {}) {
  const stt = fakeSTT();
  const audio = [], events = [], spoken = [];
  let release;
  const generated = new Promise((r) => { release = r; });

  const bridge = createBridge({
    lang: 'en-IN',
    onAudio: (b) => audio.push(b),
    onEvent: (e) => events.push(e),
    async think(history, opts) {
      if (opts?.onFirstClause) opts.onFirstClause(HEAD);
      await generated;
      return { say: LINE, end: false, disposition: 'qualifying' };
    },
    async speak(text) { spoken.push(text); return Buffer.from(text); },
    openSTT: stt.open,
    ...over,
  });

  return {
    bridge, stt, audio, events, spoken,
    release: () => { release(); },
    of: (type) => events.filter((e) => e.type === type),
    say: (text) => stt.fire({ type: 'transcript', final: true, text }),
    bargeIn: () => stt.fire({ type: 'speech_start' }),
  };
}

console.log('\n═══ THE OPENING PHRASE, BEFORE THE MODEL HAS FINISHED ═══\n');

await t('she speaks the opening phrase while think() is still running', async () => {
  const h = build();
  h.say('tell me about the project');
  await settle();

  // The completion has NOT been released, and she is already talking.
  assert.deepEqual(h.spoken, [HEAD], `spoke ${JSON.stringify(h.spoken)} before the model finished`);
  assert.equal(h.audio.length, 1, 'the opening phrase reached the transport');

  h.release();
  await settle();
});

await t('the whole line is spoken exactly once — no repeat, no gap', async () => {
  const h = build();
  h.say('go on');
  await settle();
  h.release();
  await settle();

  // Every phrase of the line, in order, each exactly once.
  assert.equal(h.spoken[0], HEAD);
  assert.equal(h.spoken.join(' '), LINE,
    `reassembled to "${h.spoken.join(' ')}" instead of the line she was given`);
  assert.equal(new Set(h.spoken).size, h.spoken.length, 'a phrase was spoken twice');
});

await t('`speaking` goes true once and false once, not once per instalment', async () => {
  // Two instalments naively means two true/false pairs, and the first `false`
  // arrives while she is still talking — the transport unmutes the microphone
  // mid-sentence and she hears herself.
  const h = build();
  h.say('go on');
  await settle();
  h.release();
  await settle();

  const flags = h.of('speaking').map((e) => e.value);
  assert.deepEqual(flags, [true, false], `got ${JSON.stringify(flags)}`);
});

await t('history records the FULL line, not the opening phrase', async () => {
  // history is the compliance record. Leaving the head in it would understate
  // what she said; leaving both in would claim she said the opening twice.
  const h = build();
  h.say('go on');
  await settle();
  h.release();
  await settle();

  const agent = h.bridge._state ? null : null;   // not exposed; assert via events
  const said = h.of('said');
  assert.equal(said[said.length - 1].text, LINE, 'the final `said` must carry the whole line');
  assert.ok(said.some((e) => e.early === true), 'the early phrase should be flagged as early');
  void agent;
});

console.log('\n═══ WHAT MUST NOT BREAK ═══\n');

await t('a barge-in DURING the opening phrase stops her', async () => {
  // This used to be impossible rather than merely broken: cutOff() only acts
  // when she is speaking, and during think() she was not. Now she is.
  const h = build();
  h.say('go on');
  await settle();
  const before = h.spoken.length;

  h.bargeIn();
  h.release();
  await settle();

  assert.equal(h.spoken.length, before,
    `kept speaking after a barge-in: ${JSON.stringify(h.spoken.slice(before))}`);
});

await t('a barge-in during the opening phrase is recorded as cut off, not as a voice failure', async () => {
  const h = build();
  h.say('go on');
  await settle();
  h.bargeIn();
  h.release();
  await settle();

  assert.ok(h.of('agent_cut_off').length === 1, 'the transcript must say she was interrupted');
  assert.equal(h.of('not_delivered').length, 0,
    'an interruption is not a voice failure and must not be logged as one');
});

await t('the model failing mid-line does not cut her off mid-word', async () => {
  const h = build({
    async think(history, opts) {
      if (opts?.onFirstClause) opts.onFirstClause(HEAD);
      await new Promise((r) => setTimeout(r, 0));
      throw new Error('upstream 503');
    },
  });
  h.say('go on');
  await settle();

  assert.deepEqual(h.spoken, [HEAD], 'the phrase already in flight should still be spoken');
  assert.ok(h.of('error').some((e) => /brain/.test(e.text)), 'the failure must be reported');
  assert.ok(h.of('not_delivered').length === 1,
    'the transcript must not claim she said a line the model never finished');
});

await t('a head the splitter disagrees with stops the turn rather than repeating her', async () => {
  // Designed not to happen — firstClauseOf() implements the splitter's own runt
  // and head rules — but if it ever does, re-speaking phrases[0] repeats her
  // and skipping ahead drops words. On a compliance record, neither is
  // acceptable, so it stops and says so.
  const h = build({
    async think(history, opts) {
      if (opts?.onFirstClause) opts.onFirstClause('Are you looking');   // not a splitter boundary
      await new Promise((r) => setTimeout(r, 0));
      return { say: LINE, end: false, disposition: 'qualifying' };
    },
  });
  h.say('go on');
  await settle();

  assert.equal(h.of('clause_mismatch').length, 1, 'the disagreement must be visible');
  assert.deepEqual(h.spoken, ['Are you looking'], 'nothing may be spoken twice');
  assert.equal(h.of('not_delivered').length, 1, 'and the record must say the line was not completed');
});

await t('a think() that never calls onFirstClause behaves exactly as before', async () => {
  // Providers without streaming, SARVAM_LLM_STREAM=0, and every existing test
  // double take this path. It must be untouched.
  const h = build({
    async think() { return { say: LINE, end: false, disposition: 'qualifying' }; },
  });
  h.say('go on');
  await settle();

  assert.equal(h.spoken.join(' '), LINE);
  assert.deepEqual(h.of('speaking').map((e) => e.value), [true, false]);
  assert.equal(h.of('said').length, 1, 'one `said`, carrying the whole line');
  assert.equal(h.of('not_delivered').length, 0);
});

await t('time-to-first-audio is measured from the opening phrase, so the saving is visible', async () => {
  const h = build();
  h.say('go on');
  await settle();
  h.release();
  await settle();

  const timing = h.of('turn_timing')[0];
  assert.ok(timing, 'a turn that made audio must yield a timing sample');
  const clause = h.of('first_clause')[0];
  assert.ok(clause, 'the first-clause moment must be observable');
  assert.ok(typeof clause.ms === 'number', 'and it must carry a duration');
});

console.log('\n═══ AUDIO FORWARDED DURING SYNTHESIS ═══\n');

/** A speak() that emits the phrase in chunks the way a streaming provider does. */
function streamingSpeak(spoken) {
  return async (text, lang, format, opts) => {
    const whole = Buffer.from(text);
    if (typeof opts?.onChunk === 'function') {
      const half = Math.floor(whole.length / 2);
      opts.onChunk(whole.subarray(0, half));
      opts.onChunk(whole.subarray(half));
      spoken.push(text);
      return { audio: whole, provider: 'sarvam', streamed: true };
    }
    spoken.push(text);
    return whole;
  };
}

await t('a phrase already sent in chunks is NOT played again from the buffer', async () => {
  // The failure this guards sounds like a stutter, not like a bug: every
  // phrase heard twice, the second time immediately after the first.
  const spoken = [];
  const h = build({ speak: streamingSpeak(spoken) });
  h.say('go on');
  await settle();
  h.release();
  await settle();

  const total = h.audio.reduce((n, b) => n + b.length, 0);
  const expected = Buffer.from(LINE.replace(/\s+/g, ' ')).length;
  assert.ok(Math.abs(total - expected) <= 4,
    `${total} bytes reached the transport for a ${expected}-byte line — `
    + 'roughly double means every phrase played twice');
});

await t('a barge-in mid-synthesis stops the chunks still arriving', async () => {
  // Supersession has to be checked INSIDE the chunk callback, not only around
  // the await. Otherwise the tail of an interrupted phrase keeps arriving and
  // she talks over the prospect who just cut her off.
  const spoken = [];
  const h = build({
    speak: async (text, lang, format, opts) => {
      const whole = Buffer.from(text);
      if (typeof opts?.onChunk === 'function') {
        opts.onChunk(whole.subarray(0, 4));
        h.bargeIn();                       // interrupted mid-phrase
        opts.onChunk(whole.subarray(4));   // must be dropped
        spoken.push(text);
        return { audio: whole, provider: 'sarvam', streamed: true };
      }
      spoken.push(text);
      return whole;
    },
  });
  h.say('go on');
  await settle();
  h.release();
  await settle();

  const total = h.audio.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 4, `${total} bytes went out after the barge-in, expected only the first 4`);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
