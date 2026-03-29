#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_ROOT/install-from-release.sh"
DESTINATION="$(cd "$SCRIPT_ROOT/.." && pwd)"

if [ ! -f "$INSTALLER" ]; then
  echo 'The release installer script was not found next to update-from-release.sh.'
  exit 1
fi

bash "$INSTALLER" "https://github.com/BieleckiLtd/JkMonitorV2" "dev-latest" "$DESTINATION"