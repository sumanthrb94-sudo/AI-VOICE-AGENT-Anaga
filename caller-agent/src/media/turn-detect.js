// caller-agent/src/media/turn-detect.js
//
// SEMANTIC end-of-turn detection, layered on top of the silence window.
//
// ── WHY ───────────────────────────────────────────────────────────────────
// A fixed silence threshold has to be wrong in one of two directions. Ours is
// 900ms, set that high deliberately because Indian English and code-mixing
// pause mid-sentence and a shorter window talks over people — but 900ms of dead
// air after "no" is most of a second of the agent visibly not listening.
//
// The fix is not a different number. It is noticing that "and then, uh" and
// "no, not really" are not the same event, and that we ALREADY KNOW WHICH:
// transport.js speculatively transcribes at 400ms of silence, so by the time
// the decision is due there is usually a transcript in hand. This reads it.
//
//   complete    -> close the window EARLY. They answered; stop making them wait.
//   incomplete  -> HOLD it open longer. They are mid-thought; interrupting a
//                  prospect mid-sentence is the single rudest thing this agent
//                  can do, and it is what a shorter fixed threshold would cause.
//   null        -> no opinion. The plain silence window decides, unchanged.
//
// ── THE FALLBACK IS NOT OPTIONAL ──────────────────────────────────────────
// Every path is still bounded by the raw silence timeout and maxUtteranceMs.
// This can move the decision earlier or later WITHIN those bounds; it can never
// remove them. A classifier that hangs, throws, or has no opinion costs nothing.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
// It is not a trained model. smart-turn-v2 and its relatives classify on
// ACOUSTICS — pitch contour, final-syllable lengthening, breath — which is
// strictly more information than the words, and catches the case this cannot:
// a grammatically complete sentence said with a rising, unfinished intonation.
// Running one needs an inference host this repo does not have.
//
// The seam is deliberate: swap the body of endOfTurn() for a call to such a
// model and nothing above it changes. Until then this buys most of the benefit
// from a transcript we are already paying for.

/** Words that almost never end a turn — the speaker is still going. */
const CONTINUATIONS = [
  // English / Indian English
  'and', 'or', 'but', 'so', 'because', 'if', 'then', 'also', 'plus', 'though',
  'actually', 'basically', 'like', 'i mean', 'you know', 'um', 'uh', 'umm', 'hmm',
  'the', 'a', 'an', 'my', 'our', 'their', 'this', 'that', 'to', 'for', 'in', 'at',
  'with', 'about', 'around', 'nearly', 'maybe', 'around',
  // Hindi — romanised and Devanagari
  'aur', 'ya', 'lekin', 'kyunki', 'agar', 'matlab', 'toh', 'to', 'phir', 'woh',
  'और', 'या', 'लेकिन', 'क्योंकि', 'अगर', 'मतलब', 'फिर', 'वो', 'तो',
  // Telugu — romanised and native
  'mariyu', 'kaani', 'endukante', 'ante', 'appudu', 'inka',
  'మరియు', 'కానీ', 'ఎందుకంటే', 'అంటే', 'ఇంకా', 'అప్పుడు',
];

/** Complete turns in their own right. Short answers are the whole point: they
 *  are the ones a long silence window punishes hardest. */
const COMPLETE_ALONE = [
  'yes', 'no', 'yeah', 'nope', 'ok', 'okay', 'sure', 'right', 'correct', 'fine',
  'haan', 'nahi', 'nahin', 'theek hai', 'thik hai', 'bilkul', 'ji', 'ji haan',
  'avunu', 'kaadu', 'ledu', 'sare', 'sari', 'antha', 'ok andi',
  'हाँ', 'हां', 'नहीं', 'ठीक है', 'बिल्कुल',
  'అవును', 'కాదు', 'లేదు', 'సరే',
];

const TERMINAL = /[.!?।॥]\s*$/;
const TRAILING_COMMA = /[,;:—–]\s*$/;

/** Strip punctuation and case so a cue matches however STT rendered it. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:—–"'“”‘’()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this utterance finished?
 *
 * @param {string} text  the transcript so far (may be a speculative one)
 * @returns {'complete'|'incomplete'|null}  null means "no opinion"
 */
export function endOfTurn(text) {
  const raw = String(text || '');
  const norm = normalize(raw);
  if (!norm) return null;                       // nothing to judge

  // Trailing comma or dash: they are enumerating. Nobody stops on a comma.
  if (TRAILING_COMMA.test(raw.trim())) return 'incomplete';

  const words = norm.split(' ');
  const last = words[words.length - 1];
  const lastTwo = words.slice(-2).join(' ');

  // A dangling conjunction or filler. Checked BEFORE terminal punctuation,
  // because STT happily emits "and." at the end of a fragment.
  if (CONTINUATIONS.includes(last) || CONTINUATIONS.includes(lastTwo)) return 'incomplete';

  // A number with nothing after it is usually mid-figure — "eighty five" before
  // "lakhs", "two" before "BHK". Prices and configurations are most of what
  // this call is made of, so cutting in here is expensive and common.
  if (/^\d+$/.test(last)) return 'incomplete';

  // A short answer, whole in itself.
  if (COMPLETE_ALONE.includes(norm) || COMPLETE_ALONE.includes(lastTwo)) return 'complete';

  // Explicit sentence end from an STT that emits punctuation, on something long
  // enough to be a sentence. Many Indic STT paths emit none at all, which is
  // why this is the last check rather than the first.
  if (TERMINAL.test(raw.trim()) && words.length >= 3) return 'complete';

  return null;                                  // let the silence window decide
}

/**
 * How long to wait for more speech, given what we think we heard.
 * Always inside [semanticCloseMs, maxUtteranceMs] — the caller still applies
 * its own hard bounds on top.
 */
export function windowFor(verdict, timings) {
  if (verdict === 'complete') return timings.semanticCloseMs;
  if (verdict === 'incomplete') return Math.round(timings.silenceMs * timings.hesitationFactor);
  return timings.silenceMs;
}
