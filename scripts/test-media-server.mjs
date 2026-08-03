// scripts/test-media-server.mjs
//
// QA for the WebSocket media server, including the hand-rolled RFC 6455 layer.
//
// The RFC layer is tested against Node's NATIVE global WebSocket client — real
// interop with an independent implementation, not a self-consistent mock. If
// the framing is wrong, the standard client will reject it.
//
// The top of the file then drives a FULL CALL through a simulated provider
// socket: start event → audio in → disclosure out → opt-out → call ends. That
// is the same session.js and transport.js the mock path uses; only the wire is
// different.
//
// Run: node --experimental-detect-module scripts/test-media-server.mjs

import assert from 'node:assert';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const { createMediaServer, codecs } = await import(`${ROOT}/caller-agent/src/media/server.js`);
const { acceptKey, encodeFrame, decodeFrame } = await import(`${ROOT}/caller-agent/src/media/ws.js`);
const { runCall } = await import(`${ROOT}/caller-agent/src/session.js`);
const { detectOptOut } = await import(`${ROOT}/shared/optout.js`);

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

console.log('\n═══ MEDIA SERVER QA ═══');

// ---------------------------------------------------------------------------
section('RFC 6455 framing (unit)');

await t('accept key matches the RFC 6455 worked example', () => {
  // The example from the spec itself — if this passes, the handshake is right.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

await t('a server frame round-trips through the decoder', () => {
  const encoded = encodeFrame(0x1, Buffer.from('hello'));
  // Server frames are unmasked; decode reads them back.
  const f = decodeFrame(encoded);
  assert.equal(f.opcode, 0x1);
  assert.equal(f.payload.toString(), 'hello');
  assert.equal(f.fin, true);
});

await t('extended payload lengths are encoded correctly', () => {
  const medium = decodeFrame(encodeFrame(0x2, Buffer.alloc(200)));
  assert.equal(medium.payload.length, 200);
  const large = decodeFrame(encodeFrame(0x2, Buffer.alloc(70000)));
  assert.equal(large.payload.length, 70000);
});

await t('a partial frame returns null rather than corrupt data', () => {
  const full = encodeFrame(0x1, Buffer.from('abcdefghij'));
  assert.equal(decodeFrame(full.subarray(0, 4)), null);
  assert.equal(decodeFrame(Buffer.alloc(1)), null);
});

await t('masked client frames are unmasked', () => {
  // Build a masked frame the way a browser client would.
  const payload = Buffer.from('masked!');
  const mask = Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
  assert.equal(decodeFrame(frame).payload.toString(), 'masked!');
});

// ---------------------------------------------------------------------------
section('interop with Node\'s native WebSocket client');

/** Start a media server on an ephemeral port. */
async function startServer(onCall, opts = {}) {
  const server = createMediaServer({ onCall, provider: 'plivo', ...opts });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { server, port, url: `ws://127.0.0.1:${port}` };
}

await t('the native WebSocket client completes the handshake', async () => {
  const { server, url } = await startServer(async () => {});
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('native client refused our handshake'));
    setTimeout(() => rej(new Error('handshake timeout')), 3000);
  });
  ws.close();
  server.close();
});

await t('the /answer endpoint returns provider XML naming the stream URL', async () => {
  process.env.MEDIA_SERVER_WS_URL = 'wss://media.example.com/stream';
  const { server, port } = await startServer(async () => {});
  const res = await fetch(`http://127.0.0.1:${port}/answer`);
  const xml = await res.text();
  assert.match(res.headers.get('content-type'), /xml/);
  assert.match(xml, /<Stream[^>]*bidirectional="true"/);
  assert.match(xml, /wss:\/\/media\.example\.com\/stream/);
  server.close();
});

await t('/health reports the provider and active stream count', async () => {
  const { server, port } = await startServer(async () => {});
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'plivo');
  assert.equal(body.activeStreams, 0);
  server.close();
});

// ---------------------------------------------------------------------------
section('a full call over a simulated provider socket');

/** Speak text to the server the way Plivo would: base64 in a media envelope. */
function sendAudio(ws, text) {
  ws.send(JSON.stringify({
    event: 'media',
    media: { payload: Buffer.from(text, 'utf8').toString('base64') },
  }));
}

await t('disclosure → qualification → opt-out, entirely over the wire', async () => {
  const spokenToCallee = [];
  let sessionResult = null;

  // A hostile brain that never stops selling — the session must stop it.
  const brain = {
    async nextTurn() { return { say: 'Let me tell you about the offer!', end: false, disposition: 'qualifying' }; },
    async reportOutcome(p) { sessionResult = p; return { ok: true, review: { disposition: p.call.disposition } }; },
  };

  const persona = JSON.parse(
    await (await import('node:fs/promises')).readFile(`${ROOT}/caller-agent/flows/anaga.persona.json`, 'utf8')
  );

  const { server, url } = await startServer(async ({ media, callId }) => {
    // The media transport IS the telephony adapter for a real call.
    const telephony = {
      async dial() { return { answered: true, reason: null, callId }; },
      say: (text) => { spokenToCallee.push(text); return media.say(text); },
      listen: () => media.listen(),
      async hangup(reason) { media.close(reason); return { ended: reason }; },
    };
    return runCall({
      job: { callId, lead: { phone: '+919876543210', name: 'Ravi' }, agent: { lang: 'en-IN' } },
      telephony, brain, persona,
    });
  }, {
    // Mock speech so the test asserts plumbing, not vendor accuracy.
    sttFactory: () => ({ async transcribe(chunks) { return chunks.map((c) => c.toString('utf8')).join(' ').trim(); } }),
    ttsFactory: () => ({ async synth(text) { return { frames: [Buffer.from(text, 'utf8')] }; } }),
  });

  const ws = new WebSocket(url);
  await new Promise((r) => { ws.onopen = r; });

  const fromServer = [];
  ws.onmessage = (e) => fromServer.push(typeof e.data === 'string' ? e.data : '');

  ws.send(JSON.stringify({ event: 'start', start: { callId: 'stream-1' } }));
  await new Promise((r) => setTimeout(r, 150));

  sendAudio(ws, 'yes I have a minute');
  await new Promise((r) => setTimeout(r, 1200));      // let endpointing fire

  sendAudio(ws, 'actually do not call me again');
  await new Promise((r) => setTimeout(r, 1600));

  // --- assertions -------------------------------------------------------
  assert.ok(spokenToCallee.length > 0, 'the agent should have spoken');
  assert.match(spokenToCallee[0], /\bAI\b/i, `disclosure must be first, got: ${spokenToCallee[0]}`);

  assert.ok(sessionResult, 'the session must have reported an outcome');
  assert.equal(sessionResult.call.disposition, 'opt-out');

  const last = spokenToCallee.at(-1);
  assert.match(last, /do-not-call list/i, `last line must be the opt-out ack, got: ${last}`);

  const optOutTurn = sessionResult.history.find((h) => h.role === 'user' && detectOptOut(h.text).optOut);
  assert.ok(optOutTurn, 'the opt-out utterance must be in the transcript');

  assert.ok(fromServer.some((m) => m.includes('playAudio')), 'audio must have gone back over the socket');

  ws.close();
  server.close();
});

await t('a barge-in sends the provider a clear-audio command', async () => {
  let mediaRef = null;
  // Long enough that playback is still running when the barge-in threshold is
  // reached. Barge-in now needs a sustained voice run (~240ms); a line that
  // finishes before then simply has nothing left to cancel.
  const LONG_PITCH = ('This is a very long pitch that the caller is going to interrupt '
    + 'before it finishes because nobody wants to hear the whole thing read out '
    + 'at length over the phone in one breath').trim();

  const { server, url } = await startServer(async ({ media }) => {
    mediaRef = media;
    await media.say(LONG_PITCH);
    await new Promise((r) => setTimeout(r, 500));
  }, {
    sttFactory: () => ({ async transcribe(c) { return c.map((x) => x.toString('utf8')).join(' '); } }),
    ttsFactory: () => ({ async synth(text) {
      // Many frames, with a yield between, so there is a window to interrupt.
      return { frames: text.split(' ').map((w) => Buffer.from(w)) };
    } }),
  });

  const ws = new WebSocket(url);
  await new Promise((r) => { ws.onopen = r; });
  const fromServer = [];
  ws.onmessage = (e) => fromServer.push(String(e.data));

  ws.send(JSON.stringify({ event: 'start', start: { callId: 'stream-2' } }));
  await new Promise((r) => setTimeout(r, 20));
  // Sustained interruption: barge-in requires a continuous voice run so that a
  // single echoed frame cannot cancel our own utterance.
  for (let i = 0; i < 6; i++) {
    sendAudio(ws, 'stop talking please');
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(mediaRef, 'the call should have started');
  assert.ok(fromServer.some((m) => m.includes('clearAudio')),
    'barge-in must tell the provider to drop buffered playback');

  ws.close();
  server.close();
});

await t('a provider stop event closes the media transport', async () => {
  let closed = false;
  const { server, url } = await startServer(async ({ media }) => {
    const heard = await media.listen();
    closed = heard.hangup === true;
  }, {
    sttFactory: () => ({ async transcribe() { return ''; } }),
    ttsFactory: () => ({ async synth() { return { frames: [] }; } }),
  });

  const ws = new WebSocket(url);
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ event: 'start', start: { callId: 'stream-3' } }));
  await new Promise((r) => setTimeout(r, 100));
  ws.send(JSON.stringify({ event: 'stop' }));
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(closed, true, 'a provider stop must resolve a pending listen as a hangup');
  ws.close();
  server.close();
});

// ---------------------------------------------------------------------------
section('codecs');

await t('the plivo codec parses start/media/stop', () => {
  const c = codecs.plivo;
  assert.equal(c.parse(JSON.stringify({ event: 'start', start: { callId: 'x' } })).type, 'start');
  const audio = c.parse(JSON.stringify({ event: 'media', media: { payload: Buffer.from('hi').toString('base64') } }));
  assert.equal(audio.type, 'audio');
  assert.equal(audio.audio.toString(), 'hi');
  assert.equal(c.parse(JSON.stringify({ event: 'stop' })).type, 'stop');
  assert.equal(c.parse('not json'), null);
});

await t('the exotel codec carries the stream sid on outbound audio', () => {
  const out = JSON.parse(codecs.exotel.audioOut('sid-9', Buffer.from('abc')));
  assert.equal(out.stream_sid, 'sid-9');
  assert.equal(Buffer.from(out.media.payload, 'base64').toString(), 'abc');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
process.exit(0);
