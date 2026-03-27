#!/usr/bin/env bash
set -euo pipefail

DESTINATION="${1:-$HOME/fluxmonitor}"
SERVICE_NAME='fluxmonitor.service'
SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"

run_elevated() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

echo
echo 'Uninstalling Flux Monitor release deployment'
echo "Destination: $DESTINATION"

if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q "^$SERVICE_NAME"; then
    run_elevated systemctl stop "$SERVICE_NAME" || true
    run_elevated systemctl disable "$SERVICE_NAME" || true
    run_elevated rm -f "$SERVICE_PATH"
    run_elevated systemctl daemon-reload
  fi
fi

rm -rf "$DESTINATION"

echo 'Flux Monitor release deployment removed.'