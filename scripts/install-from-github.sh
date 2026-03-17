#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:-https://github.com/BieleckiLtd/JkMonitorV2}"
BRANCH="${2:-dev}"
DESTINATION="${3:-$HOME/jkmonitor}"

section() {
  echo
  echo "$1"
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

preserve_existing_state() {
  local source_root="$1"
  local preserve_root="$2"

  copy_if_exists "$source_root/.dotnet" "$preserve_root/.dotnet"
  copy_if_exists "$source_root/src/backend/JkMonitor.Backend/appsettings.Local.json" "$preserve_root/src/backend/JkMonitor.Backend/appsettings.Local.json"
  copy_if_exists "$source_root/src/backend/JkMonitor.Backend/appsettings.Development.Local.json" "$preserve_root/src/backend/JkMonitor.Backend/appsettings.Development.Local.json"
  copy_if_exists "$source_root/src/backend/JkMonitor.Backend/appsettings.Production.Local.json" "$preserve_root/src/backend/JkMonitor.Backend/appsettings.Production.Local.json"
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

  for file in \
    "$preserve_root/src/backend/JkMonitor.Backend/appsettings.Local.json" \
    "$preserve_root/src/backend/JkMonitor.Backend/appsettings.Development.Local.json" \
    "$preserve_root/src/backend/JkMonitor.Backend/appsettings.Production.Local.json"
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
TEMP_ROOT="${TMPDIR:-/tmp}/jkmonitor-install-$(date +%s)-$$"
ZIP_PATH="$TEMP_ROOT/repo.zip"
EXTRACT_PATH="$TEMP_ROOT/extract"
PRESERVE_PATH="$TEMP_ROOT/preserve"

mkdir -p "$TEMP_ROOT" "$EXTRACT_PATH" "$PRESERVE_PATH"

cleanup() {
  rm -rf "$TEMP_ROOT"
}

trap cleanup EXIT

section "JK Monitor GitHub bootstrap"
echo "Repository: $NORMALIZED_REPOSITORY"
echo "Branch: $BRANCH"
echo "Destination: $DESTINATION"

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