// shared/latency.js
//
// Turn latency, defined precisely enough to be defensible, and aggregated.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// The repository had a "<500 ms time-to-first-audio, p50" claim on its
// marketing page, retracted in a code comment that is still there. It could
// not be defended, and the reason is that there was nothing to defend it WITH:
//
//   - the streaming bridge contained no clock at all — not one Date.now()
//   - api/anaga/turn.js timed three vendor calls and logged them per-turn, and
//     nothing ever consumed that log
//   - no p50, p95 or percentile of anything was computed anywhere
//   - the on-screen "N ms to first word" started its stopwatch AFTER the
//     round trip had already returned
//
// A number nobody can reproduce is not a measurement, and the honest response
// to "how fast is it?" was "we do not know". This makes it answerable.
//
// ── THE DEFINITION, AND WHY IT IS THIS ONE ────────────────────────────────
// Two different things get called "latency" and they differ by nearly a
// second, so this module reports both and never blurs them:
//
//   ttfa   TIME TO FIRST AUDIO — from the moment the recogniser says the turn
//          ended, to the moment the first byte of her reply reaches the
//          transport. This is the industry convention and the one to quote.
//
//   ttfa_from_speech
//          The same, but measured from when the prospect actually STOPPED
//          TALKING — so it includes the endpointer's silence window. This is
//          what the prospect experiences, and it is ~900ms larger by
//          construction, because that window is a deliberate choice (see
//          caller-agent/src/media/timings.js).
//
// Quoting the first without saying which one you mean is how a 1.5s system
// gets described as a 600ms one. Both are recorded on every turn.

/** @typedef {{ttfa:number, ttfaFromSpeech:number|null, sttMs:number|null, llmMs:number|null, ttsMs:number|null, phrases:number}} TurnSample */

/**
 * One call's worth of timings. Cheap enough to leave on in production: it
 * holds numbers, never audio, text, or anything identifying.
 */
export function createTurnTimer({ now = () => Date.now() } = {}) {
  /** @type {TurnSample[]} */
  const samples = [];

  let speechEndedAt = null;   // recogniser reported the utterance final
  let speechStoppedAt = null; // last moment audio was flowing before that
  let firstAudioAt = null;
  let legs = {};
  let phrases = 0;
  let open = false;

  return {
    /** The prospect is talking; keep the last moment we heard them. */
    voice() { if (!open) speechStoppedAt = now(); },

    /** The recogniser has settled on a final transcript: the turn is ours. */
    turnStart() {
      speechEndedAt = now();
      firstAudioAt = null;
      legs = {};
      phrases = 0;
      open = true;
    },

    /** A vendor leg finished. `name` is 'stt' | 'llm' | 'tts'. */
    leg(name, ms) { if (open && Number.isFinite(ms)) legs[name] = ms; },

    /** The first byte of her reply reached the transport. */
    firstAudio() {
      if (!open || firstAudioAt !== null) return;
      firstAudioAt = now();
    },

    /** Another phrase went out. Only the first one sets ttfa. */
    phrase() { if (open) phrases++; },

    /**
     * The turn is over. Records a sample only if audio actually reached the
     * transport — a turn that produced silence has no time-to-first-audio, and
     * counting it as zero (or dropping it silently) is how a broken run
     * flatters an average.
     * @returns {TurnSample|null}
     */
    turnEnd() {
      if (!open) return null;
      open = false;
      if (speechEndedAt === null || firstAudioAt === null) return null;
      const s = {
        ttfa: firstAudioAt - speechEndedAt,
        ttfaFromSpeech: speechStoppedAt === null ? null : firstAudioAt - speechStoppedAt,
        sttMs: legs.stt ?? null,
        llmMs: legs.llm ?? null,
        ttsMs: legs.tts ?? null,
        phrases,
      };
      samples.push(s);
      speechStoppedAt = null;
      return s;
    },

    /** Turns that produced NO audio. Reported, never silently discarded. */
    get samples() { return samples.slice(); },
  };
}

/**
 * Nearest-rank percentile. Not interpolated: with the sample counts a voice
 * agent realistically produces (tens, not millions), interpolation invents
 * precision the data does not have, and "p95 = an actual observed turn" is
 * easier to defend than "p95 = a number between two turns".
 *
 * @param {number[]} xs
 * @param {number} p  0..100
 */
export function percentile(xs, p) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length - 1, Math.max(0, rank - 1))];
}

/**
 * Summarise a set of turns.
 *
 * `n` is reported first and prominently, because a p95 over four turns is not
 * a p95 — it is the second-slowest turn wearing a statistic's name. Anything
 * under ~20 samples is labelled as indicative rather than measured.
 *
 * @param {TurnSample[]} samples
 * @param {number} [attempted]  turns started, including any that made no audio
 */
export function summarise(samples, attempted = samples.length) {
  const of = (k) => samples.map((s) => s[k]).filter((x) => Number.isFinite(x));
  const stat = (k) => {
    const xs = of(k);
    if (!xs.length) return null;
    return {
      n: xs.length,
      min: xs[0] === undefined ? null : Math.min(...xs),
      p50: percentile(xs, 50),
      p95: percentile(xs, 95),
      max: Math.max(...xs),
    };
  };

  const silent = attempted - samples.length;
  return {
    turns: { attempted, measured: samples.length, silent },
    // Below this the percentiles are not worth the name. Stated in the output
    // rather than left for the reader to work out.
    confidence: samples.length >= 20 ? 'measured' : 'indicative',
    ttfa: stat('ttfa'),
    ttfaFromSpeech: stat('ttfaFromSpeech'),
    legs: { stt: stat('sttMs'), llm: stat('llmMs'), tts: stat('ttsMs') },
  };
}

/** A fixed-width table for a terminal. */
export function formatSummary(sum, { title = 'TURN LATENCY' } = {}) {
  const ms = (x) => (x === null || x === undefined ? '—' : `${Math.round(x)}ms`);
  const row = (label, s) => {
    if (!s) return `  ${label.padEnd(22)} ${'no samples'}`;
    return `  ${label.padEnd(22)} ${ms(s.p50).padStart(8)} ${ms(s.p95).padStart(8)} ${ms(s.min).padStart(8)} ${ms(s.max).padStart(8)}  n=${s.n}`;
  };
  const lines = [
    '',
    `═══ ${title} ═══`,
    '',
    `  turns attempted ${sum.turns.attempted} · measured ${sum.turns.measured}`
      + (sum.turns.silent > 0 ? ` · ${sum.turns.silent} produced NO audio` : ''),
    `  confidence: ${sum.confidence}${sum.confidence === 'indicative' ? '  (fewer than 20 turns — these are not percentiles yet)' : ''}`,
    '',
    `  ${''.padEnd(22)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'min'.padStart(8)} ${'max'.padStart(8)}`,
    row('time to first audio', sum.ttfa),
    row('  …from speech end', sum.ttfaFromSpeech),
    '',
    row('think', sum.legs.llm),
    row('speak (first phrase)', sum.legs.tts),
    '',
  ];

  // ON THE STREAMING PATH THERE IS NO "RECOGNISE" LEG TO TIME, and printing an
  // empty row invites somebody to read it as zero. Deepgram transcribes
  // continuously while the prospect is still talking, so by the time the turn
  // starts the words already exist — that cost is inside the endpointer window,
  // not after it. The request/response path is the one where STT is a discrete
  // call, and it reports sttMs separately in turn_ok.
  if (!sum.legs.stt) {
    lines.push('  recognition is not a leg here — Deepgram transcribes while they speak,');
    lines.push('  so it is already paid for by the time the turn begins.');
    lines.push('');
  } else {
    lines.splice(lines.length - 1, 0, row('recognise', sum.legs.stt));
  }

  // THE NUMBER THIS REPOSITORY IS ACTUALLY RESPONSIBLE FOR. Vendor time is
  // bought; everything else is ours, and it is the only part an engineering
  // decision here can move.
  if (sum.ttfa && sum.legs.llm && sum.legs.tts) {
    const overhead = sum.ttfa.p50 - (sum.legs.llm.p50 + sum.legs.tts.p50);
    lines.push(`  orchestration overhead (p50): ${Math.round(overhead)}ms on top of the vendors`);
    lines.push('');
  }

  return lines.join('\n');
}
