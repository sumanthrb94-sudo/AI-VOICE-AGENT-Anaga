// api/stt.js
//
// GET  /api/stt   -> { available: boolean, provider, model } (capability probe; never errors)
// POST /api/stt   -> { transcript, language_code } | 503 { error: "stt_unavailable" }
//
// Transcribes one utterance with a real Indian-language STT (Sarvam Saarika) and
// returns the DETECTED language so the live "Talk to Anaga" call can auto-switch
// languages from the caller's own voice. Key is server-side only.
// Fail soft: on any error the browser falls back to its on-device Web Speech.

import { sttAvailable, transcribe } from './_lib/stt.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

// Cap accepted audio (~1.5 MB base64 ≈ ~30s of 16 kHz mono PCM) so an oversized
// upload can't force a costly Sarvam round-trip. Sarvam's sync STT is <30s anyway.
const MAX_AUDIO_B64 = 1_500_000;

export default async function handler(req, res) {
  // Capability probe — lets the browser decide whether to use cloud STT.
  if (req.method === 'GET') {
    return res.status(200).json({
      available: sttAvailable(),
      provider: (process.env.STT_PROVIDER || 'sarvam').toLowerCase(),
      model: process.env.SARVAM_STT_MODEL || 'saarika:v2.5',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Paid endpoint (Sarvam credits) — throttle per IP to prevent credit-drain.
  if (blockedByRateLimit(req, res, { key: 'stt', max: 30, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }

  const audioBase64 = typeof body.audio === 'string' ? body.audio : '';
  if (!audioBase64) return res.status(400).json({ error: 'audio_required' });
  if (audioBase64.length > MAX_AUDIO_B64) return res.status(413).json({ error: 'audio_too_large' });
  const languageCode = typeof body.language_code === 'string' ? body.language_code : 'unknown';
  const mime = typeof body.mime === 'string' ? body.mime : 'audio/wav';

  if (!sttAvailable()) return res.status(503).json({ error: 'stt_unavailable' });

  try {
    const { transcript, language_code } = await transcribe({ audioBase64, mime, languageCode });
    return res.status(200).json({ transcript, language_code });
  } catch {
    // Never leak provider details; client falls back to on-device speech.
    return res.status(503).json({ error: 'stt_unavailable' });
  }
}
