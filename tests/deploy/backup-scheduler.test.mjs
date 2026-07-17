import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function exists(path) {
  return existsSync(join(root, path));
}

function bashPath(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

function findBash() {
  const candidate = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  return spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0 ? candidate : undefined;
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o700);
}

function serviceBlock(compose, serviceName) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `missing Compose service: ${serviceName}`);

  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      break;
    }
    block.push(line);
  }
  return block.join('\n');
}

function unitValue(unit, key) {
  const line = unit.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  assert.ok(line, `missing ${key}= in unit`);
  return line.slice(key.length + 1);
}

test('backup scheduler artifacts are present and inventoried', () => {
  for (const path of [
    'infrastructure/systemd/lunchlineup-backup.env.example',
    'infrastructure/systemd/lunchlineup-backup.service',
    'infrastructure/systemd/lunchlineup-backup.timer',
  ]) {
    assert.equal(exists(path), true, `${path} must exist`);
  }

  const systemdReadme = read('infrastructure/systemd/README.md');
  const deployReadme = read('tests/deploy/README.md');
  assert.match(systemdReadme, /`lunchlineup-backup\.env\.example`/);
  assert.match(systemdReadme, /`lunchlineup-backup\.service`/);
  assert.match(systemdReadme, /`lunchlineup-backup\.timer`/);
  assert.match(deployReadme, /`backup-scheduler\.test\.mjs`/);
});

test('Compose exposes backup only as an encrypted offsite ops job', () => {
  const compose = read('docker-compose.yml');
  const backup = serviceBlock(compose, 'backup');

  assert.match(backup, /profiles:\s*\n\s+- ops/);
  assert.match(backup, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/backup:\$\{IMAGE_TAG:-local\}"/);
  assert.match(backup, /dockerfile: infrastructure\/docker\/Dockerfile\.backup/);
  assert.doesNotMatch(backup, /env_file:/);
  assert.match(backup, /POSTGRES_USER=\$\{POSTGRES_USER:\?Set POSTGRES_USER in \.env\}/);
  assert.match(backup, /PGPASSWORD=\$\{POSTGRES_PASSWORD:\?Set POSTGRES_PASSWORD in \.env\}/);
  assert.match(backup, /BACKUP_ENCRYPTION_KEY_FILE=\/run\/secrets\/backup_key/);
  assert.match(backup, /BACKUP_OFFSITE_ENABLED=true/);
  assert.match(backup, /BACKUP_OFFSITE_URI=\$\{BACKUP_OFFSITE_URI:-\}/);
  assert.match(backup, /BACKUP_OFFSITE_RETENTION_DAYS=\$\{BACKUP_OFFSITE_RETENTION_DAYS:-35\}/);
  assert.match(backup, /BACKUP_OFFSITE_RETENTION_DRY_RUN=\$\{BACKUP_OFFSITE_RETENTION_DRY_RUN:-false\}/);
  assert.match(backup, /AWS_SHARED_CREDENTIALS_FILE=\/run\/secrets\/backup-offsite\/aws-credentials/);
  assert.match(backup, /RCLONE_CONFIG=\/run\/secrets\/backup-offsite\/rclone\.conf/);
  assert.match(backup, /BACKUP_METRICS_FILE=\/metrics\/lunchlineup_backup\.prom/);
  assert.match(backup, /source: backup_encryption_key[\s\S]*target: backup_key/);
  assert.match(backup, /backup_data:\/backups/);
  assert.match(backup, /NODE_EXPORTER_TEXTFILE_DIR:-\/var\/lib\/node_exporter\/textfile_collector\}:\/metrics/);
  assert.match(backup, /BACKUP_OFFSITE_CREDENTIALS_DIR:-\.\/secrets\/backup-offsite\}:\/run\/secrets\/backup-offsite:ro/);
  assert.match(backup, /networks:[\s\S]*- external[\s\S]*- data/);
  assert.match(backup, /postgres:[\s\S]*condition: service_healthy/);
  assert.match(backup, /restart: "no"/);
  assert.doesNotMatch(backup, /BACKUP_ENCRYPTION_KEY=/);
  assert.doesNotMatch(backup, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|RCLONE_CONFIG_PASS/);
  assert.doesNotMatch(backup, /ports:/);

  assert.match(compose, /^  backup_data:\s*$/m);
  assert.match(compose, /backup_encryption_key:[\s\S]*BACKUP_ENCRYPTION_KEY_SECRET_FILE:-\/run\/secrets\/backup_key/);
  const backupScript = read('scripts/backup.sh');
  assert.match(backupScript, /AWS_SHARED_CREDENTIALS_FILE must name a readable dedicated credentials file/);
  assert.match(backupScript, /Mutable rclone repositories cannot satisfy immutable production logical-backup proof/);
  assert.match(backupScript, /--if-none-match '\*'/);
  assert.match(backupScript, /--object-lock-mode COMPLIANCE/);
});

test('systemd runs the deployed backup image daily without pulls or dependency mutation', () => {
  const service = read('infrastructure/systemd/lunchlineup-backup.service');
  const timer = read('infrastructure/systemd/lunchlineup-backup.timer');
  const envExample = read('infrastructure/systemd/lunchlineup-backup.env.example');
  const pitrEnvExample = read('infrastructure/systemd/lunchlineup-pitr-base-backup.env.example');

  assert.match(service, /EnvironmentFile=\/etc\/lunchlineup\/backup\.env/);
  assert.match(service, /EnvironmentFile=\/var\/lib\/lunchlineup\/backup-release\.env/);
  const pitrService = read('infrastructure/systemd/lunchlineup-pitr-base-backup.service');
  assert.match(pitrService, /EnvironmentFile=\/var\/lib\/lunchlineup\/backup-release\.env/);
  assert.equal(
    unitValue(service, 'ExecStart'),
    '/bin/bash -ec \'exec /bin/bash "/opt/lunchlineup/releases/${IMAGE_TAG}/scripts/pitr-run-candidate-job.sh" lunchlineup-backup.service\'',
  );
  assert.equal(
    unitValue(pitrService, 'ExecStart'),
    '/bin/bash -ec \'exec /bin/bash "/opt/lunchlineup/releases/${IMAGE_TAG}/scripts/pitr-run-candidate-job.sh" lunchlineup-pitr-base-backup.service\'',
  );
  assert.doesNotMatch(unitValue(service, 'ExecStart'), /\/opt\/lunchlineup\/current/);
  assert.match(service, /User=lunchlineup/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /TimeoutStartSec=2h/);

  assert.match(timer, /OnCalendar=\*-\*-\* 02:17:00/);
  assert.match(timer, /RandomizedDelaySec=30m/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=lunchlineup-backup\.service/);

  assert.match(envExample, /^COMPOSE_PROJECT_NAME=lunchlineup$/m);
  assert.doesNotMatch(envExample, /^COMPOSE_SERVICE_ENV_FILE=/m);
  assert.doesNotMatch(pitrEnvExample, /^COMPOSE_SERVICE_ENV_FILE=/m);
  assert.match(envExample, /backup-release\.env/);
  assert.match(pitrEnvExample, /backup-release\.env/);
  assert.match(envExample, /^BACKUP_OFFSITE_RETENTION_DAYS=35$/m);
  assert.match(envExample, /^BACKUP_OFFSITE_RETENTION_DRY_RUN=false$/m);
  assert.doesNotMatch(envExample, /BACKUP_ENCRYPTION_KEY=/);
});

test('backup is a required CI release and deploy artifact', () => {
  const ci = read('.github/workflows/ci.yml');
  const verifier = read('scripts/verify-release-artifacts.mjs');
  const deploy = read('scripts/deploy-vm217-remote.sh');
  const dockerfile = read('infrastructure/docker/Dockerfile.backup');

  assert.match(ci, /id: build_backup/);
  assert.match(ci, /file: infrastructure\/docker\/Dockerfile\.backup/);
  assert.match(ci, /backup_ref: \$\{\{ steps\.release_manifest\.outputs\.backup_ref \}\}/);
  assert.match(ci, /"backup": \{ "ref": "\$\{BACKUP_REF\}"/);
  assert.match(verifier, /requiredServices = \[[^\]]*'backup'/);
  assert.match(verifier, /\|backup\)/);
  assert.match(deploy, /required_services = \[[^\]]*"backup"/);
  assert.match(deploy, /BACKUP_RELEASE_ENV_PATH/);
  assert.match(deploy, /backup_release_env_ok/);
  assert.match(deploy, /verify-backup-readiness\.sh/);
  assert.match(deploy, /validate-production-launch\.mjs "\$COMPOSE_SERVICE_ENV_FILE" --verify-local-secret-files/);
  assert.match(dockerfile, /postgresql-client/);
  assert.match(dockerfile, /\baws-cli\b/);
  assert.match(dockerfile, /\brclone\b/);
  assert.match(dockerfile, /CMD \["\.\/backup\.sh"\]/);
});

test('deploy validates systemd services and successful backup proof before enabling timers', () => {
  const verifier = read('scripts/verify-backup-readiness.sh');
  const deploy = read('scripts/deploy-vm217-remote.sh');

  for (const environmentFile of [
    '/etc/lunchlineup/backup.env',
    '/var/lib/lunchlineup/backup-release.env',
    '/etc/lunchlineup/pitr-base-backup.env',
  ]) {
    assert.match(verifier, new RegExp(environmentFile.replaceAll('/', '\\/')));
  }
  assert.match(verifier, /systemd-analyze verify/);
  assert.match(verifier, /systemctl disable --now "\$\{timers\[@\]\}"/);
  assert.match(verifier, /trap cleanup_verification EXIT/);
  assert.match(verifier, /restore_systemd_state/);
  assert.match(verifier, /systemctl start "\$service"/);
  assert.match(verifier, /--property=Result --value/);
  assert.match(verifier, /--property=ExecMainStatus --value/);
  assert.match(verifier, /offsite_immutable_ok/);
  assert.match(verifier, /lifecycle_owned/);
  assert.match(verifier, /authenticated provider principal/);
  assert.match(verifier, /provider observation is stale, pre-run, or from the future/);
  assert.match(verifier, /expiry_owner/);
  assert.doesNotMatch(verifier, /^docker compose /m);

  const backupStart = verifier.indexOf('run_backup_service lunchlineup-backup.service');
  const backupMetricsProof = verifier.indexOf('verify_service_metric lunchlineup-backup.service');
  const pitrStart = verifier.indexOf('run_backup_service lunchlineup-pitr-base-backup.service');
  const pitrMetricsProof = verifier.indexOf('verify_service_metric lunchlineup-pitr-base-backup.service');
  const enableTimers = verifier.indexOf('systemctl enable --now "${timers[@]}"');
  assert.ok(backupStart > 0 && backupMetricsProof > backupStart && pitrStart > backupMetricsProof);
  assert.ok(pitrMetricsProof > pitrStart && enableTimers > pitrMetricsProof);

  for (const timer of ['lunchlineup-backup.timer', 'lunchlineup-pitr-base-backup.timer']) {
    assert.match(verifier, new RegExp(timer.replace('.', '\\.')));
  }
  assert.match(verifier, /actual_enabled="\$\(read_enabled_state "\$unit" true\)"/);
  assert.match(verifier, /actual_active="\$\(read_active_state "\$unit" true\)"/);
  assert.match(verifier, /offsite_retention_ok/);
  assert.match(verifier, /backup_ok/);
  assert.match(verifier, /pitr-verify-storage\.sh/);
  assert.match(verifier, /pitr_base_backup_ok/);
  assert.match(verifier, /lunchlineup_backup_last_success_timestamp_seconds/);
  assert.match(verifier, /lunchlineup_pitr_base_backup_last_success_timestamp_seconds/);
  const stagePointer = deploy.lastIndexOf('stage_backup_release_pointer');
  const verifyBackup = deploy.lastIndexOf('verify-backup-readiness.sh');
  const commitPointers = deploy.lastIndexOf('commit_release_pointers');
  assert.ok(stagePointer < verifyBackup && verifyBackup < commitPointers);
  assert.match(deploy, /trap cleanup_staged_release_state EXIT/);
  assert.match(deploy, /backup_release_env_restored/);
  const candidateRunner = read('scripts/pitr-run-candidate-job.sh');
  for (const unitPath of [
    'infrastructure/systemd/lunchlineup-backup.service',
    'infrastructure/systemd/lunchlineup-pitr-base-backup.service',
  ]) {
    const unit = read(unitPath);
    assert.equal(unitValue(unit, 'WorkingDirectory'), '/');
    assert.match(unitValue(unit, 'ExecStart'), /\/opt\/lunchlineup\/releases\/\$\{IMAGE_TAG\}\/scripts\/pitr-run-candidate-job\.sh/);
    assert.doesNotMatch(unitValue(unit, 'ExecStart'), /\/opt\/lunchlineup\/current/);
  }
  assert.match(candidateRunner, /INVOCATION_ID="\$\{INVOCATION_ID:\?systemd INVOCATION_ID is required\}"/);
  assert.match(candidateRunner, /candidate_from_script/);
  assert.match(candidateRunner, /PRODUCTION_RUNTIME_ENV_SHA256/);
  assert.match(candidateRunner, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(candidateRunner, /config\.services\[service\]\.image = imageDigest/);
  assert.match(candidateRunner, /lunchlineup-backup\.service\) compose_service=backup/);
  assert.match(candidateRunner, /lunchlineup-pitr-base-backup\.service\) compose_service=pitr-base-backup/);
  assert.match(candidateRunner, /--file "\$immutable_config_json"/);
  assert.match(candidateRunner, /candidate_release_job_ok .*invocation_id=%s .*candidate_path=%s .*source_sha=%s .*image_ref=%s .*image_digest=%s/);
  assert.match(verifier, /_SYSTEMD_INVOCATION_ID=\$invocation_id/);
  assert.match(verifier, /candidate release journal must contain exactly one completion binding/);
  assert.match(verifier, /backup_readiness_ok release_sha=%s candidate_path=%s backup_invocation_id=%s backup_image_digest=%s pitr_invocation_id=%s pitr_image_digest=%s/);
});

test('candidate systemd job survives a deterministic tag retag and executes the snapshotted immutable digest', (t) => {
  const bash = findBash();
  if (!bash) {
    t.skip('Bash is not available');
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-candidate-backup-job-'));
  const releases = join(scratch, 'releases');
  const sourceSha = 'a'.repeat(40);
  const candidate = join(releases, sourceSha);
  const scripts = join(candidate, 'scripts');
  const fakeBin = join(scratch, 'bin');
  const runtimeEnv = join(scratch, 'runtime.env');
  const dockerLog = join(scratch, 'docker.log');
  const bindingLog = join(scratch, 'binding.log');
  const runConfigLog = join(scratch, 'run-config.log');
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  try {
    for (const path of [scripts, fakeBin]) mkdirSync(path, { recursive: true });
    const runner = join(scripts, 'pitr-run-candidate-job.sh');
    writeExecutable(runner, read('scripts/pitr-run-candidate-job.sh'));
    writeFileSync(join(candidate, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(runtimeEnv, 'POSTGRES_PASSWORD=protected-fixture\n');
    const runtimeSha = createHash('sha256').update(readFileSync(runtimeEnv)).digest('hex');
    writeExecutable(join(fakeBin, 'docker'), `#!/bin/sh
set -eu
printf '%s\n' "$*" >>'${bashPath(dockerLog)}'
case " $* " in
  *' compose '*' config --format json '*)
    printf '{"services":{"backup":{"image":"fixture/backup:${sourceSha}"},"pitr-base-backup":{"image":"postgres:16-alpine@sha256:%s"}}}\n' '${'c'.repeat(64)}'
    ;;
  *' image inspect '*) printf '%s\n' '${imageDigest}' ;;
  *' compose '*' run --detach --no-deps --pull never '*)
    previous=''
    run_config=''
    for argument in "$@"; do
      if [ "$previous" = '--file' ]; then run_config="$argument"; fi
      previous="$argument"
    done
    [ -n "$run_config" ]
    grep -q '"image":"${imageDigest}"' "$run_config"
    cat "$run_config" >>'${bashPath(runConfigLog)}'
    printf '\n' >>'${bashPath(runConfigLog)}'
    printf '%s|%s|%s|%s|%s\n' \
      "\${CANDIDATE_SYSTEMD_INVOCATION_ID:-}" \
      "\${CANDIDATE_RELEASE_PATH:-}" \
      "\${CANDIDATE_SOURCE_SHA:-}" \
      "\${CANDIDATE_IMAGE_DIGEST:-}" \
      "\${PITR_REQUIRE_CANDIDATE_BINDING:-}" >>'${bashPath(bindingLog)}'
    printf '%s\n' '${'d'.repeat(64)}'
    ;;
  *' wait '${'d'.repeat(64)}*) printf '0\n' ;;
  *' logs '${'d'.repeat(64)}*) : ;;
  *' rm -f '${'d'.repeat(64)}*) : ;;
  *' ps -a --no-trunc --filter id='${'d'.repeat(64)}*) : ;;
  *) exit 90 ;;
esac
`);
    const run = (service, invocationId) => spawnSync(bash, [
      '-c',
      'PATH="$1:$PATH"; export PATH; shift; exec bash "$@"',
      'candidate-job-fixture',
      bashPath(fakeBin),
      bashPath(runner),
      service,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        IMAGE_PREFIX: 'fixture',
        IMAGE_TAG: sourceSha,
        COMPOSE_PROJECT_NAME: 'lunchlineup',
        COMPOSE_SERVICE_ENV_FILE: bashPath(runtimeEnv),
        PRODUCTION_RUNTIME_ENV_SHA256: runtimeSha,
        INVOCATION_ID: invocationId,
        CANDIDATE_RELEASE_ROOT: bashPath(releases),
      },
    });

    const backup = run('lunchlineup-backup.service', '1'.repeat(32));
    assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
    assert.match(backup.stdout, new RegExp(`candidate_release_job_ok service=lunchlineup-backup.service invocation_id=${'1'.repeat(32)} candidate_path=${bashPath(candidate)} source_sha=${sourceSha} .*image_digest=${imageDigest}`));
    const pitr = run('lunchlineup-pitr-base-backup.service', '2'.repeat(32));
    assert.equal(pitr.status, 0, `${pitr.stdout}\n${pitr.stderr}`);
    assert.match(pitr.stdout, new RegExp(`candidate_release_job_ok service=lunchlineup-pitr-base-backup.service invocation_id=${'2'.repeat(32)}`));

    const bindings = readFileSync(bindingLog, 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(bindings, [
      `${'1'.repeat(32)}|${bashPath(candidate)}|${sourceSha}|${imageDigest}|true`,
      `${'2'.repeat(32)}|${bashPath(candidate)}|${sourceSha}|${imageDigest}|true`,
    ]);
    const dockerCalls = readFileSync(dockerLog, 'utf8');
    assert.match(dockerCalls, /--project-name lunchlineup/);
    assert.match(dockerCalls, new RegExp(`--project-directory ${bashPath(candidate)}`));
    assert.doesNotMatch(dockerCalls, new RegExp(`--project-name [^\\s]*${sourceSha}`));
    assert.doesNotMatch(dockerCalls, /\/opt\/lunchlineup\/current/);
    const immutableConfigs = readFileSync(runConfigLog, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(immutableConfigs[0].services.backup.image, imageDigest);
    assert.equal(immutableConfigs[1].services['pitr-base-backup'].image, imageDigest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('backup readiness keeps the transport-owned candidate path exact and restores state after bounded failures and timeouts', (t) => {
  const bash = findBash();
  if (!bash) {
    t.skip('Bash is not available');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-backup-readiness-'));
  const fakeBin = join(scratch, 'bin');
  const unitDir = join(scratch, 'systemd');
  const stateDir = join(scratch, 'state');
  const metricsDir = join(scratch, 'metrics');
  const envDir = join(scratch, 'env');
  const snapshotRoot = join(scratch, 'restore-snapshots');
  const composeEnv = join(envDir, 'compose.env');
  const backupEnv = join(envDir, 'backup.env');
  const releaseEnv = join(envDir, 'backup-release.env');
  const pitrEnv = join(envDir, 'pitr.env');
  const storageVerifier = join(scratch, 'pitr-storage-verify.sh');
  const systemctlLog = join(scratch, 'systemctl.log');
  const dockerLog = join(scratch, 'docker.log');
  const fakeClockLog = join(scratch, 'fake-clock.log');
  const fakeClockState = join(scratch, 'fake-clock.state');
  const containerState = join(stateDir, 'candidate-container');
  const releaseSha = 'a'.repeat(40);
  const candidateDir = join(scratch, 'releases', releaseSha);
  const candidateSystemdDir = join(candidateDir, 'infrastructure', 'systemd');
  const candidateEntrypoint = join(candidateDir, 'scripts', 'deploy-vm217-remote.sh');
  const candidateRunner = join(candidateDir, 'scripts', 'pitr-run-candidate-job.sh');
  const sourceEntrypoint = join(scratch, 'scripts', 'deploy-vm217-remote.sh');
  const candidateManifest = join(candidateDir, '.release', 'release-manifest.json');
  const protectedChannel = join(scratch, 'protected-channel');
  const remoteTransportScript = join(scratch, 'transport-remote.sh');
  const transportPathLog = join(scratch, 'transport-path.log');
  const script = join(root, 'scripts/verify-backup-readiness.sh');
  const units = [
    'lunchlineup-backup.service',
    'lunchlineup-pitr-base-backup.service',
    'lunchlineup-backup.timer',
    'lunchlineup-pitr-base-backup.timer',
  ];
  const originalBytes = new Map(units.map((unit) => [unit, `previous exact bytes for ${unit}\n`]));

  try {
    for (const directory of [
      fakeBin,
      unitDir,
      stateDir,
      metricsDir,
      envDir,
      snapshotRoot,
      candidateSystemdDir,
      dirname(candidateEntrypoint),
      dirname(sourceEntrypoint),
      dirname(candidateManifest),
    ]) mkdirSync(directory, { recursive: true });
    for (const [unit, content] of originalBytes) writeFileSync(join(unitDir, unit), content);
    for (const unit of units) writeFileSync(join(candidateSystemdDir, unit), read(`infrastructure/systemd/${unit}`));
    for (const path of [composeEnv, backupEnv, releaseEnv, pitrEnv]) writeFileSync(path, 'fixture=true\n');
    writeExecutable(candidateRunner, read('scripts/pitr-run-candidate-job.sh'));
    writeFileSync(join(candidateDir, 'docker-compose.yml'), 'services: {}\n');
    const candidateEntrypointBytes = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$APP_DIR" > "$FAKE_TRANSPORT_PATH_LOG"
exec bash "$REAL_READINESS_SCRIPT"
`;
    writeExecutable(candidateEntrypoint, candidateEntrypointBytes);
    writeExecutable(sourceEntrypoint, candidateEntrypointBytes);
    const manifestBytes = `${JSON.stringify({ sourceSha: releaseSha })}\n`;
    writeFileSync(candidateManifest, manifestBytes);
    writeFileSync(protectedChannel, '-\n', { mode: 0o600 });
    chmodSync(protectedChannel, 0o600);
    const transport = read('scripts/deploy-vm217-transport.sh');
    const remoteMatch = transport.match(/<<'REMOTE_SCRIPT'\r?\n([\s\S]*?)\r?\nREMOTE_SCRIPT/);
    assert.ok(remoteMatch, 'transport remote materialization script is missing');
    writeExecutable(remoteTransportScript, remoteMatch[1]);
    for (const unit of units) {
      writeFileSync(join(stateDir, `enabled-${unit}`), 'false');
      writeFileSync(join(stateDir, `active-${unit}`), 'false');
    }
    writeFileSync(join(stateDir, 'enabled-lunchlineup-backup.timer'), 'true');
    writeFileSync(join(stateDir, 'active-lunchlineup-backup.timer'), 'true');

    writeExecutable(storageVerifier, `#!/bin/sh
[ "\${FAKE_FAIL_PHASE:-}" != storage ]
`);
    writeExecutable(join(fakeBin, 'id'), `#!/bin/sh
if [ "\${1:-}" = -u ]; then echo 0; exit 0; fi
exit 1
`);
    writeExecutable(join(fakeBin, 'stat'), `#!/bin/sh
target=''
for argument in "$@"; do target="$argument"; done
if [ "$target" = "$FAKE_PROTECTED_CHANNEL" ] && [ "\${1:-}" = -c ] && [ "\${2:-}" = %a ]; then
  echo 600
  exit 0
fi
exec /usr/bin/stat "$@"
`);
    writeExecutable(join(fakeBin, 'systemd-analyze'), `#!/bin/sh
[ "\${FAKE_FAIL_PHASE:-}" != unit-verify ]
`);
    writeExecutable(join(fakeBin, 'date'), `#!/usr/bin/env bash
set -euo pipefail
epoch="$(<"$FAKE_CLOCK_STATE")"
case "$*" in
  '-u +%s') printf '%s\n' "$epoch" ;;
  '--iso-8601=seconds') /usr/bin/date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%S+00:00' ;;
  '-u +%Y-%m-%dT%H:%M:%SZ') /usr/bin/date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' ;;
  *) exec /usr/bin/date "$@" ;;
esac
`);
    writeExecutable(join(fakeBin, 'python3'), `#!/bin/sh
if [ "\${3:-}" = lunchlineup-backup.service ] || [ "\${3:-}" = lunchlineup-pitr-base-backup.service ]; then
  cat >/dev/null
  case "$3" in
    lunchlineup-backup.service) digest='sha256:${'b'.repeat(64)}' ;;
    lunchlineup-pitr-base-backup.service) digest='sha256:${'c'.repeat(64)}' ;;
  esac
  [ "$(grep -c '^candidate_release_job_ok ' "$2")" -eq 1 ]
  grep -F "service=$3 invocation_id=$4 candidate_path='$5' source_sha=$6 " "$2" >/dev/null
  grep -F "image_digest=$digest" "$2" >/dev/null
  printf '%s\\t%s\\t%s\\t%s\\n' "$4" "$5" "$6" "$digest"
  exit 0
fi
if [ "$#" -eq 5 ]; then
  observed_at="$(sed -n 's/^offsite_immutable_ok .* observed_at=//p' "$2" | tail -n 1)"
  observed_epoch="$(/usr/bin/date -u -d "$observed_at" +%s)"
  [ "$observed_epoch" -ge "$4" ]
  [ "$observed_epoch" -le "$(( $5 + 60 ))" ]
  [ "$(( $5 - observed_epoch ))" -le "$3" ]
  grep -q '^backup_ok .* expiry_owner=lifecycle$' "$2"
  exit 0
fi
if printf '%s' "\${3:-}" | grep -q '^lunchlineup_.*_last_success_timestamp_seconds$'; then
  [ "\${FAKE_FAIL_PHASE:-}" != metrics ] || exit 1
  value="$(awk -v metric="$3" '$1 == metric { print $2 }' "$2")"
  [ -n "$value" ]
  [ "$value" -ge "$5" ]
  [ "$value" -le "$(( $6 + 60 ))" ]
  [ "$(( $6 - value ))" -le "$4" ]
  exit 0
fi
exit 0
`);
    writeExecutable(join(fakeBin, 'journalctl'), `#!/bin/sh
case " $* " in
  *' lunchlineup-backup.service '*)
    cat "$FAKE_SYSTEMCTL_STATE_DIR/journal-lunchlineup-backup.service"
    ;;
  *' lunchlineup-pitr-base-backup.service '*)
    cat "$FAKE_SYSTEMCTL_STATE_DIR/journal-lunchlineup-pitr-base-backup.service"
    ;;
esac
`);
    writeExecutable(join(fakeBin, 'docker'), `#!/usr/bin/env bash
set -eu
printf 'docker %s\n' "$*" >>"$FAKE_SYSTEMCTL_LOG"
case " $* " in
  *' compose '*' config --format json '*)
    printf '{"services":{"backup":{"image":"fixture/backup:%s"},"pitr-base-backup":{"image":"fixture/pitr:%s"}}}\n' "$IMAGE_TAG" "$IMAGE_TAG"
    exit 0
    ;;
  *' image inspect '*)
    case "\${@: -1}" in
      fixture/backup:*) printf 'sha256:%s\n' '${'b'.repeat(64)}' ;;
      fixture/pitr:*) printf 'sha256:%s\n' '${'c'.repeat(64)}' ;;
      *) exit 92 ;;
    esac
    exit 0
    ;;
  *' compose '*' run --detach --no-deps --pull never '*)
    service="\${@: -1}"
    now="$(date -u +%s)"
    case "$service" in
      backup)
        if [ "\${FAKE_FAIL_PHASE:-}" != stale-pre-run ]; then
          tmp="$(mktemp "$FAKE_METRICS_DIR/lunchlineup_backup.prom.XXXXXX")"
          printf 'lunchlineup_backup_last_success_timestamp_seconds %s\n' "$now" >"$tmp"
          mv -f -- "$tmp" "$FAKE_METRICS_DIR/lunchlineup_backup.prom"
        fi
        observed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        container_id='${'b'.repeat(64)}'
        {
          echo 'offsite_retention_ok mode=lifecycle_owned delete=denied repository=s3://fixture/backups/'
          echo "offsite_immutable_ok object_version=version-one checksum_version=version-two principal=arn:aws:iam::123456789012:role/backup observed_at=$observed_at"
          echo "backup_ok offsite_uri=s3://fixture/backups/ offsite_version=version-one checksum_version=version-two provider_principal=arn:aws:iam::123456789012:role/backup provider_observed_at=$observed_at expiry_owner=lifecycle"
        } >"$FAKE_SYSTEMCTL_STATE_DIR/container-log-$container_id"
        ;;
      pitr-base-backup)
        container_id='${'c'.repeat(64)}'
        tmp="$(mktemp "$FAKE_METRICS_DIR/lunchlineup_pitr.prom.XXXXXX")"
        printf 'lunchlineup_pitr_base_backup_last_success_timestamp_seconds %s\n' "$now" >"$tmp"
        mv -f -- "$tmp" "$FAKE_METRICS_DIR/lunchlineup_pitr.prom"
        echo 'pitr_base_backup_ok backup_id=fixture' >"$FAKE_SYSTEMCTL_STATE_DIR/container-log-$container_id"
        ;;
      *) exit 93 ;;
    esac
    printf '%s\n' "$container_id"
    exit 0
    ;;
esac
case "\${1:-}" in
  wait)
    printf '0\n'
    ;;
  logs)
    cat "$FAKE_SYSTEMCTL_STATE_DIR/container-log-\${2:?}"
    ;;
  ps)
    [ ! -f "$FAKE_CONTAINER_STATE" ] || cat "$FAKE_CONTAINER_STATE"
    ;;
  rm)
    target=''
    for argument in "$@"; do target="$argument"; done
    rm -f "$FAKE_SYSTEMCTL_STATE_DIR/container-log-$target"
    if [ -f "$FAKE_CONTAINER_STATE" ]; then
      [ "$target" = "$(cat "$FAKE_CONTAINER_STATE")" ]
      rm -f "$FAKE_CONTAINER_STATE"
    fi
    ;;
  *) exit 91 ;;
esac
`);
    writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/sh
set -eu
state_dir="\${FAKE_SYSTEMCTL_STATE_DIR:?}"
printf '%s\n' "$*" >>"\${FAKE_SYSTEMCTL_LOG:?}"
command="\${1:-}"
[ "$#" -eq 0 ] || shift
case "$command" in
  is-enabled)
    [ "\${1:-}" != --quiet ] || shift
    timer="\${1:-}"
    if [ "\${FAKE_RESTORE_READBACK_FAIL:-false}" = true ] && [ -f "$state_dir/restoration-reloaded" ]; then
      echo transport-error
      exit 9
    fi
    if [ -f "$state_dir/enabled-$timer" ]; then [ "\${1:-}" = --quiet ] || :; echo enabled; exit 0; fi
    echo disabled
    exit 1
    ;;
  is-active)
    [ "\${1:-}" != --quiet ] || shift
    timer="\${1:-}"
    if [ "\${FAKE_RESTORE_READBACK_FAIL:-false}" = true ] && [ -f "$state_dir/restoration-reloaded" ]; then
      echo transport-error
      exit 9
    fi
    if [ -f "$state_dir/active-$timer" ]; then echo active; exit 0; fi
    echo inactive
    exit 1
    ;;
  disable)
    [ "\${1:-}" != --now ] || shift
    for timer in "$@"; do rm -f "$state_dir/enabled-$timer" "$state_dir/active-$timer"; done
    ;;
  enable)
    enable_now=false
    [ "\${1:-}" != --now ] || { enable_now=true; shift; }
    for timer in "$@"; do
      if [ "\${FAKE_RESTORE_ENABLE_FAIL:-false}" = true ] && [ "$timer" = lunchlineup-backup.timer ]; then exit 8; fi
      touch "$state_dir/enabled-$timer"
      [ "$enable_now" = false ] || touch "$state_dir/active-$timer"
    done
    ;;
  start)
    service="\${1:-}"
    [ "\${FAKE_FAIL_PHASE:-}" != backup-service ] || [ "$service" != lunchlineup-backup.service ] || exit 1
    [ "\${FAKE_FAIL_PHASE:-}" != pitr-service ] || [ "$service" != lunchlineup-pitr-base-backup.service ] || exit 1
    case "$service" in *.timer) touch "$state_dir/active-$service" ;; esac
    ;;
  stop) for timer in "$@"; do rm -f "$state_dir/active-$timer"; done ;;
  reset-failed) ;;
  show)
    case " $* " in *' Result '*) echo success ;; *) echo 0 ;; esac
    ;;
  daemon-reload)
    touch "$state_dir/restoration-reloaded"
    [ "\${FAKE_CLEANUP_DAEMON_RELOAD_FAIL:-false}" != true ] || exit 1
    ;;
  *) echo "unexpected systemctl command: $command $*" >&2; exit 1 ;;
esac
`);

    const requestedCase = process.env.BACKUP_READINESS_TEST_CASE ?? '';
    assert.ok(
      !requestedCase || [
        'storage',
        'unit-verify',
        'backup-service',
        'pitr-service',
        'metrics',
        'cleanup-daemon',
        'cleanup-enable',
        'cleanup-readback',
        'service-timeout',
        'stale-pre-run',
        'success',
      ].includes(requestedCase),
      `unknown BACKUP_READINESS_TEST_CASE: ${requestedCase}`,
    );
    const runCase = (phase, cleanupFailure = '') => {
      const caseName = cleanupFailure ? `cleanup-${cleanupFailure}` : phase;
      if (requestedCase && requestedCase !== caseName) return undefined;
      const startedAt = Date.now();
      writeFileSync(systemctlLog, '');
      writeFileSync(dockerLog, '');
      writeFileSync(fakeClockLog, '');
      writeFileSync(fakeClockState, '2000000000');
      rmSync(containerState, { force: true });
      rmSync(snapshotRoot, { recursive: true, force: true });
      mkdirSync(snapshotRoot);
      for (const unit of units) {
        writeFileSync(join(stateDir, `enabled-${unit}`), 'false');
        writeFileSync(join(stateDir, `active-${unit}`), 'false');
      }
      writeFileSync(join(stateDir, 'enabled-lunchlineup-backup.timer'), 'true');
      writeFileSync(join(stateDir, 'active-lunchlineup-backup.timer'), 'true');
      writeFileSync(join(metricsDir, 'lunchlineup_backup.prom'), 'lunchlineup_backup_last_success_timestamp_seconds 1999999999\n');
      writeFileSync(join(metricsDir, 'lunchlineup_pitr.prom'), 'lunchlineup_pitr_base_backup_last_success_timestamp_seconds 1999999999\n');
      const remoteArgs = phase === 'success' ? [
        bashPath(script),
        bashPath(remoteTransportScript),
        '-',
        '-',
        bashPath(protectedChannel),
        createHash('sha256').update('-\n').digest('hex'),
        '-',
        '-',
        bashPath(scratch),
        releaseSha,
        bashPath(candidateManifest),
        bashPath(composeEnv),
        createHash('sha256').update(readFileSync(composeEnv)).digest('hex'),
        bashPath(join(scratch, 'launch-proof.json')),
        'f'.repeat(64),
        createHash('sha256').update(manifestBytes).digest('hex'),
        bashPath(sourceEntrypoint),
        'lunchlineup',
      ] : [bashPath(script), '--direct'];
      const result = spawnSync(bash, [
        '-c',
        `PATH="$1:$PATH"; export PATH
FAKE_SYSTEMCTL_RELOADED=false
export FAKE_SYSTEMCTL_RELOADED
systemctl() {
  local command="$1"
  shift
  local state_dir="$FAKE_SYSTEMCTL_STATE_DIR"
  local unit
  local enable_now
  printf '%s %s\n' "$command" "$*" >> "$FAKE_SYSTEMCTL_LOG"
  case "$command" in
    is-enabled)
      [ "$1" != --quiet ] || shift
      unit="$1"
      if [ "$FAKE_RESTORE_READBACK_FAIL" = true ] && [ "$FAKE_SYSTEMCTL_RELOADED" = true ]; then echo transport-error; return 9; fi
      if [ "$(<"$state_dir/enabled-$unit")" = true ]; then echo enabled; return 0; fi
      echo disabled; return 1
      ;;
    is-active)
      [ "$1" != --quiet ] || shift
      unit="$1"
      if [ "$FAKE_RESTORE_READBACK_FAIL" = true ] && [ "$FAKE_SYSTEMCTL_RELOADED" = true ]; then echo transport-error; return 9; fi
      if [ "$(<"$state_dir/active-$unit")" = true ]; then echo active; return 0; fi
      echo inactive; return 3
      ;;
    disable)
      [ "$1" != --now ] || shift
      for unit in "$@"; do printf false > "$state_dir/enabled-$unit"; printf false > "$state_dir/active-$unit"; done
      ;;
    enable)
      enable_now=false
      [ "$1" != --now ] || { enable_now=true; shift; }
      for unit in "$@"; do
        if [ "$FAKE_RESTORE_ENABLE_FAIL" = true ] && [ "$unit" = lunchlineup-backup.timer ]; then return 8; fi
        printf true > "$state_dir/enabled-$unit"
        [ "$enable_now" = false ] || printf true > "$state_dir/active-$unit"
      done
      ;;
    start)
      unit="$1"
      [ "$FAKE_FAIL_PHASE" != backup-service ] || [ "$unit" != lunchlineup-backup.service ] || return 1
      [ "$FAKE_FAIL_PHASE" != pitr-service ] || [ "$unit" != lunchlineup-pitr-base-backup.service ] || return 1
      case "$unit" in
        *.timer) printf true > "$state_dir/active-$unit" ;;
        lunchlineup-backup.service)
          INVOCATION_ID='${'1'.repeat(32)}' CANDIDATE_RELEASE_ROOT="$FAKE_CANDIDATE_RELEASE_ROOT" \
            bash "$FAKE_CANDIDATE_RUNNER" "$unit" >"$state_dir/journal-$unit"
          ;;
        lunchlineup-pitr-base-backup.service)
          INVOCATION_ID='${'2'.repeat(32)}' CANDIDATE_RELEASE_ROOT="$FAKE_CANDIDATE_RELEASE_ROOT" \
            bash "$FAKE_CANDIDATE_RUNNER" "$unit" >"$state_dir/journal-$unit"
          ;;
      esac
      ;;
    stop) for unit in "$@"; do printf false > "$state_dir/active-$unit"; done ;;
    reset-failed) ;;
    show)
      unit="$1"
      case " $* " in
        *'--property=InvocationID'*)
          case "$unit" in
            lunchlineup-backup.service) printf '%s\n' '${'1'.repeat(32)}' ;;
            lunchlineup-pitr-base-backup.service) printf '%s\n' '${'2'.repeat(32)}' ;;
            *) return 92 ;;
          esac
          ;;
        *'--property=ActiveState'*)
          if [ "$(<"$state_dir/active-$unit")" = true ]; then echo active; else echo inactive; fi
          ;;
        *'--property=SubState'*)
          if [ "$(<"$state_dir/active-$unit")" = true ]; then echo running; else echo dead; fi
          ;;
        *'--property=Result'*)
          if [ "$FAKE_TIMEOUT_SERVICE" = "$unit" ]; then echo timeout; else echo success; fi
          ;;
        *'--property=ExecMainStatus'*) echo 0 ;;
        *) return 93 ;;
      esac
      ;;
    daemon-reload)
      FAKE_SYSTEMCTL_RELOADED=true
      [ "$FAKE_CLEANUP_DAEMON_RELOAD_FAIL" != true ] || return 1
      ;;
    *) return 91 ;;
  esac
}
timeout() {
  local duration=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --foreground|--signal=*|--kill-after=*) shift ;;
      *s) duration="$1"; shift; break ;;
      *) break ;;
    esac
  done
  printf 'timeout=%s command=%s\n' "$duration" "$*" >> "$FAKE_SYSTEMCTL_LOG"
  if [ "\${FAKE_TIMEOUT_SERVICE:-}" != '' ] \
    && [ "\${1:-}" = systemctl ] && [ "\${2:-}" = start ] && [ "\${3:-}" = "$FAKE_TIMEOUT_SERVICE" ]; then
    printf true > "$FAKE_SYSTEMCTL_STATE_DIR/active-$FAKE_TIMEOUT_SERVICE"
    printf '%s\n' '${'d'.repeat(64)}' > "$FAKE_CONTAINER_STATE"
    return 124
  fi
  if [ "\${FAKE_LONG_SERVICE_SECONDS:-0}" -gt 0 ] \
    && [ "\${1:-}" = systemctl ] && [ "\${2:-}" = start ]; then
    deadline="\${duration%s}"
    elapsed="$FAKE_LONG_SERVICE_SECONDS"
    [ "$3" != lunchlineup-pitr-base-backup.service ] || elapsed="$FAKE_PITR_CLOCK_ADVANCE_SECONDS"
    [ "$deadline" -gt "$elapsed" ] || return 124
    printf '%s' "$(( $(<"$FAKE_CLOCK_STATE") + elapsed ))" >"$FAKE_CLOCK_STATE"
    printf '%s|elapsed=%s|client_deadline=%s\n' "$3" "$elapsed" "$deadline" >> "$FAKE_CLOCK_LOG"
  fi
  "$@"
}
export -f systemctl timeout
readiness_script="$2"
if [ "\${3:-}" = --direct ]; then exec bash "$readiness_script"; fi
remote_script="$3"
shift 3
exec bash "$remote_script" "$@"`,
        'backup-readiness-fixture',
        bashPath(fakeBin),
        ...remoteArgs,
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: phase === 'success' ? 90_000 : 30_000,
        env: {
          ...process.env,
          APP_DIR: bashPath(candidateDir),
          COMPOSE_PROJECT_NAME: 'lunchlineup',
          COMPOSE_SERVICE_ENV_FILE: bashPath(composeEnv),
          IMAGE_PREFIX: 'fixture',
          IMAGE_TAG: releaseSha,
          BACKUP_SYSTEMD_UNIT_DIR: bashPath(unitDir),
          BACKUP_SYSTEMD_ENV_FILE: bashPath(backupEnv),
          BACKUP_RELEASE_ENV_FILE: bashPath(releaseEnv),
          PITR_BASE_BACKUP_SYSTEMD_ENV_FILE: bashPath(pitrEnv),
          PITR_STORAGE_VERIFY_SCRIPT: bashPath(storageVerifier),
          NODE_EXPORTER_TEXTFILE_DIR: bashPath(metricsDir),
          BACKUP_RESTORE_STATE_ROOT: bashPath(snapshotRoot),
          FAKE_SYSTEMCTL_STATE_DIR: bashPath(stateDir),
          FAKE_SYSTEMCTL_LOG: bashPath(systemctlLog),
          FAKE_CONTAINER_STATE: bashPath(containerState),
          FAKE_CLOCK_LOG: bashPath(fakeClockLog),
          FAKE_CLOCK_STATE: bashPath(fakeClockState),
          FAKE_LONG_SERVICE_SECONDS: phase === 'success' ? '121' : '0',
          FAKE_PITR_CLOCK_ADVANCE_SECONDS: '21601',
          FAKE_METRICS_DIR: bashPath(metricsDir),
          FAKE_CANDIDATE_RUNNER: bashPath(candidateRunner),
          FAKE_CANDIDATE_RELEASE_ROOT: bashPath(dirname(candidateDir)),
          PRODUCTION_RUNTIME_ENV_SHA256: createHash('sha256').update(readFileSync(composeEnv)).digest('hex'),
          FAKE_PROTECTED_CHANNEL: bashPath(protectedChannel),
          FAKE_TRANSPORT_PATH_LOG: bashPath(transportPathLog),
          REAL_READINESS_SCRIPT: bashPath(script),
          FAKE_TIMEOUT_SERVICE: phase === 'service-timeout' ? 'lunchlineup-backup.service' : '',
          FAKE_FAIL_PHASE: phase,
          FAKE_CLEANUP_DAEMON_RELOAD_FAIL: cleanupFailure === 'daemon' ? 'true' : 'false',
          FAKE_RESTORE_ENABLE_FAIL: cleanupFailure === 'enable' ? 'true' : 'false',
          FAKE_RESTORE_READBACK_FAIL: cleanupFailure === 'readback' ? 'true' : 'false',
        },
      });
      if (phase === 'success') assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      else assert.notEqual(result.status, 0, `${phase} must fail`);
      const systemctlCalls = readFileSync(systemctlLog, 'utf8');
      assert.equal(
        result.error?.code,
        undefined,
        `${phase} exceeded its test deadline\nsystemctl calls:\n${systemctlCalls}\nstderr:\n${result.stderr}`,
      );
      for (const [unit, content] of originalBytes) {
        const expectedBytes = phase === 'success' ? read(`infrastructure/systemd/${unit}`) : content;
        assert.equal(readFileSync(join(unitDir, unit), 'utf8'), expectedBytes, `${phase} changed ${unit}`);
      }
      if (phase === 'success') {
        assert.match(result.stdout, new RegExp(`backup_readiness_ok release_sha=${releaseSha} candidate_path=${bashPath(candidateDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.doesNotMatch(result.stdout, new RegExp(`${releaseSha}/releases/${releaseSha}`));
        assert.equal(readFileSync(transportPathLog, 'utf8').trim(), bashPath(candidateDir));
        assert.equal(readFileSync(join(stateDir, 'enabled-lunchlineup-backup.timer'), 'utf8'), 'true');
        assert.equal(readFileSync(join(stateDir, 'enabled-lunchlineup-pitr-base-backup.timer'), 'utf8'), 'true');
        const backupJournal = readFileSync(join(stateDir, 'journal-lunchlineup-backup.service'), 'utf8');
        const pitrJournal = readFileSync(join(stateDir, 'journal-lunchlineup-pitr-base-backup.service'), 'utf8');
        assert.match(backupJournal, new RegExp(`candidate_release_job_ok service=lunchlineup-backup\\.service invocation_id=${'1'.repeat(32)} candidate_path=${bashPath(candidateDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(pitrJournal, new RegExp(`candidate_release_job_ok service=lunchlineup-pitr-base-backup\\.service invocation_id=${'2'.repeat(32)} candidate_path=${bashPath(candidateDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        const backupMetric = Number(readFileSync(join(metricsDir, 'lunchlineup_backup.prom'), 'utf8').trim().split(/\s+/).at(-1));
        const finalClock = Number(readFileSync(fakeClockState, 'utf8'));
        assert.ok(finalClock - backupMetric > 300, 'fixture must advance beyond the backup freshness window during PITR');
      } else if (cleanupFailure !== 'enable') {
        assert.equal(
          readFileSync(join(stateDir, 'enabled-lunchlineup-backup.timer'), 'utf8'),
          'true',
          `${caseName} lost enabled state\nsystemctl calls:\n${systemctlCalls}\nstderr:\n${result.stderr}`,
        );
        assert.equal(
          readFileSync(join(stateDir, 'active-lunchlineup-backup.timer'), 'utf8'),
          'true',
          `${caseName} lost active state\nsystemctl calls:\n${systemctlCalls}\nstderr:\n${result.stderr}`,
        );
        assert.equal(readFileSync(join(stateDir, 'enabled-lunchlineup-pitr-base-backup.timer'), 'utf8'), 'false', `${phase} enabled PITR timer`);
        assert.equal(readFileSync(join(stateDir, 'active-lunchlineup-pitr-base-backup.timer'), 'utf8'), 'false', `${phase} activated PITR timer`);
      }
      const snapshots = readdirSync(snapshotRoot);
      if (cleanupFailure) {
        assert.equal(snapshots.length, 1, `${cleanupFailure} failure deleted the restore snapshot`);
        assert.equal(existsSync(join(snapshotRoot, snapshots[0], 'unit-lunchlineup-backup.service')), true);
      } else {
        assert.deepEqual(snapshots, [], `${phase} left a confirmed restore snapshot behind`);
      }
      assert.match(systemctlCalls, /is-enabled lunchlineup-backup\.service/);
      assert.match(systemctlCalls, /is-active lunchlineup-pitr-base-backup\.service/);
      if (phase === 'service-timeout') {
        assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`backup_readiness_timeout_reconciled service=lunchlineup-backup\\.service invocation_id=${'1'.repeat(32)} container_id=${'d'.repeat(64)}`));
        assert.equal(existsSync(containerState), false, 'timed-out candidate container survived reconciliation');
        assert.match(systemctlCalls, new RegExp(`docker rm -f ${'d'.repeat(64)}`));
      }
      if (phase === 'success') {
        assert.match(systemctlCalls, /timeout=7260s command=systemctl start lunchlineup-backup\.service/);
        assert.match(systemctlCalls, /timeout=21660s command=systemctl start lunchlineup-pitr-base-backup\.service/);
        assert.deepEqual(readFileSync(fakeClockLog, 'utf8').trim().split(/\r?\n/), [
          'lunchlineup-backup.service|elapsed=121|client_deadline=7260',
          'lunchlineup-pitr-base-backup.service|elapsed=21601|client_deadline=21660',
        ]);
      }
      if (phase === 'stale-pre-run') {
        assert.match(`${result.stdout}\n${result.stderr}`, /did not atomically publish new metrics evidence|missing, stale, pre-run/);
      }
      if (process.env.BACKUP_READINESS_TEST_TRACE === '1') {
        t.diagnostic(`${caseName} completed in ${Date.now() - startedAt}ms`);
      }
      return result;
    };

    for (const phase of ['storage', 'unit-verify', 'backup-service', 'pitr-service', 'metrics', 'stale-pre-run']) runCase(phase);
    runCase('service-timeout');
    for (const [failure, expected] of [
      ['daemon', /cleanup failed: systemd daemon-reload failed/],
      ['enable', /cleanup failed: could not re-enable lunchlineup-backup.timer/],
      ['readback', /cleanup failed: could not independently confirm lunchlineup-backup.service enabled state/],
    ]) {
      const cleanupFailure = runCase('storage', failure);
      if (!cleanupFailure) continue;
      assert.match(`${cleanupFailure.stdout}\n${cleanupFailure.stderr}`, expected);
      assert.match(`${cleanupFailure.stdout}\n${cleanupFailure.stderr}`, /restore snapshots preserved:/);
    }
    runCase('success');

    const remote = read('scripts/deploy-vm217-remote.sh');
    const readiness = read('scripts/verify-backup-readiness.sh');
    assert.match(transport, /candidate_app="\$release_root\/\$source_sha"/);
    assert.match(transport, /"APP_DIR=\$candidate_app"/);
    assert.match(remote, /APP_DIR="\$APP_DIR"[\s\S]*bash scripts\/verify-backup-readiness\.sh/);
    assert.match(readiness, /CANDIDATE_PATH="\$APP_DIR"/);
    assert.doesNotMatch(readiness, /\$APP_DIR\/releases\/\$IMAGE_TAG/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('backup scheduler docs cover secret, offsite, metrics, and one-shot proof', () => {
  const systemdReadme = read('infrastructure/systemd/README.md');
  const prometheusReadme = read('infrastructure/prometheus/README.md');
  const runbook = read('docs/runbooks/production-readiness.md');

  for (const content of [systemdReadme, runbook]) {
    assert.match(content, /\/run\/secrets\/backup_key/);
    assert.match(content, /BACKUP_OFFSITE_URI/);
    assert.match(content, /BACKUP_OFFSITE_RETENTION_DAYS/);
    assert.match(content, /offsite_retention_ok/);
    assert.match(content, /lunchlineup_backup\.prom/);
    assert.match(content, /lunchlineup-backup\.timer/);
    assert.match(content, /BackupMissingTelemetry/);
    assert.match(content, /BackupStale/);
  }

  assert.match(prometheusReadme, /lunchlineup-backup\.service/);
  assert.match(prometheusReadme, /lunchlineup_backup\.prom/);
  assert.match(runbook, /--profile ops/);
  assert.match(runbook, /--pull never/);
});
test('backup stale alert allows the daily timer maximum jitter', () => {
  const timer = read('infrastructure/systemd/lunchlineup-backup.timer');
  const alerts = read('infrastructure/prometheus/alerts/lunchlineup.yml');

  assert.match(timer, /OnCalendar=\*-\*-\* 02:17:00/);
  assert.match(timer, /RandomizedDelaySec=30m/);
  assert.match(alerts, /time\(\) - lunchlineup_backup_last_success_timestamp_seconds > 93600/);
  assert.match(alerts, /Latest backup is older than 26 hours/);
});
