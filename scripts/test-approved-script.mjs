// scripts/test-approved-script.mjs
//
// The reviewed English qualification wording must be rendered verbatim in
// browser-script mode. This test protects the contract that removes the LLM
// round trip without turning the flow into an untested second script.

import assert from 'node:assert/strict';
import { approvedScriptAvailable, approvedScriptLines, approvedScriptTurn } from '../api/_lib/approved-script.js';

let pass = 0;
async function test(name, fn) {
  await fn();
  pass++;
  console.log('  ✓', name);
}

const greet = 'Thanks for calling Vaak — I am Anaga, an AI voice assistant.';
function history(...items) {
  return items.map(([role, text]) => ({ role, text }));
}

await test('uses the exact reviewed purpose line after the opening', () => {
  const out = approvedScriptTurn(history(['agent', greet], ['user', 'Yes, please']), { lang: 'en-IN' });
  assert.equal(out?.id, 'purpose');
  assert.equal(out?.say, 'Are you looking for a home to live in, or more as an investment?');
  assert.equal(out?.disposition, 'qualifying');
});

await test('advances through the approved qualification order without an LLM', () => {
  const out = approvedScriptTurn(history(
    ['agent', greet], ['user', 'Yes'],
    ['agent', 'Are you looking for a home to live in, or more as an investment?'], ['user', 'Investment']
  ), { lang: 'en-IN' });
  assert.equal(out?.id, 'budget');
  assert.equal(out?.say, 'What budget range are you considering — for example one to two crore, or higher?');
});

await test('takes the reviewed busy branch before qualification', () => {
  const out = approvedScriptTurn(history(['agent', greet], ['user', 'I am busy, call back later']), { lang: 'en-IN' });
  assert.equal(out?.id, 'busy');
  assert.equal(out?.end, true);
  assert.equal(out?.disposition, 'busy');
});

await test('takes the reviewed opt-out branch immediately', () => {
  const out = approvedScriptTurn(history(['agent', greet], ['user', 'Please do not call me again']), { lang: 'en-IN' });
  assert.equal(out?.id, 'optout');
  assert.equal(out?.end, true);
  assert.equal(out?.disposition, 'opt-out');
  assert.match(out?.say || '', /do-not-call list/i);
});

await test('branches to booking and fills only the approved day placeholder', () => {
  const turns = [
    ['agent', greet], ['user', 'Yes'],
    ['agent', 'Are you looking for a home to live in, or more as an investment?'], ['user', 'Investment'],
    ['agent', 'What budget range are you considering — for example one to two crore, or higher?'], ['user', 'Two crore'],
    ['agent', 'Are you looking at a 2BHK, 3BHK, or something larger?'], ['user', 'Three BHK'],
    ['agent', 'Are you planning to buy in the next few months, or just exploring for now?'], ['user', 'In three months'],
    ['agent', 'Based on what you have told me, I think Skyline Villaments would suit you. Could I book you a site visit this weekend?'], ['user', 'Yes, Saturday works'],
  ];
  const book = approvedScriptTurn(history(...turns), { lang: 'en-IN' });
  assert.equal(book?.id, 'book');
  const confirm = approvedScriptTurn(history(...turns, ['agent', book.say], ['user', 'Saturday']), { lang: 'en-IN' });
  assert.equal(confirm?.id, 'confirm');
  assert.equal(confirm?.end, true);
  assert.match(confirm?.say || '', /Saturday/);
});

await test('does not claim unreviewed non-English step wording is scripted', () => {
  assert.equal(approvedScriptAvailable('te-IN'), false);
  assert.deepEqual(approvedScriptLines('hi-IN'), []);
  assert.equal(approvedScriptTurn(history(['agent', greet], ['user', 'అవును']), { lang: 'te-IN' }), null);
});

console.log(`\n═══ ${pass} passed, 0 failed ═══\n`);
