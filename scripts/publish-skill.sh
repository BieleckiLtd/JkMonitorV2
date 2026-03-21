#!/usr/bin/env bash
set -euo pipefail

# publish-skill.sh - repository publish workflow as a reusable skill
# Usage: ./scripts/publish-skill.sh "Your commit message"

COMMIT_MSG=${1:-"chore: publish changes"}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_DIR"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

ensure_git_identity() {
  if [[ -z "$(git config user.name)" ]] || [[ -z "$(git config user.email)" ]]; then
    git config user.name "Pawel Bielecki" || true
    git config user.email "bieleckiltd@outlook.com" || true
  fi
  if [[ -z "$(git config user.name)" ]] || [[ -z "$(git config user.email)" ]]; then
    echo "ERROR: git user.name/user.email is not configured." >&2
    echo "Set with: git config user.name \"Your Name\" && git config user.email \"you@example.com\"" >&2
    exit 1
  fi
}

ensure_gh() {
  if command -v gh >/dev/null 2>&1; then
    GH_CLI=gh
  elif [[ -x "/c/Program Files/GitHub CLI/gh.exe" ]]; then
    GH_CLI="/c/Program Files/GitHub CLI/gh.exe"
  else
    echo "ERROR: gh CLI not found. Please install gh: https://cli.github.com/" >&2
    exit 1
  fi

  if ! "$GH_CLI" auth status >/dev/null 2>&1; then
    echo "ERROR: gh not authenticated. Run: $GH_CLI auth login" >&2
    exit 1
  fi
}

log "1/6 ensure branch and identity"
ensure_git_identity

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "dev" ]]; then
  log "Switching to dev"
  git fetch origin dev
  git checkout dev
  git reset --hard origin/dev
fi

git status --short

log "2/6 add + commit"
git add .
if git diff --cached --quiet; then
  log "No changes to commit"
else
  git commit -m "$COMMIT_MSG"
fi

log "3/6 push"
git push origin dev

log "4/6 wait for workflow"
ensure_gh
WORKFLOW=publish-backend
RUN_ID=$(gh run list --branch dev --workflow "$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
if [[ -z "$RUN_ID" ]]; then
  RUN_ID=$(gh run list --branch dev --limit 1 --json databaseId --jq '.[0].databaseId')
fi
if [[ -z "$RUN_ID" ]]; then
  echo "ERROR: no workflow run found" >&2
  exit 1
fi
log "Watching workflow run $RUN_ID"
gh run watch "$RUN_ID"

log "5/6 deploy to pi"
ssh pi@fm.local bash -s <<'EOF'
set -euo pipefail
cd /home/pi
if [[ ! -d JkMonitorV2 ]]; then
  git clone https://github.com/BieleckiLtd/JkMonitorV2.git
fi
cd JkMonitorV2
git fetch --all

# align with remote
git checkout dev
git reset --hard origin/dev

# publish backend
dotnet publish src/backend/JkMonitor.Backend/JkMonitor.Backend.csproj -c Release -r linux-arm64 --self-contained false -o /home/pi/jkmonitor/app

# copy frontend
rsync -av --delete src/backend/JkMonitor.Backend/wwwroot/ /home/pi/jkmonitor/app/wwwroot/

sudo systemctl stop jkmonitor.service || true
sudo systemctl start jkmonitor.service
sleep 5
sudo systemctl status jkmonitor.service --no-pager
EOF

log "6/6 validate local endpoint (best effort)"
if command -v curl >/dev/null 2>&1; then
  curl -f http://127.0.0.1:5074/api/health
  curl -f http://127.0.0.1:5074/api/devices/config
else
  log "curl missing locally. Please verify http://fm.local:5074/api/health and /api/devices/config manually."
fi

log "publish-skill done"
