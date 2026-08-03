// api/_lib/translate.js
//
// Translation — provider-abstracted, Google-backed, with a path that works
// before anyone touches a billing console.
//
//   1. cloud — Cloud Translation v2. Needs GOOGLE_API_KEY or a service account
//      AND the Translation API enabled on the project. Best quality.
//   2. free  — translate.googleapis.com/translate_a/single, the endpoint the
//      Google Translate web page itself uses. No key, no project, no billing.
//      Undocumented, so it can change or rate-limit without notice. It is the
//      fallback, never the thing we promise a customer.
//
// ── WHAT MUST NEVER COME THROUGH HERE ─────────────────────────────────────
// The AI disclosure. It is a regulatory statement (docs/COMPLIANCE.md), and its
// exact wording in each language is versioned data in
// caller-agent/flows/anaga.persona.json. Machine-translating it would mean the
// sentence that makes the call legal is generated at runtime by a service that
// can return anything, in a language nobody on the team reads. Fixed lines come
// from the persona file. Only the conversational middle of a call is translated.

const FREE_URL = 'https://translate.googleapis.com/translate_a/single';
const CLOUD_URL = 'https://translation.googleapis.com/language/translate/v2';

const MAX_CHARS = 2000;      // a spoken turn is a sentence or two; this is generous
const CHUNK_CHARS = 800;     // the free endpoint carries text in the query string

// Bounded cache. Anaga repeats herself a lot across a call (greetings,
// acknowledgements, the booking line), so this is most of the latency win.
const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(k) {
  if (!cache.has(k)) return null;
  const v = cache.get(k);
  cache.delete(k); cache.set(k, v);          // refresh recency
  return v;
}
function cacheSet(k, v) {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/** "hi-IN" -> "hi". Google's translate codes are the bare language subtag. */
export function toTranslateCode(lang) {
  const s = String(lang || '').trim().toLowerCase().replace('_', '-');
  if (!s || s === 'auto') return 'auto';
  return s.split('-')[0];
}

export function translateAvailable() {
  // The free endpoint needs nothing, so translation is always *possible*.
  // `mode` below is what says whether it is the good path or the fallback.
  return true;
}

export function translateMode() {
  return (process.env.TRANSLATE_PROVIDER || 'auto').toLowerCase();
}

/**
 * translate({ text, to, from }) -> { text, from, provider }
 *
 * Never throws for an ordinary failure: on any error it returns the ORIGINAL
 * text with provider "none". A translation outage must degrade to "she speaks
 * English" — never to silence mid-call.
 */
export async function translate({ text, to, from = 'auto' } = {}) {
  const src = typeof text === 'string' ? text.trim() : '';
  const target = toTranslateCode(to);
  const source = toTranslateCode(from);

  if (!src) return { text: '', from: source, provider: 'none' };
  if (!target || target === 'auto') return { text: src, from: source, provider: 'none' };
  // Same language in and out is not a translation, it is a round trip that can
  // only make the wording worse.
  if (target === source) return { text: src, from: source, provider: 'none' };

  const clipped = src.slice(0, MAX_CHARS);
  const key = `${source}>${target}|${clipped}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };

  const mode = translateMode();
  const chain = mode === 'free' ? ['free'] : mode === 'cloud' ? ['cloud'] : ['cloud', 'free'];

  let lastError = null;
  for (const provider of chain) {
    try {
      const out = provider === 'cloud'
        ? await viaCloud(clipped, target, source)
        : await viaFree(clipped, target, source);
      if (out && out.text) {
        const result = { text: out.text, from: out.from || source, provider };
        cacheSet(key, result);
        return result;
      }
    } catch (err) {
      lastError = err;
      // `not_configured` and `api_disabled` are expected states, not incidents —
      // they just mean "fall through to the free endpoint".
    }
  }

  return { text: clipped, from: source, provider: 'none', error: errorCode(lastError) };
}

function errorCode(err) {
  if (!err) return undefined;
  return err.code || 'upstream_error';
}

// ---------------------------------------------------------------------------
// cloud: Cloud Translation v2
// ---------------------------------------------------------------------------
async function viaCloud(text, target, source) {
  const { googleFetch, googleConfigured } = await import('./google.js');
  if (!googleConfigured()) { const e = new Error('google_not_configured'); e.code = 'not_configured'; throw e; }

  const body = { q: text, target, format: 'text' };
  if (source && source !== 'auto') body.source = source;

  const data = await googleFetch(CLOUD_URL, { method: 'POST', body });
  const t = data && data.data && Array.isArray(data.data.translations) ? data.data.translations[0] : null;
  if (!t || typeof t.translatedText !== 'string') { const e = new Error('cloud_translate_empty'); e.code = 'upstream_error'; throw e; }
  return { text: decodeEntities(t.translatedText), from: t.detectedSourceLanguage || source };
}

// ---------------------------------------------------------------------------
// free: the endpoint translate.google.com itself calls
// ---------------------------------------------------------------------------
async function viaFree(text, target, source) {
  const parts = chunk(text, CHUNK_CHARS);
  const out = [];
  let detected = source;

  for (const part of parts) {
    const url = `${FREE_URL}?client=gtx&sl=${encodeURIComponent(source || 'auto')}` +
      `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(part)}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      // redirect:'manual' on purpose. When Google decides the caller looks like
      // a bot it 302s to /sorry/index instead of returning an error status.
      // Following that redirect turns a rate limit into an unrelated-looking
      // failure on a different host, which is how this reads as "upstream_error"
      // when it is really "you are calling too often from a datacentre IP".
      res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaakVoice/1.0)' },
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const e = new Error('free_translate_rate_limited');
      e.code = 'rate_limited';
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`free_translate_${res.status}`);
      e.code = res.status === 429 ? 'quota_exceeded' : 'upstream_error';
      throw e;
    }

    // Shape: [[["translated","source",…], …], null, "en", …]
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      const e = new Error('free_translate_shape'); e.code = 'upstream_error'; throw e;
    }
    out.push(data[0].map((seg) => (Array.isArray(seg) ? seg[0] : '')).filter(Boolean).join(''));
    if (typeof data[2] === 'string' && data[2]) detected = data[2];
  }

  return { text: out.join(' ').trim(), from: detected };
}

/** Split on sentence boundaries so a chunk edge never lands mid-clause. */
export function chunk(text, max) {
  const s = String(text);
  if (s.length <= max) return [s];
  const out = [];
  let buf = '';
  for (const piece of s.split(/(?<=[.!?।॥])\s+/)) {
    // A single sentence longer than the limit still has to be cut somewhere.
    if (piece.length > max) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max));
      continue;
    }
    if ((buf + ' ' + piece).trim().length > max) { out.push(buf.trim()); buf = piece; }
    else buf = (buf ? buf + ' ' : '') + piece;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Cloud Translation returns HTML entities even with format:"text". */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');            // last, so &amp;lt; does not become <
}
