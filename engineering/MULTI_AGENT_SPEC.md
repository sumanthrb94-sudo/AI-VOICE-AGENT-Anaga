# Vaak AI — Production Build & Multi-Agent Engineering Spec

**Audience:** the engineering org — human developers and/or autonomous coding agents.
**Purpose:** a buildable, production-grade specification broken into discrete, parallelizable
work packages (WPs). Each WP is scoped so a single agent (or dev) can own it end-to-end.

> This document is the contract between the business plan and the codebase. Build to this.

---

## 1. North-star architecture

Vaak is a fleet of specialized agents behind one orchestrator. Cascaded streaming pipeline
(STT → LLM → TTS) per live call, because cascaded is debuggable, swappable, and the only sane
choice for Indian-language quality. End-to-end speech-to-speech is explicitly NOT used (no tool
support, no Indic depth, not debuggable).

```
                          ┌────────────────────────────────────────────┐
                          │              ORCHESTRATOR                    │
                          │  (work assignment, load balance, handoff)    │
                          └───┬───────────────┬───────────────┬─────────┘
                              │               │               │
                  spawn N caller agents   compliance gate   analytics/eval
                              │               │               │
        ┌─────────────────────▼──────┐  ┌─────▼─────┐  ┌──────▼───────┐
        │   CALLER AGENT (1 per call) │  │ COMPLIANCE │  │  EVAL AGENT   │
        │  ┌──────┐ ┌─────┐ ┌──────┐  │  │  AGENT     │  │ (LLM-judge +  │
        │  │ STT  │→│ LLM │→│ TTS  │  │  │ DND/consent│  │  human sample)│
        │  │Sarvam│ │     │ │Sarvam│  │  │ disclosure │  └──────┬───────┘
        │  └──────┘ └──┬──┘ └──────┘  │  │ retention  │         │ feeds back
        └──────────────┼─────────────┘  └────────────┘         ▼
                       │ tool calls                    prompt/routing improvements
                       ▼
              ┌──────────────────┐
              │  BACKEND (.NET)  │  CRM, calendar, inventory, WhatsApp, suppression list
              └──────────────────┘
```

**Tech stack (provider-abstracted — never hard-bind):**
- Orchestration framework: **Pipecat** (BSD-2) self-hosted, OR self-hosted **Bolna** (`github.com/bolna-ai/bolna`) for telephony-first dialing. Decide in WP-1.
- STT/TTS: **Sarvam** (Saaras STT, Bulbul TTS) — provider-abstracted so AI4Bharat/Bhashini can slot in.
- LLM: provider-abstracted via an interface; start with a strong hosted model, support self-hosted (Ollama/VLLM) for cost.
- Telephony: **Plivo India / Exotel** (160-series, bi-directional streaming).
- Backend: **.NET 8** (founder's strength) for CRM/calendar/inventory/compliance services.
- Datastore: Postgres (Supabase acceptable) + object storage for recordings on Indian infra.
- Infra: containerized (Docker), deploy on GCP (existing footprint). Kubernetes when concurrency demands it.

**Non-negotiable principles:**
1. Stream every stage. Target time-to-first-audio <500ms; alarm >1.2s.
2. Provider abstraction at STT/LLM/TTS/telephony boundaries. No vendor hard-coded in business logic.
3. Compliance gate fails CLOSED. No verified-clean number → no dial.
4. Everything is observed: per-call metrics, transcripts, eval scores.
5. The system prompt + conversation flow is configuration (data), not code. Versioned.

---

## 2. Repository layout (target)

```
vaak-ai/
├── docs/                      # business plan, compliance, financial notes
├── orchestrator/              # WP-2: work assignment, scaling, handoff
├── caller-agent/              # WP-3: the live conversation pipeline (Pipecat/Bolna)
│   ├── pipeline.py
│   ├── providers/             # WP-4: STT/LLM/TTS adapters (abstraction layer)
│   └── flows/                 # versioned conversation flows + prompts (data)
├── compliance-agent/          # WP-5: DND scrub, consent, disclosure, retention
├── eval-agent/                # WP-7: call scoring, flywheel
├── backend-dotnet/            # WP-6: CRM, calendar, inventory, WhatsApp, suppression API
├── dashboard/                 # WP-8: client console (campaigns, results, recordings)
├── infra/                     # WP-9: docker, k8s, CI/CD, observability
├── shared/                    # contracts, schemas, types shared across services
└── .github/                   # CI workflows, agent task templates
```

---

## 3. Work packages (spawn one agent per WP; dependencies noted)

Each WP below is written as a self-contained brief. An autonomous coding agent can be spawned
against any WP whose dependencies are met. Format per WP: **Goal · Deliverables · Done-when · Depends-on.**

### WP-0 — Compliance foundation & repo bootstrap  `[no dependencies]`
- **Goal:** Legal-to-dial + clean repo skeleton.
- **Deliverables:** repo structure above; CI skeleton; DLT/160-series/telemarketer registration tracker doc; `.env.sample`; CONTRIBUTING + agent task template in `.github/`.
- **Done-when:** repo builds green; compliance checklist in `docs/COMPLIANCE.md` with owner + status per item.

### WP-1 — Framework decision spike  `[depends: WP-0]`
- **Goal:** Choose Pipecat vs self-hosted Bolna for the caller pipeline.
- **Deliverables:** a spike that runs ONE real Sarvam+LLM+Plivo call on each; latency + DX + Indian-language quality notes; a decision record (ADR).
- **Done-when:** ADR merged with a clear pick and rationale. All later WPs build on it.

### WP-2 — Orchestrator  `[depends: WP-1]`
- **Goal:** Spawn/track caller agents, balance load, manage human handoff.
- **Deliverables:** job queue; concurrency tiers; agent lifecycle (spawn → run → teardown); handoff API; healthchecks.
- **Done-when:** can run N concurrent simulated calls and warm-transfer one to a human endpoint.

### WP-3 — Caller agent pipeline  `[depends: WP-1]`
- **Goal:** Production streaming STT→LLM→TTS with excellent turn-taking.
- **Deliverables:** the pipeline; VAD + tuned endpointing; barge-in/interruption; backchanneling; loads flow+prompt from `flows/` as config.
- **Done-when:** holds a natural code-mixed (Telugu/Hindi/English) call; TTFA<500ms p50; false-positive interruption rate tracked and under target. **This WP is the product's soul — over-invest here.**

### WP-4 — Provider abstraction layer  `[depends: WP-1]`
- **Goal:** Swap STT/LLM/TTS/telephony without touching business logic.
- **Deliverables:** clean interfaces + adapters (Sarvam, AI4Bharat/Bhashini stub, hosted LLM, Ollama/VLLM, Plivo, Exotel).
- **Done-when:** can switch TTS provider via config only; tests pass for each adapter.

### WP-5 — Compliance agent  `[depends: WP-0, WP-2]`
- **Goal:** The moat, in code. Gate every dial.
- **Deliverables:** real-time DND scrub (fail closed); consent/header check; AI-disclosure enforcement hook; opt-out propagation (<defined SLA) to suppression list; recording + 90-day Indian-soil retention; immutable audit log per call.
- **Done-when:** an un-scrubbed number is provably un-dialable; opt-out mid-call propagates and blocks future dials; audit log complete.

### WP-6 — Backend (.NET) services + tool contract  `[depends: WP-0]`
- **Goal:** Where the agent's tool calls land.
- **Deliverables:** REST endpoints — `book_site_visit`, `book_callback`, `send_whatsapp`, `mark_optout`, lead scoring write-back, inventory lookup; CRM + Google/Outlook calendar + WhatsApp integration; suppression-list store.
- **Done-when:** each tool call from a live agent creates the correct record + confirmation; contract documented in `shared/`.

### WP-7 — Eval / analytics agent (the flywheel)  `[depends: WP-3, WP-6]`
- **Goal:** Make every call improve the next.
- **Deliverables:** auto-transcribe + LLM-as-judge scoring (disclosed? on-script? booked/opt-out clean? natural?); human-review sampling queue; dashboards for TTFA, interruption rate, book rate, opt-out rate; regression suite of recorded scenarios prompts are tested against before deploy.
- **Done-when:** a prompt change is gated by the eval suite; weekly quality report auto-generated.

### WP-8 — Client dashboard  `[depends: WP-2, WP-6]`
- **Goal:** Customers run campaigns and see outcomes.
- **Deliverables:** campaign upload (CSV → scrubbed → queued); live results; recordings + transcripts + scores; booked-meeting view; per-client config of flow/prompt.
- **Done-when:** a design-partner can launch a campaign and read results unaided.

### WP-9 — Infra, CI/CD, observability  `[depends: WP-0]`
- **Goal:** Production-grade ops.
- **Deliverables:** Docker images all services; k8s manifests (scale caller agents horizontally); CI/CD; centralized logging + metrics + tracing (OpenTelemetry); secrets management; recordings storage on Indian region.
- **Done-when:** one-command deploy; autoscale verified under simulated 100-concurrent-call load.

---

## 4. Suggested agent-spawn plan (parallelization)

```
Wave 1 (parallel): WP-0
Wave 2 (parallel, after WP-0): WP-1 spike, WP-6 backend, WP-9 infra
Wave 3 (after WP-1): WP-2 orchestrator, WP-3 caller agent, WP-4 providers
Wave 4 (after WP-2/3/6): WP-5 compliance, WP-7 eval, WP-8 dashboard
```

Critical path runs through WP-1 → WP-3 (the conversation engine). Staff it first and heaviest.
WP-5 (compliance) must be DONE before any real customer dial, regardless of build order.

---

## 5. Definition of "production grade" (acceptance bar)

- [ ] 100+ concurrent calls without quality degradation (load-tested)
- [ ] TTFA p50 < 500ms, p95 < 900ms
- [ ] Code-mixed Telugu/Hindi/English handled; number/name accuracy verified on real telephony audio
- [ ] Compliance gate fails closed; full audit trail; opt-out SLA met
- [ ] Provider swap via config only (no redeploy of business logic)
- [ ] Every prompt change passes the eval regression suite before deploy
- [ ] Recordings on Indian infra, 90-day retention, access-controlled
- [ ] One-command deploy + autoscale + full observability
- [ ] Zero secrets in code; SOC2-direction controls documented

---

## 6. What we explicitly do NOT build (scope discipline)

- No fully-autonomous *closing* of high-ticket deals. Agents qualify + book; humans close.
- No end-to-end speech-to-speech model in v1 (loses tools + Indic depth + debuggability).
- No bespoke STT/TTS model training in v1 — we integrate the best Indic stack and tune prompts/flows; model training is a later, funded R&D bet, not a v1 dependency.
- No non-India telephony in v1. Bharat-first, deliberately.

---

## 7. For the autonomous coding agents reading this

- Treat each WP as an isolated task with its own branch and PR.
- Honor the provider-abstraction boundary — never import a vendor SDK into business logic.
- Conversation flows + prompts live in `caller-agent/flows/` as versioned data, never hard-coded.
- Compliance code fails closed. If unsure whether a dial is legal, block it.
- Write the eval test before changing a prompt.
- Verify Pipecat/Bolna/Sarvam/Plivo API names against current docs — they move; this spec gives architecture, not frozen signatures.
