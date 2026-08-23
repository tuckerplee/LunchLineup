#!/usr/bin/env bash
# Run the database-backed integration suite against a job-private disposable stack.
set -euo pipefail

source_sha="${CI_COMMIT_SHA:-}"
if [[ ! "$source_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'CI_COMMIT_SHA must be the exact candidate SHA.' >&2
  exit 64
fi
for command in docker node npm; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 127; }
done

run_id="${CI_RUN_ID:?CI_RUN_ID is required}"
name_suffix="${run_id//[^a-zA-Z0-9]/}"
postgres_name="lunchlineup-integration-postgres-${name_suffix}"
redis_name="lunchlineup-integration-redis-${name_suffix}"
rabbitmq_name="lunchlineup-integration-rabbitmq-${name_suffix}"

cleanup() {
  docker rm -f "$postgres_name" "$redis_name" "$rabbitmq_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

postgres_password='testpass'
rabbitmq_password='rabbit-testpass'
docker run -d --name "$postgres_name" -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=root -e POSTGRES_PASSWORD="$postgres_password" -e POSTGRES_DB=lunchlineup_test \
  postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 >/dev/null
docker run -d --name "$redis_name" -p 127.0.0.1:56379:6379 \
  redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2 >/dev/null
docker run -d --name "$rabbitmq_name" -p 127.0.0.1:55672:5672 \
  -e RABBITMQ_DEFAULT_USER=lunchlineup_ci -e RABBITMQ_DEFAULT_PASS="$rabbitmq_password" \
  rabbitmq:4-alpine@sha256:ae585b93b24b77f7281320c7d1e62b3098acba91eb14b1e53a9716584c95c7e9 >/dev/null
for attempt in {1..60}; do
  if docker exec "$postgres_name" pg_isready -U root -d lunchlineup_test >/dev/null \
    && docker exec "$redis_name" redis-cli ping >/dev/null \
    && docker exec "$rabbitmq_name" rabbitmq-diagnostics -q ping >/dev/null; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    docker logs "$postgres_name" >&2 || true
    docker logs "$redis_name" >&2 || true
    docker logs "$rabbitmq_name" >&2 || true
    exit 1
  fi
  sleep 2
done

export DATABASE_URL='postgresql://lunchlineup_app:app-testpass@127.0.0.1:55432/lunchlineup_test'
export MIGRATION_DATABASE_URL="postgresql://root:${postgres_password}@127.0.0.1:55432/lunchlineup_test"
export PLATFORM_ADMIN_DB_CONTEXT_SECRET='ci-platform-admin-capability-secret-1234567890'
export REDIS_URL='redis://127.0.0.1:56379'
export RABBITMQ_URL="amqp://lunchlineup_ci:${rabbitmq_password}@127.0.0.1:55672/%2f"
export ENGINE_GRPC_URL='127.0.0.1:50051'
export DATA_TARGET_ENV=test
export WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

node scripts/apply-db-migrations.mjs
npm run test:integration
