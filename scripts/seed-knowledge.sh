#!/usr/bin/env bash
# Seed Anaga's knowledge base (RAG) with the Modcon project docs.
#
# Usage:
#   BASE_URL=https://ai-voice-agent-anaga.vercel.app \
#   ADMIN_KEY=your_admin_key \
#   bash scripts/seed-knowledge.sh
#
# Re-runnable: each run adds rows. To avoid duplicates, clear the table first in
# Supabase (delete from knowledge_base where client_id='modcon';) before re-seeding.

set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL, e.g. https://ai-voice-agent-anaga.vercel.app}"
ADMIN_KEY="${ADMIN_KEY:?set ADMIN_KEY (your ADMIN_API_KEY)}"

post_doc() {
  local title="$1"; local file="$2"
  if [[ ! -f "$file" ]]; then echo "skip (missing): $file"; return; fi
  echo "→ Seeding: $title  ($file)"
  # Use jq to safely JSON-encode the file content if available; else python.
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg t "$title" --rawfile c "$file" '{title:$t, content:$c}'
  else
    python3 -c "import json,sys;print(json.dumps({'title':sys.argv[1],'content':open(sys.argv[2]).read()}))" "$title" "$file"
  fi | curl -sS -X POST "$BASE_URL/api/anaga?action=kb-add" \
        -H "Authorization: Bearer $ADMIN_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @- ; echo
}

post_doc "SYL Residences & MODCON ONE — full data" "docs/syl.md"
post_doc "Agartha — eco-farmhouse project" "docs/agartha.md"

echo "Done. Test: POST $BASE_URL/api/anaga?action=care  {\"message\":\"What is the price of SYL?\"}"
