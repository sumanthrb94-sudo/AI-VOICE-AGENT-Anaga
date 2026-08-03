# Wiring Anaga to Meta and your CRM — the runbook

How a Facebook/Instagram lead ad or a CRM record becomes an Anaga phone call, and
how the outcome lands back in your CRM. Contract:
[`shared/integrations-contract.md`](../shared/integrations-contract.md).

```
Meta Lead Ad ──► /api/integrations/meta/leads ─┐
CRM / page   ──► /api/leads/intake ────────────┴─► CRM upsert
                                                 └─► COMPLIANCE GATE (fails closed)
                                                     └─► dial job ──► orchestrator
                                                                       └─► Anaga calls
                                                                            (/api/anaga/turn)
                                                                            └─► /api/calls/outcome
                                                                                 ├─► opt-out → DNC list
                                                                                 └─► note + score → CRM
```

Start with `GET /api/integrations/health`. It tells you exactly which pipes are
connected and what still blocks a real dial. Booleans only — safe to open in a
browser.

---

## 0. Base setup (5 minutes)

In Vercel → Project → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `INTEGRATIONS_API_KEY` | a long random string (`openssl rand -hex 32`) |
| `PUBLIC_BASE_URL` | `https://your-deployment.vercel.app` |
| `GEMINI_API_KEY` | your Google AI key (the call brain) |
| `SARVAM_API_KEY` | optional — Indian-language TTS voices |

Redeploy, then:

```bash
curl -s https://your-deployment.vercel.app/api/integrations/health | jq
```

`blockers` lists everything still missing. Work down that list.

---

## 1. Meta (Facebook / Instagram) Lead Ads

### 1.1 What you need from Meta

1. A **Meta app** (Business type) at developers.facebook.com.
2. The **Facebook Page** that runs the lead ads, admin access.
3. Permissions: `leads_retrieval`, `pages_show_list`, `pages_manage_ads`,
   `pages_read_engagement`. These require App Review before the app leaves
   development mode — a Page admin can test without review while in dev mode.
4. A **long-lived Page access token** (Graph API Explorer → get a User token →
   exchange for long-lived → get the Page token from `/me/accounts`).

### 1.2 Set the env vars

| Variable | Where it comes from |
|---|---|
| `META_APP_SECRET` | App → Settings → Basic → App Secret |
| `META_VERIFY_TOKEN` | any random string you invent; you paste the same one into Meta |
| `META_PAGE_ACCESS_TOKEN` | the long-lived Page token from 1.1 |
| `META_GRAPH_VERSION` | `v21.0` (bump when Meta deprecates it) |

### 1.3 Subscribe the webhook

App → **Webhooks** → **Page** → Subscribe to this object:

- **Callback URL:** `https://your-deployment.vercel.app/api/integrations/meta/leads`
- **Verify Token:** the value of `META_VERIFY_TOKEN`
- **Field:** `leadgen` ✅

Meta immediately calls `GET` with `hub.challenge`; the endpoint answers it. If
verification fails, check that `META_VERIFY_TOKEN` matches exactly and that the
deploy is public (no Vercel deployment protection on that path).

Then subscribe your Page to the app:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<PAGE_ID>/subscribed_apps" \
  -d "subscribed_fields=leadgen" \
  -d "access_token=<PAGE_ACCESS_TOKEN>"
```

### 1.4 Test it

Meta's **Lead Ads Testing Tool** (developers.facebook.com/tools/lead-ads-testing)
lets you fire a real webhook for a real form. Submit a test lead, then check the
Vercel function logs — you should see the leadgen id, the compliance verdict, and
whether it queued.

You can also replay a payload yourself; the signature must be real:

```bash
BODY='{"object":"page","entry":[{"id":"1","time":1754210000,"changes":[{"field":"leadgen","value":{"leadgen_id":"999","page_id":"1","form_id":"2","created_time":1754209990}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" -r | cut -d' ' -f1)
curl -s -X POST https://your-deployment.vercel.app/api/integrations/meta/leads \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$BODY" | jq
```

(The Graph fetch will fail for the fake `leadgen_id` — that is the expected
`graph_error_*` in `results`. It proves signature verification and routing work.)

### 1.5 Mapping form questions

Meta's `field_data` uses whatever the form builder named each question. The
adapter matches on substrings — `phone`/`mobile`/`whatsapp`, `email`, `city`,
`budget`, `bhk`/`configuration`, `timeline`/`when`, `purpose`/`investment` — and
keeps everything else as extras on the CRM note. **Anything the form already
answered lands in `lead.known`, and Anaga skips that question on the call.**

If your form uses names the matcher misses, extend `leadFromGraph()` in
`api/_lib/integrations/meta.js` — one file, no other change.

---

## 2. CRM

Pick one with `CRM_PROVIDER`. All four speak the same four-function interface, so
switching is a config change.

### `CRM_PROVIDER=hubspot`

- `HUBSPOT_ACCESS_TOKEN` — a **Private App** token.
- Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`,
  `crm.objects.notes.write`.
- Contacts are matched on the E.164 `phone` property, then created or updated.
- Optional custom properties (create once in HubSpot; writes degrade gracefully
  if they don't exist): `vaak_disposition` (text), `vaak_intent_score` (number),
  `vaak_last_call` (datetime), `vaak_dnd` (checkbox — rename with `CRM_DND_PROPERTY`).

### `CRM_PROVIDER=zoho`

- India DC by default (`https://www.zohoapis.in`); change `ZOHO_API_DOMAIN` and
  `ZOHO_ACCOUNTS_DOMAIN` for other data centres.
- Either `ZOHO_ACCESS_TOKEN` (quick test) or the refresh-token trio
  `ZOHO_REFRESH_TOKEN` + `ZOHO_CLIENT_ID` + `ZOHO_CLIENT_SECRET` (production —
  tokens are refreshed automatically and cached in-instance).
- Records go to the **Leads** module, upserted on `Phone`. Call outcomes become
  **Notes** on the lead plus a `Lead_Status` roll-up.

### `CRM_PROVIDER=webhook` — everything else

Salesforce Flow, Freshsales, LeadSquared, Zapier, Make, n8n, or your own
service. Set `CRM_WEBHOOK_URL` (+ `CRM_WEBHOOK_SECRET`) and consume three signed
events: `lead.received`, `call.completed`, `lead.optout`. Verify the signature:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
// timing-safe compare against req.headers['x-vaak-signature-256']
```

### `CRM_PROVIDER=none` (default)

No-ops that log. Lets you build and verify the Meta → compliance → queue path
before any CRM credentials exist.

### Pushing leads FROM your CRM

Any CRM that can call a webhook can feed Anaga:

```bash
curl -X POST https://your-deployment.vercel.app/api/leads/intake \
  -H "Authorization: Bearer $INTEGRATIONS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "source": "hubspot",
        "sourceId": "contact-8891",
        "name": "Ravi Kumar",
        "phone": "9876543210",
        "city": "Hyderabad",
        "budget": "1-2 Cr",
        "consent": { "granted": true, "basis": "crm", "at": "2026-08-01T06:30:00Z" },
        "dryRun": true
      }' | jq
```

`dryRun: true` runs every check — including the compliance gate — and returns the
dial job that *would* have been queued. Use it to prove your wiring before a
phone rings.

---

## 3. The compliance gate (read this before you dial anything)

Five checks, first failure wins. **Unconfigured means blocked.**

| # | Check | Blocks when |
|---|---|---|
| 1 | shape | the phone isn't dialable E.164 |
| 2 | consent | no basis, no timestamp, or older than `LEAD_CONSENT_WINDOW_DAYS` (90) |
| 3 | suppression | the number is on our do-not-call list, or the list can't be reached |
| 4 | DND scrub | the number is DND-registered, or the scrub can't be reached |
| 5 | calling window | outside 09:00–21:00 IST |

Wire the two external services:

- `DND_SCRUB_URL` + `DND_SCRUB_API_KEY` — `GET ?phone=+91… → { "dnd": true|false }`
- `SUPPRESSION_LIST_URL` (+ `SUPPRESSION_LIST_TOKEN`) —
  `GET ?phone=+91… → { "suppressed": true|false }` and
  `POST { phone, reason, at, source } → 2xx`

Both are plain HTTP so you can front any DLT aggregator, operator API, or your
own `.NET` service (WP-6) without changing this code.

`COMPLIANCE_MODE=dev` downgrades "can't verify" from *block* to *warn* so you can
develop without a scrub provider. Every allowed dial then carries a warning, and
`/api/integrations/health` lists it as a blocker. **Never set it on a deployment
that dials real numbers.**

**Opt-outs.** `/api/calls/outcome` writes the number to the suppression list
*before* touching the CRM, and treats an opt-out phrase in the transcript as an
opt-out even if the agent reported a different disposition. Without
`SUPPRESSION_LIST_URL` the block only survives inside one warm serverless
instance — the endpoint logs that as an error, and it is the single most
important thing to wire before real calls.

---

## 4. The dial queue — the one piece that isn't code yet

Everything above ends at a **dial job** POSTed to `DIAL_QUEUE_URL`. The consumer
— the orchestrator (WP-2) driving the caller agent (WP-3) over Plivo/Exotel — is
not in this repo yet. Until it exists, leads are accepted, gated, and written to
the CRM, and the response says `queued: false, reason: "dial_queue_not_configured"`.
That is the honest state of the system, not a silent drop.

The job payload (see the contract) carries everything a consumer needs: the lead,
what the ad form already answered, the persona, the brain endpoints, the
compliance verdict that authorized the dial, and the callback URL to report back
to. A consumer must:

1. verify `X-Vaak-Signature-256` against `DIAL_QUEUE_SECRET`;
2. **re-check the calling window** at dial time (jobs can be queued ahead of it);
3. run the call through `/api/anaga/turn` — the same brain the web demo uses;
4. POST the result to `/api/calls/outcome` with `Authorization: Bearer $INTEGRATIONS_API_KEY`.

Any queue works: an HTTP endpoint on the orchestrator, a QStash/Inngest URL, or a
Cloud Run service. Nothing above this line changes.

---

## 5. End-to-end smoke test

```bash
BASE=https://your-deployment.vercel.app

# 1. what's wired?
curl -s $BASE/api/integrations/health | jq '.ready, .blockers'

# 2. push a lead, dry run — proves normalize + gate
curl -s -X POST $BASE/api/leads/intake \
  -H "Authorization: Bearer $INTEGRATIONS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Test Lead","phone":"9876543210","consent":{"granted":true,"basis":"crm","at":"'"$(date -u +%FT%TZ)"'"},"dryRun":true}' \
  | jq '.results[0].steps.compliance, .results[0].job'

# 3. report a finished call — proves review + CRM writeback + opt-out handling
curl -s -X POST $BASE/api/calls/outcome \
  -H "Authorization: Bearer $INTEGRATIONS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"call":{"id":"smoke-1","disposition":"booked"},
       "lead":{"phone":"9876543210","name":"Test Lead"},
       "history":[{"role":"agent","text":"Hi, I am Anaga, an AI assistant from Vaak. Do you have a minute?"},
                  {"role":"user","text":"Yes. Looking for a 3BHK around 2 crore, to live in."},
                  {"role":"agent","text":"Would Saturday work for a site visit?"},
                  {"role":"user","text":"Saturday works."}]}' | jq
```

Expected on a bare deploy: step 2 blocks with `dnd_unverified` (correct — the
gate is doing its job), step 3 returns a review with `crm.provider: "none"`.
Wire the scrub + a CRM and the same commands go green.

---

## 6. The operator console

`/console.html` is the surface for the pipeline above — leads in, compliance
verdicts, calls queued, outcomes, and what is still unwired. It reads
`GET /api/console/summary` and asks for the `INTEGRATIONS_API_KEY` on open
(held in `sessionStorage` for the tab only, never written to disk).

Two things it deliberately does **not** do:

- **It never shows a number the API didn't return.** No seeded demo data. An
  empty pipeline renders an empty state telling you which curl fills it.
- **It never implies durability the backend doesn't have.** Counts come from a
  per-instance ring buffer (`api/_lib/events.js`), so the console renders a
  standing "live view, not history" banner until `DATABASE_URL` is wired. When
  it is, `record()` is the one call site to change.

Its design comes from `design-system/vaak-console/`, generated by the
`ui-ux-pro-max` skill vendored at `.claude/skills/ui-ux-pro-max` — style
"Data-Dense Dashboard", dials variance 3 / motion 2 / density 8. Regenerate or
extend it with:

```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py \
  "internal analytics dashboard admin operations monitoring data-dense enterprise" \
  --design-system --variance 3 --motion 2 --density 8 -p "Vaak Console" --output-dir "$(pwd)"
```

The console is intentionally **not** styled like the marketing home screen: it
runs its own denser token scale, a 12-column grid, smaller type, and almost no
motion. The two surfaces share only the brand accent.

## 7. What each piece owns

| Concern | File |
|---|---|
| Meta webhook + Graph fetch + field mapping | `api/_lib/integrations/meta.js` |
| Canonical Lead + phone normalization | `api/_lib/integrations/lead.js` |
| Compliance gate, DND scrub, suppression | `api/_lib/compliance.js` |
| Intake pipeline (the order of operations) | `api/_lib/pipeline.js` |
| Dial job + orchestrator hand-off | `api/_lib/queue.js` |
| CRM boundary + note rendering | `api/_lib/integrations/crm.js` |
| CRM adapters | `api/_lib/integrations/crm/{none,webhook,hubspot,zoho}.js` |
| HTTP/HMAC/auth helpers | `api/_lib/integrations/http.js` |
| Pipeline event log (live view) | `api/_lib/events.js` |
| Console API | `api/console/summary.js` |
| Console UI | `web/console.html`, `web/assets/console.{css,js}` |
| Console design system | `design-system/vaak-console/` |

Adding a CRM is one adapter file plus one line in the switch in `crm.js`. Adding
a lead source is one normalizer that calls `intakeLead()` — which is the only way
to reach the dial queue, so the gate cannot be routed around.
