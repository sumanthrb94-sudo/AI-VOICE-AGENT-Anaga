// api/speech.js
//
// Consolidated speech endpoint — TTS and STT in one function.
//
// GET  /api/speech?type=tts  → { available, provider, model }   (was /api/tts GET)
// POST /api/speech?type=tts  → { audio, mime }                  (was /api/tts POST)
// GET  /api/speech?type=stt  → { available, provider, model }   (was /api/stt GET)
// POST /api/speech?type=stt  → { transcript, language_code }    (was /api/stt POST)
//
// Legacy URLs /api/tts and /api/stt are rewritten here via vercel.json.

import { ttsAvailable, synth } from './_lib/tts.js';
import { sttAvailable, transcribe } from './_lib/stt.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

const MAX_AUDIO_B64 = 1_500_000;

export default async function handler(req, res) {
  const type = String(req.query && req.query.type || 'tts');
  if (type === 'stt') return handleSTT(req, res);
  return handleTTS(req, res);
}

async function handleTTS(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      available: ttsAvailable(),
      provider: (process.env.TTS_PROVIDER || 'sarvam').toLowerCase(),
      model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2',
    });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (blockedByRateLimit(req, res, { key: 'tts', max: 40, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text_required' });
  if (!ttsAvailable()) return res.status(503).json({ error: 'tts_unavailable' });

  try {
    const { audio, mime } = await synth({
      text, lang: body.lang || 'en-IN', speaker: body.speaker || 'anushka',
      pitch: body.pitch, pace: body.pace, loudness: body.loudness,
    });
    return res.status(200).json({ audio, mime });
  } catch { return res.status(503).json({ error: 'tts_unavailable' }); }
}

async function handleSTT(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      available: sttAvailable(),
      provider: (process.env.STT_PROVIDER || 'sarvam').toLowerCase(),
      model: process.env.SARVAM_STT_MODEL || 'saarika:v2.5',
    });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (blockedByRateLimit(req, res, { key: 'stt', max: 30, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const audioBase64 = typeof body.audio === 'string' ? body.audio : '';
  if (!audioBase64) return res.status(400).json({ error: 'audio_required' });
  if (audioBase64.length > MAX_AUDIO_B64) return res.status(413).json({ error: 'audio_too_large' });
  if (!sttAvailable()) return res.status(503).json({ error: 'stt_unavailable' });

  try {
    const { transcript, language_code } = await transcribe({
      audioBase64, mime: body.mime || 'audio/wav', languageCode: body.language_code || 'unknown',
    });
    return res.status(200).json({ transcript, language_code });
  } catch { return res.status(503).json({ error: 'stt_unavailable' }); }
}
