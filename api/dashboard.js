// api/dashboard.js
//
// GET /api/dashboard -> { ok, store, leads:[...] }  (recent leads, newest first)
//
// Lead data is customer PII, so this is PASSCODE-gated (DASHBOARD_PASSCODE) and
// disabled entirely if no passcode is configured (fail closed — never expose leads).
//   Auth: Authorization: Bearer <DASHBOARD_PASSCODE>  (or  x-dashboard-key: <…>)

import { listLeads, leadStore } from './_lib/leadstore.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

function authorized(req) {
  const pass = process.env.DASHBOARD_PASSCODE;
  if (!pass) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-dashboard-key']) || '').trim();
  return bearer === pass || alt === pass;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'dash', max: 30, windowMs: 60000 })) return;
  if (!process.env.DASHBOARD_PASSCODE) return res.status(503).json({ error: 'dashboard_disabled' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const r = await listLeads({ limit: 200 });
    return res.status(200).json({ ok: true, store: leadStore(), leads: r.leads || [] });
  } catch (e) {
    console.error('dashboard_failed', String(e).slice(0, 160));
    return res.status(503).json({ error: 'dashboard_unavailable' });
  }
}
