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

/* ---- 3 selectable voices for Anaga ----
   `idx` binds each preset to a DIFFERENT installed voice (when the device has
   several). Strong, well-separated pitch/rate make them clearly distinct even
   when the device only exposes one TTS voice — the common reason "all three
   sound the same". `hints` is only a soft preference. */
const VOICES = [
  { id: "aria",  name: "Aria",  style: "Warm & bright",  idx: 0, pitch: 1.15, rate: 1.0,
    hints: ["samantha", "aria", "veena", "heera", "google us english", "zira"] },
  { id: "kiara", name: "Kiara", style: "Low & crisp",    idx: 1, pitch: 0.8,  rate: 1.12,
    hints: ["google uk english female", "kalpana", "tessa", "catherine", "serena", "fiona"] },
  { id: "meher", name: "Meher", style: "High & gentle",  idx: 2, pitch: 1.5,  rate: 0.85,
    hints: ["victoria", "swara", "raveena", "moira", "karen", "nicky"] }
];
let selectedVoiceId = (function () {
  try { return localStorage.getItem("vaak_voice") || "aria"; } catch (e) { return "aria"; }
})();
function currentVoice() { return VOICES.find(v => v.id === selectedVoiceId) || VOICES[0]; }
function setSelectedVoice(id) {
  selectedVoiceId = id;
  try { localStorage.setItem("vaak_voice", id); } catch (e) {}
}

const synth = window.speechSynthesis;
let voices = [];
function loadVoices() { voices = (synth && synth.getVoices()) || []; }
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

/* a de-duplicated, quality-ranked list of voices for a language base */
function rankedVoices(base) {
  if (!voices.length) loadVoices();
  const female = v => FEMALE_HINTS.some(h => v.name.toLowerCase().includes(h));
  const lang = v => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith(base);
  const en   = v => v.lang && v.lang.toLowerCase().startsWith("en");
  const buckets = [
    voices.filter(v => lang(v) && female(v)),
    voices.filter(v => lang(v) && !female(v)),
    voices.filter(v => !lang(v) && en(v) && female(v)),
    voices.filter(v => !lang(v) && en(v)),
    voices.slice()
  ];
  const seen = new Set(), out = [];
  for (const b of buckets) for (const v of b) {
    const k = v.voiceURI || v.name;
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

/* bind a preset to a concrete, DISTINCT installed voice (by index) */
function resolveVoiceForPreset(preset, lang) {
  const base = (lang || "en-IN").split("-")[0].toLowerCase();
  const ranked = rankedVoices(base);
  if (!ranked.length) return null;
  const byHint = ranked.find(v => preset.hints.some(h => v.name.toLowerCase().includes(h)));
  /* distinctness first: give each preset a different voice when possible,
     else fall back to its hinted voice, else the first available. */
  return ranked[preset.idx] || byHint || ranked[ranked.length - 1] || ranked[0];
}

function voiceLabel(v) {
  return v ? v.name.replace(/^(Google|Microsoft)\s+/i, "").replace(/\s*\(.*\)$/, "") : "default";
}

/* speakText(text, lang, { onstart, onend, voice }) -> returns chosen voice (or null) */
function speakText(text, lang, opts = {}) {
  if (!synth) {
    /* no TTS engine — don't stall the conversation; continue after a short beat */
    setTimeout(() => opts.onend && opts.onend(), 400);
    return null;
  }
  const preset = opts.voice || currentVoice();
  const u = new SpeechSynthesisUtterance(text);
  const v = resolveVoiceForPreset(preset, lang);
  if (v) u.voice = v;
  u.lang = (v && v.lang) || lang;
  u.pitch = preset.pitch;
  u.rate = preset.rate;
  if (opts.onstart) u.onstart = opts.onstart;
  /* fire onend exactly once, even if the browser drops the speech 'end' event
     (a common cause of a stalled call) — a watchdog guarantees progress. */
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(wd); opts.onend && opts.onend(); };
  u.onend = finish;
  u.onerror = finish;
  synth.cancel();
  synth.speak(u);
  const ms = Math.min(20000, 2600 + text.split(/\s+/).length * 380);
  const wd = setTimeout(finish, ms);
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
    const hl = (curLang === "auto") ? "en-IN" : curLang;   // sample needs a concrete language
    const v = speakText(ANAGA_LINES[hl] || ANAGA_LINES["en-IN"], hl, { onend: () => setSpeaking(false) });
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

/* ---------------- voice picker (3 selectable AI voices) ---------------- */
(function voicePicker() {
  const picker = document.getElementById("voice-picker");
  if (!picker) return;
  const cards = [...picker.querySelectorAll(".voice-card")];
  const note = document.getElementById("voice-resolved");
  const refresh = () => cards.forEach(c => c.classList.toggle("is-active", c.dataset.voice === selectedVoiceId));

  /* show which real installed voice each preset resolves to (transparency:
     proves they differ, or reveals a 1-voice device honestly). */
  function updateNote() {
    if (!voices.length) loadVoices();
    const map = VOICES.map(p => ({ p, v: resolveVoiceForPreset(p, "en-IN") }));
    cards.forEach(c => {
      const m = map.find(x => x.p.id === c.dataset.voice);
      if (m) c.title = m.v ? "Uses your device voice: " + voiceLabel(m.v) : "Uses your device's default voice";
    });
    if (!note) return;
    const names = map.map(m => voiceLabel(m.v));
    const distinct = new Set(names.map(n => n.toLowerCase())).size;
    if (!voices.length) { note.textContent = ""; return; }
    note.textContent = distinct >= 2
      ? "On your device → Aria: " + names[0] + " · Kiara: " + names[1] + " · Meher: " + names[2]
      : "Your device exposes one TTS voice (" + names[0] + "), so the three differ by pitch & pace. For 3 distinct natural voices, deploy with a cloud voice (Sarvam/ElevenLabs).";
  }

  refresh();
  updateNote();
  if (synth) synth.addEventListener && synth.addEventListener("voiceschanged", updateNote);
  setTimeout(updateNote, 600);   // voices often load a beat after first paint

  cards.forEach(card => card.addEventListener("click", () => {
    setSelectedVoice(card.dataset.voice);
    refresh();
    if (synth) speakText("Hi, I'm Anaga, your AI voice agent. How can I help you today?", "en-IN", { voice: currentVoice() });
  }));
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
  let micAllowed = false;         // whether getUserMedia granted
  let micCapable = false;         // recog supported AND mic granted → can actually listen

  /* spoken language for THIS call (driven by the hero language pills).
     When non-English and Chrome's on-device translator is available, Anaga's
     English brain output is translated to callBase for speaking, and the
     caller's speech is translated back to English for the rule engine. */
  let callLang = "en-IN";
  let callBase = "en";
  let translateOn = false;
  let autoMode = false;           // 🌐 detect the caller's language with on-device AI
  let notedLang = null;           // last language we announced a switch to (avoid spam)

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
  /* speak `display` (already in the caller's language) in `ttsLang`, record
     `histText` (English) for review/LLM, then continue or end the call. */
  function speakLine(display, endInfo, opts) {
    opts = opts || {};
    addBubble("anaga", display);
    history.push({ role: "agent", text: opts.histText || display });
    setMic(false);
    setStatus("Anaga is speaking…", "is-speaking");
    speakText(display, opts.lang || CALL_LANG, {
      onend: () => {
        if (endInfo) return finishCall(endInfo);
        (opts.onDone || startListening)();
      }
    });
  }

  /* Deliver an ENGLISH line from the brain — translate to the caller's
     language first when translation is on (the second of the two passes). */
  function deliver(englishLine, endInfo) {
    if (!translateOn) { speakLine(englishLine, endInfo); return; }
    setStatus("Anaga is speaking…", "is-speaking");
    TranslateKit.out(englishLine, callBase)
      .then(tr => speakLine(tr || englishLine, endInfo, { lang: callLang, histText: englishLine }))
      .catch(() => speakLine(englishLine, endInfo, { lang: callLang, histText: englishLine }));
  }

  /* offline path: speak a FLOW step (mirrors the versioned flow JSON) */
  function sayStep(id) {
    const step = FLOW[id];
    stepId = id;
    const endInfo = step.end
      ? { reason: step.optout ? "Opt-out recorded · call ended" : "Call ended", optout: !!step.optout }
      : null;
    deliver(step.say(), endInfo);
  }

  function startListening() {
    if (!active) return;
    if (!micCapable) {                       // no recog or mic not granted → prompt typing instead
      setStatus("Your turn — type your reply below ⌨️", null);
      if (textInput) textInput.focus();
      return;
    }
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
    addBubble("you", text);                 // show what the caller actually said (their language)
    setStatus("Anaga is thinking…", null);

    /* translate the caller's speech to English (first pass) so the rule engine /
       LLM see English; the displayed bubble keeps the original language. */
    const advance = (englishText) => {
      history.push({ role: "user", text: englishText });
      if (brainMode === "offline") { setTimeout(nextOfflineTurn, 350); return; }
      nextLiveTurn();
    };
    const toEnglishThenAdvance = () => {
      if (translateOn) TranslateKit.in(text, callBase).then(en => advance(en || text)).catch(() => advance(text));
      else advance(text);
    };

    /* 🌐 auto-detect the caller's language with on-device AI, then adapt */
    if (autoMode && window.TranslateKit && TranslateKit.available() && TranslateKit.hasDetector()) {
      TranslateKit.detect(text)
        .then(base => {
          if (!active) return;
          if (shouldSwitch(base, text)) applyLanguage(base).then(toEnglishThenAdvance);
          else toEnglishThenAdvance();
        })
        .catch(toEnglishThenAdvance);
    } else {
      toEnglishThenAdvance();
    }
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
        deliver(line, endInfo);
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

  /* label the mic button so its state is always visible — but NEVER disable it,
     so a tap always does something (either listen, or explain + focus the text box). */
  function configureMicButton(granted) {
    const label = micBtn.querySelector(".call__mic-label");
    micCapable = !!(recog && granted);
    micBtn.disabled = false;
    micBtn.classList.toggle("is-disabled", !micCapable);
    label.textContent = micCapable
      ? "🎤 Tap to speak"
      : (recog ? "🎤 Allow mic — or tap to type" : "🎤 Voice unsupported — tap to type");
  }

  /* ---- lifecycle ---- */
  function resetCall() {
    ctx = {}; stepId = null; processing = false;
    history = []; lastDisposition = "qualifying"; brainMode = null;
    transcript.innerHTML = "";
    if (reviewEl) { reviewEl.hidden = true; reviewEl.innerHTML = ""; }
    if (endBtn) endBtn.textContent = "✕ End call";
    micCapable = false;
    micBtn.disabled = false;           // never a dead button; configureMicButton sets the label
    micBtn.classList.remove("is-on");
    setBrain(null);
    clearNotice();
  }

  function langLabel(base) {
    return ({ en: "English", hi: "Hindi", te: "Telugu", ta: "Tamil", kn: "Kannada", mr: "Marathi", bn: "Bengali", ml: "Malayalam", gu: "Gujarati", pa: "Punjabi" })[base] || base;
  }
  function bcp47(base) {
    return ({ en: "en-IN", hi: "hi-IN", te: "te-IN", ta: "ta-IN", kn: "kn-IN", mr: "mr-IN", bn: "bn-IN", ml: "ml-IN", gu: "gu-IN", pa: "pa-IN" })[base] || (base + "-IN");
  }

  /* switch the live call to a language mid-conversation (used by auto-detect).
     Returns a promise that resolves once translators (if needed) are ready. */
  function applyLanguage(base) {
    callBase = base;
    callLang = bcp47(base);
    if (recog) { try { recog.lang = callLang; } catch (e) {} }
    if (base === "en") { translateOn = false; return Promise.resolve(true); }
    if (!window.TranslateKit || !TranslateKit.available()) { translateOn = false; return Promise.resolve(false); }
    return TranslateKit.prep(base).then(ok => {
      translateOn = ok;
      if (ok && notedLang !== base) { notedLang = base; addBubble("anaga", "🌐 Detected " + langLabel(base) + " — switching to " + langLabel(base) + "."); }
      return ok;
    }).catch(() => { translateOn = false; return false; });
  }

  /* avoid flip-flopping on short acknowledgements ("yes"/"haan") while already
     mid-conversation in another language. */
  function shouldSwitch(base, text) {
    if (!base) return false;
    if (base === callBase) return base !== "en" && !translateOn;   // same lang but translator not on yet
    if (base === "en" && translateOn && text.trim().length < 8) return false; // short ack inside a non-EN call
    return true;
  }

  /* Mobile browsers only allow speech to start from a user gesture. Speaking a
     near-silent utterance inside the tap "unlocks" TTS for the rest of the call. */
  function primeAudio() {
    if (!synth) return;
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.cancel(); synth.speak(u); } catch (e) {}
  }

  /* getUserMedia can hang on mobile (prior denial, OS quirks). Never let it
     stall the call — race it against a timeout so the greeting always proceeds. */
  function requestMicSafe() {
    return Promise.race([
      requestMic(),
      new Promise(res => setTimeout(() => res(false), 6000))
    ]);
  }

  function startCall() {
    resetCall();
    active = true;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    primeAudio();                    // unlock audio within the tap (mobile)

    /* language for this call comes from the active hero language pill.
       "auto" → detect the caller's language on the fly with on-device AI. */
    const activePill = document.querySelector('#voice-demo .lang-pill.is-active');
    const sel = (activePill && activePill.dataset.lang) || "en-IN";
    autoMode = (sel === "auto");
    callLang = autoMode ? "en-IN" : sel;
    callBase = callLang.split("-")[0];
    translateOn = false;
    notedLang = null;
    if (recog) recog.lang = callLang;

    setStatus("Connecting…", null);
    requestMicSafe().then(granted => {
      if (!active) return;            // closed while the prompt was open
      micAllowed = granted;
      configureMicButton(granted);
      if (!recog) {
        addBubble("anaga", "(Speech recognition isn't available in this browser — you can type your replies. Chrome or Edge give the full voice experience.)");
      } else if (!granted) {
        addBubble("anaga", "(Microphone access wasn't granted — no problem, you can type your replies below.)");
      }

      const begin = () => { if (active) sayStep("greet"); };

      /* 🌐 Auto-detect: greet in English, then adapt to whatever the caller speaks */
      if (autoMode) {
        if (window.TranslateKit && TranslateKit.available() && TranslateKit.hasDetector()) {
          addBubble("anaga", "🌐 Auto language is on — reply in English, हिंदी, or తెలుగు and I'll match you.");
        } else {
          showNotice("🌐 Auto-detect needs Chrome 138+ (or Edge) — running in English. You can still type.");
        }
        setTimeout(begin, 450);
        return;
      }

      if (callBase === "en") { setTimeout(begin, 450); return; }

      /* non-English: prepare Chrome's on-device translator (the two passes) */
      const reqLabel = langLabel(callBase);
      if (!window.TranslateKit || !TranslateKit.available()) {
        callLang = "en-IN"; callBase = "en"; if (recog) recog.lang = "en-IN";
        showNotice("🌐 On-device translation needs Chrome 138+ (or Edge) — running this call in English. You can still type.");
        setTimeout(begin, 350);
        return;
      }
      setStatus("Preparing " + reqLabel + " on your device…", null);
      TranslateKit.prep(callBase).then(ok => {
        if (!active) return;
        translateOn = ok;
        if (ok) {
          addBubble("anaga", "🌐 We'll talk in " + reqLabel + " — translated on your device, no API.");
        } else {
          callLang = "en-IN"; callBase = "en"; if (recog) recog.lang = "en-IN";
          showNotice("🌐 The on-device " + reqLabel + " model isn't available here — running in English. You can still type.");
        }
        setTimeout(begin, 350);
      }).catch(() => { translateOn = false; callBase = "en"; callLang = "en-IN"; if (recog) recog.lang = "en-IN"; setTimeout(begin, 350); });
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
    if (!micCapable) {                       // can't listen → guide to typing (always responsive)
      showNotice(recog
        ? "🎤 Mic needs permission on a secure page (https or localhost). Type your reply below — Anaga will still respond."
        : "🎤 Voice input isn't supported in this browser (try Chrome/Edge). Type your reply below — Anaga will still respond.");
      if (textInput) textInput.focus();
      return;
    }
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
