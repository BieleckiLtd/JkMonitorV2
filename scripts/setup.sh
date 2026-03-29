#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_ROOT/.." && pwd)"
BACKEND_PATH="$REPO_ROOT/src/FluxMonitor.Backend"
LOCAL_DOTNET_ROOT="$REPO_ROOT/.dotnet"
LOCAL_DOTNET="$LOCAL_DOTNET_ROOT/dotnet"
INSTALL_SCRIPT="${TMPDIR:-/tmp}/dotnet-install-FluxMonitor.sh"
APP_URL='http://localhost:5074'
HEALTH_URL="$APP_URL/api/health"

section() {
  echo
  echo "$1"
}

get_dotnet() {
  if command -v dotnet >/dev/null 2>&1; then
    if dotnet --list-sdks 2>/dev/null | grep -q '^10\.'; then
      command -v dotnet
      return
    fi
  fi

  if [ -x "$LOCAL_DOTNET" ]; then
    echo "$LOCAL_DOTNET"
    return
  fi

  echo ""
}

read_choice() {
  local prompt="$1"
  local default_value="$2"
  local value
  read -r -p "$prompt [$default_value] " value
  if [ -z "$value" ]; then
    echo "$default_value"
  else
    case "${value,,}" in
      y|yes) echo 'y' ;;
      n|no) echo 'n' ;;
      *)
        echo ""
        ;;
    esac
  fi
}

read_validated_choice() {
  local prompt="$1"
  local default_value="$2"

  while true; do
    local chosen
    chosen="$(read_choice "$prompt" "$default_value")"
    if [ -n "$chosen" ]; then
      echo "$chosen"
      return
    fi

    echo 'Accepted values: y, n, yes, no'
  done
}

read_required_value() {
  local prompt="$1"
  local value=""

  while [ -z "$value" ]; do
    read -r -p "$prompt" value
    if [ -z "$value" ]; then
      echo 'A value is required to continue.'
    fi
  done

  echo "$value"
}

write_install_audit() {
  local target_path="$1"
  local install_kind="$2"
  local repository="$3"
  local branch="$4"
  local release_tag="$5"
  local asset_name="$6"
  local checksum="$7"
  local destination="$8"
  local installed_by="$9"
  local installed_at_utc="${10}"
  local machine_name="${11}"

  cat > "$target_path" <<EOF
{
  "installKind": "$install_kind",
  "repository": "$repository",
  "branch": "$branch",
  "releaseTag": "$release_tag",
  "assetName": "$asset_name",
  "checksum": "$checksum",
  "destination": "$destination",
  "installedBy": "$installed_by",
  "installedAtUtc": "$installed_at_utc",
  "machineName": "$machine_name"
}
EOF
}

install_local_dotnet() {
  section "Installing local .NET toolchain"
  mkdir -p "$LOCAL_DOTNET_ROOT"
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$INSTALL_SCRIPT"
  bash "$INSTALL_SCRIPT" --channel 10.0 --install-dir "$LOCAL_DOTNET_ROOT" --quality ga
}

open_browser_when_ready() {
  if ! command -v curl >/dev/null 2>&1; then
    return
  fi

  (
    for _ in $(seq 1 60); do
      if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
        if command -v xdg-open >/dev/null 2>&1; then
          xdg-open "$APP_URL" >/dev/null 2>&1 || true
        elif command -v open >/dev/null 2>&1; then
          open "$APP_URL" >/dev/null 2>&1 || true
        fi
        exit 0
      fi
      sleep 1
    done
  ) &
  BROWSER_PID=$!
}

section "Flux Monitor setup"
echo "This script prepares a local toolchain if needed, configures PostgreSQL storage, and launches the app without preloading any devices."

DOTNET_CMD="$(get_dotnet)"
if [ -z "$DOTNET_CMD" ]; then
  answer="$(read_validated_choice 'No compatible .NET 10 SDK was found. Install a local copy into this repository?' 'y')"
  if [ "${answer,,}" != "y" ]; then
    echo "A .NET 10 SDK is required to run this repository from source."
    exit 1
  fi
  install_local_dotnet
  DOTNET_CMD="$LOCAL_DOTNET"
fi

ENVIRONMENT='Development'
TARGET_CONFIG="$BACKEND_PATH/appsettings.Development.Local.json"
AUDIT_PATH="$REPO_ROOT/src/install-audit.json"
IS_FIRST_INSTALL='true'
if [ -f "$TARGET_CONFIG" ] || [ -f "$AUDIT_PATH" ]; then
  IS_FIRST_INSTALL='false'
fi
CONNECTION_STRING="$(read_required_value 'PostgreSQL connection string: ')"
cat > "$TARGET_CONFIG" <<EOF
{
  "Monitor": {
    "Storage": {
      "Provider": "TimescaleDb",
      "ConnectionString": "$CONNECTION_STRING"
    }
  }
}
EOF

if [ "$IS_FIRST_INSTALL" = 'true' ]; then
  write_install_audit \
    "$AUDIT_PATH" \
    'source' \
    "$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo '')" \
    "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')" \
    '' \
    '' \
    '' \
    "$REPO_ROOT" \
    "$(id -un 2>/dev/null || echo unknown)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(hostname 2>/dev/null || echo unknown)"
fi

section "Starting Flux Monitor"
echo "Environment: $ENVIRONMENT"
echo "Opening $APP_URL after the backend is ready."
echo "No devices are preconfigured. Add them from the app after it starts."

BROWSER_PID=''
open_browser_when_ready

cd "$REPO_ROOT"
trap 'if [ -n "${BROWSER_PID:-}" ]; then kill "$BROWSER_PID" >/dev/null 2>&1 || true; fi' EXIT
ASPNETCORE_ENVIRONMENT="$ENVIRONMENT" "$DOTNET_CMD" run --project ./src/FluxMonitor.Backend --launch-profile http
