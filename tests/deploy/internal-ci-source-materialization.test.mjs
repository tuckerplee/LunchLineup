import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { materializeInternalCiSource } from '../../scripts/materialize-internal-ci-source.mjs';
import { readInternalCiSourceContext, selectInternalCiSourceProfile } from '../../scripts/internal-ci-source-context.mjs';
import { verifyInternalCiSourceClone } from '../../scripts/verify-internal-ci-source-clone.mjs';
import { prepareInternalCiDependencyInstall } from '../../scripts/internal-ci-dependency-install-plan.mjs';
import { readInternalCiMigrationSource } from '../../scripts/read-internal-ci-migrations.mjs';

const script = resolve(import.meta.dirname, '../../scripts/materialize-internal-ci-source.mjs');
const git = (cwd,...args) => { const r=spawnSync('git',args,{cwd,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
function fixture(development = false) {
  const scratch=mkdtempSync(join(tmpdir(),'ll-source-')), remote=join(scratch,'remote.git'), workspace=join(scratch,'workspace'), runner=join(scratch,'runner');
  mkdirSync(runner); git(scratch,'init','--bare',remote); git(scratch,'clone',remote,workspace); git(workspace,'config','user.email','ci@example.invalid'); git(workspace,'config','user.name','CI Test');
  mkdirSync(join(workspace,'.ci')); writeFileSync(join(workspace,'.ci/pipeline.json'),'{}\n'); writeFileSync(join(workspace,'README.md'),'main\n'); git(workspace,'add','.'); git(workspace,'commit','-m','main'); git(workspace,'branch','-M','main'); git(workspace,'push','-u','origin','main');
  git(workspace,'checkout','-b','internal-beta-candidate'); writeFileSync(join(workspace,'candidate.txt'),'candidate\n'); git(workspace,'add','.'); git(workspace,'commit','-m','candidate'); git(workspace,'push','-u','origin','internal-beta-candidate'); git(workspace,'fetch','origin');
  const candidateSha=git(workspace,'rev-parse','HEAD'), sourceRef=development?'refs/heads/codex/disposable-test':'refs/heads/internal-beta-candidate';
  if (development) { git(workspace,'checkout','-b','codex/disposable-test'); writeFileSync(join(workspace,'development.txt'),'development\n'); writeFileSync(join(workspace,'.ci/development-qa.pipeline.json'),'{"development":true}\n'); git(workspace,'add','.'); git(workspace,'commit','-m','development'); git(workspace,'push','-u','origin','codex/disposable-test'); git(workspace,'fetch','origin'); }
  const sha=git(workspace,'rev-parse','HEAD'), artifact=join(workspace,'.release','internal-ci',sha), runRoot=join(runner,'lunchlineup-source-run-1');
  const env={...process.env,CI_COMMIT_SHA:sha,CI_REF:sourceRef,CI_RUN_ID:'run-1',CI_RUN_ATTEMPT:'1',CI_REPOSITORY:'lunchlineup',RUNNER_TEMP:runner};
  const expectedSource=development?{version:2,sourcePurpose:'disposable-development',repository:'tuckerplee/LunchLineup',sourceRef,sourceSha:sha,treeSha:git(workspace,'rev-parse','HEAD^{tree}'),baselineRef:'refs/heads/main',baselineSha:git(workspace,'rev-parse','refs/remotes/origin/main'),baselineTreeSha:git(workspace,'rev-parse','refs/remotes/origin/main^{tree}'),pipelinePath:'.ci/development-qa.pipeline.json',pipelineSha256:createHash('sha256').update(readFileSync(join(workspace,'.ci/development-qa.pipeline.json'))).digest('hex')}:undefined;
  return {scratch,remote,workspace,runner,sha,candidateSha,artifact,runRoot,env,expectedSource,args:['--artifact-root',artifact,'--run-root',runRoot]};
}
const run=(f,env=f.env)=>spawnSync(process.execPath,[script,...f.args],{cwd:f.workspace,env,encoding:'utf8'});
test('clean exact candidate materializes independent exact clones and bounded proof',()=>{ const f=fixture(); try { const r=run(f); assert.equal(r.status,0,r.stderr); const proof=JSON.parse(readFileSync(join(f.artifact,'source/source-proof.json'))); assert.equal(proof.sourceSha,f.sha); assert.equal(proof.status,'passed'); assert.doesNotMatch(JSON.stringify(proof),/[A-Za-z]:[\\/]/); assert.equal(existsSync(join(f.runRoot,'source-context.json')),true); assert.equal(existsSync(join(f.artifact,'gates/source-identity.json')),true); const scan=join(f.runRoot,'scan'),build=join(f.runRoot,'build'); assert.notEqual(git(scan,'rev-parse','--absolute-git-dir'),git(build,'rev-parse','--absolute-git-dir')); writeFileSync(join(scan,'scan-only.txt'),'x'); assert.equal(existsSync(join(build,'scan-only.txt')),false); assert.equal(git(build,'status','--porcelain=v1','--untracked-files=all'),''); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
for (const [name,prepare,envChange] of [
 ['HEAD differs from controller SHA',()=>{},(f)=>({...f.env,CI_COMMIT_SHA:'9'.repeat(40)})],
 ['wrong branch',()=>{},(f)=>({...f.env,CI_REF:'refs/heads/main'})],
 ['dirty tracked file',(f)=>writeFileSync(join(f.workspace,'candidate.txt'),'dirty\n')],
 ['staged file',(f)=>{writeFileSync(join(f.workspace,'staged.txt'),'x');git(f.workspace,'add','staged.txt');}],
 ['untracked file',(f)=>writeFileSync(join(f.workspace,'untracked.txt'),'x')],
 ['remote candidate mismatch',(f)=>{writeFileSync(join(f.workspace,'local.txt'),'x');git(f.workspace,'add','.');git(f.workspace,'commit','-m','local only'); f.env.CI_COMMIT_SHA=git(f.workspace,'rev-parse','HEAD'); f.args[1]=join(f.workspace,'.release','internal-ci',f.env.CI_COMMIT_SHA);}],
 ['missing baseline',(f)=>git(f.workspace,'update-ref','-d','refs/remotes/origin/main')],
 ['wrong baseline ref',(f)=>git(f.workspace,'update-ref','refs/remotes/origin/main',f.sha)],
 ['existing scan destination',(f)=>mkdirSync(join(f.runRoot,'scan'),{recursive:true})],
 ['existing build destination',(f)=>mkdirSync(join(f.runRoot,'build'),{recursive:true})],
]) test(`materializer rejects ${name}`,()=>{ const f=fixture(); try { prepare(f); const r=run(f,envChange?envChange(f):f.env); assert.notEqual(r.status,0,`unexpected success for ${name}`); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
test('materializer refuses an existing proof/artifact root',()=>{ const f=fixture(); try { mkdirSync(join(f.artifact,'source'),{recursive:true}); writeFileSync(join(f.artifact,'source/source-proof.json'),'{}'); assert.notEqual(run(f).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
for (const cloneName of ['scan','build']) test(`materializer rejects a symlinked ${cloneName} root`,(t)=>{ const f=fixture(); try { const target=join(f.scratch,`${cloneName}-target`); mkdirSync(target); mkdirSync(f.runRoot,{recursive:true}); try { symlinkSync(target,join(f.runRoot,cloneName),process.platform==='win32'?'junction':'dir'); } catch (error) { t.skip(`directory symlinks are unavailable: ${error.code}`); return; } assert.notEqual(run(f).status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
for (const cloneName of ['scan','build']) test(`downstream verifier rejects Git alternates in the ${cloneName} clone`,()=>{ const f=fixture(); try { const materialized=run(f); assert.equal(materialized.status,0,materialized.stderr); const clone=join(f.runRoot,cloneName),alternates=join(clone,'.git','objects','info','alternates'); mkdirSync(resolve(alternates,'..'),{recursive:true}); writeFileSync(alternates,join(f.workspace,'.git','objects')); const verified=spawnSync(process.execPath,[resolve(script,'../verify-internal-ci-source-clone.mjs'),'--proof',join(f.artifact,'source/source-proof.json'),'--clone',clone,'--purpose',cloneName,'--require-clean'],{encoding:'utf8'}); assert.notEqual(verified.status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
test('source context rejects equal scan and build paths and a mutated clone tree',()=>{ const f=fixture(); try { const materialized=run(f); assert.equal(materialized.status,0,materialized.stderr); const contextPath=join(f.runRoot,'source-context.json'),context=JSON.parse(readFileSync(contextPath)); context.buildSourcePath=context.scanSourcePath; writeFileSync(contextPath,JSON.stringify(context)); const check=`import {readInternalCiSourceContext} from '${resolve(script,'../internal-ci-source-context.mjs').replaceAll('\\','/')}'; readInternalCiSourceContext(process.argv[1],{verifyClones:true});`; const equal=spawnSync(process.execPath,['--input-type=module','-e',check,contextPath],{env:f.env,encoding:'utf8'}); assert.notEqual(equal.status,0); context.buildSourcePath=join(f.runRoot,'build'); writeFileSync(contextPath,JSON.stringify(context)); writeFileSync(join(context.buildSourcePath,'candidate.txt'),'mutated\n'); const mutated=spawnSync(process.execPath,['--input-type=module','-e',check,contextPath],{env:f.env,encoding:'utf8'}); assert.notEqual(mutated.status,0); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });
test('materializer rejects pipeline bytes changed during cloning',async()=>{ const f=fixture(); try { const child=spawn(process.execPath,[script,...f.args],{cwd:f.workspace,env:f.env,stdio:['ignore','pipe','pipe']}); let stderr=''; child.stderr.setEncoding('utf8'); child.stderr.on('data',(chunk)=>{stderr+=chunk;}); const deadline=Date.now()+10000; while(!existsSync(join(f.runRoot,'scan','.git'))&&child.exitCode===null&&Date.now()<deadline) await new Promise((resolvePromise)=>setTimeout(resolvePromise,5)); assert.equal(child.exitCode,null,`materializer exited before the pipeline mutation: ${stderr}`); writeFileSync(join(f.workspace,'.ci/pipeline.json'),'{"changed":true}\n'); const status=await new Promise((resolvePromise,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolvePromise(code));}); assert.notEqual(status,0,'pipeline mutation unexpectedly passed'); assert.match(stderr,/Pipeline changed during materialization|Source is not clean/); } finally { rmSync(f.scratch,{recursive:true,force:true}); } });

const materializeDevelopment = f => materializeInternalCiSource({ artifactRoot:f.artifact, runRoot:f.runRoot, workspace:f.workspace, env:f.env, expectedSource:f.expectedSource });
for (const missing of [false,true]) test(`legacy exact clone keeps acceptance with candidate tracking ref ${missing?'absent':'different'}`,()=>{
  const f=fixture();try{
    assert.equal(run(f).status,0);const contextPath=join(f.runRoot,'source-context.json'),proofPath=join(f.artifact,'source/source-proof.json');
    for(const purpose of ['scan','build']){
      const clone=join(f.runRoot,purpose);
      if(missing)git(clone,'update-ref','-d','refs/remotes/origin/internal-beta-candidate');
      else git(clone,'update-ref','refs/remotes/origin/internal-beta-candidate',git(clone,'rev-parse','refs/remotes/origin/main'));
      assert.equal(verifyInternalCiSourceClone({proofPath,clone,purpose,requireClean:true}).sourceSha,f.sha);
      assert.equal(spawnSync(process.execPath,[resolve(script,'../verify-internal-ci-source-clone.mjs'),'--proof',proofPath,'--clone',clone,'--purpose',purpose,'--require-clean'],{env:f.env}).status,0);
    }
    assert.equal(readInternalCiSourceContext(contextPath,{env:f.env,verifyClones:true}).sourceSha,f.sha);
  }finally{rmSync(f.scratch,{recursive:true,force:true});}
});
test('explicit development profile binds distinct actual source through materialization, clones, install plan and migration reader',()=>{
  const f=fixture(true);
  try {
    assert.notEqual(f.sha,f.candidateSha);
    assert.notEqual(run(f).status,0,'ambient CI_REF must not authorize disposable materialization');
    const {proofPath,contextPath}=materializeDevelopment(f), options={expectedSource:f.expectedSource,env:f.env,verifyClones:true};
    const context=readInternalCiSourceContext(contextPath,options),proof=JSON.parse(readFileSync(proofPath));
    assert.equal(context.version,2); assert.equal(context.sourcePurpose,'disposable-development'); assert.equal(context.remoteSourceSha,f.sha);
    assert.equal(proof.pipelinePath,f.expectedSource.pipelinePath); assert.equal(Object.hasOwn(proof,'remoteCandidateSha'),false);
    const clones=[context.scanSourcePath,context.buildSourcePath];
    assert.notEqual(git(clones[0],'rev-parse','--absolute-git-dir'),git(clones[1],'rev-parse','--absolute-git-dir'));
    for (const [index,clone] of clones.entries()) {
      assert.equal(git(clone,'rev-parse','HEAD'),f.sha);
      assert.equal(git(clone,'rev-parse','refs/remotes/origin/codex/disposable-test'),f.sha);
      assert.equal(git(clone,'rev-parse','refs/remotes/origin/main'),f.expectedSource.baselineSha);
      assert.equal(existsSync(join(clone,'.git/objects/info/alternates')),false);
      assert.equal(spawnSync('git',['symbolic-ref','-q','HEAD'],{cwd:clone}).status,1);
      assert.equal(verifyInternalCiSourceClone({proofPath,clone,purpose:index?'build':'scan',requireClean:true,expectedSource:f.expectedSource}).sourceSha,f.sha);
      const cli=spawnSync(process.execPath,[resolve(script,'../verify-internal-ci-source-clone.mjs'),'--proof',proofPath,'--clone',clone,'--purpose',index?'build':'scan'],{env:f.env});
      assert.notEqual(cli.status,0,'default clone CLI must reject disposable proof');
    }
    assert.throws(()=>readInternalCiSourceContext(contextPath,{env:f.env,verifyClones:true}));
    assert.throws(()=>readInternalCiMigrationSource(contextPath,{env:f.env}));
    assert.throws(()=>prepareInternalCiDependencyInstall(contextPath,{env:f.env}));
    assert.equal(readInternalCiMigrationSource(contextPath,options).sourceRef,f.expectedSource.sourceRef);
    const plan=prepareInternalCiDependencyInstall(contextPath,options);
    assert.equal(plan.cwd,context.buildSourcePath); assert.deepEqual(plan.args,['ci']); assert.equal(plan.installProved,false); assert.equal(plan.nativeQualified,false);
    writeFileSync(join(context.buildSourcePath,'untracked-install.txt'),'x');
    assert.throws(()=>prepareInternalCiDependencyInstall(contextPath,options));
    assert.equal(readInternalCiMigrationSource(contextPath,{expectedSource:f.expectedSource,env:f.env}).sourceSha,f.sha,'post-install readback permits generated untracked files');
    writeFileSync(join(context.buildSourcePath,'development.txt'),'tampered tracked source\n');
    assert.throws(()=>readInternalCiMigrationSource(contextPath,{expectedSource:f.expectedSource,env:f.env}));
  } finally {rmSync(f.scratch,{recursive:true,force:true});}
});
for (const [label,mutate] of Object.entries({
  'missing selected tracking ref':f=>git(f.workspace,'update-ref','-d','refs/remotes/origin/codex/disposable-test'),
  'selected tracking ref at candidate SHA':f=>git(f.workspace,'update-ref','refs/remotes/origin/codex/disposable-test',f.candidateSha),
  'controller ref mismatch with same source SHA':f=>{git(f.workspace,'update-ref','refs/remotes/origin/codex/other',f.sha);f.env.CI_REF='refs/heads/codex/other';},
  'expected tree mismatch':f=>{f.expectedSource.treeSha='f'.repeat(40);},
  'expected baseline mismatch':f=>{f.expectedSource.baselineSha=f.candidateSha;},
  'expected baseline tree mismatch':f=>{f.expectedSource.baselineTreeSha='f'.repeat(40);},
  'expected pipeline mismatch':f=>{f.expectedSource.pipelineSha256='f'.repeat(64);},
})) test(`development materializer rejects ${label} before creating proof`,()=>{
  const f=fixture(true);try{mutate(f);assert.throws(()=>materializeDevelopment(f));assert.equal(existsSync(join(f.artifact,'source/source-proof.json')),false);assert.equal(existsSync(f.runRoot),false);}finally{rmSync(f.scratch,{recursive:true,force:true});}
});
for (const ref of ['main','origin/dev','refs/tags/dev','refs/heads/main','refs/heads/internal-beta-candidate','refs/heads/x:y','refs/heads/a..b','refs/heads/a@{1}','refs/heads/a b','refs/heads/a\nb','refs/heads/a/*','refs/heads/a//b','refs/heads/.a','refs/heads/a.lock','refs/heads/a/','refs/heads/a.','refs/heads/a^','refs/heads/a~1','refs/heads/a\\b',[],{}]) test(`explicit development selector refuses ref ${JSON.stringify(ref)}`,()=>{
  const profile={version:2,sourcePurpose:'disposable-development',repository:'tuckerplee/LunchLineup',sourceRef:ref,sourceSha:'a'.repeat(40),treeSha:'b'.repeat(40),baselineRef:'refs/heads/main',baselineSha:'c'.repeat(40),baselineTreeSha:'d'.repeat(40),pipelinePath:'.ci/pipeline.json',pipelineSha256:'e'.repeat(64)};
  assert.throws(()=>selectInternalCiSourceProfile(profile));
});
test('development context/proof and actual clone mismatches refuse against independent profile',()=>{
  const f=fixture(true);try{
    const {proofPath,contextPath}=materializeDevelopment(f), originalContext=readFileSync(contextPath),originalProof=readFileSync(proofPath), options={expectedSource:f.expectedSource,env:f.env,verifyClones:true};
    const cases=[['context sourceRef',c=>{c.sourceRef='refs/heads/codex/unapproved';},()=>{}],['proof sourceRef',()=>{},p=>{p.sourceRef='refs/heads/codex/unapproved';}],['selfconsistent unapproved sourceRef',c=>{c.sourceRef='refs/heads/codex/unapproved';},p=>{p.sourceRef='refs/heads/codex/unapproved';}],['context repository',c=>{c.repository='other/project';},()=>{}],['proof repository',()=>{},p=>{p.repository='other/project';}],['pipeline path',c=>{c.pipelinePath='.ci/pipeline.json';},p=>{p.pipelinePath='.ci/pipeline.json';}],['cross-version alias',c=>{c.remoteCandidateSha=c.sourceSha;},()=>{}],['purpose',c=>{c.sourcePurpose='release';},p=>{p.sourcePurpose='release';}]];
    for(const [label,changeContext,changeProof] of cases){const c=JSON.parse(originalContext),p=JSON.parse(originalProof);changeContext(c);changeProof(p);writeFileSync(contextPath,JSON.stringify(c));writeFileSync(proofPath,JSON.stringify(p));assert.throws(()=>readInternalCiSourceContext(contextPath,options),undefined,label);}
    writeFileSync(contextPath,originalContext);writeFileSync(proofPath,originalProof);
    assert.throws(()=>readInternalCiSourceContext(contextPath,{...options,env:{...f.env,CI_REF:'refs/heads/codex/unapproved'}}));
    assert.throws(()=>readInternalCiSourceContext(contextPath,{...options,expectedSource:{...f.expectedSource,sourceRef:'refs/heads/codex/unapproved'}}));
    const clone=join(f.runRoot,'build');git(clone,'update-ref','refs/remotes/origin/codex/disposable-test',f.candidateSha);
    assert.throws(()=>verifyInternalCiSourceClone({proofPath,clone,purpose:'build',expectedSource:f.expectedSource}));
    assert.throws(()=>readInternalCiSourceContext(contextPath,options));
    git(clone,'update-ref','refs/remotes/origin/codex/disposable-test',f.sha);
    git(clone,'update-ref','refs/remotes/origin/main',f.candidateSha);
    assert.throws(()=>verifyInternalCiSourceClone({proofPath,clone,purpose:'build',expectedSource:f.expectedSource}));
    assert.throws(()=>readInternalCiSourceContext(contextPath,options));
    git(clone,'update-ref','refs/remotes/origin/main',f.expectedSource.baselineSha);
    git(clone,'checkout','-b','attached-development');
    assert.throws(()=>verifyInternalCiSourceClone({proofPath,clone,purpose:'build',expectedSource:f.expectedSource}));
    assert.throws(()=>readInternalCiSourceContext(contextPath,options));
  }finally{rmSync(f.scratch,{recursive:true,force:true});}
});
test('materializer and clone CLIs refuse duplicate, unknown and missing options',()=>{
  const f=fixture();try{
    for(const extra of [['--run-root',f.runRoot],['--source-profile','untrusted.json'],['--unknown','x'],['--run-root']]) assert.notEqual(spawnSync(process.execPath,[script,...f.args,...extra],{cwd:f.workspace,env:f.env}).status,0);
    assert.equal(run(f).status,0);
    const cloneArgs=['--proof',join(f.artifact,'source/source-proof.json'),'--clone',join(f.runRoot,'build'),'--purpose','build'];
    for(const extra of [['--purpose','scan'],['--source-profile','untrusted.json'],['--unknown','x'],['--clone'],['--require-clean','--require-clean']]) assert.notEqual(spawnSync(process.execPath,[resolve(script,'../verify-internal-ci-source-clone.mjs'),...cloneArgs,...extra],{env:f.env}).status,0);
  }finally{rmSync(f.scratch,{recursive:true,force:true});}
});


// Exercise the real fixed-record reader and source verifier with synthetic
// filesystem metadata; no root ownership or fixed /var path is fabricated.
test('fixed browser CLI supplies only a protected owner profile to the real source verifier', async () => {
  const { runInNewContext } = await import('node:vm');
  const { constants } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { verifyInternalCiSourceSelection, verifyInternalCiSourceProof, verifyInternalCiSourceContextIdentity } = await import('../../scripts/internal-ci-source-context.mjs');
  const source = readFileSync(new URL('../../scripts/fixed-browser-source-profile.mjs', import.meta.url), 'utf8');
  const executable = source.replace(/^import .*;\n/gm, '').replace('export function ', 'function ') + '\nreadFixedBrowserSourceProfile';
  const run = '20261008T051347Z-lunchlineup-11111111-123456';
  const profile = { version: 2, sourcePurpose: 'disposable-development', repository: 'tuckerplee/LunchLineup', sourceRef: 'refs/heads/codex/disposable-fixed-test', sourceSha: '1'.repeat(40), treeSha: '2'.repeat(40), baselineRef: 'refs/heads/main', baselineSha: '3'.repeat(40), baselineTreeSha: '4'.repeat(40), pipelinePath: '.ci/development-browser.pipeline.json', pipelineSha256: '5'.repeat(64) };
  const record = { runId: run, sourceProfile: profile, materializerSha256: '6'.repeat(64) };
  const workspace = `/var/lib/custom-ci/workspaces/${run}`, temporary = `/var/lib/custom-ci/runs/${run}/tmp/job-tmp`;
  const env = { CI_RUN_ID: run, CI_COMMIT_SHA: profile.sourceSha, CI_REF: profile.sourceRef, CI_RUN_ATTEMPT: '1', CI_REPOSITORY: 'lunchlineup', LUNCHLINEUP_DEVELOPMENT_QA: '1', CI_WORKSPACE: workspace, RUNNER_TEMP: temporary };
  const options = { proofPath: `${workspace}/.release/internal-ci/${profile.sourceSha}/source/source-proof.json`, clone: `${temporary}/lunchlineup-source-${run}/build`, purpose: 'build', requireClean: true };
  const proof = { ...profile, remoteSourceSha: profile.sourceSha, kind: 'lunchlineup-internal-ci-source-proof', status: 'passed', runId: run, originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true, verifiedAt: '2026-10-08T05:13:53.169Z' };
  function reader(change = {}) {
    const bytes = Buffer.from(JSON.stringify(change.record ?? record)); let reads = 0, stats = 0, closed = 0;
    const info = { dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o100444, nlink: 1, size: bytes.length, mtimeMs: 1, ctimeMs: 1, isFile: () => true, isSymbolicLink: () => false, ...change.file };
    const parent = { uid: 0, mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false, ...change.parent };
    const fs = {
      constants,
      lstatSync: path => { if (path.endsWith('/browser-source-profile.json')) { if (change.absent) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return { ...info, ...change.named }; } return parent; },
      realpathSync: path => change.noncanonical ? `${path}/alias` : path,
      openSync: (path, flags) => { assert.equal(path, `/var/lib/custom-ci/runs/${run}/browser-source-profile.json`); assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); if (change.openError) throw new Error('open refused'); return 9; },
      fstatSync: () => ({ ...info, ...(stats++ ? change.after : {}) }),
      readSync: (fd, buffer, offset, length) => { if (reads++) return 0; bytes.copy(buffer, offset, 0, Math.min(length, bytes.length)); return Math.min(length, bytes.length); },
      closeSync: fd => { assert.equal(fd, 9); closed++; },
    };
    const read = runInNewContext(executable, { ...fs, dirname, resolve, Buffer, selectInternalCiSourceProfile, process: { env } });
    return { read, closed: () => closed };
  }
  const valid = reader(), selected = valid.read(options, env);
  assert.equal(valid.closed(), 1);
  assert.equal(reader().read(options, { ...env, LUNCHLINEUP_BROWSER_COHORT: 'full' }).pipelinePath, profile.pipelinePath);
  const staffRecord = { ...record, sourceProfile: { ...profile, pipelinePath: '.ci/development-staff.pipeline.json' } };
  const staffEnv = { ...env, LUNCHLINEUP_BROWSER_COHORT: 'staff' };
  assert.equal(reader({ record: staffRecord }).read(options, staffEnv).pipelinePath, staffRecord.sourceProfile.pipelinePath);
  assert.throws(() => reader({ record: staffRecord }).read(options, env));
  assert.throws(() => reader().read(options, staffEnv));
  for (const cohort of ['', 'unknown', 'staff,full']) assert.throws(() => reader({ record: staffRecord }).read(options, { ...staffEnv, LUNCHLINEUP_BROWSER_COHORT: cohort }));
  assert.throws(() => reader({ record: { ...record, sourceProfile: { ...profile, pipelinePath: '.ci/arbitrary.pipeline.json' } } }).read(options, staffEnv));
  const contextOptions = { contextPath: `${temporary}/lunchlineup-source-${run}/source-context.json` };
  assert.equal(reader().read(contextOptions, env).sourceSha, profile.sourceSha);
  assert.throws(() => reader().read({ contextPath: '/wrong' }, env));
  assert.throws(() => reader().read({ ...contextOptions, arbitrary: true }, env));
  const context = { ...proof, kind: 'lunchlineup-internal-ci-source-context' };
  assert.equal(verifyInternalCiSourceContextIdentity(context, { commitSha: profile.sourceSha, runId: run }, { expectedSource: selected }), context);
  assert.throws(() => verifyInternalCiSourceContextIdentity(context, { commitSha: profile.sourceSha, runId: run }));
  const writer = readFileSync(new URL('../../scripts/write-internal-beta-qualification-env.mjs', import.meta.url), 'utf8');
  assert.match(writer, /readFixedBrowserSourceProfile\(\{contextPath:resolve\(sourceContext\)\}\)/);
  assert.match(writer, /readInternalCiSourceContext\(resolve\(sourceContext\),\{expectedSource\}\)/);
  assert.deepEqual({ ...selected }, profile);
  assert.throws(() => verifyInternalCiSourceSelection(proof), /Source selection mismatch/);
  assert.equal(verifyInternalCiSourceSelection(proof, selected).sourceSha, profile.sourceSha);
  assert.equal(verifyInternalCiSourceProof(proof, proof, { expectedSource: selected }), proof);
  for (const key of ['sourceSha', 'treeSha', 'baselineSha', 'baselineTreeSha', 'pipelineSha256', 'sourceRef']) assert.throws(() => verifyInternalCiSourceSelection({ ...proof, [key]: 'bad' }, selected), /Source selection mismatch/);
  assert.equal(reader({ absent: true }).read(options, env), undefined);
  assert.equal(reader().read(options, {}), undefined);
  for (const change of [
    { file: { uid: 999 } }, { file: { nlink: 2 } }, { file: { mode: 0o100644 } }, { file: { isFile: () => false } }, { file: { size: 8193 } },
    { parent: { uid: 999 } }, { parent: { mode: 0o40775 } }, { parent: { isSymbolicLink: () => true } }, { noncanonical: true },
    { openError: true }, { after: { ino: 3 } }, { named: { ino: 3 } }, { named: { isSymbolicLink: () => true } },
    { record: { ...record, runId: 'other' } }, { record: { ...record, extra: true } }, { record: { ...record, sourceProfile: { ...profile, pipelinePath: '.ci/development-qa.pipeline.json' } } },
  ]) assert.throws(() => reader(change).read(options, env));
  for (const key of Object.keys(env)) assert.throws(() => reader().read(options, { ...env, [key]: 'wrong' }));
  for (const key of Object.keys(options)) assert.throws(() => reader().read({ ...options, [key]: key === 'requireClean' ? false : '/wrong' }, env));
  const cli = readFileSync(new URL('../../scripts/verify-internal-ci-source-clone.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const expectedSource = readFixedBrowserSourceProfile\(selected\);/);
  assert.match(cli, /verifyInternalCiSourceClone\(\{ \.\.\.selected, expectedSource \}\)/);
  for (const script of ['install-internal-ci-dependencies.sh', 'run-development-browser-qa.sh']) assert.match(readFileSync(new URL(`../../scripts/${script}`, import.meta.url), 'utf8'), /verify-internal-ci-source-clone\.mjs.*--purpose build --require-clean/);
});
