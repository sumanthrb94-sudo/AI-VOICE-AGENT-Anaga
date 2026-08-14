# Vaak AI Production Configuration Runbook

**Purpose.** This is the ordered, operator-facing configuration sequence for the remaining live-production gates. It preserves the deployed Firebase contract exactly: **do not change** `FIREBASE_SERVICE_ACCOUNT`, `FIRESTORE_DATABASE_ID`, or any existing Firestore collection names.

> **Do not add Groq now.** The deployed backend currently implements only the `sarvam` and `gemini` LLM adapters. Adding `GROQ_API_KEY` by itself will do nothing. Use Sarvam as the primary conversational LLM and Deepgram for English speech recognition first; both are already designed into the service. Groq is a later, optional code change—not a prerequisite for launch.

The live health endpoint currently reports six production blockers: Meta Lead Ads, integration endpoint authentication, DND scrubbing, the dial queue, an outbound caller ID, and recording storage. Firestore persistence and the durable suppression list are already live. [1]

| Order | Gate | Owner | Can be completed now? |
|---|---|---|---|
| 1 | Set service-to-service secrets and URLs | Engineering | Yes |
| 2 | Configure Sarvam and Deepgram routing | Engineering | Yes |
| 3 | Create India-region recording storage | AWS administrator + Engineering | Yes |
| 4 | Wire Meta Lead Ads | Meta Business/Page administrator + Engineering | Yes, if Page access is available |
| 5 | Deploy and connect the dial-job receiver | Engineering + telephony administrator | Yes, except live calls remain blocked until steps 6–7 |
| 6 | Obtain and normalize a DND scrub service | DLT/telephony provider + Engineering | Requires provider contract |
| 7 | Complete Principal Entity / telemarketer / caller-ID onboarding | Business + telephony provider | Requires external approval |
| 8 | Complete controlled end-to-end validation | Engineering + business owner | Only after all preceding gates pass |

## 1. Configure the core secrets and callback URL

Create the following secrets from an operator-controlled terminal. Do **not** paste them into source files, Git, browser JavaScript, or a public chat.

```bash
openssl rand -hex 32   # INTEGRATIONS_API_KEY
openssl rand -hex 32   # DIAL_QUEUE_SECRET
openssl rand -hex 32   # META_VERIFY_TOKEN
```

In **Vercel → ai-voice-agent-anaga → Settings → Environment Variables**, add the values below to **Production**. Add the same non-production values to **Preview** only if preview testing is intentionally required; production and preview should not share a real telephony or Meta token.

| Variable | Production value | Where else it must exist | Reason |
|---|---|---|---|
| `INTEGRATIONS_API_KEY` | First generated secret | Cloud Run caller-agent | Protects lead intake, outcome reporting, transcript access, recording playback, and Firestore certification. |
| `PUBLIC_BASE_URL` | `https://ai-voice-agent-anaga.vercel.app` | Cloud Run caller-agent may instead use `VAAK_API_BASE_URL` | Builds Meta and outcome callback URLs. |
| `COMPLIANCE_MODE` | `strict` | Cloud Run caller-agent | Ensures an unavailable DND result blocks, rather than allows, a call. |
| `CALLING_WINDOW_START_IST` | `9` | Cloud Run caller-agent | Start of allowed call window. |
| `CALLING_WINDOW_END_IST` | `21` | Cloud Run caller-agent | End of allowed call window. |

Set `VAAK_API_BASE_URL=https://ai-voice-agent-anaga.vercel.app` and the **same** `INTEGRATIONS_API_KEY` on the Cloud Run caller-agent. The caller agent uses that key when it reports `/api/calls/outcome`; a mismatch prevents completion and opt-out data from being reported.

After redeploying Vercel, run the authenticated Firestore certification once from a protected terminal:

```bash
export BASE='https://ai-voice-agent-anaga.vercel.app'
export INTEGRATIONS_API_KEY='<retrieve securely from your secret manager>'

curl --fail-with-body --request POST \
  "$BASE/api/integrations/firestore-verify" \
  --header "Authorization: Bearer $INTEGRATIONS_API_KEY"
```

**Pass condition:** HTTP 200 with `ok: true`, `verified: true`, and `cleaned: true`. The probe writes, reads, and removes one labelled verification document; it does not alter lead or call records.

## 2. Use the keys you already have: Sarvam and Deepgram

Configure both keys as **server-side secrets** on Vercel and Cloud Run. Vercel uses them for API/batch routes; Cloud Run uses them in the live call path.

| Variable | Recommended production value | Purpose |
|---|---|---|
| `SARVAM_API_KEY` | Your Sarvam key | Sarvam Saaras STT, Bulbul TTS, and the primary LLM. |
| `DEEPGRAM_API_KEY` | Your Deepgram key | Deepgram Nova-3 for English STT and the live streaming bridge. |
| `STT_PROVIDER` | `sarvam,deepgram` | Global fallback chain. |
| `STT_PROVIDER_EN_IN` | `deepgram,sarvam` | English: Deepgram first, Sarvam fallback. |
| `STT_PROVIDER_TE_IN` | `sarvam,deepgram` | Telugu: Sarvam first, Deepgram fallback. |
| `STT_PROVIDER_HI_IN` | `sarvam,deepgram` | Hindi: Sarvam first, Deepgram fallback. |
| `DEEPGRAM_MODEL` | `nova-3` | Current configured Deepgram model. |
| `LLM_PROVIDER` | `sarvam,gemini` | Sarvam primary, existing Gemini fallback. |
| `SARVAM_LLM_MODEL` | `sarvam-105b-conversations` | The existing real-time voice-agent default. |

After deployment, inspect the non-secret health output:

```bash
curl -s "$BASE/api/integrations/health" | jq '.brain, .stt, .tts'
```

**Pass condition:** `brain.ready` includes `sarvam`; `stt.ready` includes both `sarvam` and `deepgram`; `stt.byLang.en-IN.serves` becomes `deepgram`; Telugu and Hindi remain Sarvam-first. This is not a production blocker by itself, but it activates the intended English STT routing and a real fallback path.

### Why Groq is optional, not required

The current code recognizes only `sarvam` and `gemini`, so `GROQ_API_KEY` and `LLM_PROVIDER=sarvam,groq,gemini` cannot work until a Groq adapter and tests are added. Sarvam is the correct first choice because it is already the configured speech and Indic conversational provider; it avoids adding another vendor, another egress path for conversation text, and a new operational failure mode.

Groq is technically attractive as a future fallback: its production `llama-3.1-8b-instant` model is documented at about 560 tokens/second and $0.05 per million input tokens plus $0.08 per million output tokens. [2] However, Groq’s free tier is rate-limited and rate limits apply at the organization level, so it should not be treated as a no-cost production availability guarantee. [3] If Sarvam quality or reliability testing later shows a need for a third provider, implement and test a Groq adapter first, then place it **after Sarvam** as `sarvam,groq,gemini`. Do not add its key before that code change.

## 3. Create the India-region call-recording bucket

Use an AWS S3 bucket in **Asia Pacific (Mumbai), `ap-south-1`**. Hyderabad, `ap-south-2`, is also accepted by the application. AWS documents both as S3 Regions. [4] This runbook uses S3 because the application already signs native S3 requests and therefore needs no storage SDK or additional service.

### 3.1 Create and harden the bucket

1. Sign in to the AWS account that will own call recordings and select **Asia Pacific (Mumbai) `ap-south-1`** in the region selector.
2. Open **S3 → Create bucket**. Use a globally unique, non-identifying name such as `vaak-call-recordings-ap-south-1-<account-suffix>`.
3. Keep **Block all public access** enabled. Do not turn off any public-access block and do not add a public-read policy.
4. Keep **Object Ownership: Bucket owner enforced**. This disables ACL-based access control, which AWS recommends for most modern S3 usage. [5]
5. Keep default server-side encryption enabled. The application writes every recording with the `AES256` server-side-encryption header; S3 also encrypts new uploads at rest by default. [5]
6. Do **not** configure cross-region replication to a non-Indian Region. Do not configure a CDN, static website endpoint, or public object URL.

### 3.2 Add the mandatory 90-day lifecycle rule

The application reports only its requested retention duration. The **bucket lifecycle policy** is the actual control that satisfies retention; the health endpoint cannot prove its existence.

1. In the bucket, open **Management → Lifecycle rules → Create lifecycle rule**.
2. Name it `expire-call-recordings-after-90-days`.
3. Scope the rule to the prefix `calls/`.
4. Select **Expire current versions of objects** after **90 days**.
5. Prefer a **non-versioned bucket** for this retention-only audio store. If your organization requires versioning, also configure expiration for noncurrent versions; S3 lifecycle expiration of a current version creates a delete marker, and noncurrent versions require their own rule to be removed. [6]
6. Save the rule and record a screenshot or exported lifecycle JSON in your compliance evidence store.

> AWS lifecycle expiry is asynchronous. An object is eligible at the configured age and may be removed shortly afterward. Do not claim a stronger deletion-time guarantee than the lifecycle policy provides. [6]

### 3.3 Create a least-privilege upload identity

Create a dedicated IAM user or machine identity named, for example, `vaak-call-recording-prod`. Create an access key only for this purpose and store it in the approved secret manager. AWS generally recommends temporary IAM roles where the hosting platform supports them; this Vercel/Cloud Run configuration requires a restricted S3-compatible access-key pair. [5]

Attach an **identity policy** equivalent to the following, replacing the bucket name. The application needs only `PutObject`, `GetObject` for short-lived signed playback, and `DeleteObject` for an approved erasure request. It does not need blanket account or bucket-list permissions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VaakCallRecordingObjectsOnly",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::REPLACE_WITH_BUCKET_NAME/calls/*"
    }
  ]
}
```

Add a bucket policy that denies non-TLS requests. AWS documents `aws:SecureTransport` for this purpose. [7]

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::REPLACE_WITH_BUCKET_NAME",
        "arn:aws:s3:::REPLACE_WITH_BUCKET_NAME/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

### 3.4 Add the storage configuration to both services

Set the following values in **Vercel Production** and on the **Cloud Run caller-agent**. The same bucket and credentials are intentional: Cloud Run uploads finished WAV files directly, while Vercel mints protected short-lived playback links and handles deletion.

| Variable | Value |
|---|---|
| `RECORDING_BUCKET` | Your bucket name only, without `s3://` or a URL |
| `RECORDING_REGION` | `ap-south-1` |
| `RECORDING_ACCESS_KEY_ID` | IAM access-key ID for the restricted identity |
| `RECORDING_SECRET_ACCESS_KEY` | Matching secret access key |
| `RECORDING_RETENTION_DAYS` | `90` |
| `RECORDING_ENDPOINT` | Leave unset for AWS S3 |
| `RECORDING_ALLOW_NON_INDIAN_REGION` | **Leave unset** |
| `CALL_RECORDING` | Leave unset/on; do not set `off` |
| `CALL_MAX_SECONDS` | `300`, or your approved maximum |

Redeploy Vercel and Cloud Run. Then run:

```bash
curl -s "$BASE/api/integrations/health" | jq '.recording'
```

**Pass condition:** `configured: true`, `region: "ap-south-1"`, `indianRegion: true`, `usable: true`, and `retentionDays: 90`. Then place **one consented internal test call**, confirm that the object is under `calls/YYYY-MM-DD/<call-id>.wav`, verify the bucket remains private, and confirm playback requires the operator key and receives only a short-lived signed URL.

## 4. Configure Meta Lead Ads

Meta webhooks send only the `leadgen_id`; the application fetches the full form response with a Page access token. The Page must install the app and subscribe to the `leadgen` field before notifications are delivered. [8]

### 4.1 Prepare Meta assets and permissions

1. In [Meta for Developers](https://developers.facebook.com/apps/), create or select the business app that will own this integration.
2. Confirm that the Facebook Page running the Lead Ads is owned by or accessible to the business.
3. Ensure the person generating the Page token has the Page **ADVERTISE** task. Meta lists this as a requirement for subscribing the app to the Page. [8]
4. Request only the permissions required by the integration. Meta’s current Lead Ads documentation lists `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, and ad-management permissions for retrieving lead/ad data and webhooks. [8] [9]
5. In **Leads Access Manager**, confirm that the app/user can access lead data for the selected Page and form. If business administrators customized lead access, Page administration alone may not grant data access. [9]
6. Keep the app in Development mode only for role-based testing. Before receiving production leads from people outside app roles, complete Meta App Review and business verification as required, then move the app to Live mode. Meta documents that development-mode apps cannot retrieve general lead data. [10]

### 4.2 Create the token and Vercel secrets

1. In the app dashboard, copy **App Secret** from **Settings → Basic**. This becomes `META_APP_SECRET`.
2. Generate a random `META_VERIFY_TOKEN`; it is an application-controlled string, not a Meta-issued credential.
3. Use Graph API Explorer with the correct app selected to obtain a User token with the approved permissions. Exchange or select the appropriate Page token through Meta’s supported Page-token flow, then create/store the long-lived Page access token according to your Meta account’s current token procedure. Treat it like a password.
4. Set the following Vercel **Production** variables:

| Variable | Value |
|---|---|
| `META_APP_SECRET` | App Secret from Meta |
| `META_VERIFY_TOKEN` | Newly generated verification secret |
| `META_PAGE_ACCESS_TOKEN` | Long-lived Page access token |
| `META_GRAPH_VERSION` | `v26.0` after testing; make the version explicit |

The repository currently defaults to `v21.0`, while Meta’s current lead-retrieval documentation uses `v26.0`. Set `v26.0` only after the verification and test-lead checks below pass; the adapter accepts an explicit Graph version. [9]

### 4.3 Register and install the webhook

1. Redeploy Vercel after saving the Meta values.
2. In **Meta App Dashboard → Webhooks**, add the **Page** object.
3. Use the following callback URL:

   ```text
   https://ai-voice-agent-anaga.vercel.app/api/integrations/meta/leads
   ```

4. Enter the exact `META_VERIFY_TOKEN` value as the Verify Token.
5. Subscribe to the **`leadgen`** field.
6. Ensure Vercel deployment protection does not require an interactive login on this webhook route; Meta must reach it unauthenticated for the handshake and notifications.
7. Install the app on the Page. Meta documents this call shape:

   ```bash
   curl --request POST \
     "https://graph.facebook.com/v26.0/REPLACE_WITH_PAGE_ID/subscribed_apps?subscribed_fields=leadgen" \
     --data-urlencode "access_token=RETRIEVE_PAGE_TOKEN_SECURELY"
   ```

8. Confirm installation with the corresponding `GET /<PAGE_ID>/subscribed_apps` request. Meta reports an empty `data` list if no app is installed. [8]

### 4.4 Test before using a real campaign

1. Open Meta’s Lead Ads Testing Tool and select the Page and form.
2. Create one test lead using a consented internal identity.
3. Check Vercel function logs. Expected sequence: a signed `leadgen` POST is accepted, the API fetches the lead record, normalizes the form data, runs the compliance gate, and either produces a signed queue job or refuses safely with the reason.
4. Confirm that no dial occurs until DND, the queue, and caller-ID gates are configured.
5. If Meta returns a Graph permission error, recheck Page task assignment, Leads Access Manager access, app review/live state, and the long-lived token.

## 5. Configure the dial queue and Cloud Run receiver

The repository already contains the dial-job receiver. It exposes:

| Endpoint | Function |
|---|---|
| `POST /jobs` | Receives a signed, compliance-authorized outbound job. |
| `GET /health` | Reports caller-agent readiness. |

Deploy `caller-agent/` to its Cloud Run service in the approved India region and obtain its HTTPS URL. Set the Vercel values below:

```text
DIAL_QUEUE_URL=https://YOUR_CALLER_AGENT_RUN_URL/jobs
DIAL_QUEUE_SECRET=<the generated 64-hex secret>
```

Set these on the Cloud Run caller-agent:

```text
DIAL_QUEUE_SECRET=<the exact same secret>
VAAK_API_BASE_URL=https://ai-voice-agent-anaga.vercel.app
INTEGRATIONS_API_KEY=<the exact Vercel integration key>
COMPLIANCE_MODE=strict
CALLING_WINDOW_START_IST=9
CALLING_WINDOW_END_IST=21
```

The receiver verifies `X-Vaak-Signature-256`, rejects unsigned or stale jobs, and independently rechecks the calling window. Keep the endpoint public only if it remains protected by this HMAC and is not discoverable as a general-purpose call API; do not add an unauthenticated alternate dial endpoint.

Test the receiver without a live dial by submitting a deliberately invalid or unsigned request and confirming HTTP 403. Only perform the signed, real telephony test after DND and caller-ID onboarding are complete.

## 6. Configure DND scrub: provider contract, not a bypass

Do **not** set `COMPLIANCE_MODE=dev` in production. In strict mode, the service fails closed if it cannot establish that a number is clear.

1. Contract an approved telecom/DLT provider or use the DND service bundled with the telephony provider. The provider must support a real-time lookup before each dial.
2. If the provider’s native API response does not exactly match the application contract, deploy a tiny private adapter service. The adapter keeps the provider credential private and exposes only the normalized contract below.
3. Configure Vercel:

   ```text
   DND_SCRUB_URL=https://YOUR_DND_ADAPTER_OR_PROVIDER/v1/scrub
   DND_SCRUB_API_KEY=<adapter/provider bearer token>
   COMPLIANCE_MODE=strict
   ```

4. The endpoint must implement this exact response contract:

   ```http
   GET /v1/scrub?phone=%2B919876543210
   Authorization: Bearer <DND_SCRUB_API_KEY>

   200 OK
   Content-Type: application/json

   {"dnd": false}
   ```

   Return `{"dnd": true}` for a blocked number. The application also understands `registered` or `blocked`, but standardize on `dnd` to keep the audit trail clear.

5. Test three cases with provider-approved test numbers: a clean result, a DND result, and an outage/timeout. **Pass condition:** clean is eligible only when all other gates pass; DND is rejected; outage is rejected as `dnd_unverified`.

TRAI’s sender guidance requires Principal Entity registration, registered headers/templates where applicable, and acquisition/registration of customer consent before commercial communication. [11] It is not sufficient to merely have a list of ad leads.

## 7. Obtain the compliant outbound caller ID and DLT onboarding

This is a business and telecom-provider workflow, not a Vercel setting.

1. Select the Indian telephony provider that will carry the actual outbound calls and confirm that it supports the required commercial-calling route, real-time DND checks, call recording in India, and Media Streams or the integration required by the caller agent.
2. Register the business as a **Principal Entity** on the provider/TSP DLT process, submit the required legal and business documents, and retain approval evidence.
3. Register approved headers/content/consent templates where the provider and communication type require them. TRAI describes PE registration, header registration, content templates, and consumer-consent registration as the sender-side framework. [11]
4. Complete telemarketer onboarding with the chosen provider and obtain the compliant outbound number. Confirm the carrier’s current eligibility and assignment rules for the required 160-series route before you treat any number as production-approved.
5. Configure Cloud Run only after written provider confirmation:

   ```text
   OUTBOUND_CALLER_ID=+91160XXXXXXXX
   DLT_PRINCIPAL_ENTITY_ID=<approved PE identifier>
   DLT_HEADER=<approved header where applicable>
   TELEPHONY_PROVIDER=<plivo or exotel, matching the deployed adapter>
   ```

6. Add the relevant provider credential variables only to Cloud Run’s secret configuration—not Vercel browser code—and restart the caller agent.

The application requires a caller ID before it considers the dialer ready, but that technical field does **not** replace carrier registration, consent, DND, or legal review.

## 8. Final production verification sequence

Run these checks in order. Stop at the first failure; do not compensate by weakening compliance mode.

| Check | How to verify | Pass condition |
|---|---|---|
| Health | `curl -s "$BASE/api/integrations/health" | jq` | `ready.production: true` and `blockers: []`. |
| Firestore | Authenticated `firestore-verify` POST | `verified: true`, `cleaned: true`. |
| Sarvam/Deepgram | Inspect `.brain` and `.stt` health sections | Both configured; English Deepgram-first. |
| Recording | Health plus S3 lifecycle review | Indian region, private bucket, 90-day lifecycle evidenced. |
| Meta | Lead Ads Testing Tool | Verified callback, valid signature, full lead retrieval. |
| DND | Clean/DND/outage tests | Allow only clean; block DND and failure. |
| Dial queue | Signed job receiver test | HMAC verified; unsigned/stale jobs refused. |
| First real call | One internal consenting number | Disclosure spoken, recording stored, outcome persisted, opt-out test then redial refusal. |

Finally, rotate the Firebase service-account key that was previously exposed in a chat transcript, update `FIREBASE_SERVICE_ACCOUNT` in Vercel with the new key, redeploy, and repeat the Firestore certification. Do not commit the new JSON file.

## References

[1]: https://ai-voice-agent-anaga.vercel.app/api/integrations/health
[2]: https://console.groq.com/docs/model/llama-3.1-8b-instant
[3]: https://console.groq.com/docs/rate-limits
[4]: https://docs.aws.amazon.com/general/latest/gr/s3.html
[5]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html
[6]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html
[7]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html
[8]: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/
[9]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving
[10]: https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads
[11]: https://trai.gov.in/advice-to-senders
