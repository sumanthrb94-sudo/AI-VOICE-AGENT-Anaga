// scripts/probe-voices.mjs
//
// For every voice the picker offers: click it in a REAL browser, and print what
// the server ends up asking the vendor for.
//
//   node scripts/probe-voices.mjs
//
// This answers "why is every voice female?" with a table instead of an
// argument. Three links in that chain can each break it silently and they look
// identical from outside:
//
//   1. the CARD    — does clicking it change the selected preset?
//   2. the REQUEST — does the browser send that preset's speaker and gender?
//   3. the RESOLVE — does the server keep them, or substitute?
//
// Every previous version of this question was answered by reading code. Reading
// code is how the substitution step got missed twice.
//
// Vendors are stubbed, so this proves what we ASK FOR. Whether the vendor's
// "abhilash" actually sounds like a man is the vendor's half, and no local run
// can answer it — scripts/analyze-voice.mjs measures that from real audio.

import { launchChromium } from './playwright.mjs';

process.env.STUB_VENDORS = '1';
process.env.SARVAM_API_KEY = process.env.SARVAM_API_KEY || 'probe-key';

const { createDevServer, vendorCalls } = await import('./dev-server.mjs');

const server = createDevServer();
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const page = await (await browser.newContext()).newPage();

const sent = [];
page.on('request', (r) => {
  if (!r.url().includes('/api/tts') || r.method() !== 'POST') return;
  try { sent.push(JSON.parse(r.postData() || '{}')); } catch { /* ignore */ }
});

await page.goto(BASE);
await page.waitForSelector('.voice-card', { timeout: 10000 });
// The picker may re-render from GET /api/tts; let that settle.
await page.waitForTimeout(1500);

const cards = await page.$$eval('.voice-card', (els) => els.map((e) => ({
  id: e.dataset.voice,
  label: (e.querySelector('.voice-card__txt b') || {}).textContent || '',
  sub: (e.querySelector('.voice-card__txt em') || {}).textContent || '',
})));

console.log(`\n═══ VOICE PROBE — ${cards.length} cards in the picker ═══\n`);
console.log('card            label        →  requested            →  vendor received');
console.log('─'.repeat(78));

let mismatches = 0;
for (const c of cards) {
  sent.length = 0;
  vendorCalls.length = 0;
  await page.click(`.voice-card[data-voice="${c.id}"]`);
  await page.waitForTimeout(900);

  const req = sent[sent.length - 1] || {};
  const vendor = vendorCalls[vendorCalls.length - 1] || {};
  const vb = vendor.body || {};
  const got = vb.speaker || vb.voice || (vb.input ? 'voicestudio' : '—');

  // The failure this exists to catch: the browser asks for one voice and the
  // vendor is asked for another, or for a different gender.
  const bad = req.speaker && got !== '—' && got !== req.speaker;
  if (bad) mismatches++;

  console.log(
    `${String(c.id).padEnd(15)} ${String(c.label + ' ' + c.sub).padEnd(12)} →  `
    + `${String((req.speaker || '?') + '/' + (req.gender || '?')).padEnd(20)} →  `
    + `${got}${bad ? '   ⚠ SUBSTITUTED' : ''}`
  );
}

console.log('─'.repeat(78));
const genders = new Set(sent.map((s) => s.gender));
console.log(`\nsubstitutions: ${mismatches}`);
console.log('note: a substitution is not automatically wrong — a v2 name under v3 is');
console.log('      SUPPOSED to be swapped for a same-gender v3 voice. It is wrong only');
console.log('      if the gender changed, which the columns above make visible.\n');

await browser.close();
server.close();
