// api/whatsapp/webhook.js
//
// WhatsApp Cloud API webhook — the "send a number, get a call in a second" entry.
//   GET  -> Meta verification handshake (echo hub.challenge).
//   POST -> inbound message: parse a phone number, fire an outbound Anaga call,
//           and reply on WhatsApp. Authenticated via X-Hub-Signature-256.
//
// We always answer 200 quickly to Meta (so it doesn't retry or disable the
// webhook); any problem is reported back to the SENDER as a WhatsApp message,
// not as an HTTP error. The single platform API call is sub-second, so the lead
// is dialed in roughly the time it takes the message to arrive.

import {
  readRawBody, verifyMetaSignature, handleVerification, parseInboundMessage,
  extractPhoneNumber, sendWhatsAppText, whatsappConfigured,
} from '../_lib/whatsapp.js';
import { triggerOutboundCall, voicePlatformConfigured } from '../_lib/voice-platform.js';

export default async function handler(req, res) {
  // 1) Verification handshake (Meta calls this once when you save the callback URL).
  if (req.method === 'GET') {
    const v = handleVerification(req);
    if (v.ok) return res.status(200).send(v.challenge);
    return res.status(403).json({ error: 'verification_failed' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 2) Read the RAW body and verify Meta's signature before trusting anything.
  const raw = await readRawBody(req);
  const sig = verifyMetaSignature(req, raw);
  if (!sig.ok) return res.status(401).json({ error: 'bad_signature' });

  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(200).json({ ok: true }); } // malformed — ack and stop

  const msg = parseInboundMessage(body);
  // Non-message events (delivery/read status callbacks) — ack and stop.
  if (!msg || !msg.from) return res.status(200).json({ ok: true });

  try {
    const number = extractPhoneNumber(msg.text);
    if (!number) {
      await safeReply(msg.from,
        'Send me a phone number to call (e.g. +91 95348 69999) and Anaga will ring them right away.');
      return res.status(200).json({ ok: true });
    }
    if (!voicePlatformConfigured()) {
      await safeReply(msg.from,
        'Calling is not switched on yet — the voice line still needs to be connected. Please try again shortly.');
      return res.status(200).json({ ok: true });
    }
    await triggerOutboundCall({
      to: number,
      metadata: { source: 'whatsapp', notify: msg.from, name: msg.name || '' },
    });
    await safeReply(msg.from,
      `📞 Calling ${number} now — Anaga will qualify the lead in Telugu and update you here.`);
  } catch (e) {
    console.error('whatsapp_trigger_failed', String(e).slice(0, 200));
    await safeReply(msg.from, 'Sorry — I could not place that call just now. Please try again in a moment.');
  }
  return res.status(200).json({ ok: true });
}

async function safeReply(to, text) {
  if (!whatsappConfigured()) return;
  try { await sendWhatsAppText({ to, body: text }); }
  catch (e) { console.error('whatsapp_reply_failed', String(e).slice(0, 120)); }
}
