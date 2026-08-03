#!/usr/bin/env bash
# scripts/review.sh — Alibaba Open Code Review, wired to this repo.
#
# Wraps `ocr` with the two things it cannot infer:
#   --background-file  the compliance context that decides what counts as a defect
#   --exclude          the vendored skill payloads, which are not our code
#
# Usage:
#   scripts/review.sh                      # staged + unstaged changes
#   scripts/review.sh --from main --to HEAD
#   scripts/review.sh --commit abc123
#
# No LLM key configured? Use delegation mode instead — it emits the review spec
# and rules with no LLM call, for a host agent (Claude Code) to execute:
#   scripts/review.sh --delegate
#
# Install: npm install -g @alibaba-group/open-code-review   (Apache-2.0)

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v ocr >/dev/null 2>&1; then
  echo "ocr not found. Install with: npm install -g @alibaba-group/open-code-review" >&2
  exit 127
fi

# Vendored third-party skill payloads and generated output are not our code.
EXCLUDE='.claude/skills/**,.claude/commands/**,.claude/helpers/**,.claude/agents/**,.claude-flow/**,.agents/**,graphify-out/**,public/**,design-system/**'

BACKGROUND=".ocr/background.md"

if [ "${1:-}" = "--delegate" ]; then
  shift
  exec ocr delegate preview "$@"
fi

exec ocr review \
  --background-file "$BACKGROUND" \
  --exclude "$EXCLUDE" \
  "$@"
