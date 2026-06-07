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

# --- Reference docs are intentionally NOT published ------------------
# The customer-facing site no longer links to internal/confidential docs
# (business plan, financials, build spec). Keeping them out of ./public
# ensures no internal or third-party names are reachable on the public site.

echo "✓ Static site assembled in ./public"
