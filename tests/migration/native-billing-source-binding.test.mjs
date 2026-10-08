import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivateStableSnapshot, verifyNativeBillingSourceBinding } from '../../scripts/native-billing-source-binding.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const body = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function fixture() {
  const runId = '20261002T010000Z-job-a1', sourceSha = 'a'.repeat(40), treeSha = 'b'.repeat(40), baselineSha = 'c'.repeat(40), baselineTreeSha = 'd'.repeat(40), pipelineSha256 = 'e'.repeat(64);
  const workspace = `/var/lib/custom-ci/workspaces/${runId}`, temporaryRoot = `/var/lib/custom-ci/runs/${runId}/tmp/job-tmp`, runRoot = `${temporaryRoot}/lunchlineup-source-${runId}`, artifactRoot = `${workspace}/.release/internal-ci/${sourceSha}`;
  const context = { version: 1, kind: 'lunchlineup-internal-ci-source-context', repository: 'tuckerplee/LunchLineup', runId, runRoot, sourceRef: 'refs/heads/internal-beta-candidate', sourceSha, treeSha, remoteCandidateSha: sourceSha, baselineRef: 'refs/heads/main', baselineSha, pipelineSha256, sourceProofPath: `${artifactRoot}/source/source-proof.json`, scanSourcePath: `${runRoot}/scan`, buildSourcePath: `${runRoot}/build`, artifactRoot, evidenceRoot: artifactRoot };
  const proof = { version: 1, kind: 'lunchlineup-internal-ci-source-proof', status: 'passed', repository: context.repository, sourceRef: context.sourceRef, sourceSha, remoteCandidateSha: sourceSha, treeSha, baselineRef: context.baselineRef, baselineSha, baselineTreeSha, pipelineSha256, runId, originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true, verifiedAt: '2026-10-02T01:00:00.000Z' };
  const prefix = `lunchlineup-integration-${runId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const preflight = { runId, sourceSha, workspace, temporaryRoot, mutationRole: 'lunchlineup_ci_app', dataTargetEnvironment: 'disposable', database: 'lunchlineup_test', store: `${temporaryRoot}/lunchlineup-integration-containers-${runId}`, containers: ['postgres', 'redis', 'rabbitmq'].map(name => `${prefix}-${name}`) };
  const runtime = { postgresPort: 15432, appPassword: 'app:s e/c%ret', ownerPassword: 'root@s:e/c%ret' };
  const env = { CI_RUN_ID: runId, CI_COMMIT_SHA: sourceSha, CI_REPOSITORY: 'lunchlineup', CI_REF: context.sourceRef, CI_RUN_ATTEMPT: '1', RUNNER_TEMP: temporaryRoot, DATA_TARGET_ENV: 'disposable', APP_DB_USER: 'lunchlineup_ci_app', POSTGRES_USER: 'root', APP_DB_PASSWORD: runtime.appPassword, POSTGRES_PASSWORD: runtime.ownerPassword, DATABASE_URL: `postgresql://lunchlineup_ci_app:${encodeURIComponent(runtime.appPassword)}@127.0.0.1:15432/lunchlineup_test`, MIGRATION_DATABASE_URL: `postgresql://root:${encodeURIComponent(runtime.ownerPassword)}@127.0.0.1:15432/lunchlineup_test`, NODE_ENV: 'test' };
  const value = { contextBytes: body(context), proofBytes: body(proof), preflightBytes: body(preflight), expected: { runId, sourceSha, treeSha, baselineSha, baselineTreeSha, pipelineSha256 }, env, runtime };
  rehash(value); return value;
}
function rehash(value) { for (const name of ['context', 'proof', 'preflight']) value.expected[`${name}Sha256`] = sha(value[`${name}Bytes`]); }
function change(value, name, mutate) { const parsed = JSON.parse(value[`${name}Bytes`]); mutate(parsed); value[`${name}Bytes`] = body(parsed); rehash(value); }
function refused(value) {
  assert.throws(() => verifyNativeBillingSourceBinding(value), error => error.message === 'Native billing source binding refused.' && !error.cause);
}

function disposableFixture() {
  const value=fixture(), sourceRef='refs/heads/codex/disposable-native-test', pipelinePath='.ci/development-qa.pipeline.json';
  for (const name of ['context','proof']) {
    const original=JSON.parse(value[`${name}Bytes`]), entries=[];
    for (const [key,old] of Object.entries(original)) {
      if (key==='pipelineSha256') entries.push(['pipelinePath',pipelinePath]);
      entries.push([key==='remoteCandidateSha'?'remoteSourceSha':key,key==='version'?2:key==='sourceRef'?sourceRef:old]);
      if (key==='repository') entries.push(['sourcePurpose','disposable-development']);
    }
    value[`${name}Bytes`]=body(Object.fromEntries(entries));
  }
  const e=value.expected;
  e.sourceProfile={version:2,sourcePurpose:'disposable-development',repository:'tuckerplee/LunchLineup',sourceRef,sourceSha:e.sourceSha,treeSha:e.treeSha,baselineRef:'refs/heads/main',baselineSha:e.baselineSha,baselineTreeSha:e.baselineTreeSha,pipelinePath,pipelineSha256:e.pipelineSha256};
  value.env.CI_REF=sourceRef; rehash(value); return value;
}
test('explicit disposable native metadata binds canonical v2 and remains frozen/unqualified',()=>{
  const value=disposableFixture(),result=verifyNativeBillingSourceBinding(value);
  assert.equal(result.context.sourceRef,value.expected.sourceProfile.sourceRef);assert.equal(result.context.version,2);assert.equal(result.proof.remoteSourceSha,value.expected.sourceSha);
  assert.equal(result.nativeQualified,false);assert.equal(result.releaseQualified,false);
  value.expected.sourceProfile.sourceRef='refs/heads/codex/changed';value.proofBytes.fill(0);
  assert.equal(result.proof.sourceRef,'refs/heads/codex/disposable-native-test');assert.throws(()=>{result.context.sourcePurpose='release';},TypeError);
});
for (const [label,mutate] of Object.entries({
  'absent explicit selection despite disposable env and receipt':v=>{delete v.expected.sourceProfile;},
  'context ref only':v=>change(v,'context',o=>{o.sourceRef='refs/heads/codex/unapproved';}),
  'proof ref only':v=>change(v,'proof',o=>{o.sourceRef='refs/heads/codex/unapproved';}),
  'environment ref only':v=>{v.env.CI_REF='refs/heads/codex/unapproved';},
  'expected ref only':v=>{v.expected.sourceProfile.sourceRef='refs/heads/codex/unapproved';},
  'selfconsistent unapproved receipt refs':v=>{for(const n of ['context','proof'])change(v,n,o=>{o.sourceRef='refs/heads/codex/unapproved';});},
  'selfconsistent unapproved trees':v=>{for(const n of ['context','proof'])change(v,n,o=>{o.treeSha='f'.repeat(40);});},
  'conflicting expected envelope':v=>{v.expected.sourceProfile.sourceSha='f'.repeat(40);},
  'wrong repository':v=>{for(const n of ['context','proof'])change(v,n,o=>{o.repository='other/project';});},
  'wrong pipeline path':v=>{for(const n of ['context','proof'])change(v,n,o=>{o.pipelinePath='.ci/pipeline.json';});},
  'wrong purpose':v=>{for(const n of ['context','proof'])change(v,n,o=>{o.sourcePurpose='release';});},
  'wrong receipt version':v=>change(v,'context',o=>{o.version=1;}),
  'legacy alias in disposable context':v=>change(v,'context',o=>{o.remoteCandidateSha=o.sourceSha;delete o.remoteSourceSha;}),
  'unknown explicit profile key':v=>{v.expected.sourceProfile.authorized=true;},
  'missing explicit profile key':v=>{delete v.expected.sourceProfile.baselineTreeSha;},
  'array expected ref':v=>{v.expected.sourceProfile.sourceRef=['refs/heads/codex/dev'];},
  'non-string receipt ref':v=>change(v,'proof',o=>{o.sourceRef={ref:'refs/heads/codex/dev'};}),
})) test(`disposable metadata refuses ${label} with recalculated hashes`,()=>{const value=disposableFixture();mutate(value);refused(value);});
for (const name of ['context','proof']) for (const label of ['duplicate key','reordered keys','extra key','missing key','BOM','compact bytes']) test(`disposable canonical ${name} refuses ${label}`,()=>{
  const value=disposableFixture(), bytes=value[`${name}Bytes`], parsed=JSON.parse(bytes);
  const mutations={
    'duplicate key':()=>Buffer.from(bytes.toString().replace('  "version": 2,','  "version": 2,\n  "version": 2,')),
    'reordered keys':()=>body(Object.fromEntries(Object.entries(parsed).reverse())),
    'extra key':()=>body({...parsed,extra:true}),
    'missing key':()=>{delete parsed.sourcePurpose;return body(parsed);},
    'BOM':()=>Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]),
    'compact bytes':()=>Buffer.from(JSON.stringify(parsed)+'\n'),
  };
  value[`${name}Bytes`]=mutations[label]();rehash(value);refused(value);
});

test('canonical producer-shaped receipts bind exact runtime; output detached/frozen and unqualified', () => {
  const value = fixture(), result = verifyNativeBillingSourceBinding(value);
  assert.equal(result.controllerBinding.preflightSha256, sha(value.preflightBytes));
  assert.equal(result.contextPath, `${result.context.runRoot}/source-context.json`);
  assert.equal(result.nativeQualified, false); assert.equal(result.releaseQualified, false);
  value.contextBytes.fill(0); value.env.CI_RUN_ID = 'changed'; value.expected.sourceSha = 'f'.repeat(40);
  assert.equal(result.context.sourceSha, 'a'.repeat(40));
  assert.throws(() => result.preflight.containers.push('changed'), TypeError);
});
const bodyCases = {
  'duplicate same-value key': bytes => Buffer.from(bytes.toString().replace('  "version": 1,', '  "version": 1,\n  "version": 1,')),
  'escaped key spelling': bytes => Buffer.from(bytes.toString().replace('"version"', '"ver\\u0073ion"')),
  'compact formatting': bytes => Buffer.from(JSON.stringify(JSON.parse(bytes)) + '\n'),
  'reordered keys': bytes => body(Object.fromEntries(Object.entries(JSON.parse(bytes)).reverse())),
  'extra key': bytes => body({ ...JSON.parse(bytes), constructor: 'extra' }),
  'noncanonical number': bytes => Buffer.from(bytes.toString().replace('"version": 1,', '"version": 1e0,')),
  'BOM': bytes => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
  'malformed UTF8': bytes => Buffer.concat([bytes.subarray(0, 20), Buffer.from([0xc0, 0xaf]), bytes.subarray(20)]),
  'CRLF': bytes => Buffer.from(bytes.toString().replaceAll('\n', '\r\n')),
  'missing final LF': bytes => bytes.subarray(0, -1),
};
for (const [label, mutate] of Object.entries(bodyCases)) test(`refuses ${label} even with recomputed receipt hash`, () => { const value = fixture(); value.contextBytes = mutate(value.contextBytes); rehash(value); refused(value); });
const bindingCases = {
  'source digest mismatch': v => { v.expected.contextSha256 = '0'.repeat(64); },
  'unknown context ref': v => change(v, 'context', o => { o.sourceRef = 'refs/heads/main'; }),
  'selfconsistent unapproved tree': v => { change(v, 'context', o => { o.treeSha = 'f'.repeat(40); }); change(v, 'proof', o => { o.treeSha = 'f'.repeat(40); }); },
  'baseline tree mismatch': v => change(v, 'proof', o => { o.baselineTreeSha = 'f'.repeat(40); }),
  'pipeline mismatch': v => { v.expected.pipelineSha256 = 'f'.repeat(64); },
  'path alias': v => change(v, 'context', o => { o.buildSourcePath += '/../build'; }),
  'false clone flag': v => change(v, 'proof', o => { o.buildCloneVerified = false; }),
  'non-producer timestamp': v => change(v, 'proof', o => { o.verifiedAt = '2026-10-02T01:00:00Z'; }),
  'wrong preflight container': v => change(v, 'preflight', o => { o.containers[0] = 'other-postgres'; }),
  'wrong preflight store': v => change(v, 'preflight', o => { o.store = '/var/lib/containers'; }),
  'noncanonical attempt': v => { v.env.CI_RUN_ATTEMPT = '01'; },
  'URL object': v => { v.env.DATABASE_URL = new URL(v.env.DATABASE_URL); },
  'selfconsistent wrong port': v => { v.env.DATABASE_URL = v.env.DATABASE_URL.replace(':15432/', ':15433/'); v.env.MIGRATION_DATABASE_URL = v.env.MIGRATION_DATABASE_URL.replace(':15432/', ':15433/'); },
  'URL option': v => { v.env.DATABASE_URL += '?options=bad'; },
  'malformed encoded password': v => { v.env.DATABASE_URL = v.env.DATABASE_URL.replace(encodeURIComponent(v.runtime.appPassword), '%ZZ'); },
  'password differs from owner allocation': v => { v.runtime.appPassword = 'different-secret'; },
  'environment password differs': v => { v.env.APP_DB_PASSWORD = 'different-secret'; },
  'equal owner and app passwords': v => { v.runtime.ownerPassword = v.runtime.appPassword; v.env.POSTGRES_PASSWORD = v.runtime.ownerPassword; v.env.MIGRATION_DATABASE_URL = `postgresql://root:${encodeURIComponent(v.runtime.ownerPassword)}@127.0.0.1:15432/lunchlineup_test`; },
  'production environment': v => { v.env.NODE_ENV = 'production'; },
};
for (const [label, mutate] of Object.entries(bindingCases)) test(`refuses ${label} without secret-bearing errors`, () => { const value = fixture(); mutate(value); refused(value); });

function privateFile(run) {
  const callerUid = process.getuid(), callerGid = process.getgid();
  const rootUid = fs.lstatSync('/').uid;
  // A mapped-root runner sees unmapped host-root ancestors as 65534. The API
  // accepts an explicit file owner independently of its caller; use the real
  // mapped nobody identity for only this newly created receipt in that case.
  const expectedUid = callerUid === 0 && rootUid === 65534 ? rootUid : callerUid;
  if (expectedUid !== callerUid) {
    const ranges = fs.readFileSync('/proc/self/uid_map', 'utf8').trim().split('\n')
      .map(line => line.trim().split(/\s+/).map(Number));
    assert.ok(ranges.every(row => row.length === 3 && row.every(Number.isSafeInteger)));
    assert.ok(ranges.some(([inside, , length]) => expectedUid >= inside && expectedUid < inside + length),
      'fixture receipt owner must be a real mapped UID, not only the overflow display ID');
  }
  const root = fs.mkdtempSync(join(homedir(), '.billing-snapshot-'));
  const path = join(root, 'receipt.json');
  const options = { expectedUid, maxBytes: 64 };
  const writeReceipt = contents => {
    fs.writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
    const created = fs.lstatSync(path);
    assert.ok(created.isFile()); assert.equal(created.nlink, 1);
    assert.equal(created.uid, callerUid); assert.equal(created.gid, callerGid);
    assert.equal(created.mode & 0o7777, 0o600);
    if (expectedUid !== callerUid) fs.chownSync(path, expectedUid, callerGid);
    const owned = fs.lstatSync(path);
    assert.ok(owned.isFile()); assert.equal(owned.nlink, 1);
    assert.equal(owned.dev, created.dev); assert.equal(owned.ino, created.ino);
    assert.equal(owned.uid, expectedUid); assert.equal(owned.gid, callerGid);
    assert.equal(owned.mode & 0o7777, 0o600);
  };
  try {
    const directory = fs.lstatSync(root);
    assert.ok(directory.isDirectory()); assert.equal(directory.uid, callerUid);
    assert.equal(directory.mode & 0o7777, 0o700);
    writeReceipt('original\n');
    run({ root, path, options, writeReceipt });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('private snapshot reads complete bytes with exact digest', () => privateFile(({ path, options }) => {
  const result = readPrivateStableSnapshot(path, options);
  assert.equal(result.bytes.toString(), 'original\n'); assert.equal(result.size, 9); assert.equal(result.sha256, sha(result.bytes));
}));
const snapshotCases = {
  'final symlink': ({ root, path }) => { fs.renameSync(path, join(root, 'original')); fs.symlinkSync('original', path); },
  'ancestor symlink': state => { fs.mkdirSync(join(state.root, 'real'), { mode: 0o700 }); fs.renameSync(state.path, join(state.root, 'real', 'receipt.json')); fs.symlinkSync('real', join(state.root, 'alias')); state.path = join(state.root, 'alias', 'receipt.json'); },
  'hardlink': ({ root, path }) => { fs.linkSync(path, join(root, 'link')); },
  'public file mode': ({ path }) => { fs.chmodSync(path, 0o644); },
  'writable parent': ({ root }) => { fs.chmodSync(root, 0o777); },
  'wrong owner UID': state => { state.options.expectedUid += 1; },
  'empty file': ({ path }) => { fs.truncateSync(path, 0); },
  'oversized file': ({ path }) => { fs.writeFileSync(path, Buffer.alloc(65)); },
  'directory': state => { state.path = state.root; },
  'dot path alias': state => { state.path = `${state.root}/./receipt.json`; },
};
for (const [label, mutate] of Object.entries(snapshotCases)) test(`private snapshot refuses ${label} and closes any FD`, () => privateFile(state => {
  mutate(state); const before = fs.readdirSync('/proc/self/fd').length;
  assert.throws(() => readPrivateStableSnapshot(state.path, state.options), /source binding refused/);
  assert.equal(fs.readdirSync('/proc/self/fd').length, before);
}));
for (const [label, mutate] of Object.entries({
  growth: s => fs.appendFileSync(s.path, 'growth'),
  shrink: s => fs.truncateSync(s.path, 1),
  replacement: s => { fs.renameSync(s.path, join(s.root, 'old')); s.writeReceipt('replacement'); },
  'ancestor mode drift': s => fs.chmodSync(s.root, 0o777),
})) test(`private snapshot refuses observed ${label} during read`, t => privateFile(state => {
  const original = fs.readSync; let changed = false;
  const before = fs.readdirSync('/proc/self/fd').length;
  t.mock.method(fs, 'readSync', (...args) => { const count = original(...args); if (!changed) { changed = true; mutate(state); } return count; });
  syncBuiltinESMExports();
  try { assert.throws(() => readPrivateStableSnapshot(state.path, state.options), /source binding refused/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(fs.readdirSync('/proc/self/fd').length, before);
}));

for (const name of ['proof', 'preflight']) test(`refuses duplicate ${name} key despite matching digest`, () => {
  const value = fixture(), key = name === 'proof' ? 'version' : 'runId';
  const text = value[`${name}Bytes`].toString();
  const line = text.split('\n').find(line => line.includes(`"${key}"`));
  value[`${name}Bytes`] = Buffer.from(text.replace(line, line + '\n' + line)); rehash(value); refused(value);
});
for (const primaryRefusal of [false, true]) test(`private snapshot sanitizes close failure with primary refusal ${primaryRefusal}`, t => privateFile(state => {
  if (primaryRefusal) fs.chmodSync(state.path, 0o644);
  const original = fs.closeSync, before = fs.readdirSync('/proc/self/fd').length;
  let closed = false;
  t.mock.method(fs, 'closeSync', fd => { original(fd); closed = true; throw new Error('private-raw-path-secret'); });
  syncBuiltinESMExports();
  try { assert.throws(() => readPrivateStableSnapshot(state.path, state.options), error => error.message === 'Native billing source binding refused.' && !error.cause); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(closed, true); assert.equal(fs.readdirSync('/proc/self/fd').length, before);
}));

test('private snapshot sanitizes read failure after open and closes its FD', t => privateFile(state => {
  const before = fs.readdirSync('/proc/self/fd').length;
  let attempted = false;
  t.mock.method(fs, 'readSync', () => { attempted = true; throw new Error('private-raw-path-secret'); });
  syncBuiltinESMExports();
  try { assert.throws(() => readPrivateStableSnapshot(state.path, state.options), error => error.message === 'Native billing source binding refused.' && !error.cause); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(attempted, true); assert.equal(fs.readdirSync('/proc/self/fd').length, before);
}));
