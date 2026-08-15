// scripts/measure-latency.mjs
//
// Measure turn latency against whatever this environment is actually wired to,
// and print a number you can defend.
//
//   node --experimental-detect-module scripts/measure-latency.mjs --turns 30
//
// ── WHAT IT DOES, AND WHAT IT REFUSES TO DO ───────────────────────────────
// It drives the REAL bridge — the same code a call runs — with a scripted
// prospect, and times each turn from the moment the recogniser settles on a
// final transcript to the moment the first byte of her reply reaches the
// transport. Then it reports p50 and p95.
//
// It will not print a percentile it does not have. With fewer than 20 turns
// the output says "indicative", because a p95 over four turns is the
// second-slowest turn wearing a statistic's name.
//
// ── VENDORS ───────────────────────────────────────────────────────────────
// By default it uses STUB vendors with configurable delays, which measures the
// PIPELINE — the overhead this repository adds on top of whatever the vendors
// cost. That number is useful and reproducible anywhere, including CI.
//
// With --live it calls the real LLM and the real TTS through the same
// composition root the caller agent uses, so it measures what a prospect
// actually waits through. That needs SARVAM_API_KEY (and whatever else
// TTS_PROVIDER/LLM_PROVIDER name) and it costs money per turn.
//
//   --turns N     how many turns to drive          (default 30)
//   --live        use the real LLM and TTS
//   --lang X      te-IN | hi-IN | en-IN            (default en-IN)
//   --phone       measure the 8kHz mu-law phone leg rather than the browser
//   --json        emit the summary as JSON as well
//
// ── WHY THIS IS NOT A BENCHMARK OF THE VENDORS ────────────────────────────
// It measures ONE deployment from ONE machine on ONE network. Run it from the
// region the service runs in, or the number describes your broadband.

import { createBridge } from '../caller-agent/src/agent/bridge.js';
import { summarise, formatSummary } from '../shared/latency.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const TURNS = Number(arg('turns', 30));
const LIVE = Boolean(arg('live', false));
const LANG = String(arg('lang', 'en-IN'));
const PHONE = Boolean(arg('phone', false));
const AS_JSON = Boolean(arg('json', false));

const AUDIO = PHONE
  ? { encoding: 'mulaw', sampleRate: 8000 }
  : { encoding: 'linear16', sampleRate: 16000 };

// What a prospect says. Real qualification answers, in the language under
// test, because the reply length drives synthesis time and a one-word corpus
// would measure the wrong thing.
const PROSPECT = {
  'en-IN': [
    'I am looking for a three bedroom',
    'somewhere around two and a half crore',
    'for my own use, not investment',
    'in the next three or four months',
    'what is the price per square foot',
    'this weekend could work',
  ],
  'hi-IN': [
    'तीन बीएचके देख रहे हैं',
    'बजट ढाई करोड़ तक',
    'खुद रहने के लिए',
    'तीन चार महीने में',
    'इस वीकेंड ठीक रहेगा',
  ],
  'te-IN': [
    'త్రీ బీహెచ్‌కే చూస్తున్నాం',
    'రెండున్నర కోట్ల దాకా బడ్జెట్',
    'మేము ఉండటానికే',
    'మూడు నాలుగు నెలల్లో',
    'ఈ వీకెండ్ ఓకే',
  ],
};

const REPLIES = [
  'Got it. Are you looking to live in it, or to invest?',
  'Understood. What budget are you working with?',
  'Noted. Two BHK or three BHK?',
  'Right. Shall we set up a site visit this weekend?',
];

/** Stub vendors with delays drawn from what the repository has observed. */
function stubs() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Jittered so the percentiles have something to be percentiles OF. These
  // are not claims about the vendors — they are a placeholder shape, and the
  // point of the run is the pipeline overhead on top of them.
  const jitter = (base, spread) => base + Math.floor((Math.random() - 0.5) * spread);
  let i = 0;
  return {
    async think() {
      await wait(Math.max(1, jitter(Number(process.env.STUB_LLM_MS || 700), 240)));
      return { say: REPLIES[i++ % REPLIES.length], end: false, disposition: 'qualifying' };
    },
    async speak(text) {
      await wait(Math.max(1, jitter(Number(process.env.STUB_TTS_MS || 1020), 300)));
      const samples = Math.max(160, Math.round(text.length * 40));
      return Buffer.alloc(samples);
    },
  };
}

/** The real composition root — the same think/speak a call uses. */
async function live() {
  const { generate } = await import('../api/_lib/llm.js');
  const { synth } = await import('../api/_lib/tts.js');
  const { turnPrompt, TURN_DISPOSITIONS } = await import('../api/_lib/prompts.js');
  const { unwrapFor } = await import('../shared/wav.js');

  return {
    async think(history) {
      const { system, user } = turnPrompt(history, { lang: LANG, direction: 'outbound' });
      const out = await generate({ system, user, json: true });
      const say = typeof out?.say === 'string' ? out.say.trim() : '';
      if (!say) throw new Error('empty completion');
      return {
        say,
        end: out.end === true,
        disposition: TURN_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'qualifying',
      };
    },
    async speak(text, lang, format) {
      const codec = format?.encoding === 'mulaw' ? 'mulaw' : 'linear16';
      const rate = Number(format?.sampleRate) || AUDIO.sampleRate;
      const out = await synth({ text, lang, codec, sampleRate: rate });
      const buf = Buffer.from(out.audio, 'base64');
      return { audio: unwrapFor(buf, out.mime, { encoding: codec, sampleRate: rate }), provider: out.provider };
    },
  };
}

const vendors = LIVE ? await live() : stubs();

const samples = [];
let attempted = 0;
let sttEvents = null;

const bridge = createBridge({
  lang: LANG,
  direction: 'outbound',
  audio: AUDIO,
  onAudio() {},
  onEvent(e) { if (e.type === 'turn_timing') samples.push(e); },
  isOptOut: () => false,
  think: vendors.think,
  speak: vendors.speak,
  openSTT: (o) => {
    sttEvents = o.onEvent;
    return { send() {}, close() {} };
  },
});

const lines = PROSPECT[LANG] || PROSPECT['en-IN'];

console.log(
  `\ndriving ${TURNS} turns · ${LIVE ? 'LIVE vendors' : 'stub vendors'} · ${LANG}`
  + ` · ${AUDIO.sampleRate}Hz ${AUDIO.encoding}\n`,
);

for (let i = 0; i < TURNS; i++) {
  const said = lines[i % lines.length];
  attempted++;

  // An interim first, so time-from-speech-end has something to measure
  // against — the same sequence a real recogniser produces.
  sttEvents({ type: 'transcript', final: false, text: said.slice(0, Math.ceil(said.length / 2)) });
  await new Promise((r) => setTimeout(r, 40));

  const before = samples.length;
  sttEvents({ type: 'transcript', final: true, text: said });

  // Wait for this turn to complete rather than guessing at a delay.
  const deadline = Date.now() + 30000;
  while (samples.length === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (samples.length === before) console.log(`  turn ${i + 1}: produced NO audio`);
  else process.stdout.write(`\r  ${samples.length}/${TURNS} turns`);
}

bridge.end();
process.stdout.write('\n');

const sum = summarise(samples, attempted);
console.log(formatSummary(sum, { title: `TURN LATENCY · ${LIVE ? 'live' : 'stub'} · ${LANG}` }));

// The sentence somebody would actually put in a document, written for them so
// it cannot drift from the run that produced it.
if (sum.ttfa) {
  const scope = LIVE ? 'end to end, real vendors' : 'pipeline overhead only, stub vendors';
  console.log(
    `  Quotable: time-to-first-audio p50 ${Math.round(sum.ttfa.p50)}ms, `
    + `p95 ${Math.round(sum.ttfa.p95)}ms over ${sum.ttfa.n} turns (${scope}).`,
  );
  if (sum.confidence === 'indicative') {
    console.log('  — but run at least 20 turns before quoting a p95 anywhere.');
  }
  if (!LIVE) {
    console.log('  — this does NOT include real vendor time. Re-run with --live for that.');
  }
  console.log('');
}

if (AS_JSON) console.log(JSON.stringify(sum, null, 2));

process.exit(sum.turns.measured === 0 ? 1 : 0);
