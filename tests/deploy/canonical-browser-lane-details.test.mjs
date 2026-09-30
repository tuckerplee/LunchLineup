// Pure synthetic source characterization. No real database, browser or network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDevelopmentBrowserReport } from '../../scripts/verify-development-browser-report.mjs';
import { verifyInteractionProofReport } from '../../apps/web/tests/e2e/verify-internal-beta-interaction-proof.mjs';
const home=dirname(fileURLToPath(import.meta.url));
const repoRoot=resolve(home,'../..');
const proposal=repoRoot;
const createdFixtures=[];
const sha='a'.repeat(40), tree='b'.repeat(40), run='synthetic-offline-only';
const image='sha256:'+'c'.repeat(64), publicSha='d'.repeat(64);
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const write=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const scopes=[['canonical-baseline','development-browser-cases.json','fullstack'],
  ['interaction-proof-artifacts','development-browser-cases.json','interaction'],
  ['canonical-logout','development-logout-cases.json','fullstack'],
  ['canonical-staff','development-staff-cases.json','fullstack']];
function reportFor(rows,order){
  const config={workers:1,forbidOnly:true,shard:null,webServer:null,projects:[...new Set(rows.map(r=>r.project))].map(name=>({id:name,name,retries:0,repeatEach:1}))};
  const suites=[];
  rows.forEach((row,index)=>{
    let children=suites,parent;
    for(const title of row.titlePath.slice(0,-1)){
      parent=children.find(s=>s.title===title);
      if(!parent){parent={title,specs:[],suites:[]};children.push(parent);}
      children=parent.suites;
    }
    parent.specs.push({id:`case-${index}`,title:row.titlePath.at(-1),file:row.file,ok:true,tags:['full-stack'],
      tests:[{projectId:row.project,projectName:row.project,expectedStatus:'passed',annotations:[],results:[],status:'skipped'}]});
  });
  const selection={config,errors:[],stats:{expected:0,skipped:rows.length,unexpected:0,flaky:0},suites};
  const report=structuredClone(selection);
  const base=Date.parse('2026-09-30T00:00:00.000Z')+order*60000;
  report.stats={startTime:new Date(base).toISOString(),duration:rows.length*1000,expected:rows.length,skipped:0,unexpected:0,flaky:0};
  report.config.metadata={actualWorkers:1};
  let index=0,project,worker=-1;
  function fill(nodes){for(const suite of nodes){for(const spec of suite.specs){const t=spec.tests[0];if(t.projectName!==project){project=t.projectName;worker++;}
    t.status='expected';t.results=[{status:'passed',retry:0,workerIndex:worker,parallelIndex:0,errors:[],annotations:[],startTime:new Date(base+index++*1000).toISOString(),duration:500}];}
    fill(suite.suites);}}
  fill(report.suites);return {selection,report};
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'lunchlineup-canonical-helper-unit-')),build=join(dir,'build'),root=join(dir,'evidence');
  createdFixtures.push(dir);
  mkdirSync(join(build,'.ci'),{recursive:true});mkdirSync(root);
  const release={sourceSha:sha,runId:run,treeSha:tree,images:{web:{localImageId:image}},services:{web:{imageArtifact:'web'}},publicBuildConfig:{sha256:publicSha}};
  write(join(root,'release-manifest.json'),release);
  scopes.forEach(([scope,file,lane],order)=>{
    const manifestPath=join(build,'.ci',file);copyFileSync(join(proposal,'.ci',file),manifestPath);
    const manifest=read(manifestPath),p=join(root,scope);mkdirSync(p);
    const {selection,report}=reportFor(manifest.lanes[lane],order);
    let mediaIndex=0;
    const attach=nodes=>{for(const suite of nodes){for(const spec of suite.specs){const index=mediaIndex++,result=spec.tests[0].results[0];result.attachments=[];
      const required=[['trace','application/zip','zip'],['screenshot','image/png','png'],...(lane==='interaction'?[['video','video/webm','webm']]:[])];
      for(const [name,contentType,extension] of required){const media=join(p,`synthetic-${index}-${name}.${extension}`);writeFileSync(media,'synthetic offline media fixture');result.attachments.push({name,contentType,path:media});}
    }attach(suite.suites);}};attach(report.suites);
    report.config.metadata={...report.config.metadata,candidateSha:sha,candidateTreeSha:tree,releaseManifestSha256:digest(join(root,'release-manifest.json')),webImageId:image,publicBuildConfigSha256:publicSha};
    write(join(p,'selection.json'),selection);write(join(p,'results.json'),report);
    const verified=verifyDevelopmentBrowserReport(manifest,lane,selection,report);
    write(join(p,'acceptance-proof.json'),{...verified,candidateSha:sha,runId:run,
      manifestSha256:digest(manifestPath),selectionSha256:digest(join(p,'selection.json')),reportSha256:digest(join(p,'results.json'))});
  });
  const canonical=verifyInteractionProofReport(read(join(root,'interaction-proof-artifacts/results.json')),sha,{candidateTreeSha:tree,releaseManifestSha256:digest(join(root,'release-manifest.json')),webImageId:image,publicBuildConfigSha256:publicSha});
  canonical.playwrightReportSha256=digest(join(root,'interaction-proof-artifacts/results.json'));write(join(root,'interaction-proof.json'),canonical);
  return {dir,build,root,output:join(root,'details.json')};
}
function execute(f){const r=spawnSync(process.execPath,[join(repoRoot,'scripts/write-internal-beta-browser-lane-details.mjs'),f.build,f.root,sha,run,f.output],{encoding:'utf8',timeout:10000});assert.equal(Number.isInteger(r.status),true,r.error?.message??r.stderr);return r;}
function mutate(f,file,change){const p=join(f.root,file),v=read(p);change(v);write(p,v);}
test('canonical cohort receipt enforces exact proof semantics, run identity, lifetimes and real owned media', t=>{
  t.after(()=>{for(const dir of createdFixtures){assert.ok(dir.startsWith(join(tmpdir(),'lunchlineup-canonical-helper-unit-')));rmSync(dir,{recursive:true});}});
const results=[];
let f=fixture(),r=execute(f);assert.equal(r.status,0,r.stderr);assert.equal(read(f.output).passed,42);assert.equal(read(f.output).mediaEvidence.length,99);
for(const item of read(f.output).mediaEvidence){const payload=join(f.root,item.path);assert.equal(readFileSync(payload).length,item.bytes);assert.equal(digest(payload),item.sha256);}results.push({case:'synthetic valid four-scope fixture',observed:'accepted',expected:true});
for(const [name,file,change] of [
 ['wrong release source','release-manifest.json',v=>{v.sourceSha='e'.repeat(40);}],
 ['wrong supporting run','canonical-staff/acceptance-proof.json',v=>{v.runId='another-run';}],
 ['wrong report digest','canonical-logout/acceptance-proof.json',v=>{v.reportSha256='e'.repeat(64);}],
 ['wrong interaction tree','interaction-proof.json',v=>{v.candidateTreeSha='e'.repeat(40);}],
 ['wrong interaction image','interaction-proof.json',v=>{v.webImageId='sha256:'+'e'.repeat(64);}],
 ['wrong public config binding','interaction-proof.json',v=>{v.publicBuildConfigSha256='e'.repeat(64);}],
 ['wrong release manifest digest','interaction-proof.json',v=>{v.releaseManifestSha256='e'.repeat(64);}],
 ['hidden global teardown error','canonical-staff/results.json',v=>{v.errors.push({message:'failed teardown'});}],
 ['incomplete passing stats','canonical-staff/results.json',v=>{v.stats.expected=7;}],
]){
 f=fixture();mutate(f,file,change);r=execute(f);assert.notEqual(r.status,0,name);results.push({case:name,observed:'rejected',expected:true});
}
// Move every Staff time together, preserving internally valid single-lane intervals.
f=fixture();mutate(f,'canonical-staff/results.json',v=>{
 const offset=-180000;v.stats.startTime=new Date(Date.parse(v.stats.startTime)+offset).toISOString();
 const visit=nodes=>{for(const s of nodes){for(const spec of s.specs)for(const t of spec.tests)for(const a of t.results)a.startTime=new Date(Date.parse(a.startTime)+offset).toISOString();visit(s.suites);}};visit(v.suites);
});
mutate(f,'canonical-staff/acceptance-proof.json',v=>{v.reportSha256=digest(join(f.root,'canonical-staff/results.json'));});
r=execute(f);assert.notEqual(r.status,0,'out-of-order cohort');results.push({case:'internally valid but reordered Staff lifetime',observed:'rejected',expected:true});
// Characterize missing containment: preserve exact bytes via an out-of-root symlink.
f=fixture();let path=join(f.root,'canonical-staff/results.json'),external=join(f.dir,'outside-evidence-results.json');copyFileSync(path,external);unlinkSync(path);symlinkSync(external,path);
r=execute(f);assert.notEqual(r.status,0,r.stderr);results.push({case:'out-of-evidence-root symlink report',observed:'rejected',expected:true});
// Characterize scope of image binding: all declarations agree, malformed image accepted.
f=fixture();mutate(f,'release-manifest.json',v=>{v.images.web.localImageId='not-an-image-digest';});
mutate(f,'interaction-proof.json',v=>{v.webImageId='not-an-image-digest';v.releaseManifestSha256=digest(join(f.root,'release-manifest.json'));});
r=execute(f);assert.notEqual(r.status,0,r.stderr);results.push({case:'mutually consistent malformed image identity',observed:'rejected',expected:true});
for(const [name,file,change] of [
 ['missing interaction metadata','interaction-proof-artifacts/results.json',v=>{delete v.config.metadata.webImageId;}],
 ['forged canonical case inventory','interaction-proof.json',v=>{v.cases={};}],
 ['forged canonical artifact policy','interaction-proof.json',v=>{v.artifactPolicy.trace='off';}],
 ['mutually consistent malformed public config','release-manifest.json',v=>{v.publicBuildConfig.sha256='invalid';}],
]){
 f=fixture();mutate(f,file,change);
 if(file.endsWith('results.json'))mutate(f,'interaction-proof-artifacts/acceptance-proof.json',v=>{v.reportSha256=digest(join(f.root,file));});
 if(name==='mutually consistent malformed public config')mutate(f,'interaction-proof.json',v=>{v.publicBuildConfigSha256='invalid';v.releaseManifestSha256=digest(join(f.root,'release-manifest.json'));});
 r=execute(f);assert.notEqual(r.status,0,name);results.push({case:name,observed:'rejected',expected:true});
}
f=fixture();f.output=join(f.dir,'outside-output.json');r=execute(f);assert.notEqual(r.status,0,'output escape');results.push({case:'out-of-evidence output',observed:'rejected',expected:true});
f=fixture();path=join(f.root,'canonical-staff/results.json');external=join(f.root,'identical-report.json');copyFileSync(path,external);unlinkSync(path);symlinkSync(external,path);
r=execute(f);assert.notEqual(r.status,0,'internal symlink');results.push({case:'in-root report symlink',observed:'rejected',expected:true});
f=fixture();path=join(f.build,'.ci/development-staff-cases.json');external=join(f.dir,'outside-manifest.json');copyFileSync(path,external);unlinkSync(path);symlinkSync(external,path);
r=execute(f);assert.notEqual(r.status,0,'source manifest symlink');results.push({case:'out-of-source manifest symlink',observed:'rejected',expected:true});
for(const [name,change] of [
 ['contradictory passed false',v=>{v.passed=false;}],['wrong supporting lane',v=>{v.lane='interaction';}],
 ['wrong supporting count',v=>{v.executed=7;}],['wrong supporting cases',v=>{v.cases=[];}],
]){f=fixture();mutate(f,'canonical-staff/acceptance-proof.json',change);r=execute(f);assert.notEqual(r.status,0,name);results.push({case:name,observed:'rejected',expected:true});}
f=fixture();mutate(f,'release-manifest.json',v=>{v.runId='foreign-run';});r=execute(f);assert.notEqual(r.status,0,'foreign release run');results.push({case:'foreign-run release manifest for same source',observed:'rejected',expected:true});
function firstAttempt(f,scope,change){mutate(f,scope+'/results.json',v=>{let first;const visit=nodes=>{for(const s of nodes){if(s.specs.length&&!first)first=s.specs[0].tests[0].results[0];visit(s.suites);}};visit(v.suites);change(first);});mutate(f,scope+'/acceptance-proof.json',v=>{v.reportSha256=digest(join(f.root,scope,'results.json'));});}
for(const [name,scope,change] of [
 ['missing interaction video','interaction-proof-artifacts',a=>{a.attachments=a.attachments.filter(x=>x.name!=='video');}],
 ['missing interaction screenshot','interaction-proof-artifacts',a=>{a.attachments=a.attachments.filter(x=>x.name!=='screenshot');}],
 ['missing native trace','canonical-staff',a=>{a.attachments=a.attachments.filter(x=>x.name!=='trace');}],
 ['wrong media type','interaction-proof-artifacts',a=>{a.attachments.find(x=>x.name==='trace').contentType='application/octet-stream';}],
]){f=fixture();firstAttempt(f,scope,change);r=execute(f);assert.notEqual(r.status,0,name);results.push({case:name,observed:'rejected',expected:true});}
f=fixture();writeFileSync(join(f.root,'canonical-staff/synthetic-0-trace.zip'),'');r=execute(f);assert.notEqual(r.status,0,'empty media');results.push({case:'empty native trace file',observed:'rejected',expected:true});
f=fixture();path=join(f.root,'canonical-staff/synthetic-0-trace.zip');external=join(f.dir,'outside-trace.zip');copyFileSync(path,external);unlinkSync(path);symlinkSync(external,path);r=execute(f);assert.notEqual(r.status,0,'symlink media');results.push({case:'escaped trace symlink',observed:'rejected',expected:true});
f=fixture();firstAttempt(f,'canonical-staff',a=>{a.attachments.find(x=>x.name==='trace').path=join(f.root,'canonical-baseline/synthetic-0-trace.zip');});r=execute(f);assert.notEqual(r.status,0,'foreign cohort media');results.push({case:'trace from earlier fixture cohort',observed:'rejected',expected:true});

assert.equal(results.length,32);assert.ok(results.every(item=>item.expected));
});
