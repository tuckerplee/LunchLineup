import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const deployScript = join(root, 'scripts', 'deploy-vm217-remote.sh');
const bashPath = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bashPath, ['--version'], { encoding: 'utf8' }).status === 0;

function read(path) {
  return readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n');
}

function bashPathFor(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function runChild(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

test('VM217 production deploy gates success on public and required internal health', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const ci = read('.github/workflows/ci.yml');
  const requiredServices = ['pdf-parser', 'worker', 'engine', 'webhook-replay', 'prometheus', 'alertmanager'];

  assert.match(script, /HEALTH_URL="\$\{HEALTH_URL:-\}"/);
  assert.match(script, /HEALTH_REQUEST_TIMEOUT_SECONDS="\$\{HEALTH_REQUEST_TIMEOUT_SECONDS:-10\}"/);
  assert.match(script, /HEALTH_POLL_SECONDS="\$\{HEALTH_POLL_SECONDS:-5\}"/);
  assert.match(script, /PRODUCTION_WEB_URL="\$\{PRODUCTION_WEB_URL:-\}"/);
  assert.match(script, /wait_for_health "\$\{HEALTH_URL:-\$PRODUCTION_API_HEALTH_URL\}"/);
  assert.match(script, /wait_for_release_health "\$PRODUCTION_API_HEALTH_URL" "\$SOURCE_SHA"/);
  assert.match(script, /wait_for_web_surface "\$PRODUCTION_WEB_URL" "Public Next\.js web surface" "\$SOURCE_SHA"/);
  for (const service of requiredServices) {
    assert.match(script, new RegExp(`\\b${service}\\b`));
  }
  assert.match(script, /docker inspect --format .*\.State\.Health/);
  assert.match(script, /if \[\[ -n "\$health_status" && "\$health_status" != "healthy" \]\]/);
  assert.match(script, /elif \[\[ -z "\$health_status" && "\$state_status" != "running" \]\]/);

  const apiHealthIndex = script.lastIndexOf('wait_for_health "${HEALTH_URL:-$PRODUCTION_API_HEALTH_URL}"');
  const releaseHealthIndex = script.lastIndexOf('wait_for_release_health "$PRODUCTION_API_HEALTH_URL" "$SOURCE_SHA"');
  const publicWebIndex = script.lastIndexOf('wait_for_web_surface "$PRODUCTION_WEB_URL"');
  const internalHealthIndex = script.lastIndexOf('! wait_for_required_services');
  const retainedProofIndex = script.lastIndexOf('write_post_deploy_proof');
  const deployedShaIndex = script.lastIndexOf('commit_release_pointers');
  const successIndex = script.indexOf('deploy_remote_ok scope=production');
  assert.ok(releaseHealthIndex !== -1 && releaseHealthIndex < apiHealthIndex);
  assert.ok(apiHealthIndex !== -1 && apiHealthIndex < publicWebIndex);
  assert.ok(publicWebIndex < internalHealthIndex);
  assert.ok(internalHealthIndex !== -1 && internalHealthIndex < retainedProofIndex);
  assert.ok(retainedProofIndex < deployedShaIndex);
  assert.ok(deployedShaIndex < successIndex);
  assert.match(script, /Production post-deploy verification failed; the CI failure path must run the configured verified rollback command/);
  assert.match(script, /compose_release up -d --no-build --pull never pdf-parser\r?\n\s*compose_release up -d --no-build --pull never/);
  assert.match(script, /compose_release logs --tail=100 proxy web api pdf-parser worker/);
  assert.match(ci, /id: same_gate_release_outcome[\s\S]*id: automatic_production_rollback[\s\S]*scripts\/rollback-vm217-transport\.sh/);
});

test('VM217 alert gate verifies fresh loopback Alertmanager state before proof and pointer promotion', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const compose = read('docker-compose.yml');
  const productionDeploy = script.slice(
    script.indexOf('run_production_release_deploy()'),
    script.indexOf('run_development_source_deploy()'),
  );
  const alertmanager = compose.slice(
    compose.indexOf('  alertmanager:'),
    compose.indexOf('\n  # Observability: Node Exporter'),
  );

  assert.match(script, /DEPLOY_ALERTMANAGER_URL="\$\{DEPLOY_ALERTMANAGER_URL:-http:\/\/127\.0\.0\.1:9093\/api\/v2\/alerts\}"/);
  assert.match(script, /DEPLOY_ALERT_MAX_RESPONSE_AGE_MS="\$\{DEPLOY_ALERT_MAX_RESPONSE_AGE_MS:-30000\}"/);
  assert.match(script, /DEPLOY_ALERT_STABILITY_SECONDS="\$\{DEPLOY_ALERT_STABILITY_SECONDS:-900\}"/);
  assert.match(script, /--alertmanager-url "\$DEPLOY_ALERTMANAGER_URL"/);
  assert.match(script, /--max-response-age-ms "\$DEPLOY_ALERT_MAX_RESPONSE_AGE_MS"/);
  assert.match(script, /DEPLOY_ALERT_MAX_RESPONSE_AGE_MS < 1000 \|\| DEPLOY_ALERT_MAX_RESPONSE_AGE_MS > 300000/);
  assert.match(script, /DEPLOY_ALERT_BOOT_GRACE_SECONDS > 300/);
  assert.match(script, /DEPLOY_ALERT_STABILITY_SECONDS < 60 \|\| DEPLOY_ALERT_STABILITY_SECONDS > 900/);
  assert.match(script, /stable_since=0[\s\S]*now - stable_since >= DEPLOY_ALERT_STABILITY_SECONDS/);
  assert.match(script, /stable_since=0[\s\S]*Critical LunchLineup alerts did not remain continuously inactive/);

  const alertGateIndex = productionDeploy.indexOf('if ! verify_deploy_alerts');
  const proofIndex = productionDeploy.indexOf('write_post_deploy_proof');
  const stagePointerIndex = productionDeploy.indexOf('stage_backup_release_pointer');
  const commitPointerIndex = productionDeploy.indexOf('commit_release_pointers');
  assert.ok(alertGateIndex !== -1 && alertGateIndex < proofIndex);
  assert.ok(proofIndex < stagePointerIndex);
  assert.ok(stagePointerIndex < commitPointerIndex);

  assert.match(alertmanager, /ports:\s*\n\s+- "127\.0\.0\.1:9093:9093"/);
  assert.doesNotMatch(alertmanager, /0\.0\.0\.0:9093|"9093:9093"/);
});

test('production releases for the same workflow and ref serialize without cancellation', () => {
  const ci = read('.github/workflows/ci.yml');
  const concurrencyStart = ci.indexOf('concurrency:');
  const jobsStart = ci.indexOf('\njobs:', concurrencyStart);
  const concurrency = ci.slice(concurrencyStart, jobsStart);

  assert.ok(concurrencyStart !== -1 && jobsStart > concurrencyStart);
  assert.match(concurrency, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(concurrency, /cancel-in-progress: false/);
  assert.doesNotMatch(concurrency, /github\.(?:sha|run_id|run_number|run_attempt)/);
});

test('production rollback is durably armed in a completed step before remote mutation', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const ci = read('.github/workflows/ci.yml');
  const productionStart = script.indexOf('run_production_release_deploy()');
  const productionEnd = script.indexOf('run_development_source_deploy()', productionStart);
  const productionDeploy = script.slice(productionStart, productionEnd);
  const lockIndex = script.lastIndexOf('if ! flock -n 9');
  const productionCallIndex = script.lastIndexOf('run_production_release_deploy');
  const preflightIndex = productionDeploy.indexOf('preflight_rollback_schema_compatibility');
  const mutationIndex = productionDeploy.indexOf('compose_release up -d --no-build --pull never');
  const verifyInputsIndex = ci.indexOf('name: Verify production deployment inputs');
  const armStepIndex = ci.indexOf('name: Arm production rollback');
  const deployStepStart = ci.indexOf('id: production_deploy');
  const deployStepEnd = ci.indexOf('      - name: Verify deployed release inputs remain exact', deployStepStart);
  const deployStep = ci.slice(deployStepStart, deployStepEnd);

  assert.ok(productionStart !== -1 && productionEnd > productionStart);
  assert.ok(lockIndex !== -1 && lockIndex < productionCallIndex);
  assert.ok(preflightIndex !== -1 && preflightIndex < mutationIndex);
  assert.ok(verifyInputsIndex !== -1 && verifyInputsIndex < armStepIndex);
  assert.ok(armStepIndex < deployStepStart, 'arming must complete before the remote deploy command starts');
  assert.match(ci, /id: arm_production_rollback[\s\S]*echo "armed=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(ci, /production_rollback_armed: \$\{\{ steps\.arm_production_rollback\.outputs\.armed \}\}/);
  assert.match(ci, /if: always\(\) && steps\.arm_production_rollback\.outcome == 'success'/);
  assert.match(ci, /steps\.same_gate_release_outcome\.outcome != 'success' \|\| steps\.same_gate_release_outcome\.outputs\.rollback_required == 'true'/);
  assert.match(ci, /Require completed automatic rollback after release failure[\s\S]*test "\$ROLLBACK_PROOF_OUTCOME" = success/);
  assert.doesNotMatch(script, /production_deploy_mutation_started/);
  assert.doesNotMatch(deployStep, /GITHUB_OUTPUT|PIPESTATUS|while IFS= read/);
});
test('VM217 public web gate rejects API health and generic edge responses', () => {
  const script = read('scripts/deploy-vm217-remote.sh');

  assert.match(script, /PRODUCTION_WEB_URL must target the public Next\.js root route \(\/\), not an API or health path/);
  assert.match(script, /\[\[ "\$code" != "200" \]\]/);
  assert.match(script, /\[\[ "\$content_type" != text\/html\* \]\]/);
  assert.match(script, /response_bytes < 1024/);
  assert.match(script, /served_release" != "\$expected_release/);
  assert.match(script, /X-LunchLineup-Release/i);
  assert.match(script, /grep -Fq '<h1>LunchLineup<\/h1>'/);
  assert.match(script, /grep -Fq '\/_next\/static\/'/);
  assert.match(script, /Cache-Control: no-cache/);
  assert.match(script, /lunchlineup_deploy_probe=/);
  assert.match(script, /--connect-timeout "\$request_timeout"/);
  assert.match(script, /--max-time "\$request_timeout"/);
  assert.match(script, /sleep_before_health_retry "\$deadline"/);
  assert.equal(
    (script.match(/--max-time "\$HEALTH_REQUEST_TIMEOUT_SECONDS"/g) ?? []).length,
    2,
    'post-deploy API and launch-proof readbacks must also have request deadlines',
  );
});

test('production Compose identity stays stable across retained release SHA directories', { skip: !bashAvailable }, (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  if (spawnSync(python, ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('Python is not available');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'll-compose-identity-'));
  const fakeBin = join(scratch, 'bin');
  const dockerLog = join(scratch, 'docker.log');
  const fakeDocker = join(fakeBin, 'docker');
  mkdirSync(fakeBin);
  writeFileSync(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
`);
  chmodSync(fakeDocker, 0o700);

  const runCandidate = (sourceSha, runtimeBytes = '') => {
    const candidate = join(scratch, 'releases', sourceSha);
    const composeFile = join(candidate, 'docker-compose.yml');
    const runtimeEnv = join(candidate, 'runtime.env');
    mkdirSync(candidate, { recursive: true });
    writeFileSync(composeFile, 'services: {}\n');
    writeFileSync(runtimeEnv, runtimeBytes);
    return {
      candidate,
      result: spawnSync(bashPath, [
        '-c',
        `PATH="$1:$PATH"; export PATH
python3() { "$PYTHON_BINARY" "$@"; }
export -f python3
source "$2"
validate_production_compose_scope
compose_release ps`,
        'compose-identity-fixture',
        bashPathFor(fakeBin),
        bashPathFor(deployScript),
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          APP_DIR: bashPathFor(candidate),
          COMPOSE_PROJECT_NAME: 'lunchlineup',
          COMPOSE_PROJECT_DIRECTORY: bashPathFor(candidate),
          COMPOSE_FILE: bashPathFor(composeFile),
          COMPOSE_SERVICE_ENV_FILE: bashPathFor(runtimeEnv),
          RELEASE_SOURCE_SHA: sourceSha,
          VM217_DEPLOY_SCOPE: 'production',
          PYTHON_BINARY: python,
          FAKE_DOCKER_LOG: bashPathFor(dockerLog),
        },
      }),
    };
  };

  try {
    const first = runCandidate('1'.repeat(40));
    assert.equal(first.result.status, 0, `${first.result.stdout}\n${first.result.stderr}`);
    const second = runCandidate('2'.repeat(40));
    assert.equal(second.result.status, 0, `${second.result.stdout}\n${second.result.stderr}`);

    const calls = readFileSync(dockerLog, 'utf8').trim().split(/\r?\n/);
    assert.equal(calls.length, 2);
    for (const [call, candidate] of [
      [calls[0], first.candidate],
      [calls[1], second.candidate],
    ]) {
      assert.match(call, /^compose --project-name lunchlineup /);
      assert.match(call, new RegExp(`--project-directory ${bashPathFor(candidate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(call, /--project-name [^\s]*(?:1{40}|2{40})/);
    }

    const beforeDrift = readFileSync(dockerLog, 'utf8');
    const drifted = runCandidate('3'.repeat(40), 'COMPOSE_PROJECT_NAME=release-scoped-project\n');
    assert.notEqual(drifted.result.status, 0);
    assert.match(drifted.result.stderr, /COMPOSE_PROJECT_NAME conflicts with the stable production Compose scope/);
    assert.equal(readFileSync(dockerLog, 'utf8'), beforeDrift, 'scope drift must fail before Docker is invoked');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('VM217 EXIT cleanup fails closed and preserves exact backup snapshots on systemctl or readback failure', { skip: !bashAvailable }, () => {
  const units = ['lunchlineup-backup.timer'];

  const runCase = (failure = '') => {
    const scratch = mkdtempSync(join(tmpdir(), 'll-deploy-backup-restore-'));
    const fakeBin = join(scratch, 'bin');
    const unitDir = join(scratch, 'systemd');
    const systemctlState = join(scratch, 'systemctl-state');
    const snapshotDir = join(scratch, 'backup-systemd-state');
    const backupEnv = join(scratch, 'backup-release.env');
    const previousBackupEnv = join(scratch, 'backup-release.env.previous');
    const runtimeState = join(snapshotDir, 'runtime-state');
    const originalBytes = new Map(units.map((unit) => [unit, `original exact ${unit}\n`]));

    for (const directory of [fakeBin, unitDir, systemctlState, snapshotDir]) mkdirSync(directory);
    writeFileSync(backupEnv, 'candidate=true\n');
    writeFileSync(previousBackupEnv, 'previous=true\n');
    writeFileSync(join(snapshotDir, 'units'), units.map((unit) => `${unit}|true`).join('\n') + '\n');
    writeFileSync(runtimeState, [
      'lunchlineup-backup.timer|true|true|true',
    ].join('\n') + '\n');
    for (const [unit, bytes] of originalBytes) {
      writeFileSync(join(snapshotDir, `unit-${unit}`), bytes);
      writeFileSync(join(unitDir, unit), `candidate ${unit}\n`);
    }
    for (const unit of units) {
      writeFileSync(join(systemctlState, `enabled-${unit}`), 'false');
      writeFileSync(join(systemctlState, `active-${unit}`), 'false');
    }

    const fakeSystemctl = join(fakeBin, 'systemctl');
    writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
set -u
state_dir="\${FAKE_SYSTEMCTL_STATE:?}"
command="\${1:-}"
[ "$#" -eq 0 ] || shift
case "$command" in
  is-enabled)
    unit="\${1:-}"
    if [ "\${FAKE_RESTORE_READBACK_FAIL:-false}" = true ] && [ -f "$state_dir/reloaded" ]; then echo transport-error; exit 9; fi
    if [ -f "$state_dir/enabled-$unit" ]; then echo enabled; exit 0; fi
    echo disabled; exit 1
    ;;
  is-active)
    unit="\${1:-}"
    if [ "\${FAKE_RESTORE_READBACK_FAIL:-false}" = true ] && [ -f "$state_dir/reloaded" ]; then echo transport-error; exit 9; fi
    if [ -f "$state_dir/active-$unit" ]; then echo active; exit 0; fi
    echo inactive; exit 3
    ;;
  enable)
    unit="\${1:-}"
    if [ "\${FAKE_RESTORE_ENABLE_FAIL:-false}" = true ] && [ "$unit" = lunchlineup-backup.timer ]; then exit 8; fi
    touch "$state_dir/enabled-$unit"
    ;;
  disable) for unit in "$@"; do rm -f "$state_dir/enabled-$unit"; done ;;
  start) for unit in "$@"; do touch "$state_dir/active-$unit"; done ;;
  stop) for unit in "$@"; do rm -f "$state_dir/active-$unit"; done ;;
  daemon-reload) touch "$state_dir/reloaded" ;;
  *) exit 91 ;;
esac
`);
    chmodSync(fakeSystemctl, 0o700);

    const result = spawnSync(bashPath, [
      '-c',
      `PATH="$1:$PATH"; export PATH
source "$2"
FAKE_STATE_PATH="$8"
FAKE_RELOADED=false
systemctl() {
  local command="$1"
  shift
  local unit
  case "$command" in
    is-enabled)
      unit="$1"
      if [ "$FAKE_RESTORE_READBACK_FAIL" = true ] && [ "$FAKE_RELOADED" = true ]; then echo transport-error; return 9; fi
      if [ "$(<"$FAKE_STATE_PATH/enabled-$unit")" = true ]; then echo enabled; return 0; fi
      echo disabled; return 1
      ;;
    is-active)
      unit="$1"
      if [ "$FAKE_RESTORE_READBACK_FAIL" = true ] && [ "$FAKE_RELOADED" = true ]; then echo transport-error; return 9; fi
      if [ "$(<"$FAKE_STATE_PATH/active-$unit")" = true ]; then echo active; return 0; fi
      echo inactive; return 3
      ;;
    enable)
      unit="$1"
      if [ "$FAKE_RESTORE_ENABLE_FAIL" = true ] && [ "$unit" = lunchlineup-backup.timer ]; then return 8; fi
      printf true > "$FAKE_STATE_PATH/enabled-$unit"
      ;;
    disable) for unit in "$@"; do printf false > "$FAKE_STATE_PATH/enabled-$unit"; done ;;
    start) for unit in "$@"; do printf true > "$FAKE_STATE_PATH/active-$unit"; done ;;
    stop) for unit in "$@"; do printf false > "$FAKE_STATE_PATH/active-$unit"; done ;;
    daemon-reload) FAKE_RELOADED=true ;;
    *) return 91 ;;
  esac
}
BACKUP_RELEASE_ENV_STAGE_ACTIVE=true
BACKUP_RELEASE_ENV_PATH="$3"
BACKUP_RELEASE_ENV_PREVIOUS_PATH="$4"
BACKUP_RELEASE_ENV_PREVIOUS_EXISTED=true
BACKUP_SYSTEMD_UNIT_DIR="$5"
BACKUP_SYSTEMD_STATE_DIR="$6"
BACKUP_RUNTIME_STATE_PATH="$7"
RUNTIME_ENV_STAGE_ACTIVE=false
trap cleanup_staged_release_state EXIT`,
      'deploy-backup-restore-fixture',
      bashPathFor(fakeBin),
      bashPathFor(deployScript),
      bashPathFor(backupEnv),
      bashPathFor(previousBackupEnv),
      bashPathFor(unitDir),
      bashPathFor(snapshotDir),
      bashPathFor(runtimeState),
      bashPathFor(systemctlState),
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        FAKE_SYSTEMCTL_STATE: bashPathFor(systemctlState),
        FAKE_RESTORE_ENABLE_FAIL: failure === 'systemctl' ? 'true' : 'false',
        FAKE_RESTORE_READBACK_FAIL: failure === 'readback' ? 'true' : 'false',
      },
    });

    assert.equal(result.error?.code, undefined, `${failure || 'success'} case exceeded its deadline`);
    assert.equal(readFileSync(backupEnv, 'utf8'), 'previous=true\n');
    for (const [unit, bytes] of originalBytes) assert.equal(readFileSync(join(unitDir, unit), 'utf8'), bytes);
    return { scratch, snapshotDir, previousBackupEnv, result };
  };

  for (const [failure, expected] of [
    ['systemctl', /could not enable lunchlineup-backup.timer/],
    ['readback', /could not read lunchlineup-backup.timer enabled state/],
  ]) {
    const fixture = runCase(failure);
    try {
      assert.notEqual(fixture.result.status, 0);
      assert.match(`${fixture.result.stdout}\n${fixture.result.stderr}`, expected);
      assert.doesNotMatch(fixture.result.stdout, /backup_release_env_restored/);
      assert.equal(existsSync(fixture.snapshotDir), true, `${failure} failure deleted systemd snapshots`);
      assert.equal(existsSync(fixture.previousBackupEnv), true, `${failure} failure deleted env snapshot`);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }

  const restored = runCase();
  try {
    assert.equal(restored.result.status, 0, `${restored.result.stdout}\n${restored.result.stderr}`);
    assert.match(restored.result.stdout, /backup_release_env_restored path=.* units=exact runtime_state=confirmed/);
    assert.equal(existsSync(restored.snapshotDir), false);
    assert.equal(existsSync(restored.previousBackupEnv), false);
  } finally {
    rmSync(restored.scratch, { recursive: true, force: true });
  }
});

test('VM217 curl health loop times out against a peer that accepts but never responds', { skip: !bashAvailable }, async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const startedAt = Date.now();

  try {
    const result = await runChild(bashPath, [
      '-c',
      'set -euo pipefail; HEALTH_TIMEOUT_SECONDS=2; HEALTH_REQUEST_TIMEOUT_SECONDS=1; HEALTH_POLL_SECONDS=1; source "$1"; docker() { :; }; wait_for_health "$2"',
      'bounded-health-fixture',
      bashPathFor(deployScript),
      `http://127.0.0.1:${port}/health`,
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Health check timed out after 2s/);
    assert.ok(Date.now() - startedAt < 5000, 'health loop must respect its overall deadline');
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  }
});

test('VM217 binds downloaded launch proof to CI checksum, source SHA, and freshness', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const validator = read('scripts/verify-downloaded-launch-proof.py');

  assert.match(script, /require_sha256 "\$LAUNCH_PROOF_ARTIFACT_SHA256"/);
  assert.match(script, /python3 scripts\/verify-downloaded-launch-proof\.py "\$proof_body"/);
  assert.match(validator, /proof\.get\("sourceSha"\) != args\.source_sha/);
  assert.match(validator, /LAUNCH_PROOF_MAX_AGE_SECONDS must be a positive integer/);
  assert.match(validator, /exceeds LAUNCH_PROOF_MAX_AGE_SECONDS/);
  assert.match(script, /--mode "\$launch_proof_mode"/);

  const checksumIndex = script.indexOf('python3 scripts/verify-downloaded-launch-proof.py');
  const proofRecordIndex = script.indexOf('cat > "$proof_tmp"');
  const retainedProofIndex = script.indexOf('mv "$proof_tmp" "$proof_path"');
  const successIndex = script.indexOf('post_deploy_proof_ok');
  assert.ok(checksumIndex !== -1 && checksumIndex < proofRecordIndex);
  assert.ok(proofRecordIndex < retainedProofIndex);
  assert.ok(retainedProofIndex < successIndex);
});

test('VM217 proof validator accepts exact fresh bytes and rejects checksum drift', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-vm217-proof-'));
  const proofPath = join(scratch, 'launch-proof.json');
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const checkedAt = '2026-07-09T12:00:00.000Z';
  const proof = {
    sourceSha,
    generatedAt: checkedAt,
    evidence: {
      runtimeEnv: { checkedAt },
    },
  };
  const proofBytes = `${JSON.stringify(proof)}\n`;
  const sha256 = createHash('sha256').update(proofBytes).digest('hex');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const args = [
    'scripts/verify-downloaded-launch-proof.py',
    proofPath,
    '--source-sha',
    sourceSha,
    '--sha256',
    sha256,
    '--max-age-seconds',
    '86400',
    '--verification-time',
    checkedAt,
  ];

  try {
    writeFileSync(proofPath, proofBytes);
    const valid = spawnSync(python, args, { cwd: root, encoding: 'utf8' });
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /downloaded_launch_proof_ok/);

    const multiDayRollback = spawnSync(python, [
      ...args,
      '--verification-time',
      '2026-08-09T12:00:00.000Z',
      '--mode',
      'rollback',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(multiDayRollback.status, 0, `${multiDayRollback.stdout}\n${multiDayRollback.stderr}`);
    assert.match(multiDayRollback.stdout, /mode=rollback/);

    writeFileSync(proofPath, `${proofBytes} `);
    const drifted = spawnSync(python, args, { cwd: root, encoding: 'utf8' });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /does not match the CI-verified/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('protected launch-proof URI stays out of curl argv and retained proof JSON', { skip: !bashAvailable }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-vm217-protected-proof-'));
  const fakeBin = join(scratch, 'bin');
  const fakeCurl = join(fakeBin, 'curl');
  const argvLog = join(scratch, 'curl-argv.log');
  const configPathLog = join(scratch, 'curl-config-path.log');
  const apiBody = join(scratch, 'api.json');
  const launchProofBody = join(scratch, 'launch-proof.json');
  const externalHealth = join(scratch, 'external-health.json');
  const releaseManifest = join(scratch, 'release-manifest.json');
  const proofDir = join(scratch, 'proofs');
  const proofPath = join(proofDir, 'retained-proof.json');
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const protectedUri = `https://proof-user:proof-password@proofs.lunchlineup.com/releases/${sourceSha}/launch-proof.json?X-Amz-Signature=${'a'.repeat(64)}#private-fragment`;
  try {
    mkdirSync(fakeBin);
    writeFileSync(apiBody, '{"status":"ok"}\n');
    writeFileSync(launchProofBody, `${JSON.stringify({ sourceSha, generatedAt: '2026-07-16T12:00:00.000Z' })}\n`);
    writeFileSync(externalHealth, '{"status":"passed"}\n');
    writeFileSync(releaseManifest, `${JSON.stringify({ sourceSha })}\n`);
    writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
if [[ -r /proc/$$/cmdline ]]; then
  tr '\\0' ' ' < /proc/$$/cmdline >> "$FAKE_CURL_ARGV_LOG"
  printf '\\n' >> "$FAKE_CURL_ARGV_LOG"
else
  printf 'curl' >> "$FAKE_CURL_ARGV_LOG"
  printf ' <%s>' "$@" >> "$FAKE_CURL_ARGV_LOG"
  printf '\\n' >> "$FAKE_CURL_ARGV_LOG"
fi
config=''
output=''
while (( $# > 0 )); do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    -o|--output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$output" ]]
if [[ -n "$config" ]]; then
  grep -Fq -- "$EXPECTED_PROTECTED_URI" "$config"
  printf '%s\\n' "$config" > "$FAKE_CURL_CONFIG_PATH_LOG"
  cp "$FAKE_LAUNCH_PROOF_BODY" "$output"
else
  cp "$FAKE_API_BODY" "$output"
fi
`);
    chmodSync(fakeCurl, 0o755);

    const wrapper = `
set -euo pipefail
source "$1"
EXTERNAL_HEALTH_PROOF_PATH="$2"
PATH="$3:$PATH"
export PATH
python3() {
  if [[ "\${1:-}" == "scripts/verify-downloaded-launch-proof.py" ]]; then return 0; fi
  command "$PYTHON_BINARY" "$@"
}
node() { return 0; }
write_post_deploy_proof
config_path="$(tr -d '\\r\\n' < "$FAKE_CURL_CONFIG_PATH_LOG")"
[[ -n "$config_path" && ! -e "$config_path" ]]
`;
    const result = spawnSync(bashPath, [
      '-c', wrapper, 'protected-proof-fixture', bashPathFor(deployScript), bashPathFor(externalHealth),
      bashPathFor(fakeBin),
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_SOURCE_SHA: sourceSha,
        RELEASE_MANIFEST_PATH: bashPathFor(releaseManifest),
        POST_DEPLOY_PROOF_DIR: bashPathFor(proofDir),
        POST_DEPLOY_PROOF_PATH: bashPathFor(proofPath),
        PRODUCTION_API_HEALTH_URL: 'https://api.lunchlineup.com/health',
        PRODUCTION_WEB_URL: 'https://lunchlineup.com/',
        LAUNCH_PROOF_MANIFEST_URI: protectedUri,
        LAUNCH_PROOF_ARTIFACT_SHA256: createHash('sha256').update(readFileSync(launchProofBody)).digest('hex'),
        FAKE_CURL_ARGV_LOG: bashPathFor(argvLog),
        FAKE_CURL_CONFIG_PATH_LOG: bashPathFor(configPathLog),
        FAKE_API_BODY: bashPathFor(apiBody),
        FAKE_LAUNCH_PROOF_BODY: bashPathFor(launchProofBody),
        EXPECTED_PROTECTED_URI: protectedUri,
        PYTHON_BINARY: process.platform === 'win32' ? 'python' : 'python3',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const argv = readFileSync(argvLog, 'utf8');
    const retainedProofBytes = readFileSync(proofPath, 'utf8');
    const retainedProof = JSON.parse(retainedProofBytes);
    for (const secret of ['proof-user', 'proof-password', 'X-Amz-Signature', 'private-fragment', protectedUri]) {
      assert.equal(argv.includes(secret), false, `curl argv leaked ${secret}`);
      assert.equal(retainedProofBytes.includes(secret), false, `retained proof leaked ${secret}`);
    }
    assert.equal(
      retainedProof.launchProofManifestUri,
      `https://proofs.lunchlineup.com/releases/${sourceSha}/launch-proof.json`,
    );
    assert.equal(retainedProof.launchProofManifestUriRedacted, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('rollback performs compatibility preflight and skips old schema application', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const compose = read('docker-compose.yml');

  assert.match(script, /VM217_DEPLOY_OPERATION:-deploy/);
  assert.match(script, /rollback\)[\s\S]*DEPLOY_MIGRATION_MODE="\$\{DEPLOY_MIGRATION_MODE:-skip\}"/);
  assert.match(script, /Rollback refuses to apply an older release schema/);
  assert.match(script, /MIGRATION_SOURCE_SHA="\$SOURCE_SHA"/);
  assert.match(script, /MIGRATION_BASELINE_SOURCE_SHA="\$EXPECTED_CURRENT_RELEASE_SHA"/);
  assert.match(script, /export MIGRATION_BASELINE_SOURCE_SHA/);
  assert.match(script, /export MIGRATION_SOURCE_SHA/);
  assert.match(script, /npx prisma migrate diff/);
  assert.match(script, /--from-schema-datamodel=\/app\/packages\/db\/prisma\/schema\.prisma/);
  assert.match(script, /--to-url="\$MIGRATION_DATABASE_URL"/);
  assert.match(script, /python3 scripts\/verify-rollback-schema-compatibility\.py "\$diff_path"/);
  assert.match(script, /verify-raw-migration-rollback\.mjs/);
  assert.match(script, /--old-release-compatibility-proof "\$OLD_RELEASE_COMPATIBILITY_PROOF_PATH"/);
  assert.match(script, /Old-release compatibility proof changed after signed transport verification/);
  assert.match(script, /OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256/);
  assert.ok(script.indexOf('preflight_rollback_raw_migrations') < script.indexOf('compose_release up -d --no-build --pull never'));
  assert.match(script, /failed closed/);
  assert.match(script, /ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM/);
  assert.match(script, /ROLLBACK_SCHEMA_COMPATIBILITY_VERIFIED=true/);
  assert.match(compose, /DEPLOY_MIGRATION_MODE=\$\{DEPLOY_MIGRATION_MODE:-apply\}/);
  assert.match(compose, /MIGRATION_SOURCE_SHA=\$\{MIGRATION_SOURCE_SHA:-\}/);
  assert.match(compose, /MIGRATION_BASELINE_SOURCE_SHA=\$\{MIGRATION_BASELINE_SOURCE_SHA:-\}/);
  assert.match(compose, /MIGRATION_FRESH_DATABASE_CONFIRM=\$\{MIGRATION_FRESH_DATABASE_CONFIRM:-\}/);
  assert.match(compose, /skip\)[\s\S]*ROLLBACK_SCHEMA_COMPATIBILITY_VERIFIED/);
  assert.match(compose, /apply\)[\s\S]*exec node scripts\/apply-db-migrations\.mjs/);
  assert.doesNotMatch(script, /prisma db push/);
});

test('candidate deploy blocks authenticated registry and live-pointer disagreement before mutation', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const productionDeploy = script.slice(
    script.indexOf('run_production_release_deploy()'),
    script.indexOf('run_development_source_deploy()'),
  );
  assert.match(script, /preflight_expected_current_release/);
  assert.match(script, /Live release SHA does not match the authenticated release registry current pointer/);
  assert.ok(
    productionDeploy.indexOf('preflight_expected_current_release') < productionDeploy.indexOf('pull_release_images'),
    'live/current-pointer agreement must precede image pulls and mutation',
  );
});

test('deploy delegates owner DDL exclusively to the migration service', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const compose = read('docker-compose.yml');
  const productionDeploy = script.slice(
    script.indexOf('run_production_release_deploy()'),
    script.indexOf('run_development_source_deploy()'),
  );
  const developmentDeploy = script.slice(
    script.indexOf('run_development_source_deploy()'),
    script.indexOf('case "$DEPLOY_SCOPE" in'),
  );

  assert.match(productionDeploy, /compose_release up -d --no-build --pull never/);
  assert.match(developmentDeploy, /migrate pgbouncer postgres/);
  assert.match(compose, /apply\)[\s\S]*exec node scripts\/apply-db-migrations\.mjs/);
  assert.doesNotMatch(script, /compose_release exec -T api/);
  assert.doesNotMatch(script, /docker compose[^\n]*exec -T api/);
  assert.doesNotMatch(script, /prisma db execute/);
  assert.doesNotMatch(script, /20260321_plan_definitions\.sql/);
});

test('rollback schema preflight allows compatible additive DDL and rejects write-breaking or unknown drift', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-schema-'));
  const diffPath = join(scratch, 'schema-diff.sql');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = (sql) => {
    writeFileSync(diffPath, sql);
    return spawnSync(python, ['scripts/verify-rollback-schema-compatibility.py', diffPath], {
      cwd: root,
      encoding: 'utf8',
    });
  };

  try {
    const exact = run('-- This is an empty migration.\n');
    assert.equal(exact.status, 0, `${exact.stdout}\n${exact.stderr}`);
    assert.match(exact.stdout, /policy=backward-compatible-additive/);

    const additive = run(`
      CREATE TYPE "AuditKind" AS ENUM ('created', 'updated');
      CREATE TABLE "AuditEvent" (
        "id" TEXT NOT NULL,
        "kind" "AuditKind" NOT NULL,
        CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX "AuditEvent_id_key" ON "AuditEvent"("id");
      ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_user_fkey" FOREIGN KEY ("id") REFERENCES "User"("id");
      ALTER TABLE "User"
        ADD COLUMN "nickname" TEXT,
        ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN "label" TEXT NOT NULL DEFAULT 'semi;colon';
      CREATE INDEX "User_nickname_idx" ON "User"("nickname");
    `);
    assert.equal(additive.status, 0, `${additive.stdout}\n${additive.stderr}`);
    assert.match(additive.stdout, /create_table=1/);
    assert.match(additive.stdout, /add_column_nullable=1/);
    assert.match(additive.stdout, /add_column_defaulted=2/);
    assert.match(additive.stdout, /create_index=1/);

    for (const sql of [
      'ALTER TABLE "User" ADD COLUMN "required" TEXT NOT NULL;\n',
      'ALTER TABLE "Shift" ADD CONSTRAINT "Shift_window_check" CHECK ("end" > "start");\n',
      'CREATE UNIQUE INDEX "User_email_key" ON "User"("email");\n',
      'ALTER TABLE "User" ALTER COLUMN "email" TYPE VARCHAR(64);\n',
      'DROP TABLE "User";\n',
      'VACUUM "User";\n',
    ]) {
      const rejected = run(sql);
      assert.notEqual(rejected.status, 0);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /failed closed/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('raw migration rollback policy requires exact approval and rejects trigger and RLS policy deltas', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-raw-migration-rollback-'));
  const migrationPath = 'packages/db/prisma/migrations/20990101_candidate.sql';
  const absoluteMigration = join(scratch, ...migrationPath.split('/'));
  const rollbackManifestPath = join(scratch, 'rollback.json');
  const candidateManifestPath = join(scratch, 'candidate.json');
  const policyPath = join(scratch, 'policy.json');
  const classifierPath = join(root, 'scripts/verify-rollback-schema-compatibility.py');
  const run = (sql, approved = true) => {
    mkdirSync(dirname(absoluteMigration), { recursive: true });
    writeFileSync(absoluteMigration, sql);
    const digest = createHash('sha256').update(sql).digest('hex');
    const contract = (files, rawMigrations) => ({ algorithm: 'sha256', files, rawMigrations: { version: 1, files: rawMigrations } });
    writeFileSync(rollbackManifestPath, JSON.stringify({ deploymentContract: contract({}, {}) }));
    writeFileSync(candidateManifestPath, JSON.stringify({ deploymentContract: contract({ [migrationPath]: digest }, { [migrationPath]: digest }) }));
    writeFileSync(policyPath, JSON.stringify({
      version: 2,
      historicalBaselineSourceSha: '0'.repeat(40),
      historicalMigrations: {},
      compatibilityClass: 'backward-compatible-additive-v1',
      migrations: approved ? { [migrationPath]: { sha256: digest, compatibility: 'backward-compatible-additive-v1' } } : {},
    }));
    return spawnSync(process.execPath, [
      'scripts/verify-raw-migration-rollback.mjs',
      '--rollback-manifest', rollbackManifestPath,
      '--candidate-manifest', candidateManifestPath,
      '--candidate-root', scratch,
      '--policy', policyPath,
      '--classifier', classifierPath,
    ], { cwd: root, encoding: 'utf8' });
  };

  try {
    const safe = run('CREATE TABLE "NewAudit" ("id" TEXT NOT NULL, CONSTRAINT "NewAudit_pkey" PRIMARY KEY ("id"));\n');
    assert.equal(safe.status, 0, `${safe.stdout}\n${safe.stderr}`);
    assert.match(safe.stdout, /candidate_only=1/);

    const unapproved = run('CREATE TABLE "NewAudit" ("id" TEXT);\n', false);
    assert.notEqual(unapproved.status, 0);
    assert.match(unapproved.stderr, /lacks an exact additive approval or expand\/contract design/);

    for (const sql of [
      'CREATE TRIGGER "User_touch" BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION touch_user();\n',
      'CREATE POLICY "User_tenant" ON "User" USING (true);\n',
    ]) {
      const rejected = run(sql);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /destructive, trigger\/RLS-bearing, or unknown/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('release pointers advance only after retained proof and use staged atomic writes', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const productionDeploy = script.slice(
    script.indexOf('run_production_release_deploy()'),
    script.indexOf('run_development_source_deploy()'),
  );

  assert.ok(productionDeploy.indexOf('write_post_deploy_proof') < productionDeploy.indexOf('stage_backup_release_pointer'));
  assert.ok(productionDeploy.indexOf('stage_backup_release_pointer') < productionDeploy.indexOf('verify-backup-readiness.sh'));
  assert.ok(productionDeploy.indexOf('verify-backup-readiness.sh') < productionDeploy.indexOf('commit_release_pointers'));
  assert.match(script, /mktemp "\$APP_DIR\/DEPLOYED_GIT_SHA\.tmp\.XXXXXX"/);
  assert.match(script, /chmod 440 -- "\$APP_DIR\/DEPLOYED_GIT_SHA"/);
  assert.match(script, /expected_release="\$production_root\/releases\/\$\{SOURCE_SHA,,\}"/);
  assert.match(script, /Production APP_DIR must be the exact retained releases\/<source SHA> path/);
  assert.match(script, /lock_candidate_release_bytes/);
  assert.match(script, /find "\$APP_DIR" -type d[\s\S]*chmod 550/);
  assert.match(script, /"\$ACTIVE_RELEASE_POINTER\/DEPLOYED_GIT_SHA"[\s\S]*"\$SOURCE_SHA"/);
  assert.match(script, /mktemp "\$POST_DEPLOY_PROOF_DIR\/deploy-proof\.tmp\.XXXXXX"/);
  assert.match(script, /mv "\$proof_tmp" "\$proof_path"/);
  assert.match(script, /the staged release state will be restored/);
  assert.match(script, /trap cleanup_staged_release_state EXIT/);
  assert.doesNotMatch(productionDeploy, /> DEPLOYED_GIT_SHA/);
});

test('fresh-runner DAST and load jobs pull every started third-party image before pull-never startup', () => {
  const ci = read('.github/workflows/ci.yml');
  const requiredPull = 'docker compose --env-file .env.smoke pull proxy pgbouncer postgres redis rabbitmq';
  const startup = 'docker compose --env-file .env.smoke up -d --no-build --pull never migrate proxy web api engine worker pgbouncer postgres redis rabbitmq';

  for (const [job, nextJob] of [['dast', 'e2e-tests'], ['load-test', 'validate-release-gates']]) {
    const block = ci.slice(ci.indexOf(`  ${job}:`), ci.indexOf(`  ${nextJob}:`));
    assert.ok(block.indexOf(requiredPull) !== -1, `${job} must pull third-party images`);
    assert.ok(block.indexOf(requiredPull) < block.indexOf(startup), `${job} must pull before startup`);
  }
});

test('production workflow carries the verified proof digest into deploy and smoke', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /id: launch_proof/);
  assert.match(ci, /launch_proof_sha256="\$\(sha256sum "\$launch_proof"/);
  assert.match(ci, /LAUNCH_PROOF_ARTIFACT_SHA256=\$launch_proof_sha256/);
  assert.match(ci, /launch_proof_sha256: \$\{\{ steps\.launch_proof\.outputs\.sha256 \}\}/);
  assert.match(ci, /LAUNCH_PROOF_ARTIFACT_SHA256: \$\{\{ env\.DEPLOYED_LAUNCH_PROOF_SHA256 \}\}/);
  assert.match(ci, /--expected-launch-proof-sha256 "\$LAUNCH_PROOF_ARTIFACT_SHA256"/);
  assert.match(ci, /--max-proof-age-seconds "\$LAUNCH_PROOF_MAX_AGE_SECONDS"/);
  assert.match(ci, /PRODUCTION_API_HEALTH_URL: \$\{\{ vars\.PRODUCTION_API_HEALTH_URL \}\}/);
  assert.match(ci, /PRODUCTION_WEB_URL: \$\{\{ vars\.PRODUCTION_WEB_URL \}\}/);
  assert.match(ci, /LAUNCH_PROOF_MANIFEST_URI: \$\{\{ secrets\.LAUNCH_PROOF_MANIFEST_URI \}\}/);
  assert.match(ci, /test -n "\$PRODUCTION_API_HEALTH_URL"/);
  assert.match(ci, /test -n "\$PRODUCTION_WEB_URL"/);
  assert.match(ci, /test -n "\$LAUNCH_PROOF_MANIFEST_URI"/);
  assert.match(ci, /EXPECTED_CURRENT_RELEASE_SHA: \$\{\{ env\.EXPECTED_CURRENT_RELEASE_SHA \}\}/);
  assert.match(ci, /EXPECTED_CURRENT_RELEASE_SHA="\$EXPECTED_CURRENT_RELEASE_SHA"/);
  assert.doesNotMatch(ci, /run:.*\$\{\{ (?:vars\.PRODUCTION_(?:API_HEALTH|WEB)_URL|secrets\.LAUNCH_PROOF_MANIFEST_URI) \}\}/);
});
