# Vaak AI

**Voice-AI sales infrastructure for Bharat's high-ticket, multilingual, regulated industries.**

Autonomous, India-native voice agents that qualify leads, handle objections in the languages
Indians actually speak (Hindi / Telugu / English + code-mixing), book high-intent meetings, and
hand warm prospects to human closers — compliant with TRAI/DLT/DND by design.

---

## This repository contains

| Path | What | For |
|---|---|---|
| `docs/BUSINESS_PLAN.md` | Investment memorandum & business plan | **Investors / CEO — read first** |
| `docs/COMPLIANCE.md` | India regulatory requirements + enforcement rules | Compliance owner, WP-5 |
| `docs/INTEGRATIONS.md` | **Runbook: wiring Anaga to Meta Lead Ads + your CRM** | **Whoever connects a customer** |
| `docs/CLEAN_REBUILD_ADR.md` | **Clean-build decision: runtime boundary, Firebase preservation, and gates** | **Engineering / CEO** |
| `docs/REPOSITORY_AUDIT_2026-08-14.md` | **End-to-end audit, validation evidence, and production gates** | **Engineering / CEO** |
| `docs/VOICE_AGENT_RESEARCH.md` | Verified Sarvam, Deepgram, Pipecat, and telephony research notes | Engineering |
| `docs/FINANCIAL_MODEL_NOTES.md` | Unit economics & market assumptions | Investors, founder |
| `engineering/MULTI_AGENT_SPEC.md` | Production build spec, multi-agent design, work packages | **Engineering — build to this** |
| `engineering/LIVEKIT_REFERENCE.md` | What we took from livekit/agents, what we didn't, and why | Engineering |
| `engineering/VOICESTUDIO_REFERENCE.md` | **Self-hosted voice: the AGPL line, data residency, a male voice** | **Engineering — read §1 before writing any adapter** |
| `web/` | **Home screen (Mission Control)** + the Scratch→Production→Investors→Marketing Playbook + the live "Talk to Anaga" call demo | **Everyone — open `web/index.html`** |
| `api/` | Serverless **call brain** (provider-abstracted LLM) + the **integration tubing**: Meta Lead Ads webhook, lead intake, compliance gate, dial queue, CRM writeback | Vercel functions |
| `web/console.html` | **Operator console** — leads in, compliance verdicts, calls queued, outcomes, wiring status | Whoever runs campaigns |
| `design-system/` | Generated design systems (ui-ux-pro-max skill) — the source of truth for each surface | Anyone touching UI |
| `caller-agent/` | **The dialer** — consumes dial jobs, runs the call, reports outcomes | Engineering |
| `LAUNCH.md` | **Launch readiness: what is proven, what blocks a real call** | **Read before launch** |
| `docs/GO_LIVE.md` | **The exact remaining env vars and prerequisites, in order** | **Whoever is turning this on** |
| `.github/` | CI + agent task templates | Coding agents |

## Getting a real lead to a real call

```
Meta Lead Ad ─► /api/integrations/meta/leads ─┐
CRM / page   ─► /api/leads/intake ────────────┴─► CRM upsert
                                               └─► COMPLIANCE GATE (fails closed)
                                                   └─► dial job ─► orchestrator ─► Anaga calls
                                                                                   └─► /api/calls/outcome
                                                                                        ├─► opt-out → DNC list
                                                                                        └─► note + intent score → CRM
```

Watch it happen in the **operator console** at `/console.html` (needs the
`INTEGRATIONS_API_KEY`).

Setup: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) · API contract:
[`shared/integrations-contract.md`](shared/integrations-contract.md) · what's
wired on a running deploy: `GET /api/integrations/health` ·
tests: `node --experimental-detect-module scripts/test-integrations.mjs`.

The dial queue consumer now exists: `caller-agent/` consumes signed jobs, runs the
turn loop, and reports outcomes back. **Launch readiness — including what is still
blocking a real call — is in [`LAUNCH.md`](LAUNCH.md). Read it before pitching.**

```bash
# One-time local browser-test setup
corepack enable
pnpm install
pnpm run test:browser:install

# Full reproducible validation
pnpm test

# Individual suites remain available:
node --experimental-detect-module scripts/test-integrations.mjs   # 49
node --experimental-detect-module scripts/test-media.mjs          # 13
node --experimental-detect-module scripts/test-media-server.mjs   # 18
node --experimental-detect-module scripts/test-firestore.mjs      # 6 (+6 live)
node --experimental-detect-module scripts/test-echo.mjs           # 16
node --experimental-detect-module scripts/test-voice.mjs          # 42
node --experimental-detect-module scripts/test-voicestudio.mjs    # 18
node --experimental-detect-module scripts/test-recording.mjs      # 21
node scripts/test-browser-echo.mjs                                # 6  (real Chromium)
node scripts/test-browser-voice.mjs                               # 11 (real Chromium)
CALLING_WINDOW_START_IST=0 CALLING_WINDOW_END_IST=24 \
  node --experimental-detect-module scripts/test-e2e.mjs          # 44
```                                                               # 244 total
#      (+6 more when FIREBASE_SERVICE_ACCOUNT_LIVE is set: 244)

## Home screen & the Playbook

Open `web/index.html` for the project's home screen. The hero has one dedicated
button — **🗺️ The Playbook** — that opens a four-phase operating manual taking the
company from an empty repo to a ₹100 Cr outcome: **From Scratch → To Production →
Grabbing Investors → Marketing & GTM.** No build step; see `web/README.md`.

## The one-line thesis
India's most valuable conversations happen by voice, in many languages — and no platform built
for Bharat's languages, telephony, and regulation exists to have them at scale. Vaak is that layer.
We start with real estate (the founder's home market), build a compliance + conversation moat
foreign per-minute platforms can't cross, and compound it with an eval flywheel where every call
makes the next one better.

## What we are honest about
- The agent **qualifies and books**; humans **close** high-ticket deals. We do not sell the
  "AI closed the whole project" fantasy — that claim dies in diligence and on the phone.
- Market numbers are cited; projections are estimates to validate with design-partner data.
- The build spec gives architecture, not frozen API signatures — verify vendor APIs against current docs.

## For autonomous coding agents
Start at `engineering/MULTI_AGENT_SPEC.md`. Each work package (WP-0 … WP-9) is an isolated,
branchable task with explicit done-when criteria and dependencies. Honor the provider-abstraction
boundary, keep conversation flows as versioned data, and make the compliance gate fail closed.

## Status
Pre-seed. Founder-led. Beachhead: Hyderabad real estate. Building to the milestones in the plan.
