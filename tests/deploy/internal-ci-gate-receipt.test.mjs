import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const recorder = join(root, 'scripts/record-internal-ci-gate.mjs');
const sha = '1'.repeat(40), tree = '2'.repeat(40), baseline = '3'.repeat(40), pipeline = '4'.repeat(64);

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'll-gate-')), artifact = join(scratch, 'artifact'), runRoot = join(scratch, 'runner', 'lunchlineup-source-run-1'), scan = join(runRoot, 'scan'), build = join(runRoot, 'build');
  for (const path of [join(artifact, 'source'), join(artifact, 'logs'), join(artifact, 'results'), join(artifact, 'details'), join(artifact, 'gates'), scan, build]) mkdirSync(path, { recursive: true });
  mkdirSync(join(scan, '.git')); mkdirSync(join(build, '.git'));
  const proof = { version: 1, kind: 'lunchlineup-internal-ci-source-proof', status: 'passed', repository: 'tuckerplee/LunchLineup', sourceRef: 'refs/heads/internal-beta-candidate', sourceSha: sha, remoteCandidateSha: sha, treeSha: tree, baselineRef: 'refs/heads/main', baselineSha: baseline, baselineTreeSha: baseline, pipelineSha256: pipeline, runId: 'run-1', originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true, verifiedAt: new Date().toISOString() };
  const proofPath = join(artifact, 'source/source-proof.json'); writeFileSync(proofPath, JSON.stringify(proof));
  const contextPath = join(runRoot, 'source-context.json'); writeFileSync(contextPath, JSON.stringify({ version: 1, kind: 'lunchlineup-internal-ci-source-context', repository: proof.repository, runId: proof.runId, runRoot, sourceRef: proof.sourceRef, sourceSha: sha, treeSha: tree, remoteCandidateSha: sha, baselineRef: proof.baselineRef, baselineSha: baseline, pipelineSha256: pipeline, sourceProofPath: proofPath, scanSourcePath: scan, buildSourcePath: build, artifactRoot: artifact, evidenceRoot: artifact }));
  const startedAt = new Date(Date.now() - 2000).toISOString(), resultPath = join(artifact, 'results/lint.json'), detailsPath = join(artifact, 'details/lint.json'), evidencePath = join(artifact, 'logs/lint.log');
  writeFileSync(resultPath, JSON.stringify({ version: 1, kind: 'lunchlineup-internal-ci-command-result', name: 'lint', status: 'passed', repository: proof.repository, runId: proof.runId, sourceSha: sha, treeSha: tree, attempt: 1, exitCode: 0, startedAt, completedAt: new Date(Date.now() - 1000).toISOString() }));
  writeFileSync(detailsPath, JSON.stringify({ sourceSha: sha })); writeFileSync(evidencePath, 'lint passed\n');
  const args = ['--name','lint','--source-context',contextPath,'--started-at',startedAt,'--command-result',resultPath,'--details',detailsPath,'--output',join(artifact,'gates/lint.json'),'--evidence',evidencePath];
  const env = { ...process.env, CI_COMMIT_SHA: sha, CI_RUN_ID: 'run-1', CI_RUN_ATTEMPT: '1', RUNNER_TEMP: join(scratch, 'runner') };
  return { scratch, artifact, args, env, contextPath, resultPath, detailsPath, evidencePath };
}
function run(f, args = f.args, env = f.env) { return spawnSync(process.execPath, [recorder, ...args], { env, encoding: 'utf8' }); }
test('exact successful command result writes an exclusive source-bound gate', () => { const f=fixture(); try { const r=run(f); assert.equal(r.status,0,r.stderr); const gate=JSON.parse(readFileSync(join(f.artifact,'gates/lint.json'))); assert.equal(gate.status,'passed'); assert.equal(gate.sourceSha,sha); assert.equal(gate.evidence[0].path,'logs/lint.log'); assert.notEqual(run(f).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
for (const [name, mutate] of [
  ['missing command result', (f)=>f.args.filter((v,i,a)=>v!=='--command-result'&&a[i-1]!=='--command-result')],
  ['failed command result', (f)=>{ const x=JSON.parse(readFileSync(f.resultPath)); x.status='failed'; writeFileSync(f.resultPath,JSON.stringify(x)); return f.args; }],
  ['wrong source command result', (f)=>{ const x=JSON.parse(readFileSync(f.resultPath)); x.sourceSha='9'.repeat(40); writeFileSync(f.resultPath,JSON.stringify(x)); return f.args; }],
  ['wrong tree command result', (f)=>{ const x=JSON.parse(readFileSync(f.resultPath)); x.treeSha='9'.repeat(40); writeFileSync(f.resultPath,JSON.stringify(x)); return f.args; }],
  ['wrong pipeline context', (f)=>{ const x=JSON.parse(readFileSync(f.contextPath)); x.pipelineSha256='9'.repeat(64); writeFileSync(f.contextPath,JSON.stringify(x)); return f.args; }],
  ['completion before start', (f)=>{ const x=JSON.parse(readFileSync(f.resultPath)); x.completedAt=new Date(Date.parse(x.startedAt)-1000).toISOString(); writeFileSync(f.resultPath,JSON.stringify(x)); return f.args; }],
  ['missing evidence', (f)=>f.args.slice(0,-2)],
  ['evidence outside root', (f)=>{ const outside=join(f.scratch,'outside.log'); writeFileSync(outside,'x'); const a=[...f.args]; a[a.length-1]=outside; return a; }],
  ['unknown gate', (f)=>f.args.map((v,i,a)=>a[i-1]==='--name'?'unknown':v)],
]) test(`gate recorder rejects ${name}`,()=>{ const f=fixture(); try { assert.notEqual(run(f,mutate(f)).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
test('gate recorder rejects non-controller and retried attempts',()=>{ for (const attempt of ['', '2']) { const f=fixture(); try { assert.notEqual(run(f,f.args,{...f.env,CI_RUN_ATTEMPT:attempt}).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } } });
test('gate recorder rejects a future start time',()=>{ const f=fixture(); try { const future=new Date(Date.now()+60000).toISOString(),args=[...f.args],index=args.indexOf('--started-at');args[index+1]=future;const result=JSON.parse(readFileSync(f.resultPath));result.startedAt=future;result.completedAt=new Date(Date.now()+61000).toISOString();writeFileSync(f.resultPath,JSON.stringify(result));assert.notEqual(run(f,args).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
test('gate recorder rejects duplicate evidence paths',()=>{ const f=fixture(); try { assert.notEqual(run(f,[...f.args,'--evidence',f.evidencePath]).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
test('gate recorder rejects symlink evidence',t=>{ const f=fixture(); try { const link=join(f.artifact,'logs/lint-link.log');try{symlinkSync(f.evidencePath,link,'file');}catch(error){t.skip(`file symlinks are unavailable: ${error.code}`);return;}const args=[...f.args];args[args.length-1]=link;assert.notEqual(run(f,args).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
