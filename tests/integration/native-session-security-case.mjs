/** Shared real HTTP/PostgreSQL/Redis scenario; execution-target admission belongs to its caller.
 * Both callers must pass the same explicit disposable loopback target checks.
 * Synthetic signed sessions and real Redis state do not qualify login/TOTP or a release.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
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
export function validateNativeSessionSecurityTarget(){
  assert.equal(process.env.DATA_TARGET_ENV,'disposable');assertE2ESeedTarget(process.env);
  const appUrl=localService('DATABASE_URL'),ownerUrl=localService('MIGRATION_DATABASE_URL'),redisUrl=localService('REDIS_URL');
  for(const url of [appUrl,ownerUrl]){assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.pathname,'/lunchlineup_test');assert.ok(url.password.length>0);}
  assert.equal(appUrl.username,'lunchlineup_ci_app');assert.equal(ownerUrl.username,'root');assert.equal(appUrl.port,ownerUrl.port);
  assert.equal(redisUrl.protocol,'redis:');assert.ok(['','/0'].includes(redisUrl.pathname));assert.equal(redisUrl.username,'');assert.equal(redisUrl.password,'');assert.notEqual(redisUrl.port,appUrl.port);
  return {redisUrl};
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

export async function runNativeSessionSecurity(context){
  // Validate targets before loading Prisma/TS/native application code, even
  // when an explicit local owner invokes this case without the VM wrapper.
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.ok(['vm218','local'].includes(context.executionTarget));
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  if(context.executionTarget==='vm218')assert.match(context.targetReceiptSha256??'',/^[a-f0-9]{64}$/);
  else {assert.equal(context.targetReceiptSha256,undefined);assert.ok(context.workspace.startsWith('/tmp/'));}
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');const require=createRequire(import.meta.url);require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString()),appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString()),refusalClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(context.redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-security-${nonce}`,`native-security-other-${nonce}`];
  const users=[],roles=[],sessions=[],allSessions=[],checkpoints=[],cleanupFailures=[];
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
    const config=loadConfig({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${trapPort}/v1`,REDIS_URL:context.redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
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
    for(const user of [users[0],users[0],users[1]]){const session=await owner.session.create({data:{userId:user.id,refreshToken:sha(randomBytes(32)),ipAddress:'127.0.0.1',userAgent:'native-security-fixture',createdAt:new Date(),expiresAt:new Date(Date.now()+3600000)}});sessions.push(session);allSessions.push(session);}
    await redis.del(...sessions.map(key));
    const sign=(session=sessions[0],user=users[0],extra={},jwtOptions={})=>jwt.sign({sub:user.id,tenantId:user.tenantId,sessionId:session.id,role:'SUPER_ADMIN',permissions:['settings:read','payroll:read'],mfaVerified:true,pinResetRequired:false,...extra},secret,{algorithm:'HS256',issuer:'lunchlineup',audience:'lunchlineup-api',expiresIn:'30m',...jwtOptions});
    let token=sign();const foreignToken=sign(sessions[2],users[1]);
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
      ['suspended-user',()=>owner.user.update({where:{id:users[0].id},data:{suspendedAt:new Date()}}),async()=>{
        // Reactivation must not revive credentials revoked by the real trigger.
        await owner.user.update({where:{id:users[0].id},data:{suspendedAt:null}});
        const prior=sessions.slice(0,2),priorIds=prior.map(row=>row.id);
        assert.equal(await owner.session.count({where:{id:{in:priorIds},userId:users[0].id,revokedAt:{not:null}}}),2);
        await deny('suspension-keeps-prior-primary-revoked','/v2/settings','bearer',401,'authentication_required',token);
        await deny('suspension-keeps-prior-sibling-revoked','/v2/settings','bearer',401,'authentication_required',sign(prior[1]));
        await redis.del(...prior.map(key));
        // Synthetic replacement fixtures only, not a credential-login claim.
        // Atomic creation leaves no untracked first row if the second fails.
        const fresh=await owner.$transaction(async tx=>{
          const rows=[];
          for(let index=0;index<2;index++)rows.push(await tx.session.create({data:{userId:users[0].id,refreshToken:sha(randomBytes(32)),ipAddress:'127.0.0.1',userAgent:'native-security-fixture',createdAt:new Date(),expiresAt:new Date(Date.now()+3600000)}}));
          return rows;
        },{maxWait:5000,timeout:10000});
        allSessions.push(...fresh);sessions.splice(0,2,...fresh);token=sign();
        await redis.set(key(sessions[0]),'1','EX',600);
        for(const credential of ['cookie','bearer']){
          const response=await request('/v2/settings',credential);assert.equal(response.status,200);assert.equal(response.body.general.name,`Private fixture ${tenantIds[0]}`);assert.equal(Boolean(response.headers['set-cookie']),credential==='cookie');
          if(credential==='cookie'){
            const access=response.headers['set-cookie'].find(value=>value.startsWith('access_token='));assert.ok(access);
            const claims=jwt.verify(access.slice(13).split(';',1)[0],secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
            assert.equal(claims.sessionId===sessions[0].id,true);assert.equal(claims.mfaVerified,true);
          }
          record(`post-suspension-fresh-session:${credential}`,response);
        }
        assert.equal(await owner.session.count({where:{id:{in:fresh.map(row=>row.id)},userId:users[0].id,revokedAt:null}}),2);
        assert.equal(await owner.session.count({where:{id:{in:priorIds},userId:users[0].id,revokedAt:{not:null}}}),2);
      }],
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
    assert.ok(refusedConnections>0);assert.equal(trapCalls,0);assert.equal(checkpoints.length,100);assert.equal(new Set(checkpoints.map(value=>value.name)).size,100);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Owned API close',15000);appCloseSettled=true;});
    for(const socket of appSockets)socket.destroy();
    await attempt(async()=>{assert.equal(appCloseSettled,true,'Owned API close must settle');assert.equal(Boolean(app?.server.listening),false);assert.equal(appSockets.size,0);});
    await attempt(async()=>{if(store)await bounded(store.close(),'Owned MFA client cleanup');});await attempt(async()=>{if(refusalStore)await bounded(refusalStore.close(),'Refusal-target MFA client cleanup');});
    await attempt(async()=>{if(allSessions.length)await bounded(redis.del(...allSessions.map(key)),'Exact fixture MFA-key deletion');});
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
        const userIds=users.map(row=>row.id),roleIds=roles.map(row=>row.id),sessionIds=allSessions.map(row=>row.id);
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.auditLog.deleteMany({where:{tenantId:{in:tenantIds},resourceId:{in:userIds},action:'USER_PIN_ROTATED'}});
        await tx.roleAssignment.deleteMany({where:{tenantId:{in:tenantIds},userId:{in:userIds},roleId:{in:roleIds}}});await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.role.deleteMany({where:{id:{in:roleIds},tenantId:{in:tenantIds}}});
        await tx.tenantSetting.deleteMany({where:{tenantId:{in:tenantIds},key:'workspace_settings'}});await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);databaseCleaned=true;
    });
    await attempt(async()=>{if(redis.status!=='end')await bounded(redis.quit(),'Owned Redis fixture-client close');});redis.disconnect(false);
    const closed=await Promise.allSettled([appClient.$disconnect(),refusalClient.$disconnect(),owner.$disconnect()].map(promise=>bounded(promise,'Owned Prisma disconnect')));for(const result of closed)if(result.status==='rejected')cleanupFailures.push(result.reason);
    await attempt(async()=>{
      const receipt={version:1,kind:context.executionTarget==='vm218'?'native-session-security-integration':'native-session-security-local-integration',executionTarget:context.executionTarget,releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,targetReceiptSha256:context.targetReceiptSha256,fixtureNonce:nonce,startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',transport:'owned-127.0.0.1-http',apiPort,legacyTrapPort:trapPort,unavailableRedisTrapPort:refusalPort,legacyCalls:trapCalls,refusedStartupConnections:refusedConnections,expectedCheckpointCount:100,completedCheckpointCount:checkpoints.length,checkpoints,databaseCleaned,appCloseSettled,effectsConfirmed,baselineEffects,expectedEffects:expectedEffects(),effectsBeforeCleanup,fixturePreserved:!databaseCleaned,apiClosed:!app?.server.listening,acceptedApiSocketsRemaining:appSockets.size,legacyTrapClosed:!trap?.listening,refusalTrapClosed:!refusalTrap?.listening,
        limitation:'Synthetic signed session fixtures and real Redis state: no actual login/TOTP, retained-auth success, Redis-server outage, runtime503, controller admission or release qualification.',failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-session-security-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Private actual-run diagnostic receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native session security and every owned cleanup failure retained.');
}

/** Separately selected credential slice. Same disposable owner/target contract;
 * actual retained controllers, services, guards, HTTP bridge, PostgreSQL/Redis.
 * No provider, browser, password-reset delivery, or whole-release claim. */
export async function runNativeCredentialSecurity(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const {createHmac}=require('node:crypto'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-credentials-${nonce}`,`native-credentials-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex');
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    AUTH_DEBUG:'false',OIDC_ENABLED:'false',RESEND_API_KEY:'',STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map(Object.keys(configuration).map(key=>[key,process.env[key]]));
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','POST /v2/auth/pin/verify','GET /v2/auth/me','GET /v2/settings',
    'PUT /v2/users/me/pin','GET /v2/auth/mfa/enrollment','POST /v2/auth/mfa/enrollment','PUT /v2/auth/mfa/enrollment',
    'POST /v2/auth/mfa/verify','POST /v2/auth/refresh','POST /v2/auth/logout']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload)=>{
    assert.ok(allowed.has(`${method} ${path}`));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  const totp=base32=>{
    let value=0,bits=0;const bytes=[];for(const letter of base32){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter);assert.ok(n>=0);value=(value<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest[digest.length-1]&15;
    return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  };
  try{
    Object.assign(process.env,configuration);
    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController],providers:[
      {provide:ConfigService,useValue:configService},{provide:TenantPrismaService,useValue:tenantDb},
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:'Private credential fixture',status:'ACTIVE'}});
    const password=`Credential!${randomBytes(16).toString('hex')}`,pin=String(randomInt(100000,999999));
    let newPin;do{newPin=String(randomInt(100000,999999));}while(newPin===pin);
    const salt=randomBytes(16).toString('hex'),pinHash=`${salt}:${scryptSync(pin,salt,64).toString('hex')}`;
    const passwordHash=await bcrypt.hash(password,10);
    for(const [index,tenantId]of [tenantIds[0],tenantIds[0],tenantIds[1]].entries())users.push(await owner.user.create({data:{tenantId,
      username:`credential${nonce.replaceAll('-','').slice(0,12)}${index}`,name:'Credential fixture',role:'STAFF',passwordHash,pinHash,
      pinResetRequired:index===1,mfaEnabled:false,mfaBackupCodes:[]}}));
    const permissions=await owner.permission.findMany({where:{key:{in:['auth:login_password','auth:login_pin','settings:read']}}});assert.equal(permissions.length,3);
    for(const tenantId of tenantIds){const role=await owner.role.create({data:{tenantId,name:'Credential staff',slug:'credential-staff',isSystem:true,legacyRole:'STAFF'}});roles.push(role);
      for(const permission of permissions)await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
      for(const user of users.filter(row=>row.tenantId===tenantId))await owner.roleAssignment.create({data:{tenantId,userId:user.id,roleId:role.id}});
    }
    checkpoint('restricted-roles-RLS-and-owned-fixtures');
    const beforeLogin=await owner.session.count({where:{userId:{in:users.map(row=>row.id)}}});assert.equal(beforeLogin,0);
    refused(await request('POST','/v2/auth/password/verify',jar(),{identifier:users[0].username,tenantSlug:tenantIds[0],password:'wrong-credential'}));
    refused(await request('POST','/v2/auth/pin/verify',jar(),{identifier:users[0].username,tenantSlug:tenantIds[1],pin}));
    assert.equal(await owner.session.count({where:{userId:{in:users.map(row=>row.id)}}}),0);checkpoint('wrong-password-and-foreign-workspace-no-session');
    const primaryLogin=await login(users[0],'password',password),sibling=await login(users[0],'pin',pin),foreign=await login(users[2],'pin',pin);
    ok(await request('GET','/v2/settings',primaryLogin.cookies));ok(await request('GET','/v2/auth/me',sibling.cookies));checkpoint('password-and-PIN-issued-cookie-native-readback');
    const forced=await login(users[1],'pin',pin);assert.equal(forced.response.body.pinResetRequired,true);assert.ok(forced.response.body.redirectTo.startsWith('/auth/reset-pin'));
    refused(await request('GET','/v2/settings',forced.cookies));ok(await request('GET','/v2/auth/me',forced.cookies));checkpoint('credential-forced-PIN-recovery-boundary');
    ok(await request('PUT','/v2/users/me/pin',forced.cookies,{currentPin:pin,newPin}));
    const rotated=await owner.user.findUniqueOrThrow({where:{id:users[1].id}});assert.equal(rotated.pinResetRequired,false);assert.equal(rotated.pinHash===pinHash,false);
    const [newSalt,newHash]=rotated.pinHash.split(':');assert.equal(scryptSync(newPin,newSalt,64).toString('hex')===newHash,true);
    assert.equal(await owner.session.count({where:{userId:users[1].id,revokedAt:null}}),0);refused(await request('GET','/v2/auth/me',forced.cookies));
    refused(await request('POST','/v2/auth/pin/verify',jar(),{identifier:users[1].username,tenantSlug:tenantIds[0],pin}));
    const resetLogin=await login(users[1],'pin',newPin);ok(await request('GET','/v2/settings',resetLogin.cookies));ok(await request('GET','/v2/settings',foreign.cookies));checkpoint('native-PIN-write-old-denied-new-login-foreign-preserved');
    const enrollment=await request('POST','/v2/auth/mfa/enrollment',primaryLogin.cookies);ok(enrollment);assert.equal(typeof enrollment.body.secret==='string'&&/^[A-Z2-7]{32}$/.test(enrollment.body.secret),true);
    assert.equal(new URL(enrollment.body.otpauthUrl).protocol,'otpauth:');assert.ok(enrollment.body.expiresInSeconds>0&&enrollment.body.expiresInSeconds<=600);
    const pending=await owner.session.findUniqueOrThrow({where:{id:primaryLogin.sessionId}});assert.equal(/^enc:v[12]:/.test(pending.mfaEnrollmentSecret),true);assert.equal(pending.mfaEnrollmentSecret.includes(enrollment.body.secret),false);
    assert.ok(pending.mfaEnrollmentExpiresAt>new Date());assert.equal((await owner.user.findUniqueOrThrow({where:{id:users[0].id}})).mfaEnabled,false);
    const siblingEnrollment=await request('POST','/v2/auth/mfa/enrollment',sibling.cookies);ok(siblingEnrollment);
    assert.equal(typeof siblingEnrollment.body.secret==='string'&&/^[A-Z2-7]{32}$/.test(siblingEnrollment.body.secret),true);
    assert.equal(siblingEnrollment.body.secret===enrollment.body.secret,false);
    const primaryPendingAfterSibling=await owner.session.findUniqueOrThrow({where:{id:primaryLogin.sessionId}});
    const siblingPending=await owner.session.findUniqueOrThrow({where:{id:sibling.sessionId}});
    assert.equal(primaryPendingAfterSibling.userId,users[0].id);assert.equal(siblingPending.userId,users[0].id);
    assert.equal(primaryPendingAfterSibling.id===siblingPending.id,false);
    assert.equal(primaryPendingAfterSibling.mfaEnrollmentSecret===pending.mfaEnrollmentSecret,true);
    assert.equal(primaryPendingAfterSibling.mfaEnrollmentExpiresAt.getTime(),pending.mfaEnrollmentExpiresAt.getTime());
    assert.equal(/^enc:v[12]:/.test(siblingPending.mfaEnrollmentSecret),true);
    assert.equal(siblingPending.mfaEnrollmentSecret.includes(siblingEnrollment.body.secret),false);
    assert.equal(siblingPending.mfaEnrollmentSecret===primaryPendingAfterSibling.mfaEnrollmentSecret,false);
    assert.ok(siblingPending.mfaEnrollmentExpiresAt>new Date());
    assert.ok(siblingPending.mfaEnrollmentExpiresAt.getTime()<=Date.now()+600000);
    assert.ok(siblingEnrollment.body.expiresInSeconds>0&&siblingEnrollment.body.expiresInSeconds<=600);
    checkpoint('exact-session-encrypted-pending-generations');
    const confirmation=await request('PUT','/v2/auth/mfa/enrollment',primaryLogin.cookies,{code:totp(enrollment.body.secret)});ok(confirmation);assert.equal(confirmation.body.mfaVerified,true);
    const codes=confirmation.body.backupCodes;assert.ok(Array.isArray(codes)&&codes.length===10);
    const enabled=await owner.user.findUniqueOrThrow({where:{id:users[0].id}});assert.equal(enabled.mfaEnabled,true);assert.equal(/^enc:v[12]:/.test(enabled.mfaSecret),true);
    assert.equal(enabled.mfaSecret.includes(enrollment.body.secret),false);assert.equal(enabled.mfaBackupCodes.length,10);for(const code of codes)assert.equal(enabled.mfaBackupCodes.includes(code),false);
    const afterPending=await owner.session.findMany({where:{userId:users[0].id}});for(const row of afterPending){assert.equal(row.mfaEnrollmentSecret,null);assert.equal(row.mfaEnrollmentExpiresAt,null);}
    assert.equal(await redis.get(`session_mfa:${primaryLogin.sessionId}`),'1');ok(await request('GET','/v2/settings',primaryLogin.cookies));checkpoint('real-TOTP-confirm-durable-secret-trigger-and-protected-access');
    refused(await request('GET','/v2/settings',sibling.cookies));
    const challenge=await request('POST','/v2/auth/mfa/verify',sibling.cookies,{code:codes[0]});ok(challenge);assert.equal(challenge.body.mfaVerified,true);
    assert.equal((await owner.user.findUniqueOrThrow({where:{id:users[0].id}})).mfaBackupCodes.length,9);
    assert.equal(await redis.get(`session_mfa:${sibling.sessionId}`),'1');ok(await request('GET','/v2/settings',sibling.cookies));checkpoint('recovery-code-challenge-exact-session-and-count');
    const fresh=await login(users[0],'password',password);assert.equal(fresh.response.body.requiresMfa,true);
    refused(await request('POST','/v2/auth/mfa/verify',fresh.cookies,{code:codes[0]}));assert.equal(await redis.get(`session_mfa:${fresh.sessionId}`),null);
    assert.equal((await owner.user.findUniqueOrThrow({where:{id:users[0].id}})).mfaBackupCodes.length,9);checkpoint('consumed-recovery-proof-refused-in-new-credential-session');
    const stale=cloneJar(primaryLogin.cookies),oldValidator=(await owner.session.findUniqueOrThrow({where:{id:primaryLogin.sessionId}})).refreshToken;
    const refresh=await request('POST','/v2/auth/refresh',primaryLogin.cookies);ok(refresh);assert.equal(refresh.body.mfaVerified,true);
    const currentSession=await owner.session.findUniqueOrThrow({where:{id:primaryLogin.sessionId}});assert.equal(currentSession.refreshToken===oldValidator,false);
    assert.equal(await owner.refreshTokenReplay.count({where:{sessionId:primaryLogin.sessionId,validatorHash:oldValidator}}),1);
    assert.equal(primaryLogin.cookies.get('refresh_token')===stale.get('refresh_token'),false);assert.equal(primaryLogin.cookies.get('csrf_token')===stale.get('csrf_token'),false);
    ok(await request('GET','/v2/settings',primaryLogin.cookies));checkpoint('refresh-rotates-validator-ledger-CSRF-real-MFA');
    const unknown=cloneJar(sibling.cookies),issuedSiblingRefresh=decodeURIComponent(sibling.cookies.get('refresh_token'));
    const siblingParts=issuedSiblingRefresh.split('.');assert.equal(siblingParts.length,3);assert.equal(siblingParts[0],'v2');
    let unknownValidator;do{unknownValidator=randomBytes(32).toString('base64url');}while(unknownValidator===siblingParts[2]);
    unknown.set('refresh_token',`v2.${siblingParts[1]}.${unknownValidator}`);
    refused(await request('POST','/v2/auth/refresh',unknown));
    assert.equal((await owner.session.findUniqueOrThrow({where:{id:sibling.sessionId}})).revokedAt,null);
    ok(await request('GET','/v2/settings',sibling.cookies));checkpoint('unknown-refresh-validator-cannot-revoke-sibling');
    refused(await request('POST','/v2/auth/refresh',stale));assert.ok((await owner.session.findUniqueOrThrow({where:{id:primaryLogin.sessionId}})).revokedAt);
    refused(await request('GET','/v2/settings',primaryLogin.cookies));ok(await request('GET','/v2/settings',sibling.cookies));ok(await request('GET','/v2/settings',foreign.cookies));checkpoint('recognized-refresh-replay-revokes-only-bound-session');
    const oldSibling=cloneJar(sibling.cookies);ok(await request('POST','/v2/auth/logout',sibling.cookies));assert.ok((await owner.session.findUniqueOrThrow({where:{id:sibling.sessionId}})).revokedAt);
    refused(await request('GET','/v2/settings',oldSibling));assert.equal(sibling.cookies.get('access_token'),'');assert.equal(sibling.cookies.get('refresh_token'),'');checkpoint('actual-API-logout-revocation-cookie-clear');
    const audits=await owner.auditLog.findMany({where:{tenantId:{in:tenantIds}},select:{action:true,resourceId:true,newValue:true}});
    const createdSessions=await owner.session.findMany({where:{userId:{in:users.map(row=>row.id)}}});
    // Successful new-PIN login prunes its revoked predecessor; audit history remains.
    const expectedIssued=[primaryLogin,sibling,foreign,forced,resetLogin,fresh].map(row=>row.sessionId);
    assert.equal(new Set(expectedIssued).size,6);assert.deepEqual(issuedSessions.map(row=>row.id),expectedIssued);
    assert.deepEqual(createdSessions.map(row=>row.id).sort(),expectedIssued.filter(id=>id!==forced.sessionId).sort());
    assert.equal(await owner.session.findUnique({where:{id:forced.sessionId}}),null);
    const loginAudits=audits.filter(row=>row.action==='SESSION_CREATED');assert.equal(loginAudits.length,6);
    assert.deepEqual(loginAudits.map(row=>row.resourceId).sort(),[...expectedIssued].sort());
    for(const issued of issuedSessions){const audit=loginAudits.find(row=>row.resourceId===issued.id);assert.equal(audit.newValue.loginMethod,issued.loginMethod);} 
    assert.equal(audits.filter(row=>row.action==='USER_PIN_ROTATED').length,1);assert.equal(audits.filter(row=>row.action==='MFA_ENABLED').length,1);
    for(const row of audits){assert.ok(['SESSION_CREATED','USER_PIN_ROTATED','MFA_ENABLED'].includes(row.action));const text=JSON.stringify(row);for(const sensitive of [password,pin,newPin,enrollment.body.secret,...codes])assert.equal(text.includes(sensitive),false);}
    checkpoint('independent-auth-audit-counts-and-secret-redaction');
    assert.equal(checks.length,14);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Credential native close',15000);});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Credential retained close',15000);});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Credential native Redis close');});
    await attempt(async()=>{
      // destroy() initiates closure; ownership settles only after every close event.
      const sockets=[...appSockets,...retainedSockets];
      await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{
        socket.once('close',done);socket.destroy();
      }))),'Credential owned socket close events',15000);
    });
    await attempt(async()=>{assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;});
    await attempt(async()=>{
      assert.equal(closed,true);if(redis.status==='ready')await snapshotKeys();
      const userIds=users.map(row=>row.id),roleIds=roles.map(row=>row.id);
      const storedSessions=await owner.session.findMany({where:{userId:{in:userIds}},select:{id:true,userId:true}});
      const sessionIds=[...new Set([...storedSessions.map(row=>row.id),...issuedSessions.map(row=>row.id)])];
      for(const row of issuedSessions)assert.ok(userIds.includes(row.userId));
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)));
      const audits=await owner.auditLog.findMany({where:{tenantId:{in:tenantIds}},select:{action:true,resourceId:true}});
      for(const row of audits){assert.ok(['SESSION_CREATED','USER_PIN_ROTATED','MFA_ENABLED'].includes(row.action),'Preserve unexpected fixture audit');assert.ok([...userIds,...sessionIds].includes(row.resourceId));}
      assert.equal(await owner.creditTransaction.count({where:{tenantId:{in:tenantIds}}}),0);
      assert.equal(await owner.passwordResetEmailOutbox.count({where:{tenantId:{in:tenantIds}}}),0);
      const claimScope={OR:[{tenantId:{in:tenantIds}},{userId:{in:userIds}}]};
      const claims=await owner.mfaTotpClaim.findMany({where:claimScope,select:{id:true,tenantId:true,userId:true}});
      assert.ok(claims.length<=1,'Only the single enrollment TOTP may create a fixture claim');
      for(const claim of claims){assert.equal(claim.tenantId,tenantIds[0]);assert.equal(claim.userId,users[0].id);}
      await owner.$transaction(async tx=>{
        const tenants=await tx.tenant.findMany({where:{id:{in:tenantIds}},select:{id:true,slug:true}});for(const row of tenants)assert.equal(row.id,row.slug);
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        // Replica-mode teardown suppresses FK cascades; explicitly delete exact claims.
        for(const claim of claims){const removed=await tx.mfaTotpClaim.deleteMany({where:{id:claim.id,tenantId:claim.tenantId,userId:claim.userId}});assert.equal(removed.count,1);}
        assert.equal(await tx.mfaTotpClaim.count({where:claimScope}),0);
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.auditLog.deleteMany({where:{tenantId:{in:tenantIds},resourceId:{in:[...userIds,...sessionIds]},action:{in:['SESSION_CREATED','USER_PIN_ROTATED','MFA_ENABLED']}}});
        await tx.roleAssignment.deleteMany({where:{tenantId:{in:tenantIds},userId:{in:userIds},roleId:{in:roleIds}}});await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.role.deleteMany({where:{id:{in:roleIds},tenantId:{in:tenantIds}}});
        await tx.tenantSetting.deleteMany({where:{tenantId:{in:tenantIds}}});await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);
      assert.equal(await owner.mfaTotpClaim.count({where:claimScope}),0);databaseCleaned=true;
      if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Exact credential Redis-key cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Credential Redis disconnect');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Credential Prisma disconnect'));
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const receipt={version:1,kind:'native-credential-security-local-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,
        startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',
        expectedCheckpointCount:14,completedCheckpointCount:checks.length,checkpoints:checks,apiPort,retainedPort,
        transport:'owned-loopback-native-v2-to-real-retained-auth',credentialSource:'HTTP-issued cookies only; no synthetic session/JWT/MFA markers',
        databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        limitations:['Scoped real Nest auth composition, not full AppModule/production ingress','Local development cookie transport, not TLS secure-cookie proof','No browser/provider/password-reset-outbox/removal/concurrent-authority qualification'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-credential-security-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Credential durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native credential scenario or owned cleanup failed; preserve first attempt.');
}

/** Authenticated synthetic callback over retained HTTP and real PostgreSQL.
 * No provider traffic or public Caddy ingress qualification. */
export async function runNativeSignedCallback(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');assert.equal(context.exclusiveRedis,true);
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));assert.equal(context.redisUrl.toString(),redisUrl.toString());assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory}=require('@nestjs/core'),{ConfigService}=require('@nestjs/config');
  const express=require('express'),{Webhook}=require('standardwebhooks');
  const {EmailDeliveryFeedbackController}=require('../../apps/api/src/email-delivery/email-delivery-feedback.controller.ts');
  const {EmailDeliveryFeedbackService}=require('../../apps/api/src/email-delivery/email-delivery-feedback.service.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {captureRawBody}=require('../../apps/api/src/common/bootstrap-security.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString()),client=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const nonce=randomUUID(),tenantIds=[`native-callback-${nonce}`,`native-callback-foreign-${nonce}`],users=[],apps=[],checks=[],cleanupFailures=[];
  const key=`whsec_${randomBytes(32).toString('base64')}`,signer=new Webhook(key),wrongSigner=new Webhook(`whsec_${randomBytes(32).toString('base64')}`);
  const capability=process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;assert.ok(capability);
  let primary,complete=false,databaseCleaned=false,ownedAppsClosed=false;
  const startedAt=new Date().toISOString(),checkpoint=name=>checks.push(name);
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const fields={id:true,tenantId:true,email:true,deletedAt:true,emailDeliverySuppressedAt:true,emailDeliverySuppressionReason:true,emailDeliveryLastEventAt:true};
  const read=()=>owner.user.findMany({where:{id:{in:users.map(row=>row.id)}},select:fields,orderBy:{id:'asc'}});
  const signed=(bytes,offset=0,sign=signer)=>{const id=`msg_${randomUUID()}`,date=new Date(Date.now()+offset*1000);return {'svix-id':id,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':sign.sign(id,date,bytes)};};
  const start=async apiKey=>{
    const config=new ConfigService({RESEND_API_KEY:apiKey,RESEND_WEBHOOK_SECRET:key});
    class CallbackModule{}
    Module({controllers:[EmailDeliveryFeedbackController],providers:[EmailDeliveryFeedbackService,{provide:ConfigService,useValue:config},{provide:TenantPrismaService,useValue:new TenantPrismaService(client)}]})(CallbackModule);
    const app=await bounded(NestFactory.create(CallbackModule,{bodyParser:false,logger:false,abortOnError:false}),'Callback retained composition');
    const sockets=track(app.getHttpServer()),entry={app,sockets,config};apps.push(entry);
    app.use(express.json({limit:cap,verify:captureRawBody}));app.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    app.useGlobalFilters(new ProductionExceptionFilter());await bounded(app.listen(0,'127.0.0.1'),'Callback retained listen');entry.port=app.getHttpServer().address().port;return entry;
  };
  const request=(entry,bytes,headers=signed(bytes),contentType='application/json')=>{
    assert.ok(Buffer.isBuffer(bytes)&&bytes.length<=cap);
    return new Promise((done,reject)=>{
      let ended=false,size=0;const chunks=[];
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:entry.port,path:'/v1/email-delivery/provider-events',method:'POST',agent:false,
        headers:{...headers,'Content-Type':contentType,'Content-Length':bytes.length}},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Callback response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Callback response failed')));res.once('aborted',()=>finish(new Error('Callback response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Callback response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Callback request deadline'));},10000);
      req.once('error',()=>finish(new Error('Callback HTTP request failed')));req.end(bytes);
    });
  };
  const unchanged=async(before,operation,status)=>{const response=await operation();assert.equal(response.status,status);assert.deepEqual(await read(),before);return response;};
  try{
    const [role]=await client.$queryRawUnsafe('SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
    for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
    const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    const [table]=await client.$queryRawUnsafe(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='"User"'::regclass`);assert.equal(table.relrowsecurity,true);assert.equal(table.relforcerowsecurity,true);
    const main=await start(`re_fixture_${randomBytes(16).toString('hex')}`),unconfigured=await start('');
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:'Private callback fixture',status:'ACTIVE'}});
    const recipient=`callback-${nonce}@example.invalid`,unrelated=`unrelated-${nonce}@example.invalid`;
    for(const [index,tenantId]of [tenantIds[0],tenantIds[1],tenantIds[0],tenantIds[1]].entries()){
      users.push(await owner.user.create({data:{tenantId,username:`callback${nonce.replaceAll('-','')}${index}`,name:'Callback fixture',role:'STAFF',
        email:index===2?unrelated:index===1?recipient.toUpperCase():recipient,deletedAt:index===3?new Date():null,
        emailDeliverySuppressedAt:null,emailDeliverySuppressionReason:null,emailDeliveryLastEventAt:null}}));
    }
    const baseline=await read();assert.equal(baseline.length,4);
    for(const row of baseline){
      const deleted=row.id===users[3].id;assert.equal(Boolean(row.deletedAt),deleted);
      // Canonical BEFORE INSERT/UPDATE privacy trigger removes deleted-user email.
      // Preserve that supported tombstone; never bypass the trigger to fake a match.
      if(deleted)assert.equal(row.email,null);
      else assert.equal(row.email.toLowerCase(),row.id===users[2].id?unrelated:recipient);
      assert.equal(row.emailDeliverySuppressedAt,null);assert.equal(row.emailDeliveryLastEventAt,null);assert.equal(row.emailDeliverySuppressionReason,null);
    }
    checkpoint('restricted-role-forced-RLS-and-four-owned-recipients');
    const occurred=new Date(Date.now()-60000),payload=(type='email.bounced',time=occurred,to=[recipient,recipient.toUpperCase()],bounce='Permanent')=>Buffer.from(JSON.stringify({type,created_at:time instanceof Date?time.toISOString():time,data:{to,bounce:{type:bounce}}},null,2));
    const bytes=payload();
    for(const header of ['svix-id','svix-timestamp','svix-signature']){const headers=signed(bytes);delete headers[header];await unchanged(baseline,()=>request(main,bytes,headers),400);}
    checkpoint('each-missing-signature-header-refused-without-write');
    await unchanged(baseline,()=>request(main,Buffer.concat([bytes,Buffer.from(' ')]),signed(bytes)),400);
    await unchanged(baseline,()=>request(main,bytes,signed(bytes,0,wrongSigner)),400);
    await unchanged(baseline,()=>request(main,bytes,{'svix-id':'invalid','svix-timestamp':'not-a-number','svix-signature':'v1,invalid'}),400);
    await unchanged(baseline,()=>request(main,bytes,signed(bytes),'text/plain'),400);checkpoint('raw-byte-tamper-wrong-key-invalid-header-missing-raw-body-refused');
    for(const offset of [-600,600])await unchanged(baseline,()=>request(main,bytes,signed(bytes,offset)),400);
    checkpoint('expired-and-future-signed-timestamps-refused');
    await unchanged(baseline,()=>request(unconfigured,bytes),503);main.config.set('RESEND_WEBHOOK_SECRET','');
    try{await unchanged(baseline,()=>request(main,bytes),503);}finally{main.config.set('RESEND_WEBHOOK_SECRET',key);}
    checkpoint('missing-key-and-missing-secret-fail-closed');
    await unchanged(baseline,()=>request(main,payload('email.complained','invalid-date')),400);checkpoint('authenticated-invalid-event-time-refused');
    for(const body of [payload('email.bounced',occurred,[recipient],'Transient'),payload('email.delivered'),payload('email.complained',occurred,[]),payload('email.complained',occurred,[null,42,'invalid'])]){
      const response=await unchanged(baseline,()=>request(main,body),200);assert.deepEqual(response.body,{received:true,suppressed:false,matchedUsers:0});
    }checkpoint('transient-unrecognized-empty-invalid-recipients-no-effect');
    // Real SQL capability refusal, never a mocked persistence exception.
    process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET=randomBytes(32).toString('hex');
    try{await unchanged(baseline,()=>request(main,bytes),500);}finally{process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET=capability;}
    checkpoint('database-capability-refusal-not-acknowledged-no-mutation');
    const assertSuppressed=async(reason,time)=>{
      const rows=await read();for(const row of rows){const original=baseline.find(item=>item.id===row.id);
        if([users[0].id,users[1].id].includes(row.id))assert.deepEqual(row,{...original,emailDeliverySuppressedAt:time,emailDeliverySuppressionReason:reason,emailDeliveryLastEventAt:time});
        else assert.deepEqual(row,original);
      }return rows;
    };
    const eventHeaders=signed(bytes),accepted=await request(main,bytes,eventHeaders);assert.equal(accepted.status,200);assert.deepEqual(accepted.body,{received:true,suppressed:true,matchedUsers:2});
    const hard=await assertSuppressed('hard_bounce',occurred);checkpoint('signed-hard-bounce-cross-tenant-active-only-independent-readback');
    const replay=await unchanged(hard,()=>request(main,bytes,eventHeaders),200);assert.deepEqual(replay.body,{received:true,suppressed:true,matchedUsers:2});checkpoint('equal-time-authenticated-replay-no-additional-business-effect');
    const older=await unchanged(hard,()=>request(main,payload('email.complained',new Date(occurred.getTime()-1000))),200);assert.deepEqual(older.body,{received:true,suppressed:true,matchedUsers:0});checkpoint('older-authenticated-event-cannot-regress-suppression');
    const complaintAt=new Date(occurred.getTime()+1000),complaint=await request(main,payload('email.complained',complaintAt));assert.equal(complaint.status,200);assert.deepEqual(complaint.body,{received:true,suppressed:true,matchedUsers:2});await assertSuppressed('complaint',complaintAt);checkpoint('newer-authenticated-complaint-exact-readback');
    const suppressedAt=new Date(occurred.getTime()+2000),suppressed=await request(main,payload('email.suppressed',suppressedAt));assert.equal(suppressed.status,200);assert.deepEqual(suppressed.body,{received:true,suppressed:true,matchedUsers:2});await assertSuppressed('provider_suppressed',suppressedAt);checkpoint('newer-authenticated-provider-suppression-exact-readback');
    assert.equal(await owner.auditLog.count({where:{tenantId:{in:tenantIds}}}),0);assert.equal(await owner.passwordResetEmailOutbox.count({where:{tenantId:{in:tenantIds}}}),0);checkpoint('no-fixture-audit-or-mail-outbox-side-effects');
    assert.equal(checks.length,14);complete=true;
  }catch(error){primary=error;}
  finally{
    process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET=capability;
    for(const entry of apps){
      await attempt(()=>bounded(entry.app.close(),'Callback app close',15000));
      await attempt(()=>bounded(Promise.all([...entry.sockets].map(socket=>new Promise(done=>{socket.once('close',done);socket.destroy();}))),'Callback socket close events',15000));
      await attempt(async()=>{assert.equal(entry.app.getHttpServer().listening,false);assert.equal(entry.sockets.size,0);});
    }
    await attempt(async()=>{assert.equal(cleanupFailures.length,0);ownedAppsClosed=true;});
    await attempt(async()=>{
      assert.equal(ownedAppsClosed,true);const userIds=users.map(row=>row.id);
      assert.equal(await owner.auditLog.count({where:{tenantId:{in:tenantIds}}}),0);assert.equal(await owner.passwordResetEmailOutbox.count({where:{tenantId:{in:tenantIds}}}),0);
      assert.equal(await owner.session.count({where:{userId:{in:userIds}}}),0);
      await owner.$transaction(async tx=>{
        const rows=await tx.tenant.findMany({where:{id:{in:tenantIds}},select:{id:true,slug:true}});for(const row of rows)assert.equal(row.id,row.slug);
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});
      assert.equal(await owner.user.count({where:{OR:[{id:{in:userIds}},{tenantId:{in:tenantIds}}]}}),0);assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);databaseCleaned=true;
    });
    for(const db of [client,owner])await attempt(()=>bounded(db.$disconnect(),'Callback Prisma disconnect'));
    await attempt(async()=>{
      const receipt={version:1,kind:'native-signed-callback-local-integration',runId:context.runId,sourceSha:context.sourceSha,startedAt,finishedAt:new Date().toISOString(),
        status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',releaseQualified:false,expectedCheckpointCount:14,completedCheckpointCount:checks.length,checkpoints:checks,
        databaseCleaned,ownedAppsClosed,fixturePreserved:!databaseCleaned,providerTraffic:false,redisUsed:false,
        transport:'owned-loopback-retained-Nest-raw-body',signing:'ephemeral-standardwebhooks-signature-verified-by-real-Resend-SDK',
        limitations:['Synthetic signed events only; no actual provider delivery/configuration','Deleted fixture is trigger-anonymized with null email; matching-email deleted-row predicate is not independently exercised','Direct retained owner only; Caddy/public ingress unexecuted','No worker, inbox, provider retention or whole-release qualification'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-signed-callback-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Callback durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native signed callback or owned cleanup failed; preserve first attempt.');
}

/** Separately selected MFA removal: real issued credentials and proofs; no mocked auth. */
export async function runNativeMfaRemoval(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const {createHmac}=require('node:crypto'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-mfa-removal-${nonce}`,`native-mfa-removal-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex');
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    AUTH_DEBUG:'false',OIDC_ENABLED:'false',RESEND_API_KEY:'',STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map(Object.keys(configuration).map(key=>[key,process.env[key]]));
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','POST /v2/auth/pin/verify','GET /v2/auth/me','GET /v2/settings',
    'PUT /v2/users/me/pin','GET /v2/auth/mfa/enrollment','POST /v2/auth/mfa/enrollment','PUT /v2/auth/mfa/enrollment',
    'POST /v2/auth/mfa/verify','DELETE /v2/auth/mfa/enrollment','POST /v2/auth/refresh','POST /v2/auth/logout']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload)=>{
    assert.ok(allowed.has(`${method} ${path}`));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  const totp=base32=>{
    let value=0,bits=0;const bytes=[];for(const letter of base32){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter);assert.ok(n>=0);value=(value<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest[digest.length-1]&15;
    return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  };
  try{
    Object.assign(process.env,configuration);
    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController],providers:[
      {provide:ConfigService,useValue:configService},{provide:TenantPrismaService,useValue:tenantDb},
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);
    for(const id of tenantIds){await owner.tenant.create({data:{id,slug:id,name:'Private MFA removal fixture',status:'ACTIVE'}});await owner.tenantSetting.create({data:{tenantId:id,key:'workspace_settings',value:{security:{requireMfaForAll:false}}}});}
    const password=`Removal!${randomBytes(16).toString('hex')}`,passwordHash=await bcrypt.hash(password,10);
    for(const [index,tenantId]of [tenantIds[0],tenantIds[0],tenantIds[1]].entries())users.push(await owner.user.create({data:{tenantId,
      username:`removal${nonce.replaceAll('-','').slice(0,12)}${index}`,name:'MFA removal fixture',role:'STAFF',passwordHash,
      pinResetRequired:false,mfaEnabled:false,mfaBackupCodes:[]}}));
    const permissions=await owner.permission.findMany({where:{key:{in:['auth:login_password','settings:read','admin_portal:access']}}});assert.equal(permissions.length,3);
    const {PRIVILEGED_MFA_PERMISSION_KEYS}=require('../../apps/api/src/auth/rbac.service.ts');assert.equal(PRIVILEGED_MFA_PERMISSION_KEYS.has('admin_portal:access'),true);
    for(const [index,user]of users.entries()){
      const role=await owner.role.create({data:{tenantId:user.tenantId,name:`MFA fixture ${index}`,slug:`mfa-removal-${index}`,isSystem:false,legacyRole:'STAFF'}});roles.push(role);
      for(const permission of permissions.filter(row=>index===1||row.key!=='admin_portal:access'))await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
      await owner.roleAssignment.create({data:{tenantId:user.tenantId,userId:user.id,roleId:role.id}});
    }
    checkpoint('restricted-RLS-optional-workspace-and-exact-privileged-permission-fixtures');
    const primaryLogin=await login(users[0],'password',password),sibling=await login(users[0],'password',password),privileged=await login(users[1],'password',password),foreign=await login(users[2],'password',password);
    assert.equal(privileged.response.body.requiresMfa,true);assert.equal(primaryLogin.response.body.requiresMfa,false);
    ok(await request('GET','/v2/settings',primaryLogin.cookies));ok(await request('GET','/v2/settings',foreign.cookies));
    checkpoint('real-credential-own-sibling-privileged-and-foreign-sessions');
    const enroll=async account=>{
      const start=await request('POST','/v2/auth/mfa/enrollment',account.cookies);ok(start);assert.match(start.body.secret,/^[A-Z2-7]{32}$/);
      const confirmation=await request('PUT','/v2/auth/mfa/enrollment',account.cookies,{code:totp(start.body.secret)});ok(confirmation);assert.equal(confirmation.body.mfaVerified,true);
      assert.equal(confirmation.body.backupCodes.length,10);const user=await owner.user.findUniqueOrThrow({where:{id:claims(account.cookies).sub}});
      assert.equal(user.mfaEnabled,true);assert.match(user.mfaSecret,/^enc:v[12]:/);assert.equal(user.mfaBackupCodes.length,10);
      assert.equal(await redis.get(`session_mfa:${account.sessionId}`),'1');return {secret:start.body.secret,codes:confirmation.body.backupCodes};
    };
    const voluntaryFactor=await enroll(primaryLogin),privilegedFactor=await enroll(privileged);
    const challenge=await request('POST','/v2/auth/mfa/verify',sibling.cookies,{code:voluntaryFactor.codes[0]});ok(challenge);
    assert.equal((await owner.user.findUniqueOrThrow({where:{id:users[0].id}})).mfaBackupCodes.length,9);
    assert.equal(await redis.get(`session_mfa:${sibling.sessionId}`),'1');ok(await request('GET','/v2/settings',sibling.cookies));
    checkpoint('actual-TOTP-enrollment-and-sibling-recovery-proof');
    const state=async()=>({
      users:await owner.user.findMany({where:{id:{in:users.map(row=>row.id)}},orderBy:{id:'asc'},select:{id:true,tenantId:true,mfaEnabled:true,mfaSecret:true,mfaBackupCodes:true}}),
      sessions:await owner.session.findMany({where:{userId:{in:users.map(row=>row.id)}},orderBy:{id:'asc'}}),
      claims:await owner.mfaTotpClaim.findMany({where:{userId:{in:users.map(row=>row.id)}},orderBy:{id:'asc'}}),
      audits:await owner.auditLog.findMany({where:{tenantId:{in:tenantIds}},orderBy:{id:'asc'}}),
      markers:await Promise.all(issuedSessions.map(async row=>({id:row.id,value:await redis.get(`session_mfa:${row.id}`)}))),
    });
    const deniedUnchanged=async(account,code)=>{const before=await state();const response=await request('DELETE','/v2/auth/mfa/enrollment',account.cookies,{code});assert.equal(response.status,403);assert.deepEqual(await state(),before);};
    await deniedUnchanged(primaryLogin,'not-a-valid-proof');checkpoint('invalid-removal-proof-preserves-factors-sessions-audits');
    await deniedUnchanged(primaryLogin,voluntaryFactor.codes[0]);checkpoint('consumed-recovery-code-cannot-remove-MFA');
    await owner.tenantSetting.update({where:{tenantId_key:{tenantId:tenantIds[0],key:'workspace_settings'}},data:{value:{security:{requireMfaForAll:true}}}});
    try{await deniedUnchanged(primaryLogin,voluntaryFactor.codes[1]);}finally{await owner.tenantSetting.update({where:{tenantId_key:{tenantId:tenantIds[0],key:'workspace_settings'}},data:{value:{security:{requireMfaForAll:false}}}});}
    checkpoint('mandatory-workspace-policy-refuses-unused-valid-proof');
    await deniedUnchanged(privileged,privilegedFactor.codes[0]);checkpoint('privileged-access-refuses-unused-valid-proof');
    const beforeRemoval=await state(),beforeUser=beforeRemoval.users.find(row=>row.id===users[0].id);
    assert.equal(beforeUser.mfaBackupCodes.length,9);const own=beforeRemoval.sessions.filter(row=>row.userId===users[0].id);
    assert.deepEqual(own.map(row=>row.id).sort(),[primaryLogin.sessionId,sibling.sessionId].sort());for(const row of own)assert.equal(row.revokedAt,null);
    const removal=await request('DELETE','/v2/auth/mfa/enrollment',primaryLogin.cookies,{code:voluntaryFactor.codes[1]});ok(removal);assert.deepEqual(removal.body,{success:true,mfaEnabled:false});
    const removed=await state();assert.deepEqual(removed.users.find(row=>row.id===users[0].id),{...beforeUser,mfaEnabled:false,mfaSecret:null,mfaBackupCodes:[]});
    for(const row of removed.users.filter(row=>row.id!==users[0].id))assert.deepEqual(row,beforeRemoval.users.find(item=>item.id===row.id));
    for(const row of removed.sessions){const previous=beforeRemoval.sessions.find(item=>item.id===row.id);assert.ok(previous);
      if(row.userId===users[0].id){assert.ok(row.revokedAt instanceof Date);assert.equal(row.mfaEnrollmentSecret,null);assert.equal(row.mfaEnrollmentExpiresAt,null);}
      else assert.deepEqual(row,previous);
    }
    assert.equal(removed.sessions.length,beforeRemoval.sessions.length);assert.deepEqual(removed.claims,beforeRemoval.claims);
    for(const session of own)assert.equal(await redis.get(`session_mfa:${session.id}`),null);
    assert.equal(await redis.get(`session_mfa:${privileged.sessionId}`),'1');checkpoint('unused-proof-removes-factor-revokes-exact-own-sessions-preserves-foreign');
    const disabled=removed.audits.filter(row=>row.action==='MFA_DISABLED');assert.equal(disabled.length,1);
    assert.equal(disabled[0].tenantId,tenantIds[0]);assert.equal(disabled[0].userId,users[0].id);assert.equal(disabled[0].actorUserId,users[0].id);assert.equal(disabled[0].actorTenantId,tenantIds[0]);
    assert.equal(disabled[0].resource,'User');assert.equal(disabled[0].resourceId,users[0].id);assert.deepEqual(disabled[0].newValue,{mfaEnabled:false,sessionsRevoked:2});
    assert.deepEqual(removed.audits.filter(row=>row.action!=='MFA_DISABLED'),beforeRemoval.audits);
    for(const row of removed.audits){const text=JSON.stringify(row);for(const sensitive of [password,voluntaryFactor.secret,privilegedFactor.secret,...voluntaryFactor.codes,...privilegedFactor.codes])assert.equal(text.includes(sensitive),false);}
    checkpoint('one-attributed-MFA-disabled-audit-exact-revocation-count-and-redaction');
    for(const account of [primaryLogin,sibling]){refused(await request('GET','/v2/settings',account.cookies));refused(await request('DELETE','/v2/auth/mfa/enrollment',account.cookies,{code:voluntaryFactor.codes[2]}));}
    ok(await request('GET','/v2/settings',foreign.cookies));ok(await request('GET','/v2/settings',privileged.cookies));checkpoint('revoked-cookies-denied-and-foreign-privileged-access-preserved');
    const fresh=await login(users[0],'password',password);assert.equal(fresh.response.body.requiresMfa,false);ok(await request('GET','/v2/settings',fresh.cookies));
    const me=await request('GET','/v2/auth/me',fresh.cookies);ok(me);assert.equal((await owner.user.findUniqueOrThrow({where:{id:users[0].id}})).mfaEnabled,false);checkpoint('new-real-login-observes-disabled-factor');
    const beforeRetry=await state(),retry=await request('DELETE','/v2/auth/mfa/enrollment',fresh.cookies,{code:'already-disabled-no-proof'});ok(retry);assert.deepEqual(retry.body,{success:true,mfaEnabled:false});assert.deepEqual(await state(),beforeRetry);
    ok(await request('GET','/v2/settings',fresh.cookies));checkpoint('already-disabled-live-session-retry-no-new-revocation-or-audit');
    const loginAudits=beforeRetry.audits.filter(row=>row.action==='SESSION_CREATED');assert.equal(loginAudits.length,5);assert.deepEqual(loginAudits.map(row=>row.resourceId).sort(),issuedSessions.map(row=>row.id).sort());
    assert.equal(beforeRetry.audits.filter(row=>row.action==='MFA_ENABLED').length,2);assert.equal(beforeRetry.audits.filter(row=>row.action==='MFA_DISABLED').length,1);
    checkpoint('exact-five-issued-session-two-enrollment-one-removal-audits');
    assert.equal(checks.length,13);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Credential native close',15000);});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Credential retained close',15000);});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Credential native Redis close');});
    await attempt(async()=>{
      // destroy() initiates closure; ownership settles only after every close event.
      const sockets=[...appSockets,...retainedSockets];
      await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{
        socket.once('close',done);socket.destroy();
      }))),'Credential owned socket close events',15000);
    });
    await attempt(async()=>{assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;});
    await attempt(async()=>{
      assert.equal(closed,true);if(redis.status==='ready')await snapshotKeys();
      const userIds=users.map(row=>row.id),roleIds=roles.map(row=>row.id);
      const storedSessions=await owner.session.findMany({where:{userId:{in:userIds}},select:{id:true,userId:true}});
      const sessionIds=[...new Set([...storedSessions.map(row=>row.id),...issuedSessions.map(row=>row.id)])];
      for(const row of issuedSessions)assert.ok(userIds.includes(row.userId));
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)));
      const audits=await owner.auditLog.findMany({where:{tenantId:{in:tenantIds}},select:{action:true,resourceId:true}});
      for(const row of audits){assert.ok(['SESSION_CREATED','MFA_ENABLED','MFA_DISABLED'].includes(row.action),'Preserve unexpected fixture audit');assert.ok([...userIds,...sessionIds].includes(row.resourceId));}
      assert.equal(await owner.creditTransaction.count({where:{tenantId:{in:tenantIds}}}),0);
      assert.equal(await owner.passwordResetEmailOutbox.count({where:{tenantId:{in:tenantIds}}}),0);
      const claimScope={OR:[{tenantId:{in:tenantIds}},{userId:{in:userIds}}]};
      const claims=await owner.mfaTotpClaim.findMany({where:claimScope,select:{id:true,tenantId:true,userId:true}});
      assert.ok(claims.length<=2,'Only two enrollment TOTP proofs may create fixture claims');
      assert.equal(new Set(claims.map(row=>row.userId)).size,claims.length);
      for(const claim of claims){assert.equal(claim.tenantId,tenantIds[0]);assert.ok([users[0]?.id,users[1]?.id].includes(claim.userId));}
      await owner.$transaction(async tx=>{
        const tenants=await tx.tenant.findMany({where:{id:{in:tenantIds}},select:{id:true,slug:true}});for(const row of tenants)assert.equal(row.id,row.slug);
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        // Replica-mode teardown suppresses FK cascades; explicitly delete exact claims.
        for(const claim of claims){const removed=await tx.mfaTotpClaim.deleteMany({where:{id:claim.id,tenantId:claim.tenantId,userId:claim.userId}});assert.equal(removed.count,1);}
        assert.equal(await tx.mfaTotpClaim.count({where:claimScope}),0);
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.auditLog.deleteMany({where:{tenantId:{in:tenantIds},resourceId:{in:[...userIds,...sessionIds]},action:{in:['SESSION_CREATED','MFA_ENABLED','MFA_DISABLED']}}});
        await tx.roleAssignment.deleteMany({where:{tenantId:{in:tenantIds},userId:{in:userIds},roleId:{in:roleIds}}});await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.role.deleteMany({where:{id:{in:roleIds},tenantId:{in:tenantIds}}});
        await tx.tenantSetting.deleteMany({where:{tenantId:{in:tenantIds}}});await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);
      assert.equal(await owner.mfaTotpClaim.count({where:claimScope}),0);databaseCleaned=true;
      if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Exact credential Redis-key cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Credential Redis disconnect');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Credential Prisma disconnect'));
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const receipt={version:1,kind:'native-mfa-removal-local-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,
        startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',
        expectedCheckpointCount:13,completedCheckpointCount:checks.length,checkpoints:checks,apiPort,retainedPort,
        transport:'owned-loopback-native-v2-to-real-retained-auth',credentialSource:'HTTP-issued cookies only; no synthetic session/JWT/MFA markers',
        databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        limitations:['Scoped real Nest auth composition, not full AppModule/production ingress','Local development cookie transport, not TLS secure-cookie proof','No browser/provider/password-reset-outbox/concurrent-authority or expiry-wait rollback qualification','Removal positive uses unused recovery code; new TOTP step removal not exercised','No response-loss/restart or postcommit Redis-outage qualification'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-mfa-removal-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Credential durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native MFA removal or owned cleanup failed; preserve first attempt.');
}

// C03 scoped native publication support. Appended after existing source only.
// Preparation draft: main entry/fixture teardown remain unsealed; not runnable admission.
async function publicationNoProviderInvariant(owner) {
  // Global sweep owners require an entirely exclusive disposable database.
  assert.equal(await owner.scheduleSolveJob.count(), 0, 'No global solve work is admitted');
  assert.equal(await owner.webhookEndpoint.count(), 0, 'No webhook endpoint is admitted');
  assert.equal(await owner.webhookDelivery.count(), 0, 'No webhook delivery is admitted');
}

function publicationRealProviders(require, tenantDb, configService) {
  const {ModuleRef}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {SchedulesController}=require('../../apps/api/src/schedules/schedules.controller.ts');
  const {MeteringService}=require('../../apps/api/src/billing/metering.service.ts');
  const {FeatureAccessService}=require('../../apps/api/src/billing/feature-access.service.ts');
  const {EmailDeliveryFeedbackService}=require('../../apps/api/src/email-delivery/email-delivery-feedback.service.ts');
  const {SchedulePublishedEmailService}=require('../../apps/api/src/email-delivery/schedule-published-email.service.ts');
  const {NotificationsService}=require('../../apps/api/src/notifications/notifications.service.ts');
  const {MetricsService}=require('../../apps/api/src/common/metrics.service.ts');
  const {WebhookDeliveryStore}=require('../../apps/api/src/webhooks/webhook-delivery.store.ts');
  const {WebhooksService}=require('../../apps/api/src/webhooks/webhooks.service.ts');
  assert.equal(configService.get('SCHEDULE_PUBLISHED_EMAIL_ENABLED'),'false');
  for(const key of ['RESEND_API_KEY','RESEND_WEBHOOK_SECRET']) {
    assert.equal(configService.get(key),undefined);assert.equal(process.env[key],undefined);
  }
  return {controller:SchedulesController, providers:[
    {provide:ConfigService,useValue:configService},
    {provide:TenantPrismaService,useValue:tenantDb},MetricsService,
    {provide:MeteringService,useFactory:db=>new MeteringService(db),inject:[TenantPrismaService]},
    {provide:FeatureAccessService,useFactory:(meter,db)=>new FeatureAccessService(meter,db),inject:[MeteringService,TenantPrismaService]},
    {provide:EmailDeliveryFeedbackService,useFactory:(config,db)=>new EmailDeliveryFeedbackService(config,db),inject:[ConfigService,TenantPrismaService]},
    {provide:SchedulePublishedEmailService,useFactory:(config,feedback)=>new SchedulePublishedEmailService(config,feedback),inject:[ConfigService,EmailDeliveryFeedbackService]},
    {provide:NotificationsService,useFactory:(config,modules,email,db)=>new NotificationsService(config,modules,email,db),inject:[ConfigService,ModuleRef,SchedulePublishedEmailService,TenantPrismaService]},
    {provide:WebhookDeliveryStore,useFactory:(config,db)=>new WebhookDeliveryStore(config,db),inject:[ConfigService,TenantPrismaService]},
    {provide:WebhooksService,useFactory:(config,store,features)=>new WebhooksService(config,store,features),inject:[ConfigService,WebhookDeliveryStore,FeatureAccessService]},
  ]};
}

async function publicationDurableSnapshot(owner, tenantId, scheduleIds) {
  return owner.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return {
      tenant:await tx.tenant.findUniqueOrThrow({where:{id:tenantId},select:{usageCredits:true,creditDebt:true}}),
      schedules:await tx.schedule.findMany({where:{tenantId,id:{in:scheduleIds}},select:{id:true,publicId:true,status:true,revision:true,publishedAt:true},orderBy:{id:'asc'}}),
      credits:await tx.creditTransaction.findMany({where:{tenantId},orderBy:{id:'asc'}}),
      audits:await tx.auditLog.findMany({where:{tenantId},orderBy:{id:'asc'}}),
      changes:await tx.scheduleChangeSet.findMany({where:{tenantId},orderBy:{id:'asc'}}),
      intents:await tx.notificationOutbox.findMany({where:{tenantId},orderBy:{id:'asc'}}),
      notifications:await tx.notification.findMany({where:{tenantId},orderBy:{id:'asc'}}),
      deliveries:await tx.webhookDelivery.findMany({where:{tenantId},orderBy:{id:'asc'}}),
    };
  },{isolationLevel:'RepeatableRead',maxWait:5000,timeout:10000});
}

async function publicationAwaitLocalIntents(owner,tenantId,expected) {
  // Real synchronous delivery/background sweep may race. Never require PENDING.
  const deadline=Date.now()+15000;
  while(true) {
    const intents=await owner.notificationOutbox.findMany({where:{tenantId},orderBy:{dedupeKey:'asc'}});
    assert.equal(intents.length,expected.length,'No additional logical intent');
    assert.deepEqual(intents.map(row=>row.dedupeKey).sort(),expected.map(row=>row.dedupeKey).sort());
    for(const row of intents) {
      assert.equal(row.userId,expected.find(item=>item.dedupeKey===row.dedupeKey).userId);
      assert.equal(row.notificationType,'SCHEDULE_PUBLISHED');
      assert.ok(['PENDING','PROCESSING','DELIVERED'].includes(row.status),'Failure state is not a successful notification');
    }
    if(intents.every(row=>row.status==='DELIVERED')) {
      const notifications=await owner.notification.findMany({where:{tenantId},orderBy:{id:'asc'}});
      assert.equal(notifications.length,expected.length);
      for(const row of intents) {
        assert.equal(row.title,'');assert.equal(row.body,'');assert.equal(row.leaseUntil,null);assert.ok(row.deliveredAt);
        const notification=notifications.find(item=>item.id===row.id);assert.ok(notification,'Real processor persists Notification using intent ID');
        assert.equal(notification.userId,row.userId);assert.equal(notification.type,'SCHEDULE_PUBLISHED');
        assert.equal(notification.title,'Schedule published');assert.ok(notification.body.length>0);
      }
      return {intents,notifications,emailDeliveryQualified:false};
    }
    assert.ok(Date.now()<deadline,'Real local notification settlement exceeded finite deadline');
    await new Promise(done=>setTimeout(done,50));
  }
}

export async function runNativeSchedulePublication(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const {createHmac}=require('node:crypto'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-publication-${nonce}`,`native-publication-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex');
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    AUTH_DEBUG:'false',OIDC_ENABLED:'false',SCHEDULE_PUBLISHED_EMAIL_ENABLED:'false',WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT:process.env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT,STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map([...Object.keys(configuration),'RESEND_API_KEY','RESEND_WEBHOOK_SECRET'].map(key=>[key,process.env[key]]));
  delete process.env.RESEND_API_KEY;delete process.env.RESEND_WEBHOOK_SECRET;
  const fixtureRows=new Map(),schedules=[],domainReadbacks=[];let location;
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','POST /v2/auth/pin/verify','GET /v2/auth/me','GET /v2/settings',
    'PUT /v2/users/me/pin','GET /v2/auth/mfa/enrollment','POST /v2/auth/mfa/enrollment','PUT /v2/auth/mfa/enrollment',
    'POST /v2/auth/mfa/verify','POST /v2/auth/refresh','POST /v2/auth/logout']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload,extraHeaders={})=>{
    assert.ok(allowed.has(`${method} ${path}`)||(/^\/v2\/schedules\/[a-f0-9-]{36}\/(publish-plan|publications|reopenings|demand-windows)$/.test(path)&&['GET','POST','PUT'].includes(method))||(method==='GET'&&/^\/v2\/schedule-board\?date=2026-10-12&view=week$/.test(path)));
    for(const key of Object.keys(extraHeaders))assert.ok(['Idempotency-Key','If-Match'].includes(key));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    Object.assign(headers,extraHeaders);
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  const totp=base32=>{
    let value=0,bits=0;const bytes=[];for(const letter of base32){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter);assert.ok(n>=0);value=(value<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest[digest.length-1]&15;
    return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  };
  try{
    Object.assign(process.env,configuration);
    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    await publicationNoProviderInvariant(owner);assert.equal(await owner.notificationOutbox.count(),0);
    const graph=publicationRealProviders(require,tenantDb,configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController,graph.controller],providers:[...graph.providers,
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);
    // Synthetic rows are setup only; every publication/reopening is real HTTP.
    const tenantId=tenantIds[0],scope={tenantId};
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:'Private publication fixture',status:'ACTIVE',planTier:'GROWTH',stripeSubscriptionId:`sub-${nonce}-${id}`,stripeSubscriptionCurrentPeriodEnd:new Date(Date.now()+86400000),usageCredits:100}});
    for(const id of tenantIds)await owner.creditTransaction.create({data:{id:`fixture-grant-${id}`,tenantId:id,amount:100,balanceAfter:100,reason:'Owned test credit grant'}});
    const password=`Publication!${randomBytes(16).toString('hex')}`,passwordHash=await bcrypt.hash(password,10);
    const permissionKeys=['auth:login_password','settings:read','locations:read','schedules:read','shifts:read','schedules:publish','schedules:write'];
    const catalog=await owner.permission.findMany({where:{key:{in:permissionKeys}}});assert.deepEqual(catalog.map(x=>x.key).sort(),permissionKeys.slice().sort());
    for(let i=0;i<5;i++) {
      const tid=i===4?tenantIds[1]:tenantId,manager=i<2;
      const user=await owner.user.create({data:{tenantId:tid,username:`pub${nonce.replaceAll('-','').slice(0,12)}${i}`,name:'Publication fixture',role:manager?'MANAGER':'STAFF',passwordHash,mfaEnabled:false,mfaBackupCodes:[],email:null}});users.push(user);
      // Share the exact least-privilege fixture role within a tenant; Role names are tenant-unique.
      const roleName=manager?'MANAGER':'STAFF';
      let role=roles.find(row=>row.tenantId===tid&&row.name===roleName);
      if(!role) {
        role=await owner.role.create({data:{tenantId:tid,name:roleName,slug:`publication-${i}`,isSystem:true,legacyRole:roleName}});roles.push(role);
        for(const permission of catalog.filter(x=>manager||!['schedules:publish','schedules:write'].includes(x.key)))await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
      }
      await owner.roleAssignment.create({data:{tenantId:tid,userId:user.id,roleId:role.id}});
    }
    location=await owner.location.create({data:{tenantId,name:'Publication UTC',timezone:'UTC'}});
    for(let day=0;day<7;day++)await owner.staffAvailability.create({data:{tenantId,userId:users[2].id,locationId:location.id,dayOfWeek:day,startTimeMinutes:540,endTimeMinutes:780}});
    for(let i=0;i<2;i++) {
      const date=`2026-10-${12+i}`,schedule=await owner.schedule.create({data:{tenantId,locationId:location.id,startDate:new Date(`${date}T00:00:00Z`),endDate:new Date(`2026-10-${13+i}T00:00:00Z`),status:'DRAFT'}});schedules.push(schedule);
      await owner.shift.create({data:{tenantId,locationId:location.id,scheduleId:schedule.id,userId:users[2].id,startTime:new Date(`${date}T09:00:00Z`),endTime:new Date(`${date}T13:00:00Z`),role:'STAFF'}});
      await owner.scheduleDemandWindow.create({data:{tenantId,locationId:location.id,scheduleId:schedule.id,startTime:new Date(`${date}T09:00:00Z`),endTime:new Date(`${date}T13:00:00Z`),requiredStaff:1}});
    }
    const accounts=[];
    for(const user of users)accounts.push(await login(user,'password',password));
    for(const i of [0,1]) {
      const enrollment=await request('POST','/v2/auth/mfa/enrollment',accounts[i].cookies);ok(enrollment);
      const confirmation=await request('PUT','/v2/auth/mfa/enrollment',accounts[i].cookies,{code:totp(enrollment.body.secret)});ok(confirmation);assert.equal(confirmation.body.mfaVerified,true);
      assert.equal(await redis.get(`session_mfa:${accounts[i].sessionId}`),'1');
    }
    checkpoint('real-manager-staff-foreign-login-and-manager-TOTP');
    const A=schedules[0],B=schedules[1],path=(s,tail)=>`/v2/schedules/${s.publicId}/${tail}`;
    const board=async index=>{const response=await request('GET','/v2/schedule-board?date=2026-10-12&view=week',accounts[index].cookies);ok(response);return response.body.data;};
    const etag=async s=>{const row=(await board(0)).schedules.find(x=>x.id===s.publicId);assert.ok(row);assert.equal(typeof row.etag,'string');return row.etag;};
    const inspect=async()=>{const value=await publicationDurableSnapshot(owner,tenantId,schedules.map(x=>x.id));domainReadbacks.push(value);return value;};
    for(const i of [2,3,4])assert.equal((await board(i)).shifts.length,0);
    checkpoint('draft-invisible-to-assigned-unassigned-foreign-staff');
    const initialPlan=await request('GET',path(A,'publish-plan'),accounts[0].cookies);ok(initialPlan);
    assert.equal(initialPlan.body.scheduleId,A.publicId);assert.equal(initialPlan.body.matchingWebhookDeliveryCount,0);assert.equal(initialPlan.body.matchingWebhookDeliveryCost,0);
    assert.equal(initialPlan.body.sufficientCredits,true);assert.ok(initialPlan.body.totalConfiguredCost>0);
    checkpoint('authoritative-configured-cost-and-zero-webhook-plan');
    const edit=await request('PUT',path(A,'demand-windows'),accounts[1].cookies,{windows:[{startTime:'2026-10-12T09:00:00.000Z',endTime:'2026-10-12T12:00:00.000Z',requiredStaff:1,skill:null}]},{'Idempotency-Key':`draft-edit-${nonce}`,'If-Match':await etag(A)});ok(edit);
    const afterEdit=await inspect();const stale=await request('POST',path(A,'publications'),accounts[0].cookies,{acceptedContract:initialPlan.body.acceptedContract},{'Idempotency-Key':`stale-publish-${nonce}`});assert.ok([400,409].includes(stale.status));assert.deepEqual(await inspect(),afterEdit);
    checkpoint('actual-second-manager-draft-edit-stale-contract-atomic-refusal');
    const plan=await request('GET',path(A,'publish-plan'),accounts[0].cookies);ok(plan);assert.notEqual(plan.body.acceptedContract.version,initialPlan.body.acceptedContract.version);
    const publishKey=`publish-A-${nonce}`,issued={acceptedContract:structuredClone(plan.body.acceptedContract)},before=await inspect();
    const result=await request('POST',path(A,'publications'),accounts[0].cookies,issued,{'Idempotency-Key':publishKey});ok(result);assert.equal(result.body.id,A.publicId);assert.equal(result.body.status,'PUBLISHED');assert.deepEqual(result.body.settlement.acceptedContract,issued.acceptedContract);
    assert.equal(result.body.settlement.creditsConsumed,plan.body.totalConfiguredCost);assert.equal(result.body.settlement.newBalance,before.tenant.usageCredits-plan.body.totalConfiguredCost);assert.deepEqual(result.body.settlement.ledgerIdentities.webhookDeliveries,[]);
    const expected=[{dedupeKey:`schedule-published:${A.id}:revision-${issued.acceptedContract.version}:${users[2].id}`,userId:users[2].id}];
    await publicationAwaitLocalIntents(owner,tenantId,expected);await publicationNoProviderInvariant(owner);
    const settled=await inspect();assert.equal(settled.credits.length,before.credits.length+1);assert.equal(settled.audits.length,before.audits.length+1);assert.equal(settled.deliveries.length,0);
    const debit=settled.credits.find(row=>row.id===result.body.settlement.ledgerIdentities.schedule);assert.ok(debit);assert.equal(debit.amount,-plan.body.totalConfiguredCost);assert.equal(debit.balanceAfter,result.body.settlement.newBalance);
    assert.equal(settled.tenant.usageCredits,result.body.settlement.newBalance,'Actual PostgreSQL wallet equals issued settlement');
    assert.equal(settled.tenant.creditDebt,before.tenant.creditDebt,'Publication does not create debt');
    const beforeA=before.schedules.find(row=>row.id===A.id),settledA=settled.schedules.find(row=>row.id===A.id);
    assert.equal(beforeA.status,'DRAFT');assert.equal(beforeA.revision,issued.acceptedContract.version);
    assert.deepEqual(settledA,{...beforeA,status:'PUBLISHED',publishedAt:new Date(result.body.publishedAt)});
    assert.deepEqual(settled.schedules.find(row=>row.id===B.id),before.schedules.find(row=>row.id===B.id),'Publishing A leaves B unchanged');
    assert.deepEqual(settled.audits.filter(row=>before.audits.some(old=>old.id===row.id)),before.audits);
    const publishAudits=settled.audits.filter(row=>!before.audits.some(old=>old.id===row.id));assert.equal(publishAudits.length,1);
    const publishAudit=publishAudits[0];assert.equal(publishAudit.action,'SCHEDULE_PUBLISH');assert.equal(publishAudit.resource,'SchedulePublishRequest');
    assert.equal(publishAudit.tenantId,tenantId);assert.equal(publishAudit.userId,users[0].id);assert.equal(publishAudit.actorUserId,users[0].id);assert.equal(publishAudit.actorTenantId,tenantId);
    assert.equal(result.body.settlement.ledgerIdentities.schedule,`feature-usage-schedule-publish:${publishAudit.resourceId}`);
    assert.deepEqual(publishAudit.newValue.acceptedContract,issued.acceptedContract);assert.deepEqual(publishAudit.newValue.response.settlement,result.body.settlement);

    checkpoint('real-publication-single-configured-debit-and-original-balance');
    checkpoint('real-inapp-intent-notification-settlement-email-disabled');
    const staff=await board(2);assert.equal(staff.shifts.length,1);assert.equal(staff.shifts[0].scheduleId,A.publicId);
    for(const i of [3,4])assert.equal((await board(i)).shifts.length,0);
    checkpoint('published-only-own-assigned-staff-visibility');
    const bPlan=await request('GET',path(B,'publish-plan'),accounts[0].cookies);ok(bPlan);
    const replay=await request('POST',path(A,'publications'),accounts[0].cookies,issued,{'Idempotency-Key':publishKey});ok(replay);assert.deepEqual(replay.body.settlement,result.body.settlement);assert.deepEqual(await inspect(),settled);
    checkpoint('same-key-A-replay-after-B-review-no-second-settlement');
    const conflicting=await request('POST',path(A,'publications'),accounts[0].cookies,{acceptedContract:{...issued.acceptedContract,version:issued.acceptedContract.version+1}},{'Idempotency-Key':publishKey});assert.equal(conflicting.status,409);assert.deepEqual(await inspect(),settled);
    checkpoint('changed-publication-body-same-key-conflicts');
    const reopenKey=`reopen-A-${nonce}`,publishedEtag=await etag(A);
    const missing=await request('POST',path(A,'reopenings'),accounts[0].cookies,undefined,{'Idempotency-Key':reopenKey});assert.equal(missing.status,428);assert.deepEqual(await inspect(),settled);
    const reopened=await request('POST',path(A,'reopenings'),accounts[0].cookies,undefined,{'Idempotency-Key':reopenKey,'If-Match':publishedEtag});ok(reopened);
    const afterReopen=await inspect();assert.equal(afterReopen.schedules.find(row=>row.id===A.id).status,'DRAFT');assert.deepEqual(afterReopen.credits,settled.credits);assert.deepEqual(afterReopen.audits.filter(row=>settled.audits.some(old=>old.id===row.id)),settled.audits);
    const reopenAudits=afterReopen.audits.filter(row=>!settled.audits.some(old=>old.id===row.id));assert.equal(reopenAudits.length,1,'One exact reopening audit');
    const reopenAudit=reopenAudits[0];assert.equal(reopenAudit.action,'SCHEDULE_REOPENED');assert.equal(reopenAudit.resource,'schedule');assert.equal(reopenAudit.resourceId,A.publicId);
    assert.equal(reopenAudit.tenantId,tenantId);assert.equal(reopenAudit.userId,users[0].id);assert.equal(reopenAudit.actorUserId,users[0].id);assert.equal(reopenAudit.actorTenantId,tenantId);
    assert.deepEqual(reopenAudit.oldValue,{status:'PUBLISHED',revision:settledA.revision});assert.deepEqual(reopenAudit.newValue,{status:'DRAFT',revision:settledA.revision+1});
    assert.deepEqual(afterReopen.schedules.find(row=>row.id===A.id),{...settledA,status:'DRAFT',publishedAt:null,revision:settledA.revision+1});
    assert.deepEqual(afterReopen.schedules.find(row=>row.id===B.id),settled.schedules.find(row=>row.id===B.id));assert.deepEqual(afterReopen.tenant,settled.tenant);
    assert.deepEqual(afterReopen.intents,settled.intents);assert.equal(afterReopen.changes.length,settled.changes.length+1);
    for(const i of [2,3,4])assert.equal((await board(i)).shifts.length,0);
    checkpoint('bodyless-reopen-current-etag-history-preserved-draft-hidden');
    const newer=await etag(A);assert.notEqual(newer,publishedEtag);const reopenReplay=await request('POST',path(A,'reopenings'),accounts[0].cookies,undefined,{'Idempotency-Key':reopenKey,'If-Match':newer});ok(reopenReplay);assert.deepEqual(reopenReplay.body,reopened.body);assert.deepEqual(await inspect(),afterReopen);
    checkpoint('same-schedule-reopen-key-replays-with-newer-etag');
    const other=await request('POST',path(B,'reopenings'),accounts[0].cookies,undefined,{'Idempotency-Key':reopenKey,'If-Match':await etag(B)});assert.equal(other.status,409);assert.equal(other.body.code,'idempotency_key_reused');assert.deepEqual(await inspect(),afterReopen);
    checkpoint('reopen-same-key-different-schedule-conflicts');
    await publicationNoProviderInvariant(owner);assert.equal(checks.length,12);complete=true;
  }catch(error){primary=error;}
  finally{
    let nativeClosed=false,retainedClosed=false;
    await attempt(async()=>{if(app)await bounded(app.close(),'Publication native close',15000);nativeClosed=true;});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Publication real retained hooks close',15000);retainedClosed=true;});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Publication native Redis close');});
    await attempt(async()=>{
      const sockets=[...appSockets,...retainedSockets];
      await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{socket.once('close',done);socket.destroy();}))),'Publication socket close events',15000);
      assert.ok(nativeClosed&&retainedClosed,'Outer socket reap does not substitute for successful real hooks');
      assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;
    });
    await attempt(async()=>{
      assert.equal(closed,true,'Never delete fixtures while real owner hooks remain unsettled');
      await publicationNoProviderInvariant(owner);if(redis.status==='ready')await snapshotKeys();
      const userIds=users.map(x=>x.id),roleIds=roles.map(x=>x.id);
      const sessions=await owner.session.findMany({where:{userId:{in:userIds}}});const sessionIds=[...new Set([...sessions.map(x=>x.id),...issuedSessions.map(x=>x.id)])];
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)));
      // Freeze exact nonce-owned roster before disposal; no unbounded deletes.
      const models=['notification','notificationOutbox','auditLog','creditTransaction','scheduleChangeSet','shift','scheduleDemandWindow','schedule','staffAvailability','tenantSetting'];
      for(const model of models) {
        const rows=await owner[model].findMany({where:{tenantId:{in:tenantIds}},select:{id:true,tenantId:true}});
        for(const row of rows)assert.ok(tenantIds.includes(row.tenantId));fixtureRows.set(model,rows.map(x=>x.id));
      }
      const audits=await owner.auditLog.findMany({where:{id:{in:fixtureRows.get('auditLog')}}});
      const allowedActions=['SESSION_CREATED','MFA_ENABLED','SCHEDULE_PUBLISH','SCHEDULE_REOPENED','SCHEDULE_DEMAND_REPLACED'];
      for(const audit of audits)assert.ok(allowedActions.includes(audit.action),'Unexpected audit retained for review');
      const credits=await owner.creditTransaction.findMany({where:{id:{in:fixtureRows.get('creditTransaction')}}});
      for(const credit of credits)assert.ok(credit.id===`fixture-grant-${credit.tenantId}`||credit.id.startsWith('feature-usage-schedule-publish:'),'Unexpected ledger retained');
      const claims=await owner.mfaTotpClaim.findMany({where:{userId:{in:userIds}}});assert.ok(claims.length<=2);
      for(const claim of claims){assert.equal(claim.tenantId,tenantIds[0]);assert.ok(users.slice(0,2).some(x=>x.id===claim.userId));}
      await owner.$transaction(async tx=>{
        // Parent-authorized test disposal exception only, after real hooks and
        // financial assertions. No publication/setup constraints are bypassed.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        for(const model of models)await tx[model].deleteMany({where:{id:{in:fixtureRows.get(model)},tenantId:{in:tenantIds}}});
        for(const claim of claims)await tx.mfaTotpClaim.deleteMany({where:{id:claim.id,tenantId:claim.tenantId,userId:claim.userId}});
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.roleAssignment.deleteMany({where:{tenantId:{in:tenantIds},userId:{in:userIds},roleId:{in:roleIds}}});await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.role.deleteMany({where:{id:{in:roleIds},tenantId:{in:tenantIds}}});
        await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});if(location)await tx.location.deleteMany({where:{id:location.id,tenantId:tenantIds[0]}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});
      assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);for(const model of models)assert.equal(await owner[model].count({where:{id:{in:fixtureRows.get(model)}}}),0);assert.equal(await owner.mfaTotpClaim.count({where:{userId:{in:userIds}}}),0);databaseCleaned=true;
      if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Exact publication Redis cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Publication Redis quit');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Publication Prisma disconnect'));
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const readbackBytes=Buffer.from(JSON.stringify({sourceSha:context.sourceSha,runId:context.runId,tenantIds,domainReadbacks},null,2)+'\n');assert.ok(readbackBytes.length<=2*1024*1024);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-publication-readbacks-${nonce}.json`,readbackBytes,{flag:'wx',mode:0o600}),'Publication SQL readbacks');
      const receipt={version:1,kind:'native-schedule-publication-local-integration',runId:context.runId,sourceSha:context.sourceSha,releaseQualified:false,
        startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',expectedCheckpointCount:12,completedCheckpointCount:checks.length,checkpoints:checks,
        databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        lifecycle:{nativeClosed,retainedClosed,outerReapingIsNotHealthyClose:true},
        limits:['Real narrow owner composition, not fullAppModule/browser/TLS','Email explicitly disabled; local DELIVERED is not email/provider proof','No RabbitMQ or webhook transport; globally empty solve/endpoints','Recorded successful-response replay only, not transport response-loss','After-wait authority/production stalled-shutdown qualification remains pending','Transaction-local exact synthetic fixture disposal is not immutable-delete product proof'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-schedule-publication-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Publication durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native publication or owned cleanup failed; preserve first attempt');
}

/** Scoped native retention HTTP/PG qualification; no provider or operating-time claim. */
export async function runNativeRetentionPurge(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const {createHmac}=require('node:crypto'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AdminController}=require('../../apps/api/src/admin/admin.controller.ts');
  const {MetricsService}=require('../../apps/api/src/common/metrics.service.ts');
  const {MeteringService}=require('../../apps/api/src/billing/metering.service.ts');
  const {readdir,rmdir}=require('node:fs/promises');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-retention-auth-${nonce}`,`native-retention-auth-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex'),serviceToken=randomBytes(32).toString('base64url');
  let retentionTenants=[],retentionUsers=[],retentionSignupIds=[];
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    AUTH_DEBUG:'false',OIDC_ENABLED:'false',RESEND_API_KEY:'',STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET,RETENTION_PURGE_SERVICE_TOKEN:serviceToken,RETENTION_PURGE_SERVICE_TOKEN_FILE:'',
    TENANT_EXPORT_ARTIFACT_DIRECTORY:resolve(context.workspace,`retention-exports-${nonce}`)};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map(Object.keys(configuration).map(key=>[key,process.env[key]]));
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','POST /v2/auth/pin/verify','GET /v2/auth/me','GET /v2/settings',
    'PUT /v2/users/me/pin','GET /v2/auth/mfa/enrollment','POST /v2/auth/mfa/enrollment','PUT /v2/auth/mfa/enrollment',
    'POST /v2/auth/mfa/verify','POST /v2/auth/refresh','POST /v2/auth/logout','POST /v2/admin/retention/purge-expired']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload,bearer)=>{
    assert.ok(allowed.has(`${method} ${path}`));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(bearer)headers.Authorization=`Bearer ${bearer}`;
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  const totp=base32=>{
    let value=0,bits=0;const bytes=[];for(const letter of base32){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter);assert.ok(n>=0);value=(value<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest[digest.length-1]&15;
    return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  };
  try{
    Object.assign(process.env,configuration);
    assert.equal(await owner.tenant.count(),0,'Exclusive retention fixture requires no existing tenant or unrelated global sweep work');
    assert.equal(await owner.onboardingSignupAttempt.count(),0);assert.equal(await owner.staffInvitationOutbox.count(),0);
    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController,AdminController],providers:[MetricsService,MeteringService,
      {provide:ConfigService,useValue:configService},{provide:TenantPrismaService,useValue:tenantDb},
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);
    const day=86400000,now=new Date(),old=new Date(now.getTime()-31*day),recent=new Date(now.getTime()-29*day);
    const ownedTenants=[],fixtureUsers=[],fixedTables=['AuditLog','BillingEvent','StripeUsageEvent','CreditTransaction','PayrollLockedEntry','PayrollTimeCardApproval','TimeCard','PayrollPeriod','PayrollPolicyVersion','User','TenantSetting','Tenant'];
    // Roster is shared with finally before fixture creation starts.
    retentionTenants=ownedTenants;retentionUsers=fixtureUsers;
    const tenant=async(label,data={})=>{const id=`native-retention-${nonce}-${label}`;ownedTenants.push(id);await owner.tenant.create({data:{id,slug:id,name:'Retention fixture',status:'ACTIVE',...data}});return id;};
    const person=async(tenantId,label)=>{const id=`retention-user-${nonce}-${label}`;fixtureUsers.push(id);return owner.user.create({data:{id,tenantId,name:'Retention fixture',role:'STAFF',mfaEnabled:false,mfaBackupCodes:[]}});};
    const snapshot=async ids=>{
      const result={};for(const table of fixedTables){const column=table==='Tenant'?'id':'tenantId';result[table]=await owner.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${column}" = ANY($1::text[]) ORDER BY "id"`,ids);}
      return result;
    };
    const emptyBilling=async()=>{assert.equal(await owner.tenantDeletionBillingReconciliation.count({where:{state:'PENDING'}}),0,'No pending billing may enter this no-provider slice');assert.equal(await owner.tenantExportJob.count(),0,'No unrelated export work permitted');};
    const eligibility=async(stage='application_data')=>{await emptyBilling();const {buildExpiredTenantApplicationDataWhere,buildExpiredTenantRetentionWhere}=require('../../apps/api/src/admin/tenant-account-lifecycle.ts');return (await owner.tenant.findMany({where:stage==='application_data'?buildExpiredTenantApplicationDataWhere(new Date()):buildExpiredTenantRetentionWhere(new Date()),orderBy:[{deletedAt:'asc'},{id:'asc'}],select:{id:true}})).map(row=>row.id);};
    const invoke=async(body,bearer=serviceToken,cookies=jar())=>{await emptyBilling();return request('POST','/v2/admin/retention/purge-expired',cookies,body,bearer);};
    const good=response=>{ok(response);assert.equal(response.body.failedTenantCount,0);assert.equal(response.body.skippedTenantCount,0);assert.deepEqual(response.body.pendingDeletionBillingCandidates,[]);return response.body;};
    const hash=()=>randomBytes(32).toString('hex');
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:'Retention auth fixture',status:'ACTIVE'}});
    const password=`Retention!${randomBytes(16).toString('hex')}`,passwordHash=await bcrypt.hash(password,10);
    for(const [index,tenantId]of tenantIds.entries())users.push(await owner.user.create({data:{tenantId,username:`retention${nonce.replaceAll('-','').slice(0,12)}${index}`,name:'Retention authority',role:'STAFF',passwordHash,mfaEnabled:false,mfaBackupCodes:[]}}));
    const permissions=await owner.permission.findMany({where:{key:{in:['auth:login_password','settings:read','admin_portal:access']}}});assert.equal(permissions.length,3);
    for(const [index,user]of users.entries()){const role=await owner.role.create({data:{tenantId:user.tenantId,name:'Retention authority',slug:'retention-authority',legacyRole:'STAFF'}});roles.push(role);for(const permission of permissions.filter(row=>index===0||row.key!=='admin_portal:access'))await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await owner.roleAssignment.create({data:{tenantId:user.tenantId,userId:user.id,roleId:role.id}});}
    const admin=await login(users[0],'password',password),customer=await login(users[1],'password',password);
    assert.equal(admin.response.body.requiresMfa,true);const enrollment=await request('POST','/v2/auth/mfa/enrollment',admin.cookies);ok(enrollment);
    ok(await request('PUT','/v2/auth/mfa/enrollment',admin.cookies,{code:totp(enrollment.body.secret)}));
    const adminBearer=decodeURIComponent(admin.cookies.get('access_token')),customerBearer=decodeURIComponent(customer.cookies.get('access_token'));
    checkpoint('actual-admin-MFA-customer-credentials-and-service-token-authorities');
    assert.deepEqual(await eligibility(),[]);assert.deepEqual(await eligibility('retained_records'),[]);
    const paging=[];for(let i=0;i<26;i++)paging.push(await tenant(`page-${String(i).padStart(2,'0')}`,{status:'PURGED',deletedAt:old}));
    const protectedIds=[];
    protectedIds.push(await tenant('recent',{status:'PURGED',deletedAt:recent}));protectedIds.push(await tenant('active'));protectedIds.push(await tenant('customer-cancelled',{status:'CANCELLED'}));protectedIds.push(await tenant('archived',{status:'CANCELLED',deletedAt:old}));protectedIds.push(await tenant('already',{status:'PURGED',deletedAt:old,applicationDataPurgedAt:now}));
    const held=await tenant('held',{status:'PURGED',deletedAt:old});protectedIds.push(held);
    await owner.$transaction(async tx=>{await tx.$executeRaw`SELECT set_current_platform_admin(true, ${configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;await tx.tenant.update({where:{id:held},data:{retentionLegalHoldAt:now,retentionLegalHoldReason:'Owned retention fixture hold',retentionLegalHoldByUserId:users[0].id}});});
    const ancillary=await tenant('ancillary-active'),ancillaryUser=await person(ancillary,'ancillary');
    const ancillarySessions=[];
    for(const [label,expiresAt,revokedAt]of [['expired-old',new Date(now.getTime()-2*day),null],['expired-fresh',new Date(now.getTime()-3600000),null],['revoked-old',new Date(now.getTime()+day),new Date(now.getTime()-31*day)],['revoked-fresh',new Date(now.getTime()+day),new Date(now.getTime()-day)]]){
      const row=await owner.session.create({data:{userId:ancillaryUser.id,refreshToken:hash(),ipAddress:'192.0.2.2',userAgent:'ancillary fixture',expiresAt,revokedAt}});ancillarySessions.push({label,row});
    }
    const oldReset=await owner.passwordResetToken.create({data:{tenantId:ancillary,userId:ancillaryUser.id,tokenHash:hash(),expiresAt:new Date(now.getTime()-2*day)}}),freshReset=await owner.passwordResetToken.create({data:{tenantId:ancillary,userId:ancillaryUser.id,tokenHash:hash(),expiresAt:new Date(now.getTime()-3600000)}});
    const ancillaryRead=async()=>({sessions:await owner.session.findMany({where:{userId:ancillaryUser.id},orderBy:{id:'asc'}}),resets:await owner.passwordResetToken.findMany({where:{tenantId:ancillary},orderBy:{id:'asc'}})});
    const signupOld=await owner.onboardingSignupAttempt.create({data:{identityOrganizationHash:hash(),identityHash:hash(),organizationHash:hash(),challengeHash:hash(),otpHash:hash(),otpSentAt:new Date(now.getTime()-3*day),otpExpiresAt:new Date(now.getTime()-2*day),updatedAt:new Date(now.getTime()-2*day)}});retentionSignupIds.push(signupOld.id);
    const signupFresh=await owner.onboardingSignupAttempt.create({data:{identityOrganizationHash:hash(),identityHash:hash(),organizationHash:hash(),challengeHash:hash(),otpHash:hash(),otpSentAt:now,otpExpiresAt:new Date(now.getTime()+day)}});retentionSignupIds.push(signupFresh.id);
    const invitationUser=await person(ancillary,'ancillary-invitation');
    const invitations=[];for(const [user,deadline]of [[ancillaryUser,new Date(now.getTime()-day)],[invitationUser,new Date(now.getTime()+day)]])invitations.push(await owner.staffInvitationOutbox.create({data:{tenantId:ancillary,userId:user.id,recipientHash:hash(),status:'DELIVERED',deliveredAt:new Date(now.getTime()-2*day),payloadErasedAt:new Date(now.getTime()-2*day),diagnosticsEraseAfter:deadline,providerMessageId:'synthetic-retention-diagnostic',lastErrorCode:'FIXTURE_DIAGNOSTIC',retryAt:null}}));
    const ancillaryBefore=await ancillaryRead();
    assert.deepEqual(await eligibility(),[...paging].sort());const initial=await snapshot(ownedTenants),protectedBefore=await snapshot(protectedIds);
    const dry={dryRun:true,stage:'application_data'};
    for(const bearer of [undefined,'not-the-service-token',customerBearer]){const denied=await invoke(dry,bearer===undefined?null:bearer);assert.equal(denied.status,bearer===customerBearer?403:401);assert.deepEqual(await snapshot(ownedTenants),initial);}
    assert.equal((await invoke(dry,null,admin.cookies)).status,401);
    for(const body of [{...dry,asOf:now.toISOString()},{...dry,limit:1},{...dry,stage:'invalid'},{...dry,continuation:{deletedAt:'invalid',id:'x'}}]){assert.equal((await invoke(body)).status,422);assert.deepEqual(await snapshot(ownedTenants),initial);}
    checkpoint('operator-bearer-authority-and-v2-schema-refusals-no-tenant-change');
    const first=good(await invoke(dry));assert.equal(first.limit,25);assert.equal(first.dryRun,true);assert.deepEqual(first.candidates.map(row=>row.id),[...paging].sort().slice(0,25));assert.deepEqual(first.nextContinuation,{deletedAt:old.toISOString(),id:[...paging].sort()[24]});
    const second=good(await invoke({...dry,continuation:first.nextContinuation}));assert.deepEqual(second.candidates.map(row=>row.id),[...paging].sort().slice(25));assert.equal(second.nextContinuation,null);assert.deepEqual(await snapshot(ownedTenants),initial);assert.deepEqual(await ancillaryRead(),ancillaryBefore);assert.equal(await owner.onboardingSignupAttempt.count({where:{id:{in:retentionSignupIds}}}),2);for(const row of invitations)assert.deepEqual(await owner.staffInvitationOutbox.findUniqueOrThrow({where:{id:row.id}}),row);checkpoint('exact-26-candidate-dryrun-stable-25-plus-one-pagination');
    for(const executeConfirmation of [undefined,'wrong-confirmation']){assert.equal((await invoke({dryRun:false,stage:'application_data',...(executeConfirmation?{executeConfirmation}:{})})).status,422);assert.deepEqual(await snapshot(ownedTenants),initial);}
    const execute={dryRun:false,stage:'application_data',executeConfirmation:'purge-expired-application-data'};
    const executedFirst=good(await invoke(execute));assert.deepEqual(executedFirst.applicationDataPurgedTenants.map(row=>row.id),[...paging].sort().slice(0,25));
    const betweenPageReset=await owner.passwordResetToken.create({data:{tenantId:ancillary,userId:ancillaryUser.id,tokenHash:hash(),expiresAt:new Date(now.getTime()-2*day)}});
    const executedSecond=good(await invoke({...execute,continuation:executedFirst.nextContinuation}));assert.deepEqual(executedSecond.applicationDataPurgedTenants.map(row=>row.id),[...paging].sort().slice(25));
    assert.deepEqual(await owner.passwordResetToken.findUniqueOrThrow({where:{id:betweenPageReset.id}}),betweenPageReset,'Continuation must not run first-page dormant sweep');
    for(const id of paging){const row=await owner.tenant.findUniqueOrThrow({where:{id}});assert.ok(row.applicationDataPurgedAt);assert.equal(row.status,'PURGED');assert.equal(row.slug,`deleted-${id}`);}
    assert.deepEqual(await snapshot(protectedIds),protectedBefore);const paged=await snapshot(ownedTenants);assert.equal(good(await invoke(execute)).processedTenantCount,0);assert.deepEqual(await snapshot(ownedTenants),paged);assert.equal(await owner.passwordResetToken.findUnique({where:{id:betweenPageReset.id}}),null,'Fresh first-page replay must sweep eligible sentinel');checkpoint('confirmed-pages-tombstones-protected-status-hold-and-safe-replay');
    assert.deepEqual(await ancillaryRead(),{sessions:ancillarySessions.filter(item=>item.label.endsWith('fresh')).map(item=>item.row).sort((a,b)=>a.id.localeCompare(b.id)),resets:[freshReset]});
    assert.equal(await owner.passwordResetToken.findUnique({where:{id:oldReset.id}}),null);checkpoint('first-page-dormant-session-and-reset-sweep-independent-protected-readback');
    assert.equal(await owner.onboardingSignupAttempt.findUnique({where:{id:signupOld.id}}),null);assert.deepEqual(await owner.onboardingSignupAttempt.findUniqueOrThrow({where:{id:signupFresh.id}}),signupFresh);
    const erasedInvitation=await owner.staffInvitationOutbox.findUniqueOrThrow({where:{id:invitations[0].id}});assert.ok(erasedInvitation.diagnosticsErasedAt);assert.deepEqual({...erasedInvitation,diagnosticsErasedAt:null,updatedAt:invitations[0].updatedAt},{...invitations[0],providerMessageId:null,lastErrorCode:null});assert.deepEqual(await owner.staffInvitationOutbox.findUniqueOrThrow({where:{id:invitations[1].id}}),invitations[1]);
    checkpoint('signup-expiry-and-invitation-diagnostic-minimization-protected-pairs');
    // Subsequent eligible fixture groups are created only after paging finishes.
    const payroll=async(id,kind,year=2026)=>{
      const staff=await person(id,id+'-'+kind),reviewer=await person(id,id+'-'+kind+'-reviewer');
      const policy=await owner.payrollPolicyVersion.create({data:{tenantId:id,version:1,timeZone:'UTC',cadence:'WEEKLY',anchorDate:new Date(`${year}-06-01`),effectiveFrom:new Date(`${year}-06-01`),operationId:randomUUID(),requestHash:hash(),createdByUserId:reviewer.id}});
      const period=await owner.payrollPeriod.create({data:{tenantId:id,policyVersionId:policy.id,localStartDate:new Date(`${year}-06-01`),localEndDateExclusive:new Date(`${year}-06-08`),startsAt:new Date(`${year}-06-01`),endsAt:new Date(`${year}-06-08`),timeZone:'UTC',cadence:'WEEKLY'}});
      if(kind==='nonlocked')return {staff,reviewer,policy,period};
      const clockInAt=new Date(`${year}-06-02T09:00:00Z`),clockOutAt=new Date(`${year}-06-02T10:00:00Z`);
      const card=await owner.timeCard.create({data:{tenantId:id,userId:staff.id,payrollPeriodId:period.id,clockInAt,clockOutAt:kind==='open'?null:clockOutAt,status:kind==='open'?'OPEN':'CLOSED',workTimeZone:'UTC',revision:1,breakMinutes:0}});
      if(kind==='open')return {staff,reviewer,policy,period,card};
      const approvedAt=new Date(`${year}-06-08T01:00:00Z`);await owner.payrollPeriod.update({where:{id:period.id},data:{status:'REVIEW',revision:1,reviewStartedAt:approvedAt,reviewStartedByUserId:reviewer.id}});
      await owner.payrollTimeCardApproval.create({data:{tenantId:id,periodId:period.id,timeCardId:card.id,timeCardRevision:1,decision:'APPROVED',operationId:randomUUID(),requestHash:hash(),decidedAt:approvedAt,decidedByUserId:reviewer.id}});
      const entry=await owner.payrollLockedEntry.create({data:{tenantId:id,periodId:period.id,sequence:0,sourceType:'TIME_CARD',sourceId:card.id,sourceRevision:1,employeeId:staff.id,workTimeZone:'UTC',clockInAt,clockOutAt,breakMinutes:0,payableMinutes:60,approvedAt,approvedByUserId:reviewer.id,canonicalSha256:hash()}});
      await owner.payrollPeriod.update({where:{id:period.id},data:{status:'LOCKED',revision:2,lockedAt:new Date(`${year}-06-08T02:00:00Z`),lockedByUserId:reviewer.id,lockOperationId:randomUUID(),lockRequestHash:hash(),lockedEntrySha256:hash(),lockedEntryCount:1,totalPayableMinutes:60}});
      return {staff,reviewer,policy,period,card,entry};
    };
    const valid=await tenant('financial');const pf=await payroll(valid,'valid');
    const billing=await owner.billingEvent.create({data:{tenantId:valid,type:'fixture.invoice',amount:123,currency:'usd',metadata:{private:'fixture'}}});
    const usage=await owner.stripeUsageEvent.create({data:{tenantId:valid,metric:'ACTIVE_STAFF',periodStart:new Date('2026-06-01'),periodEnd:new Date('2026-07-01'),quantity:2,eventName:'fixture',stripeCustomerId:'fixture-no-provider',identifier:randomUUID(),idempotencyKey:randomUUID(),status:'SENT',sentAt:now,metadata:{private:'fixture'},lastError:'fixture diagnostic'}});
    const credit=await owner.creditTransaction.create({data:{tenantId:valid,amount:1,reason:'Owned retention fixture',balanceAfter:1}});
    const audit=await owner.auditLog.create({data:{tenantId:valid,userId:pf.staff.id,actorUserId:pf.reviewer.id,actorTenantId:valid,action:'RETENTION_FIXTURE',resource:'User',resourceId:pf.staff.id,oldValue:{private:'before'},newValue:{private:'after'},ipAddress:'192.0.2.1',userAgent:'private fixture'}});
    await owner.tenant.update({where:{id:valid},data:{status:'PURGED',deletedAt:old}});assert.deepEqual(await eligibility(),[valid]);
    const savedPeriod=await owner.payrollPeriod.findUniqueOrThrow({where:{id:pf.period.id}}),savedEntry=await owner.payrollLockedEntry.findUniqueOrThrow({where:{id:pf.entry.id}});
    assert.equal(good(await invoke(execute)).processedTenantCount,1);
    assert.deepEqual(await owner.billingEvent.findUniqueOrThrow({where:{id:billing.id}}),{...billing,metadata:null});
    const usageAfter=await owner.stripeUsageEvent.findUniqueOrThrow({where:{id:usage.id}});assert.ok(usageAfter.updatedAt>=usage.updatedAt);assert.deepEqual({...usageAfter,updatedAt:usage.updatedAt},{...usage,metadata:null,lastError:null});
    assert.deepEqual(await owner.creditTransaction.findUniqueOrThrow({where:{id:credit.id}}),credit);assert.deepEqual(await owner.payrollPeriod.findUniqueOrThrow({where:{id:pf.period.id}}),savedPeriod);assert.deepEqual(await owner.payrollLockedEntry.findUniqueOrThrow({where:{id:pf.entry.id}}),savedEntry);
    assert.equal(await owner.timeCard.count({where:{tenantId:valid}}),0);assert.equal(await owner.payrollTimeCardApproval.count({where:{tenantId:valid}}),0);assert.equal(await owner.user.count({where:{tenantId:valid}}),0);
    const redacted=await owner.auditLog.findUniqueOrThrow({where:{id:audit.id}});for(const field of ['id','tenantId','action','resource','resourceId','actorTenantId'])assert.equal(redacted[field],audit[field]);assert.deepEqual(redacted.createdAt,audit.createdAt);assert.equal(redacted.userId,null);assert.match(redacted.actorUserId,/^deleted-user:/);for(const field of ['oldValue','newValue','ipAddress','userAgent'])assert.equal(redacted[field],null);
    checkpoint('real-locked-payroll-financial-preservation-and-exact-private-field-minimization');
    const historical=[];
    for(const label of ['retained-eight','retained-six','retained-held']){
      const id=await tenant(label);const hp=await payroll(id,'valid',2017);
      await owner.billingEvent.create({data:{tenantId:id,type:'fixture.historical',amount:123,currency:'usd',metadata:{private:'historical'},createdAt:new Date('2017-07-01')}});
      await owner.stripeUsageEvent.create({data:{tenantId:id,metric:'ACTIVE_STAFF',periodStart:new Date('2017-06-01'),periodEnd:new Date('2017-07-01'),quantity:2,eventName:'fixture',stripeCustomerId:'fixture-no-provider',identifier:randomUUID(),idempotencyKey:randomUUID(),status:'SENT',sentAt:new Date('2017-07-01'),metadata:{private:'historical'},lastError:'historical diagnostic'}});
      await owner.creditTransaction.create({data:{tenantId:id,amount:1,reason:'Owned historical retention fixture',balanceAfter:1,createdAt:new Date('2017-07-01')}});
      await owner.auditLog.create({data:{tenantId:id,userId:hp.staff.id,actorUserId:hp.reviewer.id,actorTenantId:id,action:'RETENTION_HISTORICAL_FIXTURE',resource:'User',resourceId:hp.staff.id,newValue:{private:'historical'},createdAt:new Date('2017-07-01')}});
      await owner.tenant.update({where:{id},data:{status:'PURGED',deletedAt:old}});historical.push(id);
    }
    assert.deepEqual(await eligibility(),[...historical].sort());
    const historicalApplication=good(await invoke(execute));assert.deepEqual(historicalApplication.applicationDataPurgedTenants.map(row=>row.id).sort(),[...historical].sort());
    for(const id of historical){
      for(const model of ['billingEvent','stripeUsageEvent','creditTransaction','auditLog','payrollLockedEntry','payrollPeriod','payrollPolicyVersion'])assert.equal(await owner[model].count({where:{tenantId:id}}),1,`${model} historical retained row must exist`);
      for(const model of ['user','timeCard','payrollTimeCardApproval'])assert.equal(await owner[model].count({where:{tenantId:id}}),0);
    }
    const [oldRetained,youngRetained,heldOld]=historical;

    const failures=[];
    for(const kind of ['open','nonlocked','missing-snapshot']){
      const id=await tenant(kind);if(kind==='missing-snapshot'||kind==='open'){const staff=await person(id,kind);await owner.timeCard.create({data:{tenantId:id,userId:staff.id,clockInAt:new Date('2026-06-02T09:00:00Z'),clockOutAt:kind==='open'?null:new Date('2026-06-02T10:00:00Z'),status:kind==='open'?'OPEN':'CLOSED',workTimeZone:'UTC'}});assert.equal(await owner.payrollPeriod.count({where:{tenantId:id}}),0);}else await payroll(id,kind);
      await owner.auditLog.create({data:{tenantId:id,action:'RETENTION_REFUSAL_FIXTURE',resource:'Tenant',resourceId:id,newValue:{preserve:true}}});await owner.tenant.update({where:{id},data:{status:'PURGED',deletedAt:old}});failures.push(id);
    }
    assert.deepEqual((await eligibility()).sort(),[...failures].sort());const refusalBefore=await snapshot(failures);
    const sweptDespiteRefusal=await owner.passwordResetToken.create({data:{tenantId:ancillary,userId:ancillaryUser.id,tokenHash:hash(),expiresAt:new Date(now.getTime()-2*day)}});
    const refusedPurge=await invoke(execute);ok(refusedPurge);assert.equal(refusedPurge.body.failedTenantCount,3);assert.deepEqual(refusedPurge.body.failedTenants.map(row=>row.id).sort(),[...failures].sort());assert.equal(refusedPurge.body.processedTenantCount,0);assert.deepEqual(await snapshot(failures),refusalBefore);
    assert.equal(await owner.passwordResetToken.findUnique({where:{id:sweptDespiteRefusal.id}}),null);
    checkpoint('payroll-pre-redaction-refusal-preserves-candidates-ancillary-sweep-commits-separately');
    // These remain eligible but cannot pollute retained_records selection: age31days.
    const eight=new Date(now);eight.setUTCFullYear(eight.getUTCFullYear()-8);const six=new Date(now);six.setUTCFullYear(six.getUTCFullYear()-6);
    for(const [id,deletedAt]of [[oldRetained,eight],[youngRetained,six],[heldOld,eight]])await owner.tenant.update({where:{id},data:{deletedAt}});
    await owner.$transaction(async tx=>{await tx.$executeRaw`SELECT set_current_platform_admin(true, ${configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;await tx.tenant.update({where:{id:heldOld},data:{retentionLegalHoldAt:now,retentionLegalHoldReason:'Owned historical hold',retentionLegalHoldByUserId:users[0].id}});});
    assert.deepEqual(await eligibility('retained_records'),[oldRetained]);const retainedBefore=await snapshot([oldRetained,youngRetained,heldOld]);
    const retainedDry=good(await invoke({dryRun:true,stage:'retained_records'}));assert.deepEqual(retainedDry.candidates.map(row=>row.id),[oldRetained]);assert.deepEqual(await snapshot([oldRetained,youngRetained,heldOld]),retainedBefore);
    assert.equal((await invoke({dryRun:false,stage:'retained_records',executeConfirmation:'purge-expired-retained-records'})).status,403);assert.deepEqual(await snapshot([oldRetained,youngRetained,heldOld]),retainedBefore);checkpoint('seven-year-service-dryrun-and-execute-denial-preserve-held-and-younger');
    const retainedExecuted=good(await invoke({dryRun:false,stage:'retained_records',executeConfirmation:'purge-expired-retained-records'},adminBearer));assert.deepEqual(retainedExecuted.purgedTenants.map(row=>row.id),[oldRetained]);assert.equal(await owner.tenant.findUnique({where:{id:oldRetained}}),null);
    const erasedRetained=await snapshot([oldRetained]);for(const table of fixedTables)assert.deepEqual(erasedRetained[table],[],`${table} eligible historical rows erased`);const protectedRetained=await snapshot([youngRetained,heldOld]);for(const table of fixedTables)assert.deepEqual(protectedRetained[table],retainedBefore[table].filter(item=>(table==='Tenant'?item.row.id:item.row.tenantId)!==oldRetained));checkpoint('actual-MFA-admin-seven-year-retained-execution-distinct-from-service');
    assert.equal(checks.length,10);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Credential native close',15000);});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Credential retained close',15000);});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Credential native Redis close');});
    await attempt(async()=>{
      // destroy() initiates closure; ownership settles only after every close event.
      const sockets=[...appSockets,...retainedSockets];
      await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{
        socket.once('close',done);socket.destroy();
      }))),'Credential owned socket close events',15000);
    });
    await attempt(async()=>{assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;});
    await attempt(async()=>{
      assert.equal(closed,true);if(redis.status==='ready')await snapshotKeys();
      const allTenants=[...tenantIds,...retentionTenants],userIds=[...users.map(row=>row.id),...retentionUsers],roleIds=roles.map(row=>row.id);
      assert.equal(new Set(allTenants).size,allTenants.length);for(const id of allTenants)assert.ok(id.startsWith(`native-retention-${nonce}`)||tenantIds.includes(id));
      const storedSessions=await owner.session.findMany({where:{userId:{in:userIds}},select:{id:true}}),sessionIds=[...new Set([...storedSessions.map(row=>row.id),...issuedSessions.map(row=>row.id)])];
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)));
      assert.equal(await owner.tenantDeletionBillingReconciliation.count({where:{tenantId:{in:allTenants}}}),0);
      assert.equal(await owner.tenantExportJob.count({where:{tenantId:{in:allTenants}}}),0);assert.equal(await owner.passwordResetEmailOutbox.count({where:{tenantId:{in:allTenants}}}),0);
      // Exact owned synthetic records only, outside the actual purge under test.
      // Existing owner teardown is necessary for immutable ledger/audit/payroll rows.
      await owner.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.onboardingSignupAttempt.deleteMany({where:{id:{in:retentionSignupIds}}});
        for(const model of ['auditLog','billingEvent','stripeUsageEvent','creditTransaction','payrollTimeCardApproval','payrollLockedEntry','timeCard','payrollPeriod','payrollPolicyVersion','mfaTotpClaim','passwordResetToken','staffInvitationOutbox','roleAssignment','role','tenantSetting'])await tx[model].deleteMany({where:{tenantId:{in:allTenants}}});
        await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:allTenants}}});await tx.tenant.deleteMany({where:{id:{in:allTenants}}});
      },{maxWait:5000,timeout:20000});
      assert.equal(await owner.tenant.count({where:{id:{in:allTenants}}}),0);assert.equal(await owner.user.count({where:{id:{in:userIds}}}),0);
      for(const model of ['auditLog','billingEvent','stripeUsageEvent','creditTransaction','payrollTimeCardApproval','payrollLockedEntry','timeCard','payrollPeriod','payrollPolicyVersion','mfaTotpClaim','passwordResetToken','staffInvitationOutbox','roleAssignment','role','tenantSetting'])assert.equal(await owner[model].count({where:{tenantId:{in:allTenants}}}),0);
      databaseCleaned=true;if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Exact retention Redis cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Credential Redis disconnect');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Credential Prisma disconnect'));
    await attempt(async()=>{let entries;try{entries=await readdir(configuration.TENANT_EXPORT_ARTIFACT_DIRECTORY);}catch(error){if(error.code!=='ENOENT')throw error;}if(entries){assert.deepEqual(entries,[]);await rmdir(configuration.TENANT_EXPORT_ARTIFACT_DIRECTORY);}});
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const receipt={version:1,kind:'native-retention-local-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,
        startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',
        expectedCheckpointCount:10,completedCheckpointCount:checks.length,checkpoints:checks,apiPort,retainedPort,
        transport:'owned-loopback-native-v2-to-real-retained-auth',credentialSource:'HTTP-issued cookies only; no synthetic session/JWT/MFA markers',
        databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        limitations:['Scoped real Nest auth composition, not full AppModule/production ingress','Local development cookie transport, not TLS secure-cookie proof','No browser/provider/backups/log erasure/scheduler operating evidence','MFA cleanup is invoked transitively; no eligible/protected pending-MFA fixtures or readback qualified. No payroll export-batch or timeout/restart/concurrency qualification','Payroll refusal precedes audit redaction; independent ancillary sweep may commit'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-retention-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Credential durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native retention scenario or owned cleanup failed; preserve first attempt.');
}

/** Scoped native time-card HTTP/PG qualification; no provider or operating-time claim. */
export async function runNativeTimeCardClock(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-clock-${nonce}`,`native-clock-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex');
  const locations=[];
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    AUTH_DEBUG:'false',OIDC_ENABLED:'false',RESEND_API_KEY:'',STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map(Object.keys(configuration).map(key=>[key,process.env[key]]));
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','POST /v2/auth/pin/verify','GET /v2/auth/me','GET /v2/settings',
    'PUT /v2/users/me/pin','GET /v2/auth/mfa/enrollment','POST /v2/auth/mfa/enrollment','PUT /v2/auth/mfa/enrollment',
    'POST /v2/auth/mfa/verify','POST /v2/auth/refresh','POST /v2/auth/logout','POST /v2/admin/retention/purge-expired']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload,extraHeaders={})=>{
    assert.ok(allowed.has(`${method} ${path}`)||(/^\/v2\/time-cards\/active(?:\?.*)?$/.test(path)&&method==='GET')||(/^\/v2\/time-cards\/[0-9a-f-]{36}\/clock-out$/.test(path)&&method==='POST')||(path==='/v2/time-cards/clock-in'&&method==='POST'));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    Object.assign(headers,extraHeaders);
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  try{
    Object.assign(process.env,configuration);
    assert.equal(await owner.tenant.count(),0,'Exclusive retention fixture requires no existing tenant or unrelated global sweep work');

    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController],providers:[
      {provide:ConfigService,useValue:configService},{provide:TenantPrismaService,useValue:tenantDb},
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);

    const password=`Clock-${randomBytes(18).toString('hex')}!`,passwordHash=await bcrypt.hash(password,4);
    for(const [index,id]of tenantIds.entries())await owner.tenant.create({data:{id,slug:id,name:'Clock fixture',status:'ACTIVE',planTier:'GROWTH',stripeSubscriptionId:`sub_clock_${nonce}_${index}`,stripeSubscriptionCurrentPeriodEnd:new Date(Date.now()+86400000),usageCredits:4,creditDebt:0}});
    for(const id of tenantIds)await owner.creditTransaction.create({data:{tenantId:id,amount:4,debtAmount:0,balanceAfter:4,debtAfter:0,reason:'Owned clock fixture grant'}});
    const permissionSets=[['auth:login_password','time_cards:read','time_cards:write'],['auth:login_password','time_cards:read','time_cards:write','users:read','shifts:read'],['auth:login_password','time_cards:read'],['auth:login_password','time_cards:read','time_cards:write']];
    for(let i=0;i<4;i++){
      const tenantId=i===3?tenantIds[1]:tenantIds[0];const user=await owner.user.create({data:{tenantId,username:`clock${nonce.replaceAll('-','').slice(0,14)}${i}`,name:'Clock fixture',role:'STAFF',passwordHash,mfaEnabled:false,mfaBackupCodes:[]}});users.push(user);
      const role=await owner.role.create({data:{tenantId,name:`Clock role ${i}`,slug:`clock-role-${i}`,legacyRole:'STAFF'}});roles.push(role);
      const permissions=await owner.permission.findMany({where:{key:{in:permissionSets[i]}}});assert.deepEqual(permissions.map(row=>row.key).sort(),[...permissionSets[i]].sort());
      for(const permission of permissions)await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
      await owner.roleAssignment.create({data:{tenantId,userId:user.id,roleId:role.id}});
    }
    for(const tenantId of tenantIds)locations.push(await owner.location.create({data:{tenantId,name:'Clock UTC',timezone:'UTC'}}));
    const foreignCard=await owner.timeCard.create({data:{tenantId:tenantIds[1],userId:users[3].id,locationId:locations[1].id,status:'OPEN',clockInAt:new Date(Date.now()-60000),workTimeZone:'UTC'}});
    const actors=[];for(const user of users)actors.push(await login(user,'password',password));
    const state=async()=>({cards:await owner.timeCard.findMany({where:{tenantId:{in:tenantIds}},orderBy:{id:'asc'}}),credits:await owner.creditTransaction.findMany({where:{tenantId:{in:tenantIds}},orderBy:{id:'asc'}}),wallets:await owner.tenant.findMany({where:{id:{in:tenantIds}},select:{id:true,usageCredits:true,creditDebt:true},orderBy:{id:'asc'}}),audits:await owner.auditLog.findMany({where:{tenantId:{in:tenantIds},resource:'TimeCard'},orderBy:{id:'asc'}})});
    const active=async(i=0,query='')=>request('GET',`/v2/time-cards/active${query}`,actors[i].cookies);
    const clock=(i,body,key,headers={})=>request('POST','/v2/time-cards/clock-in',actors[i].cookies,body,{...(key?{'Idempotency-Key':key}:{}),...headers});
    const deny=async(fn,status)=>{const before=await state();const response=await fn();assert.equal(response.status,status);assert.deepEqual(await state(),before);return response;};
    assert.deepEqual((await active()).body,{data:null});assert.equal((await active()).status,200);
    for(const actor of actors){const row=await owner.session.findUniqueOrThrow({where:{id:actor.sessionId}});assert.equal(row.revokedAt,null);assert.ok(row.expiresAt>new Date());}
    checkpoint('actual-HTTP-credentials-current-sessions-and-empty-own-active-card');
    await deny(()=>request('POST','/v2/time-cards/clock-in',jar(),{}, {'Idempotency-Key':`missing-${nonce}`}),401);
    await deny(()=>clock(2,{},`no-write-${nonce}`),403);checkpoint('missing-session-and-write-permission-preserve-all-clock-state');
    await deny(()=>clock(0,{},`origin-${nonce}`,{Origin:'https://invalid.example'}),403);
    await deny(()=>clock(0,{},`csrf-${nonce}`,{'X-CSRF-Token':'wrong'}),403);
    await deny(()=>clock(0,{},undefined),428);checkpoint('origin-CSRF-and-missing-request-key-refuse-without-effects');
    await deny(()=>clock(0,{},'x'.repeat(256)),422);
    await deny(()=>clock(0,{clockInAt:new Date().toISOString()},`manual-${nonce}`),403);
    await deny(()=>clock(0,{locationId:'not-a-uuid'},`schema-${nonce}`),422);checkpoint('invalid-key-public-id-and-manual-self-time-preserve-state');
    await deny(()=>clock(0,{userId:users[1].publicId},`other-${nonce}`),403);
    await deny(()=>clock(0,{locationId:locations[1].publicId},`foreign-${nonce}`),422);checkpoint('self-other-person-and-foreign-location-refuse');
    const body={locationId:locations[0].publicId,notes:'Owned HTTP clock'},key=`clock-${nonce}`,before=await state(),start=Date.now();
    const created=await clock(0,body,key);assert.equal(created.status,201);assert.equal(created.body.reused,false);assert.equal(created.headers['cache-control'],'private, no-store');
    const card=await owner.timeCard.findUniqueOrThrow({where:{publicId:created.body.data.id}});assert.equal(card.tenantId,tenantIds[0]);assert.equal(card.userId,users[0].id);assert.equal(card.locationId,locations[0].id);assert.equal(card.status,'OPEN');assert.equal(card.clockOutAt,null);assert.equal(card.workTimeZone,'UTC');assert.equal(card.payrollPeriodId,null);assert.ok(card.clockInAt.getTime()>=start&&card.clockInAt.getTime()<=Date.now());
    for(const raw of [card.id,tenantIds[0],users[0].id,locations[0].id])assert.equal(JSON.stringify(created.body).includes(raw),false);
    checkpoint('self-clock-in-201-public-record-server-time-and-UTC-location');
    const committed=await state();assert.equal(committed.cards.length,before.cards.length+1);assert.equal(committed.credits.length,before.credits.length+1);assert.equal(committed.audits.length,1);
    const debit=committed.credits.find(row=>row.id===`feature-usage-${card.clockInOperationId}`);assert.ok(debit);assert.equal(debit.amount,-1);assert.equal(debit.debtAmount,0);assert.equal(debit.balanceAfter,3);assert.equal(debit.debtAfter,0);assert.equal(debit.reason,`Time card clock-in (${card.id})`);
    assert.equal(committed.wallets.find(row=>row.id===tenantIds[0]).usageCredits,3);assert.equal(committed.wallets.find(row=>row.id===tenantIds[0]).creditDebt,0);assert.equal(committed.audits[0].action,'TIME_CARD_CLOCKED_IN');assert.equal(committed.audits[0].resourceId,card.id);assert.equal(committed.audits[0].actorUserId,users[0].id);checkpoint('independent-exact-card-wallet-ledger-and-clock-in-audit');
    const replay=await clock(0,body,key);assert.equal(replay.status,200);assert.equal(replay.body.reused,true);assert.deepEqual(replay.body.data,created.body.data);assert.deepEqual(await state(),committed);checkpoint('exact-request-replay-200-no-additional-debit-or-audit');
    await deny(()=>clock(0,{...body,notes:'changed'},key),409);await deny(()=>clock(0,body,`second-${nonce}`),422);checkpoint('changed-key-payload-and-second-open-card-refuse');
    const own=await active();assert.equal(own.status,200);assert.deepEqual(own.body.data,created.body.data);await deny(()=>active(0,`?userId=${users[3].publicId}`),403);const team=await active(1,`?userId=${users[0].publicId}`);assert.equal(team.status,200);assert.deepEqual(team.body.data,created.body.data);checkpoint('active-own-and-team-public-scope-foreign-self-denial');
    await owner.tenant.update({where:{id:tenantIds[0]},data:{stripeSubscriptionCurrentPeriodEnd:new Date(Date.now()-1000)}});
    const expired=await owner.tenant.findUniqueOrThrow({where:{id:tenantIds[0]}});assert.equal(expired.status,'ACTIVE');await deny(()=>clock(0,body,`expired-${nonce}`),403);
    const expiredReplay=await clock(0,body,key);assert.equal(expiredReplay.status,200);assert.equal(expiredReplay.body.reused,true);assert.deepEqual(await state(),committed);assert.deepEqual((await active()).body.data,created.body.data);checkpoint('paid-period-expiry-denies-new-clock-preserves-replay-and-active-recovery');
    const closePath=`/v2/time-cards/${card.publicId}/clock-out`;
    await deny(()=>request('POST',closePath,actors[0].cookies,{clockOutAt:new Date().toISOString()}),403);
    await deny(()=>request('POST',`/v2/time-cards/${foreignCard.publicId}/clock-out`,actors[0].cookies,{}),404);checkpoint('manual-self-and-foreign-clock-out-preserve-both-tenants');
    assert.ok(Date.now()>card.clockInAt.getTime(),'Real elapsed HTTP requests must provide positive server-time duration');
    const closedResponse=await request('POST',closePath,actors[0].cookies,{breakMinutes:0});assert.equal(closedResponse.status,200);
    const closedCard=await owner.timeCard.findUniqueOrThrow({where:{id:card.id}});assert.equal(closedCard.status,'CLOSED');assert.equal(closedCard.revision,card.revision+1);assert.ok(closedCard.clockOutAt>card.clockInAt);assert.equal(closedCard.breakMinutes,0);assert.equal(closedResponse.body.id,card.publicId);assert.deepEqual((await active()).body,{data:null});
    const finalState=await state();assert.deepEqual(finalState.credits,committed.credits);assert.deepEqual(finalState.wallets,committed.wallets);assert.equal(finalState.audits.length,2);const closure=finalState.audits.find(row=>row.action==='TIME_CARD_CLOCKED_OUT');assert.equal(closure.resourceId,card.id);assert.equal(closure.actorUserId,users[0].id);assert.deepEqual(await owner.timeCard.findUniqueOrThrow({where:{id:foreignCard.id}}),foreignCard);checkpoint('expiry-safe-server-clock-out-revision-audit-no-new-debit');
    await deny(()=>request('POST',closePath,actors[0].cookies,{}),422);assert.deepEqual(await state(),finalState);checkpoint('repeated-closure-refusal-preserves-final-durable-state');
    assert.equal(checks.length,14);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Credential native close',15000);});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Credential retained close',15000);});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Credential native Redis close');});
    await attempt(async()=>{
      // destroy() initiates closure; ownership settles only after every close event.
      const sockets=[...appSockets,...retainedSockets];
      await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{
        socket.once('close',done);socket.destroy();
      }))),'Credential owned socket close events',15000);
    });
    await attempt(async()=>{assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;});
    await attempt(async()=>{
      assert.equal(closed,true);if(redis.status==='ready')await snapshotKeys();
      const allTenants=[...tenantIds],userIds=[...users.map(row=>row.id),],roleIds=roles.map(row=>row.id);
      assert.equal(new Set(allTenants).size,allTenants.length);for(const id of allTenants)assert.ok(id.startsWith(`native-clock-${nonce}`)||tenantIds.includes(id));
      const storedSessions=await owner.session.findMany({where:{userId:{in:userIds}},select:{id:true}}),sessionIds=[...new Set([...storedSessions.map(row=>row.id),...issuedSessions.map(row=>row.id)])];
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)));
      assert.equal(await owner.tenantDeletionBillingReconciliation.count({where:{tenantId:{in:allTenants}}}),0);
      assert.equal(await owner.tenantExportJob.count({where:{tenantId:{in:allTenants}}}),0);assert.equal(await owner.passwordResetEmailOutbox.count({where:{tenantId:{in:allTenants}}}),0);
      // Exact owned fixture teardown only, outside tested HTTP operations.
      // Existing owner teardown is necessary for immutable ledger/audit/payroll rows.
      await owner.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});
        for(const model of ['auditLog','billingEvent','stripeUsageEvent','creditTransaction','payrollTimeCardApproval','payrollLockedEntry','timeCardBreak','timeCard','location','payrollPeriod','payrollPolicyVersion','mfaTotpClaim','passwordResetToken','staffInvitationOutbox','roleAssignment','role','tenantSetting'])await tx[model].deleteMany({where:{tenantId:{in:allTenants}}});
        await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:allTenants}}});await tx.tenant.deleteMany({where:{id:{in:allTenants}}});
      },{maxWait:5000,timeout:20000});
      assert.equal(await owner.tenant.count({where:{id:{in:allTenants}}}),0);assert.equal(await owner.user.count({where:{id:{in:userIds}}}),0);
      for(const model of ['auditLog','billingEvent','stripeUsageEvent','creditTransaction','payrollTimeCardApproval','payrollLockedEntry','timeCardBreak','timeCard','location','payrollPeriod','payrollPolicyVersion','mfaTotpClaim','passwordResetToken','staffInvitationOutbox','roleAssignment','role','tenantSetting'])assert.equal(await owner[model].count({where:{tenantId:{in:allTenants}}}),0);
      databaseCleaned=true;if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Exact retention Redis cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Credential Redis disconnect');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Credential Prisma disconnect'));
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const receipt={version:1,kind:'native-clock-local-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,
        startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',
        expectedCheckpointCount:14,completedCheckpointCount:checks.length,checkpoints:checks,apiPort,retainedPort,
        transport:'owned-loopback-native-v2-time-cards-with-real-retained-auth',credentialSource:'HTTP-issued cookies only; no synthetic session/JWT/MFA markers',
        databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        limitations:['Scoped real Nest auth composition, not full AppModule/production ingress','Local development cookie transport, not TLS secure-cookie proof','No browser/provider/backups/log erasure/scheduler operating evidence','No payroll correction/export or response-loss/concurrency/device qualification'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-clock-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Credential durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native time-card clock scenario or owned cleanup failed; preserve first attempt.');
}

/** Scoped native password-reset storage HTTP/PG qualification; no provider or operating-time claim. */
export async function runNativePasswordResetStorage(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-reset-${nonce}`,`native-reset-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex');
  const envelopeKey=randomBytes(32),privateSecrets=[];
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY:envelopeKey.toString('hex'),PASSWORD_RESET_EMAIL_OUTBOX_ENABLED:'false',AUTH_DEBUG:'false',OIDC_ENABLED:'false',RESEND_API_KEY:'',STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map(Object.keys(configuration).map(key=>[key,process.env[key]]));
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','GET /v2/auth/me','POST /v2/auth/password/reset/request','POST /v2/auth/password/reset/confirm']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload,extraHeaders={})=>{
    assert.ok(allowed.has(`${method} ${path}`));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    Object.assign(headers,extraHeaders);
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  try{
    Object.assign(process.env,configuration);
    assert.equal(await owner.tenant.count(),0,'Exclusive retention fixture requires no existing tenant or unrelated global sweep work');

    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController],providers:[
      {provide:ConfigService,useValue:configService},{provide:TenantPrismaService,useValue:tenantDb},
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);


    const {createDecipheriv}=require('node:crypto');
    const password=`Reset-${randomBytes(18).toString('hex')}!`,nextPassword=`Next-${randomBytes(18).toString('hex')}!`;privateSecrets.push(password,nextPassword);
    const passwordHash=await bcrypt.hash(password,4);
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:'Reset storage fixture',status:'ACTIVE'}});
    for(let i=0;i<3;i++){
      const tenantId=i===2?tenantIds[1]:tenantIds[0];const user=await owner.user.create({data:{tenantId,username:`reset${nonce.replaceAll('-','').slice(0,14)}${i}`,email:`owned-${nonce}-${i}@example.invalid`,name:'Reset fixture',role:'STAFF',passwordHash,mfaEnabled:false,mfaBackupCodes:[]}});users.push(user);
      const role=await owner.role.create({data:{tenantId,name:`Reset role ${i}`,slug:`reset-role-${i}`,legacyRole:'STAFF'}});roles.push(role);
      const keys=i===1?['time_cards:read']:['auth:login_password'];const permissions=await owner.permission.findMany({where:{key:{in:keys}}});assert.deepEqual(permissions.map(x=>x.key).sort(),keys.sort());
      for(const permission of permissions)await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});await owner.roleAssignment.create({data:{tenantId,userId:user.id,roleId:role.id}});
    }
    const first=await login(users[0],'password',password),second=await login(users[0],'password',password),foreign=await login(users[2],'password',password);
    const ownedSessionIds=[first.sessionId,second.sessionId];assert.equal(new Set(ownedSessionIds).size,2);
    const state=async()=>({users:await owner.user.findMany({where:{id:{in:users.map(x=>x.id)}},orderBy:{id:'asc'}}),sessions:await owner.session.findMany({where:{userId:{in:users.map(x=>x.id)}},orderBy:{id:'asc'}}),tokens:await owner.passwordResetToken.findMany({where:{tenantId:{in:tenantIds}},orderBy:{id:'asc'}}),outbox:await owner.passwordResetEmailOutbox.findMany({where:{tenantId:{in:tenantIds}},orderBy:{id:'asc'}}),audits:await owner.auditLog.findMany({where:{tenantId:{in:tenantIds},action:'PASSWORD_RESET_COMPLETED'},orderBy:{id:'asc'}})});
    const digest=value=>sha(Buffer.from(JSON.stringify(value)));const same=(left,right,label)=>assert.equal(digest(left),digest(right),label);
    const requestReset=(identifier,extra={})=>request('POST','/v2/auth/password/reset/request',jar(),{identifier,tenantSlug:tenantIds[0]},extra);
    const confirm=(token,newPassword=nextPassword)=>request('POST','/v2/auth/password/reset/confirm',jar(),{token,password:newPassword});
    const deny=async(fn,status)=>{const before=await state();const response=await fn();assert.equal(response.status,status);same(await state(),before,'Refused reset changed protected records');};
    const initial=await state();assert.equal(initial.tokens.length,0);assert.equal(initial.outbox.length,0);assert.equal(initial.audits.length,0);checkpoint('real-HTTP-owned-sibling-and-foreign-session-baselines');
    const unknown=await requestReset(`unknown-${nonce}`);assert.equal(unknown.status,200);const ineligible=await requestReset(users[1].username);assert.equal(ineligible.status,200);same(unknown.body,ineligible.body,'Generic response differs');same(await state(),initial,'Ineligible issuance changed records');checkpoint('unknown-and-no-password-grant-generic-no-enqueue');
    await deny(()=>requestReset(users[0].username,{Origin:'https://invalid.example'}),403);
    await deny(()=>request('POST','/v2/auth/password/reset/confirm',jar(),{password:nextPassword}),422);
    await deny(()=>request('POST','/v2/auth/password/reset/confirm',jar(),{token:7,password:nextPassword}),422);checkpoint('origin-and-body-refusal-preserve-protected-records');
    const beforeIssue=Date.now(),issued=await requestReset(users[0].username),afterIssue=Date.now();assert.equal(issued.status,200);same(issued.body,unknown.body,'Eligible response is not generic');
    let current=await state();assert.equal(current.tokens.length,1);assert.equal(current.outbox.length,1);const token1=current.tokens[0],outbox1=current.outbox[0];assert.equal(token1.tenantId,tenantIds[0]);assert.equal(token1.userId,users[0].id);assert.equal(outbox1.tenantId,token1.tenantId);assert.equal(outbox1.userId,token1.userId);assert.equal(outbox1.tokenHash,token1.tokenHash);assert.equal(outbox1.expiresAt.getTime(),token1.expiresAt.getTime());assert.ok(token1.expiresAt.getTime()>=beforeIssue+3600000&&token1.expiresAt.getTime()<=afterIssue+3600000);assert.equal(outbox1.status,'PENDING');assert.equal(outbox1.attempts,0);assert.equal(outbox1.deliveredAt,null);checkpoint('real-request-atomic-token-and-encrypted-outbox-matching-lifetime');
    const reveal=outbox=>{
      const envelope=JSON.parse(outbox.encryptedPayload);assert.equal(envelope.v,1);assert.equal(envelope.alg,'aes-256-gcm');assert.equal(outbox.encryptionKeyRef,sha(envelopeKey).slice(0,16));
      const decipher=createDecipheriv('aes-256-gcm',envelopeKey,Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));let payload;
      try{payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString());}catch{throw new Error('Owned reset envelope failed private decryption');}
      let url;try{url=new URL(payload.resetUrl);}catch{throw new Error('Owned reset URL is invalid');}
      const token=url.searchParams.get('token');assert.equal(typeof token,'string');assert.equal(/^[A-Za-z0-9_-]{32,128}$/.test(token),true);privateSecrets.push(token,payload.resetUrl);
      assert.equal(payload.email===users[0].email,true,'Private recipient mismatch');assert.equal(url.origin===origin,true,'Private origin mismatch');assert.equal(url.pathname==='/auth/reset-password',true);assert.equal(url.searchParams.size,1);assert.equal(payload.expiresAt===outbox.expiresAt.toISOString(),true);assert.equal(`sha256:${sha(Buffer.from(token))}`,outbox.tokenHash);assert.equal(outbox.encryptedPayload.includes(token),false);return token;
    };
    const capability1=reveal(outbox1);checkpoint('private-AES-GCM-envelope-recipient-URL-token-hash-binding-no-delivery');
    assert.equal((await requestReset(users[0].username)).status,200);current=await state();assert.equal(current.tokens.length,2);assert.equal(current.outbox.length,2);assert.ok(current.tokens.find(x=>x.id===token1.id).consumedAt);const superseded=current.outbox.find(x=>x.id===outbox1.id);assert.equal(superseded.status,'DEAD_LETTERED');assert.ok(superseded.deadLetteredAt);assert.equal(superseded.leaseUntil,null);assert.equal(superseded.deliveredAt,null);assert.equal(superseded.encryptedPayload.length,0);assert.equal(superseded.encryptionKeyRef,'erased-v1');assert.equal(superseded.lastError,null);assert.equal(superseded.tokenHash,`erased-v1:${sha(Buffer.from(superseded.id))}`);
    const latest=current.tokens.find(x=>x.consumedAt===null),latestOutbox=current.outbox.find(x=>x.tokenHash===latest.tokenHash);assert.ok(latest);assert.equal(latestOutbox.status,'PENDING');const capability=reveal(latestOutbox);assert.equal(capability===capability1,false);await deny(()=>confirm(capability1),401);checkpoint('second-request-supersedes-token-and-deadletters-message-with-terminal-erasure');
    const expiredCapability=randomBytes(32).toString('base64url');privateSecrets.push(expiredCapability);await owner.passwordResetToken.create({data:{tenantId:tenantIds[0],userId:users[0].id,tokenHash:`sha256:${sha(Buffer.from(expiredCapability))}`,expiresAt:new Date(Date.now()-60000)}});
    await deny(()=>confirm('bad!'),401);await deny(()=>confirm(randomBytes(32).toString('base64url')),401);await deny(()=>confirm(expiredCapability),401);await deny(()=>confirm(capability,'short'),422);await deny(()=>confirm(capability,'x'.repeat(73)),422);checkpoint('invalid-unknown-expired-token-and-password-policy-refusals');
    const beforeConfirm=await state(),userBefore=beforeConfirm.users.find(x=>x.id===users[0].id);const result=await confirm(capability);assert.equal(result.status,200);assert.equal(result.body.success,true);assert.equal(Object.keys(result.body).length,1);
    const confirmed=await state(),updated=confirmed.users.find(x=>x.id===users[0].id);assert.equal(updated.passwordHash===userBefore.passwordHash,false);assert.equal(await bcrypt.compare(nextPassword,updated.passwordHash),true);assert.equal(await bcrypt.compare(password,updated.passwordHash),false);assert.ok(confirmed.tokens.find(x=>x.id===latest.id).consumedAt);checkpoint('actual-confirm-200-single-consumption-and-new-password-hash');
    for(const id of ownedSessionIds)assert.ok(confirmed.sessions.find(x=>x.id===id).revokedAt);for(const row of confirmed.tokens)assert.ok(row.consumedAt);assert.equal(updated.loginAttempts,0);assert.equal(updated.lockedUntil,null);assert.equal(updated.pinResetRequired,userBefore.pinResetRequired);assert.equal(updated.mfaEnabled,userBefore.mfaEnabled);assert.equal(confirmed.audits.length,1);const audit=confirmed.audits[0];assert.equal(audit.action,'PASSWORD_RESET_COMPLETED');assert.equal(audit.resourceId,users[0].id);assert.equal(audit.newValue.sessionsRevoked,2);same(confirmed.outbox,beforeConfirm.outbox,'Confirm unexpectedly changed outbox');same(confirmed.users.find(x=>x.id===users[2].id),initial.users.find(x=>x.id===users[2].id),'Foreign user changed');same(confirmed.sessions.find(x=>x.id===foreign.sessionId),initial.sessions.find(x=>x.id===foreign.sessionId),'Foreign session changed');checkpoint('owned-revocation-audit-foreign-preservation-and-outbox-not-delivered');
    for(const actor of [first,second])assert.equal((await request('GET','/v2/auth/me',actor.cookies)).status,401);
    const failedLogin=await request('POST','/v2/auth/password/verify',jar(),{identifier:users[0].username,tenantSlug:tenantIds[0],password});assert.equal(failedLogin.status,401);const failedUser=await owner.user.findUniqueOrThrow({where:{id:users[0].id}});assert.equal(failedUser.loginAttempts,1);assert.equal(failedUser.passwordHash===updated.passwordHash,true);assert.equal(await owner.auditLog.count({where:{tenantId:tenantIds[0],action:'PASSWORD_RESET_COMPLETED'}}),1);
    await login(users[0],'password',nextPassword);checkpoint('old-session-and-password-refusal-counter-new-password-login');
    await deny(()=>confirm(capability),401);checkpoint('consumed-token-replay-no-second-reset-effects');
    const final=await state();same(final.users.find(x=>x.id===users[2].id),initial.users.find(x=>x.id===users[2].id),'Foreign user final changed');same(final.sessions.find(x=>x.id===foreign.sessionId),initial.sessions.find(x=>x.id===foreign.sessionId),'Foreign session final changed');assert.equal(final.outbox.filter(x=>x.status==='DELIVERED').length,0);assert.equal(final.audits.length,1);for(const secretValue of privateSecrets)assert.equal(JSON.stringify(final.tokens.concat(final.outbox,final.audits)).includes(secretValue),false,'Plaintext reset material persisted');checkpoint('final-private-storage-foreign-custody-no-provider-delivery-claim');
    assert.equal(checks.length,12);complete=true;
  }catch(error){primary=error;}
  finally{
    await attempt(async()=>{if(app)await bounded(app.close(),'Credential native close',15000);});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Credential retained close',15000);});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Credential native Redis close');});
    await attempt(async()=>{
      // destroy() initiates closure; ownership settles only after every close event.
      const sockets=[...appSockets,...retainedSockets];
      await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{
        socket.once('close',done);socket.destroy();
      }))),'Credential owned socket close events',15000);
    });
    await attempt(async()=>{assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;});
    await attempt(async()=>{
      assert.equal(closed,true);if(redis.status==='ready')await snapshotKeys();
      const allTenants=[...tenantIds],userIds=[...users.map(row=>row.id),],roleIds=roles.map(row=>row.id);
      assert.equal(new Set(allTenants).size,allTenants.length);for(const id of allTenants)assert.ok(id.startsWith(`native-reset-${nonce}`)||tenantIds.includes(id));
      const storedSessions=await owner.session.findMany({where:{userId:{in:userIds}},select:{id:true}}),sessionIds=[...new Set([...storedSessions.map(row=>row.id),...issuedSessions.map(row=>row.id)])];
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)));
      assert.equal(await owner.tenantDeletionBillingReconciliation.count({where:{tenantId:{in:allTenants}}}),0);
      assert.equal(await owner.tenantExportJob.count({where:{tenantId:{in:allTenants}}}),0);
      // Exact owned fixture teardown only, outside tested HTTP operations.
      // Existing owner teardown is necessary for immutable ledger/audit/payroll rows.
      await owner.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});
        for(const model of ['auditLog','billingEvent','stripeUsageEvent','creditTransaction','payrollTimeCardApproval','payrollLockedEntry','timeCardBreak','timeCard','location','payrollPeriod','payrollPolicyVersion','mfaTotpClaim','passwordResetEmailOutbox','passwordResetToken','staffInvitationOutbox','roleAssignment','role','tenantSetting'])await tx[model].deleteMany({where:{tenantId:{in:allTenants}}});
        await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:allTenants}}});await tx.tenant.deleteMany({where:{id:{in:allTenants}}});
      },{maxWait:5000,timeout:20000});
      assert.equal(await owner.tenant.count({where:{id:{in:allTenants}}}),0);assert.equal(await owner.user.count({where:{id:{in:userIds}}}),0);
      for(const model of ['auditLog','billingEvent','stripeUsageEvent','creditTransaction','payrollTimeCardApproval','payrollLockedEntry','timeCardBreak','timeCard','location','payrollPeriod','payrollPolicyVersion','mfaTotpClaim','passwordResetEmailOutbox','passwordResetToken','staffInvitationOutbox','roleAssignment','role','tenantSetting'])assert.equal(await owner[model].count({where:{tenantId:{in:allTenants}}}),0);
      databaseCleaned=true;if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Exact retention Redis cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Credential Redis disconnect');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Credential Prisma disconnect'));
    envelopeKey.fill(0);privateSecrets.length=0;
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const receipt={version:1,kind:'native-reset-local-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,
        startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',
        expectedCheckpointCount:12,completedCheckpointCount:checks.length,checkpoints:checks,apiPort,retainedPort,
        transport:'owned-loopback-native-v2-password-reset-with-real-retained-auth',credentialSource:'HTTP-issued cookies only; no synthetic session/JWT/MFA markers',
        databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        limitations:['Scoped real Nest auth composition, not full AppModule/production ingress','Local development cookie transport, not TLS secure-cookie proof','No browser/provider/backups/log erasure/scheduler operating evidence','Encrypted storage only, no worker/provider delivery; no concurrent lock-wait/KDF expiry/postcommit Redis outage proof'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap);
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-reset-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Credential durable receipt');
    });
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native password-reset storage scenario or owned cleanup failed; preserve first attempt.');
}

/** C05 real short-lived receipt capability; no deletion/barrier/provider path. */
export async function runNativeAccountDeletionReceipt(context){
  const {redisUrl}=validateNativeSessionSecurityTarget();
  assert.equal(context.executionTarget,'local');
  assert.equal(context.exclusiveRedis,true,'Credential case requires an exclusively owned empty Redis database');
  assert.match(context.runId??'',/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.match(context.sourceSha??'',/^[a-f0-9]{40}$/);
  assert.equal(resolve(context.workspace),context.workspace);
  assert.equal(await realpath(context.workspace),context.workspace);
  assert.ok(context.workspace.startsWith('/tmp/'));
  assert.equal(context.redisUrl.toString(),redisUrl.toString());
  assert.equal(context.targetReceiptSha256,undefined);
  const require=createRequire(import.meta.url);
  require('reflect-metadata');
  process.env.TS_NODE_PROJECT=resolve(root,'apps/api-v2/tsconfig.json');
  require('ts-node').register({transpileOnly:true,experimentalResolver:true});
  const {createPrisma,requireServiceUrl}=await import('./schedule-solve-harness.mjs');
  const {createHmac}=require('node:crypto'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),Redis=require('ioredis');
  const {Module,VersioningType}=require('@nestjs/common'),{NestFactory,APP_GUARD}=require('@nestjs/core');
  const {ConfigService}=require('@nestjs/config'),{ThrottlerModule}=require('@nestjs/throttler');
  const express=require('express'),cookieParser=require('cookie-parser');
  const {AuthController}=require('../../apps/api/src/auth/auth.controller.ts');
  const {AccountDeletionReceiptController}=require('../../apps/api/src/admin/account-deletion-receipt.controller.ts');
  const {AuthService}=require('../../apps/api/src/auth/auth.service.ts');
  const {JwtService}=require('../../apps/api/src/auth/jwt.service.ts');
  const {OtpService}=require('../../apps/api/src/auth/otp.service.ts');
  const {EmailService}=require('../../apps/api/src/auth/email.service.ts');
  const {RbacService}=require('../../apps/api/src/auth/rbac.service.ts');
  const {JwtAuthGuard}=require('../../apps/api/src/auth/jwt-auth.guard.ts');
  const {RbacGuard}=require('../../apps/api/src/auth/rbac.guard.ts');
  const {RateLimitsGuard}=require('../../apps/api/src/common/guards/rate-limits.guard.ts');
  const {createRateLimitThrottlerOptions}=require('../../apps/api/src/common/redis-throttler.storage.ts');
  const {TenantPrismaService}=require('../../apps/api/src/database/tenant-prisma.service.ts');
  const {ProductionExceptionFilter}=require('../../apps/api/src/common/production-exception.filter.ts');
  const {ZodValidationPipe}=require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
  const {buildServer}=require('../../apps/api-v2/src/server.ts'),{loadConfig}=require('../../apps/api-v2/src/config.ts');
  const {TenantDatabase}=require('../../apps/api-v2/src/platform/database.ts');
  const {NativeIdentityAdapter,RedisMfaSessionStore}=require('../../apps/api-v2/src/platform/native-identity.ts');
  const owner=createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const appClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const retainedClient=createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const redis=new Redis(redisUrl.toString(),{lazyConnect:true,enableOfflineQueue:false,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:1000,commandTimeout:1000});
  redis.on('error',()=>undefined);
  const nonce=randomUUID(),startedAt=new Date().toISOString(),tenantIds=[`native-deletion-receipt-${nonce}`,`native-deletion-receipt-foreign-${nonce}`];
  const users=[],roles=[],checks=[],cleanupFailures=[],jars=[],issuedSessions=[];
  const capabilities=[],readbackSummary=[];
  const ownedKeys=new Set(),secret=randomBytes(32).toString('hex');
  const configuration={NODE_ENV:'development',JWT_SECRET:secret,JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
    REDIS_URL:redisUrl.toString(),MFA_SECRET_ENCRYPTION_KEY_CURRENT:randomBytes(32).toString('hex'),
    OTP_HMAC_SECRET:randomBytes(32).toString('hex'),APP_ORIGIN:'http://127.0.0.1',COOKIE_SECURE:'false',TRUST_PROXY:'false',
    AUTH_DEBUG:'false',OIDC_ENABLED:'false',RESEND_API_KEY:'',STAFF_INVITATION_OUTBOX_ENABLED:'false',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET};
  assert.ok(configuration.PLATFORM_ADMIN_DB_CONTEXT_SECRET,'Restricted platform context capability required');
  const previousEnv=new Map(Object.keys(configuration).map(key=>[key,process.env[key]]));
  let app,retained,store,throttleOptions,apiPort,retainedPort,origin,primary,complete=false,closed=false,databaseCleaned=false,redisCleaned=false;
  let appSockets=new Set(),retainedSockets=new Set();
  const attempt=async fn=>{try{await fn();}catch(error){cleanupFailures.push(error);}};
  const checkpoint=name=>{assert.ok(!checks.includes(name));checks.push(name);assert.ok(checks.length<=40);};
  const jar=()=>{const value=new Map();jars.push(value);return value;};
  const cloneJar=source=>{const value=jar();for(const [key,valueText]of source)value.set(key,valueText);return value;};
  const allowed=new Set(['POST /v2/auth/password/verify','POST /v2/auth/pin/verify','GET /v2/auth/me','GET /v2/settings',
    'PUT /v2/users/me/pin','GET /v2/auth/mfa/enrollment','POST /v2/auth/mfa/enrollment','PUT /v2/auth/mfa/enrollment',
    'POST /v2/auth/mfa/verify','POST /v2/auth/refresh','POST /v2/auth/logout','POST /v2/account-deletion/prepare','POST /v2/account-deletion/receipt']);
  const snapshotKeys=async()=>{
    let cursor='0';do{const result=await redis.scan(cursor,'COUNT',100);cursor=result[0];for(const key of result[1]){
      assert.ok(key.startsWith('lunchlineup:rate-limit:v1:')||key.startsWith('session_mfa:'),'Unexpected key in exclusive credential Redis');
      ownedKeys.add(key);assert.ok(ownedKeys.size<=512);
    }}while(cursor!=='0');
  };
  const request=async(method,path,cookies,payload,security={})=>{
    assert.ok(allowed.has(`${method} ${path}`));
    const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload));if(bytes)assert.ok(bytes.length<=cap);
    const headers={Origin:origin,Host:`127.0.0.1:${apiPort}`,Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')};
    if(cookies.has('csrf_token'))headers['X-CSRF-Token']=decodeURIComponent(cookies.get('csrf_token'));
    if(security.wrongOrigin)headers.Origin='http://untrusted.invalid';
    if(security.omitCsrf)delete headers['X-CSRF-Token'];
    if(bytes){headers['Content-Type']='application/json';headers['Content-Length']=bytes.length;}
    const result=await new Promise((done,reject)=>{
      const chunks=[];let size=0,ended=false;
      const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):done(value);};
      const req=http.request({hostname:'127.0.0.1',port:apiPort,path,method,headers,agent:false},res=>{
        res.on('data',chunk=>{size+=chunk.length;if(size>cap){res.destroy();finish(new Error('Credential response exceeds bound'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new Error('Credential HTTP response failed')));
        res.once('aborted',()=>finish(new Error('Credential HTTP response aborted')));
        res.once('end',()=>{try{finish(null,{status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())});}catch{finish(new Error('Credential response is not bounded JSON'));}});
      });
      const timer=setTimeout(()=>{req.destroy();finish(new Error('Credential HTTP deadline exceeded'));},10000);
      req.once('error',()=>finish(new Error('Credential HTTP request failed')));req.end(bytes);
    });
    for(const cookie of result.headers['set-cookie']??[]){const item=cookie.split(';',1)[0],split=item.indexOf('=');assert.ok(split>0);cookies.set(item.slice(0,split),item.slice(split+1));}
    await snapshotKeys();
    return result;
  };
  const ok=response=>assert.equal(response.status,200,'Expected successful native credential request');
  const refused=response=>assert.ok([400,401,403].includes(response.status),'Expected explicit credential refusal, not unavailable/429');
  const claims=cookies=>jwt.verify(decodeURIComponent(cookies.get('access_token')),secret,{algorithms:['HS256'],issuer:'lunchlineup',audience:'lunchlineup-api'});
  const login=async(user,kind,credential,cookies=jar())=>{
    const response=await request('POST',`/v2/auth/${kind}/verify`,cookies,{identifier:user.username,tenantSlug:user.tenantId,[kind]:credential});ok(response);
    for(const name of ['access_token','refresh_token','csrf_token'])assert.ok(cookies.get(name));
    assert.equal('accessToken'in response.body,false);assert.equal('refreshToken'in response.body,false);
    const payload=claims(cookies);assert.equal(payload.sub,user.id);assert.equal(payload.tenantId,user.tenantId);
    const stored=await owner.session.findUniqueOrThrow({where:{id:payload.sessionId}});assert.equal(stored.userId,user.id);assert.equal(stored.revokedAt,null);
    assert.match(stored.refreshToken,/^sha256:[a-f0-9]{64}$/);assert.ok(stored.selectorHash);
    issuedSessions.push({id:stored.id,userId:user.id,loginMethod:kind==='password'?'USERNAME_PASSWORD':'USERNAME_PIN'});
    return {cookies,response,sessionId:stored.id};
  };
  const totp=base32=>{
    let value=0,bits=0;const bytes=[];for(const letter of base32){const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter);assert.ok(n>=0);value=(value<<5)|n;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest[digest.length-1]&15;
    return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  };
  try{
    Object.assign(process.env,configuration);
    for(const client of [appClient,retainedClient]){
      const [role]=await client.$queryRawUnsafe(`SELECT current_user AS name,current_database() AS database,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`);
      assert.equal(role.name,'lunchlineup_ci_app');assert.equal(role.database,'lunchlineup_test');
      for(const flag of ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit'])assert.equal(role[flag],false);
      const [{count}]=await client.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)');assert.equal(count,0);
    }
    const tables=await appClient.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('"User"'::regclass,'"Session"'::regclass,'"RefreshTokenReplay"'::regclass,'"Role"'::regclass,'"RoleAssignment"'::regclass,'"TenantSetting"'::regclass)`);
    assert.equal(tables.length,6);for(const row of tables){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);}
    await bounded(redis.connect(),'Credential Redis connect');assert.equal(await redis.dbsize(),0,'Exclusive owner must supply initially empty Redis');
    const configService=new ConfigService(configuration),tenantDb=new TenantPrismaService(retainedClient);
    throttleOptions=createRateLimitThrottlerOptions(configService);
    class CredentialAuthModule{}
    Module({imports:[ThrottlerModule.forRoot(throttleOptions)],controllers:[AuthController,AccountDeletionReceiptController],providers:[
      {provide:ConfigService,useValue:configService},{provide:TenantPrismaService,useValue:tenantDb},
      AuthService,JwtService,OtpService,EmailService,RbacService,
      {provide:APP_GUARD,useClass:JwtAuthGuard},{provide:APP_GUARD,useClass:RbacGuard},{provide:APP_GUARD,useClass:RateLimitsGuard},
    ]})(CredentialAuthModule);
    retained=await bounded(NestFactory.create(CredentialAuthModule,{bodyParser:false,logger:false,abortOnError:false}),'Retained auth composition');
    const expressApp=retained.getHttpAdapter().getInstance();expressApp.disable('x-powered-by');expressApp.set('trust proxy',false);
    retained.use(cookieParser());retained.use(express.json({limit:cap}));
    retained.enableVersioning({type:VersioningType.URI,defaultVersion:'1'});
    retained.useGlobalPipes(new ZodValidationPipe());retained.useGlobalFilters(new ProductionExceptionFilter());
    retainedSockets=track(retained.getHttpServer());
    await bounded(retained.listen(0,'127.0.0.1'),'Retained auth listen');retainedPort=retained.getHttpServer().address().port;
    const config=loadConfig({NODE_ENV:'development',APP_ORIGIN:'http://127.0.0.1',LEGACY_API_BASE_URL:`http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL:redisUrl.toString(),JWT_SECRET:secret,METRICS_TOKEN:randomBytes(32).toString('hex'),DEPLOY_RELEASE_SHA:context.sourceSha,
      COOKIE_SECURE:'false',TRUST_PROXY:'false',AUTH_STATE_TIMEOUT_MS:'1000',STAFF_INVITATION_OUTBOX_ENABLED:'false',OIDC_ENABLED:'false',LOG_LEVEL:'silent'});
    const database=new TenantDatabase(appClient);store=new RedisMfaSessionStore(config);
    app=await bounded(buildServer(config,{database,identity:new NativeIdentityAdapter(config,database,store)}),'Native credential server');appSockets=track(app.server);
    await bounded(app.listen({host:'127.0.0.1',port:0}),'Native credential listen');apiPort=app.server.address().port;
    origin=`http://127.0.0.1:${apiPort}`;config.appOrigin=origin;config.allowedOrigins=new Set([origin]);configuration.APP_ORIGIN=origin;process.env.APP_ORIGIN=origin;configService.set('APP_ORIGIN',origin);
    const preparedAction='TENANT_DELETION_RECEIPT_PREPARED',preparePath='/v2/account-deletion/prepare',readPath='/v2/account-deletion/receipt';
    const safeEqual=(actual,expected,label)=>assert.ok(JSON.stringify(actual)===JSON.stringify(expected),label);
    const snapshot=()=>owner.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const scope={tenantId:{in:tenantIds}};
      return {tenants:await tx.tenant.findMany({where:{id:{in:tenantIds}},orderBy:{id:'asc'}}),audits:await tx.auditLog.findMany({where:scope,orderBy:{id:'asc'}}),credits:await tx.creditTransaction.findMany({where:scope,orderBy:{id:'asc'}}),billing:await tx.tenantDeletionBillingReconciliation.findMany({where:scope,orderBy:{tenantId:'asc'}})};
    },{isolationLevel:'RepeatableRead',maxWait:5000,timeout:10000});
    for(const id of tenantIds)await owner.tenant.create({data:{id,slug:id,name:'Receipt fixture',status:'ACTIVE'}});
    const password=`Receipt!${randomBytes(16).toString('hex')}`,passwordHash=await bcrypt.hash(password,10);
    const keys=['auth:login_password','settings:read','tenant_account:lifecycle'];
    const catalog=await owner.permission.findMany({where:{key:{in:keys}}});assert.ok(catalog.length===3,'Complete actual permission catalog');
    for(let i=0;i<3;i++){
      const tenantId=i===2?tenantIds[1]:tenantIds[0],privileged=i!==1;
      const user=await owner.user.create({data:{tenantId,username:`receipt${nonce.replaceAll('-','').slice(0,12)}${i}`,name:'Receipt actor',role:privileged?'ADMIN':'STAFF',passwordHash,mfaEnabled:false,mfaBackupCodes:[]}});users.push(user);
      const role=await owner.role.create({data:{tenantId,name:privileged?'ADMIN':'STAFF',slug:`receipt-${i}`,isSystem:true,legacyRole:privileged?'ADMIN':'STAFF'}});roles.push(role);
      for(const permission of catalog.filter(x=>privileged||x.key!=='tenant_account:lifecycle'))await owner.rolePermission.create({data:{roleId:role.id,permissionId:permission.id}});
      await owner.roleAssignment.create({data:{tenantId,userId:user.id,roleId:role.id}});
    }
    const actors=[];for(const user of users)actors.push(await login(user,'password',password));
    const beforeMfa=await snapshot();const unverified=await request('POST',preparePath,actors[0].cookies,{confirmation:tenantIds[0]});assert.equal(unverified.status,403);safeEqual(await snapshot(),beforeMfa,'Unverified applicable MFA leaves receipt state unchanged');
    for(const i of [0,2]){
      const enrollment=await request('POST','/v2/auth/mfa/enrollment',actors[i].cookies);ok(enrollment);
      assert.ok(typeof enrollment.body.secret==='string'&&/^[A-Z2-7]{32}$/.test(enrollment.body.secret),'Valid confidential enrollment shape');
      const confirmed=await request('PUT','/v2/auth/mfa/enrollment',actors[i].cookies,{code:totp(enrollment.body.secret)});ok(confirmed);assert.ok(confirmed.body.mfaVerified===true,'Real MFA confirmation');
      assert.ok(await redis.get(`session_mfa:${actors[i].sessionId}`)==='1','Actual MFA session state');
    }
    checkpoint('real-lifecycle-actors-credentials-applicable-MFA-and-restricted-platform-context');
    const initial=await snapshot();
    for(const [cookies,status]of [[jar(),401],[actors[1].cookies,403]]){const denied=await request('POST',preparePath,cookies,{confirmation:tenantIds[0]});assert.equal(denied.status,status);safeEqual(await snapshot(),initial,'Prepare authentication/permission refusal preserves state');}
    checkpoint('prepare-authentication-permission-and-unverified-MFA-refusals');
    for(const payload of [{},{confirmation:'wrong-owned-slug'},{confirmation:tenantIds[1]}]){const response=await request('POST',preparePath,actors[0].cookies,payload);assert.equal(response.status,422);safeEqual(await snapshot(),initial,'Wrong slug refusal preserves exact state');}
    for(const security of [{wrongOrigin:true},{omitCsrf:true}]){const response=await request('POST',preparePath,actors[0].cookies,{confirmation:tenantIds[0]},security);assert.equal(response.status,403);safeEqual(await snapshot(),initial,'Unsafe request refusal preserves state');}
    checkpoint('slug-and-origin-CSRF-refusals-have-no-prepared-audit');
    const before=Date.now(),prepared=await request('POST',preparePath,actors[0].cookies,{confirmation:tenantIds[0]}),after=Date.now();ok(prepared);
    assert.ok(typeof prepared.body.token==='string'&&/^[a-f0-9]{64}$/.test(prepared.body.token),'Private capability has exact64hex shape');
    const token=prepared.body.token;capabilities.push(token);const digest=sha(Buffer.from(token)),expires=Date.parse(prepared.body.expiresAt);
    assert.ok(Number.isFinite(expires)&&expires>=before+86400000&&expires<=after+86400000,'Receipt expiry is24hours from issuance');
    assert.ok(prepared.headers['cache-control']==='private, no-store','Prepare cache policy');
    const afterPrepared=await snapshot(),newAudits=afterPrepared.audits.filter(x=>!initial.audits.some(old=>old.id===x.id));assert.equal(newAudits.length,1);
    const issued=newAudits[0];assert.ok(issued.action===preparedAction&&issued.resource==='AccountDeletionReceipt'&&issued.resourceId===digest&&issued.tenantId===tenantIds[0]&&issued.userId===users[0].id,'Exact hash-only attributable prepared audit');
    assert.ok(!JSON.stringify(issued).includes(token),'Capability never persisted in cleartext');
    safeEqual(afterPrepared.tenants,initial.tenants,'Prepare does not mutate tenant lifecycle');safeEqual(afterPrepared.credits,initial.credits,'Prepare does not mutate credit ledger');safeEqual(afterPrepared.billing,initial.billing,'Prepare does not create billing work');
    readbackSummary.push({tokenHash:digest,expiresAt:prepared.body.expiresAt,auditId:issued.id,tenantId:issued.tenantId,userId:issued.userId});
    checkpoint('real-prepare-64hex-24hour-expiry-exact-hash-only-audit-no-lifecycle-write');
    for(let i=0;i<2;i++){const read=await request('POST',readPath,jar(),{token});ok(read);assert.ok(read.headers['cache-control']==='private, no-store','Anonymous receipt cache policy');safeEqual(read.body,{state:'NOT_RECORDED',receipt:null},'Pre-barrier read discloses no identity');safeEqual(await snapshot(),afterPrepared,'Anonymous receipt is readonly');}
    checkpoint('anonymous-NOT_RECORDED-private-no-store-and-readonly-repeat');
    const unknown=randomBytes(32).toString('hex');capabilities.push(unknown);
    for(const payload of [{},{token:5},{token:'not-a-capability'},{token:unknown}]){const response=await request('POST',readPath,jar(),payload);assert.equal(response.status,404);safeEqual(await snapshot(),afterPrepared,'Unknown or malformed read preserves state');}
    for(const [path,cookies,payload]of [[preparePath,actors[0].cookies,{confirmation:tenantIds[0],padding:'x'.repeat(2048)}],[readPath,jar(),{token,padding:'x'.repeat(2048)}]]){const response=await request('POST',path,cookies,payload);assert.equal(response.status,413);safeEqual(await snapshot(),afterPrepared,'Over2048byte receipt request preserves state');}
    checkpoint('missing-malformed-unknown404-and-oversized2048body413-preserve-state');
    const expiredToken=randomBytes(32).toString('hex');capabilities.push(expiredToken);
    const expired=await owner.auditLog.create({data:{tenantId:tenantIds[0],userId:users[0].id,action:preparedAction,resource:'AccountDeletionReceipt',resourceId:sha(Buffer.from(expiredToken)),createdAt:new Date(Date.now()-86400000-60000)}});
    const expiredBefore=await snapshot();const refusedExpiry=await request('POST',readPath,jar(),{token:expiredToken});assert.equal(refusedExpiry.status,404);safeEqual(await snapshot(),expiredBefore,'Historical expiry predicate refuses without mutation');
    assert.ok(expired.createdAt.getTime()<Date.now()-86400000,'Expired fixture age bound');
    checkpoint('separate-historical-expired-capability404-no-clock-mock-or-barrier');
    const foreign=await request('POST',preparePath,actors[2].cookies,{confirmation:tenantIds[1]});ok(foreign);assert.ok(typeof foreign.body.token==='string'&&/^[a-f0-9]{64}$/.test(foreign.body.token),'Foreign fixture private capability shape');capabilities.push(foreign.body.token);
    const foreignRead=await request('POST',readPath,jar(),{token:foreign.body.token});ok(foreignRead);safeEqual(foreignRead.body,{state:'NOT_RECORDED',receipt:null},'Foreign capability remains anonymous and nonidentifying');
    const final=await snapshot();assert.ok(final.tenants.every(x=>x.status==='ACTIVE'&&x.deletedAt===null),'No deletion transition');assert.equal(final.billing.length,0);assert.equal(final.credits.length,0);
    assert.equal(final.audits.filter(x=>x.action==='TENANT_DELETION_BARRIER_COMMITTED').length,0);assert.equal(final.audits.filter(x=>x.action===preparedAction).length,3);
    for(const capability of capabilities)assert.ok(!JSON.stringify(final).includes(capability),'No private receipt capability persisted');
    checkpoint('foreign-owned-prepare-anonymous-read-no-barrier-or-provider-effects');
    assert.equal(checks.length,8);complete=true;
  }catch(error){primary=error;}
  finally{
    let nativeClosed=false,retainedClosed=false;
    await attempt(async()=>{if(app)await bounded(app.close(),'Receipt native close',15000);nativeClosed=true;});
    await attempt(async()=>{if(retained)await bounded(retained.close(),'Receipt retained close',15000);retainedClosed=true;});
    await attempt(async()=>{throttleOptions?.storage?.onApplicationShutdown?.();if(store)await bounded(store.close(),'Receipt native Redis close');});
    await attempt(async()=>{
      const sockets=[...appSockets,...retainedSockets];await bounded(Promise.all(sockets.map(socket=>new Promise(done=>{socket.once('close',done);socket.destroy();}))),'Receipt socket closure',15000);
      assert.ok(nativeClosed&&retainedClosed,'Actual app close required');assert.equal(Boolean(app?.server.listening),false);assert.equal(Boolean(retained?.getHttpServer().listening),false);assert.equal(appSockets.size,0);assert.equal(retainedSockets.size,0);closed=true;
    });
    await attempt(async()=>{
      assert.ok(closed,'Preserve fixtures until real apps close');if(redis.status==='ready')await snapshotKeys();
      const userIds=users.map(x=>x.id),roleIds=roles.map(x=>x.id),rows=await owner.session.findMany({where:{userId:{in:userIds}},select:{id:true}}),sessionIds=[...new Set([...rows.map(x=>x.id),...issuedSessions.map(x=>x.id)])];
      for(const key of ownedKeys)if(key.startsWith('session_mfa:'))assert.ok(sessionIds.includes(key.slice('session_mfa:'.length)),'Only owned MFA keys removed');
      const audits=await owner.auditLog.findMany({where:{tenantId:{in:tenantIds}},select:{id:true,action:true,resourceId:true,userId:true,tenantId:true}});
      const digests=capabilities.map(x=>sha(Buffer.from(x)));
      for(const row of audits){assert.ok(['SESSION_CREATED','MFA_ENABLED','TENANT_DELETION_RECEIPT_PREPARED'].includes(row.action),'Unexpected audit preserved');assert.ok(userIds.includes(row.userId),'Owned audit actor');assert.ok(row.action==='TENANT_DELETION_RECEIPT_PREPARED'?digests.includes(row.resourceId):[...userIds,...sessionIds].includes(row.resourceId),'Exact owned audit identity');}
      assert.equal(await owner.tenantDeletionBillingReconciliation.count({where:{tenantId:{in:tenantIds}}}),0);assert.equal(await owner.creditTransaction.count({where:{tenantId:{in:tenantIds}}}),0);
      const claims=await owner.mfaTotpClaim.findMany({where:{userId:{in:userIds}}});assert.ok(claims.length<=2,'At most two real enrollment claims');for(const claim of claims)assert.ok([users[0]?.id,users[2]?.id].includes(claim.userId)&&tenantIds.includes(claim.tenantId),'Exact enrolled fixture claims');
      await owner.$transaction(async tx=>{
        // Existing authorized synthetic test disposal only; immutable audit
        // constraints remain active throughout preparation and every receipt call.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        for(const claim of claims)await tx.mfaTotpClaim.deleteMany({where:{id:claim.id,tenantId:claim.tenantId,userId:claim.userId}});
        await tx.refreshTokenReplay.deleteMany({where:{sessionId:{in:sessionIds}}});await tx.session.deleteMany({where:{id:{in:sessionIds},userId:{in:userIds}}});
        await tx.auditLog.deleteMany({where:{id:{in:audits.map(x=>x.id)},tenantId:{in:tenantIds}}});
        await tx.roleAssignment.deleteMany({where:{tenantId:{in:tenantIds},userId:{in:userIds},roleId:{in:roleIds}}});await tx.rolePermission.deleteMany({where:{roleId:{in:roleIds}}});await tx.role.deleteMany({where:{id:{in:roleIds},tenantId:{in:tenantIds}}});
        await tx.tenantSetting.deleteMany({where:{tenantId:{in:tenantIds}}});await tx.user.deleteMany({where:{id:{in:userIds},tenantId:{in:tenantIds}}});await tx.tenant.deleteMany({where:{id:{in:tenantIds},slug:{in:tenantIds}}});
      },{maxWait:5000,timeout:20000});
      assert.equal(await owner.tenant.count({where:{id:{in:tenantIds}}}),0);assert.equal(await owner.auditLog.count({where:{id:{in:audits.map(x=>x.id)}}}),0);assert.equal(await owner.mfaTotpClaim.count({where:{userId:{in:userIds}}}),0);databaseCleaned=true;
      if(ownedKeys.size)await bounded(redis.del(...ownedKeys),'Receipt exactRedis cleanup');assert.equal(await redis.dbsize(),0);redisCleaned=true;
    });
    await attempt(async()=>{if(redis.status==='ready')await bounded(redis.quit(),'Receipt Redis quit');});redis.disconnect(false);
    for(const client of [appClient,retainedClient,owner])await attempt(()=>bounded(client.$disconnect(),'Receipt Prisma disconnect'));
    for(const cookies of jars)cookies.clear();for(const [key,value]of previousEnv)value===undefined?delete process.env[key]:process.env[key]=value;
    await attempt(async()=>{
      const receipt={version:1,kind:'native-deletion-receipt-local-integration',releaseQualified:false,runId:context.runId,sourceSha:context.sourceSha,startedAt,finishedAt:new Date().toISOString(),status:complete&&!primary&&!cleanupFailures.length?'passed':'failed',expectedCheckpointCount:8,completedCheckpointCount:checks.length,checkpoints:checks,readbackSummary,databaseCleaned,redisCleaned,ownedAppsClosed:closed,fixturePreserved:!databaseCleaned,
        limitations:['Pre-barrier prepare/read only; no deletion/barrier/provider','Historical expiry fixture is not24hours real operation','No browser/TLS/fullAppModule/currentauthorityrace proof','Exact synthetic disposal is not immutable-delete product proof'],
        failures:[...(primary?[primary]:[]),...cleanupFailures].map(error=>({name:error?.name??'Error',messageSha256:sha(Buffer.from(String(error?.message??error)))}))};
      const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n');assert.ok(bytes.length<=cap,'Bounded receipt');for(const token of capabilities)assert.ok(!bytes.includes(Buffer.from(token)),'No private capability in durable evidence');
      await bounded(writeFile(`${context.workspace}/.release/internal-ci/${context.sourceSha}/integration/native-deletion-receipt-${nonce}.json`,bytes,{flag:'wx',mode:0o600}),'Receipt durable evidence');
    });
    capabilities.fill('');
  }
  if(primary||cleanupFailures.length)throw new AggregateError([...(primary?[primary]:[]),...cleanupFailures],'Native receipt scenario or cleanup failed; preserve first attempt');
}
