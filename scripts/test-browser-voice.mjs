// scripts/test-browser-voice.mjs
//
// REAL BROWSER test of the male voice and the Google translation fallback.
//
// Runs the shipped page in Chromium against a stub API, so it exercises the
// actual DOM, the actual voice picker, the actual CloudTTS module and the
// actual TranslateKit — not a re-implementation of them.
//
// ── WHAT THIS PROVES ──────────────────────────────────────────────────────
//  * the male preset reaches /api/tts as gender:"male"
//  * when no provider can speak as a man, the UI SAYS SO instead of playing a
//    woman's voice under the name "Arjun"
//  * TranslateKit falls back to POST /api/translate when Chrome's on-device
//    translator is absent — i.e. translation works outside Chrome 138+
//
// ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
// That Google Cloud TTS is enabled on any particular project, or what its
// voices sound like. Both are deploy facts; /api/integrations/health answers
// the first and only ears answer the second.
//
// Run: node scripts/test-browser-voice.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const WEB = path.join(ROOT, 'web');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

// ---------------------------------------------------------------------------
// stub API + static server. `world` is flipped between tests.
// ---------------------------------------------------------------------------
const world = { maleCapable: true, ttsRequests: [], translateRequests: [] };
// 1 frame of silent MP3 — enough for the Audio element to accept the data URI.
const SILENT_MP3 = Buffer.from('//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA', 'base64').toString('base64');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url === '/api/tts') {
    if (req.method === 'GET') {
      return send(200, {
        available: true,
        chain: ['google', 'gtranslate', 'sarvam'],
        ready: world.maleCapable ? ['google', 'gtranslate'] : ['gtranslate'],
        maleCapable: world.maleCapable,
      });
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      world.ttsRequests.push(parsed);
      const wantsMale = parsed.gender === 'male';
      return send(200, {
        audio: SILENT_MP3,
        mime: 'audio/mpeg',
        // The server tells the truth about who spoke: a request for a man is
        // only honoured when a male-capable provider is in the chain.
        provider: world.maleCapable ? 'google' : 'gtranslate',
        voice: world.maleCapable ? (wantsMale ? 'en-IN-Wavenet-B' : 'en-IN-Wavenet-A') : 'translate/en',
        gender: world.maleCapable && wantsMale ? 'male' : 'female',
      });
    });
  }

  if (url === '/api/translate') {
    if (req.method === 'GET') return send(200, { available: true, mode: 'auto', auth: 'none' });
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      world.translateRequests.push(parsed);
      return send(200, { text: `[${parsed.to}] ${parsed.text}`, from: 'en', provider: 'free' });
    });
  }

  if (url.startsWith('/api/')) return send(503, { error: 'llm_unavailable' });

  const f = path.join(WEB, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Stub only the hardware boundary — plus one deliberate removal.
//
// This Chromium DOES ship the on-device Translator API, so left alone the page
// would take the Chrome-only path and the fallback would go untested. Deleting
// those globals reproduces what a Safari, Firefox or older-Chrome visitor
// actually has, which is the case this change exists for.
const INIT = `
(() => {
  for (const k of ['Translator', 'LanguageDetector', 'translation']) {
    try { delete window[k]; } catch (e) {}
  }

  class FakeSR {
    constructor() { this.lang=''; this.interimResults=false; this.continuous=false; this.maxAlternatives=1; }
    start() { window.__srRunning = true; }
    stop()  { window.__srRunning = false; if (this.onend) this.onend(); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = function () { return new FakeSR(); };
  window.webkitSpeechRecognition = window.SpeechRecognition;
  window.SpeechSynthesisUtterance = function (text) {
    this.text = text; this.lang=''; this.rate=1; this.pitch=1; this.volume=1;
    this.onend=null; this.onstart=null; this.onerror=null;
  };
  const spoken = [];
  window.__spoken = spoken;
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    get: () => ({
      speaking: false, pending: false, paused: false,
      getVoices: () => [],
      cancel() {},
      speak(u) {
        if (u && u.text && String(u.text).trim()) spoken.push(String(u.text));
        setTimeout(() => { try { u.onstart && u.onstart(); } catch (e) {} }, 0);
        setTimeout(() => { try { u.onend && u.onend(); } catch (e) {} }, 20);
      },
    }),
  });
})();
`;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 900, height: 1000 } });
await ctx.addInitScript(INIT);

const pageErrors = [];
async function open() {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);   // let the /api/tts + /api/translate probes land
  return page;
}

console.log('\n═══ REAL BROWSER: male voice + Google translation ═══\n');

// ---------------------------------------------------------------------------
let page = await open();

await t('the picker offers all seven Sarvam voices, four female and three male', async () => {
  const cards = await page.$$eval('#voice-picker .voice-card', (n) => n.map((c) => c.dataset.voice));
  assert.deepEqual(cards, ['aria', 'kiara', 'meher', 'arya', 'arjun', 'karun', 'hitesh']);
});

await t('selecting Arjun asks the server for a MALE voice', async () => {
  world.ttsRequests.length = 0;
  await page.click('#voice-picker .voice-card[data-voice="arjun"]');
  await page.waitForTimeout(900);
  const req = world.ttsRequests.at(-1);
  assert.ok(req, 'the click should have hit /api/tts');
  assert.equal(req.gender, 'male');
});

await t('a female preset still asks for a female voice', async () => {
  world.ttsRequests.length = 0;
  await page.click('#voice-picker .voice-card[data-voice="aria"]');
  await page.waitForTimeout(900);
  assert.equal(world.ttsRequests.at(-1).gender, 'female');
});

await t('the note names the provider that actually spoke, not a hardcoded vendor', async () => {
  const note = await page.textContent('#voice-resolved');
  assert.match(note, /Google Cloud/i, `expected the serving provider, got: ${note}`);
  assert.doesNotMatch(note, /Sarvam/i, 'the label must follow the provider, not be baked in');
});

await t('TranslateKit uses the server when the browser has no on-device translator', async () => {
  world.translateRequests.length = 0;
  const out = await page.evaluate(async () => {
    // No window.Translator in this context — this is the non-Chrome path.
    if (window.TranslateKit.onDevice()) return { skipped: true };
    const ok = await window.TranslateKit.prep('hi');
    const line = await window.TranslateKit.out('What is your budget range?', 'hi');
    return { ok, line, mode: window.TranslateKit.mode() };
  });
  assert.equal(out.skipped, undefined, 'this context should NOT have an on-device translator');
  assert.equal(out.ok, true, 'prep() must confirm the server path really works');
  assert.equal(out.mode, 'google');
  assert.equal(out.line, '[hi] What is your budget range?');
  assert.ok(world.translateRequests.some((r) => r.to === 'hi'), 'the server should have been asked for Hindi');
});

await t('the caller-speech pass translates back to English for the rule engine', async () => {
  const back = await page.evaluate(() => window.TranslateKit.in('मुझे दो करोड़ का घर चाहिए', 'hi'));
  assert.equal(back, '[en] मुझे दो करोड़ का घर चाहिए');
});

await t('a server that returns provider "none" counts as a MISS, not a translation', async () => {
  // provider "none" means the text came back untranslated. Treating it as a
  // success would have Anaga speak English while the UI claims Hindi.
  const miss = await page.evaluate(async () => {
    const realFetch = window.fetch;
    window.fetch = async (u, i) => {
      if (String(u).includes('/api/translate') && i && i.method === 'POST') {
        return new Response(JSON.stringify({ text: 'untranslated', from: 'en', provider: 'none' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(u, i);
    };
    const r = await window.TranslateKit.out('a line nobody translated before', 'te');
    window.fetch = realFetch;
    return r;
  });
  assert.equal(miss, null);
});

await page.close();

// ---------------------------------------------------------------------------
// Second world: nothing in the chain can speak as a man.
// ---------------------------------------------------------------------------
world.maleCapable = false;
page = await open();

await t('THE HONESTY RULE: with no male-capable provider, the card says so', async () => {
  const card = await page.$('#voice-picker .voice-card[data-voice="arjun"]');
  const cls = await card.getAttribute('class');
  assert.match(cls, /is-unavailable/, 'the male card must be marked unavailable');
  const title = await card.getAttribute('title');
  assert.match(title, /Google Cloud Text-to-Speech/i, `the card must explain what is missing, got: ${title}`);
});

await t('and the chip warns rather than presenting a woman as "Arjun"', async () => {
  await page.click('#voice-picker .voice-card[data-voice="arjun"]');
  await page.waitForTimeout(900);
  await page.click('#start-call');
  await page.waitForSelector('#call-transcript .bubble--anaga', { timeout: 8000 });
  await page.waitForTimeout(1400);
  const chip = await page.textContent('#call-voice');
  const title = await page.getAttribute('#call-voice', 'title');
  const state = await page.evaluate(() => JSON.stringify(window.CloudTTS.status()));
  assert.match(chip, /Arjun/);
  assert.match(chip, /⚠/, `the mismatch must be visible on the chip, got: ${chip} | CloudTTS=${state} | posted=${world.ttsRequests.length}`);
  assert.match(title, /no male voice/i, `the reason must be readable, got: ${title}`);
});

await t('XSS: a hostile LLM reply cannot execute in the transcript', async () => {
  // Everything that reaches addBubble is attacker-reachable: the model's reply
  // (which echoes what the caller just said), the translation response, and the
  // caller's own speech. This page keeps a visitor-supplied Gemini API key in
  // localStorage, so script execution here is credential theft.
  const result = await page.evaluate(async () => {
    window.__xss = false;
    localStorage.setItem('vaak_canary', 'secret-key-value');
    const t = document.getElementById('call-transcript');
    const before = t.querySelectorAll('.bubble').length;

    // Drive the real renderer through the real text path.
    const input = document.getElementById('call-textinput');
    const form = document.getElementById('call-textform');
    input.value = '<img src=x onerror="window.__xss=true">';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 600));

    const bubbles = [...t.querySelectorAll('.bubble')];
    const added = bubbles.length > before;
    const withImg = bubbles.filter((b) => b.querySelector('img')).length;
    const shown = bubbles.map((b) => (b.querySelector('.bubble__txt') || {}).textContent || '');

    // CONTROL: the same payload through the OLD innerHTML template, into a
    // detached node. A security test that passes because the payload was inert
    // proves nothing — this shows the payload really does build an element, so
    // the assertions above are measuring the fix and not a dud input.
    const probe = document.createElement('div');
    probe.innerHTML = `<span class="bubble__txt">${'<img src=x onerror="window.__control=true">'}</span>`;
    const controlBuiltElement = !!probe.querySelector('img');

    return {
      xss: window.__xss, added, withImg,
      showsRaw: shown.some((x) => x.includes('<img')),
      controlBuiltElement,
    };
  });

  assert.equal(result.controlBuiltElement, true,
    'control failed: the payload must actually build an element via innerHTML');
  assert.equal(result.xss, false, 'the injected handler MUST NOT have run');
  assert.equal(result.withImg, 0, 'no element may be created from the payload');
  assert.equal(result.showsRaw, true, 'and the text should still be displayed, as text');
});

// ---------------------------------------------------------------------------
// MOBILE AUTOPLAY — the bug that made the cloud voice unreachable on a phone.
//
// A browser only lets audio start from inside a user gesture. Every line was
// played from a .then() AFTER the /api/tts fetch, on a FRESH Audio element, so
// play() was rejected on every phone, the catch ran the device-voice fallback,
// and the page went on saying "Cloud voices" because the readiness probe is a
// GET that has nothing to do with whether audio can play.
// ---------------------------------------------------------------------------

/** Instrument HTMLMediaElement.play so a test can see the unlock and block it. */
async function instrumentAudio(p, { block = false } = {}) {
  await p.evaluate((shouldBlock) => {
    window.__audio = { plays: [], elements: [], spoke: 0 };
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!window.__audio.elements.includes(this)) window.__audio.elements.push(this);
      window.__audio.plays.push({ src: String(this.src).slice(0, 32), muted: this.muted, at: Date.now() });
      if (shouldBlock) {
        const e = new Error('blocked'); e.name = 'NotAllowedError';
        return Promise.reject(e);
      }
      return realPlay.apply(this, arguments);
    };
    if (window.speechSynthesis) {
      const realSpeak = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = function (u) {
        // The silent primer is not a device voice; only count real speech.
        if (u && u.text && u.text.trim()) window.__audio.spoke++;
        return realSpeak(u);
      };
    }
  }, block);
}

await t('AUTOPLAY: audio is unlocked inside the tap, before any network call', async () => {
  world.ttsRequests.length = 0;
  await page.goto(BASE);
  await instrumentAudio(page);
  await page.click('#hear-anaga');
  // The unlock has to be synchronous within the gesture — so a play() must have
  // happened before the /api/tts response could possibly have come back.
  const first = await page.evaluate(() => window.__audio.plays[0] || null);
  assert.ok(first, 'nothing was played inside the tap — the element is never unlocked');
  assert.equal(first.muted, true, 'the unlock should play a MUTED silent clip, not the line');
});

await t('AUTOPLAY: the same element is reused, or the unlock was pointless', async () => {
  await page.waitForFunction(() => window.__audio.plays.length >= 2, null, { timeout: 8000 });
  const n = await page.evaluate(() => window.__audio.elements.length);
  assert.equal(n, 1, `a fresh Audio() per line is not unlocked; used ${n} elements`);
});

await t('AUTOPLAY BLOCKED: the handset voice is NOT quietly substituted', async () => {
  await page.goto(BASE);
  await instrumentAudio(page, { block: true });
  await page.click('#hear-anaga');
  // Generous: this is a NEGATIVE assertion, so it must outlast the whole
  // fetch -> blocked play -> fallback chain rather than beat it.
  await page.waitForTimeout(3000);
  const spoke = await page.evaluate(() => window.__audio.spoke);
  assert.equal(spoke, 0,
    'the device voice spoke — that is the "shitty voice from nowhere" this whole fix exists to stop');
});

await t('AUTOPLAY BLOCKED: the page SAYS the browser blocked it', async () => {
  const note = await page.locator('#voice-note').innerText();
  assert.ok(/blocked|Tap/i.test(note), `a blocked line must explain itself, got: "${note}"`);
});

// NOT COVERED: the vaak_allow_device_voice escape hatch. Verified by hand (the
// opt-in does still reach browserSpeak), but asserting it here depends on the
// shared `world` stub left by earlier tests in this file, and a test that fails
// for reasons unrelated to what it claims to check is worse than an honest gap.
await t('no uncaught page errors across either world', () => {
  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
});

const shot = process.env.SHOT_PATH || '/tmp/browser-voice.png';
await page.screenshot({ path: shot, fullPage: false });
console.log(`\n  screenshot: ${shot}`);

await browser.close();
server.close();

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
