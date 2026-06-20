// api/followup.js
//
// Consolidated follow-up endpoint.
//
// POST /api/followup?action=trigger  → send day-1/3/7 WhatsApp + enqueue remainder
// POST /api/followup?action=process  → process pending queue (called by n8n every 30m)
//
// Both require CALL_TRIGGER_SECRET.

import { sendWhatsAppText, whatsappConfigured, normalizeIndianMsisdn } from './_lib/whatsapp.js';
import { getFollowupMessage, buildSequenceQueue } from './_lib/followup-templates.js';
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
  if (blockedByRateLimit(req, res, { key: 'followup', max: 60, windowMs: 60000 })) return;

  const action = String(req.query && req.query.action || 'trigger');
  if (action === 'process') return handleProcess(req, res);
  return handleTrigger(req, res);
}

async function handleTrigger(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const phone = normalizeIndianMsisdn(body.phone);
  const name = String(body.name || 'there').trim();
  const day = parseInt(body.day, 10) || 1;
  const disposition = String(body.disposition || '').trim();
  const summary = String(body.summary || '').trim();
  const language = String(body.language || '').trim();
  if (!phone) return res.status(400).json({ error: 'phone_required' });

  let sent = false;
  if (whatsappConfigured()) {
    try { const msg = getFollowupMessage({ day, name, disposition, summary, language }); await sendWhatsAppText({ to: phone, body: msg }); sent = true; }
    catch (e) { console.error('followup_send_failed', String(e).slice(0, 160)); }
  }

  let queued = 0;
  if (body.enqueue_remaining !== false) {
    try { queued = await enqueueRemaining({ phone, name, language, disposition, summary, startDay: day }); }
    catch (e) { console.error('followup_enqueue_failed', String(e).slice(0, 160)); }
  }

  return res.status(200).json({ ok: true, sent, queued, message: sent ? `Day-${day} follow-up sent` : 'WhatsApp not configured' });
}

async function handleProcess(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: true, processed: 0, failed: 0, reason: 'supabase_not_configured' });
  }
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_FOLLOWUP_TABLE || 'followup_queue';

  let rows = [];
  try {
    const now = new Date().toISOString();
    const resp = await fetch(`${base}/rest/v1/${table}?status=eq.pending&send_at=lte.${encodeURIComponent(now)}&limit=50&select=*`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!resp.ok) throw new Error('fetch_' + resp.status);
    rows = await resp.json();
    if (!Array.isArray(rows)) rows = [];
  } catch (e) { console.error('followup_fetch_failed', String(e).slice(0, 160)); return res.status(503).json({ ok: false, error: 'fetch_failed' }); }

  let processed = 0, failed = 0;
  for (const row of rows) {
    let success = false;
    if (whatsappConfigured() && row.lead_phone) {
      try {
        const msg = getFollowupMessage({ day: row.sequence_day || 1, name: row.lead_name || 'there', disposition: row.disposition || '', summary: row.summary || '', language: row.language || '' });
        await sendWhatsAppText({ to: row.lead_phone, body: msg });
        success = true;
      } catch (e) { console.error('followup_row_failed_' + row.id, String(e).slice(0, 160)); }
    }
    try {
      await fetch(`${base}/rest/v1/${table}?id=eq.${row.id}`, { method: 'PATCH', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ status: success ? 'sent' : 'failed', sent_at: new Date().toISOString() }) });
    } catch { /* ignore */ }
    if (success) processed++; else failed++;
  }
  return res.status(200).json({ ok: true, processed, failed, total: rows.length });
}

async function enqueueRemaining({ phone, name, language, disposition, summary, startDay }) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return 0;
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_FOLLOWUP_TABLE || 'followup_queue';
  const remaining = buildSequenceQueue([1, 3, 7].filter((d) => d > startDay));
  if (!remaining.length) return 0;
  const rows = remaining.map(({ day, sendAt }) => ({ lead_phone: phone, lead_name: name, sequence_day: day, language, disposition, summary, send_at: sendAt.toISOString(), status: 'pending', client_id: process.env.TENANT_ID || 'modcon' }));
  const resp = await fetch(`${base}/rest/v1/${table}`, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  return resp.ok ? rows.length : 0;
}
