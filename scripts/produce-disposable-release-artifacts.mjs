import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { readInternalCiSourceContext, selectInternalCiSourceProfile, verifyExactClone } from './internal-ci-source-context.mjs';
import { readRegularEvidenceSnapshot, writeExclusiveJson } from './internal-ci-evidence.mjs';
import { buildDeploymentContractBundle, snapshotDeploymentContractJson } from './write-deployment-contract.mjs';
import { validatePrivateTargetProfile } from './private-target-profile.mjs';
import { writeInternalCiComposeImageInventory, writeDisposableReleaseProducerArtifacts } from './compose-image-inventory.mjs';
import { verifyInternalBetaPublicBuild } from './verify-internal-beta-public-build.mjs';

// Private owner API, not an installed admission or public CLI. The enclosing owner
// MUST contain the engine/storage/network and recursively settle descendants.
export async function produceDisposableReleaseArtifacts(options) {
 const selected=snapshotDeploymentContractJson(options);
 const exact=(value,keys)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('Exact producer input keys required.');};
 exact(selected,['sourceContext','expectedSource','env','privateTargetProfile','buildEnvironment','publicBuildConfig','tools','projectName','limits','evidenceLimits']);
 const {limits}=selected;
 exact(limits,['issuedEpoch','expiresEpoch','commandMilliseconds','maxStdoutBytes','maxStderrBytes','maxArchiveBytes','maxUncompressedArchiveBytes','maxTotalArchiveBytes']);
 for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<=0)throw new Error('Explicit positive finite producer limits required.');
 if(limits.issuedEpoch>=limits.expiresEpoch||limits.maxStdoutBytes>64*1024*1024||limits.maxStderrBytes>64*1024*1024||limits.maxArchiveBytes>limits.maxTotalArchiveBytes)throw new Error('Invalid producer bounds.');
 const now=Date.now()/1000,end=performance.now()+(limits.expiresEpoch-now)*1000;
 const check=()=>{const wall=Date.now()/1000;if(wall<limits.issuedEpoch||wall>=limits.expiresEpoch||performance.now()>=end)throw new Error('Original producer window expired or not yet valid.');};
 check();
 const profile=selectInternalCiSourceProfile(selected.expectedSource);
 if(profile.version!==2)throw new Error('Independent disposable source required.');
 validatePrivateTargetProfile(selected.privateTargetProfile);
 if(!/^[a-z][a-z0-9-]{0,62}$/.test(selected.projectName))throw new Error('Invalid exact private Compose project.');
 if(!selected.env||Array.isArray(selected.env)||Object.values(selected.env).some(x=>typeof x!=='string'))throw new Error('Explicit string environment required.');
 const context=readInternalCiSourceContext(resolve(selected.sourceContext),{expectedSource:profile,env:selected.env});
 verifyExactClone(context.buildSourcePath,context,{expectedSource:profile});check();
 const root=resolve(context.evidenceRoot), images=resolve(root,'images'), logs=resolve(root,'producer-commands');
 exact(selected.tools,['engine','gzip']);
 // Stable regular-file reads supplement independently admitted immutable custody.
 const pinned=(pin)=>{exact(pin,['path','bytes','sha256']);if(typeof pin.path!=='string'||!isAbsolute(pin.path)||realpathSync(pin.path)!==pin.path||!Number.isSafeInteger(pin.bytes)||pin.bytes<=0||!/^([a-f0-9]{64})$/.test(pin.sha256))throw new Error('Invalid independent file pin.');const fd=openSync(pin.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size!==BigInt(pin.bytes))throw new Error('Pinned file type/length differs.');let count=0;const h=createHash('sha256'),buffer=Buffer.alloc(65536);while(count<pin.bytes){check();const n=readSync(fd,buffer,0,Math.min(buffer.length,pin.bytes-count),count);if(!n)throw new Error('Truncated pinned file.');h.update(buffer.subarray(0,n));count+=n;}const after=fstatSync(fd,{bigint:true}),named=lstatSync(pin.path,{bigint:true});for(const k of ['dev','ino','size','mtimeNs','ctimeNs'])if(before[k]!==after[k]||after[k]!==named[k])throw new Error('Pinned file changed.');if(h.digest('hex')!==pin.sha256)throw new Error('Pinned file digest differs.');}finally{closeSync(fd);}};
 for(const pin of [selected.buildEnvironment,selected.publicBuildConfig,...Object.values(selected.tools)])pinned(pin);
 // Never synthesize private settings or borrow the C08/browser environment writer.
 const buildEnv=selected.buildEnvironment.path,publicConfig=selected.publicBuildConfig.path;
 readRegularEvidenceSnapshot(publicConfig,root);
 mkdirSync(images,{mode:0o700});mkdirSync(logs,{mode:0o700});
 const exclusive=(path,bytes)=>{const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}};
 const compose=['compose','--project-name',selected.projectName,'--env-file',buildEnv,'-f',resolve(context.buildSourcePath,'docker-compose.yml'),'--profile','ops'];
 let sequence=0,totalArchiveBytes=0;
 const run=async(tool,args,{stdoutPath=null,stdoutCap=limits.maxStdoutBytes,inputPath=null}={})=>{
  check();pinned(selected.tools[tool]);pinned(selected.buildEnvironment);
  const id=String(++sequence).padStart(3,'0'),out=stdoutPath??resolve(logs,`${id}.stdout`),err=resolve(logs,`${id}.stderr`);
  let outFd=null,errFd=null,inputFd=null,child,timer,primaryError=null;
  let outputBytes=0,errorBytes=0,reason=null,exitCode=null,signal=null;
  const diagnosticErrors=[];
  const errorCode=error=>String(error?.code??error?.name??'Error').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64);
  const diagnose=(stage,error)=>{if(diagnosticErrors.length<16)diagnosticErrors.push({stage,code:errorCode(error)});};
  // Path strings never enter persistent command JSON. Bind substituted logical
  // roles to independent pins/source identity; argv hash retains exact correlation.
  const logicalArgs=args.map(arg=>arg===buildEnv?'input:build-environment':arg===resolve(context.buildSourcePath,'docker-compose.yml')?'source:docker-compose.yml':arg);
  const outcome={tool,args:logicalArgs,argvSha256:createHash('sha256').update(JSON.stringify(args)).digest('hex'),toolPin:{bytes:selected.tools[tool].bytes,sha256:selected.tools[tool].sha256},buildEnvironmentPin:{bytes:selected.buildEnvironment.bytes,sha256:selected.buildEnvironment.sha256},sourceSha:profile.sourceSha,treeSha:profile.treeSha};
  try{
   outFd=openSync(out,'wx',0o600);errFd=openSync(err,'wx',0o600);
   if(inputPath!==null)inputFd=openSync(inputPath,constants.O_RDONLY|constants.O_NOFOLLOW);
   child=spawn(selected.tools[tool].path,args,{cwd:context.buildSourcePath,env:selected.env,stdio:[inputFd??'ignore','pipe','pipe']});
   const stop=why=>{reason??=why;for(const [stage,action] of [['kill',()=>child.kill('SIGKILL')],['stdout-destroy',()=>child.stdout.destroy()],['stderr-destroy',()=>child.stderr.destroy()]])try{action();}catch(error){diagnose(stage,error);}};
   const consume=(fd,chunk,count,cap)=>{const keep=Math.min(chunk.length,Math.max(0,cap-count));let offset=0;while(offset<keep){const n=writeSync(fd,chunk,offset,keep-offset);if(n<=0)throw new Error('Zero output write.');offset+=n;}return count+chunk.length;};
   child.stdout.on('data',chunk=>{try{outputBytes=consume(outFd,chunk,outputBytes,stdoutCap);if(outputBytes>stdoutCap)stop('stdout-limit');}catch(error){diagnose('stdout-write',error);stop('stdout-write');}});
   child.stderr.on('data',chunk=>{try{errorBytes=consume(errFd,chunk,errorBytes,limits.maxStderrBytes);if(errorBytes>limits.maxStderrBytes)stop('stderr-limit');}catch(error){diagnose('stderr-write',error);stop('stderr-write');}});
   child.stdout.on('error',error=>{diagnose('stdout-read',error);stop('stdout-read');});
   child.stderr.on('error',error=>{diagnose('stderr-read',error);stop('stderr-read');});
   timer=setTimeout(()=>stop('deadline'),Math.max(1,Math.min(limits.commandMilliseconds,end-performance.now(),(limits.expiresEpoch-Date.now()/1000)*1000)));
   await new Promise(resolveDone=>{child.once('error',error=>{reason??=`spawn:${errorCode(error)}`;});child.once('close',(code,sig)=>{exitCode=code;signal=sig;resolveDone();});});
  }catch(error){primaryError=error;reason??='setup-or-command-error';diagnose('primary',error);
  }finally{
   if(timer)clearTimeout(timer);
   for(const [name,fd,flush] of [['input',inputFd,false],['stdout',outFd,true],['stderr',errFd,true]])if(fd!==null){
    if(flush)try{fsyncSync(fd);}catch(error){diagnose(`${name}-fsync`,error);}
    try{closeSync(fd);}catch(error){diagnose(`${name}-close`,error);}
   }
   Object.assign(outcome,{exitCode,signal,reason,stdoutBytes:outputBytes,stderrBytes:errorBytes,stdoutTruncated:outputBytes>stdoutCap,stderrTruncated:errorBytes>limits.maxStderrBytes,diagnosticErrors,recursiveSettlement:false});
   try{writeExclusiveJson(resolve(logs,`${id}.json`),outcome,{root});}catch(error){diagnose('receipt-publication',error);primaryError??=error;}
  }
  if(primaryError||reason||exitCode!==0||signal||diagnosticErrors.length){const failure=new Error(`Producer command ${id} failed; inspect retained outputs and attached outcome.`,primaryError?{cause:primaryError}:undefined);failure.commandOutcome=outcome;throw failure;}
  check();return out;
 };
 const composePath=resolve(root,'compose-config.json');
 await run('engine',[...compose,'config','--format','json'],{stdoutPath:composePath});
 const inventory=await writeInternalCiComposeImageInventory({sourceContext:selected.sourceContext,composeConfig:composePath,runtimeContract:resolve(context.buildSourcePath,'infrastructure/ci/internal-beta-runtime-services.json'),outputPath:resolve(root,'compose-image-inventory.prebuild.json'),expectedSource:profile,env:selected.env});check();
 if(Object.keys(inventory.services).length!==28||Object.keys(inventory.images).length!==21)throw new Error('Complete selected 28-service/21-artifact inventory required.');
 const imageIds={};
 for(const [name,row] of Object.entries(inventory.images)){
  if(!/^[a-z0-9-]+$/.test(name))throw new Error('Unsafe image artifact name.');
  await run('engine',row.source==='first-party'?[...compose,'build',row.composeServices[0]]:['pull',row.resolvedRef]);
  const path=await run('engine',['image','inspect','--format','{{.Id}}',row.resolvedRef]);
  let id=readRegularEvidenceSnapshot(path,root).bytes.toString('utf8').trim();if(/^[a-f0-9]{64}$/.test(id))id=`sha256:${id}`;
  if(!/^sha256:[a-f0-9]{64}$/.test(id))throw new Error('Invalid actual image identity.');imageIds[name]=id;
 }
 for(const [name,row] of Object.entries(inventory.images)){
  // Save by the observed immutable local ID; metadata retains selected reference.
  const raw=resolve(images,`${name}.tar`),archive=resolve(images,`${name}.tar.gz`);
  await run('engine',['image','save',imageIds[name]],{stdoutPath:raw,stdoutCap:limits.maxUncompressedArchiveBytes});
  const rawIdentity=lstatSync(raw,{bigint:true});
  await run('gzip',['-n','-9','-c'],{inputPath:raw,stdoutPath:archive,stdoutCap:Math.min(limits.maxArchiveBytes,limits.maxTotalArchiveBytes-totalArchiveBytes)});
  const rawAfter=lstatSync(raw,{bigint:true});if(!rawAfter.isFile()||rawAfter.dev!==rawIdentity.dev||rawAfter.ino!==rawIdentity.ino||rawAfter.size!==rawIdentity.size||rawAfter.mtimeNs!==rawIdentity.mtimeNs)throw new Error('Raw archive changed during compression.');
  unlinkSync(raw); // Only this invocation's completed transient export, as legacy exporter.
  const stat=lstatSync(archive);if(!stat.isFile()||stat.size<=0)throw new Error('Empty archive.');
  totalArchiveBytes+=stat.size;if(totalArchiveBytes>limits.maxTotalArchiveBytes)throw new Error('Total archive budget exceeded.');
  const fd=openSync(archive,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
  try{while(offset<stat.size){check();const n=readSync(fd,buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!n)throw new Error('Truncated archive.');hash.update(buffer.subarray(0,n));offset+=n;}}finally{closeSync(fd);}
  writeExclusiveJson(resolve(images,`${name}.image.json`),{artifactName:name,composeServices:row.composeServices,imageRef:row.resolvedRef,localImageId:imageIds[name],archiveFile:`images/${name}.tar.gz`,archiveSha256:hash.digest('hex'),archiveBytes:stat.size},{root});
 }
 const webName=Object.keys(inventory.images).find(name=>inventory.images[name].composeServices.includes('web'));
 if(!webName)throw new Error('Web image missing.');
 const contractPath=resolve(root,'public-build-contract.json');
 await run('engine',['run','--rm','--entrypoint','cat',imageIds[webName],'/app/public/.well-known/lunchlineup-build.json'],{stdoutPath:contractPath});
 pinned(selected.publicBuildConfig);
 await verifyInternalBetaPublicBuild({sourceContext:selected.sourceContext,contractPath,configPath:publicConfig,detailsPath:resolve(root,'public-build-details.json'),expectedSource:profile,env:selected.env,privateTargetProfile:selected.privateTargetProfile});check();
 const bundle=buildDeploymentContractBundle(context.buildSourcePath),bundlePath=resolve(root,'deployment-contract.bundle.json');check();
 exclusive(bundlePath,bundle.bytes);
 const result=await writeDisposableReleaseProducerArtifacts({sourceContext:selected.sourceContext,composeConfig:composePath,composeInventoryOutput:resolve(root,'compose-image-inventory.json'),publicBuildContract:contractPath,imageDirectory:images,manifestOutput:resolve(root,'release-manifest.json'),expectedSource:profile,env:selected.env,privateTargetProfile:selected.privateTargetProfile,deploymentContract:bundle.contract,deploymentContractBundlePath:bundlePath,artifactManifestOutput:resolve(root,'artifact-manifest.json'),evidenceLimits:selected.evidenceLimits});check();
 return {...result,admission:false,acceptance:false,qualification:false,recursiveSettlement:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)throw new Error('Private producer requires independently admitted owner invocation.');
