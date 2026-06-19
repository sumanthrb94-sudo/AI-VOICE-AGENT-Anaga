// api/leads.js
//
// GET  /api/leads  -> { available, store, fields }   (capability probe)
// POST /api/leads  -> append one lead/call row to the store (Google Sheet / Supabase)
//
// Used by /api/voice/webhook (auto-log on hang-up) and by external tools (n8n,
// a dashboard) to drop a structured row. Shared-secret guarded + rate-limited.
// Fail soft: storage errors -> 503 (never leak provider details).

import { appendLead, leadStoreConfigured, leadStore, LEAD_FIELDS } from './_lib/leadstore.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false; // fail closed
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-trigger-secret']) || '').trim();
  return bearer === secret || alt === secret;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ available: leadStoreConfigured(), store: leadStore(), fields: LEAD_FIELDS });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'leads', max: 60, windowMs: 60000 })) return;
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });
  if (!leadStoreConfigured()) return res.status(503).json({ error: 'leadstore_unavailable' });

  try {
    const r = await appendLead(body);
    return res.status(200).json({ ok: r.ok !== false, store: leadStore() });
  } catch (e) {
    console.error('lead_log_failed', String(e).slice(0, 200));
    return res.status(503).json({ error: 'lead_log_failed' });
  }
}
