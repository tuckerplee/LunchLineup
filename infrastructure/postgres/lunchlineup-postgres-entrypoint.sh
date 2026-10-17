#!/bin/sh
# LunchLineup postgres entrypoint wrapper (baked into the postgres image).
#
# Default (LL_PGBR_ENABLED unset or not "true"): exec the stock entrypoint with no
# change. No pgBackRest config is rendered, archive_mode stays whatever compose set
# (off) and nothing touches the network.
#
# LL_PGBR_ENABLED=true (set only by infrastructure/postgres/compose.pgbackrest.yml):
# validate every required setting and mounted file, FAIL CLOSED (exit 1, container
# does not start) on anything missing, render a pgBackRest config plus the SFTP key,
# known_hosts and cipher material into the postgres-owned tmpfs /run/pgbackrest,
# force archive_mode=on with the pgBackRest archive_command, then hand over to the
# stock entrypoint. When the first argument is "pgbackrest" (restore through
# `docker compose run`), the command runs as the postgres user.
set -eu

DEST="${LL_PGBR_RUNTIME_DIR:-/run/pgbackrest}"
SRC="${LL_PGBR_SOURCE_DIR:-/run/pgbackrest-src}"
CONF="$DEST/pgbackrest.conf"

fatal() { echo "lunchlineup-postgres-entrypoint: FATAL: $*" >&2; exit 1; }

if [ "${LL_PGBR_ENABLED:-false}" != "true" ]; then
  if [ "${1:-}" = "pgbackrest" ]; then
    fatal "pgBackRest is not enabled (set PGBACKREST_ENABLED=true and include infrastructure/postgres/compose.pgbackrest.yml)"
  fi
  exec docker-entrypoint.sh "$@"
fi

[ "$(id -u)" = "0" ] || fatal "must start as root to prepare pgBackRest material"
[ -d "$DEST" ] || fatal "$DEST (tmpfs) is not mounted"

need() { # name value regex
  [ -n "$2" ] || fatal "$1 is required when PGBACKREST_ENABLED=true"
  printf '%s' "$2" | grep -Eq "$3" || fatal "$1 has an invalid value"
}
need_file() { # name path
  [ -f "$2" ] && [ -r "$2" ] && [ -s "$2" ] || fatal "$1: mounted file $2 is missing, empty or unreadable"
}

STANZA="${LL_PGBR_STANZA:-}"
HOST="${LL_PGBR_SFTP_HOST:-}"
PORT="${LL_PGBR_SFTP_PORT:-22}"
SFTP_USER="${LL_PGBR_SFTP_USER:-}"
REPO_PATH="${LL_PGBR_REPO_PATH:-}"
RET_FULL="${LL_PGBR_RETENTION_FULL:-4}"
RET_DIFF="${LL_PGBR_RETENTION_DIFF:-7}"
PG_USER="${LL_PGBR_PG_USER:-}"

need PGBACKREST_STANZA "$STANZA" '^[a-z0-9][a-z0-9_-]{0,63}$'
need PGBACKREST_SFTP_HOST "$HOST" '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'
need PGBACKREST_SFTP_PORT "$PORT" '^[0-9]{1,5}$'
need PGBACKREST_SFTP_USER "$SFTP_USER" '^[a-z_][a-z0-9_-]{0,31}$'
need PGBACKREST_REPO_PATH "$REPO_PATH" '^/[A-Za-z0-9._/-]{0,255}$'
need PGBACKREST_RETENTION_FULL "$RET_FULL" '^[0-9]{1,3}$'
need PGBACKREST_RETENTION_DIFF "$RET_DIFF" '^[0-9]{1,3}$'
need POSTGRES_USER "$PG_USER" '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
need_file PGBACKREST_SFTP_KEY_FILE "$SRC/sftp_key"
need_file PGBACKREST_SFTP_KNOWN_HOSTS_FILE "$SRC/known_hosts"
need_file PGBACKREST_CIPHER_PASS_FILE "$SRC/cipher_pass"
grep -Eq 'PRIVATE KEY' "$SRC/sftp_key" || fatal "PGBACKREST_SFTP_KEY_FILE does not look like a private key"
grep -Eq '^\|1\|' "$SRC/known_hosts" \
  || grep -Eq "(^|[ ,])($HOST|\[$HOST\]:$PORT)[ ,]" "$SRC/known_hosts" \
  || fatal "PGBACKREST_SFTP_KNOWN_HOSTS_FILE has no entry for $HOST (port $PORT); host key checking is strict"

umask 077
install -d -o postgres -g postgres -m 0700 "$DEST/lock"
install -o postgres -g postgres -m 0600 "$SRC/sftp_key" "$DEST/sftp_key"
install -o postgres -g postgres -m 0600 "$SRC/known_hosts" "$DEST/known_hosts"
CIPHER_PASS="$(tr -d '\r\n' < "$SRC/cipher_pass")"
[ -n "$CIPHER_PASS" ] || fatal "PGBACKREST_CIPHER_PASS_FILE holds no passphrase"
case "$CIPHER_PASS" in *[!A-Za-z0-9_.@%+=,:/-]*) fatal "PGBACKREST_CIPHER_PASS_FILE: use only [A-Za-z0-9_.@%+=,:/-] (e.g. 'openssl rand -hex 32')" ;; esac

{
  echo "[global]"
  echo "log-path=/var/log/pgbackrest"
  echo "spool-path=/var/spool/pgbackrest"
  echo "lock-path=$DEST/lock"
  echo "log-level-console=warn"
  echo "log-level-file=info"
  echo "start-fast=y"
  echo "archive-async=y"
  echo "compress-type=zst"
  echo "process-max=2"
  echo "repo2-type=sftp"
  echo "repo2-path=$REPO_PATH"
  echo "repo2-sftp-host=$HOST"
  echo "repo2-sftp-host-port=$PORT"
  echo "repo2-sftp-host-user=$SFTP_USER"
  echo "repo2-sftp-private-key-file=$DEST/sftp_key"
  echo "repo2-sftp-known-host=$DEST/known_hosts"
  echo "repo2-sftp-host-key-check-type=strict"
  echo "repo2-sftp-host-key-hash-type=sha256"
  echo "repo2-retention-full-type=count"
  echo "repo2-retention-full=$RET_FULL"
  echo "repo2-retention-diff=$RET_DIFF"
  echo "repo2-cipher-type=aes-256-cbc"
  echo "repo2-cipher-pass=$CIPHER_PASS"
  echo
  echo "[$STANZA]"
  echo "pg1-path=${PGDATA:-/var/lib/postgresql/data}"
  echo "pg1-socket-path=/var/run/postgresql"
  echo "pg1-user=$PG_USER"
} > "$CONF"
chown postgres:postgres "$CONF"
chmod 0600 "$CONF"
unset CIPHER_PASS

if [ "${1:-}" = "pgbackrest" ]; then
  exec su-exec postgres "$@"
fi
if [ "${1:-}" = "postgres" ]; then
  # Later -c options win over the compose defaults (archive_mode=off, /bin/false).
  set -- "$@" -c archive_mode=on -c "archive_command=pgbackrest --stanza=$STANZA archive-push %p"
fi
exec docker-entrypoint.sh "$@"
