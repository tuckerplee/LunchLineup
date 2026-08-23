#!/usr/bin/env bash
# Execute the beta release gates locally on the Custom CI appliance. No live host is contacted.
set -euo pipefail

source_sha="${CI_COMMIT_SHA:-}"
if [[ ! "$source_sha" =~ ^[a-f0-9]{40}$ ]] || [[ "${CI_REF:-}" != 'refs/heads/internal-beta-candidate' ]]; then
  echo 'Internal beta qualification requires the exact internal-beta-candidate SHA.' >&2
  exit 64
fi
for command in docker curl node npx; do
  command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 127; }
done

artifact_root=".release/internal-ci/${source_sha}"
gate_dir="$artifact_root/gates"
mkdir -p "$gate_dir" "$artifact_root/dast" "$artifact_root/load" "$artifact_root/sbom" "$artifact_root/trivy"
project="lunchlineup-beta-${CI_RUN_ID//[^a-zA-Z0-9]/}"
env_file="${RUNNER_TEMP:?RUNNER_TEMP is required}/lunchlineup-beta-${CI_RUN_ID}/smoke.env"
metrics_file="${RUNNER_TEMP}/lunchlineup-beta-${CI_RUN_ID}/secrets/metrics_token"
export IMAGE_PREFIX='lunchlineup-internal-ci'
export IMAGE_TAG="$source_sha"
export DEPLOY_RELEASE_SHA="$source_sha"
export COMPOSE_PROJECT_NAME="$project"
export ZAP_IMAGE='zaproxy/zap-stable@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef'
export SYFT_IMAGE='anchore/syft:v1.38.0-nonroot@sha256:86e3e28b85481f2a17d6bbc3f436a7d5a1fb4f6e9227ec4c22f70b2e710f7339'
export TRIVY_IMAGE='aquasec/trivy:0.69.3@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c'
services=(api api-v2 web engine worker migrate control backup proxy pgbouncer postgres node-exporter loki tempo grafana alertmanager otel-collector)

mark_gate() {
  local name="$1"
  local started="$2"
  node - "$gate_dir/${name}.json" "$name" "$source_sha" "$started" <<'NODE'
const { writeFileSync } = require('node:fs');
const [output, name, sourceSha, startedAt] = process.argv.slice(2);
writeFileSync(output, `${JSON.stringify({ name, status: 'passed', sourceSha, attempts: 1, startedAt, completedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
}

cleanup() {
  docker compose -p "$project" --env-file "$env_file" logs --tail=300 api api-v2 web engine worker migrate > "$artifact_root/compose.log" 2>&1 || true
  docker compose -p "$project" --env-file "$env_file" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${RUNNER_TEMP}/lunchlineup-beta-${CI_RUN_ID}"
}
trap cleanup EXIT

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/write-smoke-env.mjs "$env_file" "$metrics_file"
cat >> "$env_file" <<EOF
IMAGE_PREFIX=$IMAGE_PREFIX
IMAGE_TAG=$IMAGE_TAG
DEPLOY_RELEASE_SHA=$DEPLOY_RELEASE_SHA
E2E_FULL_STACK=1
E2E_PREAUTH_IP_LIMIT=120
E2E_PREAUTH_IDENTIFIER_LIMIT=30
EOF

# Build every first-party runtime image under the exact candidate tag.
docker compose -p "$project" --env-file "$env_file" config >/dev/null
docker compose -p "$project" --env-file "$env_file" build "${services[@]}"
node scripts/write-internal-ci-release-manifest.mjs "$artifact_root/release-manifest.json"
mark_gate release-images "$started_at"

# Start a disposable release-image stack and verify its exact release header.
docker compose -p "$project" --env-file "$env_file" up -d --no-build --pull never migrate proxy web api api-v2 engine worker pgbouncer postgres redis rabbitmq
for attempt in {1..60}; do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null && curl -fsS http://127.0.0.1:8080/ >/dev/null; then break; fi
  if [[ "$attempt" == 60 ]]; then docker compose -p "$project" --env-file "$env_file" logs --tail=300 >&2; exit 1; fi
  sleep 5
done
test "$(curl -fsSI http://127.0.0.1:8080/ | awk 'tolower($0) ~ /^x-lunchlineup-release:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }')" = "$source_sha"

export BASE_URL='http://127.0.0.1:8080'
export E2E_FULL_STACK=1 E2E_MOCK_API=0 E2E_CANDIDATE_SHA="$source_sha"
export E2E_SEED_COMMAND="docker compose -p $project --env-file $env_file run --rm -e DATA_TARGET_ENV=disposable migrate sh -lc 'DATABASE_URL=\"\$MIGRATION_DATABASE_URL\" node scripts/seed-e2e.mjs'"
npx playwright install chromium
(cd apps/web && npx playwright test --project=chromium --workers=1 tests/e2e/operations-workflows.spec.ts tests/e2e/month-volume-workflows.spec.ts tests/e2e/stress-workflows.spec.ts tests/e2e/tenant-admin-workflows.spec.ts)
cp -R apps/web/playwright-report "$artifact_root/fullstack-playwright-report"
cp -R apps/web/test-results "$artifact_root/fullstack-test-results"
mark_gate fullstack-e2e "$started_at"

(cd apps/web && npx playwright test --config=playwright.interaction-proof.config.ts)
(cd apps/web && node tests/e2e/verify-internal-beta-interaction-proof.mjs --report "test-results/internal-beta-interaction-proof-$source_sha/results.json" --source-sha "$source_sha" --output "test-results/internal-beta-interaction-proof-$source_sha/proof.json")
cp "apps/web/test-results/internal-beta-interaction-proof-$source_sha/proof.json" "$artifact_root/interaction-proof.json"
cp -R "apps/web/test-results/internal-beta-interaction-proof-$source_sha" "$artifact_root/interaction-proof-artifacts"
mark_gate interaction-proof "$started_at"

export EXPECTED_SOURCE_SHA="$source_sha" DAST_OUTPUT_DIR="${RUNNER_TEMP}/lunchlineup-candidate-dast/$source_sha"
bash scripts/run-dast.sh "$BASE_URL"
cp "$DAST_OUTPUT_DIR"/* "$artifact_root/dast/"
mark_gate dast "$started_at"

export ALLOW_LOCAL_LOAD_SMOKE=true AVAILABILITY_IMPORT_TENANT_SLUG=e2e-operations AVAILABILITY_IMPORT_LOGIN_IDENTIFIER=e2e.load AVAILABILITY_IMPORT_LOGIN_PIN=246812 AVAILABILITY_IMPORT_MFA_SECRET=JBSWY3DPEHPK3PXP AVAILABILITY_IMPORT_TARGET_USER_IDENTIFIER=staff-1 AVAILABILITY_IMPORT_ORIGIN=https://smoke.lunchlineup.test AVAILABILITY_IMPORT_CREDIT_SOURCE_ATTESTATION=admin-credit-grant LOAD_OUTPUT_DIR="${RUNNER_TEMP}/lunchlineup-candidate-load/$source_sha"
bash scripts/load-test.sh "$BASE_URL"
cp "$LOAD_OUTPUT_DIR"/* "$artifact_root/load/"
mark_gate load "$started_at"

# Export each exact local image, then scan the immutable archive rather than a mutable tag.
for service in "${services[@]}"; do
  ref="$IMAGE_PREFIX/$service:$source_sha"
  archive="${RUNNER_TEMP}/$service-$source_sha.tar"
  docker save "$ref" -o "$archive"
  docker run --rm --user 0:0 -v "$archive:/image.tar:ro" -v "$(pwd -P)/$artifact_root/sbom:/out:rw" "$SYFT_IMAGE" docker-archive:/image.tar -o "spdx-json=/out/$service.spdx.json"
  docker run --rm --user 0:0 -v "$archive:/image.tar:ro" -v "$(pwd -P):/workspace:ro" -v "$(pwd -P)/$artifact_root/trivy:/out:rw" "$TRIVY_IMAGE" image --input /image.tar --format json --output "/out/$service.trivy.json" --scanners vuln --severity HIGH,CRITICAL --ignorefile /workspace/.trivyignore.yaml --exit-code 1
  rm -f "$archive"
done
mark_gate sbom "$started_at"
mark_gate trivy "$started_at"
