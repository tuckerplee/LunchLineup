import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
    'infrastructure/systemd/run-retention-scheduler.sh',
    'infrastructure/systemd/install-retention-scheduler.sh',
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

const expectedExecStart = '/usr/bin/flock -w 600 /run/lock/lunchlineup-deploy.lock /bin/sh /opt/lunchlineup/infrastructure/systemd/run-retention-scheduler.sh';

test('retention units run the one-shot container under the deploy lock, never host Node.js', () => {
  for (const name of ['lunchlineup-retention-purge', 'lunchlineup-retained-record-review']) {
    const unit = read(`infrastructure/systemd/${name}.service`);
    assert.equal(unitValue(unit, 'ExecStart'), expectedExecStart);
    assert.equal(unitValue(unit, 'Type'), 'oneshot');
    assert.equal(unitValue(unit, 'User'), 'root');
    assert.match(unit, /Requires=docker\.service/);
    assert.doesNotMatch(unit, /\/usr\/bin\/node|invoke-retained-record-purge|User=lunchlineup|EnvironmentFile=|ReadWritePaths/);
  }
});

test('retention units keep stage, dry-run, and confirmation exactly', () => {
  const service = read('infrastructure/systemd/lunchlineup-retention-purge.service');
  const reviewService = read('infrastructure/systemd/lunchlineup-retained-record-review.service');

  assert.match(service, /^Environment=RETENTION_PURGE_STAGE=application_data$/m);
  assert.match(service, /^Environment=RETENTION_PURGE_DRY_RUN=false$/m);
  assert.match(service, /^Environment=RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data$/m);
  assert.match(service, /^Environment=RETENTION_PURGE_PROOF_FILE=\/var\/lib\/lunchlineup\/proofs\/retention-purge-latest\.json$/m);
  assert.match(service, /^Environment=RETENTION_PURGE_METRICS_FILE=\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retention_purge\.prom$/m);

  assert.match(reviewService, /^Environment=RETENTION_PURGE_STAGE=retained_records$/m);
  assert.match(reviewService, /^Environment=RETENTION_PURGE_DRY_RUN=true$/m);
  assert.match(reviewService, /^Environment=RETENTION_PURGE_PROOF_FILE=\/var\/lib\/lunchlineup\/proofs\/retained-record-review-latest\.json$/m);
  assert.match(reviewService, /^Environment=RETENTION_PURGE_METRICS_FILE=\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retained_record_review\.prom$/m);
  assert.doesNotMatch(reviewService, /RETENTION_PURGE_EXECUTE_CONFIRM/);
  assert.doesNotMatch(read('infrastructure/systemd/lunchlineup-retention-purge.env.example'), /RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-retained-records/);
});

test('retention timers keep their schedules', () => {
  const timer = read('infrastructure/systemd/lunchlineup-retention-purge.timer');
  const reviewTimer = read('infrastructure/systemd/lunchlineup-retained-record-review.timer');
  assert.match(timer, /OnCalendar=\*-\*-\* 03:17:00/);
  assert.match(timer, /RandomizedDelaySec=30m/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /Unit=lunchlineup-retention-purge\.service/);
  assert.match(reviewTimer, /OnCalendar=\*-\*-\* 04:17:00/);
  assert.match(reviewTimer, /RandomizedDelaySec=30m/);
  assert.match(reviewTimer, /Persistent=true/);
  assert.match(reviewTimer, /Unit=lunchlineup-retained-record-review\.service/);
});

test('retention wrapper runs the exact compose invocation and forwards the pinned environment', () => {
  const wrapper = read('infrastructure/systemd/run-retention-scheduler.sh');
  assert.match(wrapper, /docker compose --project-name lunchlineup --project-directory "\$ROOT" --env-file "\$E"/);
  assert.match(wrapper, /-f docker-compose\.yml -f infrastructure\/development-admission\/compose\.private-proxy\.yml/);
  assert.match(wrapper, /PGBACKREST_ENABLED/);
  assert.match(wrapper, /-f infrastructure\/postgres\/compose\.pgbackrest\.yml/);
  assert.match(wrapper, /run --rm --no-deps -T/);
  assert.match(wrapper, /COMPOSE_SERVICE_ENV_FILE="\$E" exec "\$@"/);
  assert.match(wrapper, /retention-scheduler/);
  for (const name of ['RETENTION_PURGE_STAGE', 'RETENTION_PURGE_DRY_RUN', 'RETENTION_PURGE_EXECUTE_CONFIRM', 'RETENTION_PURGE_PROOF_FILE', 'RETENTION_PURGE_METRICS_FILE', 'RETENTION_PURGE_LOCK_FILE']) {
    assert.match(wrapper, new RegExp(name));
  }
  assert.doesNotMatch(wrapper, /^\s*[^#\s].*\bnode\b.*invoke-retained-record-purge/m);
  assert.doesNotMatch(wrapper, /^\s*[^#\s]*.* up\b/m);
});

test('install script verifies units without enabling or starting them', () => {
  const install = read('infrastructure/systemd/install-retention-scheduler.sh');
  assert.match(install, /systemd-analyze verify/);
  assert.match(install, /systemctl daemon-reload/);
  assert.doesNotMatch(install, /^\s*systemctl (enable|start|restart)\b/m);
});

test('retention-scheduler compose service is profile-gated, hardened, and mounts only proof and textfile dirs', () => {
  const compose = read('docker-compose.yml');
  const svc = serviceBlock(compose, 'retention-scheduler');
  assert.match(svc, /<<: \*locked-runtime/);
  assert.match(svc, /profiles:\s*\n\s+- ops/);
  assert.match(svc, /restart: "no"/);
  assert.match(svc, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/migrate:\$\{IMAGE_TAG:-local\}"/);
  assert.doesNotMatch(svc, /build:/);
  assert.match(svc, /user: "\$\{RETENTION_PURGE_UID:-1000\}:\$\{RETENTION_PURGE_GID:-1000\}"/);
  assert.match(svc, /- node\s*\n\s+- scripts\/invoke-retained-record-purge\.mjs/);
  assert.match(svc, /networks:\s*\n\s+- app\s*\n/);
  assert.doesNotMatch(svc, /^\s+- (external|data|management)$/m);
  assert.doesNotMatch(svc, /ports:|depends_on:|docker\.sock/);
  assert.match(svc, /secrets:\s*\n\s+- retention_purge_token/);
  assert.match(svc, /RETENTION_PURGE_TOKEN_FILE=\/run\/secrets\/retention_purge_token/);
  assert.match(svc, /RETENTION_PURGE_URL=http:\/\/api-v2:3002\/v2\/admin\/retention\/purge-expired/);
  assert.match(svc, /RETENTION_PURGE_DRY_RUN=true/);
  assert.match(svc, /tmpfs:\s*\n\s+- \/tmp:rw,noexec,nosuid,nodev/);
  const targets = [...svc.matchAll(/^\s+target: (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(targets, ['/var/lib/lunchlineup/proofs', '/var/lib/node_exporter/textfile_collector']);
  assert.equal((svc.match(/type: bind/g) ?? []).length, 2);
  assert.equal((svc.match(/create_host_path: false/g) ?? []).length, 2);
});

test('retention script accepts the private api-v2 endpoint only on its internal path and writes 0644 metrics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-sched-'));
  try {
    const token = join(dir, 'token');
    writeFileSync(token, 'x\n');
    const run = (url, extra = {}) => spawnSync(process.execPath, [join(root, 'scripts/invoke-retained-record-purge.mjs')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        RETENTION_PURGE_URL: url,
        RETENTION_PURGE_TOKEN_FILE: token,
        RETENTION_PURGE_LOCK_FILE: join(dir, 'lock'),
        RETENTION_PURGE_TIMEOUT_MS: '500',
        ...extra,
      },
    });
    assert.match(run('http://api-v2:3002/api/v2/admin/retention/purge-expired').stderr, /must target \/v2\/admin\/retention\/purge-expired/);
    assert.match(run('http://api-v2:3003/v2/admin/retention/purge-expired').stderr, /must use https/);
    assert.match(run('http://proxy:80/api/v2/admin/retention/purge-expired').stderr, /must use https/);
    assert.match(run('https://lunchlineup.com/v2/admin/retention/purge-expired').stderr, /must target \/api\/v2/);

    const metrics = join(dir, 'm.prom');
    const proof = join(dir, 'p.json');
    // api-v2 is not resolvable here, so the request fails, but the failure outputs are still written.
    const failed = run('http://api-v2:3002/v2/admin/retention/purge-expired', {
      RETENTION_PURGE_METRICS_FILE: metrics,
      RETENTION_PURGE_PROOF_FILE: proof,
    });
    assert.equal(failed.status, 1);
    assert.doesNotMatch(failed.stderr, /must (use|target)/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(metrics).mode & 0o777, 0o644);
      assert.equal(statSync(proof).mode & 0o777, 0o600);
    }
    assert.match(readFileSync(metrics, 'utf8'), /lunchlineup_retention_purge_last_attempt_timestamp_seconds\{mode="dry_run",stage="retained_records"\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retention scheduler install docs are end-to-end and verify-first', () => {
  const systemdReadme = read('infrastructure/systemd/README.md');
  const runbook = read('docs/runbooks/data-retention-delete-export.md');

  assert.match(systemdReadme, /install-retention-scheduler\.sh/);
  assert.match(systemdReadme, /install -m 0644 infrastructure\/systemd\/lunchlineup-retention-purge\.service \/etc\/systemd\/system\/lunchlineup-retention-purge\.service/);
  assert.match(systemdReadme, /install -m 0644 infrastructure\/systemd\/lunchlineup-retained-record-review\.service \/etc\/systemd\/system\/lunchlineup-retained-record-review\.service/);
  assert.match(systemdReadme, /systemd-analyze verify .*lunchlineup-retention-purge\.service .*lunchlineup-retained-record-review\.service/);
  assert.match(systemdReadme, /systemctl daemon-reload/);
  assert.match(systemdReadme, /Enabling \(separate owner decision\)/);
  assert.match(systemdReadme, /systemctl enable --now lunchlineup-retention-purge\.timer lunchlineup-retained-record-review\.timer/);
  assert.match(systemdReadme, /systemctl start lunchlineup-retention-purge\.service lunchlineup-retained-record-review\.service/);
  assert.match(systemdReadme, /journalctl -u lunchlineup-retention-purge\.service -u lunchlineup-retained-record-review\.service -n 100 --no-pager/);
  assert.match(systemdReadme, /test -s \/var\/lib\/lunchlineup\/proofs\/retention-purge-latest\.json/);
  assert.match(systemdReadme, /test -s \/var\/lib\/lunchlineup\/proofs\/retained-record-review-latest\.json/);
  assert.match(systemdReadme, /test -s \/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retention_purge\.prom/);
  assert.match(systemdReadme, /test -s \/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retained_record_review\.prom/);
  assert.match(systemdReadme, /RETENTION_PURGE_STAGE=application_data RETENTION_PURGE_DRY_RUN=false RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-application-data/);
  assert.match(systemdReadme, /RETENTION_PURGE_STAGE=retained_records RETENTION_PURGE_DRY_RUN=true/);
  assert.match(systemdReadme, /\/run\/lock\/lunchlineup-deploy\.lock/);
  assert.match(systemdReadme, /flock -w 600/);
  assert.match(systemdReadme, /no Dockerfile change/);

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

  assert.match(envExample, /RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE=/);
  assert.match(envExample, /RETENTION_PROOF_DIR=\/var\/lib\/lunchlineup\/proofs/);
  assert.match(envExample, /RETENTION_TEXTFILE_DIR=\/var\/lib\/node_exporter\/textfile_collector/);

  assert.match(runbook, /RETENTION_PURGE_URL=http:\/\/api-v2:3002\/v2\/admin\/retention\/purge-expired/);
  assert.match(runbook, /RETENTION_PURGE_TOKEN_FILE=\/run\/secrets\/retention_purge_token/);
  assert.match(runbook, /RETENTION_PURGE_PROOF_FILE=\/var\/lib\/lunchlineup\/proofs\/retention-purge-latest\.json/);
  assert.match(runbook, /RETENTION_PURGE_METRICS_FILE=\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retention_purge\.prom/);
  assert.match(runbook, /RETENTION_PURGE_LOCK_FILE=\/tmp\/retention-purge\.lock/);

  for (const content of [runbook, systemdReadme]) {
    assert.match(content, /\/var\/lib\/lunchlineup\/proofs\/retained-record-review-latest\.json/);
    assert.match(content, /\/var\/lib\/node_exporter\/textfile_collector\/lunchlineup_retained_record_review\.prom/);
    assert.match(content, /\/tmp\/retained-record-review\.lock/);
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

test('retained-record metrics use the host node_exporter textfile collector, not an in-stack exporter', () => {
  const compose = read('docker-compose.yml');
  const estate = read('docs/estate/README.md');

  assert.doesNotMatch(compose, /node-exporter|NODE_EXPORTER_TEXTFILE_DIR/);
  assert.doesNotMatch(compose, /^  node_exporter:/m);
  // The only textfile_collector references are the one-shot scheduler's metrics path and bind mount to the host directory.
  assert.match(serviceBlock(compose, 'retention-scheduler'), /textfile_collector/);
  assert.equal(compose.split('textfile_collector').length, serviceBlock(compose, 'retention-scheduler').split('textfile_collector').length);
  assert.match(estate, /node_exporter textfile collector/);
  assert.match(estate, /\/var\/lib\/node_exporter\/textfile_collector/);
});
