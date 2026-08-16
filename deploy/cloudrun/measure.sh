#!/usr/bin/env bash
# =============================================================================
# Measure turn latency FROM asia-south1, beside the vendors.
#
#   bash deploy/cloudrun/measure.sh              # 20 turns, te-IN
#   TURNS=40 LANG_TAG=en-IN bash deploy/cloudrun/measure.sh
#
# Run it from the REPOSITORY ROOT, after deploy.sh has pushed an image.
#
# ── WHY THIS EXISTS AND CLOUD SHELL DOES NOT DO ──────────────────────────────
# `node scripts/measure-latency.mjs --live` from Cloud Shell measures the round
# trip from wherever Google put that VM — usually the United States — to Sarvam
# and Deepgram in India, and back. Every number it produces is inflated by a
# path no prospect will ever be on, and Cloud Shell cannot be pinned to a
# region, so the honest number is simply not available there.
#
# A Cloud Run JOB runs the same image, in the same region, with the same
# secrets, and exits. It is the same code the service runs, on the same network
# the service is on, so what it measures is what a caller would experience.
#
# It costs a few seconds of CPU and real vendor spend for the turns it drives.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

SERVICE="${SERVICE:-anaga-agent}"
JOB="${JOB:-${SERVICE}-measure}"
REGION="${REGION:-asia-south1}"
REPO="${REPO:-anaga}"
TURNS="${TURNS:-20}"
LANG_TAG="${LANG_TAG:-te-IN}"        # not LANG: that is a POSIX locale variable

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud is not installed."
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
[ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] \
  || die "No project set. Run: gcloud config set project YOUR_PROJECT_ID"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}"

# The tag the service is CURRENTLY serving, so the measurement describes the
# deployment rather than whatever :latest happens to be. Measuring a different
# build from the one running is how a number outlives the code that earned it.
TAG="$(gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(spec.template.spec.containers[0].image)' 2>/dev/null | sed 's/.*://')"
[ -n "$TAG" ] || die "No deployed service '$SERVICE' in $REGION. Run deploy.sh first."

say "→ Measuring ${TURNS} turns of ${LANG_TAG} from ${REGION}, against image :${TAG}"

for s in sarvam-key deepgram-key; do
  gcloud secrets describe "$s" >/dev/null 2>&1 || die "missing secret $s — see deploy.sh"
done
SECRETS="SARVAM_API_KEY=sarvam-key:latest,DEEPGRAM_API_KEY=deepgram-key:latest"
if gcloud secrets describe gemini-key >/dev/null 2>&1; then
  SECRETS="${SECRETS},GEMINI_API_KEY=gemini-key:latest"
fi

# `jobs deploy` creates or updates, so re-running is safe.
#
# --max-retries 0 is deliberate. A retried measurement is two runs averaged by
# accident, and the failure this harness most needs to report — a rate limit —
# is exactly the one a retry would paper over.
#
# No LLM_PROVIDER/TTS_PROVIDER: the code defaults are `sarvam,gemini` and
# `sarvam,google,...`, the same chains the service is deployed with, since
# every provider past the first is inert without its own key. Passing them
# would need --env-vars-file anyway, because both values contain commas and
# --set-env-vars splits on those — the same trap that broke deploy.sh twice.
#
# --args= AND --command=, WITH THE EQUALS SIGN, NOT A SPACE.
#
# The args this passes START WITH A DASH — "--experimental-detect-module,…" —
# and gcloud's parser reads a space-separated value beginning with `--` as the
# next FLAG rather than as the value. So `--args "--experimental…"` leaves
# --args with nothing and fails with "argument --args: expected one argument",
# which reads as a missing argument rather than as a quoting rule.
#
# COMMENTS GO HERE, NOT INSIDE THE COMMAND. A `# ...` inside backticks comments
# out its own closing backtick, so bash keeps reading the following lines
# looking for it and swallows the flags below — a separate bug that produced
# the identical error message, which is how it hid behind this one.
gcloud run jobs deploy "$JOB" \
  --image "${IMAGE}:${TAG}" \
  --region "$REGION" \
  --set-secrets "$SECRETS" \
  --set-env-vars "NODE_ENV=production" \
  --max-retries 0 \
  --task-timeout 900s \
  --cpu 1 --memory 512Mi \
  --command=node \
  --args="--experimental-detect-module,scripts/measure-latency.mjs,--live,--turns,${TURNS},--lang,${LANG_TAG}" \
  --quiet >/dev/null

say "→ Running it (this drives ${TURNS} real turns and spends real vendor credit)"
gcloud run jobs execute "$JOB" --region "$REGION" --wait --quiet >/dev/null \
  || echo "  (the job reported a failure — the output below still says why)"

say "→ Output"
# The job's stdout, oldest first, which is the order the harness printed it in.
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${JOB}" \
  --limit 200 --freshness=20m --format='value(textPayload)' --order=asc

cat <<EOF

  This number was measured in ${REGION}, beside the vendors, on the image the
  service is serving right now (:${TAG}). It is the one worth quoting.

  Read the failure breakdown FIRST. A p50 computed only from turns that
  produced audio is a percentile over survivors, and it flatters.

EOF
