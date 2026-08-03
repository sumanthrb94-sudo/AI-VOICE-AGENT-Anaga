// caller-agent/src/session.js
//
// One live call, start to finish. This is WP-3 — "the product's soul".
//
// The loop is deliberately small, because everything safety-critical happens
// around it rather than inside the LLM:
//
//   dial → [disclosure MUST be turn 1] → loop { listen → OPT-OUT CHECK → brain
//   → say } → hangup → report outcome
//
// Four invariants the LLM is not trusted to hold:
//
//   1. DISCLOSURE IS TURN ONE. The first thing said on every call states that
//      Anaga is an AI. It comes from the persona file, not the model, and if
//      the brain is down we still disclose before doing anything else.
//   2. OPT-OUT IS CHECKED BEFORE THE BRAIN. Every prospect utterance goes
//      through detectOptOut() first. On a hit we say the opt-out line and hang
//      up — the model never gets a chance to keep selling.
//   3. HARD LIMITS. Max turns and max wall-clock seconds. A stuck brain or a
//      chatty prospect cannot produce an unbounded call.
//   4. THE OUTCOME IS ALWAYS REPORTED. Every exit path — answered, no-answer,
//      busy, hangup, crash — reports to /api/calls/outcome. A call we cannot
//      account for is a compliance hole.

import { detectOptOut } from './optout.js';

export const MAX_TURNS = Number(process.env.CALL_MAX_TURNS || 24);
export const MAX_SECONDS = Number(process.env.CALL_MAX_SECONDS || 300);
export const MAX_SILENT_TURNS = Number(process.env.CALL_MAX_SILENT_TURNS || 2);

/**
 * Run one call.
 *
 * @param {object} deps
 * @param {object} deps.job        the signed dial job (see shared/integrations-contract.md)
 * @param {object} deps.telephony  a telephony adapter (mock/plivo/exotel)
 * @param {object} deps.brain      { nextTurn(history, lead), reportOutcome(payload) }
 * @param {object} deps.persona    parsed anaga.persona.json
 * @param {function} [deps.now]    injectable clock for tests
 * @param {function} [deps.log]
 * @returns {Promise<object>} the call result (also reported to the API)
 */
export async function runCall({ job, telephony, brain, persona, now = () => Date.now(), log = () => {} }) {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const lead = job.lead || {};
  const lang = job.agent?.lang || lead.lang || 'en-IN';
  const callId = job.callId || `call_${startedAtMs.toString(36)}`;

  /** @type {Array<{role:'agent'|'user', text:string}>} */
  const history = [];
  let disposition = 'busy';
  let endReason = 'unknown';
  let optOutMatched = null;

  const elapsedSec = () => Math.round((now() - startedAtMs) / 1000);
  const say = async (text) => {
    const ok = await telephony.say(text);
    if (ok) history.push({ role: 'agent', text });
    return ok;
  };

  try {
    // ---- 1. dial ---------------------------------------------------------
    const dial = await telephony.dial({
      to: lead.phone,
      from: job.telephony?.callerId || process.env.OUTBOUND_CALLER_ID,
      callId,
    });

    if (!dial.answered) {
      endReason = dial.reason || 'no_answer';
      disposition = dial.reason === 'busy' ? 'busy' : 'no-answer';
      return await finish();
    }

    // ---- 2. disclosure — non-skippable, first words on the call ----------
    // Straight from the persona file. Never model-generated: a hallucinated
    // opening that omits "I am an AI" is a regulatory breach on every call.
    const disclosure = persona?.disclosure?.[lang]
      || persona?.disclosure?.['en-IN']
      || "Hi, I'm Anaga, an AI voice assistant from Vaak. Is now a good time to talk for a couple of minutes?";

    if (!(await say(disclosure))) {
      endReason = 'dropped_before_disclosure';
      disposition = 'busy';
      return await finish();
    }

    // ---- 3. the turn loop ------------------------------------------------
    let silentTurns = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (elapsedSec() >= MAX_SECONDS) {
        endReason = 'max_duration';
        break;
      }

      const heard = await telephony.listen();

      if (heard.hangup) {
        endReason = 'callee_hangup';
        break;
      }

      if (heard.silent || !heard.text) {
        silentTurns++;
        if (silentTurns > MAX_SILENT_TURNS) {
          endReason = 'silence';
          break;
        }
        // One nudge, then give up. Do not badger.
        await say(silentTurns === 1
          ? 'Sorry, I did not catch that — are you still there?'
          : 'I will let you go for now. Thank you for your time!');
        continue;
      }
      silentTurns = 0;

      history.push({ role: 'user', text: heard.text });

      // ---- INVARIANT 2: opt-out is checked before the brain runs --------
      const opt = detectOptOut(heard.text);
      if (opt.optOut) {
        optOutMatched = opt.matched;
        disposition = 'opt-out';
        endReason = 'opt_out';
        log('opt_out_detected', { callId, matched: opt.matched });
        await say(
          'I completely understand. I am adding your number to our do-not-call list now, '
          + 'so you will not receive further calls. Apologies for the disturbance.'
        );
        break;
      }

      // ---- brain ---------------------------------------------------------
      let next;
      try {
        next = await brain.nextTurn(history, lead);
      } catch (err) {
        // A dead brain must not strand a live call. Close it politely and let
        // a human follow up — never leave dead air on someone's phone.
        log('brain_error', { callId, error: String(err && err.message) });
        endReason = 'brain_unavailable';
        disposition = 'callback';
        await say('I am having a little trouble on my side. Our team will call you back shortly. Thank you!');
        break;
      }

      if (next?.disposition) disposition = next.disposition;
      if (next?.say) await say(next.say);

      if (next?.end) {
        endReason = 'agent_ended';
        break;
      }
    }

    if (endReason === 'unknown') endReason = 'max_turns';
    return await finish();
  } catch (err) {
    // ---- INVARIANT 4: even a crash reports an outcome -------------------
    log('session_error', { callId, error: String(err && err.message) });
    endReason = 'error';
    return await finish(String(err && err.message));
  }

  // -----------------------------------------------------------------------
  async function finish(errorMessage = null) {
    await telephony.hangup(endReason).catch(() => {});

    const result = {
      callId,
      startedAt,
      durationSec: elapsedSec(),
      disposition,
      endReason,
      optOut: disposition === 'opt-out',
      optOutMatched,
      turns: history.length,
      history,
      error: errorMessage,
    };

    // Reporting is best-effort at the transport level but never skipped: an
    // unreported opt-out is the worst failure this system has.
    try {
      const reported = await brain.reportOutcome({
        call: {
          id: callId,
          startedAt,
          durationSec: result.durationSec,
          disposition,
          recordingUrl: null,
        },
        lead: {
          phone: lead.phone,
          name: lead.name || null,
          source: lead.source || null,
          sourceId: lead.sourceId || null,
          crmRecordId: job.crm?.recordId || null,
          campaign: lead.campaign || null,
        },
        history,
      });
      result.reported = reported?.ok === true;
      result.review = reported?.review || null;
    } catch (err) {
      result.reported = false;
      result.reportError = String(err && err.message);
      log('outcome_report_failed', { callId, disposition, error: result.reportError });
    }

    log('call_finished', {
      callId, disposition, endReason,
      durationSec: result.durationSec, turns: result.turns, reported: result.reported,
    });
    return result;
  }
}
