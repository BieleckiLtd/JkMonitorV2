#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/BieleckiLtd/JkMonitorV2}"
RELEASE_TAG="${2:-dev-latest}"
DESTINATION="${3:-$HOME/fluxmonitor}"
APP_ROOT="$DESTINATION/app"
LOCAL_DOTNET_ROOT="$DESTINATION/.dotnet"
LOCAL_DOTNET="$LOCAL_DOTNET_ROOT/dotnet"
APP_PORT='5074'
APP_BIND_URL="http://[::]:$APP_PORT"
APP_LOCAL_URL="http://127.0.0.1:$APP_PORT"
HEALTH_URL="$APP_LOCAL_URL/api/health"
ASSET_NAME='fluxmonitor-backend-linux-arm64.tar.gz'
CHECKSUM_ASSET_NAME="$ASSET_NAME.sha256"
INSTALL_SCRIPT=''
SERVICE_NAME='fluxmonitor.service'
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
MDNS_SERVICE_NAME='avahi-daemon.service'
NETWORKMANAGER_POLKIT_RULE_PATH='/etc/polkit-1/rules.d/50-fluxmonitor-networkmanager.rules'
NETWORKMANAGER_WIFI_POWERSAVE_CONFIG_PATH='/etc/NetworkManager/conf.d/50-fluxmonitor-wifi-powersave-off.conf'
SYSTEMD_POLKIT_RULE_PATH='/etc/polkit-1/rules.d/51-fluxmonitor-systemd.rules'
TUNNEL_SERVICE_NAME='cloudflared.service'
TUNNEL_SERVICE_PATH="/etc/systemd/system/$TUNNEL_SERVICE_NAME"
SSH_SERVICE_NAME='ssh.service'
ENV_PATH="$DESTINATION/fluxmonitor.env"
TUNNEL_ENV_PATH="$DESTINATION/cloudflared.env"
CLOUDFLARED_START_SCRIPT_PATH="$DESTINATION/cloudflared-run.sh"
RELEASE_INFO_PATH="$DESTINATION/release-info.env"
NONINTERACTIVE_CONNECTION_STRING="${FLUXMONITOR_CONNECTION_STRING:-}"
NONINTERACTIVE_INSTALL_RUNTIME="${FLUXMONITOR_INSTALL_RUNTIME:-}"
NONINTERACTIVE_INSTALL_SERVICE="${FLUXMONITOR_INSTALL_SERVICE:-}"
NONINTERACTIVE_REUSE_EXISTING_CONFIGURATION="${FLUXMONITOR_REUSE_EXISTING_CONFIGURATION:-}"
NONINTERACTIVE_REFRESH_CLOUDFLARED="${FLUXMONITOR_REFRESH_CLOUDFLARED:-}"
EXPECTED_RELEASE_SHA256="${FLUXMONITOR_EXPECTED_RELEASE_SHA256:-}"
CONFIGURE_SCRIPT_PATH="$DESTINATION/configure.sh"
TIMESCALE_REPOSITORY_SETUP_URL='https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh'
CLOUDFLARED_PACKAGE_CHANGED='false'
CLOUDFLARED_START_SCRIPT_CHANGED='false'

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

get_existing_writable_directory() {
  local path="$1"

  while [ -n "$path" ] && [ ! -d "$path" ]; do
    local next_path
    next_path="$(dirname "$path")"
    if [ "$next_path" = "$path" ]; then
      break
    fi
    path="$next_path"
  done

  if [ -d "$path" ] && [ -w "$path" ]; then
    echo "$path"
    return 0
  fi

  return 1
}

get_installer_temp_base() {
  local destination_root="$1"
  local preferred_parent
  preferred_parent="$(get_existing_writable_directory "$(dirname "$destination_root")" || true)"
  if [ -n "$preferred_parent" ]; then
    echo "$preferred_parent/.fluxmonitor-installer"
    return
  fi

  if [ -n "${HOME:-}" ] && [ -d "$HOME" ] && [ -w "$HOME" ]; then
    echo "$HOME/.fluxmonitor-installer"
    return
  fi

  echo "${TMPDIR:-/tmp}/.fluxmonitor-installer"
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

try_download_file() {
  local url="$1"
  local target="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$target"
    return $?
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$target" "$url"
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$url" "$target" <<'PY'
import sys
import urllib.request

url, target = sys.argv[1], sys.argv[2]
urllib.request.urlretrieve(url, target)
PY
    return $?
  fi

  echo 'No supported download tool was found. Install curl, wget, or python3.' >&2
  return 1
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

write_install_audit() {
  local install_kind="$1"
  local repository="$2"
  local branch="$3"
  local release_tag="$4"
  local asset_name="$5"
  local checksum="$6"
  local destination="$7"
  local installed_by="$8"
  local installed_at_utc="$9"
  local machine_name="${10}"

  cat > "$DESTINATION/install-audit.json" <<EOF
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
  copy_if_exists "$source_root/cloudflared.env" "$preserve_root/cloudflared.env"
  copy_if_exists "$source_root/app/notifications.json" "$preserve_root/app/notifications.json"

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

  if [ -f "$preserve_root/cloudflared.env" ]; then
    cp "$preserve_root/cloudflared.env" "$destination_root/cloudflared.env"
  fi

  if [ -f "$preserve_root/app/notifications.json" ]; then
    mkdir -p "$destination_root/app"
    cp "$preserve_root/app/notifications.json" "$destination_root/app/notifications.json"
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

get_host_name() {
  if command -v hostname >/dev/null 2>&1; then
    hostname 2>/dev/null | tr -d '[:space:]'
    return
  fi

  echo ""
}

get_hostname_access_url() {
  local host_name
  host_name="$(get_host_name)"

  if [ -n "$host_name" ]; then
    echo "http://$host_name.local:$APP_PORT"
    return
  fi

  echo ""
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

  if [ -n "$NONINTERACTIVE_CONNECTION_STRING" ]; then
    return 0
  fi

  return 1
}

configuration_file_has_postgres_storage() {
  local config_path="$1"

  if [ ! -f "$config_path" ]; then
    return 1
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$config_path" <<'PY'
import json
import sys

path = sys.argv[1]

try:
    with open(path, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)
except Exception:
    raise SystemExit(1)

monitor = payload.get('Monitor') if isinstance(payload, dict) else None
storage = monitor.get('Storage') if isinstance(monitor, dict) else None
provider = storage.get('Provider') if isinstance(storage, dict) else None
connection_string = storage.get('ConnectionString') if isinstance(storage, dict) else None

if isinstance(provider, str) and provider.lower() == 'timescaledb' and isinstance(connection_string, str) and connection_string.strip():
    raise SystemExit(0)

raise SystemExit(1)
PY
    return $?
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
  local default_value="$2"
  local value
  read -r -p "$prompt [$default_value] " value
  if [ -z "$value" ]; then
    echo "$default_value"
  else
    case "${value,,}" in
      y|yes) echo 'y' ;;
      n|no) echo 'n' ;;
      *) echo "" ;;
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

read_connection_string_field() {
  local connection_string="$1"
  local field_name="$2"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$connection_string" "$field_name" <<'PY'
import sys

connection_string, field_name = sys.argv[1], sys.argv[2].lower()

for segment in connection_string.split(';'):
    if '=' not in segment:
        continue
    key, value = segment.split('=', 1)
    if key.strip().lower() == field_name:
        print(value.strip())
        raise SystemExit(0)
PY
    return
  fi

  printf '%s\n' "$connection_string" | tr ';' '\n' | awk -F= -v field_name="$field_name" '
    BEGIN { IGNORECASE = 1 }
    $1 ~ ("^[[:space:]]*" field_name "[[:space:]]*$") {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
      exit
    }'
}

is_local_connection_string() {
  local connection_string="$1"
  local host

  host="$(read_connection_string_field "$connection_string" 'Host')"
  if [ -z "$host" ]; then
    host="$(read_connection_string_field "$connection_string" 'Server')"
  fi

  case "${host,,}" in
    ''|localhost|127.0.0.1|::1|[::1])
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

read_connection_string_database_name() {
  local connection_string="$1"
  local database_name

  database_name="$(read_connection_string_field "$connection_string" 'Database')"
  if [ -n "$database_name" ]; then
    printf '%s\n' "$database_name"
    return
  fi

  database_name="$(read_connection_string_field "$connection_string" 'Initial Catalog')"
  if [ -n "$database_name" ]; then
    printf '%s\n' "$database_name"
    return
  fi

  printf '%s\n' 'postgres'
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

get_postgres_server_major_version() {
  local version_num
  version_num="$(run_as_postgres "psql -Atq -d postgres -c 'SHOW server_version_num;'" | tr -d '[:space:]')"
  if [[ ! "$version_num" =~ ^[0-9]{5,6}$ ]]; then
    return
  fi

  printf '%s\n' "${version_num%????}"
}

local_database_exists() {
  local database_name="$1"
  [ "$(run_as_postgres "psql -Atq -d postgres -c \"SELECT 1 FROM pg_database WHERE datname = '$database_name';\"" | tr -d '[:space:]')" = '1' ]
}

timescaledb_is_available_on_server() {
  [ "$(run_as_postgres "psql -Atq -d postgres -c \"SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb';\"" | tr -d '[:space:]')" = '1' ]
}

timescaledb_is_enabled_for_database() {
  local database_name="$1"
  [ "$(run_as_postgres "psql -Atq -d \"$database_name\" -c \"SELECT 1 FROM pg_extension WHERE extname = 'timescaledb';\"" | tr -d '[:space:]')" = '1' ]
}

get_postgres_extension_directory() {
  local sharedir
  sharedir="$(pg_config --sharedir 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$sharedir" ]; then
    return 1
  fi

  printf '%s\n' "$sharedir/extension"
}

read_timescaledb_default_version() {
  local extension_dir="$1"
  local control_path="$extension_dir/timescaledb.control"

  if [ ! -f "$control_path" ]; then
    return 1
  fi

  awk -F"'" '/^[[:space:]]*default_version[[:space:]]*=/{ print $2; exit }' "$control_path"
}

timescaledb_installation_scripts_are_present() {
  local extension_dir
  local default_version
  local scripts

  extension_dir="$(get_postgres_extension_directory)" || return 1
  default_version="$(read_timescaledb_default_version "$extension_dir" || true)"

  if [ -n "$default_version" ] && [ -f "$extension_dir/timescaledb--$default_version.sql" ]; then
    return 0
  fi

  scripts=("$extension_dir"/timescaledb--*.sql)
  [ -e "${scripts[0]}" ]
}

dpkg_package_is_installed() {
  local package_name="$1"
  dpkg -l "$package_name" 2>/dev/null \
    | awk -v package_name="$package_name" '$1 == "ii" && $2 == package_name { found = 1 } END { exit(found ? 0 : 1) }'
}

find_installed_timescaledb_apache_package() {
  local postgres_major="$1"
  local package_name

  for package_name in \
    "timescaledb-2-oss-postgresql-$postgres_major" \
    "postgresql-$postgres_major-timescaledb"
  do
    if dpkg_package_is_installed "$package_name"; then
      printf '%s\n' "$package_name"
      return 0
    fi
  done

  return 1
}

select_timescaledb_package_name() {
  local postgres_major="$1"
  local packages
  packages="$(apt-cache search --names-only "timescaledb.*postgresql-$postgres_major" | awk '{ print $1 }' | sort -u)"

  if [ -z "$packages" ]; then
    return
  fi

  for preferred in \
    "timescaledb-2-postgresql-$postgres_major" \
    "timescaledb-2-oss-postgresql-$postgres_major" \
    "timescaledb-postgresql-$postgres_major"
  do
    if printf '%s\n' "$packages" | grep -Fxq "$preferred"; then
      printf '%s\n' "$preferred"
      return
    fi
  done

  printf '%s\n' "$packages" \
    | grep -E "^timescaledb-.*postgresql-$postgres_major$" \
    | sort -V \
    | tail -n 1
}

install_timescaledb_package_for_local_postgres() {
  local postgres_major="$1"
  local repo_setup_script="$TEMP_ROOT/install-timescaledb-repository.sh"
  local apache_package=''
  local community_package="timescaledb-2-postgresql-$postgres_major"
  local package_name
  local scripts_missing='false'

  apache_package="$(find_installed_timescaledb_apache_package "$postgres_major" || true)"

  if timescaledb_is_available_on_server; then
    if ! timescaledb_installation_scripts_are_present; then
      warn 'TimescaleDB is listed by PostgreSQL, but the installation SQL files are missing. Reinstalling the package.' >&2
      scripts_missing='true'
    fi

    if [ -n "$apache_package" ] && ! dpkg_package_is_installed "$community_package"; then
      section 'Upgrading TimescaleDB from Apache (OSS) to Community Edition' >&2
      info "Detected Apache-only TimescaleDB package '$apache_package'." >&2
      info "Community Edition enables native compression for reduced storage." >&2

      download_file "$TIMESCALE_REPOSITORY_SETUP_URL" "$repo_setup_script"
      run_elevated bash "$repo_setup_script" >&2
      run_elevated apt-get update >&2

      info "Removing $apache_package" >&2
      run_elevated apt-get remove -y "$apache_package" >&2

      info "Installing $community_package" >&2
      run_elevated apt-get install -y "$community_package" >&2

      if command -v systemctl >/dev/null 2>&1; then
        run_elevated systemctl restart postgresql >/dev/null 2>&1 || true
      fi

      if dpkg_package_is_installed "$community_package"; then
        success "Upgraded to TimescaleDB Community Edition ($community_package)." >&2
      else
        warn "TimescaleDB Community package '$community_package' could not be installed. Continuing with Apache-only edition." >&2
      fi
    fi

    if [ "$scripts_missing" = 'false' ]; then
      return 0
    fi
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi

  section 'Installing TimescaleDB extension package' >&2
  info "Preparing the TimescaleDB apt repository for PostgreSQL $postgres_major." >&2
  download_file "$TIMESCALE_REPOSITORY_SETUP_URL" "$repo_setup_script"
  run_elevated bash "$repo_setup_script" >&2
  run_elevated apt-get update >&2

  package_name="$(select_timescaledb_package_name "$postgres_major")"
  if [ -z "$package_name" ]; then
    warn "No TimescaleDB package matching PostgreSQL $postgres_major was found in the apt repository." >&2
    return 1
  fi

  if [ "$scripts_missing" = 'true' ] && dpkg_package_is_installed "$package_name"; then
    info "Reinstalling package '$package_name' to restore the missing extension SQL files." >&2
    run_elevated apt-get install --reinstall -y "$package_name" >&2
  else
    info "Installing package '$package_name'." >&2
    run_elevated apt-get install -y "$package_name" >&2
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_elevated systemctl restart postgresql >/dev/null 2>&1 || true
  fi

  if timescaledb_is_available_on_server && timescaledb_installation_scripts_are_present; then
    success "TimescaleDB package '$package_name' is available to PostgreSQL." >&2
    return 0
  fi

  warn "TimescaleDB package '$package_name' was installed, but PostgreSQL still cannot use the extension cleanly." >&2
  return 1
}

ensure_timescaledb_preloaded() {
  local postgres_major="$1"
  local conf_dir="/etc/postgresql/$postgres_major/main"
  local conf_file="$conf_dir/postgresql.conf"

  if [ ! -f "$conf_file" ]; then
    conf_file="$(run_as_postgres "psql -Atq -d postgres -c 'SHOW config_file;'" | tr -d '[:space:]')"
    if [ -z "$conf_file" ] || [ ! -f "$conf_file" ]; then
      warn 'Could not locate postgresql.conf to configure shared_preload_libraries.' >&2
      return 1
    fi
  fi

  if grep -Eq "^\s*shared_preload_libraries\s*=.*timescaledb" "$conf_file"; then
    return 0
  fi

  info "Adding timescaledb to shared_preload_libraries in $conf_file" >&2
  if grep -Eq "^\s*shared_preload_libraries\s*=" "$conf_file"; then
    run_elevated sed -i -E "s/^(\s*shared_preload_libraries\s*=\s*')/\1timescaledb,/" "$conf_file"
  elif grep -Eq "^#\s*shared_preload_libraries\s*=" "$conf_file"; then
    run_elevated sed -i -E "s/^#\s*shared_preload_libraries\s*=.*/shared_preload_libraries = 'timescaledb'/" "$conf_file"
  else
    printf "shared_preload_libraries = 'timescaledb'\n" | run_elevated tee -a "$conf_file" >/dev/null
  fi

  if command -v systemctl >/dev/null 2>&1; then
    info 'Restarting PostgreSQL to apply shared_preload_libraries change.' >&2
    run_elevated systemctl restart postgresql >/dev/null 2>&1 || true
  fi
}

ensure_timescaledb_for_local_database() {
  local database_name="$1"
  local postgres_major

  if ! command -v psql >/dev/null 2>&1; then
    return 1
  fi

  if ! local_database_exists "$database_name"; then
    warn "Local PostgreSQL database '$database_name' does not exist, so TimescaleDB could not be enabled automatically." >&2
    return 1
  fi

  postgres_major="$(get_postgres_server_major_version)"
  if [ -z "$postgres_major" ]; then
    warn 'PostgreSQL is installed, but the server major version could not be detected for TimescaleDB package installation.' >&2
    return 1
  fi

  install_timescaledb_package_for_local_postgres "$postgres_major" || return 1

  ensure_timescaledb_preloaded "$postgres_major" || return 1

  if timescaledb_is_enabled_for_database "$database_name"; then
    success "TimescaleDB is already enabled for database '$database_name'." >&2
    return 0
  fi

  run_as_postgres "psql -v ON_ERROR_STOP=1 -d \"$database_name\" -c \"CREATE EXTENSION IF NOT EXISTS timescaledb;\"" >/dev/null

  if timescaledb_is_enabled_for_database "$database_name"; then
    success "TimescaleDB was enabled for database '$database_name'." >&2
    return 0
  fi

  warn "TimescaleDB could not be enabled for database '$database_name'. Flux Monitor will continue with plain PostgreSQL tables." >&2
  return 1
}

maybe_provision_local_timescaledb_for_connection_string() {
  local connection_string="$1"
  local database_name

  if [ -z "$connection_string" ] || ! is_local_connection_string "$connection_string"; then
    return 0
  fi

  database_name="$(read_connection_string_database_name "$connection_string")"
  ensure_timescaledb_for_local_database "$database_name"
}

read_connection_string_from_configuration_file() {
  local config_path="$1"

  if [ ! -f "$config_path" ]; then
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$config_path" <<'PY'
import json
import sys

path = sys.argv[1]

try:
    with open(path, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)
except Exception:
    raise SystemExit(1)

monitor = payload.get('Monitor') if isinstance(payload, dict) else None
storage = monitor.get('Storage') if isinstance(monitor, dict) else None
connection_string = storage.get('ConnectionString') if isinstance(storage, dict) else None

if isinstance(connection_string, str) and connection_string.strip():
    print(connection_string.strip())
PY
    return
  fi

  grep -Eo '"ConnectionString"[[:space:]]*:[[:space:]]*"[^"]+"' "$config_path" \
    | head -n 1 \
    | sed -E 's/.*"ConnectionString"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/'
}

get_existing_runtime_connection_string() {
  local config_path
  local connection_string

  for config_path in \
    "$APP_ROOT/appsettings.Production.Local.json" \
    "$APP_ROOT/appsettings.Local.json" \
    "$APP_ROOT/appsettings.Development.Local.json"
  do
    connection_string="$(read_connection_string_from_configuration_file "$config_path")"
    if [ -n "$connection_string" ]; then
      printf '%s\n' "$connection_string"
      return
    fi
  done
}

bootstrap_local_postgres_connection_string() {
  local database_name='fluxmonitor'
  local role_name='fluxmonitor_app'
  local password
  password="$(generate_password)"

  section 'Bootstrapping local PostgreSQL' >&2

  if ! command -v psql >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then
      echo 'No PostgreSQL client was found and automatic PostgreSQL installation is only implemented for apt-based Linux systems.' >&2
      exit 1
    fi

    info 'Installing the local PostgreSQL server package.' >&2
    run_elevated apt-get update >&2
    run_elevated apt-get install -y postgresql >&2
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_elevated systemctl enable postgresql >/dev/null 2>&1 || true
    run_elevated systemctl start postgresql >/dev/null 2>&1 || true
  fi

  info "Creating or updating the local PostgreSQL role '$role_name' and database '$database_name'." >&2
  run_as_postgres "psql -v ON_ERROR_STOP=1 -d postgres -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role_name') THEN CREATE ROLE $role_name LOGIN PASSWORD '$password'; ELSE ALTER ROLE $role_name WITH LOGIN PASSWORD '$password'; END IF; END \\\$\\\$;\"" >/dev/null

  if [ "$(run_as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = '$database_name'\" postgres" | tr -d '[:space:]')" != '1' ]; then
    run_as_postgres "createdb -O $role_name $database_name" >/dev/null 2>&1 || true
  fi

  maybe_provision_local_timescaledb_for_connection_string "Host=127.0.0.1;Port=5432;Database=$database_name;Username=$role_name;Password=$password" || true

  printf 'Host=127.0.0.1;Port=5432;Database=%s;Username=%s;Password=%s\n' "$database_name" "$role_name" "$password"
}

get_configured_choice() {
  local configured_value="$1"
  local prompt="$2"
  local default_value="$3"

  if [ -n "$configured_value" ]; then
    case "${configured_value,,}" in
      y|yes|true|1)
        echo 'y'
        return
        ;;
      n|no|false|0)
        echo 'n'
        return
        ;;
    esac

    echo "Unsupported configured value '$configured_value' for $prompt." >&2
    exit 1
  fi

  read_validated_choice "$prompt" "$default_value"
}

install_local_runtime() {
  section 'Installing local ASP.NET Core runtime'
  mkdir -p "$LOCAL_DOTNET_ROOT"
  download_file 'https://dot.net/v1/dotnet-install.sh' "$INSTALL_SCRIPT"
  bash "$INSTALL_SCRIPT" --channel 10.0 --runtime aspnetcore --install-dir "$LOCAL_DOTNET_ROOT"
}

install_or_update_cloudflared_package() {
  local architecture
  local installed_version
  local package_path

  section 'Installing Cloudflare Tunnel connector'

  if command -v cloudflared >/dev/null 2>&1 && ! is_truthy "$NONINTERACTIVE_REFRESH_CLOUDFLARED"; then
    installed_version="$(cloudflared --version 2>/dev/null | head -n 1 || true)"

    if [ -n "$installed_version" ]; then
      info "cloudflared is already installed ($installed_version). Skipping package refresh."
    else
      info 'cloudflared is already installed. Skipping package refresh.'
    fi

    muted 'Set FLUXMONITOR_REFRESH_CLOUDFLARED=yes to force a package refresh.'
    CLOUDFLARED_PACKAGE_CHANGED='false'
    return 0
  fi

  if ! command -v dpkg >/dev/null 2>&1; then
    echo 'Automatic cloudflared installation requires dpkg on this Linux host.' >&2
    exit 1
  fi

  architecture="$(dpkg --print-architecture)"
  package_path="$TEMP_ROOT/cloudflared-linux-$architecture.deb"

  if is_truthy "$NONINTERACTIVE_REFRESH_CLOUDFLARED"; then
    info 'Forcing a cloudflared package refresh because FLUXMONITOR_REFRESH_CLOUDFLARED is enabled.'
  fi

  info 'Fetching the latest cloudflared package from Cloudflare.'
  download_file "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$architecture.deb" "$package_path"

  if ! run_elevated dpkg -i "$package_path" >&2; then
    if command -v apt-get >/dev/null 2>&1; then
      info 'Resolving cloudflared package dependencies.'
      run_elevated apt-get install -f -y >&2
      run_elevated dpkg -i "$package_path" >&2
    else
      exit 1
    fi
  fi

  CLOUDFLARED_PACKAGE_CHANGED='true'
}

install_or_update_speedtest_cli() {
  local fallback_path="$TEMP_ROOT/speedtest-cli"

  section 'Installing internet speed test tool'

  if command -v apt-get >/dev/null 2>&1; then
    info 'Installing or updating speedtest-cli from the system package repository.'
    if run_elevated apt-get update >&2 && run_elevated apt-get install -y speedtest-cli >&2; then
      return 0
    fi

    warn 'The package repository install failed. Falling back to the upstream speedtest-cli script.'
  else
    warn 'apt-get is not available on this host. Falling back to the upstream speedtest-cli script.'
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    warn 'python3 is required for the speedtest-cli fallback installation, but it is not available. Skipping this optional helper.'
    return 0
  fi

  info 'Installing the upstream speedtest-cli helper script to /usr/local/bin.'
  if ! try_download_file 'https://raw.githubusercontent.com/sivel/speedtest-cli/master/speedtest.py' "$fallback_path"; then
    warn 'The upstream speedtest-cli download failed. Continuing without updating that optional helper.'
    return 0
  fi

  chmod +x "$fallback_path"
  if ! run_elevated install -m 0755 "$fallback_path" /usr/local/bin/speedtest-cli; then
    warn 'The upstream speedtest-cli script could not be installed. Continuing without updating that optional helper.'
  fi
}

write_local_file_if_changed() {
  local source_path="$1"
  local target_path="$2"
  local file_mode="${3:-0644}"

  if [ -f "$target_path" ] && cmp -s "$source_path" "$target_path"; then
    return 1
  fi

  mkdir -p "$(dirname "$target_path")"
  install -m "$file_mode" "$source_path" "$target_path"
  return 0
}

write_elevated_file_if_changed() {
  local source_path="$1"
  local target_path="$2"
  local file_mode="${3:-0644}"

  if [ -f "$target_path" ] && run_elevated cmp -s "$source_path" "$target_path"; then
    return 1
  fi

  run_elevated mkdir -p "$(dirname "$target_path")"
  run_elevated install -m "$file_mode" "$source_path" "$target_path"
  return 0
}

build_cloudflared_start_script() {
  cat <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]; then
  echo 'Cloudflare Tunnel token is not configured.' >&2
  exit 64
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo 'cloudflared is not installed.' >&2
  exit 127
fi

exec "$(command -v cloudflared)" tunnel --no-autoupdate run --token "$CLOUDFLARED_TUNNEL_TOKEN"
EOF
}

write_cloudflared_start_script() {
  local temp_path="$TEMP_ROOT/cloudflared-run.sh"

  build_cloudflared_start_script > "$temp_path"

  if write_local_file_if_changed "$temp_path" "$CLOUDFLARED_START_SCRIPT_PATH" 0755; then
    CLOUDFLARED_START_SCRIPT_CHANGED='true'
  else
    CLOUDFLARED_START_SCRIPT_CHANGED='false'
  fi
}

build_systemd_polkit_rule() {
  local current_user="$1"

  cat <<EOF
polkit.addRule(function(action, subject) {
  if (subject.user !== '$current_user') {
    return;
  }

  var unit = action.lookup('unit');
  var verb = action.lookup('verb');

  if (action.id === 'org.freedesktop.systemd1.manage-units') {
    if (unit === '$TUNNEL_SERVICE_NAME'
        && ['start', 'stop', 'restart', 'reload-or-restart'].indexOf(verb) >= 0) {
      return polkit.Result.YES;
    }

    if ((unit === '$SSH_SERVICE_NAME' || unit === 'ssh')
        && ['start', 'stop', 'restart', 'reload-or-restart'].indexOf(verb) >= 0) {
      return polkit.Result.YES;
    }
  }

  if (action.id === 'org.freedesktop.systemd1.manage-unit-files') {
    if ((unit === '$SSH_SERVICE_NAME' || unit === 'ssh')
        && ['enable', 'disable', 'reenable'].indexOf(verb) >= 0) {
      return polkit.Result.YES;
    }
  }

  if (action.id === 'org.freedesktop.systemd1.reload-daemon') {
    return polkit.Result.YES;
  }
});
EOF
}

build_cloudflared_service_unit() {
  local current_user="$1"

  cat <<EOF
[Unit]
Description=Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$current_user
WorkingDirectory=$DESTINATION
EnvironmentFile=-$TUNNEL_ENV_PATH
ExecCondition=/bin/bash -lc '[ -n "\${CLOUDFLARED_TUNNEL_TOKEN:-}" ]'
ExecStart=$CLOUDFLARED_START_SCRIPT_PATH
Restart=on-failure
RestartSec=5
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF
}

build_networkmanager_wifi_powersave_config() {
  cat <<'EOF'
[connection]
wifi.powersave=2
EOF
}

disable_wifi_powersave_now() {
  local interfaces
  local interface_name

  if ! command -v iw >/dev/null 2>&1; then
    return 0
  fi

  interfaces="$(iw dev 2>/dev/null | awk '$1 == "Interface" { print $2 }' || true)"
  if [ -z "$interfaces" ]; then
    return 0
  fi

  while IFS= read -r interface_name; do
    if [ -z "$interface_name" ]; then
      continue
    fi

    run_elevated iw dev "$interface_name" set power_save off >/dev/null 2>&1 || true
  done <<EOF
$interfaces
EOF
}

configure_persistent_wifi_powersave_off() {
  local config_changed='false'
  local temp_path="$TEMP_ROOT/networkmanager-wifi-powersave-off.conf"

  build_networkmanager_wifi_powersave_config > "$temp_path"
  if write_elevated_file_if_changed "$temp_path" "$NETWORKMANAGER_WIFI_POWERSAVE_CONFIG_PATH" 0644; then
    config_changed='true'
  fi

  disable_wifi_powersave_now

  if [ "$config_changed" = 'true' ]; then
    info 'Configured NetworkManager to keep Wi-Fi power save disabled persistently.'
  else
    info 'NetworkManager Wi-Fi power-save override is already in place.'
  fi
}

install_or_update_mdns_support() {
  local host_name
  local hostname_url

  host_name="$(get_host_name)"
  hostname_url="$(get_hostname_access_url)"

  if [ -z "$host_name" ]; then
    warn 'Could not determine the device hostname. Skipping .local access configuration.'
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get is not available on this host. Skipping automatic mDNS package installation for $hostname_url."
    return 0
  fi

  info "Installing or updating mDNS support for $hostname_url."
  run_elevated apt-get update >&2
  run_elevated apt-get install -y avahi-daemon avahi-utils libnss-mdns >&2

  if command -v systemctl >/dev/null 2>&1; then
    run_elevated systemctl enable "$MDNS_SERVICE_NAME" >/dev/null 2>&1 || true
    run_elevated systemctl restart "$MDNS_SERVICE_NAME" >/dev/null 2>&1 || true
  fi

  if command -v avahi-resolve-host-name >/dev/null 2>&1; then
    if avahi-resolve-host-name -4 "$host_name.local" >/dev/null 2>&1; then
      success "mDNS hostname is active: $hostname_url"
      return 0
    fi

    warn "mDNS packages were installed, but $host_name.local did not resolve locally yet."
  fi
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
APP_BIND_URL="http://[::]:$APP_PORT"

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

get_host_name() {
  if command -v hostname >/dev/null 2>&1; then
    hostname 2>/dev/null | tr -d '[:space:]'
    return
  fi

  echo ""
}

get_hostname_access_url() {
  local host_name
  host_name="$(get_host_name)"

  if [ -n "$host_name" ]; then
    echo "http://$host_name.local:$APP_PORT"
    return
  fi

  echo ""
}

writable_config="$APP_ROOT/appsettings.Production.Local.json"

echo
echo 'Flux Monitor runtime configuration'
echo 'This helper updates the managed PostgreSQL connection string for the installed app.'

read -r -p 'PostgreSQL connection string: ' connection_string
while [ -z "$connection_string" ]; do
  echo 'A PostgreSQL connection string is required.'
  read -r -p 'PostgreSQL connection string: ' connection_string
done

cat > "$writable_config" <<JSON
{
  "Monitor": {
    "Storage": {
      "Provider": "TimescaleDb",
      "ConnectionString": "$connection_string"
    }
  }
}
JSON

cat > "$ENV_PATH" <<ENVVARS
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=$APP_BIND_URL
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

echo 'No devices are configured by this helper. Add them from the app after it starts.'
hostname_url="$(get_hostname_access_url)"
lan_url="$(get_access_url)"

if [ -n "$hostname_url" ]; then
  echo "Open $hostname_url from your PC once the service is running."
  if [ "$lan_url" != "$hostname_url" ]; then
    echo "If this PC does not resolve .local hostnames, use $lan_url instead."
  fi
else
  echo "Open $lan_url from your PC once the service is running."
fi
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
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://[::]:5074}"

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

install_cloudflared_service() {
  local current_user
  local polkit_changed='false'
  local service_changed='false'
  local service_enabled='false'
  local service_running='false'
  local polkit_temp_path="$TEMP_ROOT/cloudflared-systemd.rules"
  local service_temp_path="$TEMP_ROOT/cloudflared.service"
  current_user="$(id -un)"

  if [ -d /etc/polkit-1/rules.d ]; then
    build_systemd_polkit_rule "$current_user" > "$polkit_temp_path"
    if write_elevated_file_if_changed "$polkit_temp_path" "$SYSTEMD_POLKIT_RULE_PATH" 0644; then
      polkit_changed='true'
    fi
  fi

  build_cloudflared_service_unit "$current_user" > "$service_temp_path"
  if write_elevated_file_if_changed "$service_temp_path" "$TUNNEL_SERVICE_PATH" 0644; then
    service_changed='true'
  fi

  if run_elevated systemctl is-active --quiet "$TUNNEL_SERVICE_NAME"; then
    service_running='true'
  fi

  if run_elevated systemctl is-enabled "$TUNNEL_SERVICE_NAME" >/dev/null 2>&1; then
    service_enabled='true'
  fi

  if [ "$polkit_changed" = 'false' ] \
    && [ "$service_changed" = 'false' ] \
    && [ "$CLOUDFLARED_PACKAGE_CHANGED" = 'false' ] \
    && [ "$CLOUDFLARED_START_SCRIPT_CHANGED" = 'false' ] \
    && [ "$service_enabled" = 'true' ]; then
    if [ "$service_running" = 'true' ]; then
      info 'Managed cloudflared service is already up to date and running. Skipping reinstall.'
    else
      info 'Managed cloudflared service is already up to date. Skipping reinstall.'
    fi

    return 0
  fi

  if [ "$polkit_changed" = 'true' ] || [ "$service_changed" = 'true' ]; then
    run_elevated systemctl daemon-reload
  fi

  if [ "$service_enabled" = 'false' ]; then
    run_elevated systemctl enable "$TUNNEL_SERVICE_NAME" >/dev/null 2>&1 || true
  fi

  if [ "$service_running" = 'true' ] \
    && { [ "$service_changed" = 'true' ] \
      || [ "$CLOUDFLARED_PACKAGE_CHANGED" = 'true' ] \
      || [ "$CLOUDFLARED_START_SCRIPT_CHANGED" = 'true' ]; }; then
    info 'Restarting the managed cloudflared service to apply tunnel updates.'
    run_elevated systemctl restart "$TUNNEL_SERVICE_NAME" >/dev/null 2>&1 || true
  else
    info 'Managed cloudflared service configuration was checked. No tunnel restart was needed.'
  fi
}

install_systemd_service() {
  local current_user
  current_user="$(id -un)"

  if [ -d /etc/polkit-1/rules.d ]; then
    run_elevated tee "$NETWORKMANAGER_POLKIT_RULE_PATH" >/dev/null <<EOF
polkit.addRule(function(action, subject) {
  if (subject.user === '$current_user'
      && action.id.indexOf('org.freedesktop.NetworkManager.') === 0) {
    return polkit.Result.YES;
  }
});
EOF
  fi

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
TEMP_BASE="$(get_installer_temp_base "$DESTINATION")"
TEMP_ROOT="$TEMP_BASE/FluxMonitor-release-install-$(date +%s)-$$"
ARCHIVE_PATH="$TEMP_ROOT/$ASSET_NAME"
CHECKSUM_PATH="$TEMP_ROOT/$CHECKSUM_ASSET_NAME"
EXTRACT_PATH="$TEMP_ROOT/extract"
PRESERVE_PATH="$TEMP_ROOT/preserve"
INSTALL_SCRIPT="$TEMP_ROOT/dotnet-install-fluxmonitor-runtime.sh"

mkdir -p "$TEMP_BASE" "$TEMP_ROOT" "$EXTRACT_PATH" "$PRESERVE_PATH"

cleanup() {
  if [ -n "${BROWSER_PID:-}" ]; then
    kill "$BROWSER_PID" >/dev/null 2>&1 || true
  fi

  rm -rf "$TEMP_ROOT"
}

trap cleanup EXIT

section 'Flux Monitor release bootstrap'
muted "Repository: $NORMALIZED_REPOSITORY"
muted "Release tag: $RELEASE_TAG"
muted "Destination: $DESTINATION"
muted "Working folder: $TEMP_ROOT"

get_release_asset_download_url() {
  local asset_name="$1"
  printf 'https://github.com/%s/releases/download/%s/%s\n' "$NORMALIZED_REPOSITORY" "$RELEASE_TAG" "$asset_name"
}

section 'Downloading release artifact'
info 'Fetching the published build from GitHub Releases via direct asset URL.'
download_file "$(get_release_asset_download_url "$ASSET_NAME")" "$ARCHIVE_PATH"

section 'Verifying release artifact'
info 'Checking the published checksum before install.'
download_file "$(get_release_asset_download_url "$CHECKSUM_ASSET_NAME")" "$CHECKSUM_PATH"
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
IS_FIRST_INSTALL='true'
if [ -d "$DESTINATION" ]; then
  IS_FIRST_INSTALL='false'
  warn 'Existing installation found. Preserving local config and cached runtime.'
  preserve_existing_state "$DESTINATION" "$PRESERVE_PATH"
  rm -rf "$DESTINATION"
fi

mkdir -p "$DESTINATION"
mv "$EXTRACT_PATH/linux-arm64" "$APP_ROOT"
restore_preserved_state "$PRESERVE_PATH" "$DESTINATION"
normalize_release_runtime_configuration
write_release_info "$DOWNLOADED_RELEASE_SHA256"
if [ "$IS_FIRST_INSTALL" = 'true' ]; then
  write_install_audit \
    'release' \
    "$NORMALIZED_REPOSITORY" \
    '' \
    "$RELEASE_TAG" \
    "$ASSET_NAME" \
    "$DOWNLOADED_RELEASE_SHA256" \
    "$DESTINATION" \
    "$(id -un 2>/dev/null || echo unknown)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(hostname 2>/dev/null || echo unknown)"
fi
write_start_script
write_configure_script
write_cloudflared_start_script

install_or_update_cloudflared_package
install_or_update_speedtest_cli

section 'Checking ASP.NET Core runtime'
DOTNET_CMD="$(get_dotnet)"
if [ -z "$DOTNET_CMD" ]; then
  answer="$(get_configured_choice "$NONINTERACTIVE_INSTALL_RUNTIME" 'No compatible ASP.NET Core 10 runtime was found. Install a local copy into this folder?' 'y')"
  if [ "${answer,,}" != 'y' ]; then
    echo 'An ASP.NET Core 10 runtime is required to run this published build.'
    exit 1
  fi

  install_local_runtime
  DOTNET_CMD="$LOCAL_DOTNET"
fi

section 'Configuring first run'
reused_existing_configuration='false'

if has_reusable_runtime_configuration && { is_truthy "$NONINTERACTIVE_REUSE_EXISTING_CONFIGURATION" || ! [ -t 0 ]; }; then
  reused_existing_configuration='true'
  ENVIRONMENT="$(get_existing_environment_name)"
  if [ -z "$ENVIRONMENT" ]; then
    ENVIRONMENT='Production'
  fi
  info "Reusing the existing runtime configuration for $ENVIRONMENT."
  EXISTING_CONNECTION_STRING="$(get_existing_runtime_connection_string)"
elif has_existing_runtime_configuration; then
  info 'Existing runtime settings were found, but PostgreSQL is not configured. Rebuilding managed production configuration.'
else
  info 'Starting with storage configured and no preloaded devices.'
  muted 'Add devices later from the app once the web UI is running.'
fi
ENVIRONMENT="${ENVIRONMENT:-Production}"
TARGET_CONFIG="$APP_ROOT/appsettings.Production.Local.json"

if [ "$reused_existing_configuration" = 'false' ]; then
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
  maybe_provision_local_timescaledb_for_connection_string "$CONNECTION_STRING" || true
elif [ -n "${EXISTING_CONNECTION_STRING:-}" ]; then
  maybe_provision_local_timescaledb_for_connection_string "$EXISTING_CONNECTION_STRING" || true
fi

if [ "$reused_existing_configuration" = 'false' ] || [ ! -f "$ENV_PATH" ]; then
  write_env_file "$ENVIRONMENT"
fi

section 'Configuring Wi-Fi'
configure_persistent_wifi_powersave_off

section 'Configuring local hostname discovery'
install_or_update_mdns_support

ACCESS_URL="$(get_access_url 2>/dev/null)" || ACCESS_URL="$APP_LOCAL_URL"
ACCESS_URL="${ACCESS_URL:-$APP_LOCAL_URL}"
HOSTNAME_ACCESS_URL="$(get_hostname_access_url 2>/dev/null)" || HOSTNAME_ACCESS_URL=''

INSTALL_SERVICE='n'
if command -v systemctl >/dev/null 2>&1; then
  if ! [ -t 0 ] && [ -z "$NONINTERACTIVE_INSTALL_SERVICE" ]; then
    INSTALL_SERVICE='y'
  else
    INSTALL_SERVICE="$(get_configured_choice "$NONINTERACTIVE_INSTALL_SERVICE" 'Install and start a systemd service for headless operation?' 'y')"
  fi
fi

if [ "${INSTALL_SERVICE,,}" = 'y' ]; then
  section 'Installing Cloudflare Tunnel service'
  install_cloudflared_service

  section 'Installing systemd service'
  install_systemd_service

  section 'Starting Flux Monitor'
  info "Environment: $ENVIRONMENT"
  muted "Installed app root: $APP_ROOT"
  muted "Reusable launch command: $DESTINATION/start.sh"
  muted "Service file path: $SERVICE_PATH"
  if [ -n "$HOSTNAME_ACCESS_URL" ]; then
    success "Hostname access URL: $HOSTNAME_ACCESS_URL"
  fi
  success "Local access URL: $APP_LOCAL_URL"
  success "LAN access URL: $ACCESS_URL"
  muted 'Tip: most terminals let you Ctrl+Click the URL to open it.'
  muted 'No devices are preconfigured. Add them from the app after the first start.'

  if wait_for_health; then
    if [ -n "$HOSTNAME_ACCESS_URL" ]; then
      success "Flux Monitor is running under systemd. Open $HOSTNAME_ACCESS_URL from your PC."
      if [ "$HOSTNAME_ACCESS_URL" != "$ACCESS_URL" ]; then
        muted "If this PC does not resolve .local hostnames, use $ACCESS_URL instead."
      fi
    else
      success "Flux Monitor is running under systemd. Open $ACCESS_URL from your PC."
    fi
  else
    echo 'The systemd service was installed, but the health endpoint did not become ready in time.' >&2
    echo "Inspect service logs with: sudo journalctl -u $SERVICE_NAME -n 200 --no-pager" >&2
    exit 1
  fi

  exit 0
fi

section 'Starting Flux Monitor'
info "Environment: $ENVIRONMENT"
muted "Installed app root: $APP_ROOT"
muted "Reusable launch command: $DESTINATION/start.sh"
muted "Service file path: $SERVICE_PATH"
if [ -n "$HOSTNAME_ACCESS_URL" ]; then
  success "Hostname access URL: $HOSTNAME_ACCESS_URL"
fi
success "Local access URL: $APP_LOCAL_URL"
success "LAN access URL: $ACCESS_URL"
muted 'Tip: most terminals let you Ctrl+Click the URL to open it.'
muted 'No devices are preconfigured. Add them from the app after the first start.'

info "Opening $APP_LOCAL_URL on the device after the backend is ready."
if [ -n "$HOSTNAME_ACCESS_URL" ]; then
  success "From your PC, open $HOSTNAME_ACCESS_URL once the device is reachable on your network."
  if [ "$HOSTNAME_ACCESS_URL" != "$ACCESS_URL" ]; then
    muted "If this PC does not resolve .local hostnames, use $ACCESS_URL instead."
  fi
else
  success "From your PC, open $ACCESS_URL once the device is reachable on your network."
fi
muted 'Tip: Ctrl+Click usually works directly from the terminal output.'

BROWSER_PID=''
open_browser_when_ready

cd "$APP_ROOT"
ASPNETCORE_ENVIRONMENT="$ENVIRONMENT" ASPNETCORE_URLS="$APP_BIND_URL" "$DOTNET_CMD" ./FluxMonitor.Backend.dll
