# Go-live — the exact remaining steps

Checked against `https://ai-voice-agent-anaga.vercel.app` on **2026-08-07**, on
commit `9299e2b`. Live output, not a plan:

```json
"ready": { "demo": true, "production": false }
"blockers": [
  "meta_lead_ads_not_wired", "integrations_api_key_missing",
  "dnd_scrub_not_configured", "suppression_list_not_configured",
  "datastore_not_durable", "dial_queue_not_configured",
  "outbound_caller_id_missing"
]
```

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

Appears as a blocker once `cc2633c` is live. An S3-compatible bucket in
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
      Anaga reads the offline script instead of thinking
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
