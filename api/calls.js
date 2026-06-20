// api/calls.js
//
// POST /api/calls — trigger an outbound call via the configured voice platform.
// Requires CALL_TRIGGER_SECRET.
// Was: /api/calls/outbound (now rewritten here via vercel.json).

import { triggerOutboundCall, voicePlatformConfigured } from './_lib/voice-platform.js';
import { normalizeIndianMsisdn } from './_lib/whatsapp.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  return bearer === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (blockedByRateLimit(req, res, { key: 'outbound', max: 20, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const phone = normalizeIndianMsisdn(body.phone || body.to);
  if (!phone) return res.status(400).json({ error: 'phone_required' });
  if (!voicePlatformConfigured()) return res.status(503).json({ error: 'voice_platform_not_configured' });

  const direction = ['inbound', 'commercial'].includes(body.direction) ? body.direction : 'outbound';
  const metadata = { name: body.name || '', notify: body.notify || '', direction, source: body.source || 'api' };

  try {
    const result = await triggerOutboundCall({ to: phone, direction, metadata });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('outbound_call_failed', String(e).slice(0, 200));
    return res.status(503).json({ error: 'call_failed', detail: String(e).slice(0, 100) });
  }
}
