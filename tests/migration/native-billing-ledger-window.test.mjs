import assert from 'node:assert/strict';
import test from 'node:test';
import { ledgerWindowSql as sql, withNativeBillingLedgerReadAccess as window } from '../../scripts/native-billing-ledger-window.mjs';

// Only injected clients/hooks. No pg import, subprocess, socket or SQL execution.
function fixture() {
  const run='fixture-ledger-54',source='a'.repeat(40);
  const temporary=`/var/lib/custom-ci/runs/${run}/tmp/job-tmp`;
  const context={runId:run,sourceSha:source};
  const target={runId:run,sourceSha:source,workspace:`/var/lib/custom-ci/workspaces/${run}`,
    temporaryRoot:temporary,store:`${temporary}/lunchlineup-integration-containers-${run}`,
    database:'lunchlineup_test',mutationRole:'lunchlineup_ci_app',dataTargetEnvironment:'disposable',
    containers:['postgres','redis','rabbitmq'].map(name=>`lunchlineup-integration-fixtureledger54-${name}`)};
  const env={CI_COMMIT_SHA:source,CI_RUN_ID:run,CI_REPOSITORY:'lunchlineup',RUNNER_TEMP:temporary,
    DATA_TARGET_ENV:'disposable',DATABASE_URL:'postgresql://lunchlineup_ci_app:synthetic-app@127.0.0.1:15432/lunchlineup_test',
    MIGRATION_DATABASE_URL:'postgresql://root:synthetic-root@127.0.0.1:15432/lunchlineup_test'};
  const inventory=[{relativePath:'packages/db/prisma/migrations/fixture.sql',sha256:'b'.repeat(64),bytes:5,phase:'post'}];
  const identity={database:'lunchlineup_test',current_user:'root',session_user:'root',timezone:'UTC',search_path:'pg_catalog',
    system_identifier:'1000',postmaster_started_at:'2026-10-02T00:00:00Z',database_oid:'10',database_owner_oid:'20',
    owner_oid:'20',owner_superuser:true,app_oid:'21',app_login:true,app_superuser:false,app_createdb:false,
    app_createrole:false,app_inherit:false,app_replication:false,app_bypassrls:false,schema_oid:'30',schema_owner_oid:'20',
    table_oid:'40',table_owner_oid:'20',relkind:'r',relpersistence:'p'};
  const store={grant:{schema:false,table:false},events:[],clients:[],phase:undefined,
    defaults:[],databaseAcl:[{datacl:null}],columns:[{attnum:1,attname:'path',attacl:null}],
    memberships:[],empty:{tenants:'0',users:'0',usage_events:'0'},extraAcl:[],identity,
    faults:[],fixtureCalls:0,factoryCalls:0,liveHook:undefined,settleHook:undefined,fixtureHook:undefined};
  const ownerAcl=[{object:'schema',grantor:'20',grantee:'20',privilege_type:'USAGE',is_grantable:false},
    {object:'schema',grantor:'20',grantee:'20',privilege_type:'CREATE',is_grantable:false},
    {object:'table',grantor:'20',grantee:'20',privilege_type:'SELECT',is_grantable:false}];
  const role={current_user:'lunchlineup_ci_app',session_user:'lunchlineup_ci_app',current_database:'lunchlineup_test',
    rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false};
  const admission={
    async assertLiveTarget(binding,phase) {
      store.phase=phase;store.events.push(['live',phase,binding]);
      if(store.liveHook) await store.liveHook(binding,phase);
    },
    async assertDatabasePhaseClosed(_binding,phase) {
      store.events.push(['closed',phase]);
      assert.ok(store.clients.filter(client=>client.phase===phase).every(client=>client.closed));
    },
    async assertFixtureSettlement(_binding,observation) {
      store.events.push(['settled',observation]);
      if(store.settleHook) await store.settleHook(observation);
    },
  };
  const matching=(operation,client,query)=>store.faults.find(fault=>!fault.used&&fault.operation===operation
    && (!fault.phase||fault.phase===client.phase)&&(!fault.role||fault.role===client.role)
    &&(!fault.sql||fault.sql===query));
  const fail=fault=>{fault.used=true;throw fault.error;};
  const createClient=(options)=>{
    store.factoryCalls+=1;
    assert.equal(typeof options.connectionString,'string');
    assert.match(options.options,/search_path=pg_catalog/);
    assert.ok(options.application_name.length<=63);
    const client={role:new URL(options.connectionString).username==='root'?'owner':'app',
      phase:store.phase,options,closed:false,tx:undefined,
      async connect(){store.events.push(['connect',this.phase,this.role]);const fault=matching('connect',this);if(fault)fail(fault);},
      async end(){store.events.push(['end',this.phase,this.role]);const fault=matching('end',this);if(fault)fail(fault);this.closed=true;},
      async query(query){
        store.events.push(['query',this.phase,this.role,query]);
        const fault=matching('query',this,query);if(fault&&!fault.afterEffect)fail(fault);
        let rows=[];const grant=this.tx??store.grant;
        if(query===sql.identity) rows=[structuredClone(store.identity)];
        else if(query===sql.role) rows=[structuredClone(role)];
        else if(query===sql.memberships) rows=structuredClone(store.memberships);
        else if(query===sql.rights) rows=[{schema_usage:grant.schema,schema_create:false,
          table_rights:grant.table?['SELECT']:[],column_rights:grant.table?['SELECT']:[]}];
        else if(query===sql.acl) rows=[...structuredClone(ownerAcl),...structuredClone(store.extraAcl),
          ...(grant.schema?[{object:'schema',grantor:'20',grantee:'21',privilege_type:'USAGE',is_grantable:false}]:[]),
          ...(grant.table?[{object:'table',grantor:'20',grantee:'21',privilege_type:'SELECT',is_grantable:false}]:[])];
        else if(query===sql.columns) rows=structuredClone(store.columns);
        else if(query===sql.defaults) rows=structuredClone(store.defaults);
        else if(query===sql.databaseAcl) rows=structuredClone(store.databaseAcl);
        else if(query===sql.empty) rows=[structuredClone(store.empty)];
        else if(query===sql.ledger) {
          if(this.role==='app') assert.ok(store.grant.schema&&store.grant.table,'App ledger read before grants');
          rows=[{path:'packages/db/prisma/migrations/fixture.sql',sha256:'b'.repeat(64),bytes:5,
            phase:'post',execution_mode:'APPLIED',source_sha:source,applied_at:'2026-10-02T00:00:00Z'}];
        } else if(query===sql.begin) this.tx={...store.grant};
        else if(query===sql.grantSchema) this.tx.schema=true;
        else if(query===sql.grantTable) this.tx.table=true;
        else if(query===sql.revokeTable) this.tx.table=false;
        else if(query===sql.revokeSchema) this.tx.schema=false;
        else if(query===sql.commit){store.grant={...this.tx};this.tx=undefined;}
        else if(query===sql.rollback) this.tx=undefined;
        else assert.equal(query,sql.limits,'Unexpected/non-fixed SQL');
        if(fault&&fault.afterEffect)fail(fault);
        return {rows};
      },
    };
    store.clients.push(client);return client;
  };
  const args={env,context,target,inventory,admission,createClient,async runFixtures(binding){
    store.fixtureCalls+=1;store.events.push(['fixtures']);
    assert.deepEqual(store.grant,{schema:true,table:true});
    assert.ok(store.clients.every(client=>client.closed),'Setup backend held into B8');
    if(store.fixtureHook)return store.fixtureHook(binding);
    return 'synthetic-fixture-result';
  }};
  return {args,store};
}
const writes=store=>store.events.filter(row=>row[0]==='query'&&[sql.grantSchema,sql.grantTable,sql.revokeSchema,sql.revokeTable].includes(row[3]));
const flatten=error=>error instanceof AggregateError?error.errors.flatMap(flatten):[error];

test('window commits exact grant, reads ledger as app, disconnects, settles, revokes and closes',async()=>{
  const {args,store}=fixture();const result=await window(args);
  assert.equal(result.fixtureResult,'synthetic-fixture-result');assert.equal(result.nativeQualified,false);
  assert.deepEqual(writes(store).map(row=>row[3]),[sql.grantSchema,sql.grantTable,sql.revokeTable,sql.revokeSchema]);
  assert.deepEqual(store.grant,{schema:false,table:false});assert.ok(store.clients.every(client=>client.closed));
  assert.equal(store.clients.length,3);assert.equal(store.fixtureCalls,1);
  const appRead=store.events.findIndex(row=>row[0]==='query'&&row[2]==='app'&&row[3]===sql.ledger);
  assert.ok(appRead>=0&&appRead<store.events.findIndex(row=>row[0]==='fixtures'));
  for(const phase of result.windowObservations.phases){assert.equal(phase.commitAcknowledged,true);assert.equal(phase.independentPhaseClosureObserved,true);}
});

for(const [name,mutate] of [
  ['production',args=>args.env.DATA_TARGET_ENV='production'],
  ['external endpoint',args=>args.env.MIGRATION_DATABASE_URL=args.env.MIGRATION_DATABASE_URL.replace('127.0.0.1','example.invalid')],
  ['owner credential reuse',args=>args.env.MIGRATION_DATABASE_URL=args.env.MIGRATION_DATABASE_URL.replace('synthetic-root','synthetic-app')],
  ['mutable URL object',args=>args.env.MIGRATION_DATABASE_URL=new URL(args.env.MIGRATION_DATABASE_URL)],
  ['wrong controller',args=>args.env.CI_RUN_ID='other'],
  ['missing owner hook',args=>delete args.admission.assertFixtureSettlement],
])test(`refuses ${name} before client creation`,async()=>{
  const {args,store}=fixture();mutate(args);await assert.rejects(window(args));assert.equal(store.factoryCalls,0);assert.deepEqual(store.events,[]);assert.equal(store.clients.length,0);assert.equal(store.fixtureCalls,0);
});

for(const [name,mutate] of [
  ['preexisting schema access',store=>store.grant.schema=true],
  ['role membership',store=>store.memberships=[{roleid:'20'}]],
  ['column-only access',store=>store.columns[0].attacl='{lunchlineup_ci_app=w/root}'],
  ['PUBLIC ledger ACL',store=>store.extraAcl=[{object:'table',grantor:'20',grantee:'0',privilege_type:'SELECT',is_grantable:false}]],
  ['populated database',store=>store.empty.users='1'],
  ['unexpected table owner',store=>store.identity.table_owner_oid='21'],
])test(`refuses ${name} without grant/revoke or fixtures`,async()=>{
  const {args,store}=fixture();mutate(store);await assert.rejects(window(args));assert.deepEqual(writes(store),[]);assert.equal(store.fixtureCalls,0);assert.ok(store.clients.every(client=>client.closed));
});

for(const thrown of [undefined,null,false,0])test(`falsey connect rejection ${String(thrown)} stops fixture admission and retains value`,async()=>{
  const {args,store}=fixture();store.faults=[{operation:'connect',phase:'grant',error:thrown}];
  await assert.rejects(window(args),error=>{assert.equal(flatten(error)[0],thrown);return true;});
  assert.equal(store.fixtureCalls,0);assert.deepEqual(writes(store),[]);
});

test('unknown grant COMMIT outcome is retained after safe compensation and never starts fixtures',async()=>{
  const {args,store}=fixture();const primary=new Error('synthetic commit acknowledgement lost');
  store.faults=[{operation:'query',phase:'grant',sql:sql.commit,afterEffect:true,error:primary}];
  await assert.rejects(window(args),error=>{
    assert.equal(flatten(error)[0],primary);assert.equal(error.windowObservations.phases[0].commitIssued,true);
    assert.equal(error.windowObservations.phases[0].commitAcknowledged,false);assert.equal(error.windowObservations.revokeVerified,true);return true;
  });assert.equal(store.fixtureCalls,0);assert.deepEqual(store.grant,{schema:false,table:false});
});

test('falsey mutation error and secondary close failure remain ordered and block fixtures',async()=>{
  const {args,store}=fixture();const secondary=new Error('synthetic close failure');
  store.faults=[{operation:'query',phase:'grant',sql:sql.grantTable,error:0},
    {operation:'end',phase:'grant',role:'owner',error:secondary}];
  store.settleHook=()=>{throw new Error('phase backend remains unconfirmed');};
  await assert.rejects(window(args),error=>{const errors=flatten(error);assert.equal(errors[0],0);assert.ok(errors.includes(secondary));return true;});
  assert.equal(store.fixtureCalls,0);assert.ok(!writes(store).some(row=>row[1]==='revoke'));
});

test('fixture failure is retained and revokes after independently observed settlement',async()=>{
  const {args,store}=fixture();const primary=new Error('synthetic fixture assertion');store.fixtureHook=()=>{throw primary;};
  await assert.rejects(window(args),error=>{assert.equal(flatten(error)[0],primary);assert.equal(error.windowObservations.revokeVerified,true);return true;});
  assert.deepEqual(store.grant,{schema:false,table:false});
});

for(const failure of ['unsettled child','lost target','identity drift','default grant drift','database ACL drift']) {
  test(`${failure} after fixture refuses unsafe revoke or downstream success`,async()=>{
    const {args,store}=fixture();store.fixtureHook=()=>{
      if(failure==='unsettled child')store.settleHook=()=>{throw new Error('unsettled child');};
      if(failure==='lost target')store.liveHook=(_binding,phase)=>{if(phase==='revoke')throw new Error('ownership lost');};
      if(failure==='identity drift')store.identity.table_oid='41';
      if(failure==='default grant drift')store.defaults=[{defaclacl:'unexpected'}];
      if(failure==='database ACL drift')store.databaseAcl=[{datacl:'unexpected'}];
    };
    await assert.rejects(window(args));assert.equal(store.fixtureCalls,1);
    assert.ok(!writes(store).some(row=>row[1]==='revoke'));
  });
}

test('revoke acknowledgement failure cannot turn fixture success into window success',async()=>{
  const {args,store}=fixture();const primary=new Error('synthetic revoke acknowledgement');
  store.faults=[{operation:'query',phase:'revoke',sql:sql.commit,afterEffect:true,error:primary}];
  await assert.rejects(window(args),error=>{assert.equal(flatten(error)[0],primary);assert.equal(error.windowObservations.phases[1].commitAcknowledged,false);return true;});
  assert.equal(store.fixtureCalls,1);
});

test('caller mutation cannot redirect later URL/source/inventory or replace captured owner hooks',async()=>{
  const {args,store}=fixture();const original=args.env.MIGRATION_DATABASE_URL;
  store.liveHook=(_binding,phase)=>{if(phase==='grant'){
    args.context.sourceSha='c'.repeat(40);args.inventory[0].sha256='d'.repeat(64);
    args.env.MIGRATION_DATABASE_URL=original.replace('15432','15433');
    args.admission.assertFixtureSettlement=()=>{throw new Error('replacement must never run');};
  }};
  const result=await window(args);assert.equal(result.revokeObserved,true);
  assert.ok(store.clients.filter(client=>client.role==='owner').every(client=>client.options.connectionString===original));
  assert.ok(store.events.filter(row=>row[0]==='live').every(row=>row[2].sourceSha==='a'.repeat(40)&&row[2].port===15432));
});
