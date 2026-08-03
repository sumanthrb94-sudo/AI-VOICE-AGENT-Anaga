#!/usr/bin/env bash
# .claude/hooks/vaak-prompt.sh
#
# UserPromptSubmit hook — runs on EVERY prompt, before Claude sees it.
#
# Because it is on the critical path of every single turn, it obeys three rules:
#   1. It never fails the turn. Every branch exits 0; a missing tool is a no-op.
#   2. It is time-boxed. Nothing here may block a prompt for more than ~3s.
#   3. It only does work when work changed. graphify is incremental (SHA256
#      cache), so a no-change turn costs a stat sweep, not a re-index.
#
# What it emits on stdout is injected into the turn as context, so it stays to a
# couple of lines — this text is paid for on every prompt.

set -u
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# Never let a slow or broken tool hold a prompt hostage.
run() { timeout 3s "$@" 2>/dev/null; }

notes=""

# --- graphify: keep the code knowledge graph current -----------------------
if command -v graphify >/dev/null 2>&1; then
  if [ -f graphify-out/graph.json ]; then
    # Incremental: only re-parses files whose SHA256 changed.
    run graphify update . >/dev/null || true
  else
    notes="${notes}graphify: no graph yet — run \`graphify . --code-only\` for graph-backed answers. "
  fi
fi

# --- open-code-review: flag unreviewed changes to the pipeline -------------
# Only the paths where a mistake means an illegal phone call.
if command -v git >/dev/null 2>&1; then
  changed=$(run git diff --name-only -- api/ caller-agent/ shared/ | wc -l | tr -d ' ')
  if [ "${changed:-0}" -gt 0 ] 2>/dev/null; then
    notes="${notes}${changed} uncommitted file(s) under api/|caller-agent/|shared/ — compliance-sensitive; \`ocr review\` before committing. "
  fi
fi

[ -n "$notes" ] && echo "[vaak] $notes"
exit 0
