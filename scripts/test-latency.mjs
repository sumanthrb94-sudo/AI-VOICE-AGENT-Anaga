// scripts/test-latency.mjs
//
// The measurement itself, tested — because a harness nobody checked produces
// numbers nobody should quote.
//
// The failure modes here are all the same shape: a way of turning a bad run
// into a good-looking number. A turn that produced silence counted as fast; a
// p95 computed over four samples; the endpointer's 900ms quietly excluded from
// what the prospect experienced. Each one is asserted against.
//
// Run: node --experimental-detect-module scripts/test-latency.mjs

import assert from 'node:assert';
import { createTurnTimer, percentile, summarise, formatSummary } from '../shared/latency.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

/** A clock we drive by hand, so the tests measure logic and not the machine. */
function fakeClock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

console.log('\n═══ LATENCY MEASUREMENT ═══\n');
console.log('─── percentiles ───\n');

t('nearest-rank percentile picks an ACTUAL observation', () => {
  // Not interpolated on purpose: "p95 = a turn that really happened" is easier
  // to defend than "p95 = a number between two turns".
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 100);
  assert.equal(percentile(xs, 100), 100);
  assert.ok(xs.includes(percentile(xs, 73)), 'every percentile must be a real sample');
});

t('an unsorted input is sorted first', () => {
  assert.equal(percentile([90, 10, 50, 30, 70], 50), 50);
});

t('an empty set yields null, never zero', () => {
  // Zero would render as "0ms" and read as instantaneous.
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([NaN, undefined, null], 95), null);
});

console.log('\n─── what counts as a turn ───\n');

t('TIME TO FIRST AUDIO runs from the FINAL transcript to the first byte', () => {
  const c = fakeClock();
  const timer = createTurnTimer({ now: c.now });
  timer.voice();            // they are still talking
  c.advance(900);           // the endpointer's silence window
  timer.turnStart();        // recogniser settles — the wait becomes ours
  c.advance(700); timer.leg('llm', 700);
  c.advance(1020); timer.leg('tts', 1020);
  timer.firstAudio(); timer.phrase();
  const s = timer.turnEnd();

  assert.equal(s.ttfa, 1720, 'ttfa excludes the endpointer window');
  assert.equal(s.ttfaFromSpeech, 2620, 'and from-speech includes it');
  assert.equal(s.llmMs, 700);
  assert.equal(s.ttsMs, 1020);
});

t('THE ENDPOINTER WINDOW IS NEVER SILENTLY EXCLUDED', () => {
  // Reporting only ttfa without from-speech is how a 2.6s experience gets
  // described as 1.7s. Both must be present on every sample.
  const c = fakeClock();
  const timer = createTurnTimer({ now: c.now });
  timer.voice();
  c.advance(900);
  timer.turnStart();
  c.advance(500);
  timer.firstAudio();
  const s = timer.turnEnd();
  assert.ok(s.ttfaFromSpeech > s.ttfa, 'from-speech must always be the larger number');
  assert.equal(s.ttfaFromSpeech - s.ttfa, 900);
});

t('A TURN THAT MADE NO AUDIO PRODUCES NO SAMPLE', () => {
  // The important one. Counting a silent turn as zero, or dropping it without
  // saying so, is exactly how a broken run flatters an average.
  const c = fakeClock();
  const timer = createTurnTimer({ now: c.now });
  timer.turnStart();
  c.advance(4000);
  const s = timer.turnEnd();           // TTS failed — firstAudio never called
  assert.equal(s, null);
  assert.equal(timer.samples.length, 0);
});

t('only the FIRST phrase sets time-to-first-audio', () => {
  const c = fakeClock();
  const timer = createTurnTimer({ now: c.now });
  timer.turnStart();
  c.advance(800); timer.firstAudio(); timer.phrase();
  c.advance(600); timer.firstAudio(); timer.phrase();   // later phrases must not move it
  const s = timer.turnEnd();
  assert.equal(s.ttfa, 800);
  assert.equal(s.phrases, 2);
});

t('timings outside a turn are ignored rather than corrupting the next one', () => {
  const c = fakeClock();
  const timer = createTurnTimer({ now: c.now });
  timer.firstAudio();                 // stray, before any turn
  timer.leg('llm', 999);
  assert.equal(timer.turnEnd(), null);
  timer.turnStart();
  c.advance(300); timer.firstAudio();
  const s = timer.turnEnd();
  assert.equal(s.ttfa, 300);
  assert.equal(s.llmMs, null, 'the stray leg must not leak into this turn');
});

console.log('\n─── the summary refuses to overclaim ───\n');

t('SILENT TURNS ARE REPORTED, not quietly dropped', () => {
  const samples = [{ ttfa: 100, ttfaFromSpeech: 200 }, { ttfa: 200, ttfaFromSpeech: 300 }];
  const sum = summarise(samples, 5);
  assert.equal(sum.turns.attempted, 5);
  assert.equal(sum.turns.measured, 2);
  assert.equal(sum.turns.silent, 3);
  assert.match(formatSummary(sum), /3 produced NO audio/);
});

t('fewer than 20 turns is labelled INDICATIVE, not measured', () => {
  // A p95 over four turns is the second-slowest turn wearing a statistic's name.
  const few = Array.from({ length: 4 }, (_, i) => ({ ttfa: 100 + i, ttfaFromSpeech: 200 + i }));
  assert.equal(summarise(few).confidence, 'indicative');
  assert.match(formatSummary(summarise(few)), /not percentiles yet/);

  const many = Array.from({ length: 20 }, (_, i) => ({ ttfa: 100 + i, ttfaFromSpeech: 200 + i }));
  assert.equal(summarise(many).confidence, 'measured');
});

t('n is carried on every statistic', () => {
  const sum = summarise(Array.from({ length: 7 }, (_, i) => ({ ttfa: i * 10, llmMs: i })));
  assert.equal(sum.ttfa.n, 7);
  assert.equal(sum.legs.llm.n, 7);
  assert.equal(sum.legs.tts, null, 'a leg with no data is null, not a zeroed row');
});

t('the recognise row explains itself instead of printing an empty one', () => {
  const out = formatSummary(summarise([{ ttfa: 500, llmMs: 200, ttsMs: 300 }]));
  assert.doesNotMatch(out, /recognise\s+no samples/,
    'an empty row invites somebody to read it as zero');
  assert.match(out, /transcribes while they speak/);
});

t('orchestration overhead is reported — the part this repo owns', () => {
  // Vendor time is bought. Overhead is the only part an engineering decision
  // in this repository can move, so it is the number worth surfacing.
  const out = formatSummary(summarise([{ ttfa: 1800, llmMs: 700, ttsMs: 1000 }]));
  assert.match(out, /orchestration overhead \(p50\): 100ms/);
});

console.log('\n─── the bridge actually emits these ───\n');

t('the streaming bridge has a clock in it at all', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../caller-agent/src/agent/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /createTurnTimer/, 'the bridge had NO timing whatsoever before this');
  assert.match(src, /timer\.turnStart\(\)/);
  assert.match(src, /timer\.firstAudio\(\)/);
  assert.match(src, /type: 'turn_timing'/);
});

t('a real bridge turn emits a turn_timing event', async () => {
  const { createBridge } = await import('../caller-agent/src/agent/bridge.js');
  const events = [];
  let sttEvents;
  const bridge = createBridge({
    lang: 'en-IN',
    onAudio() {},
    onEvent: (e) => events.push(e),
    isOptOut: () => false,
    think: async () => ({ say: 'Two BHK or three BHK?', end: false, disposition: 'qualifying' }),
    speak: async () => Buffer.alloc(320),
    openSTT: (o) => { sttEvents = o.onEvent; return { send() {}, close() {} }; },
  });
  sttEvents({ type: 'transcript', final: false, text: 'three' });
  sttEvents({ type: 'transcript', final: true, text: 'three bedroom' });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  const timing = events.find((e) => e.type === 'turn_timing');
  assert.ok(timing, 'a completed turn must report its timing');
  assert.ok(Number.isFinite(timing.ttfa) && timing.ttfa >= 0);
  assert.ok(timing.phrases >= 1);
  bridge.end();
});

t('a turn whose voice FAILED emits no timing at all', async () => {
  const { createBridge } = await import('../caller-agent/src/agent/bridge.js');
  const events = [];
  let sttEvents;
  const bridge = createBridge({
    lang: 'en-IN',
    onAudio() {},
    onEvent: (e) => events.push(e),
    isOptOut: () => false,
    think: async () => ({ say: 'Two BHK or three BHK?', end: false, disposition: 'qualifying' }),
    speak: async () => { throw new Error('vendor down'); },
    openSTT: (o) => { sttEvents = o.onEvent; return { send() {}, close() {} }; },
  });
  sttEvents({ type: 'transcript', final: true, text: 'three bedroom' });
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(events.filter((e) => e.type === 'turn_timing').length, 0,
    'a silent turn must not contribute a fast-looking sample');
  assert.equal(events.filter((e) => e.type === 'not_delivered').length, 1,
    'but it must still be reported as undelivered');
  bridge.end();
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
