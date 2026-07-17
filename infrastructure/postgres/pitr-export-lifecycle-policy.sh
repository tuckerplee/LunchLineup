#!/bin/sh
# Exports the live bucket lifecycle configuration through a read-only audit identity.
set -eu
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/pitr-object-store.sh"

PITR_MC_CONFIG_DIR=""
cleanup() {
  pitr_close_object_store
}
trap cleanup EXIT HUP INT TERM

pitr_open_object_store
BUCKET_ROOT="pitr/$PITR_S3_BUCKET"
pitr_mc ilm rule export "$BUCKET_ROOT"
