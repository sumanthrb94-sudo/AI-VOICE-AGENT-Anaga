// api/booking/create.js
//
// POST /api/booking/create
// Book a site-visit slot. Creates a Google Calendar event and logs the booking
// to the lead store. Sends a WhatsApp confirmation if configured.
//
// Body: { name, phone, slot (ISO), language?, direction?, notes? }
// Response: { ok:true, eventId?, label, message }

import { createBooking, calendarConfigured } from '../_lib/calendar.js';
import { appendLead } from '../_lib/leadstore.js';
import { sendWhatsAppText, whatsappConfigured } from '../_lib/whatsapp.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';
import { normalizeIndianMsisdn } from '../_lib/whatsapp.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'booking', max: 10, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  const name = String(body.name || '').trim();
  const phone = normalizeIndianMsisdn(body.phone);
  const slot = String(body.slot || '').trim();
  const language = String(body.language || '').trim();
  const direction = String(body.direction || 'outbound').trim();
  const notes = String(body.notes || '').trim();

  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!phone) return res.status(400).json({ error: 'phone_required' });
  if (!slot || isNaN(Date.parse(slot))) return res.status(400).json({ error: 'slot_required' });

  // Format a human-readable label in IST
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const slotDate = new Date(Date.parse(slot) + IST_OFFSET_MS);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h = slotDate.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const label = `${dayNames[slotDate.getUTCDay()]} ${slotDate.getUTCDate()} ${monthNames[slotDate.getUTCMonth()]} · ${h % 12 || 12}:00 ${ampm} IST`;

  let eventId = '';
  let htmlLink = '';

  // Create Google Calendar event (fail soft — booking still proceeds without it)
  if (calendarConfigured()) {
    try {
      const r = await createBooking({ name, phone, slot, language, notes });
      eventId = r.eventId;
      htmlLink = r.htmlLink;
    } catch (e) {
      console.error('calendar_create_failed', String(e).slice(0, 160));
    }
  }

  // Log the booking as a lead row
  try {
    await appendLead({
      name, phone, language,
      callType: direction,
      disposition: 'booked',
      score: 80,
      interested: true,
      summary: `Site visit booked for ${label}.${notes ? ' Notes: ' + notes : ''}`,
      nextAction: `Confirm site visit on ${label}`,
      bookingDay: label,
      callId: eventId,
      source: 'web-booking',
    });
  } catch (e) {
    console.error('booking_lead_log_failed', String(e).slice(0, 160));
  }

  // WhatsApp confirmation to the lead
  if (whatsappConfigured() && phone) {
    const msg = [
      `✅ Your site visit at *Modcon SYL Residences* is confirmed!`,
      `📅 *${label}*`,
      `📍 Thukkuguda (near ORR Exit-14, Shamshabad)`,
      ``,
      `We look forward to seeing you, ${name}!`,
      `For directions or queries: +91 95348 69999`,
    ].join('\n');
    sendWhatsAppText({ to: phone, body: msg }).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    eventId,
    htmlLink,
    label,
    message: `Site visit booked for ${label}`,
  });
}
