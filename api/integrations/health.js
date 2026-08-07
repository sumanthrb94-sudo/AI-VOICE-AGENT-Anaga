// api/integrations/health.js
//
// GET /api/integrations/health — "which pipes are actually connected?"
//
// Returns booleans only. No secret, token, URL, or account id is ever included,
// so this is safe to hit from a browser while wiring an integration up. It is
// the fastest way to tell a misconfigured deploy from a broken one.

import { requireMethod } from '../_lib/integrations/http.js';
import { metaStatus } from '../_lib/integrations/meta.js';
import { crmStatus } from '../_lib/integrations/crm.js';
import { complianceStatus } from '../_lib/compliance.js';
import { queueStatus } from '../_lib/queue.js';
import { ttsStatus, voiceStudioHealth } from '../_lib/tts.js';
import { translateMode } from '../_lib/translate.js';
import { googleAuthMode } from '../_lib/google.js';
import { storeStatus } from '../_lib/store.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const compliance = complianceStatus();
  const meta = metaStatus();
  const crm = crmStatus();
  const queue = queueStatus();
  const store = await storeStatus();
  const voiceStudio = await voiceStudioHealth();

  const brain = {
    provider: (process.env.LLM_PROVIDER || 'gemini').toLowerCase(),
    configured: Boolean(process.env.GEMINI_API_KEY || process.env.LLM_API_KEY),
  };

  // What is still missing before this deploy can legally dial a real number.
  const blockers = [];
  if (!meta.appSecret || !meta.pageAccessToken) blockers.push('meta_lead_ads_not_wired');
  if (!process.env.INTEGRATIONS_API_KEY) blockers.push('integrations_api_key_missing');
  if (!compliance.dndScrub) blockers.push('dnd_scrub_not_configured');
  if (!compliance.suppressionList) blockers.push('suppression_list_not_configured');
  // A configured-but-unreachable store is worse than an unconfigured one: it
  // looks fine and blocks every dial. Surface it as its own blocker.
  if (store.backend === 'firestore' && !store.reachable) blockers.push('datastore_unreachable');
  if (store.backend === 'memory') blockers.push('datastore_not_durable');
  if (!queue.configured) blockers.push('dial_queue_not_configured');
  if (!process.env.OUTBOUND_CALLER_ID) blockers.push('outbound_caller_id_missing');
  if (compliance.mode === 'dev') blockers.push('COMPLIANCE_MODE=dev — must be strict before real dials');
  // Configured-but-down is the dangerous shape: it looks wired and silently
  // costs a hop on every single line Anaga speaks.
  if (voiceStudio.configured && !voiceStudio.reachable) blockers.push('voicestudio_unreachable');

  return res.status(200).json({
    ok: true,
    ready: {
      // the demo brain works with just an LLM key
      demo: brain.configured,
      // the full Meta/CRM -> call -> writeback loop
      production: blockers.length === 0,
    },
    brain,
    tts: ttsStatus(),
    voiceStudio,
    translate: { mode: translateMode(), auth: googleAuthMode() },
    store,
    meta,
    crm,
    compliance,
    dialQueue: queue,
    endpoints: {
      metaWebhook: '/api/integrations/meta/leads',
      leadIntake: '/api/leads/intake',
      callOutcome: '/api/calls/outcome',
      turn: '/api/anaga/turn',
      summary: '/api/anaga/summary',
    },
    blockers,
  });
}
