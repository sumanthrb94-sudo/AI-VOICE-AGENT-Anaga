// api/calls/outbound.js
//
// POST /api/calls/outbound — trigger an outbound Anaga call to a phone number.
// This is the programmatic entry point: a dashboard, curl, Zapier, OR the WhatsApp
// webhook all funnel through the same voice-platform adapter. Dialing PSTN costs
// real money, so this endpoint REQUIRES a shared secret and is rate-limited.
//
//   Auth:  Authorization: Bearer <CALL_TRIGGER_SECRET>   (or  x-trigger-secret: <…>)
//   Body:  { "to": "+9195…", "name"?: string, "notify"?: "<wa_id to update on WhatsApp>" }
//   200 -> { ok:true, id }   | 401 unauthorized | 400 bad input | 503 unavailable
//
// Fail soft + leak nothing: provider details never reach the caller.

import { triggerOutboundCall, voicePlatformConfigured } from '../_lib/voice-platform.js';
import { normalizeIndianMsisdn } from '../_lib/whatsapp.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false; // fail closed — must be configured before we dial
  const bearer = String((req.headers && req.headers['authorization']) || '')
    .replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-trigger-secret']) || '').trim();
  return bearer === secret || alt === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'outbound', max: 20, windowMs: 60000 })) return;
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!voicePlatformConfigured()) return res.status(503).json({ error: 'voice_unavailable' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }

  const to = normalizeIndianMsisdn(body.to);
  if (!to) return res.status(400).json({ error: 'invalid_to' });

  try {
    const r = await triggerOutboundCall({
      to,
      metadata: { source: 'api', name: String(body.name || ''), notify: String(body.notify || '') },
    });
    return res.status(200).json({ ok: true, id: r.id });
  } catch (e) {
    console.error('outbound_call_failed', String(e).slice(0, 200));
    return res.status(503).json({ error: 'voice_unavailable' });
  }
}
