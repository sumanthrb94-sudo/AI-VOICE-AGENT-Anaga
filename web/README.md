# Vaak AI — Home Screen (Mission Control)

A self-contained, zero-build home screen for the Vaak AI project.

## What's here

| File | Purpose |
|---|---|
| `index.html` | The home screen — brand, hero, agent fleet, production metrics |
| `assets/styles.css` | All styling (dark "mission control" theme, no framework) |
| `assets/app.js` | Renders the agent fleet + metrics and drives the Playbook overlay |
| `assets/playbook-data.js` | The Playbook content — edit this to change the guide |

## Talk to Anaga (live two-way call demo)

The hero's green **Talk to Anaga — live call demo** button opens a call screen that
actually listens and responds:

- Your **microphone** → browser **SpeechRecognition** (STT) → a real-estate qualification
  **dialogue engine** → Anaga **speaks back** with her female voice (TTS).
- She runs the real beachhead script: discloses she's an AI, gets consent, qualifies
  (purpose → budget → configuration → timeline), and **books a site visit** — and if you say
  "not interested" / "remove me", she records an **opt-out** and ends (the compliance behaviour).
- A live transcript shows both sides; the avatar pulses while she speaks vs. listens.
- **No mic? No problem** — type your replies in the box. Chrome/Edge give the full voice
  experience (SpeechRecognition isn't available in all browsers).
- Demo runs in English for reliability; the dialogue mirrors the versioned source flow at
  `caller-agent/flows/real-estate-qualify.flow.json`.

> This is a front-end simulation (rule-based, on-device). The production caller agent (WP-3)
> uses Sarvam STT/TTS + an LLM over this same flow, with the compliance gate (WP-5) enforcing
> disclosure and opt-out, fail-closed.

## Hear Anaga (sample line)

The hero has a **Hear Anaga** button with English / हिंदी / తెలుగు pills. It speaks her
opening disclosure line in the browser via the **Web Speech API** — no API keys, no backend.
It picks the best **female** voice installed on your OS/browser and the waveform pulses while
she talks. This is a front-end preview of her persona; the production voice is Sarvam's female
Bulbul voice, configured in `caller-agent/flows/anaga.persona.json` and built in WP-3/WP-4.

> Note: available voices vary by OS/browser (Chrome/Edge have the widest set). If no regional
> female voice is installed, it falls back to your default voice. The line text mirrors the
> persona file.

## The Playbook button

The hero action row has a dedicated, surgically-placed button in the centre:

> **🗺️ The Playbook — Scratch → Production → Investors → Marketing**

Clicking it opens a full-screen, four-phase operating manual that walks the
project from an empty repo to a ₹100 Cr company:

1. **From Scratch** — compliance foundation, repo bootstrap, framework spike (WP-0/WP-1)
2. **To Production** — the full work-package build, conversation engine first (WP-2…WP-9)
3. **Grabbing Investors** — a diligence-proof narrative, market, unit economics, the ask
4. **Marketing & GTM** — Hyderabad RE beachhead → expand → cross into BFSI

All content is sourced from `docs/BUSINESS_PLAN.md`, `engineering/MULTI_AGENT_SPEC.md`,
`docs/COMPLIANCE.md`, and `docs/FINANCIAL_MODEL_NOTES.md`.

## Run it locally

Quick look (app, voice demo, and Playbook all work; the nav's doc links need the build):

```bash
cd web && python3 -m http.server 8000   # open http://localhost:8000
```

Full site exactly as deployed (assembles docs + spec into `public/`):

```bash
bash scripts/build-static.sh
cd public && python3 -m http.server 8000
```

Keyboard: `←` / `→` move between phases, `Esc` closes the overlay.
Deep-link straight into the guide with `#playbook`.

## Deploy to Vercel

The repo is Vercel-ready via `vercel.json` (build → `public/`, no framework needed).

**Option A — dashboard:** Import the GitHub repo at vercel.com. Vercel reads `vercel.json`
automatically (Build Command `bash scripts/build-static.sh`, Output Directory `public`).
Leave the Framework Preset as **Other**. Deploy.

**Option B — CLI:**

```bash
npm i -g vercel
vercel        # preview deploy
vercel --prod # production deploy
```

> ⚠️ **Confidential docs go public.** `build-static.sh` copies `BUSINESS_PLAN.md` and
> `FINANCIAL_MODEL_NOTES.md` into the deploy so the nav links resolve — these are marked
> *Confidential*. To keep them off a public URL, comment out those two `cp` lines in
> `scripts/build-static.sh` (the nav links will then 404, or remove the links in `index.html`).
