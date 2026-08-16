# Deploying the live-call service

Cloud Run, `asia-south1` (Mumbai) — beside Sarvam and Deepgram. See
`docs/ARCHITECTURE.md` for why this is not on Vercel.

```bash
bash deploy/cloudrun/deploy.sh
```

That is the whole thing. It builds, pushes and deploys, and refuses to start if
something it needs is missing rather than half-deploying.

## Easiest: Cloud Shell

No local install, and `gcloud` is already authenticated as you.

Open [Cloud Shell](https://shell.cloud.google.com), then:

```bash
git clone -b claude/anaga-voice-meta-crm-w6atbl \
  https://github.com/sumanthrb94-sudo/AI-VOICE-AGENT-Anaga.git
cd AI-VOICE-AGENT-Anaga
gcloud config set project YOUR_PROJECT_ID
bash deploy/cloudrun/deploy.sh
```

Cloud Shell ships Node 20, so the script's image-contents pre-flight check may
skip with a warning — that is fine and deliberate. CI runs it on every push; a
pre-flight check refusing to deploy because it could not run would be the check
causing the outage it exists to prevent.

Docker is not needed anywhere: `gcloud builds submit` builds remotely.

## Once, before the first run

**Run the script first, then create the secrets.** That order is not a
preference — `gcloud secrets create` fails with `SERVICE_DISABLED` on a project
where Secret Manager has never been used, and the script is the thing that
enables it. So the first run stops at the secrets check having done all the
enabling; you create the secrets, and the second run goes all the way through.

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

bash deploy/cloudrun/deploy.sh          # enables APIs, then stops: "create the secrets above"

# Keys go in Secret Manager, never in --set-env-vars: env vars are readable by
# anyone with console read access, and one of these dials phones.
printf %s "YOUR_SARVAM_KEY"   | gcloud secrets create sarvam-key       --data-file=-
printf %s "YOUR_DEEPGRAM_KEY" | gcloud secrets create deepgram-key     --data-file=-
printf %s "YOUR_TWILIO_TOKEN" | gcloud secrets create twilio-auth-token --data-file=-   # optional
printf %s "YOUR_GEMINI_KEY"   | gcloud secrets create gemini-key       --data-file=-   # optional

bash deploy/cloudrun/deploy.sh          # this one deploys
```

`printf`, not `echo` — `echo` appends a newline, and the key reaches the vendor
with a trailing `\n`. That fails authentication in a way that looks exactly like
a wrong key.

Paste one command at a time. gcloud asks `enable and retry? (y/N)` on a disabled
API, and a multi-line paste answers that prompt with your next command.

The script enables the APIs, grants Cloud Build's service account the role it
needs, and creates the Artifact Registry repository itself.

**The project needs a billing account.** Firebase's free Spark plan does not
attach one, and Cloud Build and Artifact Registry both refuse without it:

```bash
gcloud beta billing projects describe YOUR_PROJECT_ID     # want billingEnabled: true
gcloud beta billing accounts list                         # OPEN: True ones only
gcloud beta billing projects link YOUR_PROJECT_ID --billing-account=XXXXXX-XXXXXX-XXXXXX
```

To rotate a key later, add a version rather than recreating the secret — the
service reads `:latest`, so the next revision picks it up:

```bash
printf %s "NEW_KEY" | gcloud secrets versions add sarvam-key --data-file=-
```

Overridable by environment variable: `SERVICE`, `REGION` (default
`asia-south1`), `REPO`, `MIN_INSTANCES`, `PROJECT`.

## Why not `gcloud run deploy --source .`

Because it does not deploy this service. `--source .` builds a `Dockerfile` at
the REPO ROOT, and ours is at `deploy/cloudrun/Dockerfile`. With no root
Dockerfile, Cloud Build falls back to a buildpack, which reads `package.json`,
finds Next.js, and deploys the **frontend** as the call service — a failure that
looks like a successful deploy right up until the first call.

`deploy/cloudrun/cloudbuild.yaml` names the Dockerfile explicitly, so there is
nothing to guess.

## What you get

```
  Service   https://anaga-agent-xxxx.a.run.app
  Health    /health                ← check this before dialling anything
  Call page /live.html             ← open it and talk to her
  Socket    wss://…/agent
  Twilio    /incoming-call         ← the number's Voice webhook (POST)
```

`GET /health` reports the region and whether the recogniser is configured. If
`stt` is false, every call connects to silence — check it first, because a
missing key otherwise shows up as a call that just does not respond.

Four things that are easy to get wrong:

- **`--timeout 3600`.** Cloud Run's default request timeout is 5 minutes, and a
  WebSocket *is* one request. Leave it at the default and every call is cut off
  mid-sentence at five minutes, which looks like a bug in the agent.
- **`--min-instances 0`** costs nothing between demos, at the price of a cold
  start on the first call — several seconds of nothing before she speaks. Run
  `MIN_INSTANCES=1 bash deploy/cloudrun/deploy.sh` before showing this to
  anyone.
- **`/agent` is UNAUTHENTICATED and spends money.** `--allow-unauthenticated` is
  required for a browser or Twilio to reach the service at all, and `/agent` has
  no signature to check the way `/twilio` and `/incoming-call` do — a browser
  has no shared secret to sign with. So anyone who finds the URL can open a
  socket and burn Sarvam and Deepgram credits. Mitigations, in order of
  effectiveness: do not publish the URL, watch the vendor spend, and keep
  `--max-instances` low (the script sets 10) so abuse hits a ceiling rather
  than a bill.
- **Secret Manager, not `--set-env-vars`,** for keys. Env vars are visible to
  anyone with console read access.
- **`GET /health` before you dial.** It reports the region and whether the
  recogniser is configured, so a missing key shows up as a boolean rather than
  as silence during a call.

The service serves its own call page at `/live.html`, so after deploying you
can just open the service URL and talk — the page defaults to the host that
served it. To drive it from a page hosted elsewhere (the Vercel site), set
`window.ANAGA_AGENT_URL` to `wss://<service-url>/agent` before `live.js` loads,
or paste it into the field on the page.

`web/` is copied into the image for exactly this reason. It was not, at first,
and the result was a container that started, reported healthy, and 404'd the one
page it exists to serve. `scripts/test-container-contents.mjs` now walks the
service's real import graph and asserts every file it reaches is inside a
`COPY` line.

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

Then open the call page with `window.ANAGA_AGENT_URL = "ws://localhost:8080/agent"`.
No container, no Cloud Run, no phone number.
