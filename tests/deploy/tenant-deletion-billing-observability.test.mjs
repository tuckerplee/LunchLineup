import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('Prometheus runtime glob sees production groups but not promtool fixtures', () => {
  const compose = read('docker-compose.yml');
  const prometheus = read('infrastructure/prometheus/prometheus.yml');
  const alertsDir = join(root, 'infrastructure/prometheus/alerts');
  const fixtureDir = join(alertsDir, 'tests');

  assert.match(
    compose,
    /\.\/infrastructure\/prometheus\/alerts:\/etc\/prometheus\/alerts:ro/,
  );
  assert.match(prometheus, /rule_files:\s*\n\s*- \/etc\/prometheus\/alerts\/\*\.yml/);

  const runtimeFiles = readdirSync(alertsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(runtimeFiles, ['lunchlineup.yml', 'tenant-deletion-billing.yml']);
  for (const file of runtimeFiles) {
    const rules = read(`infrastructure/prometheus/alerts/${file}`);
    assert.match(rules, /^groups:/m, `${file} must contain production rule groups`);
    assert.doesNotMatch(rules, /^(?:rule_files|tests):/m, `${file} must not contain promtool fixture syntax`);
  }

  const fixtureFiles = readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.yml'))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(fixtureFiles, ['lunchlineup.test.yml', 'tenant-deletion-billing.test.yml']);
  for (const file of fixtureFiles) {
    const fixture = read(`infrastructure/prometheus/alerts/tests/${file}`);
    assert.match(fixture, /^rule_files:/m);
    assert.match(fixture, /^tests:/m);
  }
});

test('deletion-billing critical freshness uses successful sweeps and fixtures cover reverse health', () => {
  const alerts = read('infrastructure/prometheus/alerts/tenant-deletion-billing.yml');
  const fixture = read('infrastructure/prometheus/alerts/tests/tenant-deletion-billing.test.yml');
  const dashboard = JSON.parse(read('infrastructure/grafana/dashboards/tenant-deletion-billing.json'));
  const freshnessRule = alerts.slice(alerts.indexOf('alert: TenantDeletionBillingSweepStale'));

  assert.match(
    freshnessRule,
    /time\(\) - lunchlineup_tenant_deletion_billing_reconciliation_last_success_timestamp_seconds/,
  );
  assert.match(
    freshnessRule,
    /absent\(lunchlineup_tenant_deletion_billing_reconciliation_last_success_timestamp_seconds/,
  );
  assert.doesNotMatch(
    freshnessRule,
    /lunchlineup_tenant_deletion_billing_reconciliation_last_sweep_timestamp_seconds/,
  );
  assert.match(fixture, /failed sweeps cannot hide missing successful-sweep freshness/);
  assert.match(fixture, /failed sweeps cannot hide a stale successful sweep/);
  assert.match(fixture, /last_sweep_timestamp_seconds/);
  assert.match(fixture, /alertname: TenantDeletionBillingSweepStale/);

  const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  assert.match(
    panels.get('Deletion Billing Last Healthy Sweep Age')?.targets?.[0]?.expr ?? '',
    /last_success_timestamp_seconds/,
  );
  assert.doesNotMatch(alerts + fixture, /tenant_cancellation|cancellation_reconciliation/);
});
