# Vaak AI ("Anaga") — Production Readiness Review

Scope: the Vercel-hosted static site (`web/`) + serverless functions (`api/`) that power the
live "Talk to Anaga" demo. Brain = Google Gemini; voice = Sarvam Bulbul (TTS) + Sarvam Saarika
(STT). This document is a review only — it points at concrete files/lines and does **not** change
any code.

Reviewer summary in one line: **the secret-handling and fail-soft design are genuinely good for a
demo, but the public endpoints have zero abuse protection (no rate limiting, no audio size cap),
the BYOK path intentionally exposes a key in the browser, and the build publishes files marked
Confidential. None of these should ship to a public production URL as-is.**

---

## 1. Security

### 1.1 Are API keys strictly server-side?
For the **server path: yes.** The provider keys are read only from server-side env and never
returned to the browser:
- `GEMINI_API_KEY` — read only in `api/_lib/llm.js:57` (`generateGemini`). On failure the code
  deliberately avoids leaking the URL (which contains the key) — see `api/_lib/llm.js:90-91`,
  `:96-100`.
- `SARVAM_API_KEY` — read only in `api/_lib/tts.js:27` and `api/_lib/stt.js:37`. Sent upstream as
  the `api-subscription-key` header only.
- The capability probes (`GET /api/tts`, `GET /api/stt`) return only `{ available, provider, model }`
  (`api/tts.js:14-20`, `api/stt.js:15-21`) — booleans/model names, never the key. Good.
- Error bodies are generic (`tts_unavailable`, `stt_unavailable`, `llm_unavailable`) and upstream
  detail is swallowed (`api/tts.js:47-49`, `api/stt.js:47-50`, `api/anaga/turn.js:51-53`). Good —
  no stack traces or provider responses reach the client.

### 1.2 The BYOK localStorage path (`web/assets/llm-client.js`) — risk assessment
This path is **by design** a client-side key holder and is the single biggest "security" caveat,
though it is correctly scoped and documented:
- The user pastes a Gemini key into a password field (`web/index.html:267`), it is stored in
  `localStorage` under `vaak_gemini_key` (`llm-client.js:19-22`) and sent **directly from the
  browser to Google** (`llm-client.js:70`, `:133`) with the key in the query string
  (`?key=...`).
- Priority order is BYOK → server `/api` → offline (`llm-client.js:12`, `app.js:1040-1052`).

Risk: a key in `localStorage` + in request URLs is readable by any script running on the page
(XSS), by browser extensions, by anyone with access to that browser profile, and appears in
browser history / any logging proxy. The code's own banner says exactly this
(`llm-client.js:7-11`; `web/README.md:64-65`).
- **Severity for production: LOW *if* nobody uses it on the deployed site** (it is opt-in and empty
  by default). It does **not** expose the *server's* key.
- **The real risk** is a user pasting their *personal* Gemini key into a public deployment and that
  key leaking / being abused on their Google bill. Recommendation: on the production deployment,
  hide or disable the "Connect Gemini" UI (or gate it behind a `?dev` flag) so the public site uses
  only the server key. At minimum keep the existing warning visible.

### 1.3 Input validation on `api/*.js`
Body parsing is defensive and consistent across all four handlers (handles both pre-parsed objects
and raw strings, rejects bad JSON with 400 not 500):
- `api/anaga/turn.js:21-44` and `api/anaga/summary.js:22-45` validate that `history` is a non-empty
  array of `{ role:'agent'|'user', text:string }` and 400 otherwise. Good.
- `api/tts.js:36-40` requires non-empty `text`; clamps modulation; truncates text to 1500 chars in
  `api/_lib/tts.js:38`. Speaker is allow-listed (`api/_lib/tts.js:30-32`). Good.
- `api/stt.js:37-40` requires a `body.audio` string.

**Gap — no audio size limit (`api/stt.js`):** `body.audio` is accepted as an arbitrary base64
string and decoded with `Buffer.from(audioBase64, 'base64')` (`api/_lib/stt.js:42`) then forwarded
to Sarvam with **no length check**. There is no `export const config` / `bodyParser.sizeLimit`
anywhere in `api/` (verified: none exists), so only Vercel's **default ~4.5 MB request-body limit**
applies. An attacker can POST ~4.5 MB of base64 on every request, forcing a full Sarvam STT
round-trip (cost + latency) each time. There is also no validation that the bytes are actually
audio. **Recommend:** reject `body.audio` above an explicit cap (e.g. a few hundred KB — a 16 kHz
mono WAV utterance is small) before allocating the Buffer or calling Sarvam; optionally cap raw
body size via function config.

`api/anaga/turn.js` / `summary.js` validate the *shape* of `history` but **not its size** — an
attacker can send a huge `history` array (each element a long `text`) and run up Gemini tokens.
Recommend capping the number of turns and total transcript length before calling `generate()`.

### 1.4 CORS / method allow-lists
- **Method allow-lists: present.** Each handler returns `405` with an `Allow` header for the wrong
  verb (`api/tts.js:22-25`, `api/stt.js:23-26`, `api/anaga/turn.js:15-18`, `api/anaga/summary.js:17-20`).
  Good.
- **CORS: none set.** No `Access-Control-Allow-Origin` / preflight handling anywhere (verified).
  These are same-origin endpoints called by the bundled frontend, so this is acceptable today, but
  it does **not** restrict who can call them — any site/script/cURL can POST cross-origin via a
  simple request (JSON POST). CORS would not stop server-to-server abuse anyway; see rate limiting.

### 1.5 Secrets in the repo
- `.gitignore:1-4` ignores `.env`, `.env.local`, `*.local`. Only `.env.sample` is tracked and it
  contains **empty** placeholders (`.env.sample:20,36`, etc.). No `.env` on disk. **No secrets
  committed.** Good.
- `.github/` contains only `AGENT_TASK_TEMPLATE.md` — there is **no CI workflow** despite
  `README.md:21` listing "CI". No secret-scanning gate exists; consider adding one (e.g. gitleaks)
  before this is a real product.

### 1.6 Abuse / rate limiting — **MISSING (highest-priority production gap)**
There is **no rate limiting, throttling, auth, or per-IP control anywhere** in `api/` (verified:
no reads of `req.headers`, `x-forwarded-for`, no limiter). All four endpoints are public and each
one spends real money on every call:
- `POST /api/anaga/turn` and `/api/anaga/summary` → Gemini tokens.
- `POST /api/tts` → Sarvam Bulbul characters (up to 1500 per call).
- `POST /api/stt` → Sarvam Saarika audio-seconds (up to ~4.5 MB of audio per call).

Anyone who finds the deployed URL can script these in a loop and run up the Gemini + Sarvam bills,
and/or exhaust the Vercel function quota. **Before any public launch:**
- Add **per-IP rate limiting** (e.g. Vercel’s `@vercel/firewall`/edge middleware, or Upstash
  Redis token-bucket keyed on `x-forwarded-for`) on all four endpoints — both a short-window burst
  cap and a daily cap.
- Add an explicit **max audio size** on `/api/stt` (§1.3) and a **max `history` size** on
  `/turn` & `/summary`.
- Set **billing alerts / hard quotas** on both the Google AI and Sarvam accounts as a backstop.
- Consider a lightweight bot check (origin allow-list, a signed nonce minted by the page, or
  Vercel Bot Management) so only the real site can call the endpoints.

---

## 2. Reliability

### 2.1 Timeouts / abort on upstream calls — present everywhere
Every upstream call uses `AbortController` + `setTimeout`:
- Gemini: 12 s (`api/_lib/llm.js:20`, `:78-94`).
- Sarvam TTS: 20 s (`api/_lib/tts.js:49-61`).
- Sarvam STT: 20 s (`api/_lib/stt.js:49-61`).
- BYOK browser Gemini: 15 s non-stream / 20 s stream (`llm-client.js:77`, `:140`).
- Frontend also races STT/translate/audio against timeouts so the call never freezes
  (`app.js:756-761` `withTimeout`, used at `:967`; `requestMicSafe` at `:1278-1283`). Good.

### 2.2 Graceful 503 fallbacks — strong (this is the app's best trait)
The whole stack is "fail soft": any upstream failure becomes a clean 503 and the browser silently
degrades.
- `/turn` → `503 llm_unavailable` → browser flips to the on-device rule engine for the rest of the
  call (`api/anaga/turn.js:51-53`; `app.js:1103-1108` `brainMode='offline'`, detect-once).
- `/summary` → 503 → local heuristic review always renders (`app.js:1496-1501`, `localReview()`).
- `/tts` 503 → browser Web Speech voice (`app.js:285`, `:339`).
- `/stt` 503 → browser `SpeechRecognition` (`app.js:975`).
Note these are *demo* fallbacks; the offline rule engine cannot truly converse (it follows the
fixed `FLOW` in `app.js:643-688`) and the app honestly tells the user so (`app.js:735-740`).

### 2.3 `maxDuration` in `vercel.json`
Set to **30 s for all functions**: `vercel.json:6-8` (`"api/**/*.js": { "maxDuration": 30 }`).
This is comfortably above the 12 s (LLM) and 20 s (Sarvam) internal timeouts, so the upstream abort
fires first and the function returns a clean 503 rather than being killed by the platform. Fine.
Minor: you could lower per-function budgets to just above each internal timeout to cap worst-case
billed duration, but 30 s is safe.

### 2.4 Cold starts
- Functions are **dependency-free** (they use Node 18+ global `fetch`/`FormData`/`Blob`; no
  `node_modules`, no SDK) — see `api/_lib/llm.js:18`, `api/_lib/stt.js:41`. This keeps cold-start
  cost low. Good.
- The frontend probes `GET /api/tts` and `GET /api/stt` once on load (`app.js:344`, `:422`) and
  caches the capability, so a cold probe only delays the *first* voice/STT decision, not every turn.
- No region is pinned in `vercel.json`. For India users, latency to both Sarvam and the function
  region matters (the metrics card advertises `<500 ms time-to-first-audio`, `app.js:23`). Consider
  pinning the function region close to Sarvam/users and to your Indian-region recording store. This
  serverless demo will **not** hit the advertised concurrency/latency numbers (those describe the
  future production caller-agent, WP-3); see §5.

---

## 3. Compliance (India: TRAI / TCCCPR / DLT / DND / DPDP)

The regulatory requirements are well documented in `docs/COMPLIANCE.md` (DLT registration,
160-series numbers, real-time DND scrub fail-closed, AI disclosure, opt-out propagation, 90-day
Indian-region recording retention, TRAI-permitted hours, DPDP review). **None of that machinery
exists in this codebase yet** — the env placeholders for it (`DLT_*`, `DND_SCRUB_API_KEY`,
`SUPPRESSION_LIST_URL`, `RECORDING_BUCKET`, telephony creds) are all empty in `.env.sample:3-8`,
`:39-48` and unused by any `api/` code.

What the demo **does** do (in-browser only, no telephony):
- **AI disclosure at call open** — Anaga's first line discloses she is an AI from Vaak. Enforced in
  the prompt (`api/_lib/prompts.js:50-52`, mirrored `llm-client.js:35-36`) and hard-coded in the
  offline greeting (`app.js:645`). Good as a behaviour, but it is *model/script* behaviour, not a
  non-bypassable gate.
- **Opt-out handling** — "not interested / remove me / don't call / DND" (incl. Hindi/Telugu) →
  acknowledge, say added to do-not-call list, end immediately (`prompts.js:65-68`; offline
  `optout` step `app.js:684-687`; intent regex `app.js:625`). It ends the *demo call* and labels
  the review `opt-out` — but it writes to **no suppression list** and persists nothing.

What the demo **does not** do / what is required before real outbound calls:
- No DLT-registered header, no 160-series origination, no telemarketer registration.
- No real-time **DND scrub** before dialing (the COMPLIANCE.md "fail closed: no clean number → no
  dial" rule is not implemented — there is no dialer at all).
- **Opt-out is not durable** — no write to a suppression store, no propagation, no audit. A real
  product must persist opt-outs permanently and block future dials (`COMPLIANCE.md:34`).
- No **call recording / 90-day Indian-region retention**, no immutable per-call audit log
  (`COMPLIANCE.md:15-16,35`).
- No **DPDP** lawful-basis/consent/retention/deletion handling for the lead's number.
- No **TRAI-permitted-hours** enforcement.

Bottom line: **this is a safe-to-show product demo, not a compliant outbound dialer.** Disclosure
and opt-out are demonstrated as *conversation behaviour* via the LLM/script; they are not the
fail-closed, audited, persisted controls `docs/COMPLIANCE.md` mandates. Do not place real outbound
calls from this code.

---

## 4. Deploy

### 4.1 Build
- `vercel.json`: `buildCommand: bash scripts/build-static.sh`, `outputDirectory: public`,
  `installCommand` is a no-op (static site) — `vercel.json:3-5`.
- `scripts/build-static.sh` copies `web/` → `public/` and copies selected docs into
  `public/docs` + `public/engineering` (`build-static.sh:16-28`).
- The `api/` functions deploy automatically from the `api/` directory — no build step, no deps.
- **WARNING — confidential docs are published:** `build-static.sh:25,27` copy
  `docs/BUSINESS_PLAN.md` and `docs/FINANCIAL_MODEL_NOTES.md` (both marked *Confidential*) into the
  public deploy so nav links resolve (`build-static.sh:20-22`, `web/README.md:145-148`). On a public
  URL these are world-readable. **Comment out those two `cp` lines** (and the matching nav links)
  before a public production deploy.

### 4.2 Environment variables — required vs optional
Everything degrades gracefully, so **nothing is strictly required to deploy the static demo**; the
vars below enable the live brain/voice. Set them **server-side in Vercel only**.

Required to enable the **live Gemini brain** (`/api/anaga/turn`, `/summary`):
- `GEMINI_API_KEY` — without it, both endpoints 503 and the call uses the offline rule engine
  (`api/_lib/llm.js:57-61`).

Required to enable **cloud voice + cloud STT** (`/api/tts`, `/api/stt`):
- `SARVAM_API_KEY` — one key powers both Bulbul TTS and Saarika STT
  (`api/_lib/tts.js:27`, `api/_lib/stt.js:37`). Without it, probes return `available:false` and the
  browser uses Web Speech / `SpeechRecognition`.

Optional (have sensible defaults — values from `.env.sample` / code):
- `GEMINI_MODEL` (default `gemini-2.5-flash`, `llm.js:63`)
- `LLM_PROVIDER` (default `gemini`, `llm.js:37`)
- `TTS_PROVIDER` (default `sarvam`, `tts.js:17` / `_lib/tts.js:24`)
- `STT_PROVIDER` (default `sarvam`, `stt.js:18` / `_lib/stt.js:34`)
- `SARVAM_TTS_MODEL` (default `bulbul:v2`, `_lib/tts.js:41`)
- `SARVAM_STT_MODEL` (default `saarika:v2.5`, `_lib/stt.js:45`)

Unused by current `api/` code (forward-looking, for the production caller-agent / compliance work —
leave empty for the web demo): `PLIVO_*`, `EXOTEL_*`, `OUTBOUND_CALLER_ID`, `LLM_API_KEY`,
`LLM_BASE_URL`, `DLT_*`, `DND_SCRUB_API_KEY`, `RECORDING_*`, `DATABASE_URL`, `SUPPRESSION_LIST_URL`,
`OTEL_*`, `AI4BHARAT_API_KEY`, `AGENT_*`, `TTS_*` voice hints. (`LLM_API_KEY`/`LLM_BASE_URL` exist
in `.env.sample:29-30` but the Gemini adapter ignores them and reads `GEMINI_API_KEY` — see
Issues §I-2.)

### 4.3 How to verify a deployment
The capability probes are the intended health checks. After deploy, with keys set, these should
return `available:true`:
- `GET https://<deployment>/api/tts`  → `{ "available": true, "provider": "sarvam", "model": "bulbul:v2" }`
- `GET https://<deployment>/api/stt`  → `{ "available": true, "provider": "sarvam", "model": "saarika:v2.5" }`

> NOTE / DISCREPANCY: the review brief mentions a `/api/live/token` probe. **No such endpoint exists
> in this repo** — there is no `api/live/` directory (verified). The only probes are `/api/tts` and
> `/api/stt`. The Gemini brain has **no GET probe**; verify it with a POST:
> `POST /api/anaga/turn` with body `{"history":[{"role":"agent","text":"hi"}]}` → expect `200` with
> `{say,end,disposition}` when `GEMINI_API_KEY` is set, or `503 {"error":"llm_unavailable"}` if not.
> If you want a clean health endpoint for the brain, add a `GET /api/anaga/turn` (or a dedicated
> probe) that reports `available` from a `GEMINI_API_KEY` presence check, mirroring tts/stt.

In the running UI, the call header tag shows which brain is live ("live AI · server" /
"live AI · your key" / "offline script", `app.js:713-730`) and the voice chip shows the Sarvam
speaker when cloud TTS is on — a quick manual smoke test.

---

## 5. Known limitations & costs

### 5.1 Browser STT / Web Speech limits (the no-key fallback)
- `SpeechRecognition` is effectively **Chrome/Edge-only**; Firefox/Safari largely lack it, so those
  users fall to typing (`app.js:1310-1314`). The README states this (`web/README.md:48`).
- Web Speech accuracy for **Telugu/Hindi/code-mix is poor**, and `recog.lang` is pinned to `en-IN`
  for non-English capture — the code knows this and prefers Sarvam audio when available, hiding the
  garbled interim (`app.js:1144-1147`).
- Echo/barge-in handling is heuristic (`app.js:764-770`, `:1137-1141`) and mobile browsers need a
  user gesture to start audio (`app.js:1269-1274`).
- Web Speech / `speechSynthesis` cannot be tapped by Web Audio, so the Voice Lab meter is synthetic
  for browser TTS (`app.js:1795-1796`). Cosmetic only.

### 5.2 Per-minute / per-call cost drivers (what actually spends money)
- **Gemini** — one `generateContent` per conversational turn (`/api/anaga/turn`) plus one per call
  summary (`/api/anaga/summary`). Cost scales with transcript length: the **entire `history` is
  re-sent every turn** (`prompts.js:77-85`, `:107-111`), so long calls grow quadratically in tokens.
- **Sarvam Bulbul TTS** — billed per character, up to 1500 chars/request (`_lib/tts.js:38`), and the
  frontend **prefetches the next sentence** (`app.js:294-304`) — good for latency, but it can
  synthesize chunks that are never played (barge-in/hang-up), i.e. some paid-for-but-unused audio.
- **Sarvam Saarika STT** — billed per audio length, one round-trip per caller utterance
  (`app.js:413-419`); abusable without a size cap (§1.3).
- **Vercel** — function invocations + GB-seconds; `maxDuration:30` caps worst case but a flood of
  STT/LLM calls burns quota fast (see §1.6).
- The advertised metrics (100+ concurrent, `<500 ms` TTFA, `app.js:21-28`) describe the *future*
  streaming caller-agent, **not** this request/response serverless demo — don't quote them for this
  deployment.

### 5.3 What to monitor
- Per-endpoint request rate + p95 latency + 4xx/5xx (esp. **503 rate** = upstream/key problems).
- **Gemini and Sarvam spend** with daily budget alerts and hard caps (no app-level cost guard
  exists).
- Distinct source IPs / top callers (to catch abuse, since there's no rate limit today).
- Vercel function duration/invocation quota and cold-start frequency.
- There is **no observability wired in** — `OTEL_EXPORTER_OTLP_ENDPOINT` (`.env.sample:51`) is
  unused. Add at least structured logs + an uptime check on the two probes.

---

## 6. Pre-launch checklist

Security / abuse
- [ ] Add **per-IP rate limiting** to `/api/anaga/turn`, `/api/anaga/summary`, `/api/tts`, `/api/stt`.
- [ ] Add an explicit **max audio-size** check in `api/stt.js` before decoding/forwarding (§1.3).
- [ ] Add a **max `history` length** check in `turn.js` / `summary.js` (§1.3).
- [ ] Set **billing alerts + hard quotas** on Google AI (Gemini) and Sarvam.
- [ ] Restrict who can call the endpoints (origin allow-list / signed nonce / bot management).
- [ ] On the public deploy, **disable/hide the BYOK "Connect Gemini" UI** (or gate it) (§1.2).
- [ ] Confirm `GEMINI_API_KEY` / `SARVAM_API_KEY` are set **only** as server env vars in Vercel,
      never in client code or `NEXT_PUBLIC_*`-style vars.

Deploy hygiene
- [ ] **Comment out** the `BUSINESS_PLAN.md` + `FINANCIAL_MODEL_NOTES.md` `cp` lines in
      `scripts/build-static.sh` (and matching nav links) so Confidential docs don't go public (§4.1).
- [ ] Verify probes: `GET /api/tts` and `GET /api/stt` return `available:true`; POST-probe `/turn`.
- [ ] Pin a function **region** near users/Sarvam; consider tighter per-function `maxDuration`.
- [ ] Add a **CI workflow** + secret-scanning (none exists today; README claims CI) (§1.5).
- [ ] Add **observability** (logs/uptime/OTEL) and a cost dashboard (§5.3).

Compliance (MANDATORY before any *real* outbound call — not needed for the in-browser demo)
- [ ] DLT registration + approved header; 160-series number; telemarketer registration.
- [ ] Real-time **DND scrub**, fail-closed (no clean number → no dial).
- [ ] **Durable opt-out**: write to suppression list, block all future dials, audit it.
- [ ] Disclosure as a **non-bypassable gate** (not just prompt/script behaviour).
- [ ] Call **recording + 90-day Indian-region retention** + immutable per-call audit log.
- [ ] TRAI-permitted-hours enforcement; DPDP lawful-basis/retention/deletion review.

---

## Issues found (report only — not fixed)

- **I-1 (High) — No rate limiting / abuse protection on any public endpoint.**
  `api/anaga/turn.js`, `api/anaga/summary.js`, `api/tts.js`, `api/stt.js` have no throttling, auth,
  or per-IP control (no `req.headers`/`x-forwarded-for` use anywhere). Public + cost-bearing
  (Gemini, Sarvam). See §1.6.

- **I-2 (High) — `api/stt.js` accepts unbounded base64 audio.** `body.audio` is forwarded with no
  size/length validation; `Buffer.from(audioBase64,'base64')` at `api/_lib/stt.js:42`. Only Vercel's
  default ~4.5 MB body limit applies (no `bodyParser.sizeLimit` config exists). Each oversized POST
  triggers a paid Sarvam round-trip. See §1.3.

- **I-3 (Medium) — `turn.js`/`summary.js` don't bound `history` size.** Shape is validated
  (`turn.js:38-44`) but not length; the full transcript is re-sent to Gemini every turn
  (`prompts.js:77-85`) → unbounded token cost / amplification vector. See §1.3.

- **I-4 (Medium) — Build publishes Confidential docs.** `scripts/build-static.sh:25,27` copy
  `BUSINESS_PLAN.md` and `FINANCIAL_MODEL_NOTES.md` into `public/`, making them world-readable on a
  public deploy. See §4.1.

- **I-5 (Medium) — BYOK key exposed in browser by design.** `web/assets/llm-client.js:19-22` stores
  the Gemini key in `localStorage`; `:70` and `:133` put it in the request URL query string. Documented,
  opt-in, and does not expose the server key, but risky if used on the public site. See §1.2.

- **I-6 (Low) — Review brief's `/api/live/token` probe does not exist.** There is no `api/live/`
  directory in the repo (verified). Only `/api/tts` and `/api/stt` expose GET probes; the Gemini
  brain has no health probe at all. See §4.3.

- **I-7 (Low) — `LLM_API_KEY` / `LLM_BASE_URL` are dead config.** Present in `.env.sample:29-30`
  and implied by `LLM_PROVIDER`, but the Gemini adapter reads `GEMINI_API_KEY` and ignores them
  (`api/_lib/llm.js:56-65`). Misleading for operators; `GEMINI_API_KEY` is the one that matters.

- **I-8 (Low) — README claims CI that doesn't exist.** `README.md:21` lists `.github/` as "CI +
  agent task templates", but `.github/` contains only `AGENT_TASK_TEMPLATE.md` — no workflow, no
  secret-scan gate. See §1.5.

- **I-9 (Info) — Advertised performance metrics describe future production, not this demo.**
  `web/assets/app.js:21-28` shows "100+ concurrent", "<500 ms time-to-first-audio". This serverless
  request/response demo (per-turn `fetch`, non-streaming server path) won't meet those; they belong
  to the WP-3 streaming caller-agent. Avoid quoting them for this deployment. See §5.2.

- **I-10 (Info) — No observability.** `OTEL_EXPORTER_OTLP_ENDPOINT` (`.env.sample:51`) is unused;
  there is no logging/metrics/alerting wired into the functions. See §5.3.

- **I-11 (Info, positive) — Secrets hygiene is correct.** `.gitignore:1-4` covers `.env*`; only
  `.env.sample` (empty placeholders) is tracked; no secrets in the repo; upstream errors and the
  key-bearing URL are never leaked to clients (`api/_lib/llm.js:90-100`). Good baseline.
