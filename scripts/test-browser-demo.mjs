// scripts/test-browser-demo.mjs
//
// REAL BROWSER test of web/index.html — the live-call screen, which is the home
// page. It used to live at /demo.html while the voice sampler held the root; the
// sampler's job ended the moment a voice was chosen, and leaving it as the front
// door meant the demo URL showed a picker with one card on it.
//
// ── WHAT MAKES THIS DEMO WORTH TESTING ────────────────────────────────────
// It is a real call, not a playback. Every line comes from /api/anaga/turn
// against the versioned flow and is spoken by /api/tts. That is the claim being
// made to the room, so the tests are about the claim:
//
//   - the language you pick is the language the brain and the voice are asked for
//   - INBOUND and OUTBOUND are genuinely different conversations, not a label
//   - the opt-out ends the call in the CLIENT, whatever the model returns
//   - nothing is synthesized before the gesture that unlocks audio
//   - the transcript survives a voice outage, because it is written first
//
// Run: node scripts/test-browser-demo.mjs

import assert from 'node:assert';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

process.env.STUB_VENDORS = '1';
process.env.SARVAM_API_KEY = process.env.SARVAM_API_KEY || 'test-key';
process.env.SARVAM_STREAM = '0';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const STUB_SAY = 'Are you looking to live in it, or to invest?';
process.env.STUB_LLM_SAY = STUB_SAY;

const { createDevServer } = await import('./dev-server.mjs');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

const server = createDevServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));

const turns = [], synths = [];
page.on('request', (r) => {
  if (r.method() !== 'POST') return;
  try {
    const b = JSON.parse(r.postData() || '{}');
    if (r.url().includes('/api/anaga/turn')) turns.push(b);
    if (r.url().includes('/api/tts')) synths.push(b);
  } catch { /* ignore */ }
});

// Timestamp every synth request inside the page, so "was phrase 2 requested
// while phrase 1 was playing?" is a measurement rather than an inference.
await page.addInitScript(() => {
  window.__ttsPosts = []; window.__ttsTimes = [];
  const real = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).includes('/api/tts') && init && init.method === 'POST') {
      window.__ttsPosts.push(1);
      window.__ttsTimes.push(Math.round(performance.now()));
    }
    return real.apply(this, arguments);
  };
});

const restart = async () => {
  await page.goto(BASE);                 // the call IS the home page now
  await page.waitForSelector('#start');
  turns.length = 0; synths.length = 0;
};

console.log('\n═══ REAL BROWSER: the investor call screen ═══\n');
await restart();

await t('NOTHING IS CALLED UNTIL THE CALL STARTS', async () => {
  await page.waitForTimeout(1200);
  assert.equal(turns.length, 0, `${turns.length} brain calls before anyone pressed start`);
  assert.equal(synths.length, 0, `${synths.length} synth calls before anyone pressed start`);
});

await t('the call screen replaces the setup screen', async () => {
  await page.locator('#start').click();
  await page.waitForSelector('#log .ln.her', { timeout: 10000 });
  assert.ok(await page.locator('body.in-call').count(), 'the call screen must be showing');
  assert.equal(await page.locator('.setup').isVisible(), false);
});

await t('ANAGA OPENS — and the opening is DATA, not a generation', async () => {
  // Her first line is reviewed, versioned wording in caller-agent/flows. Asking
  // the model for a sentence that is already written cost an LLM round trip at
  // the most latency-sensitive moment of the call, and risked a paraphrase of
  // the reviewed disclosure reaching a real prospect.
  // NOT /Anaga/ — every bubble carries "Anaga" as its speaker label, so that
  // pattern matches even when she said something else entirely. It did, and
  // hid the fact that the opening was still coming from the model.
  const her = await page.locator('#log .ln.her').first().innerText();
  assert.match(her, /AI voice assistant/i, 'the AI disclosure is the first thing said');
  assert.equal(turns.length, 0, 'the opening must not cost a brain call');

  const approved = await page.evaluate(() => fetch('/api/anaga/turn?lang=te-IN&direction=outbound')
    .then((r) => r.json()));
  assert.equal(approved.source, 'flow', 'the endpoint must say it is not a generation');
  assert.ok(her.includes(approved.say), 'she must say the approved line verbatim');
});

await t('the LANGUAGE picked reaches the voice', async () => {
  assert.ok(synths.length >= 1, 'the opening line must be spoken');
  assert.equal(synths[0].lang, 'te-IN', 'the voice must be asked for the same language');
});

await t('THE OPENING IS PRE-SYNTHESIZED, before the call starts', async () => {
  // The two slowest things on the call — a brain round trip and a synthesis —
  // both happen while you are still choosing a language.
  const armed = await page.evaluate(() => !!(window.__openingReady));
  assert.ok(armed, 'the opening audio should already be in hand');
});

await t('…but a call started INSTANTLY still opens with the approved line', async () => {
  // Someone who lands and hits Start before the prewarm lands must get the same
  // words, just a little later. Prewarming removes the WAIT; it is not what
  // makes the line correct.
  await restart();
  await page.locator('#start').click({ force: true });
  await page.waitForSelector('#log .ln.her', { timeout: 10000 });
  const her = await page.locator('#log .ln.her').first().innerText();
  assert.match(her, /AI voice assistant/i, `expected the approved line, got "${her}"`);
  assert.equal(turns.length, 0, 'still no brain call for the opening');
});

await t('the timer runs', async () => {
  await page.waitForFunction(() => /00:0[1-9]/.test(document.getElementById('timer').textContent),
    null, { timeout: 6000 });
});

await t('a typed reply appears as the PROSPECT and gets an answer', async () => {
  const before = await page.locator('#log .ln').count();
  await page.locator('#say').fill('I am looking to invest');
  await page.locator('#compose button[type=submit]').click();
  await page.waitForFunction((n) => document.querySelectorAll('#log .ln').length >= n + 2,
    before, { timeout: 10000 });
  const you = await page.locator('#log .ln.you').last().innerText();
  assert.ok(you.includes('I am looking to invest'));
  assert.ok(you.includes('Prospect'), 'every line must say who said it');
  // Only turns AFTER the opening go to the brain, and they carry the setting.
  assert.ok(turns.length >= 1, 'a real reply does need the brain');
  assert.equal(turns[0].lang, 'te-IN');
  assert.equal(turns[0].direction, 'outbound');
});

await t('THE OPT-OUT ENDS THE CALL, whatever the model returns', async () => {
  // The stub always answers end:false and keeps qualifying. The client must
  // stop anyway — on a real call this is where the number joins the
  // suppression list, before anything else happens.
  const brainCalls = turns.length;
  await page.locator('#say').fill('not interested, do not call me again');
  await page.locator('#compose button[type=submit]').click();
  await page.waitForSelector('body.ended', { timeout: 10000 });

  assert.equal(turns.length, brainCalls, 'the brain must not be consulted about an opt-out');
  const her = await page.locator('#log .ln.her').last().innerText();
  // The screen is in Telugu here, so assert the Telugu acknowledgement. An
  // English-only assertion passes on a page nobody in the demo can read.
  assert.match(her, /డు-నాట్-కాల్/, `expected a do-not-call acknowledgement, got "${her}"`);
  const rows = await page.locator('#rows').innerText();
  assert.match(rows, /opt-out/, 'the outcome must record the disposition');
});

await t('the outcome card scores the call from the SERVER, not the model', async () => {
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById('score').textContent),
    null, { timeout: 10000 });
  const score = Number(await page.locator('#score').innerText());
  assert.ok(score >= 0 && score <= 100, `expected a 0-100 score, got ${score}`);
});

// ── the other three combinations ────────────────────────────────────────────

await t('INBOUND is a different conversation, not a different label', async () => {
  const flow = await page.evaluate(() => fetch('/api/tts').then(() => null));
  const dirs = await page.evaluate(async () => {
    const r = await fetch('/api/anaga/turn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: [{ role: 'user', text: 'hi' }], direction: 'inbound' }),
    });
    return r.json();
  });
  assert.equal(dirs.direction, 'inbound', 'the endpoint must echo what it actually used');
  void flow;
});

for (const [lang, label] of [['hi-IN', 'Hindi'], ['en-IN', 'English']]) {
  await t(`${label} runs end to end`, async () => {
    await restart();
    await page.locator(`#lang button[data-lang="${lang}"]`).click();
    await page.locator('#dir button[data-dir="inbound"]').click();
    // The opening for the DEFAULT combo is prewarmed on load, so synths[0] is
    // a Telugu request that happened before this switch. Only what is asked
    // for after the choice says anything about the choice.
    synths.length = 0;
    await page.locator('#start').click();
    await page.waitForSelector('#log .ln.her', { timeout: 10000 });
    await page.waitForFunction(() => window.__ttsPosts.length > 0, null, { timeout: 8000 }).catch(() => {});
    assert.ok(synths.length, 'the opening must be spoken');
    assert.equal(synths[0].lang, lang, 'the voice follows the language too');
    const her = await page.locator('#log .ln.her').first().innerText();
    const approved = await page.evaluate((l) => fetch('/api/anaga/turn?lang=' + l + '&direction=inbound')
      .then((r) => r.json()), lang);
    assert.ok(her.includes(approved.say), `${lang} must open with its own approved line`);
    const sub = await page.locator('#sub').innerText();
    assert.ok(sub.includes('Incoming'), `an inbound call must say so, got "${sub}"`);
  });
}

await t('THE TRANSCRIPT SURVIVES A VOICE OUTAGE', async () => {
  // The line is written before it is spoken, so a dead vendor costs the audio
  // and nothing else. A demo that goes blank when TTS fails is a demo that
  // fails in the room.
  await restart();
  await page.route('**/api/tts', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: '{"error":"tts_unavailable"}',
  }));
  await page.locator('#start').click();
  await page.waitForSelector('#log .ln.her', { timeout: 10000 });
  const her = await page.locator('#log .ln.her').first().innerText();
  assert.match(her, /AI voice assistant/i, 'the words must appear even with no voice');
  const st = await page.locator('#state').innerText();
  assert.match(st, /voice unavailable/i, `and it must say why, got "${st}"`);
  await page.unroute('**/api/tts');
});


// ── half-duplex, with a stubbed recogniser ──────────────────────────────────
// This is the guarantee scripts/test-browser-echo.mjs used to hold on the old
// call page: Anaga must not hear herself and answer herself. That page is gone
// — web/assets/app.js is now referenced by no HTML in this repo — but the
// failure it protected against is a property of ANY page with a mic and a
// speaker, so it moves here rather than being retired.
//
// The old page defended with text-matching ("did that sound like what I just
// said?"). This one closes the microphone instead, which cannot be fooled by a
// prospect who happens to repeat Anaga's words back to her.

const SR_STUB = () => {
  window.__sr = { starts: 0, aborts: 0, live: false, current: null };
  function Stub() {
    window.__sr.current = this;
    this.lang = ''; this.interimResults = false; this.continuous = false;
  }
  Stub.prototype.start = function () { window.__sr.starts++; window.__sr.live = true; };
  Stub.prototype.stop = function () {
    window.__sr.live = false;
    if (this.onend) this.onend();
  };
  Stub.prototype.abort = function () {
    window.__sr.aborts++; window.__sr.live = false;
    if (this.onend) this.onend();
  };
  window.SpeechRecognition = Stub;
  window.webkitSpeechRecognition = Stub;
  // Deliver a recognition result the way the browser would.
  window.__hear = function (text, isFinal) {
    const r = window.__sr.current;
    if (!r || !r.onresult) return false;
    r.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: !!isFinal })] });
    return true;
  };
};

await page.addInitScript(SR_STUB);
await restart();
await page.locator('#lang button[data-lang="en-IN"]').click();
await page.locator('#start').click();
await page.waitForSelector('#log .ln.her', { timeout: 10000 });

await t('the mic button opens the recogniser', async () => {
  await page.locator('#mic').click();
  await page.waitForFunction(() => window.__sr.starts > 0, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('mic').getAttribute('aria-pressed')), 'true');
});

await t('THE MIC IS CLOSED WHILE ANAGA SPEAKS — and STAYS closed', async () => {
  const before = await page.evaluate(() => window.__sr.aborts);
  await page.locator('#say').fill('three bedrooms please');
  await page.locator('#compose button[type=submit]').click();
  // Her reply triggers speak(), which must close recognition before any audio
  // starts. An open mic on a phone speaker hears her and answers her.
  await page.waitForFunction((n) => window.__sr.aborts > n, before, { timeout: 10000 });

  // STAYS closed. Asserting only that an abort happened is what let this ship
  // broken: aborting fires onend synchronously, onend reopened the mic in the
  // same tick, and the abort counter went up exactly as it does when the fix is
  // working. The property is "shut while she talks", not "shut once".
  const live = await page.evaluate(() =>
    document.body.classList.contains('speaking') ? window.__sr.live : null);
  assert.notEqual(live, true, 'the mic reopened while Anaga still had the floor');
});

await t('and it REOPENS once she has finished', async () => {
  await page.waitForFunction(() => window.__sr.live === true, null, { timeout: 10000 });
});

await t('AN OPT-OUT HEARD THROUGH THE MIC still ends the call', async () => {
  // The one thing that must never be discarded as noise, echo, or a half-heard
  // phrase. It ends the call here, in the client.
  const ok = await page.evaluate(() => window.__hear('actually please remove me from your list', true));
  assert.equal(ok, true, 'the stub must be wired to the live recogniser');
  await page.waitForSelector('body.ended', { timeout: 10000 });
  const her = await page.locator('#log .ln.her').last().innerText();
  assert.match(her, /do-not-call/i, `expected the opt-out acknowledgement, got "${her}"`);
});

await t('the mic is released when the call ends', async () => {
  assert.equal(await page.evaluate(() => window.__sr.live), false, 'a finished call must not hold the mic');
  assert.equal(await page.evaluate(() => document.getElementById('mic').getAttribute('aria-pressed')), 'false');
});


// ── first phrase first ──────────────────────────────────────────────────────
// Synthesizing a whole line before playing any of it means the prospect waits
// for the LAST word to be rendered before hearing the FIRST. Bulbul takes ~3.3s
// on a two-sentence turn, measured on the deployment, and that is 3.3s of the
// agent visibly not answering.

await t('a long line is SPLIT, and the first request is the short one', async () => {
  await restart();
  const line = 'Namaste, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?';
  process.env.STUB_LLM_SAY = line;
  await page.locator('#lang button[data-lang="en-IN"]').click();
  await page.locator('#start').click();
  await page.waitForSelector('#log .ln.her', { timeout: 10000 });
  // Her opening is the flow line; the SPLIT under test is her reply to this.
  // Let the opening finish before measuring the reply — its own phrases would
  // otherwise be counted as the split under test.
  await page.waitForTimeout(600);
  synths.length = 0;
  await page.locator('#say').fill('tell me about it');
  await page.locator('#compose button[type=submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('#log .ln.her').length >= 2,
    null, { timeout: 10000 });
  // Poll the TEST's own list, not the page's counter: the page counts every
  // synth since load, including the opening's, so it was already past three
  // before the reply's phrases had been requested at all.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline
    && synths.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim() !== line.replace(/\s+/g, ' ').trim()) {
    await page.waitForTimeout(150);
  }

  const asked = synths.map((p) => p.text);
  assert.ok(asked.length >= 2, `the line should be split, got ${asked.length} request(s)`);
  assert.ok(asked[0].length < line.length / 2,
    `the first request must be the SHORT one, got "${asked[0]}"`);
  // Every word still gets said — splitting must not drop the tail.
  assert.equal(asked.join(' ').replace(/\s+/g, ' ').trim(), line.replace(/\s+/g, ' ').trim(),
    'the phrases must reassemble into the whole line');
  process.env.STUB_LLM_SAY = STUB_SAY;
});

await t('THE NEXT PHRASE IS RENDERED WHILE THE CURRENT ONE PLAYS', async () => {
  // The overlap is the entire point. Requesting phrase 2 only after phrase 1
  // finishes playing would serialise synthesis behind audio and buy nothing.
  const gaps = await page.evaluate(() => window.__ttsTimes || []);
  if (gaps.length >= 2) {
    assert.ok(gaps[1] - gaps[0] < 2000,
      `phrase 2 should be requested during phrase 1, gap was ${gaps[1] - gaps[0]}ms`);
  }
});

await t('THE SPLIT IS NOT LATIN-BIASED — Hindi and Telugu split too', async () => {
  // Every cheap proxy for "long enough to be worth its own round trip" is
  // biased by script. A CHARACTER floor swallowed whole Hindi sentences (21
  // characters, a second and a half of speech). A WORD floor swallowed Telugu,
  // which is agglutinative — "ఇప్పుడు మాట్లాడవచ్చా?" is a whole question in two
  // words. Both failures land on exactly the two languages this sells in.
  const hi = await page.evaluate(() => window.__splitForSpeech(
    'नमस्ते, मैं अनगा हूँ। मेरे पास गाचीबौली में एक थ्री बीएचके है। क्या आप जानना चाहेंगे?'));
  assert.equal(hi.length, 3, `the danda ends a sentence like a full stop, got ${hi.length}`);

  const te = await page.evaluate(() => window.__splitForSpeech(
    'నమస్కారం, నేను అనగా. మీరు అడిగిన ఇంటి గురించి మాట్లాడటానికి కాల్ చేశాను. ఇప్పుడు మాట్లాడవచ్చా?'));
  assert.equal(te.length, 3, `Telugu must split too, got ${te.length}`);
  assert.ok(te[0].length < 25, 'the first Telugu phrase must be the short one');
});

await t('a SHORT line is not split into a pointless extra round trip', async () => {
  // A runt is short by BOTH measures — which is "Yes." and "Theek hai.", and
  // nothing that carries a clause.
  for (const short of ['Theek hai.', 'Yes.', 'సరే.']) {
    const parts = await page.evaluate((x) => window.__splitForSpeech(x), short);
    assert.deepEqual(parts, [short], `"${short}" does not deserve its own round trip`);
  }
});

await t('TIME TO FIRST WORD IS SHOWN, not claimed', async () => {
  await page.waitForFunction(() => /\d+\s*ms/.test(document.getElementById('ttfa').textContent),
    null, { timeout: 10000 });
  const shown = await page.locator('#ttfa').innerText();
  assert.match(shown, /\d+ ms to first word/);
});

await t('no uncaught page errors', () => {
  assert.deepEqual(pageErrors, []);
});

await restart();
await page.locator('#start').click();
await page.waitForSelector('#log .ln.her', { timeout: 10000 });
await page.waitForTimeout(400);
await page.screenshot({ path: process.env.SHOT_PATH || '/tmp/demo.png', fullPage: true });
console.log(`\n  screenshot: ${process.env.SHOT_PATH || '/tmp/demo.png'}`);

await browser.close();
server.close();

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
