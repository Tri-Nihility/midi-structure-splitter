#!/usr/bin/env bash
# ============================================================
# GitHub Repository Setup Script
# MIDI Structure Splitter
#
# Usage:
#   chmod +x scripts/setup-github.sh
#   ./scripts/setup-github.sh
#
# Prerequisites:
#   - GitHub CLI (gh) installed and authenticated
#   - Git installed
# ============================================================

set -euo pipefail

REPO_NAME="midi-structure-splitter"
REPO_DESC="MIDI结构拆分 — 基于COSIATEC算法的MIDI压缩与模式分析工具"
REPO_VISIBILITY="public"

echo "=== Setting up GitHub repository for: ${REPO_NAME} ==="
echo ""

# Check prerequisites
if ! command -v gh &>/dev/null; then
  echo "[ERROR] GitHub CLI (gh) is not installed."
  echo "   Install it: https://cli.github.com/"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "[ERROR] Not authenticated with GitHub."
  echo "   Run: gh auth login"
  exit 1
fi

# Create the repository on GitHub
echo "[INFO] Creating repository on GitHub..."
gh repo create "${REPO_NAME}" \
  --"${REPO_VISIBILITY}" \
  --description "${REPO_DESC}" \
  --source=. \
  --remote=origin \
  --push

echo ""
echo "[OK] Repository created successfully!"
echo "   URL: https://github.com/$(gh api user --jq '.login')/${REPO_NAME}"

# Set default branch protections (optional)
echo ""
echo "[TIP] Recommended next steps:"
echo "   1. Go to repo Settings -> Branches -> Add branch protection rule"
echo "   2. Set 'main' as the protected branch"
echo "   3. Require pull request reviews before merging"
echo "   4. Require status checks to pass before merging"
echo ""
echo "   Or use the CLI:"
echo "   gh api repos/\$(gh api user --jq '.login')/${REPO_NAME}/branches/main/protection \\"
echo "     --method PUT \\"
echo "     -F required_status_checks='{\"strict\":true,\"contexts\":[]}' \\"
echo "     -F enforce_admins=false \\"
echo "     -F required_pull_request_reviews='{\"required_approving_review_count\":1}'"
