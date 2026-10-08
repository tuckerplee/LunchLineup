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
