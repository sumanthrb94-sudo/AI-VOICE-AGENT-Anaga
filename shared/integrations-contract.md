# Vaak integrations contract (shared)

The wiring between **lead sources** (Meta Lead Ads, a CRM, a landing page), the
**compliance gate**, the **dial queue** (orchestrator / caller agent), and the
**CRM writeback**. Setup runbook: [`docs/INTEGRATIONS.md`](../docs/INTEGRATIONS.md).

Companion to [`call-api-contract.md`](./call-api-contract.md), which covers the
live-call brain (`/api/anaga/turn`, `/api/anaga/summary`).

---

## The pipe

```
 Meta Lead Ads ──► POST /api/integrations/meta/leads ─┐
 CRM / page /                                          │
 CSV / Zapier ──► POST /api/leads/intake ──────────────┤
                                                       ▼
                                            normalize → Lead
                                                       │
                                     1. validate (E.164 phone)
                                     2. dedupe (best effort)
                                     3. CRM upsert         (best effort)
                                     4. COMPLIANCE GATE    (FAILS CLOSED)
                                     5. enqueue dial job ──► DIAL_QUEUE_URL
                                                                  │
                                                        caller agent runs
                                                     /api/anaga/turn (brain)
                                                                  │
                                     POST /api/calls/outcome ◄────┘
                                                       │
                                       opt-out → suppression list
                                       review  → CRM note + score + next action
```

**Nothing dials without passing step 4.** Adding a new lead source means adding
a normalizer, never a new path around the gate.

---

## The Lead object (canonical)

Every source is normalized to this before anything else happens.

```json
{
  "id": "meta_lead_ads:1234567890",
  "source": "meta_lead_ads",
  "sourceId": "1234567890",
  "receivedAt": "2026-08-03T09:12:00.000Z",

  "name": "Ravi Kumar",
  "phone": "+919876543210",
  "email": "ravi@example.com",
  "city": "Hyderabad",
  "lang": "te-IN",

  "known": { "purpose": "investment", "budget": "1-2 Cr" },

  "campaign": {
    "id": null, "name": "Skyline Villaments — Aug",
    "adId": "…", "formId": "…", "pageId": "…", "platform": "facebook"
  },

  "consent": { "granted": true, "basis": "lead_form", "at": "2026-08-03T09:11:40.000Z" }
}
```

- `phone` is **E.164** or `null`. Bare 10-digit Indian mobiles get `+91`.
- `known` is what the ad form already answered — Anaga skips those questions.
- `consent.basis` ∈ `lead_form` | `crm` | `none`. `none` is never dialable.

---

## POST `/api/integrations/meta/leads`

Meta Lead Ads webhook. **Auth: `X-Hub-Signature-256` HMAC over the raw body with
`META_APP_SECRET`.** No valid signature → `403`, nothing processed.

`GET` on the same path answers Meta's subscription handshake using
`META_VERIFY_TOKEN` and returns `hub.challenge` as `text/plain`.

**Request** — Meta's standard envelope:
```json
{ "object": "page",
  "entry": [ { "id": "PAGE_ID", "time": 1754210000,
    "changes": [ { "field": "leadgen",
      "value": { "leadgen_id": "…", "page_id": "…", "form_id": "…", "ad_id": "…", "created_time": 1754209990 } } ] } ] }
```

**Response 200** (always, for a *signed* request — Meta disables subscriptions
that keep receiving non-2xx):
```json
{ "received": true, "processed": 1, "queued": 1,
  "results": [ { "leadgenId": "…", "accepted": true, "queued": true, "steps": { … } } ] }
```

| Status | When |
|---|---|
| `200` | signed and processed (per-lead failures reported inside `results`) |
| `400` | signed but the body is not JSON |
| `403` | missing / bad signature, or `META_APP_SECRET` unset |

---

## POST `/api/leads/intake`

Source-agnostic intake for CRMs, landing pages, CSV uploaders, Zapier.

**Auth:** `Authorization: Bearer $INTEGRATIONS_API_KEY` (or `X-Api-Key`).
Unset key → `503 auth_not_configured`. Fails closed.

**Request** — one lead, or `{ "leads": [ … ] }` (max 100):
```json
{
  "source": "hubspot",
  "sourceId": "contact-8891",
  "name": "Ravi Kumar",
  "phone": "9876543210",
  "email": "ravi@example.com",
  "city": "Hyderabad",
  "purpose": "investment",
  "budget": "1-2 Cr",
  "consent": { "granted": true, "basis": "crm", "at": "2026-08-01T06:30:00Z" },
  "dryRun": false,
  "ignoreWindow": false
}
```

- `dryRun` — run every check including the compliance gate, skip the CRM write
  and the enqueue, and return the dial job that *would* have been sent.
- `ignoreWindow` — queue outside the 09:00–21:00 IST calling window. The caller
  agent must re-check at dial time.

**Response 200**
```json
{ "received": 1, "queued": 1, "blocked": 0,
  "results": [ {
    "accepted": true, "queued": true, "callId": "…", "reason": null,
    "lead": { "id": "…", "phone": "+9198XXXXXX10", "consentBasis": "crm" },
    "steps": {
      "validate":   { "ok": true },
      "dedupe":     { "duplicate": false },
      "crm":        { "ok": true, "recordId": "…", "provider": "hubspot" },
      "compliance": { "allowed": true, "checks": { "shape": true, "consent": true, "suppression": true, "dnd": true, "window": true }, "warnings": [] },
      "queue":      { "queued": true, "callId": "…" }
    } } ] }
```

A refused dial is still a `200` with `accepted: true` and
`reason: "blocked:<why>"` — the lead was received, the call was refused.

**Block reasons:** `invalid_phone` · `no_consent` · `no_consent_basis` ·
`consent_timestamp_missing` · `consent_expired` · `suppressed` ·
`suppression_unverified` · `dnd_registered` · `dnd_unverified` ·
`outside_calling_window`.

---

## POST `/api/calls/outcome`

The caller agent / telephony webhook reports a finished call. Closes the loop:
review → suppression (on opt-out) → CRM writeback.

**Auth:** `Authorization: Bearer $INTEGRATIONS_API_KEY`.

**Request**
```json
{
  "call": { "id": "call_123", "startedAt": "2026-08-03T10:02:00Z",
            "durationSec": 96, "recordingUrl": "https://…", "disposition": "booked" },
  "lead": { "phone": "+919876543210", "name": "Ravi Kumar",
            "source": "meta_lead_ads", "sourceId": "1234567890", "crmRecordId": "8891" },
  "history": [ { "role": "agent", "text": "…" }, { "role": "user", "text": "…" } ],
  "review":  { }
}
```

- `review` optional. If absent and `history` is present, it is generated with
  the same prompt as `/api/anaga/summary`; if the LLM is unavailable a heuristic
  review is used. **The writeback never depends on the LLM being up.**

**Response 200**
```json
{ "ok": true, "callId": "call_123",
  "review": { "interested": true, "score": 78, "disposition": "booked",
              "summary": "…", "nextAction": "…", "comment": "…", "generatedBy": "llm" },
  "optOut": false,
  "suppression": null,
  "crm": { "provider": "hubspot", "logged": true, "error": null, "dncFlagged": null } }
```

Opt-out handling is unconditional: if the disposition is `opt-out` **or** the
transcript contains an opt-out phrase, the number goes to the suppression list
*before* the CRM is touched, and `suppression.durable:false` is logged as an
error — a non-durable suppression means that number can be dialed again.

---

## Outbound: dial job → `DIAL_QUEUE_URL`

Signed `X-Vaak-Signature-256: sha256=<hex hmac of the body with DIAL_QUEUE_SECRET>`.

```json
{ "type": "outbound_call", "version": 1, "createdAt": "…",
  "lead": { "id": "…", "phone": "+91…", "name": "…", "known": { }, "campaign": { } },
  "agent": { "name": "Anaga", "persona": "caller-agent/flows/anaga.persona.json",
             "lang": "en-IN", "turnEndpoint": "/api/anaga/turn", "summaryEndpoint": "/api/anaga/summary" },
  "callback": { "url": "https://…/api/calls/outcome", "auth": "bearer INTEGRATIONS_API_KEY" },
  "telephony": { "callerId": "+91160…", "maxAttempts": 3 },
  "compliance": { "allowed": true, "checks": { }, "warnings": [ ] },
  "crm": { "provider": "hubspot", "recordId": "8891" } }
```

The queue consumer (orchestrator, WP-2) **must** re-check the calling window at
dial time — a job may have been queued with `ignoreWindow`.

---

## Outbound: CRM webhook events (`CRM_PROVIDER=webhook`)

Signed the same way with `CRM_WEBHOOK_SECRET`.

| `event` | Payload | When |
|---|---|---|
| `lead.received` | `{ lead }` | a lead lands, before the gate |
| `call.completed` | `{ lead, review, call }` | a call finishes |
| `lead.optout` | `{ lead, reason }` | the prospect opts out |

---

## Rules (all endpoints)

- POST + JSON; validate input; never echo a secret, token, or upstream URL.
- The compliance gate fails **closed**; CRM writes fail **soft** (a CRM outage
  must never block a dial or lose an opt-out).
- CRM and lead-source vendors live behind adapters
  (`api/_lib/integrations/crm/*`, `api/_lib/integrations/meta.js`). Business
  logic imports the boundary, never a vendor.
- `GET /api/integrations/health` reports which pipes are connected — booleans
  only, never values.
