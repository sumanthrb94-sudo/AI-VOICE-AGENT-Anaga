// api/booking.js
//
// Site-visit booking — slots and creation in one function.
//
// GET  /api/booking          → available 1-hour slots (was /api/booking/slots)
// POST /api/booking          → create a booking     (was /api/booking/create)

import { getAvailableSlots, createBooking, calendarConfigured } from './_lib/calendar.js';
import { appendLead } from './_lib/leadstore.js';
import { sendWhatsAppText, whatsappConfigured, normalizeIndianMsisdn } from './_lib/whatsapp.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return handleSlots(req, res);
  if (req.method === 'POST') return handleCreate(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleSlots(req, res) {
  if (blockedByRateLimit(req, res, { key: 'slots', max: 30, windowMs: 60000 })) return;
  try {
    const slots = await getAvailableSlots();
    return res.status(200).json({ ok: true, slots, calendarConnected: calendarConfigured() });
  } catch (e) {
    console.error('slots_failed', String(e).slice(0, 160));
    return res.status(503).json({ ok: false, error: 'slots_unavailable', slots: [] });
  }
}

async function handleCreate(req, res) {
  if (blockedByRateLimit(req, res, { key: 'booking', max: 10, windowMs: 60000 })) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = body.length ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'invalid_json' }); } }
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

  const IST = 5.5 * 3600000;
  const sd = new Date(Date.parse(slot) + IST);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const h = sd.getUTCHours();
  const label = `${days[sd.getUTCDay()]} ${sd.getUTCDate()} ${months[sd.getUTCMonth()]} · ${h % 12 || 12}:00 ${h >= 12 ? 'PM' : 'AM'} IST`;

  let eventId = '', htmlLink = '';
  if (calendarConfigured()) {
    try { const r = await createBooking({ name, phone, slot, language, notes }); eventId = r.eventId; htmlLink = r.htmlLink; }
    catch (e) { console.error('calendar_create_failed', String(e).slice(0, 160)); }
  }

  try {
    await appendLead({
      name, phone, language, callType: direction,
      disposition: 'booked', score: 80, interested: true,
      summary: `Site visit booked for ${label}.${notes ? ' Notes: ' + notes : ''}`,
      nextAction: `Confirm site visit on ${label}`,
      bookingDay: label, callId: eventId, source: 'web-booking',
    });
  } catch (e) { console.error('booking_lead_log_failed', String(e).slice(0, 160)); }

  if (whatsappConfigured() && phone) {
    const msg = [`✅ Your site visit at *Modcon SYL Residences* is confirmed!`, `📅 *${label}*`, `📍 Thukkuguda (near ORR Exit-14, Shamshabad)`, ``, `We look forward to seeing you, ${name}!`, `For directions or queries: +91 95348 69999`].join('\n');
    sendWhatsAppText({ to: phone, body: msg }).catch(() => {});
  }

  return res.status(200).json({ ok: true, eventId, htmlLink, label, message: `Site visit booked for ${label}` });
}
