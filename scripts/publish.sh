#!/usr/bin/env bash
set -euo pipefail

COMMIT_MSG=${1:-}
REMOTE_NAME=${REMOTE_NAME:-origin}
BRANCH=${BRANCH:-dev}
RELEASE_TAG=${RELEASE_TAG:-dev-latest}
PI_HOST=${PI_HOST:-pi@fm.local}
REPOSITORY=${REPOSITORY:-}
WAIT_SECONDS=${WAIT_SECONDS:-0}
ARTIFACT_TIMEOUT_SECONDS=${ARTIFACT_TIMEOUT_SECONDS:-600}
POLL_SECONDS=${POLL_SECONDS:-30}
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
LINUX_ASSET_NAME='fluxmonitor-backend-linux-arm64.tar.gz'
GITHUB_TOKEN_VALUE="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

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
    if printf '%s\n' "$staged" | grep -Ev '^(src/FluxMonitor\.UI/|src/FluxMonitor\.Backend/wwwroot/)' >/dev/null 2>&1; then
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
    if [[ -n "$GITHUB_TOKEN_VALUE" ]]; then
      curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: FluxMonitor-publish-script' -H "Authorization: Bearer $GITHUB_TOKEN_VALUE" "$url"
    else
      curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: FluxMonitor-publish-script' "$url"
    fi
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    if [[ -n "$GITHUB_TOKEN_VALUE" ]]; then
      wget -qO- --header='Accept: application/vnd.github+json' --header='User-Agent: FluxMonitor-publish-script' --header="Authorization: Bearer $GITHUB_TOKEN_VALUE" "$url"
    else
      wget -qO- --header='Accept: application/vnd.github+json' --header='User-Agent: FluxMonitor-publish-script' "$url"
    fi
    return
  fi

  echo 'curl or wget is required to query the GitHub release API.' >&2
  exit 1
}

parse_sha256_payload() {
  local payload="$1"
  local checksum

  checksum="$(printf '%s\n' "$payload" | awk 'NR == 1 { print $1 }')"

  if [[ ! "$checksum" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    return 1
  fi

  printf '%s\n' "${checksum,,}"
}

fetch_release_checksum() {
  local repository_slug="$1"
  local tag="$2"
  local asset_name="$3"
  local release_json
  local checksum_asset_url
  local payload

  if ! command -v python3 >/dev/null 2>&1; then
    echo 'python3 is required to parse the GitHub release metadata.' >&2
    exit 1
  fi

  release_json="$(fetch_release_json "$repository_slug" "$tag")"
  checksum_asset_url="$(RELEASE_JSON="$release_json" python3 - "$asset_name.sha256" <<'PY'
import json
import os
import sys

asset_name = sys.argv[1]
payload = json.loads(os.environ["RELEASE_JSON"])

for asset in payload.get("assets", []):
    if asset.get("name") == asset_name and asset.get("url"):
        print(asset["url"])
        raise SystemExit(0)

raise SystemExit(1)
PY
)"

  if command -v curl >/dev/null 2>&1; then
    if [[ -n "$GITHUB_TOKEN_VALUE" ]]; then
      payload="$(curl -fsSL -H 'Accept: application/octet-stream' -H 'User-Agent: FluxMonitor-publish-script' -H "Authorization: Bearer $GITHUB_TOKEN_VALUE" "$checksum_asset_url")"
    else
      payload="$(curl -fsSL -H 'Accept: application/octet-stream' -H 'User-Agent: FluxMonitor-publish-script' "$checksum_asset_url")"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [[ -n "$GITHUB_TOKEN_VALUE" ]]; then
      payload="$(wget -qO- --header='Accept: application/octet-stream' --header='User-Agent: FluxMonitor-publish-script' --header="Authorization: Bearer $GITHUB_TOKEN_VALUE" "$checksum_asset_url")"
    else
      payload="$(wget -qO- --header='Accept: application/octet-stream' --header='User-Agent: FluxMonitor-publish-script' "$checksum_asset_url")"
    fi
  else
    echo 'curl or wget is required to download the published checksum file.' >&2
    exit 1
  fi

  parse_sha256_payload "$payload"
}

release_asset_fingerprint() {
  local json="$1"
  local asset_name="$2"

  if ! command -v python3 >/dev/null 2>&1; then
    echo 'python3 is required to parse the GitHub release metadata.' >&2
    exit 1
  fi

  JSON_PAYLOAD="$json" python3 - "$asset_name" <<'PY'
import json
import os
import sys

payload = os.environ.get("JSON_PAYLOAD", "")
if not payload:
    raise SystemExit(1)

asset_name = sys.argv[1]
data = json.loads(payload)

for asset in data.get("assets", []):
    if asset.get("name") != asset_name:
        continue

    digest = asset.get("digest") or ""
    updated_at = asset.get("updated_at") or ""
    print(f"{asset.get('id')}|{digest}|{updated_at}")
    raise SystemExit(0)

raise SystemExit(1)
PY
}

try_get_release_asset_fingerprint() {
  local repository_slug="$1"
  local tag="$2"
  local asset_name="$3"
  local json

  if ! json="$(fetch_release_json "$repository_slug" "$tag" 2>/dev/null)"; then
    return 1
  fi

  release_asset_fingerprint "$json" "$asset_name" 2>/dev/null
}

release_asset_ready() {
  local json="$1"
  local asset_name="$2"
  local previous_fingerprint="$3"

  if command -v python3 >/dev/null 2>&1; then
    JSON_PAYLOAD="$json" python3 - "$asset_name" "$previous_fingerprint" <<'PY'
import json
import os
import sys

payload = os.environ.get('JSON_PAYLOAD', '')
if not payload:
    sys.exit(1)

data = json.loads(payload)
asset_name = sys.argv[1]
previous_fingerprint = sys.argv[2]

for asset in data.get('assets', []):
    if asset.get('name') != asset_name:
        continue

    digest = asset.get('digest') or ''
    updated_at = asset.get('updated_at') or ''
    current_fingerprint = f"{asset.get('id')}|{digest}|{updated_at}"
    if not previous_fingerprint or current_fingerprint != previous_fingerprint:
        sys.exit(0)

sys.exit(1)
PY
    return $?
  fi

  printf '%s\n' "$json" | grep -q 'fluxmonitor-backend-linux-arm64.tar.gz'
}

assert_release_asset_exists() {
  local repository_slug="$1"
  local tag="$2"
  local json

  json="$(fetch_release_json "$repository_slug" "$tag")"

  if ! printf '%s\n' "$json" | grep -q 'fluxmonitor-backend-linux-arm64.tar.gz'; then
    echo "Release tag '$tag' does not contain asset 'fluxmonitor-backend-linux-arm64.tar.gz'." >&2
    exit 1
  fi
}

wait_for_release_checksum() {
  local repository_slug="$1"
  local tag="$2"
  local asset_name="$3"
  local started_at
  local checksum

  started_at=$(date +%s)

  while true; do
    if checksum="$(fetch_release_checksum "$repository_slug" "$tag" "$asset_name" 2>/dev/null)"; then
      printf '%s\n' "$checksum"
      return
    fi

    if (( $(date +%s) - started_at >= ARTIFACT_TIMEOUT_SECONDS )); then
      echo "Timed out waiting for release checksum '$asset_name.sha256' on tag '$tag'." >&2
      exit 1
    fi

    sleep "$POLL_SECONDS"
  done
}

wait_for_release_asset() {
  local repository_slug="$1"
  local tag="$2"
  local previous_fingerprint="$3"
  local started_at
  local json

  started_at=$(date +%s)

  while true; do
    if json="$(fetch_release_json "$repository_slug" "$tag" 2>/dev/null)"; then
      if release_asset_ready "$json" 'fluxmonitor-backend-linux-arm64.tar.gz' "$previous_fingerprint"; then
        log "Release asset '$LINUX_ASSET_NAME' is ready."
        return
      fi

      if fingerprint="$(release_asset_fingerprint "$json" "$LINUX_ASSET_NAME" 2>/dev/null)"; then
        log "Release asset '$LINUX_ASSET_NAME' is unchanged ($fingerprint). Retrying in $POLL_SECONDS seconds."
      else
        log "Release asset '$LINUX_ASSET_NAME' is not ready yet. Retrying in $POLL_SECONDS seconds."
      fi
    else
      log "GitHub release metadata is not ready yet. Retrying in $POLL_SECONDS seconds."
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
CURRENT_COMMIT="$(git rev-parse HEAD)"
EXPECTED_RELEASE_SHA256=''
PREVIOUS_RELEASE_ASSET_FINGERPRINT="$(try_get_release_asset_fingerprint "$REPOSITORY_SLUG" "$RELEASE_TAG" "$LINUX_ASSET_NAME" || true)"

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
    CURRENT_COMMIT="$(git rev-parse HEAD)"

    log "Pushing to $REMOTE_NAME/$BRANCH"
    PUSH_STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
    git push "$REMOTE_NAME" "$BRANCH"
    PUSHED_CHANGES=1
  fi
fi

if (( PUSHED_CHANGES == 1 )); then
  if (( WAIT_SECONDS > 0 )); then
    log "Waiting $WAIT_SECONDS seconds before artifact polling"
    sleep "$WAIT_SECONDS"
  fi

  log "Waiting for updated GitHub release artifact (polling every $POLL_SECONDS seconds)"
  wait_for_release_asset "$REPOSITORY_SLUG" "$RELEASE_TAG" "$PREVIOUS_RELEASE_ASSET_FINGERPRINT"
else
  log 'Checking current GitHub release artifact'
  assert_release_asset_exists "$REPOSITORY_SLUG" "$RELEASE_TAG"
fi

log 'Resolving published release checksum'
EXPECTED_RELEASE_SHA256="$(wait_for_release_checksum "$REPOSITORY_SLUG" "$RELEASE_TAG" "$LINUX_ASSET_NAME")"
log "Expected Linux release checksum: $EXPECTED_RELEASE_SHA256"

require_cmd ssh

log "Deploying to $PI_HOST"
ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=no "$PI_HOST" bash -s <<EOF
set -euo pipefail
expected_sha256='$EXPECTED_RELEASE_SHA256'
repository_slug='$REPOSITORY_SLUG'
release_tag='$RELEASE_TAG'
asset_name='$LINUX_ASSET_NAME'
expected_source_revision_id='$CURRENT_COMMIT'
export FLUXMONITOR_EXPECTED_RELEASE_SHA256="\$expected_sha256"
export FLUXMONITOR_INSTALL_RUNTIME='y'
export FLUXMONITOR_INSTALL_SERVICE='y'
export FLUXMONITOR_REUSE_EXISTING_CONFIGURATION='1'
wget -qO- https://raw.githubusercontent.com/$REPOSITORY_SLUG/dev/scripts/install-from-release.sh | bash -s -- https://github.com/$REPOSITORY_SLUG "\$release_tag"
if [ ! -f "\$HOME/fluxmonitor/release-info.env" ]; then
  echo 'The installer did not persist release-info.env.' >&2
  exit 1
fi

set -a
. "\$HOME/fluxmonitor/release-info.env"
set +a

if [[ "\${FLUXMONITOR_RELEASE_SHA256,,}" != "\$expected_sha256" ]]; then
  echo "Installed checksum mismatch on device. Expected \$expected_sha256 but installer recorded \${FLUXMONITOR_RELEASE_SHA256:-missing}." >&2
  exit 1
fi
sleep 5
sudo systemctl is-active fluxmonitor.service
health_json="\$(curl -fsS http://127.0.0.1:5074/api/health)"

if command -v python3 >/dev/null 2>&1; then
  HEALTH_JSON="\$health_json" python3 - "\$release_tag" "\$expected_source_revision_id" <<'PY'
import json
import os
import sys

payload = json.loads(os.environ["HEALTH_JSON"])
build = payload.get("build") or {}
release_tag = build.get("releaseTag")
source_revision_id = build.get("sourceRevisionId")
expected_tag = sys.argv[1]
expected_source_revision_id = sys.argv[2]

if release_tag != expected_tag:
    raise SystemExit(
        f"Runtime release tag mismatch. Expected {expected_tag} but app reported {release_tag!r}."
    )

if source_revision_id != expected_source_revision_id:
    raise SystemExit(
        f"Runtime source revision mismatch. Expected {expected_source_revision_id} but app reported {source_revision_id!r}."
    )
PY
else
  printf '%s\n' "\$health_json" | grep -F "\"releaseTag\":\"\$release_tag\"" >/dev/null 2>&1 || {
    echo "Runtime release tag mismatch. Expected \$release_tag." >&2
    exit 1
  }

  printf '%s\n' "\$health_json" | grep -F "\"sourceRevisionId\":\"\$expected_source_revision_id\"" >/dev/null 2>&1 || {
    echo "Runtime source revision mismatch. Expected \$expected_source_revision_id." >&2
    exit 1
  }
fi
EOF

log 'Publish workflow completed'
