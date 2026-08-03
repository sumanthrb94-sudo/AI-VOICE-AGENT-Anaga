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

import { authorize, requireMethod } from '../_lib/integrations/http.js';
import { list, rollup, meta } from '../_lib/events.js';
import { metaStatus } from '../_lib/integrations/meta.js';
import { crmStatus } from '../_lib/integrations/crm.js';
import { complianceStatus } from '../_lib/compliance.js';
import { queueStatus } from '../_lib/queue.js';

export default function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const auth = authorize(req);
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
    events: list({ limit }),

    // provenance — the console must not imply a database exists
    store: meta(),
  });
}
