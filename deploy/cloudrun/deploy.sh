#!/usr/bin/env bash
# =============================================================================
# Deploy the live-call service to Cloud Run.
#
#   bash deploy/cloudrun/deploy.sh
#
# Run it from the REPOSITORY ROOT. It builds, pushes and deploys, and refuses
# to do any of that if something it needs is missing.
#
# ── WHY A SCRIPT AND NOT A gcloud ONE-LINER ──────────────────────────────────
# The README used to say `gcloud run deploy --source .`, which builds a
# Dockerfile at the REPO ROOT. Ours is at deploy/cloudrun/Dockerfile, so that
# command does not build this service — it either fails or, worse, falls back
# to a buildpack that guesses at a start command from package.json and boots
# the Next.js frontend instead of the agent.
#
# `gcloud builds submit --config` takes an explicit Dockerfile path, so the
# ambiguity disappears.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

SERVICE="${SERVICE:-anaga-agent}"
REGION="${REGION:-asia-south1}"        # Mumbai — beside Sarvam and Deepgram
REPO="${REPO:-anaga}"                  # Artifact Registry repository
MIN_INSTANCES="${MIN_INSTANCES:-0}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud is not installed. https://cloud.google.com/sdk/docs/install"

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] \
  || die "No project set. Run: gcloud config set project YOUR_PROJECT_ID"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}"

say "→ Checking the image would contain everything the service imports"
# Cheap, and it catches the failure that otherwise only appears after a deploy:
# a COPY list that has gone stale, so the container starts, /health says fine,
# and the first import dies at runtime.
#
# SKIPPED RATHER THAN FATAL when node is absent or too old. Cloud Shell ships
# Node 20, and --experimental-detect-module needs 20.19+. Refusing to deploy
# because a PRE-FLIGHT CHECK could not run would be the check causing the
# outage it exists to prevent — so it warns and carries on. CI runs it on
# every push regardless.
if command -v node >/dev/null 2>&1; then
  if node --experimental-detect-module scripts/test-container-contents.mjs >/dev/null 2>&1; then
    echo "  ✓ every module the service imports is inside a COPY line"
  else
    echo "  ⚠ could not verify the image contents here (node $(node -v)). CI checks this on every push."
    echo "    To see why: node --experimental-detect-module scripts/test-container-contents.mjs"
  fi
else
  echo "  ⚠ no node on this machine — skipping the image-contents check (CI runs it)"
fi

say "→ Enabling the APIs this needs (no-op if already on)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com --quiet

say "→ Making sure the Artifact Registry repository exists"
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" \
    --description="Anaga live-call service"

# ── SECRETS ──────────────────────────────────────────────────────────────────
# Keys go in Secret Manager, never --set-env-vars: env vars are readable by
# anyone with console read access on the project, and one of these dials phones.
say "→ Checking secrets"
MISSING=()
for s in sarvam-key deepgram-key; do
  gcloud secrets describe "$s" >/dev/null 2>&1 || MISSING+=("$s")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "  Missing secrets: ${MISSING[*]}"
  echo "  Create each one with:"
  for s in "${MISSING[@]}"; do
    echo "    printf %s \"YOUR_KEY\" | gcloud secrets create $s --data-file=-"
  done
  die "create the secrets above, then re-run"
fi

SECRETS="SARVAM_API_KEY=sarvam-key:latest,DEEPGRAM_API_KEY=deepgram-key:latest"
# Optional, so a deployment without it still works.
if gcloud secrets describe gemini-key >/dev/null 2>&1; then
  SECRETS="${SECRETS},GEMINI_API_KEY=gemini-key:latest"
fi
# Twilio's auth token is what makes /incoming-call verify its caller. The
# endpoint FAILS CLOSED without it — an unverified caller is one the compliance
# gate never saw — so its absence is a warning, not a silent downgrade.
if gcloud secrets describe twilio-auth-token >/dev/null 2>&1; then
  SECRETS="${SECRETS},TWILIO_AUTH_TOKEN=twilio-auth-token:latest"
else
  echo "  ⚠ no twilio-auth-token secret — /incoming-call will refuse every call (by design)"
fi

say "→ Building ${IMAGE}"
gcloud builds submit --config deploy/cloudrun/cloudbuild.yaml \
  --substitutions "_IMAGE=${IMAGE}" .

say "→ Deploying to Cloud Run (${REGION})"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances "$MIN_INSTANCES" \
  --max-instances 10 \
  --concurrency 20 \
  --cpu 1 --memory 512Mi \
  --timeout 3600 \
  --set-env-vars "NODE_ENV=production,LLM_PROVIDER=sarvam,gemini,TTS_PROVIDER=sarvam,google" \
  --set-secrets "$SECRETS" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

say "✓ Deployed"
cat <<EOF

  Service   ${URL}
  Health    ${URL}/health
  Call page ${URL}/live.html          ← open this to talk to her
  Socket    ${URL/https:/wss:}/agent
  Twilio    ${URL}/incoming-call      ← paste into the number's Voice webhook (POST)

  Check it before dialling anything:

    curl -s ${URL}/health | jq

  \`stt\` must be true. If it is false the recogniser has no key and every call
  will connect to silence.

EOF

if [ "$MIN_INSTANCES" = "0" ]; then
  cat <<'EOF'
  ⚠ min-instances is 0, so the first call after an idle period pays a cold
    start — several seconds before she says anything. Before showing this to
    anyone: MIN_INSTANCES=1 bash deploy/cloudrun/deploy.sh

EOF
fi

cat <<'EOF'
  ⚠ /agent is UNAUTHENTICATED. Anyone who finds the URL can open a socket and
    spend your Sarvam and Deepgram credits. --allow-unauthenticated is required
    for Twilio and a browser to reach it at all, so the mitigations are: keep
    the URL unpublished, watch the vendor spend, and set max-instances (done —
    10 above) so an abusive caller hits a ceiling rather than a bill.
    /twilio and /incoming-call verify Twilio's signature; /agent has no
    equivalent because a browser has no shared secret to sign with.

EOF
