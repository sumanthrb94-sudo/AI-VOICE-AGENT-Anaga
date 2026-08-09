// scripts/test-browser-console.mjs
//
// REAL BROWSER test of the operator console's call review.
//
// Runs the shipped console in Chromium against a stub API, so it exercises the
// actual DOM and the actual console.js — not a re-implementation.
//
// ── WHAT THIS PROVES ──────────────────────────────────────────────────────
//  * finished calls render with the score AND how much of the call was
//    actually qualified, never one without the other
//  * a transcript is fetched on demand, one call at a time — the list payload
//    never carries conversations
//  * TRANSCRIBED SPEECH CANNOT EXECUTE. The transcript is words a stranger
//    said on a phone call, transcribed by a vendor, rendered inside a page
//    that holds the operator key. If any of that is ever put through innerHTML
//    it is a stored XSS with a credential sitting next to it.
//  * a recording is played through a minted signed URL, and that URL is never
//    written into the page as text
//  * with no durable store the console says calls are NOT being kept, rather
//    than showing an empty table that looks like "no calls yet"
//
// Run: node scripts/test-browser-console.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const WEB = path.join(ROOT, 'web');
const KEY = 'browser-console-operator-key';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

// A transcript line that tries to execute. This is not paranoia: it is one
// prospect reading a string aloud, or one STT vendor returning markup.
const HOSTILE = '<img src=x onerror="window.__pwned=1"> and also <script>window.__pwned=1</script>';

const world = {
  durable: true,
  transcriptRequests: [],
  recordingRequests: [],
};

const CALLS = [
  {
    callId: 'call_hot', at: '2026-08-09T10:00:00.000Z', startedAt: '2026-08-09T10:00:00.000Z',
    durationSec: 96, disposition: 'booked', optOut: false,
    score: 87, band: 'hot',
    scoring: { band: 'hot', coverage: 100, answered: 4, of: 4, cappedBy: null, fields: [], explain: '87/100 (hot), 4 of 4 questions answered.' },
    qualification: { purpose: 'end-use', budget: 'in-range', config: 'match', timeline: 'immediate' },
    summary: 'Qualified end-user, booked Saturday.', nextAction: 'Assign a closer.',
    comment: 'Serious buyer.', reviewedBy: 'llm', turns: 6,
    recordingRef: 's3://vaak-recordings/calls/2026-08-09/call_hot.wav',
    lead: { phoneMasked: '+9198*****78', name: 'Test Lead', source: 'meta', sourceId: 'l1', crmRecordId: 'c1' },
  },
  {
    callId: 'call_thin', at: '2026-08-09T09:00:00.000Z', startedAt: '2026-08-09T09:00:00.000Z',
    durationSec: 31, disposition: 'callback', optOut: false,
    score: 48, band: 'cool',
    scoring: { band: 'cool', coverage: 25, answered: 1, of: 4, cappedBy: null, fields: [], explain: '48/100 (cool), 1 of 4 questions answered.' },
    qualification: { budget: 'in-range' }, summary: 'Only gave a budget.',
    nextAction: 'Call back.', comment: '', reviewedBy: 'llm', turns: 3,
    recordingRef: null,
    lead: { phoneMasked: '+9197*****11', name: 'Thin Lead', source: 'meta', sourceId: 'l2', crmRecordId: 'c2' },
  },
];

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const query = new URLSearchParams((req.url.split('?')[1] || ''));
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.startsWith('/api/')) {
    if ((req.headers.authorization || '') !== `Bearer ${KEY}`) return send(401, { error: 'unauthorized' });
  }

  if (url === '/api/console/summary') {
    return send(200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      wiring: {
        meta: { appSecret: true, pageAccessToken: true, verifyToken: true },
        crm: { provider: 'webhook', configured: true },
        compliance: { mode: 'strict', dndScrub: true, suppressionList: true, quietHours: '09:00–21:00 IST' },
        dialQueue: { configured: true }, blockers: [], canDial: true,
      },
      funnel: { counts: { received: 2, blocked: 0, queued: 2, completed: 2, booked: 1 }, bySource: { meta: 2 }, blockReasons: {}, dialRate: 100, bookRate: 50, avgScore: 67 },
      events: [],
      calls: world.durable ? CALLS : [],
      store: world.durable
        ? { durable: true, backend: 'firestore', projectId: 'vaak', reachable: true, held: 2 }
        : { durable: false, backend: 'memory', reachable: false, held: 0, capacity: 500, instanceStartedAt: new Date().toISOString(), storeError: null },
    });
  }

  if (url === '/api/calls/transcript') {
    const callId = query.get('callId');
    world.transcriptRequests.push(callId);
    const base = CALLS.find((c) => c.callId === callId);
    if (!base) return send(404, { error: 'call_not_found' });
    return send(200, {
      ok: true,
      call: {
        ...base,
        transcript: [
          { role: 'agent', text: "Hi, I'm Anaga, an AI voice assistant from Vaak." },
          { role: 'user', text: HOSTILE },
          { role: 'agent', text: 'Could I book you a site visit this weekend?' },
        ],
      },
    });
  }

  if (url === '/api/calls/recording') {
    world.recordingRequests.push(query.get('ref'));
    return send(200, { url: 'https://signed.invalid/audio.wav?sig=SECRETSIGNATURE', expiresInSec: 300 });
  }

  // static
  const file = path.join(WEB, url === '/' ? 'index.html' : url.replace(/^\//, ''));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pageErrors = [];

async function openConsole() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(([k, key]) => { sessionStorage.setItem(k, key); }, ['vaak_operator_key', KEY]);
  await page.goto(`${BASE}/console.html`);
  try {
    await page.waitForSelector('#calls-body table, #calls-body .empty', { timeout: 10000 });
  } catch (e) {
    throw new Error(`console did not render calls — freshness says "${await page.locator('#freshness').innerText()}"`);
  }
  return { ctx, page };
}

console.log('\n═══ REAL BROWSER: operator call review ═══\n');

let ctx, page;

await t('finished calls render with the outcome and the lead score', async () => {
  world.durable = true;
  ({ ctx, page } = await openConsole());
  const rows = await page.locator('#calls-body tbody tr:not([hidden])').count();
  assert.ok(rows >= 2, `expected the calls, got ${rows} rows`);
  const body = await page.locator('#calls-body').innerText();
  assert.ok(body.includes('87/100'), 'the score should be shown');
  assert.ok(body.includes('booked'), 'the outcome should be shown');
});

await t('a score is never shown without how much was actually qualified', async () => {
  const body = await page.locator('#calls-body').innerText();
  assert.ok(/4 of 4 questions answered/.test(body), 'the well-qualified call');
  assert.ok(/1 of 4 questions answered/.test(body),
    'a 48 off one answer must not look like a 48 off four');
});

await t('the number is masked in the operator view', async () => {
  const body = await page.locator('#calls-body').innerText();
  assert.ok(body.includes('+9198*****78'));
  assert.ok(!/\+919\d{9}/.test(body), 'a full number reached the page');
});

await t('the list payload carries no transcripts — they are fetched one at a time', async () => {
  assert.equal(world.transcriptRequests.length, 0, 'nothing should have been fetched yet');
  await page.locator('#calls-body tbody tr').first().getByRole('button', { name: 'Transcript' }).click();
  await page.waitForFunction(() => document.querySelector('.transcript') !== null, null, { timeout: 5000 });
  assert.deepEqual(world.transcriptRequests, ['call_hot'], 'exactly one call, on demand');
});

await t('the transcript renders, agent and prospect both', async () => {
  const text = await page.locator('.transcript').innerText();
  assert.ok(text.includes('Anaga:'), text.slice(0, 200));
  assert.ok(text.includes('Prospect:'));
  assert.ok(text.includes('site visit this weekend'));
});

await t('THE ONE THAT MATTERS: transcribed speech cannot execute', async () => {
  // A page holding the operator key must not run markup that arrived as words
  // somebody said down a phone line.
  const pwned = await page.evaluate(() => window.__pwned === 1);
  assert.equal(pwned, false, 'a hostile transcript executed inside the console');
  const injected = await page.locator('.transcript img, .transcript script').count();
  assert.equal(injected, 0, 'the markup was parsed as HTML rather than shown as text');
  const shown = await page.locator('.transcript').innerText();
  assert.ok(shown.includes('onerror'), 'and it should still be READABLE as what they said');
});

await t('the score explanation travels with the transcript', async () => {
  const text = await page.locator('.transcript').innerText();
  assert.ok(text.includes('87/100'), '"why is this an 87?" should be answerable here');
});

await t('playing a recording mints a signed URL, and never renders it', async () => {
  await page.locator('#calls-body tbody tr').first().getByRole('button', { name: 'Recording' }).click();
  await page.waitForSelector('#calls-body audio', { timeout: 5000 });
  assert.deepEqual(world.recordingRequests, ['s3://vaak-recordings/calls/2026-08-09/call_hot.wav']);
  const body = await page.locator('#calls-body').innerText();
  assert.ok(!body.includes('SECRETSIGNATURE'),
    'the signed URL is a bearer credential for that audio — it must not be page text');
});

await t('a call with no recording offers no playback button', async () => {
  const second = page.locator('#calls-body tbody tr').nth(2);   // row 0 is a call, row 1 its detail
  assert.equal(await second.getByRole('button', { name: 'Recording' }).count(), 0);
});

await t('with no durable store the console says calls are NOT being kept', async () => {
  await ctx.close();
  world.durable = false;
  ({ ctx, page } = await openConsole());
  const body = await page.locator('#calls-body').innerText();
  assert.ok(/not being kept/i.test(body), `an empty table reads as "no calls yet": ${body}`);
  assert.ok(/FIREBASE_SERVICE_ACCOUNT/.test(body), 'and it should say what to set');
});

await t('no uncaught page errors', async () => {
  assert.deepEqual(pageErrors, []);
});

await ctx.close();
await browser.close();
server.close();

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
