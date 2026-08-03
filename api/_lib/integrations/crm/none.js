// api/_lib/integrations/crm/none.js
//
// The default: no CRM wired. Every call succeeds as a no-op and logs
// server-side, so the Meta → compliance → dial-queue tubing can be built and
// tested before a customer's CRM credentials exist. Nothing is silently
// swallowed — each call reports `ok:true, noop:true` so the endpoint response
// tells the truth about what was (not) written.

export const id = 'none';

// `configured()` is true so the pipeline runs end-to-end with CRM_PROVIDER unset.
export function configured() {
  return true;
}

export async function upsertLead(lead) {
  console.log('[crm:none] lead.received', { source: lead.source, sourceId: lead.sourceId });
  return { ok: true, noop: true, recordId: null, error: null };
}

export async function logCall(lead, review) {
  console.log('[crm:none] call.completed', {
    sourceId: lead.sourceId,
    disposition: review?.disposition,
    score: review?.score,
  });
  return { ok: true, noop: true, error: null };
}

export async function markOptOut(lead, reason) {
  console.log('[crm:none] lead.optout', { sourceId: lead.sourceId, reason });
  return { ok: true, noop: true, error: null };
}
