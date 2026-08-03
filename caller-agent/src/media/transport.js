// caller-agent/src/media/transport.js
//
// The audio leg of a live call: turns a raw bidirectional audio stream into the
// say()/listen() interface session.js is written against.
//
//   telephony audio in  -> STT -> endpointing -> listen() resolves with text
//   say(text)           -> TTS -> telephony audio out, interruptible
//
// The two hard problems in voice agents both live here:
//
//   ENDPOINTING — deciding the prospect has finished speaking. Too eager and
//   you interrupt someone mid-sentence; too patient and the call feels dead.
//   Indian English + code-mixing has longer intra-sentence pauses than US
//   English, so the silence threshold is deliberately higher than the ~500ms
//   Western default and is tunable per deployment.
//
//   BARGE-IN — the prospect talking over the agent. When speech is detected
//   while we are speaking, playback is cancelled IMMEDIATELY. A voice agent
//   that talks over a person who is trying to opt out is the worst failure
//   this system can have, so barge-in cancels TTS before anything else.
//
//   SELF-ECHO — our own audio returning on the receive path and being
//   transcribed as the prospect. Left unguarded this loops: the agent answers
//   itself forever (reproduced in scripts/simulate-echo.mjs: 49 turns, 24
//   billed LLM calls). Guarded here by timing (playback window + echo tail),
//   a sustained-speech requirement for barge-in, and a content check against
//   what we recently said (shared/echo-guard.js).
//
// This module is transport-agnostic: it takes an `audioOut` sink and is fed by
// `pushAudio()`. The Plivo/Exotel WebSocket servers wire those up; the test
// harness wires them to arrays. Same code path either way.

import { createEchoGuard } from '../../../shared/echo-guard.js';

// Timing defaults come from env, but every one is overridable PER TRANSPORT.
// They are read at construction, not at import: pacing differs by language
// (Telugu and Hindi speakers pause longer mid-sentence than the ~500ms Western
// default assumes), so a single process must be able to run different values
// on different calls.
function timings(o = {}) {
  return {
    silenceMs: Number(o.silenceMs ?? process.env.ENDPOINT_SILENCE_MS ?? 900),
    maxUtteranceMs: Number(o.maxUtteranceMs ?? process.env.MAX_UTTERANCE_MS ?? 20000),
    minSpeechMs: Number(o.minSpeechMs ?? process.env.MIN_SPEECH_MS ?? 200),
    // How much audio one frame represents, and therefore the pacing interval
    // for outbound playback. Must match the framing in providers/speech.js.
    frameMs: Number(o.frameMs ?? process.env.TTS_FRAME_MS ?? 20),
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
  };
}

/**
 * @param {object} deps
 * @param {object} deps.stt        { transcribe(audioChunks, lang) -> string }
 * @param {object} deps.tts        { synth(text, lang) -> { audio, mime } }
 * @param {function} deps.audioOut (chunk) => void — send audio to the callee
 * @param {string} [deps.lang]
 * @param {function} [deps.now]
 * @param {function} [deps.log]
 * @param {number} [deps.silenceMs]       endpointing threshold for this call
 * @param {number} [deps.maxUtteranceMs]  hard ceiling on one utterance
 * @param {number} [deps.minSpeechMs]     below this it is a cough, not a turn
 * @param {number} [deps.frameMs]         playback pacing interval
 * @param {function} [deps.sleep]         injectable delay, for deterministic tests
 */
export function createMediaTransport({
  stt, tts, audioOut, lang = 'en-IN', now = () => Date.now(), log = () => {},
  silenceMs, maxUtteranceMs, minSpeechMs, frameMs, echoTailMs, bargeInMinMs, maxEchoDiscards,
  echoGuard = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const T = timings({ silenceMs, maxUtteranceMs, minSpeechMs, frameMs, echoTailMs, bargeInMinMs, maxEchoDiscards });
  const echo = echoGuard || createEchoGuard({ now });
  /** @type {Array<Buffer>} */
  let buffer = [];
  let speechStartedAt = null;
  let lastVoiceAt = null;
  let pendingResolve = null;
  let closed = false;

  // Set while TTS is playing so barge-in can cancel it.
  let speaking = null;        // { cancelled: boolean }
  let playbackEndedAt = -Infinity;
  let voiceRunStartedAt = null;   // start of the current continuous voice run
  let echoDiscards = 0;

  /** True while our own audio could still be arriving on the receive path. */
  function inEchoWindow(t) {
    return Boolean(speaking) || (t - playbackEndedAt) < T.echoTailMs;
  }

  function isVoice(chunk, hasVoice) {
    // The transport does not do its own VAD: telephony providers and STT
    // vendors both supply voice-activity flags, and re-deriving them from raw
    // PCM here would be a worse copy. `hasVoice` is that signal.
    return hasVoice === true || (hasVoice == null && chunk && chunk.length > 0);
  }

  /** Feed one inbound audio frame. Called by the WebSocket media server. */
  function pushAudio(chunk, { hasVoice } = {}) {
    if (closed) return;
    const t = now();

    if (isVoice(chunk, hasVoice)) {
      // Track how long voice has been continuous, so barge-in can require a
      // sustained run rather than firing on a single echo frame.
      if (voiceRunStartedAt == null || (t - (lastVoiceAt ?? t)) > T.silenceMs) {
        voiceRunStartedAt = t;
      }

      // ---- BARGE-IN, but only on SUSTAINED speech --------------------------
      // Firing on one frame meant our own echo cancelled our own utterance.
      if (speaking && !speaking.cancelled && (t - voiceRunStartedAt) >= T.bargeInMinMs) {
        speaking.cancelled = true;
        playbackEndedAt = t;
        log('barge_in', { lang, sustainedMs: t - voiceRunStartedAt });
      }

      if (speechStartedAt == null) speechStartedAt = t;
      lastVoiceAt = t;
      buffer.push(chunk);
    } else {
      voiceRunStartedAt = null;
    }

    maybeEndpoint(t);
  }

  function maybeEndpoint(t) {
    if (!pendingResolve || speechStartedAt == null) return;

    const spokeFor = t - speechStartedAt;
    const silentFor = t - (lastVoiceAt ?? t);

    const longEnough = spokeFor >= T.minSpeechMs;
    const doneTalking = silentFor >= T.silenceMs;
    const tooLong = spokeFor >= T.maxUtteranceMs;

    if ((longEnough && doneTalking) || tooLong) {
      const chunks = buffer;
      buffer = [];
      speechStartedAt = null;
      lastVoiceAt = null;

      // Whether our own audio could have been arriving while this was captured.
      const suspect = inEchoWindow(t);
      const resolve = pendingResolve;
      pendingResolve = null;

      stt.transcribe(chunks, lang)
        .then((text) => {
          if (!text) return resolve({ text: null, hangup: false, silent: true });

          // ---- CONTENT CHECK: is this us, coming back? --------------------
          const verdict = echo.check(text, t, { duringPlayback: suspect });
          if (verdict.isEcho) {
            echoDiscards++;
            log('self_echo_discarded', {
              lang, score: Number(verdict.score.toFixed(2)),
              duringPlayback: suspect, discards: echoDiscards,
              heard: String(text).slice(0, 60),
            });

            // Keep listening rather than answering ourselves. Bounded, so a
            // persistent echo cannot hang the session forever.
            if (echoDiscards < T.maxEchoDiscards) {
              pendingResolve = resolve;
              return;
            }
            return resolve({ text: null, hangup: false, silent: true });
          }

          echoDiscards = 0;
          return resolve({ text, hangup: false, silent: false });
        })
        .catch((err) => {
          log('stt_error', { error: String(err && err.message) });
          // A failed transcription is silence, not a hangup — the session
          // nudges once and moves on rather than dropping the call.
          resolve({ text: null, hangup: false, silent: true });
        });
    }
  }

  /** Called by the media server on a silence timer tick. */
  function tick() { maybeEndpoint(now()); }

  return {
    pushAudio,
    tick,

    /** Speak. Resolves when playback finished OR was cancelled by barge-in. */
    async say(text) {
      if (closed) return false;
      const me = { cancelled: false };
      speaking = me;
      // Remember it BEFORE playback: the echo can return before say() resolves.
      echo.noteSpoken(text, now());

      let audio;
      try {
        audio = await tts.synth(text, lang);
      } catch (err) {
        log('tts_error', { error: String(err && err.message) });
        speaking = null;
        return false;
      }

      if (me.cancelled) { speaking = null; playbackEndedAt = now(); return true; }

      // PACED playback. Writing every frame in one synchronous loop looks like
      // streaming but is not: the whole utterance lands in the provider's
      // jitter buffer in a single tick, so (a) barge-in can never interrupt
      // mid-sentence because the loop has already finished, and (b) the callee
      // keeps hearing us for as long as that buffer holds — precisely when
      // someone is talking over us to opt out.
      //
      // Each frame represents `frameMs` of audio, so it is written at roughly
      // that cadence. The first frame goes out immediately to keep
      // time-to-first-audio low; the yield between frames is what gives
      // pushAudio() a window to cancel.
      const frames = audio.frames || [audio.audio];
      for (let i = 0; i < frames.length; i++) {
        if (me.cancelled || closed) break;
        audioOut(frames[i]);
        if (i < frames.length - 1) await sleep(T.frameMs);
      }
      speaking = null;
      playbackEndedAt = now();
      return true;
    },

    /** Wait for the prospect's next utterance. */
    listen() {
      if (closed) return Promise.resolve({ text: null, hangup: true, silent: false });
      return new Promise((resolve) => {
        pendingResolve = resolve;
        maybeEndpoint(now());
      });
    },

    close(reason = 'closed') {
      closed = true;
      if (speaking) speaking.cancelled = true;
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r({ text: null, hangup: true, silent: false });
      }
      log('media_closed', { reason });
    },

    // test introspection
    _isSpeaking: () => Boolean(speaking && !speaking.cancelled),
    _buffered: () => buffer.length,
    _echoDiscards: () => echoDiscards,
    _inEchoWindow: () => inEchoWindow(now()),
  };
}
