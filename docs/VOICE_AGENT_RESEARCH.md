# Voice-Agent Stack Research Notes

## Verified upstream findings

| Component | Verified capability | Installation or integration signal | Architecture relevance |
|---|---|---|---|
| Pipecat | Pipecat is an open-source Python framework for real-time voice and multimodal agents with both Deepgram and Sarvam listed as STT services, and both Deepgram and Sarvam listed as TTS services. | The project documents a CLI scaffold (`uv tool install "pipecat-ai[cli]"`; `pipecat init`) and package extras for provider-specific support. | It is a strong abstraction-layer candidate for a new streaming caller-agent core because it preserves provider swapability and offers a short developer path. |
| Sarvam + Pipecat | Sarvam provides an official Pipecat guide using `pipecat-ai[daily,sarvam]`, Saaras v3 STT, and Bulbul v3 TTS. The guide covers fixed Indic languages, auto-detected STT (`language="unknown"`), and speech-to-English translation mode. | The guide uses one Sarvam API key and shows service initialization directly in Pipecat. | Sarvam should be the default Indic-language STT/TTS path for Hindi, Telugu, and code-mixed conversations; automatic language detection can reduce client-side translation complexity. |

## Sources

[1]: https://github.com/pipecat-ai/pipecat "Pipecat GitHub repository"
[2]: https://docs.sarvam.ai/api/integration/build-voice-agent-with-pipecat "Sarvam: Build Your First Voice Agent using Pipecat"

## Working conclusion

The initial clean rebuild should keep the existing Node.js/Vercel integration layer and Firebase/Firestore persistence contract intact, while isolating the live audio loop behind a language-agnostic agent interface. Pipecat is currently the leading candidate for that loop because official upstream material confirms direct Sarvam support, Deepgram support, and a lightweight scaffold path. Deepgram remains a plausible fallback for English and noise-tolerant streaming recognition; its role and current pricing require separate verification before any provider-selection recommendation is finalized.

## Cost observations

| Provider and service | Current published rate | Practical role |
|---|---:|---|
| Sarvam Saaras STT | ₹30 per audio hour, charged per second and rounded per request | Default India-language speech recognition candidate. |
| Sarvam Bulbul TTS | ₹30 per 10,000 characters, charged per character | Default India-language synthesized speech candidate. |
| Deepgram Nova-3 Multilingual streaming STT | $0.0058 per minute on pay-as-you-go | Secondary recognizer for English, noisy audio, or cases where a provider quality test demonstrates a material improvement. |
| Deepgram Flux Multilingual streaming STT | $0.0078 per minute on pay-as-you-go | Optional managed turn-detection alternative, but not the lowest-cost STT option in the reviewed catalog. |
| Deepgram Aura-1 TTS | $0.015 per 1,000 characters on pay-as-you-go | Secondary TTS fallback, not the India-first default. |

Deepgram’s official pricing shows a $200 free credit for its pay-as-you-go plan, while Sarvam’s pricing page lists ₹30/hour for Saaras STT and ₹30/10,000 characters for Bulbul TTS. The precise lowest-cost runtime selection must be measured using the company’s actual Hindi/Telugu/English call mix and the average agent response length; TTS character pricing and STT audio-minute pricing are not directly interchangeable.[3] [4]

[3]: https://deepgram.com/pricing "Deepgram Pricing"
[4]: https://docs.sarvam.ai/api/getting-started/pricing "Sarvam API Pricing"

## Integration and repository references

| Reference | What it proves | Recommendation |
|---|---|---|
| Deepgram official Pipecat guide | Pipecat can combine Deepgram STT and TTS in a real-time pipeline; Deepgram Flux STT offers built-in turn detection; the setup also needs a transport such as Daily in the published quickstart. | Use as a provider adapter reference, not as the primary deployment template because the default quickstart adds a second managed transport dependency. |
| `pipecat-ai/pipecat` | Pipecat is the canonical open-source framework and offers a CLI scaffold plus focused service examples. It is BSD-2-Clause licensed. | Use as the canonical framework dependency and implementation reference. |
| `dpkdhingra91/pipecat-sarvam-azure-starter` | MIT-licensed Sarvam STT → Azure OpenAI → Sarvam TTS starter with FastAPI, WebSocket transport, Docker, language configuration, and a small repository structure. | Use for design reference only. It is useful for configuration and service decomposition, but it has one commit and hard-codes Azure OpenAI as its primary LLM path, so it should not be adopted wholesale. |

The official Deepgram guide’s published route adds a Daily transport/API key and an LLM key. For the lowest operational cost, the clean rebuild should instead keep the repository’s existing direct Twilio/WebSocket media bridge and provider adapters, so Pipecat only owns the realtime STT → LLM → TTS loop. That avoids paying for a transport platform where direct carrier media streaming already exists.[5] [6] [7]

[5]: https://developers.deepgram.com/docs/pipecat-integration "Deepgram: Pipecat Integration"
[6]: https://github.com/pipecat-ai/pipecat "Pipecat GitHub repository"
[7]: https://github.com/dpkdhingra91/pipecat-sarvam-azure-starter "Pipecat Sarvam Azure starter repository"

## Telephony conclusion

Pipecat’s Plivo serializer is part of the core library and explicitly supports bidirectional audio, DTMF, automatic hang-up, μ-law conversion, and direct WebSocket transport. This means a Pipecat-based caller loop can receive carrier audio directly rather than requiring the Daily transport used in one Deepgram quickstart. The clean rebuild can therefore keep the direct carrier-media pattern, preserving a lower recurring integration surface while retaining a controlled provider boundary.[8]

[8]: https://docs.pipecat.ai/api-reference/server/services/serializers/plivo "Pipecat Plivo Frame Serializer"

