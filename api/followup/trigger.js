// api/followup/trigger.js
//
// POST /api/followup/trigger
//
// Trigger a single WhatsApp follow-up message to a lead.
// Also enqueues the remaining sequence steps in Supabase (followup_queue table)
// for n8n or a cron to process on day 3 / day 7.
//
// Requires CALL_TRIGGER_SECRET (Bearer) for auth — server-to-server only.
// Called by: api/voice/webhook.js on end-of-call, n8n, or manually.
//
// Body:
//   { phone, name, day (1|3|7), disposition, summary, language, enqueue_remaining? }
//
// Response: { ok, sent, queued, message }

import { sendWhatsAppText, whatsappConfigured, normalizeIndianMsisdn } from '../_lib/whatsapp.js';
import { getFollowupMessage, buildSequenceQueue } from '../_lib/followup-templates.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '')
    .replace(/^Bearer\s+/i, '').trim();
  return bearer === secret;
}

async function enqueueRemaining({ phone, name, language, disposition, summary, startDay }) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return 0;
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_FOLLOWUP_TABLE || 'followup_queue';

  const allDays = [1, 3, 7];
  const remaining = buildSequenceQueue(allDays.filter((d) => d > startDay));
  if (remaining.length === 0) return 0;

  const rows = remaining.map(({ day, sendAt }) => ({
    lead_phone: phone,
    lead_name: name,
    sequence_day: day,
    language,
    disposition,
    summary,
    send_at: sendAt.toISOString(),
    status: 'pending',
    client_id: process.env.TENANT_ID || 'modcon',
  }));

  const resp = await fetch(`${base}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) return 0;
  return rows.length;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (blockedByRateLimit(req, res, { key: 'followup', max: 60, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const phone = normalizeIndianMsisdn(body.phone);
  const name = String(body.name || 'there').trim();
  const day = parseInt(body.day, 10) || 1;
  const disposition = String(body.disposition || '').trim();
  const summary = String(body.summary || '').trim();
  const language = String(body.language || '').trim();
  const enqueueRemaining = body.enqueue_remaining !== false;

  if (!phone) return res.status(400).json({ error: 'phone_required' });

  let sent = false;
  if (whatsappConfigured()) {
    try {
      const msg = getFollowupMessage({ day, name, disposition, summary, language });
      await sendWhatsAppText({ to: phone, body: msg });
      sent = true;
    } catch (e) {
      console.error('followup_send_failed', String(e).slice(0, 160));
    }
  }

  let queued = 0;
  if (enqueueRemaining) {
    try {
      queued = await enqueueRemaining({ phone, name, language, disposition, summary, startDay: day });
    } catch (e) {
      console.error('followup_enqueue_failed', String(e).slice(0, 160));
    }
  }

  return res.status(200).json({
    ok: true,
    sent,
    queued,
    message: sent ? `Day-${day} follow-up sent to ${phone}` : 'WhatsApp not configured — queued only',
  });
}
