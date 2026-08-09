// caller-agent/src/media/server.js
//
// The WebSocket media server — the last code blocker between a dial job and a
// real conversation. Telephony providers stream call audio to a socket YOU host
// and expect audio back on the same socket; this is that socket.
//
//   provider WS  --{event:"media", payload:<b64 audio>}-->  transport.pushAudio
//   transport.audioOut  --{event:"playAudio", ...}------->  provider WS
//
// It is provider-agnostic: `codecs` below translate each vendor's JSON envelope
// to and from raw audio, and everything above that line is the SAME tested
// media transport and session the mock path uses. Swapping Plivo for Exotel
// changes a codec, not the conversation.
//
// ⚠️ VERIFICATION: the wire format here follows Plivo's and Exotel's documented
// streaming envelopes but has NOT been run against a live provider socket. The
// RFC 6455 layer underneath IS verified, against Node's native WebSocket client
// (scripts/test-media-server.mjs). Treat the codecs as the part to check first
// in the WP-1 spike — they are also the cheapest part to fix.

import http from 'node:http';
import { upgrade, isUpgrade } from './ws.js';
import { createMediaTransport } from './transport.js';
import { createSTT, createTTS, withSynthCache } from '../providers/speech.js';

// ---------------------------------------------------------------------------
// provider codecs — the only vendor-specific code in the media path
// ---------------------------------------------------------------------------
export const codecs = {
  // Plivo: JSON envelopes, base64 payloads, `start`/`media`/`stop` events.
  plivo: {
    parse(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return null; }
      if (m.event === 'start') {
        return { type: 'start', callId: m.start?.callId || m.start?.streamId || null };
      }
      if (m.event === 'media' && m.media?.payload) {
        return {
          type: 'audio',
          audio: Buffer.from(m.media.payload, 'base64'),
          // Plivo does not send a VAD flag; the transport falls back to
          // "non-empty frame == voice", which its `hasVoice == null` branch
          // handles. Real VAD should come from the STT vendor.
          hasVoice: undefined,
        };
      }
      if (m.event === 'stop' || m.event === 'hangup') return { type: 'stop' };
      return null;
    },
    audioOut(streamId, chunk) {
      return JSON.stringify({
        event: 'playAudio',
        media: {
          contentType: 'audio/x-l16',
          sampleRate: Number(process.env.TELEPHONY_SAMPLE_RATE || 8000),
          payload: Buffer.from(chunk).toString('base64'),
        },
      });
    },
    // Sent to stop playback instantly on barge-in.
    clear() { return JSON.stringify({ event: 'clearAudio' }); },
  },

  exotel: {
    parse(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return null; }
      if (m.event === 'start') return { type: 'start', callId: m.start?.call_sid || null };
      if (m.event === 'media' && m.media?.payload) {
        return { type: 'audio', audio: Buffer.from(m.media.payload, 'base64'), hasVoice: undefined };
      }
      if (m.event === 'stop') return { type: 'stop' };
      return null;
    },
    audioOut(streamId, chunk) {
      return JSON.stringify({
        event: 'media',
        stream_sid: streamId,
        media: { payload: Buffer.from(chunk).toString('base64') },
      });
    },
    clear(streamId) { return JSON.stringify({ event: 'clear', stream_sid: streamId }); },
  },
};

/**
 * Create the media server.
 *
 * @param {object} opts
 * @param {function} opts.onCall  async ({ media, callId }) => void
 *        Invoked once the provider's `start` event arrives, with a ready media
 *        transport. The caller wires this to runCall().
 * @param {string} [opts.provider]
 */
export function createMediaServer({
  onCall,
  provider = process.env.TELEPHONY_PROVIDER || 'plivo',
  log = () => {},
  sttFactory = createSTT,
  ttsFactory = createTTS,
} = {}) {
  const codec = codecs[provider] || codecs.plivo;
  const sessions = new Set();

  // ONE cached TTS for the whole server, not one per call. The lines worth
  // caching — the disclosure, the opt-out acknowledgement, the silence nudges —
  // are identical on every call, so a per-call cache would miss on every one of
  // them. The adapter itself is stateless, so sharing it is safe.
  const tts = withSynthCache(ttsFactory());

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, provider, activeStreams: sessions.size }));
    }
    // Providers fetch an XML document to be told to open the stream. Emitting
    // it here keeps the answer_url and the socket on one service.
    if (req.url.startsWith('/answer')) {
      const wsUrl = (process.env.MEDIA_SERVER_WS_URL || '').trim();
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n`
        + `  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=${Number(process.env.TELEPHONY_SAMPLE_RATE || 8000)}">${wsUrl}</Stream>\n`
        + `</Response>\n`
      );
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', (req, socket, head) => {
    if (!isUpgrade(req)) { socket.destroy(); return; }
    const ws = upgrade(req, socket, head);
    if (!ws) return;

    let streamId = null;
    let transport = null;
    let started = false;
    let ticker = null;

    ws.on('message', async (data) => {
      const msg = codec.parse(typeof data === 'string' ? data : data.toString('utf8'));
      if (!msg) return;

      if (msg.type === 'start' && !started) {
        started = true;
        streamId = msg.callId;

        transport = createMediaTransport({
          stt: sttFactory(),
          tts,
          audioOut: (chunk) => ws.send(codec.audioOut(streamId, chunk)),
          log,
        });

        // Endpointing needs a clock, not just inbound frames: if the prospect
        // stops talking the provider stops sending audio, so nothing would
        // trigger the silence check without this tick.
        ticker = setInterval(() => transport.tick(), 100);
        sessions.add(ws);

        log('media_stream_started', { streamId, provider });
        try {
          await onCall({ media: transport, callId: streamId });
        } catch (err) {
          log('media_call_error', { streamId, error: String(err && err.message) });
        } finally {
          ws.close(1000, 'call_finished');
        }
        return;
      }

      if (!transport) return;

      if (msg.type === 'audio') {
        const wasSpeaking = transport._isSpeaking();
        transport.pushAudio(msg.audio, { hasVoice: msg.hasVoice });
        // Barge-in: tell the provider to drop already-buffered playback too,
        // otherwise the caller keeps hearing us for as long as its jitter
        // buffer holds — which is exactly when someone is trying to opt out.
        if (wasSpeaking && !transport._isSpeaking() && codec.clear) {
          ws.send(codec.clear(streamId));
        }
        return;
      }

      if (msg.type === 'stop') {
        transport.close('provider_stop');
      }
    });

    ws.on('close', () => {
      if (ticker) clearInterval(ticker);
      if (transport) transport.close('socket_closed');
      sessions.delete(ws);
      log('media_stream_closed', { streamId });
    });

    ws.on('error', (err) => log('media_socket_error', { streamId, error: String(err && err.message) }));
  });

  return server;
}
