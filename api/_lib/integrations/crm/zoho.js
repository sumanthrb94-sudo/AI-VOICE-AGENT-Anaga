// api/_lib/integrations/crm/zoho.js
//
// Zoho CRM adapter — the most common CRM in the Indian real-estate market, so
// it gets a first-class adapter rather than the generic webhook.
//
// Auth: OAuth2. Set ZOHO_REFRESH_TOKEN + ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET
// and this exchanges for a short-lived access token (cached in-instance), or
// set ZOHO_ACCESS_TOKEN directly for a quick test.
// Data centre matters: ZOHO_API_DOMAIN (default https://www.zohoapis.in for
// India) and ZOHO_ACCOUNTS_DOMAIN (default https://accounts.zoho.in).
//
// Records go to the Leads module, upserted on Phone via the `upsert` endpoint
// with a duplicate_check_fields of Phone. Call outcomes are written as Notes
// attached to the lead.
//
// ⚠️ Verify against current Zoho docs (zoho.com/crm/developer/docs/api).

import { fetchJson } from '../http.js';

export const id = 'zoho';

export function configured() {
  return Boolean(
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET)
  );
}

const apiDomain = () => process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
const accountsDomain = () => process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// Access tokens live ~1h. Cache per warm instance; refresh a minute early.
let cachedToken = { value: null, expiresAt: 0 };

async function accessToken() {
  if (process.env.ZOHO_ACCESS_TOKEN) return { ok: true, token: process.env.ZOHO_ACCESS_TOKEN };
  if (cachedToken.value && Date.now() < cachedToken.expiresAt) {
    return { ok: true, token: cachedToken.value };
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN || '',
    client_id: process.env.ZOHO_CLIENT_ID || '',
    client_secret: process.env.ZOHO_CLIENT_SECRET || '',
    grant_type: 'refresh_token',
  });

  const res = await fetchJson(`${accountsDomain()}/oauth/v2/token?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
    timeoutMs: 8000,
  });
  const token = res.data?.access_token;
  if (!res.ok || !token) return { ok: false, error: res.error || 'zoho_token_refresh_failed' };

  const ttl = Number(res.data?.expires_in || 3600);
  cachedToken = { value: token, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 };
  return { ok: true, token };
}

async function zoho(path, { method = 'GET', body } = {}) {
  const t = await accessToken();
  if (!t.ok) return { ok: false, error: t.error, data: null };
  return fetchJson(`${apiDomain()}${path}`, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${t.token}`, 'Content-Type': 'application/json' },
    body,
    timeoutMs: 8000,
  });
}

function leadRecord(lead) {
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    Last_Name: parts.slice(1).join(' ') || parts[0] || 'Unknown',
    ...(parts.length > 1 ? { First_Name: parts[0] } : {}),
    Phone: lead.phone,
    ...(lead.email ? { Email: lead.email } : {}),
    ...(lead.city ? { City: lead.city } : {}),
    Lead_Source: lead.source === 'meta_lead_ads'
      ? (lead.campaign?.platform === 'instagram' ? 'Instagram' : 'Facebook Ads')
      : 'Modcon Builders',
    ...(lead.campaign?.name ? { Description: `Campaign: ${lead.campaign.name}` } : {}),
  };
}

export async function upsertLead(lead) {
  if (!configured()) return { ok: false, error: 'zoho_not_configured', recordId: null };

  const res = await zoho('/crm/v3/Leads/upsert', {
    method: 'POST',
    body: { data: [leadRecord(lead)], duplicate_check_fields: ['Phone'] },
  });
  if (!res.ok) return { ok: false, error: res.error, recordId: null };

  const row = res.data?.data?.[0];
  const recordId = row?.details?.id || null;
  if (!recordId) return { ok: false, error: row?.code || 'zoho_upsert_no_id', recordId: null };
  return { ok: true, error: null, recordId };
}

async function findLeadId(lead) {
  if (lead.crmRecordId) return { ok: true, id: lead.crmRecordId };
  const res = await zoho(`/crm/v3/Leads/search?phone=${encodeURIComponent(lead.phone)}`);
  if (!res.ok) return { ok: false, error: res.error, id: null };
  const hit = res.data?.data?.[0];
  return { ok: true, id: hit?.id || null };
}

async function addNote(recordId, title, content) {
  const res = await zoho('/crm/v3/Notes', {
    method: 'POST',
    body: {
      data: [{
        Note_Title: title,
        Note_Content: content,
        Parent_Id: recordId,
        se_module: 'Leads',
      }],
    },
  });
  return { ok: res.ok, error: res.error };
}

export async function logCall(lead, review, call, noteBody) {
  if (!configured()) return { ok: false, error: 'zoho_not_configured' };

  let found = await findLeadId(lead);
  if (!found.ok) return { ok: false, error: found.error };
  if (!found.id) {
    const created = await upsertLead(lead);
    if (!created.ok) return { ok: false, error: created.error };
    found = { ok: true, id: created.recordId };
  }

  const note = await addNote(found.id, `Anaga call — ${review?.disposition || 'undecided'}`, noteBody);

  // Roll the outcome onto the lead itself; custom fields may not exist, so a
  // rejected update must not lose the note we just wrote.
  await zoho('/crm/v3/Leads', {
    method: 'PUT',
    body: {
      data: [{
        id: found.id,
        Lead_Status: review?.disposition === 'booked' ? 'Contacted' : 'Attempted to Contact',
        ...(Number.isFinite(review?.score) ? { Anaga_Intent_Score: review.score } : {}),
      }],
    },
  });

  return { ok: note.ok, error: note.error };
}

export async function markOptOut(lead, reason) {
  if (!configured()) return { ok: false, error: 'zoho_not_configured' };

  const found = await findLeadId(lead);
  if (!found.ok || !found.id) return { ok: false, error: found.error || 'lead_not_found' };

  const dndField = process.env.CRM_DND_PROPERTY || 'Anaga_DND';
  await zoho('/crm/v3/Leads', {
    method: 'PUT',
    body: { data: [{ id: found.id, Lead_Status: 'Not Interested', [dndField]: true }] },
  });

  const note = await addNote(
    found.id,
    'Opt-out — do not call',
    `Opt-out recorded by Anaga (${reason || 'requested by prospect'}). Number added to the Modcon Builders do-not-call list. Do not dial again.`
  );
  return { ok: note.ok, error: note.error };
}
