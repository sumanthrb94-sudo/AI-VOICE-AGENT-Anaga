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

## Running it locally instead

```bash
DEEPGRAM_API_KEY=… SARVAM_API_KEY=… \
  node --experimental-detect-module caller-agent/src/agent/main.js
```

Then open the call page with `window.VAAK_AGENT_URL = "ws://localhost:8080/agent"`.
No container, no Cloud Run, no phone number.
