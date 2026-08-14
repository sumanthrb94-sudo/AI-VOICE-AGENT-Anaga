# End-to-End Repository Audit and Clean-Foundation Report

**Prepared:** 2026-08-14  
**Scope:** Latest available repository implementation, Firebase/Firestore preservation, cost-conscious voice-stack assessment, and clean-build foundation work.

## Executive assessment

The repository has a stronger production-oriented implementation than the default branch suggests. The default branch ends at commit `87650ef` from 2026-06-06, but the newest available work is commit `b3f3d35` from 2026-08-12 on `claude/anaga-voice-meta-crm-w6atbl`. The newer work is the correct baseline because it contains the direct WebSocket agent service, Deepgram live-STT bridge, Sarvam TTS integration, carrier framing, Firestore durability layer, compliance controls, recordings, and a broad test suite.

The rebuild should be **incremental, contract-preserving, and evidence-led**. The system already contains valuable legal and operational controls that should not be erased by a rewrite. The clean foundation implemented in this change set makes the project reproducibly testable on a normal machine and adds explicit protection for the existing Firebase/Firestore integration.

## Latest-commit baseline

| Item | Finding | Implication |
|---|---|---|
| Default branch | `claude/home-screen-setup-guide-Pwabh`, commit `87650ef`, 2026-06-06 | Stale as an engineering baseline. |
| Newest available branch | `claude/anaga-voice-meta-crm-w6atbl`, commit `b3f3d35`, 2026-08-12 | Selected as the dedicated clean-rebuild baseline. |
| Latest commit subject | `A page you can hear today: /live.html, and the capture bug it found` | The newest work is focused on the live streaming path, not only static UI. |
| Working branch | `manus/ceo-clean-rebuild` | Keeps the audit and foundation changes isolated from existing branches. |

## Current architecture, end to end

The current solution separates web/API responsibilities from the long-lived audio connection. Vercel functions own lead intake, compliance evaluation, CRM writeback, operator console access, call outcome persistence, recording access, and health reporting. The Cloud Run caller service owns the persistent WebSocket call loop because serverless request handlers are not a suitable home for a full-duplex media connection.

| Layer | Current responsibility | Status |
|---|---|---|
| Lead sources | Meta Lead Ads webhook and authenticated generic lead intake | Implemented and covered by integration tests. |
| Compliance | Consent, DND scrub, calling window, and durable suppression checks | Implemented with a strict fail-closed posture. |
| Queue hand-off | HMAC-signed dial jobs to the caller service | Implemented; requires real deployment secrets and a dial endpoint. |
| Live caller | WebSocket media service with Deepgram streaming STT, flow-backed prompts, Sarvam voice output, interruption handling, and carrier envelopes | Implemented and tested with simulated browser and carrier paths. |
| Durable data | Firestore-backed suppression, leads, events, calls, and users | Implemented; live credential and deployment verification remains an external environment task. |
| Operator experience | Console for lead funnel, call outcomes, protected transcripts, and signed recording playback | Implemented and browser-tested. |
| Recording | Indian-region object storage references, access-controlled playback, and erase support | Implemented; production bucket and retention lifecycle are not configured in source control. |

## Firebase/Firestore preservation result

No Firebase or Firestore source file, environment key, collection default, or database selector was modified. The rebuild foundation adds a regression test that locks the existing contract:

| Preserved surface | Existing value or behaviour |
|---|---|
| Credential environment variable | `FIREBASE_SERVICE_ACCOUNT` as raw or base64 service-account JSON |
| Database selector | `FIRESTORE_DATABASE_ID`, default `(default)` |
| Durable collections | `suppression`, `leads`, `events`, `calls`, `users` with environment overrides |
| Safety behaviour | Unavailable Firestore returns an unknown suppression state; strict compliance blocks the dial |
| Production credential handling | No credential was read, printed, added, replaced, or committed during this work |

The core Firestore test suite passed its offline contract checks and intentionally skipped live round trips because no Firebase credential was injected into this environment. This is correct: source changes cannot prove a production deployment’s secret configuration.

## Voice-stack decision

The recommended foundation is to retain the Node 22 direct-media service, use Sarvam as the India-language default, and retain Deepgram as a measured streaming-STT fallback. This avoids a second production runtime while preserving the project’s versioned flow, Sarvam voice, and compliance controls.

| Option | Assessment | Decision |
|---|---|---|
| Existing Node direct WebSocket service | Lowest incremental complexity; existing code, carrier handling, and tests are already present | **Foundation path** |
| Pipecat on Cloud Run | Valid longer-term framework option with official Sarvam, Deepgram, and Plivo support, but introduces a Python runtime and migration cost | Pilot only after carrier-audio evaluation |
| Deepgram all-in-one voice agent | Fast to prototype but does not fit Sarvam-first Indic speech and keeps too much of the call loop in one vendor boundary | Do not adopt for the product core |

Sarvam’s official Pipecat guide supports Saaras v3 STT and Bulbul v3 TTS for Indic-language agents, including auto-detected STT configurations.[1] Deepgram’s official Pipecat guide confirms its role in real-time STT/TTS and its Flux STT option for native turn detection.[2] Pipecat supports both providers and offers direct carrier serializers such as Plivo’s WebSocket serializer, but its framework benefits do not outweigh a second runtime for the current foundation.[3] [4]

## Cost observations

Current published prices should be used as inputs to a real-call financial model, not as a standalone provider decision. Sarvam lists Saaras STT at ₹30 per hour and Bulbul TTS at ₹30 per 10,000 characters.[5] Deepgram lists Nova-3 Multilingual streaming STT at $0.0058 per minute and Flux Multilingual at $0.0078 per minute on its pay-as-you-go page.[6]

The product should therefore measure the actual cost of a call as **carrier minutes + recognized audio minutes + generated response characters + LLM tokens + storage/recording**, split by language and average speaking ratio. That is more decision-useful than comparing only an STT rate against a TTS rate.

## Clean-foundation implementation completed

| Change | Outcome |
|---|---|
| Added root `package.json` and `pnpm-lock.yaml` | A normal Node 22 developer can install the browser-test dependency deterministically. |
| Added shared `scripts/playwright.mjs` | Removes all machine-specific `/opt/node22` and `/opt/pw-browsers` assumptions from browser tools. |
| Updated six browser utilities | Live call, investor demo, Telugu picker, operator console, voice probe, and benchmark now use the portable launcher. |
| Strengthened CI | CI installs the pinned test dependency and Chromium before browser tests; browser tests now gate rather than warn-and-pass. |
| Added `scripts/test-firebase-contract.mjs` | Guards the existing Firebase credential name, database selector, collection defaults, and fail-closed store behaviour. |
| Added architecture and research records | `docs/CLEAN_REBUILD_ADR.md` and `docs/VOICE_AGENT_RESEARCH.md` record the technical decision and sources. |
| Updated README | Documents the one-time setup and full `pnpm test` validation command. |

## Validation evidence

The documented command `pnpm test` completed successfully with zero failures after the changes. The real-browser suites passed **72 checks**: 9 for the streaming call page, 33 for the investor demo, 19 for the Telugu voice picker, and 11 for the protected operator console. The core suite also completed successfully, including integrations, authentication, Firestore fail-closed behaviour, echo regression, media handling, agent bridge, voice handling, recordings, and call-record persistence. The static-site assembly also completed successfully.

The browser validation now proves that the service can open a real local WebSocket, request echo-cancelled microphone constraints, stream raw audio, show interim and final transcripts, return agent audio over the same socket, support interruption controls, preserve opt-out handling, and render hostile transcript text without executing it.

## Production blockers not solvable in source code

The existing launch checklist correctly identifies configuration and business prerequisites that are not code defects. They remain required before any live outbound call.

| Required gate | Why it remains open |
|---|---|
| Rotated `FIREBASE_SERVICE_ACCOUNT` configured in the deployment | Necessary for durable suppression and outcome history; no live production secret was available in this task. |
| DND scrub provider and credentials | Strict compliance intentionally blocks outbound dialing until this is configured. |
| DLT/telemarketer registration and compliant 160-series caller ID | Legal and commercial prerequisite, not an engineering change. |
| Indian-region recording bucket plus 90-day lifecycle | The code can refuse a non-Indian region, but it cannot create or verify the cloud lifecycle policy. |
| Dial queue URL and shared HMAC secret | Required to route an authorized job to the caller service. |
| Real consented internal test calls | Needed to validate carrier codec handling, speech quality, opt-out propagation, recordings, and CRM writeback with real vendors. |

## Recommended next sequence

First, configure a rotated Firebase service account in the deployment and verify the health endpoint reports Firestore as reachable. Second, run a controlled language-quality spike against consented 8 kHz phone recordings to compare Sarvam and Deepgram by name, number, and code-mixed accuracy. Third, configure the compliant dialing and recording prerequisites, then place only consented internal calls. Finally, use those results to decide whether Pipecat adds enough operational value to justify a separate Python call-loop migration.

## References

[1]: https://docs.sarvam.ai/api/integration/build-voice-agent-with-pipecat "Sarvam: Build Your First Voice Agent using Pipecat"
[2]: https://developers.deepgram.com/docs/pipecat-integration "Deepgram: Pipecat Integration"
[3]: https://github.com/pipecat-ai/pipecat "Pipecat GitHub repository"
[4]: https://docs.pipecat.ai/api-reference/server/services/serializers/plivo "Pipecat Plivo Frame Serializer"
[5]: https://docs.sarvam.ai/api/getting-started/pricing "Sarvam API Pricing"
[6]: https://deepgram.com/pricing "Deepgram Pricing"
