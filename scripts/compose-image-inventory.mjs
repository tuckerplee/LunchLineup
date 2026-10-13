import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInternalCiSourceContext, selectInternalCiSourceProfile } from './internal-ci-source-context.mjs';
import { readRegularEvidenceSnapshot, writeExclusiveJson } from './internal-ci-evidence.mjs';
import { snapshotDeploymentContractJson, validateRetainedDeploymentContract } from './write-deployment-contract.mjs';
import { validatePrivateTargetProfile } from './private-target-profile.mjs';
import { writeInternalCiReleaseManifest } from './write-internal-ci-release-manifest.mjs';

// expectedSource comes from the authenticated caller, never the context JSON.
export async function writeInternalCiComposeImageInventory({ sourceContext, composeConfig, runtimeContract, outputPath, expectedSource, env = process.env }) {
const profile=selectInternalCiSourceProfile(expectedSource);
const context=readInternalCiSourceContext(resolve(sourceContext),{expectedSource:profile.version===2?profile:undefined,env}), composePath=resolve(composeConfig), contractPath=resolve(runtimeContract), output=resolve(outputPath);
if(profile.version===2&&contractPath!==resolve(context.buildSourcePath,'infrastructure/ci/internal-beta-runtime-services.json'))throw new Error('Disposable runtime contract must come from selected source.');
const composeItem=readRegularEvidenceSnapshot(composePath,context.evidenceRoot), contractBytes=readFileSync(contractPath), compose=JSON.parse(composeItem.bytes), contract=JSON.parse(contractBytes); if(!compose.services||contract.version!==1||contract.kind!=='lunchlineup-internal-beta-runtime-services') throw new Error('Invalid Compose inventory inputs.');
const actualNames=Object.keys(compose.services).sort(), expectedNames=Object.keys(contract.services).sort(); if(JSON.stringify(actualNames)!==JSON.stringify(expectedNames)) throw new Error(`Resolved Compose services differ from runtime contract: actual=${actualNames.join(',')} expected=${expectedNames.join(',')}`);
const byRef=new Map(), serviceInventory={}; for(const name of actualNames){const definition=compose.services[name],image=String(definition.image??''); if(!image) throw new Error(`Compose service ${name} has no image.`); const firstParty=image.startsWith('lunchlineup-internal-ci/'); if(firstParty){if(!image.endsWith(`:${context.sourceSha}`)) throw new Error(`First-party image ${image} is not candidate-bound.`);} else if(!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`Third-party image ${image} is mutable.`); const expected=contract.services[name], hasHealth=Boolean(definition.healthcheck), state=expected.state; if(state==='healthy'&&!hasHealth) throw new Error(`Service ${name} requires a health check.`); serviceInventory[name]={imageRef:image,state,requiredOnVm107:expected.requiredOnVm107,hasHealthCheck:hasHealth}; const item=byRef.get(image)??{artifactName:firstParty?image.slice(image.lastIndexOf('/')+1,image.lastIndexOf(':')):name,composeServices:[],resolvedRef:image,source:firstParty?'first-party':'third-party'}; item.composeServices.push(name); byRef.set(image,item); }
const images=Object.fromEntries([...byRef.values()].sort((a,b)=>a.artifactName.localeCompare(b.artifactName)).map((item)=>{item.composeServices.sort();return[item.artifactName,item];})); if(Object.keys(images).length!==byRef.size) throw new Error('Image artifact-name collision.');
const inventory={version:1,kind:'lunchlineup-internal-ci-compose-image-inventory',sourceSha:context.sourceSha,treeSha:context.treeSha,composeConfig:{path:composeItem.path,sha256:createHash('sha256').update(composeItem.bytes).digest('hex'),bytes:composeItem.bytes.length},runtimeContract:'infrastructure/ci/internal-beta-runtime-services.json',services:serviceInventory,images};
if(!readRegularEvidenceSnapshot(composePath,context.evidenceRoot).bytes.equals(composeItem.bytes)||!readFileSync(contractPath).equals(contractBytes))throw new Error('Compose inventory inputs changed before publication.');
writeExclusiveJson(output,inventory,{root:context.evidenceRoot});
return inventory;
}

// Owner-facing metadata publication after actual image export. No CLI or build dispatch.
// Explicit expectations authenticate nothing by themselves; owner custody is required.
export async function writeDisposableReleaseProducerMetadata({ sourceContext, composeConfig, composeInventoryOutput, publicBuildContract, imageDirectory, manifestOutput, expectedSource, env, privateTargetProfile, deploymentContract, deploymentContractBundlePath }) {
if(expectedSource===undefined||env===undefined)throw new Error('Independent disposable source and owner environment required.');
const profile=selectInternalCiSourceProfile(snapshotDeploymentContractJson(expectedSource));
const ownerEnv=snapshotDeploymentContractJson(env), privateProfile=snapshotDeploymentContractJson(privateTargetProfile), schema=snapshotDeploymentContractJson(deploymentContract);
validatePrivateTargetProfile(privateProfile);validateRetainedDeploymentContract(schema);
if(typeof deploymentContractBundlePath!=='string'||!deploymentContractBundlePath)throw new Error('Retained schema bundle path required.');
if(resolve(composeInventoryOutput)===resolve(manifestOutput))throw new Error('Producer outputs must be distinct.');
const context=readInternalCiSourceContext(resolve(sourceContext),{expectedSource:profile,env:ownerEnv});
const inventory=await writeInternalCiComposeImageInventory({sourceContext,composeConfig,runtimeContract:resolve(context.buildSourcePath,'infrastructure/ci/internal-beta-runtime-services.json'),outputPath:composeInventoryOutput,expectedSource:profile,env:ownerEnv});
const manifest=await writeInternalCiReleaseManifest({sourceContext,composeConfig,publicBuildContract,imageDirectory,outputPath:manifestOutput,expectedSource:profile,env:ownerEnv,privateTargetProfile:privateProfile,deploymentContract:schema,deploymentContractBundlePath});
if(inventory.sourceSha!==manifest.sourceSha||inventory.treeSha!==manifest.treeSha||inventory.composeConfig.path!==manifest.composeConfig.path||inventory.composeConfig.sha256!==manifest.composeConfig.sha256)throw new Error('Paired producer metadata differs.');
return {inventory,manifest,acceptance:false,admission:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),one=(f)=>{const i=args.indexOf(f);return i<0?'':args[i+1]??'';};
 await writeInternalCiComposeImageInventory({sourceContext:one('--source-context'),composeConfig:one('--compose-config'),runtimeContract:one('--runtime-contract'),outputPath:one('--output')});
}
