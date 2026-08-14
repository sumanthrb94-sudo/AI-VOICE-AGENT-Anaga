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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade, isUpgrade } from '../media/ws.js';
import { createBridge } from './bridge.js';
import {
  TWILIO_FORMAT, twiml, validSignature, parseTwilio, mediaFrame, clearFrame,
} from './twilio.js';

const SAMPLE_RATE = 16000;
const MAX_BODY = 64 * 1024;

// Provider usage is operational telemetry, not a transcript. Keep this numeric
// and provider-only so Cloud Run logs can support unit-cost analysis without
// becoming another storage location for call content or personal data.
function logUsage(usage, context = {}) {
  if (!usage || typeof usage !== 'object') return;
  console.log(JSON.stringify({
    event: 'call_usage',
    direction: context.direction || 'unknown',
    transport: context.transport || 'unknown',
    currency: usage.currency || 'INR',
    durationMs: Number(usage.durationMs) || 0,
    estimate: usage.estimate || { amount: null, complete: false, unpriced: [] },
    stages: usage.stages || {},
  }));
}

// The call page, served from the same origin as the socket. Not a web server
// ambition — it means the local loop is ONE command and live.js can default to
// this host instead of asking somebody to type a WebSocket URL on a phone.
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/** Serve a static file, or return false so the caller can 404. */
function serveStatic(pathname, res) {
  if (process.env.AGENT_SERVE_WEB === '0') return false;
  const rel = pathname === '/' ? 'live.html' : pathname.replace(/^\//, '');
  const file = path.resolve(WEB, rel);
  // CONTAINMENT. `path.resolve` collapses "..", and this is what stops
  // /../../etc/passwd — the check must be on the RESOLVED path, not the URL.
  if (!file.startsWith(WEB + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
  return true;
}

/**
 * @param {object} o
 * @param {function} o.think    (history, ctx) => Promise<{say,end,disposition}>
 * @param {function} o.speak    (text, lang)   => Promise<Buffer>
 * @param {function} o.greeting (lang, direction) => Promise<string>
 * @param {function} [o.isOptOut]
 */
export function createAgentServer(o = {}) {
  const server = http.createServer(async (req, res) => {
    const path_ = String(req.url || '').split('?')[0];

    // ── TWILIO ANSWERS HERE ─────────────────────────────────────────────
    // Twilio POSTs this when a call arrives; the TwiML we return connects the
    // audio to /twilio. It is form-encoded, not JSON.
    if (path_ === '/incoming-call' && req.method === 'POST') {
      const raw = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(raw));
      const token = process.env.TWILIO_AUTH_TOKEN;

      // FAIL CLOSED. This endpoint answers phone calls and spends Deepgram and
      // Sarvam minutes, and on this product an unverified caller is also one
      // the compliance gate never saw. No token configured is not "skip the
      // check" — it is a refusal, because the alternative is an open endpoint
      // that looks configured.
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const url = `${proto}://${req.headers.host}${req.url}`;
      if (!validSignature({ url, params, signature: req.headers['x-twilio-signature'], token })) {
        console.error(JSON.stringify({ event: 'twilio_rejected', reason: token ? 'bad_signature' : 'no_token' }));
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }

      const wsUrl = process.env.TWILIO_STREAM_URL || `wss://${req.headers.host}/twilio`;
      console.log(JSON.stringify({ event: 'twilio_call', stream: wsUrl }));
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(twiml(wsUrl));
      return;
    }

    if (path_ === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, sampleRate: SAMPLE_RATE,
        stt: Boolean(process.env.DEEPGRAM_API_KEY),
        region: process.env.CLOUD_RUN_REGION || process.env.REGION || 'unknown',
      }));
      return;
    }
    if (req.method === 'GET' && serveStatic(path_, res)) return;

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.on('upgrade', (req, socket, head) => {
    const path_ = String(req.url || '').split('?')[0];
    if (!isUpgrade(req)) { socket.destroy(); return; }
    if (path_ === '/agent') {
      const ws = upgrade(req, socket, head);
      if (ws) attach(ws, o);
      return;
    }
    if (path_ === '/twilio') {
      const ws = upgrade(req, socket, head);
      if (ws) attachTwilio(ws, o);
      return;
    }
    socket.destroy();
  });

  return server;
}

/** Read a bounded request body. An unbounded one is a memory exhaustion. */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > MAX_BODY) { raw = ''; req.destroy(); resolve(''); }
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

/**
 * The phone leg. The SAME bridge, wearing Twilio's envelope.
 *
 * Nothing transcodes: Twilio's 8kHz mulaw goes straight to the recogniser, and
 * Bulbul is asked for 8kHz mulaw so its bytes go straight back down the line.
 */
export function attachTwilio(ws, o = {}) {
  let bridge = null;
  let streamSid = '';

  ws.on('message', (data, kind) => {
    if (kind === 'binary' || Buffer.isBuffer(data)) return;   // Twilio is all JSON
    const m = parseTwilio(data);
    if (!m) return;

    if (m.type === 'start') {
      streamSid = m.streamSid;
      // A phone call is INBOUND by definition here: they rang us. Consent to
      // the call is implied by dialling; disclosure is not, and the inbound
      // flow says so in its first sentence.
      const lang = String(process.env.TWILIO_CALL_LANG || 'en-IN');
      try {
        bridge = createBridge({
          lang,
          direction: 'inbound',
          audio: TWILIO_FORMAT,
          onAudio: (audio) => ws.send(mediaFrame(streamSid, audio)),
          onEvent: (e) => {
            // Twilio holds audio we have already sent, so cancelling on our
            // side is not enough — without this the prospect interrupts and
            // Twilio keeps playing the sentence they are talking over.
            if (e.type === 'clear' && streamSid) ws.send(clearFrame(streamSid));
            if (e.type === 'usage') logUsage(e.usage, { direction: 'inbound', transport: 'twilio' });
            if (e.type === 'ended') { try { ws.close(1000, 'done'); } catch { /* gone */ } }
          },
          think: (history) => o.think(history, { lang, direction: 'inbound' }),
          speak: (text, l, fmt) => o.speak(text, l, fmt),
          isOptOut: o.isOptOut,
        });
      } catch (err) {
        console.error(JSON.stringify({ event: 'twilio_bridge_failed', reason: String(err?.message || err) }));
        try { ws.close(1011, 'agent'); } catch { /* gone */ }
        return;
      }

      // SHE SPEAKS FIRST, AND THAT IS NOT A NICETY.
      //
      // This was missing, and a simulated call found it: the socket opened and
      // then sat in silence until the caller said something. On an inbound call
      // the first sentence is the DISCLOSURE — consent to the call is implied
      // by their dialling, but knowing they are talking to an AI is not, and
      // the flow's inbound rules say so in as many words.
      //
      // A caller who hears nothing also just hangs up.
      if (o.greeting) {
        (async () => {
          try { await bridge.greet(await o.greeting(lang, 'inbound')); }
          catch (err) {
            console.error(JSON.stringify({ event: 'twilio_greet_failed', reason: String(err?.message || err) }));
          }
        })();
      }
      return;
    }

    if (m.type === 'audio' && bridge) { bridge.pushAudio(m.audio); return; }
    if (m.type === 'stop' && bridge) bridge.end();
  });

  ws.on('close', () => { if (bridge) bridge.end(); });
  ws.on('error', () => { if (bridge) bridge.end(); });
  return { get bridge() { return bridge; }, get streamSid() { return streamSid; } };
}

/** Wire one client socket to one conversation. Exported for tests. */
export function attach(ws, o = {}) {
  let bridge = null;

  const send = (obj) => ws.send(JSON.stringify(obj));
  const observeAndSend = (event) => {
    if (event?.type === 'usage') logUsage(event.usage, { direction: event.direction || 'unknown', transport: 'agent_websocket' });
    send(event);
  };

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
          onEvent: observeAndSend,
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
