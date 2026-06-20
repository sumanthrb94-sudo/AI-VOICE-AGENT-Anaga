// api/leads.js
//
// Consolidated lead endpoint — probe, secret-gated append, and public capture.
//
// GET  /api/leads              → { available, store, fields }  (probe — no auth)
// POST /api/leads              → append one row (CALL_TRIGGER_SECRET required)
// POST /api/leads?capture=1   → public lead capture from browser (was /api/lead-capture)
//
// The public capture path (?capture=1) is hardened: honeypot, rate limit,
// requires name + phone, never leaks store details. Fail soft for the UX.

import { appendLead, leadStoreConfigured, leadStore, LEAD_FIELDS } from './_lib/leadstore.js';
import { normalizeIndianMsisdn } from './_lib/whatsapp.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-trigger-secret']) || '').trim();
  return bearer === secret || alt === secret;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ available: leadStoreConfigured(), store: leadStore(), fields: LEAD_FIELDS });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

  // Public capture path (browser form / early gate save)
  const isCapture = String(req.query && req.query.capture || '') === '1';
  if (isCapture) return handlePublicCapture(req, res);

  // Secret-gated server-to-server append
  if (blockedByRateLimit(req, res, { key: 'leads', max: 60, windowMs: 60000 })) return;
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });
  if (!leadStoreConfigured()) return res.status(503).json({ error: 'leadstore_unavailable' });

  try {
    const r = await appendLead(body);
    return res.status(200).json({ ok: r.ok !== false, store: leadStore() });
  } catch (e) {
    console.error('lead_log_failed', String(e).slice(0, 200));
    return res.status(503).json({ error: 'lead_log_failed' });
  }
}

async function handlePublicCapture(req, res) {
  if (blockedByRateLimit(req, res, { key: 'leadcap', max: 8, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  // Honeypot
  if (body.website || body.company_url) return res.status(200).json({ ok: true });

  const phone = normalizeIndianMsisdn(body.phone);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || !phone) return res.status(400).json({ error: 'name_phone_required' });
  if (!leadStoreConfigured()) return res.status(200).json({ ok: true, stored: false });

  try {
    await appendLead({
      name, phone,
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
    return res.status(200).json({ ok: true, stored: false });
  }
}
