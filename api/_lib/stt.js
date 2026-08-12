// api/_lib/stt.js
//
// Speech to text — provider-abstracted, the same shape as _lib/tts.js. Keys are
// server-side only; the browser sends audio and gets words back.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// The browser demo used the Web Speech API, which is free and instant and
// cannot do the one thing this product needs: echo cancellation. It owns the
// microphone exclusively, exposes no audio stream, and happily transcribes
// Anaga's own voice coming back off a phone speaker. She answers herself, and
// the call becomes a loop — shipped, three times, with three different
// heuristics stacked on top to try to tell her voice from a prospect's.
//
// The fix is not a better heuristic. It is to capture audio through
// getUserMedia with echoCancellation, where the browser subtracts what it is
// playing from what it hears BEFORE anything downstream sees it, and to send
// that audio somewhere that will transcribe it. That somewhere is here.
//
// Sarvam Saaras: same vendor as the voice, Indic-native, Indian data residency
// for the audio as well as the text (docs/COMPLIANCE.md), and the key is
// already configured because the TTS uses it.

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const DEFAULT_TIMEOUT_MS = 12000;

/** Languages Saaras accepts, plus auto-detect. */
const LANGS = new Set(['unknown', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN',
  'pa-IN', 'ta-IN', 'te-IN', 'en-IN', 'gu-IN', 'as-IN', 'ur-IN']);

export function sttChain() {
  return String(process.env.STT_PROVIDER || 'sarvam')
    .split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
}

export function sttReady(provider) {
  if (provider === 'sarvam') return Boolean(process.env.SARVAM_API_KEY);
  if (provider === 'deepgram') return Boolean(process.env.DEEPGRAM_API_KEY);
  return false;
}

export function sttAvailable() { return sttChain().some(sttReady); }

export function sttStatus() {
  const chain = sttChain();
  return {
    chain,
    ready: chain.filter(sttReady),
    model: process.env.SARVAM_STT_MODEL || 'saaras:v3',
    deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
  };
}

const ADAPTERS = { sarvam: viaSarvam, deepgram: viaDeepgram };

/**
 * Transcribe one utterance.
 *
 * @param {object} opts
 * @param {Buffer}  opts.audio  raw bytes (WebM/Opus from MediaRecorder, WAV, MP4…)
 * @param {string} [opts.mime]  the container the browser produced
 * @param {string} [opts.lang]  BCP-47; "unknown" auto-detects
 * @returns {Promise<{text: string, lang: string|null, provider: string}>}
 * @throws when every configured provider fails — the caller decides what a
 *         failed transcription means, and on a live call it is NOT silence.
 */
export async function transcribe({ audio, mime, lang } = {}) {
  if (!audio || !audio.length) throw new Error('stt_audio_required');
  const chain = sttChain().filter(sttReady);
  if (!chain.length) throw new Error('stt_unavailable');

  const errors = [];
  for (const provider of chain) {
    try {
      // DISPATCH ON THE PROVIDER. This loop walked the chain and then called
      // Sarvam every time regardless — harmless while Sarvam was the only
      // adapter, and a silent lie the moment a second one existed:
      // STT_PROVIDER=deepgram would have reported Deepgram in health and sent
      // the audio to Sarvam.
      const adapter = ADAPTERS[provider];
      if (!adapter) throw new Error(`no adapter for "${provider}"`);
      const out = await adapter({ audio, mime, lang });
      if (errors.length) {
        console.error(JSON.stringify({
          event: 'stt_fell_back', served: provider, severity: 'high',
          failed: errors.map((e) => String(e).slice(0, 160)),
        }));
      }
      return out;
    } catch (err) {
      errors.push(`${provider}: ${err?.message || 'failed'}`);
    }
  }
  const e = new Error('stt_failed');
  e.detail = errors.join(' | ');
  throw e;
}

async function viaSarvam({ audio, mime, lang }) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('sarvam_not_configured');

  const form = new FormData();
  // The filename extension matters to some multipart parsers, so it is derived
  // from the container the browser actually produced rather than assumed. Chrome
  // gives WebM/Opus, Safari gives MP4 — Saaras accepts both.
  const type = String(mime || 'audio/webm').split(';')[0];
  const ext = type.includes('mp4') || type.includes('aac') ? 'm4a'
    : type.includes('ogg') ? 'ogg'
      : type.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([audio], { type }), `utterance.${ext}`);
  form.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v3');
  // "transcribe" keeps the prospect's own language and normalises numbers —
  // "9840950950" rather than the digits spelled out one at a time, which is
  // what a budget or a phone number has to be for the rest of the pipeline.
  form.append('mode', process.env.SARVAM_STT_MODE || 'transcribe');
  // Auto-detect by default. A prospect who answers a Telugu call in English is
  // ordinary here, and pinning the language transcribes them as gibberish.
  form.append('language_code', LANGS.has(String(lang)) ? String(lang) : 'unknown');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.STT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  let res;
  try {
    res = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': key },
      body: form,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`sarvam_stt_${err && err.name === 'AbortError' ? 'timeout' : 'network'}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Carry the vendor's own sentence. "[object Object]" in this position cost
    // days on the TTS side — see the note in _lib/tts.js.
    let detail = `HTTP ${res.status}`;
    try {
      const e = await res.json();
      const msg = e?.error?.message || e?.message || e?.error || e?.detail;
      detail += ': ' + (typeof msg === 'string' ? msg : JSON.stringify(e)).slice(0, 300);
    } catch { /* not JSON; the status stands alone */ }
    throw new Error(`sarvam_stt_failed: ${detail}`);
  }

  const data = await res.json();
  return {
    text: String(data?.transcript || '').trim(),
    lang: data?.language_code || null,
    provider: 'sarvam',
  };
}

// ---------------------------------------------------------------------------
// Deepgram Nova-3
// ---------------------------------------------------------------------------
//
// ── WHAT IT BUYS ──────────────────────────────────────────────────────────
// Nova-3 does Telugu (`te`), Hindi (`hi`) and Indian English (`en-IN`), which
// is the whole product, and its streaming endpoint carries the two things this
// pipeline is missing: interim transcripts as the prospect speaks, and
// server-side endpointing with VAD events. That is the answer to both "she is
// slow" and "it thinks the room is talking" — but only over a WebSocket, which
// a Vercel serverless function cannot hold. This adapter is the BATCH endpoint;
// see docs/VAD.md for what the streaming move requires.
//
// ── THE CATCH, AND IT MATTERS ─────────────────────────────────────────────
// Deepgram's code-switching mode (`language=multi`) covers English and Hindi
// but NOT Telugu. So a Telugu call has to PIN `te`, and a prospect who answers
// a Telugu call in English — completely ordinary here — is then transcribed by
// a Telugu model. Saaras auto-detects across all of them and does not have this
// problem. That is a real trade, not a detail: pick per language, not globally.
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

/** Our BCP-47 to Deepgram's codes. Nova-3 wants the bare tag for Indic. */
const DG_LANG = {
  'te-IN': 'te', 'hi-IN': 'hi', 'en-IN': 'en-IN', 'ta-IN': 'ta', 'kn-IN': 'kn',
  'mr-IN': 'mr', 'bn-IN': 'bn', 'gu-IN': 'gu', 'pa-IN': 'pa', 'ur-IN': 'ur',
};

async function viaDeepgram({ audio, mime, lang }) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('deepgram_not_configured');

  const q = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    // Punctuation and number formatting, for the same reason Saaras runs in
    // "transcribe" mode: a budget or a phone number has to arrive as digits.
    smart_format: 'true',
    punctuate: 'true',
  });
  // Pinned when we know the language, `multi` when we do not — and `multi`
  // deliberately, rather than a guess, because guessing Telugu wrong produces
  // fluent nonsense rather than an obvious failure.
  q.set('language', DG_LANG[String(lang)] || process.env.DEEPGRAM_FALLBACK_LANG || 'multi');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.STT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  let res;
  try {
    res = await fetch(`${DEEPGRAM_URL}?${q}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        // The container as the browser produced it. Deepgram sniffs the bytes
        // too, but a wrong declared type is how "works on my phone" happens.
        'Content-Type': String(mime || 'audio/webm').split(';')[0],
      },
      body: audio,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`deepgram_stt_${err && err.name === 'AbortError' ? 'timeout' : 'network'}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Carry the vendor's own sentence — see the note in the Sarvam adapter
    // above, which cost days on the TTS side.
    let detail = `HTTP ${res.status}`;
    try {
      const e = await res.json();
      const msg = e?.err_msg || e?.message || e?.error || e?.reason;
      detail += ': ' + (typeof msg === 'string' ? msg : JSON.stringify(e)).slice(0, 300);
    } catch { /* not JSON; the status stands alone */ }
    throw new Error(`deepgram_stt_failed: ${detail}`);
  }

  const data = await res.json();
  const channel = data?.results?.channels?.[0];
  return {
    text: String(channel?.alternatives?.[0]?.transcript || '').trim(),
    // Deepgram reports what it detected under `multi`; under a pinned language
    // it reports nothing, so fall back to what we asked for rather than null —
    // the caller uses this to decide which voice answers.
    lang: channel?.detected_language || (DG_LANG[String(lang)] ? String(lang) : null),
    provider: 'deepgram',
  };
}
