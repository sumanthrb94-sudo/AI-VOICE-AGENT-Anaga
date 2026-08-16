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
//   --bare        DIAGNOSTIC: replace the system prompt with a minimal one, to
//                 find out how much of first-clause latency is prefill. Strips
//                 every compliance rule. Never a deployment mode.
//
// ── WHY THIS IS NOT A BENCHMARK OF THE VENDORS ────────────────────────────
// It measures ONE deployment from ONE machine on ONE network. Run it from the
// region the service runs in, or the number describes your broadband.

import { createBridge } from '../caller-agent/src/agent/bridge.js';
import { summarise, formatSummary, percentile } from '../shared/latency.js';

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
// A DIAGNOSTIC, not a mode. See think() below: it answers whether
// first-clause latency is prefill or a fixed vendor cost, and it strips every
// compliance rule to do it, so it must never be how anything is deployed.
const BARE = Boolean(arg('bare', false));

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
    async think(history, opts) {
      let { system, user } = turnPrompt(history, { lang: LANG, direction: 'outbound' });
      // ── --bare, A DIAGNOSTIC AND NOT A MODE ────────────────────────────
      // first-clause is 1005ms p50 and the real system prompt is 6065
      // characters, about 1700 tokens. Two very different things produce that
      // number and they are indistinguishable from outside: PREFILL, which
      // scales with the prompt, or a fixed time-to-first-token at the vendor,
      // which does not.
      //
      // This replaces the prompt with the smallest thing that still yields the
      // same JSON shape, purely to find the floor. If first-clause barely
      // moves, the prompt is not the cost and the compliance rules stay
      // exactly as they are — which is the outcome to hope for, because those
      // rules are the disclosure wording, the opt-out triggers and "humans
      // close", and trading any of them for milliseconds is a bad trade.
      //
      // NEVER ship this. It is not a faster Anaga, it is a different one with
      // none of her obligations.
      if (BARE) {
        system = 'You are a polite Indian real-estate voice agent. Reply with JSON: '
          + '{"say": "<one short sentence, in the caller\'s language>", "end": false, '
          + '"disposition": "qualifying"}. "say" MUST be the first key.';
      }
      // Passed through, or this harness would measure a pipeline the service
      // does not run — the most flattering kind of wrong measurement is the
      // one that measures a SLOWER path than production, but a measurement of
      // a different path is useless in either direction.
      const out = await generate({ system, user, json: true, onFirstClause: opts?.onFirstClause });
      const say = typeof out?.say === 'string' ? out.say.trim() : '';
      if (!say) throw new Error('empty completion');
      return {
        say,
        end: out.end === true,
        disposition: TURN_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'qualifying',
      };
    },
    // ⚠ THIS MUST MIRROR caller-agent/src/agent/main.js EXACTLY.
    //
    // It is a copy of the composition root, and a copy drifts. It has now done
    // so twice in the same way: a wrapper that omitted `opts` silently dropped
    // onChunk, so the harness measured BUFFERED synthesis while the service
    // streamed — reporting a slower pipeline than the one that ships, which is
    // the flattering direction to be wrong in only if you never notice.
    //
    // server.js had the identical bug in the other direction, where it made a
    // real call slower than the measurement. Both are the same mistake: an
    // argument list written out by hand rather than passed through.
    async speak(text, lang, format, opts) {
      const codec = format?.encoding === 'mulaw' ? 'mulaw' : 'linear16';
      const rate = Number(format?.sampleRate) || AUDIO.sampleRate;
      const out = await synth({
        text, lang, codec, sampleRate: rate,
        onChunk: typeof opts?.onChunk === 'function' ? opts.onChunk : undefined,
      });
      const buf = Buffer.from(out.audio, 'base64');
      return {
        audio: unwrapFor(buf, out.mime, { encoding: codec, sampleRate: rate }),
        provider: out.provider,
        streamed: out.streamed === true,
      };
    },
  };
}

const vendors = LIVE ? await live() : stubs();

// ── WHY A TURN WAS SILENT ───────────────────────────────────────────────────
// The bridge catches vendor errors on purpose: one failed phrase must not take
// down a live call. The cost is that this harness saw only the SYMPTOM —
// "produced NO audio", twelve times in a row, with no way to tell a rate limit
// from a timeout from a rejected codec. Three different problems, one message,
// and the run that is supposed to diagnose latency could not diagnose itself.
//
// So the reasons are recorded on the way past and re-thrown unchanged. The
// bridge behaves exactly as it did; the harness stops being blind.
const failures = [];
function watched(fn, stage) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      failures.push({ turn: attempted, stage, message: String(err?.message || err) });
      throw err;
    }
  };
}
vendors.think = watched(vendors.think, 'think');
vendors.speak = watched(vendors.speak, 'speak');

const samples = [];
let attempted = 0;
let sttEvents = null;

// ── A CALL ENDS. THE MEASUREMENT DOES NOT ───────────────────────────────────
// Anaga qualifies the lead, books the visit, and returns end:true — at which
// point finish() sets `ended` and every later transcript is correctly ignored.
// This harness kept pushing transcripts into a finished call and reported the
// resulting silence as ten failed turns, identically, every run.
//
// That looked like a rate limit (a run of failures after a run of successes)
// and then like a stall (no vendor error, nothing to report). It was neither:
// it was the product working and the measurement not knowing what "the call
// is over" looks like. Exactly ten every time was the clue — a vendor limit
// does not land on the same turn twice.
//
// So a finished call starts a new one. 20 turns of measurement across however
// many calls it takes, which is also closer to what a day of dialling is.
let ended = false;
let calls = 0;
const clauseMs = [];
let bridge = null;

function startCall() {
  ended = false;
  calls++;
  bridge = createBridge({
    lang: LANG,
    direction: 'outbound',
    audio: AUDIO,
    onAudio() {},
    onEvent(e) {
      if (e.type === 'turn_timing') samples.push(e);
      if (e.type === 'ended') ended = true;
      // The moment the model has written enough to START SPEAKING, which is
      // the only part of `think` on the critical path. Without it, `think`
      // p50 answers a question nobody is waiting on — the back half of the
      // generation happens while she is already talking.
      if (e.type === 'first_clause' && typeof e.ms === 'number') clauseMs.push(e.ms);
    },
    isOptOut: () => false,
    think: vendors.think,
    speak: vendors.speak,
    openSTT: (o) => {
      sttEvents = o.onEvent;
      return { send() {}, close() {} };
    },
  });
}
startCall();

const lines = PROSPECT[LANG] || PROSPECT['en-IN'];

console.log(
  `\ndriving ${TURNS} turns · ${LIVE ? 'LIVE vendors' : 'stub vendors'} · ${LANG}`
  + ` · ${AUDIO.sampleRate}Hz ${AUDIO.encoding}`
  + (BARE ? '\n  ⚠ --bare: MINIMAL PROMPT, no compliance rules. A diagnostic number only.' : '')
  + '\n',
);

let line = 0;
for (let i = 0; i < TURNS; i++) {
  // She has hung up. Dial again rather than talking to a call that is over.
  if (ended) {
    bridge.end();
    startCall();
    line = 0;                      // a fresh call starts from the top of the script
    console.log(`\n  — she ended the call; starting call ${calls}`);
  }
  const said = lines[line++ % lines.length];
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
  if (samples.length === before) {
    const why = failures.filter((f) => f.turn === attempted);
    console.log(why.length
      ? `  turn ${i + 1}: NO audio — ${why.map((f) => `${f.stage}: ${f.message}`).join('; ')}`
      : ended
        ? `  turn ${i + 1}: NO audio — she ended the call on this turn (not a failure)`
        : `  turn ${i + 1}: NO audio — no vendor error; the turn never completed `
          + `(timed out after 30s, or the reply was empty)`);
  } else process.stdout.write(`\r  ${samples.length}/${TURNS} turns`);
}

bridge.end();
process.stdout.write('\n');

const sum = summarise(samples, attempted);
console.log(formatSummary(sum, { title: `TURN LATENCY · ${LIVE ? 'live' : 'stub'} · ${LANG}` }));
if (clauseMs.length) {
  // Printed next to `think` so the split is unmissable: this is what gates
  // her first word, and the difference between the two is what overlapping
  // bought. Attack this number, not the other one.
  const p = (q) => `${Math.round(percentile(clauseMs, q))}ms`;
  console.log(`  first clause ready       ${p(50).padStart(6)}   ${p(95).padStart(6)}`
    + `   ${String(Math.round(Math.min(...clauseMs))).padStart(4)}ms   `
    + `${String(Math.round(Math.max(...clauseMs))).padStart(4)}ms  n=${clauseMs.length}`);
  console.log('    …the rest of `think` above runs while she is already speaking\n');
}
if (calls > 1) {
  console.log(`  spread over ${calls} calls — she ends one when the lead is qualified\n`);
}

// ── WHAT WENT WRONG, GROUPED ───────────────────────────────────────────────
// A silence rate is not a footnote next to a latency number, it is the more
// important of the two: a p50 of 3.6s on 40% of turns is not a 3.6s agent.
// Grouped by message so twelve instances of one rate limit read as one
// problem rather than twelve, and printed BEFORE the quotable line so nobody
// copies a number out of a run that mostly failed.
if (failures.length) {
  const byMessage = new Map();
  for (const f of failures) {
    const k = `${f.stage}: ${f.message}`;
    byMessage.set(k, (byMessage.get(k) || 0) + 1);
  }
  console.log('  WHY TURNS FAILED\n');
  for (const [msg, n] of [...byMessage].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)} ×  ${msg}`);
  }
  console.log('');
  const rate = failures.some((f) => /429|rate.?limit|quota|too many/i.test(f.message));
  const slow = failures.some((f) => /timeout|abort/i.test(f.message));
  if (rate) {
    console.log('    A rate limit is not a latency result. Re-run with fewer turns,');
    console.log('    or spaced out, before reading anything into the numbers above.\n');
  } else if (slow) {
    console.log('    Timeouts inflate nothing and hide everything: the slowest turns');
    console.log('    are the ones missing from the percentiles, so the p95 is optimistic.\n');
  }
}

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

// The failures ride along in --json too. A run piped into a file or a CI step
// that reports only the percentiles is reporting the turns that SUCCEEDED,
// which is the most flattering possible sample and never says so.
if (AS_JSON) {
  const firstClause = clauseMs.length
    ? { n: clauseMs.length, min: Math.round(Math.min(...clauseMs)),
        p50: Math.round(percentile(clauseMs, 50)), p95: Math.round(percentile(clauseMs, 95)),
        max: Math.round(Math.max(...clauseMs)) }
    : null;
  console.log(JSON.stringify({ ...sum, firstClause, calls, failures }, null, 2));
}

process.exit(sum.turns.measured === 0 ? 1 : 0);
