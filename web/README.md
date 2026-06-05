# Vaak AI — Home Screen (Mission Control)

A self-contained, zero-build home screen for the Vaak AI project.

## What's here

| File | Purpose |
|---|---|
| `index.html` | The home screen — brand, hero, agent fleet, production metrics |
| `assets/styles.css` | All styling (dark "mission control" theme, no framework) |
| `assets/app.js` | Renders the agent fleet + metrics and drives the Playbook overlay |
| `assets/playbook-data.js` | The Playbook content — edit this to change the guide |

## Hear Anaga (live voice demo)

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
