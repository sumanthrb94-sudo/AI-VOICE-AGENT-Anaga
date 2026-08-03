# Launch readiness — Vaak / Anaga

An honest state-of-the-system. Written so nobody discovers a gap the week of launch.

**Bottom line:** the software path from *a Facebook lead* to *a CRM note* is built
and QA-tested end to end — 96 automated tests, including the compliance gate and
the opt-out path. **It cannot legally place a real call yet**, and the remaining
blockers are mostly not code: they are a telephony spike, a DND scrub contract,
and DLT registration.

Run the suites yourself:

```bash
node --experimental-detect-module scripts/test-integrations.mjs   # 46
node --experimental-detect-module scripts/test-media.mjs          # 12
CALLING_WINDOW_START_IST=0 CALLING_WINDOW_END_IST=24 \
  node --experimental-detect-module scripts/test-e2e.mjs          # 38
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
| Endpointing + barge-in | `caller-agent/src/media/transport.js` | media QA (12 cases) |
| Outcome → suppression → CRM writeback | `api/calls/outcome.js` | E2E §2, §5 |
| CRM adapters (HubSpot, Zoho, webhook) | `api/_lib/integrations/crm/` | E2E via webhook |
| Operator console | `web/console.html` | E2E §7 |
| Rate limiting, structured logs, PII masking | `api/_lib/guard.js` | E2E §7 |

### Invariants the tests actually hold you to

- A dial is **refused** when the DND scrub is unreachable, unconfigured, the
  consent is missing/expired, or the number is suppressed.
- **Disclosure is the first thing said on every call**, from the persona file,
  never model-generated.
- An opt-out ends the call **before the LLM gets another turn** — asserted with a
  deliberately hostile brain that tries to keep selling.
- Every exit path reports an outcome: no-answer, hangup, silence, dead brain, crash.
- A CRM outage never loses an opt-out.
- No unmasked phone number or secret appears in any log, API response, CRM event,
  or dial job.

---

## 🚫 Blocking a real launch

### 1. The media server — the last piece of code
`say()`/`listen()` are built and tested against a mock. What does not exist is the
**WebSocket server that carries live telephony audio**: Plivo/Exotel stream audio
to a socket you host and expect Plivo XML back. `MEDIA_SERVER_URL` is where it
plugs in, and both adapters **refuse to dial without it** rather than placing a
call they cannot speak on.

Estimate: this is the largest remaining engineering item. Everything it plugs into
is done.

### 2. Telephony adapters are unverified against live accounts
`plivo.js` and `exotel.js` are written to the documented APIs and have **never run
against a real account** — no credentials exist in this repo or in CI. This is
WP-1 in the spec: place **one real call on each** before trusting either.

### 3. STT on real telephony audio is unproven
The Sarvam TTS path mirrors the code the live web demo already uses. The **STT path
has never seen 8kHz μ-law from a phone line**, which is materially harder than
browser mic audio. Number and name accuracy on real telephony audio is an explicit
acceptance criterion in the spec and is **not yet met**.

### 4. No durable datastore
Pipeline events are an in-process ring buffer. Consequences, all real:
- the console shows a **live view, not history** (it says so),
- lead dedupe is per-instance, so a Meta retry hitting a cold instance can double-dial,
- **`SUPPRESSION_LIST_URL` is the exception and is non-negotiable** — without it
  opt-outs die with the instance. Wire it before the first real call.

### 5. Regulatory prerequisites — not code
- [ ] DLT principal entity registration
- [ ] 160-series outbound number provisioned (`OUTBOUND_CALLER_ID`)
- [ ] Telemarketer registration
- [ ] DND scrub provider contract (`DND_SCRUB_URL`)
- [ ] Call recording storage on Indian soil, 90-day retention (`RECORDING_BUCKET`)

Recording is **not implemented**. The spec requires it; `recordingUrl` is plumbed
through to the CRM note but nothing writes one.

---

## Pre-flight checklist

Do not dial a real number until every box is ticked.

```bash
curl -s "$BASE/api/integrations/health" | jq '.ready.production, .blockers'
curl -s "$CALLER_AGENT/health" | jq '.canDialForReal, .blockers'
```

- [ ] `/api/integrations/health` → `ready.production: true`, `blockers: []`
- [ ] caller agent `/health` → `canDialForReal: true`
- [ ] `COMPLIANCE_MODE=strict` (never `dev` — health reports `dev` as a blocker)
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
