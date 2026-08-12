# Hearing the prospect and not the room

Why the microphone reported background noise as a talking prospect, what the
research says about fixing it, and the exact order to build it in.

---

## 1. What was wrong

`web/assets/mic.js` decided "someone is speaking" from one number — the RMS
energy of the frame — against an adaptive floor:

```js
isVoice = level > Math.max(0.012, floor * 2.2);
if (!isVoice && !speaking) floor = floor * 0.98 + level * 0.02;
```

Three separate failures, all of which present as *"it thinks the room is
talking"*:

**The floor latched.** It only adapted while the gate was **closed**. The moment
ambient noise crossed the threshold, `isVoice` stayed true, the floor froze
below it, and nothing could ever bring it back down. A fan starting, a
television, traffic through an open window — the gate opened and stayed open for
the rest of the call. The comment above that line claimed it prevented exactly
this.

**Calibration took the peak.** `floor = max(floor, level)` across the first
600 ms. A door closing during that window set the floor to the bang, and the
microphone was deaf for the whole call — the opposite failure, from the same
three lines.

**Energy is the wrong instrument.** This is the part no amount of tuning fixes.
Loudness is not what makes a sound speech. Measured against ground truth on
real-world audio (arXiv 2601.17270, *Window Size Versus Accuracy Experiments in
Voice Activity Detection*), Matthews correlation coefficient:

| detector | MCC |
|---|---|
| RMS energy | **0.11** |
| WebRTC VAD (GMM) | 0.41 |
| Silero VAD (neural) | **0.72** |

0.11 is very nearly a coin toss. The same paper finds hysteresis meaningfully
helps WebRTC (0.41 → 0.47) and does nothing for RMS — you cannot post-process
your way out of a bad feature.

## 2. What is shipped now (tier 0 — no dependencies)

Still energy-based, but no longer indefensible:

- **Percentile noise floor.** The 20th percentile of the last ~3.2 s, recorded
  whether the gate is open or shut. This is minimum-statistics noise estimation,
  the standard approach. Speech is intermittent — even a fast talker leaves gaps
  between words — so the quietest fifth of a window is the room. Continuous
  noise fills the whole window, the percentile rises into it, and the gate closes
  by itself. An exponential average cannot do this: fast enough to catch a fan in
  seconds is fast enough for the prospect's own voice to raise the floor and
  deafen the microphone mid-sentence.
- **Hysteresis.** Open at `floor × 3.0`, close at `floor × 1.8`, with the gate's
  own state — so a level sitting on one threshold cannot chatter the gate and
  chop an utterance into fragments.
- **A spectral test, to open only.** Two classical features from the spectrum the
  analyser already produces:
  - **band ratio** — energy in 300–3400 Hz over total. Speech lives in the
    telephone band. Air conditioning, mains hum and traffic are mostly below it;
    clatter and keyboard noise are mostly above.
  - **spectral flatness** (Wiener entropy) — geometric mean over arithmetic mean
    of the spectrum. White noise is flat and scores near 1; voiced speech has
    harmonics and formants and scores far lower.

  Applied only to **opening**. An unvoiced consonant at the end of a word is
  legitimately noise-shaped and must not close the gate early.
- **Median calibration**, so one bang no longer deafens the call.
- `smoothingTimeConstant = 0.2` on the analyser. The 0.8 default blurs each
  frame into the several before it, which is precisely what a detector must not
  do.

**What this still will not do.** A television playing dialogue is speech-shaped
and will get through. Another person talking near the phone will get through.
Those need a model.

## 3. Tier 1 — the real fix: a neural VAD

**Silero VAD** (MIT, ~1–2 MB ONNX) is the industry default: LiveKit, Pipecat,
and the browser package `ricky0123/vad` all run it. In the browser it goes
through ONNX Runtime Web inside an **AudioWorklet**.

```
mic ─▶ AudioWorklet ─▶ Silero (ONNX) ─▶ speech probability per 32 ms frame
                                          │
                                  threshold + min-frames + pre-roll
```

Silero's own frame is **512 samples @ 16 kHz = 32 ms**, and its parameters are
`positive_speech_threshold` / `negative_speech_threshold` (hysteresis, built in),
`min_speech_frames`, and `pre_speech_pad_frames`.

**The blocker for this repo:** vanilla ES modules, **zero npm dependencies**, no
build step. ONNX Runtime Web is ~11.8 MB before the model. Adopting it means
giving up one of those constraints — vendoring a WASM build into `web/assets/`,
or adding a bundler. That is a deliberate decision, not an afternoon.

## 4. Tier 2 — delete ours and let Sarvam do it

Sarvam's streaming STT WebSocket (`wss://api.sarvam.ai/speech-to-text/ws`)
already runs a neural VAD server-side, and its parameters give the game away —
they are Silero's, verbatim:

```
positive_speech_threshold   0.7     negative_speech_threshold  0.45
min_speech_frames           2       first_turn_min_speech_frames  8
negative_frames_count      18       negative_frames_window       24
pre_speech_pad_frames       9       interrupt_min_speech_frames   2
vad_signals  → speech_start / speech_end events
```

One frame is 512 samples: 32 ms at 16 kHz. `saaras:v3-realtime` (beta) adds true
partial transcripts.

So moving the browser onto the streaming transport gets a **Silero-grade VAD for
free** and lets us delete our own — the same change that gets latency under a
second. That is the argument for doing the WebSocket work: it is not only
faster, it is also the honest fix for this.

**Constraint:** the WebSocket takes **WAV or raw PCM only** (`pcm_s16le`,
`pcm_l16`, `pcm_raw`) at 8 or 16 kHz. No Opus, no WebM. So the AudioWorklet has
to emit Int16 PCM — which it should be doing anyway.

## 5. Noise cancellation — the blueprint

**Noise suppression is not a fix for the VAD problem.** It cleans audio for the
recogniser; it does not decide who is talking. Do §2/§3 first. Then:

### Where it goes

**Raw samples, in an AudioWorklet, before the encoder.** Never in a WebRTC
Encoded Transform — that only sees compressed frames, and a suppressor needs
uncompressed audio.

```
getUserMedia ─▶ AudioWorkletNode(suppressor) ─▶ MediaStreamDestination ─▶ recorder/WS
   AEC on                 ↑
   NS off            RNNoise / DTLN WASM
```

### The rules, in order of how expensive they are to get wrong

1. **Never stack two suppressors.** Set `noiseSuppression: false` in
   `getUserMedia` when you ship your own. Models are trained on raw audio;
   feeding one the output of another produces artefacts and burns battery twice.
   *(We currently have `noiseSuppression: true` — that is WebRTC NS3, and it must
   be turned off the moment a worklet lands.)*
2. **Keep `echoCancellation: true`.** RNNoise is a denoiser, not an echo
   canceller. Turn AEC off and speakerphone howl comes straight back — and this
   product has shipped that loop three times already.
3. **Do the frame-size bridging properly.** An AudioWorklet's `process()` is a
   fixed 128 samples and cannot be configured. RNNoise wants 480. Jitsi's
   solution is a circular buffer over one `Float32Array` with in-place denoise —
   copy it rather than reinventing it.
4. **Convert Float32 → Int16 PCM inside the worklet**, not on the main thread.
   It is what the streaming APIs want on the wire, and doing it at 48 kHz on the
   main thread costs a few percent CPU for nothing.

### Which model

| option | size | licence | good at | cost |
|---|---|---|---|---|
| WebRTC NS3 (built-in) | 0 | — | moderate noise, human listeners | free |
| **RNNoise** WASM | ~a few hundred KB | BSD | steady noise (fans, hum) | free, **unmaintained since 2024** |
| **DTLN** (`dtln-rs`, Datadog) | small | MIT | better than RNNoise; 1 s audio in 33 ms on M1 | free |
| DeepFilterNet | heavy via ORT Web | MIT/Apache | high quality | free, ~11.8 MB runtime |
| Krisp BVC / ai-coustics | SDK | paid | production grade, **removes other voices** | metered since May 2026 |

For this product: **DTLN** is the recommendation over RNNoise — same insertion
point, actively maintained, MIT, better on the noise types Indian outdoor and
office calls actually have. RNNoise is the safe fallback if the WASM build fights
back.

**Background *voice* cancellation** — removing another person talking near the
phone, rather than fan noise — is the one thing only Krisp BVC does well, and it
is now paid. That is the honest answer to "someone else in the room sets it off".

### Recommended order

1. **Tier 0** (shipped) — percentile floor, hysteresis, spectral gate.
2. **Move to the streaming WebSocket** — gets Sarvam's neural VAD *and* the
   latency fix, and requires the PCM worklet that step 3 needs anyway.
3. **Add DTLN in that same worklet** — noise suppression, `noiseSuppression:
   false`, AEC still on.
4. Only then consider Krisp, and only if background *speech* is the complaint.

Doing 2 before 3 matters: the worklet built for streaming PCM is the same worklet
the suppressor lives in. Building the suppressor first means building that
plumbing twice.

## 6. Deepgram, and which recogniser to use per language

`api/_lib/stt.js` now has a Deepgram Nova-3 adapter alongside Saaras.
`STT_PROVIDER` is a chain, so `deepgram,sarvam` tries Deepgram and falls through
on an outage.

```
DEEPGRAM_API_KEY=…          # server-side env only, never the repo
STT_PROVIDER=deepgram,sarvam
DEEPGRAM_MODEL=nova-3       # optional
```

**Nova-3 covers the whole product**: Telugu `te`, Hindi `hi`, Indian English
`en-IN`. Telugu and Tamil landed in January 2026 and got an accuracy pass in
May 2026.

**But it cannot code-switch into Telugu.** `language=multi` covers English,
Spanish, French, German, **Hindi**, Russian, Portuguese, Japanese, Italian and
Dutch — Telugu is not on that list. So a Telugu call must pin `language=te`, and
a prospect who answers a Telugu call in English gets run through a Telugu model.
That is completely ordinary behaviour on these calls, and Saaras auto-detects
across all of them without being told.

Which gives an honest split rather than a global swap:

| call language | recogniser | why |
|---|---|---|
| Telugu | **Saaras** | auto-detects when the prospect switches to English mid-call |
| Hindi | either | Deepgram's `multi` handles Hindi/English code-mixing natively |
| English | either | both are strong; Deepgram is generally faster |

The reason to reach for Deepgram is **not** the batch endpoint — it is the
streaming one, which carries interim transcripts and server-side endpointing
with VAD events, i.e. the fix for both the latency and the false-trigger
problems. That needs the WebSocket transport in §4, and the same caveat applies:
a Vercel serverless function cannot hold the connection.

## 7. "Can't we just use one vendor for all three languages?"

Yes. Several could. The question is which trade you are buying, and **it is not
cost** — see the arithmetic below before optimising for the wrong axis.

### Streaming prices, per minute (checked 2026-08)

| vendor / model | $/min | languages | notes |
|---|---|---|---|
| **Deepgram Flux (English)** | 0.0065 | en | **built-in turn detection**, built for voice agents |
| Deepgram Flux (multilingual) | 0.0078 | multi | same, across languages |
| Deepgram Nova-3 mono | 0.0048–0.0077 | 45+ incl. `te` `hi` | promo pricing on streaming |
| Deepgram Nova-3 multilingual | 0.0058–0.0092 | `multi` **excludes Telugu** | auto language detection |
| **Google Chirp 2** | 0.0048 | **100+** | cheapest broad-coverage option |
| Google Chirp 3 / STT V2 | 0.016 | 35+ | ~3× Chirp 2 |
| Groq Whisper-large-v3-turbo | ~0.0006 | 100+ | **batch only, no streaming** |
| OpenAI gpt-4o-mini-transcribe | 0.003 | 57 | streaming |

Batch is consistently 30–50% cheaper than streaming across every vendor.

### Do the arithmetic before choosing on price

A qualifying call is 3–5 minutes. At **1,000 calls/month × 4 min = 4,000 min**:

| | monthly |
|---|---|
| Google Chirp 2 | **$19** |
| Deepgram Nova-3 streaming | **$22** |
| Deepgram Flux | **$26** |

**The spread across every serious option is under ten dollars a month.** At this
volume, price is not a reason to pick anything. Pick on accuracy in Telugu, on
latency, and on whether the vendor solves the turn-detection problem — those
differences are worth far more than $7.

### Why Google is not the obvious "one vendor for everything"

Chirp 2 does cover all three languages for less money. Three things count
against it here:

1. **No native WebSocket.** Google streams over gRPC bidirectional
   (`StreamingRecognize`). A browser cannot speak that, so you need a relay
   process in the middle — extra hop, extra latency, extra thing to run.
   Deepgram exposes `wss://` directly.
2. **Region.** Chirp 3 is GA only in the US and EU multi-regions; Asia is public
   preview with no SLA. For a product whose compliance posture is Indian data
   residency (`docs/COMPLIANCE.md`), routing prospect audio to a US region is a
   question for a lawyer, not just an engineer.
3. **Telugu quality is unmeasured by us.** Nobody's published benchmark settles
   Telugu telephony audio. Sarvam trains specifically on Indic and code-mixed
   speech; that is the whole reason it is here.

### Is anything faster?

**Yes — Deepgram Flux**, and it is aimed exactly at the two complaints in this
document. It is conversational ASR for voice agents with **turn detection and
interruption handling built into the model**, not bolted on. Adopting it would
delete our endpointer, our VAD and our barge-in heuristic in one move. English
only at $0.0065/min; multilingual at $0.0078.

Google's answer is `ENDPOINTING_SENSITIVITY_SUPERSHORT` on Chirp 3, which is a
tuning knob rather than a model that understands turns.

### And local?

- **Groq-hosted Whisper turbo is ~$0.0006/min** — eight times cheaper than
  anything else — and has **no streaming**, so it cannot be part of a live turn.
  It is the right tool for post-call transcripts, not for the call.
- **True on-device** (Whisper or Moonshine compiled to WASM) means a multi-MB
  download per session, and Indic accuracy well below any of the above. Not
  viable for Telugu today.
- What genuinely *should* be local is the part that already is: echo
  cancellation and endpointing. §2 and §5.

### The recommendation

Keep the per-language split in §6. If you want to consolidate later, the vendor
to consolidate onto is **Deepgram — but on Flux, not Nova-3**, and only once the
streaming transport exists, because Flux's whole value is the turn detection and
that only exists over the WebSocket. Consolidating onto Google saves roughly $3
a month and costs you a relay server and a data-residency conversation.

## References

- arXiv 2601.17270 — *Window Size Versus Accuracy Experiments in Voice Activity
  Detection* (RMS 0.11 / WebRTC 0.41 / Silero 0.72 MCC)
- github.com/snakers4/silero-vad — Silero VAD (MIT)
- github.com/ricky0123/vad — Silero in the browser via ONNX Runtime Web
- jitsi.org/blog/enhanced-noise-suppression-in-jitsi-meet — RNNoise in an
  AudioWorklet, the circular-buffer pattern
- datadoghq.com/blog/engineering/noise-suppression-library — `dtln-rs` (MIT)
- docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api — the
  server-side VAD parameters quoted in §4
