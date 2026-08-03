# LiveKit Agents — what we took, what we didn't, and why

**Source:** [livekit/agents](https://github.com/livekit/agents) · Apache-2.0 · ~17 MB, 905 Python files
**Reviewed:** commit at HEAD, August 2026

The most mature open-source voice-agent framework, and the reference implementation
for turn-taking. This document records what was worth adopting.

## Why the repo is NOT vendored

It was studied, not imported. Vendoring it would be wrong on four counts:

1. **Language.** It is Python. `caller-agent/` is vanilla Node ESM with an empty
   `dependencies` block, deployed next to a static site with no build step.
2. **Transport.** It is built for **WebRTC**. We are built for **PSTN telephony**
   via Plivo/Exotel. That difference is not cosmetic — see "echo" below.
3. **Staleness.** 17 MB of vendored framework we cannot run would be stale within
   a release and would silently rot.
4. **It is a dependency decision, not a reference decision.** If we ever want
   LiveKit, we adopt it as a dependency with its own service — not as a folder.

What is captured here instead is the *design knowledge*, with attribution at each
site in the code that uses it.

---

## ✅ Adopted: false-interruption resume

**Their design** (`livekit-agents/livekit/agents/voice/turn.py`):

```python
"resume_false_interruption": True,
"false_interruption_timeout": 2.0,
```

On a suspected interruption they **pause** the agent's speech and start a timer.
If no transcript materialises within the timeout, the interruption was false — a
cough, line noise, a door — and the agent **resumes** what it was saying.

**Why we needed it.** Our barge-in *cancelled* playback outright. One spurious
frame permanently swallowed the rest of Anaga's sentence, and there was no way to
get it back. Worse: a barge-in landing while TTS was still synthesising dropped
the **entire line** — which could be the AI disclosure or an opt-out
acknowledgement.

**Where it lives:** `caller-agent/src/media/transport.js`
(`resumePausedSpeech`, `falseInterruptionTimeoutMs`, `resumeFalseInterruption`).

**Where we go further.** LiveKit resumes on a *timeout* — it never learns why the
interruption was false. Our echo guard often knows: when the interrupting audio
is positively identified as Anaga's own voice, we resume **immediately** rather
than waiting out two seconds of dead air. A stronger signal, because we know the
cause and not merely the absence of a transcript.

**Correctness boundary:** a *real* interruption still discards the remainder. We
must never finish a sentence over someone who actually spoke — that is the
failure the whole echo effort exists to prevent. Both directions are tested
(`scripts/test-echo.mjs`, "false-interruption resume").

---

## 📋 Reconciled: turn-taking thresholds

| Parameter | LiveKit default | Ours | Why we differ |
|---|---|---|---|
| min interruption duration | `0.5 s` | `0.24 s` (`BARGE_IN_MIN_MS`) | Ours must respond fast to an opt-out. 500ms of continued speech over someone saying "stop calling" is the exact harm we are guarding against. Our echo guard carries the false-positive load instead. |
| false-interruption timeout | `2.0 s` | `2.0 s` | Adopted unchanged. |
| endpointing silence | VAD/ML turn detector | `0.9 s` (`ENDPOINT_SILENCE_MS`) | They ship a trained turn-detector model. We use a threshold tuned higher than the ~500ms Western norm because code-mixed Telugu/Hindi/English pauses longer mid-sentence. |
| `min_interruption_words` | `0` (off) | not implemented | Noted below. |
| `backchannel_boundary` | `(1.0, 1.0)` | not implemented | Noted below. |

Their comment on `backchannel_boundary` independently confirms something we hit:
the end-of-turn value exists to absorb *"STT transcript timestamp inaccuracy"* —
the same late-finalisation that made our 1.2 s browser echo window unreliable and
led us to drop timing as the primary signal.

---

## ❌ Not adopted (yet), with reasons

- **ML turn detector.** They ship a trained model for end-of-utterance
  prediction. Materially better than a silence threshold, and the right upgrade
  once we have real call recordings to evaluate against. It is a model dependency
  and a latency budget, so it is a deliberate later decision, not a copy.
- **`min_interruption_words`.** Requires a word count before honouring an
  interruption. Attractive, but it delays reaction to a one-word "stop" — which
  is precisely the utterance we must react to fastest. Revisit only with real
  call data.
- **Preemptive generation.** They start the LLM before the turn is confirmed to
  cut latency. Worth having; blocked on our brain being a single request/response
  endpoint rather than a stream.

---

## ⚠️ Where they do NOT help us: self-echo

Searching their voice pipeline for echo handling returns **nothing**. That is not
an oversight — it is an architectural consequence. LiveKit runs over **WebRTC**,
where acoustic echo cancellation is handled by the browser/SDK at the transport
layer, before audio ever reaches the agent.

**We do not get that.** PSTN and SIP legs carry hybrid echo from 2-wire/4-wire
conversion, carrier AEC is inconsistent, and our own browser demo demonstrated
acoustic coupling on speakerphone. Our `shared/echo-guard.js` addresses a problem
their architecture does not have to solve.

This is worth knowing for two reasons: it is capability we hold that a
WebRTC-first competitor does not, and it means *adopting LiveKit later would not
remove the need for the echo guard* on telephony legs.

---

## If we ever adopt LiveKit for real

It would be a **separate Python service** behind the existing dial-queue
contract (`shared/integrations-contract.md`), consuming signed jobs exactly as
`caller-agent/` does today. The compliance gate, the suppression list, the
opt-out detector and the CRM writeback would not move — they are ours, they are
tested, and they are the part a framework does not provide.

The honest trigger for that decision is **not** feature envy: it is if the ML
turn detector measurably beats our endpointing on real Indian-language call
audio. Until we have that audio, adopting a framework would trade a system we
can debug for one we cannot, on a guess.
