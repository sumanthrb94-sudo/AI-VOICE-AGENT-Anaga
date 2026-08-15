// scripts/test-bridge-failures.mjs
//
// What the live bridge does when something breaks mid-call.
//
// scripts/test-agent-bridge.mjs covers the happy path and barge-in. This
// covers the four ways a call could previously go wrong SILENTLY — each one
// leaving either the prospect or the compliance record misled:
//
//   1. an opt-out spoken while she is thinking was dropped entirely
//   2. the transcript claimed she said lines the prospect never heard
//   3. a dead recogniser left her deaf for the rest of the call, still billing
//   4. an undelivered AI disclosure was swallowed by an empty catch
//
// Run: node --experimental-detect-module scripts/test-bridge-failures.mjs

import assert from 'node:assert';
import { createBridge } from '../caller-agent/src/agent/bridge.js';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };

/** A bridge wired to controllable fakes. */
function harness({ think, speak, isOptOut } = {}) {
  const events = [];
  const audio = [];
  let sttEvents = null;
  let sttClosed = false;
  let closeCb = null;

  const bridge = createBridge({
    lang: 'en-IN',
    direction: 'outbound',
    onAudio: (b) => audio.push(b),
    onEvent: (e) => events.push(e),
    // Mirrors shared/optout.js closely enough for these tests. The first version
    // of this regex did not match "do not call" (the `o` broke `do ?n'?t`), which
    // failed a test that was asserting correct behaviour.
    isOptOut: isOptOut || ((x) => /not interested|remove me|unsubscribe|do ?n'?t call|do not call|stop calling/i.test(x)),
    think: think || (async () => ({ say: 'Are you looking to live in it, or to invest?', end: false, disposition: 'qualifying' })),
    speak: speak || (async () => Buffer.alloc(320)),
    openSTT: (o) => {
      sttEvents = o.onEvent;
      closeCb = o.onClose;
      return { send() {}, close() { sttClosed = true; } };
    },
  });

  return {
    bridge, events, audio,
    hear: (text) => sttEvents({ type: 'transcript', final: true, text }),
    speechStart: () => sttEvents({ type: 'speech_start' }),
    killStt: () => closeCb(),
    get sttClosed() { return sttClosed; },
    types: () => events.map((e) => e.type),
    of: (type) => events.filter((e) => e.type === type),
    history: () => bridge._history(),
  };
}

console.log('\n═══ BRIDGE FAILURE MODES ═══\n');
console.log('─── 1. an opt-out during a think ───\n');

await t('AN OPT-OUT SPOKEN WHILE SHE IS THINKING IS STILL HONOURED', async () => {
  // The defect: answer() opened with `if (ended || thinking) return;` and only
  // checked isOptOut BELOW it. A "don't call me" arriving during an in-flight
  // think() was never suppressed, never answered, and never pushed into
  // history — it left no trace anywhere at all.
  //
  // That window is precisely when it happens: the 1-3s she is thinking is when
  // somebody interrupts.
  let release;
  const h = harness({ think: () => new Promise((r) => { release = r; }) });

  h.hear('I want a three bedroom flat');   // starts the think, never resolves yet
  await settle();
  assert.equal(h.bridge._state().thinking, true, 'setup: she must be mid-think');

  h.hear('actually, do not call me again');
  await settle();

  assert.ok(h.of('disposition').some((e) => e.value === 'opt-out'),
    'the opt-out must be recorded even though a turn was in flight');
  assert.ok(h.bridge.ended, 'and the call must end');

  const said = h.history().map((x) => x.text).join(' | ');
  assert.match(said, /do not call me again/, 'the opt-out utterance must appear in the record');
  assert.match(said, /do-not-call list/i, 'and she must confirm it out loud');

  release?.({ say: 'ignored', end: false, disposition: 'qualifying' });
  await settle();
});

await t('the superseded turn cannot speak over the opt-out confirmation', async () => {
  let release;
  const h = harness({ think: () => new Promise((r) => { release = r; }) });
  h.hear('tell me about the project');
  await settle();
  h.hear('remove me from your list');
  await settle();

  const before = h.audio.length;
  release?.({ say: 'Here are the amenities.', end: false, disposition: 'qualifying' });
  await settle();

  assert.equal(h.audio.length, before, 'the abandoned turn must render no audio');
  assert.doesNotMatch(h.history().map((x) => x.text).join(' '), /amenities/,
    'and must not reach the transcript');
});

await t('ordinary speech during a think is dropped, but VISIBLY', async () => {
  // Still dropped — one turn at a time is the design — but it used to be
  // silent, and "she ignored me" is a real complaint with this as one cause.
  let release;
  const h = harness({ think: () => new Promise((r) => { release = r; }) });
  h.hear('what is the price');
  await settle();
  h.hear('and the possession date');
  await settle();

  assert.equal(h.of('dropped_while_thinking').length, 1);
  assert.equal(h.of('dropped_while_thinking')[0].text, 'and the possession date');
  release?.({ say: 'ok', end: false, disposition: 'qualifying' });
  await settle();
});

console.log('\n─── 2. the transcript must not lie ───\n');

await t('A LINE THAT WAS NEVER SPOKEN IS MARKED AS SUCH', async () => {
  // history.push({role:'agent'}) and the `said` event both fire BEFORE play().
  // When synthesis failed the loop simply broke, and the record kept the whole
  // sentence — asserting she said something the prospect never heard.
  const h = harness({
    speak: async () => { throw new Error('voice returned audio/mpeg, which is not PCM'); },
  });
  h.hear('go on then');
  await settle();

  const last = h.history()[h.history().length - 1];
  assert.equal(last.role, 'agent');
  assert.match(last.text, /NOT SPOKEN — the caller heard nothing/,
    'the compliance record must say the caller heard nothing');
  assert.match(last.text, /not PCM/, 'and why');

  const nd = h.of('not_delivered');
  assert.equal(nd.length, 1);
  assert.equal(nd[0].delivered, 0);
});

await t('a PARTIALLY spoken line records how much actually landed', async () => {
  let n = 0;
  const h = harness({
    think: async () => ({ say: 'First sentence here. Second sentence here.', end: false, disposition: 'qualifying' }),
    speak: async () => { if (++n > 1) throw new Error('vendor 503'); return Buffer.alloc(320); },
  });
  h.hear('ok');
  await settle();

  const last = h.history()[h.history().length - 1];
  assert.match(last.text, /only 1 of 2 phrases reached the caller/);
  assert.equal(h.of('not_delivered')[0].delivered, 1);
});

await t('a fully spoken line is NOT marked — no false alarms', async () => {
  const h = harness();
  h.hear('ok');
  await settle();
  const last = h.history()[h.history().length - 1];
  assert.doesNotMatch(last.text, /…\[/, `clean line got annotated: ${last.text}`);
  assert.equal(h.of('not_delivered').length, 0);
});

await t('a BARGE-IN is still recorded as a cut-off, not as a voice failure', async () => {
  // cutOff() already appended "…[cut off]". The new marker must not relabel an
  // interruption — the prospect talking over her is not a broken vendor.
  //
  // Barge-in fires from the FIRST delivered chunk rather than after a guessed
  // number of ticks: the first attempt waited two ticks, by which time the
  // whole four-phrase line had already been spoken, and the test failed
  // against correct code.
  let sttEvents;
  const events = [];
  let interrupted = false;
  const bridge = createBridge({
    lang: 'en-IN', direction: 'outbound',
    onEvent: (e) => events.push(e),
    isOptOut: () => false,
    think: async () => ({ say: 'One. Two. Three. Four.', end: false, disposition: 'qualifying' }),
    speak: async () => { await tick(); return Buffer.alloc(320); },
    onAudio: () => {
      if (interrupted) return;
      interrupted = true;
      sttEvents({ type: 'speech_start' });   // she is talked over mid-line
    },
    openSTT: (o) => { sttEvents = o.onEvent; return { send() {}, close() {} }; },
  });

  sttEvents({ type: 'transcript', final: true, text: 'ok' });
  await settle(20);

  const agent = bridge._history().filter((x) => x.role === 'agent').pop();
  assert.match(agent.text, /…\[cut off\]/, `a barge-in stays a cut-off, got: ${agent.text}`);
  assert.doesNotMatch(agent.text, /NOT SPOKEN/, 'and must not be blamed on the voice');
  assert.equal(events.filter((e) => e.type === 'not_delivered').length, 0,
    'an interruption is not a delivery failure');
});

console.log('\n─── 3. a dead recogniser ───\n');

await t('A CLOSED STT SOCKET ENDS THE CALL rather than going deaf', async () => {
  // Before: it emitted a UI error and nothing else. `ended` stayed false, the
  // transport kept streaming, deepgram-live.js kept buffering every chunk into
  // an unbounded array, and usage kept being metered for audio no vendor saw.
  // The prospect got a live call in which she never responded again.
  const h = harness();
  h.killStt();
  await settle();

  assert.ok(h.bridge.ended, 'the call must end rather than continue deaf');
  assert.equal(h.of('stt_lost').length, 1, 'and say why');
  assert.ok(h.types().includes('ended'), 'the transport must be told');
});

await t('pushAudio after the recogniser died meters nothing', async () => {
  const h = harness();
  h.killStt();
  await settle();
  const before = h.bridge._usage();
  h.bridge.pushAudio(Buffer.alloc(3200));
  const after = h.bridge._usage();
  assert.deepEqual(after, before, 'a dead call must not keep billing for audio');
});

console.log('\n─── 4. the disclosure ───\n');

await t('AN UNDELIVERED DISCLOSURE IS A COMPLIANCE EVENT, not a shrug', async () => {
  const h = harness({ speak: async () => { throw new Error('vendor down'); } });
  const said = await h.bridge.greet('Hi, I am Anaga, an AI voice assistant from Modcon Builders.');

  assert.equal(said.delivered, 0, 'greet must report what actually landed');
  assert.equal(h.of('disclosure_missing').length, 1, 'and raise it as a disclosure failure');
  assert.match(h.history()[0].text, /NOT SPOKEN/,
    'the record must not claim the disclosure was made');
});

await t('greet(falsy) reports a missing disclosure instead of returning quietly', async () => {
  const h = harness();
  const said = await h.bridge.greet('');
  assert.equal(said.delivered, 0);
  assert.equal(h.of('disclosure_missing').length, 1);
  assert.equal(h.history().length, 0, 'and nothing is recorded as said');
});

await t('a delivered disclosure reports success and is not flagged', async () => {
  const h = harness();
  const said = await h.bridge.greet('Hi, I am Anaga, an AI voice assistant from Modcon Builders.');
  assert.ok(said.delivered > 0);
  assert.equal(said.delivered, said.of);
  assert.equal(h.of('disclosure_missing').length, 0);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
