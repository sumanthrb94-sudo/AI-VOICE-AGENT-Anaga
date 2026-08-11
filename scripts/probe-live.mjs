// scripts/probe-live.mjs
//
// TALK TO THE REAL VENDORS. No stubs, no dev server, no browser.
//
// Every other suite in scripts/ replaces globalThis.fetch so it can run in CI
// with no keys and no egress. That is the right trade for CI and it means those
// suites cannot tell you the one thing you want to know before a demo: whether
// Sarvam answers THIS key, on THIS network, today. Only a real request does.
//
// It drives the shipped adapters (api/_lib/*.js), not hand-written curl, so a
// pass here is a pass for the code that runs in production — model names, body
// shape, headers, timeouts and all.
//
//   SARVAM_API_KEY=… node --experimental-detect-module scripts/probe-live.mjs
//
// Options:
//   --skip-stt / --skip-tts / --skip-llm   run one leg at a time
//   --lang te-IN                           default te-IN
//   --text "…"                             what to synthesize and read back
//
// SPENDS MONEY. Three requests, a few hundred characters. That is the point —
// a probe that costs nothing proves nothing.
//
// THE ROUND TRIP IS THE POINT. It synthesizes a line, then sends that audio
// straight back to the recogniser and prints what came back. Two green ticks
// with no relationship between them can both be true while the pipeline is
// broken in the middle; this fails when the halves do not agree.

import { synth, ttsStatus, ttsAvailable, sarvamModel } from '../api/_lib/tts.js';
import { transcribe, sttStatus, sttAvailable } from '../api/_lib/stt.js';
import { generate, llmStatus } from '../api/_lib/llm.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const LANG = opt('--lang', 'te-IN');
const TEXT = opt('--text', {
  'te-IN': 'నమస్కారం, నేను అనగా. మీరు మూడు బెడ్‌రూమ్‌ల ఫ్లాట్ కోసం చూస్తున్నారా?',
  'hi-IN': 'Namaste, main Anaga hoon. Kya aap teen bedroom ka flat dhoondh rahe hain?',
  'en-IN': 'Hello, this is Anaga. Are you looking for a three bedroom flat?',
}[LANG] || 'Hello, this is Anaga.');

let failed = 0;
const ok = (m) => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = (m) => { failed++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const ms = (t) => `${Math.round(performance.now() - t)} ms`;

console.log('\n═══ LIVE VENDOR PROBE — real requests, real money ═══\n');
console.log(`  language   ${LANG}`);
console.log(`  stt        ${JSON.stringify(sttStatus())}`);
console.log(`  llm        ${JSON.stringify(llmStatus())}`);
console.log(`  tts        chain=${ttsStatus().chain} model=${sarvamModel()}`);
console.log(`  key        ${process.env.SARVAM_API_KEY ? 'SARVAM_API_KEY set' : '\x1b[31mSARVAM_API_KEY MISSING\x1b[0m'}\n`);

// ---------------------------------------------------------------------------
let spoken = null;    // the audio TTS produced, fed back into STT below

if (!has('--skip-tts')) {
  console.log('TTS — Sarvam Bulbul');
  if (!ttsAvailable()) bad('no TTS provider is configured; set SARVAM_API_KEY');
  else {
    const t = performance.now();
    try {
      const out = await synth({ text: TEXT, lang: LANG });
      const bytes = Buffer.from(out.audio, 'base64');
      // WHICH PROVIDER ANSWERED, not just "some audio arrived". The chain falls
      // back silently by design; a probe that does not name the winner will
      // cheerfully report success while Google Translate reads your Telugu.
      if (out.provider !== 'sarvam') {
        bad(`fell back to "${out.provider}" — Sarvam did not serve this. Reason is in the log above.`);
      } else {
        ok(`${out.provider} · ${out.voice || 'default voice'} · ${bytes.length} bytes ${out.mime} · ${ms(t)}`);
      }
      if (bytes.length < 2000) bad(`only ${bytes.length} bytes — that is not a spoken sentence`);
      spoken = { audio: bytes, mime: out.mime };
    } catch (err) {
      bad(`synth threw: ${err.message}${err.detail ? ' — ' + err.detail : ''}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
if (!has('--skip-stt')) {
  console.log('STT — Sarvam Saaras');
  if (!sttAvailable()) bad('no STT provider is configured; set SARVAM_API_KEY');
  else if (!spoken) console.log('  – skipped: nothing was synthesized to read back');
  else {
    const t = performance.now();
    try {
      // Deliberately WITHOUT a language hint: auto-detect is what a real call
      // uses, and getting the language wrong is the failure that matters.
      const out = await transcribe({ audio: spoken.audio, mime: spoken.mime });
      ok(`${out.provider} · detected ${out.lang || 'nothing'} · ${ms(t)}`);
      console.log(`      heard: ${out.text || '(empty)'}`);
      if (!out.text) bad('it transcribed our own clear synthesis as silence');
      if (out.lang && out.lang !== LANG) {
        bad(`detected ${out.lang} for a ${LANG} line — a real prospect would be transcribed as gibberish`);
      }
    } catch (err) {
      bad(`transcribe threw: ${err.message}${err.detail ? ' — ' + err.detail : ''}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
if (!has('--skip-llm')) {
  console.log('LLM — the brain');
  const st = llmStatus();
  if (!st.ready.length) bad(`nothing in the chain [${st.chain}] has a key`);
  else {
    const t = performance.now();
    try {
      const out = await generate({
        json: true,
        system: 'You are a JSON API. Reply with exactly {"say":"<one short sentence>","end":false,"disposition":"qualifying"} and nothing else.',
        user: 'A prospect just said they want a three bedroom flat. Ask one qualifying question.',
      });
      if (out && typeof out.say === 'string' && out.say.trim()) {
        ok(`answered in ${ms(t)}`);
        console.log(`      say: ${out.say}`);
      } else {
        bad(`answered, but not in the contract shape: ${JSON.stringify(out).slice(0, 200)}`);
      }
    } catch (err) {
      // 429 is the one that has actually bitten: a brain out of quota is a
      // billing problem, and it looks exactly like a broken agent from a phone.
      const quota = err.code === 'quota_exceeded' || /\b429\b|quota/i.test(String(err.message));
      bad(`${quota ? 'OUT OF QUOTA' : 'generate threw'}: ${err.message}`);
    }
  }
  console.log('');
}

console.log(failed
  ? `\x1b[31m═══ ${failed} problem${failed > 1 ? 's' : ''} — the demo will show ${failed > 1 ? 'them' : 'it'} ═══\x1b[0m\n`
  : '\x1b[32m═══ all three legs are live ═══\x1b[0m\n');
process.exit(failed ? 1 : 0);
