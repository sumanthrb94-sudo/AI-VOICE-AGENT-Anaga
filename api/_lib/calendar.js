// api/_lib/calendar.js
//
// Google Calendar client — service-account JWT auth, same key pair used for
// Google Sheets (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY).
//
// Environment variables required:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   — ...@...iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY             — PEM key (\n may be escaped as \\n)
//   GOOGLE_CALENDAR_ID             — the calendar's full ID (email-style or 'primary')
//
// All calls are fail-soft: callers catch and treat the error as "unavailable".

import crypto from 'node:crypto';

const SCOPES = 'https://www.googleapis.com/auth/calendar';
const TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';

let _tok = null; // { token, exp(ms) }

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function calendarToken() {
  if (_tok && Date.now() < _tok.exp - 60000) return _tok.token;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  if (key.indexOf('\\n') >= 0) key = key.replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google service-account credentials not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: SCOPES, aud: TOKEN_AUDIENCE, iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(key));
  const jwt = `${header}.${claim}.${sig}`;
  const resp = await fetch(TOKEN_AUDIENCE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 160); } catch { /* ignore */ }
    throw new Error('calendar_token_' + resp.status + (d ? ': ' + d : ''));
  }
  const data = await resp.json();
  _tok = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return _tok.token;
}

function calendarId() {
  return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

/**
 * Check if the calendar integration is configured.
 */
export function calendarConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

/**
 * List busy blocks for a time range. Returns [{start, end}] in ISO strings.
 */
export async function getBusySlots(timeMin, timeMax) {
  const token = await calendarToken();
  const calId = calendarId();
  const url = 'https://www.googleapis.com/calendar/v3/freeBusy';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin, timeMax,
      items: [{ id: calId }],
    }),
  });
  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error('calendar_freebusy_' + resp.status + (d ? ': ' + d : ''));
  }
  const data = await resp.json();
  const busy = (data.calendars && data.calendars[calId] && data.calendars[calId].busy) || [];
  return busy;
}

/**
 * Get available 1-hour site-visit slots on the next two Saturdays and Sundays,
 * between 10:00 and 18:00 IST, skipping busy blocks.
 * Returns an array of { iso, label } objects, sorted chronologically.
 */
export async function getAvailableSlots() {
  // IST = UTC+5:30
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  const now = new Date();
  const slots = [];

  // Collect the next 2 Saturdays (day=6) and 2 Sundays (day=0)
  const targetDays = [6, 0]; // Saturday, Sunday
  const found = { 6: 0, 0: 0 };
  const candidateDates = [];
  for (let i = 1; i <= 14 && (found[6] < 2 || found[0] < 2); i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const dayUTC = d.getUTCDay();
    // Adjust to IST day
    const istMidnight = new Date(d.getTime() + IST_OFFSET_MS);
    const dayIST = istMidnight.getUTCDay();
    if (targetDays.includes(dayIST) && found[dayIST] < 2) {
      found[dayIST]++;
      // midnight IST for this day
      const istDay = new Date(Date.UTC(
        istMidnight.getUTCFullYear(),
        istMidnight.getUTCMonth(),
        istMidnight.getUTCDate()
      ) - IST_OFFSET_MS); // convert back to UTC
      candidateDates.push(istDay);
    }
  }

  if (candidateDates.length === 0) return [];

  candidateDates.sort((a, b) => a - b);

  const timeMin = candidateDates[0].toISOString();
  const timeMax = new Date(
    candidateDates[candidateDates.length - 1].getTime() + 86400000
  ).toISOString();

  let busy = [];
  try {
    busy = await getBusySlots(timeMin, timeMax);
  } catch {
    // If calendar API fails, return slots without conflict checking
    busy = [];
  }

  // Build 1-hour slots from 10:00 to 17:00 IST (last slot starts at 17:00)
  for (const date of candidateDates) {
    for (let hour = 10; hour <= 17; hour++) {
      const slotStart = new Date(date.getTime() + (hour - 5.5) * 3600000 - 30 * 60000);
      // Actually let's calculate properly: date is midnight UTC (=5:30 AM IST)
      // We want 10:00 IST = 04:30 UTC
      const slotStartUTC = new Date(date.getTime() + (hour * 60 - 5 * 60 - 30) * 60000);
      const slotEndUTC = new Date(slotStartUTC.getTime() + 3600000);

      // Skip slots in the past (with 30min buffer)
      if (slotStartUTC.getTime() < now.getTime() + 30 * 60000) continue;

      // Check for conflicts
      const conflict = busy.some((b) => {
        const bStart = new Date(b.start).getTime();
        const bEnd = new Date(b.end).getTime();
        return slotStartUTC.getTime() < bEnd && slotEndUTC.getTime() > bStart;
      });
      if (conflict) continue;

      // Format label in IST
      const istStart = new Date(slotStartUTC.getTime() + IST_OFFSET_MS);
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const hh = istStart.getUTCHours();
      const ampm = hh >= 12 ? 'PM' : 'AM';
      const h12 = hh % 12 || 12;
      const label = `${dayNames[istStart.getUTCDay()]} ${istStart.getUTCDate()} ${monthNames[istStart.getUTCMonth()]} · ${h12}:00 ${ampm} IST`;

      slots.push({ iso: slotStartUTC.toISOString(), label });
    }
  }

  return slots;
}

/**
 * Create a site-visit calendar event.
 * @param {{ name:string, phone:string, slot:string, language?:string, notes?:string }} opts
 * @returns {{ ok:true, eventId:string, htmlLink:string }}
 */
export async function createBooking({ name, phone, slot, language = '', notes = '' }) {
  const token = await calendarToken();
  const calId = calendarId();
  const start = new Date(slot);
  const end = new Date(start.getTime() + 3600000);

  const langLabel = language && language !== 'auto' ? ` · ${language}` : '';
  const description = [
    `Lead: ${name} (${phone})${langLabel}`,
    notes ? `Notes: ${notes}` : '',
    'Booked by Anaga — Modcon Builders AI',
  ].filter(Boolean).join('\n');

  const event = {
    summary: `Site visit — ${name}`,
    description,
    start: { dateTime: start.toISOString(), timeZone: 'Asia/Kolkata' },
    end: { dateTime: end.toISOString(), timeZone: 'Asia/Kolkata' },
    attendees: [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 30 },
      ],
    },
  };

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });

  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error('calendar_insert_' + resp.status + (d ? ': ' + d : ''));
  }

  const data = await resp.json();
  return { ok: true, eventId: data.id, htmlLink: data.htmlLink || '' };
}
