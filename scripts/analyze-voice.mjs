// scripts/analyze-voice.mjs
//
// Measure what a voice actually sounds like, instead of arguing about it.
//
// "The voice sounds robotic" is a real report and a useless bug ticket: it
// cannot be reproduced, compared between versions, or checked after a fix. Every
// property people mean by it IS measurable, so this measures them.
//
//   node --experimental-detect-module scripts/analyze-voice.mjs sample.wav
//   node --experimental-detect-module scripts/analyze-voice.mjs \
//        --text "Namaste, main Anaga hoon" --lang hi-IN --base https://…
//
// WHAT THE NUMBERS MEAN
//
//   F0 spread (semitones)  Pitch movement across the utterance. This is the
//                          measurement behind "robotic". Natural expressive
//                          speech sits around 2.5-5 st; a flat concatenative
//                          or badly-conditioned TTS comes in under 1.5 and
//                          sounds dead. Measured in semitones, not Hz, because
//                          Hz is not perceptually linear and a male and a
//                          female voice are not comparable in Hz at all.
//
//   Bandwidth / rolloff    Where the audio actually stops. A hard wall at
//                          ~3.4kHz is the telephone band. A wall at 4kHz means
//                          something rendered at 8kHz. This is what separates
//                          "the vendor's voice is poor" from "our pipeline
//                          destroyed a good voice" — a distinction worth having
//                          before blaming a vendor.
//
//   Clipping               Samples pinned at full scale. Audible as crackle,
//                          and usually a gain bug rather than a voice problem.
//
//   Voiced ratio / gaps    Pacing. Chunked synthesis shows up here: rendering
//                          a line phrase-by-phrase can leave a seam at every
//                          phrase boundary, and a run of suspiciously regular
//                          mid-sentence gaps is that seam.
//
// Zero dependencies, like the rest of the repo — the FFT and the pitch tracker
// are below. WAV in (PCM 16-bit); an MP3 has to be converted first, because a
// hand-rolled MP3 decoder is not worth owning.

import fs from 'node:fs';
import { parseWav } from '../caller-agent/src/providers/speech.js';

// ---------------------------------------------------------------------------
// signal helpers
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT. re/im are Float64Array of length 2^k. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const nextPow2 = (n) => 1 << Math.ceil(Math.log2(n));

/** Magnitude spectrum of one windowed frame. */
function spectrum(frame) {
  const n = nextPow2(frame.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < frame.length; i++) {
    re[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame.length - 1)));
  }
  fft(re, im);
  const half = n / 2 + 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/**
 * Fundamental frequency by autocorrelation, computed through the FFT.
 *
 * Deliberately simple, and it reports NOTHING rather than guessing: a frame
 * whose autocorrelation peak is weak is unvoiced (a consonant, silence, line
 * noise), and inventing a pitch for it would flatten the very statistic this
 * script exists to measure.
 */
function detectF0(frame, sampleRate, { fmin = 70, fmax = 300, minPeak = 0.35 } = {}) {
  let mean = 0;
  for (const v of frame) mean += v;
  mean /= frame.length;

  const n = nextPow2(frame.length * 2);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < frame.length; i++) {
    re[i] = (frame[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame.length - 1)));
  }
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im);                      // inverse via conjugate symmetry of a real even spectrum

  const ac = re;
  if (!(ac[0] > 0)) return null;
  const lo = Math.floor(sampleRate / fmax);
  const hi = Math.min(Math.floor(sampleRate / fmin), frame.length - 1);
  let best = -1, bestK = -1;
  for (let k = lo; k <= hi; k++) {
    if (ac[k] > best) { best = ac[k]; bestK = k; }
  }
  if (bestK < 0) return null;
  return best / ac[0] > minPeak ? sampleRate / bestK : null;
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

export function analyze(samples, sampleRate) {
  const n = samples.length;
  const dur = n / sampleRate;

  let peak = 0, sumSq = 0, clipped = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 0.995) clipped++;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  const dbfs = (v) => 20 * Math.log10(Math.max(v, 1e-12));

  // ---- framing -----------------------------------------------------------
  const win = Math.round(0.040 * sampleRate);
  const hop = Math.round(0.020 * sampleRate);
  const frames = [];
  for (let i = 0; i + win <= n; i += hop) {
    const fr = samples.subarray(i, i + win);
    let s = 0;
    for (const v of fr) s += v * v;
    frames.push({ at: i / sampleRate, frame: fr, rms: Math.sqrt(s / win) });
  }
  if (!frames.length) throw new Error('audio too short to analyse');

  // Speech vs silence, relative to the file's own noise floor — an absolute
  // threshold would call a quiet recording silent from end to end.
  const sorted = frames.map((f) => f.rms).slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const speechThr = Math.max(floor * 3, rms * 0.1);

  // ---- average spectrum over speech frames only --------------------------
  const voicedFrames = frames.filter((f) => f.rms > speechThr);
  const specFrames = (voicedFrames.length ? voicedFrames : frames).slice(0, 600);
  const bins = spectrum(specFrames[0].frame).length;
  const avg = new Float64Array(bins);
  for (const f of specFrames) {
    const m = spectrum(f.frame);
    for (let i = 0; i < bins; i++) avg[i] += m[i] * m[i];
  }
  const fftLen = (bins - 1) * 2;
  const binHz = sampleRate / fftLen;

  let total = 0;
  for (const v of avg) total += v;
  const rolloff = (p) => {
    let acc = 0;
    for (let i = 0; i < bins; i++) {
      acc += avg[i];
      if (acc / total >= p) return Math.round(i * binHz);
    }
    return Math.round(sampleRate / 2);
  };
  let maxBin = 0;
  for (const v of avg) if (v > maxBin) maxBin = v;
  let edge = 0;
  for (let i = 0; i < bins; i++) if (10 * Math.log10(avg[i] / maxBin + 1e-20) > -40) edge = i;
  const bandwidth = Math.round(edge * binHz);

  // ---- pitch track -------------------------------------------------------
  const f0s = [];
  for (const f of frames) {
    if (f.rms <= speechThr) continue;
    const v = detectF0(f.frame, sampleRate);
    if (v) f0s.push(v);
  }
  f0s.sort((a, b) => a - b);
  const pct = (p) => (f0s.length ? f0s[Math.min(f0s.length - 1, Math.floor(f0s.length * p))] : null);
  const median = pct(0.5);

  let spread = null;
  if (f0s.length > 20) {
    const st = f0s.map((v) => 12 * Math.log2(v / median));
    const m = st.reduce((a, b) => a + b, 0) / st.length;
    spread = Math.sqrt(st.reduce((a, b) => a + (b - m) ** 2, 0) / st.length);
  }

  // ---- pacing ------------------------------------------------------------
  const segs = [], gaps = [];
  let run = 0, cur = frames[0].rms > speechThr;
  for (const f of frames) {
    const s = f.rms > speechThr;
    if (s === cur) run++;
    else { (cur ? segs : gaps).push(run * 0.020); run = 1; cur = s; }
  }
  (cur ? segs : gaps).push(run * 0.020);
  const internal = gaps.filter((g) => g > 0.08 && g < 2.0);

  return {
    durationSec: +dur.toFixed(2),
    sampleRate,
    peakDbfs: +dbfs(peak).toFixed(1),
    rmsDbfs: +dbfs(rms).toFixed(1),
    clippedSamples: clipped,
    bandwidthHz: bandwidth,
    rolloff85Hz: rolloff(0.85),
    rolloff99Hz: rolloff(0.99),
    f0MedianHz: median ? +median.toFixed(1) : null,
    f0P10Hz: pct(0.1) ? +pct(0.1).toFixed(1) : null,
    f0P90Hz: pct(0.9) ? +pct(0.9).toFixed(1) : null,
    f0SpreadSemitones: spread == null ? null : +spread.toFixed(2),
    voicedPct: +((100 * f0s.length) / frames.length).toFixed(1),
    speechSec: +segs.reduce((a, b) => a + b, 0).toFixed(1),
    silenceSec: +gaps.reduce((a, b) => a + b, 0).toFixed(1),
    internalGaps: internal.length,
    medianGapSec: internal.length
      ? +internal.slice().sort((a, b) => a - b)[Math.floor(internal.length / 2)].toFixed(3)
      : null,
  };
}

/**
 * Turn the measurements into statements someone can act on. Each verdict names
 * the thing to go and look at, because "quality: 62/100" tells nobody anything.
 */
export function verdicts(a) {
  const out = [];

  if (a.f0SpreadSemitones == null) {
    out.push(['unknown', 'Not enough voiced audio to judge intonation.']);
  } else if (a.f0SpreadSemitones < 1.5) {
    out.push(['BAD', `Monotone: ${a.f0SpreadSemitones} semitones of pitch movement. This is what people mean by "robotic". Natural speech is 2.5-5.`]);
  } else if (a.f0SpreadSemitones < 2.5) {
    out.push(['WARN', `Flat-ish: ${a.f0SpreadSemitones} semitones. Understated but not dead.`]);
  } else {
    out.push(['OK', `Intonation is natural: ${a.f0SpreadSemitones} semitones of pitch movement.`]);
  }

  if (a.bandwidthHz < 3800) {
    out.push(['INFO', `Telephone band (content stops at ${a.bandwidthHz} Hz). Expected on a call leg; on the browser demo it means something resampled to 8kHz.`]);
  } else if (a.bandwidthHz < 7000) {
    out.push(['WARN', `Narrow: content stops at ${a.bandwidthHz} Hz — an 8kHz render being played as if it were wideband.`]);
  } else {
    out.push(['OK', `Full bandwidth to ${a.bandwidthHz} Hz.`]);
  }

  if (a.clippedSamples > 0) {
    out.push(['BAD', `${a.clippedSamples} clipped samples — audible crackle. That is a gain bug, not a voice problem.`]);
  }
  if (a.peakDbfs < -20) {
    out.push(['WARN', `Very quiet (peak ${a.peakDbfs} dBFS). Quiet reads as "muffled" long before it reads as "quiet".`]);
  }
  if (a.internalGaps > 0 && a.medianGapSec != null && a.medianGapSec > 0.35) {
    out.push(['WARN', `${a.internalGaps} mid-utterance gaps, median ${a.medianGapSec}s. Check whether chunked synthesis is leaving a seam at every phrase boundary (TTS_CHUNK_SPEECH=0 to test).`]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------
function pcmFromWav(buf) {
  const { data, sampleRate, channels, bitsPerSample } = parseWav(buf);
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}-bit`);
  const total = Math.floor(data.length / 2);
  const mono = new Float32Array(Math.floor(total / channels));
  for (let i = 0; i < mono.length; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2);
    mono[i] = s / channels / 32768;
  }
  return { samples: mono, sampleRate };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };

  let wav;
  const text = flag('text');
  if (text) {
    // Ask a deployment to speak, then measure what came back. This is the loop
    // that turns "it sounds bad" into a number attached to a commit.
    const base = (flag('base') || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    if (!base) { console.error('--text needs --base https://your-deploy'); process.exit(2); }
    const res = await fetch(`${base}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: flag('lang') || 'en-IN', gender: flag('gender') || 'female', speaker: flag('speaker') || undefined }),
    });
    if (!res.ok) { console.error(`/api/tts returned ${res.status}`); process.exit(1); }
    const out = await res.json();
    console.log(`provider: ${out.provider}   voice: ${out.voice || '—'}   gender: ${out.gender}   mime: ${out.mime}`);
    if (!/wav/.test(out.mime || '')) {
      console.error(`\nGot ${out.mime}. This analyser reads WAV; ask for it with SARVAM_STREAM=0 on the`);
      console.error('deployment, or convert first. (An MP3 decoder is not worth a dependency here.)');
      process.exit(3);
    }
    wav = Buffer.from(out.audio, 'base64');
  } else {
    const file = argv.find((a) => !a.startsWith('--'));
    if (!file) {
      console.error('usage: analyze-voice.mjs <file.wav>');
      console.error('       analyze-voice.mjs --text "…" --lang hi-IN --base https://…');
      process.exit(2);
    }
    wav = fs.readFileSync(file);
  }

  const { samples, sampleRate } = pcmFromWav(wav);
  const a = analyze(samples, sampleRate);

  console.log('\n═══ VOICE ANALYSIS ═══\n');
  for (const [k, v] of Object.entries(a)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log('\n─── verdict ───');
  for (const [level, msg] of verdicts(a)) console.log(`  [${level}] ${msg}`);
  console.log();
}
