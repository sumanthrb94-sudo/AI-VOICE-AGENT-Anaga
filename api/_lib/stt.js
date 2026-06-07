// api/_lib/stt.js
//
// Speech-to-text — provider-abstracted (default: Sarvam Saarika). The API key
// lives ONLY here (server-side env), never in the browser. Takes base64 audio
// (16 kHz mono WAV from the browser) and returns the transcript PLUS the
// detected language code, so Anaga can auto-switch languages from the caller's
// own voice — Telugu / Hindi / English / code-mixed — the way Sarvam does it.
//
// Other providers (Google STT, Deepgram, Whisper) can slot in behind the same
// transcribe() interface without touching callers (honors the provider-
// abstraction boundary in MULTI_AGENT_SPEC §1).
//
// ⚠️ Verify the Sarvam endpoint / model names against current docs
// (https://docs.sarvam.ai). This targets the synchronous Saarika REST API with
// language_code="unknown" for automatic language detection.

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';

export function sttAvailable() {
  const provider = (process.env.STT_PROVIDER || 'sarvam').toLowerCase();
  if (provider === 'sarvam') return !!process.env.SARVAM_API_KEY;
  return false;
}

/**
 * Transcribe one utterance and detect its language.
 * @param {object} opts
 * @param {string} opts.audioBase64 - base64-encoded audio (WAV recommended).
 * @param {string} [opts.mime]      - audio MIME type (default audio/wav).
 * @param {string} [opts.languageCode] - "unknown" to auto-detect, or e.g. "te-IN".
 * @returns {Promise<{transcript:string, language_code:string|null}>}
 */
export async function transcribe({ audioBase64, mime, languageCode } = {}) {
  const provider = (process.env.STT_PROVIDER || 'sarvam').toLowerCase();
  if (provider !== 'sarvam') throw new Error('unsupported_stt_provider');

  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('stt_unavailable');
  if (!audioBase64) throw new Error('no_audio');

  // Node 18+ on Vercel exposes global Blob / FormData / fetch (undici).
  const bytes = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime || 'audio/wav' }), 'audio.wav');
  form.append('model', process.env.SARVAM_STT_MODEL || 'saarika:v2.5');
  // "unknown" → Saarika auto-detects the language and returns it in the response.
  form.append('language_code', languageCode || 'unknown');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: { 'api-subscription-key': key }, // do NOT set Content-Type; fetch sets the multipart boundary
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { const e = await res.json(); detail = (e && (e.message || e.error)) || detail; } catch (_) { /* ignore */ }
    throw new Error('sarvam_stt_failed: ' + detail);
  }

  const data = await res.json();
  // Be defensive about field names across Saarika/Saaras versions.
  const transcript =
    (data && (data.transcript ||
      (Array.isArray(data.transcripts) ? data.transcripts[0] : '') ||
      data.text)) || '';
  const language_code =
    (data && (data.language_code || data.detected_language_code || data.lang_code)) || null;

  return { transcript: String(transcript || ''), language_code };
}
