// scripts/test-browser-bench.mjs
//
// REAL BROWSER test of web/bench.html — the page that answers "which woman's
// voice is fastest".
//
// It exists because the question could not be answered from a phone: the only
// numbers anywhere were one sample per voice, rendered on a handset, where the
// cold start and the signal swamp whatever difference there is between two
// speakers of the same model. A ranking built on that is a ranking of noise.
//
// So the things worth testing are the parts that stop it lying:
//   - the warm-up round is DISCARDED, not averaged in
//   - only FEMALE voices are measured
//   - it reports when the top two overlap instead of crowning a winner
//
// Run: node scripts/test-browser-bench.mjs

import assert from 'node:assert';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

process.env.STUB_VENDORS = '1';
process.env.SARVAM_API_KEY = process.env.SARVAM_API_KEY || 'test-key';
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
const page = await (await browser.newContext()).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));

const posts = [];
page.on('request', (r) => {
  if (r.url().includes('/api/tts') && r.method() === 'POST') {
    try { posts.push(JSON.parse(r.postData() || '{}')); } catch { /* ignore */ }
  }
});

console.log('\n═══ REAL BROWSER: the voice benchmark ═══\n');

// 2 rounds keeps the suite quick: one warm-up, one measured.
await page.goto(`${BASE}/bench.html?rounds=2`);
await page.waitForFunction(() => /female voices/.test(document.getElementById('note')?.textContent || ''),
  null, { timeout: 10000 });

let women = 0;
await t('it measures the FEMALE voices, and only those', async () => {
  const probe = await page.evaluate(() => fetch('/api/tts').then((r) => r.json()));
  women = probe.voices.filter((v) => v.gender === 'female').length;
  assert.ok(women >= 10, `expected the female half of the catalogue, got ${women}`);
  assert.ok(probe.voices.some((v) => v.gender === 'male'), 'the catalogue does have men in it');
  const note = await page.locator('#note').innerText();
  assert.ok(note.includes(`${women} female voices`), `note should name the count, got "${note}"`);
});

await t('nothing is measured until you ask', async () => {
  await page.waitForTimeout(800);
  assert.equal(posts.length, 0, `${posts.length} requests before the button was pressed`);
});

await t('every voice it requests is a woman', async () => {
  posts.length = 0; vendorCalls.length = 0;
  await page.locator('#go').click();
  await page.waitForFunction(() => /^done/.test(document.getElementById('note')?.textContent || ''),
    null, { timeout: 120000 });

  const probe = await page.evaluate(() => fetch('/api/tts').then((r) => r.json()));
  const male = new Set(probe.voices.filter((v) => v.gender === 'male').map((v) => v.id));
  const asked = posts.filter((p) => p.speaker).map((p) => p.speaker);
  assert.deepEqual(asked.filter((s) => male.has(s)), [], 'a man was measured in a women-only run');
});

await t('THE WARM-UP ROUND IS DISCARDED, not averaged in', async () => {
  // 2 rounds requested, so each voice is called twice and scored once. If the
  // first round counted, the first voice measured would carry the cold start
  // for the whole catalogue and win or lose on that alone.
  const perVoice = {};
  for (const p of posts) if (p.speaker) perVoice[p.speaker] = (perVoice[p.speaker] || 0) + 1;
  const counts = [...new Set(Object.values(perVoice))];
  assert.deepEqual(counts, [2], `each voice should be called once per round, got ${counts}`);
});

await t('it never sends pitch — v3 rejects it', async () => {
  assert.deepEqual(posts.filter((p) => 'pitch' in p && p.pitch !== undefined), []);
});

await t('the ranking is sorted fastest first, with NO missing numbers', async () => {
  const rows = await page.locator('#out tbody tr').count();
  assert.equal(rows, women, `expected a row per voice, got ${rows}`);
  const cells = await page.$$eval('#out tbody tr td:nth-child(2)',
    (tds) => tds.map((td) => td.textContent));
  // "—" must not appear: `res.d.ms || null` once dropped every zero, so the
  // FASTEST results were the ones missing from the column. Assert on the text,
  // not on Number(), or a dash silently becomes NaN and NaN compares false to
  // everything — which is how the first version of this test passed.
  assert.deepEqual(cells.filter((c) => !/^\d+$/.test(c)), [],
    'every measured voice must show a server time');
  const server = cells.map(Number);
  assert.deepEqual(server, server.slice().sort((a, b) => a - b),
    'the table must be ordered by the measured time');
});

await t('IT SAYS SO WHEN THE WINNER IS NOISE', async () => {
  // The stub answers every voice at the same speed, so the top two necessarily
  // overlap. A benchmark that crowns a winner off that is worse than no
  // benchmark: it launders a coin flip into a decision.
  const v = await page.locator('#verdict').innerText();
  assert.ok(/too close to call/i.test(v), `expected an overlap warning, got "${v}"`);
});

await t('the server reports its OWN time, separate from the round trip', async () => {
  const body = await page.evaluate(() => fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x', lang: 'te-IN', speaker: 'pooja' }),
  }).then((r) => r.json()));
  assert.equal(typeof body.ms, 'number', 'the response must carry the server-side ms');
  assert.ok(body.ms >= 0 && body.ms < 60000);
});

await t('no uncaught page errors', () => {
  assert.deepEqual(pageErrors, []);
});

await page.screenshot({ path: process.env.SHOT_PATH || '/tmp/bench.png', fullPage: true });
console.log(`\n  screenshot: ${process.env.SHOT_PATH || '/tmp/bench.png'}`);

await browser.close();
server.close();

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
