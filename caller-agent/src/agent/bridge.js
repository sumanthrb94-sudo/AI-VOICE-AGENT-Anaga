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

/**
 * @param {object} o
 * @param {string}   o.lang            call language, BCP-47
 * @param {string}   [o.direction]     'outbound' | 'inbound'
 * @param {function} o.onAudio         (Buffer) => void — her voice, to the caller
 * @param {function} o.onEvent         ({type,...}) => void — transcript/state, for the UI
 * @param {function} o.think           (history) => Promise<{say,end,disposition}>
 * @param {function} o.speak           (text, lang) => Promise<Buffer> — TTS
 * @param {function} [o.isOptOut]      (text) => boolean — ours, never the model's
 * @param {function} [o.openSTT]       test seam
 */
export function createBridge(o) {
  const {
    lang, direction = 'outbound', onAudio, onEvent, think, speak,
    isOptOut = () => false, openSTT = openLiveSTT,
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
    onClose() { if (!ended) emit({ type: 'error', text: 'stt_closed' }); },
  });

  /** One turn: their words in, her voice out. */
  async function answer(heard) {
    if (ended || thinking) return;
    thinking = true;
    history.push({ role: 'user', text: heard });

    // OPT-OUT IS OURS. Checked before the model is asked anything, because the
    // model does not get a vote on it and must not be able to talk past it.
    if (isOptOut(heard)) {
      thinking = false;
      const bye = await sayBye();
      emit({ type: 'disposition', value: 'opt-out' });
      await play(bye, ++turnId);
      finish();
      return;
    }

    let out;
    try {
      out = await think(history);
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
    await play(out.say, mine);
    if (out.end === true && mine === turnId) finish();
  }

  /**
   * Speak a line, phrase by phrase, checking after every one whether she has
   * been superseded. Rendering the whole line first would mean an interruption
   * is only honoured once the sentence has finished being made.
   */
  async function play(text, mine) {
    speaking = true;
    emit({ type: 'speaking', value: true });
    for (const phrase of splitForSpeech(text)) {
      if (ended || mine !== turnId) break;
      let audio;
      try {
        audio = await speak(phrase, lang);
      } catch (err) {
        emit({ type: 'error', text: `voice: ${err?.message || 'unavailable'}` });
        break;
      }
      // Checked AGAIN after the await: synthesis takes a second or more, and
      // she may have been interrupted while it was happening.
      if (ended || mine !== turnId) break;
      try { onAudio(audio); } catch { /* the transport is gone */ }
    }
    if (mine === turnId) {
      speaking = false;
      emit({ type: 'speaking', value: false });
    }
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
    emit({ type: 'ended', history });
  }

  return {
    /** Raw 16-bit PCM from the caller, as it arrives. */
    pushAudio(pcm) { if (!ended) stt.send(pcm); },
    /** Her opening line — outbound calls speak first. */
    async greet(line) {
      if (!line || ended) return;
      history.push({ role: 'agent', text: line });
      emit({ type: 'said', text: line, disposition: 'qualifying' });
      await play(line, ++turnId);
    },
    end: finish,
    get ended() { return ended; },
    // Test seams.
    _history: () => history,
    _state: () => ({ speaking, thinking, turnId, partial, direction }),
  };
}
