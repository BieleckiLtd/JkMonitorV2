#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/BieleckiLtd/JkMonitorV2}"
RELEASE_TAG="${2:-dev-latest}"
DESTINATION="${3:-$HOME/jkmonitor}"
APP_ROOT="$DESTINATION/app"
LOCAL_DOTNET_ROOT="$DESTINATION/.dotnet"
LOCAL_DOTNET="$LOCAL_DOTNET_ROOT/dotnet"
APP_URL='http://localhost:5074'
HEALTH_URL="$APP_URL/api/health"
ASSET_NAME='jkmonitor-backend-linux-arm64.tar.gz'
INSTALL_SCRIPT="${TMPDIR:-/tmp}/dotnet-install-jkmonitor-runtime.sh"
SERVICE_NAME='jkmonitor.service'
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
ENV_PATH="$DESTINATION/jkmonitor.env"

section() {
  echo
  echo "$1"
}

run_elevated() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

normalize_repository() {
  local input="$1"

  if [[ "$input" =~ ^https://github\.com/([^/]+/[^/]+)/?$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  if [[ "$input" =~ ^[^/]+/[^/]+$ ]]; then
    echo "$input"
    return
  fi

  echo "Unsupported repository value '$input'. Use 'owner/repo' or a GitHub URL." >&2
  exit 1
}

download_file() {
  local url="$1"
  local target="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$url" "$target" <<'PY'
import sys
import urllib.request

url, target = sys.argv[1], sys.argv[2]
urllib.request.urlretrieve(url, target)
PY
    return
  fi

  echo 'No supported download tool was found. Install curl, wget, or python3.' >&2
  exit 1
}

copy_if_exists() {
  local source_path="$1"
  local target_path="$2"

  if [ ! -e "$source_path" ]; then
    return
  fi

  mkdir -p "$(dirname "$target_path")"
  cp -R "$source_path" "$target_path"
}

preserve_existing_state() {
  local source_root="$1"
  local preserve_root="$2"

  copy_if_exists "$source_root/.dotnet" "$preserve_root/.dotnet"

  for file_name in \
    appsettings.Local.json \
    appsettings.Development.Local.json \
    appsettings.Production.Local.json
  do
    copy_if_exists "$source_root/app/$file_name" "$preserve_root/app/$file_name"
  done
}

restore_preserved_state() {
  local preserve_root="$1"
  local destination_root="$2"

  if [ ! -d "$preserve_root" ]; then
    return
  fi

  if [ -d "$preserve_root/.dotnet" ]; then
    rm -rf "$destination_root/.dotnet"
    cp -R "$preserve_root/.dotnet" "$destination_root/.dotnet"
  fi

  for file_name in \
    appsettings.Local.json \
    appsettings.Development.Local.json \
    appsettings.Production.Local.json
  do
    if [ -f "$preserve_root/app/$file_name" ]; then
      mkdir -p "$destination_root/app"
      cp "$preserve_root/app/$file_name" "$destination_root/app/$file_name"
    fi
  done
}

get_dotnet() {
  if command -v dotnet >/dev/null 2>&1; then
    if dotnet --list-runtimes 2>/dev/null | grep -q '^Microsoft.AspNetCore.App 10\.'; then
      command -v dotnet
      return
    fi
  fi

  if [ -x "$LOCAL_DOTNET" ]; then
    if "$LOCAL_DOTNET" --list-runtimes 2>/dev/null | grep -q '^Microsoft.AspNetCore.App 10\.'; then
      echo "$LOCAL_DOTNET"
      return
    fi
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
        *) echo "" ;;
      esac
    elif [ "$mode" = 'yesno' ]; then
      case "$normalized" in
        y|yes) echo 'y' ;;
        n|no) echo 'n' ;;
        *) echo "" ;;
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

install_local_runtime() {
  section 'Installing local ASP.NET Core runtime'
  mkdir -p "$LOCAL_DOTNET_ROOT"
  download_file 'https://dot.net/v1/dotnet-install.sh' "$INSTALL_SCRIPT"
  bash "$INSTALL_SCRIPT" --channel 10.0 --runtime aspnetcore --install-dir "$LOCAL_DOTNET_ROOT"
}

write_start_script() {
  cat > "$DESTINATION/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_ROOT/app"
LOCAL_DOTNET="$SCRIPT_ROOT/.dotnet/dotnet"

if command -v dotnet >/dev/null 2>&1 && dotnet --list-runtimes 2>/dev/null | grep -q '^Microsoft.AspNetCore.App 10\.'; then
  DOTNET_CMD="$(command -v dotnet)"
elif [ -x "$LOCAL_DOTNET" ]; then
  DOTNET_CMD="$LOCAL_DOTNET"
else
  echo 'No compatible ASP.NET Core 10 runtime was found.' >&2
  exit 1
fi

export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://localhost:5074}"

cd "$APP_ROOT"
exec "$DOTNET_CMD" ./JkMonitor.Backend.dll
EOF

  chmod +x "$DESTINATION/start.sh"
}

write_env_file() {
  local environment_name="$1"

  cat > "$ENV_PATH" <<EOF
ASPNETCORE_ENVIRONMENT=$environment_name
ASPNETCORE_URLS=$APP_URL
EOF
}

install_systemd_service() {
  local current_user
  current_user="$(id -un)"

  run_elevated tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=JK Monitor Backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$current_user
WorkingDirectory=$APP_ROOT
EnvironmentFile=$ENV_PATH
ExecStart=$DESTINATION/start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  run_elevated systemctl daemon-reload
  run_elevated systemctl enable "$SERVICE_NAME"
  run_elevated systemctl restart "$SERVICE_NAME"
}

wait_for_health() {
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi

  for _ in $(seq 1 60); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
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

NORMALIZED_REPOSITORY="$(normalize_repository "$REPOSITORY")"
ASSET_URL="https://github.com/$NORMALIZED_REPOSITORY/releases/download/$RELEASE_TAG/$ASSET_NAME"
TEMP_ROOT="${TMPDIR:-/tmp}/jkmonitor-release-install-$(date +%s)-$$"
ARCHIVE_PATH="$TEMP_ROOT/$ASSET_NAME"
EXTRACT_PATH="$TEMP_ROOT/extract"
PRESERVE_PATH="$TEMP_ROOT/preserve"

mkdir -p "$TEMP_ROOT" "$EXTRACT_PATH" "$PRESERVE_PATH"

cleanup() {
  rm -rf "$TEMP_ROOT"
}

trap cleanup EXIT

section 'JK Monitor release bootstrap'
echo "Repository: $NORMALIZED_REPOSITORY"
echo "Release tag: $RELEASE_TAG"
echo "Destination: $DESTINATION"

section 'Downloading release artifact'
download_file "$ASSET_URL" "$ARCHIVE_PATH"

section 'Extracting release artifact'
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_PATH"

section 'Preparing installation folder'
if [ -d "$DESTINATION" ]; then
  echo 'Existing installation found. Preserving local config and cached runtime.'
  preserve_existing_state "$DESTINATION" "$PRESERVE_PATH"
  rm -rf "$DESTINATION"
fi

mkdir -p "$DESTINATION"
mv "$EXTRACT_PATH/linux-arm64" "$APP_ROOT"
restore_preserved_state "$PRESERVE_PATH" "$DESTINATION"
write_start_script

section 'Checking ASP.NET Core runtime'
DOTNET_CMD="$(get_dotnet)"
if [ -z "$DOTNET_CMD" ]; then
  answer="$(read_validated_choice 'No compatible ASP.NET Core 10 runtime was found. Install a local copy into this folder?' 'yesno' 'y')"
  if [ "${answer,,}" != 'y' ]; then
    echo 'An ASP.NET Core 10 runtime is required to run this published build.'
    exit 1
  fi

  install_local_runtime
  DOTNET_CMD="$LOCAL_DOTNET"
fi

section 'Configuring startup mode'
MODE="$(read_validated_choice 'Choose startup mode: 1 = simulator, 2 = hardware' 'startup' '1')"
ENVIRONMENT='Development'
TARGET_CONFIG="$APP_ROOT/appsettings.Development.Local.json"

if [ "$MODE" = '1' ]; then
  USE_DB="$(read_validated_choice 'Enable PostgreSQL and TimescaleDB persistence now?' 'yesno' 'n')"
  if [ "${USE_DB,,}" = 'y' ]; then
    read -r -p 'PostgreSQL connection string: ' CONNECTION_STRING
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
    cat > "$TARGET_CONFIG" <<'EOF'
{
  "Monitor": {
    "Storage": {
      "Provider": "None",
      "ConnectionString": ""
    }
  }
}
EOF
  fi
else
  ENVIRONMENT='Production'
  TARGET_CONFIG="$APP_ROOT/appsettings.Production.Local.json"
  read -r -p 'RS485 serial port (example: /dev/ttyUSB0): ' SERIAL_PORT
  if [ -z "$SERIAL_PORT" ]; then
    echo 'A serial port is required for hardware mode.'
    exit 1
  fi

  USE_DB="$(read_validated_choice 'Enable PostgreSQL and TimescaleDB persistence?' 'yesno' 'y')"
  CONNECTION_STRING=''
  if [ "${USE_DB,,}" = 'y' ]; then
    read -r -p 'PostgreSQL connection string: ' CONNECTION_STRING
  fi

  cat > "$TARGET_CONFIG" <<EOF
{
  "Monitor": {
    "SerialBus": {
      "PortName": "$SERIAL_PORT"
    },
    "Storage": {
      "Provider": "$( [ "${USE_DB,,}" = 'y' ] && echo 'TimescaleDb' || echo 'None' )",
      "ConnectionString": "$CONNECTION_STRING"
    },
    "Devices": [
      {
        "DeviceId": "jk-master-01",
        "DisplayName": "Main Battery Rack",
        "Protocol": "jk-rs485",
        "RegisterProfile": "jk-inverter-v15",
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

write_env_file "$ENVIRONMENT"

INSTALL_SERVICE='n'
if command -v systemctl >/dev/null 2>&1; then
  INSTALL_SERVICE="$(read_validated_choice 'Install and start a systemd service for headless operation?' 'yesno' 'y')"
fi

section 'Starting JK Monitor'
echo "Environment: $ENVIRONMENT"
echo "Installed app root: $APP_ROOT"
echo "Reusable launch command: $DESTINATION/start.sh"
echo "Service file path: $SERVICE_PATH"

if [ "${INSTALL_SERVICE,,}" = 'y' ]; then
  section 'Installing systemd service'
  install_systemd_service

  if wait_for_health; then
    echo "JK Monitor is running under systemd at $APP_URL"
  else
    echo 'The systemd service was installed, but the health endpoint did not become ready in time.' >&2
    echo "Inspect service logs with: sudo journalctl -u $SERVICE_NAME -n 200 --no-pager" >&2
    exit 1
  fi

  exit 0
fi

echo "Opening $APP_URL after the backend is ready."

BROWSER_PID=''
open_browser_when_ready

cd "$APP_ROOT"
trap 'if [ -n "${BROWSER_PID:-}" ]; then kill "$BROWSER_PID" >/dev/null 2>&1 || true; fi' EXIT
ASPNETCORE_ENVIRONMENT="$ENVIRONMENT" ASPNETCORE_URLS="$APP_URL" "$DOTNET_CMD" ./JkMonitor.Backend.dll