// api/booking/slots.js
//
// GET /api/booking/slots
// Returns available 1-hour site-visit windows on the next 2 Saturdays + 2 Sundays,
// 10 AM – 6 PM IST, skipping already-booked blocks from Google Calendar.
//
// Requires GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY + GOOGLE_CALENDAR_ID.
// If unconfigured → returns generic slots without conflict-checking (still usable).
//
// Response: { ok:true, slots:[{ iso:"...", label:"Sat 21 Jun · 10:00 AM IST" },...] }

import { getAvailableSlots, calendarConfigured } from '../_lib/calendar.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'slots', max: 30, windowMs: 60000 })) return;

  res.setHeader('Cache-Control', 'no-store');

  try {
    const slots = await getAvailableSlots();
    return res.status(200).json({
      ok: true,
      slots,
      calendarConnected: calendarConfigured(),
    });
  } catch (e) {
    console.error('slots_failed', String(e).slice(0, 160));
    return res.status(503).json({ ok: false, error: 'slots_unavailable', slots: [] });
  }
}
