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
import { ttsStatus, ttsAvailable, voiceStudioHealth } from '../_lib/tts.js';
import { sttStatus, sttAvailable } from '../_lib/stt.js';
import { llmStatus } from '../_lib/llm.js';
import { recordingStatus } from '../_lib/recording.js';
import { translateMode } from '../_lib/translate.js';
import { googleAuthMode } from '../_lib/google.js';
import { storeStatus } from '../_lib/store.js';
import { callUsageStatus } from '../../shared/call-usage.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const compliance = complianceStatus();
  const meta = metaStatus();
  const crm = crmStatus();
  const queue = queueStatus();
  const store = await storeStatus();
  const voiceStudio = await voiceStudioHealth();
  const recording = recordingStatus();

  // ASK THE MODULE, don't re-derive it here. This block used to check
  // GEMINI_API_KEY by hand and call the provider "gemini", both of which went
  // stale the moment the brain became a chain: a deploy running on Sarvam
  // reported its brain as unconfigured on the one page you check to find out.
  const llm = llmStatus();
  const brain = { ...llm, configured: llm.ready.length > 0 };

  // The browser sends audio now, so a deploy without STT has a mute prospect:
  // every utterance comes back 503 and the screen just sits there. It fails
  // closed on purpose, which is right and completely invisible — this is where
  // you find out which of the two it is.
  const stt = sttStatus();

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
  // docs/COMPLIANCE.md requires recordings on Indian infrastructure with 90-day
  // retention. Unconfigured is a blocker; configured-but-non-Indian is worse,
  // because it looks done.
  if (!recording.configured) blockers.push('call_recording_not_configured');
  else if (!recording.indianRegion && !recording.overrideActive) blockers.push(`recording_region_not_indian:${recording.region}`);
  else if (recording.overrideActive) blockers.push('RECORDING_ALLOW_NON_INDIAN_REGION=1 — recordings are leaving India');

  return res.status(200).json({
    ok: true,
    // WHERE THIS FUNCTION RUNS — and it should be bom1 (Mumbai).
    //
    // Every vendor on this pipeline is in India, and one turn makes three
    // SERIAL calls to api.sarvam.ai: transcribe, think, speak. Run the function
    // in the US and each of those pays a transcontinental round trip, on top of
    // the prospect's own handset crossing the ocean twice — latency no amount
    // of code tuning gets back. It was iad1 (Washington DC) until vercel.json
    // pinned "regions": ["bom1"].
    //
    // Reported rather than assumed, because the setting is easy to lose in a
    // project-settings change and the symptom is just "she feels slow".
    region: process.env.VERCEL_REGION || 'unknown',
    ready: {
      // the demo brain works with just an LLM key
      demo: brain.configured,
      // A LIVE CALL needs all three: something to hear with, something to think
      // with, something to speak with. Reporting only the brain made a deploy
      // that could not hear a prospect look ready.
      call: brain.configured && sttAvailable() && ttsAvailable(),
      // the full Meta/CRM -> call -> writeback loop
      production: blockers.length === 0,
    },
    brain,
    stt,
    tts: ttsStatus(),
    voiceStudio,
    recording,
    translate: { mode: translateMode(), auth: googleAuthMode() },
    // Boolean/configuration names only. The commercial rates themselves never
    // leave the server through this public wiring endpoint.
    usage: callUsageStatus(),
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
