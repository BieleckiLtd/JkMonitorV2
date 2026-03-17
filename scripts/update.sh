#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_ROOT/.." && pwd)"
INSTALLER="$SCRIPT_ROOT/install-from-github.sh"

if [ ! -f "$INSTALLER" ]; then
  echo 'The GitHub installer script was not found next to update.sh.'
  exit 1
fi

bash "$INSTALLER" "https://github.com/BieleckiLtd/JkMonitorV2" "dev" "$REPO_ROOT"