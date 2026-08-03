// api/translate.js
//
// GET  /api/translate  -> { available, mode, provider } (capability probe; never errors)
// POST /api/translate  -> { text, from, provider }
//
// Lets Anaga answer in the prospect's language when the brain replied in
// English. Fail soft by design: on any failure the ORIGINAL text comes back with
// provider "none", so a translation outage means she speaks English, never that
// she goes silent.
//
// The AI disclosure is NOT translated here — see the header of _lib/translate.js.
// Its per-language wording is versioned data in the persona file.

import { translate, translateMode, toTranslateCode } from './_lib/translate.js';
import { googleAuthMode } from './_lib/google.js';
import { limited } from './_lib/guard.js';

const MAX_TEXT = 2000;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      available: true,             // the free endpoint needs no credential
      mode: translateMode(),       // auto | cloud | free
      auth: googleAuthMode(),      // api_key | service_account | none
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (limited(req, res, { bucket: 'translate', limit: Number(process.env.RATE_LIMIT_TRANSLATE || 120) })) return;

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
  if (text.length > MAX_TEXT) return res.status(400).json({ error: 'text_too_long', max: MAX_TEXT });

  const to = toTranslateCode(body.to);
  if (!to || to === 'auto') return res.status(400).json({ error: 'target_language_required' });

  const out = await translate({ text, to, from: body.from || 'auto' });
  return res.status(200).json(out);
}
