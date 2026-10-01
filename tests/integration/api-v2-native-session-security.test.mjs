/** PRIVATE SOURCE PROPOSAL ONLY; never imported/executed or qualified.
 * One future top-level integration test. Actual fixture PG/Redis and real HTTP;
 * no SessionIdentity/auth/DB/MFA mock, handler override, retained auth success,
 * production request, Redis-server stop/flush or invented admission receipt.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertE2ESeedTarget } from '../../scripts/data-target-guard.mjs';

const root=resolve(import.meta.dirname,'../..'), cap=64*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function bounded(promise,label,ms=10000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} exceeded its deadline.`)),ms);})]);}
  finally{clearTimeout(timer);}
}
function localService(name){
  let url;try{url=new URL(process.env[name]);}catch{throw new Error(`Invalid approved ${name}.`);}
  assert.equal(url.hostname,'127.0.0.1');assert.match(url.port,/^\d+$/);
  assert.ok(Number(url.port)>0&&Number(url.port)<=65535&&! [4000,8080,18443].includes(Number(url.port)));
  assert.equal(url.search,'');assert.equal(url.hash,'');return url;
}
async function admittedContext(){
  // Canonical target checks precede loading Prisma/TS/native application code.
  assert.equal(process.env.DATA_TARGET_ENV,'disposable');assertE2ESeedTarget(process.env);
  assert.equal(process.env.CI_REPOSITORY,'lunchlineup');
  const runId=process.env.CI_RUN_ID,sourceSha=process.env.CI_COMMIT_SHA;
  assert.match(runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);assert.match(sourceSha??'',/^[a-f0-9]{40}$/);
  const workspace=`/var/lib/custom-ci/workspaces/${runId}`,temporary=`/var/lib/custom-ci/runs/${runId}/tmp/job-tmp`;
  assert.equal(process.env.CI_WORKSPACE,workspace);assert.equal(process.env.RUNNER_TEMP,temporary);
  assert.equal(root,`${temporary}/lunchlineup-source-${runId}/build`);assert.equal(await realpath(root),root);
  const path=`${workspace}/.release/internal-ci/${sourceSha}/integration-target.json`;
  assert.equal(await realpath(path),path);const meta=await stat(path);assert.equal(meta.isFile(),true);assert.equal(meta.mode&0o077,0);
  const bytes=await readFile(path);assert.ok(bytes.length<=cap);const target=JSON.parse(bytes.toString('utf8'));
  const prefix=`lunchlineup-integration-${runId.replace(/[^a-zA-Z0-9]/g,'')}`;
  assert.deepEqual(target,{runId,sourceSha,workspace,temporaryRoot:temporary,mutationRole:'lunchlineup_ci_app',
    dataTargetEnvironment:'disposable',database:'lunchlineup_test',store:`${temporary}/lunchlineup-integration-containers-${runId}`,
    containers:['postgres','redis','rabbitmq'].map(name=>`${prefix}-${name}`)});
  assert.equal(await realpath(target.store),target.store);
  // Receipt is correlation, NOT independent controller authority. Only the
  // existing root-owned wrapper can admit the actual fresh store/containers.
  const appUrl=localService('DATABASE_URL'),ownerUrl=localService('MIGRATION_DATABASE_URL'),redisUrl=localService('REDIS_URL');
  for(const url of [appUrl,ownerUrl]){assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.pathname,'/lunchlineup_test');assert.ok(url.password.length>0);}
  assert.equal(appUrl.username,'lunchlineup_ci_app');assert.equal(ownerUrl.username,'root');assert.equal(appUrl.port,ownerUrl.port);
  assert.equal(redisUrl.protocol,'redis:');assert.ok(['','/0'].includes(redisUrl.pathname));assert.equal(redisUrl.username,'');assert.equal(redisUrl.password,'');assert.notEqual(redisUrl.port,appUrl.port);
  return {runId,sourceSha,workspace,redisUrl,targetReceiptSha256:sha(bytes)};
}
function track(server){const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});return sockets;}
async function listen(server){await bounded(new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);}), 'Owned listener');const a=server.address();assert.ok(a&&typeof a==='object');assert.equal(a.address,'127.0.0.1');return a.port;}
async function closeListener(server,sockets){
  if(server?.listening){const closed=new Promise((done,reject)=>server.close(error=>error?reject(error):done()));for(const socket of sockets)socket.destroy();await bounded(closed,'Owned listener close');}
  assert.equal(Boolean(server?.listening),false);assert.equal(sockets.size,0,'All owned accepted sockets closed');
}
async function nativeHttp(port,path,{method='GET',credential='cookie',token,payload,origin,csrf,authorization}={}){
  assert.ok(['/v2/settings','/v2/payroll/policies?limit=10','/v2/auth/me','/v2/users/me/pin'].includes(path));
  const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
  const headers=credential==='cookie'?{Cookie:`access_token=${token}${csrf?`; csrf_token=${csrf}`:''}`}:{Authorization:`Bearer ${token}`};
  if(authorization!==undefined)headers.Authorization=authorization;if(origin!==undefined)headers.Origin=origin;if(csrf!==undefined)headers['X-CSRF-Token']=csrf;
  if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
  return new Promise((done,reject)=>{
    let ended=false,size=0;const chunks=[];
    const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);if(error)reject(error);else done(value);};
    const request=http.request({hostname:'127.0.0.1',port,path,method,headers,agent:false},response=>{
      response.on('data',chunk=>{size+=chunk.length;if(size>cap){response.destroy();request.destroy();finish(new Error('Native response exceeded byte cap.'));}else chunks.push(chunk);});
      response.once('error',()=>finish(new Error('Owned native response failed.')));response.once('aborted',()=>finish(new Error('Owned native response aborted.')));
      response.once('end',()=>{try{finish(null,{status:response.statusCode,headers:response.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish(new Error('Native response was not bounded JSON.'));}});
    });
    const timer=setTimeout(()=>{request.destroy();finish(new Error('Owned native request deadline exceeded.'));},5000);
    request.once('error',()=>finish(new Error('Owned native request failed.')));request.end(bytes);
  });
}

test('native session security binds signed JWTs to live restricted PostgreSQL and real Redis MFA over owned loopback HTTP',{timeout:180000},async()=>{
  const context=await admittedContext();
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');const require=createRequire(import.meta.url);require('ts-node/register/transpile-only');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString()),appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString()),refusalClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(context.redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-security-${nonce}`,`native-security-other-${nonce}`];
  const users=[],roles=[],sessions=[],checkpoints=[],cleanupFailures=[];
  let app,store,refusalStore,trap,refusalTrap,apiPort,trapPort,refusalPort,primary,complete=false,databaseCleaned=false,trapCalls=0,refusedConnections=0,appCloseSettled=false,effectsConfirmed=false,pinAuditExpected=false,baselineEffects,effectsBeforeCleanup;
  let appSockets=new Set(),trapSockets=new Set(),refusalSockets=new Set();
  const key=session=>`session_mfa:${session.id}`;
  const record=(name,response)=>{assert.ok(checkpoints.length<160);checkpoints.push({name,status:response.status,accessCookieIssued:Boolean(response.headers['set-cookie'])});};
  const attempt=async operation=>{try{await operation();}catch(error){cleanupFailures.push(error);}};
  const payrollEffectModels=Object.freeze(['payrollPolicyVersion','payrollPeriod','payrollTimeCardApproval','payrollLockedEntry','payrollAmendment','payrollAmendmentDecision','payrollOperation','payrollExportBatch','payrollExportLine','payrollReconciliationReceipt','payrollReconciliationLineEvent','payrollReconciliationLineState']);
  const effects=async()=>owner.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const payroll={};
    for(const model of payrollEffectModels)payroll[model]=await tx[model].count({where:{tenantId:{in:tenantIds}}});
    return {payroll,audits:await tx.auditLog.count({where:{tenantId:{in:tenantIds}}}),credits:await tx.creditTransaction.count({where:{tenantId:{in:tenantIds}}})};
  },{isolationLevel:'RepeatableRead',maxWait:5000,timeout:10000});
  const expectedEffects=()=>baselineEffects ? {...baselineEffects,audits:baselineEffects.audits+(pinAuditExpected?1:0)} : undefined;

  try{
    const [role]=await appClient.$queryRawUnsafe(`SELECT current_user AS name,session_user AS session_name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
    assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.session_name,role.name);assert.equal(role.database,'lunchlineup_test');
    for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
    const [{count}]=await appClient.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    const catalog=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"RolePermission"'::regclass,'"TenantSetting"'::regclass,'"PayrollPolicyVersion"'::regclass)`);
    assert.equal(catalog.length,7);for(const row of catalog){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Actual Redis fixture client');
    trap=http.createServer((_request,response)=>{trapCalls++;response.writeHead(503,{'Content-Type':'application/json'});response.end('{"code":"fixture_refuses_retained_delivery"}');});trapSockets=track(trap);trapPort=await listen(trap);
    const secret=randomBytes(32).toString('hex');
    const config=loadConfig({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${trapPort}/v1`,REDIS_URL:context.redisUrl.toString(),JWT_SECRET:secret,DEPLOY_RELEASE_SHA:context.sourceSha,COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    // Concrete real identity/store/database only; every domain service and
    // handler comes from buildServer defaults, with no spies or replacements.
    app=await buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)});appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native API listener');const address=app.server.address();assert.ok(address&&typeof address==='object');assert.equal(address.address,'127.0.0.1');apiPort=address.port;
    const origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:`Private fixture ${id}`,status:'ACTIVE'}});
    const pin=String(randomInt(100000,999999));let replacement;do{replacement=String(randomInt(100000,999999));}while(replacement===pin);
    const salt=randomBytes(16).toString('hex'),initialHash=`${salt}:${scryptSync(pin,salt,64).toString('hex')}`;
    for(const [index,tenantId]of tenantIds.entries())users.push(await owner.user.create({data:{tenantId,name:'Native security fixture',username:`native${nonce.replaceAll('-','').slice(0,16)}${index}`,role:'STAFF',mfaEnabled:false,mfaBackupCodes:[],pinHash:initialHash}}));
    const permissionRows=await owner.permission.findMany({where:{key:{in:['settings:read','payroll:read','auth:login_pin']}}});assert.equal(permissionRows.length,3);
    const permissionId=key=>{const row=permissionRows.find(value=>value.key===key);assert.ok(row);return row.id;};
    for(const [index,tenantId]of tenantIds.entries()){
      const baseRole=await owner.role.create({data:{tenantId,name:'Native security base',slug:'native-security-base',isSystem:true,legacyRole:'STAFF'}});roles.push(baseRole);
      for(const permission of ['settings:read','auth:login_pin'])await owner.rolePermission.create({data:{roleId:baseRole.id,permissionId:permissionId(permission)}});
      await owner.roleAssignment.create({data:{tenantId,userId:users[index].id,roleId:baseRole.id}});
    }
    const privilegedRole=await owner.role.create({data:{tenantId:tenantIds[0],name:'Native Payroll reader',slug:'native-payroll-reader',isSystem:false}});roles.push(privilegedRole);
    await owner.rolePermission.create({data:{roleId:privilegedRole.id,permissionId:permissionId('payroll:read')}});
    for(const user of [users[0],users[0],users[1]])sessions.push(await owner.session.create({data:{userId:user.id,refreshToken:sha(randomBytes(32)),ipAddress:'127.0.0.1',userAgent:'native-security-fixture',createdAt:new Date(),expiresAt:new Date(Date.now()+3600000)}}));
    await redis.del(...sessions.map(key));
    const sign=(session=sessions[0],user=users[0],extra={},jwtOptions={})=>jwt.sign({sub:user.id,tenantId:user.tenantId,sessionId:session.id,role:'SUPER_ADMIN',permissions:['settings:read','payroll:read'],mfaVerified:true,pinResetRequired:false,...extra},secret,{algorithm:'HS256',issuer:'lunchlineup',audience:'lunchlineup-api',expiresIn:'30m',...jwtOptions});
    const token=sign(),foreignToken=sign(sessions[2],users[1]);
    const request=(path,credential='cookie',selectedToken=token,extra={})=>nativeHttp(apiPort,path,{credential,token:selectedToken,...extra});
    const noCookie=response=>assert.equal(Boolean(response.headers['set-cookie']),false,'Rejected identity must not rotate an access cookie');
    const deny=async(name,path,credential,status,code,selectedToken=token,extra={})=>{
      const response=await request(path,credential,selectedToken,extra);assert.equal(response.status,status);assert.equal(response.body.code,code);noCookie(response);
      for(const id of tenantIds)assert.equal(JSON.stringify(response.body).includes(`Private fixture ${id}`),false);record(name,response);
    };
    const denied=async(name,status,code,selectedToken=token)=>{for(const credential of ['cookie','bearer'])for(const path of ['/v2/settings','/v2/payroll/policies?limit=10'])await deny(`${name}:${credential}:${path}`,path,credential,status,code,selectedToken);};
    const policy=(requireMfaForAll=false,sessionTimeoutMinutes=480)=>owner.tenantSetting.upsert({where:{tenantId_key:{tenantId:tenantIds[0],key:'workspace_settings'}},create:{tenantId:tenantIds[0],key:'workspace_settings',value:{security:{requireMfaForAll,sessionTimeoutMinutes}}},update:{value:{security:{requireMfaForAll,sessionTimeoutMinutes}}}});
    const positive=async(label,selectedToken=token)=>{
      for(const credential of ['cookie','bearer'])for(const path of ['/v2/settings','/v2/payroll/policies?limit=10']){
        const response=await request(path,credential,selectedToken);assert.equal(response.status,200);assert.equal(Boolean(response.headers['set-cookie']),credential==='cookie');
        if(path==='/v2/settings')assert.equal(response.body.general.name,`Private fixture ${tenantIds[0]}`);else assert.deepEqual(response.body,{data:[],nextCursor:null});
        if(credential==='cookie'){
          const access=response.headers['set-cookie'].find(value=>value.startsWith('access_token='));assert.ok(access);
          const claims=jwt.verify(access.slice(13).split(';',1)[0],secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
          assert.equal(claims.sessionId===sessions[0].id,true);assert.equal(claims.mfaVerified,true);
        }
        record(`${label}:${credential}:${path}`,response);
      }
    };
    const baseMe=await request('/v2/auth/me','bearer');assert.equal(baseMe.status,200);assert.equal(baseMe.body.user.role,'STAFF');assert.equal(baseMe.body.user.roleLabel,'Native security base');assert.equal(baseMe.body.user.mfaRequired,false);assert.equal(baseMe.body.user.permissions.includes('payroll:read'),false);record('signed-role-permission-claims-ignored',baseMe);
    for(const credential of ['cookie','bearer']){const response=await request('/v2/settings',credential);assert.equal(response.status,200);assert.equal(response.body.general.name,`Private fixture ${tenantIds[0]}`);record(`basic-settings:${credential}`,response);}
    const baseline=await effects();baselineEffects=baseline;
    await policy(true);await denied('live-tenant-MFA',403,'mfa_verification_required');assert.deepEqual(await effects(),baseline);
    await policy(false);await owner.user.update({where:{id:users[0].id},data:{mfaEnabled:true}});await denied('live-user-MFA',403,'mfa_verification_required');assert.deepEqual(await effects(),baseline);
    await owner.user.update({where:{id:users[0].id},data:{mfaEnabled:false}});
    await owner.roleAssignment.create({data:{tenantId:tenantIds[0],userId:users[0].id,roleId:privilegedRole.id}});await denied('live-role-MFA-JWT-cannot-override',403,'mfa_verification_required');assert.deepEqual(await effects(),baseline);
    const pending=await request('/v2/auth/me','bearer');assert.equal(pending.status,200);assert.equal(pending.body.user.mfaRequired,true);assert.equal(pending.body.user.mfaVerified,false);record('pending-native-recovery-me',pending);
    await redis.set(key(sessions[0]),'1','EX',600);await positive('actual-verified-Redis');await positive('JWT-false-does-not-downgrade-Redis',sign(sessions[0],users[0],{mfaVerified:false}));
    await redis.set(key(sessions[0]),'true','EX',600);await denied('noncanonical-Redis-flag',403,'mfa_verification_required');
    await redis.del(key(sessions[0]));await denied('live-Redis-verification-removed',403,'mfa_verification_required');await redis.set(key(sessions[0]),'1','EX',600);
    // Genuine close/reconnect, not a server-outage/runtime503 claim.
    await bounded(store.close(),'Owned MFA client close');await positive('owned-client-reconnects-to-live-Redis');
    await owner.roleAssignment.delete({where:{userId_roleId:{userId:users[0].id,roleId:privilegedRole.id}}});
    await deny('live-role-removal-overrides-token','/v2/payroll/policies?limit=10','bearer',403,'permission_denied');
    await owner.roleAssignment.create({data:{tenantId:tenantIds[0],userId:users[0].id,roleId:privilegedRole.id}});
    const liveCases=[
      ['revoked-session',()=>owner.session.update({where:{id:sessions[0].id},data:{revokedAt:new Date()}}),()=>owner.session.update({where:{id:sessions[0].id},data:{revokedAt:null}})],
      ['expired-session',()=>owner.session.update({where:{id:sessions[0].id},data:{expiresAt:new Date(Date.now()-60000)}}),()=>owner.session.update({where:{id:sessions[0].id},data:{expiresAt:new Date(Date.now()+3600000)}})],
      ['shortened-live-timeout',async()=>{await policy(false,5);await owner.session.update({where:{id:sessions[0].id},data:{createdAt:new Date(Date.now()-600000)}});},async()=>{await policy(false);await owner.session.update({where:{id:sessions[0].id},data:{createdAt:new Date()}});}],
      ['suspended-user',()=>owner.user.update({where:{id:users[0].id},data:{suspendedAt:new Date()}}),()=>owner.user.update({where:{id:users[0].id},data:{suspendedAt:null}})],
      ['suspended-tenant',()=>owner.tenant.update({where:{id:tenantIds[0]},data:{status:'SUSPENDED'}}),()=>owner.tenant.update({where:{id:tenantIds[0]},data:{status:'ACTIVE'}})],
    ];
    for(const [name,activate,restore]of liveCases){let failure;try{await activate();await denied(name,401,'authentication_required');}catch(error){failure=error;}try{await restore();}catch(error){throw new AggregateError([...(failure?[failure]:[]),error],'Live fixture probe and restoration failures retained.');}if(failure)throw failure;}
    for(const [name,invalid]of [
      ['cross-tenant-locator',sign(sessions[0],users[0],{tenantId:tenantIds[1]})],['cross-user-locator',sign(sessions[0],users[1],{tenantId:tenantIds[0]})],['cross-session-locator',sign(sessions[2],users[0])],['expired-signed-JWT',sign(sessions[0],users[0],{},{expiresIn:-60})],
      ['wrong-signature-JWT',jwt.sign({sub:users[0].id,tenantId:tenantIds[0],sessionId:sessions[0].id},randomBytes(32).toString('hex'),{algorithm:'HS256',issuer:'lunchlineup',audience:'lunchlineup-api',expiresIn:'30m'})],
    ])await denied(name,401,'authentication_required',invalid);
    await deny('malformed-Bearer-precedes-cookie','/v2/settings','cookie',401,'authentication_required',token,{authorization:'Bearer malformed'});
    const foreign=await request('/v2/settings','bearer',foreignToken);assert.equal(foreign.status,200);assert.equal(foreign.body.general.name,`Private fixture ${tenantIds[1]}`);record('valid-foreign-native-tenant-isolated',foreign);
    await redis.del(key(sessions[0]));await owner.user.update({where:{id:users[0].id},data:{pinResetRequired:true}});await denied('mandatory-PIN-precedes-pending-MFA',403,'pin_rotation_required');
    const recovery=await request('/v2/auth/me','bearer');assert.equal(recovery.status,200);assert.equal(recovery.body.user.pinResetRequired,true);assert.equal(recovery.body.user.mfaRequired,true);assert.equal(recovery.body.user.mfaVerified,false);record('actual-mandatory-PIN-native-recovery-me',recovery);
    const csrf=randomBytes(24).toString('hex');
    await deny('PIN-requires-origin','/v2/users/me/pin','cookie',403,'origin_not_allowed',token,{method:'PUT',payload:{currentPin:pin,newPin:replacement},origin:'http://127.0.0.1',csrf});
    await deny('PIN-requires-CSRF','/v2/users/me/pin','cookie',403,'csrf_validation_failed',token,{method:'PUT',payload:{currentPin:pin,newPin:replacement},origin});
    const guarded=await owner.user.findUniqueOrThrow({where:{id:users[0].id},select:{pinHash:true,pinResetRequired:true}});assert.equal(guarded.pinHash===initialHash,true);assert.equal(guarded.pinResetRequired,true);
    assert.equal(await owner.session.count({where:{id:{in:sessions.slice(0,2).map(row=>row.id)},revokedAt:null}}),2);
    const rotated=await request('/v2/users/me/pin','cookie',token,{method:'PUT',payload:{currentPin:pin,newPin:replacement},origin,csrf});assert.equal(rotated.status,200);pinAuditExpected=true;assert.deepEqual(rotated.body,{success:true});record('actual-HTTP-PIN-rotation',rotated);
    const changed=await owner.user.findUniqueOrThrow({where:{id:users[0].id},select:{pinHash:true,pinResetRequired:true,pinLoginAttempts:true,pinLockedUntil:true}});
    assert.equal(changed.pinResetRequired,false);assert.equal(changed.pinLoginAttempts,0);assert.equal(changed.pinLockedUntil,null);assert.equal(changed.pinHash===initialHash,false);
    const [changedSalt,changedHash]=changed.pinHash.split(':');assert.equal(scryptSync(replacement,changedSalt,64).toString('hex')===changedHash,true);assert.equal(scryptSync(pin,changedSalt,64).toString('hex')===changedHash,false);
    assert.equal(await owner.session.count({where:{id:{in:sessions.slice(0,2).map(row=>row.id)},revokedAt:{not:null}}}),2);assert.equal(await owner.auditLog.count({where:{tenantId:tenantIds[0],action:'USER_PIN_ROTATED',resourceId:users[0].id}}),1);
    await denied('rotation-revokes-primary-access',401,'authentication_required');await denied('rotation-revokes-sibling-access',401,'authentication_required',sign(sessions[1]));
    const unaffected=await request('/v2/settings','bearer',foreignToken);assert.equal(unaffected.status,200);record('rotation-preserves-foreign-session',unaffected);assert.equal(trapCalls,0);assert.deepEqual(await effects(),expectedEffects(),'Only the permitted PIN audit may change fixture effect totals');
    // Actual Redis store to a controlled owned TCP refusal target. buildServer
    // must reject readiness; this is NOT a running-route503/server outage proof.
    refusalTrap=net.createServer(socket=>{refusedConnections++;socket.destroy();});refusalSockets=track(refusalTrap);refusalPort=await listen(refusalTrap);
    const refusalConfig={...config,redisUrl:`redis://127.0.0.1:${refusalPort}`},refusalDb=new TenantDatabase(refusalClient);refusalStore=new RedisMfaSessionStore(refusalConfig);
    await assert.rejects(()=>bounded(buildServer(refusalConfig,{database:refusalDb,identity:new NativeIdentityAdapter(refusalConfig,refusalDb,refusalStore)}),'Unavailable-target native startup'),error=>error.message==='MFA session store is unavailable.');
    assert.ok(refusedConnections>0);assert.equal(trapCalls,0);assert.equal(checkpoints.length,96);assert.equal(new Set(checkpoints.map(value=>value.name)).size,96);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Owned API close',15000);appCloseSettled=true;});
    for(const socket of appSockets)socket.destroy();
    await attempt(async()=>{assert.equal(appCloseSettled,true,'Owned API close must settle');assert.equal(Boolean(app?.server.listening),false);assert.equal(appSockets.size,0);});
    await attempt(async()=>{if(store)await bounded(store.close(),'Owned MFA client cleanup');});await attempt(async()=>{if(refusalStore)await bounded(refusalStore.close(),'Refusal-target MFA client cleanup');});
    await attempt(async()=>{if(sessions.length)await bounded(redis.del(...sessions.map(key)),'Exact fixture MFA-key deletion');});
    await attempt(()=>closeListener(trap,trapSockets));await attempt(()=>closeListener(refusalTrap,refusalSockets));
    await attempt(async()=>{
      assert.equal(appCloseSettled,true,'Preserve fixture when native close/drain did not settle');
      assert.equal(Boolean(app?.server.listening),false,'Preserve fixture if owned native listener remains live');
      assert.equal(appSockets.size,0,'Preserve fixture with accepted sockets still open');
      effectsBeforeCleanup=await bounded(effects(),'Exact fixture effects before cleanup');
      assert.ok(baselineEffects,'Preserve partial setup without a captured effects baseline');
      assert.deepEqual(effectsBeforeCleanup,expectedEffects(),'Preserve unexpected Payroll/credit/audit effects for failure diagnostics');
      effectsConfirmed=true;
      await owner.$transaction(async tx=>{
        const existing=await tx.tenant.findMany({where:{id:{in:tenantIds}},select:{id:true,slug:true}});for(const row of existing)assert.equal(row.slug===row.id,true,'Ownership changed; refuse cleanup');
        // Approved integration teardown pattern: elevated transaction-local
        // replica mode only after app closure, exclusively these exact fixtures.
        // It permits removal of their otherwise append-only PIN rotation audit.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        const userIds=users.map(row=>row.id),roleIds=roles.map(row=>row.id),sessionIds=sessions.map(row=>row.id);
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.auditLog.deleteMany({where:{tenantId:{in:tenantIds},resourceId:{in:userIds},action:'USER_PIN_ROTATED'}});
        await tx.roleAssignment.deleteMany({where:{tenantId:{in:tenantIds},userId:{in:userIds},roleId:{in:roleIds}}});await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.role.deleteMany({where:{id:{in:roleIds},tenantId:{in:tenantIds}}});
        await tx.tenantSetting.deleteMany({where:{tenantId:{in:tenantIds},key:'workspace_settings'}});await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);databaseCleaned=true;
    });
    await attempt(async()=>{if(redis.status!=='end')await bounded(redis.quit(),'Owned Redis fixture-client close');});redis.disconnect(false);
    const closed=await Promise.allSettled([appClient.$disconnect(),refusalClient.$disconnect(),owner.$disconnect()].map(promise=>bounded(promise,'Owned Prisma disconnect')));for(const result of closed)if(result.status==='rejected')cleanupFailures.push(result.reason);
    await attempt(async()=>{
      const receipt={version:1,kind:'native-session-security-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,targetReceiptSha256:context.targetReceiptSha256,fixtureNonce:nonce,startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',transport:'owned-127.0.0.1-http',apiPort,legacyTrapPort:trapPort,unavailableRedisTrapPort:refusalPort,legacyCalls:trapCalls,refusedStartupConnections:refusedConnections,expectedCheckpointCount:96,completedCheckpointCount:checkpoints.length,checkpoints,databaseCleaned,appCloseSettled,effectsConfirmed,baselineEffects,expectedEffects:expectedEffects(),effectsBeforeCleanup,fixturePreserved:!databaseCleaned,apiClosed:!app?.server.listening,acceptedApiSocketsRemaining:appSockets.size,legacyTrapClosed:!trap?.listening,refusalTrapClosed:!refusalTrap?.listening,
        limitation:'Synthetic signed session fixtures and real Redis state: no actual login/TOTP, retained-auth success, Redis-server outage, runtime503, controller admission or release qualification.',failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-session-security-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Private actual-run diagnostic receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native session security and every owned cleanup failure retained.');
});
