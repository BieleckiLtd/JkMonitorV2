#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_ROOT/.." && pwd)"
BACKEND_PATH="$REPO_ROOT/src/backend/FluxMonitor.Backend"
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
  local mode="$2"
  local default_value="$3"
  local value
  read -r -p "$prompt [$default_value] " value
  if [ -z "$value" ]; then
    echo "$default_value"
  else
    local normalized="${value,,}"
    if [ "$mode" = 'startup' ]; then
      case "$normalized" in
        1|sim|simulator) echo '1' ;;
        2|hw|hardware) echo '2' ;;
        *)
          echo ""
          ;;
      esac
    elif [ "$mode" = 'yesno' ]; then
      case "$normalized" in
        y|yes) echo 'y' ;;
        n|no) echo 'n' ;;
        *)
          echo ""
          ;;
      esac
    else
      echo "$value"
    fi
  fi
}

read_validated_choice() {
  local prompt="$1"
  local type="$2"
  local default_value="$3"

  while true; do
    local chosen
    chosen="$(read_choice "$prompt" "$type" "$default_value")"
    if [ -n "$chosen" ]; then
      echo "$chosen"
      return
    fi

    if [ "$type" = 'startup' ]; then
      echo 'Accepted values: 1, 2, simulator, hardware'
    else
      echo 'Accepted values: y, n, yes, no'
    fi
  done
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
echo "This script prepares a local toolchain if needed, requires PostgreSQL configuration, guides the startup mode, and launches the app."

DOTNET_CMD="$(get_dotnet)"
if [ -z "$DOTNET_CMD" ]; then
  answer="$(read_validated_choice 'No compatible .NET 10 SDK was found. Install a local copy into this repository?' 'yesno' 'y')"
  if [ "${answer,,}" != "y" ]; then
    echo "A .NET 10 SDK is required to run this repository from source."
    exit 1
  fi
  install_local_dotnet
  DOTNET_CMD="$LOCAL_DOTNET"
fi

MODE="$(read_validated_choice 'Choose startup mode: 1 = simulator, 2 = hardware' 'startup' '1')"
ENVIRONMENT='Development'
TARGET_CONFIG="$BACKEND_PATH/appsettings.Development.Local.json"

if [ "$MODE" = '1' ]; then
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
else
  ENVIRONMENT='Production'
  TARGET_CONFIG="$BACKEND_PATH/appsettings.Production.Local.json"
  read -r -p 'RS485 serial port (example: /dev/ttyUSB0): ' SERIAL_PORT
  if [ -z "$SERIAL_PORT" ]; then
    echo 'A serial port is required for hardware mode.'
    exit 1
  fi

  CONNECTION_STRING="$(read_required_value 'PostgreSQL connection string: ')"

  cat > "$TARGET_CONFIG" <<EOF
{
  "Monitor": {
    "SerialBus": {
      "PortName": "$SERIAL_PORT"
    },
    "Storage": {
      "Provider": "TimescaleDb",
      "ConnectionString": "$CONNECTION_STRING"
    },
    "Devices": [
      {
        "DeviceId": "jk-master-01",
        "DisplayName": "Main Battery Rack",
        "DefinitionId": "jk-inverter-bms",
        "TransportPortName": "$SERIAL_PORT",
        "Address": 1,
        "IsMaster": true,
        "PollIntervalMilliseconds": 1000,
        "Enabled": true
      }
    ]
  }
}
EOF
fi

section "Starting Flux Monitor"
echo "Environment: $ENVIRONMENT"
echo "Opening $APP_URL after the backend is ready."

BROWSER_PID=''
open_browser_when_ready

cd "$REPO_ROOT"
trap 'if [ -n "${BROWSER_PID:-}" ]; then kill "$BROWSER_PID" >/dev/null 2>&1 || true; fi' EXIT
ASPNETCORE_ENVIRONMENT="$ENVIRONMENT" "$DOTNET_CMD" run --project ./src/backend/FluxMonitor.Backend --launch-profile http
