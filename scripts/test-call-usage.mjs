// scripts/test-call-usage.mjs
//
// The billing record must be measured, not guessed: audio duration is derived
// from the actual wire format, costs require an explicitly configured rate, and
// the outcome payload must stay numeric/non-PII.

import assert from 'node:assert/strict';
import {
  audioDurationMs,
  createCallUsageLedger,
  sanitizeCallUsage,
  callUsageStatus,
} from '../shared/call-usage.js';

let pass = 0;
async function test(name, fn) {
  await fn();
  pass++;
  console.log('  ✓', name);
}

console.log('\n═══ CALL USAGE AND COST QA ═══\n');

await test('wire audio is metered from its true codec and sample rate', () => {
  assert.equal(audioDurationMs(640, { encoding: 'linear16', sampleRate: 16000 }), 20);
  assert.equal(audioDurationMs(160, { encoding: 'mulaw', sampleRate: 8000 }), 20);
  assert.equal(audioDurationMs(0, { encoding: 'linear16', sampleRate: 16000 }), 0);
});

await test('unconfigured rates keep vendor units visible but cost deliberately incomplete', () => {
  const clock = { now: 1_000 };
  const usage = createCallUsageLedger({ env: { CALL_COST_CURRENCY: 'INR' }, now: () => clock.now });
  usage.recordSTT({ provider: 'deepgram', audioMs: 60_000 });
  usage.recordTTS({ provider: 'sarvam', chars: 1_000, audioMs: 2_000 });
  usage.recordLLM({ provider: 'sarvam', inputChars: 500, outputChars: 500 });
  clock.now = 61_000;
  const snapshot = usage.close();

  assert.equal(snapshot.stages.stt[0].billableUnits, 1);
  assert.equal(snapshot.stages.tts[0].billableUnits, 1);
  assert.equal(snapshot.stages.llm[0].billableUnits, 1);
  assert.equal(snapshot.stages.telephony.billableUnits, 1);
  assert.equal(snapshot.estimate.complete, false);
  assert.equal(snapshot.estimate.amount, 0, 'unpriced is not silently estimated');
  assert.deepEqual(snapshot.estimate.unpriced.sort(), [
    'deepgram:MINUTE', 'outbound:MINUTE', 'sarvam:1K_CHARS', 'sarvam:1K_CHARS',
  ].sort());
});

await test('configured invoice rates produce a reproducible blended estimate', () => {
  const clock = { now: 0 };
  const usage = createCallUsageLedger({
    env: {
      CALL_COST_CURRENCY: 'INR',
      CALL_COST_STT_DEEPGRAM_PER_MINUTE: '1.2',
      CALL_COST_TTS_SARVAM_PER_1K_CHARS: '0.3',
      CALL_COST_LLM_SARVAM_PER_1K_CHARS: '0.1',
      CALL_COST_TELEPHONY_OUTBOUND_PER_MINUTE: '0.5',
    },
    now: () => clock.now,
  });
  usage.recordSTT({ provider: 'deepgram', audioMs: 60_000 });
  usage.recordTTS({ provider: 'sarvam', chars: 1_000, audioMs: 2_000 });
  usage.recordLLM({ provider: 'sarvam', inputChars: 500, outputChars: 500 });
  clock.now = 60_000;
  const snapshot = usage.close();

  assert.equal(snapshot.currency, 'INR');
  assert.equal(snapshot.estimate.complete, true);
  assert.equal(snapshot.estimate.amount, 2.1);
});

await test('health exposes rate presence without commercial values', () => {
  const status = callUsageStatus({
    env: {
      CALL_COST_CURRENCY: 'INR',
      CALL_COST_STT_DEEPGRAM_PER_MINUTE: '1.2',
      CALL_COST_TTS_SARVAM_PER_1K_CHARS: '',
    },
  });
  assert.equal(status.currency, 'INR');
  assert.ok(status.configuredRates.includes('CALL_COST_STT_DEEPGRAM_PER_MINUTE'));
  assert.ok(status.missingRates.includes('CALL_COST_TTS_SARVAM_PER_1K_CHARS'));
  assert.equal(status.complete, false);
  assert.doesNotMatch(JSON.stringify(status), /1\.2/);
});

await test('the persisted shape excludes lead, audio, and transcript data', () => {
  const safe = sanitizeCallUsage({
    version: 99,
    currency: 'inr',
    durationMs: 10_000,
    phone: '+919999999999',
    transcript: 'do not persist this',
    audio: 'base64-do-not-persist',
    stages: {
      stt: [{ provider: 'deepgram', audioMs: 2_000, text: 'private' }],
      tts: [{ provider: 'sarvam', chars: 40, audioMs: 300, cached: true }],
      llm: [{ provider: 'sarvam', inputChars: 100, outputChars: 40, prompt: 'private' }],
      telephony: { durationMs: 10_000, billableUnits: 1 / 6, unit: 'MINUTE' },
    },
    estimate: { amount: 1.1, complete: false, unpriced: ['sarvam:1K_CHARS'] },
  });
  const json = JSON.stringify(safe);
  assert.equal(safe.currency, 'INR');
  assert.equal(safe.stages.stt[0].audioMs, 2_000);
  assert.doesNotMatch(json, /9999999999|transcript|base64|private|prompt/i);
});

console.log(`\n═══ ${pass} passed, 0 failed ═══\n`);
