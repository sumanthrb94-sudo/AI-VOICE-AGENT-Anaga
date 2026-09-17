// scripts/test-half-duplex.mjs
//
// THE MICROPHONE MUST BE SHUT WHILE SHE SPEAKS.
//
// Her audio leaves the laptop speaker and returns to the microphone. Deepgram
// cannot tell her voice from the prospect's, so it fires speech_start, the
// bridge reads that as barge-in and calls cutOff(), and she interrupts herself
// mid-sentence — every sentence. From the other side of the table that is
// indistinguishable from "the microphone is interrupting everything".
//
// echoCancellation:true does not prevent it: her audio is rendered through a
// Web Audio graph into ctx.destination, which Chrome's echo canceller does not
// reliably take as its reference. web/assets/app.js hit this on the older path
// and wrote down the evidence — real echo arrived as "calling" and "wonderful
// thank you", both committed as caller turns, both far under any threshold a
// text filter could use.
//
// So these assertions are about bytes: while `speaking` is true, NOTHING may
// reach the socket. Not filtered, not scored — not sent.
//
// Run: node --experimental-detect-module scripts/test-half-duplex.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ the fixtures */

/** Everything live.js touches, and nothing it does not. */
function harness() {
  const sent = [];           // what actually reached the socket
  const played = [];         // messages posted to the playback worklet
  let capturePort = null;    // the mic's message pump, once wired
  let socket = null;

  class FakePort {
    constructor(sink) { this.onmessage = null; this._sink = sink; }
    postMessage(m) { if (this._sink) this._sink(m); }
  }
  class FakeNode {
    constructor(_ctx, name) {
      this.name = name;
      this.port = new FakePort(name === 'anaga-playback' ? (m) => played.push(m) : null);
      if (name === 'anaga-capture') capturePort = this.port;
    }
    connect(next) { return next; }
  }

  const win = {
    __micLive: false,
    setTimeout, clearTimeout,
    location: { protocol: 'https:', host: 'x.test' },
    ANAGA_AGENT_URL: 'wss://agent.test/agent',
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
    },
    AudioContext: class {
      constructor() { this.audioWorklet = { addModule: async () => {} }; this.destination = {}; }
      createMediaStreamSource() { return { connect: (n) => n }; }
      createGain() { return { gain: {}, connect: (n) => n }; }
      close() {}
    },
    AudioWorkletNode: FakeNode,
    WebSocket: class {
      constructor(url) {
        this.url = url; this.readyState = 0; socket = this;
        queueMicrotask(() => { this.readyState = 1; this.onopen && this.onopen(); });
      }
      send(d) { sent.push(d); }
      close() { this.readyState = 3; }
    },
  };
  win.window = win;

  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync('web/assets/live.js', 'utf8'), ctx, { filename: 'live.js' });

  return {
    win, sent, played,
    createLiveCall: win.createLiveCall,
    /** One buffer of captured microphone audio. */
    speakIntoMic: (n = 320) => capturePort.onmessage({ data: new ArrayBuffer(n) }),
    /** A server event, as the socket would deliver it. */
    fromServer: (o) => socket.onmessage({ data: JSON.stringify(o) }),
    /** Bytes sent that are audio rather than the JSON control messages. */
    audioBytes: () => sent.filter((d) => typeof d !== 'string').length,
  };
}

async function live(opts = {}) {
  const h = harness();
  const call = h.createLiveCall({ ...opts });
  await call.start('te-IN', 'outbound');
  await tick(0);
  return { ...h, call };
}

console.log('\n═══ THE MIC IS SHUT WHILE SHE SPEAKS ═══\n');

/* ------------------------------------------------------------------ gating */

console.log('§1 the gate');

await t('before she speaks, the microphone is open', async () => {
  const h = await live();
  h.speakIntoMic();
  assert.equal(h.audioBytes(), 1, 'audio captured before her first word was dropped');
  assert.equal(h.call.isMuted(), false);
});

await t('while she speaks, NOT ONE BYTE reaches the socket', async () => {
  const h = await live();
  h.fromServer({ type: 'speaking', value: true });
  for (let i = 0; i < 25; i++) h.speakIntoMic();
  assert.equal(h.audioBytes(), 0, 'HER OWN VOICE IS BEING SENT BACK TO THE RECOGNISER');
  assert.equal(h.call.isMuted(), true);
});

await t('it reopens after she finishes — but not on the same tick', async () => {
  const h = await live();
  h.fromServer({ type: 'speaking', value: true });
  h.fromServer({ type: 'speaking', value: false });

  // The tail of her last word is still leaving the speaker.
  h.speakIntoMic();
  assert.equal(h.audioBytes(), 0, 'reopened instantly — the tail is captured as the prospect');

  await tick(400);
  h.speakIntoMic();
  assert.equal(h.audioBytes(), 1, 'the mic never reopened — the call is now deaf');
});

await t('what was captured while shut is DROPPED, never queued', async () => {
  // Queuing would replay her echo into the recogniser a moment later, which
  // is the same bug with a delay on it.
  const h = await live();
  h.fromServer({ type: 'speaking', value: true });
  for (let i = 0; i < 10; i++) h.speakIntoMic();
  h.fromServer({ type: 'speaking', value: false });
  await tick(400);
  assert.equal(h.audioBytes(), 0, 'buffered echo was flushed once the mic reopened');
});

await t('back-to-back turns do not leave the mic stuck shut', async () => {
  const h = await live();
  for (let i = 0; i < 3; i++) {
    h.fromServer({ type: 'speaking', value: true });
    h.fromServer({ type: 'speaking', value: false });
  }
  await tick(400);
  h.speakIntoMic();
  assert.equal(h.audioBytes(), 1);
  assert.equal(h.call.isMuted(), false);
});

/* ------------------------------------------------------- the way back in */

console.log('\n§2 interrupting her on purpose');

await t('interrupt() opens the mic and drops what is buffered', async () => {
  const h = await live();
  h.fromServer({ type: 'speaking', value: true });
  assert.equal(h.call.isMuted(), true);

  assert.equal(h.call.interrupt(), true);
  assert.equal(h.call.isMuted(), false, 'interrupt did not reopen the mic');
  assert.ok(h.played.includes('clear'), 'her buffered audio kept playing after the interrupt');

  // And the speech that follows must reach the recogniser — that is what makes
  // the SERVER perform a real barge-in rather than this being a local mute.
  h.speakIntoMic();
  assert.equal(h.audioBytes(), 1);
});

await t('a later `speaking:false` does not re-mute after an interrupt', async () => {
  const h = await live();
  h.fromServer({ type: 'speaking', value: true });
  h.call.interrupt();
  h.fromServer({ type: 'speaking', value: false });
  await tick(400);
  h.speakIntoMic();
  assert.equal(h.audioBytes(), 1);
});

/* ---------------------------------------------------------------- earphones */

console.log('\n§3 earphones — no acoustic path, so no gate');

await t('halfDuplex:false keeps the mic open through her whole turn', async () => {
  const h = await live({ halfDuplex: false });
  h.fromServer({ type: 'speaking', value: true });
  for (let i = 0; i < 5; i++) h.speakIntoMic();
  assert.equal(h.audioBytes(), 5, 'open-mic barge-in is broken with earphones');
  assert.equal(h.call.isHalfDuplex(), false);
});

await t('the default is ON — a speaker is the case you cannot detect', async () => {
  const h = await live();
  assert.equal(h.call.isHalfDuplex(), true,
    'defaulting open means every laptop demo self-interrupts');
});

/* ----------------------------------------------------------- not going deaf */

console.log('\n§4 the failure that must not be silent');

await t('a lost `speaking:false` cannot shut the mic forever', async () => {
  // A dropped event would otherwise leave a live call that can never hear
  // again, with no error anywhere — the worst shape a demo bug can take.
  const h = await live();
  h.fromServer({ type: 'speaking', value: true });
  assert.equal(h.call.isMuted(), true);
  const src = readFileSync('web/assets/live.js', 'utf8');
  assert.match(src, /MAX_MUTE_MS/, 'no deadman timer guards a lost speaking:false');
  const m = src.match(/var MAX_MUTE_MS = (\d+)/);
  assert.ok(m && Number(m[1]) >= 5000 && Number(m[1]) <= 60000,
    'the deadman should be longer than an utterance and shorter than a call');
});

await t('the UI is told, so nobody talks into a closed mic', async () => {
  const seen = [];
  const h = await live({ onMic: (open) => seen.push(open) });
  h.fromServer({ type: 'speaking', value: true });
  h.fromServer({ type: 'speaking', value: false });
  await tick(400);
  assert.deepEqual(seen, [false, true], `onMic reported ${JSON.stringify(seen)}`);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
