#!/usr/bin/env bash
# ============================================================
# GitHub Repository Setup & Push Script
# MIDI Structure Splitter
#
# One-command setup: creates a GitHub repo and pushes all code.
#
# Usage:
#   chmod +x scripts/setup-github.sh
#   ./scripts/setup-github.sh
#
# Or specify a custom repo name:
#   ./scripts/setup-github.sh my-custom-name
#
# Prerequisites:
#   - GitHub CLI (gh) installed: https://cli.github.com/
#   - Authenticated: gh auth login
#   - Git installed
# ============================================================

set -euo pipefail

REPO_NAME="${1:-midi-structure-splitter}"
REPO_DESC="MIDI Structure Splitter - COSIATEC-based MIDI compression and pattern analysis tool"
REPO_VISIBILITY="public"
TOPICS="midi,music-analysis,cosiatec,pattern-discovery,compression"

echo ""
echo "============================================"
echo "  MIDI Structure Splitter"
echo "  GitHub Repository Setup"
echo "============================================"
echo ""
echo "  Repository: ${REPO_NAME}"
echo "  Visibility: ${REPO_VISIBILITY}"
echo ""

# ---- Prerequisites ----
if ! command -v gh &>/dev/null; then
  echo "[ERROR] GitHub CLI (gh) is not installed."
  echo "  Install: https://cli.github.com/"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "[ERROR] Not authenticated with GitHub."
  echo "  Run: gh auth login"
  exit 1
fi

echo "[OK] GitHub CLI ready."
echo ""

# ---- Ensure we are in project root ----
cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "[ERROR] Not a git repository."
  exit 1
fi

BRANCH=$(git branch --show-current)
COMMITS=$(git rev-list --count HEAD 2>/dev/null || echo "?")
echo "[INFO] Branch: ${BRANCH}, Commits: ${COMMITS}"
echo ""

# ---- Check if already pushed ----
CURRENT_URL=$(git remote get-url origin 2>/dev/null || echo "")
if echo "$CURRENT_URL" | grep -q "github.com"; then
  echo "[INFO] Remote already set to: $CURRENT_URL"
  echo "[INFO] Pushing latest commits..."
  git push -u origin "$BRANCH"
  echo "[OK] Done!"
  exit 0
fi

# ---- Create repo and push ----
echo "[INFO] Creating repository on GitHub..."
gh repo create "$REPO_NAME" \
  --"$REPO_VISIBILITY" \
  --description "$REPO_DESC" \
  --source=. \
  --remote=origin \
  --push 2>/dev/null || {
    echo "[WARN] gh repo create --push failed (remote may exist). Trying manual push..."
    git remote add origin "https://github.com/$(gh api user --jq '.login')/${REPO_NAME}.git" 2>/dev/null || true
    git push -u origin "$BRANCH"
  }

echo ""
echo "============================================"
echo "  Repository: https://github.com/$(gh api user --jq '.login')/${REPO_NAME}"
echo "  Branch: ${BRANCH} (${COMMITS} commits)"
echo "============================================"