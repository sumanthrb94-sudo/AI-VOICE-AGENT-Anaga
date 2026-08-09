# Go-live — the exact remaining steps

Checked against the live deployment on **2026-08-07**, on commit `b192673`.
Live output, not a plan:

```json
"ready": { "demo": true, "production": false }
"blockers": [
  "meta_lead_ads_not_wired", "integrations_api_key_missing",
  "dnd_scrub_not_configured", "suppression_list_not_configured",
  "datastore_not_durable", "dial_queue_not_configured",
  "outbound_caller_id_missing", "call_recording_not_configured"
]
```

That is **eight**, one more than before implementing call recording. Building it
correctly *added* a blocker rather than removing one: the requirement in
`docs/COMPLIANCE.md` existed the whole time, and until it was implemented the
health endpoint could not see that it was unmet. A readiness list that grows
when you build the thing it asks for is the list working.

**Every one of those is an unset environment variable or a business
prerequisite. None is unwritten code.** Re-check any time with:

```bash
BASE=https://ai-voice-agent-anaga.vercel.app node scripts/preflight.mjs
```

---

## Do these in order — highest leverage first

### 1. `FIREBASE_SERVICE_ACCOUNT` — one variable, two blockers

Closes **`datastore_not_durable`** and **`suppression_list_not_configured`** at
once: the compliance gate accepts Firestore as the durable suppression register,
so the opt-out list stops living in one warm serverless instance.

Value: the whole service-account JSON, or its base64. You already have it at
`.secrets/firebase-adminsdk.json`.

> ⚠️ That key is an admin credential — it bypasses every Firestore rule. It has
> also been pasted into a chat transcript, so **rotate it in the Firebase
> console and set the new one**, don't reuse key id `3d419d1e…`.

Verify: `store.backend` reads `firestore`, `reachable: true`.

### 2. `INTEGRATIONS_API_KEY` — closes `integrations_api_key_missing`

```bash
openssl rand -hex 32
```

Auth for `/api/leads/intake`, `/api/calls/outcome`, `/api/calls/recording` and
the operator console. It **fails closed**: while unset, nothing is authorized,
so no lead push and no outcome report is accepted at all.

### 3. Recording — closes `call_recording_not_configured`

An S3-compatible bucket in
**`ap-south-1` (Mumbai)** or **`ap-south-2` (Hyderabad)**:

```
RECORDING_BUCKET=vaak-recordings
RECORDING_REGION=ap-south-1
RECORDING_ACCESS_KEY_ID=…
RECORDING_SECRET_ACCESS_KEY=…
```

A non-Indian region is **refused**, not warned about — nothing uploads.

**Then set the 90-day lifecycle rule on the bucket.** This code cannot see it
and does not claim to enforce it; `docs/COMPLIANCE.md` requires it.

The audio itself is captured by `caller-agent/src/media/recorder.js`, which
mixes both legs of the call onto one timeline. It is on by default;
`CALL_RECORDING=off` disables it, and `CALL_MAX_SECONDS` is the ceiling — a call
that outruns it is logged as `RECORDING_TRUNCATED` rather than filed as if it
were whole.

### 3b. Transcript and lead score — need `FIREBASE_SERVICE_ACCOUNT`

The transcript, the disposition, the lead score and the scoring breakdown are
written to the `calls` collection by `POST /api/calls/outcome` and read back
through `GET /api/calls/transcript?callId=…` with the operator key. Without
Firestore configured the call still completes and still reports, but the
conversation is not kept — the endpoint logs `CALL_NOT_PERSISTED` at severity
`high` for exactly that case.

The score is computed from the weights in
`caller-agent/flows/real-estate-qualify.flow.json` (`qualification`), not
invented by the model, so it is reproducible and every point is explained in
`scoring.explain`. **Tuning what a lead is worth is an edit to that flow file
and a redeploy — it is not a code change.**

### 4. `PUBLIC_BASE_URL`

`https://ai-voice-agent-anaga.vercel.app`. Used to build the dial job's callback
URLs — wrong or unset means the caller agent cannot report back.

### 5. Meta Lead Ads — closes `meta_lead_ads_not_wired`

```
META_APP_SECRET=…            # Meta app dashboard
META_PAGE_ACCESS_TOKEN=…     # long-lived page token
META_VERIFY_TOKEN=…          # any random string; paste the same one into Meta
```

Webhook: `POST {PUBLIC_BASE_URL}/api/integrations/meta/leads`.
Runbook: [`docs/INTEGRATIONS.md`](INTEGRATIONS.md).

### 6. Dial queue — closes `dial_queue_not_configured`

```
DIAL_QUEUE_URL=…             # where signed dial jobs are POSTed
DIAL_QUEUE_SECRET=…          # openssl rand -hex 32 — the HMAC key
```

The same secret goes on the caller-agent host, which verifies the signature
before dialling anyone.

---

## These two need a person outside engineering

### 7. `OUTBOUND_CALLER_ID` — closes `outbound_caller_id_missing`

The **160-series** number. It requires telemarketer registration and DLT
principal-entity registration first. Not something a deploy can fix.

### 8. `DND_SCRUB_URL` + `DND_SCRUB_API_KEY` — closes `dnd_scrub_not_configured`

A TRAI/DLT DND scrub provider contract. The gate expects:

```
GET {DND_SCRUB_URL}?phone=+91…  ->  200 { "dnd": true|false }
```

**Until this exists, every dial is refused in strict mode** — deliberately.
`COMPLIANCE_MODE=dev` is the only bypass, it is reported as a blocker, and it
must never be set on a deployment that dials real numbers.

---

## Then, before the first real call

The pre-flight cannot check these. Nothing can, except doing them:

- [ ] DLT principal entity registration
- [ ] Telemarketer registration
- [ ] The bucket lifecycle rule really expires objects at 90 days
- [ ] Gemini quota restored — the brain answers `503 quota_exceeded` today, so
      Anaga reads the offline script instead of thinking. **Check the request
      count in the Google console before topping it up**: `/api/anaga/turn` was
      public and unmetered until `b192673`, so the drain may not have been you.
- [ ] One real call to a **consenting internal number**, end to end
- [ ] That call's opt-out verified to reach the suppression list, and a re-dial
      of the same number verified to be **refused**
- [ ] One real call on each telephony provider (`LAUNCH.md` #1, #2) — the codec
      envelopes have never seen a live socket
- [ ] STT measured on that call's audio (`LAUNCH.md` #3)

---

## What "production ready" will and will not mean

When every box is ticked, the system can lawfully place qualification calls,
honour opt-outs durably, record them on Indian soil, and write outcomes back to
a CRM.

It will still be true that **Anaga qualifies and books; humans close.** That
line is in the README because it survives diligence, and no amount of green in
this document changes it.
