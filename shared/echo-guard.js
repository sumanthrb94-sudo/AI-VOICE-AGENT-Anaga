// shared/echo-guard.js
//
// Stops the agent hearing itself.
//
// On a real call, some of what we transmit comes back on the receive path:
// hybrid echo from the 2-wire local loop, acoustic echo when the callee is on
// speakerphone, or VoIP loopback. Providers run AEC, but it is imperfect — the
// reflection is attenuated, not absent. STT transcribes it happily, the brain
// answers it, and the agent starts a conversation with itself.
//
// Reproduced in scripts/simulate-echo.mjs: 49 turns, 24 billed LLM calls, a
// transcript of the agent quoting itself recursively. Observed for real in the
// browser demo (speakerphone), where Anaga's "…looking for a home to live in"
// came back as a prospect turn.
//
// Three independent defences, because any one of them can be defeated:
//
//   1. TIMING   — audio arriving while we speak, plus an echo-tail hangover
//                 after, is suspect. Cheap, catches the common case, but must
//                 not kill barge-in.
//   2. CONTENT  — does the transcript match what we recently said? Provider-
//                 agnostic and works even when the timing window leaks.
//   3. SHAPE    — STT re-finalising overlapping segments of echoed audio emits
//                 growing prefixes ("why you", "why you looking", …) which
//                 naive appending concatenates into garbage.
//
// This module owns 2 and 3. The transport owns 1 because only it knows when
// playback is running.

import { detectOptOut } from './optout.js';

const DEFAULT_WINDOW_MS = 15000;
const DEFAULT_THRESHOLD = 0.55;
// Below this many content words, bag-of-words overlap is meaningless: a human
// answering "to live in" scores 1.0 against a line of hers containing those
// words. Short utterances are judged on TIMING instead.
const DEFAULT_MIN_TOKENS = 4;
// Echo reproduces her phrasing verbatim; a human paraphrases. A long CONTIGUOUS
// run of her exact words is the strongest single signal we have.
//
// Measured in absolute words, not as a fraction of the candidate: the stacked
// garbage from production contains the verbatim run "you looking for a home to
// live in", but it is buried in so much repetition that a ratio dilutes to
// ~0.18 and the check misses the very string it was written for.
const DEFAULT_MIN_RUN_WORDS = 4;

/** Lowercase, strip punctuation, collapse whitespace. */
export function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  // Two-letter words carry almost no signal and inflate the overlap score, so
  // "a home to live in" does not match on "a/to/in" alone.
  return norm(text).split(' ').filter((w) => w.length > 2);
}

/**
 * Fraction of the candidate's meaningful words that appear in `reference`.
 * Asymmetric on purpose: a SHORT echo fragment of a LONG agent line should
 * score high, which a symmetric measure (Jaccard/Dice) would dilute.
 */
export function overlapScore(candidate, reference) {
  const c = tokens(candidate);
  if (!c.length) return 0;
  const ref = new Set(tokens(reference));
  if (!ref.size) return 0;
  return c.filter((w) => ref.has(w)).length / c.length;
}

/**
 * Length, in words, of the longest run of consecutive candidate words that
 * appears verbatim and in order inside the reference.
 */
export function longestRunWords(candidate, reference) {
  const c = norm(candidate).split(' ').filter(Boolean);
  const r = norm(reference);
  if (!c.length || !r) return 0;

  let best = 0;
  for (let i = 0; i < c.length; i++) {
    for (let j = c.length; j > i + best; j--) {
      const run = c.slice(i, j).join(' ');
      if (run.length > 2 && r.includes(run)) { best = j - i; break; }
    }
  }
  return best;
}

/**
 * Detects the growing-prefix pattern STT produces on echoed audio, where each
 * new "final" extends the previous one. Appending them yields
 * "why you why you looking why you looking for …".
 *
 * @returns {'extends'|'duplicate'|'distinct'}
 */
export function relation(prev, next) {
  const a = norm(prev);
  const b = norm(next);
  if (!a) return 'distinct';
  if (a === b) return 'duplicate';
  if (b.startsWith(a)) return 'extends';     // next is a longer hypothesis of the same audio
  if (a.startsWith(b)) return 'duplicate';   // next is a shorter re-report — already have it
  if (a.endsWith(b)) return 'duplicate';
  return 'distinct';
}

/**
 * Append a new STT final to an accumulating utterance WITHOUT re-stacking
 * overlapping hypotheses. Use instead of `prev + " " + next`.
 */
export function appendUtterance(prev, next) {
  const n = String(next || '').trim();
  if (!n) return prev;
  if (!prev) return n;

  switch (relation(prev, n)) {
    case 'duplicate': return prev;
    case 'extends': return n;                 // the longer hypothesis supersedes
    default: return `${prev} ${n}`;
  }
}

/**
 * Rolling memory of what the agent said, for content-based echo rejection.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs]   how far back a line can still echo
 * @param {number} [opts.threshold]  overlap fraction that counts as echo
 */
export function createEchoGuard({
  windowMs = Number(process.env?.ECHO_MEMORY_MS ?? DEFAULT_WINDOW_MS),
  threshold = Number(process.env?.ECHO_MATCH_THRESHOLD ?? DEFAULT_THRESHOLD),
  minTokens = Number(process.env?.ECHO_MIN_TOKENS ?? DEFAULT_MIN_TOKENS),
  minRunWords = Number(process.env?.ECHO_MIN_RUN_WORDS ?? DEFAULT_MIN_RUN_WORDS),
  now = () => Date.now(),
} = {}) {
  /** @type {Array<{text:string, at:number}>} */
  let spoken = [];

  function prune(t) {
    spoken = spoken.filter((s) => t - s.at <= windowMs);
  }

  return {
    /** Record a line the agent just said. */
    noteSpoken(text, at = now()) {
      const t = String(text || '').trim();
      if (!t) return;
      spoken.push({ text: t, at });
      prune(at);
    },

    /**
     * Is this transcript our own speech coming back?
     *
     * @param {string} text
     * @param {number} [at]
     * @param {object} [ctx]
     * @param {boolean} [ctx.duringPlayback] our audio could be arriving right now
     * @returns {{isEcho:boolean, score:number, run:number, matched:string|null, reason:string}}
     */
    check(text, at = now(), { duringPlayback = false } = {}) {
      prune(at);
      const candidate = String(text || '').trim();
      if (!candidate || !spoken.length) {
        return { isEcho: false, score: 0, run: 0, matched: null, reason: 'no_reference' };
      }

      // ---- HARD OVERRIDE: an opt-out is NEVER echo ------------------------
      // Anaga's own opt-out acknowledgement ("adding your number to our
      // do-not-call list") shares most of its words with "do not call me
      // again", so pure word overlap classified a genuine opt-out as her own
      // voice and swallowed it. Suppressing an opt-out is far worse than any
      // echo: we would keep talking to someone who asked us to stop, and dial
      // them again tomorrow. Content rejection never applies here.
      if (detectOptOut(candidate).optOut) {
        return { isEcho: false, score: 0, run: 0, matched: null, reason: 'opt_out_override' };
      }

      let best = { score: 0, run: 0, matched: null };
      for (const s of spoken) {
        const score = overlapScore(candidate, s.text);
        const run = longestRunWords(candidate, s.text);
        // Rank on the verbatim run first — it is the stronger signal.
        if (run > best.run || (run === best.run && score > best.score)) {
          best = { score, run, matched: s.text };
        }
      }

      // ---- VERBATIM RULE ---------------------------------------------------
      // A long contiguous run of her exact words is echo regardless of how much
      // else surrounds it. This is what catches the production string, whose
      // repetition would otherwise dilute any ratio-based measure. A human
      // answering a question rarely repeats four-plus of her words in order.
      if (best.run >= minRunWords) {
        return { ...best, isEcho: true, reason: 'verbatim_run' };
      }

      const contentWords = tokens(candidate).length;

      // Short utterances cannot be judged on content — "to live in" is both a
      // fragment of her question and a perfectly good human answer. Fall back
      // to timing: only echo if our audio could be arriving right now.
      if (contentWords < minTokens) {
        const isEcho = duringPlayback && best.score >= threshold;
        return { ...best, isEcho, reason: isEcho ? 'short_during_playback' : 'too_short_to_judge' };
      }

      const isEcho = best.score >= threshold && duringPlayback;
      return { ...best, isEcho, reason: isEcho ? 'overlap_during_playback' : 'below_threshold' };
    },

    /** For tests and diagnostics. */
    size: () => spoken.length,
    reset() { spoken = []; },
  };
}
