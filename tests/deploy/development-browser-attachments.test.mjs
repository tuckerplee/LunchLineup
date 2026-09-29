import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../../scripts/run-development-browser-qa.sh', import.meta.url), 'utf8');
const start = source.indexOf('verify_runtime_attachments(){');
const bodyStart = source.indexOf("<<'NODE'\n", start) + "<<'NODE'\n".length;
const bodyEnd = source.indexOf('\nNODE\n', bodyStart);
assert.ok(start >= 0 && bodyEnd > bodyStart);
const body = source.slice(bodyStart, bodyEnd);
const id = value => createHash('sha256').update(value).digest('hex');
const project = 'lunchlineup-beta-attachmentfixture';
const network = `${project}_app`;
const v4 = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\neth0\t000A580A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n';
const rejectedV6 = `${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} ffffffff 00000000 00000000 00200200 lo\n`;

function fixture(modify = () => {}, verify) {
  const root = mkdtempSync(join(tmpdir(), 'lunchlineup-attachment-test-'));
  try {
    const identity = { sourceSha: 'a'.repeat(40), runId: 'attachment-fixture', project };
    const config = { services: { api: { image: 'fixture:api' }, 'pdf-parser': { image: 'fixture:parser' } }, networks: { app: { name: network } } };
    const policy = { ...identity, services: { api: { networks: ['app'] }, 'pdf-parser': { networks: [], networkMode: 'none' } } };
    const proof = { ...identity, networks: [{ name: network, networkId: id(network) }] };
    const state = { inventory: [], containers: {}, images: {}, routes: {}, required: 'api,pdf-parser', policy, proof };
    for (const service of ['api', 'pdf-parser']) {
      const containerId = id(service), imageId = id(`image-${service}`);
      state.inventory.push({ Id: containerId, Names: [`${project}_${service}_1`], Labels: { 'com.docker.compose.project': project } });
      state.containers[containerId] = { Id: containerId, Image: `sha256:${imageId}`, State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } }, HostConfig: { NetworkMode: service === 'api' ? network : 'none' }, NetworkSettings: { Networks: service === 'api' ? { [network]: { NetworkID: id(network) } } : {} } };
      state.images[config.services[service].image] = { Id: imageId };
      state.routes[containerId] = { '/proc/net/route': service === 'api' ? v4 : v4.split('\n')[0] + '\n', '/proc/net/ipv6_route': rejectedV6 };
    }
    modify(state);
    const bin = join(root, 'bin'), output = join(root, 'output'); mkdirSync(bin); mkdirSync(output);
    const paths = ['config', 'policy', 'proof', 'state'].map(name => join(root, `${name}.json`));
    [config, policy, proof, state].forEach((value, index) => writeFileSync(paths[index], JSON.stringify(value)));
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE));
fs.appendFileSync(process.env.FIXTURE_COMMANDS,JSON.stringify(args)+'\\n');
let value;
if(args[0]==='ps')value=state.inventory;
else if(args[0]==='inspect')value=[state.containers[args[1]]];
else if(args[0]==='image'&&args[1]==='inspect')value=[state.images[args[2]]];
else if(args[0]==='exec'&&args[2]==='cat'&&['/proc/net/route','/proc/net/ipv6_route'].includes(args[3])){process.stdout.write(state.routes[args[1]][args[3]]);process.exit(0);}
else process.exit(92);
process.stdout.write(JSON.stringify(value));
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['-', ...paths.slice(0, 3), output, 'pre-fixtures', state.required], { input: body, encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_STATE: paths[3], FIXTURE_COMMANDS: join(root, 'commands') } });
    assert.ifError(result.error);
    verify({ result, output, state, commands: existsSync(join(root, 'commands')) ? readFileSync(join(root, 'commands'), 'utf8').trim().split('\n').map(JSON.parse) : [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('actual attachment admission binds immutable container/image/network IDs and retains routes without external probes', () => fixture(undefined, ({ result, output, commands }) => {
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(readFileSync(join(output, 'proof.json'), 'utf8'));
  assert.equal(proof.buildTrafficQualified, false);
  assert.equal(proof.noExternalProbePerformed, true);
  assert.equal(proof.containers.length, 2);
  for (const container of proof.containers) for (const artifact of [container.attachments, container.ipv4Routes, container.ipv6Routes]) {
    const bytes = readFileSync(join(output, artifact.artifact));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.equal(bytes.length, artifact.bytes);
  }
  assert.deepEqual(commands[0], ['ps', '--no-trunc', '--format', 'json']);
  assert.ok(commands.filter(args => args[0] === 'exec').every(args => args[2] === 'cat' && args[3].startsWith('/proc/net/')));
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'pdf-parser-attachment.json'), 'utf8')).attachments, []);
}));

for (const [description, modify] of [
  ['unexpected network', state => { state.containers[id('api')].NetworkSettings.Networks.extra = { NetworkID: id('extra') }; }],
  ['replaced network ID', state => { state.containers[id('api')].NetworkSettings.Networks[network].NetworkID = id('replacement'); }],
  ['parser host mode', state => { state.containers[id('pdf-parser')].HostConfig.NetworkMode = 'host'; }],
  ['parser attachment', state => { state.containers[id('pdf-parser')].NetworkSettings.Networks[network] = { NetworkID: id(network) }; }],
  ['foreign project', state => { state.containers[id('api')].Config.Labels['com.docker.compose.project'] = 'another-job'; }],
  ['stopped container', state => { state.containers[id('api')].State.Running = false; }],
  ['image mismatch', state => { state.containers[id('api')].Image = id('other-image'); }],
  ['container identity mismatch', state => { state.containers[id('api')].Id = id('other-container'); }],
  ['missing service', state => { state.inventory.pop(); }],
  ['duplicate service', state => { state.inventory.push(state.inventory[0]); }],
  ['malformed inventory', state => { state.inventory[0] = null; }],
  ['malformed names', state => { state.inventory[0].Names = null; }],
  ['proof identity mismatch', state => { state.proof.sourceSha = 'b'.repeat(40); }],
  ['IPv4 default route', state => { state.routes[id('api')]['/proc/net/route'] += 'eth0 00000000 010A580A 0003 0 0 0 00000000 0 0 0\n'; }],
  ['usable IPv6 default route', state => { state.routes[id('api')]['/proc/net/ipv6_route'] = rejectedV6.replace('00200200 lo', '00000003 eth0'); }],
  ['malformed route', state => { state.routes[id('api')]['/proc/net/route'] = 'invalid'; }],
]) test(`actual attachment admission rejects ${description}`, () => fixture(modify, ({ result, output }) => {
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(output, 'proof.json')), false);
  if (description.includes('default route')) assert.equal(existsSync(join(output, 'api-ipv4-routes.txt')), true);
}));

test('attachment admission runs after early API startup before later sorted image builds and before fixtures', () => {
  const early = source.indexOf('verify_runtime_attachments early-api');
  const final = source.indexOf('verify_runtime_attachments pre-fixtures');
  const fixtures = source.indexOf('npx playwright test');
  assert.match(source, /for\(const name of \[\.\.\.selected\]\.sort\(\)\)/);
  assert.ok('api' < 'web');
  assert.ok(early > source.indexOf('--no-deps api >>'));
  assert.match(source.slice(early), /^verify_runtime_attachments early-api api,postgres,redis,rabbitmq\n  fi\ndone /);
  assert.ok(final > early);
  assert.ok(fixtures > final);
});
