import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedExecStart = '/usr/bin/env RETENTION_PURGE_STAGE=application_data RETENTION_PURGE_DRY_RUN=false RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data /usr/bin/node /opt/lunchlineup/current/scripts/invoke-retained-record-purge.mjs';
const expectedReviewExecStart = '/usr/bin/env RETENTION_PURGE_STAGE=retained_records RETENTION_PURGE_DRY_RUN=true RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retained-record-review-latest.json RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retained_record_review.prom RETENTION_PURGE_LOCK_FILE=/run/lunchlineup/retained-record-review.lock /usr/bin/node /opt/lunchlineup/current/scripts/invoke-retained-record-purge.mjs';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function exists(path) {
  return existsSync(join(root, path));
}

function unitValue(unit, key) {
  const line = unit.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  assert.ok(line, `missing ${key}= in unit`);
  return line.slice(key.length + 1);
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

test('retained-record systemd scheduler artifacts are present and inventoried', () => {
  for (const path of [
    'infrastructure/systemd/README.md',
    'infrastructure/systemd/lunchlineup-retained-record-review.service',
    'infrastructure/systemd/lunchlineup-retained-record-review.timer',
    'infrastructure/systemd/lunchlineup-retention-purge.env.example',
    'infrastructure/systemd/lunchlineup-retention-purge.service',
    'infrastructure/systemd/lunchlineup-retention-purge.timer',
  ]) {
    assert.equal(exists(path), true, `${path} must exist`);
  }

  const infrastructureReadme = read('infrastructure/README.md');
  const systemdReadme = read('infrastructure/systemd/README.md');
  const deployReadme = read('tests/deploy/README.md');

  assert.match(infrastructureReadme, /`systemd\/`/);
  assert.match(systemdReadme, /`lunchlineup-retained-record-review\.service`/);
  assert.match(systemdReadme, /`lunchlineup-retained-record-review\.timer`/);
  assert.match(systemdReadme, /`lunchlineup-retention-purge\.service`/);
  assert.match(systemdReadme, /`lunchlineup-retention-purge\.timer`/);
  assert.match(systemdReadme, /`lunchlineup-retention-purge\.env\.example`/);
  assert.match(deployReadme, /`retention-scheduler\.test\.mjs`/);
});

test('retention schedulers split automatic application-data execution from retained-record review', () => {
  const service = read('infrastructure/systemd/lunchlineup-retention-purge.service');
  const reviewService = read('infrastructure/systemd/lunchlineup-retained-record-review.service');
  const envExample = read('infrastructure/systemd/lunchlineup-retention-purge.env.example');
  const timer = read('infrastructure/systemd/lunchlineup-retention-purge.timer');
  const reviewTimer = read('infrastructure/systemd/lunchlineup-retained-record-review.timer');

  assert.match(service, /EnvironmentFile=\/etc\/lunchlineup\/retention-purge\.env/);
  assert.equal(unitValue(service, 'ExecStart'), expectedExecStart);
  assert.match(service, /User=lunchlineup/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/lunchlineup \/var\/lib\/node_exporter\/textfile_collector \/run\/lunchlineup/);
  assert.match(service, /RETENTION_PURGE_STAGE=application_data/);
  assert.match(service, /RETENTION_PURGE_DRY_RUN=false/);
  assert.match(service, /RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data/);

  assert.match(reviewService, /EnvironmentFile=\/etc\/lunchlineup\/retention-purge\.env/);
  assert.equal(unitValue(reviewService, 'ExecStart'), expectedReviewExecStart);
  assert.match(reviewService, /User=lunchlineup/);
  assert.match(reviewService, /NoNewPrivileges=true/);
  assert.match(reviewService, /ProtectSystem=strict/);
  assert.match(reviewService, /RETENTION_PURGE_STAGE=retained_records/);
  assert.match(reviewService, /RETENTION_PURGE_DRY_RUN=true/);
  assert.match(reviewService, /retained-record-review-latest\.json/);
  assert.match(reviewService, /lunchlineup_retained_record_review\.prom/);
  assert.doesNotMatch(reviewService, /RETENTION_PURGE_EXECUTE_CONFIRM/);
  assert.doesNotMatch(envExample, /RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-retained-records/);

  assert.match(timer, /OnCalendar=\*-\*-\* 03:17:00/);
  assert.match(timer, /RandomizedDelaySec=30m/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=lunchlineup-retention-purge\.service/);
  assert.match(reviewTimer, /OnCalendar=\*-\*-\* 04:17:00/);
  assert.match(reviewTimer, /RandomizedDelaySec=30m/);
  assert.match(reviewTimer, /Persistent=true/);
  assert.match(reviewTimer, /Unit=lunchlineup-retained-record-review\.service/);
});
test('retention scheduler install docs are end-to-end and verify-first', () => {
  const systemdReadme = read('infrastructure/systemd/README.md');
  const runbook = read('docs/runbooks/data-retention-delete-export.md');
  const expectedExecPattern = new RegExp(expectedExecStart.replace(/[^A-Za-z0-9]/g, '\\$&'));
  const expectedReviewPattern = new RegExp(expectedReviewExecStart.replace(/[^A-Za-z0-9]/g, '\\$&'));

  assert.match(systemdReadme, /install -d -m 0750 \/etc\/lunchlineup/);
  assert.match(systemdReadme, /install -d -m 0750 \/run\/secrets/);
  assert.match(systemdReadme, /install -m 0640 infrastructure\/systemd\/lunchlineup-retention-purge\.env\.example \/etc\/lunchlineup\/retention-purge\.env/);
  assert.match(systemdReadme, /install -o root -g lunchlineup -m 0640 \/secure\/source\/retention_purge_token \/run\/secrets\/retention_purge_token/);
  assert.match(systemdReadme, /install -m 0644 infrastructure\/systemd\/lunchlineup-retention-purge\.service \/etc\/systemd\/system\/lunchlineup-retention-purge\.service/);
  assert.match(systemdReadme, /install -m 0644 infrastructure\/systemd\/lunchlineup-retained-record-review\.service \/etc\/systemd\/system\/lunchlineup-retained-record-review\.service/);
  assert.match(systemdReadme, /systemd-analyze verify .*lunchlineup-retention-purge\.service .*lunchlineup-retained-record-review\.service/);
  assert.match(systemdReadme, /systemctl daemon-reload/);
  assert.match(systemdReadme, /systemctl enable --now lunchlineup-retention-purge\.timer lunchlineup-retained-record-review\.timer/);
  assert.match(systemdReadme, /systemctl start lunchlineup-retention-purge\.service lunchlineup-retained-record-review\.service/);
  assert.match(systemdReadme, /journalctl -u lunchlineup-retention-purge\.service -u lunchlineup-retained-record-review\.service -n 100 --no-pager/);
  assert.match(systemdReadme, /test -s \/var\/lib\/lunchlineup\/proofs\/retention-purge-latest\.json/);
  assert.match(systemdReadme, /test -s \/var\/lib\/lunchlineup\/proofs\/retained-record-review-latest\.json/);
  assert.match(systemdReadme, /test -s \/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retention_purge\.prom/);
  assert.match(systemdReadme, /test -s \/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retained_record_review\.prom/);
  assert.match(systemdReadme, expectedExecPattern);
  assert.match(systemdReadme, expectedReviewPattern);

  assert.match(runbook, /verify-first/);
  assert.match(runbook, /lunchlineup-retention-purge\.timer/);
  assert.match(runbook, /lunchlineup-retained-record-review\.timer/);
  assert.match(runbook, /\/var\/lib\/lunchlineup\/proofs\/retention-purge-latest\.json/);
  assert.match(runbook, /\/var\/lib\/lunchlineup\/proofs\/retained-record-review-latest\.json/);
  assert.match(runbook, /\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retained_record_review\.prom/);
});
test('retention schedulers use token, proof, lock, and metrics files', () => {
  const envExample = read('infrastructure/systemd/lunchlineup-retention-purge.env.example');
  const runbook = read('docs/runbooks/data-retention-delete-export.md');
  const systemdReadme = read('infrastructure/systemd/README.md');

  for (const content of [envExample, runbook]) {
    assert.match(content, /RETENTION_PURGE_URL=https:\/\/lunchlineup\.com\/api\/v1\/admin\/retention\/purge-expired/);
    assert.match(content, /RETENTION_PURGE_TOKEN_FILE=\/run\/secrets\/retention_purge_token/);
    assert.match(content, /RETENTION_PURGE_PROOF_FILE=\/var\/lib\/lunchlineup\/proofs\/retention-purge-latest\.json/);
    assert.match(content, /RETENTION_PURGE_METRICS_FILE=\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retention_purge\.prom/);
    assert.match(content, /RETENTION_PURGE_LOCK_FILE=\/run\/lunchlineup\/retention-purge\.lock/);
  }

  for (const content of [runbook, systemdReadme]) {
    assert.match(content, /\/var\/lib\/lunchlineup\/proofs\/retained-record-review-latest\.json/);
    assert.match(content, /\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retained_record_review\.prom/);
    assert.match(content, /\/run\/lunchlineup\/retained-record-review\.lock/);
  }

  assert.match(systemdReadme, /\/run\/secrets\/retention_purge_token/);
  assert.match(systemdReadme, /RETENTION_PURGE_SERVICE_TOKEN_FILE=\/run\/secrets\/retention_purge_token/);
  assert.match(systemdReadme, /RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE/);
  assert.match(systemdReadme, /\/var\/lib\/lunchlineup\/proofs/);
  assert.match(systemdReadme, /\/var\/lib\/node_exporter\/textfile_collector/);
});
test('retention scheduler docs name independent execution and review monitoring ownership', () => {
  const runbook = read('docs/runbooks/data-retention-delete-export.md');
  const systemdReadme = read('infrastructure/systemd/README.md');

  for (const content of [runbook, systemdReadme]) {
    assert.match(content, /ApplicationDataRetentionExecutionTelemetryMissing/);
    assert.match(content, /ApplicationDataRetentionExecutionStale/);
    assert.match(content, /RetentionPurgeTelemetryMissing/);
    assert.match(content, /mode="execute",stage="application_data"/);
    assert.match(content, /dry-run proof/);
    assert.match(content, /do not execute/i);
  }
});

test('node-exporter textfile collector is wired for retained-record metrics', () => {
  const compose = read('docker-compose.yml');
  const prometheusReadme = read('infrastructure/prometheus/README.md');
  const nodeExporter = serviceBlock(compose, 'node-exporter');

  assert.match(nodeExporter, /--collector\.textfile\.directory=\/textfile_collector/);
  assert.match(
    nodeExporter,
    /\$\{NODE_EXPORTER_TEXTFILE_DIR:-\/var\/lib\/node_exporter\/textfile_collector\}:\/textfile_collector:ro/,
  );
  assert.match(prometheusReadme, /NODE_EXPORTER_TEXTFILE_DIR/);
  assert.match(prometheusReadme, /--collector\.textfile\.directory=\/textfile_collector/);
});
