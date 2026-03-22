#!/usr/bin/env bash
set -euo pipefail

COMMIT_MSG=${1:-}
REMOTE_NAME=${REMOTE_NAME:-origin}
BRANCH=${BRANCH:-dev}
RELEASE_TAG=${RELEASE_TAG:-dev-latest}
PI_HOST=${PI_HOST:-pi@jk.local}
REPOSITORY=${REPOSITORY:-}
WAIT_SECONDS=${WAIT_SECONDS:-120}
ARTIFACT_TIMEOUT_SECONDS=${ARTIFACT_TIMEOUT_SECONDS:-600}
POLL_SECONDS=${POLL_SECONDS:-15}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)

cd "$REPO_DIR"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

ensure_git_identity() {
  if [[ -z "$(git config user.name || true)" ]] || [[ -z "$(git config user.email || true)" ]]; then
    echo "git user.name and user.email must be configured before publish." >&2
    exit 1
  fi
}

normalize_repository() {
  local candidate="$1"

  if [[ -z "$candidate" ]]; then
    candidate="$(git remote get-url "$REMOTE_NAME")"
  fi

  case "$candidate" in
    https://github.com/*)
      candidate="${candidate#https://github.com/}"
      candidate="${candidate%.git}"
      candidate="${candidate%/}"
      ;;
    git@github.com:*)
      candidate="${candidate#git@github.com:}"
      candidate="${candidate%.git}"
      ;;
    ssh://git@github.com/*)
      candidate="${candidate#ssh://git@github.com/}"
      candidate="${candidate%.git}"
      candidate="${candidate%/}"
      ;;
  esac

  if [[ "$candidate" =~ ^[^/]+/[^/]+$ ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  echo "Unsupported repository value '$candidate'. Use 'owner/repo' or a GitHub URL." >&2
  exit 1
}

default_commit_message() {
  local staged
  staged="$(git diff --cached --name-only)"

  if [[ -z "$staged" ]]; then
    printf '%s\n' 'chore: publish current changes'
    return
  fi

  if printf '%s\n' "$staged" | grep -Ev '^(AGENTS\.md|README\.md|skills/.*|scripts/.*)$' >/dev/null 2>&1; then
    if printf '%s\n' "$staged" | grep -Ev '^src/backend/JkMonitor\.Backend/frontend/' >/dev/null 2>&1; then
      if printf '%s\n' "$staged" | grep -Ev '^tests/' >/dev/null 2>&1; then
        printf '%s\n' 'chore: publish current changes'
      else
        printf '%s\n' 'test: update backend tests'
      fi
    else
      printf '%s\n' 'feat: update frontend'
    fi
  else
    printf '%s\n' 'chore: refine publish automation'
  fi
}

fetch_release_json() {
  local repository_slug="$1"
  local tag="$2"
  local url="https://api.github.com/repos/$repository_slug/releases/tags/$tag"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: JkMonitorV2-publish-script' "$url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO- --header='Accept: application/vnd.github+json' --header='User-Agent: JkMonitorV2-publish-script' "$url"
    return
  fi

  echo 'curl or wget is required to query the GitHub release API.' >&2
  exit 1
}

release_asset_ready() {
  local json="$1"
  local asset_name="$2"
  local updated_after="$3"

  if command -v python3 >/dev/null 2>&1; then
    JSON_PAYLOAD="$json" python3 - "$asset_name" "$updated_after" <<'PY'
import datetime
import json
import os
import sys

payload = os.environ.get('JSON_PAYLOAD', '')
if not payload:
    sys.exit(1)

data = json.loads(payload)
asset_name = sys.argv[1]
updated_after = datetime.datetime.fromisoformat(sys.argv[2].replace('Z', '+00:00'))

for asset in data.get('assets', []):
    if asset.get('name') != asset_name:
        continue

    updated_at = asset.get('updated_at')
    if not updated_at:
        continue

    updated_at_value = datetime.datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
    if updated_at_value >= updated_after:
        sys.exit(0)

sys.exit(1)
PY
    return $?
  fi

  printf '%s\n' "$json" | grep -q 'jkmonitor-backend-linux-arm64.tar.gz'
}

assert_release_asset_exists() {
  local repository_slug="$1"
  local tag="$2"
  local json

  json="$(fetch_release_json "$repository_slug" "$tag")"

  if ! printf '%s\n' "$json" | grep -q 'jkmonitor-backend-linux-arm64.tar.gz'; then
    echo "Release tag '$tag' does not contain asset 'jkmonitor-backend-linux-arm64.tar.gz'." >&2
    exit 1
  fi
}

wait_for_release_asset() {
  local repository_slug="$1"
  local tag="$2"
  local updated_after="$3"
  local started_at
  local json

  started_at=$(date +%s)

  while true; do
    if json="$(fetch_release_json "$repository_slug" "$tag" 2>/dev/null)"; then
      if release_asset_ready "$json" 'jkmonitor-backend-linux-arm64.tar.gz' "$updated_after"; then
        return
      fi
    fi

    if (( $(date +%s) - started_at >= ARTIFACT_TIMEOUT_SECONDS )); then
      echo "Timed out waiting for GitHub release asset on tag '$tag'." >&2
      exit 1
    fi

    sleep "$POLL_SECONDS"
  done
}

require_cmd git

REPOSITORY_SLUG="$(normalize_repository "$REPOSITORY")"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  echo "Publish expects branch '$BRANCH'. Current branch is '$CURRENT_BRANCH'." >&2
  exit 1
fi

PUSHED_CHANGES=0
PUSH_STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

log 'Checking repository state'
if [[ -z "$(git status --porcelain=v1)" ]]; then
  log 'Working tree is clean. Skipping commit and push.'
else
  log 'Local changes detected. Staging files.'
  git add --all

  if git diff --cached --quiet; then
    log 'Nothing remained staged after git add.'
  else
    ensure_git_identity

    if [[ -z "$COMMIT_MSG" ]]; then
      COMMIT_MSG="$(default_commit_message)"
      log "Generated commit message: $COMMIT_MSG"
    fi

    log 'Creating commit'
    git commit -m "$COMMIT_MSG"

    log "Pushing to $REMOTE_NAME/$BRANCH"
    PUSH_STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    git push "$REMOTE_NAME" "$BRANCH"
    PUSHED_CHANGES=1
  fi
fi

if (( PUSHED_CHANGES == 1 )); then
  log "Waiting $WAIT_SECONDS seconds before artifact check"
  sleep "$WAIT_SECONDS"
  log 'Waiting for updated GitHub release artifact'
  wait_for_release_asset "$REPOSITORY_SLUG" "$RELEASE_TAG" "$PUSH_STARTED_AT"
else
  log 'Checking current GitHub release artifact'
  assert_release_asset_exists "$REPOSITORY_SLUG" "$RELEASE_TAG"
fi

require_cmd ssh

log "Deploying to $PI_HOST"
ssh -o StrictHostKeyChecking=no "$PI_HOST" bash -s <<EOF
set -euo pipefail
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 "$RELEASE_TAG"
sleep 5
sudo systemctl is-active jkmonitor.service
curl -fsS http://127.0.0.1:5074/api/health
EOF

log 'Publish workflow completed'