#!/usr/bin/env bash
# Upgrades TimescaleDB from the Apache 2 (OSS) edition to the Community (TSL) edition.
# The Community edition supports native compression which significantly reduces storage.
# Run on the device: sudo bash scripts/upgrade-timescaledb-community.sh
set -euo pipefail

section() { echo; echo "── $1"; }
info()    { echo "   $1"; }
success() { echo "✓  $1"; }
warn()    { echo "⚠  $1"; }

TIMESCALE_REPOSITORY_SETUP_URL='https://packagecloud.io/install/repositories/timescale/timescaledb/script.deb.sh'

run_as_postgres() {
  local cmd="$1"
  if [ "$(id -un)" = 'postgres' ]; then
    bash -c "$cmd"
  else
    sudo -u postgres bash -c "$cmd"
  fi
}

get_postgres_server_major_version() {
  local version_num
  version_num="$(run_as_postgres "psql -Atq -d postgres -c 'SHOW server_version_num;'" | tr -d '[:space:]')"
  if [[ ! "$version_num" =~ ^[0-9]{5,6}$ ]]; then
    return
  fi
  printf '%s\n' "${version_num%????}"
}

get_current_timescaledb_license() {
  run_as_postgres "psql -Atq -d postgres -c \"SHOW timescaledb.license;\"" 2>/dev/null | tr -d '[:space:]'
}

section "TimescaleDB Community Edition upgrade"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root (use sudo)."
  exit 1
fi

POSTGRES_MAJOR="$(get_postgres_server_major_version)"
if [ -z "$POSTGRES_MAJOR" ]; then
  echo "Could not detect PostgreSQL server version."
  exit 1
fi
info "PostgreSQL major version: $POSTGRES_MAJOR"

CURRENT_LICENSE="$(get_current_timescaledb_license)"
info "Current TimescaleDB license: ${CURRENT_LICENSE:-unknown}"

if [ "$CURRENT_LICENSE" = "timescale" ]; then
  success "Already running TimescaleDB Community Edition. Nothing to do."
  exit 0
fi

OSS_PACKAGE="timescaledb-2-oss-postgresql-$POSTGRES_MAJOR"
COMMUNITY_PACKAGE="timescaledb-2-postgresql-$POSTGRES_MAJOR"

section "Setting up TimescaleDB apt repository"
TEMP_SCRIPT="$(mktemp)"
curl -fsSL "$TIMESCALE_REPOSITORY_SETUP_URL" -o "$TEMP_SCRIPT"
bash "$TEMP_SCRIPT"
rm -f "$TEMP_SCRIPT"
apt-get update

section "Replacing OSS package with Community package"
if dpkg -l "$OSS_PACKAGE" 2>/dev/null | grep -q "^ii"; then
  info "Removing $OSS_PACKAGE"
  apt-get remove -y "$OSS_PACKAGE"
fi

info "Installing $COMMUNITY_PACKAGE"
apt-get install -y "$COMMUNITY_PACKAGE"

section "Restarting PostgreSQL"
systemctl restart postgresql

NEW_LICENSE="$(get_current_timescaledb_license)"
info "TimescaleDB license after upgrade: ${NEW_LICENSE:-unknown}"

if [ "$NEW_LICENSE" = "timescale" ]; then
  success "Upgrade complete. TimescaleDB Community Edition is active."
  info "Native compression is now available. The app will enable it on next startup."
else
  warn "Package was installed but license did not change to 'timescale'."
  warn "You may need to update timescaledb.license in postgresql.conf and restart."
fi
