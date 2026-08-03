// api/tts.js
//
// GET  /api/tts  -> { available, chain, ready, maleCapable } (capability probe; never errors)
// POST /api/tts  -> { audio: base64, mime, provider, voice, gender } | 503 { error }
//
// Synthesizes Anaga's speech with a real cloud voice so she sounds the same on
// every device. Keys are server-side only. Fail soft: on total failure the
// browser falls back to its on-device voice — but the chain in _lib/tts.js means
// that now takes every provider failing, not one.

import { ttsAvailable, ttsStatus, synth } from './_lib/tts.js';

export default async function handler(req, res) {
  // Capability probe — lets the browser decide whether to use cloud voices, and
  // whether the male voice it is offering can actually be served.
  if (req.method === 'GET') {
    return res.status(200).json(ttsStatus());
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text_required' });

  const lang = typeof body.lang === 'string' ? body.lang : 'en-IN';
  const speaker = typeof body.speaker === 'string' ? body.speaker : 'anushka';
  const gender = String(body.gender || 'female').toLowerCase() === 'male' ? 'male' : 'female';
  const voice = typeof body.voice === 'string' ? body.voice : undefined;
  const { pitch, pace, loudness } = body;   // optional modulation (clamped in synth)

  if (!ttsAvailable()) return res.status(503).json({ error: 'tts_unavailable' });

  try {
    const out = await synth({ text, lang, speaker, gender, voice, pitch, pace, loudness });
    return res.status(200).json(out);
  } catch (err) {
    // The reason goes to the log, never to the client — provider errors can
    // carry key fragments. But it MUST reach the log: a silent 503 here is what
    // turned "the premium voice is off" into a week of guessing.
    console.error(JSON.stringify({
      event: 'tts_failed',
      reason: String(err?.message || 'tts_error'),
      detail: err?.detail ? String(err.detail).slice(0, 500) : undefined,
    }));
    return res.status(503).json({ error: 'tts_unavailable' });
  }
}
