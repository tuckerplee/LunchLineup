// Source-only structure checks for the native API observability contract. No Docker
// probe, child-process call, application import or credential access in this
// fixture; promtool execution is covered by the container-mode verifier test.
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
const mutations = [
  ['missing native stop grace', 'compose', doc => { delete api(doc).stop_grace_period; }, /reviewed 30s stop grace/],
  ['native stop grace "10s"', 'compose', doc => { api(doc).stop_grace_period = '10s'; }, /reviewed 30s stop grace/],
  ['native stop grace "31s"', 'compose', doc => { api(doc).stop_grace_period = '31s'; }, /reviewed 30s stop grace/],
  ['native stop grace null', 'compose', doc => { api(doc).stop_grace_period = null; }, /reviewed 30s stop grace/],
  ['missing native service', 'compose', doc => { delete doc.services['api-v2']; }, /missing api-v2 service/],
  ['missing metrics secret mount', 'compose', doc => { api(doc).secrets = []; }, /mount metrics_token once/],
  ['renamed metrics secret mount', 'compose', doc => { api(doc).secrets = [{ source: 'metrics_token', target: 'different_target' }]; }, /mount metrics_token once/],
  ['wrong token file environment', 'compose', doc => { env(doc).METRICS_TOKEN_FILE = '/tmp/synthetic-token'; }, /read the mounted metrics token file/],
  ['empty conflicting inline token', 'compose', doc => { env(doc).METRICS_TOKEN = ''; }, /inline or conflicting METRICS_TOKEN/],
  ['duplicate file environment binding', 'compose', doc => { api(doc).environment.push('METRICS_TOKEN_FILE=/run/secrets/metrics_token'); }, /one metrics token file binding/],
  ['public native port', 'compose', doc => { api(doc).ports = ['3002:3002']; }, /must not publish/],
  ['host network', 'compose', doc => { api(doc).network_mode = 'host'; }, /scoped Compose networks/],
  ['missing native shared network', 'compose', doc => { api(doc).networks = ['data']; }, /share the app network/],
  ['added native external network', 'compose', doc => { api(doc).networks.push('external'); }, /existing internal networks/],
  ['writable native root filesystem', 'compose', doc => { api(doc).read_only = false; }, /locked runtime privileges/],
  ['privileged native runtime', 'compose', doc => { api(doc).privileged = true; }, /locked runtime privileges/],
  ['added native capabilities', 'compose', doc => { api(doc).cap_add = ['SYS_ADMIN']; }, /locked runtime privileges/],
  ['removed no-new-privileges', 'compose', doc => { api(doc).security_opt = []; }, /retain no-new-privileges/],
  ['volume shadows secret', 'compose', doc => { api(doc).volumes.push('synthetic:/run/secrets'); }, /must not shadow/],
  ['unreviewed env file', 'compose', doc => { api(doc).env_file = 'synthetic.env'; }, /unreviewed env_file/],
  ['proxy loses the metrics token', 'compose', doc => { doc.services.proxy.secrets = []; }, /proxy must receive metrics_token/],
  ['proxy loses the management network', 'compose', doc => { doc.services.proxy.networks = ['external', 'app']; }, /proxy must attach to the management network/],
  ['postgres archive mode hard-coded on', 'compose', doc => { doc.services.postgres.command = doc.services.postgres.command.map(value => value.replace('${POSTGRES_ARCHIVE_MODE:-off}', 'on')); }, /archive_mode must default to off/],
  ['postgres archive command defaults to success', 'compose', doc => { doc.services.postgres.command = doc.services.postgres.command.map(value => value.replace('/bin/false', '/bin/true')); }, /fail-closed \/bin\/false/],
  ['ServiceDown omits the application job', 'estateRules', doc => { alert(doc, 'ServiceDown').expr = alert(doc, 'ServiceDown').expr.replace('job="lunchlineup"', 'job="other"'); }, /ServiceDown must cover job="lunchlineup"/],
  ['removed missing native alert', 'estateRules', doc => { for (const group of doc.groups) group.rules = group.rules.filter(rule => rule.alert !== 'NativeApiMetricsMissing'); }, /missing alert NativeApiMetricsMissing/],
  ['empty native rule controls', 'estateRuleTestNative', doc => { doc.tests = []; }, /fixtures must load docs\/estate\/lunchlineup-rules\.yml/],
  ['native controls load unrelated rules', 'estateRuleTestNative', doc => { doc.rule_files = ['../tenant-deletion-billing.yml']; }, /fixtures must load docs\/estate\/lunchlineup-rules\.yml/],
  ['scrape job renamed', 'estateTargets', doc => { doc.scrape_configs[0].job_name = 'api-v2'; }, /exactly one scrape job named lunchlineup/],
  ['scrape drops the bearer credential', 'estateTargets', doc => { delete doc.scrape_configs[0].authorization; }, /Bearer credentials_file/],
  ['scrape retargets the native service', 'estateTargets', doc => { doc.scrape_configs[0].static_configs.find(config => config.labels.service === 'api-v2').labels.__metrics_path__ = '/metrics'; }, /api-v2 must use __metrics_path__ \/metrics\/api-v2/],
  ['scrape targets another host', 'estateTargets', doc => { doc.scrape_configs[0].static_configs[0].targets = ['api-v2:3002']; }, /every target must be the VM107 gateway/],
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
      const value = yaml.load(text);
      mutate(value);
      writeFileSync(target, yaml.dump(value, { lineWidth: -1 }));
      const result = validateObservabilityConfigs({ root: path });
      assert.equal(result.ok, false, name);
      assert.match(result.errors.join('\n'), message);
    } finally { rmSync(path, { recursive: true, force: true }); }
  });
}
test('native rule fixture is owned by both pinned host and container command plans', () => {
  assert.ok(PROMETHEUS_RULE_TEST_FILES.includes('docs/estate/tests/native-api.test.yml'));
  const check = buildObservabilityToolCommands({ root }).find(value => value.id === 'prometheus-rule-tests');
  assert.ok(check);
  assert.ok(check.hostCommand.args.includes(join(root, 'docs/estate/tests/native-api.test.yml')));
  assert.ok(check.containerCommand.args.includes('native-api.test.yml'));
  assert.ok(check.containerCommand.args.includes(OBSERVABILITY_TOOL_IMAGES.prometheus));
  // Inspect command data only; never invoke a runner or binary in this case.
});
