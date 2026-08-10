// caller-agent/src/media/timings.js
//
// Every clock in the audio leg, in one place, with what each one costs.
//
// This file exists because "the agent feels slow" is almost never one thing. A
// turn is a chain of waits, and the only way to argue about which to shorten is
// to see them side by side:
//
//   prospect stops talking
//     +900ms   silenceMs        waiting to be sure they finished        (below)
//     + ~0ms   STT              overlapped — see speculateMs            (transport.js)
//     +  ?ms   the brain        one HTTP round trip to /api/anaga/turn  (brain.js)
//     +~600ms  TTS first phrase render of phrase one only               (transport.js say)
//   first audio reaches their ear
//
// The 900ms is the one everybody reaches for first, and it is the one to leave
// alone. It is high on purpose: Indian English and Hindi/Telugu code-mixing
// pause mid-sentence far longer than the ~500ms Western default assumes, and
// every millisecond cut off it buys latency by talking over people. The two
// knobs below it — speculateMs and chunkSpeech — buy the same latency by
// overlapping work instead, which costs money rather than interruptions.
//
// Defaults come from env, but every one is overridable PER TRANSPORT, and they
// are read at construction rather than at import: pacing differs by language,
// so a single process must be able to run different values on different calls.

export function timings(o = {}) {
  return {
    // ---- endpointing: deciding they have finished ------------------------
    silenceMs: Number(o.silenceMs ?? process.env.ENDPOINT_SILENCE_MS ?? 900),
    maxUtteranceMs: Number(o.maxUtteranceMs ?? process.env.MAX_UTTERANCE_MS ?? 20000),
    minSpeechMs: Number(o.minSpeechMs ?? process.env.MIN_SPEECH_MS ?? 200),

    // SPECULATIVE TRANSCRIPTION. How much silence before we send what we have
    // to STT while STILL waiting out the full endpointing window, so that
    // transcription is already done when the window closes. See maybeEndpoint().
    // Set to 0 to disable and pay for STT serially instead.
    speculateMs: Number(o.speculateMs ?? process.env.ENDPOINT_SPECULATE_MS ?? 400),

    // ── SEMANTIC ENDPOINTING (media/turn-detect.js) ────────────────────────
    // The speculative transcript above is not only a latency trick: it is the
    // evidence for whether they FINISHED or merely PAUSED. These two knobs are
    // the window that replaces silenceMs when there is an opinion — and only
    // then. Both stay inside maxUtteranceMs, and silenceMs remains the fallback
    // for every utterance we have no opinion about, which is most of them.
    //
    // semanticCloseMs is short on purpose: it applies only after a transcript
    // that reads as a finished answer ("no", "three BHK"), where the remaining
    // wait is the agent visibly not listening.
    semanticCloseMs: Number(o.semanticCloseMs ?? process.env.ENDPOINT_SEMANTIC_CLOSE_MS ?? 350),
    // And the other direction: a dangling "and…" or a bare number buys MORE
    // patience, because interrupting a prospect mid-sentence is the rudest
    // thing this agent can do and the one a shorter fixed threshold causes.
    hesitationFactor: Number(o.hesitationFactor ?? process.env.ENDPOINT_HESITATION_FACTOR ?? 1.6),
    // Explicit false wins; otherwise ENDPOINT_SEMANTIC=0 turns it off; otherwise on.
    semanticEndpointing: o.semanticEndpointing === false
      ? false
      : process.env.ENDPOINT_SEMANTIC !== '0',
    // Each speculation is a billed STT call that may be thrown away, so a
    // rambling caller with many pauses is capped rather than unbounded.
    maxSpeculations: Number(o.maxSpeculations ?? process.env.ENDPOINT_MAX_SPECULATIONS ?? 2),

    // ---- playback --------------------------------------------------------
    // How much audio one frame represents, and therefore the pacing interval
    // for outbound playback. Must match the framing in providers/speech.js.
    frameMs: Number(o.frameMs ?? process.env.TTS_FRAME_MS ?? 20),
    // CHUNKED SYNTHESIS. Split a line at phrase boundaries and start playing
    // the first phrase while the rest renders. See say().
    chunkSpeech:
      (o.chunkSpeech ?? process.env.TTS_CHUNK_SPEECH) !== false
      && String(process.env.TTS_CHUNK_SPEECH ?? 'true') !== 'false',
    chunkMaxChars: Number(o.chunkMaxChars ?? process.env.TTS_CHUNK_MAX_CHARS ?? 140),

    // ---- echo and interruption -------------------------------------------
    // How long after playback ends our own audio can still arrive. Covers the
    // provider jitter buffer plus line round-trip; 250ms is generous for
    // domestic Indian routes and still well under a human's reply latency.
    echoTailMs: Number(o.echoTailMs ?? process.env.ECHO_TAIL_MS ?? 250),
    // Barge-in needs SUSTAINED speech, not one frame. A single echo burst must
    // not cancel our own utterance; a human interrupting speaks for longer.
    bargeInMinMs: Number(o.bargeInMinMs ?? process.env.BARGE_IN_MIN_MS ?? 240),
    // After this many consecutive echo discards, report silence so the session
    // can make progress instead of waiting forever.
    maxEchoDiscards: Number(o.maxEchoDiscards ?? process.env.MAX_ECHO_DISCARDS ?? 4),
    // FALSE-INTERRUPTION RESUME (pattern from livekit/agents, Apache-2.0 —
    // voice/turn.py `resume_false_interruption` / `false_interruption_timeout`,
    // default 2.0s). Barge-in used to CANCEL playback outright, so a cough, a
    // burst of line noise, or our own echo permanently swallowed the rest of
    // Anaga's sentence. Instead we PAUSE, and resume if the interruption turns
    // out to be nothing.
    falseInterruptionTimeoutMs:
      Number(o.falseInterruptionTimeoutMs ?? process.env.FALSE_INTERRUPTION_TIMEOUT_MS ?? 2000),
    resumeFalseInterruption:
      (o.resumeFalseInterruption ?? process.env.RESUME_FALSE_INTERRUPTION) !== false
      && String(process.env.RESUME_FALSE_INTERRUPTION ?? 'true') !== 'false',
  };
}
