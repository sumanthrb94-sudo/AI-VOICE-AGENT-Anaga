# VoiceStudio — what we take, what we don't, and the licence line

**Upstream:** [github.com/debpalash/VoiceStudio](https://github.com/debpalash/VoiceStudio)
(previously OmniVoice-Studio) · reviewed at `ea2d715` · AGPL-3.0-only

Same format as [`LIVEKIT_REFERENCE.md`](LIVEKIT_REFERENCE.md): an honest read of
an open-source project, what it actually gives Anaga, and where the boundary is.

---

## 1. The licence, first — this decides the architecture

VoiceStudio is **AGPL-3.0-only**. Its own `LICENSE-NOTICE.md` is unusually clear,
and worth quoting because it settles most of the question:

> You are free to use, copy, modify, and redistribute it — and that **includes
> commercial and internal business use**: run the app, use its outputs
> commercially, sell the audio you produce with it, provide professional/client
> services with it, and deploy it within your organization.
>
> Because this is the **Affero** GPL, one additional obligation applies: if you
> modify VoiceStudio and make that modified version available to others over a
> network, you must also offer those users the complete corresponding source
> code of your modified version under these same AGPL-3.0 terms.

It also offers a paid commercial licence for embedding it in a closed product.

So, concretely:

| | |
|---|---|
| ✅ | Run an **unmodified** VoiceStudio on our own GPU host and call it over HTTP. Its notice names this exactly: deploy internally, sell the audio. |
| ✅ | Ship Anaga calls whose audio it synthesized. The output is ours. |
| ⚠️ | **Modify** it and expose the modified build to users over a network → we must publish our modified source under AGPL-3.0. Fine for a patched Dockerfile we're willing to publish; a decision, not an accident. |
| ❌ | **Copy its source into this repo.** Vendoring even one adapter file risks making Anaga's server a derivative work, and the Affero clause bites precisely because we serve users over a network. This is the one that would hurt. |
| 💰 | Want it embedded in the product with no copyleft? `VoiceStudio@palash.dev` sells that. |

**This is not legal advice.** The distinction between "separate programs talking
over a documented protocol" and "one derivative work" is exactly where the FSF
and courts have been least crisp. Before this goes commercial, have counsel read
the AGPL against our deployment. The engineering rule in the meantime is simple
and safe: **network boundary, no source copied.** That is why the adapter in
`api/_lib/tts.js` is 60 lines of `fetch` and imports nothing from upstream.

---

## 2. What it actually is

An **open-source ElevenLabs alternative** — a Tauri v2 desktop app (Rust shell,
React UI) wrapping a Python/FastAPI backend that runs as a local sidecar on
`localhost:3900`. Real-time dictation, zero-shot voice cloning from ~3 seconds of
reference audio, voice design, and video dubbing. 14 TTS engines and 11 ASR
engines behind one picker.

It is **not** a voice-agent framework. No telephony, no turn-taking, no
barge-in, no endpointing, no compliance, no dial queue. Do not read it as a
competitor to `caller-agent/` or as an alternative to LiveKit — it sits in the
slot where Sarvam and ElevenLabs sit. It is a **synthesis and transcription
engine**, and that is all we should ask of it.

---

## 3. Why it matters to us specifically

Four things, in the order they matter for Modcon Builders.

### 3.1 Data residency — the one that is a requirement, not a saving

`docs/COMPLIANCE.md` requires Indian data residency, and call recordings on
Indian soil with 90-day retention. Every cloud TTS we use today ships the
prospect's conversation to a vendor: Sarvam (India, fine), Google (not India by
default). A VoiceStudio box on an Indian VPS means **the audio never leaves
infrastructure we control**. That converts a standing compliance question into a
deployment fact, and it is the strongest reason to take this seriously.

### 3.2 A male voice, today, without waiting on anyone

The Arjun preset is currently unservable: Google Cloud TTS is not enabled on the
project and every Sarvam speaker we use is female. VoiceStudio clones **either
gender** from a 3-second sample, and its Voice Design builds a voice from
gender / age / accent / pitch / emotion. This removes the dependency on a Google
console click entirely.

### 3.3 The unit economics our own pitch depends on

`README.md` claims a moat against "foreign per-minute platforms". Per-character
TTS billing is a variable cost that scales linearly with call volume and caps our
margin. Self-hosted inference is a **fixed GPU cost**. At the volumes in
`docs/FINANCIAL_MODEL_NOTES.md` that is the difference between a per-minute
reseller and an infrastructure company. This is the commercial argument, and it
is the reason to spend real time here rather than treat it as a curiosity.

### 3.4 Indian languages, including the ones we have not shipped yet

From `docs/languages.md` (the number is training-data hours):

| Language | Code | Hours |
|---|---|---|
| Tamil | `ta` | 423 |
| Bengali | `bn` | 272 |
| **Telugu** | `te` | 230 |
| Marathi | `mr` | 157 |
| Kannada | `kn` | 128 |
| **Hindi** | `hi` | 117 |

Telugu at 230h is genuinely encouraging for a Hyderabad beachhead. Hindi at 117h
is modest. **Neither number is a quality claim** — hours of training data and
"sounds right to a Hyderabad homebuyer" are different things, and only the A/B in
§6 settles it.

Bonus: Tamil, Kannada, Marathi and Bengali are our stated expansion languages and
we have no vendor for them.

### 3.5 ASR, which is a live blocker

`LAUNCH.md` blocker #3 is "STT on real telephony audio is unproven" — we have
never run our STT against 8kHz μ-law from a phone line. VoiceStudio bundles
WhisperX, Faster-Whisper, Parakeet, FunASR and sherpa-onnx behind an
OpenAI-compatible `/v1/audio/transcriptions`. That makes the experiment cheap:
record one real call, replay it against several engines, measure number and name
accuracy. **The blocker is unproven, not unsolvable, and this is how we prove it.**

---

## 4. What we took

Exactly one thing: a **provider adapter**, `viaVoiceStudio()` in
`api/_lib/tts.js`. It POSTs to `/v1/audio/speech` — an OpenAI-compatible
endpoint, so this is the same code shape as any OpenAI audio client — and returns
base64 MP3 through the existing `synth()` interface. No upstream source, no
dependency, no submodule.

```
VOICESTUDIO_URL           http://10.0.0.4:3900
VOICESTUDIO_API_KEY       optional; loopback is unauthenticated by default
VOICESTUDIO_MODEL         default "tts-1" (the active engine on that box)
VOICESTUDIO_VOICE_FEMALE  cloned profile id — GET /v1/audio/voices
VOICESTUDIO_VOICE_MALE    ditto
VOICESTUDIO_TIMEOUT_MS    default 25000
```

It leads the default chain (`voicestudio,google,gtranslate,sarvam`) and is
**inert until `VOICESTUDIO_URL` is set**, so leading with it changes nothing on a
deployment that has not stood one up.

**One deliberate refusal:** a gender with no pinned profile id is *refused*, not
approximated, and the chain moves on. Every engine will synthesize *something*
for an unknown voice, and that something is how a male preset ends up sounding
like a woman with nobody noticing. Same rule as the rest of the chain: never
claim a voice we cannot serve.

---

## 5. What we did NOT take, and why

- **Any source file.** §1.
- **The Tauri desktop shell.** We need a headless service, not an app.
- **Voice cloning as a product feature.** Cloning a real salesperson's voice for
  outbound calls is a consent question before it is a technical one — TRAI
  disclosure plus the person's own permission, in writing. Worth doing, not worth
  doing casually.
- **The dubbing / audiobook / subtitle surface.** Large and irrelevant to us.
- **Their ASR, for now.** Genuinely promising (§3.5), but our STT sits in
  `caller-agent/`, not the API, and swapping it is its own work package.

---

## 6. Before betting on it — the honest checklist

Nothing above is proven for Modcon Builders. In order:

1. **Stand one up.** A GPU box (CUDA) on an Indian VPS. CPU works for some
   engines but not at call latency. This is real infrastructure with real
   uptime — a serverless deploy cannot host it, and neither can Vercel.
2. **Measure time-to-first-audio.** A phone call forgives ~300ms and punishes a
   second. There is a streaming `/ws/tts` that emits sentence-by-sentence chunks,
   which fits the paced playback already in `caller-agent/src/media/transport.js`
   — but the batch `/v1/audio/speech` we call today returns a whole clip. If
   latency disappoints, the streaming socket is the next move, not a rewrite.
3. **A/B Hindi and Telugu against Sarvam** with native speakers, on the actual
   qualification script, over a real phone codec. Not on a laptop speaker.
   §3.4's numbers are training hours, not opinions about how it sounds.
4. **Test at 8kHz μ-law.** Everything sounds fine at 24kHz. Telephony is the
   only bar that counts.
5. **Then read the AGPL with counsel** (§1), before it carries revenue.

Until 1–4 are done, VoiceStudio is a well-founded bet with an adapter ready for
it, and Sarvam remains what actually speaks on production. Saying otherwise in a
pitch would be the kind of claim that dies in diligence.

---

## 7. Credit

VoiceStudio is by Palash Debnath and its contributors, AGPL-3.0. If it ends up
in our stack, sponsor it — [ko-fi.com/debpalash](https://ko-fi.com/debpalash) —
and if we improve it, upstream the patch. The commercial licence exists for a
reason and the honest move, if we ever need to embed rather than call it, is to
pay for it rather than argue about derivative works.
