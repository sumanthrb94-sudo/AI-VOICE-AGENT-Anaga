#!/usr/bin/env bash
# ===================================================================
# Assemble the Anaga site into a self-contained ./public directory
# that Vercel (or any static host) serves from root.
#   - web/            -> public/            (pages + assets)
#   - docs/*.md       -> public/docs/       (PUBLIC documents only)
#
# public/ is gitignored: it is a build output, rebuilt from web/ on
# every deploy. web/ is the only source of truth.
# ===================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Cleaning public/"
rm -rf public
mkdir -p public

echo "→ Copying site (web/)"
cp -R web/. public/

# web/README.md is developer documentation — how the pages are wired, which
# asset does what. It is not part of the site, and publishing it hands a
# stranger a map of the origin. (It also happened to contain the warning about
# the leak below, so the guard caught it publishing an advisory about itself.)
find public -maxdepth 1 -name '*.md' -delete

# --- Reference docs, PUBLIC ONLY ------------------------------------
#
# THE BUSINESS PLAN AND THE FINANCIAL MODEL WERE BEING PUBLISHED HERE.
#
# docs/BUSINESS_PLAN.md carries the line "Confidential — for prospective
# investors and founding team only" in its own header, and it was copied
# into the deploy directory and served at a 200 URL to anyone who typed
# the path. So was docs/FINANCIAL_MODEL_NOTES.md. The note that used to
# sit here said to "comment out the lines below" to keep them off a
# public deployment — which means the leak was known, written down, and
# left switched on.
#
# A commented-out `cp` is the wrong shape for this. It reads as an option
# and it is one keystroke from being uncommented by someone who did not
# read the sentence above it. So the rule is now enforced instead:
# anything published from docs/ must be listed in PUBLIC_DOCS, and the
# build FAILS if a file that says "Confidential" reaches public/.
#
# To publish the business plan to investors, send it to investors. Do not
# put it on the origin that serves the marketing site.
PUBLIC_DOCS=(
  docs/COMPLIANCE.md      # deliberately public — how we treat DND/consent
  docs/INTEGRATIONS.md    # deliberately public — what we connect to
)

echo "→ Copying public reference docs"
mkdir -p public/docs
for doc in "${PUBLIC_DOCS[@]}"; do
  [ -f "$doc" ] || { echo "✗ PUBLIC_DOCS lists a file that does not exist: $doc" >&2; exit 1; }
  cp "$doc" public/docs/
done

# --- The guard, not the comment -------------------------------------
# Belt and braces: whatever anyone adds above, a document that declares
# itself confidential must never end up in the output directory.
echo "→ Checking for confidential material in the output"
if leaked=$(grep -rliE '^\s*>?\s*\*{0,2}confidential' public/ 2>/dev/null); then
  echo "✗ CONFIDENTIAL MATERIAL IN THE PUBLIC BUILD:" >&2
  echo "$leaked" | sed 's/^/    /' >&2
  echo "  Remove it from PUBLIC_DOCS (or from web/) — this deploy would publish it." >&2
  exit 1
fi

echo "✓ Static site assembled in ./public"
