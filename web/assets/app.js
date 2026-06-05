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
