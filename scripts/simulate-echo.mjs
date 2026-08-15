// scripts/simulate-echo.mjs
//
// SIMULATION: the agent hears itself.
//
// On a real phone line, some of what you transmit comes back on the receive
// path. Sources, all of which exist on Indian PSTN/VoIP routes:
//
//   - hybrid (line) echo from 2-wire/4-wire conversion at the local loop
//   - acoustic echo when the callee is on speakerphone
//   - VoIP loopback on a badly configured SBC or media bridge
//
// Providers run echo cancellation, but it is imperfect — typical echo return
// loss leaves the reflection attenuated, not absent, and AEC degrades badly
// when the far end changes level mid-call.
//
// What happens to a naive agent:
//
//   agent speaks ──► line ──► echo returns ──► STT transcribes the agent's OWN
//   words as the prospect ──► brain answers them ──► agent speaks ──► ...
//
// The call never ends, the transcript is nonsense, and every "prospect turn" is
// billed LLM + STT. Worse for this product specifically: an agent talking to
// itself cannot hear a real opt-out underneath the loop.
//
// This script runs the REAL media transport and the REAL session against a
// simulated line with a configurable echo path, and reports whether the loop
// occurs.
//
// Run: node --experimental-detect-module scripts/simulate-echo.mjs

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

/** Same asymmetric word-overlap the production guard uses. */
function overlap(candidate, reference) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const c = norm(candidate).split(' ').filter((w) => w.length > 2);
  if (!c.length) return 0;
  const ref = new Set(norm(reference).split(' ').filter((w) => w.length > 2));
  if (!ref.size) return 0;
  return c.filter((w) => ref.has(w)).length / c.length;
}
const { createMediaTransport } = await import(`${ROOT}/caller-agent/src/media/transport.js`);
const { runCall } = await import(`${ROOT}/caller-agent/src/session.js`);

// ---------------------------------------------------------------------------
// a simulated phone line with an echo path
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {number} opts.echoDelayMs      round-trip delay before our audio returns
 * @param {number} opts.echoGain         0 = perfect cancellation, 1 = full loopback
 * @param {string[]} opts.prospectSays   what the human ACTUALLY says (often nothing)
 */
function createEchoLine({ echoDelayMs = 120, echoGain = 0.6, prospectSays = [] } = {}) {
  let clock = 0;
  const transmitted = [];      // what the agent sent
  const inbound = [];          // what arrives on the receive path
  let pendingEcho = [];        // frames in flight down the echo path

  return {
    now: () => clock,
    advance(ms) { clock += ms; this.deliverEcho(); },

    /** The transport's audioOut sink — also feeds the echo path. */
    audioOut(frame) {
      transmitted.push({ at: clock, frame });
      if (echoGain > 0) {
        // The reflection arrives later and attenuated. We model attenuation as
        // "does it survive the provider's AEC", not as sample-level gain.
        pendingEcho.push({ arrivesAt: clock + echoDelayMs, frame });
      }
    },

    /** Move any echo whose delay has elapsed onto the receive path. */
    deliverEcho() {
      const due = pendingEcho.filter((e) => e.arrivesAt <= clock);
      pendingEcho = pendingEcho.filter((e) => e.arrivesAt > clock);
      for (const e of due) inbound.push({ at: clock, frame: e.frame, isEcho: true });
      return due;
    },

    prospectSpeak(text) { inbound.push({ at: clock, frame: Buffer.from(text, 'utf8'), isEcho: false }); },
    drainInbound() { const out = inbound.splice(0); return out; },
    transmitted: () => transmitted.map((t) => t.frame.toString('utf8')),
    prospectSays,
  };
}

// ---------------------------------------------------------------------------
// harness: wire the line to the real transport and pump it
// ---------------------------------------------------------------------------
async function runSimulation({ label, echoGain, echoDelayMs = 120, prospectSays = [], maxMs = 30000 }) {
  const line = createEchoLine({ echoDelayMs, echoGain, prospectSays });

  const transport = createMediaTransport({
    stt: {
      // Mock STT: the "audio" carries its own text. Faithful to the real
      // failure — a real STT transcribes echoed speech just as happily.
      async transcribe(chunks) {
        return chunks.map((c) => c.toString('utf8')).join(' ').replace(/\s+/g, ' ').trim();
      },
    },
    tts: {
      async synth(text) { return { frames: [Buffer.from(text, 'utf8')] }; },
    },
    audioOut: (f) => line.audioOut(f),
    now: line.now,
    silenceMs: 400,
    frameMs: 10,
    sleep: async (ms) => { line.advance(ms); },
  });

  // Pump: advance the clock, deliver echo, feed the transport.
  // It must outlive the call, or the session waits on a listen() that nothing
  // can ever resolve because the simulated clock stopped moving. When the line
  // clock runs out we close the transport, which ends the call cleanly.
  let stopped = false;
  const pump = (async () => {
    let spoken = 0;
    let iterations = 0;
    while (!stopped && iterations++ < 100000) {
      line.advance(20);
      for (const item of line.drainInbound()) {
        transport.pushAudio(item.frame, { hasVoice: true });
      }
      // The real human speaks on a slow schedule, if at all.
      if (prospectSays[spoken] && line.now() > (spoken + 1) * 6000) {
        line.prospectSpeak(prospectSays[spoken++]);
      }
      transport.tick();
      if (line.now() >= maxMs) { transport.close('sim_time_limit'); break; }
      await new Promise((r) => setImmediate(r));
    }
  })();

  const telephony = {
    async dial() { return { answered: true, reason: null, callId: 'sim' }; },
    say: (t) => transport.say(t),
    listen: () => transport.listen(),
    async hangup(r) { transport.close(r); return { ended: r }; },
  };

  let brainCalls = 0;
  const brain = {
    async nextTurn(history) {
      brainCalls++;
      const last = history.filter((h) => h.role === 'user').at(-1);
      return {
        say: `I hear you said "${String(last?.text || '').slice(0, 30)}". Tell me more?`,
        end: false,
        disposition: 'qualifying',
      };
    },
    async reportOutcome() { return { ok: true }; },
  };

  const persona = {
    disclosure: { 'en-IN': 'Hi, I am Anaga, an AI voice assistant from Modcon Builders. Is now a good time?' },
  };

  const result = await runCall({
    job: { callId: 'sim', lead: { phone: '+919876543210' }, agent: { lang: 'en-IN' } },
    telephony, brain, persona, now: line.now,
  });
  stopped = true;
  await pump;

  // --- analysis ----------------------------------------------------------
  const agentTurns = result.history.filter((h) => h.role === 'agent').map((h) => h.text);
  const userTurns = result.history.filter((h) => h.role === 'user').map((h) => h.text);

  // A user turn is self-echo only if it matches something the agent said
  // EARLIER. Comparing against the whole transcript misfired: the brain quotes
  // the prospect back ("I hear you said \"Yes I have a minute\""), so genuine
  // prospect turns looked like echo. Order matters — echo can only follow.
  const selfEchoTurns = result.history.filter((turn, i) => {
    if (turn.role !== 'user') return false;
    return result.history.slice(0, i).some((prior) =>
      prior.role === 'agent' && overlap(turn.text, prior.text) >= 0.55);
  }).map((t) => t.text);

  const realProspectTurns = userTurns.filter((u) => prospectSays.some((p) => u.includes(p.slice(0, 15))));

  return {
    label,
    echoGain,
    turns: result.turns,
    endReason: result.endReason,
    brainCalls,
    userTurns,
    selfEcho: selfEchoTurns.length,
    realHeard: realProspectTurns.length,
    expectedReal: prospectSays.length,
  };
}

function report(r) {
  const loop = r.selfEcho > 0;
  console.log(`\n── ${r.label} (echoGain=${r.echoGain}) ─────────────────────`);
  console.log(`   turns exchanged     : ${r.turns}`);
  console.log(`   end reason          : ${r.endReason}`);
  console.log(`   LLM calls billed    : ${r.brainCalls}`);
  console.log(`   SELF-ECHO turns     : ${r.selfEcho}   ${loop ? '← the agent answered ITSELF' : '✓ none'}`);
  console.log(`   real prospect heard : ${r.realHeard}/${r.expectedReal}`);
  if (r.userTurns.length) {
    console.log('   what it "heard":');
    for (const u of r.userTurns.slice(0, 5)) console.log(`     • "${u.slice(0, 72)}"`);
  }
  return loop;
}

// ---------------------------------------------------------------------------
console.log('\n═══ ECHO SIMULATION — does the agent talk to itself? ═══');

const clean = await runSimulation({
  label: 'A. clean line (provider AEC working)',
  echoGain: 0,
  prospectSays: ['Yes I have a minute', 'Looking for a 3BHK'],
});
const cleanLoop = report(clean);

const echoey = await runSimulation({
  label: 'B. echo on the line (imperfect AEC)',
  echoGain: 0.6,
  echoDelayMs: 120,
  prospectSays: ['Yes I have a minute'],
});
const echoLoop = report(echoey);

const silentWithEcho = await runSimulation({
  label: 'C. echo + SILENT prospect (worst case)',
  echoGain: 0.8,
  echoDelayMs: 80,
  prospectSays: [],           // the human says NOTHING — every turn is self-echo
});
const silentLoop = report(silentWithEcho);

console.log('\n═══ VERDICT ═══');
console.log(`  clean line              : ${cleanLoop ? 'LOOPED ✗' : 'no self-echo ✓'}`);
console.log(`  echoey line             : ${echoLoop ? 'LOOPED ✗' : 'no self-echo ✓'}`);
console.log(`  echo + silent prospect  : ${silentLoop ? 'LOOPED ✗' : 'no self-echo ✓'}`);

if (echoLoop || silentLoop) {
  console.log('\n  ⚠ The agent transcribes and answers its own speech.');
  console.log('    On a real call this burns LLM + STT per fake turn, produces a');
  console.log('    nonsense transcript, and can bury a genuine opt-out under the loop.');
  process.exitCode = 2;   // 2 = bug reproduced (not a test failure)
} else {
  console.log('\n  ✓ No self-echo loop under any simulated line condition.');
}
