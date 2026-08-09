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
import { splitForSpeech } from '../providers/speech.js';
import { timings } from './timings.js';

// The false-interruption resume below follows the design in livekit/agents
// (Apache-2.0), voice/turn.py. See engineering/LIVEKIT_REFERENCE.md for what was
// adopted, what was not, and why. No LiveKit code is vendored — it is Python and
// WebRTC-first; this is our own implementation of their pattern.

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
  falseInterruptionTimeoutMs, resumeFalseInterruption,
  speculateMs, maxSpeculations, chunkSpeech, chunkMaxChars,
  echoGuard = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const T = timings({
    silenceMs, maxUtteranceMs, minSpeechMs, frameMs, echoTailMs, bargeInMinMs, maxEchoDiscards,
    falseInterruptionTimeoutMs, resumeFalseInterruption,
    speculateMs, maxSpeculations, chunkSpeech, chunkMaxChars,
  });
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
  // Remainder of an utterance cut short by a suspected interruption.
  let pausedSpeech = null;        // { frames, index, pending, text, at }
  // In-flight speculative transcription of the utterance so far.
  let speculation = null;         // { promise, frames }
  let speculations = 0;

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
      // They carried on talking, so anything we guessed at is about a
      // half-sentence. Drop it and let the next pause guess again.
      speculation = null;
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

    // ---- SPECULATIVE TRANSCRIPTION ---------------------------------------
    // The endpointing window is dead time — 900ms of it, set that high on
    // purpose because Indian English and code-mixing pause mid-sentence and a
    // shorter window talks over people. Rather than shorten it, spend it: at
    // `speculateMs` of silence, send what we have to STT and keep waiting. If
    // they really had finished, the transcript is already in hand when the
    // window closes and STT costs nothing on the critical path. If they carry
    // on, the guess is discarded (pushAudio clears it) and the full utterance
    // is transcribed normally. Endpointing accuracy is untouched either way —
    // this buys latency with money, not with interruptions.
    if (!doneTalking && !tooLong && longEnough && buffer.length
        && T.speculateMs > 0 && !speculation && speculations < T.maxSpeculations
        && silentFor >= T.speculateMs) {
      const guess = buffer.slice();
      speculations++;
      const promise = stt.transcribe(guess, lang);
      promise.catch(() => {});     // abandoning it must not crash the process
      speculation = { promise, frames: guess.length };
      log('stt_speculated', { lang, frames: guess.length, afterSilenceMs: silentFor, attempt: speculations });
    }

    if ((longEnough && doneTalking) || tooLong) {
      const chunks = buffer;
      buffer = [];
      speechStartedAt = null;
      lastVoiceAt = null;

      // Usable only if not one frame arrived after we guessed — otherwise it
      // is a transcript of a fragment of what they said.
      const spec = speculation && speculation.frames === chunks.length ? speculation : null;
      speculation = null;
      speculations = 0;

      // Whether our own audio could have been arriving while this was captured.
      const suspect = inEchoWindow(t);
      const resolve = pendingResolve;
      pendingResolve = null;

      if (spec) log('stt_speculation_used', { lang, frames: chunks.length });
      // A speculation that FAILED must not cost the turn: fall back to a fresh
      // transcription rather than reporting silence to the session.
      const transcript = spec
        ? spec.promise.catch(() => stt.transcribe(chunks, lang))
        : stt.transcribe(chunks, lang);

      transcript
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

            // We have positively identified the interrupter as our own voice,
            // so any barge-in it caused was false. Resume immediately rather
            // than waiting out the timeout — a stronger signal than LiveKit's
            // timer, because we know WHY it was false.
            if (pausedSpeech) resumeFalse('self_echo');

            // Keep listening rather than answering ourselves. Bounded, so a
            // persistent echo cannot hang the session forever.
            if (echoDiscards < T.maxEchoDiscards) {
              pendingResolve = resolve;
              return;
            }
            return resolve({ text: null, hangup: false, silent: true });
          }

          // Genuine speech: the interruption was real. Discard the remainder —
          // talking over someone who actually spoke is the failure we started from.
          if (pausedSpeech) { log('paused_speech_discarded', { lang, reason: 'real_speech' }); pausedSpeech = null; }
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
  function tick() {
    maybeEndpoint(now());

    // No transcript materialised after the interruption — it was noise, not a
    // person. Resume. (livekit/agents calls this a "false interruption".)
    if (pausedSpeech && T.resumeFalseInterruption && !speaking
        && (now() - pausedSpeech.at) >= T.falseInterruptionTimeoutMs) {
      resumeFalse('timeout');
    }
  }

  // Bound at the end of the factory, once `api` exists.
  let resumeFalse = () => {};

  const api = {
    pushAudio,
    tick,

    /**
     * Speak. Resolves when playback finished OR was cancelled by barge-in.
     *
     * @param {string} text
     * @param {object} [opts]
     * @param {boolean} [opts.atomic]  synthesize the line whole — see below
     */
    async say(text, { atomic = false } = {}) {
      if (closed) return false;
      const me = { cancelled: false };
      speaking = me;
      // Remember it BEFORE playback: the echo can return before say() resolves.
      echo.noteSpoken(text, now());

      // CHUNKED SYNTHESIS. Rendering the whole line before playing any of it
      // means the prospect waits for the last word to be synthesized before
      // hearing the first — about a second of silence on a two-sentence turn.
      // Split at phrase boundaries and that wait becomes the render time of the
      // first phrase; the rest renders while the earlier audio is playing.
      //
      // `atomic` opts out, and the lines that use it are the reason it exists:
      // a chunked line whose second part fails to render is a TRUNCATED line,
      // and a truncated AI disclosure or opt-out acknowledgement is a
      // compliance failure. Those are said whole and prewarmed instead, so they
      // are fast without ever being splittable.
      const parts = (atomic || !T.chunkSpeech)
        ? [text]
        : splitForSpeech(text, { maxChars: T.chunkMaxChars });
      if (!parts.length) { speaking = null; return false; }

      // Abandoned renders must not surface as unhandled rejections; awaiting
      // the original still throws normally.
      const render = (i) => {
        if (i >= parts.length) return null;
        const p = tts.synth(parts[i], lang);
        p.catch(() => {});
        return p;
      };

      let inflight = render(0);
      let wrote = false;

      for (let p = 0; p < parts.length; p++) {
        let audio;
        try {
          audio = await inflight;
        } catch (err) {
          log('tts_error', { error: String(err && err.message), part: p, parts: parts.length });
          speaking = null;
          // Nothing was said at all — the caller treats that as a failed line.
          // Part-way through, the line is truncated but the call is live, so
          // report success and let the session carry on rather than hanging up.
          if (!wrote) return false;
          playbackEndedAt = now();
          return true;
        }

        // Start the NEXT part rendering before playing this one. That overlap
        // is the whole point; kicking it off after playback would serialise
        // synthesis behind audio again.
        inflight = (me.cancelled || closed) ? null : render(p + 1);

        const frames = audio.frames || [audio.audio];
        const pending = parts.slice(p + 1);

        // PACED playback. Writing every frame in one synchronous loop looks
        // like streaming but is not: the whole utterance lands in the
        // provider's jitter buffer in a single tick, so (a) barge-in can never
        // interrupt mid-sentence because the loop has already finished, and
        // (b) the callee keeps hearing us for as long as that buffer holds —
        // precisely when someone is talking over us to opt out.
        //
        // Each frame is `frameMs` of audio and is written at roughly that
        // cadence. Nothing is waited on before the first frame, so
        // time-to-first-audio stays low; the yield before every later frame is
        // what gives pushAudio() a window to cancel.
        let i = 0;
        for (; i < frames.length; i++) {
          if (wrote) await sleep(T.frameMs);
          if (me.cancelled || closed) break;
          audioOut(frames[i]);
          wrote = true;
        }

        // Interrupted part-way: keep the remainder so it can be resumed if the
        // interruption turns out to be false. Cancelling outright meant one
        // spurious frame of noise cost the rest of the sentence. `pending`
        // carries the parts not yet rendered — the resume re-synthesizes them,
        // which is cheap because a false interruption is rare.
        if (me.cancelled && T.resumeFalseInterruption && !closed
            && (i < frames.length || pending.length)) {
          pausedSpeech = {
            frames, index: i, pending,
            text: [parts[p], ...pending].join(' '),
            at: now(),
          };
          log('speech_paused', {
            lang,
            remainingFrames: frames.length - i,
            pendingParts: pending.length,
            beforePlayback: i === 0,
          });
        }

        if (me.cancelled || closed) break;
      }

      speaking = null;
      playbackEndedAt = now();
      return true;
    },

    /**
     * Resume an utterance that was cut short by an interruption which turned
     * out not to be real. Called when the echo guard positively identifies the
     * interrupter as our OWN voice, or when the false-interruption timeout
     * elapses with no transcript.
     */
    async resumePausedSpeech(reason = 'false_interruption') {
      if (!pausedSpeech || closed) return false;
      const resume = pausedSpeech;
      pausedSpeech = null;

      const me = { cancelled: false };
      speaking = me;
      const pending = resume.pending || [];
      log('speech_resumed', { lang, reason, fromFrame: resume.index, pendingParts: pending.length });

      let wrote = false;
      const play = async (frames, from) => {
        for (let i = from; i < frames.length; i++) {
          if (wrote) await sleep(T.frameMs);
          if (me.cancelled || closed) return false;
          audioOut(frames[i]);
          wrote = true;
        }
        return true;
      };

      let ok = await play(resume.frames, resume.index);
      // Parts that were still queued when the interruption landed were never
      // rendered. Render them now — the alternative is holding synthesized
      // audio for every part of every line on the chance it gets interrupted.
      for (const part of pending) {
        if (!ok) break;
        try {
          const audio = await tts.synth(part, lang);
          ok = await play(audio.frames || [audio.audio], 0);
        } catch (err) {
          log('tts_error', { error: String(err && err.message), phase: 'resume' });
          break;
        }
      }

      speaking = null;
      playbackEndedAt = now();
      return true;
    },

    /**
     * Render lines we already know we are going to say, before we need them.
     * Fire-and-forget by design: it never rejects, and a prewarm that fails
     * costs the latency it would have saved and nothing more.
     */
    async prewarm(texts) {
      if (typeof tts.prewarm !== 'function') return 0;
      try {
        return await tts.prewarm([].concat(texts || []).filter(Boolean), lang);
      } catch {
        return 0;
      }
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
    _pausedSpeech: () => (pausedSpeech
      ? {
        remaining: pausedSpeech.frames.length - pausedSpeech.index,
        pendingParts: (pausedSpeech.pending || []).length,
      }
      : null),
    _isSpeaking: () => Boolean(speaking && !speaking.cancelled),
    _buffered: () => buffer.length,
    _echoDiscards: () => echoDiscards,
    _inEchoWindow: () => inEchoWindow(now()),
    _speculating: () => Boolean(speculation),
  };

  // tick() and the echo-discard branch both need to resume, and both run before
  // `api` exists at their definition site — bind once here.
  resumeFalse = (reason) => { api.resumePausedSpeech(reason).catch(() => {}); };

  return api;
}
