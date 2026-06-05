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
| `docs/FINANCIAL_MODEL_NOTES.md` | Unit economics & market assumptions | Investors, founder |
| `engineering/MULTI_AGENT_SPEC.md` | Production build spec, multi-agent design, work packages | **Engineering — build to this** |
| `web/` | **Home screen (Mission Control)** + the Scratch→Production→Investors→Marketing Playbook + the live "Talk to Anaga" call demo | **Everyone — open `web/index.html`** |
| `api/` | Serverless **call brain** — provider-abstracted LLM (Google Gemini) for live turn generation + call review | Vercel functions |
| `.github/` | CI + agent task templates | Coding agents |

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
