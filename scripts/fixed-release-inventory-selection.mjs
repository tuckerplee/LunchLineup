// Source interface only. No CLI, publisher, installation or dispatch registration.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { selectInternalCiSourceProfile } from './internal-ci-source-context.mjs';
import { snapshotDeploymentContractJson, validateRetainedDeploymentContract } from './write-deployment-contract.mjs';
import { validatePrivateTargetProfile } from './private-target-profile.mjs';
import { stableJson } from './internal-ci-evidence.mjs';
import { validateDisposableReleaseInventoryFromFds } from './disposable-release-inventory.mjs';
export const RELEASE_INVENTORY_HARD_MAX = 64 * 1024 * 1024;
const AUTHORITY = '/etc/custom-ci/disposable-release-inventory-authority.json';
const OPERATION = 'validate-inventory-and-retained-schema';
const PINS = ['controllerCommit','controllerTree','entrypointSha256','nodeSha256','receiveIntentSha256'];
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const exact=(v,keys)=>v!==null && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(key=>Object.hasOwn(v,key));
const equal=(a,b)=>stableJson(a)===stableJson(b);
const positive=n=>Number.isSafeInteger(n)&&n>0;
const sha=(s,n)=>typeof s==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(s);
const digest=b=>createHash('sha256').update(b).digest('hex');
const scope={inventory:true,retainedSchema:true,runtimeConfiguration:false,acceptance:false,admission:false,qualification:false};
function protectedBytes(path,mode,maximum) {
 need(positive(maximum)&&maximum<=RELEASE_INVENTORY_HARD_MAX,'Invalid independent read bound.');
 need(typeof path==='string'&&resolve(path)===path,'Noncanonical protected path.');
 for(let p=dirname(path);;p=dirname(p)){
  const s=lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022)&&realpathSync(p)===p,'Unprotected authority ancestor.');if(p==='/')break;
 }
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const first=fstatSync(fd);need(first.isFile()&&first.uid===0&&first.gid===0&&first.nlink===1&&(first.mode&0o7777)===mode&&first.size>0&&first.size<=maximum,'Protected record custody differs.');
  const bytes=Buffer.alloc(first.size);let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);need(count>0,'Truncated protected record.');offset+=count;}
  const last=fstatSync(fd),named=lstatSync(path),keys=['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'];
  need(!named.isSymbolicLink()&&keys.every(k=>first[k]===last[k]&&first[k]===named[k]),'Protected record changed.');
  return bytes;
 }finally{closeSync(fd);}
}
// Executable custody uses exact independently selected length and bounded chunks,
// not the JSON parser ceiling. This reads a selected file, not process identity.
function executableDigest(path,mode,expectedBytes) {
 need(positive(expectedBytes)&&typeof path==='string'&&resolve(path)===path,'Invalid executable custody input.');
 for(let p=dirname(path);;p=dirname(p)){
  const s=lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022)&&realpathSync(p)===p,'Unprotected executable ancestor.');if(p==='/')break;
 }
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const first=fstatSync(fd);need(first.isFile()&&first.uid===0&&first.gid===0&&first.nlink===1&&(first.mode&0o7777)===mode&&first.size===expectedBytes,'Executable custody differs.');
  const hash=createHash('sha256'),chunk=Buffer.alloc(65536);let remaining=expectedBytes;
  while(remaining){const count=readSync(fd,chunk,0,Math.min(chunk.length,remaining),null);need(count>0,'Executable truncated.');hash.update(chunk.subarray(0,count));remaining-=count;}
  const last=fstatSync(fd),named=lstatSync(path),keys=['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'];
  need(!named.isSymbolicLink()&&keys.every(k=>first[k]===last[k]&&first[k]===named[k]),'Executable changed.');return hash.digest('hex');
 }finally{closeSync(fd);}
}
export function validateReleaseInventoryAuthority(input){
 const a=snapshotDeploymentContractJson(input);
 need(exact(a,['version','kind','operation',...PINS,'entrypointPath','nodePath','entrypointBytes','nodeBytes','sourceProfile'])&&a.version===1&&a.kind==='lunchlineup-disposable-release-inventory-authority'&&a.operation===OPERATION,'Invalid independent authority schema.');
 for(const k of PINS)need(sha(a[k],k==='controllerCommit'||k==='controllerTree'?40:64),'Invalid authority pin.');
 for(const k of ['entrypointPath','nodePath'])need(typeof a[k]==='string'&&a[k].startsWith('/')&&resolve(a[k])===a[k],'Invalid executable authority path.');
 for(const k of ['entrypointBytes','nodeBytes'])need(positive(a[k]),'Exact executable byte length required.');
 selectInternalCiSourceProfile(a.sourceProfile);return a;
}
export function validateReleaseInventorySelection(input,authority,nowEpoch){
 const a=validateReleaseInventoryAuthority(authority),r=snapshotDeploymentContractJson(input);
 need(exact(r,['version','kind','operation','runId','sourceProfile','authority','paths','expectations','inputPins','envelope','scope'])&&r.version===1&&r.kind==='lunchlineup-disposable-release-inventory-selection'&&r.operation===OPERATION,'Invalid selection schema.');
 need(typeof r.runId==='string'&&/^[0-9]{8}T[0-9]{6}Z-lunchlineup-[a-f0-9]{8}-[a-f0-9]{6}$/.test(r.runId),'Invalid release run.');
 need(exact(r.authority,PINS)&&PINS.every(k=>r.authority[k]===a[k])&&equal(selectInternalCiSourceProfile(r.sourceProfile),a.sourceProfile),'Independent authority differs.');
 need(exact(r.paths,['evidenceRoot','manifest','artifactManifest'])&&r.paths.evidenceRoot===`/var/lib/custom-ci/release-inventory/${r.runId}/inputs`&&r.paths.manifest==='release-manifest.json'&&r.paths.artifactManifest==='artifact-manifest.json','Fixed release paths differ.');
 need(exact(r.expectations,['privateTargetProfile','runtimeContract','compose','deploymentContract']),'Expectation roster differs.');
 validatePrivateTargetProfile(r.expectations.privateTargetProfile);validateRetainedDeploymentContract(r.expectations.deploymentContract);
 for(const k of ['runtimeContract','compose'])need(r.expectations[k]!==null&&typeof r.expectations[k]==='object'&&!Array.isArray(r.expectations[k])&&r.expectations[k].services!==null&&typeof r.expectations[k].services==='object'&&!Array.isArray(r.expectations[k].services),'Missing service expectation.');
 need(exact(r.inputPins,['manifest','artifactManifest']),'Input pin roster differs.');
 for(const v of Object.values(r.inputPins))need(exact(v,['bytes','sha256'])&&positive(v.bytes)&&sha(v.sha256,64),'Invalid input pin.');
 const e=r.envelope;need(exact(e,['issuedEpoch','expiresEpoch','maxInputBytes','maxInputFiles','maxResultBytes'])&&Object.values(e).every(positive)&&e.issuedEpoch<e.expiresEpoch&&e.maxResultBytes<RELEASE_INVENTORY_HARD_MAX,'Invalid finite envelope.');
 need(Number.isFinite(nowEpoch)&&nowEpoch>=e.issuedEpoch&&nowEpoch<e.expiresEpoch,'Selection outside original window.');
 need(equal(r.scope,scope),'Selection scope differs.');return r;
}
// The future owner supplies a lower record-read bound independently of its contents.
export function readFixedReleaseInventorySelection(runId,maximumRecordBytes){
 need(typeof runId==='string'&&/^[0-9]{8}T[0-9]{6}Z-lunchlineup-[a-f0-9]{8}-[a-f0-9]{6}$/.test(runId),'Invalid run selector.');
 need(positive(maximumRecordBytes)&&maximumRecordBytes<RELEASE_INVENTORY_HARD_MAX,'Independent lower read bound required.');
 const authorityBytes=protectedBytes(AUTHORITY,0o600,RELEASE_INVENTORY_HARD_MAX),authority=validateReleaseInventoryAuthority(JSON.parse(authorityBytes));
 // Executable bytes are checked, but imported closure custody remains a separate
 // prerequisite of future installed owner admission; these checks do not supply it.
 for(const [pathKey,pinKey,sizeKey,mode] of [['entrypointPath','entrypointSha256','entrypointBytes',0o444],['nodePath','nodeSha256','nodeBytes',0o755]])need(executableDigest(authority[pathKey],mode,authority[sizeKey])===authority[pinKey],'Executable bytes differ.');
 const path=`/var/lib/custom-ci/release-inventory/${runId}/selection.json`,selectionBytes=protectedBytes(path,0o444,maximumRecordBytes),selection=validateReleaseInventorySelection(JSON.parse(selectionBytes),authority,Date.now()/1000);
 need(selection.runId===runId,'Run selector differs.');
 return {authority,selection,authoritySha256:digest(authorityBytes),selectionSha256:digest(selectionBytes),installedAdmission:false};
}

// Pure semantic join only. The caller must supply one independently authenticated
// owner context; this function does not install or establish that custody.
export async function validateSelectedDisposableReleaseInventoryFromFds(input) {
 const active=new Set();
 function inspect(value){
  if(value===null||typeof value!=='object')return;
  need(!active.has(value),'Cyclic selected held-input data.');active.add(value);
  if(Array.isArray(value))need(Object.getPrototypeOf(value)===Array.prototype,'Custom array prototype rejected.');
  for(const key of Reflect.ownKeys(value)){
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   need(Object.hasOwn(descriptor,'value'),'Selected held-input accessors rejected.');
   inspect(descriptor.value);
  }
  active.delete(value);
 }
 inspect(input);
 const copied=snapshotDeploymentContractJson(input);
 need(exact(copied,['authority','selection','borrowedFds','expectedInputPins','limits']),'Exact selected held-input arguments required.');
 const selected=validateReleaseInventorySelection(copied.selection,copied.authority,Date.now()/1000);
 const limits=copied.limits;
 need(exact(limits,['maxFiles','maxFileBytes','maxInputBytes','maxJsonBytes','maxResultBytes','issuedEpoch','expiresEpoch'])&&Object.values(limits).every(positive),'Explicit lower held-input limits required.');
 need(limits.issuedEpoch===selected.envelope.issuedEpoch&&limits.expiresEpoch===selected.envelope.expiresEpoch,'Original selected window differs.');
 need(limits.maxFiles<=selected.envelope.maxInputFiles&&limits.maxInputBytes<=selected.envelope.maxInputBytes&&limits.maxResultBytes<=selected.envelope.maxResultBytes,'Held-input limits exceed selected envelope.');
 need(limits.maxFileBytes<=limits.maxInputBytes&&limits.maxJsonBytes<=limits.maxFileBytes&&limits.maxJsonBytes<=RELEASE_INVENTORY_HARD_MAX,'Held-input limit hierarchy differs.');
 const pins=copied.expectedInputPins;
 need(pins!==null&&typeof pins==='object'&&!Array.isArray(pins),'Complete independent held-input pins required.');
 for(const key of ['manifest','artifactManifest']){
  const name=selected.paths[key],pin=pins[name],expected=selected.inputPins[key];
  need(Object.hasOwn(pins,name)&&pin!==null&&typeof pin==='object'&&!Array.isArray(pin)&&pin.bytes===expected.bytes&&pin.sha256===expected.sha256,'Selected bootstrap pin differs.');
 }
 return validateDisposableReleaseInventoryFromFds({
  manifestPath:selected.paths.manifest,artifactManifestPath:selected.paths.artifactManifest,
  borrowedFds:copied.borrowedFds,expectedInputPins:pins,limits,
  expectedSource:selected.sourceProfile,expectedRunId:selected.runId,
  expectedPrivateTargetProfile:selected.expectations.privateTargetProfile,
  expectedRuntimeContract:selected.expectations.runtimeContract,
  expectedCompose:selected.expectations.compose,
  expectedDeploymentContract:selected.expectations.deploymentContract
 });
}
