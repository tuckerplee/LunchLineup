import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bashPath = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bashPath, ['--version'], { encoding: 'utf8' }).status === 0;
const sourceA = 'a'.repeat(40);
const sourceB = 'b'.repeat(40);
const secretMarker = 'fixture-runtime-secret-do-not-log';

function bashPathFor(path) {
  return path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'll-runtime-env-durability-'));
  const inputA = join(scratch, 'candidate-a.env');
  const inputB = join(scratch, 'candidate-b.env');
  const harness = join(scratch, 'fixture.sh');
  const bytesA = `RUNTIME_FIXTURE=${secretMarker}-a\n`;
  const bytesB = `RUNTIME_FIXTURE=${secretMarker}-b\n`;
  writeFileSync(inputA, bytesA);
  writeFileSync(inputB, bytesB);
  chmodSync(inputA, 0o600);
  chmodSync(inputB, 0o600);
  writeFileSync(harness, `#!/usr/bin/env bash
set -euo pipefail

deploy_script="$1"
scratch="$2"
action="$3"
input_a="$4"
input_b="$5"
source_a="$6"
source_b="$7"
digest_a="$8"
digest_b="$9"
real_stat="$(command -v stat)"
source <(sed '/^trap cleanup_staged_release_state EXIT$/,$d' "$deploy_script")

id() {
  [[ "\${1:-}" == "-u" ]] && printf '0\\n' || command id "$@"
}
declare -A FIXTURE_NORMALIZED_PATHS=()
chown() {
  local path="\${*: -1}"
  FIXTURE_NORMALIZED_PATHS["$path"]=true
}
mv() {
  local args=("$@")
  local count="\${#args[@]}"
  local source="\${args[$((count - 2))]}"
  local target="\${args[$((count - 1))]}"
  command mv "$@"
  if [[ "\${FIXTURE_NORMALIZED_PATHS[$source]:-false}" == "true" ]]; then
    FIXTURE_NORMALIZED_PATHS["$target"]=true
  fi
}
sync() { :; }
getent() {
  if [[ "\${1:-}" == "group" && "\${2:-}" == "fixture-service" ]]; then
    printf 'fixture-service:x:4242:\n'
  elif [[ "\${1:-}" == "passwd" && "\${2:-}" == "lunchlineup" ]]; then
    printf 'lunchlineup:x:4243:%s::/nonexistent:/usr/sbin/nologin\n' "\${FIXTURE_PRIMARY_GID:-4242}"
  else
    return 2
  fi
}
FIXTURE_TIMERS_ENABLED=true
FIXTURE_TIMERS_ACTIVE=true
systemctl() {
  case "\${1:-}" in
    is-enabled)
      unit="\${2:-}"
      [[ "$unit" != --quiet ]] || unit="\${3:-}"
      if [[ "$unit" == *.timer && "$FIXTURE_TIMERS_ENABLED" == "true" ]]; then
        printf 'enabled\n'
        return 0
      fi
      printf 'disabled\n'
      return 1
      ;;
    is-active)
      unit="\${2:-}"
      [[ "$unit" != --quiet ]] || unit="\${3:-}"
      if [[ "$unit" == *.timer && "$FIXTURE_TIMERS_ACTIVE" == "true" ]]; then
        printf 'active\n'
        return 0
      fi
      printf 'inactive\n'
      return 3
      ;;
    disable)
      FIXTURE_TIMERS_ENABLED=false
      [[ " $* " == *" --now "* ]] && FIXTURE_TIMERS_ACTIVE=false
      ;;
    enable)
      FIXTURE_TIMERS_ENABLED=true
      [[ " $* " == *" --now "* ]] && FIXTURE_TIMERS_ACTIVE=true
      ;;
    start) FIXTURE_TIMERS_ACTIVE=true ;;
    stop) FIXTURE_TIMERS_ACTIVE=false ;;
    *) return 0 ;;
  esac
}
node() { :; }
lock_candidate_release_bytes() { :; }
post_pointer_commit_checkpoint() {
  local pointer="$1"
  if [[ "\${FIXTURE_FAIL_AFTER_POINTER:-}" == "$pointer" ]]; then
    unset FIXTURE_FAIL_AFTER_POINTER
    printf 'fixture_failure_injected_after_pointer_commit pointer=%s\n' "$pointer" >&2
    exit 86
  fi
}
stat() {
  if [[ "\${1:-}" == "-c" && "\${2:-}" == "%u:%g:%a" ]]; then
    local path="\${*: -1}"
    if [[ -n "\${FIXTURE_BAD_MODE_PATH:-}" && "$path" == "$FIXTURE_BAD_MODE_PATH" ]]; then
      printf '0:0:644\\n'
    elif [[ "$path" == "$input_a" || "$path" == "$input_b" ]]; then
      printf '0:0:600\\n'
    elif [[ -d "$path" ]]; then
      if [[ "\${FIXTURE_NORMALIZED_PATHS[$path]:-false}" == "true" ]]; then
        printf '0:4242:750\\n'
      else
        printf '0:0:700\\n'
      fi
    elif [[ "$(basename "$path")" == "DEPLOYED_GIT_SHA" ]]; then
      if [[ "\${FIXTURE_NORMALIZED_PATHS[$path]:-false}" == "true" ]]; then
        printf '0:4242:440\\n'
      else
        printf '0:0:600\\n'
      fi
    else
      if [[ "\${FIXTURE_NORMALIZED_PATHS[$path]:-false}" == "true" ]]; then
        printf '0:4242:640\\n'
      else
        printf '0:0:600\\n'
      fi
    fi
    return
  fi
  "$real_stat" "$@"
}

RUNTIME_ENV_STORE_ROOT="$scratch/runtime-env"
ACTIVE_RUNTIME_ENV_POINTER="$RUNTIME_ENV_STORE_ROOT/current"
SERVICE_GROUP_NAME="fixture-service"
BACKUP_RELEASE_ENV_PATH="$scratch/backup-release.env"
BACKUP_SYSTEMD_UNIT_DIR="$scratch/systemd"
WEBHOOK_KEY_READINESS_STATE_PATH="$scratch/webhook-readiness.json"
ACTIVE_RELEASE_POINTER="$scratch/releases/current"
COMPOSE_IMAGE_PREFIX="fixture-release"
mkdir -p "$scratch/releases/$source_a" "$scratch/releases/$source_b" "$BACKUP_SYSTEMD_UNIT_DIR"
for unit in "\${BACKUP_UNITS[@]}"; do
  printf 'fixture-bootstrap:%s\n' "$unit" > "$BACKUP_SYSTEMD_UNIT_DIR/$unit"
done
resolve_service_group

set_candidate() {
  SOURCE_SHA="$1"
  COMPOSE_SERVICE_ENV_FILE="$2"
  PRODUCTION_RUNTIME_ENV_SHA256="$3"
  APP_DIR="$scratch/releases/$SOURCE_SHA"
  COMPOSE_PROJECT_NAME=lunchlineup
  COMPOSE_PROJECT_DIRECTORY="$APP_DIR"
  COMPOSE_FILE="$APP_DIR/docker-compose.yml"
  printf 'services: {}\n' > "$COMPOSE_FILE"
  mkdir -p "$APP_DIR/infrastructure/systemd"
  for unit in "\${BACKUP_UNITS[@]}"; do
    printf 'fixture-candidate:%s:%s\n' "$SOURCE_SHA" "$unit" > "$APP_DIR/infrastructure/systemd/$unit"
  done
}

install_candidate_units() {
  local unit
  for unit in "\${BACKUP_UNITS[@]}"; do
    cp "$APP_DIR/infrastructure/systemd/$unit" "$BACKUP_SYSTEMD_UNIT_DIR/$unit"
  done
}

case "$action" in
  lifecycle)
    set_candidate "$source_a" "$input_a" "$digest_a"
    persist_candidate_runtime_env
    candidate_a="$RUNTIME_ENV_CANDIDATE_PATH"
    [[ "$candidate_a" == "$RUNTIME_ENV_STORE_ROOT/by-release/$source_a/$digest_a/runtime.env" ]]
    cmp -s "$input_a" "$candidate_a"
    stage_backup_release_pointer
    install_candidate_units
    grep -Fxq "COMPOSE_PROJECT_NAME=lunchlineup" "$BACKUP_RELEASE_ENV_PATH"
    grep -Fxq "COMPOSE_SERVICE_ENV_FILE=$candidate_a" "$BACKUP_RELEASE_ENV_PATH"
    grep -Fxq "PRODUCTION_RUNTIME_ENV_SHA256=$digest_a" "$BACKUP_RELEASE_ENV_PATH"
    commit_release_pointers
    [[ "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" == "$candidate_a" ]]

    set_candidate "$source_b" "$input_b" "$digest_b"
    persist_candidate_runtime_env
    candidate_b="$RUNTIME_ENV_CANDIDATE_PATH"
    commit_runtime_env_pointer
    [[ "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" == "$candidate_b" ]]
    restore_staged_runtime_env
    [[ "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" == "$candidate_a" ]]
    [[ ! -e "$candidate_b" ]]

    set_candidate "$source_b" "$input_b" "$digest_b"
    persist_candidate_runtime_env
    candidate_b="$RUNTIME_ENV_CANDIDATE_PATH"
    stage_backup_release_pointer
    install_candidate_units
    commit_release_pointers
    [[ "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" == "$candidate_b" ]]

    set_candidate "$source_a" "$input_a" "$digest_a"
    persist_candidate_runtime_env
    [[ "$RUNTIME_ENV_CANDIDATE_CREATED" == "false" ]]
    stage_backup_release_pointer
    install_candidate_units
    commit_release_pointers
    [[ "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" == "$candidate_a" ]]
    cmp -s "$input_a" "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")"
    grep -Fxq "COMPOSE_SERVICE_ENV_FILE=$candidate_a" "$BACKUP_RELEASE_ENV_PATH"
    grep -Fxq "COMPOSE_PROJECT_NAME=lunchlineup" "$BACKUP_RELEASE_ENV_PATH"
    grep -Fxq "PRODUCTION_RUNTIME_ENV_SHA256=$digest_a" "$BACKUP_RELEASE_ENV_PATH"
    ;;
  digest-mismatch)
    set_candidate "$source_a" "$input_a" "$digest_b"
    persist_candidate_runtime_env
    ;;
  permission-mismatch)
    FIXTURE_BAD_MODE_PATH="$input_a"
    set_candidate "$source_a" "$input_a" "$digest_a"
    persist_candidate_runtime_env
    ;;
  existing-drift)
    drift_path="$RUNTIME_ENV_STORE_ROOT/by-release/$source_a/$digest_a/runtime.env"
    mkdir -p "$(dirname "$drift_path")"
    printf 'DRIFTED=true\\n' > "$drift_path"
    set_candidate "$source_a" "$input_a" "$digest_a"
    persist_candidate_runtime_env
    ;;
  legacy-existing)
    legacy_path="$RUNTIME_ENV_STORE_ROOT/by-release/$source_a/$digest_a/runtime.env"
    mkdir -p "$(dirname "$legacy_path")"
    cp "$input_a" "$legacy_path"
    set_candidate "$source_a" "$input_a" "$digest_a"
    persist_candidate_runtime_env
    validate_durable_runtime_env "$RUNTIME_ENV_CANDIDATE_PATH" "$digest_a"
    ;;
  failure-after-runtime-pointer|failure-after-release-pointer)
    set_candidate "$source_a" "$input_a" "$digest_a"
    persist_candidate_runtime_env
    stage_backup_release_pointer
    install_candidate_units
    commit_release_pointers

    set_candidate "$source_b" "$input_b" "$digest_b"
    persist_candidate_runtime_env
    stage_backup_release_pointer
    install_candidate_units
    if [[ "$action" == "failure-after-runtime-pointer" ]]; then
      FIXTURE_FAIL_AFTER_POINTER=runtime
    else
      FIXTURE_FAIL_AFTER_POINTER=release
    fi
    capture_failure_state() {
      local status=$?
      trap - EXIT
      printf 'release=%s\nruntime=%s\nbackup=%s\n' \
        "$(basename "$(readlink -f "$ACTIVE_RELEASE_POINTER")")" \
        "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" \
        "$(sed -n 's/^IMAGE_TAG=//p' "$BACKUP_RELEASE_ENV_PATH")" \
        > "$scratch/failure-state.before-cleanup"
      (cleanup_staged_release_state) || true
      printf 'release=%s\nruntime=%s\nbackup=%s\n' \
        "$(basename "$(readlink -f "$ACTIVE_RELEASE_POINTER")")" \
        "$(readlink -f "$ACTIVE_RUNTIME_ENV_POINTER")" \
        "$(sed -n 's/^IMAGE_TAG=//p' "$BACKUP_RELEASE_ENV_PATH")" \
        > "$scratch/failure-state.after-cleanup"
      exit "$status"
    }
    trap capture_failure_state EXIT
    commit_release_pointers
    ;;
  *)
    exit 64
    ;;
esac
`);
  chmodSync(harness, 0o700);
  return {
    scratch,
    harness,
    inputA,
    inputB,
    digestA: digest(bytesA),
    digestB: digest(bytesB),
  };
}

function run(f, action) {
  return spawnSync(bashPath, [
    bashPathFor(f.harness),
    bashPathFor(join(root, 'scripts/deploy-vm217-remote.sh')),
    bashPathFor(f.scratch),
    action,
    bashPathFor(f.inputA),
    bashPathFor(f.inputB),
    sourceA,
    sourceB,
    f.digestA,
    f.digestB,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MSYS: 'winsymlinks:sys',
      FIXTURE_PRIMARY_GID: action === 'group-mismatch' ? '4999' : '4242',
    },
  });
}

test('runtime env fixture persists exact bytes, restores failed deploys, and activates retained rollback bytes', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    const result = run(f, 'lifecycle');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /runtime_env_persisted/);
    assert.match(result.stdout, /runtime_env_restored/);
    assert.match(result.stdout, /runtime_env_active/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretMarker));
    const active = join(f.scratch, 'runtime-env', 'by-release', sourceA, f.digestA, 'runtime.env');
    assert.equal(readFileSync(active, 'utf8'), readFileSync(f.inputA, 'utf8'));
    assert.match(readFileSync(join(f.scratch, 'backup-release.env'), 'utf8'), new RegExp(`COMPOSE_SERVICE_ENV_FILE=.*${sourceA}/${f.digestA}/runtime\\.env`));
  } finally {
    rmSync(f.scratch, { recursive: true, force: true });
  }
});

test('runtime env fixture fails closed on digest drift without logging secret bytes', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    for (const action of ['digest-mismatch', 'existing-drift']) {
      const result = run(f, action);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /digest mismatch/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretMarker));
    }
  } finally {
    rmSync(f.scratch, { recursive: true, force: true });
  }
});

test('runtime env fixture enforces root-only transported input and service-group durable state', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    const result = run(f, 'permission-mismatch');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /owned by root:root with mode 0600/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretMarker));
  } finally {
    rmSync(f.scratch, { recursive: true, force: true });
  }
});

test('runtime env fixture migrates exact legacy root-only durable bytes to the service group', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    const result = run(f, 'legacy-existing');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /runtime_env_persisted/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretMarker));
  } finally {
    rmSync(f.scratch, { recursive: true, force: true });
  }
});

test('failure injection after each pointer commit preserves exact-state evidence for rollback reconciliation', { skip: !bashAvailable }, () => {
  for (const [action, expectedRelease] of [
    ['failure-after-runtime-pointer', sourceA],
    ['failure-after-release-pointer', sourceB],
  ]) {
    const f = fixture();
    try {
      const result = run(f, action);
      assert.notEqual(result.status, 0, `${action} unexpectedly passed`);
      assert.match(result.stderr, /fixture_failure_injected_after_pointer_commit/);
      assert.ok(existsSync(join(f.scratch, 'failure-state.before-cleanup')), `${result.stdout}\n${result.stderr}`);
      const state = readFileSync(join(f.scratch, 'failure-state.before-cleanup'), 'utf8');
      assert.match(state, new RegExp(`^release=${expectedRelease}$`, 'm'));
      assert.match(state, new RegExp(`^runtime=.*${sourceB}/${f.digestB}/runtime\\.env$`, 'm'));
      assert.match(state, new RegExp(`^backup=${sourceB}$`, 'm'));
      assert.ok(existsSync(join(f.scratch, 'failure-state.after-cleanup')), `${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(f.scratch, { recursive: true, force: true });
    }
  }
});

test('runtime env fixture rejects a group that does not match the systemd service account', { skip: !bashAvailable }, () => {
  const f = fixture();
  try {
    const result = run(f, 'group-mismatch');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be the non-root service account's primary group/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretMarker));
  } finally {
    rmSync(f.scratch, { recursive: true, force: true });
  }
});

test('deploy script binds Compose, backup, promotion, and cleanup to one durable runtime candidate', () => {
  const script = readFileSync(join(root, 'scripts/deploy-vm217-remote.sh'), 'utf8').replaceAll('\r\n', '\n');
  assert.match(script, /RUNTIME_ENV_STORE_ROOT="\$\{RUNTIME_ENV_STORE_ROOT:-\/var\/lib\/lunchlineup\/runtime-env\}"/);
  assert.match(script, /release_dir="\$by_release_root\/\$release_sha"/);
  assert.match(script, /digest_dir="\$release_dir\/\$expected_sha256"/);
  assert.match(script, /require_root_private_file "\$transported_path" "Transported runtime environment"/);
  assert.match(script, /chown "root:\$SERVICE_GROUP_GID" -- "\$candidate_tmp"[\s\S]*chmod 640 -- "\$candidate_tmp"/);
  assert.match(script, /require_service_group_directory[\s\S]*mode 0750/);
  assert.match(script, /require_service_group_file[\s\S]*mode 0640/);
  assert.match(script, /primary_gid" == "\$resolved_gid"/);
  assert.match(script, /COMPOSE_SERVICE_ENV_FILE="\$RUNTIME_ENV_CANDIDATE_PATH"/);
  assert.match(script, /--project-name "\$COMPOSE_PROJECT_NAME"/);
  assert.match(script, /--project-directory "\$COMPOSE_PROJECT_DIRECTORY"/);
  assert.match(script, /--file "\$COMPOSE_FILE"/);
  assert.match(script, /PRODUCTION_RUNTIME_ENV_SHA256=%s/);
  assert.match(script, /commit_runtime_env_pointer\n  post_pointer_commit_checkpoint runtime[\s\S]*mv -Tf -- "\$active_pointer_tmp" "\$ACTIVE_RELEASE_POINTER"[\s\S]*post_pointer_commit_checkpoint release/);
  assert.match(script, /systemctl enable --now "\$\{BACKUP_TIMERS\[@\]\}"[\s\S]*systemctl is-enabled --quiet "\$timer"[\s\S]*systemctl is-active --quiet "\$timer"/);
  assert.match(script, /remove_confirmed_backup_stage_snapshots/);
  assert.match(script, /remove_confirmed_backup_stage_snapshots\(\)[\s\S]*BACKUP_RELEASE_ENV_STAGE_ACTIVE=false/);
  assert.match(script, /cleanup_staged_release_state[\s\S]*restore_staged_runtime_env/);
  assert.doesNotMatch(script, /runtime\.env.*(?:cat|echo).*secret/i);
});
