#!/bin/sh
# Runs one scheduled pgBackRest backup inside the running postgres container.
# Called by lunchlineup-pgbackrest-backup@<repo>-<type>.service under the deploy flock.
# Instance names: repo2-full, repo2-diff, repo3-full, repo3-diff. The backup targets only
# that repository (--repo=N), so repo2 (NAS) and repo3 (GCS) are independent.
set -eu

INSTANCE="${1:-}"
case "$INSTANCE" in
  repo2-full|repo2-diff|repo3-full|repo3-diff) ;;
  *) echo "run-pgbackrest-backup: instance must be repo2-full|repo2-diff|repo3-full|repo3-diff, got '$INSTANCE'" >&2; exit 1 ;;
esac
REPO="${INSTANCE%%-*}"; REPO_N="${REPO#repo}"; TYPE="${INSTANCE#*-}"

E="${LUNCHLINEUP_RUNTIME_ENV:-/opt/lunchlineup-secrets/runtime.env}"
CONTAINER="${LUNCHLINEUP_POSTGRES_CONTAINER:-lunchlineup-postgres-1}"
[ -r "$E" ] || { echo "runtime env not readable: $E" >&2; exit 1; }

# Read (never source) single values.
val() { sed -n "s/^$1=//p" "$E" | tail -n 1 | tr -d "\"' \r"; }
[ "$(val PGBACKREST_ENABLED)" = "true" ] || { echo "PGBACKREST_ENABLED is not true in $E" >&2; exit 1; }
if [ "$REPO_N" = "3" ] && [ "$(val PGBACKREST_REPO3_ENABLED)" != "true" ]; then
  echo "PGBACKREST_REPO3_ENABLED is not true in $E; refusing repo3 backup" >&2; exit 1
fi
STANZA="$(val PGBACKREST_STANZA)"
printf '%s' "$STANZA" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,63}$' || { echo "PGBACKREST_STANZA is missing or invalid" >&2; exit 1; }

echo "pgBackRest $TYPE backup to repo$REPO_N (stanza $STANZA, container $CONTAINER)"
exec docker exec -u postgres "$CONTAINER" pgbackrest "--stanza=$STANZA" "--repo=$REPO_N" "--type=$TYPE" backup
