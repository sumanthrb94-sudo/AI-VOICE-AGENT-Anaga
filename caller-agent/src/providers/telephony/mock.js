// caller-agent/src/providers/telephony/mock.js
//
// The telephony adapter that makes this system QA-testable.
//
// Real telephony needs credentials, a 160-series number, a DLT registration and
// a human on the other end — none of which exist in CI. This adapter implements
// the exact same interface as the Plivo/Exotel ones and drives a SCRIPTED
// PROSPECT instead, so the full path (dial job → turn loop → disclosure →
// qualification → opt-out → outcome → CRM) runs deterministically in a test.
//
// It is not a stub that returns success. It models the things that actually go
// wrong on Indian telephony: no-answer, busy, the callee hanging up mid-turn,
// and speech that arrives garbled. If a bug only shows up on a real call, this
// adapter should be extended until it shows up here too.

/**
 * A scripted prospect. `replies` are consumed in order; each may be:
 *   - a string: what the prospect says on that turn
 *   - { say, delayMs }: the same, with simulated think-time
 *   - { hangup: true }: the prospect drops the call at this point
 */
export function createMockTelephony({
  outcome = 'answered',        // answered | no_answer | busy | failed
  replies = [],
  answerDelayMs = 0,
  hangupAfterTurns = null,
} = {}) {
  let turn = 0;
  let live = false;
  let ended = null;
  const spoken = [];

  return {
    id: 'mock',

    /** Place the call. Resolves once the callee picks up (or doesn't). */
    async dial({ to, from, callId }) {
      if (answerDelayMs) await new Promise((r) => setTimeout(r, answerDelayMs));
      if (outcome !== 'answered') {
        ended = outcome;
        return { answered: false, reason: outcome, callId, to, from };
      }
      live = true;
      return { answered: true, reason: null, callId, to, from };
    },

    /** Play a line to the callee. Returns false if the call is already dead. */
    async say(text) {
      if (!live) return false;
      spoken.push(text);
      return true;
    },

    /**
     * Wait for the callee's next utterance.
     * @returns {Promise<{text:string|null, hangup:boolean, silent:boolean}>}
     */
    async listen() {
      if (!live) return { text: null, hangup: true, silent: false };

      if (hangupAfterTurns != null && turn >= hangupAfterTurns) {
        live = false;
        ended = 'callee_hangup';
        return { text: null, hangup: true, silent: false };
      }

      const next = replies[turn++];
      if (next == null) {
        // Ran out of script: the callee went silent. Real calls do this.
        return { text: null, hangup: false, silent: true };
      }
      if (typeof next === 'object' && next.hangup) {
        live = false;
        ended = 'callee_hangup';
        return { text: null, hangup: true, silent: false };
      }
      const say = typeof next === 'object' ? next.say : next;
      if (typeof next === 'object' && next.delayMs) {
        await new Promise((r) => setTimeout(r, next.delayMs));
      }
      return { text: String(say), hangup: false, silent: false };
    },

    /** Tear the call down. Idempotent. */
    async hangup(reason = 'agent_ended') {
      if (live) ended = reason;
      live = false;
      return { ended: ended || reason };
    },

    // --- test introspection (mock only; not part of the interface) --------
    _spoken: () => spoken.slice(),
    _ended: () => ended,
    _isLive: () => live,
  };
}
