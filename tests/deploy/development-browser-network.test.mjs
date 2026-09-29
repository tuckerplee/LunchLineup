import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../../scripts/run-development-browser-qa.sh', import.meta.url), 'utf8');
const renderStart = source.indexOf('node - "$artifact_root/compose-config.json"');
const renderBodyStart = source.indexOf("<<'NODE'\n", renderStart) + "<<'NODE'\n".length;
const renderBodyEnd = source.indexOf('\nNODE\n', renderBodyStart);
assert.ok(renderStart >= 0 && renderBodyEnd > renderBodyStart);
const render = source.slice(renderBodyStart, renderBodyEnd);
const prepareStart = source.indexOf('prepare_runtime_networks(){\n');
const prepareEnd = source.indexOf('\n}\nverify_runtime_attachments', prepareStart);
assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
const prepare = source.slice(prepareStart, prepareEnd + 2);
const project = 'lunchlineup-beta-networkfixture';
const runId = 'network-fixture';
const sha = 'a'.repeat(40);

function config() {
  const service = (networks, depends_on = {}) => ({ image: `fixture:${Math.random()}`, environment: {}, networks: Object.fromEntries(networks.map(key => [key, {}])), depends_on });
  return { services: {
    'api-v2': service(['app'], { api: {} }),
    api: service(['app', 'outbound-egress'], { postgres: {}, migrate: {} }),
    web: service(['app']), worker: service(['data', 'outbound-egress'], { 'pdf-parser': {} }),
    engine: service(['data']), proxy: { ...service(['app', 'external']), ports: [{ host_ip: '127.0.0.1', published: '8080', target: 80, protocol: 'tcp' }] },
    postgres: service(['data']), migrate: service(['data']),
    'pdf-parser': { image: 'fixture:parser', network_mode: 'none', cap_drop: ['ALL'] },
  }, networks: Object.fromEntries(['app', 'data', 'external', 'outbound-egress', 'unused'].map(key => [key, { name: `${project}_${key}`, driver: 'bridge', internal: false }])) };
}

function fixture(options, verify) {
  const root = mkdtempSync(join(tmpdir(), 'lunchlineup-network-test-'));
  try {
    const input = config();
    options.modifyConfig?.(input);
    const paths = ['config.json', 'images.tsv', 'runtime.json', 'development-network-policy.json'].map(name => join(root, name));
    writeFileSync(paths[0], JSON.stringify(input));
    const rendered = spawnSync(process.execPath, ['-', ...paths, project], { input: render, encoding: 'utf8', timeout: 5_000, env: { ...process.env, CI_RUN_ID: runId, CI_COMMIT_SHA: sha } });
    if (options.renderFails) {
      assert.notEqual(rendered.status, 0);
      assert.equal(existsSync(paths[2]), false);
      return;
    }
    assert.equal(rendered.status, 0, rendered.stderr);
    const runtime = JSON.parse(readFileSync(paths[2], 'utf8'));
    const policy = JSON.parse(readFileSync(paths[3], 'utf8'));
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(root, 'fullstack-target.json'), JSON.stringify({ store: '/fixture-store', runId, sourceSha: sha, project }));
    writeFileSync(join(root, 'backend.json'), JSON.stringify({ host: { networkBackend: options.backend ?? 'netavark' }, store: { graphRoot: options.store ?? '/fixture-store' } }));
    for (const network of policy.networks) {
      const inspected = { id: createHash('sha256').update(network.name).digest('hex'), name: network.name, driver: 'bridge', internal: true, dns_enabled: true, ipv6_enabled: false, options: { isolate: 'true' }, labels: { 'com.docker.compose.project': project, 'io.podman.compose.project': project } };
      options.modifyInspect?.(inspected);
      writeFileSync(join(root, `inspect-${network.name}.json`), JSON.stringify([inspected]));
    }
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FIXTURE_ROOT/commands"
if [[ "$1" == info ]]; then cat "$FIXTURE_ROOT/backend.json"; exit 0; fi
[[ "$1" == network ]] || exit 92
case "$2" in
  exists) exit "$FIXTURE_EXISTS_STATUS";;
  create) [[ " $* " == *' --internal '* && " $* " == *' --opt isolate=true '* ]] || exit 93; exit 0;;
  inspect) name=$3; cat "$FIXTURE_ROOT/inspect-$name.json";;
  *) exit 94;;
esac
`, { mode: 0o700 });
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
artifact_root="$FIXTURE_ROOT"
project='${project}'
${prepare}
prepare_runtime_networks
`], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_EXISTS_STATUS: String(options.existsStatus ?? 1) } });
    assert.ifError(result.error);
    verify({ root, result, runtime, policy, commands: readFileSync(join(root, 'commands'), 'utf8') });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('runtime networks deny egress while retaining named service links, loopback publication and networkless parser', () => {
  fixture({}, ({ root, result, runtime, policy, commands }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(runtime.services['pdf-parser'].network_mode, 'none');
    assert.deepEqual(runtime.services.proxy.ports, [{ host_ip: '127.0.0.1', published: '8080', target: 80, protocol: 'tcp' }]);
    assert.equal(runtime.networks.unused, undefined);
    for (const network of Object.values(runtime.networks)) {
      assert.equal(network.internal, true);
      assert.equal(network.enable_ipv6, false);
      assert.deepEqual(network.driver_opts, { isolate: 'true' });
    }
    assert.equal(commands.split('\n').filter(line => line.startsWith('network create ')).length, policy.networks.length);
    const proof = JSON.parse(readFileSync(join(root, 'development-network-readiness.json'), 'utf8'));
    assert.equal(proof.sourceSha, sha);
    assert.equal(proof.runtimeStarted, false);
    assert.equal(proof.externalEgress, 'denied');
    assert.ok(proof.networks.every(network => /^[a-f0-9]{64}$/.test(network.inspectionSha256)));
  });
});

for (const [description, modifyConfig] of [
  ['host network', value => { value.services.worker.network_mode = 'host'; }],
  ['privileged runtime', value => { value.services.worker.privileged = true; }],
  ['network admin capability', value => { value.services.worker.cap_add = ['CAP_NET_ADMIN']; }],
  ['implicit network', value => { delete value.services.api.networks; }],
  ['shared network', value => { value.networks.app.external = true; }],
  ['public listener', value => { value.services.proxy.ports[0].host_ip = '0.0.0.0'; }],
]) test(`render refuses ${description}`, () => fixture({ modifyConfig, renderFails: true }));

for (const options of [{ backend: 'cni' }, { store: '/shared-store' }, { existsStatus: 0 }, { existsStatus: 125 }]) {
  test(`network admission fails before creation: ${JSON.stringify(options)}`, () => {
    fixture(options, ({ root, result, commands }) => {
      assert.notEqual(result.status, 0);
      assert.ok(!commands.includes('network create '));
      assert.equal(existsSync(join(root, 'development-network-readiness.json')), false);
    });
  });
}

for (const [description, modifyInspect] of [
  ['noninternal network', value => { value.internal = false; }],
  ['foreign label', value => { value.labels['com.docker.compose.project'] = 'another-job'; }],
  ['internal DNS unavailable', value => { value.dns_enabled = false; }],
  ['IPv6 enabled', value => { value.ipv6_enabled = true; }],
  ['isolation missing', value => { delete value.options.isolate; }],
]) test(`actual network readback rejects ${description}`, () => {
  fixture({ modifyInspect }, ({ root, result }) => {
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(root, 'development-network-readiness.json')), false);
  });
});

test('network preparation precedes every runtime Compose startup and leaves image builds outside its restriction', () => {
  const gate = source.indexOf('\nprepare_runtime_networks\n');
  const firstStart = source.indexOf('"${compose[@]}" --profile ops up');
  assert.ok(gate >= 0 && firstStart > gate);
  assert.ok(source.indexOf('build_image "$action" "$service" "$image"') < gate);
  assert.match(source, /docker network create --internal/);
});
