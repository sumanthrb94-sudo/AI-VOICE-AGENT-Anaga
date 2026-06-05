/* ===================================================================
   Vaak AI — Mission Control · app logic
   Renders the agent fleet, the metrics, and drives the Playbook overlay.
   =================================================================== */

/* ---------------- agent fleet (from MULTI_AGENT_SPEC.md) ---------------- */
const FLEET = [
  { wp: "WP-0", badge: ["base", "Foundation"], name: "Compliance foundation & repo bootstrap", desc: "Legal-to-dial + clean repo skeleton, CI, registration tracker.", dep: "none" },
  { wp: "WP-1", badge: ["base", "Spike"], name: "Framework decision (ADR)", desc: "Pipecat vs self-hosted Bolna — decided by one real Sarvam+LLM+Plivo call each.", dep: "WP-0" },
  { wp: "WP-2", badge: ["base", "Orchestrator"], name: "Orchestrator", desc: "Spawn/track caller agents, balance load, warm human handoff.", dep: "WP-1" },
  { wp: "WP-3", badge: ["core", "The soul"], name: "Anaga — caller-agent pipeline", desc: "Anaga's voice: streaming STT→LLM→TTS, female Sarvam voice, turn-taking, barge-in, code-mixed calls. Over-invest here.", dep: "WP-1" },
  { wp: "WP-4", badge: ["base", "Adapters"], name: "Provider abstraction", desc: "Swap STT/LLM/TTS/telephony via config. No vendor SDK in business logic.", dep: "WP-1" },
  { wp: "WP-5", badge: ["moat", "The moat"], name: "Compliance agent", desc: "DND scrub, disclosure, opt-out, retention, audit log. Fails closed.", dep: "WP-0, WP-2" },
  { wp: "WP-6", badge: ["base", "Backend"], name: "Backend (.NET) + tools", desc: "book_site_visit, book_callback, send_whatsapp, CRM, calendar, suppression.", dep: "WP-0" },
  { wp: "WP-7", badge: ["core", "Flywheel"], name: "Eval / analytics agent", desc: "LLM-as-judge scoring + human sample; gates every prompt change.", dep: "WP-3, WP-6" },
  { wp: "WP-8", badge: ["base", "Console"], name: "Client dashboard", desc: "Campaign upload → scrubbed → queued; live results, recordings, scores.", dep: "WP-2, WP-6" },
  { wp: "WP-9", badge: ["base", "Ops"], name: "Infra, CI/CD, observability", desc: "Docker + k8s autoscale, OpenTelemetry, secrets, Indian-region recordings.", dep: "WP-0" }
];

/* ---------------- production-grade metrics (§5) ---------------- */
const METRICS = [
  { num: "100", u: "+ calls", label: "Concurrent, no quality degradation (load-tested)" },
  { num: "<500", u: "ms", label: "Time-to-first-audio, p50 (p95 < 900ms)" },
  { num: "3", u: "languages", label: "Code-mixed Telugu / Hindi / English, first-class" },
  { num: "90", u: "days", label: "Recording retention on Indian infra, access-controlled" },
  { num: "0", u: "secrets", label: "Zero secrets in code; SOC2-direction controls" },
  { num: "1", u: "command", label: "Deploy + autoscale + full observability" }
];

/* ---------------- render fleet ---------------- */
const fleetGrid = document.getElementById("fleet-grid");
fleetGrid.innerHTML = FLEET.map(a => `
  <article class="agent-card">
    <div class="agent-card__top">
      <span class="agent-card__wp">${a.wp}</span>
      <span class="agent-card__badge badge--${a.badge[0]}">${a.badge[1]}</span>
    </div>
    <h3>${a.name}</h3>
    <p>${a.desc}</p>
    <div class="agent-card__dep"><b>Depends on:</b> ${a.dep}</div>
  </article>
`).join("");

/* ---------------- render metrics ---------------- */
const metricsGrid = document.getElementById("metrics-grid");
metricsGrid.innerHTML = METRICS.map(m => `
  <div class="metric">
    <div class="metric__num">${m.num}<span class="u"> ${m.u}</span></div>
    <div class="metric__label">${m.label}</div>
  </div>
`).join("");

/* ===================================================================
   PLAYBOOK OVERLAY
   =================================================================== */
const PB = window.PLAYBOOK;
const overlay   = document.getElementById("playbook");
const tabsEl    = document.getElementById("playbook-tabs");
const bodyEl    = document.getElementById("playbook-body");
const railFill  = document.getElementById("rail-fill");
const openBtn   = document.getElementById("open-playbook");
let current = 0;
let lastFocus = null;

/* tabs */
tabsEl.innerHTML = PB.map((ph, i) => `
  <button class="ptab" data-i="${i}">
    <span class="ptab__idx">${i}</span>
    <span>${ph.tab}<span class="ptab__sub">${ph.sub}</span></span>
  </button>
`).join("");

function renderPhase(i) {
  current = i;
  const ph = PB[i];

  /* tabs active state */
  [...tabsEl.children].forEach((t, k) => t.classList.toggle("is-active", k === i));

  /* progress rail */
  railFill.style.width = `${((i + 1) / PB.length) * 100}%`;

  /* body */
  bodyEl.innerHTML = `
    <div class="phase__intro">
      <div class="goal">${ph.goal}</div>
      <div class="why">${ph.why}</div>
      <div class="meta">
        ${ph.meta.map(m => `<span><b>${m[0]}:</b> ${m[1]}</span>`).join("")}
      </div>
    </div>
    ${ph.steps.map((s, n) => `
      <div class="step">
        <span class="step__n">${n + 1}</span>
        <h4>${s.h}</h4>
        <p>${s.p}</p>
        ${s.list ? `<ul>${s.list.map(li => `<li>${li}</li>`).join("")}</ul>` : ""}
        <div>${(s.tags || []).map(t => `<span class="step__tag ${t[1]}">${t[0]}</span>`).join("")}</div>
      </div>
    `).join("")}
    <div class="phase__nav">
      <button class="prev" ${i === 0 ? "disabled" : ""}>← ${i === 0 ? "Start" : PB[i - 1].tab}</button>
      <button class="next" ${i === PB.length - 1 ? "disabled" : ""}>${i === PB.length - 1 ? "You're at the finish line 🏁" : PB[i + 1].tab + " →"}</button>
    </div>
  `;

  bodyEl.scrollTop = 0;
  const prev = bodyEl.querySelector(".prev");
  const next = bodyEl.querySelector(".next");
  if (prev && i > 0) prev.onclick = () => renderPhase(i - 1);
  if (next && i < PB.length - 1) next.onclick = () => renderPhase(i + 1);
}

/* open / close */
function openPlaybook() {
  lastFocus = document.activeElement;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  renderPhase(0);
  overlay.querySelector(".playbook__close").focus();
}
function closePlaybook() {
  overlay.hidden = true;
  document.body.style.overflow = "";
  if (lastFocus) lastFocus.focus();
}

openBtn.addEventListener("click", openPlaybook);
tabsEl.addEventListener("click", e => {
  const t = e.target.closest(".ptab");
  if (t) renderPhase(+t.dataset.i);
});
overlay.addEventListener("click", e => { if (e.target.matches("[data-close]")) closePlaybook(); });
document.addEventListener("keydown", e => {
  if (overlay.hidden) return;
  if (e.key === "Escape") closePlaybook();
  if (e.key === "ArrowRight" && current < PB.length - 1) renderPhase(current + 1);
  if (e.key === "ArrowLeft" && current > 0) renderPhase(current - 1);
});

/* deep-link: open with #playbook */
if (location.hash === "#playbook") openPlaybook();

/* ===================================================================
   VOICE — shared female-voice synthesis (Web Speech API), used by both
   the "Hear Anaga" sample and the live Call demo. No keys, no backend.
   Sample lines mirror caller-agent/flows/anaga.persona.json.
   =================================================================== */
const ANAGA_LINES = {
  "en-IN": "Hi, I'm Anaga, an AI voice assistant from Vaak. Is now a good time to talk for a couple of minutes?",
  "hi-IN": "नमस्ते, मैं अनघा हूँ, वाक की एक ए आई वॉइस असिस्टेंट। क्या मैं आपसे दो मिनट बात कर सकती हूँ?",
  "te-IN": "నమస్కారం, నేను అనగా, వాక్ నుండి ఒక ఏఐ వాయిస్ అసిస్టెంట్. మీకు కొన్ని నిమిషాలు ఉంటే మాట్లాడొచ్చా?"
};
const FEMALE_HINTS = [
  "female", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "veena",
  "zira", "susan", "linda", "heera", "kalpana", "swara", "aditi", "raveena",
  "google हिन्दी", "google తెలుగు", "google uk english female", "google us english"
];

const synth = window.speechSynthesis;
let voices = [];
function loadVoices() { voices = (synth && synth.getVoices()) || []; }
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

function pickVoice(lang) {
  const base = lang.split("-")[0];
  const byLang = voices.filter(v => v.lang && (v.lang === lang || v.lang.replace("_", "-").startsWith(base)));
  const isFemale = v => FEMALE_HINTS.some(h => v.name.toLowerCase().includes(h));
  return (
    byLang.find(isFemale) || byLang[0] ||
    voices.filter(v => v.lang && v.lang.startsWith("en")).find(isFemale) ||
    voices.find(isFemale) || null
  );
}

/* speakText(text, lang, { onstart, onend }) -> returns chosen voice (or null) */
function speakText(text, lang, opts = {}) {
  if (!synth) { opts.onend && opts.onend(); return null; }
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.lang = (v && v.lang) || lang;
  u.pitch = 1.08;
  u.rate = 0.97;
  if (opts.onstart) u.onstart = opts.onstart;
  u.onend = () => opts.onend && opts.onend();
  u.onerror = () => opts.onend && opts.onend();
  synth.cancel();
  synth.speak(u);
  return v;
}

let curLang = "en-IN"; // controlled by the language pills (sample); call demo runs in en-IN

/* language pills (shared) */
const demoEl = document.getElementById("voice-demo");
if (demoEl) {
  demoEl.querySelectorAll(".lang-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      demoEl.querySelectorAll(".lang-pill").forEach(p => p.classList.remove("is-active"));
      pill.classList.add("is-active");
      curLang = pill.dataset.lang;
    });
  });
}

/* ---------------- Hear Anaga (one-shot sample) ---------------- */
(function hearAnaga() {
  const hearBtn   = document.getElementById("hear-anaga");
  const voiceNote = document.getElementById("voice-note");
  const chipEl    = document.querySelector(".agent-chip");
  if (!hearBtn) return;
  if (!synth) {
    hearBtn.disabled = true;
    if (voiceNote) voiceNote.textContent = "Your browser doesn't support in-browser speech. Try Chrome or Edge.";
    return;
  }
  let speaking = false;
  const setSpeaking = on => {
    speaking = on;
    hearBtn.setAttribute("aria-pressed", String(on));
    hearBtn.classList.toggle("is-speaking", on);
    if (chipEl) chipEl.classList.toggle("is-speaking", on);
    hearBtn.querySelector(".btn--hear__ico").textContent = on ? "■" : "▶";
    hearBtn.querySelector(".btn--hear__label").textContent = on ? "Stop" : "Hear Anaga";
  };
  const play = () => {
    const v = speakText(ANAGA_LINES[curLang] || ANAGA_LINES["en-IN"], curLang, { onend: () => setSpeaking(false) });
    setSpeaking(true);
    if (v) voiceNote.textContent = `Voice: ${v.name}${/female/i.test(v.name) ? "" : " (best female match on your system)"}.`;
    else   voiceNote.textContent = "No regional voice installed — using your default voice.";
  };
  hearBtn.addEventListener("click", () => {
    if (speaking) { synth.cancel(); setSpeaking(false); return; }
    play();
  });
  window.addEventListener("beforeunload", () => synth.cancel());
})();

/* ===================================================================
   LIVE CALL DEMO — your mic → STT → dialogue engine → Anaga responds.
   A code-mixed-style real-estate qualification + booking flow that
   mirrors caller-agent/flows/real-estate-qualify.flow.json. The browser
   SpeechRecognition does STT; speakText() does TTS. Falls back to typing.
   =================================================================== */
(function callDemo() {
  const startBtn   = document.getElementById("start-call");
  const overlay    = document.getElementById("call");
  if (!startBtn || !overlay) return;

  const statusEl   = document.getElementById("call-status");
  const avatarEl   = document.getElementById("call-avatar");
  const transcript = document.getElementById("call-transcript");
  const micBtn     = document.getElementById("call-mic");
  const textForm   = document.getElementById("call-textform");
  const textInput  = document.getElementById("call-textinput");
  const brainEl    = document.getElementById("call-brain");
  const noticeEl   = document.getElementById("call-notice");
  const reviewEl   = document.getElementById("call-review");
  const endBtn     = document.getElementById("call-end");

  /* backend endpoints (relative — work behind the same origin / Vercel functions) */
  const TURN_URL    = "/api/anaga/turn";
  const SUMMARY_URL = "/api/anaga/summary";
  const CALL_LANG   = "en-IN";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recog = SR ? new SR() : null;
  if (recog) { recog.lang = "en-IN"; recog.interimResults = true; recog.maxAlternatives = 1; recog.continuous = false; }

  let ctx = {};
  let stepId = null;
  let listening = false;
  let processing = false;
  let active = false;
  let interimEl = null;

  /* full conversation transcript sent to the backend brain */
  let history = [];               // [{ role:"agent"|"user", text }]
  let lastDisposition = "qualifying";

  /* which brain decides the next turn:
     null = not yet detected, "live" = backend LLM, "offline" = on-device rule engine.
     Detect-once: after the first failed /turn we stay offline for the rest of the call. */
  let brainMode = null;
  let micAllowed = false;         // whether getUserMedia granted (affects copy only)

  /* ---- intent helpers ---- */
  const has = (t, re) => re.test(t);
  const affirmative = t => has(t, /\b(yes|yeah|yep|yup|sure|ok|okay|fine|haan|ha|please|go ahead|sounds good|why not|definitely|of course|alright|interested)\b/i);
  const negative    = t => has(t, /\b(no|nope|not now|busy|later|can'?t|cannot|don'?t|some other time|not really)\b/i);
  const optout      = t => has(t, /\b(not interested|do ?n'?t call|don'?t call|stop calling|remove me|unsubscribe|leave me alone|opt ?out|take me off|dnd)\b/i);
  const extractBudget = t => { const m = t.match(/(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|l)\b/i); return m ? `${m[1]} ${/c/i.test(m[2]) ? "crore" : "lakh"}` : null; };
  const extractBHK    = t => { const m = t.match(/(\d)\s*[- ]?\s*bhk/i); if (m) return `${m[1]}BHK`; if (/studio/i.test(t)) return "studio"; if (/villa|penthouse|duplex/i.test(t)) return t.match(/villa|penthouse|duplex/i)[0].toLowerCase(); return null; };

  /* ---- the flow (mirrors the versioned flow JSON) ---- */
  const FLOW = {
    greet: {
      say: () => "Namaste! This is Anaga, an A I assistant from Vaak, calling about the Skyline Villaments project in Hyderabad. Just so you know, I'm an AI voice agent. Do you have a quick minute to talk?",
      next: t => optout(t) ? "optout" : (negative(t) ? "busy" : "purpose")
    },
    purpose: {
      say: () => "Wonderful, thank you. Are you looking for a home to live in, or more as an investment?",
      next: (t) => { ctx.purpose = /invest/i.test(t) ? "an investment" : "your own use"; return "budget"; }
    },
    budget: {
      say: () => `Got it — for ${ctx.purpose}. And what budget range are you considering? For example, one to two crore, or higher?`,
      next: (t) => { ctx.budget = extractBudget(t) || "the range you mentioned"; return "config"; }
    },
    config: {
      say: () => `Noted, around ${ctx.budget}. Are you looking at a 2BHK, 3BHK, or something larger?`,
      next: (t) => { ctx.config = extractBHK(t) || "that configuration"; return "timeline"; }
    },
    timeline: {
      say: () => `A ${ctx.config}, perfect. Are you planning to buy in the next few months, or just exploring for now?`,
      next: (t) => { ctx.timeline = /month|soon|ready|immediat|next|asap|urgent/i.test(t) ? "soon" : "exploring"; return "offer"; }
    },
    offer: {
      say: () => `Thanks for sharing all that. Based on a ${ctx.config} for ${ctx.purpose}, I really think our Skyline Villaments would suit you. Could I book you a site visit this weekend?`,
      next: t => optout(t) ? "optout" : (affirmative(t) ? "book" : "callback")
    },
    book: {
      say: () => "Great! Would Saturday or Sunday work better for you?",
      next: (t) => { ctx.day = /sun/i.test(t) ? "Sunday" : (/sat/i.test(t) ? "Saturday" : "this weekend"); return "confirm"; }
    },
    confirm: {
      say: () => `Done! I've booked your site visit for ${ctx.day}. You'll get a WhatsApp confirmation with the location and a map shortly, and our sales manager will meet you there. Thank you so much for your time — have a wonderful day!`,
      end: true
    },
    callback: {
      say: () => "No problem at all. I'll have our sales manager send the project details on WhatsApp, and we can arrange a visit whenever you're ready. Thank you for your time!",
      end: true
    },
    busy: {
      say: () => "No worries at all — I'll try you another time. Thank you, and have a good day!",
      end: true
    },
    optout: {
      say: () => "I completely understand. I'm adding your number to our do-not-call list right now, so you won't receive any further calls. Apologies for the disturbance, and have a good day.",
      end: true, optout: true
    }
  };

  /* ---- UI helpers ---- */
  function setStatus(text, mode) {
    statusEl.textContent = text;
    avatarEl.classList.remove("is-speaking", "is-listening");
    if (mode) avatarEl.classList.add(mode);
  }
  function addBubble(who, text) {
    const b = document.createElement("div");
    b.className = `bubble bubble--${who}`;
    b.innerHTML = `<span class="bubble__who">${who === "anaga" ? "Anaga" : "You"}</span><span class="bubble__txt">${text}</span>`;
    transcript.appendChild(b);
    transcript.scrollTop = transcript.scrollHeight;
    return b;
  }
  function showInterim(text) {
    if (!interimEl) interimEl = addBubble("you", "");
    interimEl.classList.add("is-interim");
    interimEl.querySelector(".bubble__txt").textContent = text;
    transcript.scrollTop = transcript.scrollHeight;
  }
  function clearInterim() { if (interimEl) { interimEl.remove(); interimEl = null; } }

  /* subtle "which brain is active" tag in the call header */
  function setBrain(mode, src) {
    if (!brainEl) return;
    if (mode === "live") {
      brainEl.hidden = false;
      brainEl.className = "call__brain call__brain--live";
      brainEl.innerHTML = `<i class="dot"></i> live AI${src ? " · " + src : ""}`;
      brainEl.title = "Anaga's replies are generated live by Gemini" + (src ? " (" + src + ")." : ".");
    } else if (mode === "offline") {
      brainEl.hidden = false;
      brainEl.className = "call__brain call__brain--offline";
      brainEl.innerHTML = `<i class="dot"></i> offline script`;
      brainEl.title = "No backend reachable — running the on-device qualification script.";
    } else {
      brainEl.hidden = true;
      brainEl.textContent = "";
    }
  }

  /* inline notice (mic blocked, etc.) */
  function showNotice(text) {
    if (!noticeEl) return;
    noticeEl.textContent = text;
    noticeEl.hidden = false;
  }
  function clearNotice() { if (noticeEl) { noticeEl.hidden = true; noticeEl.textContent = ""; } }

  /* ---- speaking & listening ---- */
  /* speak a line and decide what to do when Anaga finishes.
     onDone(endInfo|null): endInfo = { reason, optout } when the call should end. */
  function speakLine(line, endInfo, onDone) {
    addBubble("anaga", line);
    history.push({ role: "agent", text: line });
    setMic(false);
    setStatus("Anaga is speaking…", "is-speaking");
    speakText(line, CALL_LANG, {
      onend: () => {
        if (endInfo) return finishCall(endInfo);
        if (onDone) onDone();
        else startListening();
      }
    });
  }

  /* offline path: speak a FLOW step (mirrors the versioned flow JSON) */
  function sayStep(id) {
    const step = FLOW[id];
    stepId = id;
    const line = step.say();
    const endInfo = step.end
      ? { reason: step.optout ? "Opt-out recorded · call ended" : "Call ended", optout: !!step.optout }
      : null;
    speakLine(line, endInfo);
  }

  function startListening() {
    if (!active) return;
    if (!recog) { setStatus("Your turn — type your reply below", null); return; }
    if (listening) return;
    processing = false;
    try { recog.start(); } catch (e) { /* already started */ }
  }

  function handleUtterance(text) {
    if (processing || !active) return;
    text = (text || "").trim();
    if (!text) { startListening(); return; }
    processing = true;
    clearInterim();
    addBubble("you", text);
    history.push({ role: "user", text });
    setStatus("Anaga is thinking…", null);

    /* Once we know the brain is offline, never hit the network again this call. */
    if (brainMode === "offline") { setTimeout(nextOfflineTurn, 350); return; }
    nextLiveTurn();
  }

  /* offline rule-engine turn (also the fallback used the moment the backend fails) */
  function nextOfflineTurn() {
    if (!active) return;
    const lastUser = [...history].reverse().find(m => m.role === "user");
    const said = lastUser ? lastUser.text : "";
    const step = FLOW[stepId] || FLOW.greet;
    const nextId = (step.next ? step.next(said, ctx) : null) || "callback";
    sayStep(nextId);
  }

  /* live backend turn: POST history → { say, end, disposition }.
     On any non-200 / throw we flip to the offline engine for the rest of the call. */
  /* fetch the next turn from the best available brain:
     your own Gemini key (BYOK, in-browser) → server /api → (caller handles offline). */
  function fetchTurn() {
    if (window.AnagaBrain && AnagaBrain.hasKey()) {
      return AnagaBrain.turn({ history }).then(d => ({ data: d, src: "your key" }));
    }
    return fetch(TURN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: CALL_LANG, history })
    }).then(res => {
      if (!res.ok) throw new Error("turn_unavailable_" + res.status);
      return res.json();
    }).then(d => ({ data: d, src: "server" }));
  }

  function nextLiveTurn() {
    fetchTurn()
      .then(({ data, src }) => {
        if (!active) return;
        if (brainMode !== "live") { brainMode = "live"; setBrain("live", src); }
        const line = (data && data.say) ? String(data.say) : "Sorry, could you say that again?";
        if (data && data.disposition) lastDisposition = data.disposition;
        const endInfo = (data && data.end)
          ? { reason: data.disposition === "opt-out" ? "Opt-out recorded · call ended" : "Call ended",
              optout: data.disposition === "opt-out" }
          : null;
        speakLine(line, endInfo);
      })
      .catch(() => {
        if (!active) return;
        /* detect-once: remember offline so we don't spam failed fetches every turn */
        if (brainMode !== "offline") { brainMode = "offline"; setBrain("offline"); }
        nextOfflineTurn();
      });
  }

  if (recog) {
    recog.onstart = () => { listening = true; setMic(true); setStatus("Listening… speak now", "is-listening"); };
    recog.onresult = e => {
      let interim = "", finalT = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalT += r[0].transcript; else interim += r[0].transcript;
      }
      if (interim) showInterim(interim);
      if (finalT) { try { recog.stop(); } catch (e) {} handleUtterance(finalT); }
    };
    recog.onerror = ev => {
      listening = false; setMic(false);
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        setStatus("Mic blocked — type your reply below", null);
      } else if (ev.error === "no-speech") {
        setStatus("Didn't catch that — tap the mic to try again", null);
      }
    };
    recog.onend = () => { listening = false; setMic(false); };
  }

  function setMic(on) {
    micBtn.classList.toggle("is-on", on);
    micBtn.setAttribute("aria-pressed", String(on));
    micBtn.querySelector(".call__mic-label").textContent = on ? "Listening… (tap to stop)" : "🎤 Tap to speak";
  }

  /* ---- microphone permission ---- */
  /* Explicitly request mic access BEFORE the dialogue. The mic only works in a
     secure context (HTTPS or http://localhost) — on file:// or plain http the
     browser hides navigator.mediaDevices, so we explain that instead of failing
     silently. On deny/unsupported we continue in text-only mode. Resolves boolean. */
  function requestMic() {
    const md = navigator.mediaDevices;
    const insecure = (typeof window.isSecureContext !== "undefined") && !window.isSecureContext;
    if (insecure || !md || !md.getUserMedia) {
      showNotice(insecure
        ? "🎤 The microphone needs a secure page — open this on your deployed https:// link (Vercel) or via http://localhost. On a file:// or plain http page browsers block the mic. You can still type your replies below."
        : "🎤 Microphone isn't available in this browser — use Chrome or Edge, or type your replies below.");
      return Promise.resolve(false);
    }
    setStatus("Requesting microphone…", null);
    return md.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop()); // we only needed the permission
        clearNotice();
        return true;
      })
      .catch(err => {
        showNotice(err && err.name === "NotAllowedError"
          ? "🎤 Microphone permission was blocked. Click the 🔒/🎤 icon in your browser's address bar, allow the mic, then start a new call. You can also type below."
          : "🎤 Couldn't access the microphone — you can type your replies below.");
        return false;
      });
  }

  /* enable/disable + label the mic button so its state is always visible */
  function configureMicButton(granted) {
    const label = micBtn.querySelector(".call__mic-label");
    if (recog && granted) {
      micBtn.disabled = false; micBtn.classList.remove("is-disabled");
      label.textContent = "🎤 Tap to speak";
    } else {
      micBtn.disabled = true; micBtn.classList.add("is-disabled");
      label.textContent = recog ? "🎤 Mic blocked — type below" : "🎤 Voice input unsupported — type below";
    }
  }

  /* ---- lifecycle ---- */
  function resetCall() {
    ctx = {}; stepId = null; processing = false;
    history = []; lastDisposition = "qualifying"; brainMode = null;
    transcript.innerHTML = "";
    if (reviewEl) { reviewEl.hidden = true; reviewEl.innerHTML = ""; }
    if (endBtn) endBtn.textContent = "✕ End call";
    micBtn.disabled = true;            // re-enabled by configureMicButton after the permission resolves
    micBtn.classList.remove("is-on");
    setBrain(null);
    clearNotice();
  }

  function startCall() {
    resetCall();
    active = true;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    setStatus("Connecting…", null);
    requestMic().then(granted => {
      if (!active) return;            // closed while the prompt was open
      micAllowed = granted;
      configureMicButton(granted);
      if (!recog) {
        addBubble("anaga", "(Speech recognition isn't available in this browser — you can type your replies. Chrome or Edge give the full voice experience.)");
      } else if (!granted) {
        addBubble("anaga", "(Microphone access wasn't granted — no problem, you can type your replies below.)");
      }
      setStatus("Connecting…", null);
      setTimeout(() => { if (active) sayStep("greet"); }, 450);
    });
  }

  /* endInfo: { reason, optout } | string (legacy) */
  function finishCall(endInfo) {
    const reason = typeof endInfo === "string" ? endInfo : (endInfo && endInfo.reason) || "Call ended";
    active = false; listening = false;
    if (recog) try { recog.abort(); } catch (e) {}
    synth && synth.cancel();
    setMic(false);
    setStatus(reason, null);
    if (endBtn) endBtn.textContent = "✕ Close";
    renderReview();
  }

  /* ===================================================================
     POST-CALL "CALL REVIEW" — summarize + internal comment.
     POST the full history to /api/anaga/summary. On 503 / throw (e.g. the
     static build with no backend) fall back to a local heuristic review so
     the card ALWAYS appears, labelled clearly. Reuses the dark theme.
     =================================================================== */
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  /* derive a sensible review from the captured context / transcript when the
     backend isn't reachable. booked → interested ~85; opt-out → not interested;
     otherwise scale by how far the lead got through qualification. */
  function localReview() {
    const userTurns = history.filter(m => m.role === "user").length;
    const joined = history.filter(m => m.role === "user").map(m => m.text).join("  ").toLowerCase();
    let disposition = lastDisposition;
    let interested, score, summary, nextAction, comment;

    /* normalize FLOW-engine dispositions into the contract's vocabulary */
    if (stepId === "confirm")       disposition = "booked";
    else if (stepId === "optout")   disposition = "opt-out";
    else if (stepId === "busy")     disposition = "busy";
    else if (stepId === "callback") disposition = "callback";

    if (disposition === "booked") {
      interested = true; score = 85;
      summary = `Lead engaged through qualification and booked a site visit${ctx.day ? " for " + ctx.day : ""}. Interested in a ${ctx.config || "home"} for ${ctx.purpose || "their use"}${ctx.budget ? " around " + ctx.budget : ""}.`;
      nextAction = "Sales manager to confirm the site visit on WhatsApp and prepare a tailored unit shortlist.";
      comment = "Hot lead — booked a site visit on the call. Treat as high priority and confirm promptly.";
    } else if (disposition === "opt-out" || /not interested|don'?t call|stop calling|remove me/.test(joined)) {
      disposition = "opt-out"; interested = false; score = 3;
      summary = "Lead asked not to be contacted. Number flagged for the do-not-call list.";
      nextAction = "Suppress the number — no further outreach. Compliance honored opt-out on the call.";
      comment = "Opt-out recorded. Do not contact again.";
    } else if (disposition === "busy" || userTurns <= 1) {
      disposition = "busy"; interested = false; score = 25;
      summary = "Lead was busy or ended early; qualification did not complete.";
      nextAction = "Retry at a better time, or send project details on WhatsApp first.";
      comment = "Reached but not qualified — try a callback at a more convenient time.";
    } else if (disposition === "callback") {
      interested = true; score = 55;
      summary = `Lead shared some details (${[ctx.purpose, ctx.budget, ctx.config, ctx.timeline].filter(Boolean).join(", ") || "partial"}) but wasn't ready to book yet.`;
      nextAction = "Send project brochure on WhatsApp and follow up to arrange a visit.";
      comment = "Warm but undecided — nurture with details and a soft follow-up.";
    } else {
      disposition = "undecided"; interested = userTurns >= 3; score = Math.min(70, 25 + userTurns * 10);
      summary = `Partial qualification captured (${[ctx.purpose, ctx.budget, ctx.config, ctx.timeline].filter(Boolean).join(", ") || "limited info"}).`;
      nextAction = "Follow up to complete qualification and offer a site visit.";
      comment = "Conversation in progress when it ended — follow up to qualify fully.";
    }
    return { interested, score, disposition, summary, nextAction, comment, _local: true };
  }

  function paintReview(r) {
    if (!reviewEl) return;
    const local = !!r._local;
    const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)));
    const yes = !!r.interested;
    const badgeClass = yes ? "is-yes" : "is-no";
    const meterColor = score >= 66 ? "var(--green)" : score >= 33 ? "var(--saffron)" : "#ff6b6b";

    reviewEl.innerHTML = `
      <div class="review__head">
        <h3>Call Review</h3>
        <span class="review__source ${local ? "is-local" : "is-live"}">
          ${local ? "local heuristic" : "AI summary"}
        </span>
      </div>
      <div class="review__row">
        <span class="review__badge ${badgeClass}">
          ${yes ? "Interested" : "Not interested"}
        </span>
        <span class="review__disp">${escapeHtml(r.disposition || "undecided")}</span>
      </div>
      <div class="review__meter" role="img" aria-label="Intent score ${score} out of 100">
        <div class="review__meter-label"><span>Intent score</span><b>${score}/100</b></div>
        <div class="review__meter-track">
          <div class="review__meter-fill" style="width:${score}%;background:${meterColor}"></div>
        </div>
      </div>
      <div class="review__block">
        <span class="review__k">Summary</span>
        <p>${escapeHtml(r.summary || "No summary available.")}</p>
      </div>
      <div class="review__block">
        <span class="review__k">Suggested next action</span>
        <p>${escapeHtml(r.nextAction || "—")}</p>
      </div>
      <div class="review__comment">
        <span class="review__k">Internal note (from our side)</span>
        <p>${escapeHtml(r.comment || "—")}</p>
      </div>
      <button class="review__new" id="call-new" type="button">↻ New call</button>
    `;
    reviewEl.hidden = false;
    transcript.scrollTop = transcript.scrollHeight;
    const newBtn = reviewEl.querySelector("#call-new");
    if (newBtn) newBtn.addEventListener("click", startCall);
    newBtn && newBtn.focus();
  }

  function renderReview() {
    if (!reviewEl) return;
    /* loading placeholder while we ask the backend */
    reviewEl.hidden = false;
    reviewEl.innerHTML = `<div class="review__head"><h3>Call Review</h3>
      <span class="review__source">summarizing…</span></div>`;

    const useByok = window.AnagaBrain && AnagaBrain.hasKey();
    /* No key and the server already proved unreachable → local heuristic. */
    if (!useByok && brainMode === "offline") { paintReview(localReview()); return; }

    const summaryReq = useByok
      ? AnagaBrain.summary({ history })
      : fetch(SUMMARY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ history })
        }).then(res => {
          if (!res.ok) throw new Error("summary_unavailable_" + res.status);
          return res.json();
        });

    summaryReq
      .then(data => {
        if (!data || typeof data !== "object") throw new Error("summary_bad_payload");
        paintReview(data);
      })
      .catch(() => paintReview(localReview()));
  }
  function closeCall() {
    if (active) finishCall({ reason: "Call ended" });
    overlay.hidden = true;
    document.body.style.overflow = "";
  }

  startBtn.addEventListener("click", startCall);
  /* End call: hang up and SHOW the review (overlay stays). If the call already
     ended (review on screen), the same button dismisses the overlay. */
  if (endBtn) endBtn.addEventListener("click", () => { if (active) finishCall({ reason: "Call ended" }); else closeCall(); });
  micBtn.addEventListener("click", () => {
    if (!active) return;
    if (listening) { try { recog.stop(); } catch (e) {} }
    else startListening();
  });
  textForm.addEventListener("submit", e => {
    e.preventDefault();
    const t = textInput.value;
    textInput.value = "";
    if (listening && recog) { try { recog.stop(); } catch (e) {} }
    handleUtterance(t);
  });
  overlay.addEventListener("click", e => { if (e.target.matches("[data-call-close]")) closeCall(); });
  document.addEventListener("keydown", e => { if (!overlay.hidden && e.key === "Escape") closeCall(); });
})();

/* stop any speech when the Playbook opens */
openBtn.addEventListener("click", () => { if (synth) synth.cancel(); });

/* ===================================================================
   SETTINGS — "Connect Gemini" (bring-your-own-key, stored in this browser)
   =================================================================== */
(function settings() {
  const openS  = document.getElementById("open-settings");
  const modal  = document.getElementById("settings");
  if (!openS || !modal || !window.AnagaBrain) return;

  const keyEl    = document.getElementById("settings-key");
  const modelEl  = document.getElementById("settings-model");
  const statusEl = document.getElementById("settings-status");
  const msgEl    = document.getElementById("settings-msg");
  const connectB = document.getElementById("settings-connect");
  const clearB   = document.getElementById("settings-clear");
  const revealB  = document.getElementById("settings-reveal");

  function refreshStatus() {
    const connected = AnagaBrain.hasKey();
    statusEl.textContent = connected
      ? `Status: connected ✓ — Anaga's brain runs live via your browser key (model: ${AnagaBrain.getModel()}).`
      : "Status: not connected — the call runs the offline script (or your Vercel server key, if deployed).";
    statusEl.className = "settings__status" + (connected ? " is-connected" : "");
    if (openS) openS.textContent = connected ? "🔑 Gemini connected" : "🔑 Connect Gemini";
  }
  function showMsg(text, ok) {
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = "settings__msg " + (ok ? "is-ok" : "is-err");
  }
  function open() {
    keyEl.value = AnagaBrain.getKey();
    modelEl.value = AnagaBrain.getModel() === AnagaBrain.DEFAULT_MODEL ? "" : AnagaBrain.getModel();
    msgEl.hidden = true;
    refreshStatus();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    keyEl.focus();
  }
  function close() { modal.hidden = true; document.body.style.overflow = ""; }

  openS.addEventListener("click", open);
  modal.addEventListener("click", e => { if (e.target.matches("[data-settings-close]")) close(); });
  document.addEventListener("keydown", e => { if (!modal.hidden && e.key === "Escape") close(); });

  revealB.addEventListener("click", () => {
    keyEl.type = keyEl.type === "password" ? "text" : "password";
  });

  connectB.addEventListener("click", () => {
    const key = keyEl.value.trim();
    const model = modelEl.value.trim() || AnagaBrain.DEFAULT_MODEL;
    if (!key) { showMsg("Please paste your Gemini API key first.", false); return; }
    connectB.disabled = true;
    showMsg("Testing the key…", true);
    AnagaBrain.test(key, model)
      .then(() => {
        AnagaBrain.setKey(key);
        AnagaBrain.setModel(modelEl.value.trim());
        showMsg("Connected ✓  Anaga will now think with Gemini. Start a call to hear it.", true);
        refreshStatus();
      })
      .catch(err => showMsg("Couldn't connect: " + (err && err.message ? err.message : "check the key/model and try again."), false))
      .finally(() => { connectB.disabled = false; });
  });

  clearB.addEventListener("click", () => {
    AnagaBrain.setKey("");
    showMsg("Disconnected. The key was removed from this browser.", true);
    refreshStatus();
  });

  refreshStatus(); // reflect any previously-saved key on load
})();
