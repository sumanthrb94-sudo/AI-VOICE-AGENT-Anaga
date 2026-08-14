# Firestore Production Persistence Runbook

**Purpose:** Activate and verify the repository’s existing Firestore persistence path without renaming Firebase variables, changing collection names, or placing a service-account key in source control.

## Current deployment position

The public health endpoint currently reports `store.backend: "memory"`, `store.durable: false`, and the blocker `datastore_not_durable`. This means the deployed application is correctly refusing to describe itself as production-ready. It does **not** mean that the source code should be replaced or that a new database should be introduced.

The code now includes an authenticated `POST /api/integrations/firestore-verify` endpoint. It verifies that the configured service account can write, read, and delete a temporary document in the existing `events` collection. The probe does not access or modify lead, suppression, call, or user records; it removes its own temporary document before returning.

| Existing contract | Required production value | Preserve exactly |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Full service-account JSON or base64 JSON, stored only as a server-side deployment secret | Yes |
| `FIRESTORE_DATABASE_ID` | Existing Firestore database identifier, normally `(default)` | Yes |
| `FIRESTORE_COL_SUPPRESSION` | Existing suppression collection name | Yes |
| `FIRESTORE_COL_LEADS` | Existing lead collection name | Yes |
| `FIRESTORE_COL_EVENTS` | Existing event collection name; used for the temporary verification row | Yes |
| `FIRESTORE_COL_CALLS` | Existing call-record collection name | Yes |
| `INTEGRATIONS_API_KEY` | Existing endpoint authentication secret | Yes |

## Secure configuration sequence

Configure the existing values as **production server-side environment variables** in the deployment platform. Do not put a Firebase JSON key in `.env`, browser code, Git, test fixtures, logging, or a public API request.

| Step | Action | Expected health result |
|---|---|---|
| 1 | Add the existing Firebase service-account credential as `FIREBASE_SERVICE_ACCOUNT`. | `store.backend` becomes `firestore`. |
| 2 | Retain or set the existing `FIRESTORE_DATABASE_ID` and collection variables. | `store.projectId` is populated and `store.reachable` becomes `true`. |
| 3 | Ensure `INTEGRATIONS_API_KEY` is present. | The verifier endpoint accepts an authenticated request. |
| 4 | Deploy the current application revision. | The health map includes `endpoints.firestoreVerify`. |
| 5 | Call the verifier once using the integration key. | HTTP 200 with `ok: true`, `verified: true`, and `cleaned: true`. |

The verifier request should be made from an operator-controlled terminal or a protected deployment task. It must never be embedded in client-side JavaScript.

```bash
curl --fail-with-body --request POST \
  "https://<your-domain>/api/integrations/firestore-verify" \
  --header "Authorization: Bearer $INTEGRATIONS_API_KEY"
```

## Pass and fail criteria

| Response | Interpretation | Required action |
|---|---|---|
| `200`, `ok: true`, `store.verified: true`, `store.cleaned: true` | The configured service account can persist and clean up a probe document. | Recheck `/api/integrations/health`; Firestore is ready for the remaining compliance gates. |
| `503`, `store.backend: "memory"` | The service account is absent or malformed in the deployed environment. | Add or correct only `FIREBASE_SERVICE_ACCOUNT`; do not alter collection names. |
| `503`, `store.backend: "firestore"`, `store.error` set | Credentials exist but lack access, target the wrong database, or Firestore is unavailable. | Fix the service account’s Firestore access or the existing database selector. |
| `503`, `store.cleaned: false` | The account could create a probe but could not remove it. | Stop; correct delete permission before enabling production calls. |

## Safety properties

> A Firestore ping alone is not a persistence guarantee. Production calling requires a service account that can complete the write-read-delete path, because call records and opt-outs must be durable.

The health endpoint remains non-destructive and exposes no credential material. The new verifier is destructive only to one short-lived, explicitly labelled probe document in the existing event collection, and it is protected by `INTEGRATIONS_API_KEY` plus a low default request limit.

The application’s existing compliance behavior remains unchanged: an absent or unreachable Firestore store causes suppression checks to be unknown, and strict mode blocks outbound dialing rather than allowing a potentially non-compliant call.

## Validation included in the repository

Run the complete local validation suite before deployment:

```bash
pnpm test
bash scripts/build-static.sh
```

The dedicated verifier test can also be run by itself:

```bash
node scripts/test-firestore-verify.mjs
```

This test uses a local stateful Firestore REST double and proves that the probe writes, reads, deletes, returns no leftover document, and rejects unauthenticated callers.
