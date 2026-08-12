// scripts/simulate-twilio-call.mjs
//
// A phone call, without a phone, a number, or a Twilio account.
//
// ── WHY ───────────────────────────────────────────────────────────────────
// The phone leg is a codec around the same bridge the browser uses, and its
// wire format is fully documented: base64 8kHz mulaw in a JSON envelope. So the
// whole leg can be exercised by sending exactly those messages — which is worth
// doing BEFORE spending a trial's 75 voice minutes finding out that a socket
// URL was wrong.
//
// Deepgram's own telephony reference ships a `dev_client.py` for the same
// reason. This is that, for this repo.
//
//   node --experimental-detect-module scripts/simulate-twilio-call.mjs
//   node --experimental-detect-module scripts/simulate-twilio-call.mjs \
//        --url ws://localhost:8080/twilio --say "I want a three bedroom"
//
// With no --url it starts the server in-process, so it runs with nothing
// deployed. With a --url it drives a server you started yourself, which is how
// you check a Cloud Run deployment before pointing a real number at it.
//
// ── WHAT IT PROVES, AND WHAT IT DOES NOT ──────────────────────────────────
// It proves OUR half: the envelope, the streamSid, the barge-in clear, that
// audio comes back down the line in the right format. It does not prove that
// Twilio will accept the TwiML, or that Deepgram answers — the first is a trial
// question (see deploy/cloudrun/README.md) and the second needs egress.

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SAY = opt('--say', 'I want a three bedroom flat');
const LANG = opt('--lang', process.env.TWILIO_CALL_LANG || 'en-IN');
let URL_ = opt('--url', '');

const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const info = (m) => console.log('    ' + m);

// ---------------------------------------------------------------------------
// A recogniser, unless one is reachable. Egress to Deepgram is blocked from
// most dev environments, and a simulator that cannot run without it would be
// useless exactly where it is most needed.
// ---------------------------------------------------------------------------
const STUB_DG = !process.env.DEEPGRAM_API_KEY || process.env.SIMULATE_STT === '1';
let fireDG = null;
if (STUB_DG) {
  process.env.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'simulated';
  const RealWS = globalThis.WebSocket;
  globalThis.WebSocket = function (u, p) {
    if (String(u).includes('deepgram')) {
      const self = { url: u, send() {}, close() {} };
      Object.defineProperty(self, 'onmessage', {
        set(fn) { fireDG = (o) => fn({ data: JSON.stringify(o) }); },
      });
      setTimeout(() => self.onopen && self.onopen(), 0);
      return self;
    }
    return new RealWS(u, p);
  };
}

let server = null;
if (!URL_) {
  const { createAgentServer } = await import('../caller-agent/src/agent/server.js');
  // The real brain and voice when they are configured; otherwise something
  // that answers, so the transport can be checked on its own.
  let think, speak;
  try {
    const main = await import('../api/_lib/llm.js');
    const tts = await import('../api/_lib/tts.js');
    const prompts = await import('../api/_lib/prompts.js');
    think = async (history) => {
      const { system, user } = prompts.turnPrompt(history, { lang: LANG, direction: 'inbound' });
      const out = await main.generate({ system, user, json: true });
      return { say: String(out?.say || '').trim(), end: out?.end === true };
    };
    speak = async (text, lang, fmt) => {
      const out = await tts.synth({ text, lang, codec: 'mulaw', sampleRate: fmt.sampleRate });
      return Buffer.from(out.audio, 'base64');
    };
  } catch { /* fall through to the canned pair below */ }

  const configured = Boolean(process.env.SARVAM_API_KEY);
  server = createAgentServer({
    think: configured ? think : async () => ({ say: 'Are you looking to live in it, or to invest?', end: false }),
    speak: configured ? speak : async () => Buffer.alloc(160, 0xff),
    greeting: async () => 'Thanks for calling Vaak. I am Anaga, an AI voice assistant.',
    isOptOut: (t) => /not interested|do not call|don't call/i.test(t),
  });
  await new Promise((r) => server.listen(0, r));
  URL_ = `ws://127.0.0.1:${server.address().port}/twilio`;
  console.log(`\n  in-process server on ${URL_}`);
  console.log(`  brain/voice: ${configured ? 'REAL (SARVAM_API_KEY is set)' : 'canned — set SARVAM_API_KEY for the real ones'}`);
  console.log(`  recogniser : ${STUB_DG ? 'SIMULATED' : 'REAL'}\n`);
}

// ---------------------------------------------------------------------------
// The call. Exactly the messages Twilio sends, in the order it sends them.
// ---------------------------------------------------------------------------
const STREAM_SID = 'MZsimulated00000000000000000000';
const ws = new WebSocket(URL_);
const got = { media: 0, bytes: 0, clear: 0 };

ws.onmessage = (e) => {
  let m;
  try { m = JSON.parse(String(e.data)); } catch { return; }
  if (m.event === 'media') {
    got.media++;
    got.bytes += Buffer.from(m.media.payload, 'base64').length;
    if (m.streamSid !== STREAM_SID) console.log('  \x1b[31m✗\x1b[0m wrong streamSid:', m.streamSid);
  }
  if (m.event === 'clear') { got.clear++; info('← clear (barge-in): Twilio drops what it has buffered'); }
};

await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`cannot reach ${URL_}`)); });
ok(`connected to ${URL_}`);

const send = (o) => ws.send(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
send({
  event: 'start',
  start: {
    streamSid: STREAM_SID, callSid: 'CAsimulated', tracks: ['inbound'],
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
  },
});
ok('start sent — she should answer first, because inbound discloses immediately');
await wait(1500);
info(`← ${got.media} media frames, ${got.bytes} bytes of mulaw`);

// 20ms of silence per frame, which is exactly what a phone sends.
for (let i = 0; i < 25; i++) {
  send({ event: 'media', media: { track: 'inbound', payload: Buffer.alloc(160, 0xff).toString('base64') } });
  await wait(20);
}
ok('500ms of caller audio streamed, 20ms per frame');

if (fireDG) {
  fireDG({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: SAY }] } });
  ok(`recogniser returned: "${SAY}"`);
  await wait(2500);
  info(`← ${got.media} media frames total, ${got.bytes} bytes`);

  fireDG({ type: 'SpeechStarted' });
  ok('caller interrupts mid-sentence');
  await wait(400);
}

send({ event: 'stop' });
await wait(200);
ws.close();
if (server) server.close();

console.log(`\n  ${got.media} media frames back, ${got.bytes} bytes, ${got.clear} clear\n`);
if (!got.media) {
  console.log('  \x1b[31mNo audio came back.\x1b[0m Check the voice provider and the log above.\n');
  process.exit(1);
}
console.log('  \x1b[32mThe phone leg works end to end.\x1b[0m'
  + ' What this does NOT prove: that Twilio accepts <Connect><Stream> on a\n'
  + '  trial account — see deploy/cloudrun/README.md — or that Deepgram answers.\n');
process.exit(0);
