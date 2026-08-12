# Deploying the live-call service

Cloud Run, `asia-south1` (Mumbai) — beside Sarvam and Deepgram. See
`docs/ARCHITECTURE.md` for why this is not on Vercel.

```bash
gcloud run deploy vaak-agent \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --timeout 3600 \
  --set-env-vars "LLM_PROVIDER=sarvam,gemini" \
  --set-secrets "SARVAM_API_KEY=sarvam-key:latest,DEEPGRAM_API_KEY=deepgram-key:latest,GEMINI_API_KEY=gemini-key:latest"
```

Cloud Run builds `Dockerfile` at the repo root by default; point it at this one
with a `--dockerfile` flag if your `gcloud` supports it, or copy it to the root
before deploying.

Four things that are easy to get wrong:

- **`--timeout 3600`.** Cloud Run's default request timeout is 5 minutes, and a
  WebSocket *is* one request. Leave it at the default and every call is cut off
  mid-sentence at five minutes, which looks like a bug in the agent.
- **`--min-instances 0`** costs nothing between demos, at the price of a cold
  start on the first call. Raise it to 1 before showing this to anyone.
- **Secret Manager, not `--set-env-vars`,** for keys. Env vars are visible to
  anyone with console read access.
- **`GET /health` before you dial.** It reports the region and whether the
  recogniser is configured, so a missing key shows up as a boolean rather than
  as silence during a call.

The browser connects to `wss://<service-url>/agent`. Point the page at it by
setting `window.VAAK_AGENT_URL` before `live.js` loads — see the top of
`web/assets/live.js`.

## Before you spend a trial minute: simulate the call

```bash
node --experimental-detect-module scripts/simulate-twilio-call.mjs
```

It starts the server in-process and sends exactly the messages Twilio sends —
`connected`, `start`, 20 ms `media` frames, `stop` — and prints what comes back.
No number, no account, no deployment. It already found one bug that a real call
would have found the expensive way (an answered call that never disclosed).

Point it at a deployment before wiring a number to it:

```bash
node --experimental-detect-module scripts/simulate-twilio-call.mjs \
  --url wss://<service-url>/twilio
```

## What a 30-day trial can and cannot do

Checked against Twilio's docs, and one of these may be a hard blocker.

**⚠️ `<Connect><Stream>` may not be available on a trial.** Twilio's trial page
documents the custom TwiML it supports — `<Say>`, `<Play>`, `<Gather>`,
`<Dial>`/`<Conference>` — and lists thirteen blocked verbs that are replaced
with *"The {verb} verb is not available on trial accounts."* `<Connect>` and
`<Stream>` appear in **neither** list in the text we could read, so this is
unconfirmed either way. **Test it first, in two minutes, before building
anything else on it:** make a TwiML Bin containing

```xml
<Response><Connect><Stream url="wss://example.com/twilio" /></Connect></Response>
```

point your number at it, and call. If you hear the "not available on trial
accounts" message, Media Streams needs a paid account and everything below is
moot until you upgrade.

If it works, the rest of the trial limits are livable for a demo:

| limit | value |
|---|---|
| Voice minutes | **75 total**, then calls are cut off |
| Per-call length | **10 minutes** |
| Concurrent calls | 5 |
| Inbound callers | **must be a Verified Caller ID** (error 21264) |
| Verified numbers | 5 per account |
| Geography | calls restricted to your **sign-up country** |
| TwiML fetch timeout | **5 s** — a cold Cloud Run start can exceed this |
| Trial length | 30 days |

Two of those matter more than they look:

- **Only verified numbers can call in.** Your own phone is verified
  automatically; anyone else you want to demo to needs adding first (max 5).
- **The 5-second TwiML fetch timeout versus `--min-instances 0`.** A cold Cloud
  Run start can take longer than 5 s, and Twilio gives up. Set
  `--min-instances 1` before any call you care about.

**An Indian phone number is unlikely on a trial.** India requires a Regulatory
Bundle, and Twilio's own FAQ says you cannot provision numbers that need
regulatory documentation on a trial account. Combined with the sign-up-country
restriction, the realistic demo is: a number in your sign-up country, called
from your own verified phone.

And none of this touches Indian outbound regulation — DLT registration, TRAI,
the DND registry. That is `docs/COMPLIANCE.md`, it applies to outbound dialling
rather than to someone ringing us, and it is not something a Twilio trial
answers.

## The phone number

Add `TWILIO_AUTH_TOKEN` (Console → Account Info) to the deploy, then point the
number at the service:

```
Twilio Console → Phone Numbers → your number → Voice → A call comes in
  Webhook   https://<service-url>/incoming-call   HTTP POST
```

That is the whole setup. `/incoming-call` returns TwiML that connects the call
to `wss://<service-url>/twilio`, which runs the **same bridge** the browser uses.

Three things worth knowing before the first call:

- **The webhook fails closed.** Without `TWILIO_AUTH_TOKEN` it answers 403 to
  everything, including Twilio. That is deliberate: this endpoint answers phone
  calls and spends Deepgram and Sarvam minutes, and an unverified caller is one
  the compliance gate never saw. If calls are rejected, check the token before
  anything else — the log line says which of the two it was.
- **Nothing transcodes.** Twilio speaks 8 kHz G.711 mulaw, Deepgram accepts it,
  and Bulbul is asked to synthesize it. If you change `TWILIO_FORMAT` you are
  adding a conversion, and telephony audio has no quality to spare.
- **`TWILIO_CALL_LANG`** sets the language for inbound calls (default `en-IN`).
  A caller cannot be asked which language they want before being greeted, so
  this is a per-number setting — one number per language is the honest shape.

Inbound only, for now. Outbound dialling still goes through the compliance gate
and the dial queue (`caller-agent/src/server.js`), and that is where it belongs:
`UserStartedSpeaking` does not know about the DND registry.

## Running it locally instead

```bash
DEEPGRAM_API_KEY=… SARVAM_API_KEY=… \
  node --experimental-detect-module caller-agent/src/agent/main.js
```

Then open the call page with `window.VAAK_AGENT_URL = "ws://localhost:8080/agent"`.
No container, no Cloud Run, no phone number.
