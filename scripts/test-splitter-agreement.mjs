// scripts/test-splitter-agreement.mjs
//
// The browser's phrase splitter and the server's must agree, character for
// character, on every line either of them will ever see.
//
// ── WHY THIS IS NOT PEDANTRY ──────────────────────────────────────────────
// api/anaga/turn.js pre-renders PHRASE 0 with the SERVER splitter and ships
// that audio inside the turn response, so the browser does not have to wait
// for synthesis. The browser then splits the same line with its OWN splitter
// and speaks everything after phrase 0.
//
// If the two disagree about where phrase 0 ends, the prospect hears the
// overlap twice, or hears a fragment cut mid-word. They disagreed on every
// decimal number:
//
//   "Your budget is 3.5 crore, is that right?"
//     server  -> "Your budget is 3.5 crore," | "is that right?"
//     browser -> "Your budget is 3."         | "5 crore, is that right?"
//
// which is a budget figure read wrong, on the one turn where the number is
// the entire point.
//
// The two implementations cannot be merged: the server uses lookbehind
// (/(?<=[.!?।॥])\s+/) and lookbehind is a PARSE-time SyntaxError on Safari
// before 16.4 — it would not degrade the call page, it would blank it. So
// they stay separate and this test holds them together.
//
// Run: node --experimental-detect-module scripts/test-splitter-agreement.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

import { splitForSpeech } from '../shared/speech-split.js';

/* ---- lift the browser splitter out of demo-call.js, unmodified ---------- */

const src = fs.readFileSync(new URL('../web/assets/demo-call.js', import.meta.url), 'utf8');

// demo-call.js exposes its splitter for exactly this reason (window.__splitForSpeech).
// Run it in a sandbox with just enough DOM for the IIFE to reach that line.
const noop = () => {};
const el = () => ({
  addEventListener: noop, appendChild: noop, removeChild: noop, remove: noop,
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  querySelectorAll: () => [], querySelector: () => null, closest: () => null,
  style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', focus: noop,
  setAttribute: noop, getAttribute: () => null, scrollTop: 0, scrollHeight: 0,
});
const sandbox = {
  window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => Promise.reject(new Error('no network in this test')),
  navigator: { mediaDevices: {}, userAgent: 'node' },
  performance: { now: () => 0 },
  location: { host: 'test', protocol: 'https:', search: '' },
  localStorage: { getItem: () => null, setItem: noop },
  Audio: function () { return el(); },
  document: {
    addEventListener: noop, getElementById: () => el(), createElement: () => el(),
    querySelectorAll: () => [], querySelector: () => null,
    body: el(), documentElement: el(), hidden: false,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch (err) {
  console.error('could not evaluate demo-call.js in a sandbox:', err.message);
  process.exit(1);
}

const browserSplit = sandbox.window.__splitForSpeech;
assert.equal(typeof browserSplit, 'function',
  'demo-call.js must keep exposing window.__splitForSpeech — this test is why');

/* ------------------------------------------------------------------ cases */

// Lines Anaga actually says, in the three languages she says them in, plus the
// number shapes an Indian property call is full of.
const LINES = [
  // the decimals that started this
  'Your budget is 3.5 crore, is that right?',
  'It works out to about 7.25 crore all-in.',
  'The rate is 8,400 per sq ft. Does that work?',
  'Possession is in March 2027. Shall we visit this weekend?',
  'It is 1.5 km from the ORR. Would you like to see it?',
  'Around 2.5 to 3 crore, or higher?',

  // ordinary two-sentence turns
  'Namaste! This is Anaga from Modcon Builders. Do you have a quick minute?',
  "Understood. I'll add your number to our do-not-call list right away.",
  'Are you looking to live in it, or to invest?',

  // Devanagari danda, and Hindi with a decimal
  'नमस्ते, मैं अनगा हूँ। दो मिनट बात कर सकती हूँ?',
  'बजट 3.5 करोड़ तक सोच रहे हैं क्या। ठीक है।',
  'पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।',

  // Telugu, code-mixed the way the flow actually writes it
  'హలో, నేను అనగా, మోడ్‌కాన్ బిల్డర్స్ నుంచి AI వాయిస్ అసిస్టెంట్‌ని. రెండు నిమిషాలు టైమ్ ఉందా?',
  'బడ్జెట్ 2.5 కోట్ల దాకా ఆలోచిస్తున్నారా?',
  'టూ బీహెచ్‌కే నా, త్రీ బీహెచ్‌కే నా? ఈ వీకెండ్ సైట్ విజిట్ పెట్టుకుందామా?',

  // abbreviations and edge shapes
  'Meet Mr. Rao at the site office.',
  'No.',
  'Okay!',
  'Really? Yes. Fine.',
  'A trailing space is fine too. ',
];

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

console.log('\n═══ SPLITTER AGREEMENT ═══\n');

for (const line of LINES) {
  const label = line.length > 46 ? line.slice(0, 44) + '…' : line;
  t(label, () => {
    const server = splitForSpeech(line);
    const browser = browserSplit(line);
    assert.deepEqual(browser, server,
      `\n       server : ${JSON.stringify(server)}\n       browser: ${JSON.stringify(browser)}`);
  });
}

console.log('\n─── the property that actually matters ───\n');

t('PHRASE 0 IS IDENTICAL — it is the one the server pre-renders and ships', () => {
  // Even if the tails ever diverged, this is the seam that produces audible
  // damage: the server sends phrase 0 as audio and the browser speaks the rest.
  const wrong = LINES.filter((l) => splitForSpeech(l)[0] !== browserSplit(l)[0]);
  assert.deepEqual(wrong, [], `these lines would double or truncate the opening phrase:\n       ${wrong.join('\n       ')}`);
});

t('a decimal is never a sentence boundary in either implementation', () => {
  for (const n of ['3.5 crore', '8.25 lakh', '1.5 km', '2.5 to 3 crore']) {
    const line = `The figure is ${n} in total.`;
    assert.equal(splitForSpeech(line).length, 1, `server split "${line}"`);
    assert.equal(browserSplit(line).length, 1, `browser split "${line}"`);
  }
});

t('the browser splitter still avoids lookbehind (Safari < 16.4 parse error)', () => {
  // A regression here does not degrade the page, it blanks it — the file fails
  // to parse, so nothing on the call screen runs at all.
  // Comments are stripped first: splitOn's own comment QUOTES the server
  // regex it has to match, so a naive scan flags the documentation rather than
  // the code. Checking the text of a comment is not checking the program.
  const from = src.indexOf('function splitOn');
  const code = src.slice(from, from + 1800)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\(\?<[=!]/, 'lookbehind in demo-call.js would blank the page on older iPhones');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
