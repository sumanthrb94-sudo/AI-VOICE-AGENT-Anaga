// api/lead-capture.js
//
// PUBLIC lead-capture endpoint for the browser agent + website forms. Unlike
// /api/leads (server-to-server, secret-gated), this is meant to be called from an
// untrusted browser, so it is hardened instead of secret-gated:
//   • hard per-IP rate limit   • honeypot field   • requires name + a valid phone
//   • never leaks store internals (always 200 to the UX once input is valid)
//
// Writes to the configured lead store (Supabase / Google Sheet) via appendLead.

import { appendLead, leadStoreConfigured } from './_lib/leadstore.js';
import { normalizeIndianMsisdn } from './_lib/whatsapp.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  // Public endpoint — throttle hard to deter spam/abuse.
  if (blockedByRateLimit(req, res, { key: 'leadcap', max: 8, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (body.website || body.company_url) return res.status(200).json({ ok: true });

  const phone = normalizeIndianMsisdn(body.phone);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || !phone) return res.status(400).json({ error: 'name_phone_required' });

  // If no store is configured, don't break the visitor's experience.
  if (!leadStoreConfigured()) return res.status(200).json({ ok: true, stored: false });

  try {
    await appendLead({
      name,
      phone,
      language: body.language,
      callType: body.callType || body.direction || 'web',
      disposition: body.disposition,
      score: body.score,
      interested: body.interested,
      summary: body.summary,
      nextAction: body.nextAction,
      comment: body.comment,
      source: body.source || 'web-agent',
    });
    return res.status(200).json({ ok: true, stored: true });
  } catch (e) {
    console.error('lead_capture_failed', String(e).slice(0, 160));
    return res.status(200).json({ ok: true, stored: false }); // fail soft for the UX
  }
}
