// api/_lib/leadstore.js
//
// Provider-abstracted LEAD / CALL log — every finished call drops a structured
// row your sales team can see. Default store is a GOOGLE SHEET (the "Excel" your
// team already opens); Supabase is the alternative. If nothing is configured it
// no-ops and fails soft, so logging can NEVER break a call.
//
// Same provider-abstraction boundary as llm.js / voice-platform.js. No npm deps:
// global fetch (Node 18+) + node:crypto for the Google service-account JWT.

import crypto from 'node:crypto';

// Canonical column order (the Sheet header row should match this).
export const LEAD_FIELDS = [
  'ts', 'name', 'phone', 'language', 'callType', 'disposition', 'score',
  'interested', 'summary', 'nextAction', 'comment', 'bookingDay', 'callId',
  'source', 'recording',
];

export function leadStore() {
  return (process.env.LEAD_STORE || 'sheets').toLowerCase();
}

export function leadStoreConfigured() {
  switch (leadStore()) {
    case 'sheets':
      return !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID);
    case 'supabase':
      return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
    default:
      return false;
  }
}

/**
 * Append one lead/call row. Returns { ok, store } or { ok:false, skipped }.
 * Never throws to the caller in the not-configured case (fail soft).
 */
export async function appendLead(lead) {
  if (!leadStoreConfigured()) return { ok: false, skipped: 'not_configured' };
  const row = normalizeLead(lead);
  switch (leadStore()) {
    case 'sheets':   return appendSheets(row);
    case 'supabase': return appendSupabase(row);
    default:         return { ok: false, skipped: 'unsupported' };
  }
}

/**
 * List recent leads (newest first). Supabase only (Sheets read not implemented).
 * Returns { ok, leads }.
 */
export async function listLeads({ limit = 100 } = {}) {
  if (!leadStoreConfigured() || leadStore() !== 'supabase') return { ok: false, leads: [] };
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_LEADS_TABLE || 'leads';
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const resp = await fetch(`${base}/rest/v1/${table}?select=*&order=created_at.desc&limit=${n}`, {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
  });
  if (!resp.ok) { let d = ''; try { d = (await resp.text()).slice(0, 200); } catch (_) {} throw new Error('supabase_list_' + resp.status + (d ? ': ' + d : '')); }
  const leads = await resp.json();
  return { ok: true, leads: Array.isArray(leads) ? leads : [] };
}

function normalizeLead(l) {
  l = l || {};
  return {
    ts: l.ts || new Date().toISOString(),
    name: str(l.name),
    phone: str(l.phone),
    language: str(l.language),
    callType: str(l.callType || l.direction),
    disposition: str(l.disposition),
    score: l.score == null ? '' : String(l.score),
    interested: l.interested == null ? '' : (l.interested ? 'yes' : 'no'),
    summary: str(l.summary),
    nextAction: str(l.nextAction),
    comment: str(l.comment),
    bookingDay: str(l.bookingDay),
    callId: str(l.callId),
    source: str(l.source),
    recording: str(l.recording),
  };
}
function str(v) { return v == null ? '' : String(v).slice(0, 2000); }

// ---------------------------------------------------------------------------
// Google Sheets — service-account JWT → Sheets API values:append.
// Needs GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID; share
// the sheet with the service-account email (Editor). Header row should be LEAD_FIELDS.
// ---------------------------------------------------------------------------
let _tok = null; // { token, exp(ms) }

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sheetsToken() {
  if (_tok && Date.now() < _tok.exp - 60000) return _tok.token;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  if (key.indexOf('\\n') >= 0) key = key.replace(/\\n/g, '\n');   // env-escaped newlines
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(key));
  const jwt = `${header}.${claim}.${sig}`;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  if (!resp.ok) { let d = ''; try { d = (await resp.text()).slice(0, 160); } catch (_) {} throw new Error('sheets_token_' + resp.status + (d ? ': ' + d : '')); }
  const data = await resp.json();
  _tok = { token: data.access_token, exp: Date.now() + ((data.expires_in || 3600) * 1000) };
  return _tok.token;
}

async function appendSheets(row) {
  const id = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || 'Leads';
  const token = await sheetsToken();
  const range = encodeURIComponent(tab) + '!A1';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const values = [LEAD_FIELDS.map((f) => row[f] != null ? row[f] : '')];
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!resp.ok) { let d = ''; try { d = (await resp.text()).slice(0, 200); } catch (_) {} throw new Error('sheets_append_' + resp.status + (d ? ': ' + d : '')); }
  return { ok: true, store: 'sheets' };
}

// ---------------------------------------------------------------------------
// Supabase — PostgREST insert. Needs SUPABASE_URL + SUPABASE_SERVICE_KEY and a
// table (default "leads") whose columns match LEAD_FIELDS.
// ---------------------------------------------------------------------------
async function appendSupabase(row) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_LEADS_TABLE || 'leads';
  const resp = await fetch(`${base}/rest/v1/${table}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!resp.ok) { let d = ''; try { d = (await resp.text()).slice(0, 200); } catch (_) {} throw new Error('supabase_insert_' + resp.status + (d ? ': ' + d : '')); }
  return { ok: true, store: 'supabase' };
}
