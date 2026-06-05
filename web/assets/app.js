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

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recog = SR ? new SR() : null;
  if (recog) { recog.lang = "en-IN"; recog.interimResults = true; recog.maxAlternatives = 1; recog.continuous = false; }

  let ctx = {};
  let stepId = null;
  let listening = false;
  let processing = false;
  let active = false;
  let interimEl = null;

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

  /* ---- speaking & listening ---- */
  function sayStep(id) {
    const step = FLOW[id];
    stepId = id;
    const line = step.say();
    addBubble("anaga", line);
    setMic(false);
    setStatus("Anaga is speaking…", "is-speaking");
    speakText(line, "en-IN", {
      onend: () => {
        if (step.end) return finishCall(step.optout ? "Opt-out recorded · call ended" : "Call ended");
        startListening();
      }
    });
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
    const nextId = (FLOW[stepId].next ? FLOW[stepId].next(text, ctx) : null) || "callback";
    setStatus("Anaga is thinking…", null);
    setTimeout(() => sayStep(nextId), 350);
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
    micBtn.querySelector(".call__mic-label").textContent = on ? "Listening… (tap to stop)" : "Tap to speak";
  }

  /* ---- lifecycle ---- */
  function startCall() {
    ctx = {}; stepId = null; processing = false; active = true;
    transcript.innerHTML = "";
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    setStatus("Connecting…", null);
    if (!recog) addBubble("anaga", "(Speech recognition isn't available in this browser — you can type your replies. Chrome or Edge give the full voice experience.)");
    setTimeout(() => sayStep("greet"), 500);
  }
  function finishCall(reason) {
    active = false; listening = false;
    if (recog) try { recog.abort(); } catch (e) {}
    synth && synth.cancel();
    setMic(false);
    setStatus(reason || "Call ended", null);
  }
  function closeCall() {
    finishCall("Call ended");
    overlay.hidden = true;
    document.body.style.overflow = "";
  }

  startBtn.addEventListener("click", startCall);
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
