// api/calls/outcome.js
//
// POST /api/calls/outcome — the return pipe. The caller agent (or the telephony
// webhook) reports a finished call here and this endpoint closes every loop:
//
//   1. review   — use the review it was given, else generate one with the same
//                 summary prompt /api/anaga/summary uses, else fall back to a
//                 heuristic. A dead LLM must NEVER cost us the writeback.
//   2. opt-out  — if the prospect opted out, add the number to the suppression
//                 list FIRST (that is what actually blocks future dials), then
//                 flag the CRM record do-not-call.
//   3. CRM      — write the call note, disposition, intent score, next action.
//
// Auth: Bearer INTEGRATIONS_API_KEY (fails closed).
//
// Request:
//   { call: { id, startedAt, durationSec, recordingUrl, disposition },
//     lead: { phone, name?, email?, source?, sourceId?, crmRecordId?, campaign? },
//     history: [ { role: "agent"|"user", text } ],     // optional if review given
//     review: { … }                                    // optional, from the agent
//   }
//
// Contract: shared/integrations-contract.md

import { authorize, requireMethod, readRawBody, parseJson } from '../_lib/integrations/http.js';
import { normalizeLead, validateLead, maskPhone } from '../_lib/integrations/lead.js';
import { record } from '../_lib/events.js';
import { generate } from '../_lib/llm.js';
import { summaryPrompt, SUMMARY_DISPOSITIONS } from '../_lib/prompts.js';
import { addToSuppression } from '../_lib/compliance.js';
import * as crm from '../_lib/integrations/crm.js';

const OPT_OUT_RE = /\b(do ?not call|don'?t call|stop calling|remove me|unsubscribe|opt.?out|dnd|mat karo call|call mat)\b/i;

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  const auth = authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const raw = await readRawBody(req);
  const body = parseJson(raw);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const call = body.call && typeof body.call === 'object' ? body.call : {};
  const history = Array.isArray(body.history) ? body.history.filter(isTurn) : [];

  const lead = normalizeLead(body.lead || {}, {
    source: body.lead?.source || 'unknown',
    sourceId: body.lead?.sourceId || null,
    campaign: body.lead?.campaign || {},
    consent: body.lead?.consent || {},
  });
  if (body.lead?.crmRecordId) lead.crmRecordId = String(body.lead.crmRecordId);

  const valid = validateLead(lead);
  if (!valid.ok) return res.status(400).json({ error: valid.error });

  // --- 1. the review ------------------------------------------------------
  const review = await buildReview(body.review, history, call);

  // --- 2. opt-out: suppression list first ---------------------------------
  const optedOut = review.disposition === 'opt-out' ||
    call.disposition === 'opt-out' ||
    history.some((t) => t.role === 'user' && OPT_OUT_RE.test(t.text));

  let suppression = null;
  if (optedOut) {
    review.disposition = 'opt-out';
    review.interested = false;
    review.score = 0;
    suppression = await addToSuppression(lead.phone, 'opt_out_on_call');
    if (!suppression.durable) {
      // Loud: without a durable list this number can be dialed again.
      console.error('[calls/outcome] OPT-OUT NOT DURABLY SUPPRESSED', suppression.error);
    }
  }

  // --- 3. CRM writeback (best effort, never fails the request) ------------
  const written = await crm.logCall(lead, review, {
    id: call.id || null,
    startedAt: call.startedAt || null,
    durationSec: Number(call.durationSec) || null,
    recordingUrl: call.recordingUrl || null,
    history,
  });

  const dnc = optedOut ? await crm.markOptOut(lead, 'opt_out_on_call') : null;

  record('call.completed', {
    source: lead.source,
    phone: maskPhone(lead.phone),
    name: lead.name || null,
    callId: call.id || null,
    disposition: review.disposition,
    score: review.score,
    durationSec: Number(call.durationSec) || null,
    nextAction: review.nextAction || null,
    reviewedBy: review.generatedBy,
  });

  return res.status(200).json({
    ok: true,
    callId: call.id || null,
    review,
    optOut: optedOut,
    suppression: suppression ? { ok: suppression.ok, durable: suppression.durable, error: suppression.error } : null,
    crm: { provider: crm.crmProvider(), logged: written.ok, error: written.error, dncFlagged: dnc ? dnc.ok : null },
  });
}

function isTurn(t) {
  return t && typeof t === 'object' && typeof t.text === 'string' &&
    (t.role === 'agent' || t.role === 'user');
}

/**
 * Given review > generated review > heuristic review. Always returns a
 * contract-shaped object; never throws.
 */
async function buildReview(given, history, call) {
  if (given && typeof given === 'object' && (given.summary || given.disposition)) {
    return coerce(given);
  }

  if (history.length) {
    try {
      const { system, user } = summaryPrompt(history);
      const out = await generate({ system, user, json: true });
      if (out && typeof out === 'object') return coerce(out);
    } catch {
      // fall through to the heuristic — the writeback matters more than the prose
    }
  }

  return heuristicReview(history, call);
}

function coerce(out) {
  let score = Number(out.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    interested: out.interested === true,
    score,
    disposition: SUMMARY_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'undecided',
    summary: typeof out.summary === 'string' ? out.summary.trim() : '',
    nextAction: typeof out.nextAction === 'string' ? out.nextAction.trim() : '',
    comment: typeof out.comment === 'string' ? out.comment.trim() : '',
    generatedBy: out.generatedBy || 'llm',
  };
}

/** No LLM, no supplied review — still produce something a closer can act on. */
function heuristicReview(history, call) {
  const said = history.filter((t) => t.role === 'user').map((t) => t.text).join(' ');
  const disposition = SUMMARY_DISPOSITIONS.includes(call.disposition)
    ? call.disposition
    : (OPT_OUT_RE.test(said) ? 'opt-out' : 'undecided');

  const score = disposition === 'booked' ? 80 : disposition === 'callback' ? 50 : 0;
  return {
    interested: disposition === 'booked' || disposition === 'callback',
    score,
    disposition,
    summary: `Call ended with disposition "${disposition}". ${history.length} turns exchanged. Automatic review unavailable — read the transcript.`,
    nextAction: disposition === 'booked'
      ? 'Confirm the site visit and assign a closer.'
      : disposition === 'opt-out'
        ? 'Do not contact. Number suppressed.'
        : 'Human to review the transcript and decide.',
    comment: 'Generated without the LLM reviewer (fallback). Transcript attached.',
    generatedBy: 'heuristic',
  };
}
