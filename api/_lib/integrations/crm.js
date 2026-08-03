// api/_lib/integrations/crm.js
//
// Provider-abstracted CRM boundary — the mirror of api/_lib/llm.js, for the
// system of record. Business logic (the intake pipeline, the call-outcome
// endpoint) calls upsertLead / logCall / markOptOut and never learns whether a
// HubSpot, a Zoho, or someone's n8n webhook answered.
//
// Adding a CRM = one adapter file exposing
//   { id, configured(), upsertLead(lead), logCall(lead, review, call, noteBody), markOptOut(lead, reason) }
// plus one line in the switch below. No caller changes.
//
// Failure policy: CRM writes are BEST EFFORT and never block a dial or a call
// outcome. A CRM outage must not stop us calling a lead or recording an
// opt-out — the opt-out still hits the suppression list, which is the gate that
// actually protects the prospect.

import * as none from './crm/none.js';
import * as webhookCrm from './crm/webhook.js';
import * as hubspot from './crm/hubspot.js';
import * as zoho from './crm/zoho.js';

export function crmProvider() {
  return String(process.env.CRM_PROVIDER || 'none').toLowerCase();
}

function adapter() {
  switch (crmProvider()) {
    case 'hubspot': return hubspot;
    case 'zoho': return zoho;
    case 'webhook': return webhookCrm;
    case 'none':
    case '': return none;
    // Salesforce / Freshsales / LeadSquared: point CRM_PROVIDER at `webhook`
    // and consume the signed envelope, or drop an adapter in ./crm/ and add it
    // here — the interface is four functions.
    default: return none;
  }
}

export function crmStatus() {
  const a = adapter();
  return { provider: crmProvider(), configured: a.configured() };
}

export function crmConfigured() {
  return adapter().configured();
}

/** Create/update the contact for a freshly-received lead. */
export async function upsertLead(lead) {
  const a = adapter();
  if (!a.configured()) return { ok: false, error: 'crm_not_configured', recordId: null, provider: a.id };
  try {
    const out = await a.upsertLead(lead);
    return { ...out, provider: a.id };
  } catch {
    return { ok: false, error: 'crm_adapter_error', recordId: null, provider: a.id };
  }
}

/** Write the finished call back as a note + status roll-up. */
export async function logCall(lead, review, call) {
  const a = adapter();
  if (!a.configured()) return { ok: false, error: 'crm_not_configured', provider: a.id };
  try {
    const out = await a.logCall(lead, review, call, renderCallNote(lead, review, call));
    return { ...out, provider: a.id };
  } catch {
    return { ok: false, error: 'crm_adapter_error', provider: a.id };
  }
}

/** Flag the contact as do-not-call in the CRM (the suppression list is separate). */
export async function markOptOut(lead, reason) {
  const a = adapter();
  if (!a.configured()) return { ok: false, error: 'crm_not_configured', provider: a.id };
  try {
    const out = await a.markOptOut(lead, reason);
    return { ...out, provider: a.id };
  } catch {
    return { ok: false, error: 'crm_adapter_error', provider: a.id };
  }
}

// ---------------------------------------------------------------------------
// The note a human closer actually reads. One shape across every CRM.
// ---------------------------------------------------------------------------

export function renderCallNote(lead, review, call = {}) {
  const L = [];
  L.push(`📞 Anaga (AI voice agent) — outbound qualification call`);
  L.push(`Outcome: ${review?.disposition || 'undecided'}${Number.isFinite(review?.score) ? ` · intent ${review.score}/100` : ''}`);
  if (call.startedAt) L.push(`When: ${call.startedAt}${call.durationSec ? ` · ${call.durationSec}s` : ''}`);
  if (lead.campaign?.name || lead.source) {
    L.push(`Source: ${lead.source}${lead.campaign?.name ? ` · ${lead.campaign.name}` : ''}`);
  }
  L.push('');

  if (review?.summary) { L.push(`Summary: ${review.summary}`); L.push(''); }
  if (review?.comment) { L.push(`Internal note: ${review.comment}`); L.push(''); }
  if (review?.nextAction) { L.push(`▶ Next action: ${review.nextAction}`); L.push(''); }

  const known = { ...(lead.known || {}), ...(review?.qualified || {}) };
  const qualifiedLines = ['purpose', 'budget', 'configuration', 'timeline']
    .filter((k) => known[k])
    .map((k) => `  • ${k}: ${known[k]}`);
  if (qualifiedLines.length) { L.push('Qualified:'); L.push(...qualifiedLines); L.push(''); }

  if (call.recordingUrl) L.push(`Recording: ${call.recordingUrl}`);
  if (Array.isArray(call.history) && call.history.length) {
    L.push('');
    L.push('Transcript:');
    for (const t of call.history.slice(0, 60)) {
      L.push(`  ${t.role === 'agent' ? 'Anaga' : 'Prospect'}: ${String(t.text || '').slice(0, 400)}`);
    }
  }

  L.push('');
  L.push('— Anaga qualifies and books; humans close.');
  return L.join('\n');
}
