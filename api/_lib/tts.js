// api/_lib/tts.js
//
// Text-to-speech — provider-abstracted (default: Sarvam Bulbul). The API key
// lives ONLY here (server-side env), never in the browser. Returns base64 audio.
// Other providers (ElevenLabs, Azure, Google Cloud) can be added behind the same
// synth() interface without touching callers (honors the provider-abstraction
// boundary in MULTI_AGENT_SPEC §1).
//
// ⚠️ Verify the Sarvam endpoint / model / speaker names against current docs
// (https://docs.sarvam.ai) — they evolve. This targets Bulbul v2.

const SARVAM_URL = 'https://api.sarvam.ai/text-to-speech';

// female Bulbul v2 speakers used by the 3 UI voices
const SARVAM_SPEAKERS = ['anushka', 'manisha', 'vidya', 'arya'];

export function ttsAvailable() {
  const provider = (process.env.TTS_PROVIDER || 'sarvam').toLowerCase();
  if (provider === 'sarvam') return !!process.env.SARVAM_API_KEY;
  return false;
}

export async function synth({ text, lang, speaker, pitch, pace, loudness } = {}) {
  const provider = (process.env.TTS_PROVIDER || 'sarvam').toLowerCase();
  if (provider !== 'sarvam') throw new Error('unsupported_tts_provider');

  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('tts_unavailable');

  const spk = SARVAM_SPEAKERS.includes(String(speaker || '').toLowerCase())
    ? String(speaker).toLowerCase()
    : 'anushka';

  // modulation (clamped to Sarvam's accepted ranges; verify against current docs)
  const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };

  const body = {
    text: String(text).slice(0, 1500),
    target_language_code: lang || 'en-IN',
    speaker: spk,
    model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2',
    pitch: clamp(pitch, -1, 1, 0),
    pace: clamp(pace, 0.3, 3, 1.0),
    loudness: clamp(loudness, 0.1, 3, 1.0),
    speech_sample_rate: 22050,
    enable_preprocessing: true
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(SARVAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { const e = await res.json(); detail = (e && (e.message || e.error)) || detail; } catch (_) { /* ignore */ }
    throw new Error('sarvam_tts_failed: ' + detail);
  }
  const data = await res.json();
  const audio = data && (Array.isArray(data.audios) ? data.audios[0] : data.audio);
  if (!audio) throw new Error('sarvam_tts_empty');
  return { audio, mime: 'audio/wav' };
}
