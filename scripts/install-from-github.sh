#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/BieleckiLtd/JkMonitorV2}"
BRANCH="${2:-dev}"
DESTINATION="${3:-$HOME/fluxmonitor}"

section() {
  echo
  echo "$1"
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

copy_if_exists() {
  local source_path="$1"
  local target_path="$2"

  if [ ! -e "$source_path" ]; then
    return
  fi

  mkdir -p "$(dirname "$target_path")"
  cp -R "$source_path" "$target_path"
}

copy_first_existing() {
  local target_path="$1"
  shift

  for source_path in "$@"; do
    if [ ! -e "$source_path" ]; then
      continue
    fi

    copy_if_exists "$source_path" "$target_path"
    return
  done
}

preserve_existing_state() {
  local source_root="$1"
  local preserve_root="$2"

  copy_if_exists "$source_root/.dotnet" "$preserve_root/.dotnet"
  copy_first_existing "$preserve_root/src/FluxMonitor.Backend/notifications.json" \
    "$source_root/src/FluxMonitor.Backend/notifications.json" \
    "$source_root/src/backend/FluxMonitor.Backend/notifications.json"
  copy_first_existing "$preserve_root/src/FluxMonitor.Backend/appsettings.Local.json" \
    "$source_root/src/FluxMonitor.Backend/appsettings.Local.json" \
    "$source_root/src/backend/FluxMonitor.Backend/appsettings.Local.json"
  copy_first_existing "$preserve_root/src/FluxMonitor.Backend/appsettings.Development.Local.json" \
    "$source_root/src/FluxMonitor.Backend/appsettings.Development.Local.json" \
    "$source_root/src/backend/FluxMonitor.Backend/appsettings.Development.Local.json"
  copy_first_existing "$preserve_root/src/FluxMonitor.Backend/appsettings.Production.Local.json" \
    "$source_root/src/FluxMonitor.Backend/appsettings.Production.Local.json" \
    "$source_root/src/backend/FluxMonitor.Backend/appsettings.Production.Local.json"
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

  if [ -f "$preserve_root/src/FluxMonitor.Backend/notifications.json" ]; then
    mkdir -p "$destination_root/src/FluxMonitor.Backend"
    cp "$preserve_root/src/FluxMonitor.Backend/notifications.json" "$destination_root/src/FluxMonitor.Backend/notifications.json"
  fi

  for file in \
    "$preserve_root/src/FluxMonitor.Backend/appsettings.Local.json" \
    "$preserve_root/src/FluxMonitor.Backend/appsettings.Development.Local.json" \
    "$preserve_root/src/FluxMonitor.Backend/appsettings.Production.Local.json"
  do
    if [ -f "$file" ]; then
      local relative_path="${file#"$preserve_root"/}"
      mkdir -p "$(dirname "$destination_root/$relative_path")"
      cp "$file" "$destination_root/$relative_path"
    fi
  done
}

NORMALIZED_REPOSITORY="$(normalize_repository "$REPOSITORY")"

ZIP_URL="https://github.com/$NORMALIZED_REPOSITORY/archive/refs/heads/$BRANCH.zip"
TEMP_BASE="$(get_installer_temp_base "$DESTINATION")"
TEMP_ROOT="$TEMP_BASE/FluxMonitor-install-$(date +%s)-$$"
ZIP_PATH="$TEMP_ROOT/repo.zip"
EXTRACT_PATH="$TEMP_ROOT/extract"
PRESERVE_PATH="$TEMP_ROOT/preserve"

mkdir -p "$TEMP_BASE" "$TEMP_ROOT" "$EXTRACT_PATH" "$PRESERVE_PATH"

cleanup() {
  rm -rf "$TEMP_ROOT"
}

trap cleanup EXIT

section "Flux Monitor GitHub bootstrap"
echo "Repository: $NORMALIZED_REPOSITORY"
echo "Branch: $BRANCH"
echo "Destination: $DESTINATION"
echo "Working folder: $TEMP_ROOT"

section "Downloading source archive"
curl -fsSL "$ZIP_URL" -o "$ZIP_PATH"

section "Extracting archive"
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP_PATH" -d "$EXTRACT_PATH"
else
  python3 - <<PY
import zipfile
with zipfile.ZipFile(r"$ZIP_PATH") as zf:
    zf.extractall(r"$EXTRACT_PATH")
PY
fi

SOURCE_ROOT="$(find "$EXTRACT_PATH" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$SOURCE_ROOT" ]; then
  echo 'The downloaded archive did not contain a repository root folder.'
  exit 1
fi

section "Preparing installation folder"
if [ -d "$DESTINATION" ]; then
  echo 'Existing installation found. Preserving local config and cached toolchain.'
  preserve_existing_state "$DESTINATION" "$PRESERVE_PATH"
  rm -rf "$DESTINATION"
fi

mkdir -p "$(dirname "$DESTINATION")"
mv "$SOURCE_ROOT" "$DESTINATION"
restore_preserved_state "$PRESERVE_PATH" "$DESTINATION"

if [ ! -f "$DESTINATION/scripts/setup.sh" ]; then
  echo 'The repository does not contain scripts/setup.sh.'
  exit 1
fi

section "Starting guided setup"
cd "$DESTINATION"
bash ./scripts/setup.sh
