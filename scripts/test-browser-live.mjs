// scripts/test-browser-live.mjs
//
// REAL BROWSER against the REAL agent service: web/live.html, the streaming
// call page, over an actual WebSocket.
//
// scripts/test-agent-bridge.mjs proves the server. This proves the half nobody
// can see from Node — that a page opens a socket, streams PCM up, shows an
// interim transcript as a draft and replaces it with the final one, and plays
// what comes back. The old HTTP page's worst bugs all lived exactly here.
//
// Only Deepgram is faked; the socket, the page, the AudioWorklet and the frames
// are real.
//
// Run: node scripts/test-browser-live.mjs

import assert from 'node:assert';
import { launchChromium } from './playwright.mjs';

process.env.DEEPGRAM_API_KEY = 'test-key';

// Intercept only the Deepgram socket — there is no egress to it from here.
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

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

// 320 bytes = 10ms of 16kHz 16-bit audio, so playback has something real.
const server = createAgentServer({
  think: async () => ({ say: 'Are you looking to live in it, or to invest?', end: false, disposition: 'qualifying' }),
  speak: async () => Buffer.alloc(320, 0),
  greeting: async () => 'Hi, I am Anaga, an AI voice assistant from Vaak.',
  isOptOut: (x) => /not interested/i.test(x),
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));

// A real MediaStream with no hardware — this container has no audio device, and
// every Chromium fake-device flag returns NotFoundError. An oscillator through
// createMediaStreamDestination() yields a genuine stream a genuine AudioWorklet
// will process. Only the hardware is synthetic.
await page.addInitScript(() => {
  window.__gum = null;
  const AC = window.AudioContext || window.webkitAudioContext;
  navigator.mediaDevices = navigator.mediaDevices || {};
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__gum = c;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.05;          // quiet, but not silent: real samples
    osc.connect(gain).connect(dest);
    osc.start();
    return dest.stream;
  };
});

console.log('\n═══ REAL BROWSER: the streaming call page ═══\n');

await page.goto(`${BASE}/live.html`);
await page.waitForSelector('#start');

await t('the agent service serves its own call page', async () => {
  // One command for the whole local loop. Typing a WebSocket URL on a phone
  // once is enough.
  assert.equal(await page.locator('#start').count(), 1);
  assert.equal(await page.locator('#lang button[data-lang="en-IN"]').getAttribute('aria-pressed'), 'true',
    'English is the default — it is the language being demoed first');
});

await t('THE PAGE OPENS A SOCKET AND SHE SPEAKS FIRST', async () => {
  await page.locator('#start').click();
  await page.waitForSelector('#log .ln.her', { timeout: 15000 });
  const her = await page.locator('#log .ln.her').first().innerText();
  assert.match(her, /AI voice assistant/, 'the opening must disclose');
});

await t('the microphone is asked for WITH echo cancellation', async () => {
  // Deepgram's VAD cannot tell her voice from the prospect's if the browser
  // hands it both. This is still the whole design.
  const c = await page.evaluate(() => window.__gum);
  assert.equal(c?.audio?.echoCancellation, true);
});

await t('AUDIO STREAMS UP AS IT IS CAPTURED — no recording, no upload', async () => {
  // The entire point. The old page recorded a whole utterance and POSTed it,
  // and every heuristic it grew came from that one decision.
  await page.waitForTimeout(600);
  const bytes = await page.evaluate(() => window.__sentBytes || 0);
  assert.ok(bytes > 0, 'PCM must be flowing to the server already');
});

await t('AN INTERIM TRANSCRIPT IS A DRAFT, and the final one replaces it', async () => {
  // Showing a partial as settled text is how a demo looks like it misheard
  // you — and appending each one would produce a wall of near-duplicates.
  fireDG({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'I want a three' }] } });
  await page.waitForSelector('#log .ln.draft', { timeout: 8000 });
  assert.match(await page.locator('#log .ln.draft').innerText(), /I want a three/);

  fireDG({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'I want a three bedroom' }] } });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#log .ln.draft').count(), 1, 'one draft, updated — not one per word');

  fireDG({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'I want a three bedroom flat' }] } });
  await page.waitForFunction(() => document.querySelectorAll('#log .ln.you').length > 0, null, { timeout: 8000 });
  assert.equal(await page.locator('#log .ln.draft').count(), 0, 'the draft must be replaced, not left behind');
  assert.match(await page.locator('#log .ln.you').last().innerText(), /three bedroom flat/);
});

await t('and she answers it', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#log .ln.her').length >= 2,
    null, { timeout: 15000 });
  assert.match(await page.locator('#log .ln.her').last().innerText(), /live in it/);
});

await t('HER VOICE COMES BACK ON THE SAME SOCKET, as binary', async () => {
  const got = await page.evaluate(() => window.__gotAudio || 0);
  assert.ok(got > 0, 'audio must arrive as binary frames, not as a second request');
});

await t('ending the call releases the microphone', async () => {
  await page.locator('#end').click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__micLive === false), true);
});

await t('no uncaught page errors', () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
server.close();
globalThis.WebSocket = RealWS;

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
