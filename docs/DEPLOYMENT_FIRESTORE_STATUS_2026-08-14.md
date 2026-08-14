# Deployment Firestore Status

**Checked:** 2026-08-14

The Vercel project **`ai-voice-agent-anaga`** is accessible in the authenticated workspace. Its current production deployment is ready but runs an older source commit, `e9d5677`, on `claude/anaga-voice-meta-crm-w6atbl`.

The project-level environment inventory contains existing application secrets such as Sarvam and Gemini credentials but does **not** contain `FIREBASE_SERVICE_ACCOUNT` or `INTEGRATIONS_API_KEY`. This is consistent with the public health response reporting a memory store rather than durable Firestore persistence.

The supplied Firebase service account was tested locally against the existing target project. The full live durability suite passed: store reachability, suppression reads/writes, idempotency, atomic lead deduplication, event queries, call-record round trips, index-free queries, and cleanup. The readiness branch has a local checkpoint at `44ed4b4`; the supplied credential was not committed.

The user explicitly confirmed adding the existing Firebase credential as a sensitive Vercel environment variable for the **Production and Preview** scopes. No Firestore collection variable or database selector is to be changed. The next action is saving that approved environment variable, followed by a redeploy and a health verification.

## Applied production configuration

The project’s `FIREBASE_SERVICE_ACCOUNT` variable has now been added as a **Sensitive** Vercel project environment variable scoped to **Production and Preview**. No `FIRESTORE_*` setting, collection name, or database identifier was changed.

A production redeploy of the existing current deployment has been started so the new server-side environment variable can take effect. The next verification step is to confirm the canonical health endpoint changes from `store.backend: "memory"` to `store.backend: "firestore"` with `store.reachable: true`.

## Live verification result

The production redeploy completed successfully. The canonical health endpoint now reports:

| Check | Live result |
|---|---|
| `store.backend` | `firestore` |
| `store.durable` | `true` |
| `store.reachable` | `true` |
| `store.error` | `null` |
| Durable suppression backend | `firestore` |

Firestore persistence is therefore active on the live application. The production readiness status remains `false` only because unrelated outbound-call controls are still deliberately absent: Meta lead configuration, the integration endpoint key, DND scrub, dial queue, outbound caller ID, and compliant recording storage.

The temporary local environment-import file was deleted after the Vercel update. The supplied credential remains only in the user-provided upload and the approved Vercel server-side secret store; it was not added to Git.
