// api/admin/clients.js
//
// GET  /api/admin/clients            → list all registered builder-clients (tenants)
// POST /api/admin/clients            → register a new builder-client
//
// Auth: ADMIN_API_KEY (separate from DASHBOARD_PASSCODE).
// This is the B2B onboarding endpoint — Anaga's multi-tenant control plane.
//
// POST body:
//   {
//     id: "builder2",                // unique slug
//     name: "Example Builders",
//     gemini_api_key: "...",         // client brings their own Gemini key
//     voice_platform: "bolna",
//     bolna_api_key: "...",
//     bolna_agent_id: "...",
//     whatsapp_phone_number_id: "...",
//     whatsapp_token: "...",
//     google_calendar_id: "...",
//     supabase_leads_table: "leads_builder2",
//     persona: { ... },              // optional — defaults to Anaga template
//     projects: [ ... ],             // their project data for the AI
//     contact: { phone: "...", email: "...", website: "..." },
//   }

import { registerTenant, listTenants } from '../_lib/tenant.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.ADMIN_API_KEY;
  if (!secret) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '')
    .replace(/^Bearer\s+/i, '').trim();
  return bearer === secret;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'admin', max: 20, windowMs: 60000 })) return;
  if (!process.env.ADMIN_API_KEY) return res.status(503).json({ error: 'admin_disabled' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    try {
      const clients = await listTenants();
      return res.status(200).json({ ok: true, clients });
    } catch (e) {
      console.error('admin_list_failed', String(e).slice(0, 160));
      return res.status(503).json({ ok: false, error: 'list_failed' });
    }
  }

  // POST — register new client
  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const id = String(body.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const name = String(body.name || '').trim().slice(0, 120);
  if (!id) return res.status(400).json({ error: 'id_required' });
  if (!name) return res.status(400).json({ error: 'name_required' });

  try {
    const result = await registerTenant({ id, name, ...body });
    return res.status(201).json({ ok: true, id, message: `Client "${name}" registered.` });
  } catch (e) {
    console.error('admin_register_failed', String(e).slice(0, 160));
    if (String(e).includes('23505')) {
      return res.status(409).json({ error: 'client_already_exists' });
    }
    return res.status(503).json({ ok: false, error: 'register_failed' });
  }
}
