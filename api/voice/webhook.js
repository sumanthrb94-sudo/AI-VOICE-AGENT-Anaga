// api/voice/webhook.js
//
// Server webhook for the managed voice platform (Vapi / Retell). The platform
// POSTs call-lifecycle events here; we act on the END-OF-CALL report — pull
// Anaga's outcome / summary and send a WhatsApp follow-up to whoever requested
// the call (carried in metadata.notify). Authenticated with an optional shared
// secret header that the platform echoes back.
//
// Fail soft: ALWAYS answer 200 so the platform doesn't retry endlessly; on any
// problem we log server-side and move on.

import { sendWhatsAppText, whatsappConfigured, readRawBody } from '../_lib/whatsapp.js';
import { appendLead, leadStoreConfigured } from '../_lib/leadstore.js';

function authorized(req) {
  const secret = process.env.VOICE_WEBHOOK_SECRET;
  if (!secret) return true; // optional in dev — set it in production
  const got = String(
    (req.headers && (req.headers['x-vapi-secret'] || req.headers['x-webhook-secret'])) || ''
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
    if (ev.type === 'end-of-call' && ev.notify && whatsappConfigured()) {
      const lines = [`✅ Call ${ev.outcome ? '(' + ev.outcome + ')' : 'ended'}${ev.to ? ' · ' + ev.to : ''}`];
      if (ev.summary) lines.push('', ev.summary);
      if (ev.nextAction) lines.push('', 'Next: ' + ev.nextAction);
      await sendWhatsAppText({ to: ev.notify, body: lines.join('\n') }).catch(() => {});
    }
    // Auto-log every finished call as a row (Google Sheet / Supabase) — fail soft.
    if (ev.type === 'end-of-call' && leadStoreConfigured()) {
      appendLead({
        name: ev.name, phone: ev.to, language: ev.language, callType: ev.direction || 'outbound',
        disposition: ev.outcome, score: ev.score, interested: ev.interested,
        summary: ev.summary, nextAction: ev.nextAction, comment: ev.comment,
        bookingDay: ev.bookingDay, callId: ev.callId, source: ev.source || 'phone', recording: ev.recording,
      }).catch((e) => console.error('lead_log_failed', String(e).slice(0, 160)));
    }
  } catch (e) {
    console.error('voice_webhook_failed', String(e).slice(0, 200));
  }
  return res.status(200).json({ ok: true });
}

// Map Vapi / Retell payloads onto a small common shape we can act on.
function normalizeEvent(body) {
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
