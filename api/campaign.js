// api/campaign.js
//
// POST /api/campaign — fire a BATCH of outbound Anaga calls in parallel, capped
// at a concurrency limit so we never exceed your platform / Exotel channels.
//
//   Auth:  Authorization: Bearer <CALL_TRIGGER_SECRET>
//   Body:  { "numbers": ["+9195…", {"to":"+9195…","name":"Ravi"} ...],
//            "concurrency"?: 5, "direction"?: "outbound"|"commercial", "notify"?: "<wa_id>" }
//   200 -> { requested, triggered, failed, results:[{to,ok,id?}] }
//
// Each call is just a quick API trigger; the platform then runs them concurrently
// up to YOUR channel capacity. For very large / time-paced campaigns, loop this
// (or /api/calls/outbound) from n8n with delays — serverless functions are short-lived.

import { triggerOutboundCall, voicePlatformConfigured } from './_lib/voice-platform.js';
import { normalizeIndianMsisdn } from './_lib/whatsapp.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

const MAX_BATCH = 100;
const MAX_CONCURRENCY = 20;

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-trigger-secret']) || '').trim();
  return bearer === secret || alt === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'campaign', max: 6, windowMs: 60000 })) return;
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!voicePlatformConfigured()) return res.status(503).json({ error: 'voice_unavailable' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object' || !Array.isArray(body.numbers)) {
    return res.status(400).json({ error: 'numbers_required' });
  }

  const direction = (body.direction === 'commercial' || body.direction === 'inbound') ? body.direction : 'outbound';
  const notify = String(body.notify || '');
  let concurrency = parseInt(body.concurrency, 10);
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = 5;
  concurrency = Math.min(concurrency, MAX_CONCURRENCY);

  // normalize + dedupe + cap
  const seen = new Set();
  const list = [];
  for (const item of body.numbers) {
    const raw = typeof item === 'string' ? item : (item && item.to);
    const name = (item && typeof item === 'object' && item.name) ? String(item.name) : '';
    const to = normalizeIndianMsisdn(raw);
    if (to && !seen.has(to)) { seen.add(to); list.push({ to, name }); if (list.length >= MAX_BATCH) break; }
  }
  if (!list.length) return res.status(400).json({ error: 'no_valid_numbers' });

  const results = new Array(list.length);
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      const { to, name } = list[i];
      try {
        const r = await triggerOutboundCall({ to, metadata: { source: 'campaign', direction, notify, name } });
        results[i] = { to, ok: true, id: r.id || '' };
      } catch (e) {
        console.error('campaign_call_failed', to, String(e).slice(0, 120));
        results[i] = { to, ok: false };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));

  const triggered = results.filter((r) => r && r.ok).length;
  return res.status(200).json({
    requested: list.length,
    triggered,
    failed: list.length - triggered,
    results,
  });
}
