// api/tts.js
//
// GET  /api/tts  -> { available, chain, ready, maleCapable } (capability probe; never errors)
// POST /api/tts  -> { audio: base64, mime, provider, voice, gender } | 503 { error }
//
// Synthesizes Anaga's speech with a real cloud voice so she sounds the same on
// every device. Keys are server-side only. Fail soft: on total failure the
// browser falls back to its on-device voice — but the chain in _lib/tts.js means
// that now takes every provider failing, not one.

//
// ── THIS ENDPOINT SPENDS MONEY AND IS PUBLIC ──────────────────────────────
// The browser demo calls it with no credential, so it cannot require one — but
// it was also unmetered, which means anyone (or a crawler) could bill the
// Gemini/Sarvam account one request at a time from a URL that is indexed.
// The account's quota being exhausted mid-session is exactly what an unmetered
// paid endpoint on a public URL looks like.
//
// The limiter in guard.js is a per-instance dampener, NOT a hard cap — Vercel
// scales out and each instance counts separately. It raises the cost of a naive
// loop; it does not stop a distributed one. For a real ceiling put Vercel WAF or
// Cloudflare in front, or require a key and drop the anonymous demo.

import { ttsAvailable, ttsStatus, synth } from './_lib/tts.js';
import { limited } from './_lib/guard.js';

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

  // Metered before any paid provider is touched.
  if (limited(req, res, { bucket: 'tts', limit: Number(process.env.RATE_LIMIT_TTS || 60) })) return;

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
  // No default here: an absent speaker is resolved per-model inside synth(),
  // because "anushka" is a v2 name and would be rejected by v3.
  const speaker = typeof body.speaker === 'string' ? body.speaker : undefined;
  const gender = String(body.gender || 'female').toLowerCase() === 'male' ? 'male' : 'female';
  const voice = typeof body.voice === 'string' ? body.voice : undefined;
  const { pitch, pace, loudness } = body;   // optional modulation (clamped in synth)

  if (!ttsAvailable()) return res.status(503).json({ error: 'tts_unavailable' });

  const t0 = Date.now();
  try {
    const out = await synth({ text, lang, speaker, gender, voice, pitch, pace, loudness });
    const ms = Date.now() - t0;

    // TIME EVERY SUCCESS, BY SPEAKER. "Which voice is fastest" was unanswerable
    // because nothing recorded it: the only numbers anywhere were single samples
    // rendered on a phone, where cold start and signal swamp the difference
    // between two voices. One line per synth makes the question arithmetic.
    console.log(JSON.stringify({
      event: 'tts_ok',
      provider: out.provider,
      speaker: out.voice,
      gender: out.gender,
      chars: text.length,
      ms,
    }));

    // A silent fallback is the failure mode that costs the most time: the
    // caller gets a 200 and audio, so nothing looks wrong, and the only symptom
    // is that the voice sounds worse than it should. Log it at ERROR, because
    // serving the free fallback voice to real prospects IS an incident even
    // though the request succeeded.
    // `ms` is the SERVER's own time — network and decode excluded — which is the
    // only part that differs between one speaker and another.
    const { fellBackFrom, ...body } = { ...out, ms };
    if (fellBackFrom?.length) {
      console.error(JSON.stringify({
        event: 'tts_fell_back',
        served: out.provider,
        // Provider messages, never their payloads — an upstream error body can
        // echo a key fragment.
        failed: fellBackFrom.map((e) => String(e).slice(0, 120)),
        lang,
        severity: 'high',
        detail: `"${out.provider}" answered because earlier providers failed; the premium voice is NOT being used`,
      }));
    }
    return res.status(200).json(body);
  } catch (err) {
    // The reason goes to the log, never to the client — provider errors can
    // carry key fragments. But it MUST reach the log: a silent 503 here is what
    // turned "the premium voice is off" into a week of guessing.
    console.error(JSON.stringify({
      event: 'tts_failed',
      reason: String(err?.message || 'tts_error'),
      detail: err?.detail ? String(err.detail).slice(0, 500) : undefined,
    }));
    // "this voice cannot be served" and "no voice can be served" need different
    // words on screen. Collapsing them into one 503 is why a request that was
    // being REFUSED looked the same as the whole provider being down — and why
    // substituting silently ever seemed like the kinder option.
    if (err?.code === 'voice_unavailable') {
      // The speaker name is echoed back because it came from the caller and the
      // caller is the one who needs to know which name failed. JSON, not HTML,
      // and bounded.
      return res.status(503).json({
        error: 'voice_unavailable',
        voice: speaker ? String(speaker).slice(0, 40) : undefined,
      });
    }
    return res.status(503).json({ error: 'tts_unavailable' });
  }
}
