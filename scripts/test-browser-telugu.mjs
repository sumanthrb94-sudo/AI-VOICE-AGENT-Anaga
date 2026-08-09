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

await t('every Bulbul voice is listed', async () => {
  const n = await page.locator('.v').count();
  assert.ok(n >= 30, `expected the full catalogue, got ${n}`);
});

await t('NOTHING PLAYS UNTIL A TAP', async () => {
  // The whole point of the rewrite. Give it a generous window: an autoplay
  // would have fired long before this.
  await page.waitForTimeout(2500);
  assert.equal(posts.length, 0, `${posts.length} synth requests before any tap`);
  assert.equal(vendorCalls.length, 0, 'the vendor was called with nobody asking');
});

await t('a tap plays that voice, and only that voice', async () => {
  posts.length = 0; vendorCalls.length = 0;
  const card = page.locator('.v').nth(3);
  const id = await card.getAttribute('data-voice');
  await card.click();
  await page.waitForFunction(() => document.querySelectorAll('.v[data-state="playing"]').length > 0
    || /ms$/.test(document.querySelector('.v:nth-child(4) em')?.textContent || ''), null, { timeout: 8000 });
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
  const label = await page.locator('.v').nth(3).locator('em').innerText();
  assert.ok(/\d+\s*ms/.test(label), `expected a millisecond figure, got "${label}"`);
});

await t('the pace control reaches the vendor', async () => {
  posts.length = 0; vendorCalls.length = 0;
  await page.locator('#pace').fill('1.45');
  await page.locator('.v').nth(5).click();
  await page.waitForTimeout(1200);
  assert.ok(posts.length >= 1, 'a tap should synthesize');
  assert.equal(posts[0].pace, 1.45, 'the slider must actually change the request');
});

await t('a second tap on the same voice is served from cache', async () => {
  const card = page.locator('.v').nth(7);
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

await t('no uncaught page errors', () => {
  assert.deepEqual(pageErrors, []);
});

await page.screenshot({ path: process.env.SHOT_PATH || '/tmp/telugu.png' });
console.log(`\n  screenshot: ${process.env.SHOT_PATH || '/tmp/telugu.png'}`);

await browser.close();
server.close();

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
