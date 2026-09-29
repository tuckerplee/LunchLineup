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
  status=$?; cleanup_status=0; down_status=0
  if [[ -f "$artifact_root/fullstack-target.json" ]]; then
    timeout --kill-after=5s 30s "${compose[@]}" --profile ops logs --tail 120 >"$artifact_root/development-runtime-final.log" 2>&1 || true
    timeout --kill-after=5s 60s "${compose[@]}" --profile ops down -v --remove-orphans >"$artifact_root/development-cleanup.log" 2>&1 || down_status=$?
  fi
  # The adapter fixes every read to this controller run's private store. Keep
  # the short runroot available until independent readback proves no survivor.
  containers_status=0; volumes_status=0; networks_status=0
  timeout --kill-after=5s 30s docker ps -a --format json >"$artifact_root/development-cleanup-containers.json" 2>"$artifact_root/development-cleanup-containers.log" || containers_status=$?
  timeout --kill-after=5s 30s docker volume ls --format json >"$artifact_root/development-cleanup-volumes.json" 2>"$artifact_root/development-cleanup-volumes.log" || volumes_status=$?
  timeout --kill-after=5s 30s docker network ls --format json >"$artifact_root/development-cleanup-networks.json" 2>"$artifact_root/development-cleanup-networks.log" || networks_status=$?
  python3 - "$artifact_root" "$project" "$CI_RUN_ID" "$CI_COMMIT_SHA" "$runtime_root" "$status" "$down_status" "$containers_status" "$volumes_status" "$networks_status" <<'PY' || cleanup_status=$?
import datetime, errno, json, socket, sys
from pathlib import Path
root, project, run_id, source_sha, runtime_root = sys.argv[1:6]
primary_status, down_status, *read_statuses = map(int, sys.argv[6:])
root = Path(root)
absence = {}
errors = []
for resource, read_status in zip(('containers', 'volumes', 'networks'), read_statuses):
    absent = False
    if read_status == 0:
        try:
            rows = json.loads((root / f'development-cleanup-{resource}.json').read_text())
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError('invalid inventory')
            def owned(row):
                labels = row.get('Labels', row.get('labels', {})) or {}
                if isinstance(labels, str):
                    labels = dict(part.split('=', 1) for part in labels.split(',') if '=' in part)
                if not isinstance(labels, dict):
                    raise ValueError('invalid labels')
                if any(labels.get(key) == project for key in ('com.docker.compose.project', 'io.podman.compose.project')):
                    return True
                names = row.get('Names', row.get('names', row.get('Name', row.get('name'))))
                if isinstance(names, str):
                    names = [names]
                if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                    raise ValueError('invalid names')
                return any(name.lstrip('/') == project or name.lstrip('/').startswith((project + '_', project + '-')) for name in names)
            absent = not any(owned(row) for row in rows)
        except (OSError, ValueError, TypeError):
            errors.append(f'{resource}_inventory_unverified')
    else:
        errors.append(f'{resource}_readback_failed')
    absence[resource] = absent
ports = {}
for port in (4000, 8080, 18443):
    with socket.socket() as probe:
        probe.settimeout(1)
        ports[str(port)] = probe.connect_ex(('127.0.0.1', port)) == errno.ECONNREFUSED
passed = down_status == 0 and all(absence.values()) and all(ports.values()) and not errors
receipt = dict(version=1, runId=run_id, sourceSha=source_sha, project=project,
               completedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
               primaryExitCode=primary_status,
               cleanupCommand='timeout --kill-after=5s 60s docker compose --project-name <project> --env-file <run-private-env> -f <candidate-compose> --profile ops down -v --remove-orphans',
               cleanupAttempted=(root / 'fullstack-target.json').is_file(),
               cleanupExitCode=down_status,
               inventoryCommands=['docker ps -a --format json', 'docker volume ls --format json', 'docker network ls --format json'],
               inventoryExitCodes=dict(zip(('containers', 'volumes', 'networks'), read_statuses)),
               ownedResourceAbsence=absence, loopbackPortsClosed=ports,
               runtimeDirectory=runtime_root, runtimePreservationRequired=not passed,
               errors=errors, resourceAbsenceVerified=passed, cleanupVerified=False)
with (root / 'development-cleanup-receipt.json').open('x') as output:
    json.dump(receipt, output, indent=2)
    output.write('\n')
sys.exit(0 if passed else 1)
PY
  runtime_outcome=not-created
  if [[ "$cleanup_status" == 0 && -n "$runtime_root" && -d "$runtime_root" && ! -L "$runtime_root" && "$(cat "$runtime_root/owner")" == "$CI_RUN_ID" ]]; then
    runtime_outcome=removed
    rm -rf -- "$runtime_root" || { cleanup_status=$?; runtime_outcome=removal-failed; }
    if [[ -e "$runtime_root" ]]; then cleanup_status=1; runtime_outcome=removal-failed; fi
  elif [[ -n "$runtime_root" ]]; then
    runtime_outcome=preserved
    [[ "$cleanup_status" != 0 ]] || runtime_outcome=ownership-unverified
    cleanup_status=1
    printf 'Development cleanup is unverified; preserving run-owned runtime directory: %s\n' "$runtime_root" >&2
  fi
  python3 - "$artifact_root/development-cleanup-receipt.json" "$cleanup_status" "$runtime_outcome" <<'PY' || cleanup_status=$?
import datetime, json, sys
from pathlib import Path
path = Path(sys.argv[1])
status = int(sys.argv[2])
outcome = sys.argv[3]
receipt = json.loads(path.read_text())
receipt['runtimeDirectoryOutcome'] = outcome
receipt['runtimeDirectoryRemoved'] = outcome == 'removed'
receipt['runtimePreservationRequired'] = outcome in ('preserved', 'removal-failed', 'ownership-unverified')
receipt['cleanupVerified'] = receipt['resourceAbsenceVerified'] and status == 0 and outcome in ('removed', 'not-created')
receipt['finalCleanupExitCode'] = status
receipt['completedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
if outcome in ('removal-failed', 'ownership-unverified'):
    receipt['errors'].append('runtime_' + outcome.replace('-', '_'))
temporary = path.with_suffix('.final.json')
with temporary.open('x') as output:
    json.dump(receipt, output, indent=2)
    output.write('\n')
temporary.replace(path)
PY
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
node - "$artifact_root/compose-config.json" "$artifact_root/development-images.tsv" "$qualification_root/development-compose.json" <<'NODE'
const fs=require('node:fs');const [configPath,out,runtimePath]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configPath));
const selected=new Set();function include(name){if(selected.has(name))return;const service=config.services[name];if(!service)throw new Error(`Missing development service ${name}`);selected.add(name);for(const dep of Object.keys(service.depends_on??{})){if(dep==='pitr-wal-provider'&&String(config.services.postgres.environment.PITR_ENABLED)==='false')continue;include(dep);}}
for(const name of ['api-v2','web','worker','engine','proxy'])include(name);
const seen=new Set(),lines=[];for(const name of [...selected].sort()){const s=config.services[name];if(seen.has(s.image))continue;seen.add(s.image);lines.push([s.build?'build':'pull',name,s.image].join('\t'));}
fs.writeFileSync(out,lines.join('\n')+'\n',{flag:'wx'});
config.services=Object.fromEntries([...selected].map(name=>{const service=config.services[name];delete service.depends_on;return [name,service];}));
// Use the application's existing isolated browser-test throttle configuration.
Object.assign(config.services.api.environment,{NODE_ENV:'test',DATA_TARGET_ENV:'test',E2E_FULL_STACK:'1',E2E_PREAUTH_IP_LIMIT:'120',E2E_PREAUTH_IDENTIFIER_LIMIT:'30'});
fs.writeFileSync(runtimePath,JSON.stringify(config),{flag:'wx',mode:0o600});
NODE
export LUNCHLINEUP_DEV_COMPOSE="$qualification_root/development-compose.json"
build_image(){
  local action=$1 service=$2 image=$3
  printf 'Development image: %s\n' "$service"
  if [[ "$action" == build ]]; then "${compose[@]}" --profile ops build "$service"; else docker pull "$image"; fi
  docker image inspect --format '{{.Id}}' "$image"
}
# Prove fresh database setup before spending time building application images.
while IFS=$'\t' read -r action service image; do
  case "$service" in migrate|postgres|redis|rabbitmq|pitr-wal-provider) build_image "$action" "$service" "$image";; esac
done <"$artifact_root/development-images.tsv" >"$artifact_root/development-build.log" 2>&1
# These are job-private networks from the existing manifest, with Podman isolation.
for network in alertmanager-egress pitr-egress outbound-egress; do
  docker network create --label "io.podman.compose.project=$project" --label "com.docker.compose.project=$project" --driver bridge --opt isolate=true "${project}_${network}" >/dev/null
done
if awk -F '\t' '$2 == "pitr-wal-provider" { found=1 } END { exit !found }' "$artifact_root/development-images.tsv"; then
  "${compose[@]}" --profile ops up -d --no-build --no-deps pitr-wal-provider >"$artifact_root/development-start.log" 2>&1
fi
"${compose[@]}" --profile ops up -d --no-build --no-deps postgres redis rabbitmq >"$artifact_root/development-start.log" 2>&1
for attempt in {1..60}; do
  if "${compose[@]}" exec -T postgres pg_isready -U lunchlineup_ci_admin -d lunchlineup_ci >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 60 ]] || { "${compose[@]}" logs --tail 80 >"$artifact_root/development-runtime.log" 2>&1; exit 1; }
  sleep 2
done
"${compose[@]}" --profile ops run --rm --no-deps -e NODE_ENV=test -e APP_ENV=test -e DEPLOY_ENV=test -e NEXT_PUBLIC_APP_ENV=test migrate >"$artifact_root/development-migrations.log" 2>&1
while IFS=$'\t' read -r action service image; do
  case "$service" in migrate|postgres|redis|rabbitmq|pitr-wal-provider) continue;; esac
  build_image "$action" "$service" "$image"
  if [[ "$service" == api ]]; then
    "${compose[@]}" --profile ops up -d --no-build --no-deps api >>"$artifact_root/development-start.log" 2>&1
    for attempt in {1..60}; do
      if curl --silent --fail --max-time 3 http://127.0.0.1:4000/live >/dev/null; then break; fi
      [[ "$attempt" != 60 ]] || { echo 'Retained API startup failed'; exit 1; }
      sleep 2
    done
  fi
done <"$artifact_root/development-images.tsv" >>"$artifact_root/development-build.log" 2>&1
"${compose[@]}" --profile ops up -d --no-build --no-deps engine api api-v2 pdf-parser worker web proxy >>"$artifact_root/development-start.log" 2>&1
for attempt in {1..120}; do
  status=$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/auth/login || true)
  api_status=$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:8080/api/v2/ready || true)
  if [[ "$status" == 200 && "$api_status" == 200 ]]; then break; fi
  [[ "$attempt" != 120 ]] || { "${compose[@]}" logs --tail 80 >"$artifact_root/development-runtime.log" 2>&1; exit 1; }
  sleep 2
done
output="$artifact_root/fullstack-playwright"; mkdir -- "$output"
cd "$build_root/apps/web"
BASE_URL=http://127.0.0.1:8080 E2E_FULL_STACK=1 E2E_MOCK_API=0 E2E_SIGNUP_MODE=closed_beta E2E_COMPOSE_PROJECT_NAME="$project" E2E_COMPOSE_ENV_FILE="$env_file" E2E_CANDIDATE_SHA="$CI_COMMIT_SHA" E2E_ARTIFACT_ROOT="$output" PLAYWRIGHT_JSON_OUTPUT_NAME="$output/results.json" npx playwright test --reporter=json --grep='@full-stack' --project=chromium --workers=1 --retries=0 --trace=retain-on-failure tests/e2e/operations-workflows.spec.ts tests/e2e/month-volume-workflows.spec.ts tests/e2e/stress-workflows.spec.ts tests/e2e/tenant-admin-workflows.spec.ts tests/e2e/staff-repair-acceptance.spec.ts tests/e2e/settings-recovery-acceptance.spec.ts >"$output/test.log" 2>&1
node - "$output/results.json" <<'NODE'
const report=JSON.parse(require('node:fs').readFileSync(process.argv[2]));const s=report.stats;
if(!s||!(s.expected>0)||s.unexpected!==0||s.skipped!==0||s.flaky!==0)throw new Error('Development browser acceptance failed or incomplete');
console.log(JSON.stringify({developmentBrowserAcceptance:'passed',...s}));
NODE

# Development interaction evidence uses the actual candidate and built web image.
# It is deliberately not promoted as a release-qualified interaction receipt.
interaction="$artifact_root/development-interaction"; mkdir -- "$interaction"
web_image=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).services.web.image)' "$artifact_root/compose-config.json")
web_id=$(docker image inspect --format '{{.Id}}' "$web_image")
BASE_URL=http://127.0.0.1:8080 E2E_FULL_STACK=1 E2E_MOCK_API=0 E2E_SIGNUP_MODE=closed_beta E2E_COMPOSE_PROJECT_NAME="$project" E2E_COMPOSE_ENV_FILE="$env_file" E2E_CANDIDATE_SHA="$CI_COMMIT_SHA" E2E_CANDIDATE_TREE_SHA="$(git -C "$build_root" rev-parse 'HEAD^{tree}')" E2E_WEB_IMAGE_ID="$web_id" E2E_INTERACTION_PROOF_ROOT="$interaction" PLAYWRIGHT_JSON_OUTPUT_NAME="$interaction/results.json" npx playwright test --reporter=json --config=playwright.interaction-proof.config.ts --workers=1 --retries=0 >"$interaction/test.log" 2>&1
node - "$interaction/results.json" <<'NODE'
const report=JSON.parse(require('node:fs').readFileSync(process.argv[2]));const s=report.stats;
if(!s||!(s.expected>0)||s.unexpected!==0||s.skipped!==0||s.flaky!==0)throw new Error('Development interaction acceptance failed or incomplete');
console.log(JSON.stringify({developmentInteractionAcceptance:'passed',releaseQualified:false,...s}));
NODE
