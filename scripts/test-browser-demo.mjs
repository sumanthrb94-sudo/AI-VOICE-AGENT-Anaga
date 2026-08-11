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

// A REAL microphone, faked by Chromium. getUserMedia resolves, MediaRecorder
// produces real WebM — so the pipeline under test is the one that ships, not a
// stub of it. Without these flags getUserMedia rejects and the whole audio path
// is untestable, which is how it went three rounds without one.
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-fake-device-for-media-capture', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
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

// A REAL MediaStream with no hardware.
//
// This container has no audio device and Chromium's fake-device flags do not
// provide one — every combination returns NotFoundError, so getUserMedia cannot
// be exercised here at all. Rather than stub my own code, an AudioContext
// oscillator is piped into createMediaStreamDestination(), which yields a
// genuine MediaStream that a genuine MediaRecorder will record. Only the
// hardware is synthetic; the capture path, the recorder, the container
// negotiation and the blob are all real.
//
// WHAT THIS STILL CANNOT PROVE: that echoCancellation actually removes Anaga's
// voice on a handset. That is the property the whole design rests on and it is
// verifiable only on a real device. The constraint being REQUESTED is asserted
// below; whether the browser honours it is the browser's half.
await page.addInitScript(() => {
  window.__gumConstraints = null;
  const AC = window.AudioContext || window.webkitAudioContext;
  navigator.mediaDevices = navigator.mediaDevices || {};
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__gumConstraints = c;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // SILENT on purpose. A constant tone reads as continuous speech to the
    // real analyser, which then fights the synthetic _feed() the tests use to
    // drive endpointing — both were mutating the same state and both failed.
    // The recorder still captures (silence is bytes); the endpointer is driven
    // deterministically instead of by a signal nobody can control.
    gain.gain.value = 0;
    osc.connect(gain).connect(dest);
    osc.start();
    window.__fakeCtx = ctx;
    return dest.stream;
  };
});

// Timestamp every synth request inside the page, so "was phrase 2 requested
// while phrase 1 was playing?" is a measurement rather than an inference.
await page.addInitScript(() => {
  window.__ttsPosts = []; window.__ttsTimes = []; window.__turnAudio = 0;
  const real = window.fetch;
  window.fetch = function (url, init) {
    if (String(url).includes('/api/anaga/turn') && init && init.method === 'POST'
        && String(init.body || '').includes('"audio"')) {
      window.__turnAudio++;
    }
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
  // Compared against the API's own line, not an English phrase. The Telugu and
  // Hindi openings are in NATIVE SCRIPT now — /AI voice assistant/ passed only
  // while they were Roman transliteration, which is the thing that made her
  // sound synthetic in the first place.
  const her = await page.locator('#log .ln.her').first().innerText();
  assert.equal(turns.length, 0, 'the opening must not cost a brain call');

  const approved = await page.evaluate(() => fetch('/api/anaga/turn?lang=te-IN&direction=outbound')
    .then((r) => r.json()));
  assert.equal(approved.source, 'flow', 'the endpoint must say it is not a generation');
  assert.ok(her.includes(approved.say), 'she must say the approved line verbatim');
  assert.match(approved.say, /[\u0C00-\u0C7F]/, 'the Telugu opening must be in Telugu script');
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
  const line = await page.evaluate(() => fetch('/api/anaga/turn?lang=te-IN&direction=outbound')
    .then((r) => r.json()).then((d) => d.say));
  assert.ok(her.includes(line), `expected the approved line, got "${her}"`);
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
    if (lang === 'hi-IN') {
      assert.match(approved.say, /[\u0900-\u097F]/, 'the Hindi opening must be in Devanagari');
    }
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
  const line = await page.evaluate(() => fetch('/api/anaga/turn?lang=te-IN&direction=outbound')
    .then((r) => r.json()).then((d) => d.say));
  assert.ok(her.includes(line), 'the words must appear even with no voice');
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

await t('THE CALL OPENS ONE ECHO-CANCELLED STREAM', async () => {
  await restart();
  await page.locator('#start').click();
  await page.waitForFunction(() => window.__mic && window.__mic.isOpen(),
    null, { timeout: 10000 });
  // echoCancellation is the whole design. Without it her voice reaches the
  // recorder and no downstream cleverness reliably removes it — three attempts
  // proved that on real hardware.
  // The constraint must be ASKED FOR. Whether the browser honours it is the
  // browser's half and only a real handset can answer that.
  const c = await page.evaluate(() => window.__gumConstraints);
  assert.equal(c && c.audio && c.audio.echoCancellation, true,
    'the microphone must be requested WITH echo cancellation — the whole design rests on it');
  assert.equal(c.audio.noiseSuppression, true);
});

await t('SPEECH IS ENDPOINTED, and the utterance is SENT AS AUDIO', async () => {
  // The endpointer decides when you started and stopped; the recorder hands
  // over that utterance; the server transcribes it. One request for the whole
  // turn — audio in, transcript and reply and her audio out.
  const before = turns.length;
  // The onset is driven synthetically — there is no audio device here to talk
  // into. The SILENCE is not: real time has to pass, because the recorder is
  // real and captures wall-clock. Feeding both halves synthetically closed the
  // utterance in the same tick the recorder opened it, and the blob that
  // reached the server was a few bytes of container with no audio in it.
  await page.evaluate(() => {
    for (let i = 0; i < 8; i++) window.__mic._feed(true, 100);   // talking
  });
  await page.waitForTimeout(1100);   // …and stopped. The real endpointer sees it.
  await page.waitForFunction((n) => window.__turnAudio > n, before, { timeout: 15000 })
    .catch(() => {});
  const withAudio = turns.filter((t) => t.audio);
  assert.ok(withAudio.length >= 1, 'the utterance must be posted as audio');
  assert.ok(withAudio[0].mime, 'and must say what container it is in');
  assert.equal(withAudio[0].lang, 'te-IN');
});

await t('THE TRANSCRIPT COMES BACK AND BECOMES A TURN', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#log .ln.you').length > 0,
    null, { timeout: 15000 });
  const you = await page.locator('#log .ln.you').last().innerText();
  assert.match(you, /బెడ్‌రూమ్/, `expected the transcript, got "${you}"`);
});

await t('SHE MAKES A SOUND WHILE SHE THINKS — the dead air is the machine tell', async () => {
  // Three vendor calls run in series after you stop talking; measured in
  // production that is three to five seconds of nothing. A person answers with
  // SOME noise inside about 200ms. The acknowledgement is rendered once at the
  // start of the call and played the instant the endpointer closes an
  // utterance, before the request has even left the phone.
  await page.waitForFunction(
    () => window.__acksWanted > 0 && window.__acksReady >= window.__acksWanted,
    null, { timeout: 12000 },
  );
  // Rendered up front, not synthesized in the gap they exist to cover — a
  // synthesis mid-gap would arrive at exactly the moment the real reply does.
  assert.ok(await page.evaluate(() => window.__acksReady >= 2),
    'more than one, or the same noise every turn is its own machine tell');
  // It must never become a turn: a model shown "okay" as its own previous line
  // starts treating it as one and answering it.
  const hers = await page.locator('#log .ln.her').allInnerTexts();
  assert.ok(!hers.some((h) => /^Anaga\s*(okay|right|mm-hmm|got it)$/i.test(h.trim())),
    'an acknowledgement is a noise, not a line in the transcript');
});

await t('A COUGH IS NOT AN UTTERANCE', async () => {
  // Under the minimum speech length nothing is sent. Transcribing a door
  // closing costs money to be told it was a door.
  const before = turns.filter((t) => t.audio).length;
  await page.evaluate(() => {
    window.__mic._feed(true, 100); window.__mic._feed(true, 60);
    for (let i = 0; i < 10; i++) window.__mic._feed(false, 100);
  });
  await page.waitForTimeout(1200);
  assert.equal(turns.filter((t) => t.audio).length, before,
    'a burst too short to be speech must not be sent');
});

await t('SHE STOPS WHEN YOU START TALKING — no threshold of its own', async () => {
  // Barge-in is just the endpointer noticing speech. It needs no separate
  // guess, because her voice is not in this signal at all.
  await restart();
  await page.locator('#start').click();
  await page.waitForFunction(() => document.body.classList.contains('speaking'),
    null, { timeout: 12000 });
  await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__mic._feed(true, 100); });
  await page.waitForFunction(() => !document.body.classList.contains('speaking'),
    null, { timeout: 6000 });
  const hers = await page.locator('#log .ln.her').allInnerTexts();
  assert.ok(hers.some((h) => /cut off/.test(h)), 'and the transcript records that she was cut off');
});

await t('NO SELF-ANSWER LOOP: she speaks, and nothing arrives from it', async () => {
  // The failure that shipped three times. With echo cancellation there is no
  // echo to guard against, so the assertion is simply that her own speech
  // produces no turn at all.
  await restart();
  await page.locator('#start').click();
  await page.waitForSelector('#log .ln.her', { timeout: 12000 });
  const lines = await page.locator('#log .ln').count();
  const brainCalls = turns.length;
  await page.waitForTimeout(3000);        // let her finish talking, undisturbed
  assert.equal(await page.locator('#log .ln').count(), lines,
    'her own voice must not produce a single turn');
  assert.equal(turns.length, brainCalls,
    'and must never reach the brain — every loop iteration was a billed call');
});

await t('the microphone is released when the call ends', async () => {
  await page.locator('#end').click();
  await page.waitForSelector('body.ended', { timeout: 8000 });
  assert.equal(await page.evaluate(() => window.__mic.isOpen()), false,
    'a finished call must not hold the microphone');
});

await t('THE FIRST PHRASE SHIPS WITH THE TURN — one round trip, not two', async () => {
  await restart();
  const line = 'Namaste, this is Anaga from Vaak. I have a three BHK in Gachibowli. Would you like the details?';
  process.env.STUB_LLM_SAY = line;
  await page.locator('#lang button[data-lang="en-IN"]').click();
  await page.locator('#start').click();
  await page.waitForSelector('#log .ln.her', { timeout: 10000 });
  // Let the OPENING finish before measuring the next line. Her opening renders
  // its own later phrases while the earlier ones play, and the acknowledgements
  // render once at the start of the call — both land in `synths` and neither
  // belongs to the turn under test. Waiting on wall-clock made this pass only
  // as long as nothing before it got slower or longer.
  await page.waitForFunction(
    () => !document.body.classList.contains('speaking')
      && window.__acksWanted > 0 && window.__acksReady >= window.__acksWanted,
    null, { timeout: 15000 },
  ).catch(() => {});
  await page.waitForTimeout(300);
  synths.length = 0;

  await page.locator('#say').fill('tell me about it');
  await page.locator('#compose button[type=submit]').click();
  await page.waitForFunction(() => document.querySelectorAll('#log .ln.her').length >= 2,
    null, { timeout: 10000 });

  // The reply carries its own first phrase, rendered server-side the instant
  // the model answered. Asking for it separately meant a second
  // handset-to-server hop on a mobile network after the slow part was over.
  const turn = await page.evaluate((h) => fetch('/api/anaga/turn?voice=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history: h, lang: 'en-IN', direction: 'outbound' }),
  }).then((r) => r.json()), [{ role: 'user', text: 'tell me about it' }]);
  assert.ok(turn.speak, 'the turn must carry audio');
  assert.ok(turn.speak.audio, '…with actual bytes in it');
  assert.equal(turn.speak.text, 'Namaste, this is Anaga from Vaak.',
    'and it must be the FIRST phrase, not the whole line');

  // The browser then renders only what is left — no duplicate of phrase one.
  const deadline = Date.now() + 15000;
  const rest = () => synths.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
  const expected = line.slice(turn.speak.text.length).trim();
  while (Date.now() < deadline && rest() !== expected) await page.waitForTimeout(150);
  assert.equal(rest(), expected,
    `the browser must render the remainder, and only the remainder — got ${JSON.stringify(synths.map((p) => p.text))}`);
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
