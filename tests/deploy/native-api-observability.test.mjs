// Source-only candidate. Compose the selected verifier/dashboard/config/rules
// before future execution. No Docker probe, child-process call, application
// import or credential access in this fixture. It is not native promtool proof.
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  OBSERVABILITY_FILES, OBSERVABILITY_TOOL_IMAGES, PROMETHEUS_RULE_TEST_FILES,
  buildObservabilityToolCommands, validateObservabilityConfigs,
} from '../../scripts/verify-observability-configs.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function scratch() {
  const path = mkdtempSync(join(tmpdir(), 'lunchlineup-native-observability-'));
  try {
    for (const relative of Object.values(OBSERVABILITY_FILES)) {
      const target = join(path, relative); mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, relative), target);
    }
    cpSync(join(root, 'docs/runbooks'), join(path, 'docs/runbooks'), { recursive: true });
    return path;
  } catch (error) {
    rmSync(path, { recursive: true, force: true }); throw error;
  }
}
const job = doc => doc.scrape_configs.find(value => value.job_name === 'api-v2');
const api = doc => doc.services['api-v2'];
const env = doc => {
  if (Array.isArray(api(doc).environment)) {
    api(doc).environment = Object.fromEntries(api(doc).environment.map(value => {
      const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)];
    }));
  }
  return api(doc).environment;
};
const alert = (doc, name) => doc.groups.flatMap(group => group.rules).find(value => value.alert === name);
const panel = (doc, id) => doc.panels.find(value => value.id === id);
const mutations = [
  ['missing native stop grace', 'compose', doc => { delete api(doc).stop_grace_period; }, /reviewed 30s stop grace/],
  ['native stop grace "10s"', 'compose', doc => { api(doc).stop_grace_period = "10s"; }, /reviewed 30s stop grace/],
  ['native stop grace "15s"', 'compose', doc => { api(doc).stop_grace_period = "15s"; }, /reviewed 30s stop grace/],
  ['native stop grace "29s"', 'compose', doc => { api(doc).stop_grace_period = "29s"; }, /reviewed 30s stop grace/],
  ['native stop grace "31s"', 'compose', doc => { api(doc).stop_grace_period = "31s"; }, /reviewed 30s stop grace/],
  ['native stop grace 30', 'compose', doc => { api(doc).stop_grace_period = 30; }, /reviewed 30s stop grace/],
  ['native stop grace null', 'compose', doc => { api(doc).stop_grace_period = null; }, /reviewed 30s stop grace/],
  ['missing native job', 'prometheus', doc => { doc.scrape_configs = doc.scrape_configs.filter(job => job.job_name !== 'api-v2'); }, /missing api-v2 scrape job/],
  ['wrong native target', 'prometheus', doc => { job(doc).static_configs[0].targets = ['api:3000']; }, /api-v2 scrape targets/],
  ['wrong native metrics path', 'prometheus', doc => { job(doc).metrics_path = '/v2/ready'; }, /api-v2 metrics_path/],
  ['wrong credential file', 'prometheus', doc => { job(doc).authorization.credentials_file = '/tmp/synthetic-token'; }, /api-v2 scrape must read/],
  ['inline Bearer credential', 'prometheus', doc => { job(doc).authorization.credentials = 'synthetic-not-a-real-token'; }, /only file-backed Bearer/],
  ['Basic authentication instead of Bearer', 'prometheus', doc => { job(doc).authorization.type = 'Basic'; }, /Bearer authorization/],
  ['unbounded native scrape timeout', 'prometheus', doc => { delete job(doc).scrape_timeout; }, /bounded 5s\/12000\/8MB/],
  ['disabled sample limit', 'prometheus', doc => { job(doc).sample_limit = 0; }, /bounded 5s\/12000\/8MB/],
  ['disabled body limit', 'prometheus', doc => { job(doc).body_size_limit = '0'; }, /bounded 5s\/12000\/8MB/],
  ['request-family dropping relabel', 'prometheus', doc => { job(doc).metric_relabel_configs = [{ action: 'drop', regex: '.*' }]; }, /unreviewed relabel/],
  ['static job label override', 'prometheus', doc => { job(doc).static_configs[0].labels = { job: 'api' }; }, /without label overrides/],
  ['slow native scrape interval', 'prometheus', doc => { job(doc).scrape_interval = '2m'; }, /api-v2 scrape_interval/],
  ['duplicate native job', 'prometheus', doc => { doc.scrape_configs.push({ ...job(doc) }); }, /scrape job names must be unique/],
  ['missing native service', 'compose', doc => { delete doc.services['api-v2']; }, /missing api-v2 service/],
  ['missing metrics secret mount', 'compose', doc => { api(doc).secrets = []; }, /mount metrics_token once/],
  ['renamed metrics secret mount', 'compose', doc => { api(doc).secrets = [{ source: 'metrics_token', target: 'different_target' }]; }, /mount metrics_token once/],
  ['wrong token file environment', 'compose', doc => { env(doc).METRICS_TOKEN_FILE = '/tmp/synthetic-token'; }, /read the mounted metrics token file/],
  ['empty conflicting inline token', 'compose', doc => { env(doc).METRICS_TOKEN = ''; }, /inline or conflicting METRICS_TOKEN/],
  ['duplicate file environment binding', 'compose', doc => { api(doc).environment.push('METRICS_TOKEN_FILE=/run/secrets/metrics_token'); }, /one metrics token file binding/],
  ['public native port', 'compose', doc => { api(doc).ports = ['3002:3002']; }, /must not publish/],
  ['host network', 'compose', doc => { api(doc).network_mode = 'host'; }, /scoped Compose networks/],
  ['missing native shared network', 'compose', doc => { api(doc).networks = ['data', 'telemetry']; }, /must share app network/],
  ['missing scrape shared network', 'compose', doc => { doc.services.prometheus.networks = ['management']; }, /must share app network/],
  ['added native external network', 'compose', doc => { api(doc).networks.push('external'); }, /existing internal networks/],
  ['writable native root filesystem', 'compose', doc => { api(doc).read_only = false; }, /locked runtime privileges/],
  ['privileged native runtime', 'compose', doc => { api(doc).privileged = true; }, /locked runtime privileges/],
  ['added native capabilities', 'compose', doc => { api(doc).cap_add = ['SYS_ADMIN']; }, /locked runtime privileges/],
  ['removed no-new-privileges', 'compose', doc => { api(doc).security_opt = []; }, /retain no-new-privileges/],
  ['volume shadows secret', 'compose', doc => { api(doc).volumes.push('synthetic:/run/secrets'); }, /must not shadow/],
  ['unreviewed env file', 'compose', doc => { api(doc).env_file = 'synthetic.env'; }, /unreviewed env_file/],
  ['ServiceDown omits native', 'prometheusAlerts', doc => { alert(doc, 'ServiceDown').expr = alert(doc, 'ServiceDown').expr.replace('|api-v2', ''); }, /ServiceDown must cover api-v2/],
  ['removed missing native alert', 'prometheusAlerts', doc => { for (const group of doc.groups) group.rules = group.rules.filter(rule => rule.alert !== 'NativeApiMetricsMissing'); }, /missing NativeApiMetricsMissing|missing native alert NativeApiMetricsMissing/],
  ['marker forced healthy fallback', 'prometheusAlerts', doc => { alert(doc, 'NativeApiHttpInstrumentationUnavailable').expr += ' or vector(1)'; }, /reviewed native selector/],
  ['native latency uses millisecond threshold', 'prometheusAlerts', doc => { alert(doc, 'HighNativeApiLatency').expr = alert(doc, 'HighNativeApiLatency').expr.replace('> 2', '> 2000'); }, /reviewed native selector/],
  ['retained family added to fast burn', 'prometheusAlerts', doc => { alert(doc, 'ApiAvailabilityBudgetFastBurn').expr += ' or sum(rate(http_requests_total{job="api"}[5m]))'; }, /reviewed native selector/],
  ['4xx dilutes slow denominator', 'prometheusAlerts', doc => { alert(doc, 'ApiAvailabilityBudgetSlowBurn').expr = alert(doc, 'ApiAvailabilityBudgetSlowBurn').expr.replaceAll('2xx|3xx|5xx', '2xx|3xx|4xx|5xx'); }, /reviewed native selector/],
  ['burn pending duration weakened', 'prometheusAlerts', doc => { alert(doc, 'ApiAvailabilityBudgetSlowBurn').for = '0m'; }, /reviewed duration\/severity\/team/],
  ['missing job loses fixed job label', 'prometheusAlerts', doc => { delete alert(doc, 'NativeApiMetricsMissing').labels.job; }, /carry fixed job api-v2/],
  ['empty native rule controls', 'nativeRuleFixture', doc => { doc.tests = []; }, /native rule controls must load/],
  ['native controls load unrelated rules', 'nativeRuleFixture', doc => { doc.rule_files = ['../tenant-deletion-billing.yml']; }, /native rule controls must load/],
  ['availability defaults absent to100', 'platformDashboard', doc => { panel(doc, 13).targets[0].expr += ' or vector(100)'; }, /reviewed query ownership/],
  ['error ratio gets a denominator floor', 'platformDashboard', doc => { panel(doc, 6).targets[0].expr = 'sum(rate(lunchlineup_api_v2_http_requests_total{job="api-v2",scope="application",status_class="5xx"}[5m])) / clamp_min(sum(rate(lunchlineup_api_v2_http_requests_total{job="api-v2",scope="application"}[5m])),0.001)'; }, /reviewed query ownership/],
  ['native latency display uses ms', 'platformDashboard', doc => { panel(doc, 2).fieldConfig.defaults.unit = 'ms'; }, /reviewed units/],
  ['native rate switches to retained family', 'platformDashboard', doc => { panel(doc, 1).targets[0].expr = 'sum(rate(http_requests_total{job="api"}[1m]))'; }, /reviewed query ownership/],
  ['unqualified history title', 'platformDashboard', doc => { panel(doc, 13).title = 'Qualified API Availability'; }, /provisional history qualification/],
  ['stale successful stat reducer', 'platformDashboard', doc => { panel(doc, 13).options.reduceOptions.calcs = ['lastNotNull']; }, /instant\/last\/Unknown/],
  ['missing stat defaults100', 'platformDashboard', doc => { panel(doc, 13).fieldConfig.defaults.noValue = '100%'; }, /instant\/last\/Unknown/],
  ['retained diagnostic replaced by native', 'platformDashboard', doc => { panel(doc, 22).targets[0].expr = panel(doc, 1).targets[0].expr; }, /reviewed query ownership/],
  ['native missing from service scrape dashboard', 'platformDashboard', doc => { panel(doc, 10).targets[0].expr = panel(doc, 10).targets[0].expr.replace('|api-v2', ''); }, /reviewed query ownership/],
  ['abort diagnostic invents completed responses', 'platformDashboard', doc => { panel(doc, 27).targets[0].expr = panel(doc, 6).targets[0].expr; }, /reviewed query ownership/],
  ['retained dependencies mislabeled native', 'platformDashboard', doc => { panel(doc, 28).targets[0].expr = panel(doc, 28).targets[0].expr.replace('job="api"', 'job="api-v2"'); }, /reviewed query ownership/],
  ['duplicate dashboard panel ID', 'platformDashboard', doc => { doc.panels.push({ ...panel(doc, 13) }); }, /panel IDs must be unique/],
  ['native panel uses unprovisioned datasource', 'platformDashboard', doc => { panel(doc, 13).datasource.uid = 'unknown-prometheus'; }, /provisioned prometheus/],
];
test('reviewed native observability candidate passes structure with all owned files', () => {
  const path = scratch();
  try {
    const result = validateObservabilityConfigs({ root: path });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(api(yaml.load(readFileSync(join(path, OBSERVABILITY_FILES.compose), 'utf8'))).stop_grace_period, '30s');
    assert.deepEqual(result.checked, Object.values(OBSERVABILITY_FILES).sort());
  } finally { rmSync(path, { recursive: true, force: true }); }
});
for (const [name, key, mutate, message] of mutations) {
  test('native observability rejects ' + name, () => {
    const path = scratch();
    try {
      const before = validateObservabilityConfigs({ root: path });
      assert.equal(before.ok, true, before.errors.join('\n'));
      const relative = OBSERVABILITY_FILES[key]; assert.ok(relative, key);
      const target = join(path, relative), text = readFileSync(target, 'utf8');
      const json = key === 'platformDashboard', value = json ? JSON.parse(text) : yaml.load(text);
      mutate(value);
      writeFileSync(target, json ? JSON.stringify(value, null, 2) + '\n' : yaml.dump(value, { lineWidth: -1 }));
      const result = validateObservabilityConfigs({ root: path });
      assert.equal(result.ok, false, name);
      assert.match(result.errors.join('\n'), message);
    } finally { rmSync(path, { recursive: true, force: true }); }
  });
}
test('native rule fixture is owned by both pinned host and container command plans', () => {
  assert.ok(PROMETHEUS_RULE_TEST_FILES.includes('infrastructure/prometheus/alerts/tests/native-api.test.yml'));
  const check = buildObservabilityToolCommands({ root }).find(value => value.id === 'prometheus-rule-tests');
  assert.ok(check);
  assert.ok(check.hostCommand.args.includes(join(root, 'infrastructure/prometheus/alerts/tests/native-api.test.yml')));
  assert.ok(check.containerCommand.args.includes('native-api.test.yml'));
  assert.ok(check.containerCommand.args.includes(OBSERVABILITY_TOOL_IMAGES.prometheus));
  // Inspect command data only; never invoke a runner or binary in this case.
});
