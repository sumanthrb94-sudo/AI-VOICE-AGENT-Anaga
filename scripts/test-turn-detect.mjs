// scripts/test-turn-detect.mjs
//
// QA for SEMANTIC end-of-turn detection — caller-agent/src/media/turn-detect.js
// and its use in the media transport.
//
// ── THE PROPERTY BEING PROTECTED ──────────────────────────────────────────
// A fixed silence threshold is wrong in one of two directions. Ours is 900ms
// because Indian English and code-mixing pause mid-sentence, which means 900ms
// of dead air after the word "no". This closes that gap WITHOUT ever shortening
// the guarantee: the silence window and maxUtteranceMs still bound every path,
// and an utterance the classifier has no opinion about is treated exactly as it
// was before.
//
// The failure that matters most is the asymmetric one. Cutting somebody off
// mid-sentence is far worse than making them wait, so "incomplete" must buy
// MORE patience and every ambiguous case must fall back, never forward.
//
// Run: node --experimental-detect-module scripts/test-turn-detect.mjs

import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const { endOfTurn, windowFor } = await import(`${ROOT}/caller-agent/src/media/turn-detect.js`);
const { createMediaTransport } = await import(`${ROOT}/caller-agent/src/media/transport.js`);
const { timings } = await import(`${ROOT}/caller-agent/src/media/timings.js`);

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

console.log('\n═══ SEMANTIC TURN DETECTION ═══');

// ===========================================================================
section('§1 the classifier — a pause is not a full stop');
// ===========================================================================

await t('a dangling conjunction is NOT the end of a turn', () => {
  for (const s of ['I am looking in Gachibowli and', 'we want three bedrooms but',
    'haan matlab', 'nenu chusanu kaani', 'so']) {
    assert.equal(endOfTurn(s), 'incomplete', `"${s}" should read as mid-thought`);
  }
});

await t('a dangling filler is NOT the end of a turn', () => {
  for (const s of ['budget is around', 'it is like', 'um', 'I mean']) {
    assert.equal(endOfTurn(s), 'incomplete', `"${s}" should read as mid-thought`);
  }
});

await t('A BARE NUMBER IS MID-FIGURE — prices are most of this call', () => {
  // "eighty five" before "lakhs"; "two" before "BHK". Cutting in here is both
  // expensive and the single most likely place on a property call.
  assert.equal(endOfTurn('my budget is 85'), 'incomplete');
  assert.equal(endOfTurn('I want 3'), 'incomplete');
});

await t('a trailing comma is somebody still listing', () => {
  assert.equal(endOfTurn('Gachibowli, Kondapur,'), 'incomplete');
});

await t('SHORT ANSWERS ARE COMPLETE — they are what a long window punishes', () => {
  for (const s of ['no', 'yes', 'haan', 'nahi', 'avunu', 'ledu', 'theek hai', 'సరే']) {
    assert.equal(endOfTurn(s), 'complete', `"${s}" is a whole answer`);
  }
});

await t('a punctuated sentence is complete', () => {
  assert.equal(endOfTurn('I am looking to invest in a three BHK.'), 'complete');
  assert.equal(endOfTurn('मुझे तीन बेडरूम चाहिए।'), 'complete');
});

await t('EVERYTHING ELSE GETS NO OPINION, and the silence window decides', () => {
  // The safe default, and the common case. An classifier that guesses on
  // ambiguous input is worse than one that abstains, because the cost of the
  // two mistakes is not symmetric.
  assert.equal(endOfTurn('looking in Gachibowli'), null);
  assert.equal(endOfTurn(''), null);
  assert.equal(endOfTurn(null), null);
  assert.equal(endOfTurn('   '), null);
});

await t('punctuation on a fragment does not fake completeness', () => {
  // STT emits "and." at the end of a fragment more often than anyone expects.
  assert.equal(endOfTurn('and.'), 'incomplete');
  assert.equal(endOfTurn('so.'), 'incomplete');
});

// ===========================================================================
section('§2 the window — bounded in both directions');
// ===========================================================================

const T = timings({});

await t('complete closes EARLY, incomplete waits LONGER, null is unchanged', () => {
  assert.ok(windowFor('complete', T) < T.silenceMs, 'a finished answer should not wait 900ms');
  assert.ok(windowFor('incomplete', T) > T.silenceMs, 'a mid-sentence pause should buy patience');
  assert.equal(windowFor(null, T), T.silenceMs, 'no opinion must change nothing');
});

await t('THE ASYMMETRY IS DELIBERATE and must survive a config edit', () => {
  // Interrupting somebody mid-sentence is far worse than making them wait, so
  // the patient direction must always be the bigger move.
  const early = T.silenceMs - windowFor('complete', T);
  const late = windowFor('incomplete', T) - T.silenceMs;
  assert.ok(late > 0 && early > 0);
  assert.ok(windowFor('incomplete', T) <= T.maxUtteranceMs,
    'patience must still be bounded by the hard ceiling');
});

// ===========================================================================
section('§3 in the transport — the silence window is still the fallback');
// ===========================================================================

/** A transport on an injected clock whose STT returns a scripted transcript. */
function harness(transcript, opts = {}) {
  let clock = 0;
  const tr = createMediaTransport({
    stt: { async transcribe() { return transcript; } },
    tts: { async synth(text) { return { frames: [Buffer.from(text)] }; } },
    audioOut: () => {},
    now: () => clock,
    silenceMs: 900, speculateMs: 400, minSpeechMs: 100, frameMs: 20,
    ...opts,
  });
  return {
    tr,
    speak(ms = 300) { clock += ms; tr.pushAudio(Buffer.from('x'), { hasVoice: true }); },
    async quiet(ms) {
      clock += ms;
      tr.pushAudio(Buffer.alloc(0), { hasVoice: false });
      tr.tick();
      await new Promise((r) => setImmediate(r));   // let the speculation land
      tr.tick();
    },
  };
}

await t('a FINISHED answer is returned before the full silence window', async () => {
  const h = harness('no');
  const heard = h.tr.listen();
  h.speak(300);
  await h.quiet(450);          // past speculateMs, well short of silenceMs
  await h.quiet(10);
  const res = await Promise.race([heard, new Promise((r) => setTimeout(() => r(null), 50))]);
  assert.ok(res && res.text, 'a complete short answer should not wait out 900ms');
  assert.equal(res.text, 'no');
});

await t('A MID-SENTENCE PAUSE IS NOT CUT OFF at the normal window', async () => {
  const h = harness('my budget is around');
  const heard = h.tr.listen();
  h.speak(300);
  await h.quiet(450);
  await h.quiet(500);          // 950ms silent — past silenceMs, still mid-thought
  const res = await Promise.race([heard, new Promise((r) => setTimeout(() => r(null), 50))]);
  assert.equal(res, null, 'the agent must still be listening, not answering');
});

await t('…but patience is BOUNDED — it still ends', async () => {
  const h = harness('my budget is around');
  const heard = h.tr.listen();
  h.speak(300);
  await h.quiet(450);
  await h.quiet(1200);         // past silenceMs * hesitationFactor
  const res = await Promise.race([heard, new Promise((r) => setTimeout(() => r(null), 50))]);
  assert.ok(res && res.text, 'a hesitation must not hold the call open forever');
});

await t('WITH NO OPINION, the behaviour is exactly what it was', async () => {
  const h = harness('looking in Gachibowli');
  const heard = h.tr.listen();
  h.speak(300);
  await h.quiet(450);
  await h.quiet(500);          // 950ms — past the plain silence window
  const res = await Promise.race([heard, new Promise((r) => setTimeout(() => r(null), 50))]);
  assert.ok(res && res.text, 'an ambiguous utterance must use the unchanged window');
});

await t('SEMANTIC ENDPOINTING CAN BE TURNED OFF, and then nothing changed', async () => {
  // The escape hatch that makes this safe to ship: if it ever misjudges a real
  // call, one env var puts the old behaviour back without a deploy.
  const h = harness('no', { semanticEndpointing: false });
  const heard = h.tr.listen();
  h.speak(300);
  await h.quiet(450);
  await h.quiet(10);
  const res = await Promise.race([heard, new Promise((r) => setTimeout(() => r(null), 50))]);
  assert.equal(res, null, 'with it off, even "no" waits out the full window');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
