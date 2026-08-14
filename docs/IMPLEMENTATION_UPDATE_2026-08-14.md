# Implementation Update: Provider Metering and Deployment Readiness

**Date:** 2026-08-14  
**Scope:** Second clean-build implementation increment following the repository audit and portable-validation foundation.

## Deployment verification

A read-only inspection of the existing Vercel project confirmed that the current preview deployment responds successfully from Mumbai (`bom1`) and is ready for demo and live-call service paths. The health endpoint reports an available Sarvam/Gemini LLM chain, Sarvam STT/TTS capability, and Deepgram configured as the live-STT route.

> **The deployment is not production-ready for outbound calls.** It correctly reports `production: false` because its current durable store is memory, and the required legal and integration gates remain incomplete.

| Health area | Observed status | Meaning |
|---|---|---|
| Demo and call capability | Ready | The configured brain, speech recognition, and speech synthesis paths are present. |
| Firebase/Firestore | Memory store; non-durable | No Firebase connection was changed. A deployment-side `FIREBASE_SERVICE_ACCOUNT` must be configured and verified before production calling. |
| Compliance | Strict mode; no DND scrub or durable suppression list | Correctly blocks production outbound calling. |
| Dial queue and caller ID | Not configured | No real outbound dial can be initiated from this deployment. |
| Recording | No active recording bucket | Production recording remains blocked until Indian-region storage and retention are configured. |
| Meta lead integration | Not configured | Lead ads cannot yet enter the production funnel. |

## Implementation completed

This increment adds a provider-neutral call-usage ledger in `shared/call-usage.js`. It records only numeric operational data: audio duration, synthesized characters, LLM input/output character estimates, selected provider, cache state, and call duration. It never records audio bytes, prompts, transcripts, or phone numbers.

| Component | Change | Operational benefit |
|---|---|---|
| Live bridge | Meters incoming Deepgram-streamed audio and outgoing TTS phrase usage, including the serving provider after fallback | A completed call can now show which speech providers actually consumed units. |
| LLM adapter and caller composition | Marks structured LLM responses with the non-public serving provider and propagates TTS provider/fallback metadata | Fallbacks are attributable rather than silently blended into average cost. |
| Cloud Run agent server | Emits a numeric-only `call_usage` log event for browser and Twilio calls | Unit and cost analysis can be performed from Cloud Run logs without storing conversation content there. |
| Authenticated outcome endpoint | Sanitizes and stores accepted usage metadata with the durable call record | The protected single-call operator review can show cost context alongside the transcript. |
| Call view | Shows usage only with a protected single-call transcript request, never in a bulk call list | Cost data stays least-privilege and avoids increasing routine operator payloads. |
| Health endpoint | Returns `usage` rate-readiness names and currency, never commercial rate values | Operators can see whether a complete estimate is possible without exposing contracted rates. |
| Environment contract | Adds explicit STT routing and rate-input variables to `.env.sample` | Routing and costing are deployment configuration, not hidden code assumptions. |

## Cost-estimation contract

Costs are intentionally based only on environment variables set from the organization’s actual vendor agreements and telephony invoices. The code does not embed public list prices, tax assumptions, or an INR/USD conversion.

| Input family | Example purpose | Behaviour when absent |
|---|---|---|
| `CALL_COST_STT_*_PER_MINUTE` | Streaming or batch recognition rate | Audio minutes are recorded; estimate remains incomplete. |
| `CALL_COST_TTS_*_PER_1K_CHARS` | Speech synthesis rate | Generated characters are recorded; estimate remains incomplete. |
| `CALL_COST_LLM_*_PER_1K_CHARS` | Conversation-model estimate | Input and output character counts are recorded as a temporary proxy until token usage is returned by every provider. |
| `CALL_COST_TELEPHONY_OUTBOUND_PER_MINUTE` | Carrier call rate | Call duration is recorded; estimate remains incomplete. |

The `usage.estimate.complete` flag is true only when every consumed billed unit has an explicit rate. This prevents a partial number from being presented as an all-in call cost.

## Automated validation completed

The complete `pnpm test` suite and static build passed after this increment. New and extended regression coverage verifies the following:

| Test surface | Verified invariant |
|---|---|
| `scripts/test-call-usage.mjs` | Codec-aware duration calculation, explicit-rate estimates, health-safe rate readiness, and removal of PII/content from persisted usage. |
| `scripts/test-agent-bridge.mjs` | A finished live call emits numeric-only usage with Deepgram STT and actual TTS/LLM provider identity. |
| `scripts/test-call-record.mjs` | Usage survives Firestore encoding in a protected single-call response, while bulk lists omit it. |
| Existing Firebase contract guard | Existing service-account variable, Firestore database selector, collection defaults, and fail-closed state remain unchanged. |
| Existing browser suites | 72 real-browser checks remain passing. |

## Required next production actions

The next engineering changes cannot be truthfully completed from source code alone. They require deployment credentials, vendor accounts, and consented telephony tests.

1. Configure the existing Firebase service account in deployment secrets and verify `store.backend: firestore` plus `store.reachable: true` through the health endpoint. Do not rename any Firebase environment variables or collections.
2. Enter the actual contracted unit rates into the new `CALL_COST_*` environment values and check that the health endpoint reports all required rate names as configured.
3. Configure the compliant DND scrub and durable suppression path; strict mode should continue blocking all production dials until this is verified.
4. Configure the dial queue, signed secret, 160-series caller identity, and Indian-region recording bucket with the required lifecycle policy.
5. Run consented internal 8 kHz carrier calls in Telugu, Hindi, English, and code-mixed speech. Compare Sarvam and Deepgram accuracy, latency, fallback rate, and measured estimated cost before changing the language-routing order.
