import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../../scripts/run-development-browser-qa.sh', import.meta.url), 'utf8');
const marker = 'node - "$artifact_root/development-browser-isolation.json"';
const start = source.indexOf("<<'NODE'\n", source.indexOf(marker)) + "<<'NODE'\n".length;
const end = source.indexOf('\nNODE\n', start);
assert.ok(source.includes(marker) && end > start);
const guard = source.slice(start, end);
const sha = 'a'.repeat(40);
const proof = () => ({
  kind: 'disposable-development-browser-isolation-selftest', releaseQualified: false,
  runId: 'fixture', sourceSha: sha, status: 'passed', approvedOrigin: 'http://127.0.0.1:8080',
  expectedCheckpointCount: 10, completedCheckpointCount: 10, deniedTrapHits: 0, cleanupVerified: true,
  deniedTrapConnections: 0,
  optionOverrideProof: { attempts: 3, rejectedBeforeCreation: 3, factoryCalls: 0, deniedTrapConnections: 0 },
  checkpoints: Array.from({ length: 10 }, (_, index) => ({ case: `case-${index}`, deniedTrapHits: 0, deniedTrapConnections: 0 })),
  proxy: { upstream: { hostname: '127.0.0.1', port: 8080 }, stoppedAt: new Date().toISOString(), approvedConnects: 1, openUpstreamSockets: 0, socketsClosed: true },
  ownedHarness: { syntheticTarget: { serverClosed: true }, deniedTrap: { serverClosed: true }, browserClosed: true },
});

function check(value) {
  const root = mkdtempSync(join(tmpdir(), 'qa-isolation-admission-'));
  try {
    const file = join(root, 'receipt.json');
    if (value) writeFileSync(file, JSON.stringify(value));
    return spawnSync(process.execPath, ['-', file, 'fixture', sha], { input: guard, encoding: 'utf8', timeout: 5000 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('runtime admission accepts completed current nonrelease browser proof', () => {
  const result = check(proof());
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, mutate] of [
  ['foreign run', value => { value.runId = 'other'; }],
  ['foreign source', value => { value.sourceSha = 'b'.repeat(40); }],
  ['missing checkpoint', value => { value.checkpoints.pop(); }],
  ['duplicate checkpoint', value => { value.checkpoints[1].case = value.checkpoints[0].case; }],
  ['trap reached', value => { value.checkpoints[4].deniedTrapHits = 1; }],
  ['trap connection', value => { value.checkpoints[4].deniedTrapConnections = 1; }],
  ['missing option proof', value => { delete value.optionOverrideProof; }],
  ['option factory invoked', value => { value.optionOverrideProof.factoryCalls = 1; }],
  ['incomplete option rejection', value => { value.optionOverrideProof.rejectedBeforeCreation = 2; }],
  ['unverified cleanup', value => { value.cleanupVerified = false; }],
  ['open browser', value => { value.ownedHarness.browserClosed = false; }],
  ['wrong proxy upstream', value => { value.proxy.upstream.hostname = 'other.invalid'; }],
  ['unproven local transport', value => { value.proxy.approvedConnects = 0; }],
  ['open upstream socket', value => { value.proxy.openUpstreamSockets = 1; }],
  ['unclosed proxy sockets', value => { value.proxy.socketsClosed = false; }],
  ['release claim', value => { value.releaseQualified = true; }],
]) test(`runtime admission rejects ${name}`, () => {
  const value = proof(); mutate(value);
  const result = check(value);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
});

test('missing proof refuses runtime preparation', () => {
  assert.notEqual(check(null).status, 0);
  assert.ok(source.indexOf(marker) < source.indexOf('build_image(){'));
});
