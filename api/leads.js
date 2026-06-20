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
    // Production health/status report (public — for uptime monitors).  /api/health
    if (req.query && (req.query.health || req.query.status)) {
      return res.status(200).json(healthReport());
    }
    return res.status(200).json({ available: leadStoreConfigured(), store: leadStore(), fields: LEAD_FIELDS });
  }
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

  // Routing:
  //  • explicit ?capture=1  → public hardened capture (browser form / early gate)
  //  • valid CALL_TRIGGER_SECRET → server-to-server append (full field set)
  //  • anything else (unauthenticated POST) → public hardened capture
  // This means the browser capture works even if a rewrite drops the ?capture flag.
  const captureFlag = String(req.query && req.query.capture || '') === '1';
  if (captureFlag || !authorized(req)) return handlePublicCapture(req, res);

  // Secret-gated server-to-server append
  if (blockedByRateLimit(req, res, { key: 'leads', max: 60, windowMs: 60000 })) return;

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

// Production health/status — reports which integrations are configured (no secrets).
function healthReport() {
  const has = (k) => !!process.env[k];
  return {
    ok: true,
    service: 'anaga-modcon',
    tenant: process.env.TENANT_ID || 'modcon',
    time: new Date().toISOString(),
    integrations: {
      gemini: has('GEMINI_API_KEY'),
      leadStore: leadStoreConfigured(),
      store: leadStore(),
      supabase: has('SUPABASE_URL') && has('SUPABASE_SERVICE_KEY'),
      knowledgeBase: has('GEMINI_API_KEY') && has('SUPABASE_URL') && has('SUPABASE_SERVICE_KEY'),
      whatsapp: has('WHATSAPP_TOKEN') && has('WHATSAPP_PHONE_NUMBER_ID'),
      voicePlatform: process.env.VOICE_PLATFORM || 'bolna',
      voiceConfigured: has('BOLNA_API_KEY') || has('VAPI_API_KEY') || has('RETELL_API_KEY') || has('SAMVAAD_AGENT_ID'),
      calendar: has('GOOGLE_SERVICE_ACCOUNT_EMAIL') && has('GOOGLE_PRIVATE_KEY'),
      dashboard: has('DASHBOARD_PASSCODE'),
      followupQueue: has('SUPABASE_URL') && has('SUPABASE_SERVICE_KEY'),
      crmSync: has('CRM_WEBHOOK_URL'),
      salesAlerts: has('SALES_NOTIFY_WHATSAPP'),
      admin: has('ADMIN_API_KEY'),
    },
  };
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
