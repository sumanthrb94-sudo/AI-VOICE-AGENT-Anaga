#!/usr/bin/env bash
# ===================================================================
# Assemble the Vaak AI home screen into a self-contained ./public
# directory that Vercel (or any static host) can serve from root.
#   - web/            -> public/            (index.html, assets/)
#   - docs/*.md       -> public/docs/       (linked from the nav)
#   - engineering/*.md-> public/engineering/(linked from the nav)
# ===================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Cleaning public/"
rm -rf public
mkdir -p public

echo "→ Copying home screen (web/)"
cp -R web/. public/

# --- Reference docs surfaced by the home-screen nav -----------------
# NOTE: docs/BUSINESS_PLAN.md is marked Confidential. It is copied here
# so the nav links resolve on the deployed site. To keep it OFF a public
# deployment, comment out the BUSINESS_PLAN / FINANCIAL lines below.
echo "→ Copying reference docs"
mkdir -p public/docs public/engineering
cp docs/BUSINESS_PLAN.md          public/docs/          # ← Confidential
cp docs/COMPLIANCE.md             public/docs/
cp docs/FINANCIAL_MODEL_NOTES.md  public/docs/          # ← Confidential
cp engineering/MULTI_AGENT_SPEC.md public/engineering/

echo "✓ Static site assembled in ./public"
