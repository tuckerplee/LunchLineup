import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  queryAndVerifyDeployAlerts,
  runDeployAlertCli,
  verifyAlertmanagerPayload,
  verifyDeployAlertPayload,
} from '../../scripts/verify-deploy-alerts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const prometheusUrl = 'http://127.0.0.1:3002/api/datasources/proxy/uid/prometheus/api/v1/rules';
const alertmanagerUrl = 'http://127.0.0.1:9093/api/v2/alerts';
const now = Date.parse('Wed, 15 Jul 2026 18:00:00 GMT');

function payload(rules) {
  return {
    status: 'success',
    data: {
      groups: [
        { name: 'lunchlineup.service', rules },
        { name: 'lunchlineup.api', rules: [] },
        { name: 'lunchlineup.worker', rules: [] },
        { name: 'lunchlineup.engine', rules: [] },
        { name: 'lunchlineup.infrastructure', rules: [] },
        { name: 'lunchlineup.retention', rules: [] },
        {
          name: 'unrelated.service',
          rules: [{ type: 'alerting', name: 'OtherCritical', state: 'firing', labels: { severity: 'critical' } }],
        },
      ],
    },
  };
}

const quietCritical = {
  type: 'alerting',
  name: 'ServiceDown',
  state: 'inactive',
  labels: { severity: 'critical' },
  alerts: [],
};

function response(body, date = new Date(now - 1_000).toUTCString()) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'date' ? date : null },
    json: async () => body,
  };
}

test('alert gate accepts a complete LunchLineup scope with no firing critical alert', () => {
  const result = verifyDeployAlertPayload(payload([
    quietCritical,
    { type: 'alerting', name: 'WarningOnly', state: 'firing', labels: { severity: 'warning' } },
  ]));
  assert.deepEqual(result, { groupCount: 6, criticalRuleCount: 1 });
});

test('alert gate fails closed for a firing critical LunchLineup alert', () => {
  assert.throws(
    () => verifyDeployAlertPayload(payload([{ ...quietCritical, state: 'firing' }])),
    /pending or firing critical LunchLineup alerts: ServiceDown/,
  );
});

test('alert gate fails closed for a pending critical LunchLineup alert', () => {
  assert.throws(
    () => verifyDeployAlertPayload(payload([{ ...quietCritical, state: 'pending' }])),
    /pending or firing critical LunchLineup alerts: ServiceDown/,
  );
  assert.throws(
    () => verifyDeployAlertPayload(payload([{
      ...quietCritical,
      alerts: [{ state: 'pending' }],
    }])),
    /pending or firing critical LunchLineup alerts: ServiceDown/,
  );
});

test('alert gate fails closed when its required rule scope is missing or malformed', () => {
  assert.throws(
    () => verifyDeployAlertPayload({ status: 'success', data: { groups: [] } }),
    /required alert groups are missing/,
  );
  assert.throws(() => verifyDeployAlertPayload({ status: 'error' }), /invalid rules response/);
  assert.throws(
    () => verifyDeployAlertPayload(payload([{ ...quietCritical, labels: { severity: 'warning' } }])),
    /no critical rules/,
  );
});

test('authenticated query verifies fresh Prometheus and Alertmanager responses', async () => {
  let authorization = '';
  const urls = [];
  const result = await queryAndVerifyDeployAlerts({
    url: prometheusUrl,
    runtimeEnvironment: { GRAFANA_USER: 'operator', GRAFANA_PASSWORD: 'not-printed' },
    now,
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      if (String(url) === prometheusUrl) {
        authorization = options.headers.authorization;
        return response(payload([quietCritical]));
      }
      return response([]);
    },
  });
  assert.equal(result.criticalRuleCount, 1);
  assert.equal(result.alertCount, 0);
  assert.match(authorization, /^Basic /);
  assert.deepEqual(urls, [prometheusUrl, alertmanagerUrl]);
  await assert.rejects(
    queryAndVerifyDeployAlerts({
      url: 'https://prometheus.example.com/api/v1/rules',
      runtimeEnvironment: { GRAFANA_USER: 'operator', GRAFANA_PASSWORD: 'not-printed' },
      fetchImpl: async () => assert.fail('external URL must fail before fetch'),
    }),
    /Prometheus rules URL must be exactly/,
  );
});

test('Alertmanager rejects active and unprocessed critical alerts', () => {
  for (const state of ['active', 'unprocessed']) {
    assert.throws(
      () => verifyAlertmanagerPayload([{
        labels: { alertname: `Critical-${state}`, severity: 'critical' },
        status: { state },
      }]),
      new RegExp(`active or unprocessed critical Alertmanager alerts: Critical-${state}`),
    );
  }
  assert.deepEqual(
    verifyAlertmanagerPayload([
      { labels: { alertname: 'Suppressed', severity: 'critical' }, status: { state: 'suppressed' } },
      { labels: { alertname: 'Warning', severity: 'warning' }, status: { state: 'active' } },
    ]),
    { alertCount: 2, criticalAlertCount: 1 },
  );
  assert.throws(() => verifyAlertmanagerPayload({ alerts: [] }), /invalid alerts response/);
});

test('query rejects non-exact Alertmanager URLs and stale, future, or malformed dates', async () => {
  const options = {
    url: prometheusUrl,
    runtimeEnvironment: { GRAFANA_USER: 'operator', GRAFANA_PASSWORD: 'not-printed' },
    now,
  };
  await assert.rejects(
    queryAndVerifyDeployAlerts({
      ...options,
      alertmanagerUrl: `${alertmanagerUrl}?active=true`,
      fetchImpl: async () => assert.fail('invalid URL must fail before fetch'),
    }),
    /Alertmanager alerts URL must be exactly/,
  );

  for (const [date, expected] of [
    [null, /Date header is missing or malformed/],
    ['not-a-date', /Date header is missing or malformed/],
    [new Date(now - 30_001).toUTCString(), /response is stale/],
    [new Date(now + 1_000).toUTCString(), /Date header is in the future/],
  ]) {
    await assert.rejects(
      queryAndVerifyDeployAlerts({
        ...options,
        fetchImpl: async () => response(payload([quietCritical]), date),
      }),
      expected,
    );
  }

  await assert.rejects(
    queryAndVerifyDeployAlerts({
      ...options,
      fetchImpl: async (url) => String(url) === prometheusUrl
        ? response(payload([quietCritical]))
        : response([], new Date(now - 30_001).toUTCString()),
    }),
    /Alertmanager alerts response is stale/,
  );
});

test('query bounds the configured maximum response age', async () => {
  await assert.rejects(
    queryAndVerifyDeployAlerts({
      url: prometheusUrl,
      runtimeEnvironment: { GRAFANA_USER: 'operator', GRAFANA_PASSWORD: 'not-printed' },
      maxResponseAgeMs: 300_001,
      fetchImpl: async () => assert.fail('invalid age must fail before fetch'),
    }),
    /maximum response age must be between 1000 and 300000/,
  );
});

test('CLI passes both source options and prints the two-source success summary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lunchlineup-alert-cli-'));
  const runtimePath = join(directory, 'runtime.env');
  writeFileSync(runtimePath, 'GRAFANA_USER=operator\nGRAFANA_PASSWORD=not-printed\n');
  const argv = [
    'node',
    'verify-deploy-alerts.mjs',
    'query',
    '--url',
    prometheusUrl,
    '--alertmanager-url',
    alertmanagerUrl,
    '--runtime-env',
    runtimePath,
    '--max-response-age-ms',
    '15000',
  ];
  let output = '';
  try {
    const freshDate = new Date(Date.now() - 1_000).toUTCString();
    const result = await runDeployAlertCli({
      argv,
      fetchImpl: async (url) => String(url) === prometheusUrl
        ? response(payload([quietCritical]), freshDate)
        : response([], freshDate),
      stdout: { write: (value) => { output += value; } },
    });
    assert.equal(result.alertCount, 0);
    assert.match(output, /alertmanager_alerts=0 alertmanager_critical=0 alertmanager_active=0/);

    await assert.rejects(
      runDeployAlertCli({
        argv: argv.map((value) => value === '15000' ? '1000' : value),
        fetchImpl: async (url) => String(url) === prometheusUrl
          ? response(payload([quietCritical]), new Date(Date.now() - 2_000).toUTCString())
          : response([]),
        stdout: { write: () => assert.fail('stale CLI response must not print success') },
      }),
      /Prometheus rules response is stale/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deploy checks authenticated critical alerts before proof and pointer promotion', () => {
  const script = readFileSync(join(root, 'scripts', 'deploy-vm217-remote.sh'), 'utf8');
  const verifier = readFileSync(join(root, 'scripts', 'verify-deploy-alerts.mjs'), 'utf8');
  const runFunction = script.slice(script.indexOf('run_production_release_deploy()'));
  assert.ok(runFunction.indexOf('verify_deploy_alerts') < runFunction.indexOf('write_post_deploy_proof'));
  assert.ok(runFunction.indexOf('verify_deploy_alerts') < runFunction.indexOf('commit_release_pointers'));
  assert.match(script, /http:\/\/127\.0\.0\.1:3002\/api\/datasources\/proxy\/uid\/prometheus\/api\/v1\/rules/);
  assert.match(script, /--runtime-env "\$COMPOSE_SERVICE_ENV_FILE"/);
  assert.match(verifier, /option\('--alertmanager-url', argv\)/);
  assert.match(verifier, /option\('--max-response-age-ms', argv\)/);
});
