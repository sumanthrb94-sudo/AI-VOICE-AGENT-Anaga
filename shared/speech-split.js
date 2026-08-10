// shared/speech-split.js
//
// Split a line into speakable phrases. Imported by BOTH the API
// (api/_lib, api/anaga/turn.js) and the call leg
// (caller-agent/src/providers/speech.js), because two copies of this drift and
// the one that drifts is the one nobody is reading.
//
// (web/assets/demo-call.js carries a third, hand-written copy: it is a plain
// browser script with no module loader, so it cannot import this. Its rules are
// the same and its comments say so; if you change the thresholds here, change
// them there too.)
//
// ── WHY SPLIT AT ALL ──────────────────────────────────────────────────────
// Synthesizing a whole line before playing any of it means the listener waits
// for the LAST word to be rendered before hearing the FIRST. Bulbul takes ~3.3s
// on a two-sentence turn. Split it, and the wait is the render time of the
// first phrase; everything behind it renders while earlier audio plays.

// Sentence ends, including the Devanagari danda — a splitter that only knows
// about "." leaves an entire Hindi turn as one chunk.
const SENTENCE_END = /(?<=[.!?।॥])\s+/;
const CLAUSE_END = /(?<=[,;:—–])\s+/;

/**
 * A runt is a fragment too short to be worth its own network round trip.
 *
 * Every cheap proxy for that is biased by script, and BOTH biases land on the
 * two languages this product sells in:
 *
 *   CHARACTERS are Latin-biased. "नमस्ते, मैं अनगा हूँ।" is 21 characters and
 *   about a second and a half of speech; the same sentence in English is 33. A
 *   24-character floor merged every Hindi sentence back into one blob and
 *   quietly turned first-phrase-first off for Hindi entirely.
 *
 *   WORDS are biased the other way. Telugu is agglutinative:
 *   "ఇప్పుడు మాట్లాడవచ్చా?" is a whole question in two words, and a four-word
 *   floor swallowed it just as badly.
 *
 * Short by BOTH is "Yes." and "Theek hai." — and nothing carrying a clause.
 */
function wordCount(s) { return s.split(/\s+/).filter(Boolean).length; }
export function isRunt(s, minWords = 4, minChars = 16) {
  return wordCount(s) < minWords && s.length < minChars;
}

export function splitForSpeech(text, { maxChars = 140, minChars = 16, minWords = 4 } = {}) {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  if (isRunt(whole, minWords, minChars)) return [whole];

  const parts = [];
  for (const sentence of whole.split(SENTENCE_END)) {
    const s = sentence.trim();
    if (!s) continue;
    // A long sentence still blocks first audio, so break it at clause
    // boundaries. Falls through to the whole sentence when it has none — a hard
    // character split would cut mid-word, and Bulbul pronounces the fragments
    // as two separate words.
    if (s.length <= maxChars) { parts.push(s); continue; }
    let acc = '';
    for (const clause of s.split(CLAUSE_END)) {
      const c = clause.trim();
      if (!c) continue;
      if (acc && (acc.length + c.length + 1) > maxChars) { parts.push(acc); acc = c; }
      else acc = acc ? `${acc} ${c}` : c;
    }
    if (acc) parts.push(acc);
  }

  const merged = [];
  for (const p of parts) {
    if (merged.length && isRunt(merged[merged.length - 1], minWords, minChars)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`;
    } else {
      merged.push(p);
    }
  }
  // A trailing runt has nothing to merge into; fold it backwards instead.
  if (merged.length > 1 && isRunt(merged[merged.length - 1], minWords, minChars)) {
    const tail = merged.pop();
    merged[merged.length - 1] = `${merged[merged.length - 1]} ${tail}`;
  }
  return merged.length ? merged : [whole];
}
