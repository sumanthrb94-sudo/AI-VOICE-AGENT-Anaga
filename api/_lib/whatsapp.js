// api/_lib/whatsapp.js
//
// WhatsApp adapter for the lead-intake trigger ("send Anaga a number, she calls
// it"). Default provider is the OFFICIAL Meta WhatsApp Cloud API — free to start,
// no BSP/middleman needed — and it is swappable later to a BSP (AiSensy / Gupshup)
// behind the SAME two functions. This module does exactly three things:
//   1. VERIFY + parse an INBOUND WhatsApp message (an operator sends a lead's number).
//   2. Answer Meta's GET verification handshake.
//   3. SEND a WhatsApp text back ("calling now…" / call-outcome updates).
//
// Security: the access token + app secret live ONLY in server env and are never
// logged or returned. Inbound webhooks are authenticated with Meta's
// X-Hub-Signature-256 (HMAC-SHA256 over the RAW body using the App Secret).
//
// No npm deps: global fetch (Node 18+) + node:crypto.

import crypto from 'node:crypto';

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

export function whatsappConfigured() {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

// Read the request body as a string WITHOUT trusting a framework body-parser, so
// the Meta signature can be checked over the exact bytes Meta signed. We read the
// stream FIRST (before anything touches req.body) to keep the raw bytes intact.
export async function readRawBody(req) {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  } catch (_) { /* stream already consumed — fall through */ }
  // Fallbacks if a parser beat us to the stream.
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

// Verify Meta's X-Hub-Signature-256. Returns { ok, enforced }. When no app secret
// is configured we return ok:true with enforced:false (dev mode) — PRODUCTION MUST
// set WHATSAPP_APP_SECRET so spoofed webhooks can't trigger paid calls.
export function verifyMetaSignature(req, rawBody) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return { ok: true, enforced: false };
  const header = String((req.headers && req.headers['x-hub-signature-256']) || '');
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, enforced: true };
}

// GET webhook verification handshake (Meta calls this once when you save the URL).
export function handleVerification(req) {
  const q = req.query || {};
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return { ok: true, challenge: String(challenge == null ? '' : challenge) };
  }
  return { ok: false, challenge: '' };
}

// Pull the first inbound text message out of a Cloud API webhook payload.
// Returns null for non-message events (delivery/read status callbacks, etc.).
export function parseInboundMessage(body) {
  try {
    const value = body && body.entry && body.entry[0] &&
      body.entry[0].changes && body.entry[0].changes[0] &&
      body.entry[0].changes[0].value;
    const msg = value && value.messages && value.messages[0];
    if (!msg) return null; // status callback, not a message
    const from = msg.from; // sender wa_id (E.164 digits, no '+')
    const name = (value.contacts && value.contacts[0] &&
      value.contacts[0].profile && value.contacts[0].profile.name) || '';
    let text = '';
    if (msg.type === 'text') text = (msg.text && msg.text.body) || '';
    else if (msg.type === 'button') text = (msg.button && msg.button.text) || '';
    else if (msg.type === 'interactive') {
      const i = msg.interactive || {};
      text = (i.list_reply && i.list_reply.title) || (i.button_reply && i.button_reply.title) || '';
    }
    return { from, name, text, type: msg.type, id: msg.id };
  } catch (_) {
    return null;
  }
}

// Extract a dialable E.164 Indian number from free text. Accepts "+91 95…",
// "095…", "95…", with spaces / dashes / a name alongside it. Returns null if none.
export function extractPhoneNumber(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  // Whole string with separators stripped (handles "Ravi 9534869999").
  candidates.push(text.replace(/[^\d+]/g, ''));
  // Each whitespace-separated token (handles "+91 9534869999" split oddly).
  for (const t of text.replace(/[^\d+]/g, ' ').split(/\s+/)) if (t) candidates.push(t);
  for (const c of candidates) {
    const n = normalizeIndianMsisdn(c);
    if (n) return n;
  }
  return null;
}

// Normalize a raw string to an E.164 Indian mobile number, or null if implausible.
export function normalizeIndianMsisdn(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (/^\d{11,13}$/.test(digits)) return '+' + digits; // already international
    return null;
  }
  if (/^[6-9]\d{9}$/.test(s)) return '+91' + s;                 // 10-digit mobile
  if (/^0[6-9]\d{9}$/.test(s)) return '+91' + s.slice(1);       // leading 0
  if (/^91[6-9]\d{9}$/.test(s)) return '+' + s;                 // 91 + 10
  if (/^091[6-9]\d{9}$/.test(s)) return '+' + s.slice(1);       // 091 + 10
  return null;
}

// Send a WhatsApp text. Free-form text is allowed within the 24-hour customer
// service window (i.e. replying to a message the user just sent — exactly our
// flow). Outside that window Meta requires a pre-approved template. Returns
// { ok, id } or throws on misconfig / upstream error.
export async function sendWhatsAppText({ to, body }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('whatsapp_not_configured');

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to).replace(/^\+/, ''),
    type: 'text',
    text: { preview_url: false, body: String(body).slice(0, 4096) },
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }

  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 200); } catch (_) {}
    throw new Error(`whatsapp_send_failed_${resp.status}${d ? ': ' + d : ''}`);
  }
  const data = await resp.json().catch(() => ({}));
  return { ok: true, id: (data && data.messages && data.messages[0] && data.messages[0].id) || '' };
}
