// api/console/summary.js
//
// GET /api/console/summary — everything the operator console renders, in one
// request: the wiring status, the pipeline funnel, why leads were blocked, and
// the recent event stream.
//
// Auth: Bearer INTEGRATIONS_API_KEY. This surfaces (masked) prospect names and
// call outcomes, so unlike /api/integrations/health it is NOT public.
//
// Every number comes from api/_lib/events.js — a per-instance ring buffer. The
// response says so in `store.durable:false`, and the console renders that as a
// visible banner. No fabricated history, no seeded demo numbers.

import { authorizeRead, requireMethod } from '../_lib/integrations/http.js';
import { list, rollup, meta, history } from '../_lib/events.js';
import { storeStatus, recentCalls } from '../_lib/store.js';
import { callView } from '../_lib/callview.js';
import { metaStatus } from '../_lib/integrations/meta.js';
import { crmStatus } from '../_lib/integrations/crm.js';
import { complianceStatus } from '../_lib/compliance.js';
import { queueStatus } from '../_lib/queue.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  // A signed-in operator OR the machine key. Before this, the console demanded
  // that a human paste the fleet's shared secret into a text box and kept it
  // in sessionStorage — the same key the caller agent uses to report call
  // outcomes, now one screenshot away from being shared.
  const auth = await authorizeRead(req, { role: 'viewer' });
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const compliance = complianceStatus();
  const queue = queueStatus();
  const metaWiring = metaStatus();
  const crm = crmStatus();
  const roll = rollup();

  // The same blocker list /api/integrations/health computes, so the console and
  // the public probe can never disagree about readiness.
  const blockers = [];
  if (!metaWiring.appSecret || !metaWiring.pageAccessToken) blockers.push('meta_lead_ads_not_wired');
  if (!compliance.dndScrub) blockers.push('dnd_scrub_not_configured');
  if (!compliance.suppressionList) blockers.push('suppression_list_not_configured');
  if (!queue.configured) blockers.push('dial_queue_not_configured');
  if (!process.env.OUTBOUND_CALLER_ID) blockers.push('outbound_caller_id_missing');
  if (compliance.mode === 'dev') blockers.push('compliance_mode_dev');

  const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));

  // Durable history when Firestore is wired; this instance's buffer otherwise.
  // Finished calls come from the durable store only — an event buffer holds
  // summaries, not conversations, so there is nothing to show without it.
  const [events, store, calls] = await Promise.all([
    history(limit), storeStatus(), recentCalls(25),
  ]);

  return res.status(200).json({
    ok: true,
    generatedAt: new Date().toISOString(),

    // "is this deployment able to make a real call?"
    wiring: {
      meta: metaWiring,
      crm,
      compliance,
      dialQueue: queue,
      blockers,
      canDial: blockers.length === 0,
    },

    // the funnel, derived from real events only
    funnel: roll,

    // the stream
    events: events.docs,

    // finished calls — score, disposition and a reference to the recording.
    // Transcripts are NOT here: they are fetched one at a time from
    // /api/calls/transcript?callId=…, which logs each read.
    calls: (calls.docs || []).map((d) => callView(d, { transcript: false })),

    // provenance — the console states exactly what is backing these numbers
    store: events.durable
      ? { durable: true, backend: store.backend, projectId: store.projectId, reachable: store.reachable, held: events.docs.length }
      : { ...meta(), backend: store.backend, reachable: store.reachable, storeError: store.error || null },
  });
}
