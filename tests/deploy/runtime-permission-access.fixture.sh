#!/bin/sh
set -eu

[ "$#" -eq 2 ] || { echo "usage: runtime-permission-access.fixture.sh DEPLOY_SCRIPT ROLLBACK_ACTIVATOR" >&2; exit 64; }
deploy_script="$1"
rollback_activator="$2"

[ "$(id -u)" = "0" ] || { echo "fixture requires root" >&2; exit 77; }
command -v setpriv >/dev/null
test -r "$deploy_script"
test -r "$rollback_activator"
service_user="nobody"
service_uid="$(id -u "$service_user")"
service_gid="$(id -g "$service_user")"
[ "$service_uid" != "0" ]
[ "$service_gid" != "0" ]

scratch="$(mktemp -d /tmp/lunchlineup-runtime-permissions.XXXXXXXX)"
cleanup() {
  rm -rf -- "$scratch"
}
trap cleanup EXIT INT TERM
chown "root:$service_gid" "$scratch"
chmod 750 "$scratch"

source_sha="$(printf '%040d' 0 | tr 0 a)"
transported="$scratch/transported-runtime.env"
printf '%s\n' 'RUNTIME_PERMISSION_FIXTURE=redacted' > "$transported"
chown root:root "$transported"
chmod 600 "$transported"
runtime_digest="$(sha256sum "$transported" | awk '{print $1}')"

runtime_root="$scratch/runtime-env"
runtime_digest_dir="$runtime_root/by-release/$source_sha/$runtime_digest"
mkdir -p "$runtime_digest_dir"
for directory in \
  "$runtime_root" \
  "$runtime_root/by-release" \
  "$runtime_root/by-release/$source_sha" \
  "$runtime_digest_dir"
do
  chown "root:$service_gid" "$directory"
  chmod 750 "$directory"
  [ "$(stat -c '%u:%g:%a' "$directory")" = "0:$service_gid:750" ]
done

durable_runtime="$runtime_digest_dir/runtime.env"
cp "$transported" "$durable_runtime"
chown "root:$service_gid" "$durable_runtime"
chmod 640 "$durable_runtime"
[ "$(stat -c '%u:%g:%a' "$transported")" = "0:0:600" ]
[ "$(stat -c '%u:%g:%a' "$durable_runtime")" = "0:$service_gid:640" ]
[ "$(sha256sum "$durable_runtime" | awk '{print $1}')" = "$runtime_digest" ]
setpriv --reuid="$service_uid" --regid="$service_gid" --clear-groups \
  sh -c 'test -r "$1" && test "$(sha256sum "$1" | awk '\''{print $1}'\'')" = "$2"' \
  sh "$durable_runtime" "$runtime_digest"

live_app="$scratch/live"
release_root="$live_app/releases"
mkdir -p "$release_root"
chown "root:$service_gid" "$live_app" "$release_root"
chmod 750 "$live_app" "$release_root"

materialize_release() {
  sha="$1"
  release="$release_root/$sha"
  mkdir -p "$release/infrastructure/control"
  printf 'services:\n  backup: {}\n  pitr-base-backup: {}\n' > "$release/docker-compose.yml"
  printf '#!/bin/sh\nexit 0\n' > "$release/infrastructure/control/public-web-probe.sh"
  printf '%s\n' "$sha" > "$release/DEPLOYED_GIT_SHA"
  find "$release" -type d -exec chown "root:$service_gid" {} + -exec chmod 550 {} +
  chown "root:$service_gid" "$release/docker-compose.yml" "$release/DEPLOYED_GIT_SHA" \
    "$release/infrastructure/control/public-web-probe.sh"
  chmod 440 "$release/docker-compose.yml" "$release/DEPLOYED_GIT_SHA"
  chmod 550 "$release/infrastructure/control/public-web-probe.sh"
}

source_a="$(printf '%040d' 0 | tr 0 1)"
source_b="$(printf '%040d' 0 | tr 0 2)"
materialize_release "$source_a"
materialize_release "$source_b"

ln -s "$release_root/$source_a" "$live_app/current"
printf '%s\n' "$source_a" > "$live_app/DEPLOYED_GIT_SHA"
pointer_tmp="$live_app/.current.$source_b.$$"
ln -s "$release_root/$source_b" "$pointer_tmp"
mv -Tf "$pointer_tmp" "$live_app/current"

[ "$(stat -c '%u:%g:%a' "$release_root/$source_b")" = "0:$service_gid:550" ]
[ "$(stat -c '%u:%g:%a' "$release_root/$source_b/docker-compose.yml")" = "0:$service_gid:440" ]
[ "$(stat -c '%u:%g:%a' "$release_root/$source_b/infrastructure/control/public-web-probe.sh")" = "0:$service_gid:550" ]
[ "$(cat "$live_app/DEPLOYED_GIT_SHA")" = "$source_a" ]
[ "$(cat "$live_app/current/DEPLOYED_GIT_SHA")" = "$source_b" ]

setpriv --reuid="$service_uid" --regid="$service_gid" --clear-groups \
  sh -c 'cd "$1" && test -r docker-compose.yml && test -r "$2" && test "$(cat DEPLOYED_GIT_SHA)" = "$3" && ./infrastructure/control/public-web-probe.sh' \
  sh "$live_app/current" "$durable_runtime" "$source_b"

echo "runtime_permission_access_fixture_ok uid=$service_uid gid=$service_gid"
