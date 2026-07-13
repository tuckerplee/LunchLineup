import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  assert.match(backupScript, /RCLONE_CONFIG must name a readable dedicated config file/);
});

test('systemd runs the deployed backup image daily without pulls or dependency mutation', () => {
  const service = read('infrastructure/systemd/lunchlineup-backup.service');
  const timer = read('infrastructure/systemd/lunchlineup-backup.timer');
  const envExample = read('infrastructure/systemd/lunchlineup-backup.env.example');

  assert.match(service, /EnvironmentFile=\/etc\/lunchlineup\/backup\.env/);
  assert.match(service, /EnvironmentFile=\/var\/lib\/lunchlineup\/backup-release\.env/);
  const pitrService = read('infrastructure/systemd/lunchlineup-pitr-base-backup.service');
  assert.match(pitrService, /EnvironmentFile=\/var\/lib\/lunchlineup\/backup-release\.env/);
  assert.equal(
    unitValue(service, 'ExecStart'),
    '/usr/bin/docker compose --project-directory /opt/lunchlineup --profile ops --env-file ${COMPOSE_SERVICE_ENV_FILE} run --rm --no-deps --pull never backup',
  );
  assert.match(service, /User=lunchlineup/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /TimeoutStartSec=2h/);

  assert.match(timer, /OnCalendar=\*-\*-\* 02:17:00/);
  assert.match(timer, /RandomizedDelaySec=30m/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=lunchlineup-backup\.service/);

  assert.match(envExample, /^COMPOSE_PROJECT_NAME=lunchlineup-production$/m);
  assert.match(envExample, /^COMPOSE_SERVICE_ENV_FILE=\/opt\/lunchlineup-secrets\/runtime\.env$/m);
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
  assert.match(verifier, /restore_timer_state/);
  assert.match(verifier, /systemctl start "\$service"/);
  assert.match(verifier, /--property=Result --value/);
  assert.match(verifier, /--property=ExecMainStatus --value/);
  assert.doesNotMatch(verifier, /^docker compose /m);

  const backupStart = verifier.indexOf('run_backup_service lunchlineup-backup.service');
  const pitrStart = verifier.indexOf('run_backup_service lunchlineup-pitr-base-backup.service');
  const metricsProof = verifier.indexOf('lunchlineup_pitr_base_backup_last_success_timestamp_seconds');
  const enableTimers = verifier.indexOf('systemctl enable --now "${timers[@]}"');
  assert.ok(backupStart > 0 && pitrStart > backupStart);
  assert.ok(metricsProof > pitrStart && enableTimers > metricsProof);

  for (const timer of ['lunchlineup-backup.timer', 'lunchlineup-pitr-base-backup.timer']) {
    assert.match(verifier, new RegExp(timer.replace('.', '\\.')));
    assert.match(verifier, /systemctl is-enabled --quiet "\$timer"/);
    assert.match(verifier, /systemctl is-active --quiet "\$timer"/);
  }
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
  assert.match(deploy, /trap cleanup_staged_backup_release_pointer EXIT/);
  assert.match(deploy, /backup_release_env_restored/);
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
