import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDeploymentContract } from '../../scripts/write-deployment-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const immutableImageRefPattern = /@sha256:[a-f0-9]{64}$/i;
const publicBuildConfigKeys = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_WS_URL',
  'NEXT_PUBLIC_OIDC_ENABLED',
  'NEXT_PUBLIC_SIGNUP_MODE',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL',
  'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL',
  'NEXT_PUBLIC_DPA_CONTACT_EMAIL',
  'NEXT_PUBLIC_APP_ORIGIN',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_APP_ENV',
];
const publicBuildConfigValues = {
  NEXT_PUBLIC_API_URL: '/api/v1',
  NEXT_PUBLIC_WS_URL: 'wss://lunchlineup.com',
  NEXT_PUBLIC_OIDC_ENABLED: 'false',
  NEXT_PUBLIC_SIGNUP_MODE: 'closed_beta',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
  NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: 'privacy@lunchlineup.com',
  NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@lunchlineup.com',
  NEXT_PUBLIC_DPA_CONTACT_EMAIL: 'dpa@lunchlineup.com',
  NEXT_PUBLIC_APP_ORIGIN: 'https://lunchlineup.com',
  NEXT_PUBLIC_APP_URL: 'https://lunchlineup.com',
  NEXT_PUBLIC_APP_ENV: 'production',
};

test('Compose requires a non-empty APP_ORIGIN for API startup', () => {
  const api = serviceBlock(read('docker-compose.yml'), 'api');
  assert.match(api, /APP_ORIGIN=\$\{APP_ORIGIN:\?Set public HTTPS APP_ORIGIN in \.env\}/);
  assert.doesNotMatch(api, /APP_ORIGIN=\$\{APP_ORIGIN:-\}/);
});

test('Compose keeps a production API fallback and propagates launch-critical delivery config', () => {
  const compose = read('docker-compose.yml');
  const api = serviceBlock(compose, 'api');
  const worker = serviceBlock(compose, 'worker');
  const envExample = read('.env.example');

  assert.ok(api.includes('- NODE_ENV=${NODE_ENV:-production}'));
  for (const block of [api, worker]) {
    assert.ok(block.includes('- STRIPE_METER_ID=${STRIPE_METER_ID:-}'));
    assert.ok(block.includes('- STRIPE_METER_AGGREGATION=${STRIPE_METER_AGGREGATION:-last}'));
  }
  assert.ok(worker.includes(
    '- PASSWORD_RESET_EMAIL_OUTBOX_ENABLED=${PASSWORD_RESET_EMAIL_OUTBOX_ENABLED:?Set PASSWORD_RESET_EMAIL_OUTBOX_ENABLED=true in .env}',
  ));
  assert.doesNotMatch(worker, /PASSWORD_RESET_EMAIL_OUTBOX_ENABLED=\$\{PASSWORD_RESET_EMAIL_OUTBOX_ENABLED:-/);
  assert.match(envExample, /^STRIPE_METER_AGGREGATION=last$/m);
  assert.match(envExample, /^PASSWORD_RESET_EMAIL_OUTBOX_ENABLED=true$/m);
});

function read(path) {
  return readFileSync(join(root, path), 'utf8');
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
function findBash() {
  if (process.platform === 'win32') {
    const gitBash = 'C:/Program Files/Git/bin/bash.exe';
    return existsSync(gitBash) ? gitBash : undefined;
  }
  const result = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? 'bash' : undefined;
}

function workerHealthCommand(worker) {
  const lines = worker.split(/\r?\n/);
  const marker = lines.findIndex((line) => line.trim() === '- |');
  assert.notEqual(marker, -1, 'worker healthcheck must use an executable command block');

  const commandLines = [];
  for (let index = marker + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('          ')) break;
    commandLines.push(line.slice(10));
  }

  return commandLines.join('\n').replaceAll('$$', '$');
}

const bash = findBash();

function serviceImageRef(compose, serviceName) {
  const match = serviceBlock(compose, serviceName).match(/^\s{4}image:\s*"?([^"\n]+)"?\s*$/m);
  assert.ok(match, `missing Compose image for ${serviceName}`);
  return match[1];
}

function parseEnv(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        assert.notEqual(separator, -1, `invalid env line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function samplePublicBuildConfig(overrides = {}) {
  const values = { ...publicBuildConfigValues, ...overrides };
  const canonical = JSON.stringify({ keys: publicBuildConfigKeys, values });
  return {
    sha256: createHash('sha256').update(canonical).digest('hex'),
    keys: publicBuildConfigKeys,
    values,
  };
}

function publicBuildRuntimeEnv(overrides = {}) {
  return Object.entries({ ...publicBuildConfigValues, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n';
}

function sampleReleaseManifest(sourceSha = '0123456789abcdef0123456789abcdef01234567') {
  const services = {
    api: 'Dockerfile.api',
    web: 'Dockerfile.web',
    engine: 'Dockerfile.engine',
    worker: 'Dockerfile.worker',
    migrate: 'Dockerfile.migrations',
    control: 'Dockerfile.control',
    backup: 'Dockerfile.backup',
  };

  return {
    version: 1,
    sourceSha,
    imagePrefix: 'ghcr.io/tuckerplee/lunchlineup',
    workflowRun: 'https://github.com/tuckerplee/lunchlineup/actions/runs/1',
    publicBuildConfig: samplePublicBuildConfig(),
    productionHealthProof: {
      domain: 'lunchlineup.com',
      url: 'https://lunchlineup.com/api/health',
    },
    deploymentContract: buildDeploymentContract(root),
    images: Object.fromEntries(
      Object.entries(services).map(([service, dockerfile], index) => {
        const digest = `sha256:${String(index + 1).repeat(64)}`;
        return [
          service,
          {
            ref: `ghcr.io/tuckerplee/lunchlineup/${service}:${sourceSha}@${digest}`,
            digest,
            dockerfile: `infrastructure/docker/${dockerfile}`,
          },
        ];
      }),
    ),
  };
}

function sampleLaunchProof(sourceSha = '0123456789abcdef0123456789abcdef01234567') {
  const checkedAt = new Date().toISOString();
  const proofEntry = (uri, summary, command, artifactDigit) => ({
    status: 'passed',
    sourceSha,
    uri,
    checkedAt,
    summary,
    command,
    exitCode: 0,
    artifactSha256: artifactDigit.repeat(64),
    artifactBytes: 2048,
  });

  return {
    version: 1,
    sourceSha,
    generatedAt: checkedAt,
    evidence: {
      runtimeEnv: proofEntry(
        'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/110',
        'validate-production-launch passed against the production runtime env',
        'node scripts/validate-production-launch.mjs /tmp/production-runtime.env',
        '1',
      ),
      dast: proofEntry(
        'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/111',
        'DAST baseline completed with no launch-blocking findings',
        'scripts/run-dast.sh https://lunchlineup.com',
        '2',
      ),
      load: proofEntry(
        'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/112',
        'Load smoke completed against the release image stack',
        'scripts/load-test.sh https://lunchlineup.com',
        '3',
      ),
      drDrill: {
        ...proofEntry(
          's3://lunchlineup-prod/launch-proof/dr-drill-20260709.json',
          'Off-host encrypted backup restored into the disposable DR drill database',
          'BACKUP_FILE=/tmp/lunchlineup-20260709000000.sql.zst.gpg DR_OFFHOST_SOURCE_URI=s3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg ./scripts/dr-drill.sh',
          '4',
        ),
        backupSha256: 'a'.repeat(64),
        restoredTableCount: 42,
        sourceUri: 's3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg',
      },
      pitrDrill: {
        ...proofEntry(
          's3://lunchlineup-prod/launch-proof/pitr-drill-20260709.json',
          'Named COMPLETE base backup and archived WAL restored with invariants passing',
          'PITR_BASE_BACKUP_ID=20260709T010000Z-1234 ./scripts/pitr-restore.sh && ./ops/check-pitr-invariants',
          '7',
        ),
        baseBackupId: '20260709T010000Z-1234',
        baseBackupUri: 's3://lunchlineup-prod/postgres/basebackups/20260709T010000Z-1234/COMPLETE',
        archivedWalSegment: '00000001000000000000002A',
        archivedWalUri: 's3://lunchlineup-prod/postgres/wal/00000001000000000000002A',
        recoveryTargetTime: checkedAt,
        sourceTimestamp: checkedAt,
      },
      alertRoute: proofEntry(
        'https://pagerduty.com/incidents/ABC123',
        'Production critical alert route delivered to the paging target',
        'amtool alert add ServiceDown severity=critical',
        '5',
      ),
    },
  };
}

test('Compose services are project-scoped and discover each other by service DNS', () => {
  const compose = read('docker-compose.yml');
  const prometheus = read('infrastructure/prometheus/prometheus.yml');

  assert.doesNotMatch(compose, /^\s*container_name:/m);
  assert.match(serviceBlock(compose, 'prometheus'), /infrastructure\/prometheus\/alerts:\/etc\/prometheus\/alerts:ro/);
  assert.match(prometheus, /targets:\s*\['api:3000'\]/);
  assert.match(prometheus, /targets:\s*\['engine:8000'\]/);
  assert.match(prometheus, /targets:\s*\['worker:3003'\]/);
  assert.match(prometheus, /targets:\s*\['webhook-replay:3004'\]/);
  assert.match(prometheus, /targets:\s*\['control:3001'\]/);
  assert.match(prometheus, /targets:\s*\['node-exporter:9100'\]/);
  assert.match(prometheus, /alertmanagers:[\s\S]*targets:\s*\['alertmanager:9093'\]/);
  assert.doesNotMatch(prometheus, /lunchlineup-(api|engine|worker|control)/);
});

test('RabbitMQ persists broker state on a declared project-scoped named volume', () => {
  const compose = read('docker-compose.yml');
  const rabbit = serviceBlock(compose, 'rabbitmq');
  const topLevelVolumes = compose.slice(compose.indexOf('\nvolumes:\n'));

  assert.match(rabbit, /^\s{4}volumes:\s*\n\s{6}- rabbitmq_data:\/var\/lib\/rabbitmq$/m);
  assert.doesNotMatch(rabbit, /\.\/.*:\/var\/lib\/rabbitmq/);
  assert.match(topLevelVolumes, /^  rabbitmq_data:\s*$/m);
});

test('Compose build services are tagged for release-image smoke checks', () => {
  const compose = read('docker-compose.yml');

  for (const service of ['api', 'web', 'engine', 'worker', 'migrate', 'control', 'backup']) {
    assert.match(
      serviceBlock(compose, service),
      new RegExp(`image: "\\$\\{IMAGE_PREFIX:-lunchlineup\\}/${service}:\\$\\{IMAGE_TAG:-local\\}"`),
    );
  }
});

test('web image bakes explicit public config at build time', () => {
  const dockerfile = read('infrastructure/docker/Dockerfile.web');
  const compose = read('docker-compose.yml');
  const ci = read('.github/workflows/ci.yml');
  const webBlock = serviceBlock(compose, 'web');
  const publicBuildKeys = [
    'NEXT_PUBLIC_API_URL',
    'NEXT_PUBLIC_WS_URL',
    'NEXT_PUBLIC_OIDC_ENABLED',
    'NEXT_PUBLIC_SIGNUP_MODE',
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL',
    'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL',
    'NEXT_PUBLIC_DPA_CONTACT_EMAIL',
    'NEXT_PUBLIC_APP_ORIGIN',
    'NEXT_PUBLIC_APP_URL',
    'NEXT_PUBLIC_APP_ENV',
  ];

  assert.match(ci, /Verify web public build config/);
  assert.match(ci, /NEXT_PUBLIC_WS_URL must use wss for main-branch web image builds/);
  assert.match(ci, /NEXT_PUBLIC_WS_URL must not point at localhost in release images/);
  assert.match(ci, /public_build_config=/);
  assert.match(ci, /"publicBuildConfig": \$\{public_build_config\}/);

  for (const key of publicBuildKeys) {
    assert.ok(dockerfile.includes(`ARG ${key}=`), `Dockerfile.web must declare ${key} as a build arg`);
    assert.ok(dockerfile.includes(`${key}=$${key}`), `Dockerfile.web must export ${key}`);
    assert.ok(webBlock.includes(`${key}: \${${key}:-`), `Compose web build args must pass ${key}`);
    assert.ok(webBlock.includes(`- ${key}=\${${key}:-`), `Compose web runtime env must pass ${key}`);
    assert.ok(ci.includes(`${key}=\${{ vars.${key}`), `CI web build args must pass ${key}`);
  }
});

test('Dockerfile base images are digest-pinned', () => {
  for (const dockerfile of [
    'Dockerfile.api',
    'Dockerfile.backup',
    'Dockerfile.control',
    'Dockerfile.engine',
    'Dockerfile.migrations',
    'Dockerfile.web',
    'Dockerfile.worker',
  ]) {
    const content = read(`infrastructure/docker/${dockerfile}`);
    const fromLines = content.split(/\r?\n/).filter((line) => /^\s*FROM\s+/i.test(line));

    assert.ok(fromLines.length > 0, `${dockerfile} must declare a base image`);
    for (const line of fromLines) {
      assert.match(line, /^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?\s*$/i, dockerfile);
      assert.doesNotMatch(line, /(^|[/:])latest(@|\s|$)/i, dockerfile);
    }
  }

  const backupDockerfile = read('infrastructure/docker/Dockerfile.backup');
  assert.match(backupDockerfile, /apk add --no-cache[^\n]*aws-cli[^\n]*rclone/);
});

test('Compose third-party service images are digest-pinned', () => {
  const compose = read('docker-compose.yml');

  for (const service of [
    'proxy',
    'pgbouncer',
    'postgres',
    'redis',
    'rabbitmq',
    'autoheal',
    'prometheus',
    'alertmanager',
    'node-exporter',
    'loki',
    'promtail',
    'otel-collector',
    'tempo',
    'grafana',
  ]) {
    const ref = serviceImageRef(compose, service);
    assert.match(ref, immutableImageRefPattern, service);
    assert.match(ref, /:[^:@]+@sha256:/, service);
    assert.doesNotMatch(ref, /\$\{/, service);
    assert.doesNotMatch(ref, /(^|[/:])latest(@|$)/i, service);
    assert.doesNotMatch(serviceBlock(compose, service), /build:/, service);
  }

  assert.match(serviceImageRef(compose, 'pgbouncer'), /^edoburu\/pgbouncer:v1\.25\.2-p0@sha256:/);
  assert.match(serviceImageRef(compose, 'autoheal'), /^willfarrell\/autoheal:1\.2\.0@sha256:/);
});

test('CI service containers are digest-pinned', () => {
  const ci = read('.github/workflows/ci.yml');
  const imageRefs = [...ci.matchAll(/^\s+image:\s*"?([^"\n]+)"?\s*$/gm)].map((match) => match[1]);

  assert.deepEqual(imageRefs.sort(), [
    'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777',
    'rabbitmq:3-alpine@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc',
    'redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99',
  ].sort());

  for (const ref of imageRefs) {
    assert.match(ref, immutableImageRefPattern);
    assert.doesNotMatch(ref, /(^|[/:])latest(@|$)/i);
  }
});

test('Compose host ports default to loopback and require explicit edge exposure', () => {
  const compose = read('docker-compose.yml');
  const control = serviceBlock(compose, 'control');
  const autoheal = serviceBlock(compose, 'autoheal');

  assert.match(serviceBlock(compose, 'proxy'), /ports:[\s\S]*- "\$\{PROXY_HTTP_BIND:-127\.0\.0\.1\}:\$\{PROXY_HTTP_PORT:-80\}:80"[\s\S]*- "\$\{PROXY_HTTPS_BIND:-127\.0\.0\.1\}:\$\{PROXY_HTTPS_PORT:-443\}:443"/);
  assert.match(serviceBlock(compose, 'api'), /ports:[\s\S]*- "\$\{API_HOST_BIND:-127\.0\.0\.1\}:\$\{API_HOST_PORT:-4000\}:3000"/);
  assert.match(serviceBlock(compose, 'api'), /API_INTERNAL_HOSTS=\$\{API_INTERNAL_HOSTS:-api,api:3000\}/);
  assert.match(serviceBlock(compose, 'api'), /RETENTION_PURGE_SERVICE_TOKEN_FILE=\/run\/secrets\/retention_purge_token/);
  assert.match(serviceBlock(compose, 'api'), /secrets:[\s\S]*- metrics_token[\s\S]*- retention_purge_token/);
  assert.match(compose, /retention_purge_token:[\s\S]*RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE/);
  assert.doesNotMatch(serviceBlock(compose, 'alertmanager'), /ports:/);
  assert.match(control, /ports:[\s\S]*- "127\.0\.0\.1:3001:3001"/);
  assert.match(control, /CONTROL_PLANE_HOST=0\.0\.0\.0/);
  assert.match(control, /CONTROL_PLANE_DOCKER_STATUS=disabled/);
  assert.doesNotMatch(control, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(control, /^\s{6}- data$/m);
  assert.match(control, /networks:\s*\n\s+- management/);
  assert.match(serviceBlock(compose, 'grafana'), /ports:[\s\S]*- "127\.0\.0\.1:3002:3000"/);
  assert.match(autoheal, /profiles:\s*\n\s+- ops/);
  assert.match(autoheal, /\/var\/run\/docker\.sock/);
  assert.equal((compose.match(/^\s+- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock\s*$/gm) ?? []).length, 1);
});

test('Alertmanager has dedicated outbound paging egress without public ingress', () => {
  const compose = read('docker-compose.yml');
  const alertmanager = serviceBlock(compose, 'alertmanager');

  assert.match(alertmanager, /networks:\s*\n\s+management:\s*\n\s+alertmanager-egress:\s*\n\s+gw_priority: 1/);
  assert.doesNotMatch(alertmanager, /ports:/);
  assert.match(
    compose,
    /  alertmanager-egress:\s*\n    driver: bridge\s*\n    internal: false\s*\n    driver_opts:\s*\n      com\.docker\.network\.bridge\.enable_icc: "false"/,
  );
  assert.equal((compose.match(/alertmanager-egress/g) ?? []).length, 2);
});

test('control healthcheck uses the IPv4 loopback endpoint with the admin token', () => {
  const compose = read('docker-compose.yml');
  const control = serviceBlock(compose, 'control');

  assert.match(control, /CMD-SHELL/);
  assert.match(control, /http:\/\/127\.0\.0\.1:3001\/api\/status/);
  assert.match(control, /Authorization: Bearer \$\$\(cat \/run\/secrets\/control_plane_admin_token\)/);
  assert.doesNotMatch(control, /http:\/\/localhost:3001\/api\/status/);
});

test('worker metrics endpoint is healthchecked and scraped', () => {
  const compose = read('docker-compose.yml');
  const worker = serviceBlock(compose, 'worker');
  const workerDockerfile = read('infrastructure/docker/Dockerfile.worker');
  const prometheus = read('infrastructure/prometheus/prometheus.yml');

  assert.match(workerDockerfile, /apt-get install[\s\S]*\bcurl\b/);
  assert.match(compose, /worker:[\s\S]*WORKER_METRICS_PORT=\$\{WORKER_METRICS_PORT:-3003\}/);
  assert.match(compose, /worker:[\s\S]*curl -fsS http:\/\/127\.0\.0\.1:\$\$\{WORKER_METRICS_PORT:-3003\}\/metrics/);
  assert.match(worker, /PASSWORD_RESET_EMAIL_OUTBOX_ENABLED:-false/);
  assert.ok(worker.includes("lunchlineup_password_reset_email_sweep_running 1(\\.0+)?"));
  assert.ok(worker.includes("lunchlineup_password_reset_email_sweep_ready 1(\\.0+)?"));
  assert.match(prometheus, /job_name: 'worker'[\s\S]*targets:\s*\['worker:3003'\]/);
});

test('worker health fails when enabled password-reset sweep readiness is absent or zero', {
  skip: bash ? false : 'Bash is not available',
}, () => {
  const worker = serviceBlock(read('docker-compose.yml'), 'worker');
  const command = workerHealthCommand(worker);
  const shell = 'curl() { printf "%s" "$METRICS_FIXTURE"; }\n' + command;
  const run = (metrics, enabled = 'true') => spawnSync(bash, ['-c', shell], {
    env: { ...process.env, METRICS_FIXTURE: metrics, PASSWORD_RESET_EMAIL_OUTBOX_ENABLED: enabled },
    encoding: 'utf8',
  });

  const ready = 'lunchlineup_password_reset_email_sweep_running 1.0\nlunchlineup_password_reset_email_sweep_ready 1.0\n';
  assert.equal(run(ready).status, 0);

  const missingReady = 'lunchlineup_password_reset_email_sweep_running 1.0\n';
  assert.notEqual(run(missingReady).status, 0);

  const zeroReady = 'lunchlineup_password_reset_email_sweep_running 1.0\nlunchlineup_password_reset_email_sweep_ready 0.0\n';
  assert.notEqual(run(zeroReady).status, 0);

  assert.equal(run(missingReady, 'false').status, 0);
});
test('engine healthcheck requires the bound and started gRPC scheduling path', () => {
  const compose = read('docker-compose.yml');
  const engine = serviceBlock(compose, 'engine');
  const source = read('apps/engine/main.py');

  assert.match(engine, /ENGINE_GRPC_REQUIRED=true/);
  assert.match(engine, /curl -fsS http:\/\/127\.0\.0\.1:8000\/health/);
  assert.match(source, /bound_port = server\.add_insecure_port\(bind_address\)/);
  assert.match(source, /if bound_port == 0:/);
  assert.match(source, /server\.start\(\)[\s\S]*GRPC_SERVER_READY = True/);
  assert.match(source, /GRPC_REQUIRED and not GRPC_SERVER_READY[\s\S]*status_code=503/);
});

test('observability alerts have live metric sources', () => {
  const compose = read('docker-compose.yml');
  const prometheus = read('infrastructure/prometheus/prometheus.yml');
  const alerts = read('infrastructure/prometheus/alerts/lunchlineup.yml');
  const alertmanager = read('infrastructure/alertmanager/alertmanager.yml');

  assert.match(compose, /alertmanager:[\s\S]*prom\/alertmanager:v0\.27\.0/);
  assert.match(compose, /alertmanager:[\s\S]*alertmanager_webhook_url/);
  assert.match(compose, /alertmanager_webhook_url:[\s\S]*ALERTMANAGER_WEBHOOK_URL_FILE/);
  assert.match(prometheus, /environment: lunchlineup-compose/);
  assert.match(prometheus, /alerting:[\s\S]*targets:\s*\['alertmanager:9093'\]/);
  assert.match(alertmanager, /receiver: production-paging-webhook/);
  assert.match(alertmanager, /url_file: \/run\/secrets\/alertmanager_webhook_url/);
  assert.match(compose, /node-exporter:[\s\S]*prom\/node-exporter:v1\.8\.1/);
  assert.match(prometheus, /job_name: 'node'[\s\S]*targets:\s*\['node-exporter:9100'\]/);
  assert.match(alerts, /alert: ServiceDown/);
  assert.match(alerts, /alert: WorkerJobFailures/);
  assert.match(alerts, /alert: WebhookReplayNotReady/);
  assert.match(alerts, /alert: WebhookReplayFailures/);
  assert.match(alerts, /node_filesystem_avail_bytes\{job="node"/);
  assert.match(alerts, /sum by \((job, )?route\) \(rate\(http_requests_total\{job="api",status=~"5\.\."\}\[5m\]\)\)/);
  assert.doesNotMatch(alerts, /rate\(http_requests_total\{job="api",status=~"5\.\."\}\[2m\]\) \//);
});

test('control plane Docker status is opt-in and exports service gauges', () => {
  const source = read('apps/control-plane/src/main.ts');

  assert.match(source, /docker\.listContainers\(\{ all: true \}\)/);
  assert.match(source, /CONTROL_PLANE_EXPECTED_SERVICES/);
  assert.match(source, /CONTROL_PLANE_DOCKER_STATUS/);
  assert.match(source, /CONTROL_PLANE_DOCKER_SOCKET_PATH is required/);
  assert.match(source, /lunchlineup_control_plane_service_up/);
  assert.match(source, /docker_status_disabled/);
  assert.match(source, /docker_unavailable/);
});

test('control plane defaults private and protects operational endpoints with an admin token', () => {
  const compose = read('docker-compose.yml');
  const prometheus = read('infrastructure/prometheus/prometheus.yml');
  const source = read('apps/control-plane/src/main.ts');
  const control = serviceBlock(compose, 'control');

  assert.match(source, /CONTROL_PLANE_HOST \?\? '127\.0\.0\.1'/);
  assert.match(source, /app\.use\('\/api\/status', requireAdminToken\(config\)\)/);
  assert.match(source, /app\.use\('\/api\/control', requireAdminToken\(config\)\)/);
  assert.match(source, /app\.use\('\/api\/metrics', requireMetricsToken\(config\)\)/);
  assert.match(source, /NODE_ENV === 'production'[\s\S]*CONTROL_PLANE_ADMIN_TOKEN_FILE is required/);
  assert.match(source, /CONTROL_PLANE_METRICS_TOKEN_FILE is required/);
  assert.match(source, /timingSafeEqual/);
  assert.match(control, /CONTROL_PLANE_ADMIN_TOKEN_FILE=\/run\/secrets\/control_plane_admin_token/);
  assert.match(control, /CONTROL_PLANE_METRICS_TOKEN_FILE=\/run\/secrets\/metrics_token/);
  assert.match(control, /secrets:[\s\S]*- control_plane_admin_token[\s\S]*- metrics_token/);
  assert.match(compose, /control_plane_admin_token:[\s\S]*CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE/);
  assert.match(control, /secrets:[\s\S]*- metrics_token/);
  assert.match(prometheus, /job_name: 'control'[\s\S]*authorization:[\s\S]*type: Bearer[\s\S]*credentials_file: \/run\/secrets\/metrics_token/);
});

test('database migrations gate API and worker startup', () => {
  const compose = read('docker-compose.yml');
  const ci = read('.github/workflows/ci.yml');

  assert.match(serviceBlock(compose, 'api'), /migrate:[\s\S]*condition: service_completed_successfully/);
  assert.match(serviceBlock(compose, 'worker'), /migrate:[\s\S]*condition: service_completed_successfully/);
  assert.match(serviceBlock(compose, 'webhook-replay'), /migrate:[\s\S]*condition: service_completed_successfully/);
  assert.match(serviceBlock(compose, 'migrate'), /dockerfile: infrastructure\/docker\/Dockerfile\.migrations/);
  assert.match(serviceBlock(compose, 'migrate'), /DATA_TARGET_ENV=\$\{DATA_TARGET_ENV:-development\}/);
  assert.match(ci, /name: "9\. Run Migrations"[\s\S]*DATA_TARGET_ENV: test/);
});

test('only the migration container imports the shared service env file', () => {
  const compose = read('docker-compose.yml');
  const smokeWriter = read('scripts/write-smoke-env.mjs');

  assert.match(serviceBlock(compose, 'migrate'), /env_file: \$\{COMPOSE_SERVICE_ENV_FILE:-\.env\}/);
  for (const service of ['api', 'webhook-replay', 'worker', 'backup']) {
    const block = serviceBlock(compose, service);
    assert.doesNotMatch(block, /env_file:/);
    assert.doesNotMatch(block, /MIGRATION_DATABASE_URL/);
    assert.doesNotMatch(block, /APP_DB_PASSWORD/);
  }

  assert.doesNotMatch(serviceBlock(compose, 'api'), /POSTGRES_PASSWORD/);
  assert.doesNotMatch(serviceBlock(compose, 'webhook-replay'), /POSTGRES_PASSWORD/);
  assert.doesNotMatch(serviceBlock(compose, 'worker'), /POSTGRES_PASSWORD/);

  assert.match(smokeWriter, /COMPOSE_SERVICE_ENV_FILE/);
  assert.match(smokeWriter, /composeServiceEnvFile/);
});

test('webhook replay worker runs from the API image and only consumes opaque retry ids', () => {
  const compose = read('docker-compose.yml');
  const apiPackage = read('apps/api/package.json');
  const webhookReadme = read('apps/api/src/webhooks/README.md');
  const replayBlock = serviceBlock(compose, 'webhook-replay');

  assert.match(replayBlock, /image: "\$\{IMAGE_PREFIX:-lunchlineup\}\/api:\$\{IMAGE_TAG:-local\}"/);
  assert.match(replayBlock, /command: \[ "node", "dist\/webhooks\/webhook-replay\.worker\.js" \]/);
  assert.match(replayBlock, /RABBITMQ_URL=\$\{RABBITMQ_URL:\?Set validated percent-encoded RABBITMQ_URL in \.env\}/);
  assert.match(replayBlock, /WEBHOOK_RETRY_WORKER_PREFETCH=\$\{WEBHOOK_RETRY_WORKER_PREFETCH:-5\}/);
  assert.match(replayBlock, /WEBHOOK_REPLAY_METRICS_PORT=\$\{WEBHOOK_REPLAY_METRICS_PORT:-3004\}/);
  assert.match(replayBlock, /networks:\s*\n\s+app:\s*\n\s+data:\s*\n\s+outbound-egress:\s*\n\s+gw_priority: 1/);
  assert.match(replayBlock, /wget --no-verbose --tries=1 --spider http:\/\/127\.0\.0\.1:\$\$\{WEBHOOK_REPLAY_METRICS_PORT:-3004\}\/health/);
  assert.match(apiPackage, /"start:webhook-replay": "node dist\/webhooks\/webhook-replay\.worker\.js"/);
  assert.match(webhookReadme, /webhook-replay\.worker\.ts/);
  assert.match(webhookReadme, /webhook-retry-queue\.ts/);
});

test('worker and webhook replay have isolated NAT egress without published ingress', () => {
  const compose = read('docker-compose.yml');
  const network = compose.slice(compose.indexOf('  outbound-egress:'), compose.indexOf('\nvolumes:'));

  for (const service of ['worker', 'webhook-replay']) {
    const block = serviceBlock(compose, service);
    const expectedNetworks = service === 'worker'
      ? /networks:\s*\n\s+app:\s*\n\s+data:\s*\n\s+telemetry:\s*\n\s+outbound-egress:\s*\n\s+gw_priority: 1/
      : /networks:\s*\n\s+app:\s*\n\s+data:\s*\n\s+outbound-egress:\s*\n\s+gw_priority: 1/;
    assert.match(block, expectedNetworks, service);
    assert.doesNotMatch(block, /^\s+ports:/m, service);
    assert.match(block, /healthcheck:/, service);
  }

  assert.match(network, /driver: bridge/);
  assert.match(network, /internal: false/);
  assert.match(network, /com\.docker\.network\.bridge\.enable_icc: "false"/);
});

test('worker exposes bounded operator-gated billing dead-letter replay controls', () => {
  const compose = read('docker-compose.yml');
  const worker = serviceBlock(compose, 'worker');

  assert.match(worker, /STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED=\$\{STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED:-false\}/);
  assert.match(worker, /STRIPE_USAGE_DEAD_LETTER_REPLAY_BATCH_SIZE=\$\{STRIPE_USAGE_DEAD_LETTER_REPLAY_BATCH_SIZE:-25\}/);
  assert.match(worker, /STRIPE_USAGE_DEAD_LETTER_REPLAY_MIN_AGE_SECONDS=\$\{STRIPE_USAGE_DEAD_LETTER_REPLAY_MIN_AGE_SECONDS:-900\}/);
  assert.match(worker, /STRIPE_USAGE_DEAD_LETTER_MAX_REPLAYS=\$\{STRIPE_USAGE_DEAD_LETTER_MAX_REPLAYS:-1\}/);
});

test('proxy config is TLS-ready, route-specific, size-limited, and sets browser security headers', () => {
  const compose = read('docker-compose.yml');
  const caddy = read('infrastructure/caddy/Caddyfile');
  const caddyTemplate = read('infrastructure/caddy/Caddyfile.template');

  assert.match(compose, /CADDY_SITE_ADDRESSES/);
  assert.match(serviceBlock(compose, 'proxy'), /DEPLOY_RELEASE_SHA: "\$\{IMAGE_TAG:-local\}"/);
  assert.match(caddy, /\{\$CADDY_SITE_ADDRESSES:/);
  assert.match(caddy, /X-LunchLineup-Release "\{\$DEPLOY_RELEASE_SHA:local\}"/);
  assert.match(caddy, /handle \/health \{[\s\S]*reverse_proxy api:3000[\s\S]*\}/);
  assert.match(caddy, /handle \/api\/health \{[\s\S]*uri strip_prefix \/api[\s\S]*reverse_proxy api:3000[\s\S]*\}/);
  assert.match(caddy, /handle \/api\/v1\/\* \{[\s\S]*uri strip_prefix \/api[\s\S]*reverse_proxy api:3000[\s\S]*\}/);
  assert.match(caddy, /handle \/ws\/\* \{[\s\S]*reverse_proxy engine:8000[\s\S]*\}/);
  assert.match(caddy, /handle \{[\s\S]*reverse_proxy web:3000[\s\S]*\}/);
  assert.match(caddy, /request_body[\s\S]*max_size 10MB/);
  assert.match(caddy, /Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"/);
  assert.match(caddy, /Content-Security-Policy/);
  assert.match(caddy, /script-src 'self' https:\/\/challenges\.cloudflare\.com 'unsafe-inline'/);
  assert.match(caddy, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(caddy, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(caddy, /X-Content-Type-Options "nosniff"/);
  assert.match(caddy, /X-Frame-Options "DENY"/);
  assert.match(caddy, /Permissions-Policy/);
  assert.match(caddyTemplate, /\{\$CADDY_SITE_ADDRESSES:/);
  assert.match(caddyTemplate, /X-LunchLineup-Release "\{\$DEPLOY_RELEASE_SHA:local\}"/);
  assert.match(caddyTemplate, /handle \/api\/v1\/\* \{[\s\S]*uri strip_prefix \/api[\s\S]*reverse_proxy api:3000[\s\S]*\}/);
  assert.match(caddyTemplate, /handle \/ws\/\* \{[\s\S]*reverse_proxy engine:8000[\s\S]*\}/);
  assert.match(caddyTemplate, /request_body[\s\S]*max_size 10MB/);
  assert.match(caddyTemplate, /Content-Security-Policy/);
  assert.match(caddyTemplate, /script-src 'self' https:\/\/challenges\.cloudflare\.com 'unsafe-inline'/);
  assert.match(caddyTemplate, /frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(caddyTemplate, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(caddyTemplate, /Permissions-Policy/);
  assert.doesNotMatch(caddyTemplate, /\{\{|\}\}/);
  assert.doesNotMatch(caddyTemplate, /X-XSS-Protection/);
});

test('example env and deploy helpers do not encode copyable weak secrets', () => {
  const envExample = read('.env.example');
  const bootstrap = read('scripts/bootstrap-vm107-dev.sh');
  const setup = read('scripts/setup-vm217.sh');

  assert.doesNotMatch(envExample, /guest:guest|change_me/);
  assert.doesNotMatch(bootstrap, /guest:guest|password@postgres|POSTGRES_PASSWORD password/);
  assert.doesNotMatch(setup, /guest:guest|password@postgres|DB_PASS=\$\{DB_PASS:-password\}/);

  for (const key of [
    'POSTGRES_PASSWORD',
    'RABBITMQ_PASSWORD',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'SESSION_SECRET',
    'CSRF_SECRET',
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'GRAFANA_PASSWORD',
    'CONTROL_PLANE_PASSWORD',
  ]) {
    assert.match(envExample, new RegExp(`^${key}=$`, 'm'));
  }

  assert.match(envExample, /^CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE=\.\/secrets\/control_plane_admin_token$/m);
  assert.match(envExample, /^CONTROL_PLANE_ADMIN_TOKEN_FILE=\.\/secrets\/control_plane_admin_token$/m);
  assert.match(envExample, /^CONTROL_PLANE_METRICS_TOKEN_FILE=\.\/secrets\/metrics_token$/m);
  assert.doesNotMatch(envExample, /^CONTROL_PLANE_ADMIN_TOKEN_FILE=\.\/secrets\/metrics_token$/m);
});

test('CI smoke jobs use the shared smoke environment generator', () => {
  const ci = read('.github/workflows/ci.yml');
  const smokeWriter = read('scripts/write-smoke-env.mjs');

  assert.equal((ci.match(/node scripts\/write-smoke-env\.mjs \.env\.smoke/g) ?? []).length, 3);
  assert.equal((ci.match(/docker pull "\$ref"/g) ?? []).length, 3);
  assert.ok((ci.match(/node scripts\/verify-release-artifacts\.mjs \.release\/release-manifest\.json --source-sha "\$GITHUB_SHA"/g) ?? []).length >= 3);
  assert.equal((ci.match(/actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/g) ?? []).length, 10);
  assert.equal((ci.match(/docker compose --env-file \.env\.smoke up -d --no-build/g) ?? []).length, 3);
  assert.equal((ci.match(/--no-build --pull never/g) ?? []).length, 3);
  assert.equal((ci.match(/docker image inspect "\$\{IMAGE_PREFIX\}\/\$\{service\}:\$\{IMAGE_TAG\}"/g) ?? []).length, 2);
  assert.equal((ci.match(/rm -f \.env\.smoke secrets\/metrics_token/g) ?? []).length, 3);
  assert.match(ci, /IMAGE_TAG: \$\{\{ github\.sha \}\}/);
  assert.match(ci, /SMOKE_TARGET_URL: http:\/\/localhost:8080/);
  assert.match(ci, /TARGET_URL: http:\/\/localhost:8080/);
  assert.equal((ci.match(/docker compose --env-file \.env\.smoke pull proxy pgbouncer postgres redis rabbitmq pitr-tools/g) ?? []).length, 3);
  assert.doesNotMatch(ci, /docker compose up -d --build/);
  assert.doesNotMatch(ci, /cat > \.env/);
  assert.match(smokeWriter, /CADDY_SITE_ADDRESSES/);
  assert.match(smokeWriter, /PROXY_HTTP_BIND/);
  assert.match(smokeWriter, /PROXY_HTTP_PORT/);
  assert.match(smokeWriter, /ALERTMANAGER_WEBHOOK_URL_FILE/);
  assert.match(smokeWriter, /alertmanager_webhook_url/);
  assert.match(smokeWriter, /\.env\.smoke/);
  assert.match(smokeWriter, /metrics-token-path/);
  assert.match(smokeWriter, /randomBytes/);
  assert.match(smokeWriter, /secret\('metrics_'\)/);
  assert.match(smokeWriter, /DOMAIN: 'smoke\.lunchlineup\.test'/);
  assert.match(smokeWriter, /COOKIE_SECURE: 'true'/);
  assert.doesNotMatch(smokeWriter, /JWT_SECRET: '.*(secret|change_me|replace_me|example|password)/i);
});

test('main branch release jobs fail closed when required deployment variables are missing', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /^concurrency:\s*\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s+cancel-in-progress: false/m);
  assert.match(ci, /Write immutable release manifest/);
  assert.match(ci, /release-manifest\.json/);
  assert.match(ci, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(ci, /api_ref: \$\{\{ steps\.release_manifest\.outputs\.api_ref \}\}/);
  assert.match(ci, /validate-release-gates:/);
  assert.match(ci, /needs: \[e2e-tests, fullstack-e2e, load-test, dast, trivy-scan, sbom, build-images, terraform-validation\]/);
  assert.match(ci, /fullstack-e2e:/);
  assert.match(ci, /E2E_FULL_STACK: '1'/);
  assert.match(ci, /E2E_MOCK_API: '0'/);
  assert.match(ci, /seed-e2e\.mjs/);
  assert.match(ci, /operations-workflows\.spec\.ts/);
  assert.match(ci, /tenant-admin-workflows\.spec\.ts/);
  assert.match(ci, /Require pushed GitHub source proof/);
  assert.match(ci, /git ls-remote origin refs\/heads\/main/);
  assert.match(ci, /test "\$remote_sha" = "\$GITHUB_SHA"/);
  assert.match(ci, /Verify immutable release and deploy command contract/);
  assert.match(ci, /productionHealthProof/);
  assert.match(ci, /DOMAIN: \$\{\{ vars\.DOMAIN \}\}/);
  assert.match(ci, /--production-api-health-url-env PRODUCTION_API_HEALTH_URL/);
  assert.match(ci, /matrix:\s*\n\s+service: \[api, web, engine, worker, migrate, control, backup\]/);
  assert.match(ci, /scan-type: 'image'/);
  assert.match(ci, /image-ref: \$\{\{ steps\.release_image\.outputs\.ref \}\}/);
  assert.match(ci, /verify-trivy-release-reports\.mjs/);
  assert.match(ci, /pattern: trivy-release-\*/);
  assert.doesNotMatch(ci, /scan-type: 'fs'/);
  assert.match(ci, /--command-env STAGING_DEPLOY_COMMAND/);
  assert.match(ci, /--command-env PRODUCTION_DEPLOY_COMMAND/);
  assert.match(ci, /--post-deploy-proof-command-env PRODUCTION_POST_DEPLOY_PROOF_COMMAND/);
  assert.match(ci, /--rollback-command-env PRODUCTION_ROLLBACK_COMMAND/);
  assert.match(ci, /Verify staging release artifact contract/);
  assert.match(ci, /Verify production release artifact contract/);
  assert.match(ci, /production-rollback:/);
  assert.match(ci, /name: Arm production rollback[\s\S]*id: arm_production_rollback[\s\S]*armed=true/);
  assert.doesNotMatch(ci, /production_deploy_mutation_started|mutation_started=true/);
  assert.match(ci, /id: production_deploy/);
  assert.match(ci, /needs: \[deploy-production, production-smoke\]/);
  assert.match(ci, /needs\.deploy-production\.outputs\.production_rollback_armed == 'true'/);
  assert.match(ci, /needs\.deploy-production\.result != 'success' \|\| needs\.production-smoke\.result != 'success'/);
  assert.match(ci, /Rehydrate and verify production runtime secret/);
  assert.match(ci, /PRODUCTION_RUNTIME_SECRET_REFERENCE: \$\{\{ vars\.PRODUCTION_RUNTIME_SECRET_REFERENCE \}\}/);
  assert.match(ci, /PRODUCTION_RUNTIME_SECRET_VERSION: \$\{\{ vars\.PRODUCTION_RUNTIME_SECRET_VERSION \}\}/);
  assert.match(ci, /RUNTIME_SECRET_AWS_ACCESS_KEY_ID/);
  assert.match(ci, /umask 077/);
  assert.match(ci, /release_inputs="\$RUNNER_TEMP\/lunchlineup-deployed-inputs"/);
  assert.match(ci, /runtime_env="\$RUNNER_TEMP\/lunchlineup-runtime\.env"/);
  assert.match(ci, /rehydrate-runtime-secret\.mjs[\s\S]*--descriptor-output "\$release_inputs\/runtime-secret\.json"/);
  assert.match(ci, /--runtime-secret "\$release_inputs\/runtime-secret\.json"/);
  assert.match(ci, /node scripts\/validate-production-launch\.mjs "\$runtime_env"/);
  assert.doesNotMatch(ci, /PRODUCTION_RUNTIME_ENV_B64/);
  assert.doesNotMatch(ci, /\$release_inputs\/runtime\.env/);
  assert.match(ci, /LAUNCH_PROOF_ARTIFACT_SHA256=\$launch_proof_sha256/);
  assert.match(ci, /LAUNCH_PROOF_MAX_AGE_SECONDS=\$LAUNCH_PROOF_MAX_AGE_SECONDS/);
  assert.match(ci, /launch_proof_sha256: \$\{\{ steps\.launch_proof\.outputs\.sha256 \}\}/);
  assert.match(ci, />> "\$GITHUB_ENV"/);
  assert.match(ci, /test -f "\$PRODUCTION_RUNTIME_ENV_PATH"/);
  assert.match(ci, /sha256sum "\$PRODUCTION_RUNTIME_ENV_PATH"/);
  assert.match(ci, /test "\$COMPOSE_SERVICE_ENV_FILE" = "\$PRODUCTION_RUNTIME_ENV_PATH"/);
  assert.match(ci, /Cleanup production runtime environment and rollback secrets/);
  assert.match(ci, /rm -rf "\$RUNNER_TEMP\/lunchlineup-deployed-inputs"/);
  for (const name of [
    'STAGING_DEPLOY_COMMAND',
    'STAGING_API_HEALTH_URL',
    'STAGING_WEB_URL',
    'PRODUCTION_DEPLOY_COMMAND',
    'PRODUCTION_HEALTH_URL',
    'PRODUCTION_API_HEALTH_URL',
    'PRODUCTION_WEB_URL',
    'PRODUCTION_POST_DEPLOY_PROOF_COMMAND',
    'PRODUCTION_ROLLBACK_COMMAND',
  ]) {
    assert.match(ci, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
    assert.match(ci, new RegExp(`test -n "\\$${name}"`));
  }
  assert.doesNotMatch(ci, /vars\.STAGING_DEPLOY_COMMAND != ''/);
  assert.doesNotMatch(ci, /vars\.PRODUCTION_DEPLOY_COMMAND != ''/);
  assert.doesNotMatch(ci, /vars\.PRODUCTION_HEALTH_URL != ''/);
  assert.match(ci, /verify-external-health-release\.mjs "\$STAGING_API_HEALTH_URL" "\$RELEASE_SOURCE_SHA"/);
  assert.match(ci, /verify-external-health-release\.mjs "\$STAGING_WEB_URL" "\$RELEASE_SOURCE_SHA"/);
  assert.match(ci, /node scripts\/verify-external-health-release\.mjs "\$PRODUCTION_API_HEALTH_URL" "\$RELEASE_SOURCE_SHA"/);
  assert.match(ci, /LAUNCH_PROOF_MANIFEST_URI: \$\{\{ secrets\.LAUNCH_PROOF_MANIFEST_URI \}\}/);
  assert.match(ci, /PRODUCTION_POST_DEPLOY_PROOF_COMMAND/);
  assert.match(ci, /bash \/tmp\/lunchlineup-post-deploy-proof\.sh/);
});

test('release artifact verifier accepts pinned manifests and rejects mutable deploy inputs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-release-artifact-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const launchProofPath = join(scratch, 'launch-proof.json');
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const pinnedDockerfile = 'FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2\n';
  const pinnedCompose =
    'services:\n  postgres:\n    image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777\n';
  const pinnedWorkflow =
    'jobs:\n  integration:\n    services:\n      redis:\n        image: redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99\n';

  function writePolicyFixture(name, overrides = {}) {
    const fixtureRoot = join(scratch, name);
    const dockerfileDir = join(fixtureRoot, 'docker');
    const composePath = join(fixtureRoot, 'docker-compose.yml');
    const workflowPath = join(fixtureRoot, 'ci.yml');

    mkdirSync(dockerfileDir, { recursive: true });
    writeFileSync(join(dockerfileDir, 'Dockerfile.api'), overrides.dockerfile ?? pinnedDockerfile);
    writeFileSync(composePath, overrides.compose ?? pinnedCompose);
    writeFileSync(workflowPath, overrides.workflow ?? pinnedWorkflow);

    return { dockerfileDir, composePath, workflowPath };
  }

  function runVerifierWithPolicyFixture(fixture) {
    return spawnSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.mjs',
        manifestPath,
        '--source-sha',
        sourceSha,
        '--dockerfile-dir',
        fixture.dockerfileDir,
        '--compose-file',
        fixture.composePath,
        '--workflow-file',
        fixture.workflowPath,
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
  }

  try {
    writeFileSync(manifestPath, `${JSON.stringify(sampleReleaseManifest(sourceSha), null, 2)}\n`);
    writeFileSync(launchProofPath, `${JSON.stringify(sampleLaunchProof(sourceSha), null, 2)}\n`);

    const artifactOnlyOutput = execFileSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    assert.match(artifactOnlyOutput, /launch_proof=not_checked/);

    const validOutput = execFileSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.mjs',
        manifestPath,
        '--source-sha',
        sourceSha,
        '--launch-proof-file',
        launchProofPath,
        '--command-env',
        'STAGING_DEPLOY_COMMAND',
        '--command-env',
        'PRODUCTION_DEPLOY_COMMAND',
        '--post-deploy-proof-command-env',
        'PRODUCTION_POST_DEPLOY_PROOF_COMMAND',
        '--rollback-command-env',
        'PRODUCTION_ROLLBACK_COMMAND',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGING_DEPLOY_COMMAND: 'scripts/verify-deploy-source.sh "$RELEASE_SOURCE_SHA" && ./deploy-staging --manifest "$RELEASE_MANIFEST_PATH"',
          PRODUCTION_DEPLOY_COMMAND: 'scripts/verify-deploy-source.sh "$RELEASE_SOURCE_SHA" && test "$(sha256sum "$COMPOSE_SERVICE_ENV_FILE" | awk \'{print $1}\')" = "$PRODUCTION_RUNTIME_ENV_SHA256" && docker compose --env-file "$COMPOSE_SERVICE_ENV_FILE" up -d --no-build --pull never && ./deploy-production --manifest "$RELEASE_MANIFEST_PATH" --proof-sha "$LAUNCH_PROOF_ARTIFACT_SHA256" --proof-max-age "$LAUNCH_PROOF_MAX_AGE_SECONDS" --api-health "$PRODUCTION_API_HEALTH_URL" --web-url "$PRODUCTION_WEB_URL" --launch-proof-uri "$LAUNCH_PROOF_MANIFEST_URI"',
          PRODUCTION_POST_DEPLOY_PROOF_COMMAND: 'DEPLOYED_GIT_SHA="$(cat /opt/lunchlineup/DEPLOYED_GIT_SHA)" && test "$DEPLOYED_GIT_SHA" = "$RELEASE_SOURCE_SHA" && curl -fsS "$PRODUCTION_API_HEALTH_URL" -o /tmp/api-health.json && curl -fsS "$LAUNCH_PROOF_MANIFEST_URI" -o /tmp/launch-proof.json && test "$(sha256sum /tmp/launch-proof.json | awk \'{print $1}\')" = "$LAUNCH_PROOF_ARTIFACT_SHA256" && test "$LAUNCH_PROOF_MAX_AGE_SECONDS" -gt 0 && test "$(stat -c%s /tmp/launch-proof.json)" -gt 0',
          PRODUCTION_ROLLBACK_COMMAND: 'cd "$ROLLBACK_DEPLOYMENT_APP_DIR" && node scripts/verify-release-artifacts.mjs "$PREVIOUS_RELEASE_MANIFEST_PATH" --source-sha "$PREVIOUS_RELEASE_SOURCE_SHA" --post-deploy-proof-command-env PRODUCTION_POST_DEPLOY_PROOF_COMMAND && VM217_DEPLOY_OPERATION=rollback ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM="verified-compatible-with-current-schema:$PREVIOUS_RELEASE_SOURCE_SHA" ./deploy-production --manifest "$PREVIOUS_RELEASE_MANIFEST_PATH" --source-sha "$PREVIOUS_RELEASE_SOURCE_SHA" && bash /tmp/lunchlineup-post-deploy-proof.sh "$PRODUCTION_API_HEALTH_URL" "$LAUNCH_PROOF_MANIFEST_URI"',
        },
      },
    );

    assert.match(validOutput, /release_artifacts_ok/);
    assert.match(validOutput, /launch_proof=candidate/);

    const unsafeRemoteInputResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--command-env', 'PRODUCTION_DEPLOY_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCTION_DEPLOY_COMMAND: 'scripts/verify-deploy-source.sh "$RELEASE_SOURCE_SHA" && test "$(sha256sum "$COMPOSE_SERVICE_ENV_FILE" | awk \'{print $1}\')" = "$PRODUCTION_RUNTIME_ENV_SHA256" && docker compose --env-file "$COMPOSE_SERVICE_ENV_FILE" up -d --no-build --pull never && ./deploy-production --manifest "$RELEASE_MANIFEST_PATH" --proof-sha "$LAUNCH_PROOF_ARTIFACT_SHA256" --proof-max-age "$LAUNCH_PROOF_MAX_AGE_SECONDS" --api-health "$PRODUCTION_API_HEALTH_URL" --web-url $PRODUCTION_WEB_URL --launch-proof-uri "$LAUNCH_PROOF_MANIFEST_URI"',
        },
      },
    );
    assert.notEqual(unsafeRemoteInputResult.status, 0);
    assert.match(`${unsafeRemoteInputResult.stdout}\n${unsafeRemoteInputResult.stderr}`, /safely forward PRODUCTION_WEB_URL/);

    const mutableManifestPath = join(scratch, 'mutable-manifest.json');
    const mutableManifest = sampleReleaseManifest(sourceSha);
    mutableManifest.images.api.ref = `ghcr.io/tuckerplee/lunchlineup/api:latest@${mutableManifest.images.api.digest}`;
    writeFileSync(mutableManifestPath, `${JSON.stringify(mutableManifest, null, 2)}\n`);

    const mutableResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', mutableManifestPath, '--source-sha', sourceSha],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.notEqual(mutableResult.status, 0);
    assert.match(`${mutableResult.stdout}\n${mutableResult.stderr}`, /latest|sourceSha|pin/);

    const mutableCommandResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--command-env', 'STAGING_DEPLOY_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGING_DEPLOY_COMMAND: 'docker compose up -d --build',
        },
      },
    );
    assert.notEqual(mutableCommandResult.status, 0);
    assert.match(`${mutableCommandResult.stdout}\n${mutableCommandResult.stderr}`, /build|verify-deploy-source|RELEASE_MANIFEST_PATH/);

    const detachedShaCommandResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--command-env', 'STAGING_DEPLOY_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGING_DEPLOY_COMMAND: 'scripts/verify-deploy-source.sh && ./deploy-staging --manifest "$RELEASE_MANIFEST_PATH"',
        },
      },
    );
    assert.notEqual(detachedShaCommandResult.status, 0);
    assert.match(`${detachedShaCommandResult.stdout}\n${detachedShaCommandResult.stderr}`, /RELEASE_SOURCE_SHA/);

    const lateVerifierCommandResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--command-env', 'STAGING_DEPLOY_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGING_DEPLOY_COMMAND: './deploy-staging --manifest "$RELEASE_MANIFEST_PATH" && scripts/verify-deploy-source.sh "$RELEASE_SOURCE_SHA"',
        },
      },
    );
    assert.notEqual(lateVerifierCommandResult.status, 0);
    assert.match(`${lateVerifierCommandResult.stdout}\n${lateVerifierCommandResult.stderr}`, /must start with verify-deploy-source/);

    const missingRuntimeEnvCommandResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--command-env', 'PRODUCTION_DEPLOY_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCTION_DEPLOY_COMMAND: 'scripts/verify-deploy-source.sh "$RELEASE_SOURCE_SHA" && ./deploy-production --manifest "$RELEASE_MANIFEST_PATH"',
        },
      },
    );
    assert.notEqual(missingRuntimeEnvCommandResult.status, 0);
    assert.match(`${missingRuntimeEnvCommandResult.stdout}\n${missingRuntimeEnvCommandResult.stderr}`, /production runtime env|PRODUCTION_RUNTIME_ENV_SHA256/);

    const weakPostDeployProofCommandResult = spawnSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.mjs',
        manifestPath,
        '--source-sha',
        sourceSha,
        '--post-deploy-proof-command-env',
        'PRODUCTION_POST_DEPLOY_PROOF_COMMAND',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCTION_POST_DEPLOY_PROOF_COMMAND: 'curl -fsS "$PRODUCTION_API_HEALTH_URL"',
        },
      },
    );
    assert.notEqual(weakPostDeployProofCommandResult.status, 0);
    assert.match(`${weakPostDeployProofCommandResult.stdout}\n${weakPostDeployProofCommandResult.stderr}`, /DEPLOYED_GIT_SHA|LAUNCH_PROOF_MANIFEST_URI/);

    const weakRollbackCommandResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--rollback-command-env', 'PRODUCTION_ROLLBACK_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCTION_ROLLBACK_COMMAND: 'cd "$ROLLBACK_DEPLOYMENT_APP_DIR" && ./rollback-production --manifest "$PREVIOUS_RELEASE_MANIFEST_PATH"',
        },
      },
    );
    assert.notEqual(weakRollbackCommandResult.status, 0);
    assert.match(`${weakRollbackCommandResult.stdout}\n${weakRollbackCommandResult.stderr}`, /source SHA|post-deploy proof|health and proof/i);

    const unboundComposeEnvCommandResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--command-env', 'PRODUCTION_DEPLOY_COMMAND'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCTION_DEPLOY_COMMAND: 'scripts/verify-deploy-source.sh "$RELEASE_SOURCE_SHA" && docker compose up -d --no-build --pull never && echo "$RELEASE_MANIFEST_PATH $COMPOSE_SERVICE_ENV_FILE $PRODUCTION_RUNTIME_ENV_SHA256"',
        },
      },
    );
    assert.notEqual(unboundComposeEnvCommandResult.status, 0);
    assert.match(`${unboundComposeEnvCommandResult.stdout}\n${unboundComposeEnvCommandResult.stderr}`, /--env-file.*COMPOSE_SERVICE_ENV_FILE/);

    const mismatchedRuntimeEnvPath = join(scratch, 'mismatched-runtime.env');
    const mismatchedRuntimeEnv = publicBuildRuntimeEnv({ NEXT_PUBLIC_APP_URL: 'https://billing.lunchlineup.com' });
    writeFileSync(mismatchedRuntimeEnvPath, mismatchedRuntimeEnv);
    const mismatchedRuntimeEnvResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PRODUCTION_RUNTIME_ENV_PATH: mismatchedRuntimeEnvPath,
          COMPOSE_SERVICE_ENV_FILE: mismatchedRuntimeEnvPath,
          PRODUCTION_RUNTIME_ENV_SHA256: createHash('sha256').update(mismatchedRuntimeEnv).digest('hex'),
        },
      },
    );
    assert.notEqual(mismatchedRuntimeEnvResult.status, 0);
    assert.match(`${mismatchedRuntimeEnvResult.stdout}\n${mismatchedRuntimeEnvResult.stderr}`, /NEXT_PUBLIC_APP_URL must match/);

    const mutableDockerfileResult = runVerifierWithPolicyFixture(
      writePolicyFixture('mutable-dockerfile', { dockerfile: 'FROM node:22-alpine\n' }),
    );
    assert.notEqual(mutableDockerfileResult.status, 0);
    assert.match(`${mutableDockerfileResult.stdout}\n${mutableDockerfileResult.stderr}`, /Dockerfile\.api:1 base image.*sha256/);

    const mutableComposeResult = runVerifierWithPolicyFixture(
      writePolicyFixture('mutable-compose', { compose: 'services:\n  postgres:\n    image: postgres:16-alpine\n' }),
    );
    assert.notEqual(mutableComposeResult.status, 0);
    assert.match(`${mutableComposeResult.stdout}\n${mutableComposeResult.stderr}`, /postgres image.*sha256/);

    const mutableWorkflowResult = runVerifierWithPolicyFixture(
      writePolicyFixture('mutable-workflow', { workflow: 'jobs:\n  test:\n    services:\n      redis:\n        image: redis:7-alpine\n' }),
    );
    assert.notEqual(mutableWorkflowResult.status, 0);
    assert.match(`${mutableWorkflowResult.stdout}\n${mutableWorkflowResult.stderr}`, /CI service image.*sha256/);

    const skippedProofPath = join(scratch, 'skipped-launch-proof.json');
    const skippedProof = sampleLaunchProof(sourceSha);
    skippedProof.evidence.dast.status = 'skipped';
    writeFileSync(skippedProofPath, `${JSON.stringify(skippedProof, null, 2)}\n`);

    const skippedProofResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--launch-proof-file', skippedProofPath],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.notEqual(skippedProofResult.status, 0);
    assert.match(`${skippedProofResult.stdout}\n${skippedProofResult.stderr}`, /dast\.status must be ok or passed/);

    const checksumLightProofPath = join(scratch, 'checksum-light-launch-proof.json');
    const checksumLightProof = sampleLaunchProof(sourceSha);
    delete checksumLightProof.evidence.load.artifactSha256;
    writeFileSync(checksumLightProofPath, `${JSON.stringify(checksumLightProof, null, 2)}\n`);

    const checksumLightProofResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--launch-proof-file', checksumLightProofPath],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.notEqual(checksumLightProofResult.status, 0);
    assert.match(`${checksumLightProofResult.stdout}\n${checksumLightProofResult.stderr}`, /load\.artifactSha256 is required/);

    const futureProofPath = join(scratch, 'future-launch-proof.json');
    const futureProof = sampleLaunchProof(sourceSha);
    futureProof.evidence.alertRoute.checkedAt = new Date(Date.parse(futureProof.generatedAt) + 301_000).toISOString();
    writeFileSync(futureProofPath, `${JSON.stringify(futureProof, null, 2)}\n`);

    const futureProofResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--launch-proof-file', futureProofPath],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.notEqual(futureProofResult.status, 0);
    assert.match(`${futureProofResult.stdout}\n${futureProofResult.stderr}`, /alertRoute\.checkedAt must not be later than launchProof\.generatedAt/);

    const reusedUriProofPath = join(scratch, 'reused-uri-launch-proof.json');
    const reusedUriProof = sampleLaunchProof(sourceSha);
    reusedUriProof.evidence.load.uri = reusedUriProof.evidence.dast.uri;
    writeFileSync(reusedUriProofPath, `${JSON.stringify(reusedUriProof, null, 2)}\n`);

    const reusedUriProofResult = spawnSync(
      process.execPath,
      ['scripts/verify-release-artifacts.mjs', manifestPath, '--source-sha', sourceSha, '--launch-proof-file', reusedUriProofPath],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.notEqual(reusedUriProofResult.status, 0);
    assert.match(`${reusedUriProofResult.stdout}\n${reusedUriProofResult.stderr}`, /load\.uri must be unique/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('release manifest binds the production API health proof to public DOMAIN', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-health-proof-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const runtimePath = join(scratch, 'runtime.env');
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const run = (manifest, environment = {}) => {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return spawnSync(
      process.execPath,
      [
        'scripts/verify-release-artifacts.mjs',
        manifestPath,
        '--source-sha',
        sourceSha,
        '--production-api-health-url-env',
        'PRODUCTION_API_HEALTH_URL',
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, ...environment } },
    );
  };

  try {
    writeFileSync(
      runtimePath,
      `${publicBuildRuntimeEnv()}DOMAIN=lunchlineup.com\nPRODUCTION_API_HEALTH_URL=https://lunchlineup.com/api/health\n`,
    );
    const manifest = sampleReleaseManifest(sourceSha);
    const valid = run(manifest, {
      PRODUCTION_API_HEALTH_URL: 'https://lunchlineup.com/api/health',
      PRODUCTION_RUNTIME_ENV_PATH: runtimePath,
    });
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);

    for (const proof of [
      { domain: 'lunchlineup.com', url: 'http://lunchlineup.com/api/health' },
      { domain: 'lunchlineup.com', url: 'https://127.0.0.1/api/health' },
      { domain: 'lunchlineup.com', url: 'https://status.lunchlineup.com/api/health' },
      { domain: 'lunchlineup.com', url: 'https://lunchlineup.com/admin' },
    ]) {
      const rejected = run(
        { ...manifest, productionHealthProof: proof },
        { PRODUCTION_API_HEALTH_URL: proof.url },
      );
      assert.notEqual(rejected.status, 0, proof.url);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /productionHealthProof/);
    }

    const mismatch = run(manifest, { PRODUCTION_API_HEALTH_URL: 'https://lunchlineup.com/health' });
    assert.notEqual(mismatch.status, 0);
    assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /must exactly match productionHealthProof\.url/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Trivy release report verifier binds every digest-pinned image and blocks HIGH or CRITICAL findings', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-trivy-release-'));
  const manifestPath = join(scratch, 'release-manifest.json');
  const reportsDir = join(scratch, 'reports');
  const manifest = sampleReleaseManifest();
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = createHash('sha256').update(manifestText).digest('hex');

  function writeReport(service, vulnerabilities = []) {
    const reportFile = `${service}.trivy.json`;
    const reportText = `${JSON.stringify({
      SchemaVersion: 2,
      ArtifactName: manifest.images[service].ref,
      ArtifactType: 'container_image',
      Results: [{ Target: service, Class: 'os-pkgs', Type: 'alpine', Vulnerabilities: vulnerabilities }],
    }, null, 2)}\n`;
    writeFileSync(join(reportsDir, reportFile), reportText);
    writeFileSync(join(reportsDir, `${service}.trivy-evidence.json`), `${JSON.stringify({
      version: 1,
      scanner: 'trivy',
      sourceSha: manifest.sourceSha,
      service,
      imageRef: manifest.images[service].ref,
      imageDigest: manifest.images[service].digest,
      releaseManifestSha256: manifestSha256,
      reportFile,
      reportSha256: createHash('sha256').update(reportText).digest('hex'),
      severityGate: ['HIGH', 'CRITICAL'],
    }, null, 2)}\n`);
  }

  const run = () => spawnSync(
    process.execPath,
    ['scripts/verify-trivy-release-reports.mjs', manifestPath, reportsDir],
    { cwd: root, encoding: 'utf8' },
  );

  try {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(manifestPath, manifestText);
    for (const service of Object.keys(manifest.images)) writeReport(service);

    const valid = run();
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /services=api,web,engine,worker,migrate,control,backup/);

    const apiEvidencePath = join(reportsDir, 'api.trivy-evidence.json');
    const apiEvidence = JSON.parse(readFileSync(apiEvidencePath, 'utf8'));
    writeFileSync(apiEvidencePath, `${JSON.stringify({ ...apiEvidence, releaseManifestSha256: '0'.repeat(64) })}\n`);
    const detached = run();
    assert.notEqual(detached.status, 0);
    assert.match(detached.stderr, /releaseManifestSha256 does not match/);
    writeReport('api');

    writeReport('worker', [{ VulnerabilityID: 'CVE-2099-0001', Severity: 'HIGH' }]);
    const vulnerable = run();
    assert.notEqual(vulnerable.status, 0);
    assert.match(vulnerable.stderr, /CVE-2099-0001:HIGH/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('launch proof template includes hard-to-fake local evidence fields', () => {
  const template = JSON.parse(read('docs/testing/launch-proof-template.json'));

  assert.equal(template.version, 1);
  for (const key of ['runtimeEnv', 'dast', 'load', 'drDrill', 'alertRoute']) {
    const entry = template.evidence[key];
    assert.equal(entry.status, 'passed', key);
    assert.ok(entry.sourceSha, key);
    assert.ok(entry.uri, key);
    assert.ok(entry.checkedAt, key);
    assert.ok(entry.summary, key);
    assert.ok(entry.command, key);
    assert.equal(entry.exitCode, 0, key);
    assert.ok(entry.artifactSha256, key);
    assert.ok(entry.artifactBytes > 0, key);
  }

  assert.ok(template.evidence.drDrill.backupSha256);
  assert.ok(template.evidence.drDrill.sourceUri);
  assert.equal(Object.hasOwn(template.evidence, 'externalHealth'), false);
});

test('smoke environment generator writes the requested env and metrics token files', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-smoke-'));
  const envPath = join(scratch, '.env.smoke');
  const tokenPath = join(scratch, 'metrics_token');

  try {
    execFileSync(process.execPath, ['scripts/write-smoke-env.mjs', envPath, tokenPath], {
      cwd: root,
      encoding: 'utf8',
    });

    const env = parseEnv(readFileSync(envPath, 'utf8'));
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.DATA_TARGET_ENV, 'test');
    assert.equal(env.COMPOSE_SERVICE_ENV_FILE, envPath);
    assert.equal(env.DOMAIN, 'smoke.lunchlineup.test');
    assert.equal(env.METRICS_TOKEN_FILE, tokenPath);
    assert.match(readFileSync(tokenPath, 'utf8').trim(), /^metrics_[A-Za-z0-9_-]{32,}$/);

    for (const key of [
      'COMPOSE_SERVICE_ENV_FILE',
      'CADDY_SITE_ADDRESSES',
      'POSTGRES_PASSWORD',
      'APP_DB_USER',
      'APP_DB_PASSWORD',
      'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
      'DATABASE_URL',
      'MIGRATION_DATABASE_URL',
      'RABBITMQ_URL',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'SESSION_SECRET',
      'MFA_SECRET_ENCRYPTION_KEY_CURRENT',
      'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
      'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY',
      'CSRF_SECRET',
      'RESEND_API_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_METER_AGGREGATION',
      'PASSWORD_RESET_EMAIL_OUTBOX_ENABLED',
      'COOKIE_SECURE',
      'NEXT_PUBLIC_API_URL',
      'NEXT_PUBLIC_WS_URL',
      'INTERNAL_API_URL',
      'NEXT_PUBLIC_OIDC_ENABLED',
      'PUBLIC_SIGNUP_MODE',
      'NEXT_PUBLIC_SIGNUP_MODE',
      'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL',
      'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL',
      'NEXT_PUBLIC_DPA_CONTACT_EMAIL',
      'NEXT_PUBLIC_APP_ORIGIN',
      'NEXT_PUBLIC_APP_URL',
      'NEXT_PUBLIC_APP_ENV',
    ]) {
      assert.ok(env[key], `missing generated smoke env key: ${key}`);
    }

    assert.equal(env.POSTGRES_USER, 'lunchlineup_ci_admin');
    assert.equal(env.APP_DB_USER, 'lunchlineup_ci_app');
    assert.notEqual(env.APP_DB_PASSWORD, env.POSTGRES_PASSWORD);
    assert.equal(env.DATABASE_URL, `postgresql://lunchlineup_ci_app:${encodeURIComponent(env.APP_DB_PASSWORD)}@postgres:5432/lunchlineup_ci`);
    assert.equal(env.MIGRATION_DATABASE_URL, `postgresql://lunchlineup_ci_admin:${encodeURIComponent(env.POSTGRES_PASSWORD)}@postgres:5432/lunchlineup_ci`);
    assert.equal(env.RABBITMQ_URL, `amqp://lunchlineup_ci:${encodeURIComponent(env.RABBITMQ_PASSWORD)}@rabbitmq:5672`);
    assert.equal(env.STRIPE_METER_AGGREGATION, 'last');
    assert.equal(env.PASSWORD_RESET_EMAIL_OUTBOX_ENABLED, 'true');
    assert.match(env.POSTGRES_PASSWORD, /^pg_[A-Za-z0-9_-]{32,}:@\/\?\[\]%$/);
    assert.match(env.APP_DB_PASSWORD, /^app_pg_[A-Za-z0-9_-]{32,}:@\/\?\[\]%$/);
    assert.match(env.RABBITMQ_PASSWORD, /^mq_[A-Za-z0-9_-]{32,}:@\/\?\[\]%$/);
    assert.match(env.DATABASE_URL, /%3A%40%2F%3F%5B%5D%25@postgres/);
    assert.match(env.RABBITMQ_URL, /%3A%40%2F%3F%5B%5D%25@rabbitmq/);
    assert.match(env.JWT_SECRET, /^jwt_[A-Za-z0-9_-]{32,}$/);
    assert.equal(Buffer.from(env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT, 'base64').length, 32);
    assert.equal(Buffer.from(env.PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY, 'base64').length, 32);

    for (const value of Object.values(env)) {
      assert.doesNotMatch(value, /change_me|replace_me|guest:guest|password@postgres/i);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('smoke environment generator help is read-only', () => {
  const accidentalHelpPath = join(root, '--help');

  const output = execFileSync(process.execPath, ['scripts/write-smoke-env.mjs', '--help'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.match(output, /Usage: node scripts\/write-smoke-env\.mjs/);
  assert.equal(existsSync(accidentalHelpPath), false);
});

test('DAST and load helper scripts execute real smoke tools', () => {
  const dast = read('scripts/run-dast.sh');
  const load = read('scripts/load-test.sh');

  assert.match(dast, /zap-baseline\.py/);
  assert.match(dast, /ZAP_IMAGE/);
  assert.match(dast, /docker run --rm/);
  assert.doesNotMatch(dast, /DAST scan complete/);

  assert.match(load, /artillery@2 run "\$SCENARIO_PATH"/);
  assert.match(load, /scripts\/artillery-smoke\.yml/);
  assert.doesNotMatch(load, /# npx artillery/);
});

test('backup restore scripts are encrypted, atomic, telemetry-producing, and fail-closed', () => {
  const backup = read('scripts/backup.sh');
  const restore = read('scripts/restore.sh');
  const drill = read('scripts/dr-drill.sh');

  assert.match(backup, /BACKUP_ENCRYPTION_KEY_FILE/);
  assert.match(backup, /mktemp/);
  assert.match(backup, /mv "\$\{TMP_BACKUP_FILE\}" "\$\{BACKUP_FILE\}"/);
  assert.match(backup, /sha256sum "\$\{BACKUP_FILE\}"/);
  assert.match(backup, /--pinentry-mode loopback/);
  assert.match(backup, /--passphrase-fd 3/);
  assert.match(backup, /BACKUP_METRICS_FILE/);
  assert.match(backup, /lunchlineup_backup_last_success_timestamp_seconds/);
  assert.match(backup, /lunchlineup_backup_last_success_size_bytes/);
  assert.doesNotMatch(backup, /--passphrase "\$\{BACKUP_ENCRYPTION_KEY\}"/);

  assert.match(restore, /RESTORE_TARGET_ENV/);
  assert.match(restore, /RESTORE_ALLOW_PRODUCTION=YES_RESTORE_PRODUCTION/);
  assert.match(restore, /RESTORE_CONFIRM=restore-<POSTGRES_DB>/);
  assert.match(restore, /RESTORE_ALLOW_NONEMPTY=YES_OVERWRITE/);
  assert.match(restore, /information_schema\.tables/);
  assert.match(restore, /sha256sum -c/);
  assert.match(restore, /ON_ERROR_STOP=1/);
  assert.match(restore, /--single-transaction/);
  assert.match(restore, /Refusing vague restore target/);
  assert.doesNotMatch(restore, /read -p "Are you sure/);

  assert.match(drill, /\*\.sql\.zst\.gpg/);
  assert.match(drill, /docker run/);
  assert.match(drill, /docker exec[\s\S]*psql/);
  assert.match(drill, /DR_SANITY_SQL/);
  assert.match(drill, /trap cleanup EXIT/);
  assert.doesNotMatch(drill, /simplified logic|# zstd -d -c|# psql/);
});

test('Grafana dashboard exposes backup freshness and host filesystem pressure', () => {
  const dashboard = read('infrastructure/grafana/dashboards/platform-overview.json');
  const datasources = read('infrastructure/grafana/datasources/datasources.yml');

  assert.match(dashboard, /Backup Age/);
  assert.match(dashboard, /time\(\) - lunchlineup_backup_last_success_timestamp_seconds/);
  assert.match(dashboard, /Host Filesystem Free/);
  assert.match(dashboard, /node_filesystem_avail_bytes/);
  assert.match(dashboard, /"id": "tempo"/);
  assert.match(dashboard, /LunchLineup Platform Overview/);
  assert.match(datasources, /name: Prometheus[\s\S]*uid: prometheus/);
  assert.match(datasources, /name: Loki[\s\S]*uid: loki/);
  assert.match(datasources, /name: Tempo[\s\S]*uid: tempo/);
});

test('Prometheus alerts point at checked-in runbooks and cover backup freshness', () => {
  const alerts = read('infrastructure/prometheus/alerts/lunchlineup.yml');
  const alertNames = [...alerts.matchAll(/^\s*- alert:\s*([A-Za-z0-9_]+)/gm)].map((match) => match[1]);
  const runbookPaths = [...alerts.matchAll(/runbook:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(
    [...runbookPaths].sort(),
    runbookPaths.filter((path) => /^docs\/runbooks\/[^/]+\.md$/.test(path)).sort(),
  );
  assert.equal(runbookPaths.length, alertNames.length);

  for (const runbook of runbookPaths) {
    assert.equal(existsSync(join(root, runbook)), true, `${runbook} must exist`);
  }

  for (const expected of [
    'ServiceDown',
    'HighApiErrorRate',
    'HighApiLatency',
    'RabbitMQDependencyUnavailable',
    'WorkerJobFailures',
    'WebhookReplayNotReady',
    'WebhookReplayFailures',
    'SolverQueueBacklog',
    'SolverErrors',
    'DiskSpaceLow',
    'HostFilesystemTelemetryMissing',
    'BackupMissingTelemetry',
    'BackupStale',
    'RetentionPurgeTelemetryMissing',
    'RetentionPurgeStale',
    'RetentionPurgeFailed',
    'RetentionPurgeCandidatesReady',
  ]) {
    assert.ok(alertNames.includes(expected), `${expected} alert is required`);
  }

  assert.match(alerts, /lunchlineup_backup_last_success_timestamp_seconds/);
  assert.match(
    alerts,
    /RabbitMQDependencyUnavailable[\s\S]*lunchlineup_dependency_up\{job="api",dependency="rabbitmq"\}[\s\S]*absent\(lunchlineup_dependency_up/,
  );
  assert.match(alerts, /lunchlineup_retention_purge_last_attempt_timestamp_seconds/);
  assert.match(alerts, /docs\/runbooks\/data-retention-delete-export\.md/);
  assert.doesNotMatch(alerts, /github\.com\/org\/lunchlineup|runbook:\s*"https:\/\/github\.com\/org/i);
});

test('production runbooks use project-scoped Compose operations', () => {
  const runbookFiles = [
    'docs/runbooks/database-failover.md',
    'docs/runbooks/data-retention-delete-export.md',
    'docs/runbooks/deployment-rollback.md',
    'docs/runbooks/disposable-dev-server.md',
    'docs/runbooks/high-cpu.md',
    'docs/runbooks/high-error-rate.md',
    'docs/runbooks/production-readiness.md',
    'docs/runbooks/security-incident.md',
  ];
  const runbooks = runbookFiles.map((file) => read(file)).join('\n');
  const productionReadiness = read('docs/runbooks/production-readiness.md');
  const rollbackRunbook = read('docs/runbooks/deployment-rollback.md');

  assert.doesNotMatch(runbooks, /lunchlineup-(api|web|engine|worker|postgres|pgbouncer|proxy|control)\b/);
  assert.doesNotMatch(runbooks, /guest:guest|docker service update|generate-secrets\.sh/);
  assert.doesNotMatch(runbooks, /curl -fsS 'http:\/\/localhost:9090/);
  assert.doesNotMatch(rollbackRunbook, /^\s+docker compose pull/m);
  assert.doesNotMatch(rollbackRunbook, /^\s+docker compose up -d/m);
  assert.match(rollbackRunbook, /Do not run raw `docker compose pull`/);
  assert.match(rollbackRunbook, /PREVIOUS_RELEASE_MANIFEST_PATH/);
  assert.match(rollbackRunbook, /PREVIOUS_RELEASE_SOURCE_SHA/);
  assert.match(rollbackRunbook, /PRODUCTION_POST_DEPLOY_PROOF_COMMAND/);
  assert.match(rollbackRunbook, /post-deploy proof JSON/);
  assert.match(runbooks, /docker compose exec prometheus/);
  assert.match(runbooks, /verify-deploy-source/);
  assert.match(runbooks, /DEPLOYED_GIT_SHA/);
  assert.match(runbooks, /BACKUP_ENCRYPTION_KEY/);
  assert.match(runbooks, /backup_metrics_collector/);
  assert.match(runbooks, /PRODUCTION_RUNTIME_SECRET_REFERENCE/);
  assert.match(runbooks, /PRODUCTION_RUNTIME_SECRET_VERSION/);
  assert.match(runbooks, /LAUNCH_PROOF_MANIFEST_URI/);
  assert.match(runbooks, /validate-production-launch\.mjs/);
  assert.match(runbooks, /--launch-proof-file \.release\/launch-proof\.json/);
  assert.match(runbooks, /launch_proof=not_checked/);
  assert.match(runbooks, /invoke-retained-record-purge\.mjs/);
  assert.match(runbooks, /RETENTION_PURGE_METRICS_FILE/);
  assert.doesNotMatch(productionReadiness, /RETENTION_PURGE|invoke-retained-record-purge|RetentionPurge/);
});
