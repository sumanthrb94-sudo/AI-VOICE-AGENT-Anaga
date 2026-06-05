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

## Run it

No build step. Either open `index.html` directly, or serve the folder:

```bash
cd web && python3 -m http.server 8000
# then open http://localhost:8000
```

Keyboard: `←` / `→` move between phases, `Esc` closes the overlay.
Deep-link straight into the guide with `index.html#playbook`.
