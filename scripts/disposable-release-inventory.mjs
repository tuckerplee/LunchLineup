import { validateDeploymentContractBundle } from './validate-deployment-contract-bundle.mjs';
import { validateRetainedDeploymentContract, snapshotDeploymentContractJson } from './write-deployment-contract.mjs';
import { validatePrivateTargetProfile } from './private-target-profile.mjs';
// Offline definition only: caller supplies independent expectations, not acceptance authority.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { selectInternalCiSourceProfile } from './internal-ci-source-context.mjs';
import { stableJson, readRegularEvidenceSnapshot, sha256File, statRegularEvidenceFile, sortedDirectoryInventory } from './internal-ci-evidence.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const equal=(a,b)=>stableJson(a)===stableJson(b);
const digest=b=>createHash('sha256').update(b).digest('hex');
const pathName=p=>typeof p==='string' && /^[^\\\0]+$/.test(p) && !p.startsWith('/') && !p.split('/').some(x=>!x||x==='.'||x==='..');
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);

async function validateInventory({ evidenceRoot, manifestPath, artifactManifestPath,
 expectedSource, expectedRunId, expectedPrivateTargetProfile, expectedRuntimeContract, expectedCompose, expectedDeploymentContract }) {
 const profile=selectInternalCiSourceProfile(expectedSource);
 need(profile.version===2,'Explicit disposable source selection required.');
 need(expectedDeploymentContract!==undefined,'Independent deployment contract required.');
 const expectedSchemaContract=snapshotDeploymentContractJson(expectedDeploymentContract);
 validateRetainedDeploymentContract(expectedSchemaContract);

 need(typeof expectedRunId==='string' && /^[A-Za-z0-9._-]+$/.test(expectedRunId),'Independent run ID required.');
 const privateTarget=validatePrivateTargetProfile(expectedPrivateTargetProfile),expectedPrivateTarget=privateTarget.binding;
 need(object(expectedRuntimeContract?.services) && object(expectedCompose?.services),'Independent runtime and Compose expectations required.');
 const manifestBytes=readRegularEvidenceSnapshot(manifestPath,evidenceRoot).bytes;
 const artifactBytes=readRegularEvidenceSnapshot(artifactManifestPath,evidenceRoot).bytes;
 const manifest=JSON.parse(manifestBytes),artifact=JSON.parse(artifactBytes);
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
 async function bound(claim,json=false){
  need(object(claim) && pathName(claim.path),'Invalid evidence claim.');
  const item=files.get(claim.path);need(item && item.sha256===claim.sha256 && (claim.bytes===undefined||claim.bytes===item.bytes),'Unbound evidence claim.');
  const path=resolve(evidenceRoot,claim.path),observed=statRegularEvidenceFile(path,evidenceRoot);
  need(observed.path===claim.path && observed.bytes===item.bytes,'Evidence path/size differs.');
  if(json){const snapshot=readRegularEvidenceSnapshot(path,evidenceRoot);need(snapshot.bytes.length===item.bytes && digest(snapshot.bytes)===item.sha256,'JSON evidence bytes differ.');return JSON.parse(snapshot.bytes);}
  need(await sha256File(path,evidenceRoot)===item.sha256,'Archive bytes differ.');
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
 const schemaSnapshot=readRegularEvidenceSnapshot(resolve(evidenceRoot,schemaClaim.path),evidenceRoot);
 need(schemaSnapshot.path===schemaClaim.path && schemaSnapshot.bytes.length===schemaClaim.bytes && digest(schemaSnapshot.bytes)===schemaClaim.sha256,'Actual schema bundle bytes differ.');
 const schemaValidation=validateDeploymentContractBundle(schemaContract,schemaSnapshot.bytes);
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
 const actualArchives=sortedDirectoryInventory(resolve(evidenceRoot,'images')).filter(x=>x.path.endsWith('.tar.gz')).map(x=>'images/'+x.path).sort();
 need(equal([...archives].sort(),listedArchives) && equal([...archives].sort(),actualArchives),'Unreferenced or missing archive.');
 const summary={kind:'disposable-release-inventory-validation',deploymentContractBundleSha256:schemaValidation.bundleSha,deploymentContractFileCount:schemaValidation.materializedFiles.size,sourceProfile:profile,runId:expectedRunId,manifestSha256:digest(manifestBytes),artifactManifestSha256:digest(artifactBytes),serviceCount:names.length,imageCount:refs.size,acceptance:false,admission:false};
 return {summary,images:manifest.images,services:manifest.services};
}

export async function validateDisposableReleaseInventory(options) {
 return (await validateInventory(options)).summary;
}

export async function validateDisposableReleaseInventoryDescriptors(options) {
 const result=await validateInventory(options);
 const freeze=value=>{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
 return freeze(result);
}
