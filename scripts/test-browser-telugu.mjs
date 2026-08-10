// scripts/test-browser-telugu.mjs
//
// REAL BROWSER test of the Telugu voice sampler — the home page.
//
// It runs against the REAL API handlers via scripts/dev-server.mjs, not a
// hand-written stub. Every previous browser suite here stubbed /api/tts itself,
// and those stubs drifted from the server until they were asserting a world
// that no longer existed.
//
// THE RULE THIS PAGE EXISTS TO KEEP: nothing plays until a tap. A page that
// speaks on its own is how the handset's built-in voice was mistaken for ours
// for two days, and how a "preview" ended up autoplaying over a live call.
//
// Run: node scripts/test-browser-telugu.mjs

import assert from 'node:assert';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

process.env.STUB_VENDORS = '1';
process.env.SARVAM_API_KEY = process.env.SARVAM_API_KEY || 'test-key';
// Batch, not stream: the stub can produce a valid WAV but not a valid MP3, and
// a browser will not decode a fabricated MP3 frame.
process.env.SARVAM_STREAM = '0';
// The brain is stubbed in dev-server too; without a key turn.js 503s before it
// ever builds a prompt, and the test would only exercise the fallback line.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
const STUB_SAY = 'మీరు ఉండటానికా, లేక పెట్టుబడి కోసమా చూస్తున్నారు?';
process.env.STUB_LLM_SAY = STUB_SAY;

const { createDevServer, vendorCalls } = await import('./dev-server.mjs');

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
const ctx = await browser.newContext();
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));

const posts = [];
page.on('request', (r) => {
  if (r.url().includes('/api/tts') && r.method() === 'POST') {
    try { posts.push(JSON.parse(r.postData() || '{}')); } catch { /* ignore */ }
  }
});

console.log('\n═══ REAL BROWSER: Telugu voice sampler ═══\n');

await page.goto(BASE);
await page.waitForSelector('.v', { timeout: 10000 });

await t('ONE voice is offered — kavya, and nothing else', async () => {
  // The picker was the tool for choosing Anaga's voice. It has been used; the
  // choice is kavya. Thirty-seven cards now only invite the question again.
  const ids = await page.$$eval('.v', (els) => els.map((e) => e.dataset.voice));
  assert.deepEqual(ids, ['kavya'], `expected only kavya, got ${ids.join(', ')}`);

  // But the catalogue is intact — "one voice" must never be indistinguishable
  // from "one voice survived", which is exactly what a Sarvam outage looked
  // like before the named-voice rule made it say so.
  const probe = await page.evaluate(() => fetch('/api/tts').then((r) => r.json()));
  assert.ok(probe.catalogueSize >= 30, 'the full catalogue must still be reported');
  assert.equal(probe.voice, 'kavya');
  const all = await page.evaluate(() => fetch('/api/tts?all=1').then((r) => r.json()));
  assert.ok(all.voices.length >= 30, '?all=1 must still return everything, for the benchmark');
});

await t('NOTHING PLAYS UNTIL A TAP', async () => {
  // The whole point of the rewrite. Give it a generous window: an autoplay
  // would have fired long before this.
  await page.waitForTimeout(2500);
  assert.equal(posts.length, 0, `${posts.length} synth requests before any tap`);
  assert.equal(vendorCalls.length, 0, 'the vendor was called with nobody asking');
});

await t('KAVYA is selected, by NAME', async () => {
  // Pinned by name, never by grid position: "the first card" silently becomes
  // somebody else the day Sarvam reorders its list.
  const on = await page.locator('.v[aria-pressed="true"]').all();
  assert.equal(on.length, 1, `${on.length} voices selected, expected exactly 1`);
  assert.equal(await on[0].getAttribute('data-voice'), 'kavya');
});

await t('a tap plays that voice, and only that voice', async () => {
  posts.length = 0; vendorCalls.length = 0;
  const card = page.locator('.v').first();
  const id = await card.getAttribute('data-voice');
  await card.click();
  await page.waitForFunction(() => document.querySelectorAll('.v[data-state="playing"]').length > 0
    || /ms/.test(document.querySelector('.v em')?.textContent || ''), null, { timeout: 8000 });
  assert.equal(posts.length, 1, `expected exactly one request, got ${posts.length}`);
  assert.equal(posts[0].speaker, id, 'the tapped voice must be the one requested');
});

await t('it asks for TELUGU, always', async () => {
  assert.equal(posts[0].lang, 'te-IN');
  // The language pills are gone; there is no path that can ask for anything else.
  const pills = await page.locator('.lang-pill').count();
  assert.equal(pills, 0, 'no language switcher should exist on this page');
});

await t('the measured latency is shown on the card', async () => {
  const label = await page.locator('.v').first().locator('em').innerText();
  assert.ok(/\d+\s*ms/.test(label), `expected a millisecond figure, got "${label}"`);
});

await t('A CACHED REPLAY SAYS SO, instead of posing as a fast voice', async () => {
  // 35ms on a card against 3366ms measured on the server, in the same place,
  // in the same units. The cache was being read as the voice being quick, and
  // a voice was very nearly chosen on that number.
  const card = page.locator('.v').first();
  await card.click();                        // stop
  await page.waitForTimeout(200);
  await card.click();                        // replay — same settings, cached
  await page.waitForTimeout(900);
  const label = await card.locator('em').innerText();
  assert.match(label, /cached/, `a replay must be labelled, got "${label}"`);
});

await t('the pace control reaches the vendor', async () => {
  posts.length = 0; vendorCalls.length = 0;
  await page.locator('#pace').fill('1.45');
  await page.locator('.v').first().click();
  await page.waitForTimeout(1200);
  assert.ok(posts.length >= 1, 'a tap should synthesize');
  assert.equal(posts[0].pace, 1.45, 'the slider must actually change the request');
});

await t('a second tap on the same voice is served from cache', async () => {
  const card = page.locator('.v').first();
  await card.click();
  await page.waitForTimeout(1200);
  const before = vendorCalls.length;
  await card.click();                       // stop
  await page.waitForTimeout(200);
  await card.click();                       // play again, same settings
  await page.waitForTimeout(1200);
  assert.equal(vendorCalls.length, before,
    'the same voice at the same settings must not be re-synthesized');
});

// ── the live transcript ─────────────────────────────────────────────────────
// Headless Chromium has no Web Speech recogniser, so the mic half cannot be
// driven here. The typing path goes through the SAME ask() → /api/anaga/turn →
// reply() → speak() chain, which is the part that can break.

await t('the transcript starts empty', async () => {
  assert.equal(await page.locator('#log .ln').count(), 0);
});

await t('BOTH SIDES appear in the transcript', async () => {
  posts.length = 0;
  await page.locator('#saytxt').fill('నేను ఉండటానికే చూస్తున్నాను');
  await page.locator('#sayform button[type=submit]').click();

  await page.waitForSelector('#log .ln.her', { timeout: 8000 });
  const you = await page.locator('#log .ln.you').innerText();
  const her = await page.locator('#log .ln.her').innerText();
  assert.ok(you.includes('నేను ఉండటానికే చూస్తున్నాను'), `your line missing: "${you}"`);
  assert.ok(her.includes(STUB_SAY), `Anaga's line missing: "${her}"`);
  // Each bubble says who is speaking; an unattributed transcript is not one.
  assert.ok(you.includes('మీరు') && her.includes('అనగా'), 'bubbles must be attributed');
});

await t("the line is WRITTEN before it is SPOKEN", async () => {
  // reply() appends the bubble and only then synthesizes, so a synthesis
  // failure still leaves a readable record. If it were the other way round a
  // TTS outage would erase the transcript, which is the one thing it is for.
  const order = await page.evaluate(() => {
    const el = document.querySelector('#log .ln.her');
    return el ? el.textContent.length : 0;
  });
  assert.ok(order > 0, 'no reply bubble');
});

await t("Anaga's reply is spoken in the SELECTED voice", async () => {
  const sel = await page.locator('.v[aria-pressed="true"]').getAttribute('data-voice');
  const spoken = posts.filter((p) => p.text === STUB_SAY);
  assert.equal(spoken.length, 1, `expected the reply to be synthesized once, got ${spoken.length}`);
  assert.equal(spoken[0].speaker, sel, 'she must speak in the voice you picked');
  assert.equal(spoken[0].lang, 'te-IN');
});

await t('an opt-out ends the call regardless of what the brain says', async () => {
  // The stub brain always answers "end: false" and keeps qualifying. The client
  // must stop anyway — the model does not get a vote on an opt-out.
  await page.locator('#saytxt').fill('నాకు ఆసక్తి లేదు, కాల్ చేయవద్దు');
  await page.locator('#sayform button[type=submit]').click();
  await page.waitForFunction(
    () => /ముగిసింది/.test(document.querySelector('#talkstate')?.textContent || ''),
    null, { timeout: 8000 });

  const lines = await page.locator('#log .ln.her').allInnerTexts();
  const last = lines[lines.length - 1];
  assert.ok(/డు-నాట్-కాల్/.test(last), `expected a do-not-call acknowledgement, got "${last}"`);

  // And it stays ended: a further attempt adds nothing.
  const before = await page.locator('#log .ln').count();
  await page.locator('#saytxt').fill('సరే చెప్పండి');
  await page.locator('#sayform button[type=submit]').click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#log .ln').count(), before,
    'the conversation continued after an opt-out');
});

// Captured here, with a healthy two-sided transcript on screen — the outage
// test below deliberately reloads into a degraded state.
await page.screenshot({ path: process.env.SHOT_PATH || '/tmp/telugu.png' });

await t('tapping quickly does not paint the card red', async () => {
  // Swapping src aborts the previous load and fires an error on it. That is
  // "superseded", not "broken", and labelling it a failure is how comparing
  // voices looked like a broken deployment.
  for (let i = 0; i < 4; i++) {
    await page.locator('.v').first().click();
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(1200);
  const red = await page.evaluate(() =>
    [...document.querySelectorAll('.v em')].map((e) => e.textContent)
      .filter((s) => /error|failed/i.test(s)));
  assert.deepEqual(red, [], `cards reported failures they did not have: ${red.join(', ')}`);
});

await t('on a fresh page she answers in KAVYA, with no tap at all', async () => {
  await page.reload();
  await page.waitForSelector('.v');
  posts.length = 0; vendorCalls.length = 0;

  await page.locator('#saytxt').fill('హలో');
  await page.locator('#sayform button[type=submit]').click();
  await page.waitForSelector('#log .ln.her', { timeout: 8000 });
  await page.waitForFunction(() => window.performance.getEntriesByType('resource')
    .some((r) => r.name.includes('/api/tts')), null, { timeout: 8000 }).catch(() => {});

  const spoken = posts.filter((p) => p.speaker);
  assert.ok(spoken.length >= 1, 'she must speak without needing a voice tap first');
  assert.equal(spoken[0].speaker, 'kavya', 'the default is a NAME, not the first card');
});

await t('a card error does not outlive the voice that caused it', async () => {
  // The status line kept the last failure forever, so the page read as broken
  // while a working voice was playing through it.
  // Start from STOPPED. With one card on the page a click is a toggle, and a
  // toggle-off correctly clears nothing — the previous version of this test
  // silently depended on there being a second card to tap.
  const card = page.locator('.v').first();
  if (await card.getAttribute('data-state') === 'playing') {
    await card.click();
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => {
    const s = document.getElementById('status');
    s.className = 'err'; s.textContent = 'ఈ వాయిస్ అందుబాటులో లేదు';
  });
  await card.click();
  await page.waitForTimeout(1500);
  const cls = await page.locator('#status').getAttribute('class');
  assert.notEqual(cls, 'err', 'a successful play must clear the stale error');
});

await t('a brain outage still produces a transcript, and says why', async () => {
  process.env.STUB_LLM_FAIL = '1';
  await page.reload();                        // the last chat ended on an opt-out
  await page.waitForSelector('.v');
  await page.locator('#saytxt').fill('బడ్జెట్ డెబ్బై లక్షలు');
  await page.locator('#sayform button[type=submit]').click();

  await page.waitForSelector('#log .ln.her', { timeout: 8000 });
  const her = await page.locator('#log .ln.her').innerText();
  assert.ok(her.length > 10, 'Anaga must still say something when the brain is down');
  const why = await page.locator('#talkstate').innerText();
  assert.ok(/బ్రెయిన్/.test(why), `the outage must be visible, got "${why}"`);
  process.env.STUB_LLM_FAIL = '';
});

await t('no uncaught page errors', () => {
  assert.deepEqual(pageErrors, []);
});

console.log(`\n  screenshot: ${process.env.SHOT_PATH || '/tmp/telugu.png'}`);

await browser.close();
server.close();

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
