#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/BieleckiLtd/JkMonitorV2}"
RELEASE_TAG="${2:-dev-latest}"
DESTINATION="${3:-$HOME/fluxmonitor}"
APP_ROOT="$DESTINATION/app"
LOCAL_DOTNET_ROOT="$DESTINATION/.dotnet"
LOCAL_DOTNET="$LOCAL_DOTNET_ROOT/dotnet"
APP_PORT='5074'
APP_BIND_URL="http://0.0.0.0:$APP_PORT"
APP_LOCAL_URL="http://127.0.0.1:$APP_PORT"
HEALTH_URL="$APP_LOCAL_URL/api/health"
ASSET_NAME='fluxmonitor-backend-linux-arm64.tar.gz'
CHECKSUM_ASSET_NAME="$ASSET_NAME.sha256"
INSTALL_SCRIPT="${TMPDIR:-/tmp}/dotnet-install-fluxmonitor-runtime.sh"
SERVICE_NAME='fluxmonitor.service'
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
ENV_PATH="$DESTINATION/fluxmonitor.env"
RELEASE_INFO_PATH="$DESTINATION/release-info.env"
NONINTERACTIVE_MODE="${FLUXMONITOR_MODE:-}"
NONINTERACTIVE_USE_DB="${FLUXMONITOR_USE_DB:-}"
NONINTERACTIVE_CONNECTION_STRING="${FLUXMONITOR_CONNECTION_STRING:-}"
NONINTERACTIVE_SERIAL_PORT="${FLUXMONITOR_SERIAL_PORT:-}"
NONINTERACTIVE_INSTALL_RUNTIME="${FLUXMONITOR_INSTALL_RUNTIME:-}"
NONINTERACTIVE_INSTALL_SERVICE="${FLUXMONITOR_INSTALL_SERVICE:-}"
NONINTERACTIVE_REUSE_EXISTING_CONFIGURATION="${FLUXMONITOR_REUSE_EXISTING_CONFIGURATION:-}"
EXPECTED_RELEASE_SHA256="${FLUXMONITOR_EXPECTED_RELEASE_SHA256:-}"
GITHUB_TOKEN_VALUE="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
CONFIGURE_SCRIPT_PATH="$DESTINATION/configure.sh"

if [ -t 1 ]; then
  COLOR_RESET='\033[0m'
  COLOR_SECTION='\033[1;38;5;208m'
  COLOR_INFO='\033[38;5;111m'
  COLOR_SUCCESS='\033[1;38;5;78m'
  COLOR_WARNING='\033[1;38;5;214m'
  COLOR_MUTED='\033[38;5;247m'
else
  COLOR_RESET=''
  COLOR_SECTION=''
  COLOR_INFO=''
  COLOR_SUCCESS=''
  COLOR_WARNING=''
  COLOR_MUTED=''
fi

paint() {
  printf '%b%s%b\n' "$1" "$2" "$COLOR_RESET"
}

section() {
  echo
  paint "$COLOR_SECTION" "$1"
}

info() {
  paint "$COLOR_INFO" "$1"
}

success() {
  paint "$COLOR_SUCCESS" "$1"
}

warn() {
  paint "$COLOR_WARNING" "$1"
}

muted() {
  paint "$COLOR_MUTED" "$1"
}

run_elevated() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_postgres() {
  local command="$1"

  if [ "$(id -u)" -eq 0 ]; then
    su postgres -c "$command"
  else
    sudo -u postgres bash -lc "$command"
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

is_truthy() {
  local value="${1:-}"

  case "${value,,}" in
    1|y|yes|true|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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

parse_sha256_file() {
  local checksum_file="$1"
  local checksum

  checksum="$(awk 'NR == 1 { print $1 }' "$checksum_file")"
  if [[ ! "$checksum" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    echo "The checksum file '$checksum_file' did not contain a valid SHA-256 value." >&2
    exit 1
  fi

  printf '%s\n' "${checksum,,}"
}

compute_sha256() {
  local file_path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{ print tolower($1) }'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{ print tolower($1) }'
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file_path" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
hasher = hashlib.sha256()
with path.open('rb') as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
        hasher.update(chunk)

print(hasher.hexdigest())
PY
    return
  fi

  echo 'No supported SHA-256 tool was found. Install sha256sum, shasum, or python3.' >&2
  exit 1
}

write_release_info() {
  local checksum="$1"

  cat > "$RELEASE_INFO_PATH" <<EOF
FLUXMONITOR_RELEASE_REPOSITORY=$NORMALIZED_REPOSITORY
FLUXMONITOR_RELEASE_TAG=$RELEASE_TAG
FLUXMONITOR_RELEASE_ASSET_NAME=$ASSET_NAME
FLUXMONITOR_RELEASE_SHA256=$checksum
EOF
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
  copy_if_exists "$source_root/fluxmonitor.env" "$preserve_root/fluxmonitor.env"
  copy_if_exists "$source_root/app/notifications.json" "$preserve_root/app/notifications.json"
  copy_if_exists "$source_root/app/devices.json" "$preserve_root/app/devices.json"
  copy_if_exists "$source_root/app/devices" "$preserve_root/app/devices"

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

  if [ -f "$preserve_root/fluxmonitor.env" ]; then
    cp "$preserve_root/fluxmonitor.env" "$destination_root/fluxmonitor.env"
  fi

  if [ -f "$preserve_root/app/notifications.json" ]; then
    mkdir -p "$destination_root/app"
    cp "$preserve_root/app/notifications.json" "$destination_root/app/notifications.json"
  fi

  if [ -f "$preserve_root/app/devices.json" ]; then
    mkdir -p "$destination_root/app"
    cp "$preserve_root/app/devices.json" "$destination_root/app/devices.json"
  fi

  # Merge back user-added device definitions without overwriting bundled ones.
  if [ -d "$preserve_root/app/devices" ]; then
    mkdir -p "$destination_root/app/devices"
    cp -n "$preserve_root/app/devices"/*.json "$destination_root/app/devices/" 2>/dev/null || true
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

get_primary_ip() {
  if command -v hostname >/dev/null 2>&1; then
    local host_ips
    host_ips="$(hostname -I 2>/dev/null || true)"
    if [ -n "$host_ips" ]; then
      for ip in $host_ips; do
        case "$ip" in
          127.*|169.254.*)
            ;;
          *)
            echo "$ip"
            return
            ;;
        esac
      done
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}'
    return
  fi

  echo ""
}

get_access_url() {
  local primary_ip
  primary_ip="$(get_primary_ip)"

  if [ -n "$primary_ip" ]; then
    echo "http://$primary_ip:$APP_PORT"
    return
  fi

  echo "$APP_LOCAL_URL"
}

has_existing_runtime_configuration() {
  if [ -f "$APP_ROOT/appsettings.Production.Local.json" ]; then
    return 0
  fi

  if [ -f "$APP_ROOT/appsettings.Development.Local.json" ] || [ -f "$APP_ROOT/appsettings.Local.json" ]; then
    return 0
  fi

  if [ -f "$ENV_PATH" ]; then
    return 0
  fi

  if [ -n "$NONINTERACTIVE_MODE" ] || [ -n "$NONINTERACTIVE_SERIAL_PORT" ] || [ -n "$NONINTERACTIVE_USE_DB" ] || [ -n "$NONINTERACTIVE_CONNECTION_STRING" ]; then
    return 0
  fi

  return 1
}

configuration_file_has_postgres_storage() {
  local config_path="$1"

  if [ ! -f "$config_path" ]; then
    return 1
  fi

  grep -Eq '"Provider"[[:space:]]*:[[:space:]]*"TimescaleDb"' "$config_path" || return 1
  grep -Eq '"ConnectionString"[[:space:]]*:[[:space:]]*"[^"]+"' "$config_path" || return 1
}

has_reusable_runtime_configuration() {
  if configuration_file_has_postgres_storage "$APP_ROOT/appsettings.Production.Local.json"; then
    return 0
  fi

  if configuration_file_has_postgres_storage "$APP_ROOT/appsettings.Local.json"; then
    return 0
  fi

  if configuration_file_has_postgres_storage "$APP_ROOT/appsettings.Development.Local.json"; then
    return 0
  fi

  return 1
}

get_existing_environment_name() {
  if [ -f "$ENV_PATH" ]; then
    local configured_environment
    configured_environment="$(grep -E '^ASPNETCORE_ENVIRONMENT=' "$ENV_PATH" | tail -n 1 | cut -d= -f2- || true)"
    if [ -n "$configured_environment" ]; then
      printf '%s\n' "$configured_environment"
      return
    fi
  fi

  if [ -f "$APP_ROOT/appsettings.Production.Local.json" ]; then
    printf '%s\n' 'Production'
    return
  fi

  if [ -f "$APP_ROOT/appsettings.Development.Local.json" ]; then
    printf '%s\n' 'Development'
    return
  fi

  printf '%s\n' ''
}

normalize_release_runtime_configuration() {
  local development_local="$APP_ROOT/appsettings.Development.Local.json"
  local production_local="$APP_ROOT/appsettings.Production.Local.json"

  if [ -f "$development_local" ] && [ ! -f "$production_local" ]; then
    cp "$development_local" "$production_local"
    info 'Migrated release-local settings from Development to Production.'
  fi

  if [ -f "$ENV_PATH" ]; then
    local app_urls
    app_urls="$(grep -E '^ASPNETCORE_URLS=' "$ENV_PATH" | tail -n 1 | cut -d= -f2- || true)"
    if [ -z "$app_urls" ]; then
      app_urls="$APP_BIND_URL"
    fi

    cat > "$ENV_PATH" <<EOF
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=$app_urls
EOF
  fi
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

get_required_connection_string() {
  if [ -n "$NONINTERACTIVE_CONNECTION_STRING" ]; then
    printf '%s\n' "$NONINTERACTIVE_CONNECTION_STRING"
    return
  fi

  if command -v psql >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then
    bootstrap_local_postgres_connection_string
    return
  fi

  if ! [ -t 0 ]; then
    echo 'FLUXMONITOR_CONNECTION_STRING is required when installing non-interactively.' >&2
    exit 1
  fi

  read_required_value 'PostgreSQL connection string: '
}

generate_password() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(24))
PY
    return
  fi

  head -c 32 /dev/urandom | base64 | tr -d '\n=+/' | cut -c1-32
}

bootstrap_local_postgres_connection_string() {
  local database_name='fluxmonitor'
  local role_name='fluxmonitor_app'
  local password
  password="$(generate_password)"

  section 'Bootstrapping local PostgreSQL'

  if ! command -v psql >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then
      echo 'No PostgreSQL client was found and automatic PostgreSQL installation is only implemented for apt-based Linux systems.' >&2
      exit 1
    fi

    info 'Installing the local PostgreSQL server package.'
    run_elevated apt-get update
    run_elevated apt-get install -y postgresql
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_elevated systemctl enable postgresql >/dev/null 2>&1 || true
    run_elevated systemctl start postgresql
  fi

  info "Creating or updating the local PostgreSQL role '$role_name' and database '$database_name'."
  run_as_postgres "psql -v ON_ERROR_STOP=1 -d postgres -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role_name') THEN CREATE ROLE $role_name LOGIN PASSWORD '$password'; ELSE ALTER ROLE $role_name WITH LOGIN PASSWORD '$password'; END IF; END \\\$\\\$;\""

  if [ "$(run_as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = '$database_name'\" postgres" | tr -d '[:space:]')" != '1' ]; then
    run_as_postgres "createdb -O $role_name $database_name"
  fi

  run_as_postgres "psql -d $database_name -c \"CREATE EXTENSION IF NOT EXISTS timescaledb;\"" >/dev/null 2>&1 || true

  printf 'Host=127.0.0.1;Port=5432;Database=%s;Username=%s;Password=%s\n' "$database_name" "$role_name" "$password"
}

get_configured_choice() {
  local configured_value="$1"
  local prompt="$2"
  local type="$3"
  local default_value="$4"

  if [ -n "$configured_value" ]; then
    local normalized="${configured_value,,}"

    if [ "$type" = 'startup' ]; then
      case "$normalized" in
        1|sim|simulator)
          echo '1'
          return
          ;;
        2|hw|hardware)
          echo '2'
          return
          ;;
      esac
    elif [ "$type" = 'yesno' ]; then
      case "$normalized" in
        y|yes|true|1)
          echo 'y'
          return
          ;;
        n|no|false|0)
          echo 'n'
          return
          ;;
      esac
    fi

    echo "Unsupported configured value '$configured_value' for $prompt." >&2
    exit 1
  fi

  read_validated_choice "$prompt" "$type" "$default_value"
}

install_local_runtime() {
  section 'Installing local ASP.NET Core runtime'
  mkdir -p "$LOCAL_DOTNET_ROOT"
  download_file 'https://dot.net/v1/dotnet-install.sh' "$INSTALL_SCRIPT"
  bash "$INSTALL_SCRIPT" --channel 10.0 --runtime aspnetcore --install-dir "$LOCAL_DOTNET_ROOT"
}

write_configure_script() {
  cat > "$CONFIGURE_SCRIPT_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_ROOT/app"
ENV_PATH="$SCRIPT_ROOT/fluxmonitor.env"
SERVICE_NAME='fluxmonitor.service'
APP_PORT='5074'

get_primary_ip() {
  if command -v hostname >/dev/null 2>&1; then
    local host_ips
    host_ips="$(hostname -I 2>/dev/null || true)"
    if [ -n "$host_ips" ]; then
      for ip in $host_ips; do
        case "$ip" in
          127.*|169.254.*)
            ;;
          *)
            echo "$ip"
            return
            ;;
        esac
      done
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}'
    return
  fi

  echo ""
}

get_access_url() {
  local primary_ip
  primary_ip="$(get_primary_ip)"

  if [ -n "$primary_ip" ]; then
    echo "http://$primary_ip:$APP_PORT"
    return
  fi

  echo "http://127.0.0.1:$APP_PORT"
}

writable_config="$APP_ROOT/appsettings.Production.Local.json"

echo
echo 'Flux Monitor hardware configuration'
echo 'This switches the install from simulator preview mode to your real RS485 setup and requires PostgreSQL.'

read -r -p 'RS485 serial port (example: /dev/ttyUSB0): ' serial_port
while [ -z "$serial_port" ]; do
  echo 'A serial port is required.'
  read -r -p 'RS485 serial port (example: /dev/ttyUSB0): ' serial_port
done

read -r -p 'PostgreSQL connection string: ' connection_string
while [ -z "$connection_string" ]; do
  echo 'A PostgreSQL connection string is required.'
  read -r -p 'PostgreSQL connection string: ' connection_string
done

cat > "$writable_config" <<JSON
{
  "Monitor": {
    "SerialBus": {
      "PortName": "$serial_port"
    },
    "Storage": {
      "Provider": "TimescaleDb",
      "ConnectionString": "$connection_string"
    },
    "Devices": [
      {
        "DeviceId": "jk-master-01",
        "DisplayName": "Main Battery Rack",
        "DefinitionId": "jk-inverter-bms",
        "TransportPortName": "$serial_port",
        "Address": 1,
        "IsMaster": true,
        "PollIntervalMilliseconds": 1000,
        "Enabled": true
      }
    ]
  }
}
JSON

cat > "$ENV_PATH" <<ENVVARS
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://0.0.0.0:$APP_PORT
ENVVARS

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^$SERVICE_NAME'; then
  if [ "$(id -u)" -eq 0 ]; then
    fuser -k "${APP_PORT}/tcp" 2>/dev/null || true
    systemctl restart "$SERVICE_NAME"
  else
    sudo fuser -k "${APP_PORT}/tcp" 2>/dev/null || true
    sudo systemctl restart "$SERVICE_NAME"
  fi
  echo
  echo 'Flux Monitor was reconfigured and the service was restarted.'
else
  echo
  echo 'Configuration saved. Start Flux Monitor again with ~/FluxMonitor/start.sh.'
fi

echo "Open $(get_access_url) from your PC once the service is running."
EOF

  chmod +x "$CONFIGURE_SCRIPT_PATH"
}

write_start_script() {
  cat > "$DESTINATION/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$SCRIPT_ROOT/app"
LOCAL_DOTNET="$SCRIPT_ROOT/.dotnet/dotnet"
ENV_PATH="$SCRIPT_ROOT/fluxmonitor.env"

if command -v dotnet >/dev/null 2>&1 && dotnet --list-runtimes 2>/dev/null | grep -q '^Microsoft.AspNetCore.App 10\.'; then
  DOTNET_CMD="$(command -v dotnet)"
elif [ -x "$LOCAL_DOTNET" ]; then
  DOTNET_CMD="$LOCAL_DOTNET"
else
  echo 'No compatible ASP.NET Core 10 runtime was found.' >&2
  exit 1
fi

if [ -f "$ENV_PATH" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_PATH"
  set +a
fi

export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Production}"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://0.0.0.0:5074}"

cd "$APP_ROOT"
exec "$DOTNET_CMD" ./FluxMonitor.Backend.dll
EOF

  chmod +x "$DESTINATION/start.sh"
}

write_env_file() {
  local environment_name="$1"

  cat > "$ENV_PATH" <<EOF
ASPNETCORE_ENVIRONMENT=$environment_name
ASPNETCORE_URLS=$APP_BIND_URL
EOF
}

install_systemd_service() {
  local current_user
  current_user="$(id -un)"

  run_elevated tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=Flux Monitor Backend
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
  run_elevated fuser -k "${APP_PORT}/tcp" 2>/dev/null || true
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
          xdg-open "$APP_LOCAL_URL" >/dev/null 2>&1 || true
        elif command -v open >/dev/null 2>&1; then
          open "$APP_LOCAL_URL" >/dev/null 2>&1 || true
        fi
        exit 0
      fi
      sleep 1
    done
  ) &
  BROWSER_PID=$!
}

NORMALIZED_REPOSITORY="$(normalize_repository "$REPOSITORY")"
TEMP_ROOT="${TMPDIR:-/tmp}/FluxMonitor-release-install-$(date +%s)-$$"
ARCHIVE_PATH="$TEMP_ROOT/$ASSET_NAME"
CHECKSUM_PATH="$TEMP_ROOT/$CHECKSUM_ASSET_NAME"
EXTRACT_PATH="$TEMP_ROOT/extract"
PRESERVE_PATH="$TEMP_ROOT/preserve"

mkdir -p "$TEMP_ROOT" "$EXTRACT_PATH" "$PRESERVE_PATH"

cleanup() {
  rm -rf "$TEMP_ROOT"
}

trap cleanup EXIT

section 'Flux Monitor release bootstrap'
muted "Repository: $NORMALIZED_REPOSITORY"
muted "Release tag: $RELEASE_TAG"
muted "Destination: $DESTINATION"

fetch_release_json() {
  local url="https://api.github.com/repos/$NORMALIZED_REPOSITORY/releases/tags/$RELEASE_TAG"

  if command -v curl >/dev/null 2>&1; then
    if [ -n "$GITHUB_TOKEN_VALUE" ]; then
      curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: FluxMonitor-install-script' -H "Authorization: Bearer $GITHUB_TOKEN_VALUE" "$url"
    else
      curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: FluxMonitor-install-script' "$url"
    fi
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    if [ -n "$GITHUB_TOKEN_VALUE" ]; then
      wget -qO- --header='Accept: application/vnd.github+json' --header='User-Agent: FluxMonitor-install-script' --header="Authorization: Bearer $GITHUB_TOKEN_VALUE" "$url"
    else
      wget -qO- --header='Accept: application/vnd.github+json' --header='User-Agent: FluxMonitor-install-script' "$url"
    fi
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    GITHUB_TOKEN_VALUE="$GITHUB_TOKEN_VALUE" python3 - "$url" <<'PY'
import os
import sys
import urllib.request

token = os.environ.get("GITHUB_TOKEN_VALUE", "")
request = urllib.request.Request(
    sys.argv[1],
    headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "FluxMonitor-install-script",
        **({"Authorization": f"Bearer {token}"} if token else {}),
    },
)
with urllib.request.urlopen(request) as response:
    sys.stdout.write(response.read().decode("utf-8"))
PY
    return
  fi

  echo 'No supported HTTP client was found. Install curl, wget, or python3.' >&2
  exit 1
}

get_release_asset_api_url() {
  local asset_name="$1"
  local release_json
  release_json="$(fetch_release_json)"

  if ! command -v python3 >/dev/null 2>&1; then
    echo 'python3 is required to parse the GitHub release metadata.' >&2
    exit 1
  fi

  RELEASE_JSON="$release_json" python3 - "$asset_name" <<'PY'
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
}

download_release_asset() {
  local asset_name="$1"
  local target="$2"
  local asset_api_url
  asset_api_url="$(get_release_asset_api_url "$asset_name")"

  if command -v curl >/dev/null 2>&1; then
    if [ -n "$GITHUB_TOKEN_VALUE" ]; then
      curl -fsSL \
        -H 'Accept: application/octet-stream' \
        -H 'User-Agent: FluxMonitor-install-script' \
        -H "Authorization: Bearer $GITHUB_TOKEN_VALUE" \
        "$asset_api_url" \
        -o "$target"
    else
      curl -fsSL \
        -H 'Accept: application/octet-stream' \
        -H 'User-Agent: FluxMonitor-install-script' \
        "$asset_api_url" \
        -o "$target"
    fi
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    if [ -n "$GITHUB_TOKEN_VALUE" ]; then
      wget -qO "$target" \
        --header='Accept: application/octet-stream' \
        --header='User-Agent: FluxMonitor-install-script' \
        --header="Authorization: Bearer $GITHUB_TOKEN_VALUE" \
        "$asset_api_url"
    else
      wget -qO "$target" \
        --header='Accept: application/octet-stream' \
        --header='User-Agent: FluxMonitor-install-script' \
        "$asset_api_url"
    fi
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    GITHUB_TOKEN_VALUE="$GITHUB_TOKEN_VALUE" python3 - "$asset_api_url" "$target" <<'PY'
import os
import sys
import urllib.request

token = os.environ.get("GITHUB_TOKEN_VALUE", "")
request = urllib.request.Request(
    sys.argv[1],
    headers={
        "Accept": "application/octet-stream",
        "User-Agent": "FluxMonitor-install-script",
        **({"Authorization": f"Bearer {token}"} if token else {}),
    },
)
with urllib.request.urlopen(request) as response, open(sys.argv[2], "wb") as output:
    output.write(response.read())
PY
    return
  fi

  echo 'No supported HTTP client was found. Install curl, wget, or python3.' >&2
  exit 1
}

section 'Downloading release artifact'
info 'Fetching the published build from GitHub Releases.'
download_release_asset "$ASSET_NAME" "$ARCHIVE_PATH"

section 'Verifying release artifact'
info 'Checking the published checksum before install.'
download_release_asset "$CHECKSUM_ASSET_NAME" "$CHECKSUM_PATH"
PUBLISHED_RELEASE_SHA256="$(parse_sha256_file "$CHECKSUM_PATH")"
DOWNLOADED_RELEASE_SHA256="$(compute_sha256 "$ARCHIVE_PATH")"

if [ "$DOWNLOADED_RELEASE_SHA256" != "$PUBLISHED_RELEASE_SHA256" ]; then
  echo "Downloaded artifact checksum mismatch. Expected $PUBLISHED_RELEASE_SHA256 but got $DOWNLOADED_RELEASE_SHA256." >&2
  exit 1
fi

if [ -n "$EXPECTED_RELEASE_SHA256" ] && [ "${DOWNLOADED_RELEASE_SHA256,,}" != "${EXPECTED_RELEASE_SHA256,,}" ]; then
  echo "Downloaded artifact does not match the expected published checksum $EXPECTED_RELEASE_SHA256." >&2
  exit 1
fi

section 'Extracting release artifact'
info 'Unpacking the application files.'
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_PATH"

section 'Preparing installation folder'
if [ -d "$DESTINATION" ]; then
  warn 'Existing installation found. Preserving local config and cached runtime.'
  preserve_existing_state "$DESTINATION" "$PRESERVE_PATH"
  rm -rf "$DESTINATION"
fi

mkdir -p "$DESTINATION"
mv "$EXTRACT_PATH/linux-arm64" "$APP_ROOT"
restore_preserved_state "$PRESERVE_PATH" "$DESTINATION"
normalize_release_runtime_configuration
write_release_info "$DOWNLOADED_RELEASE_SHA256"
write_start_script
write_configure_script

section 'Checking ASP.NET Core runtime'
DOTNET_CMD="$(get_dotnet)"
if [ -z "$DOTNET_CMD" ]; then
  answer="$(get_configured_choice "$NONINTERACTIVE_INSTALL_RUNTIME" 'No compatible ASP.NET Core 10 runtime was found. Install a local copy into this folder?' 'yesno' 'y')"
  if [ "${answer,,}" != 'y' ]; then
    echo 'An ASP.NET Core 10 runtime is required to run this published build.'
    exit 1
  fi

  install_local_runtime
  DOTNET_CMD="$LOCAL_DOTNET"
fi

section 'Configuring startup mode'
reused_existing_configuration='false'

if has_reusable_runtime_configuration && { is_truthy "$NONINTERACTIVE_REUSE_EXISTING_CONFIGURATION" || ! [ -t 0 ]; }; then
  reused_existing_configuration='true'
  ENVIRONMENT="$(get_existing_environment_name)"
  if [ -z "$ENVIRONMENT" ]; then
    ENVIRONMENT='Production'
  fi
  info "Reusing the existing runtime configuration for $ENVIRONMENT."
elif has_existing_runtime_configuration; then
  info 'Existing runtime settings were found, but PostgreSQL is not configured. Rebuilding managed production configuration.'

  if ! [ -t 0 ]; then
    MODE='1'
  else
    MODE="$(get_configured_choice "$NONINTERACTIVE_MODE" 'Choose startup mode: 1 = simulator, 2 = hardware' 'startup' '1')"
  fi
else
  MODE='1'
  info 'Starting in simulator mode for the first run so the web UI is available immediately.'
  muted 'You can switch to real hardware later from the Setup panel in the app.'
fi
ENVIRONMENT="${ENVIRONMENT:-Production}"
TARGET_CONFIG="$APP_ROOT/appsettings.Production.Local.json"

if [ "$reused_existing_configuration" = 'false' ] && [ "$MODE" = '1' ]; then
  CONNECTION_STRING="$(get_required_connection_string)"
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
elif [ "$reused_existing_configuration" = 'false' ]; then
  ENVIRONMENT='Production'
  TARGET_CONFIG="$APP_ROOT/appsettings.Production.Local.json"
  if [ -n "$NONINTERACTIVE_SERIAL_PORT" ]; then
    SERIAL_PORT="$NONINTERACTIVE_SERIAL_PORT"
  else
    SERIAL_PORT="$(read_required_value 'RS485 serial port (example: /dev/ttyUSB0): ')"
  fi
  if [ -z "$SERIAL_PORT" ]; then
    echo 'A serial port is required for hardware mode, so Flux Monitor was not started and no access URL is available yet.' >&2
    exit 1
  fi

  CONNECTION_STRING="$(get_required_connection_string)"

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

if [ "$reused_existing_configuration" = 'false' ] || [ ! -f "$ENV_PATH" ]; then
  write_env_file "$ENVIRONMENT"
fi
ACCESS_URL="$(get_access_url 2>/dev/null)" || ACCESS_URL="$APP_LOCAL_URL"
ACCESS_URL="${ACCESS_URL:-$APP_LOCAL_URL}"

INSTALL_SERVICE='n'
if command -v systemctl >/dev/null 2>&1; then
  if ! [ -t 0 ] && [ -z "$NONINTERACTIVE_INSTALL_SERVICE" ]; then
    INSTALL_SERVICE='y'
  else
    INSTALL_SERVICE="$(get_configured_choice "$NONINTERACTIVE_INSTALL_SERVICE" 'Install and start a systemd service for headless operation?' 'yesno' 'y')"
  fi
fi

section 'Starting Flux Monitor'
info "Environment: $ENVIRONMENT"
muted "Installed app root: $APP_ROOT"
muted "Reusable launch command: $DESTINATION/start.sh"
muted "Service file path: $SERVICE_PATH"
success "Local access URL: $APP_LOCAL_URL"
success "LAN access URL: $ACCESS_URL"
muted 'Tip: most terminals let you Ctrl+Click the URL to open it.'

if [ "${INSTALL_SERVICE,,}" = 'y' ]; then
  section 'Installing systemd service'
  install_systemd_service

  if wait_for_health; then
    success "Flux Monitor is running under systemd. Open $ACCESS_URL from your PC."
  else
    echo 'The systemd service was installed, but the health endpoint did not become ready in time.' >&2
    echo "Inspect service logs with: sudo journalctl -u $SERVICE_NAME -n 200 --no-pager" >&2
    exit 1
  fi

  exit 0
fi

info "Opening $APP_LOCAL_URL on the device after the backend is ready."
success "From your PC, open $ACCESS_URL once the device is reachable on your network."
muted 'Tip: Ctrl+Click usually works directly from the terminal output.'

BROWSER_PID=''
open_browser_when_ready

cd "$APP_ROOT"
trap 'if [ -n "${BROWSER_PID:-}" ]; then kill "$BROWSER_PID" >/dev/null 2>&1 || true; fi' EXIT
ASPNETCORE_ENVIRONMENT="$ENVIRONMENT" ASPNETCORE_URLS="$APP_BIND_URL" "$DOTNET_CMD" ./FluxMonitor.Backend.dll
