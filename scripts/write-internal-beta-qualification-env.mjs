import { readPrivateTargetProfile, validatePrivateTargetProfile } from './private-target-profile.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFixedBrowserSourceProfile } from './fixed-browser-source-profile.mjs';
import { readInternalCiSourceContext, selectInternalCiSourceProfile } from './internal-ci-source-context.mjs';
import { assertNoSymlinkComponents, stableJson, writeExclusiveJson } from './internal-ci-evidence.mjs';
function legacyMain() {
const args=process.argv.slice(2), one=(f)=>{const i=args.indexOf(f);return i<0?'':args[i+1]??'';};
const sourceContext=one('--source-context'), outputArgument=one('--output'), publicOutputArgument=one('--public-build-config'), secretsArgument=one('--secrets-dir');
if(!sourceContext||!outputArgument||!publicOutputArgument||!secretsArgument) throw new Error('Qualification environment arguments are required.');
const expectedSource=readFixedBrowserSourceProfile({contextPath:resolve(sourceContext)});
const context=readInternalCiSourceContext(resolve(sourceContext),{expectedSource}), output=resolve(outputArgument), publicOutput=resolve(publicOutputArgument), secretsDir=resolve(secretsArgument);
return writeInputs({context,output,publicOutput,secretsDir,ownerEnv:process.env});
}

function writeInputs({context,output,publicOutput,secretsDir,ownerEnv,selectedPrivateTarget,check=()=>{},limits}) {
check();
const composeText=readCompose(context,limits), composeDefaults={}, canonicalConflictOverrides=new Set(['NEXT_PUBLIC_APP_ORIGIN','NEXT_PUBLIC_APP_URL']);
for(const match of composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g)){if(match.index>0&&composeText[match.index-1]==='$')continue;const [,name,value]=match;if(Object.hasOwn(composeDefaults,name)&&composeDefaults[name]!==value&&!canonicalConflictOverrides.has(name))throw new Error(`Compose variable ${name} has conflicting defaults.`);composeDefaults[name]=value;}
const secret=(prefix,bytes=32)=>`${prefix}${randomBytes(bytes).toString('base64url')}`; const pg=secret('pg_'), appPg=secret('app_pg_'), mq=secret('mq_');
const developmentQa=ownerEnv.LUNCHLINEUP_DEVELOPMENT_QA==='1';
const privateTarget=selectedPrivateTarget ?? (developmentQa?null:readPrivateTargetProfile());
const appOrigin=developmentQa?'http://127.0.0.1:8080':privateTarget.origin;
const publicValues={NEXT_PUBLIC_API_URL:'/api/v2',NEXT_PUBLIC_APP_ORIGIN:appOrigin,NEXT_PUBLIC_APP_URL:appOrigin,NEXT_PUBLIC_APP_ENV:'production',NEXT_PUBLIC_SIGNUP_MODE:'closed_beta',NEXT_PUBLIC_OIDC_ENABLED:'false'}; const publicBytes=stableJson(publicValues), publicSha=createHash('sha256').update(publicBytes).digest('hex');
check();
mkdirSync(dirname(output),{recursive:true,mode:0o700}); mkdirSync(secretsDir,{recursive:true,mode:0o700});
const secretFiles={metrics_token:secret('metrics_'),control_plane_admin_token:secret('control_'),retention_purge_token:secret('retention_')}; for(const [name,value] of Object.entries(secretFiles)) writeFileSync(join(secretsDir,name),`${value}\n`,{flag:'wx',mode:0o600});
// Podman Compose uses bind mounts for file secrets; preserve the private parent
// while permitting the non-root service to read its mounted test secret.
if(ownerEnv.LUNCHLINEUP_DEVELOPMENT_QA==='1') for(const name of ['metrics_token','retention_purge_token']) chmodSync(join(secretsDir,name),0o444);
const env={...composeDefaults,NODE_ENV:ownerEnv.LUNCHLINEUP_DEVELOPMENT_QA==='1'?'test':'production',DATA_TARGET_ENV:'disposable',COMPOSE_SERVICE_ENV_FILE:output,DOMAIN:developmentQa?'127.0.0.1':privateTarget.host,PRIVATE_APP_HOST:developmentQa?'127.0.0.1':privateTarget.host,APP_ORIGIN:appOrigin,NEXT_PUBLIC_APP_ORIGIN:publicValues.NEXT_PUBLIC_APP_ORIGIN,NEXT_PUBLIC_APP_URL:publicValues.NEXT_PUBLIC_APP_URL,NEXT_PUBLIC_APP_ENV:publicValues.NEXT_PUBLIC_APP_ENV,NEXT_PUBLIC_API_URL:publicValues.NEXT_PUBLIC_API_URL,PUBLIC_SIGNUP_MODE:'closed_beta',NEXT_PUBLIC_SIGNUP_MODE:'closed_beta',COOKIE_SECURE:ownerEnv.LUNCHLINEUP_DEVELOPMENT_QA==='1'?'false':'true',NEXT_PUBLIC_OIDC_ENABLED:publicValues.NEXT_PUBLIC_OIDC_ENABLED,NEXT_PUBLIC_TURNSTILE_SITE_KEY:'',OIDC_ENABLED:'false',DEPLOY_RELEASE_SHA:context.sourceSha,DEPLOY_MIGRATION_MODE:'apply',MIGRATION_SOURCE_SHA:context.sourceSha,PUBLIC_BUILD_CONFIG_SHA256:publicSha,IMAGE_PREFIX:'lunchlineup-internal-ci',IMAGE_TAG:context.sourceSha,ADMIN_EMAIL:'ci@example.invalid',CADDY_SITE_ADDRESSES:':80',PROXY_HTTP_BIND:'127.0.0.1',PROXY_HTTP_PORT:'8080',PROXY_HTTPS_BIND:'127.0.0.1',PROXY_HTTPS_PORT:ownerEnv.LUNCHLINEUP_DEVELOPMENT_QA==='1'?'18443':'8443',API_HOST_BIND:'127.0.0.1',API_HOST_PORT:'4000',ALLOWED_HOSTS:'localhost,localhost:8080,127.0.0.1,127.0.0.1:8080,proxy,proxy:80',ALLOWED_ORIGINS:'http://localhost,http://localhost:8080,http://127.0.0.1,http://127.0.0.1:8080',POSTGRES_USER:'lunchlineup_ci_admin',POSTGRES_PASSWORD:pg,POSTGRES_DB:'lunchlineup_ci',APP_DB_USER:'lunchlineup_ci_app',APP_DB_PASSWORD:appPg,PLATFORM_ADMIN_DB_CONTEXT_SECRET:secret('platform_'),DATABASE_URL:`postgresql://lunchlineup_ci_app:${encodeURIComponent(appPg)}@postgres:5432/lunchlineup_ci`,MIGRATION_DATABASE_URL:`postgresql://lunchlineup_ci_admin:${encodeURIComponent(pg)}@postgres:5432/lunchlineup_ci`,REDIS_URL:'redis://redis:6379',RABBITMQ_USER:'lunchlineup_ci',RABBITMQ_PASSWORD:mq,RABBITMQ_URL:`amqp://lunchlineup_ci:${encodeURIComponent(mq)}@rabbitmq:5672/%2f`,JWT_SECRET:secret('jwt_'),JWT_REFRESH_SECRET:secret('refresh_'),SESSION_SECRET:secret('session_'),OTP_HMAC_SECRET:secret('otp_'),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('base64'),WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('base64'),PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY:randomBytes(32).toString('base64'),AVAILABILITY_IMPORT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),CSRF_SECRET:secret('csrf_'),RESEND_API_KEY:'re_test_internal_beta_no_network',RESEND_WEBHOOK_SECRET:'whsec_test_internal_beta',EMAIL_FROM:'LunchLineup Beta Test <no-reply@invalid.example>',STRIPE_SECRET_KEY:'sk_test_internal_beta',STRIPE_WEBHOOK_SECRET:'whsec_test_stripe',STRIPE_METER_ERROR_WEBHOOK_SECRET:'whsec_test_meter',STRIPE_METER_ERROR_EVENT_DESTINATION_ID:'ed_test_internal_beta',STRIPE_METER_ID:'mtr_test_internal_beta',STRIPE_METER_AGGREGATION:'last',PASSWORD_RESET_EMAIL_OUTBOX_ENABLED:'true',STAFF_INVITATION_OUTBOX_ENABLED:'true',STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY:randomBytes(32).toString('base64'),METRICS_TOKEN_FILE:join(secretsDir,'metrics_token'),RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE:join(secretsDir,'retention_purge_token'),CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE:join(secretsDir,'control_plane_admin_token'),NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL:'privacy@lunchlineup.com',NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL:'support@lunchlineup.com',NEXT_PUBLIC_DPA_CONTACT_EMAIL:'privacy@lunchlineup.com',INTERNAL_API_V2_URL:'http://api-v2:3002/v2',LUNCHLINEUP_STATUS_HEALTH_URL:'http://api-v2:3002/v2/ready'};
if(developmentQa){
  // Fake SDK keys do not prevent Internet calls. Delivery is unavailable here;
  // runtime network admission separately denies all external provider egress.
  Object.assign(env,{PASSWORD_RESET_EMAIL_OUTBOX_ENABLED:'false',STAFF_INVITATION_OUTBOX_ENABLED:'false',SCHEDULE_PUBLISHED_EMAIL_ENABLED:'false',NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL:'privacy@example.invalid',NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL:'support@example.invalid',NEXT_PUBLIC_DPA_CONTACT_EMAIL:'privacy@example.invalid'});
}
const environmentBytes=Buffer.from(`${Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')}\n`);
const publicValue={version:1,kind:'lunchlineup-internal-beta-public-build-config',sourceSha:context.sourceSha,...(privateTarget?{privateTarget:privateTarget.binding}:{}),sha256:publicSha,values:publicValues};
const publicBytesWritten=Buffer.from(stableJson(publicValue));
if(limits&&(environmentBytes.length>limits.maxEnvironmentBytes||publicBytesWritten.length>limits.maxPublicConfigBytes))throw new Error('Producer input byte limit exceeded; partial private inputs retained.');
check();writeFileSync(output,environmentBytes,{flag:'wx',mode:0o600});writeExclusiveJson(publicOutput,publicValue,{root:context.evidenceRoot});check();
return {buildEnvironment:{path:output,bytes:environmentBytes.length,sha256:createHash('sha256').update(environmentBytes).digest('hex')},publicBuildConfig:{path:publicOutput,bytes:publicBytesWritten.length,sha256:createHash('sha256').update(publicBytesWritten).digest('hex')},acceptance:false,admission:false,qualification:false};

}

function readCompose(context,limits) {
 const path=resolve(context.buildSourcePath,'docker-compose.yml');
 // The independently admitted exact source remains caller-owned throughout.
 if(!limits)return readFileSync(path,'utf8');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size>BigInt(limits.maxComposeBytes))throw new Error('Selected Compose input exceeds finite limit.');
  const bytes=Buffer.alloc(Number(before.size)),extra=Buffer.alloc(1);let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw new Error('Selected Compose truncated.');offset+=count;}
  if(readSync(fd,extra,0,1,offset))throw new Error('Selected Compose grew.');
  const after=fstatSync(fd,{bigint:true});
  for(const key of ['dev','ino','size','mtimeNs','ctimeNs'])if(before[key]!==after[key])throw new Error('Selected Compose changed.');
  return bytes.toString('utf8');
 } finally {closeSync(fd);}
}

// Explicit disposable input producer, not a runtime configuration importer.
// Caller owns authenticated source/path custody and must retain partial outputs on error.
export function writeDisposableReleaseProducerInputs({sourceContext,expectedSource,env,privateTargetProfile,limits}) {
 if(expectedSource===undefined||env===undefined||privateTargetProfile===undefined||limits===undefined)throw new Error('Independent source/environment/private target and limits required.');
 const profile=selectInternalCiSourceProfile(expectedSource);
 if(profile.version!==2)throw new Error('Disposable source required.');
 if(!env||Array.isArray(env)||Object.values(env).some(value=>typeof value!=='string'))throw new Error('Explicit string owner environment required.');
 const ownerEnv={...env};
 if(ownerEnv.LUNCHLINEUP_DEVELOPMENT_QA==='1')throw new Error('Private producer cannot select browser fixture origin.');
 const keys=['issuedEpoch','expiresEpoch','maxComposeBytes','maxEnvironmentBytes','maxPublicConfigBytes'];
 if(!limits||Array.isArray(limits)||Object.keys(limits).length!==keys.length||keys.some(key=>!Number.isSafeInteger(limits[key])||limits[key]<=0)||limits.issuedEpoch>=limits.expiresEpoch||keys.slice(2).some(key=>limits[key]>64*1024*1024))throw new Error('Explicit finite producer input limits required.');
 const bounds={...limits},end=performance.now()+(bounds.expiresEpoch-Date.now()/1000)*1000;
 const check=()=>{const now=Date.now()/1000;if(now<bounds.issuedEpoch||now>=bounds.expiresEpoch||performance.now()>=end)throw new Error('Original producer input window expired.');};
 check();const selectedPrivateTarget=validatePrivateTargetProfile({...privateTargetProfile});
 if(typeof sourceContext!=='string'||!isAbsolute(sourceContext)||!isAbsolute(ownerEnv.RUNNER_TEMP??''))throw new Error('Absolute admitted source and temporary root required.');
 const context=readInternalCiSourceContext(sourceContext,{expectedSource:profile,env:ownerEnv});check();
 const directory=resolve(ownerEnv.RUNNER_TEMP,`lunchlineup-producer-inputs-${context.runId}`);
 assertNoSymlinkComponents(directory,ownerEnv.RUNNER_TEMP);
 const output=join(directory,'build.env'),secretsDir=join(directory,'secrets'),publicOutput=resolve(context.evidenceRoot,'public-build-config.json');
 assertNoSymlinkComponents(publicOutput,context.evidenceRoot);
 const privateRoot=resolve(realpathSync(ownerEnv.RUNNER_TEMP),`lunchlineup-producer-inputs-${context.runId}`),publicRoot=realpathSync(context.evidenceRoot);
 const contains=(parent,child)=>{const rel=relative(parent,child);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};
 if(contains(publicRoot,privateRoot)||contains(privateRoot,publicRoot))throw new Error('Private producer credentials and public evidence roots must not overlap.');
 // Exclusive private root makes this one-shot. No retry/adoption/deletion on failure.
 mkdirSync(directory,{mode:0o700});check();
 return writeInputs({context,output,publicOutput,secretsDir,ownerEnv,selectedPrivateTarget,check,limits:bounds});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)legacyMain();
