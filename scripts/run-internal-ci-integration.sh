#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && -n "${2:-}" && $# == 2 ]] || { echo 'Usage: run-internal-ci-integration.sh --source-context <context.json>' >&2; exit 64; }
context=$2; workspace=$PWD; artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"; source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"; build_root="$source_root/build"
test "$context" = "$source_root/source-context.json"; node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build >/dev/null
suffix="${CI_RUN_ID//[^a-zA-Z0-9]/}"; prefix="lunchlineup-integration-$suffix"; postgres="${prefix}-postgres"; redis="${prefix}-redis"; rabbitmq="${prefix}-rabbitmq"; output="$artifact_root/integration"; venv="$RUNNER_TEMP/lunchlineup-integration-venv-$CI_RUN_ID"; mkdir -p "$output" "$artifact_root/results" "$artifact_root/details"; started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
runtime_root=''; graph_root=''; container_run_root=''
container(){ /usr/bin/podman --root "$graph_root" --runroot "$container_run_root" "$@"; }
cleanup(){ if [[ -n "$graph_root" && -n "$container_run_root" ]]; then container rm -f "$postgres" "$redis" "$rabbitmq" >/dev/null 2>&1 || true; container system reset --force >/dev/null 2>&1 || true; fi; if [[ -n "$graph_root" && -e "$graph_root" && ! -L "$graph_root" ]]; then case "$graph_root" in "$RUNNER_TEMP"/*) rm -rf -- "$graph_root";; esac; fi; if [[ -n "$runtime_root" && -e "$runtime_root" && ! -L "$runtime_root" ]]; then case "$runtime_root" in /tmp/llr.*) rm -rf -- "$runtime_root";; esac; fi; }; trap cleanup EXIT
umask 022
controller_runtime_root=$(realpath -e "${XDG_RUNTIME_DIR:?}")
controller_private_root=$(realpath -e "$RUNNER_TEMP/..")
case "$controller_runtime_root" in "$controller_private_root"/*) ;; *) echo 'Controller rootless runtime escaped the private run root.' >&2; exit 1;; esac
runtime_root=$(mktemp -d /tmp/llr.XXXXXX)
test ! -L "$runtime_root"; chmod 700 "$runtime_root"; export XDG_RUNTIME_DIR="$runtime_root"
graph_root="$RUNNER_TEMP/lunchlineup-integration-containers-$CI_RUN_ID"; test ! -e "$graph_root"
container_run_root="$runtime_root/containers"
rootless_netns="$container_run_root/networks/rootless-netns"
case "$rootless_netns" in "$runtime_root"/*) ;; *) echo 'Rootless network runtime escaped XDG_RUNTIME_DIR.' >&2; exit 1;; esac
container system migrate >/dev/null
if [[ -e "$rootless_netns" || -L "$rootless_netns" ]]; then test ! -L "$rootless_netns"; rm -rf -- "$rootless_netns"; fi
container rm -f "$postgres" "$redis" "$rabbitmq" >/dev/null 2>&1 || true
pg_password="pg_$(openssl rand -hex 24)"; app_password="app_$(openssl rand -hex 24)"; mq_password="mq_$(openssl rand -hex 24)"
container run -d --name "$postgres" --network slirp4netns:port_handler=slirp4netns -p 127.0.0.1::5432 -e POSTGRES_USER=root -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=lunchlineup_test postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 >/dev/null
container run -d --name "$redis" --network slirp4netns:port_handler=slirp4netns -p 127.0.0.1::6379 redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2 >/dev/null
container run -d --name "$rabbitmq" --network slirp4netns:port_handler=slirp4netns -p 127.0.0.1::5672 -e RABBITMQ_DEFAULT_USER=lunchlineup_ci -e RABBITMQ_DEFAULT_PASS="$mq_password" rabbitmq:4-alpine@sha256:ae585b93b24b77f7281320c7d1e62b3098acba91eb14b1e53a9716584c95c7e9 >/dev/null
postgres_port=$(container port "$postgres" 5432/tcp | awk -F: 'NR==1{print $NF}'); redis_port=$(container port "$redis" 6379/tcp | awk -F: 'NR==1{print $NF}'); rabbitmq_port=$(container port "$rabbitmq" 5672/tcp | awk -F: 'NR==1{print $NF}')
umask 077
for attempt in {1..60}; do if container exec "$postgres" pg_isready -U root -d lunchlineup_test >/dev/null && container exec "$redis" redis-cli ping >/dev/null && container exec "$rabbitmq" rabbitmq-diagnostics -q ping >/dev/null; then break; fi; [[ "$attempt" != 60 ]] || exit 1; sleep 2; done
test ! -e "$venv"; python3 -m venv "$venv"; trap 'cleanup; rm -rf -- "$venv"' EXIT; "$venv/bin/pip" install --requirement "$build_root/apps/engine/requirements.txt" --requirement "$build_root/apps/worker/requirements.txt" >"$output/pip.log" 2>&1; cd "$build_root"
export APP_DB_USER=lunchlineup_ci_app APP_DB_PASSWORD="$app_password" POSTGRES_USER=root POSTGRES_PASSWORD="$pg_password" DATABASE_URL="postgresql://lunchlineup_ci_app:$app_password@127.0.0.1:$postgres_port/lunchlineup_test" MIGRATION_DATABASE_URL="postgresql://root:$pg_password@127.0.0.1:$postgres_port/lunchlineup_test" PLATFORM_ADMIN_DB_CONTEXT_SECRET='ci-platform-admin-capability-secret-1234567890' REDIS_URL="redis://127.0.0.1:$redis_port" RABBITMQ_URL="amqp://lunchlineup_ci:$mq_password@127.0.0.1:$rabbitmq_port/%2f" ENGINE_GRPC_URL='127.0.0.1:50051' DATA_TARGET_ENV=disposable MIGRATION_SOURCE_SHA="$CI_COMMIT_SHA" WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' PYTHON="$venv/bin/python"
node scripts/apply-db-migrations.mjs >"$output/migrations.log" 2>&1; npm run test:integration >"$output/tests.log" 2>&1
git ls-files 'packages/db/prisma/migrations/**/migration.sql' | sort >"$output/migration-inventory.txt"
printf 'postgres=%s\nredis=%s\nrabbitmq=%s\n' "$(container inspect --format '{{.Image}}' "$postgres")" "$(container inspect --format '{{.Image}}' "$redis")" "$(container inspect --format '{{.Image}}' "$rabbitmq")" >"$output/container-images.txt"
container rm -f "$postgres" "$redis" "$rabbitmq" >/dev/null; for resource in "$postgres" "$redis" "$rabbitmq"; do if container inspect "$resource" >/dev/null 2>&1; then exit 1; fi; done; container system reset --force >/dev/null; rm -rf -- "$venv"; test "$graph_root" = "$(realpath -e "$graph_root")"; case "$graph_root" in "$RUNNER_TEMP"/*) ;; *) exit 1;; esac; rm -rf -- "$graph_root"; test ! -e "$graph_root"; graph_root=''; test "$runtime_root" = "$(realpath -e "$runtime_root")"; case "$runtime_root" in /tmp/llr.*) ;; *) exit 1;; esac; rm -rf -- "$runtime_root"; test ! -e "$runtime_root"; runtime_root=''; container_run_root=''; trap - EXIT; printf 'cleanup=passed\n' >"$output/cleanup.log"
migration_count=$(wc -l <"$output/migration-inventory.txt" | tr -d ' '); printf '{"sourceSha":"%s","migrationCount":%s,"ports":{"postgres":%s,"redis":%s,"rabbitmq":%s},"cleanupConfirmed":true}\n' "$CI_COMMIT_SHA" "$migration_count" "$postgres_port" "$redis_port" "$rabbitmq_port" >"$artifact_root/details/database-integration.json"
node "$build_root/scripts/write-internal-ci-command-result.mjs" --name database-integration --source-context "$context" --started-at "$started_at" --output "$artifact_root/results/database-integration.json"
node "$build_root/scripts/record-internal-ci-gate.mjs" --name database-integration --source-context "$context" --started-at "$started_at" --command-result "$artifact_root/results/database-integration.json" --details "$artifact_root/details/database-integration.json" --output "$artifact_root/gates/database-integration.json" --evidence "$output/pip.log" --evidence "$output/migrations.log" --evidence "$output/tests.log" --evidence "$output/migration-inventory.txt" --evidence "$output/container-images.txt" --evidence "$output/cleanup.log"
