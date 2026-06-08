/* ===================================================================
   Anaga — Modcon Builders · app logic
   Renders the agent fleet, the metrics, and drives the Playbook overlay.
   =================================================================== */

/* ---------------- agent fleet (from MULTI_AGENT_SPEC.md) ---------------- */
const FLEET = [
  { wp: "WP-0", badge: ["base", "Foundation"], name: "Compliance foundation & repo bootstrap", desc: "Legal-to-dial + clean repo skeleton, CI, registration tracker.", dep: "none" },
  { wp: "WP-1", badge: ["base", "Spike"], name: "Framework decision (ADR)", desc: "Pick the voice-pipeline approach — validated with one real end-to-end call.", dep: "WP-0" },
  { wp: "WP-2", badge: ["base", "Orchestrator"], name: "Orchestrator", desc: "Spawn/track caller agents, balance load, warm human handoff.", dep: "WP-1" },
  { wp: "WP-3", badge: ["core", "The soul"], name: "Anaga — caller-agent pipeline", desc: "Anaga's voice: streaming STT→LLM→TTS, warm female voice, turn-taking, barge-in, code-mixed calls. Over-invest here.", dep: "WP-1" },
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
  "en-IN": "Hi, I'm Anaga, Modcon Builders' AI voice assistant, calling about SYL Residences at Tukkuguda. Is now a good time to talk for a couple of minutes?",
  "hi-IN": "नमस्ते, मैं अनघा हूँ, Modcon Builders की एक ए आई वॉइस असिस्टेंट, Tukkuguda में SYL Residences के बारे में बात कर रही हूँ। क्या मैं आपसे दो मिनट बात कर सकती हूँ?",
  "te-IN": "నమస్కారం, నేను అనగా, Modcon Builders నుండి ఒక ఏఐ వాయిస్ అసిస్టెంట్, Tukkugudaలో SYL Residences గురించి మాట్లాడుతున్నాను. మీకు కొన్ని నిమిషాలు ఉంటే మాట్లాడొచ్చా?"
};
const FEMALE_HINTS = [
  "female", "samantha", "victoria", "karen", "moira", "tessa", "fiona", "veena",
  "zira", "susan", "linda", "heera", "kalpana", "swara", "aditi", "raveena",
  "google हिन्दी", "google తెలుగు", "google uk english female", "google us english"
];

/* ---- selectable voices for Anaga ----
   `idx` binds each preset to a DIFFERENT installed voice (when the device has
   several). Strong, well-separated pitch/rate make them clearly distinct even
   when the device only exposes one TTS voice — the common reason "all three
   sound the same". `hints` is only a soft preference. */
const VOICES = [
  { id: "aria",  name: "Aria",  style: "Warm & bright",  idx: 0, pitch: 1.15, rate: 1.0,  sarvam: "anushka",
    hints: ["samantha", "aria", "veena", "heera", "google us english", "zira"] },
  { id: "kiara", name: "Kiara", style: "Low & crisp",    idx: 1, pitch: 0.8,  rate: 1.12, sarvam: "manisha",
    hints: ["google uk english female", "kalpana", "tessa", "catherine", "serena", "fiona"] }
];
let selectedVoiceId = (function () {
  let v; try { v = localStorage.getItem("vaak_voice"); } catch (e) {}
  return VOICES.some(x => x.id === v) ? v : "aria";   // ignore a stale/removed voice (e.g. "meher")
})();
function currentVoice() { return VOICES.find(v => v.id === selectedVoiceId) || VOICES[0]; }
function setSelectedVoice(id) {
  selectedVoiceId = id;
  try { localStorage.setItem("vaak_voice", id); } catch (e) {}
}

/* ---- voice modulation (set by the Voice Lab sliders) ----
   pitch/pace are ±% offsets; loud is % (100 = normal). Applied to both the
   browser voice and the Sarvam request. */
let modulation = (function () {
  try { return Object.assign({ pitch: 0, pace: 0, loud: 100 }, JSON.parse(localStorage.getItem("vaak_mod") || "{}")); }
  catch (e) { return { pitch: 0, pace: 0, loud: 100 }; }
})();
function getModulation() { return modulation; }
function setModulation(m) {
  modulation = Object.assign({}, modulation, m);
  try { localStorage.setItem("vaak_mod", JSON.stringify(modulation)); } catch (e) {}
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* hook the Voice Lab registers so the meter animates during browser TTS
   (speechSynthesis output can't be captured by Web Audio) */
let vlabOnSynthetic = null;   // (durationMs) => void

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

/* ---- Cloud TTS (Sarvam Bulbul) — real, distinct, lifelike voices via /api/tts.
   Server holds the key; we fetch base64 audio and play it. Falls back to the
   browser voice when the endpoint/key isn't available. ---- */
const CloudTTS = (function () {
  let available = null;            // null=unknown, true, false
  let audio = null;
  let playWd = null;               // watchdog: a stuck <audio> must never hang the turn
  const cache = {};                // key -> dataURL (repeat lines, e.g. greeting)
  const modKey = () => modulation.pitch + "," + modulation.pace + "," + modulation.loud;
  function reqBody(text, lang, speaker) {
    return JSON.stringify({
      text, lang: lang || "en-IN", speaker,
      pitch: modulation.pitch / 100,        // ±0.5 offset
      pace: 1 + modulation.pace / 100,       // 0.5..1.5
      loudness: modulation.loud / 100        // 0..2
    });
  }
  function probe() {
    return fetch("/api/tts").then(r => r.ok ? r.json() : { available: false })
      .then(d => { available = !!(d && d.available); return available; })
      .catch(() => { available = false; return false; });
  }
  function isOn() { return available === true; }
  function stop() { if (audio) { try { audio.pause(); } catch (e) {} audio.onended = audio.onerror = audio.onplay = audio.onloadedmetadata = null; if (playWd) { clearTimeout(playWd); playWd = null; } audio = null; } }
  function play(src, opts, fallback) {
    stop();
    const el = audio = new Audio(src);
    let done = false;
    const finish = () => { if (done) return; done = true; if (playWd) { clearTimeout(playWd); playWd = null; } opts.onend && opts.onend(); };
    if (opts.onstart) audio.onplay = opts.onstart;
    audio.onended = finish;
    audio.onerror = () => { if (playWd) { clearTimeout(playWd); playWd = null; } if (!done) { done = true; fallback(); } };
    /* some browsers load a data-URI <audio> but never fire `ended` (zero-length /
       odd payloads) — bound playback so speakLine always advances. We learn the
       real duration on metadata and extend the cap to it; default to a safe max. */
    const arm = (ms) => { if (playWd) clearTimeout(playWd); playWd = setTimeout(() => { playWd = null; if (audio === el) finish(); }, ms); };
    audio.onloadedmetadata = () => { const d = el.duration; if (isFinite(d) && d > 0) arm(d * 1000 + 1200); };
    arm(20000);                       // hard ceiling until metadata refines it
    audio.play().catch(() => { if (playWd) { clearTimeout(playWd); playWd = null; } if (!done) { done = true; fallback(); } });
  }
  function speak(text, lang, preset, opts, fallback) {
    const speaker = preset.sarvam || "anushka";
    const key = speaker + "|" + (lang || "en-IN") + "|" + modKey() + "|" + text;
    if (cache[key]) return play(cache[key], opts, fallback);
    /* a hung /api/tts fetch must never freeze the call — abort it and fall back
       to the browser voice so speakLine keeps moving. */
    const ctrl = ("AbortController" in window) ? new AbortController() : null;
    const to = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, 7000);
    let settled = false;
    const bail = () => { if (settled) return; settled = true; clearTimeout(to); available = false; fallback(); };
    fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody(text, lang, speaker), signal: ctrl ? ctrl.signal : undefined })
      .then(r => { if (!r.ok) throw new Error("tts_" + r.status); return r.json(); })
      .then(d => {
        if (settled) return;
        if (!d || !d.audio) throw new Error("no_audio");
        settled = true; clearTimeout(to);
        const src = "data:" + (d.mime || "audio/wav") + ";base64," + d.audio;
        cache[key] = src;
        play(src, opts, fallback);
      })
      .catch(bail);   // degrade to browser voice
  }
  /* fetch raw audio (used by the Voice Lab so it can analyse real frequencies) */
  function fetchAudio(text, lang, preset) {
    const speaker = preset.sarvam || "anushka";
    return fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody(text, lang, speaker) })
      .then(r => { if (!r.ok) throw new Error("tts_" + r.status); return r.json(); });
  }
  /* warm the cache for the NEXT sentence while the current one plays — keeps
     sentence-chunked delivery gap-free (and lowers time-to-first-audio). */
  function prefetch(text, lang, preset) {
    if (available !== true || !text) return;
    const speaker = (preset && preset.sarvam) || "anushka";
    const key = speaker + "|" + (lang || "en-IN") + "|" + modKey() + "|" + text;
    if (cache[key]) return;
    fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody(text, lang, speaker) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && d.audio) cache[key] = "data:" + (d.mime || "audio/wav") + ";base64," + d.audio; })
      .catch(() => {});
  }
  return { probe, isOn, speak, stop, fetchAudio, prefetch };
})();

/* browser Web Speech path (fallback / no key) */
function browserSpeak(text, lang, preset, opts) {
  if (!synth) { setTimeout(() => opts.onend && opts.onend(), 400); return null; }
  const u = new SpeechSynthesisUtterance(text);
  const v = resolveVoiceForPreset(preset, lang);
  if (v) u.voice = v;
  u.lang = (v && v.lang) || lang;
  u.pitch = clamp(preset.pitch * (1 + modulation.pitch / 100), 0, 2);
  u.rate  = clamp(preset.rate  * (1 + modulation.pace  / 100), 0.1, 3);
  u.volume = clamp(modulation.loud / 100, 0, 1);
  if (opts.onstart) u.onstart = opts.onstart;
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(wd); opts.onend && opts.onend(); };
  u.onend = finish;
  u.onerror = finish;
  synth.cancel();
  synth.speak(u);
  const ms = Math.min(20000, 2600 + text.split(/\s+/).length * 380);
  const wd = setTimeout(finish, ms);
  /* browser speechSynthesis can't be tapped by Web Audio — drive a synthetic meter */
  if (vlabOnSynthetic) vlabOnSynthetic(Math.min(ms, 2600 + text.split(/\s+/).length * 360));
  return v;
}

/* speakText(text, lang, { onstart, onend, voice }) — Sarvam cloud voice when
   available, else the browser voice. Returns the resolved preset/voice. */
function speakText(text, lang, opts = {}) {
  const preset = opts.voice || currentVoice();
  if (synth) synth.cancel();
  CloudTTS.stop();
  if (CloudTTS.isOn()) {
    CloudTTS.speak(text, lang, preset, opts, () => browserSpeak(text, lang, preset, opts));
    return preset;
  }
  return browserSpeak(text, lang, preset, opts);
}
CloudTTS.probe();   // detect cloud voices once on load

/* ===================================================================
   Cloud STT (Sarvam Saarika) — accurate Indian-language speech-to-text via
   /api/stt with AUTOMATIC language detection. The browser records the caller's
   utterance, we decode it to 16 kHz mono WAV, and the server returns the
   transcript + DETECTED language so the call auto-switches languages from the
   caller's own voice (Telugu / Hindi / English / code-mix). Falls back to the
   browser's Web Speech recognition when unavailable. Key is server-side only.
   =================================================================== */
const SarvamSTT = (function () {
  let available = null;            // null=unknown, true, false
  let actx = null;
  function ctx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!actx) actx = new AC();
    return actx;
  }
  function probe() {
    return fetch("/api/stt").then(r => r.ok ? r.json() : { available: false })
      .then(d => { available = !!(d && d.available); return available; })
      .catch(() => { available = false; return false; });
  }
  function isOn() { return available === true; }

  /* AudioBuffer -> 16 kHz mono 16-bit PCM WAV Blob (what Saarika expects) */
  function encodeWav(buffer, targetRate) {
    targetRate = targetRate || 16000;
    const numCh = buffer.numberOfChannels;
    let mono = buffer.getChannelData(0);
    if (numCh > 1) {
      const m = new Float32Array(mono.length);
      for (let c = 0; c < numCh; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) m[i] += d[i] / numCh; }
      mono = m;
    }
    const ratio = buffer.sampleRate / targetRate;
    const outLen = Math.max(1, Math.floor(mono.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = mono[Math.floor(i * ratio)] || 0;

    const ab = new ArrayBuffer(44 + out.length * 2);
    const view = new DataView(ab);
    const wstr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, "RIFF"); view.setUint32(4, 36 + out.length * 2, true); wstr(8, "WAVE");
    wstr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wstr(36, "data"); view.setUint32(40, out.length * 2, true);
    let off = 44;
    for (let i = 0; i < out.length; i++) { const s = Math.max(-1, Math.min(1, out[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2; }
    return new Blob([ab], { type: "audio/wav" });
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result || ""); resolve(s.slice(s.indexOf(",") + 1)); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  /* transcribe a recorded utterance Blob -> { transcript, language_code } */
  async function transcribe(blob, languageCode) {
    if (!blob) throw new Error("no_audio");
    const c = ctx();
    if (!c) throw new Error("no_audio_ctx");
    if (c.state === "suspended" && c.resume) { try { await c.resume(); } catch (e) {} }
    const decoded = await c.decodeAudioData(await blob.arrayBuffer());
    const wav = encodeWav(decoded, 16000);
    const audio = await blobToBase64(wav);
    const res = await fetch("/api/stt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio, mime: "audio/wav", language_code: languageCode || "unknown" })
    });
    if (!res.ok) throw new Error("stt_" + res.status);
    return res.json();             // { transcript, language_code }
  }
  return { probe, isOn, transcribe };
})();
SarvamSTT.probe();
window.SarvamSTT = SarvamSTT;

/* detect the real-time Gemini Live engine (web/assets/live-call.js). When
   available it powers a true full-duplex call using the Gemini key — and uses
   ZERO Sarvam credits. Falls back to the turn-based demo when unavailable. */
if (window.LiveCall && LiveCall.probe) LiveCall.probe();

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

/* ---------------- voice picker (selectable AI voices) ---------------- */
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
    /* premium cloud voices available */
    if (CloudTTS.isOn()) {
      const list = VOICES.map(p => p.name).join(" · ");
      note.innerHTML = "🟢 Premium cloud voices — <b>" + list + "</b> (distinct &amp; lifelike).";
      return;
    }
    const names = map.map(m => voiceLabel(m.v));
    const distinct = new Set(names.map(n => n.toLowerCase())).size;
    if (!voices.length) { note.textContent = ""; return; }
    note.textContent = "Anaga's voices — " + VOICES.map(p => p.name).join(" · ") + ".";
  }

  refresh();
  updateNote();
  if (synth) synth.addEventListener && synth.addEventListener("voiceschanged", updateNote);
  setTimeout(updateNote, 600);    // voices often load a beat after first paint
  setTimeout(updateNote, 1600);   // and after the cloud-TTS capability probe resolves

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
  const voiceChip  = document.getElementById("call-voice");   // removed from UI; guards below tolerate null
  const timerEl    = document.getElementById("call-timer");
  const speakerBtn = document.getElementById("call-speaker");
  const keypadBtn  = document.getElementById("call-keypad");
  const stageEl    = document.getElementById("call-stage");   // the phone-call "face"
  let callTimerId = null, callStartMs = 0;
  function startTimer() {
    callStartMs = Date.now();
    if (timerEl) timerEl.textContent = "0:00";
    if (callTimerId) clearInterval(callTimerId);
    callTimerId = setInterval(function () {
      if (!timerEl) return;
      var s = Math.max(0, Math.floor((Date.now() - callStartMs) / 1000));
      timerEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 1000);
  }
  function stopTimer() { if (callTimerId) { clearInterval(callTimerId); callTimerId = null; } }

  /* show which voice is talking (and the Sarvam speaker when cloud is on);
     tap to cycle through the voices mid-call (applies from the next line). */
  function updateCallVoice() {
    if (!voiceChip) return;
    const p = currentVoice();
    const cloud = window.CloudTTS && CloudTTS.isOn();
    voiceChip.textContent = "🎙 " + p.name;
    voiceChip.title = "Voice: " + p.name;
  }
  if (voiceChip) voiceChip.addEventListener("click", () => {
    const ids = VOICES.map(v => v.id);
    setSelectedVoice(ids[(ids.indexOf(selectedVoiceId) + 1) % ids.length]);
    updateCallVoice();
    voiceChip.classList.remove("flash"); void voiceChip.offsetWidth; voiceChip.classList.add("flash");
  });

  /* backend endpoints (relative — work behind the same origin / Vercel functions) */
  const TURN_URL    = "/api/anaga/turn";
  const SUMMARY_URL = "/api/anaga/summary";
  const CALL_LANG   = "en-IN";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recog = SR ? new SR() : null;
  if (recog) { recog.lang = "en-IN"; recog.interimResults = true; recog.maxAlternatives = 1; recog.continuous = true; }

  /* ---- free-flow conversation config (Path A: browser-only, no new keys) ----
     CONTINUOUS  keep the mic hot so the caller never has to tap "speak"
     BARGE_IN    let the caller interrupt Anaga mid-sentence (she stops & listens)
     ENDPOINT_MS silence after speech before the caller's turn is treated as done
                 — lets them pause mid-thought without getting cut off */
  const CONTINUOUS = true;
  const BARGE_IN = true;
  const ENDPOINT_MS = 550;         // snappier end-of-turn; still tolerates a mid-thought pause
  const BARGEIN_MIN_CHARS = 3;     // ignore shorter blips while Anaga speaks (echo guard)

  let ctx = {};
  let stepId = null;
  let listening = false;
  let active = false;
  let interimEl = null;

  /* free-flow state */
  let phase = "idle";              // idle | listening | thinking | speaking
  let micMuted = false;            // caller toggled the mic off
  let wantListen = false;          // we want recognition running (drives auto-restart)
  let speakToken = 0;              // invalidates a superseded line's TTS onend (barge-in)
  let pendingEnd = null;           // end-info resolved after speech already started (streaming)
  let endpointTimer = null;        // debounce timer for natural end-of-turn
  let pendingUtter = "";           // accumulates the caller's words across short pauses
  let currentSpokenNorm = "";      // Anaga's current line, normalized — used to filter echo

  /* Sarvam STT capture: when cloud STT is available we record each utterance and
     send the audio to /api/stt for an accurate transcript + detected language. */
  let sttStream = null;            // live mic stream kept alive for recording
  let mediaRec = null;             // MediaRecorder for the current utterance
  let recChunks = [];
  let recording = false;

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
  let offlineNudged = false;      // showed the "connect a brain for real conversation" nudge once

  /* real-time Gemini Live call (full-duplex; 0 Sarvam credits) */
  let liveMode = false;
  let liveUserEl = null, liveAgentEl = null, liveUserTxt = "", liveAgentTxt = "";

  /* ---- intent helpers ---- */
  const has = (t, re) => re.test(t);
  const affirmative = t => has(t, /\b(yes|yeah|yep|yup|sure|ok|okay|fine|haan|ha|please|go ahead|sounds good|why not|definitely|of course|alright|interested)\b/i);
  const negative    = t => has(t, /\b(no|nope|not now|busy|later|can'?t|cannot|don'?t|some other time|not really)\b/i);
  const optout      = t => has(t, /\b(not interested|do ?n'?t call|don'?t call|stop calling|remove me|unsubscribe|leave me alone|opt ?out|take me off|dnd)\b/i);
  const extractBudget = t => { const m = t.match(/(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|l)\b/i); return m ? `${m[1]} ${/c/i.test(m[2]) ? "crore" : "lakh"}` : null; };
  const extractBHK    = t => { const m = t.match(/(\d)\s*[- ]?\s*bhk/i); if (m) return `${m[1]}BHK`; if (/studio/i.test(t)) return "studio"; if (/villa|penthouse|duplex/i.test(t)) return t.match(/villa|penthouse|duplex/i)[0].toLowerCase(); return null; };
  const isQuestion = t => /\?|price|cost|rate|how much|kitna|kitne|where|location|located|kahan|airport|metro|possession|ready|hand ?over|loan|emi|finance|amenit|club|pool|gym|size|sq ?ft|square feet|carpet|commercial|shop|retail|office|builder|developer|modcon|who|when|what|why/i.test(t);

  /* offline-only mini knowledge base — lets the rule-engine Anaga actually
     ANSWER common questions (honestly, generally) instead of ignoring them. */
  const QA = [
    { re: /price|cost|rate|how much|kitna|kitne|per sq|sq ?ft|square feet|carpet/i, a: "Pricing depends on the configuration — I'll have our team share the exact price sheet, and the details are on modcon.in." },
    { re: /where|location|located|area|kahan|address|connectivity|metro|airport/i, a: "SYL Residences is in Tukkuguda, South Hyderabad — on the 200-foot Srisailam Highway, just off ORR Exit 14, about 10 to 15 minutes from the airport. I'll WhatsApp you the location and a map." },
    { re: /possession|ready|hand ?over|move ?in|when.*(complete|ready)/i, a: "I'll have our manager confirm the exact possession timeline for you on the visit." },
    { re: /loan|emi|finance|bank|mortgage/i, a: "Yes, we work with leading banks for home loans and can help with the paperwork." },
    { re: /amenit|gym|pool|clubhouse|club|park|facilit|security/i, a: "There's a 22,000 square-foot clubhouse — infinity pool, a gym with Pilates, yoga, steam and sauna, a library, co-working spaces and a banquet. The homes are low-density, biophilic villaments with large balconies." },
    { re: /commercial|shop|retail|office|business|rent/i, a: "Yes — the same Tukkuguda development has a G plus 4 commercial block: retail and dining, co-working and startups, healthcare, and business-stay suites. I can have our team share commercial options too." },
    { re: /builder|developer|who.*(build|develop)|rera|modcon/i, a: "SYL Residences is by Modcon Builders — Building Beyond Expectations. You can see our credentials on modcon.in." }
  ];
  const quickAnswer = t => { const m = QA.find(q => q.re.test(t)); return m ? m.a : null; };

  /* ---- the flow (mirrors the versioned flow JSON) ---- */
  const FLOW = {
    greet: {
      say: () => "నమస్కారం! నేను అనగ, మోడ్‌కాన్ బిల్డర్స్ నుండి AI వాయిస్ అసిస్టెంట్. తుక్కుగూడలోని మా SYL రెసిడెన్సెస్ గురించి మాట్లాడటానికి కాల్ చేస్తున్నాను. ఇది AI వాయిస్ కాల్ అని తెలియజేస్తున్నాను. మీకు ఒక నిమిషం సమయం ఉందా?",
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
      say: () => `Thanks for sharing all that. Based on a ${ctx.config} for ${ctx.purpose}, I really think our SYL Residences at Tukkuguda would suit you. Could I book you a site visit this weekend?`,
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

  /* A real phone call shows a "face" (the stage: avatar, name, status, timer) — not
     a chat log. Captions/typing live behind the Captions button: tap to read the
     live transcript or type a reply. We auto-reveal them when voice can't be used,
     so the caller can always fall back to typing. Only the mic + speaker are used. */
  function setCaptions(on) {
    if (on) {
      if (stageEl) stageEl.setAttribute("hidden", "");
      transcript.removeAttribute("hidden");
      if (textForm) textForm.removeAttribute("hidden");
    } else {
      transcript.setAttribute("hidden", "");
      if (textForm) textForm.setAttribute("hidden", "");
      if (stageEl) stageEl.removeAttribute("hidden");
    }
    if (keypadBtn) { keypadBtn.classList.toggle("is-on", !!on); keypadBtn.setAttribute("aria-pressed", String(!!on)); }
  }

  /* subtle "which mode is active" tag in the call header (no vendor names) */
  function setBrain(mode, src) {
    if (!brainEl) return;
    if (mode === "live") {
      brainEl.hidden = false;
      brainEl.className = "call__brain call__brain--live";
      brainEl.innerHTML = `<i class="dot"></i> Anaga AI`;
      brainEl.title = "Live — Anaga is answering in real time.";
    } else if (mode === "offline") {
      brainEl.hidden = false;
      brainEl.className = "call__brain call__brain--offline";
      brainEl.innerHTML = `<i class="dot"></i> Basic mode`;
      brainEl.title = "Running Anaga's on-device basic script.";
      maybeNudgeOffline();
    } else {
      brainEl.hidden = true;
      brainEl.textContent = "";
    }
  }

  /* Basic (on-device) mode can only follow a fixed flow — note it once per call. */
  function maybeNudgeOffline() {
    if (offlineNudged) return;
    offlineNudged = true;
    showNotice("💡 Anaga is in basic mode right now — her full real-time answers need the live connection.");
  }

  /* inline notice (mic blocked, etc.) */
  function showNotice(text) {
    if (!noticeEl) return;
    noticeEl.textContent = text;
    noticeEl.hidden = false;
  }
  function clearNotice() { if (noticeEl) { noticeEl.hidden = true; noticeEl.textContent = ""; } }

  /* ---- free-flow helpers (echo filter, barge-in, smart endpointing) ---- */
  const norm = s => (s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

  /* never let a single async step (Sarvam STT, on-device translate, a stuck
     <audio>) hang the whole call: race it against a timeout so we always fall
     back to the next step instead of freezing on "Transcribing…" / silence. */
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve(promise),
      new Promise(res => setTimeout(() => res(fallback), ms))
    ]);
  }

  /* is this recognized text most likely Anaga's own voice echoing into the mic? */
  function isLikelyEcho(candidate) {
    if (!currentSpokenNorm) return false;
    const words = norm(candidate).split(" ").filter(w => w.length > 2);
    if (!words.length) return false;
    const hit = words.filter(w => currentSpokenNorm.includes(w)).length;
    return hit / words.length >= 0.6;     // mostly her own words → treat as echo
  }

  /* caller talks over Anaga → stop her immediately and start listening */
  function bargeIn() {
    speakToken++;                         // any in-flight TTS onend becomes a no-op
    try { synth && synth.cancel(); } catch (e) {}
    CloudTTS.stop();
    currentSpokenNorm = "";
    pendingEnd = null;
    phase = "listening";
    setStatus("Listening… (go ahead)", "is-listening");
    /* keep the auto-restart loop alive and make sure recognition is actually
       running, so a barge-in never lands us in a dead, non-restarting state. */
    if (micCapable && !micMuted) {
      wantListen = true;
      setMic(true);
      if (!listening) { try { recog.start(); } catch (e) {} }
    }
    startRec();                           // capture the interrupting utterance for Sarvam STT
    armEndpoint();                         // a one-word interruption then silence still ends the turn
  }

  /* wait for a real pause before ending the caller's turn (natural endpointing) */
  function armEndpoint() {
    if (endpointTimer) clearTimeout(endpointTimer);
    endpointTimer = setTimeout(() => {
      endpointTimer = null;
      if (!active || phase !== "listening") return;
      const t = pendingUtter.trim();
      pendingUtter = "";
      if (useSarvamStt() && recording) {
        /* show progress the instant the turn ends so it never feels frozen, then
           ship the recorded audio to Sarvam (handleUtterance does the round-trip).
           Commit to "thinking" now so a late recog result can't re-arm a 2nd
           endpoint or double-submit while stopRec() is resolving. */
        phase = "thinking";
        setStatus("Anaga is thinking…", null);
        stopRec().then(blob => {
          if (!active) return;
          phase = "listening";            // handleUtterance re-asserts "thinking"; this lets it run
          if (blob || t) handleUtterance(t, blob);
          else startListening();          // nothing captured → re-arm, never a dead state
        });
      } else if (t) {
        handleUtterance(t, null);
      } else {
        startListening();                  // silence with nothing to send → keep listening
      }
    }, ENDPOINT_MS);
  }

  /* split a line into sentences so cloud TTS can start on a short first chunk
     (lower latency) and pause naturally between sentences. Avoids regex
     look-behind for broad browser support. */
  function splitSentences(text) {
    const s = String(text);
    const raw = s.match(/[^.?!।]+[.?!।]+|\S[^.?!।]*$/g) || [s];
    const out = [];
    for (let p of raw) {
      p = p.trim();
      if (!p) continue;
      if (out.length && (p.length < 14 || out[out.length - 1].length < 14)) out[out.length - 1] += " " + p;
      else out.push(p);
    }
    return out.length ? out : [s];
  }

  /* ---- Sarvam STT capture (records each utterance for accurate, auto-language transcription) ---- */
  function useSarvamStt() { return window.SarvamSTT && SarvamSTT.isOn() && !!sttStream; }
  function startRec() {
    if (!useSarvamStt() || recording) return;
    try {
      recChunks = [];
      mediaRec = new MediaRecorder(sttStream);
      mediaRec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
      mediaRec.start();
      recording = true;
    } catch (e) { mediaRec = null; recording = false; }
  }
  function stopRec() {
    return new Promise(resolve => {
      if (!mediaRec || !recording) { recording = false; resolve(null); return; }
      recording = false;
      mediaRec.onstop = () => {
        const blob = recChunks.length ? new Blob(recChunks, { type: recChunks[0].type || "audio/webm" }) : null;
        recChunks = []; mediaRec = null; resolve(blob);
      };
      try { mediaRec.stop(); } catch (e) { mediaRec = null; resolve(null); }
    });
  }
  function stopSttCapture() {
    try { if (mediaRec && recording) mediaRec.stop(); } catch (e) {}
    recording = false; mediaRec = null; recChunks = [];
    if (sttStream) { try { sttStream.getTracks().forEach(t => t.stop()); } catch (e) {} sttStream = null; }
  }

  /* ---- speaking & listening ---- */
  /* speak `display` (already in the caller's language) in `ttsLang`, record
     `histText` (English) for review/LLM, then continue or end the call. */
  function speakLine(display, endInfo, opts) {
    opts = opts || {};
    addBubble("anaga", display);
    history.push({ role: "agent", text: opts.histText || display });
    phase = "speaking";
    currentSpokenNorm = norm(display);
    setStatus(BARGE_IN ? "Anaga is speaking… (you can jump in)" : "Anaga is speaking…", "is-speaking");

    /* keep the mic hot during speech so the caller can barge in */
    if (BARGE_IN && CONTINUOUS && micCapable && !micMuted) {
      wantListen = true;
      setMic(true);
      if (!listening) { try { recog.start(); } catch (e) {} }
    } else {
      setMic(false);
    }

    const lang = opts.lang || CALL_LANG;
    const chunks = splitSentences(display);
    const myToken = ++speakToken;       // barge-in / a newer line bumps this → stale onends no-op
    let i = 0;
    let chunkWd = null;                 // per-chunk watchdog: never wait forever on a TTS onend
    const clearWd = () => { if (chunkWd) { clearTimeout(chunkWd); chunkWd = null; } };
    let graceTries = 0;                 // bounded retries while a streaming end resolves
    const speakNext = () => {
      clearWd();
      if (myToken !== speakToken || !active) return;        // superseded
      if (i >= chunks.length) {                             // whole line delivered
        currentSpokenNorm = "";
        const finalize = () => {
          if (myToken !== speakToken || !active) return;
          const ei = (typeof endInfo === "function") ? endInfo() : endInfo;
          if (ei) return finishCall(ei);
          return (opts.onDone || startListening)();
        };
        // streaming may resolve end-of-call a beat late — poll a few short graces
        // for pendingEnd, but never stall: fall through to listening after ~1.5s.
        if (typeof endInfo === "function" && endInfo() == null && graceTries < 3) {
          graceTries++; setTimeout(speakNext, 500); return;
        }
        return finalize();
      }
      const piece = chunks[i++];
      if (window.CloudTTS && CloudTTS.isOn() && chunks[i]) CloudTTS.prefetch(chunks[i], lang, opts.voice || currentVoice());
      let advanced = false;
      const advance = () => { if (advanced) return; advanced = true; clearWd(); if (myToken === speakToken) speakNext(); };
      speakText(piece, lang, { voice: opts.voice, onend: advance });
      /* watchdog: a pure "nothing fired at all" net. The CloudTTS <audio> and the
         browser synth each resolve onend on their own (incl. their own duration
         caps), so this only catches the case where neither calls back. Keep it
         generous so it never clips a legitimately long line. */
      const budget = Math.min(30000, 5000 + piece.split(/\s+/).length * 600);
      chunkWd = setTimeout(advance, budget);
    };
    speakNext();
  }

  /* Speak Anaga's next line. The LLM brain already replies in the caller's
     language, so we speak it as-is. The offline FLOW emits English, so when the
     call is in another language we translate it first (opts.translate). */
  function deliver(line, endInfo, opts) {
    opts = opts || {};
    if (opts.translate && translateOn && callBase !== "en" && window.TranslateKit) {
      setStatus("Anaga is speaking…", "is-speaking");
      /* time-box the on-device translate so a wedged model can't leave Anaga
         silent — fall back to speaking the English line on timeout. */
      withTimeout(TranslateKit.out(line, callBase), 5000, null)
        .then(tr => speakLine(tr || line, endInfo, { lang: callLang, histText: line }))
        .catch(() => speakLine(line, endInfo, { lang: callLang, histText: line }));
      return;
    }
    speakLine(line, endInfo, { lang: opts.lang || callLang });
  }

  /* offline path: speak a FLOW step (mirrors the versioned flow JSON) */
  function sayStep(id) {
    const step = FLOW[id];
    stepId = id;
    const endInfo = step.end
      ? { reason: step.optout ? "Opt-out recorded · call ended" : "Call ended", optout: !!step.optout }
      : null;
    // The opening line is always spoken in Telugu; other steps translate to the caller's language.
    if (id === "greet") deliver(step.say(), endInfo, { lang: "te-IN" });
    else deliver(step.say(), endInfo, { translate: true });
  }

  /* arm continuous listening (no "tap to speak"): keep the mic hot for the
     caller's whole turn, ending it only after a natural pause (armEndpoint). */
  function startListening() {
    if (!active) return;
    phase = "listening";
    pendingUtter = "";
    if (!micCapable || micMuted) {           // can't / shouldn't listen → invite typing
      setStatus(micMuted ? "Muted — tap the mic to talk" : "Your turn — type your reply below ⌨️", null);
      if (!micMuted && textInput) textInput.focus();
      setMic(false);
      return;
    }
    wantListen = true;
    setStatus("Listening… speak now", "is-listening");
    setMic(true);
    if (!listening) { try { recog.start(); } catch (e) { /* already started */ } }
  }

  /* `text` is the Web Speech transcript (or typed input); `blob`, when present,
     is the recorded audio for accurate Sarvam transcription + language detection. */
  function handleUtterance(text, blob) {
    if (!active || phase === "thinking") return;
    if (endpointTimer) { clearTimeout(endpointTimer); endpointTimer = null; }
    pendingUtter = "";
    phase = "thinking";
    setMic(false);
    clearInterim();
    text = (text || "").trim();

    /* 🟢 Sarvam STT: transcribe the caller's own audio for an accurate transcript
       AND the detected language (Telugu / Hindi / English / code-mix). This is
       what makes auto language switching work from real client input.
       LATENCY: the round-trip only earns its keep when we need language detection
       (auto mode) OR when Web Speech gave us nothing to work with. In a fixed-
       language call where Web Speech already produced words, skip the upload and
       advance instantly — no per-turn round-trip, no "Transcribing…" pause. */
    if (useSarvamStt() && blob && !(text && !autoMode)) {
      setStatus("Transcribing…", null);
      /* if Web Speech already gave us words, fall back faster — no need to wait long. */
      const ms = text ? 6000 : 9000;
      withTimeout(SarvamSTT.transcribe(blob, autoMode ? "unknown" : callLang), ms, null)
        .then(r => {
          if (!active) return;
          const t = ((r && r.transcript) || text || "").trim();
          const base = (autoMode && r && r.language_code) ? String(r.language_code).split("-")[0] : null;
          if (!t) { startListening(); return; }       // nothing heard → re-arm, never stuck
          consumeUtterance(t, base);
        })
        .catch(() => { if (!active) return; if (text) consumeUtterance(text, null); else startListening(); });
      return;
    }

    if (!text) { startListening(); return; }

    /* Web Speech path: detect the language on-device (auto mode) like before. */
    if (autoMode && window.TranslateKit && TranslateKit.available() && TranslateKit.hasDetector()) {
      TranslateKit.detect(text)
        .then(base => { if (!active) return; consumeUtterance(text, shouldSwitch(base, text) ? base : null); })
        .catch(() => consumeUtterance(text, null));
    } else {
      consumeUtterance(text, null);
    }
  }

  /* show the final transcript, switch language if detected, then ask the brain.
     The caller's ACTUAL words (their language) go to the brain — the LLM replies
     in kind; the offline FLOW translates on demand for its keyword matching. */
  function consumeUtterance(text, switchToBase) {
    if (!active) return;
    addBubble("you", text);
    setStatus("Anaga is thinking…", null);
    const advance = () => {
      history.push({ role: "user", text });
      /* tiny defer just lets the "you" bubble paint before Anaga replies — keep it
         short so the offline path doesn't feel laggy. */
      if (brainMode === "offline") { setTimeout(nextOfflineTurn, 60); return; }
      nextLiveTurn();
    };
    if (switchToBase && switchToBase !== callBase) applyLanguage(switchToBase).then(advance, advance);
    else advance();
  }

  /* offline rule-engine turn (also the fallback used the moment the backend fails).
     The caller's words are in their own language; when the call isn't English we
     translate them to English first so the keyword matching still works. */
  function nextOfflineTurn() {
    if (!active) return;
    const lastUser = [...history].reverse().find(m => m.role === "user");
    const said = lastUser ? lastUser.text : "";
    const proceed = (matchText) => {
      if (!active) return;
      /* answer a question first (then re-ask the current step), instead of
         blindly advancing — makes the offline script feel responsive. */
      const qualifying = ["purpose", "budget", "config", "timeline", "offer"].includes(stepId);
      const qa = quickAnswer(matchText);
      if (qa && isQuestion(matchText) && qualifying && !optout(matchText)) {
        const cur = FLOW[stepId];
        deliver(qa + " " + (cur && cur.say ? cur.say() : ""), null, { translate: true });
        return;
      }
      const step = FLOW[stepId] || FLOW.greet;
      const nextId = (step.next ? step.next(matchText, ctx) : null) || "callback";
      sayStep(nextId);
    };
    if (translateOn && callBase !== "en" && window.TranslateKit && said) {
      /* never let a wedged on-device translator strand the turn in "thinking" —
         time-box it and proceed with the original words on timeout. */
      withTimeout(TranslateKit.in(said, callBase), 5000, said)
        .then(en => proceed(en || said)).catch(() => proceed(said));
    } else {
      proceed(said);
    }
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
    pendingEnd = null;

    /* BYOK: stream Gemini's tokens and start speaking the moment the line is
       ready. The end/disposition arrive before the spoken audio finishes, so
       speakLine resolves the hang-up via the () => pendingEnd callback. */
    if (window.AnagaBrain && AnagaBrain.hasKey() && AnagaBrain.turnStream) {
      let spoke = false;
      AnagaBrain.turnStream({
        history,
        onText: (sayText) => {
          if (!active || spoke || !sayText) return;
          spoke = true;
          if (brainMode !== "live") { brainMode = "live"; setBrain("live", "your key"); }
          deliver(String(sayText), () => pendingEnd);
        }
      })
        .then((d) => {
          if (!active) return;
          if (brainMode !== "live") { brainMode = "live"; setBrain("live", "your key"); }
          if (d && d.disposition) lastDisposition = d.disposition;
          const endInfo = (d && d.end)
            ? { reason: d.disposition === "opt-out" ? "Opt-out recorded · call ended" : "Call ended",
                optout: d.disposition === "opt-out" }
            : null;
          if (!spoke) deliver((d && d.say) ? String(d.say) : "Sorry, could you say that again?", endInfo);
          else pendingEnd = endInfo;
        })
        .catch(() => {
          if (!active) return;
          if (brainMode !== "offline") { brainMode = "offline"; setBrain("offline"); }
          nextOfflineTurn();
        });
      return;
    }

    /* server (/api) — non-streaming JSON turn */
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
    recog.onstart = () => {
      listening = true;
      if (phase === "listening") { setMic(true); setStatus("Listening… speak now", "is-listening"); }
    };
    /* speech-boundary events are language-agnostic (acoustic, not transcript) —
       they make Sarvam capture work even when Web Speech can't transcribe the
       caller's language (e.g. Telugu while recog.lang is still en-IN). */
    recog.onspeechstart = () => {
      if (!active) return;
      if (phase === "listening") {
        if (endpointTimer) { clearTimeout(endpointTimer); endpointTimer = null; }  // resumed → don't cut off
        startRec();
      }
    };
    recog.onspeechend = () => {
      if (active && useSarvamStt() && recording && phase === "listening") armEndpoint();
    };
    recog.onresult = e => {
      let interim = "", finalT = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalT += r[0].transcript; else interim += r[0].transcript;
      }
      const heard = (finalT || interim).trim();

      /* barge-in: the caller starts talking while Anaga is speaking */
      if (phase === "speaking") {
        if (!BARGE_IN || heard.length < BARGEIN_MIN_CHARS || isLikelyEcho(heard)) return;
        bargeIn();                          // stop her, switch to listening, then capture below
      }
      if (phase !== "listening") return;    // ignore stray results while thinking/idle

      if (useSarvamStt()) startRec();        // record this utterance for accurate transcription
      const shown = useSarvamStt() ? "…" : null;   // don't show Web Speech's garbled non-English interim
      if (interim) { showInterim(shown || (pendingUtter ? pendingUtter + " " + interim : interim)); armEndpoint(); }
      if (finalT)  { pendingUtter = (pendingUtter ? pendingUtter + " " : "") + finalT.trim(); showInterim(shown || pendingUtter); armEndpoint(); }
    };
    recog.onerror = ev => {
      listening = false;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        /* pause the auto-restart loop, but keep the mic tappable — a tap is a
           user gesture and can re-arm it (mobile often needs that). */
        wantListen = false; setMic(false);
        if (phase === "listening") { setStatus("Mic paused — tap the mic, or type below", null); if (textInput) textInput.focus(); }
      }
      /* no-speech / aborted / network are transient → onend auto-restarts */
    };
    recog.onend = () => {
      listening = false;
      if (active && wantListen && micCapable && !micMuted) {
        try { recog.start(); }
        catch (e) { setTimeout(() => { if (active && wantListen && !listening) { try { recog.start(); } catch (_) {} } }, 250); }
      } else {
        setMic(false);
      }
    };
  }

  /* Round phone-style Mute button: reflects mute state (highlighted when muted).
     The `on` (listening) arg is accepted for back-compat but the visual is driven
     by micMuted / micCapable. */
  function setMic(on) {
    const ico = document.getElementById("call-mic-ico");
    const lbl = document.getElementById("call-mic-label");
    if (!micCapable) {
      micBtn.classList.remove("is-on");
      micBtn.setAttribute("aria-pressed", "false");
      if (ico) ico.textContent = "🎤";
      if (lbl) lbl.textContent = "No mic";
      return;
    }
    micBtn.classList.toggle("is-on", micMuted);
    micBtn.setAttribute("aria-pressed", String(micMuted));
    if (ico) ico.textContent = micMuted ? "🔇" : "🎙️";
    if (lbl) lbl.textContent = micMuted ? "Unmute" : "Mute";
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
        ? "🎤 The microphone needs a secure page — open this on the secure https:// link or via http://localhost. On a file:// or plain http page browsers block the mic. You can still type your replies below."
        : "🎤 Microphone isn't available in this browser — use Chrome or Edge, or type your replies below.");
      return Promise.resolve(false);
    }
    setStatus("Requesting microphone…", null);
    return md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(stream => {
        /* keep the stream alive for Sarvam STT recording; otherwise we only
           needed the permission, so release it. */
        if (window.SarvamSTT && SarvamSTT.isOn()) { stopSttCapture(); sttStream = stream; }
        else { stream.getTracks().forEach(t => t.stop()); }
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
    micCapable = !!(recog && granted);
    micBtn.disabled = false;
    micBtn.classList.toggle("is-disabled", !micCapable);
    setMic(false);
  }

  /* ---- lifecycle ---- */
  function resetCall() {
    ctx = {}; stepId = null;
    history = []; lastDisposition = "qualifying"; brainMode = null;
    phase = "idle"; micMuted = false; wantListen = false; offlineNudged = false;
    pendingUtter = ""; pendingEnd = null; currentSpokenNorm = "";
    liveMode = false; liveUserEl = liveAgentEl = null; liveUserTxt = ""; liveAgentTxt = "";
    if (window.LiveCall && LiveCall.stop) { try { LiveCall.stop(); } catch (e) {} }   // end any leaked live session
    if (endpointTimer) { clearTimeout(endpointTimer); endpointTimer = null; }
    stopTimer(); if (timerEl) timerEl.textContent = "";
    stopSttCapture();                  // release any mic stream / recorder from a prior call
    transcript.innerHTML = "";
    if (reviewEl) { reviewEl.hidden = true; reviewEl.innerHTML = ""; }
    { const l = document.getElementById("call-end-label"); if (l) l.textContent = "End"; }
    setCaptions(false);                                  // start on the phone "face" (captions hidden)
    if (speakerBtn) { speakerBtn.setAttribute("aria-pressed", "true"); speakerBtn.classList.add("is-on"); }
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
    startTimer();                    // phone-call timer
    updateCallVoice();
    setTimeout(updateCallVoice, 1600);   // reflect cloud speaker once the probe resolves

    /* language for this call comes from the active hero language pill.
       "auto" → detect the caller's language on the fly. */
    const activePill = document.querySelector('#voice-demo .lang-pill.is-active');
    const sel = (activePill && activePill.dataset.lang) || "en-IN";
    autoMode = (sel === "auto");
    callLang = autoMode ? "en-IN" : sel;
    callBase = callLang.split("-")[0];
    translateOn = false;
    notedLang = null;
    if (recog) recog.lang = callLang;

    /* Prefer the REAL-TIME Gemini Live engine (true full-duplex, sub-second,
       natively multilingual, 0 Sarvam credits). Try it unless the probe has
       CONFIRMED it can't run — this avoids a first-click race where the probe
       hasn't resolved yet. startLiveCall() falls back to turn-based on any error. */
    if (window.LiveCall && LiveCall.isUnavailable && !LiveCall.isUnavailable()) { startLiveCall(); return; }
    startTurnBasedCall();
  }

  /* ---- real-time path (Gemini Live: Gemini hears & speaks itself) ---- */
  function startLiveCall() {
    liveMode = true;
    liveUserEl = liveAgentEl = null; liveUserTxt = ""; liveAgentTxt = "";
    setStatus("Connecting…", null);
    setBrain("live");
    addBubble("anaga", "🔴 Live call — just talk. Reply in English, हिंदी, or తెలుగు and I'll match you. You can interrupt me any time.");
    let connected = false;
    const toFallback = () => {
      if (!active) return;
      liveMode = false;
      try { LiveCall.stop(); } catch (e) {}
      setBrain(null);
      showNotice("⚡ Real-time mode couldn't start — switching to the standard call.");
      startTurnBasedCall();
    };
    LiveCall.start({
      lang: autoMode ? "" : callLang,
      onStatus: (state) => {
        if (!active || !liveMode) return;
        if (state === "connecting") setStatus("Connecting…", null);
        else if (state === "listening") { connected = true; clearNotice(); setStatus("🔴 Live — just talk", "is-listening"); setMic(true); }
        else if (state === "speaking") { connected = true; setStatus("Anaga is speaking… (jump in any time)", "is-speaking"); }
        else if (state === "closed") { if (active && liveMode) finishCall({ reason: "Call ended" }); }
      },
      onUserText: (t) => { if (active && liveMode) liveBubble("you", t); },
      onAgentText: (t) => { if (active && liveMode) liveBubble("anaga", t); },
      onError: () => {
        if (!active || !liveMode) return;
        if (!connected) toFallback();                 // never connected → use the fallback engine
        else { showNotice("⚠️ The live connection dropped."); finishCall({ reason: "Call ended" }); }
      },
      onClose: () => { /* "closed" status handles end-of-call */ }
    }).catch(toFallback);
  }

  /* coalesce streaming Live transcripts into one bubble per speaker turn, and
     record them in `history` so the post-call review still works. */
  function liveBubble(who, text) {
    if (who === "you") {
      if (liveAgentEl) finalizeLive("anaga");
      liveUserTxt += text;
      if (!liveUserEl) liveUserEl = addBubble("you", "");
      liveUserEl.querySelector(".bubble__txt").textContent = liveUserTxt;
    } else {
      if (liveUserEl) finalizeLive("you");
      liveAgentTxt += text;
      if (!liveAgentEl) liveAgentEl = addBubble("anaga", "");
      liveAgentEl.querySelector(".bubble__txt").textContent = liveAgentTxt;
    }
    transcript.scrollTop = transcript.scrollHeight;
  }
  function finalizeLive(who) {
    if (who === "anaga" && liveAgentEl) {
      if (liveAgentTxt.trim()) history.push({ role: "agent", text: liveAgentTxt.trim() });
      liveAgentEl = null; liveAgentTxt = "";
    }
    if (who === "you" && liveUserEl) {
      if (liveUserTxt.trim()) history.push({ role: "user", text: liveUserTxt.trim() });
      liveUserEl = null; liveUserTxt = "";
    }
  }

  /* ---- turn-based path (Web Speech / Sarvam STT → brain → TTS), the fallback ---- */
  function startTurnBasedCall() {
    setStatus("Connecting…", null);
    requestMicSafe().then(granted => {
      if (!active) return;            // closed while the prompt was open
      micAllowed = granted;
      configureMicButton(granted);
      if (!recog || !granted) setCaptions(true);   // no voice → reveal captions so they can read + type
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
    active = false; listening = false; wantListen = false; phase = "idle";
    speakToken++;                       // invalidate any in-flight TTS onend
    if (liveMode) { finalizeLive("you"); finalizeLive("anaga"); try { LiveCall.stop(); } catch (e) {} liveMode = false; }
    if (endpointTimer) { clearTimeout(endpointTimer); endpointTimer = null; }
    if (recog) try { recog.abort(); } catch (e) {}
    synth && synth.cancel();
    CloudTTS.stop();
    stopSttCapture();                   // stop recording + release the mic stream
    stopTimer();
    setMic(false);
    setStatus(reason, null);
    if (stageEl) stageEl.setAttribute("hidden", "");    // swap the call face for the review card
    { const l = document.getElementById("call-end-label"); if (l) l.textContent = "Close"; }
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

  /* pre-warm the live engine (pre-mint the ephemeral token) the instant the call
     button is pressed, so the click→first-audio path skips the mint round-trip. */
  startBtn.addEventListener("pointerdown", () => { if (window.LiveCall && LiveCall.prewarm) LiveCall.prewarm(); }, { passive: true });
  startBtn.addEventListener("click", startCall);
  /* End call: hang up and SHOW the review (overlay stays). If the call already
     ended (review on screen), the same button dismisses the overlay. */
  if (endBtn) endBtn.addEventListener("click", () => { if (active) finishCall({ reason: "Call ended" }); else closeCall(); });
  micBtn.addEventListener("click", () => {
    if (!active) return;
    if (liveMode) {                          // real-time call → mute/unmute the live mic
      micMuted = !micMuted;
      try { LiveCall.mute(micMuted); } catch (e) {}
      setMic(!micMuted);
      setStatus(micMuted ? "🔇 Muted — tap to talk" : "🔴 Live — just talk", micMuted ? null : "is-listening");
      return;
    }
    if (!micCapable) {                       // can't listen → guide to typing (always responsive)
      showNotice(recog
        ? "🎤 Mic needs permission on a secure page (https or localhost). Type your reply below — Anaga will still respond."
        : "🎤 Voice input isn't supported in this browser (try Chrome/Edge). Type your reply below — Anaga will still respond.");
      if (textInput) textInput.focus();
      return;
    }
    /* continuous mic: tap to mute while listening; tap to (re)arm otherwise.
       Tapping is a user gesture, so it also recovers a mic paused by an error. */
    if (micMuted) { micMuted = false; startListening(); return; }
    if (!wantListen || !listening) { startListening(); return; }
    micMuted = true;
    wantListen = false;
    if (endpointTimer) { clearTimeout(endpointTimer); endpointTimer = null; }
    try { recog.stop(); } catch (e) {}
    setMic(false);
    setStatus("Muted — tap the mic when you're ready", null);
  });
  textForm.addEventListener("submit", e => {
    e.preventDefault();
    const t = textInput.value;
    textInput.value = "";
    if (liveMode) { showNotice("🔴 Live call is voice-only — just speak. (Typing works in the standard call.)"); return; }
    if (listening && recog) { try { recog.stop(); } catch (e) {} }
    handleUtterance(t);
  });
  /* Captions: show/hide the live transcript + type-to-reply panel over the call face. */
  if (keypadBtn) keypadBtn.addEventListener("click", () => {
    if (!active) return;
    const turnOn = transcript.hasAttribute("hidden");   // captions currently hidden → show them
    setCaptions(turnOn);
    if (turnOn && textInput) textInput.focus();
  });
  /* Speaker: visual loudspeaker toggle (web audio always uses the default output). */
  if (speakerBtn) speakerBtn.addEventListener("click", () => {
    const on = speakerBtn.getAttribute("aria-pressed") === "true";
    speakerBtn.setAttribute("aria-pressed", String(!on));
    speakerBtn.classList.toggle("is-on", !on);
  });
  overlay.addEventListener("click", e => { if (e.target.matches("[data-call-close]")) closeCall(); });
  document.addEventListener("keydown", e => { if (!overlay.hidden && e.key === "Escape") closeCall(); });
})();

/* stop any speech when the Playbook opens */
openBtn.addEventListener("click", () => { if (synth) synth.cancel(); CloudTTS.stop(); });

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

/* ===================================================================
   VOICE LAB — real-time frequency meter + voice modulator
   - Spectrum analyzer (Web Audio AnalyserNode) reacts to your mic and to
     Anaga's previewed voice (decoded Sarvam audio = real FFT; browser TTS
     can't be tapped, so a synthetic meter animates instead).
   - Pitch / Pace / Loudness sliders set the global `modulation`, applied to
     both the browser voice and the Sarvam request.
   =================================================================== */
(function voiceLab() {
  const canvas = document.getElementById("vlab-meter");
  if (!canvas) return;
  const cx = canvas.getContext("2d");
  const micBtn = document.getElementById("vlab-mic");
  const prevBtn = document.getElementById("vlab-preview");
  const note = document.getElementById("vlab-note");
  const sl = {
    pitch: document.getElementById("vlab-pitch"),
    pace: document.getElementById("vlab-pace"),
    loud: document.getElementById("vlab-loud")
  };
  const val = {
    pitch: document.getElementById("vlab-pitch-v"),
    pace: document.getElementById("vlab-pace-v"),
    loud: document.getElementById("vlab-loud-v")
  };

  let ctx = null, analyser = null, freq = null;
  let micStream = null, micSrc = null, bufSrc = null;
  let mode = "idle";                 // idle | mic | buffer | synthetic
  let synthUntil = 0;
  const BARS = 56;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    freq = new Uint8Array(analyser.frequencyBinCount);
    return ctx;
  }
  function stopSources() {
    if (bufSrc) { try { bufSrc.stop(); } catch (e) {} try { bufSrc.disconnect(); } catch (e) {} bufSrc = null; }
    if (micSrc) { try { micSrc.disconnect(); } catch (e) {} micSrc = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  }

  /* ---- drawing ---- */
  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 900;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(170 * dpr);
  }
  function sampleBars() {
    analyser.getByteFrequencyData(freq);
    const out = new Array(BARS);
    const usable = Math.floor(freq.length * 0.7);     // ignore the empty top end
    for (let i = 0; i < BARS; i++) {
      const start = Math.floor((i / BARS) * usable);
      const end = Math.floor(((i + 1) / BARS) * usable);
      let sum = 0; for (let j = start; j < end; j++) sum += freq[j];
      out[i] = (sum / Math.max(1, end - start)) / 255;
    }
    return out;
  }
  function syntheticBars(t) {
    const out = new Array(BARS);
    for (let i = 0; i < BARS; i++) {
      const env = Math.sin((i / BARS) * Math.PI);     // louder in the middle
      const wob = 0.5 + 0.5 * Math.sin(t * 0.012 + i * 0.5) * Math.sin(t * 0.03 + i);
      out[i] = Math.max(0.04, env * (0.35 + 0.6 * wob) * (0.7 + 0.3 * Math.random()));
    }
    return out;
  }
  function idleBars(t) {
    const out = new Array(BARS);
    for (let i = 0; i < BARS; i++) out[i] = 0.06 + 0.05 * (0.5 + 0.5 * Math.sin(t * 0.002 + i * 0.4));
    return out;
  }
  function drawBars(data) {
    const w = canvas.width, h = canvas.height;
    cx.clearRect(0, 0, w, h);
    const gap = Math.max(2, w / BARS * 0.18);
    const bw = (w - gap * (BARS - 1)) / BARS;
    for (let i = 0; i < BARS; i++) {
      const bh = Math.max(2, data[i] * h * 0.92);
      const x = i * (bw + gap), y = (h - bh) / 2;     // center-mirrored
      const g = cx.createLinearGradient(0, y, 0, y + bh);
      g.addColorStop(0, "#ffb066");
      g.addColorStop(0.5, "#ff8a3d");
      g.addColorStop(1, "#6d8bff");
      cx.fillStyle = g;
      const r = Math.min(bw / 2, 4);
      cx.beginPath();
      cx.roundRect ? cx.roundRect(x, y, bw, bh, r) : cx.rect(x, y, bw, bh);
      cx.fill();
    }
  }
  function loop() {
    requestAnimationFrame(loop);
    const t = performance.now();
    let data;
    if ((mode === "mic" || mode === "buffer") && analyser) data = sampleBars();
    else if (mode === "synthetic" && t < synthUntil) data = syntheticBars(t);
    else { if (mode === "synthetic") mode = "idle"; data = idleBars(t); }
    drawBars(data);
  }

  /* ---- mic ---- */
  function micOn() {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia || (typeof window.isSecureContext !== "undefined" && !window.isSecureContext)) {
      setNote("🎤 The mic needs a secure page (https or localhost)."); return;
    }
    if (!ensureCtx()) { setNote("Web Audio isn't supported in this browser."); return; }
    md.getUserMedia({ audio: true }).then(stream => {
      ctx.resume && ctx.resume();
      stopSources();
      micStream = stream;
      micSrc = ctx.createMediaStreamSource(stream);
      micSrc.connect(analyser);              // analyser only → no feedback
      mode = "mic";
      micBtn.classList.add("is-on");
      micBtn.textContent = "■ Stop mic";
      setNote("Listening to your mic — speak to see your frequencies.");
    }).catch(() => setNote("🎤 Microphone permission was blocked."));
  }
  function micOff() {
    stopSources();
    mode = "idle";
    micBtn.classList.remove("is-on");
    micBtn.textContent = "🎤 Visualize my voice";
  }

  /* ---- preview Anaga (with current voice + modulation) ---- */
  const b64ToBuf = b64 => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
  function previewLine() {
    const pill = document.querySelector('#voice-demo .lang-pill.is-active');
    let l = pill ? pill.dataset.lang : "en-IN"; if (l === "auto") l = "en-IN";
    return { lang: l, text: "Hi, I'm Anaga, your AI voice agent. This is how I sound right now." };
  }
  function preview() {
    if (mode === "mic") micOff();
    const { lang, text } = previewLine();
    const preset = currentVoice();
    if (window.CloudTTS && CloudTTS.isOn() && ensureCtx()) {
      setNote("Synthesizing " + preset.name + "…");
      CloudTTS.fetchAudio(text, lang, preset).then(d => {
        if (!d || !d.audio) throw new Error("no audio");
        ctx.resume && ctx.resume();
        return ctx.decodeAudioData(b64ToBuf(d.audio));
      }).then(buf => {
        stopSources();
        bufSrc = ctx.createBufferSource();
        bufSrc.buffer = buf;
        bufSrc.connect(ctx.destination);     // audible
        bufSrc.connect(analyser);            // analysed
        bufSrc.onended = () => { mode = "idle"; };
        bufSrc.start();
        mode = "buffer";
        setNote("🟢 " + preset.name + " — live frequencies.");
      }).catch(() => { setNote("Using the on-device voice."); browserPreview(text, lang, preset); });
    } else {
      browserPreview(text, lang, preset);
    }
  }
  function browserPreview(text, lang, preset) {
    setNote(preset.name + " — on-device voice (synthetic meter).");
    speakText(text, lang, { voice: preset });   // browserSpeak triggers vlabOnSynthetic
  }

  /* browser-TTS hook: animate a synthetic meter for the spoken duration */
  vlabOnSynthetic = (ms) => { if (mode !== "mic") { mode = "synthetic"; synthUntil = performance.now() + (ms || 1500); } };

  /* ---- sliders / modulation ---- */
  function fmtSigned(n) { return (n > 0 ? "+" : "") + n + "%"; }
  function syncLabels() {
    val.pitch.textContent = fmtSigned(modulation.pitch);
    val.pace.textContent = fmtSigned(modulation.pace);
    val.loud.textContent = modulation.loud + "%";
  }
  function syncSliders() {
    sl.pitch.value = modulation.pitch; sl.pace.value = modulation.pace; sl.loud.value = modulation.loud;
    syncLabels();
  }
  sl.pitch.addEventListener("input", () => { setModulation({ pitch: +sl.pitch.value }); syncLabels(); });
  sl.pace.addEventListener("input", () => { setModulation({ pace: +sl.pace.value }); syncLabels(); });
  sl.loud.addEventListener("input", () => { setModulation({ loud: +sl.loud.value }); syncLabels(); });
  document.getElementById("vlab-reset").addEventListener("click", () => {
    setModulation({ pitch: 0, pace: 0, loud: 100 }); syncSliders(); setNote("Modulation reset.");
  });

  function setNote(t) { if (note) note.textContent = t; }

  micBtn.addEventListener("click", () => { mode === "mic" ? micOff() : micOn(); });
  prevBtn.addEventListener("click", preview);
  window.addEventListener("resize", fit);

  fit();
  syncSliders();
  setNote("Tap “Preview Anaga” to hear & see the current voice, or visualize your mic. Move the sliders to modulate.");
  requestAnimationFrame(loop);
})();
