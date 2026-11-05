import { validateDeploymentContractBundle } from './validate-deployment-contract-bundle.mjs';
import { validateRetainedDeploymentContract, snapshotDeploymentContractJson } from './write-deployment-contract.mjs';
import { validatePrivateTargetProfile } from './private-target-profile.mjs';
// Offline definition only: caller supplies independent expectations, not acceptance authority.
import { createHash } from 'node:crypto';
import { fstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectInternalCiSourceProfile } from './internal-ci-source-context.mjs';
import { stableJson, readRegularEvidenceSnapshot, sha256File, statRegularEvidenceFile, sortedDirectoryInventory } from './internal-ci-evidence.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const equal=(a,b)=>stableJson(a)===stableJson(b);
const digest=b=>createHash('sha256').update(b).digest('hex');
const pathName=p=>typeof p==='string' && /^[^\\\0]+$/.test(p) && !p.startsWith('/') && !p.split('/').some(x=>!x||x==='.'||x==='..');
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);

// Private adapters: public pathname callers cannot inject a reader.
function pathReader(evidenceRoot) {
 return {
  check(){}, roster(){}, finish(){},
  snapshot(path){return readRegularEvidenceSnapshot(path,evidenceRoot);},
  claimSnapshot(path){return readRegularEvidenceSnapshot(resolve(evidenceRoot,path),evidenceRoot);},
  stat(path){return statRegularEvidenceFile(resolve(evidenceRoot,path),evidenceRoot);},
  hash(path){return sha256File(resolve(evidenceRoot,path),evidenceRoot);},
  archives(){return sortedDirectoryInventory(resolve(evidenceRoot,'images')).filter(x=>x.path.endsWith('.tar.gz')).map(x=>'images/'+x.path).sort();}
 };
}

function heldReader(options) {
 const {borrowedFds,expectedInputPins:pins,limits,manifestPath,artifactManifestPath}=options;
 const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 need(exact(limits,['maxFiles','maxFileBytes','maxInputBytes','maxJsonBytes','maxResultBytes','issuedEpoch','expiresEpoch']),'Exact held-input limits required.');
 for(const value of Object.values(limits))need(Number.isSafeInteger(value)&&value>0,'Positive safe-integer limit required.');
 need(limits.maxFileBytes<=limits.maxInputBytes&&limits.maxJsonBytes<=limits.maxFileBytes&&limits.maxJsonBytes<=64*1024*1024&&limits.maxResultBytes<=64*1024*1024,'Held-input limit hierarchy differs.');
 const entered=Date.now()/1000;
 need(limits.issuedEpoch<limits.expiresEpoch&&entered>=limits.issuedEpoch&&entered<limits.expiresEpoch,'Original held-input window unavailable.');
 const end=process.hrtime.bigint()+BigInt(Math.floor((limits.expiresEpoch-entered)*1e9));
 function check(){const now=Date.now()/1000;need(now>=limits.issuedEpoch&&now<limits.expiresEpoch&&process.hrtime.bigint()<end,'Original held-input deadline elapsed.');}
 const logical=path=>pathName(path)&&path.length<=512&&Buffer.byteLength(path,'utf8')<=512;
 need(logical(manifestPath)&&logical(artifactManifestPath)&&manifestPath!==artifactManifestPath,'Distinct logical bootstrap names required.');
 need(object(pins)&&object(borrowedFds),'Held-input tables required.');
 const names=Object.keys(pins),fdNames=Object.keys(borrowedFds);
 need(names.length>0&&names.length<=limits.maxFiles&&names.length===fdNames.length&&names.every(n=>Object.hasOwn(borrowedFds,n)),'Exact bounded descriptor roster required.');
 const table=new Map(),cases=new Set(),fds=new Set(),identities=new Set();let total=0;
 for(const name of names){
  check();need(logical(name)&&!cases.has(name.normalize('NFC').toLowerCase()),'Unsafe/colliding held-input path.');cases.add(name.normalize('NFC').toLowerCase());
  const pin=pins[name],fd=borrowedFds[name];
  need(exact(pin,['bytes','sha256','veritySha256','device','inode']),'Exact independent held-input pin required.');
  need(Number.isSafeInteger(fd)&&fd>=0&&!fds.has(fd),'Distinct borrowed descriptor required.');fds.add(fd);
  need(Number.isSafeInteger(pin.bytes)&&pin.bytes>=0&&pin.bytes<=limits.maxFileBytes&&['device','inode'].every(k=>Number.isSafeInteger(pin[k])&&pin[k]>=0)&&['sha256','veritySha256'].every(k=>typeof pin[k]==='string'&&/^[a-f0-9]{64}$/.test(pin[k])),'Invalid independent held-input pin.');
  total+=pin.bytes;need(Number.isSafeInteger(total)&&total<=limits.maxInputBytes,'Held-input aggregate bound.');
  const identity=pin.device+':'+pin.inode;need(!identities.has(identity),'Duplicate held-input inode.');identities.add(identity);
  table.set(name,{fd,pin});
 }
 need(table.has(manifestPath)&&table.has(artifactManifestPath),'Missing bootstrap descriptors.');
 const fields=['dev','ino','size','mode','uid','gid','nlink','mtimeNs','ctimeNs'];
 function observe(entry){
  check();const st=fstatSync(entry.fd,{bigint:true});
  need(st.isFile()&&st.uid===0n&&(st.mode&0o022n)===0n&&st.dev===BigInt(entry.pin.device)&&st.ino===BigInt(entry.pin.inode)&&st.size===BigInt(entry.pin.bytes),'Held-input regular/root/pin identity differs.');
  if(entry.identity)need(fields.every(k=>st[k]===entry.identity[k]),'Held-input metadata changed.');
  else entry.identity=Object.fromEntries(fields.map(k=>[k,st[k]]));
  return st;
 }
 // Observe the complete roster only after all count/length/allocation bounds pass.
 for(const entry of table.values())observe(entry);
 function read(name,json=false){
  check();const entry=table.get(name);need(entry,'Missing held-input claim.');observe(entry);
  if(json)need(entry.pin.bytes>0&&entry.pin.bytes<=limits.maxJsonBytes,'Held JSON size bound.');
  if(entry.hash&&(!json||entry.bytes))return entry;
  const bytes=json?Buffer.allocUnsafe(entry.pin.bytes):null;
  const chunk=Buffer.allocUnsafe(Math.min(1024*1024,Math.max(1,entry.pin.bytes))),hash=createHash('sha256');let position=0;
  while(position<entry.pin.bytes){
   check();const count=readSync(entry.fd,chunk,0,Math.min(chunk.length,entry.pin.bytes-position),position);
   need(count>0,'Short held-input read.');hash.update(chunk.subarray(0,count));if(bytes)chunk.copy(bytes,position,0,count);position+=count;
  }
  observe(entry);check();const actual=hash.digest('hex');need(actual===entry.pin.sha256,'Held-input SHA differs.');entry.hash=actual;if(bytes)entry.bytes=bytes;return entry;
 }
 return {
  check,
  snapshot(name){return {path:name,bytes:read(name,true).bytes};},
  claimSnapshot(name){return {path:name,bytes:read(name,true).bytes};},
  stat(name){const entry=table.get(name);need(entry,'Missing held-input claim.');observe(entry);return {path:name,bytes:entry.pin.bytes};},
  hash(name){return read(name).hash;},
  roster(files){
   check();need(!files.has(artifactManifestPath),'Artifact manifest cannot list itself.');
   const union=new Set([manifestPath,artifactManifestPath,...files.keys()]);
   need(union.size===table.size&&[...union].every(n=>table.has(n)),'Complete artifact/bootstrap FD union differs.');
   const collisions=new Set();
   for(const [name,item] of files){
    need(logical(name)&&!collisions.has(name.normalize('NFC').toLowerCase()),'Artifact logical path collision.');collisions.add(name.normalize('NFC').toLowerCase());
    const pin=table.get(name).pin;need(pin.bytes===item.bytes&&pin.sha256===item.sha256,'Artifact/independent pin differs.');
   }
  },
  archives(){return names.filter(n=>n.startsWith('images/')&&n.endsWith('.tar.gz')).sort();},
  finish(result){
   for(const name of names)read(name);
   for(const entry of table.values())observe(entry);
   check();const serialized=stableJson(result);need(Buffer.byteLength(serialized,'utf8')<=limits.maxResultBytes,'Held-input result size bound.');
   for(const entry of table.values())observe(entry);check();
  }
 };
}

async function validateInventory({ evidenceRoot, manifestPath, artifactManifestPath,
 expectedSource, expectedRunId, expectedPrivateTargetProfile, expectedRuntimeContract, expectedCompose, expectedDeploymentContract }, reader=pathReader(evidenceRoot)) {
 reader.check();
 const profile=selectInternalCiSourceProfile(expectedSource);
 need(profile.version===2,'Explicit disposable source selection required.');
 need(expectedDeploymentContract!==undefined,'Independent deployment contract required.');
 const expectedSchemaContract=snapshotDeploymentContractJson(expectedDeploymentContract);
 validateRetainedDeploymentContract(expectedSchemaContract);

 need(typeof expectedRunId==='string' && /^[A-Za-z0-9._-]+$/.test(expectedRunId),'Independent run ID required.');
 const privateTarget=validatePrivateTargetProfile(expectedPrivateTargetProfile),expectedPrivateTarget=privateTarget.binding;
 need(object(expectedRuntimeContract?.services) && object(expectedCompose?.services),'Independent runtime and Compose expectations required.');
 const manifestBytes=reader.snapshot(manifestPath).bytes;
 const artifactBytes=reader.snapshot(artifactManifestPath).bytes;
 reader.check();
 const manifest=JSON.parse(manifestBytes);reader.check();
 const artifact=JSON.parse(artifactBytes);reader.check();
 const actualProfile=selectInternalCiSourceProfile(manifest.sourceProfile);
 need(equal(actualProfile,profile),'All eleven source-profile fields must match.');
 need(manifest.version===2 && manifest.kind==='lunchlineup-internal-ci-release-manifest' && manifest.releaseTarget==='internal-beta' && manifest.runId===expectedRunId,'Manifest identity differs.');
 for(const key of ['repository','sourceRef','sourceSha','treeSha','pipelineSha256'])need(manifest[key]===profile[key],'Manifest/source profile disagreement: '+key);
 need(equal(manifest.privateTarget,expectedPrivateTarget),'Private target differs.');
 need(artifact.version===1 && artifact.kind==='lunchlineup-internal-ci-artifact-manifest' && artifact.sourceSha===profile.sourceSha && artifact.treeSha===profile.treeSha && Array.isArray(artifact.files),'Artifact identity differs.');
 const files=new Map(),casePaths=new Set();let total=0;
 for(const item of artifact.files){
  need(pathName(item.path) && !casePaths.has(item.path.toLowerCase()) && /^[a-f0-9]{64}$/.test(item.sha256??'') && Number.isSafeInteger(item.bytes) && item.bytes>=0 && /^0[0-7]{3}$/.test(item.mode??''),'Invalid/duplicate artifact entry.');
  casePaths.add(item.path.toLowerCase());files.set(item.path,item);total+=item.bytes;need(Number.isSafeInteger(total),'Artifact byte count overflow.');
 }
 const root=digest(Buffer.from([...files.values()].map(x=>`${x.path}\0${x.sha256}\0${x.bytes}\0${x.mode}\n`).join('')));
 need(files.size===artifact.fileCount && total===artifact.totalBytes && root===artifact.rootSha256,'Artifact inventory root differs.');
 reader.roster(files);reader.check();
 async function bound(claim,json=false){
  reader.check();
  need(object(claim) && pathName(claim.path),'Invalid evidence claim.');
  const item=files.get(claim.path);need(item && item.sha256===claim.sha256 && (claim.bytes===undefined||claim.bytes===item.bytes),'Unbound evidence claim.');
  const observed=reader.stat(claim.path);
  need(observed.path===claim.path && observed.bytes===item.bytes,'Evidence path/size differs.');
  if(json){const snapshot=reader.claimSnapshot(claim.path);need(snapshot.bytes.length===item.bytes && digest(snapshot.bytes)===item.sha256,'JSON evidence bytes differ.');reader.check();const parsed=JSON.parse(snapshot.bytes);reader.check();return parsed;}
  need(await reader.hash(claim.path)===item.sha256,'Archive bytes differ.');
 }
 // Preserve insertion order for retention validation before canonical stable equality.
 const schemaContract=manifest.deploymentContract;
 validateRetainedDeploymentContract(schemaContract);
 need(equal(schemaContract,expectedSchemaContract),'Independent full deployment contract differs.');
 const schemaClaim=manifest.deploymentContractArtifact;
 need(object(schemaClaim) && equal(Object.keys(schemaClaim).sort(),['bytes','path','sha256']) && pathName(schemaClaim.path) && /^[a-f0-9]{64}$/.test(schemaClaim.sha256??'') && Number.isSafeInteger(schemaClaim.bytes) && schemaClaim.bytes>0,'Invalid deployment contract artifact claim.');
 need(schemaClaim.sha256===schemaContract.bundle.sha256 && schemaClaim.bytes===schemaContract.bundle.bytes,'Contract/artifact bundle pin differs.');
 const schemaItem=files.get(schemaClaim.path);
 need(schemaItem && schemaItem.sha256===schemaClaim.sha256 && schemaItem.bytes===schemaClaim.bytes,'Schema bundle is not artifact-bound.');
 const schemaSnapshot=reader.claimSnapshot(schemaClaim.path);
 need(schemaSnapshot.path===schemaClaim.path && schemaSnapshot.bytes.length===schemaClaim.bytes && digest(schemaSnapshot.bytes)===schemaClaim.sha256,'Actual schema bundle bytes differ.');
 reader.check();
 const schemaValidation=validateDeploymentContractBundle(schemaContract,schemaSnapshot.bytes);
 reader.check();
 const compose=await bound(manifest.composeConfig,true),publicContract=await bound(manifest.publicBuildConfig?.contract,true);
 need(equal(compose,expectedCompose),'Rendered Compose differs from independent expectation.');
 const names=Object.keys(expectedRuntimeContract.services).sort();
 need(names.length>0 && equal(Object.keys(compose.services??{}).sort(),names) && equal(Object.keys(manifest.services??{}).sort(),names),'Complete service roster differs.');
 const values={NEXT_PUBLIC_API_URL:'/api/v2',NEXT_PUBLIC_APP_ORIGIN:expectedPrivateTarget.origin,NEXT_PUBLIC_APP_URL:expectedPrivateTarget.origin,NEXT_PUBLIC_APP_ENV:'production',NEXT_PUBLIC_SIGNUP_MODE:'closed_beta',NEXT_PUBLIC_OIDC_ENABLED:'false'};
 const publicSha=digest(Buffer.from(stableJson(values)));
 need(equal(manifest.publicBuildConfig?.values,values) && manifest.publicBuildConfig?.sha256===publicSha,'Public build values differ.');
 const expectedPublic={sourceSha:profile.sourceSha,publicBuildConfigSha256:publicSha,nextPublicApiUrl:'/api/v2',nextPublicAppOrigin:expectedPrivateTarget.origin,nextPublicAppUrl:expectedPrivateTarget.origin,nextPublicAppEnv:'production',nextPublicSignupMode:'closed_beta',nextPublicOidcEnabled:'false',nextPublicTurnstileSiteKey:'',nextPublicPrivacyContactEmail:'privacy@lunchlineup.com',nextPublicSupportContactEmail:'support@lunchlineup.com',nextPublicDpaContactEmail:'privacy@lunchlineup.com'};
 need(equal(publicContract,expectedPublic),'Public contract bytes/values differ.');
 need(object(manifest.images) && Object.keys(manifest.images).length>0,'Images missing.');
 const refs=new Set(),archives=new Set(),consumers=new Set();
 for(const [name,image] of Object.entries(manifest.images)){
  need(/^[a-z0-9-]+$/.test(name) && object(image) && typeof image.resolvedRef==='string' && image.resolvedRef.length>0 && !refs.has(image.resolvedRef) && /^sha256:[a-f0-9]{64}$/.test(image.localImageId??''),'Invalid/duplicate image.');refs.add(image.resolvedRef);
  const source=image.resolvedRef.startsWith('lunchlineup-internal-ci/')?'first-party':'third-party';
  need(image.source===source && (source!=='third-party'||/@sha256:[a-f0-9]{64}$/.test(image.resolvedRef)),'Mutable or misclassified image.');
  need(/^images\/[a-z0-9-]+\.tar\.gz$/.test(image.archive?.path??'') && !archives.has(image.archive.path) && Number.isSafeInteger(image.archive.bytes) && image.archive.bytes>0,'Invalid/duplicate archive.');archives.add(image.archive.path);
  await bound(image.archive);
  need(Array.isArray(image.composeServices) && image.composeServices.length>0,'Image consumers missing.');
  for(const service of image.composeServices){
   need(typeof service==='string' && names.includes(service) && !consumers.has(service),'Duplicate/unreferenced consumer.');consumers.add(service);
   const row=manifest.services[service],definition=compose.services[service];
   need(row?.imageArtifact===name && row.resolvedRef===image.resolvedRef && definition.image===image.resolvedRef && row.oneShot===(String(definition.restart??'')==='no') && row.hasHealthCheck===Boolean(definition.healthcheck),'Service/image/Compose disagreement.');
  }
 }
 need(equal([...consumers].sort(),names),'Missing image consumer.');
 const listedArchives=[...files.keys()].filter(x=>x.startsWith('images/')&&x.endsWith('.tar.gz')).sort();
 const actualArchives=reader.archives();
 need(equal([...archives].sort(),listedArchives) && equal([...archives].sort(),actualArchives),'Unreferenced or missing archive.');
 const summary={kind:'disposable-release-inventory-validation',deploymentContractBundleSha256:schemaValidation.bundleSha,deploymentContractFileCount:schemaValidation.materializedFiles.size,sourceProfile:profile,runId:expectedRunId,manifestSha256:digest(manifestBytes),artifactManifestSha256:digest(artifactBytes),serviceCount:names.length,imageCount:refs.size,acceptance:false,admission:false};
 const result={summary,images:manifest.images,services:manifest.services};
 return result;
}

export async function validateDisposableReleaseInventory(options) {
 return (await validateInventory(options)).summary;
}

export async function validateDisposableReleaseInventoryDescriptors(options) {
 const result=await validateInventory(options);
 const freeze=value=>{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 return freeze(result);
}

export async function validateDisposableReleaseInventoryFromFds(options) {
 // Snapshot every independent input before any asynchronous boundary. Verity,
 // read-only access mode and same-OFD custody remain trusted owner obligations.
 const active=new Set();
 function arrayPrototypes(value){
  if(value===null||typeof value!=='object')return;
  need(!active.has(value),'Cyclic held-input options.');active.add(value);
  if(Array.isArray(value))need(Object.getPrototypeOf(value)===Array.prototype,'Custom array prototype rejected.');
  for(const key of Reflect.ownKeys(value)){
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   need(Object.hasOwn(descriptor,'value'),'Held-input accessors rejected.');
   arrayPrototypes(descriptor.value);
  }
  active.delete(value);
 }
 arrayPrototypes(options);
 const copied=snapshotDeploymentContractJson(options);
 const keys=['manifestPath','artifactManifestPath','borrowedFds','expectedInputPins','limits',
  'expectedSource','expectedRunId','expectedPrivateTargetProfile','expectedRuntimeContract',
  'expectedCompose','expectedDeploymentContract'];
 need(object(copied)&&Object.keys(copied).length===keys.length&&keys.every(k=>Object.hasOwn(copied,k)),'Exact held-input options required.');
 const reader=heldReader(copied);
 const result=await validateInventory(copied,reader);
 reader.check();
 const freeze=value=>{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 freeze(result);reader.finish(result);
 return result;
}
