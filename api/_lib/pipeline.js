// api/_lib/pipeline.js
//
// The tubing itself: everything that happens between "a lead landed" and "a
// caller agent is authorized to dial it". Every source (Meta Lead Ads, a CRM
// push, a CSV upload) funnels through this ONE function, so the compliance gate
// can never be bypassed by adding a new source.
//
//   normalized Lead
//        │
//        ├─ 1. validate shape (E.164 phone)
//        ├─ 2. dedupe (best effort — Meta retries the same leadgen_id)
//        ├─ 3. CRM upsert            (best effort, never blocks)
//        ├─ 4. COMPLIANCE GATE       (fails closed — the only hard stop)
//        └─ 5. enqueue the dial job  (orchestrator / WP-2)
//
// The CRM write happens BEFORE the gate on purpose: a lead we are not allowed
// to call still belongs in the CRM with an honest reason, so the human team can
// work it through a legal channel.

import { validateLead, leadSummary } from './integrations/lead.js';
import { checkDialable } from './compliance.js';
import * as crm from './integrations/crm.js';
import { buildCallJob, enqueueCall } from './queue.js';

// Best-effort, per-instance replay guard. Serverless instances are ephemeral
// and not shared, so this catches Meta's fast retries, NOT a duplicate an hour
// later — durable dedupe belongs in the datastore (DATABASE_URL, WP-6).
const RECENT_MAX = 500;
const recent = new Map();   // key -> timestamp

function seenRecently(key, windowMs = 10 * 60 * 1000) {
  if (!key) return false;
  const now = Date.now();
  const at = recent.get(key);
  if (at && now - at < windowMs) return true;

  recent.set(key, now);
  if (recent.size > RECENT_MAX) {
    // Drop the oldest ~10% — insertion order is chronological.
    const drop = Math.ceil(RECENT_MAX * 0.1);
    let i = 0;
    for (const k of recent.keys()) { recent.delete(k); if (++i >= drop) break; }
  }
  return false;
}

/**
 * Run a normalized Lead through the full intake pipeline.
 *
 * @param {object} lead              normalized Lead (integrations/lead.js)
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]    run every check, skip the CRM write + enqueue
 * @param {boolean} [opts.ignoreWindow] queue ahead of the 9–21 IST window
 * @returns {Promise<object>} an auditable result — every stage's verdict
 */
export async function intakeLead(lead, opts = {}) {
  const result = {
    accepted: false,
    lead: leadSummary(lead),
    steps: {},
    queued: false,
    reason: null,
  };

  // 1. shape
  const valid = validateLead(lead);
  result.steps.validate = valid;
  if (!valid.ok) {
    result.reason = valid.error;
    return result;
  }

  // 2. dedupe
  const dedupeKey = lead.id || `${lead.source}:${lead.phone}`;
  if (seenRecently(dedupeKey)) {
    result.steps.dedupe = { duplicate: true };
    result.reason = 'duplicate_lead';
    result.accepted = true;      // a duplicate is a successful no-op, not an error
    return result;
  }
  result.steps.dedupe = { duplicate: false };

  // 3. CRM upsert (best effort — an outage must not stop the call)
  if (opts.dryRun) {
    result.steps.crm = { skipped: 'dry_run', provider: crm.crmProvider() };
  } else {
    const up = await crm.upsertLead(lead);
    result.steps.crm = up;
    if (up.recordId) lead.crmRecordId = up.recordId;
  }

  // 4. COMPLIANCE GATE — the hard stop
  const gate = await checkDialable(lead, { ignoreWindow: opts.ignoreWindow === true });
  result.steps.compliance = gate;
  if (!gate.allowed) {
    result.reason = `blocked:${gate.reason}`;
    // Accepted as a lead, refused as a dial. The CRM record above carries it.
    result.accepted = true;
    return result;
  }

  // 5. enqueue the dial
  const job = buildCallJob(lead, {
    compliance: { allowed: true, checks: gate.checks, warnings: gate.warnings, at: new Date().toISOString() },
    crm: { provider: crm.crmProvider(), recordId: lead.crmRecordId || null },
  });

  if (opts.dryRun) {
    result.steps.queue = { skipped: 'dry_run' };
    result.job = job;
    result.accepted = true;
    result.reason = 'dry_run';
    return result;
  }

  const enq = await enqueueCall(job);
  result.steps.queue = { queued: enq.queued, reason: enq.reason, callId: enq.callId || null };
  result.queued = enq.queued;
  result.callId = enq.callId || null;
  result.accepted = true;
  result.reason = enq.queued ? null : enq.reason;

  return result;
}
