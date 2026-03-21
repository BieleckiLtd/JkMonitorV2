#!/usr/bin/env bash
set -euo pipefail

# publish.sh - full publish workflow
# Usage: ./scripts/publish.sh "Your commit message"
# Requirements:
# - git configured with push permission
# - gh CLI installed and logged in: https://cli.github.com/
# - ssh access: pi@fm.local with no password
# - the repo is on branch dev

COMMIT_MSG=${1:-"chore: publish changes"}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_DIR"

function log(){ echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

log "1/5: Ensuring dev branch and working tree clean"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "dev" ]]; then
  log "Switching to dev branch"
  git checkout dev
fi

log "Git status before release:"
git status --short

log "1/5: add/commit"
git add .
git commit -m "$COMMIT_MSG"

log "2/5: push to origin/dev"
git push origin dev

log "3/5: wait for GitHub Actions completion"
# Requires gh CLI. If not installed, exit.
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required to wait for workflow. Please install and login." >&2
  exit 1
fi

log "Querying latest workflow run for dev"
WORKFLOW_NAME="publish-backend"
# fallback to any workflow run if no specific
RUN_ID=$(gh run list --branch dev --workflow "$WORKFLOW_NAME" --limit 1 --json databaseId --jq '.[0].databaseId')
if [[ -z "$RUN_ID" ]]; then
  log "No workflow run found for $WORKFLOW_NAME. Waiting on latest run for dev."
  RUN_ID=$(gh run list --branch dev --limit 1 --json databaseId --jq '.[0].databaseId')
fi

if [[ -z "$RUN_ID" ]]; then
  log "Failed to locate workflow run. You can un comment the gh command below to monitor manually."
  exit 1
fi

log "Waiting for workflow run #$RUN_ID to complete..."
gh run watch "$RUN_ID"

log "4/5: deploy to Raspberry Pi"
# here we do a pull+publish remotely, then restart service
ssh pi@fm.local bash -s <<'EOF'
set -euo pipefail
cd /home/pi
if [[ ! -d JkMonitorV2 ]]; then
  git clone https://github.com/BieleckiLtd/JkMonitorV2.git
fi
cd JkMonitorV2
git fetch --all
git checkout dev
git reset --hard origin/dev

# Do a local publish for ARM64 directly on pi
dotnet publish src/backend/JkMonitor.Backend/JkMonitor.Backend.csproj -c Release -r linux-arm64 --self-contained false -o /home/pi/jkmonitor/app

# copy front-end outputs
rsync -av --delete src/backend/JkMonitor.Backend/wwwroot/ /home/pi/jkmonitor/app/wwwroot/

sudo systemctl stop jkmonitor.service || true
sudo systemctl start jkmonitor.service
sleep 5
sudo systemctl status jkmonitor.service --no-pager
curl -f http://127.0.0.1:5074/api/health
curl -f http://127.0.0.1:5074/api/devices/config
EOF

log "5/5: publish done.\nPlease verify on browser http://fm.local:5074 and clear cache if needed."