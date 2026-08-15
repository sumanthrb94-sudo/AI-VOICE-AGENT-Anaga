// caller-agent/src/agent/bridge.js
//
// One live conversation: audio in, audio out, over a connection that stays open.
//
// ── WHY THIS SHAPE ────────────────────────────────────────────────────────
// It is TRANSPORT-AGNOSTIC on purpose. It takes an `onAudio` sink and is fed by
// `pushAudio()`, and knows nothing about whether the bytes came from a browser
// or from a phone. Deepgram's own reference implementation calls this a
// "protocol-agnostic server" and it is the reason the Twilio leg is nearly
// free: a browser and a Twilio Media Stream carry the same PCM through the same
// bridge, and only the envelope around it differs.
//
// ── WHAT IT REPLACES ──────────────────────────────────────────────────────
// The whole request/response turn in api/anaga/turn.js, and with it every
// heuristic the browser had to grow because the transport could not stream:
// the energy VAD, the adaptive silence window, the barge-in guess, the
// first-phrase splitter, the LLM stream-scanning, and the backchannel that
// existed only to cover dead air.
//
// ── WHAT IT KEEPS, DELIBERATELY ───────────────────────────────────────────
// The flow and persona as the prompt, Sarvam Bulbul as her actual voice, and
// the opt-out. Deepgram's all-in-one agent would take all three (see
// docs/ARCHITECTURE.md §5) and its `UserStartedSpeaking` event does not know
// about the DND registry.

import { openLiveSTT } from '../../../shared/deepgram-live.js';
import { splitForSpeech } from '../../../shared/speech-split.js';
import { createCallUsageLedger, audioDurationMs } from '../../../shared/call-usage.js';

/**
 * @param {object} o
 * @param {string}   o.lang            call language, BCP-47
 * @param {string}   [o.direction]     'outbound' | 'inbound'
 * @param {function} o.onAudio         (Buffer) => void — her voice, to the caller
 * @param {function} o.onEvent         ({type,...}) => void — transcript/state, for the UI
 * @param {function} o.think           (history) => Promise<{say,end,disposition}>
 * @param {function} o.speak           (text, lang, audio) => Promise<Buffer|{audio: Buffer, provider?: string, cached?: boolean}> — TTS
 * @param {string}   [o.sttProvider]   configured live recognizer identity, for metering
 * @param {string}   [o.ttsProvider]   configured synthesis-chain identity, for fallback metering
 * @param {object}   [o.usageLedger]   call-scoped, non-PII usage collector
 * @param {function} [o.isOptOut]      (text) => boolean — ours, never the model's
 * @param {function} [o.openSTT]       test seam
 */
export function createBridge(o) {
  const {
    lang, direction = 'outbound', onAudio, onEvent, think, speak,
    isOptOut = () => false, openSTT = openLiveSTT,
    sttProvider = process.env.LIVE_STT_PROVIDER || 'deepgram',
    ttsProvider = process.env.TTS_PROVIDER || 'unknown',
    usageLedger = createCallUsageLedger(),
    // The transport's format, carried end to end. The browser sends 16kHz
    // linear16; a phone sends 8kHz mulaw. Both the recogniser and the voice are
    // asked for the SAME format the transport speaks, so a call transcodes
    // nowhere — see caller-agent/src/agent/twilio.js.
    audio = { encoding: 'linear16', sampleRate: 16000 },
  } = o;

  const history = [];
  let ended = false;
  let speaking = false;
  // Bumped every time she is interrupted. Audio rendered for an older turn is
  // dropped rather than played late — without this, a barge-in silences her for
  // a moment and then the superseded sentence arrives anyway.
  let turnId = 0;
  let partial = '';
  let thinking = false;

  const emit = (e) => { try { if (onEvent) onEvent(e); } catch { /* the UI's problem */ } };

  /** Stop talking, now, mid-word. */
  function cutOff() {
    if (!speaking) return;
    speaking = false;
    turnId++;
    // The transport clears whatever it has buffered — a phone line holds
    // hundreds of milliseconds of audio that is already gone from here.
    emit({ type: 'clear' });
    const last = history[history.length - 1];
    if (last && last.role === 'agent' && !/…\[cut off\]$/.test(last.text)) {
      last.text += ' …[cut off]';
      emit({ type: 'agent_cut_off' });
    }
  }

  const stt = openSTT({
    lang,
    encoding: audio.encoding,
    sampleRate: audio.sampleRate,
    onEvent(e) {
      if (ended) return;
      if (e.type === 'speech_start') {
        // BARGE-IN, as an event rather than a guess. This is the single line
        // that replaces the energy threshold, the timing window and the content
        // check that all failed on real hardware.
        emit({ type: 'user_started' });
        cutOff();
        return;
      }
      if (e.type === 'transcript') {
        if (!e.final) { partial = e.text; emit({ type: 'partial', text: e.text }); return; }
        partial = '';
        emit({ type: 'heard', text: e.text });
        void answer(e.text);
        return;
      }
      if (e.type === 'error') emit({ type: 'error', text: e.text });
    },
    // ── A DEAD RECOGNISER ENDS THE CALL. IT DOES NOT CONTINUE IT. ─────────
    //
    // This used to emit a UI error and stop there. Nothing else changed:
    // `ended` stayed false, the transport kept streaming, deepgram-live.js
    // kept pushing every PCM chunk into an unbounded `pending` array, and
    // pushAudio() kept metering STT usage for audio that reached no vendor.
    //
    // What the prospect experienced was a live call in which Anaga never
    // responded again — for the rest of the call, with no explanation and no
    // hang-up. That is worse than a dropped call, and we were billing for it.
    //
    // There is no reconnect here on purpose: a recogniser that has gone away
    // mid-call has already lost the audio spoken since, so "resume" would mean
    // answering a question we did not hear the start of. Fail closed instead —
    // the same rule the compliance gate follows.
    onClose() {
      if (ended) return;
      emit({ type: 'error', text: 'stt_closed' });
      emit({ type: 'stt_lost', text: 'the recogniser closed mid-call; ending rather than continuing deaf' });
      finish();
    },
  });

  /** One turn: their words in, her voice out. */
  async function answer(heard) {
    if (ended) return;

    // ── OPT-OUT IS CHECKED BEFORE THE `thinking` GUARD, NOT AFTER ─────────
    //
    // This used to read `if (ended || thinking) return;` on the line above,
    // with the opt-out test below it. That meant an opt-out spoken while the
    // model was mid-thought was dropped ENTIRELY: not suppressed, not
    // answered, not even pushed into history. It left no trace anywhere.
    //
    // And that window is exactly when it happens. The 1-3 seconds she is
    // thinking is the most likely moment for somebody to cut in with "don't
    // call me" — barge-in clears `speaking`, but nothing cleared `thinking`.
    //
    // docs/COMPLIANCE.md and CLAUDE.md both put this first: opt-out reaches
    // the suppression list before anything else and overrides whatever the
    // agent reports. A turn-ordering guard is not allowed to be the thing
    // that swallows it.
    if (isOptOut(heard)) {
      history.push({ role: 'user', text: heard });
      // Abandon whatever is in flight. Bumping turnId makes the superseded
      // turn's audio undeliverable even though its think() is still running.
      thinking = false;
      cutOff();
      const bye = await sayBye();
      emit({ type: 'disposition', value: 'opt-out' });
      const said = await play(bye, ++turnId);
      markIfUndelivered(said, 'the opt-out confirmation');
      finish();
      return;
    }

    // Ordinary speech during a think is still dropped — one turn at a time is
    // the design — but it is now VISIBLE rather than silent, because "she
    // ignored me" is a real complaint and this is one of its causes.
    if (thinking) {
      emit({ type: 'dropped_while_thinking', text: heard });
      return;
    }
    thinking = true;
    history.push({ role: 'user', text: heard });

    let out;
    try {
      out = await think(history);
      // The composition root can return the provider that actually served the
      // turn. The bridge accepts "unknown" for test doubles and legacy callers;
      // unit counts remain useful even when a provider does not expose usage.
      usageLedger.recordLLM({
        provider: out?.provider || process.env.LLM_PROVIDER || 'unknown',
        inputChars: history.reduce((sum, turn) => sum + String(turn.text || '').length, 0),
        outputChars: String(out?.say || '').length,
      });
    } catch (err) {
      thinking = false;
      emit({ type: 'error', text: `brain: ${err?.message || 'unavailable'}` });
      return;
    }
    thinking = false;
    if (ended || !out?.say) return;

    history.push({ role: 'agent', text: out.say });
    emit({ type: 'said', text: out.say, disposition: out.disposition });
    const mine = ++turnId;
    const said = await play(out.say, mine);
    // Only amend if this turn is still current — a barge-in is already
    // recorded by cutOff() and must not be relabelled a voice failure.
    if (mine === turnId) markIfUndelivered(said);
    if (out.end === true && mine === turnId) finish();
  }

  /**
   * Speak a line, phrase by phrase, checking after every one whether she has
   * been superseded. Rendering the whole line first would mean an interruption
   * is only honoured once the sentence has finished being made.
   */
  /**
   * @returns {Promise<{of:number, delivered:number, failed:string|null}>}
   *   How much of the line actually reached the prospect. The caller needs
   *   this because `history` is the compliance record, and it used to claim
   *   every line was spoken in full — see markIfUndelivered().
   */
  async function play(text, mine) {
    speaking = true;
    emit({ type: 'speaking', value: true });
    const phrases = splitForSpeech(text);
    let delivered = 0;
    let failed = null;
    for (const phrase of phrases) {
      if (ended || mine !== turnId) break;
      let audio_;
      try {
        const synthesized = await speak(phrase, lang, audio);
        // Existing transports return a Buffer. The composition root returns the
        // optional object form so a fallback provider can be counted honestly.
        audio_ = Buffer.isBuffer(synthesized) ? synthesized : synthesized?.audio;
        if (!Buffer.isBuffer(audio_)) throw new Error('voice returned no audio buffer');
        usageLedger.recordTTS({
          provider: synthesized?.provider || String(ttsProvider).split(',')[0] || 'unknown',
          chars: String(phrase).length,
          audioMs: audioDurationMs(audio_.length, audio),
          cached: synthesized?.cached === true,
        });
      } catch (err) {
        failed = String(err?.message || 'unavailable');
        emit({ type: 'error', text: `voice: ${failed}` });
        break;
      }
      // Checked AGAIN after the await: synthesis takes a second or more, and
      // she may have been interrupted while it was happening.
      if (ended || mine !== turnId) break;
      try { onAudio(audio_); } catch { /* the transport is gone */ }
      delivered++;
    }
    if (mine === turnId) {
      speaking = false;
      emit({ type: 'speaking', value: false });
    }
    return { of: phrases.length, delivered, failed };
  }

  /**
   * THE TRANSCRIPT MUST NOT CLAIM SHE SAID SOMETHING NOBODY HEARD.
   *
   * history.push({role:'agent'}) and the `said` event both fire BEFORE play()
   * runs, so a line was recorded as spoken and then, if synthesis failed
   * halfway, the loop simply broke. The record kept the whole sentence. On the
   * greeting that sentence is the AI DISCLOSURE, which makes the transcript —
   * the thing that would be produced as evidence if a complaint were ever
   * raised — assert that disclosure happened when the prospect heard silence.
   *
   * cutOff() already did this correctly for barge-in ("…[cut off]"). This is
   * the same idea for a voice that failed rather than a prospect who
   * interrupted.
   */
  function markIfUndelivered(result, what = 'the reply') {
    if (!result || result.delivered >= result.of) return false;
    const partial_ = result.delivered > 0;
    const note = partial_
      ? ` …[only ${result.delivered} of ${result.of} phrases reached the caller: ${result.failed || 'interrupted'}]`
      : ` …[NOT SPOKEN — the caller heard nothing: ${result.failed || 'interrupted'}]`;
    const last = history[history.length - 1];
    if (last && last.role === 'agent' && !/…\[/.test(last.text)) last.text += note;
    emit({
      type: 'not_delivered',
      what,
      delivered: result.delivered,
      of: result.of,
      reason: result.failed || 'interrupted',
    });
    return true;
  }

  async function sayBye() {
    const BYE = {
      'te-IN': 'సరే, అర్థమైంది. మీ నంబర్‌ని డు-నాట్-కాల్ లిస్ట్‌లో యాడ్ చేస్తున్నాను. డిస్టర్బ్ చేసినందుకు సారీ.',
      'hi-IN': 'ठीक है, समझ गयी। मैं आपका नंबर डू-नॉट-कॉल लिस्ट में डाल देती हूँ। डिस्टर्ब करने के लिए सॉरी।',
      'en-IN': "Understood. I'll add your number to our do-not-call list right away. Sorry to disturb you.",
    };
    const line = BYE[lang] || BYE['en-IN'];
    history.push({ role: 'agent', text: line });
    emit({ type: 'said', text: line, disposition: 'opt-out' });
    return line;
  }

  function finish() {
    if (ended) return;
    ended = true;
    try { stt.close(); } catch { /* already gone */ }
    // Emit numeric-only usage before the final conversation event. It may be
    // persisted by an authenticated caller-agent, but it never contains audio,
    // phone numbers, prompts, or transcript text.
    emit({ type: 'usage', direction, usage: usageLedger.close() });
    emit({ type: 'ended', history });
  }

  return {
    /** Raw PCM from the caller, as it arrives. Count bytes, never keep them. */
    pushAudio(pcm) {
      if (ended) return;
      const bytes = Buffer.isBuffer(pcm) ? pcm.length : (pcm?.byteLength || 0);
      usageLedger.recordSTT({ provider: sttProvider, audioMs: audioDurationMs(bytes, audio) });
      stt.send(pcm);
    },
    /** Her opening line — outbound calls speak first. */
    async greet(line) {
      // A FALSY LINE HERE IS A COMPLIANCE FAILURE, NOT A NO-OP. The greeting
      // is the AI disclosure. Returning quietly meant a prospect answered the
      // phone, heard nothing, and Anaga joined mid-conversation having never
      // identified herself. The caller (server.js) decides whether to hang up;
      // this makes sure it is TOLD.
      if (ended) return { of: 0, delivered: 0, failed: 'call already ended' };
      if (!line) {
        emit({ type: 'disclosure_missing', reason: 'no greeting line was supplied' });
        return { of: 0, delivered: 0, failed: 'no greeting line' };
      }
      history.push({ role: 'agent', text: line });
      emit({ type: 'said', text: line, disposition: 'qualifying' });
      const said = await play(line, ++turnId);
      if (markIfUndelivered(said, 'the AI disclosure')) {
        emit({ type: 'disclosure_missing', reason: said.failed || 'interrupted' });
      }
      return said;
    },
    end: finish,
    get ended() { return ended; },
    // Test seams.
    _history: () => history,
    _state: () => ({ speaking, thinking, turnId, partial, direction }),
    _usage: () => usageLedger.snapshot(),
  };
}
