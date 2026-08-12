# Where Deepgram is, and why the pipeline fights us

## 1. Where Deepgram is used today

**One function. That is the whole of it.**

`api/_lib/stt.js` → `viaDeepgram()` → `POST https://api.deepgram.com/v1/listen`

The **batch** endpoint. One HTTP request, one whole utterance in, one transcript
back. It is wired for **English only** (`STT_PROVIDER` per language, §6 of
docs/VAD.md); Telugu and Hindi go to Sarvam Saaras.

Deepgram is doing **one leg of five**. It is a drop-in replacement for a
transcription call, and nothing more.

## 2. What we actually run

```
   BROWSER                          VERCEL (bom1, serverless)         VENDORS
   ───────                          ─────────────────────────         ───────
   mic.js
   ├ getUserMedia (AEC)
   ├ AnalyserNode  → our VAD
   ├ our endpointer (silence timer)
   └ MediaRecorder → whole utterance
                    │
                    │  base64 in a JSON body
                    ▼
              POST /api/anaga/turn ──────► transcribe()  ──► Deepgram / Sarvam
                                              (wait)
                                           generate()    ──► Sarvam / Gemini
                                              (wait)
                                           synth()       ──► Sarvam Bulbul
                                              (wait)
                    ◄────────────────── { heard, say, speak: base64 }
   demo-call.js
   ├ our phrase splitter
   ├ our barge-in
   └ <audio> playback
```

Everything is **serial**. Each stage must finish before the next begins. The
transport is request/response, so there is no such thing as "partial" anywhere
in it.

Also in the repo, and **not used by the browser at all**:

```
caller-agent/          a real WebSocket media server, for the PHONE leg
├ src/media/ws.js         hand-rolled RFC 6455 (tested)
├ src/media/server.js     Plivo / Exotel codecs
├ src/media/transport.js  streaming STT, endpointing, barge-in
└ src/session.js          the call, as a conversation
```

## 3. What Deepgram actually recommends

Their reference architecture is the **Voice Agent API**: one WebSocket that
carries the entire conversation.

```
   CLIENT                          wss://agent.deepgram.com/v1/agent/converse
   ──────                          ──────────────────────────────────────────
   raw PCM, continuously  ───────►  STT (Flux / Nova-3, native turn-taking)
                                       │
                                    LLM (think)
                                       │
                                    TTS (speak)
   ◄──────  UserStartedSpeaking        ← barge-in, as an event
   ◄──────  ConversationText           ← transcript, as it happens
   ◄──────  AgentThinking
   ◄──────  [binary audio]             ← her voice, streaming
   ◄──────  AgentAudioDone
```

Message flow: `Welcome` → `Settings` → `SettingsApplied` → stream audio → events.

**What that endpoint owns that we currently hand-build:**

| we wrote | Voice Agent gives |
|---|---|
| `mic.js` VAD (percentile floor, spectral gate) | server-side neural VAD |
| our endpointer + adaptive silence window | Flux native turn-taking |
| `bargeIn()` + the deleted echo guard | `UserStartedSpeaking` event |
| `splitForSpeech()` + first-phrase-first | streaming TTS |
| `firstClauseOf()` LLM stream-scanning | streaming end to end |
| the backchannel | not needed — the gap is gone |
| base64 in / base64 out | binary frames |

## 4. So why aren't we doing that?

**One reason, and it is a deployment choice, not a coding one:**

> A Vercel serverless function cannot hold a WebSocket open.

Everything in §2 is downstream of that. The batch STT, the serial pipeline, the
hand-built VAD, the 800 ms silence timer, the recorder that buffered the whole
call, the base64 inflation — every one of them exists because the transport is
request/response.

That is the honest answer to "why are we facing this much issue". We are not
fighting Deepgram or Sarvam. We are re-implementing, badly and in a browser, the
parts of a voice stack that both vendors already ship — because the place we
deploy to cannot hold the connection that would let us use theirs.

## 5. What moving to it costs

Not free, and two of these need a decision rather than an implementation.

**A host for a long-lived process.** Fly.io (Deepgram's own reference uses
`fly.toml`), Render, Railway, Cloud Run. The Vercel functions stay for the
webhook/CRM/console surface; only the call leg moves.

**Telugu, which is the real constraint.** Voice Agent's `speak` providers are
Deepgram Aura, ElevenLabs, Cartesia, OpenAI and AWS Polly — **Sarvam is not on
that list**, and Aura is English-first. The settings schema does allow a
**custom TTS endpoint** (`https`, and `wss` for ElevenLabs only), so pointing
`speak` at our own endpoint wrapping Bulbul looks possible — **unverified**. If
it does not work, Telugu keeps the current architecture and only English moves,
which is a worse outcome than it sounds: two pipelines to maintain.

**The compliance surface stays ours regardless.** The gate, the suppression
list, opt-out overriding the model, the calling window, recording residency —
none of that belongs in a vendor's agent loop, and `UserStartedSpeaking` does
not know about the DND registry.

## 6. The order to build it

1. **Browser first** — a `/agent` WebSocket on the media server, the browser
   streams PCM to it, it bridges to Deepgram. Same server, same session code the
   phone leg will use. Testable with no phone number and no Twilio account.
2. **Then Twilio** — `POST /incoming-call` returns TwiML with `<Stream>`,
   `WS /twilio` bridges Twilio's base64 mulaw ⇄ Deepgram's binary. Deepgram's
   own reference does exactly this; the only new code is the mulaw envelope,
   because the bridge is the same one the browser uses.

Deepgram's reference calls this "protocol-agnostic server": the browser dev
client and the Twilio stream send the *same* messages, so one bridge serves
both. That is the shape to copy.

**Language: stay on Node.** Deepgram's Twilio guide is Python and their browser
demos are Node/TypeScript — both SDKs exist and neither is better. This repo is
Node ESM with zero dependencies and a hand-rolled, tested WebSocket layer already
in `caller-agent/src/media/ws.js`. Adding Python means a second runtime, a second
deploy target and a second test suite for no capability we gain.
