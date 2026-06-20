// api/voice/webhook.js
//
// Server webhook for managed voice platforms (Bolna / Vapi / Retell / Samvaad).
// The platform POSTs call-lifecycle events here on end-of-call.
// We: (1) log the lead row, (2) send a WhatsApp follow-up, (3) trigger the
//     day-1 nurture sequence, (4) notify the sales team if the lead is hot.
//
// Fail soft: always answer 200. The platform must not retry on business logic.

import { sendWhatsAppText, whatsappConfigured, readRawBody } from '../_lib/whatsapp.js';
import { appendLead, leadStoreConfigured } from '../_lib/leadstore.js';
import { getFollowupMessage } from '../_lib/followup-templates.js';

const HOT_SCORE_THRESHOLD = 70;
const WARM_SCORE_THRESHOLD = 40;

function authorized(req) {
  const secret = process.env.VOICE_WEBHOOK_SECRET;
  if (!secret) return true; // optional in dev
  const got = String(
    (req.headers && (req.headers['x-bolna-secret'] || req.headers['x-vapi-secret'] || req.headers['x-webhook-secret'])) || ''
  );
  return got === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const raw = await readRawBody(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(200).json({ ok: true }); }

  try {
    const ev = normalizeEvent(body);

    if (ev.type !== 'end-of-call') {
      return res.status(200).json({ ok: true, skipped: ev.type });
    }

    const score = Number(ev.score) || 0;
    const tier = score >= HOT_SCORE_THRESHOLD ? 'hot'
               : score >= WARM_SCORE_THRESHOLD ? 'warm' : 'cold';

    // 1. Log lead row
    if (leadStoreConfigured()) {
      appendLead({
        name: ev.name, phone: ev.to, language: ev.language,
        callType: ev.direction || 'outbound',
        disposition: ev.outcome, score: ev.score,
        interested: ev.interested,
        summary: ev.summary, nextAction: ev.nextAction,
        comment: ev.comment, bookingDay: ev.bookingDay,
        callId: ev.callId, source: ev.source || 'phone',
        recording: ev.recording,
      }).catch((e) => console.error('lead_log_failed', String(e).slice(0, 160)));
    }

    // 2. WhatsApp recap to notify contact (if metadata.notify is set)
    if (ev.notify && whatsappConfigured()) {
      const lines = [
        `📞 *Call ended* — ${ev.name || ev.to}`,
        ev.outcome ? `Result: *${ev.outcome}* (${tier})` : '',
        ev.summary || '',
        ev.nextAction ? `Next: ${ev.nextAction}` : '',
      ].filter(Boolean);
      sendWhatsAppText({ to: ev.notify, body: lines.join('\n') }).catch(() => {});
    }

    // 3. Send day-1 follow-up to the lead (opt-outs skip this)
    if (ev.to && whatsappConfigured() && ev.outcome !== 'opt-out') {
      try {
        const followupMsg = getFollowupMessage({
          day: 1,
          name: ev.name || 'there',
          disposition: ev.outcome,
          summary: ev.summary,
          language: ev.language,
        });
        await sendWhatsAppText({ to: ev.to, body: followupMsg });
      } catch (e) {
        console.error('followup_send_failed', String(e).slice(0, 160));
      }
    }

    // 4. Enqueue day 3 + day 7 follow-ups in Supabase (for n8n/cron to process)
    if (ev.to && ev.outcome !== 'opt-out' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      enqueueFollowups({
        phone: ev.to, name: ev.name, language: ev.language,
        disposition: ev.outcome, summary: ev.summary,
      }).catch((e) => console.error('followup_queue_failed', String(e).slice(0, 160)));
    }

    // 5. Hot-lead alert to sales team
    if (tier === 'hot' && process.env.SALES_NOTIFY_WHATSAPP && whatsappConfigured()) {
      const alert = [
        `🔥 *HOT LEAD* — ${ev.name || ev.to}`,
        `Score: ${ev.score}/100 · ${ev.disposition || ev.outcome}`,
        ev.summary || '',
        `Next: ${ev.nextAction || 'Follow up immediately'}`,
        `Phone: ${ev.to}`,
      ].filter(Boolean).join('\n');
      sendWhatsAppText({ to: process.env.SALES_NOTIFY_WHATSAPP, body: alert }).catch(() => {});
    }

  } catch (e) {
    console.error('voice_webhook_failed', String(e).slice(0, 200));
  }

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Normalize payloads from Bolna, Vapi, Retell, and Samvaad into one shape.
// ---------------------------------------------------------------------------
function normalizeEvent(body) {
  // Bolna payload shape (end-of-call)
  if (body && (body.event === 'call_completed' || body.event === 'call_ended')) {
    return normalizeBolna(body);
  }
  // Vapi / Retell / generic
  return normalizeVapiRetell(body);
}

function normalizeBolna(body) {
  const meta = body.metadata || {};
  const analysis = body.call_analysis || {};
  return {
    type: 'end-of-call',
    notify: meta.notify || '',
    name: meta.name || body.recipient_name || '',
    direction: meta.direction || 'outbound',
    source: meta.source || 'bolna',
    language: analysis.language || meta.language || '',
    to: body.recipient_phone_number || body.to_number || '',
    outcome: body.disconnection_reason || analysis.disposition || 'ended',
    score: analysis.score != null ? analysis.score : '',
    interested: analysis.interested,
    comment: analysis.comment || '',
    bookingDay: analysis.bookingDay || analysis.booking_day || '',
    callId: body.call_id || '',
    recording: body.recording_url || '',
    summary: analysis.summary || body.transcript_summary || '',
    nextAction: analysis.nextAction || analysis.next_action || '',
  };
}

function normalizeVapiRetell(body) {
  const m = (body && body.message) || body || {};
  const type = String(m.type || body.event || '');
  const isEnd = /end.?of.?call/i.test(type) || type === 'call_ended' || type === 'call_analyzed';
  const call = m.call || body.call || {};
  const metadata = call.metadata || m.metadata || body.metadata || {};
  const analysis = m.analysis || {};
  const structured = analysis.structuredData || {};
  return {
    type: isEnd ? 'end-of-call' : type,
    notify: metadata.notify || '',
    name: metadata.name || '',
    direction: metadata.direction || '',
    source: metadata.source || '',
    language: structured.language || '',
    to: (call.customer && call.customer.number) || body.to_number || '',
    outcome: m.endedReason || analysis.successEvaluation || structured.disposition ||
      body.disconnection_reason || '',
    score: structured.score != null ? structured.score : '',
    interested: structured.interested,
    comment: structured.comment || '',
    bookingDay: structured.bookingDay || structured.day || '',
    callId: (call && call.id) || m.callId || body.call_id || '',
    recording: m.recordingUrl || (call && call.recordingUrl) || body.recording_url || '',
    summary: m.summary || analysis.summary ||
      (body.call_analysis && body.call_analysis.call_summary) || '',
    nextAction: structured.nextAction || '',
  };
}

async function enqueueFollowups({ phone, name, language, disposition, summary }) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_FOLLOWUP_TABLE || 'followup_queue';
  const now = Date.now();
  const rows = [
    { day: 3, sendAt: new Date(now + 3 * 86400000).toISOString() },
    { day: 7, sendAt: new Date(now + 7 * 86400000).toISOString() },
  ].map(({ day, sendAt }) => ({
    lead_phone: phone, lead_name: name, sequence_day: day,
    language, disposition, summary, send_at: sendAt,
    status: 'pending', client_id: process.env.TENANT_ID || 'modcon',
  }));
  await fetch(`${base}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
}
