// scripts/test-worklet-rate.mjs
//
// Does she come out of the speaker at the speed she was synthesized at?
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
// She spoke roughly three times too fast on a deployed call, pitched up, and
// nothing anywhere reported a problem: no error, no log line, no failed check.
//
// CaptureProcessor was told its target rate and resampled 48kHz down to 16kHz.
// PlaybackProcessor was told nothing and resampled not at all — it wrote 16kHz
// samples one per output frame into a graph the browser renders at the DEVICE
// rate. On a 48kHz phone that is exactly 3x. The mic path was symmetric with
// the wire; the speaker path never was.
//
// A rate bug is the worst kind of audio bug because it does not sound like a
// bug. It sounds like a worse product.
//
// This runs the REAL worklet file — no re-implementation — inside a sandbox
// that supplies the three globals the audio thread provides, then measures how
// long a known number of input samples takes to come out.
//
// Run: node --experimental-detect-module scripts/test-worklet-rate.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/assets/pcm-worklet.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

/** Load the real worklet with the audio thread's globals stubbed. */
function loadWorklet(deviceRate) {
  const registered = {};
  const sandbox = {
    sampleRate: deviceRate,                         // the worklet global
    AudioWorkletProcessor: class {
      constructor() {
        const handlers = {};
        this.port = {
          onmessage: null,
          postMessage(d) { handlers.sent = d; },
        };
      }
    },
    registerProcessor: (name, cls) => { registered[name] = cls; },
    Int16Array, Float32Array, Math, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return registered;
}

/** Run `frames` quanta of 128 output samples and return everything produced. */
function render(node, quanta) {
  const out = [];
  for (let q = 0; q < quanta; q++) {
    const block = new Float32Array(128);
    node.process([], [[block]]);
    out.push(...block);
  }
  return out;
}

console.log('\n═══ PLAYBACK RATE ═══\n');

// 16kHz stream, 48kHz device — the ordinary phone and laptop case, and the one
// that was broken.
for (const deviceRate of [48000, 44100, 16000]) {
  t(`one second of 16kHz speech lasts one second on a ${deviceRate}Hz device`, () => {
    const { 'anaga-playback': Playback } = loadWorklet(deviceRate);
    const node = new Playback({ processorOptions: { sourceRate: 16000 } });

    // A full second of audio: 16000 samples, non-zero so silence is detectable.
    const speech = new Int16Array(16000);
    for (let i = 0; i < speech.length; i++) speech[i] = 8000;
    node.port.onmessage({ data: speech.buffer });

    // Render two seconds' worth of output and find where the audio stops.
    const quanta = Math.ceil((deviceRate * 2) / 128);
    const rendered = render(node, quanta);
    let lastAudible = -1;
    for (let i = 0; i < rendered.length; i++) if (rendered[i] !== 0) lastAudible = i;

    const seconds = (lastAudible + 1) / deviceRate;
    // 3% tolerance: the tail interpolates toward the next (absent) sample.
    assert.ok(Math.abs(seconds - 1) < 0.03,
      `played for ${seconds.toFixed(3)}s instead of 1.000s `
      + `— that is ${(1 / seconds).toFixed(2)}x speed`);
  });
}

t('WITHOUT a sourceRate it still assumes 16kHz rather than the device rate', () => {
  // Defence in depth: if live.js ever stops passing processorOptions, the
  // failure must not silently return to 3x speed.
  const { 'anaga-playback': Playback } = loadWorklet(48000);
  const node = new Playback();
  assert.equal(node.step, 16000 / 48000);
});

console.log('\n═══ WHAT THE RESAMPLING MUST NOT BREAK ═══\n');

t('barge-in still empties the buffer instantly', () => {
  const { 'anaga-playback': Playback } = loadWorklet(48000);
  const node = new Playback({ processorOptions: { sourceRate: 16000 } });
  const speech = new Int16Array(16000).fill(8000);
  node.port.onmessage({ data: speech.buffer });
  node.port.onmessage({ data: 'clear' });

  const rendered = render(node, 8);
  assert.ok(rendered.every((s) => s === 0),
    'audio survived a clear — she would talk over the prospect');
});

t('and a clear resets the fractional position, not just the queue', () => {
  // `at` is fractional now. Left mid-sample, the next phrase starts offset.
  const { 'anaga-playback': Playback } = loadWorklet(48000);
  const node = new Playback({ processorOptions: { sourceRate: 16000 } });
  node.port.onmessage({ data: new Int16Array(16000).fill(8000).buffer });
  render(node, 4);
  node.port.onmessage({ data: 'clear' });
  assert.equal(node.at, 0);
});

t('silence when there is nothing to say, not a crash', () => {
  const { 'anaga-playback': Playback } = loadWorklet(48000);
  const node = new Playback({ processorOptions: { sourceRate: 16000 } });
  const rendered = render(node, 4);
  assert.ok(rendered.every((s) => s === 0));
});

t('consecutive buffers play as one continuous phrase', () => {
  // Every buffer boundary used to reset `at` to 0 — inaudible at 1:1, but with
  // a fractional position it would drop or repeat a fraction of a sample each
  // time, several times a second.
  const { 'anaga-playback': Playback } = loadWorklet(48000);
  const node = new Playback({ processorOptions: { sourceRate: 16000 } });
  for (let n = 0; n < 3; n++) node.port.onmessage({ data: new Int16Array(1600).fill(8000).buffer });

  const rendered = render(node, Math.ceil((48000 * 0.5) / 128));
  let lastAudible = -1;
  for (let i = 0; i < rendered.length; i++) if (rendered[i] !== 0) lastAudible = i;

  const seconds = (lastAudible + 1) / 48000;
  assert.ok(Math.abs(seconds - 0.3) < 0.01,
    `three 100ms buffers played for ${seconds.toFixed(3)}s, not 0.300s`);
});

console.log('\n═══ CAPTURE, WHICH WAS ALWAYS RIGHT ═══\n');

t('capture still turns 48kHz microphone input into 16kHz PCM', () => {
  // The half that worked. Asserted so a change to one processor cannot quietly
  // break the symmetry between them again.
  const { 'anaga-capture': Capture } = loadWorklet(48000);
  const node = new Capture({ processorOptions: { targetRate: 16000 } });

  let produced = 0;
  node.port.postMessage = (buf) => { produced += new Int16Array(buf).length; };

  const quanta = 48000 / 128;                       // one second of microphone
  for (let q = 0; q < quanta; q++) node.process([[new Float32Array(128).fill(0.5)]], []);

  assert.ok(Math.abs(produced - 16000) <= 2,
    `one second of 48kHz audio produced ${produced} samples, not ~16000`);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
