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

# ── THE BUILD SERVICE ACCOUNT ────────────────────────────────────────────────
# Cloud Build now runs as the COMPUTE ENGINE default service account, not the
# legacy PROJECT_NUMBER@cloudbuild one. On a project where Cloud Build has never
# run, that account holds nothing, so `builds submit` uploads the source tarball
# to its own staging bucket and is then denied storage.objects.get reading it
# back — a 403 that reads like a bucket problem and is not one.
#
# cloudbuild.builds.builder is the bundle: read the staging bucket, write build
# logs, push to Artifact Registry. Granting storage access alone fixes this
# error and fails on the next.
say "→ Making sure Cloud Build's service account can actually build"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

if gcloud projects get-iam-policy "$PROJECT" --flatten="bindings[].members" \
     --filter="bindings.role=roles/cloudbuild.builds.builder AND bindings.members:${BUILD_SA}" \
     --format='value(bindings.role)' 2>/dev/null | grep -q .; then
  echo "  ✓ ${BUILD_SA} already has roles/cloudbuild.builds.builder"
else
  echo "  granting roles/cloudbuild.builds.builder to ${BUILD_SA}"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${BUILD_SA}" \
    --role="roles/cloudbuild.builds.builder" --quiet >/dev/null \
    || die "could not grant the build role. You need roles/resourcemanager.projectIamAdmin
    (or Owner) on ${PROJECT}, or an admin has to run:

      gcloud projects add-iam-policy-binding ${PROJECT} \\
        --member=serviceAccount:${BUILD_SA} \\
        --role=roles/cloudbuild.builds.builder"
  # IAM is eventually consistent; a build started immediately can still 403.
  echo "  waiting 30s for the grant to propagate"
  sleep 30
fi

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

# The commit becomes the second image tag, so a rollback can name a build
# rather than "the one before the bad one". NOT $SHORT_SHA — Cloud Build only
# sets that for builds it triggers from a commit, and on a manual submit it is
# empty, producing the tag `image:` and a parse error minutes into the upload.
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"
git diff --quiet HEAD 2>/dev/null || TAG="${TAG}-dirty"

say "→ Building ${IMAGE}:${TAG}"
gcloud builds submit --config deploy/cloudrun/cloudbuild.yaml \
  --substitutions "_IMAGE=${IMAGE},_TAG=${TAG}" .

# ── ENVIRONMENT ──────────────────────────────────────────────────────────────
# A FILE, not --set-env-vars, and the reason is not style.
#
# --set-env-vars splits on COMMAS, and two of these values CONTAIN commas —
# LLM_PROVIDER and TTS_PROVIDER are provider fallback CHAINS, tried in order
# (api/_lib/tts.js, api/_lib/llm.js). So "LLM_PROVIDER=sarvam,gemini" parses as
# LLM_PROVIDER=sarvam plus a bare token "gemini", which is not a KEY=VALUE pair,
# and gcloud rejects the command. gcloud offers a ^@^ alternate-delimiter escape
# for exactly this, but an escape only works if every future editor of this file
# remembers it is there — and this failure lands AFTER a three-minute build.
#
# A YAML file has no delimiter to collide with. Nothing to remember.
ENV_FILE="$(mktemp -t anaga-env-XXXXXX.yaml)"
trap 'rm -f "$ENV_FILE"' EXIT
cat > "$ENV_FILE" <<'YAML'
NODE_ENV: "production"
# Fallback chains, tried in order. A provider is inert until its own key is
# set, so naming one you have not configured costs nothing.
LLM_PROVIDER: "sarvam,gemini"
TTS_PROVIDER: "sarvam,google"
YAML

say "→ Deploying to Cloud Run (${REGION})"
# No --platform: gcloud has removed it from `run deploy`, and --region already
# selects managed.
gcloud run deploy "$SERVICE" \
  --image "${IMAGE}:${TAG}" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances "$MIN_INSTANCES" \
  --max-instances 10 \
  --concurrency 20 \
  --cpu 1 --memory 512Mi \
  --timeout 3600 \
  --env-vars-file "$ENV_FILE" \
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
