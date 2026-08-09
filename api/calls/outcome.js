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
import { scoreLead, explainScore } from '../_lib/scoring.js';
import { recordCall } from '../_lib/store.js';
import { addToSuppression } from '../_lib/compliance.js';
import * as crm from '../_lib/integrations/crm.js';
import { limited, log, requestId } from '../_lib/guard.js';
import { detectOptOut, transcriptHasOptOut } from '../../shared/optout.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  if (limited(req, res, { bucket: 'outcome', limit: Number(process.env.RATE_LIMIT_OUTCOME || 120) })) return;

  const rid = requestId(req);
  const auth = authorize(req);
  if (!auth.ok) {
    log('outcome_unauthorized', { rid, reason: auth.error });
    return res.status(auth.status).json({ error: auth.error });
  }

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
    transcriptHasOptOut(history);

  let suppression = null;
  if (optedOut) {
    review.disposition = 'opt-out';
    review.interested = false;
    // Rescore rather than assigning 0 by hand: the ceiling for "opt-out" lives
    // in the flow, and the breakdown must agree with the number next to it.
    Object.assign(review, applyScore(review));
    suppression = await addToSuppression(lead.phone, 'opt_out_on_call');
    if (!suppression.durable) {
      // Loud: without a durable list this number can be dialed again.
      log('OPT_OUT_NOT_DURABLY_SUPPRESSED', {
        rid, callId: call.id || null, error: suppression.error,
        severity: 'critical',
        detail: 'this number can be dialled again — wire SUPPRESSION_LIST_URL',
      });
    }
  }

  // --- 3. CRM writeback (best effort, never fails the request) ------------
  // Accept only an opaque s3:// reference. A caller that sends a playable URL
  // (an older agent, or a telephony provider's own recording link) must not be
  // able to get it written into a CRM note — see _lib/recording.js.
  const recordingRef = typeof call.recordingRef === 'string' && /^s3:\/\//.test(call.recordingRef)
    ? call.recordingRef
    : null;
  if (!recordingRef && call.recordingUrl) {
    log('RECORDING_URL_REJECTED', {
      rid, callId: call.id || null,
      detail: 'a playable URL was sent; only s3:// references are stored',
    });
  }

  const written = await crm.logCall(lead, review, {
    id: call.id || null,
    startedAt: call.startedAt || null,
    durationSec: Number(call.durationSec) || null,
    recordingRef,
    history,
  });

  const dnc = optedOut ? await crm.markOptOut(lead, 'opt_out_on_call') : null;

  // --- 4. the call record -------------------------------------------------
  // The TRANSCRIPT is kept here, and this is the only place it is kept. Until
  // now `recordCall` existed in store.js and was called by nothing: a finished
  // call left an event with a summary on it and the conversation itself was
  // discarded the moment the request returned. docs/COMPLIANCE.md requires a
  // call to be evidenced, a closer needs to read what was actually said, and a
  // disputed opt-out is settled by the transcript or not at all.
  //
  // The phone is stored MASKED. The link back to the person is crmRecordId /
  // sourceId, which is enough to work the lead and not enough to make this
  // collection a phone book.
  const stored = await recordCall(call.id, {
    callId: call.id || null,
    startedAt: call.startedAt || null,
    durationSec: Number(call.durationSec) || null,
    disposition: review.disposition,
    score: review.score,
    band: review.band,
    scoring: review.scoring,
    qualification: review.qualification,
    summary: review.summary,
    nextAction: review.nextAction,
    comment: review.comment,
    reviewedBy: review.generatedBy,
    optOut: optedOut,
    recordingRef,
    turns: history.length,
    transcript: history,
    lead: {
      phoneMasked: maskPhone(lead.phone),
      name: lead.name || null,
      source: lead.source || null,
      sourceId: lead.sourceId || null,
      crmRecordId: lead.crmRecordId || null,
    },
  });
  if (!stored.durable) {
    log('CALL_NOT_PERSISTED', {
      rid, callId: call.id || null, error: stored.error || null,
      severity: 'high',
      detail: 'the transcript for this call was not stored — wire FIREBASE_SERVICE_ACCOUNT',
    });
  }

  record('call.completed', {
    source: lead.source,
    phone: maskPhone(lead.phone),
    name: lead.name || null,
    callId: call.id || null,
    disposition: review.disposition,
    score: review.score,
    band: review.band || null,
    // How much of the qualification actually got done. A 70 off four answers
    // and a 70 off one are not the same lead.
    coverage: review.scoring?.coverage ?? null,
    durationSec: Number(call.durationSec) || null,
    nextAction: review.nextAction || null,
    reviewedBy: review.generatedBy,
    transcriptStored: stored.durable === true,
    // The audit trail docs/COMPLIANCE.md asks for: the event carries the
    // recording REFERENCE, so a call can be evidenced without the audio being
    // reachable from the event itself.
    recordingRef,
  });

  return res.status(200).json({
    ok: true,
    callId: call.id || null,
    review,
    optOut: optedOut,
    suppression: suppression ? { ok: suppression.ok, durable: suppression.durable, error: suppression.error } : null,
    crm: { provider: crm.crmProvider(), logged: written.ok, error: written.error, dncFlagged: dnc ? dnc.ok : null },
    recording: recordingRef ? { stored: true } : { stored: false },
    transcript: { stored: stored.durable === true, turns: history.length },
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

/**
 * Score a review from its qualification buckets, and attach the breakdown.
 *
 * Any `score` the model returned is DISCARDED. The number is computed from the
 * weights in the flow (see _lib/scoring.js) so that the same call always scores
 * the same, and so "why is this a 48?" is answerable without the transcript.
 */
function applyScore(review) {
  const s = scoreLead({ qualification: review.qualification, disposition: review.disposition });
  return {
    score: s.score,
    band: s.band,
    scoring: {
      band: s.band, coverage: s.coverage, answered: s.answered, of: s.of,
      cappedBy: s.cappedBy, fields: s.fields, explain: explainScore(s),
    },
  };
}

function coerce(out) {
  const review = {
    interested: out.interested === true,
    disposition: SUMMARY_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'undecided',
    // What the prospect actually told us, bucketed. This is the lead potency
    // input, and it is also the part a closer reads first.
    qualification: out.qualification && typeof out.qualification === 'object' ? out.qualification : {},
    summary: typeof out.summary === 'string' ? out.summary.trim() : '',
    nextAction: typeof out.nextAction === 'string' ? out.nextAction.trim() : '',
    comment: typeof out.comment === 'string' ? out.comment.trim() : '',
    generatedBy: out.generatedBy || 'llm',
  };
  return { ...review, ...applyScore(review) };
}

/** No LLM, no supplied review — still produce something a closer can act on. */
function heuristicReview(history, call) {
  const said = history.filter((t) => t.role === 'user').map((t) => t.text).join(' ');
  const disposition = SUMMARY_DISPOSITIONS.includes(call.disposition)
    ? call.disposition
    : (detectOptOut(said).optOut ? 'opt-out' : 'undecided');

  // No qualification data means every field scores "unclear" — which is the
  // honest answer. A call nobody could review is not a warm lead.
  const review = {
    interested: disposition === 'booked' || disposition === 'callback',
    disposition,
    qualification: {},
    summary: `Call ended with disposition "${disposition}". ${history.length} turns exchanged. Automatic review unavailable — read the transcript.`,
    nextAction: disposition === 'booked'
      ? 'Confirm the site visit and assign a closer.'
      : disposition === 'opt-out'
        ? 'Do not contact. Number suppressed.'
        : 'Human to review the transcript and decide.',
    comment: 'Generated without the LLM reviewer (fallback). Transcript attached.',
    generatedBy: 'heuristic',
  };
  return { ...review, ...applyScore(review) };
}
