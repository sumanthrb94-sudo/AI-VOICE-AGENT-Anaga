// shared/deepgram-live.js
//
// Deepgram's STREAMING recogniser, as a small client.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// Everything painful about this pipeline came from one thing: the browser
// recorded a WHOLE utterance and POSTed it, so nothing could overlap and
// nothing was known until the prospect had finished. That forced us to write,
// badly, the pieces a streaming recogniser gives away:
//
//   our percentile VAD          ->  server-side neural VAD
//   our adaptive silence window ->  native turn-taking (Flux) / endpointing
//   our barge-in heuristic      ->  a SpeechStarted event
//   waiting for the final text  ->  interim transcripts as they speak
//
// This is the socket that replaces them. It is deliberately NOT the Voice Agent
// API: that one owns the LLM and the voice too, and inside it Sarvam cannot be
// the recogniser and Bulbul cannot be the voice (docs/ARCHITECTURE.md §5). We
// want the leg Deepgram is best at and nothing else.
//
// ── TRANSPORT ─────────────────────────────────────────────────────────────
// Node 22 ships a native WebSocket client, so there is no dependency here. The
// key travels as a SUBPROTOCOL rather than a header, because a WebSocket
// handshake takes no custom headers in either Node or a browser — Deepgram
// documents `["token", <key>]` for exactly this reason.

const LIVE_URL = 'wss://api.deepgram.com/v1/listen';

/** Our BCP-47 to Deepgram's codes — the same table as the batch adapter. */
export const DG_LANG = {
  'te-IN': 'te', 'hi-IN': 'hi', 'en-IN': 'en-IN', 'ta-IN': 'ta', 'kn-IN': 'kn',
  'mr-IN': 'mr', 'bn-IN': 'bn', 'gu-IN': 'gu', 'pa-IN': 'pa', 'ur-IN': 'ur',
};

/**
 * The query string for a live connection.
 *
 * Exported and pure so the wire format is testable without a socket — every
 * bug we have had with a vendor so far was in what we ASKED FOR, and that half
 * is ours.
 *
 * @param {object} o
 * @param {string} [o.lang]        call language, BCP-47
 * @param {number} [o.sampleRate]  PCM rate we will send
 * @param {string} [o.model]
 */
export function liveQuery({ lang, sampleRate = 16000, model } = {}) {
  const q = new URLSearchParams({
    model: model || process.env.DEEPGRAM_LIVE_MODEL || 'nova-3',
    // RAW PCM, not a container. The whole point is to send audio as it is
    // captured; a WebM stream cannot be cut into independently decodable
    // pieces, which is what forced the old code to record whole utterances.
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    // INTERIM RESULTS ARE THE LATENCY FIX. Words arrive while the prospect is
    // still talking, so by the time they stop the transcript is essentially
    // done rather than starting.
    interim_results: 'true',
    // ENDPOINTING AND VAD, SERVER-SIDE. This is the replacement for the silence
    // timer in mic.js — a neural VAD instead of an energy threshold, which is
    // the difference between 0.72 and 0.11 Matthews correlation (docs/VAD.md).
    vad_events: 'true',
    endpointing: String(Number(process.env.DEEPGRAM_ENDPOINTING_MS || 300)),
    // A turn is finished when Deepgram says the utterance is over, not when a
    // timer in a browser guesses.
    utterance_end_ms: String(Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 1000)),
    smart_format: 'true',
    punctuate: 'true',
  });
  // Pinned when we know it; `multi` otherwise — and never a guess, because
  // guessing Telugu wrong produces fluent nonsense rather than an obvious
  // failure. See docs/VAD.md §6: `multi` does not cover Telugu.
  q.set('language', DG_LANG[String(lang)] || 'multi');
  return q;
}

/**
 * Classify one Deepgram message. Pure, so the event contract is tested without
 * a network — the parsing is where a vendor's shape surprises you.
 *
 * @returns {{type: string, text?: string, final?: boolean}|null}
 */
export function parseLiveMessage(raw) {
  let m;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!m || typeof m !== 'object') return null;

  // They started talking. On a live call this is barge-in, and it must reach
  // playback before anything else does — an agent that talks over someone
  // trying to opt out is the worst failure this system has.
  if (m.type === 'SpeechStarted') return { type: 'speech_start' };

  // The turn is over. Deepgram decides this, not a timer in the browser.
  if (m.type === 'UtteranceEnd') return { type: 'utterance_end' };

  if (m.type === 'Results' || m.channel) {
    const alt = m.channel?.alternatives?.[0];
    const text = String(alt?.transcript || '').trim();
    if (!text) return null;                       // silence between words
    return { type: 'transcript', text, final: m.is_final === true };
  }

  if (m.type === 'Error' || m.error) {
    return { type: 'error', text: String(m.description || m.message || m.error || 'deepgram_error') };
  }
  return null;
}

/**
 * Open a live recogniser.
 *
 * @param {object} o
 * @param {string} [o.lang]
 * @param {number} [o.sampleRate]
 * @param {function} o.onEvent   receives the objects parseLiveMessage returns
 * @param {function} [o.onOpen]
 * @param {function} [o.onClose]
 * @param {function} [o.WebSocketImpl]  test seam
 * @returns {{send: function, finish: function, close: function, isOpen: function}}
 */
export function openLiveSTT({ lang, sampleRate = 16000, onEvent, onOpen, onClose, WebSocketImpl } = {}) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('deepgram_not_configured');

  const WS = WebSocketImpl || globalThis.WebSocket;
  if (!WS) throw new Error('no_websocket_client');

  const url = `${LIVE_URL}?${liveQuery({ lang, sampleRate })}`;
  // The key as a subprotocol: a WebSocket handshake carries no custom headers
  // in Node or in a browser, and Deepgram documents this form.
  const ws = new WS(url, ['token', key]);
  ws.binaryType = 'arraybuffer';

  let open = false;
  // Audio that arrived before the socket finished opening. Dropping it clips
  // the first syllable of the call, which is the one nobody forgives.
  const pending = [];

  ws.onopen = () => {
    open = true;
    for (const chunk of pending.splice(0)) { try { ws.send(chunk); } catch { /* closing */ } }
    if (onOpen) onOpen();
  };
  ws.onmessage = (ev) => {
    const out = parseLiveMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (out && onEvent) onEvent(out);
  };
  ws.onerror = () => { if (onEvent) onEvent({ type: 'error', text: 'deepgram_socket_error' }); };
  ws.onclose = () => { open = false; if (onClose) onClose(); };

  return {
    isOpen: () => open,
    /** @param {Buffer|ArrayBuffer|Uint8Array} pcm 16-bit little-endian mono */
    send(pcm) {
      if (!open) { pending.push(pcm); return; }
      try { ws.send(pcm); } catch { /* the close handler reports it */ }
    },
    /** Flush: tell Deepgram no more audio is coming for this turn. */
    finish() {
      try { ws.send(JSON.stringify({ type: 'Finalize' })); } catch { /* closing */ }
    },
    close() {
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* closing */ }
      try { ws.close(); } catch { /* already gone */ }
    },
  };
}
