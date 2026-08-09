# IndicF5 — the open-source voice

Self-hosted [AI4Bharat IndicF5](https://github.com/AI4Bharat/IndicF5). Third in
the provider chain, behind Sarvam and Google: no per-character cost once the box
is paid for, but a box has to exist and stay warm.

## Why IndicF5 and not Fish-Speech or GPT-SoVITS

Those two are better known, and both were the obvious pick until checked:
**neither officially supports Telugu or Hindi.** Fish-Speech covers English,
Chinese, Japanese, Korean, French, German, Arabic and Spanish; Indic support is
an open discussion thread, not a shipped capability. GPT-SoVITS clones a voice
from five seconds but its base model's Indic phonetics are not there.

For this product that is disqualifying. A GPU bill for languages we do not sell
in is worse than the vendor we already have.

IndicF5 covers **11 Indian languages including Telugu**, trained on 1417 hours,
and does reference-audio cloning. [praxelhq/praxy](https://github.com/praxelhq/praxy)
is worth evaluating alongside it — it targets code-mixed Hindi/Telugu/Tamil/English
specifically, which is our actual conversation shape.

## The contract

Ours, not the model's — IndicF5 ships inference code, not a server. `server.py`
implements exactly this and nothing else:

```
POST /tts
  { "text": "...", "language": "te", "voice": "anaga_te_f", "sample_rate": 24000 }
  -> 200 audio/wav

GET /health
  -> { "ok": true, "voices": ["anaga_te_f", ...], "warm": true }
```

**`voice` is a NAME, never a clip.** IndicF5 needs a reference audio file and
that file's transcript to clone from; shipping a WAV on every request would be
absurd, so references live on the server under names and we send the name.

## Reference clips

Each voice is two files in `voices/`:

```
voices/anaga_te_f.wav     10-20s, clean, one speaker, no music
voices/anaga_te_f.txt     the exact transcript of that clip
```

The transcript has to be *exact*. The model aligns against it, and a wrong
transcript produces confident, fluent, wrong prosody.

> **Licence.** The IndicF5 model card requires that you only clone voices you
> have explicit permission to clone. A reference clip of somebody who did not
> agree is not a configuration detail — it is the thing that makes this
> unlawful, and no amount of it sounding good fixes that. Record your own
> voice talent, keep the release form.

## Running it

```bash
docker compose -f deploy/indicf5/docker-compose.yml up -d
curl localhost:8080/health
```

Needs an NVIDIA GPU and the container toolkit. On CPU it will load and it will
answer, far too slowly for a live call — useful for checking the wiring, not for
serving anyone.

Bound to loopback by default. **This server has no authentication**, exactly like
the VoiceStudio one: put it behind a tunnel or a reverse proxy with
`INDICF5_API_KEY`, and never expose the port.

## Pointing the app at it

```
INDICF5_URL=http://127.0.0.1:8080
INDICF5_VOICE_FEMALE=anaga_te_f
INDICF5_VOICE_MALE=anaga_te_m      # omit and the chain refuses male here
INDICF5_API_KEY=…                  # optional
INDICF5_TIMEOUT_MS=30000           # a cold GPU is slow on the first request
```

A gender with no reference configured is **refused**, and the chain moves to a
provider that can actually do it. The model will happily clone *something* for a
missing reference, and "something" is how a male preset ends up sounding like a
woman with nobody noticing.

## Is it actually better?

Do not decide by ear, and do not let anyone else either:

```bash
node --experimental-detect-module scripts/analyze-voice.mjs --text "నమస్కారం, నేను అనగా" \
  --lang te-IN --base https://your-deploy
```

Compare `f0SpreadSemitones` (pitch movement — the measurement behind "robotic",
natural speech is 2.5–5) and `bandwidthHz` against Sarvam on the same sentence.
That settles it with numbers.

## Status

⚠️ **Unverified.** Neither this server nor the adapter in `api/_lib/tts.js` has
run against a live GPU. Both are written against AI4Bharat's documented
inference call. Treat as unproven until a real box has answered one request —
the same status the VoiceStudio path carries.
