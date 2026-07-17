#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SCOPE_PREFIX = 'lunchlineup.';
const REQUIRED_GROUPS = [
  'lunchlineup.api',
  'lunchlineup.engine',
  'lunchlineup.infrastructure',
  'lunchlineup.retention',
  'lunchlineup.service',
  'lunchlineup.worker',
];
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_AGE_MS = 30_000;
const MIN_MAX_RESPONSE_AGE_MS = 1_000;
const MAX_MAX_RESPONSE_AGE_MS = 300_000;
const PROMETHEUS_RULES_URL = 'http://127.0.0.1:3002/api/datasources/proxy/uid/prometheus/api/v1/rules';
const ALERTMANAGER_ALERTS_URL = 'http://127.0.0.1:9093/api/v2/alerts';
const HTTP_DATE_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function fail(message) {
  throw new Error(`Deploy alert verification failed closed: ${message}`);
}

function option(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function parseRuntimeEnvironment(path) {
  const values = {};
  for (const [index, rawLine] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail(`runtime environment line ${index + 1} is malformed.`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function blockingAlerts(rule) {
  if (rule.alerts !== undefined && !Array.isArray(rule.alerts)) {
    fail(`critical rule ${rule.name} has a malformed alerts list.`);
  }
  return (rule.alerts ?? []).filter((alert) => (
    ['pending', 'firing'].includes(alert?.state)
    || ['pending', 'firing'].includes(alert?.status?.state)
  ));
}

export function verifyDeployAlertPayload(payload, scopePrefix = DEFAULT_SCOPE_PREFIX) {
  if (payload?.status !== 'success' || !Array.isArray(payload?.data?.groups)) {
    fail('Prometheus returned an invalid rules response.');
  }
  if (scopePrefix !== DEFAULT_SCOPE_PREFIX) fail(`scope prefix must be ${DEFAULT_SCOPE_PREFIX}`);

  for (const [index, group] of payload.data.groups.entries()) {
    if (!isRecord(group) || typeof group.name !== 'string' || !Array.isArray(group.rules)) {
      fail(`Prometheus alert group ${index + 1} is malformed.`);
    }
  }

  const groups = payload.data.groups.filter((group) => group.name.startsWith(scopePrefix));
  const returnedNames = new Set(groups.map(({ name }) => name));
  const missingGroups = REQUIRED_GROUPS.filter((name) => !returnedNames.has(name));
  if (missingGroups.length > 0) fail(`required alert groups are missing: ${missingGroups.join(', ')}`);

  let criticalRuleCount = 0;
  const blockingCriticalAlerts = [];
  for (const group of groups) {
    for (const [index, rule] of group.rules.entries()) {
      if (!isRecord(rule) || !['alerting', 'recording'].includes(rule.type)) {
        fail(`rule ${index + 1} in alert group ${group.name} is malformed.`);
      }
      if (rule?.type !== 'alerting' || rule?.labels?.severity !== 'critical') continue;
      if (typeof rule.name !== 'string' || !rule.name || !['inactive', 'pending', 'firing'].includes(rule.state)) {
        fail(`critical rule ${index + 1} in alert group ${group.name} is malformed.`);
      }
      criticalRuleCount += 1;
      if (rule.state !== 'inactive' || blockingAlerts(rule).length > 0) {
        blockingCriticalAlerts.push(rule.name);
      }
    }
  }
  if (criticalRuleCount === 0) fail(`no critical rules were returned in the ${scopePrefix} scope.`);
  if (blockingCriticalAlerts.length > 0) {
    fail(`pending or firing critical LunchLineup alerts: ${[...new Set(blockingCriticalAlerts)].sort().join(', ')}`);
  }
  return { groupCount: groups.length, criticalRuleCount };
}

export function verifyAlertmanagerPayload(payload) {
  if (!Array.isArray(payload)) fail('Alertmanager returned an invalid alerts response.');
  let criticalAlertCount = 0;
  const blocking = [];
  for (const [index, alert] of payload.entries()) {
    const state = alert?.status?.state;
    if (!isRecord(alert) || !isRecord(alert.labels) || !isRecord(alert.status)
      || !['active', 'suppressed', 'unprocessed'].includes(state)) {
      fail(`Alertmanager alert ${index + 1} is malformed.`);
    }
    if (alert.labels.severity !== 'critical') continue;
    criticalAlertCount += 1;
    if (state === 'active' || state === 'unprocessed') {
      blocking.push(alert.labels.alertname || `unnamed-critical-alert-${index + 1}`);
    }
  }
  if (blocking.length) fail(`active or unprocessed critical Alertmanager alerts: ${blocking.join(', ')}`);
  return { alertCount: payload.length, criticalAlertCount };
}

function exactUrl(value, expected, source) {
  if (value !== expected) fail(`${source} URL must be exactly ${expected}`);
  return new URL(expected);
}

function fresh(response, source, maxResponseAgeMs, now) {
  const header = response?.headers?.get?.('date');
  if (typeof header !== 'string' || !HTTP_DATE_PATTERN.test(header)) {
    fail(`${source} response Date header is missing or malformed.`);
  }
  const responseTime = Date.parse(header);
  if (!Number.isFinite(responseTime) || new Date(responseTime).toUTCString() !== header) {
    fail(`${source} response Date header is malformed.`);
  }
  const observedAt = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(observedAt)) fail('current time source returned an invalid timestamp.');
  if (responseTime > observedAt) fail(`${source} response Date header is in the future.`);
  if (observedAt - responseTime > maxResponseAgeMs) fail(`${source} response is stale.`);
}

async function fetchJson({ fetchImpl, url, options, source, timeoutMs, maxResponseAgeMs, now }) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    fail(`${source} request failed.`);
  }
  if (!response?.ok) fail(`${source} request returned HTTP ${response?.status ?? 'unknown'}.`);
  fresh(response, source, maxResponseAgeMs, now);
  try {
    return await response.json();
  } catch {
    fail(`${source} response was not JSON.`);
  }
}

export async function queryAndVerifyDeployAlerts({
  url,
  prometheusUrl,
  alertmanagerUrl = ALERTMANAGER_ALERTS_URL,
  runtimeEnvironment,
  scopePrefix = DEFAULT_SCOPE_PREFIX,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseAgeMs = DEFAULT_MAX_RESPONSE_AGE_MS,
  now = Date.now,
  fetchImpl = fetch,
}) {
  if (url !== undefined && prometheusUrl !== undefined && url !== prometheusUrl) {
    fail('conflicting Prometheus rules URLs were provided.');
  }
  const prometheusEndpoint = exactUrl(prometheusUrl ?? url, PROMETHEUS_RULES_URL, 'Prometheus rules');
  const alertmanagerEndpoint = exactUrl(alertmanagerUrl, ALERTMANAGER_ALERTS_URL, 'Alertmanager alerts');
  const username = runtimeEnvironment.GRAFANA_USER;
  const password = runtimeEnvironment.GRAFANA_PASSWORD;
  if (!username || !password) fail('GRAFANA_USER and GRAFANA_PASSWORD are required in the runtime environment.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15_000) {
    fail('request timeout must be between 1000 and 15000 milliseconds.');
  }
  if (!Number.isSafeInteger(maxResponseAgeMs)
    || maxResponseAgeMs < MIN_MAX_RESPONSE_AGE_MS
    || maxResponseAgeMs > MAX_MAX_RESPONSE_AGE_MS) {
    fail(`maximum response age must be between ${MIN_MAX_RESPONSE_AGE_MS} and ${MAX_MAX_RESPONSE_AGE_MS} milliseconds.`);
  }

  const rules = await fetchJson({
    fetchImpl,
    url: prometheusEndpoint,
    options: { headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` } },
    source: 'Prometheus rules',
    timeoutMs,
    maxResponseAgeMs,
    now,
  });
  const ruleResult = verifyDeployAlertPayload(rules, scopePrefix);
  const alerts = await fetchJson({
    fetchImpl,
    url: alertmanagerEndpoint,
    options: {},
    source: 'Alertmanager alerts',
    timeoutMs,
    maxResponseAgeMs,
    now,
  });
  return { ...ruleResult, ...verifyAlertmanagerPayload(alerts) };
}

export async function runDeployAlertCli({
  argv = process.argv,
  fetchImpl = fetch,
  stdout = process.stdout,
} = {}) {
  const command = argv[2];
  const scopePrefix = option('--scope-prefix', argv) ?? DEFAULT_SCOPE_PREFIX;
  let result;
  if (command === 'fixture') {
    const input = option('--input', argv);
    if (!input) fail('--input is required for fixture verification.');
    result = verifyDeployAlertPayload(JSON.parse(readFileSync(resolve(input), 'utf8')), scopePrefix);
  } else if (command === 'query') {
    const runtimePath = option('--runtime-env', argv);
    const url = option('--url', argv);
    if (!runtimePath || !url) {
      fail('query requires --runtime-env and --url; --alertmanager-url and --max-response-age-ms use fixed defaults when omitted.');
    }
    result = await queryAndVerifyDeployAlerts({
      url,
      alertmanagerUrl: option('--alertmanager-url', argv) ?? ALERTMANAGER_ALERTS_URL,
      runtimeEnvironment: parseRuntimeEnvironment(resolve(runtimePath)),
      scopePrefix,
      timeoutMs: Number(option('--timeout-ms', argv) ?? DEFAULT_TIMEOUT_MS),
      maxResponseAgeMs: Number(option('--max-response-age-ms', argv) ?? DEFAULT_MAX_RESPONSE_AGE_MS),
      fetchImpl,
    });
  } else {
    fail('usage: verify-deploy-alerts.mjs query --url <url> --runtime-env <path> [--alertmanager-url <url>] [--max-response-age-ms <ms>] | fixture --input <path>');
  }
  const alertmanager = result.alertCount === undefined
    ? ''
    : ` alertmanager_alerts=${result.alertCount} alertmanager_critical=${result.criticalAlertCount} alertmanager_active=0`;
  stdout.write(
    `deploy_alert_gate_ok scope_prefix=${scopePrefix} groups=${result.groupCount} critical_rules=${result.criticalRuleCount} firing=0${alertmanager}\n`,
  );
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeployAlertCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
