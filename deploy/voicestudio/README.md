# Anaga's own voice — standing up the self-hosted engine

Makes [VoiceStudio](https://github.com/debpalash/VoiceStudio) the engine behind
Anaga: her voice on calls, and optionally the ear that transcribes the prospect.

Read [`engineering/VOICESTUDIO_REFERENCE.md`](../../engineering/VOICESTUDIO_REFERENCE.md)
first — especially **§1, the licence**. Short version: we pull their published,
unmodified image and call it over its API. **Never copy its source into this
repo.**

---

## 0. What you need

- A host with an **NVIDIA GPU**, in an **Indian region**. The region is not a
  preference: `docs/COMPLIANCE.md` requires Indian data residency, and the whole
  point of self-hosting is that the prospect's audio never leaves infrastructure
  we control. A box in `us-east-1` throws that away and keeps only the saving.
- Docker with the NVIDIA container toolkit.
- ~20 GB of disk for models.

CPU works for auditioning voices and will **not** hold a phone call. Most
engines run slower than realtime; a call forgives about 300ms.

---

## 1. Start it

```bash
docker compose -f deploy/voicestudio/docker-compose.yml --profile gpu up -d
docker compose -f deploy/voicestudio/docker-compose.yml --profile gpu logs -f
```

First boot downloads several GB. Wait for the health check, then:

```bash
curl -sf http://127.0.0.1:3900/health && echo up
```

> **It is bound to loopback and it has no authentication of its own.** That
> `127.0.0.1:` prefix is the only thing between this and an open TTS/ASR service
> on the public internet. To reach it from the API host use a private network
> (WireGuard/Tailscale) or a reverse proxy with auth — never `0.0.0.0`.

---

## 2. Clone Anaga's voices

Open `http://127.0.0.1:3900` (SSH-forward the port; do not expose it). In
**Studio**, clone from ~3 seconds of clean reference audio. Clone **two**: one
female for Anaga's default persona, one male for the Arjun preset.

**Consent is not a formality.** If you clone a real person — a salesperson, the
founder, anyone — get their written permission for outbound calls first. TRAI
disclosure covers "this is an AI"; it does not cover "this is an AI wearing your
colleague's voice."

Then list the ids and audition them:

```bash
VOICESTUDIO_URL=http://127.0.0.1:3900 node scripts/voicestudio-voices.mjs
VOICESTUDIO_URL=http://127.0.0.1:3900 node scripts/voicestudio-voices.mjs --say <id>
VOICESTUDIO_URL=http://127.0.0.1:3900 node scripts/voicestudio-voices.mjs --say <id> --lang hi
```

The endpoint does not report gender, so the script's suggested pinning is a
guess. **Listen to each clip before you pin it.** The adapters refuse to serve a
gender with no pinned profile precisely so a male preset never quietly becomes a
woman — do not undo that by pinning them backwards.

---

## 3. Point Vaak at it

On the API deployment (Vercel env), and on the caller-agent host:

```
VOICESTUDIO_URL=http://10.0.0.4:3900      # private address, not localhost
VOICESTUDIO_API_KEY=…                     # if behind an auth proxy
VOICESTUDIO_VOICE_FEMALE=prof_…
VOICESTUDIO_VOICE_MALE=prof_…
```

`voicestudio` already leads the default chain and is inert until
`VOICESTUDIO_URL` is set, so nothing changes until you set it. Confirm:

```bash
curl -s "$BASE/api/integrations/health" | jq '.tts, .voiceStudio'
```

You want `voiceStudio.reachable: true`, `male: true`, `female: true`, and
`tts.maleCapable: true`. A configured-but-unreachable box is reported as the
`voicestudio_unreachable` blocker — that shape is the dangerous one, because it
looks wired and silently costs a hop on every line Anaga speaks.

To use it on the call leg too, on the caller-agent host:

```
TTS_PROVIDER=voicestudio
STT_PROVIDER=voicestudio     # optional — see §5
TTS_GENDER=female            # or male
```

---

## 4. Sample rates — the failure that does not announce itself

The engine renders at 24kHz. A phone line is 8kHz. Handing 24kHz samples to a
transport that believes they are 8kHz does not throw an error; it plays Anaga
at three times speed to a stranger, with nothing in any log to explain it.

`speech.js` therefore requests **WAV**, not headerless PCM, reads the true rate
from the header, downmixes, and resamples to `TELEPHONY_SAMPLE_RATE`. Covered by
`scripts/test-voicestudio.mjs` §1–§2. If you change the format the adapter asks
for, run that suite.

---

## 5. STT is the bigger prize, and the bigger unknown

`LAUNCH.md` blocker #3 is "STT on real telephony audio is unproven" — nothing
here has ever transcribed 8kHz μ-law from a phone line. VoiceStudio bundles
WhisperX, Faster-Whisper, Parakeet, FunASR and sherpa-onnx behind one
OpenAI-compatible endpoint, which makes the experiment cheap: record one real
call, replay it through several engines, measure **number and name accuracy**
(those are what the flow actually extracts — budget, BHK, the caller's name).

Set `VOICESTUDIO_ASR_MODEL` to pin an engine. Until that experiment is run,
leave `STT_PROVIDER=sarvam`.

---

## 6. Do not claim this works until

1. `voiceStudio.reachable: true` on the real deployment.
2. Time-to-first-audio measured on the call leg. If the batch endpoint is too
   slow, their streaming `/ws/tts` emits sentence chunks and fits the paced
   playback already in `caller-agent/src/media/transport.js` — that is the next
   move, not a rewrite.
3. **Hindi and Telugu A/B'd against Sarvam by native speakers**, on the real
   qualification script, over a phone codec. Not on a laptop speaker.
4. One real call, end to end, to a consenting internal number.
5. The AGPL read with counsel before it carries revenue.

Until 1–4, Sarvam is what actually speaks on production, and saying otherwise in
a pitch is the kind of claim that dies in diligence.
