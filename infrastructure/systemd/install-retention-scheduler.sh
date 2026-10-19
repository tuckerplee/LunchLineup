#!/bin/sh
# Installs and verifies the containerized retention scheduler units on VM107.
# It copies the four units, checks prerequisites, runs systemd-analyze verify and
# daemon-reload. It NEVER enables or starts a timer or service: enabling is a
# separate owner decision (see README.md).
#
# Usage (as root, from the release checkout on the VM):
#   sh infrastructure/systemd/install-retention-scheduler.sh [--grant-textfile-acl]
# --grant-textfile-acl adds an ACL entry for the container uid on the estate
# textfile collector directory when it is not already writable by that uid.
set -eu

ROOT="${LUNCHLINEUP_ROOT:-/opt/lunchlineup}"
E="${LUNCHLINEUP_RUNTIME_ENV:-/opt/lunchlineup-secrets/runtime.env}"
UID_C="${RETENTION_PURGE_UID:-1000}"
# Same lookup as run-retention-scheduler.sh: the textfile dir is writable through node-exp.
GID_C="${RETENTION_PURGE_GID:-$(getent group node-exp | cut -d: -f3)}"
[ -n "$GID_C" ] || { echo "install-retention-scheduler: group node-exp not found; set RETENTION_PURGE_GID" >&2; exit 1; }
PROOFS="${RETENTION_PROOF_DIR:-/var/lib/lunchlineup/proofs}"
TEXTFILE="${RETENTION_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
SRC="$ROOT/infrastructure/systemd"
DEST=/etc/systemd/system
UNITS="lunchlineup-retention-purge.service lunchlineup-retention-purge.timer lunchlineup-retained-record-review.service lunchlineup-retained-record-review.timer"
grant_acl=false
[ "${1:-}" = "--grant-textfile-acl" ] && grant_acl=true

fail() { echo "install-retention-scheduler: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "run as root"
command -v docker >/dev/null 2>&1 || fail "docker not found"
command -v flock >/dev/null 2>&1 || fail "flock not found"
command -v systemd-analyze >/dev/null 2>&1 || fail "systemd-analyze not found"
[ -r "$E" ] || fail "runtime env not readable: $E"
for u in $UNITS run-retention-scheduler.sh; do [ -f "$SRC/$u" ] || fail "missing $SRC/$u"; done

# Retention token: the compose secret file must be readable by the container uid.
token="$(sed -n 's/^RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE=//p' "$E" | tail -n 1 | tr -d "\"' \r")"
[ -n "$token" ] || fail "RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE is not set in $E"
[ -s "$token" ] || fail "retention token file missing or empty: $token"
setpriv --reuid="$UID_C" --regid="$GID_C" --clear-groups test -r "$token" \
  || fail "retention token file $token is not readable by uid $UID_C:$GID_C"

# Proof directory (ours): create if absent, owned by the container uid.
install -d -o "$UID_C" -g "$GID_C" -m 0750 "$PROOFS"

# Textfile collector directory (estate-owned): never create; verify writable.
[ -d "$TEXTFILE" ] || fail "textfile collector directory missing: $TEXTFILE"
if ! setpriv --reuid="$UID_C" --regid="$GID_C" --clear-groups test -w "$TEXTFILE"; then
  if [ "$grant_acl" = "true" ]; then
    command -v setfacl >/dev/null 2>&1 || fail "setfacl not found (install package acl)"
    setfacl -m "u:$UID_C:rwx" "$TEXTFILE"
  else
    fail "$TEXTFILE is not writable by uid $UID_C; fix ownership or re-run with --grant-textfile-acl"
  fi
fi

for u in $UNITS; do install -m 0644 "$SRC/$u" "$DEST/$u"; done
(cd "$DEST" && systemd-analyze verify $UNITS)
systemctl daemon-reload

# Confirm Compose resolves the profile-gated service and the migrate image is present locally.
set -- docker compose --project-name lunchlineup --project-directory "$ROOT" --env-file "$E" \
  -f docker-compose.yml -f infrastructure/development-admission/compose.private-proxy.yml
pgbackrest="$(sed -n 's/^PGBACKREST_ENABLED=//p' "$E" | tail -n 1 | tr -d "\"' \r")"
[ "$pgbackrest" = "true" ] && set -- "$@" -f infrastructure/postgres/compose.pgbackrest.yml
(cd "$ROOT" && COMPOSE_SERVICE_ENV_FILE="$E" "$@" --profile ops config --quiet)
image="$(cd "$ROOT" && COMPOSE_SERVICE_ENV_FILE="$E" "$@" --profile ops config --format json \
  | sed -n 's/.*"image": *"\([^"]*\/migrate:[^"]*\)".*/\1/p' | head -n 1)"
[ -n "$image" ] || fail "could not resolve the migrate image reference"
docker image inspect "$image" >/dev/null 2>&1 || fail "migrate image not present locally: $image"

echo "Installed and verified (NOT enabled): $UNITS"
echo "Owner decision to enable: systemctl enable --now lunchlineup-retention-purge.timer lunchlineup-retained-record-review.timer"
