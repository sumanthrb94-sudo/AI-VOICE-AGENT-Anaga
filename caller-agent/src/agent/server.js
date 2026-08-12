// caller-agent/src/agent/server.js
//
// The live-call socket. `GET /agent` upgrades; audio goes both ways over it.
//
// This is the piece a Vercel serverless function cannot be, and the reason
// every compromise in docs/ARCHITECTURE.md §4 existed. It runs on Cloud Run in
// asia-south1, next to every vendor on this pipeline.
//
// ── THE WIRE ──────────────────────────────────────────────────────────────
// Deliberately trivial, because the SAME bridge has to serve a browser and a
// Twilio Media Stream:
//
//   client -> server   binary frame          raw 16-bit LE PCM, mono
//   client -> server   {"type":"start", lang, direction}
//   client -> server   {"type":"stop"}
//   server -> client   binary frame          her voice, same format
//   server -> client   {"type":"heard"|"partial"|"said"|"clear"|...}
//
// Twilio wraps the same audio in a base64 JSON envelope and expects `clear` to
// stop playback; that is a codec around this, not a different server — which is
// exactly how caller-agent/src/media/server.js already treats Plivo and Exotel.

import http from 'node:http';
import { upgrade, isUpgrade } from '../media/ws.js';
import { createBridge } from './bridge.js';

const SAMPLE_RATE = 16000;

/**
 * @param {object} o
 * @param {function} o.think    (history, ctx) => Promise<{say,end,disposition}>
 * @param {function} o.speak    (text, lang)   => Promise<Buffer>
 * @param {function} o.greeting (lang, direction) => Promise<string>
 * @param {function} [o.isOptOut]
 */
export function createAgentServer(o = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, sampleRate: SAMPLE_RATE,
        stt: Boolean(process.env.DEEPGRAM_API_KEY),
        region: process.env.CLOUD_RUN_REGION || process.env.REGION || 'unknown',
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    const path = String(req.url || '').split('?')[0];
    if (path !== '/agent' || !isUpgrade(req)) { socket.destroy(); return; }
    const ws = upgrade(req, socket, head);
    if (!ws) return;
    attach(ws, o);
  });

  return server;
}

/** Wire one client socket to one conversation. Exported for tests. */
export function attach(ws, o = {}) {
  let bridge = null;

  const send = (obj) => ws.send(JSON.stringify(obj));

  ws.on('message', async (data, kind) => {
    // `kind` is the STRING 'text' or 'binary' (media/ws.js:131), not a boolean.
    // Treating it as one made every control message truthy-binary, so `start`
    // was fed to the recogniser as audio and no conversation ever began — the
    // socket connected, health said fine, and nothing happened.
    const binary = kind === 'binary' || Buffer.isBuffer(data);
    // AUDIO IS THE HOT PATH and must not be parsed as anything. A binary frame
    // goes straight through — this runs for every 20ms of every call.
    if (binary) { if (bridge) bridge.pushAudio(data); return; }

    let m;
    try { m = JSON.parse(String(data)); } catch { return; }

    if (m.type === 'start') {
      if (bridge) return;                       // one conversation per socket
      const lang = String(m.lang || 'en-IN');
      const direction = m.direction === 'inbound' ? 'inbound' : 'outbound';
      try {
        bridge = createBridge({
          lang,
          direction,
          onAudio: (pcm) => ws.send(pcm),
          onEvent: send,
          think: (history) => o.think(history, { lang, direction }),
          speak: (text, l) => o.speak(text, l),
          isOptOut: o.isOptOut,
        });
      } catch (err) {
        // A missing key must say so rather than opening a socket that will
        // never transcribe anything — the browser reported "brain unavailable"
        // for an STT failure once already.
        send({ type: 'error', text: String(err?.message || 'agent_unavailable') });
        ws.close(1011, 'agent');
        return;
      }
      send({ type: 'ready', lang, direction, sampleRate: SAMPLE_RATE });

      // OUTBOUND SPEAKS FIRST, and the opening is approved wording read from
      // the flow — never a generation. Same rule as the HTTP path.
      if (direction === 'outbound' && o.greeting) {
        try { await bridge.greet(await o.greeting(lang, direction)); } catch { /* she starts on their turn */ }
      }
      return;
    }

    if (m.type === 'stop' && bridge) bridge.end();
  });

  ws.on('close', () => { if (bridge) bridge.end(); });
  ws.on('error', () => { if (bridge) bridge.end(); });
  return { get bridge() { return bridge; } };
}
