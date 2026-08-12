// scripts/test-agent-bridge.mjs
//
// QA for the streaming call leg — shared/deepgram-live.js and
// caller-agent/src/agent/bridge.js.
//
// ── WHAT THIS SUITE IS FOR ────────────────────────────────────────────────
// This bridge exists to delete heuristics, not to add one. Every guarantee
// below used to be a guess in the browser that failed on real hardware:
//
//   barge-in was an energy threshold, then a timing window, then a content
//   match — all three shipped, all three failed. Here it is one event.
//
//   the end of a turn was an 800ms silence timer in a browser. Here the
//   recogniser decides.
//
//   a superseded line was cancelled by a flag that was checked once. Here it
//   is checked after every phrase AND after every await, because synthesis
//   takes a second and she can be interrupted during it.
//
// ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
// That Deepgram answers. Egress to api.deepgram.com is blocked from CI and
// from the dev container, so the socket is a fake and the WIRE FORMAT — the
// half that is ours — is asserted directly. The first real socket opens from
// Cloud Run.
//
// Run: node --experimental-detect-module scripts/test-agent-bridge.mjs

import assert from 'node:assert';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log('\n' + s); }

const live = await import('../shared/deepgram-live.js');
const { createBridge } = await import('../caller-agent/src/agent/bridge.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

/** A recogniser we drive by hand. */
function fakeSTT() {
  const api = { sent: [], closed: false, finished: 0, fire: null };
  api.open = (opts) => {
    api.fire = opts.onEvent;
    return {
      send: (pcm) => api.sent.push(pcm),
      finish: () => { api.finished++; },
      close: () => { api.closed = true; },
      isOpen: () => true,
    };
  };
  return api;
}

function build(over = {}) {
  const stt = fakeSTT();
  const audio = [], events = [];
  const bridge = createBridge({
    lang: 'te-IN',
    onAudio: (b) => audio.push(b),
    onEvent: (e) => events.push(e),
    think: async () => ({ say: 'ఉండటానికా, లేక ఇన్వెస్ట్‌మెంట్ కోసమా?', end: false, disposition: 'qualifying' }),
    speak: async (text) => Buffer.from(text),
    openSTT: stt.open,
    ...over,
  });
  return { bridge, stt, audio, events, of: (type) => events.filter((e) => e.type === type) };
}

// ===========================================================================
section('§1 the wire — what Deepgram is asked for');
// ===========================================================================

await t('INTERIM RESULTS AND SERVER-SIDE VAD ARE BOTH ASKED FOR', () => {
  // These two parameters are the entire reason for this rewrite. Without
  // interim_results nothing is known until they stop talking; without
  // vad_events we are back to an energy threshold in a browser.
  const q = live.liveQuery({ lang: 'te-IN' });
  assert.equal(q.get('interim_results'), 'true');
  assert.equal(q.get('vad_events'), 'true');
  assert.ok(Number(q.get('endpointing')) > 0, 'endpointing must be server-side');
  assert.ok(Number(q.get('utterance_end_ms')) > 0);
});

await t('RAW PCM, not a container', () => {
  // A WebM stream cannot be cut into independently decodable pieces, which is
  // exactly what forced the old code to record a whole utterance before
  // sending anything.
  const q = live.liveQuery({ sampleRate: 16000 });
  assert.equal(q.get('encoding'), 'linear16');
  assert.equal(q.get('sample_rate'), '16000');
  assert.equal(q.get('channels'), '1');
});

await t('Telugu is pinned; an unknown language asks for code-switching', () => {
  assert.equal(live.liveQuery({ lang: 'te-IN' }).get('language'), 'te');
  assert.equal(live.liveQuery({ lang: 'hi-IN' }).get('language'), 'hi');
  assert.equal(live.liveQuery({ lang: 'en-IN' }).get('language'), 'en-IN');
  assert.equal(live.liveQuery({}).get('language'), 'multi');
});

// ===========================================================================
section('§2 the messages it sends back');
// ===========================================================================

await t('SpeechStarted is barge-in — the event that replaces three heuristics', () => {
  assert.deepEqual(live.parseLiveMessage('{"type":"SpeechStarted"}'), { type: 'speech_start' });
});

await t('interim and final transcripts are distinguished', () => {
  const interim = live.parseLiveMessage(JSON.stringify({
    type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'నాకు మూడు' }] },
  }));
  assert.deepEqual(interim, { type: 'transcript', text: 'నాకు మూడు', final: false });
  const final = live.parseLiveMessage(JSON.stringify({
    type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'నాకు మూడు బెడ్‌రూమ్‌లు' }] },
  }));
  assert.equal(final.final, true);
});

await t('an empty transcript is not an event', () => {
  // Deepgram emits these constantly between words. Treating one as a turn
  // would have Anaga answer silence.
  assert.equal(live.parseLiveMessage(JSON.stringify({
    type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '   ' }] },
  })), null);
});

await t('junk on the socket never throws', () => {
  assert.equal(live.parseLiveMessage('not json'), null);
  assert.equal(live.parseLiveMessage(''), null);
  assert.equal(live.parseLiveMessage(null), null);
});

// ===========================================================================
section('§3 the conversation');
// ===========================================================================

await t('A FINAL TRANSCRIPT BECOMES A TURN, and her voice comes back', async () => {
  const { bridge, stt, audio, of } = build();
  stt.fire({ type: 'transcript', text: 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి', final: true });
  await settle();
  assert.equal(of('heard')[0].text, 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి');
  assert.ok(of('said').length, 'she must answer');
  assert.ok(audio.length, 'and it must reach the caller as audio');
  assert.deepEqual(bridge._history().map((h) => h.role), ['user', 'agent']);
});

await t('an INTERIM transcript is shown but never answered', async () => {
  // Answering a partial would have her reply to half a sentence — and then
  // reply again to the whole one.
  const { stt, of } = build();
  stt.fire({ type: 'transcript', text: 'నాకు మూడు', final: false });
  await settle();
  assert.equal(of('partial')[0].text, 'నాకు మూడు');
  assert.equal(of('heard').length, 0);
  assert.equal(of('said').length, 0);
});

await t('SHE STOPS WHEN THEY START — and the transcript records it', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { bridge, stt, audio, of } = build({
    speak: async (text) => { await slow; return Buffer.from(text); },
  });
  stt.fire({ type: 'transcript', text: 'చెప్పండి', final: true });
  await settle();
  // She is mid-synthesis. They start talking.
  stt.fire({ type: 'speech_start' });
  await settle();
  release(Buffer.from('too late'));
  await settle();

  assert.ok(of('user_started').length, 'barge-in must be reported');
  assert.ok(of('clear').length, 'and the transport must be told to drop buffered audio');
  assert.equal(audio.length, 0, 'audio rendered for a superseded turn must never play');
  assert.match(bridge._history().find((h) => h.role === 'agent').text, /\[cut off\]/);
});

await t('the cancellation is checked AFTER the await, not only before it', async () => {
  // Synthesis takes a second or more. A flag checked once, before the call,
  // lets a whole superseded sentence through — which is how a barge-in
  // silences her for a moment and then plays the old line anyway.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../caller-agent/src/agent/bridge.js', import.meta.url), 'utf8');
  const play = src.slice(src.indexOf('async function play'), src.indexOf('async function sayBye'));
  const checks = play.match(/mine !== turnId/g) || [];
  assert.ok(checks.length >= 2, `expected a check on both sides of the await, found ${checks.length}`);
});

await t('OPT-OUT NEVER REACHES THE MODEL', async () => {
  // It is ours, and the model does not get a vote. Asking it first is how an
  // agent talks past someone trying to leave.
  let asked = 0;
  const { bridge, stt, of } = build({
    think: async () => { asked++; return { say: 'one more question?', end: false }; },
    isOptOut: (t) => /interest/i.test(t),
  });
  stt.fire({ type: 'transcript', text: 'not interested', final: true });
  await settle();
  assert.equal(asked, 0, 'the brain must not be asked');
  assert.equal(of('disposition')[0].value, 'opt-out');
  assert.ok(bridge.ended, 'and the call ends');
});

await t('a brain outage is reported, and does not end the call', async () => {
  const { bridge, stt, of } = build({ think: async () => { throw new Error('quota'); } });
  stt.fire({ type: 'transcript', text: 'hello', final: true });
  await settle();
  assert.match(of('error')[0].text, /brain: quota/);
  assert.equal(bridge.ended, false, 'they can still speak; she just missed a turn');
});

await t('a voice outage costs the audio and nothing else', async () => {
  const { bridge, stt, of } = build({ speak: async () => { throw new Error('bulbul down'); } });
  stt.fire({ type: 'transcript', text: 'hello', final: true });
  await settle();
  assert.ok(of('said').length, 'the line is still in the transcript');
  assert.match(of('error')[0].text, /voice: bulbul down/);
  assert.equal(bridge.ended, false);
});

await t('audio flows straight through to the recogniser', async () => {
  const { bridge, stt } = build();
  bridge.pushAudio(Buffer.from([1, 2, 3, 4]));
  bridge.pushAudio(Buffer.from([5, 6]));
  assert.equal(stt.sent.length, 2, 'no buffering, no batching — it is a stream');
});

await t('ending the call closes the recogniser', async () => {
  const { bridge, stt, of } = build();
  bridge.end();
  assert.equal(stt.closed, true, 'a socket left open bills for silence');
  assert.ok(of('ended').length);
  bridge.pushAudio(Buffer.from([1]));
  assert.equal(stt.sent.length, 0, 'and nothing is sent after the end');
});

await t('OUTBOUND SPEAKS FIRST, from approved wording', async () => {
  const { bridge, audio, of } = build();
  await bridge.greet('హలో, నేను అనగా, వాక్ నుంచి AI వాయిస్ అసిస్టెంట్‌ని.');
  await settle();
  assert.match(of('said')[0].text, /అనగా/);
  assert.ok(audio.length);
});

// ===========================================================================
section('§4 the socket — a real server, real frames');
// ===========================================================================

await t('A TEXT FRAME IS NOT AUDIO', async () => {
  // media/ws.js emits the STRING 'text' or 'binary' as its second argument,
  // not a boolean. Treating it as one made every control message truthy, so
  // `start` was handed to the recogniser as audio and no conversation ever
  // began — the socket connected, /health said fine, and nothing happened.
  // Only a real frame over a real socket finds this; the fakes above cannot.
  process.env.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'test-key';
  const RealWS = globalThis.WebSocket;
  let fireDG = null;
  globalThis.WebSocket = function (url, protos) {
    if (String(url).includes('deepgram')) {
      const self = { url, send() {}, close() {} };
      Object.defineProperty(self, 'onmessage', {
        set(fn) { fireDG = (o) => fn({ data: JSON.stringify(o) }); },
      });
      setTimeout(() => self.onopen && self.onopen(), 0);
      return self;
    }
    return new RealWS(url, protos);
  };

  const { createAgentServer } = await import('../caller-agent/src/agent/server.js');
  const server = createAgentServer({
    think: async () => ({ say: 'ఉండటానికా, లేక ఇన్వెస్ట్‌మెంట్ కోసమా?', end: false, disposition: 'qualifying' }),
    speak: async () => Buffer.alloc(320, 7),
    greeting: async () => 'హలో, నేను అనగా.',
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.sampleRate, 16000, 'the wire rate must be advertised, not assumed');

    const msgs = [];
    let audioBytes = 0;
    const c = new RealWS(`ws://127.0.0.1:${port}/agent`);
    c.binaryType = 'arraybuffer';
    await new Promise((r) => { c.onopen = r; });
    c.onmessage = (e) => {
      if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
      else audioBytes += e.data.byteLength;
    };

    c.send(JSON.stringify({ type: 'start', lang: 'te-IN', direction: 'outbound' }));
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(msgs.some((m) => m.type === 'ready'), 'a text frame must start the conversation');
    assert.ok(msgs.some((m) => m.type === 'said'), 'and outbound speaks first');

    c.send(new Uint8Array(640));                     // a real binary frame
    fireDG({
      type: 'Results', is_final: true,
      channel: { alternatives: [{ transcript: 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి' }] },
    });
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(msgs.find((m) => m.type === 'heard')?.text, 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి');
    assert.ok(audioBytes > 0, 'her voice must come back as binary PCM on the same socket');
    c.close();
  } finally {
    server.close();
    globalThis.WebSocket = RealWS;
  }
});

// ===========================================================================
section('§5 the phone leg — Twilio, as an envelope round the same bridge');
// ===========================================================================

const tw = await import('../caller-agent/src/agent/twilio.js');
const crypto = await import('node:crypto');

await t('NOTHING TRANSCODES — 8kHz mulaw end to end', () => {
  // Twilio speaks it, Deepgram accepts it, Bulbul can synthesize it. Every
  // conversion between mulaw and linear costs quality, and telephony audio
  // starts with none to spare; resampling to satisfy a hardcoded 16000 would
  // have made the recogniser's job harder for nothing.
  assert.deepEqual(tw.TWILIO_FORMAT, { encoding: 'mulaw', sampleRate: 8000 });
  const q = live.liveQuery({ lang: 'en-IN', ...tw.TWILIO_FORMAT });
  assert.equal(q.get('encoding'), 'mulaw');
  assert.equal(q.get('sample_rate'), '8000');
});

await t('the TwiML CONNECTS the call, it does not fork a copy of it', () => {
  // <Start><Stream> forks the audio and lets the call continue down the rest
  // of the TwiML — that is a transcription setup and it cannot talk back.
  // Only <Connect> hands us the call bidirectionally.
  const x = tw.twiml('wss://agent.example/twilio');
  assert.match(x, /<Connect>/);
  assert.match(x, /<Stream url="wss:\/\/agent\.example\/twilio"/);
  assert.doesNotMatch(x, /<Start>/);
});

await t('a stream URL is escaped into the XML', () => {
  assert.match(tw.twiml('wss://x/y?a=1&b=2'), /a=1&amp;b=2/);
});

await t('THE WEBHOOK FAILS CLOSED without a token', () => {
  // This endpoint answers phone calls and spends money, and an unverified
  // caller is one the compliance gate never saw. "No token configured" must
  // not mean "skip the check" — that is an open endpoint that looks wired.
  assert.equal(tw.validSignature({
    url: 'https://x/incoming-call', params: {}, signature: 'anything', token: '',
  }), false);
  assert.equal(tw.validSignature({
    url: 'https://x/incoming-call', params: {}, signature: '', token: 'tok',
  }), false);
});

await t("a real Twilio signature validates, and a tampered one does not", () => {
  // Their scheme: HMAC-SHA1 over the URL with every param appended in
  // key-sorted order. Built here the way Twilio builds it, so this asserts our
  // implementation rather than restating it.
  const token = 'twilio-auth-token';
  const url = 'https://agent.example/incoming-call';
  const params = { CallSid: 'CA123', From: '+919999999999', To: '+911111111111' };
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const sig = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');

  assert.equal(tw.validSignature({ url, params, signature: sig, token }), true);
  assert.equal(tw.validSignature({
    url, params: { ...params, From: '+910000000000' }, signature: sig, token,
  }), false, 'changing a parameter must invalidate it');
  assert.equal(tw.validSignature({ url, params, signature: sig, token: 'wrong' }), false);
});

await t('OUR OWN VOICE COMING BACK IS NEVER TRANSCRIBED', () => {
  // With both tracks streamed, the outbound one is Anaga. Feeding that to the
  // recogniser is the self-answer loop this project shipped three times — and
  // no echo guard is needed if we simply never listen to ourselves.
  const inbound = tw.parseTwilio(JSON.stringify({
    event: 'media', media: { track: 'inbound', payload: Buffer.from([1, 2, 3]).toString('base64') },
  }));
  assert.equal(inbound.type, 'audio');
  assert.equal(tw.parseTwilio(JSON.stringify({
    event: 'media', media: { track: 'outbound', payload: 'AAAA' },
  })), null);
});

await t('start carries the streamSid; stop ends; anything else is ignored', () => {
  assert.deepEqual(tw.parseTwilio(JSON.stringify({ event: 'start', start: { streamSid: 'MZ1' } })),
    { type: 'start', streamSid: 'MZ1' });
  assert.deepEqual(tw.parseTwilio(JSON.stringify({ event: 'stop' })), { type: 'stop' });
  assert.equal(tw.parseTwilio(JSON.stringify({ event: 'connected' })), null);
  assert.equal(tw.parseTwilio(JSON.stringify({ event: 'mark' })), null);
  assert.equal(tw.parseTwilio('not json'), null);
});

await t('BARGE-IN SENDS A CLEAR — Twilio buffers what we already sent', () => {
  // Cancelling on our side is not enough. Without this the prospect interrupts,
  // we stop sending, and Twilio keeps playing the sentence they are talking
  // over — which on an opt-out is the worst thing this system can do.
  const c = JSON.parse(tw.clearFrame('MZ1'));
  assert.deepEqual(c, { event: 'clear', streamSid: 'MZ1' });
  const f = JSON.parse(tw.mediaFrame('MZ1', Buffer.from([0xff, 0x7f])));
  assert.equal(f.event, 'media');
  assert.equal(f.streamSid, 'MZ1');
  assert.equal(Buffer.from(f.media.payload, 'base64').length, 2, 'audio goes back base64, unconverted');
});

await t('THE PHONE LEG RUNS THE SAME CONVERSATION', async () => {
  // The point of the whole shape: one bridge, two envelopes. If this needed
  // its own turn logic there would be two of them to keep in sync, and the
  // one that drifts is the one nobody is reading.
  process.env.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'test-key';
  const RealWS = globalThis.WebSocket;
  let fireDG = null;
  globalThis.WebSocket = function (url, protos) {
    if (String(url).includes('deepgram')) {
      const self = { url, send() {}, close() {} };
      Object.defineProperty(self, 'onmessage', {
        set(fn) { fireDG = (o) => fn({ data: JSON.stringify(o) }); },
      });
      setTimeout(() => self.onopen && self.onopen(), 0);
      return self;
    }
    return new RealWS(url, protos);
  };
  const { attachTwilio } = await import('../caller-agent/src/agent/server.js');

  const sent = [];
  const handlers = {};
  const fakeSock = {
    send: (d) => sent.push(d),
    close() {},
    on(ev, fn) { handlers[ev] = fn; return this; },
  };
  let askedFormat = null;
  attachTwilio(fakeSock, {
    think: async () => ({ say: 'Are you looking to live in it, or to invest?', end: false }),
    speak: async (t2, l, fmt) => { askedFormat = fmt; return Buffer.from([0xff, 0x7f]); },
    greeting: async () => 'Thanks for calling Vaak. I am Anaga, an AI voice assistant.',
  });

  handlers.message(JSON.stringify({ event: 'start', start: { streamSid: 'MZ9' } }), 'text');
  await new Promise((r) => setTimeout(r, 60));
  // SHE DISCLOSES ON ANSWER. This was missing, and a simulated call found it:
  // the socket opened and sat in silence until the caller spoke. Consent to an
  // inbound call is implied by their dialling; knowing they are talking to an
  // AI is not — and a caller who hears nothing hangs up anyway.
  assert.ok(sent.length > 0, 'an answered call must speak first, not wait to be spoken to');
  handlers.message(JSON.stringify({
    event: 'media', media: { track: 'inbound', payload: 'AAAA' },
  }), 'text');
  fireDG({
    type: 'Results', is_final: true,
    channel: { alternatives: [{ transcript: 'I want a three bedroom' }] },
  });
  await new Promise((r) => setTimeout(r, 200));

  const frames = sent.map((s) => JSON.parse(s));
  assert.ok(frames.some((f) => f.event === 'media' && f.streamSid === 'MZ9'),
    'her voice must go back down the line');
  // The voice was asked for the format the WIRE speaks, not a constant.
  assert.deepEqual(askedFormat, { encoding: 'mulaw', sampleRate: 8000 });
  globalThis.WebSocket = RealWS;
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
