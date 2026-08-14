# ADR-001: Clean Voice-Agent Rebuild Boundary

**Status:** Accepted for the foundation phase  
**Date:** 2026-08-14  
**Owner:** Vaak AI Engineering

## Context

The repository’s default branch is not the current technical baseline. The default branch ends at commit `87650ef` (2026-06-06), whereas the newest implementation is commit `b3f3d35` (2026-08-12) on `claude/anaga-voice-meta-crm-w6atbl`. The newer branch already has a direct WebSocket caller service, provider adapters, durable Firestore storage, outbound-compliance controls, and end-to-end test coverage. A clean rebuild must therefore mean a **clean, reproducible foundation on the newest baseline**, not discarding established safety controls.

> **Decision principle:** Rebuild the call runtime incrementally around stable public contracts. Do not replace Firestore, compliance, lead intake, or call-outcome contracts while making the voice loop easier to install and operate.

## Non-negotiable preserved contracts

| Area | Preserved contract | Why it must not change |
|---|---|---|
| Firebase credential | `FIREBASE_SERVICE_ACCOUNT`, accepting raw or base64 service-account JSON | It is the deployment’s existing durable-store connection. |
| Firestore database | `FIRESTORE_DATABASE_ID`, default `(default)` | Changing the database selector would split production data. |
| Firestore collections | `suppression`, `leads`, `events`, `calls`, and `users`, with their existing environment overrides | These collections support do-not-call suppression, lead deduplication, operator history, outcomes, and human access control. |
| Compliance behaviour | A missing or unreachable durable suppression store produces an unknown state that blocks an outbound dial in strict mode | A storage outage must never grant permission to call a prospect who opted out. |
| Public integration surfaces | Lead intake, Meta webhook, signed dial jobs, call outcomes, recordings, transcript access, and operator console | These are the boundaries connecting campaigns, the caller, CRM, and operators. |

## Viable runtime approaches

| Approach | Trade-offs | Runtime cost shape | Setup complexity |
|---|---|---|---|
| **Lean Node caller service — foundation choice** | Retains the repository’s direct WebSocket bridge, existing tests, and single Node runtime. Provider abstractions stay in the service. It requires continuing to own turn-taking and carrier framing. | Carrier minutes plus selected STT, LLM, and TTS usage. No added media-transport platform charge. | Lowest. The Cloud Run container already exists; local tests use one project-managed browser dependency. |
| **Pipecat caller service on Cloud Run** | Provides an established Python pipeline abstraction with official Sarvam, Deepgram, Plivo, and Twilio components. It adds Python/uv, a second service runtime, a second deployment path, and migration/test work. | Similar vendor usage costs; framework is open-source. Direct carrier serializers avoid a separate media platform. | Moderate. Pipecat CLI scaffolding is fast, but full migration is not a one-command production swap. |
| **Deepgram all-in-one voice-agent endpoint** | Fastest managed implementation for a predominantly English product, but it gives a vendor control of the STT/LLM/TTS loop and conflicts with Sarvam-first Indic quality and the product’s compliance boundary. | One managed per-minute voice-agent rate, plus carrier cost. | Lowest initial prototype setup; least control and weakest fit for the India-first requirements. |

## Decision

The foundation retains the **Lean Node caller service** and treats Pipecat as a **measured migration option**, not an immediate runtime dependency. This is the lowest-risk and lowest-installation-complexity route because the latest code already has a Node 22 WebSocket call bridge, carrier envelopes, Deepgram live recognition, Sarvam TTS, flow-backed approved disclosures, and tests that exercise barge-in and opt-out behaviour.

Sarvam remains the default India-language speech path. Sarvam documents Pipecat support with Saaras v3 STT and Bulbul v3 TTS, including auto-detected STT and multilingual configurations.[1] Deepgram remains an optional streaming recognition path for English, noisy audio, or quality-tested fallback scenarios. Its Pipecat guide confirms its use for real-time STT/TTS, while its Flux STT path exposes built-in turn detection.[2]

Pipecat remains strategically valid. It is BSD-2-Clause licensed, provides a standard scaffold, and officially lists both Sarvam and Deepgram services.[3] Its Plivo serializer can connect directly to Plivo’s Audio Streaming WebSocket protocol without an additional serializer dependency, preserving the direct-carrier design.[4] It should be piloted only after a fixed test set compares Sarvam and Deepgram on real 8 kHz carrier recordings in Telugu, Hindi, English, and code-mixed speech.

## Cost discipline

Current published provider prices confirm why the stack must separate recognition from synthesis rather than select a provider by headline price alone. Sarvam lists Saaras STT at ₹30 per hour and Bulbul TTS at ₹30 per 10,000 characters.[5] Deepgram lists Nova-3 Multilingual streaming STT at $0.0058 per minute on pay-as-you-go and Flux Multilingual at $0.0078 per minute; its Deepgram TTS rates are priced by characters.[6] Actual per-call cost must be measured from recorded agent response lengths, language mix, and carrier charges before a provider is made the universal default.

## Foundation changes completed

The foundation work creates a repository-managed Playwright dependency, a pinned package-manager contract, a portable browser-launch helper, CI installation of Chromium, and strict browser-test execution. It also adds a Firebase contract regression test that protects the existing service-account variable, database selector, collection defaults, and fail-closed store state.

## Next implementation gates

| Gate | Required evidence | Production effect |
|---|---|---|
| Carrier-quality provider spike | Recorded and consented 8 kHz phone-audio evaluation across Hindi, Telugu, English, and code-mixed cases | Select or retain the language-routing policy. |
| Firebase live verification | Deployment health reports `backend: firestore` and `reachable: true`; test uses a rotated service-account credential outside source control | Enables durable suppression, call histories, and operator data. |
| Legal-to-dial verification | DND scrub, consent records, 160-series caller ID, and recording-residency checks are configured | Allows one consenting internal test call. |
| End-to-end live-call verification | One consenting internal call reaches a real carrier, records safely, persists outcome, and blocks a second dial after opt-out | Allows a controlled design-partner pilot. |

## References

[1]: https://docs.sarvam.ai/api/integration/build-voice-agent-with-pipecat "Sarvam: Build Your First Voice Agent using Pipecat"
[2]: https://developers.deepgram.com/docs/pipecat-integration "Deepgram: Pipecat Integration"
[3]: https://github.com/pipecat-ai/pipecat "Pipecat GitHub repository"
[4]: https://docs.pipecat.ai/api-reference/server/services/serializers/plivo "Pipecat Plivo Frame Serializer"
[5]: https://docs.sarvam.ai/api/getting-started/pricing "Sarvam API Pricing"
[6]: https://deepgram.com/pricing "Deepgram Pricing"
