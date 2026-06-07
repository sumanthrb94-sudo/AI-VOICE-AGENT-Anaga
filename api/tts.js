// api/tts.js
//
// GET  /api/tts          -> { available: boolean, provider, model } (capability probe; never errors)
// POST /api/tts          -> { audio: base64, mime } | 503 { error: "tts_unavailable" }
//
// Synthesizes Anaga's speech with a real cloud voice (Sarvam Bulbul) so the 3
// UI voices are distinct & lifelike on every device. Key is server-side only.
// Fail soft: on any error the browser falls back to its on-device voice.

import { ttsAvailable, synth } from './_lib/tts.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

export default async function handler(req, res) {
  // Capability probe — lets the browser decide whether to use cloud voices.
  if (req.method === 'GET') {
    return res.status(200).json({
      available: ttsAvailable(),
      provider: (process.env.TTS_PROVIDER || 'sarvam').toLowerCase(),
      model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Paid endpoint (Sarvam credits) — throttle per IP to prevent credit-drain.
  if (blockedByRateLimit(req, res, { key: 'tts', max: 40, windowMs: 60000 })) return;

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
  const { pitch, pace, loudness } = body;   // optional modulation (clamped in synth)

  if (!ttsAvailable()) return res.status(503).json({ error: 'tts_unavailable' });

  try {
    const { audio, mime } = await synth({ text, lang, speaker, pitch, pace, loudness });
    return res.status(200).json({ audio, mime });
  } catch {
    // Never leak provider details; client falls back to its on-device voice.
    return res.status(503).json({ error: 'tts_unavailable' });
  }
}
