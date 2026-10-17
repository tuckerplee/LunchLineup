import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  METRICS_GATEWAY_SERVICES,
  OBSERVABILITY_FILES,
  OBSERVABILITY_TOOL_IMAGES,
  PROMETHEUS_RULE_TEST_FILES,
  REMOVED_SERVICES,
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
const read = (path) => readFileSync(join(root, path), 'utf8');

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

test('Compose contains no in-stack alerting, metrics storage, dashboards, logging, tracing or backup services', () => {
  const compose = read('docker-compose.yml');

  for (const service of REMOVED_SERVICES) {
    assert.doesNotMatch(compose, new RegExp(`^  ${service}:`, 'm'), `${service} must not be a Compose service`);
  }
  for (const needle of [
    'alertmanager', 'prometheus', 'grafana', 'loki', 'promtail', 'tempo', 'otel-collector',
    'node-exporter', 'pitr', 'PITR_', 'BACKUP_', 'OTEL_', 'GRAFANA_', 'ALERTMANAGER_', 'backup_key',
    'archive-wal',
  ]) {
    assert.ok(!compose.includes(needle), `docker-compose.yml must not mention ${needle}`);
  }
  assert.doesNotMatch(compose, /^  telemetry:|^  alertmanager-egress:|^  pitr-egress:|^  pitr-wal-control:/m);
  assert.match(compose, /archive_mode=\$\{POSTGRES_ARCHIVE_MODE:-off\}/);
  assert.match(compose, /archive_command=\$\{POSTGRES_ARCHIVE_COMMAND:-\/bin\/false\}/);
});

test('observability verifier rejects a reintroduced estate component', () => {
  for (const [search, replacement, message] of [
    ['  autoheal:\n', '  grafana:\n    image: grafana/grafana:latest\n  autoheal:\n', /grafana is an estate system/],
    ['  parser_ipc:\n', '  loki_data:\n  parser_ipc:\n', /volume loki_data belongs to a removed component/],
    ['  metrics_token:\n', '  alertmanager_webhook_url:\n    file: ./x\n  metrics_token:\n', /secret alertmanager_webhook_url belongs to a removed component/],
  ]) {
    const fixtureRoot = createObservabilityFixture();
    try {
      replaceInFixture(fixtureRoot, OBSERVABILITY_FILES.compose, search, replacement);
      const result = validateObservabilityConfigs({ root: fixtureRoot });
      assert.equal(result.ok, false, search);
      assert.match(result.errors.join('\n'), message);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test('the metrics gateway is private, token-protected and reachable for the estate scraper', () => {
  const pilot = read(OBSERVABILITY_FILES.caddyPilot);
  const production = read(OBSERVABILITY_FILES.caddyProduction);
  const privateOverlay = read('infrastructure/development-admission/compose.private-proxy.yml');
  const productionOverlay = read('infrastructure/production/compose.production-proxy.yml');
  const base = read('docker-compose.yml');
  const baseCaddy = read(OBSERVABILITY_FILES.caddy);

  for (const caddyfile of [pilot, production]) {
    assert.match(caddyfile, /http:\/\/:9180 \{/);
    assert.match(caddyfile, /@authorized header Authorization "Bearer \{file\.\/run\/secrets\/metrics_token\}"/);
    assert.match(caddyfile, /handle \{\s+respond "unauthorized" 401\s+\}/);
    for (const [service, { upstream, path }] of Object.entries(METRICS_GATEWAY_SERVICES)) {
      assert.ok(caddyfile.includes(`handle /metrics/${service} {\n\t\t\trewrite * ${path}\n\t\t\treverse_proxy ${upstream}`), service);
    }
  }
  assert.match(privateOverlay, /target: 9180\s+published: "9180"\s+host_ip: "10\.231\.10\.108"/);
  assert.match(productionOverlay, /target: 9180\s+published: "9180"\s+host_ip: "\$\{PROXY_HTTP_BIND:\?/);
  // The public/local base stack never publishes the gateway.
  assert.doesNotMatch(base, /9180/);
  assert.doesNotMatch(baseCaddy, /9180|metrics_token/);
  assert.match(base, /proxy:[\s\S]*?secrets:\s*\n\s*#[^\n]*\n\s*#[^\n]*\n\s*- metrics_token\s*\n\s*networks:\s*\n\s*- external\s*\n\s*- app\s*\n\s*- management/);
});

test('observability verifier rejects a weakened metrics gateway', () => {
  for (const [search, replacement, message] of [
    ['@authorized header Authorization "Bearer {file./run/secrets/metrics_token}"', '@authorized header Authorization "Bearer"', /must require the metrics_token bearer/],
    ['respond "unauthorized" 401', 'respond "ok" 200', /must answer 401 without the token/],
    ['reverse_proxy worker:3003', 'reverse_proxy web:3000', /\/metrics\/worker must rewrite to \/metrics and proxy to worker:3003/],
  ]) {
    const fixtureRoot = createObservabilityFixture();
    try {
      replaceInFixture(fixtureRoot, OBSERVABILITY_FILES.caddyProduction, search, replacement);
      const result = validateObservabilityConfigs({ root: fixtureRoot });
      assert.equal(result.ok, false, search);
      assert.match(result.errors.join('\n'), message);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test('estate scrape target example is one lunchlineup job through the VM107 gateway', () => {
  const targets = read(OBSERVABILITY_FILES.estateTargets);

  assert.match(targets, /job_name: lunchlineup/);
  assert.match(targets, /credentials_file: \/etc\/prometheus\/secrets\/lunchlineup_metrics_token/);
  for (const service of Object.keys(METRICS_GATEWAY_SERVICES)) {
    assert.ok(targets.includes(`__metrics_path__: /metrics/${service}`), service);
  }
  assert.equal(targets.match(/targets: \['10\.231\.10\.108:9180'\]/g).length, Object.keys(METRICS_GATEWAY_SERVICES).length);
  assert.doesNotMatch(targets, /alertmanager|hooks\.slack|pagerduty|webhook_configs|url_file/i);
});

test('estate rules carry no rule about removed in-stack components', () => {
  const rules = read(OBSERVABILITY_FILES.estateRules);

  assert.doesNotMatch(rules, /alert: (?:Backup|Pitr)/);
  assert.doesNotMatch(rules, /lunchlineup_(?:backup|pitr)_/);
  assert.doesNotMatch(rules, /job="(?:api|api-v2|worker|engine|webhook-replay|control|prometheus)"/);
  assert.match(rules, /job="lunchlineup",service="api-v2"/);
});

test('observability verifier rejects estate rule regressions', () => {
  for (const [search, replacement, message] of [
    ['  - name: lunchlineup.retention\n', '  - name: lunchlineup.backup\n    rules:\n      - alert: BackupStale\n        expr: vector(1)\n        for: 1m\n  - name: lunchlineup.retention\n', /BackupStale belongs to the estate backup system/],
    ['absent(up{job="lunchlineup",service="api-v2"})', 'absent(up{job="api-v2"})', /must select job="lunchlineup"/],
  ]) {
    const fixtureRoot = createObservabilityFixture();
    try {
      replaceInFixture(fixtureRoot, OBSERVABILITY_FILES.estateRules, search, replacement);
      const result = validateObservabilityConfigs({ root: fixtureRoot });
      assert.equal(result.ok, false, search);
      assert.match(result.errors.join('\n'), message);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test('Grafana dashboards use stable panel and query references', () => {
  const dashboard = JSON.parse(read('docs/estate/dashboards/platform-overview.json'));
  const datasourceUids = new Set(['prometheus', 'loki']);
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
  assert.ok(!dashboard.panels.some((panel) => /backup/i.test(panel.title)), 'backup panels belong to the estate dashboards');
});

test('backup and PITR belong to the estate, not to alerts or scripts here', () => {
  const rules = read(OBSERVABILITY_FILES.estateRules);
  const runbook = read('docs/runbooks/postgres-pitr-recovery.md');

  assert.doesNotMatch(rules, /Pitr[A-Z]|pgbackrest/);
  assert.match(runbook, /pgBackRest/);
  assert.match(runbook, /estate-infra/);
  for (const removed of ['scripts/backup.sh', 'scripts/restore.sh', 'scripts/pitr-restore.sh', 'infrastructure/postgres/archive-wal.sh']) {
    assert.ok(!existsSync(join(root, removed)), `${removed} must stay removed`);
  }
});

test('isolated PDF parser runtime loss is healthchecked, alerted, and dashboarded', () => {
  const alerts = read(OBSERVABILITY_FILES.estateRules);
  const dashboard = JSON.parse(read('docs/estate/dashboards/platform-overview.json'));
  const compose = read('docker-compose.yml');
  const worker = read('apps/worker/src/parser_health.py');
  const workerHealthcheck = read('apps/worker/src/healthcheck.py');

  assert.match(compose, /python", "-m", "src\.healthcheck/);
  assert.match(workerHealthcheck, /lunchlineup_pdf_parser_ready/);
  assert.match(worker, /lunchlineup_pdf_parser_ready/);
  assert.match(worker, /lunchlineup_pdf_parser_health_probe_failures_total/);
  assert.match(alerts, /alert: PdfParserUnavailable[\s\S]*lunchlineup_pdf_parser_ready\{job="lunchlineup",service="worker"\} == 0[\s\S]*for: 2m/);
  assert.match(alerts, /alert: PdfParserReadinessMissing[\s\S]*absent\(lunchlineup_pdf_parser_ready\{job="lunchlineup",service="worker"\}\)[\s\S]*for: 2m/);
  assert.ok(dashboard.panels.some((panel) =>
    panel.title === 'Availability PDF Parser Readiness'
      && panel.targets?.some((target) => target.expr === 'min(lunchlineup_pdf_parser_ready{job="lunchlineup",service="worker"})'),
  ));
});

test('password-reset delivery has dead-letter, systemic provider, and stale-sweep alerts', () => {
  const alerts = read(OBSERVABILITY_FILES.estateRules);
  const runbook = read('docs/runbooks/outbound-delivery.md');

  for (const alert of ['PasswordResetEmailDeadLetters', 'PasswordResetEmailProviderOutage', 'PasswordResetEmailSweepStale']) {
    assert.match(alerts, new RegExp(`alert: ${alert}[\\s\\S]*runbook: "docs/runbooks/outbound-delivery\\.md"`));
    assert.match(runbook, new RegExp(alert));
  }
  assert.match(alerts, /lunchlineup_password_reset_email_systemic_provider_failure\{job="lunchlineup",service="worker"\} == 1/);
  assert.match(alerts, /time\(\) - lunchlineup_password_reset_email_sweep_last_success_unixtime/);
  assert.match(alerts, /increase\(lunchlineup_password_reset_email_total\{job="lunchlineup",service="worker",status="dead_lettered"\}\[15m\]\)/);
});

test('staff invitation delivery has alerts, runbook coverage, and Grafana panels', () => {
  const alerts = read(OBSERVABILITY_FILES.estateRules);
  const runbook = read('docs/runbooks/outbound-delivery.md');
  const dashboard = JSON.parse(read('docs/estate/dashboards/platform-overview.json'));
  const worker = 'job="lunchlineup",service="worker"';

  for (const alert of [
    'StaffInvitationDeadLetters',
    'StaffInvitationProviderOutage',
    'StaffInvitationSweepNotReady',
    'StaffInvitationSweepStale',
  ]) {
    const offset = alerts.indexOf('alert: ' + alert);
    assert.notEqual(offset, -1, alert + ' must be configured');
    const nextAlertOffset = alerts.indexOf('\n      - alert:', offset + 1);
    const alertDefinition = alerts.slice(offset, nextAlertOffset === -1 ? undefined : nextAlertOffset);
    assert.ok(
      alertDefinition.includes('runbook: "docs/runbooks/outbound-delivery.md"'),
      alert + ' must use the outbound-delivery runbook',
    );
    assert.ok(runbook.includes(alert), alert + ' must be documented');
  }
  assert.ok(alerts.includes(`increase(lunchlineup_staff_invitation_outbox_total{${worker},status="dead_lettered"}[15m])`));
  assert.ok(alerts.includes(`lunchlineup_staff_invitation_systemic_provider_failure{${worker}} == 1`));
  assert.ok(alerts.includes(`lunchlineup_staff_invitation_sweep_ready{${worker}} == 0`));
  assert.ok(alerts.includes('time() - lunchlineup_staff_invitation_sweep_last_success_unixtime'));
  assert.ok(alerts.includes(`lunchlineup_staff_invitation_sweep_max_staleness_seconds{${worker}}`));

  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  assert.equal(
    panels.get('Staff Invitation Dead Letters')?.targets?.[0]?.expr,
    `sum(increase(lunchlineup_staff_invitation_outbox_total{${worker},status="dead_lettered"}[15m]))`,
  );
  assert.equal(
    panels.get('Staff Invitation Provider Failure')?.targets?.[0]?.expr,
    `max(lunchlineup_staff_invitation_systemic_provider_failure{${worker}})`,
  );
  assert.equal(
    panels.get('Staff Invitation Sweep Age')?.targets?.[0]?.expr,
    `time() - max(lunchlineup_staff_invitation_sweep_last_success_unixtime{${worker}})`,
  );
  assert.deepEqual(
    panels.get('Staff Invitation Backlog')?.targets?.map((target) => target.expr),
    [
      `max(lunchlineup_staff_invitation_due{${worker}})`,
      `max(lunchlineup_staff_invitation_expired_leases{${worker}})`,
      `max(lunchlineup_staff_invitation_recent_provider_failures{${worker}})`,
    ],
  );
});

test('dead-letter paging is recent and rule fixtures prove fire then recovery', () => {
  const alerts = read(OBSERVABILITY_FILES.estateRules);
  const ruleTests = read(OBSERVABILITY_FILES.estateRuleTestMain);

  for (const [alertName, metric] of [
    ['PasswordResetEmailDeadLetters', 'lunchlineup_password_reset_email_total'],
    ['StaffInvitationDeadLetters', 'lunchlineup_staff_invitation_outbox_total'],
    ['NotificationOutboxDeadLetters', 'lunchlineup_notification_outbox_total'],
  ]) {
    assert.match(alerts, new RegExp(`alert: ${alertName}[\\s\\S]*increase\\(${metric}[\\s\\S]*\\[15m\\]`));
    assert.match(ruleTests, new RegExp(`eval_time: 5m\\r?\\n\\s*alertname: ${alertName}[\\s\\S]*eval_time: 18m\\r?\\n\\s*alertname: ${alertName}`));
  }
  assert.doesNotMatch(alerts, /DeadLetters[\s\S]{0,120}_dead_lettered[^\n]*> 0/);
});

test('solver queue telemetry is worker-owned and one poison item remains alertable', () => {
  const worker = read('apps/worker/main.py');
  const admin = read('apps/api/src/admin/admin.controller.ts');
  const apiMetrics = read('apps/api/src/common/metrics.service.ts');
  const alerts = read(OBSERVABILITY_FILES.estateRules);
  const ruleTests = read(OBSERVABILITY_FILES.estateRuleTestMain);

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
  const alerts = read(OBSERVABILITY_FILES.estateRules);
  const ruleTests = read(OBSERVABILITY_FILES.estateRuleTestMain);
  const dashboard = JSON.parse(read('docs/estate/dashboards/platform-overview.json'));

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
  const alerts = readFileSync(join(root, OBSERVABILITY_FILES.estateRules), 'utf8');
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
  assert.match(alerts, /alert: PublicWebUnavailable[\s\S]*lunchlineup_public_web_probe_success\{job="node",instance=~"[^"]+"\} == 0/);
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
    'caddy-config',
    'caddy-private-pilot',
    'caddy-production',
    'caddy-template',
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
  assert.equal(byId.get('prometheus-rules').hostCommand.command, 'promtool');
  assert.equal(byId.get('prometheus-rule-tests').hostCommand.command, 'promtool');

  for (const id of ['prometheus-rules', 'prometheus-rule-tests']) {
    const args = byId.get(id).containerCommand.args;
    const entrypointIndex = args.indexOf('--entrypoint');
    assert.notEqual(entrypointIndex, -1, `${id} must override the Prometheus server entrypoint`);
    assert.equal(args[entrypointIndex + 1], '/bin/promtool');
  }

  const ruleTestArgs = byId.get('prometheus-rule-tests').containerCommand.args;
  const prometheusImageIndex = ruleTestArgs.indexOf(OBSERVABILITY_TOOL_IMAGES.prometheus);
  assert.deepEqual(ruleTestArgs.slice(prometheusImageIndex + 1), [
    'test',
    'rules',
    ...PROMETHEUS_RULE_TEST_FILES.map((relativePath) => relativePath.split('/').at(-1)),
  ]);
});

test('observability verifier rejects weakened or multiply-owned CSP', () => {
  const fixtureRoot = createObservabilityFixture();

  try {
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.webContentSecurityPolicy,
      "'strict-dynamic'",
      "'unsafe-inline'",
    );
    replaceInFixture(
      fixtureRoot,
      OBSERVABILITY_FILES.caddy,
      'Strict-Transport-Security',
      'Content-Security-Policy "default-src \'self\'"\n        Strict-Transport-Security',
    );

    const result = validateObservabilityConfigs({ root: fixtureRoot });
    const errors = result.errors.join('\n');

    assert.equal(result.ok, false);
    assert.match(errors, /missing required CSP contract/);
    assert.match(errors, /script-src must not allow unsafe-inline/);
    assert.match(errors, /CSP must have one owner in the nonce-aware web runtime/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
  assert.match(result.stdout, /prometheus-rules skipped: promtool was not found on PATH; fallback: docker run --rm/);
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
  assert.match(result.stdout, /caddy-production: docker run --rm/);
  assert.match(result.stdout, /prometheus-rules: docker run --rm/);
  assert.match(result.stdout, /prometheus-rule-tests: docker run --rm/);
  assert.match(result.stdout, /\/bin\/promtool/);
  for (const relativePath of PROMETHEUS_RULE_TEST_FILES) {
    assert.ok(result.stdout.includes(relativePath.split('/').at(-1)));
  }
});
