#!/usr/bin/env bash
# Disposable application QA only. No release signing, publication or deployment.
set -euo pipefail
umask 077
[[ "${1:-}" == --source-context && $# == 2 && "${LUNCHLINEUP_DEVELOPMENT_QA:-}" == 1 ]] || exit 64
context=$2
workspace=$PWD
artifact_root="$workspace/.release/internal-ci/${CI_COMMIT_SHA:?}"
source_root="${RUNNER_TEMP:?}/lunchlineup-source-${CI_RUN_ID:?}"
build_root="$source_root/build"
qualification_root="$RUNNER_TEMP/lunchlineup-beta-qualification-$CI_RUN_ID"
env_file="$qualification_root/runtime.env"
project_suffix=${CI_RUN_ID,,}; project_suffix=${project_suffix//[^a-z0-9]/}
project="lunchlineup-beta-$project_suffix"
[[ "$context" == "$source_root/source-context.json" && ! -e "$qualification_root" && ! -L "$qualification_root" ]] || exit 64
node "$build_root/scripts/verify-internal-ci-source-clone.mjs" --proof "$artifact_root/source/source-proof.json" --clone "$build_root" --purpose build --require-clean >/dev/null
export PATH="$build_root/scripts/ci-container-bin:$PATH"
compose=(docker compose --project-name "$project" --env-file "$env_file" -f "$build_root/docker-compose.yml")
mkdir -- "$qualification_root"
runtime_root=""
cleanup(){
  status=$?; cleanup_status=0
  if [[ -f "$artifact_root/fullstack-target.json" ]]; then
    "${compose[@]}" --profile ops down -v --remove-orphans >"$artifact_root/development-cleanup.log" 2>&1 || cleanup_status=$?
  fi
  if [[ -n "$runtime_root" && -d "$runtime_root" && ! -L "$runtime_root" && "$(cat "$runtime_root/owner")" == "$CI_RUN_ID" ]]; then
    rm -rf -- "$runtime_root"
  fi
  trap - EXIT
  if [[ "$status" == 0 && "$cleanup_status" != 0 ]]; then exit "$cleanup_status"; fi
  exit "$status"
}
trap cleanup EXIT
# Unix sockets require a short path; image/volume storage remains in the bounded controller store.
runtime_root=$(mktemp -d /tmp/llr.XXXXXX)
printf '%s\n' "$CI_RUN_ID" >"$runtime_root/owner"
mkdir "$runtime_root/containers"
export XDG_RUNTIME_DIR="$runtime_root" LUNCHLINEUP_DEV_RUNTIME="$runtime_root"
node "$build_root/scripts/write-internal-beta-qualification-env.mjs" --source-context "$context" --output "$env_file" --public-build-config "$artifact_root/public-build-config.json" --secrets-dir "$qualification_root/secrets"
"${compose[@]}" --profile ops config --format json >"$artifact_root/compose-config.json"
python3 "$build_root/scripts/check-internal-ci-target.py" fullstack
node - "$artifact_root/compose-config.json" "$artifact_root/development-images.tsv" <<'NODE'
const fs=require('node:fs');const [configPath,out]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configPath));
const selected=new Set();function include(name){if(selected.has(name))return;const service=config.services[name];if(!service)throw new Error(`Missing development service ${name}`);selected.add(name);for(const dep of Object.keys(service.depends_on??{}))include(dep);}
for(const name of ['api-v2','web','worker','engine','proxy'])include(name);
const seen=new Set(),lines=[];for(const name of [...selected].sort()){const s=config.services[name];if(seen.has(s.image))continue;seen.add(s.image);lines.push([s.build?'build':'pull',name,s.image].join('\t'));}
fs.writeFileSync(out,lines.join('\n')+'\n',{flag:'wx'});
NODE
while IFS=$'\t' read -r action service image; do
  printf 'Development image: %s\n' "$service"
  if [[ "$action" == build ]]; then "${compose[@]}" --profile ops build "$service"; else docker pull "$image"; fi
  docker image inspect --format '{{.Id}}' "$image"
done <"$artifact_root/development-images.tsv" >"$artifact_root/development-build.log" 2>&1
# These are job-private networks from the existing manifest, with Podman isolation.
for network in alertmanager-egress pitr-egress outbound-egress; do
  docker network create --label "io.podman.compose.project=$project" --label "com.docker.compose.project=$project" --driver bridge --opt isolate=true "${project}_${network}" >/dev/null
done
"${compose[@]}" --profile ops up -d --no-build --no-deps pitr-wal-provider postgres redis rabbitmq >"$artifact_root/development-start.log" 2>&1
for attempt in {1..60}; do
  if "${compose[@]}" exec -T postgres pg_isready -U lunchlineup_ci_admin -d lunchlineup_ci >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 60 ]] || exit 1
  sleep 2
done
"${compose[@]}" --profile ops run --rm --no-deps migrate >"$artifact_root/development-migrations.log" 2>&1
"${compose[@]}" --profile ops up -d --no-build --no-deps engine api api-v2 pdf-parser worker web proxy >>"$artifact_root/development-start.log" 2>&1
for attempt in {1..120}; do
  status=$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/auth/login || true)
  if [[ "$status" == 200 ]]; then break; fi
  [[ "$attempt" != 120 ]] || { "${compose[@]}" logs --tail 80 >"$artifact_root/development-runtime.log" 2>&1; exit 1; }
  sleep 2
done
output="$artifact_root/fullstack-playwright"; mkdir -- "$output"
cd "$build_root/apps/web"
BASE_URL=http://127.0.0.1:8080 E2E_FULL_STACK=1 E2E_MOCK_API=0 E2E_SIGNUP_MODE=closed_beta E2E_COMPOSE_PROJECT_NAME="$project" E2E_COMPOSE_ENV_FILE="$env_file" E2E_CANDIDATE_SHA="$CI_COMMIT_SHA" E2E_ARTIFACT_ROOT="$output" PLAYWRIGHT_JSON_OUTPUT_NAME="$output/results.json" npx playwright test --reporter=json --project=chromium --workers=1 --retries=0 --trace=retain-on-failure tests/e2e/operations-workflows.spec.ts tests/e2e/month-volume-workflows.spec.ts tests/e2e/stress-workflows.spec.ts tests/e2e/tenant-admin-workflows.spec.ts tests/e2e/staff-repair-acceptance.spec.ts >"$output/test.log" 2>&1
node - "$output/results.json" <<'NODE'
const report=JSON.parse(require('node:fs').readFileSync(process.argv[2]));const s=report.stats;
if(!s||!(s.expected>0)||s.unexpected!==0||s.skipped!==0||s.flaky!==0)throw new Error('Development browser acceptance failed or incomplete');
console.log(JSON.stringify({developmentBrowserAcceptance:'passed',...s}));
NODE
