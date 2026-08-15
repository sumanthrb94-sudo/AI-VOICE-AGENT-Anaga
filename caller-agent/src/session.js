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
import { storeRecording } from './recording.js';

export const MAX_TURNS = Number(process.env.CALL_MAX_TURNS || 24);
export const MAX_SECONDS = Number(process.env.CALL_MAX_SECONDS || 300);
export const MAX_SILENT_TURNS = Number(process.env.CALL_MAX_SILENT_TURNS || 2);

export const DEFAULT_DISCLOSURE =
  "Hi, I'm Anaga, an AI voice assistant from Modcon Builders. Is now a good time to talk for a couple of minutes?";

/**
 * The lines the model never writes. They are constants because they are the
 * ones we are accountable for, and being constants is also why they can be
 * rendered before the call needs them — see the prewarm below.
 */
export const FIXED_LINES = {
  nudge: 'Sorry, I did not catch that — are you still there?',
  giveUp: 'I will let you go for now. Thank you for your time!',
  optOut: 'I completely understand. I am adding your number to our do-not-call list now, '
    + 'so you will not receive further calls. Apologies for the disturbance.',
  brainDown: 'I am having a little trouble on my side. Our team will call you back shortly. Thank you!',
};

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
  const say = async (text, opts) => {
    const ok = await telephony.say(text, opts);
    // RECORD WHAT SHE SAID, NOT WHAT SHE WAS GIVEN. say() reports success even
    // when the line was cut off part-way — the call is still live, so it is not
    // a failure — and pushing the generated text here meant the transcript
    // claimed a question she never finished asking. She then reads it back as
    // "already asked" and moves on without the answer; the scorer scores it;
    // and a compliance reviewer reads it as the record of the call.
    if (ok) {
      const said = typeof telephony.spokenText === 'function' ? telephony.spokenText() : '';
      history.push({ role: 'agent', text: said || text });
    }
    return ok;
  };

  // Straight from the persona file. Never model-generated: a hallucinated
  // opening that omits "I am an AI" is a regulatory breach on every call.
  const disclosure = persona?.disclosure?.[lang]
    || persona?.disclosure?.['en-IN']
    || DEFAULT_DISCLOSURE;

  try {
    // ---- 0. render what we already know we will say ----------------------
    // Every line below is a constant, and one of them is the first thing said
    // on the call. Rendering them while the phone RINGS costs nothing —
    // there are seconds of dead air there anyway — and turns the opt-out
    // acknowledgement in particular from a second of vendor latency into
    // instant, which is the one line where a delay is indefensible. Not
    // awaited: a slow or broken TTS must never hold up the dial.
    if (typeof telephony.prewarm === 'function') {
      Promise.resolve(telephony.prewarm([disclosure, ...Object.values(FIXED_LINES)]))
        .catch(() => {});
    }

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
    // Said ATOMICALLY. Everything else is split into phrases and streamed so
    // the first words start sooner, but a disclosure whose second half fails to
    // render is a call that never said "I am an AI" — worse than a slow one.
    // It is prewarmed above, so it is fast without being splittable.
    if (!(await say(disclosure, { atomic: true }))) {
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
        await say(silentTurns === 1 ? FIXED_LINES.nudge : FIXED_LINES.giveUp);
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
        // Atomic, like the disclosure: a half-spoken promise to stop calling
        // someone is the worst line on the call to truncate.
        await say(FIXED_LINES.optOut, { atomic: true });
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
        await say(FIXED_LINES.brainDown);
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

    // ---- recording ---------------------------------------------------------
    // Uploaded BEFORE the outcome is reported, so the reference can travel with
    // it — but never allowed to block the report. docs/COMPLIANCE.md wants the
    // recording; an unreported opt-out is still the worse failure, so a storage
    // outage costs us the audio and nothing else.
    let recordingRef = null;
    if (typeof telephony.recording === 'function') {
      try {
        const audio = await telephony.recording();
        if (audio && audio.length) {
          const put = await storeRecording({ callId, audio, startedAt });
          recordingRef = put.ref;
          if (!put.ok) {
            log('recording_not_stored', { callId, error: put.error, severity: 'high' });
          }
        }
      } catch (err) {
        log('recording_capture_failed', { callId, error: String(err && err.message) });
      }
    }
    result.recordingRef = recordingRef;

    // Reporting is best-effort at the transport level but never skipped: an
    // unreported opt-out is the worst failure this system has.
    try {
      const reported = await brain.reportOutcome({
        call: {
          id: callId,
          startedAt,
          durationSec: result.durationSec,
          disposition,
          // An opaque s3:// reference. The API rejects playable URLs outright —
          // see api/_lib/recording.js.
          recordingRef,
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
