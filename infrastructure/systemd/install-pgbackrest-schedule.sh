#!/bin/sh
# Installs and verifies the pgBackRest backup schedule units on the VM. It copies the
# service template and the repo2 timers (always) plus the repo3 timers (only when
# PGBACKREST_REPO3_ENABLED=true), runs systemd-analyze verify and daemon-reload.
# It NEVER enables or starts a timer or service: enabling is a separate owner decision.
#
# Usage (as root, from the release checkout on the VM):
#   sh infrastructure/systemd/install-pgbackrest-schedule.sh
set -eu

ROOT="${LUNCHLINEUP_ROOT:-/opt/lunchlineup}"
E="${LUNCHLINEUP_RUNTIME_ENV:-/opt/lunchlineup-secrets/runtime.env}"
CONTAINER="${LUNCHLINEUP_POSTGRES_CONTAINER:-lunchlineup-postgres-1}"
SRC="$ROOT/infrastructure/systemd"
DEST=/etc/systemd/system
fail() { echo "install-pgbackrest-schedule: $*" >&2; exit 1; }
val() { sed -n "s/^$1=//p" "$E" | tail -n 1 | tr -d "\"' \r"; }

[ "$(id -u)" = "0" ] || fail "run as root"
command -v docker >/dev/null 2>&1 || fail "docker not found"
command -v flock >/dev/null 2>&1 || fail "flock not found"
command -v systemd-analyze >/dev/null 2>&1 || fail "systemd-analyze not found"
[ -r "$E" ] || fail "runtime env not readable: $E"
[ "$(val PGBACKREST_ENABLED)" = "true" ] || fail "PGBACKREST_ENABLED is not true in $E"
printf '%s' "$(val PGBACKREST_STANZA)" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,63}$' || fail "PGBACKREST_STANZA is missing or invalid in $E"

UNITS="lunchlineup-pgbackrest-backup@.service lunchlineup-pgbackrest-repo2-full.timer lunchlineup-pgbackrest-repo2-diff.timer"
if [ "$(val PGBACKREST_REPO3_ENABLED)" = "true" ]; then
  UNITS="$UNITS lunchlineup-pgbackrest-repo3-full.timer lunchlineup-pgbackrest-repo3-diff.timer"
  repo3=true
else
  repo3=false
fi
for u in $UNITS run-pgbackrest-backup.sh; do [ -f "$SRC/$u" ] || fail "missing $SRC/$u"; done

for u in $UNITS; do install -m 0644 "$SRC/$u" "$DEST/$u"; done
(cd "$DEST" && systemd-analyze verify $UNITS lunchlineup-pgbackrest-backup@repo2-full.service)
systemctl daemon-reload

# Warn only: the container may legitimately be down during an install.
docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 \
  || echo "install-pgbackrest-schedule: WARNING: container $CONTAINER not found; set LUNCHLINEUP_POSTGRES_CONTAINER if the name differs" >&2

echo "Installed and verified (NOT enabled): $UNITS"
echo "Owner decision to enable: systemctl enable --now lunchlineup-pgbackrest-repo2-full.timer lunchlineup-pgbackrest-repo2-diff.timer"
[ "$repo3" = "true" ] && echo "  and for offsite: systemctl enable --now lunchlineup-pgbackrest-repo3-full.timer lunchlineup-pgbackrest-repo3-diff.timer"
exit 0
