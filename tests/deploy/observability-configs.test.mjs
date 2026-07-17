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
  PROMETHEUS_RULE_TEST_FILES,
  PROMETHEUS_VALIDATION_CREDENTIALS_FILE,
  buildObservabilityToolCommands,
  validateObservabilityConfigs,
} from '../../scripts/verify-observability-configs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifierPath = join(root, 'scripts/verify-observability-configs.mjs');
const bashPath = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const dockerAvailable = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8',
  timeout: 15_000,
  windowsHide: true,
}).status === 0;

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
test('observability verifier permits only the exact Alertmanager loopback publication', () => {
  for (const mapping of [
    '0.0.0.0:9093:9093',
    '192.0.2.10:9093:9093',
    '127.0.0.1:9094:9093',
    '127.0.0.1:9093:9094',
    '9093:9093',
    '[::1]:9093:9093',
  ]) {
    const fixtureRoot = createObservabilityFixture();
    try {
      replaceInFixture(
        fixtureRoot,
        OBSERVABILITY_FILES.compose,
        '127.0.0.1:9093:9093',
        mapping,
      );

      const result = validateObservabilityConfigs({ root: fixtureRoot });
      assert.equal(result.ok, false, `${mapping} must be rejected`);
      assert.match(
        result.errors.join('\n'),
        /alertmanager must publish only exact 127\.0\.0\.1:9093:9093/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test('Grafana dashboard uses stable panel and query references', () => {
  const dashboard = JSON.parse(readFileSync(join(root, 'infrastructure/grafana/dashboards/platform-overview.json'), 'utf8'));
  const datasourceUids = new Set(['prometheus', 'loki', 'tempo']);
  const panelIds = dashboard.panels.map((panel) => panel.id);

  assert.ok(panelIds.every((id) => Number.isInteger(id) && id > 0));
  assert.equal(new Set(panelIds).size, panelIds.length, 'panel IDs must be unique');

  for (const panel of dashboard.panels) {
    assert.ok(datasourceUids.has(panel.datasource?.uid), `${panel.title} uses an unknown datasource UID`);
    const refIds = (panel.targets ?? []).map((target) => target.refId);
    assert.ok(refIds.length > 0, `${panel.title} must define at least one query target`);
    assert.ok(refIds.every((refId) => typeof refId === 'string' && /^[A-Z]$/.test(refId)), `${panel.title} has an invalid query refId`);
    assert.equal(new Set(refIds).size, refIds.length, `${panel.title} query refIds must be unique`);
  }
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

test('isolated PDF parser runtime loss is healthchecked, alerted, and dashboarded', () => {
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const dashboard = JSON.parse(readFileSync(join(root, 'infrastructure/grafana/dashboards/platform-overview.json'), 'utf8'));
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  const worker = readFileSync(join(root, 'apps/worker/src/parser_health.py'), 'utf8');

  assert.match(compose, /lunchlineup_pdf_parser_ready 1/);
  assert.match(worker, /lunchlineup_pdf_parser_ready/);
  assert.match(worker, /lunchlineup_pdf_parser_health_probe_failures_total/);
  assert.match(alerts, /alert: PdfParserUnavailable[\s\S]*lunchlineup_pdf_parser_ready\{job="worker"\} == 0[\s\S]*for: 2m/);
  assert.match(alerts, /alert: PdfParserReadinessMissing[\s\S]*absent\(lunchlineup_pdf_parser_ready\{job="worker"\}\)[\s\S]*for: 2m/);
  assert.ok(dashboard.panels.some((panel) =>
    panel.title === 'Availability PDF Parser Readiness'
      && panel.targets?.some((target) => target.expr === 'min(lunchlineup_pdf_parser_ready{job="worker"})'),
  ));
});

test('password-reset delivery has dead-letter, systemic provider, and stale-sweep alerts', () => {
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const runbook = readFileSync(join(root, 'docs/runbooks/outbound-delivery.md'), 'utf8');

  for (const alert of ['PasswordResetEmailDeadLetters', 'PasswordResetEmailProviderOutage', 'PasswordResetEmailSweepStale']) {
    assert.match(alerts, new RegExp(`alert: ${alert}[\\s\\S]*runbook: "docs/runbooks/outbound-delivery\\.md"`));
    assert.match(runbook, new RegExp(alert));
  }
  assert.match(alerts, /lunchlineup_password_reset_email_systemic_provider_failure\{job="worker"\} == 1/);
  assert.match(alerts, /time\(\) - lunchlineup_password_reset_email_sweep_last_success_unixtime/);
  assert.match(alerts, /increase\(lunchlineup_password_reset_email_total\{job="worker",status="dead_lettered"\}\[15m\]\)/);
});

test('staff invitation delivery has alerts, runbook coverage, and Grafana panels', () => {
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const runbook = readFileSync(join(root, 'docs/runbooks/outbound-delivery.md'), 'utf8');
  const dashboard = JSON.parse(readFileSync(
    join(root, 'infrastructure/grafana/dashboards/platform-overview.json'),
    'utf8',
  ));

  for (const alert of [
    'StaffInvitationDeadLetters',
    'StaffInvitationProviderOutage',
    'StaffInvitationSweepNotReady',
    'StaffInvitationSweepStale',
  ]) {
    const offset = alerts.indexOf('alert: ' + alert);
    assert.notEqual(offset, -1, alert + ' must be configured');
    assert.ok(
      alerts.slice(offset, offset + 900).includes('runbook: "docs/runbooks/outbound-delivery.md"'),
      alert + ' must use the outbound-delivery runbook',
    );
    assert.ok(runbook.includes(alert), alert + ' must be documented');
  }
  assert.ok(alerts.includes('increase(lunchlineup_staff_invitation_outbox_total{job="worker",status="dead_lettered"}[15m])'));
  assert.ok(alerts.includes('lunchlineup_staff_invitation_systemic_provider_failure{job="worker"} == 1'));
  assert.ok(alerts.includes('lunchlineup_staff_invitation_sweep_ready{job="worker"} == 0'));
  assert.ok(alerts.includes('time() - lunchlineup_staff_invitation_sweep_last_success_unixtime'));
  assert.ok(alerts.includes('lunchlineup_staff_invitation_sweep_max_staleness_seconds{job="worker"}'));

  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  assert.equal(
    panels.get('Staff Invitation Dead Letters')?.targets?.[0]?.expr,
    'sum(increase(lunchlineup_staff_invitation_outbox_total{job="worker",status="dead_lettered"}[15m]))',
  );
  assert.equal(
    panels.get('Staff Invitation Provider Failure')?.targets?.[0]?.expr,
    'max(lunchlineup_staff_invitation_systemic_provider_failure{job="worker"})',
  );
  assert.equal(
    panels.get('Staff Invitation Sweep Age')?.targets?.[0]?.expr,
    'time() - max(lunchlineup_staff_invitation_sweep_last_success_unixtime{job="worker"})',
  );
  assert.equal(
    panels.get('Staff Invitation Sweep Ready')?.targets?.[0]?.expr,
    'min(lunchlineup_staff_invitation_sweep_ready{job="worker"}) * ((time() - max(lunchlineup_staff_invitation_sweep_last_success_unixtime{job="worker"})) <= bool max(lunchlineup_staff_invitation_sweep_max_staleness_seconds{job="worker"}))',
  );
  assert.deepEqual(
    panels.get('Staff Invitation Backlog')?.targets?.map((target) => target.expr),
    [
      'max(lunchlineup_staff_invitation_due{job="worker"})',
      'max(lunchlineup_staff_invitation_expired_leases{job="worker"})',
      'max(lunchlineup_staff_invitation_recent_provider_failures{job="worker"})',
    ],
  );
});
test('dead-letter paging is recent and rule fixtures prove fire then recovery', () => {
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const ruleTests = readFileSync(join(root, 'infrastructure/prometheus/alerts/tests/lunchlineup.test.yml'), 'utf8');

  for (const [alertName, metric] of [
    ['PasswordResetEmailDeadLetters', 'lunchlineup_password_reset_email_total'],
    ['StaffInvitationDeadLetters', 'lunchlineup_staff_invitation_outbox_total'],
    ['NotificationOutboxDeadLetters', 'lunchlineup_notification_outbox_total'],
  ]) {
    assert.match(alerts, new RegExp(`alert: ${alertName}[\\s\\S]*increase\\(${metric}[\\s\\S]*\\[15m\\]`));
    assert.match(ruleTests, new RegExp(`eval_time: 5m\\n\\s*alertname: ${alertName}[\\s\\S]*eval_time: 18m\\n\\s*alertname: ${alertName}`));
  }
  assert.doesNotMatch(alerts, /DeadLetters[\s\S]{0,120}_dead_lettered[^\n]*> 0/);
});

test('solver queue telemetry is worker-owned and one poison item remains alertable', () => {
  const worker = readFileSync(join(root, 'apps/worker/main.py'), 'utf8');
  const admin = readFileSync(join(root, 'apps/api/src/admin/admin.controller.ts'), 'utf8');
  const apiMetrics = readFileSync(join(root, 'apps/api/src/common/metrics.service.ts'), 'utf8');
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const ruleTests = readFileSync(join(root, 'infrastructure/prometheus/alerts/tests/lunchlineup.test.yml'), 'utf8');

  for (const state of ['ready', 'retry', 'dead_letter']) {
    assert.match(worker, new RegExp(`SOLVER_QUEUE_MESSAGES\\.labels\\(state="${state}"\\)`));
    assert.match(admin, new RegExp(`'lunchlineup_solver_queue_messages',\\s*'${state}'`));
  }
  assert.match(worker, /lunchlineup_solver_queue_telemetry_available/);
  assert.match(worker, /lunchlineup_solver_terminal_transitions_total/);
  assert.doesNotMatch(apiMetrics, /lunchlineup_solver_queue_depth/);
  assert.match(alerts, /alert: SolverQueuePoisoned[\s\S]*state="dead_letter"[\s\S]*lunchlineup_solver_terminal_transitions_total/);
  assert.match(ruleTests, /one durable solver poison item fires from DLQ depth[\s\S]*alertname: SolverQueuePoisoned/);
  assert.match(ruleTests, /solver terminal transition fires after immediate DLQ drain then recovers[\s\S]*alertname: SolverQueuePoisoned/);
});

test('automatic application-data execution has independent missing and 26-hour stale alerts', () => {
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.prometheusAlerts), 'utf8');
  const ruleTests = readFileSync(join(root, 'infrastructure/prometheus/alerts/tests/lunchlineup.test.yml'), 'utf8');
  const dashboard = JSON.parse(readFileSync(
    join(root, 'infrastructure/grafana/dashboards/platform-overview.json'),
    'utf8',
  ));

  assert.match(alerts, /alert: ApplicationDataRetentionExecutionTelemetryMissing[\s\S]*absent\(lunchlineup_retention_purge_last_attempt_timestamp_seconds\{mode="execute",stage="application_data"\}\)/);
  assert.match(alerts, /alert: ApplicationDataRetentionExecutionStale[\s\S]*\{mode="execute",stage="application_data"\} > 93600/);
  assert.match(ruleTests, /retained-record dry run cannot satisfy application-data execution telemetry/);
  assert.match(ruleTests, /application-data execution older than 26 hours is stale/);
  assert.ok(dashboard.panels.some((panel) =>
    panel.title === 'Application Data Retention Execution Age'
      && panel.targets?.some((target) => target.expr.includes('mode="execute",stage="application_data"')),
  ));
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
    'prometheus-rule-tests',
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
  assert.equal(byId.get('prometheus-rule-tests').hostCommand.command, 'promtool');
  assert.equal(byId.get('alertmanager-config').hostCommand.command, 'amtool');

  for (const id of ['prometheus-config', 'prometheus-rules', 'prometheus-rule-tests']) {
    const args = byId.get(id).containerCommand.args;
    const entrypointIndex = args.indexOf('--entrypoint');
    assert.notEqual(entrypointIndex, -1, `${id} must override the Prometheus server entrypoint`);
    assert.equal(args[entrypointIndex + 1], '/bin/promtool');
  }

  const configArgs = byId.get('prometheus-config').containerCommand.args;
  assert.ok(configArgs.includes(
    `${join(root, PROMETHEUS_VALIDATION_CREDENTIALS_FILE)}:/run/secrets/metrics_token:ro`,
  ));
  const ruleTestArgs = byId.get('prometheus-rule-tests').containerCommand.args;
  const prometheusImageIndex = ruleTestArgs.indexOf(OBSERVABILITY_TOOL_IMAGES.prometheus);
  assert.deepEqual(ruleTestArgs.slice(prometheusImageIndex + 1), [
    'test',
    'rules',
    ...PROMETHEUS_RULE_TEST_FILES.map((relativePath) => relativePath.split('/').at(-1)),
  ]);
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

test('observability container mode runs the real pinned config and rule validators', {
  skip: !dockerAvailable,
  timeout: 240_000,
}, () => {
  const result = spawnSync(process.execPath, [
    verifierPath,
    '--root',
    root,
    '--tool-mode',
    'container',
  ], {
    encoding: 'utf8',
    timeout: 210_000,
    windowsHide: true,
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /prometheus-config: docker run --rm/);
  assert.match(result.stdout, /prometheus-rules: docker run --rm/);
  assert.match(result.stdout, /prometheus-rule-tests: docker run --rm/);
  assert.match(result.stdout, /\/bin\/promtool/);
  for (const relativePath of PROMETHEUS_RULE_TEST_FILES) {
    assert.ok(result.stdout.includes(relativePath.split('/').at(-1)));
  }
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
      'reverse_proxy web:3000',
      'reverse_proxy engine:8000',
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
    assert.match(errors, /default must reverse_proxy web:3000/);
    assert.match(errors, /webhook URL must not be checked in as plaintext/);
    assert.match(errors, /webhook must read \/run\/secrets\/alertmanager_webhook_url/);
    assert.match(errors, /runbook docs\/runbooks\/missing\.md must exist/);
    assert.match(errors, /lunchlineup-public-web-probe\.service: missing TimeoutStartSec=25s/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
