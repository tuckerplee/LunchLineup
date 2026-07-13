import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OBSERVABILITY_FILES,
  OBSERVABILITY_TOOL_IMAGES,
  buildObservabilityToolCommands,
  validateObservabilityConfigs,
  validateObservabilityTools,
} from '../../scripts/verify-observability-configs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifierPath = join(root, 'scripts/verify-observability-configs.mjs');
const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';

function copyFixtureFile(fixtureRoot, relativePath) {
  const target = join(fixtureRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, relativePath), target);
}

function createObservabilityFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-observability-'));

  for (const relativePath of Object.values(OBSERVABILITY_FILES)) {
    copyFixtureFile(fixtureRoot, relativePath);
  }

  cpSync(join(root, 'docs/runbooks'), join(fixtureRoot, 'docs/runbooks'), { recursive: true });
  return fixtureRoot;
}

function replaceInFixture(fixtureRoot, relativePath, search, replacement) {
  const target = join(fixtureRoot, relativePath);
  const original = readFileSync(target, 'utf8');
  assert.ok(original.includes(search), `${relativePath} fixture must include ${search}`);
  writeFileSync(target, original.replace(search, replacement));
}

test('observability verifier accepts the checked-in configs', () => {
  const result = validateObservabilityConfigs({ root });

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.checked, Object.values(OBSERVABILITY_FILES).sort());
});

test('application logs and traces have private, deploy-gated observability paths', () => {
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  const deploy = readFileSync(join(root, 'scripts/deploy-vm217-remote.sh'), 'utf8');
  const collector = readFileSync(join(root, 'infrastructure/otel-collector/otel-collector-config.yml'), 'utf8');
  const promtail = readFileSync(join(root, 'infrastructure/promtail/promtail-config.yml'), 'utf8');

  assert.match(compose, /otel-collector:[\s\S]*?networks:\s*\n\s*- telemetry\s*\n\s*- management/);
  assert.match(compose, /tempo:[\s\S]*?networks:\s*\n\s*- management/);
  assert.match(compose, /promtail:[\s\S]*?\/var\/lib\/docker\/containers:\/var\/lib\/docker\/containers:ro/);
  assert.doesNotMatch(compose, /promtail:[\s\S]*?\/var\/run\/docker\.sock/);
  assert.match(collector, /endpoint: http:\/\/tempo:4318/);
  assert.match(promtail, /url: http:\/\/loki:3100\/loki\/api\/v1\/push/);
  for (const service of ['api', 'engine', 'worker']) {
    const block = compose.match(new RegExp(`^  ${service}:\\r?\\n[\\s\\S]*?(?=^  [a-zA-Z0-9_-]+:\\r?$)`, 'm'))?.[0] ?? '';
    assert.match(block, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http:\/\/otel-collector:4318\/v1\/traces/);
    assert.match(block, /telemetry/);
  }
  assert.match(deploy, /local services=\([^)]*promtail otel-collector tempo grafana\)/);
});

test('PITR alerts cover missing and stale base backups plus WAL failure and staleness', () => {
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const runbook = readFileSync(join(root, 'docs/runbooks/postgres-pitr-recovery.md'), 'utf8');

  for (const alert of ['PitrBaseBackupTelemetryMissing', 'PitrBaseBackupStale', 'PitrWalArchiveFailure', 'PitrWalArchiveStale']) {
    assert.match(alerts, new RegExp(`alert: ${alert}[\\s\\S]*runbook: "docs/runbooks/postgres-pitr-recovery\\.md"`));
    assert.match(runbook, new RegExp(alert));
  }
  assert.match(alerts, /absent\(lunchlineup_pitr_base_backup_last_success_timestamp_seconds\)/);
  assert.match(alerts, /last_failure_timestamp_seconds > lunchlineup_pitr_wal_archive_last_success_timestamp_seconds/);
  assert.match(alerts, /absent\(lunchlineup_pitr_wal_archive_last_success_timestamp_seconds\)/);
});

test('public web paging probe is external, bounded, release-aware, and fail-closed', () => {
  const script = readFileSync(join(root, OBSERVABILITY_FILES.publicWebProbe), 'utf8');
  const service = readFileSync(join(root, OBSERVABILITY_FILES.publicWebProbeService), 'utf8');
  const timer = readFileSync(join(root, OBSERVABILITY_FILES.publicWebProbeTimer), 'utf8');
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const runbook = readFileSync(join(root, 'docs/runbooks/public-web-unavailable.md'), 'utf8');

  assert.match(script, /--proto '=https'/);
  assert.match(script, /--connect-timeout "\$PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS"/);
  assert.match(script, /--max-time "\$PUBLIC_WEB_PROBE_MAX_TIME_SECONDS"/);
  assert.match(script, /--max-filesize "\$PUBLIC_WEB_PROBE_MAX_BYTES"/);
  assert.match(script, /--max-redirs 0/);
  assert.match(script, /--resolve "\$validated_host:443:\$validated_ip"/);
  assert.match(script, /socket\.getaddrinfo\(host, 443/);
  assert.match(script, /any\(not address\.is_global for address in addresses\)/);
  assert.match(script, /X-LunchLineUp-Release/);
  assert.match(script, /DEPLOYED_GIT_SHA/);
  assert.match(script, /mv "\$metrics_tmp" "\$PUBLIC_WEB_PROBE_METRICS_FILE"/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /TimeoutStartSec=25s/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/node_exporter\/textfile_collector/);
  assert.match(timer, /OnUnitActiveSec=60s/);
  assert.match(alerts, /alert: PublicWebUnavailable[\s\S]*lunchlineup_public_web_probe_success\{job="node"\} == 0/);
  assert.match(alerts, /alert: PublicWebProbeStale[\s\S]*absent\(lunchlineup_public_web_probe_last_attempt_timestamp_seconds/);
  assert.match(runbook, /Caddy `502`/);
  assert.match(runbook, /Do not write `DEPLOYED_GIT_SHA` manually/);
});

test('public web probe publishes a failed metric for a Caddy 502 response', { skip: !existsSync(bashPath) }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-public-probe-'));
  const curlStub = join(scratch, 'curl-stub.sh');
  const metricsPath = join(scratch, 'lunchlineup_public_web.prom');
  const releasePath = join(scratch, 'DEPLOYED_GIT_SHA');
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const shellPath = (path) => path.replaceAll('\\', '/');
  const pythonPath = process.platform === 'win32' ? 'C:/Python314/python.exe' : '/usr/bin/python3';

  writeFileSync(releasePath, `${sourceSha}\n`);
  writeFileSync(curlStub, `#!/usr/bin/env bash
while (( $# > 0 )); do
  case "$1" in
    --dump-header) headers="$2"; shift 2 ;;
    --output) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'HTTP/1.1 502 Bad Gateway\\r\\nContent-Type: text/html\\r\\nX-LunchLineUp-Release: ${sourceSha}\\r\\n\\r\\n' > "$headers"
printf '<h1>Bad gateway</h1>' > "$body"
printf '502 0.010'
`);
  chmodSync(curlStub, 0o755);

  try {
    const result = spawnSync(bashPath, [join(root, OBSERVABILITY_FILES.publicWebProbe)], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PUBLIC_WEB_PROBE_URL: 'https://93.184.216.34/',
        PUBLIC_WEB_PROBE_METRICS_FILE: shellPath(metricsPath),
        PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE: shellPath(releasePath),
        PUBLIC_WEB_PROBE_CURL_BIN: shellPath(curlStub),
        PUBLIC_WEB_PROBE_PYTHON_BIN: pythonPath,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public edge returned HTTP 502/);
    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /^lunchlineup_public_web_probe_success 0$/m);
    assert.match(metrics, /^lunchlineup_public_web_probe_http_status 502$/m);
    assert.match(metrics, /^lunchlineup_public_web_probe_last_attempt_timestamp_seconds [1-9][0-9]+$/m);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('observability verifier CLI runs locally without Docker or config binaries', () => {
  const verifierSource = readFileSync(verifierPath, 'utf8');
  const result = spawnSync(process.execPath, [verifierPath, '--root', root], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /observability config validation passed/);
  assert.doesNotMatch(result.stdout, /docker run|promtool|amtool|caddy validate/);
  assert.match(verifierSource, /--tool-mode off\|auto\|host\|container/);
});

test('observability verifier exposes digest-pinned container fallback commands', () => {
  const commands = buildObservabilityToolCommands({ root });
  const byId = new Map(commands.map((command) => [command.id, command]));

  assert.deepEqual([...byId.keys()].sort(), [
    'alertmanager-config',
    'caddy-config',
    'caddy-template',
    'prometheus-config',
    'prometheus-rules',
  ].sort());

  for (const image of Object.values(OBSERVABILITY_TOOL_IMAGES)) {
    assert.match(image, /^[^\s]+:[^:@\s]+@sha256:[a-f0-9]{64}$/i);
  }

  for (const command of commands) {
    assert.equal(command.containerCommand.command, 'docker');
    assert.deepEqual(command.containerCommand.args.slice(0, 2), ['run', '--rm']);
    assert.ok(
      command.containerCommand.args.some((arg) => Object.values(OBSERVABILITY_TOOL_IMAGES).includes(arg)),
      `${command.id} must use a pinned tool container image`,
    );
  }

  assert.equal(byId.get('caddy-config').hostCommand.command, 'caddy');
  assert.equal(byId.get('prometheus-config').hostCommand.command, 'promtool');
  assert.equal(byId.get('prometheus-rules').hostCommand.command, 'promtool');
  assert.equal(byId.get('alertmanager-config').hostCommand.command, 'amtool');
});

test('observability tool auto mode reports pinned Docker fallbacks when host tools are unavailable', () => {
  const result = spawnSync(process.execPath, [verifierPath, '--root', root, '--tool-mode', 'auto'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '',
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /observability tool validation completed in auto mode/);
  assert.match(result.stdout, /caddy-config skipped: caddy was not found on PATH; fallback: docker run --rm/);
  assert.match(result.stdout, /prometheus-config skipped: promtool was not found on PATH; fallback: docker run --rm/);
  assert.match(result.stdout, /alertmanager-config skipped: amtool was not found on PATH; fallback: docker run --rm/);
  for (const image of Object.values(OBSERVABILITY_TOOL_IMAGES)) {
    assert.ok(result.stdout.includes(image), `${image} fallback must be printed`);
  }
});

test('observability host mode fails closed when required host tools are unavailable', () => {
  const result = spawnSync(process.execPath, [verifierPath, '--root', root, '--tool-mode', 'host'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /observability tool validation failed/);
  assert.match(result.stderr, /caddy is required for --tool-mode host/);
  assert.match(result.stderr, /promtool is required for --tool-mode host/);
  assert.match(result.stderr, /amtool is required for --tool-mode host/);
  assert.match(result.stderr, /fallback: docker run --rm/);
});

test('observability tool validation can execute host or container contracts through an injected runner', () => {
  const hostCalls = [];
  const successfulRunner = (command, args) => {
    hostCalls.push([command, args]);
    return { status: 0, stdout: 'ok\n', stderr: '' };
  };
  const hostResult = validateObservabilityTools({ root, mode: 'auto', runner: successfulRunner });

  assert.equal(hostResult.ok, true, hostResult.errors.join('\n'));
  assert.equal(hostResult.skipped.length, 0);
  assert.ok(hostCalls.some(([command, args]) => command === 'caddy' && args[0] === 'validate'));
  assert.ok(hostCalls.some(([command, args]) => command === 'promtool' && args[0] === 'check' && args[1] === 'config'));
  assert.ok(hostCalls.some(([command, args]) => command === 'promtool' && args[0] === 'check' && args[1] === 'rules'));
  assert.ok(hostCalls.some(([command, args]) => command === 'amtool' && args[0] === 'check-config'));

  const containerCalls = [];
  const containerResult = validateObservabilityTools({
    root,
    mode: 'container',
    runner: (command, args) => {
      containerCalls.push([command, args]);
      return { status: 0, stdout: 'ok\n', stderr: '' };
    },
  });

  assert.equal(containerResult.ok, true, containerResult.errors.join('\n'));
  assert.equal(containerCalls.length, buildObservabilityToolCommands({ root }).length);
  assert.ok(containerCalls.every(([command]) => command === 'docker'));
});

test('observability verifier rejects broken structured config fixtures', () => {
  const fixtureRoot = createObservabilityFixture();

  try {
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.prometheus,
      "targets: ['api:3000']",
      "targets: ['lunchlineup-api:3000']",
    );
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.alertmanager,
      'url_file: /run/secrets/alertmanager_webhook_url',
      'url: https://hooks.example.test/alertmanager',
    );
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.caddy,
      'reverse_proxy engine:8000',
      'reverse_proxy api:3000',
    );
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.prometheusAlerts,
      'runbook: "docs/runbooks/high-error-rate.md"',
      'runbook: "docs/runbooks/missing.md"',
    );
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.publicWebProbeService,
      'TimeoutStartSec=25s',
      'TimeoutStartSec=0',
    );

    const result = validateObservabilityConfigs({ root: fixtureRoot });
    const errors = result.errors.join('\n');

    assert.equal(result.ok, false);
    assert.match(errors, /api scrape targets must be api:3000/);
    assert.match(errors, /target lunchlineup-api:3000 must resolve to a Compose service/);
    assert.match(errors, /\/ws\/\* must reverse_proxy engine:8000/);
    assert.match(errors, /webhook URL must not be checked in as plaintext/);
    assert.match(errors, /webhook must read \/run\/secrets\/alertmanager_webhook_url/);
    assert.match(errors, /runbook docs\/runbooks\/missing\.md must exist/);
    assert.match(errors, /lunchlineup-public-web-probe\.service: missing TimeoutStartSec=25s/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
