// api/_lib/integrations/crm/webhook.js
//
// The universal CRM escape hatch: POST a signed event to any URL. Salesforce
// Flow, Zapier/Make/n8n, a Google Sheet script, or a customer's own endpoint
// can all consume this without us writing a bespoke adapter.
//
// Every event has the same envelope:
//   { event, at, lead, review?, call?, reason? }
// signed with CRM_WEBHOOK_SECRET as X-Vaak-Signature-256: sha256=<hex>.

import { fetchJson, hmacSha256Hex } from '../http.js';

export const id = 'webhook';

export function configured() {
  return Boolean(process.env.CRM_WEBHOOK_URL);
}

async function send(event, payload) {
  const url = process.env.CRM_WEBHOOK_URL;
  if (!url) return { ok: false, error: 'crm_webhook_url_not_configured' };

  const body = JSON.stringify({ event, at: new Date().toISOString(), ...payload });
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.CRM_WEBHOOK_SECRET;
  if (secret) headers['X-Vaak-Signature-256'] = `sha256=${hmacSha256Hex(secret, body)}`;

  const res = await fetchJson(url, { method: 'POST', headers, body, timeoutMs: 8000 });
  return { ok: res.ok, error: res.error, recordId: res.data?.recordId || res.data?.id || null };
}

export async function upsertLead(lead) {
  const r = await send('lead.received', { lead });
  return { ok: r.ok, recordId: r.recordId, error: r.error };
}

export async function logCall(lead, review, call) {
  const r = await send('call.completed', { lead, review, call });
  return { ok: r.ok, error: r.error };
}

export async function markOptOut(lead, reason) {
  const r = await send('lead.optout', { lead, reason });
  return { ok: r.ok, error: r.error };
}
