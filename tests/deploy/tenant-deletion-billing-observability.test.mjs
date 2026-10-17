import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('estate rule bundle ships the production groups and promtool fixtures separately', () => {
  const rules = read('docs/estate/lunchlineup-rules.yml');
  const fixtureDir = join(root, 'docs/estate/tests');

  assert.match(rules, /^groups:/m);
  assert.match(rules, /- name: lunchlineup\.tenant-deletion-billing/);
  assert.doesNotMatch(rules, /^(?:rule_files|tests):/m, 'rules must not contain promtool fixture syntax');

  const fixtureFiles = readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.yml'))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(fixtureFiles, ['lunchlineup.test.yml', 'native-api.test.yml', 'tenant-deletion-billing.test.yml']);
  for (const file of fixtureFiles) {
    const fixture = read(`docs/estate/tests/${file}`);
    assert.match(fixture, /^rule_files:/m);
    assert.match(fixture, /^tests:/m);
  }
});

test('deletion-billing critical freshness uses successful sweeps and fixtures cover reverse health', () => {
  const rules = read('docs/estate/lunchlineup-rules.yml');
  const fixture = read('docs/estate/tests/tenant-deletion-billing.test.yml');
  const dashboard = JSON.parse(read('docs/estate/dashboards/tenant-deletion-billing.json'));
  const freshnessRule = rules.slice(rules.indexOf('alert: TenantDeletionBillingSweepStale'));

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
  assert.doesNotMatch(rules + fixture, /tenant_cancellation|cancellation_reconciliation/);
});
