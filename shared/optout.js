// shared/optout.js
//
// Mid-call opt-out detection — THE SINGLE SOURCE OF TRUTH, shared by the caller
// agent (which ends the call) and the API (which is the last line of defence
// when a call is reported by anything else). It used to be duplicated: the
// caller agent had full Indic coverage while api/calls/outcome.js carried a
// Latin-only regex, so a Devanagari opt-out reported by a third-party dialer
// would have been missed by the one component that writes the suppression list.
//
// This is the single most safety-critical function in the system: if it misses,
// we keep talking to someone who asked us to stop, and we dial them tomorrow.
//
// Design rules:
//   - It runs on EVERY prospect utterance, before the brain sees it. The LLM is
//     never the thing that decides whether an opt-out happened.
//   - It covers English, Hindi and Telugu, plus the romanized code-mixing real
//     callers actually use ("mujhe call mat karo", "call cheyyakandi").
//   - It biases toward FALSE POSITIVES. Ending a call we could have continued
//     costs one lead. Missing an opt-out is a regulatory breach.
//
// The triggers here are a superset of the ones in
// caller-agent/flows/real-estate-qualify.flow.json `globals.optout`.

// Each entry is matched case-insensitively against the normalized utterance.
const PATTERNS = [
  // --- English -----------------------------------------------------------
  /\bdo ?n[o']?t (call|contact|phone|ring)\b/i,
  /\bstop (calling|contacting|phoning|ringing)\b/i,
  /\bnever call\b/i,
  /\bremove (me|my (number|name))\b/i,
  /\btake me off\b/i,
  /\bunsubscribe\b/i,
  /\bopt(ing)? ?out\b/i,
  /\bblock (me|my number)\b/i,
  /\bdnd\b/i,
  /\bdo not disturb\b/i,
  /\bnot interested\b/i,
  /\bno longer interested\b/i,
  /\bleave me alone\b/i,
  /\bdon'?t (ever )?(call|contact) (me )?again\b/i,
  /\b(add|put) (me|my number) (to|on) (the )?(do.?not.?call|dnc|blacklist)\b/i,
  /\blegal action\b/i,
  /\bi'?ll (report|complain)\b/i,

  // --- Hindi (romanized + Devanagari) -----------------------------------
  /\bcall (mat|nahi|nahin) (karo|karna|kijiye)\b/i,
  /\b(mat|nahi|nahin) karo call\b/i,
  /\bphone (mat|nahi) (karo|karna)\b/i,
  /\bdobara (mat|nahi) (karo|karna)\b/i,
  /\bpareshan (mat|na) karo\b/i,
  /\bmujhe (koi )?interest nahi\b/i,
  /\bnahi chahiye\b/i,
  // NOTE: no \b on the Indic-script patterns. JavaScript's \b is defined
  // against ASCII \w, so Devanagari and Telugu characters never form a word
  // boundary and every one of these silently matched nothing. Caught by the
  // E2E suite; the substring match below is the correct form.
  /हटा (दो|दीजिए)/,
  /कॉल (मत|नहीं) (करो|करना|कीजिए)/,
  /फ़?ोन (मत|नहीं) (करो|करना)/,
  /परेशान (मत|ना) करो/,
  /मुझे (कोई )?(दिलचस्पी|इंटरेस्ट) नहीं/,
  /नहीं चाहिए/,

  // --- Telugu (romanized + script) --------------------------------------
  /\bcall (cheyyakandi|cheyyodhu|cheyyaku|vaddu)\b/i,
  /\bphone cheyyakandi\b/i,
  /\bmalli (call )?(cheyyakandi|cheyyodhu)\b/i,
  /\bnaku (interest|istam) ledu\b/i,
  /\bvaddu (andi)?\b/i,
  // Same \b problem as the Devanagari block above — matched as substrings.
  /ఇష్టం లేదు/,
  /ఆసక్తి లేదు/,
  /కాల్ (చేయకండి|చేయొద్దు|వద్దు)/,
  /ఫోన్ చేయకండి/,
  /మళ్ళీ (కాల్ )?చేయకండి/,
];

// Phrases that look like opt-outs but are not — checked first so a prospect who
// says "no, I'm not not-interested" or asks a question isn't hung up on.
const NEGATED = [
  /\b(no|not|never) (i'?m |i am )?not interested\b/i,
  /\bwhy (would|should) i (opt out|unsubscribe)\b/i,
  /\bhow do i (opt out|unsubscribe)\b/i,   // a question, answer it, don't hang up
];

/** Collapse whitespace/punctuation so "d.n.d." and "stop  calling!" still match. */
function normalize(text) {
  return String(text || '')
    .replace(/[.․]/g, (m, i, s) => (/\w/.test(s[i - 1] || '') && /\w/.test(s[i + 1] || '') ? '' : ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text  a single prospect utterance
 * @returns {{optOut: boolean, matched: string|null}}
 */
export function detectOptOut(text) {
  const s = normalize(text);
  if (!s) return { optOut: false, matched: null };

  for (const n of NEGATED) {
    if (n.test(s)) return { optOut: false, matched: null };
  }
  for (const p of PATTERNS) {
    if (p.test(s)) return { optOut: true, matched: p.source };
  }
  return { optOut: false, matched: null };
}

/** True if any prospect turn in a transcript opted out. */
export function transcriptHasOptOut(history) {
  return (Array.isArray(history) ? history : [])
    .filter((t) => t && t.role === 'user')
    .some((t) => detectOptOut(t.text).optOut);
}
