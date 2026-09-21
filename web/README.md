# web/ — the vanilla audio engine

This directory is **not the site**. The site is `app/` + `components/` (Next.js,
static-exported, deployed by Vercel). `web/` holds the hand-written, framework-free
JS that the site loads by URL, plus small standalone HTML pages used only in local
development and manual testing — never deployed on their own.

## Why this split exists

`web/assets/*.js` is audio-thread code: a VAD, an AudioWorklet, a hysteresis
gate, half-duplex mic scheduling. None of it renders anything, so none of it
benefits from a component framework — and rewriting it into one would trade
away the tests behind it (`scripts/test-half-duplex.mjs`,
`scripts/test-worklet-rate.mjs`, `scripts/test-browser-*.mjs`) for no gain.
`scripts/prepare-public.mjs` copies exactly five named files into `public/`
before `next build` runs; that list is the contract for what the real site
loads — nothing here reaches production except through it.

| File | Purpose | Loaded by |
|---|---|---|
| `assets/mic.js` | Microphone capture, VAD, endpointer | `index.html`, and the Next.js `/call` page |
| `assets/pcm-worklet.js` | The `AudioWorklet` — must be a real file URL, `addModule()` cannot take an import | `mic.js`, `live.js` |
| `assets/demo-call.js` | The turn-by-turn HTTP call demo | `index.html` |
| `assets/live.js` | The streaming call client — one WebSocket, half-duplex gating | the Next.js `/call/live` page |
| `assets/tel.js` | Telugu voice sampler | `voices.html` |

## The standalone HTML pages (dev/test only, not deployed)

| Page | What it is |
|---|---|
| `index.html` | The vanilla live-call screen `demo-call.js`/`mic.js` were built against — kept for the local dev loop (`caller-agent/src/agent/server.js` serves this directory) and for `scripts/test-browser-demo.mjs`. The deployed equivalent is the Next.js `/call` page. |
| `console.html` | An operator console — lead pipeline, compliance verdicts, call outcomes. Superseded by the Next.js `/console` app (`components/console/`), but kept until that page has equivalent test coverage for the two properties `scripts/test-browser-console.mjs` verifies here: transcripts render as text and never execute (stored XSS), and a recording's signed URL is minted and never printed to the page. |
| `bench.html` | A manual A/B tool for comparing TTS voice latency — see `scripts/test-browser-bench.mjs`. |
| `voices.html` | The Telugu voice picker/sampler, driven by `assets/tel.js` — see `scripts/test-browser-telugu.mjs`. |

## Run it locally

```bash
cd web && python3 -m http.server 8000   # open http://localhost:8000
```

Or exactly as deployed, through the real build:

```bash
pnpm build && cd public && python3 -m http.server 8000
```

## Deploy

There is nothing to deploy from here directly. `vercel.json` builds the Next.js
app (`pnpm build` → `out/`); `scripts/prepare-public.mjs` is a pre-build step
that stages the five files above into `public/` so Next.js emits them
verbatim. The serverless functions under `api/` deploy alongside it — see the
repo root `README.md` for environment variables and the deploy runbook.
