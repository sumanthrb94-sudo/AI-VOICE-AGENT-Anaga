// api/followup/process.js
//
// POST /api/followup/process  (server-to-server, CALL_TRIGGER_SECRET)
//
// Process pending follow-up queue items from Supabase. Picks up rows where
// status='pending' AND send_at <= now(), sends the WhatsApp message, marks as sent.
//
// Designed to be called by n8n on a schedule (every 30 min).
// Returns { ok, processed, failed }.

import { sendWhatsAppText, whatsappConfigured } from '../_lib/whatsapp.js';
import { getFollowupMessage } from '../_lib/followup-templates.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

function authorized(req) {
  const secret = process.env.CALL_TRIGGER_SECRET;
  if (!secret) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '')
    .replace(/^Bearer\s+/i, '').trim();
  return bearer === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (blockedByRateLimit(req, res, { key: 'followup_proc', max: 10, windowMs: 60000 })) return;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: true, processed: 0, failed: 0, reason: 'supabase_not_configured' });
  }

  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_FOLLOWUP_TABLE || 'followup_queue';

  // Fetch pending rows due for sending
  let rows = [];
  try {
    const now = new Date().toISOString();
    const resp = await fetch(
      `${base}/rest/v1/${table}?status=eq.pending&send_at=lte.${encodeURIComponent(now)}&limit=50&select=*`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }
    );
    if (!resp.ok) throw new Error('fetch_pending_' + resp.status);
    rows = await resp.json();
    if (!Array.isArray(rows)) rows = [];
  } catch (e) {
    console.error('followup_fetch_failed', String(e).slice(0, 160));
    return res.status(503).json({ ok: false, error: 'fetch_failed' });
  }

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    const phone = row.lead_phone;
    const name = row.lead_name || 'there';
    const day = row.sequence_day || 1;
    const language = row.language || '';
    const disposition = row.disposition || '';
    const summary = row.summary || '';
    const rowId = row.id;

    let success = false;
    if (whatsappConfigured() && phone) {
      try {
        const msg = getFollowupMessage({ day, name, disposition, summary, language });
        await sendWhatsAppText({ to: phone, body: msg });
        success = true;
      } catch (e) {
        console.error('followup_send_failed_row_' + rowId, String(e).slice(0, 160));
      }
    }

    // Mark row as sent or failed
    try {
      const newStatus = success ? 'sent' : 'failed';
      await fetch(`${base}/rest/v1/${table}?id=eq.${rowId}`, {
        method: 'PATCH',
        headers: {
          apikey: key, Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: newStatus, sent_at: new Date().toISOString() }),
      });
    } catch { /* ignore update failures */ }

    if (success) processed++; else failed++;
  }

  return res.status(200).json({ ok: true, processed, failed, total: rows.length });
}
