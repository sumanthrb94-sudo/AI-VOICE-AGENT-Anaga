// api/integrations/meta/leads.js
//
// Meta (Facebook / Instagram) Lead Ads webhook — the front door for "someone
// clicked our ad and asked to be called".
//
//   GET  /api/integrations/meta/leads   -> verification handshake (hub.challenge)
//   POST /api/integrations/meta/leads   -> leadgen change notifications
//
// POST flow, per leadgen change:
//   verify HMAC (fail closed) -> Graph fetch the full lead -> normalize ->
//   intakeLead() [CRM upsert -> compliance gate -> dial queue]
//
// Why we always answer 200 on a signed POST: Meta retries any non-2xx for up to
// 36h and disables the subscription on sustained failure. A downstream problem
// (Graph token expired, CRM down) must not take the webhook subscription with
// it — so failures are reported per-lead in the response body and in the logs,
// and the request itself succeeds. An UNSIGNED or mis-signed POST is a
// different animal: 403, no processing, no retry sympathy.
//
// Setup runbook: docs/INTEGRATIONS.md · contract: shared/integrations-contract.md

import { readRawBody, parseJson, requireMethod } from '../../_lib/integrations/http.js';
import {
  verifyChallenge, verifySignature, parseLeadgenChanges, fetchLeadgen, leadFromGraph, metaStatus,
} from '../../_lib/integrations/meta.js';
import { intakeLead } from '../../_lib/pipeline.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, ['GET', 'POST'])) return;

  // --- GET: subscription verification -------------------------------------
  if (req.method === 'GET') {
    const q = req.query || {};
    const v = verifyChallenge(q);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    // Meta expects the raw challenge string, not JSON.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(v.challenge);
  }

  // --- POST: leadgen notifications ----------------------------------------
  const raw = await readRawBody(req);
  const sig = verifySignature(raw, req.headers['x-hub-signature-256']);
  if (!sig.ok) {
    // Never process an unverified payload — this endpoint causes phone calls.
    console.warn('[meta/leads] rejected payload:', sig.error);
    return res.status(403).json({ error: sig.error });
  }

  const body = parseJson(raw);
  if (!body) return res.status(400).json({ error: 'invalid_json' });
  if (body.object !== 'page' && body.object !== 'instagram') {
    return res.status(200).json({ received: true, ignored: `object:${body.object || 'unknown'}` });
  }

  const changes = parseLeadgenChanges(body);
  if (!changes.length) {
    return res.status(200).json({ received: true, ignored: 'no_leadgen_changes' });
  }

  const results = [];
  for (const change of changes) {
    const record = await fetchLeadgen(change.leadgenId);
    if (!record.ok) {
      // The lead exists at Meta but we could not read it. Loud, but still 200.
      console.error('[meta/leads] graph fetch failed', change.leadgenId, record.error);
      results.push({ leadgenId: change.leadgenId, accepted: false, reason: record.error });
      continue;
    }

    const lead = leadFromGraph(record.data, change);
    const out = await intakeLead(lead);
    results.push({ leadgenId: change.leadgenId, ...out });
  }

  return res.status(200).json({
    received: true,
    processed: results.length,
    queued: results.filter((r) => r.queued).length,
    meta: metaStatus(),
    results,
  });
}
