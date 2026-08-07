# Launch readiness — Vaak / Anaga

An honest state-of-the-system. Written so nobody discovers a gap the week of launch.

**Bottom line:** the software path from *a Facebook lead* to *a CRM note* is built
and QA-tested end to end — 244 automated tests, including the compliance gate, the
opt-out path, a full call driven over a real WebSocket, and live round-trips
against the production Firestore project. **It cannot legally
place a real call yet**, and every remaining blocker is now either a one-call
verification spike or a business/legal prerequisite — not unwritten code.

Run the suites yourself:

```bash
node --experimental-detect-module scripts/test-integrations.mjs   # 49
node --experimental-detect-module scripts/test-media.mjs          # 12
node --experimental-detect-module scripts/test-media-server.mjs   # 18
node --experimental-detect-module scripts/test-firestore.mjs      # 12
node --experimental-detect-module scripts/test-echo.mjs           # 16
node --experimental-detect-module scripts/test-voice.mjs          # 36
node --experimental-detect-module scripts/test-voicestudio.mjs    # 18
node --experimental-detect-module scripts/test-recording.mjs      # 21
node --experimental-detect-module scripts/simulate-echo.mjs       # echo simulation
node scripts/test-browser-echo.mjs                                # 6 (real Chromium)
node scripts/test-browser-voice.mjs                               # 11 (real Chromium)
CALLING_WINDOW_START_IST=0 CALLING_WINDOW_END_IST=24 \
  node --experimental-detect-module scripts/test-e2e.mjs          # 44
```

---

## ✅ Built and tested

| Capability | Where | Proven by |
|---|---|---|
| Meta Lead Ads webhook, HMAC over raw body | `api/integrations/meta/leads.js` | E2E §1, §5 |
| Source-agnostic lead intake | `api/leads/intake.js` | integration + E2E |
| **Compliance gate, fails closed** | `api/_lib/compliance.js` | E2E §3, CI gate job |
| Dial queue with signed jobs | `api/_lib/queue.js` | E2E §1, §4 |
| **Caller agent — the turn loop** | `caller-agent/src/session.js` | E2E §1, §5, §6 |
| **Opt-out detection, 3 languages + code-mixing** | `shared/optout.js` | E2E §2 (12 cases) |
| Endpointing, barge-in, paced playback, false-interruption resume | `caller-agent/src/media/transport.js` | media QA (13) + echo QA (16) |
| WebSocket media server (RFC 6455, hand-rolled) | `caller-agent/src/media/ws.js`, `media/server.js` | media-server QA (18 cases, incl. hostile-peer framing), incl. interop with Node's native WebSocket client |
| Outcome → suppression → CRM writeback | `api/calls/outcome.js` | E2E §2, §5 |
| CRM adapters (HubSpot, Zoho, webhook) | `api/_lib/integrations/crm/` | E2E via webhook |
| Operator console | `web/console.html` | E2E §7 |
| Rate limiting, structured logs, PII masking | `api/_lib/guard.js` | E2E §7 |
| **Durable suppression list, atomic dedupe, event history** | `api/_lib/store.js`, `_lib/firestore.js` | Firestore QA (12), live against `anaga-2c61c` |
| **Self-echo rejection (agent never answers itself)** | `shared/echo-guard.js` | echo QA (14) + `simulate-echo.mjs` |
| Browser demo: echo rejection + global opt-out | `web/assets/app.js` | real-Chromium QA (6) |
| **TTS provider chain (self-hosted → Google Cloud → Google Translate → Sarvam)** | `api/_lib/tts.js` | voice QA (36) |
| Translation (Cloud Translation → free endpoint → English) | `api/_lib/translate.js`, `api/translate.js` | voice QA (36) |
| Male voice, and saying so when it can't be served | `web/assets/app.js`, `web/index.html` | real-Chromium QA (11) |
| **Call recording — Indian-region gate, no public URLs, DPDP erasure** | `api/_lib/recording.js`, `api/calls/recording.js` | recording QA (21) |
| **Self-hosted voice on the call leg** (TTS + STT, WAV rate conversion) | `caller-agent/src/providers/speech.js` | VoiceStudio QA (18) |
| Self-hosted deployment that cannot quietly expose itself | `deploy/voicestudio/` | VoiceStudio QA §5 |

### Invariants the tests actually hold you to

- A dial is **refused** when the DND scrub is unreachable, unconfigured, the
  consent is missing/expired, or the number is suppressed.
- A **signed dial job expires** (15 min default). A signature proves the API
  wrote the job; it says nothing about when, and the gate verdict travels inside
  the job and is never re-checked at the dialler — so an old job is an old
  authorization, possibly from before the person opted out.
- A **redelivered dial job does not dial twice**. The endpoint acks 202 and
  dials asynchronously, so an at-least-once queue whose ack is lost would
  otherwise call the same person again.
- **Disclosure is the first thing said on every call**, from the persona file,
  never model-generated.
- An opt-out ends the call **before the LLM gets another turn** — asserted with a
  deliberately hostile brain that tries to keep selling.
- Every exit path reports an outcome: no-answer, hangup, silence, dead brain, crash.
- A CRM outage never loses an opt-out.
- No unmasked phone number or secret appears in any log, API response, CRM event,
  or dial job.
- The agent never answers its own echo, and an **opt-out is never suppressed as
  echo** — that override is absolute and tested in six languages/scripts.
- A TTS provider failing costs **one hop**, not the call. Reaching the robotic
  on-device browser voice now takes every provider in the chain failing.
- The UI never claims a voice it cannot serve. A male voice needs either Google
  Cloud TTS or a self-hosted VoiceStudio with a **pinned male clone**; a gender
  with no concrete voice behind it is refused rather than approximated, and the
  male preset says so instead of playing a woman under a man's name.
- A translation outage returns the **original English**, never silence.
- The AI disclosure is never machine-translated — its per-language wording,
  including the masculine Hindi form, is versioned in the persona file.
- A recording is **refused** when the configured region is not Indian — refused,
  not warned about, so nothing is uploaded to the wrong jurisdiction.
- No playable recording URL reaches a CRM note, an event, or a log. Playback
  requires the operator key and expires in minutes.

---

## 🚫 Blocking a real launch

### 1. The provider wire format is unverified
**The media server now exists** — RFC 6455 handshake and framing (verified against
Node's native WebSocket client), the `/answer` XML endpoint, per-provider codecs,
and a full call driven over a real socket in CI: disclosure → qualification →
opt-out, with barge-in sending the provider a clear-audio command.

What is unverified is the **codec layer** — the JSON envelopes Plivo and Exotel
actually send (`event: "media"`, base64 payload shapes, sample-rate negotiation).
Those follow the published docs but have never seen a live provider socket. It is
the cheapest thing in this document to fix: one real call tells you, and it is one
file (`media/server.js`, `codecs`).

### 2. Telephony adapters are unverified against live accounts
`plivo.js` and `exotel.js` are written to the documented APIs and have **never run
against a real account** — no credentials exist in this repo or in CI. This is
WP-1 in the spec: place **one real call on each** before trusting either.

### 3. STT on real telephony audio is unproven
The Sarvam TTS path mirrors the code the live web demo already uses. The **STT path
has never seen 8kHz μ-law from a phone line**, which is materially harder than
browser mic audio. Number and name accuracy on real telephony audio is an explicit
acceptance criterion in the spec and is **not yet met**.

**The experiment is now cheap, which is new.** `STT_PROVIDER=voicestudio` puts
WhisperX, Faster-Whisper, Parakeet, FunASR and sherpa-onnx behind one endpoint on
a box we run, so this is no longer "buy a vendor and hope": record one real call,
replay it through several engines, measure number and name accuracy — those are
what the flow actually extracts (budget, BHK, the caller's name). See
`deploy/voicestudio/README.md` §5. Until that runs, `STT_PROVIDER=sarvam`.

### 4. No durable datastore — CODE DONE, **NOT SET ON THE DEPLOYMENT**

> ⚠️ **Checked 2026-08-05 against the live deployment and this section was
> overstating things.** `GET /api/integrations/health` returns
> `store.backend: "memory"`, `durable: false`, `projectId: null` — meaning
> **`FIREBASE_SERVICE_ACCOUNT` is not set as a Vercel environment variable.**
> The code below is written and tested; the running site is not using it. Right
> now an opt-out on the deployed demo lives in one warm instance and is gone
> when that instance recycles.
>
> Fix: set `FIREBASE_SERVICE_ACCOUNT` (the whole service-account JSON, or its
> base64) in the Vercel project's environment variables, redeploy, and confirm
> `store.backend` reads `firestore` and `reachable` is `true`.
>
> The lesson worth keeping: "the code is written and the tests pass" and "the
> deployment does this" are different claims, and only the health endpoint
> settles the second one. This document exists so nobody finds that out during
> launch week.

Firestore is wired **in code**: project `anaga-2c61c`, `(default)` database,
**asia-south1 (Mumbai)** — which also satisfies the Indian data-residency
requirement in `docs/COMPLIANCE.md`. Verified live from a workstation with the
credential present:
- **the suppression list survives restarts** — the opt-out no longer dies with
  the instance,
- **lead dedupe is atomic across instances** (create-if-absent → 409 for the
  loser), closing a real double-dial risk on Meta retries,
- the console reads durable history instead of one instance's buffer.

Dependency-free: the Firestore REST API with a service-account JWT signed by
`node:crypto`, so no build step and no `firebase-admin` cold-start cost.

**Two operational notes:**
1. If the project is suspended (billing lapse) or unreachable, the gate
   **blocks every dial** rather than allowing them. Verified by test. Calls stop;
   nobody gets called who shouldn't. Watch for `datastore_unreachable` in
   `/api/integrations/health`.
2. Queries avoid composite indexes by design (point reads by id, or single-field
   `orderBy`). A missing composite index is a hard 400 at runtime, not a slow
   query, so there is nothing to administer before launch.

### 5. Regulatory prerequisites — not code
- [ ] DLT principal entity registration
- [ ] 160-series outbound number provisioned (`OUTBOUND_CALLER_ID`)
- [ ] Telemarketer registration
- [ ] DND scrub provider contract (`DND_SCRUB_URL`)
- [ ] Call recording storage on Indian soil, 90-day retention (`RECORDING_BUCKET`)

~~Recording is **not implemented**.~~ **Implemented.** `api/_lib/recording.js`
stores to any S3-compatible bucket with a hand-rolled SigV4 signature, and two
rules fail closed:

1. **A non-Indian region is refused, not warned about.** Nothing is uploaded.
   `RECORDING_ALLOW_NON_INDIAN_REGION=1` overrides it and is reported as a
   blocker by `/health`.
2. **No playable URL ever reaches a CRM.** What is stored and written is an
   opaque `s3://` reference; playback goes through
   `GET /api/calls/recording` behind the operator key and mints a URL that
   expires in minutes. `DELETE` on the same endpoint is the DPDP erasure path.

**What is still yours to do:** the 90-day expiry is a **bucket lifecycle rule**,
set in your provider's console. This code cannot see it and does not claim to
enforce it — `recordingStatus().retentionEnforcedBy` says `bucket_lifecycle_policy`
for exactly that reason. Set the rule, then verify it.

---

## Pre-flight checklist

The step-by-step version, checked against the live deployment, is in
[`docs/GO_LIVE.md`](docs/GO_LIVE.md). Every remaining blocker there is an unset
environment variable or a business prerequisite — none is unwritten code.


Do not dial a real number until every box is ticked.

One command answers most of this against the LIVE deployment — not the repo,
which is the distinction that made this document wrong about Firestore for weeks:

```bash
BASE=https://your-deploy.vercel.app CALLER_AGENT=https://agent.internal \
  node scripts/preflight.mjs
```

Exit 0 only when every automated gate is green; it names what is missing and
prints the hand-checked list it cannot verify. Underneath it is just:

```bash
curl -s "$BASE/api/integrations/health" | jq '.ready.production, .blockers'
curl -s "$CALLER_AGENT/health" | jq '.canDialForReal, .blockers'
```

- [ ] `/api/integrations/health` → `ready.production: true`, `blockers: []`
- [ ] caller agent `/health` → `canDialForReal: true`
- [ ] `COMPLIANCE_MODE=strict` (never `dev` — health reports `dev` as a blocker)
- [ ] `FIREBASE_SERVICE_ACCOUNT` set **on the deployment**, and
      `/api/integrations/health` shows `store.backend: "firestore"`,
      `reachable: true` (it reads `memory` as of 2026-08-05)
- [ ] `SUPPRESSION_LIST_URL` set and a POST/GET round-trip verified
- [ ] `DND_SCRUB_URL` set, and a **known DND number is provably blocked**
- [ ] `TELEPHONY_PROVIDER` is not `mock` (the agent refuses to start in
      `NODE_ENV=production` if it is)
- [ ] one real call placed to a consenting internal number, end to end
- [ ] that call's opt-out verified to reach the suppression list, and a re-dial
      of the same number verified to be **refused**
- [ ] CI green on the branch being deployed

---

## Competitive position — read before pitching

Against a general voice-AI platform, this system's defensible edges are:

1. **Compliance as code.** The gate fails closed, opt-out propagates before
   anything else, the calling window is re-checked at dial time by the consumer,
   and every refusal is auditable. Most platforms treat DND as the customer's
   problem.
2. **Indic opt-out detection that actually works.** Devanagari and Telugu
   patterns, plus romanized code-mixing. Note that this only works because a bug
   was caught: JavaScript's `\b` is ASCII-only, so every Indic-script pattern
   silently matched nothing until the E2E suite found it. A competitor doing
   English-first regex almost certainly has that bug today.
3. **Endpointing tuned for Indian speech.** A 900ms default instead of the ~500ms
   Western norm, tunable per call, because code-mixed speech pauses longer
   mid-sentence.

What we should **not** claim: that the agent closes deals, that it has been proven
on real telephony audio, or that it is currently making calls. It qualifies and
books; humans close — and right now it does that in tests, not on a phone line.
