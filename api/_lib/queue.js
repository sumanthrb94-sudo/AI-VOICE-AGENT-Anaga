// api/_lib/queue.js
//
// The hand-off from "we have a legal, qualified-to-dial lead" to "a caller
// agent actually rings the phone". This file is the seam between the tubing in
// api/ and the orchestrator (WP-2) / caller agent (WP-3) that will own dialing.
//
// Two modes, chosen by env, no vendor in business logic:
//   DIAL_QUEUE_URL set   -> POST the job to the orchestrator (signed with
//                           DIAL_QUEUE_SECRET so it can trust the caller).
//   unset                -> return the job unqueued. The endpoint still returns
//                           200 with `queued:false` so a CRM/Meta pipeline can
//                           be wired and verified BEFORE telephony exists.
//
// The job payload is deliberately everything the caller agent needs to run the
// existing brain (/api/anaga/turn) without calling back for context.

import { fetchJson, hmacSha256Hex } from './integrations/http.js';

export function queueConfigured() {
  return Boolean(process.env.DIAL_QUEUE_URL);
}

export function queueStatus() {
  return {
    configured: queueConfigured(),
    signed: Boolean(process.env.DIAL_QUEUE_SECRET),
  };
}

/**
 * Build the dial job. Kept as a pure function so the orchestrator contract is
 * testable and so /api/leads/intake can return it in dry-run mode.
 */
export function buildCallJob(lead, { compliance, crm } = {}) {
  return {
    type: 'outbound_call',
    version: 1,
    createdAt: new Date().toISOString(),

    lead: {
      id: lead.id,
      source: lead.source,
      sourceId: lead.sourceId,
      name: lead.name || null,
      phone: lead.phone,
      email: lead.email || null,
      city: lead.city || null,
      known: lead.known || {},        // Anaga skips questions the form answered
      campaign: lead.campaign || {},
    },

    // The agent identity + brain the caller agent should run.
    agent: {
      name: process.env.AGENT_NAME || 'Anaga',
      persona: process.env.AGENT_PERSONA || 'caller-agent/flows/anaga.persona.json',
      lang: lead.lang || 'en-IN',
      turnEndpoint: '/api/anaga/turn',
      summaryEndpoint: '/api/anaga/summary',
    },

    // Where the caller agent must report back when the call ends.
    callback: {
      url: process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL}/api/calls/outcome` : '/api/calls/outcome',
      auth: 'bearer INTEGRATIONS_API_KEY',
    },

    telephony: {
      callerId: process.env.OUTBOUND_CALLER_ID || null,   // must be 160-series
      maxAttempts: Number(process.env.DIAL_MAX_ATTEMPTS || 3),
    },

    compliance: compliance || null,   // the gate decision that authorized this dial
    crm: crm || null,                 // { provider, recordId } for writeback
  };
}

/**
 * Enqueue a dial job with the orchestrator.
 * @returns {Promise<{queued:boolean, reason:string|null, job:object}>}
 */
export async function enqueueCall(job) {
  const url = process.env.DIAL_QUEUE_URL;
  if (!url) return { queued: false, reason: 'dial_queue_not_configured', job };

  const body = JSON.stringify(job);
  const headers = { 'Content-Type': 'application/json' };
  const secret = process.env.DIAL_QUEUE_SECRET;
  if (secret) headers['X-Vaak-Signature-256'] = `sha256=${hmacSha256Hex(secret, body)}`;

  const res = await fetchJson(url, { method: 'POST', headers, body, timeoutMs: 8000 });
  return {
    queued: res.ok,
    reason: res.ok ? null : (res.error || 'queue_error'),
    job,
    callId: res.data?.callId || res.data?.id || null,
  };
}
