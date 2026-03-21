#!/usr/bin/env bash
set -euo pipefail

# publish.sh - full publish workflow
# Usage: ./scripts/publish.sh "Your commit message"
# Requirements:
# - git configured with push permission
# - gh CLI installed and logged in: https://cli.github.com/
# - ssh access: pi@jk.local with no password
# - the repo is on branch dev

COMMIT_MSG=${1:-"chore: publish changes"}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
RELEASE_TAG=${RELEASE_TAG:-dev-latest}
PI_HOST=${PI_HOST:-pi@jk.local}
cd "$REPO_DIR"

function log(){ echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

function require_cmd(){
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

function ensure_git_identity(){
  if [[ -z "$(git config user.name || true)" ]] || [[ -z "$(git config user.email || true)" ]]; then
    echo "git user.name and user.email must be configured before publish." >&2
    exit 1
  fi
}

function ensure_gh(){
  if command -v gh >/dev/null 2>&1; then
    GH_BIN=gh
    return
  fi

  if [[ -x "/c/Program Files/GitHub CLI/gh.exe" ]]; then
    GH_BIN="/c/Program Files/GitHub CLI/gh.exe"
    return
  fi

  echo "gh CLI is required to wait for workflow. Please install and login." >&2
  exit 1
}

function run_gh(){
  "$GH_BIN" "$@"
}

log "1/5: Ensuring dev branch and working tree clean"
ensure_git_identity
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "dev" ]]; then
  log "Switching to dev branch"
  git fetch origin dev
  git checkout dev
  git reset --hard origin/dev
fi

log "Git status before release:"
git status --short

log "1/5: add/commit"
git add .
if git diff --cached --quiet; then
  log "No staged changes to commit"
else
  git commit -m "$COMMIT_MSG"
fi

log "2/5: push to origin/dev"
git push origin dev

log "3/5: wait for GitHub Actions completion"
ensure_gh
run_gh auth status >/dev/null 2>&1 || {
  echo "gh CLI is not authenticated. Run 'gh auth login' first." >&2
  exit 1
}

log "Querying latest workflow run for dev"
WORKFLOW_NAME="publish-backend"
# fallback to any workflow run if no specific
RUN_ID=$(run_gh run list --branch dev --workflow "$WORKFLOW_NAME" --limit 1 --json databaseId --jq '.[0].databaseId')
if [[ -z "$RUN_ID" ]]; then
  log "No workflow run found for $WORKFLOW_NAME. Waiting on latest run for dev."
  RUN_ID=$(run_gh run list --branch dev --limit 1 --json databaseId --jq '.[0].databaseId')
fi

if [[ -z "$RUN_ID" ]]; then
  log "Failed to locate workflow run."
  exit 1
fi

log "Waiting for workflow run #$RUN_ID to complete..."
run_gh run watch "$RUN_ID"

log "Confirming release $RELEASE_TAG exists"
run_gh release view "$RELEASE_TAG" >/dev/null

log "4/5: deploy to Raspberry Pi"
# deploy from the published GitHub release artifact
require_cmd ssh
ssh -o StrictHostKeyChecking=no "$PI_HOST" bash -s <<EOF
set -euo pipefail
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 "$RELEASE_TAG"
sleep 5
sudo systemctl is-active jkmonitor.service
curl -f http://127.0.0.1:5074/api/health
EOF

log "5/5: publish done. Please verify on browser http://jk.local:5074 and clear cache if needed."