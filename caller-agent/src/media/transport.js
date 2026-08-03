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
// This module is transport-agnostic: it takes an `audioOut` sink and is fed by
// `pushAudio()`. The Plivo/Exotel WebSocket servers wire those up; the test
// harness wires them to arrays. Same code path either way.

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
 */
export function createMediaTransport({
  stt, tts, audioOut, lang = 'en-IN', now = () => Date.now(), log = () => {},
  silenceMs, maxUtteranceMs, minSpeechMs,
} = {}) {
  const T = timings({ silenceMs, maxUtteranceMs, minSpeechMs });
  /** @type {Array<Buffer>} */
  let buffer = [];
  let speechStartedAt = null;
  let lastVoiceAt = null;
  let pendingResolve = null;
  let closed = false;

  // Set while TTS is playing so barge-in can cancel it.
  let speaking = null;   // { cancelled: boolean }

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
      // ---- BARGE-IN: cancel playback the instant the prospect speaks ----
      if (speaking && !speaking.cancelled) {
        speaking.cancelled = true;
        log('barge_in', { lang });
      }
      if (speechStartedAt == null) speechStartedAt = t;
      lastVoiceAt = t;
      buffer.push(chunk);
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

      const resolve = pendingResolve;
      pendingResolve = null;

      stt.transcribe(chunks, lang)
        .then((text) => resolve({ text: text || null, hangup: false, silent: !text }))
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

      let audio;
      try {
        audio = await tts.synth(text, lang);
      } catch (err) {
        log('tts_error', { error: String(err && err.message) });
        speaking = null;
        return false;
      }

      if (me.cancelled) { speaking = null; return true; }

      // Chunked so barge-in can stop mid-sentence rather than at the end of it.
      for (const frame of audio.frames || [audio.audio]) {
        if (me.cancelled || closed) break;
        audioOut(frame);
      }
      speaking = null;
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
  };
}
