// Callable SQL mechanism only. This module supplies neither native admission
// nor a trusted owner. The future protected owner must validate source snapshots,
// enforce storage/network/lifetime boundaries, and substantiate each hook below.
// There is deliberately no command-line entry point or pipeline invocation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  verifyAppliedMigrationRows,
  verifyIntegrationDatabaseTarget,
  verifyRestrictedIntegrationRole,
} from './read-internal-ci-migrations.mjs';

export const ledgerWindowSql = Object.freeze({
  identity: `SELECT current_database() AS database, current_user AS current_user,
    session_user AS session_user, current_setting('TimeZone') AS timezone, current_setting('search_path') AS search_path,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    pg_postmaster_start_time()::text AS postmaster_started_at,
    d.oid::text AS database_oid, d.datdba::text AS database_owner_oid,
    owner_role.oid::text AS owner_oid, owner_role.rolsuper AS owner_superuser,
    app.oid::text AS app_oid, app.rolcanlogin AS app_login,
    app.rolsuper AS app_superuser, app.rolcreatedb AS app_createdb,
    app.rolcreaterole AS app_createrole, app.rolinherit AS app_inherit,
    app.rolreplication AS app_replication, app.rolbypassrls AS app_bypassrls,
    n.oid::text AS schema_oid,
    n.nspowner::text AS schema_owner_oid, c.oid::text AS table_oid,
    c.relowner::text AS table_owner_oid, c.relkind, c.relpersistence
    FROM pg_database d CROSS JOIN pg_roles owner_role CROSS JOIN pg_roles app
    CROSS JOIN pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid
    WHERE d.datname=current_database() AND owner_role.rolname='root'
      AND app.rolname='lunchlineup_ci_app' AND n.nspname='lunchlineup_migrations'
      AND c.relname='raw_migration_ledger'`,
  role: `SELECT current_user, session_user, current_database(), rolcanlogin,
    rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname=current_user`,
  memberships: `SELECT roleid::text, member::text, grantor::text, admin_option
    FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles
      WHERE rolname='lunchlineup_ci_app') ORDER BY roleid, grantor`,
  rights: `SELECT
    has_schema_privilege('lunchlineup_ci_app','lunchlineup_migrations','USAGE') AS schema_usage,
    has_schema_privilege('lunchlineup_ci_app','lunchlineup_migrations','CREATE') AS schema_create,
    ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
      'TRUNCATE','REFERENCES','TRIGGER']) AS privilege
      WHERE has_table_privilege('lunchlineup_ci_app',
        'lunchlineup_migrations.raw_migration_ledger',privilege)) AS table_rights,
    ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS privilege
      WHERE has_any_column_privilege('lunchlineup_ci_app',
        'lunchlineup_migrations.raw_migration_ledger',privilege)) AS column_rights`,
  acl: `SELECT 'schema' AS object, a.grantor::text, a.grantee::text,
      a.privilege_type, a.is_grantable FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='lunchlineup_migrations'
    UNION ALL SELECT 'table', a.grantor::text, a.grantee::text,
      a.privilege_type, a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE n.nspname='lunchlineup_migrations' AND c.relname='raw_migration_ledger'
    ORDER BY object, grantor, grantee, privilege_type, is_grantable`,
  columns: `SELECT a.attnum, a.attname, a.attacl::text FROM pg_attribute a
    WHERE a.attrelid='lunchlineup_migrations.raw_migration_ledger'::regclass
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
  databaseAcl: `SELECT datacl::text FROM pg_database WHERE datname=current_database()`,
  defaults: `SELECT oid::text, defaclrole::text, defaclnamespace::text,
    defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY oid`,
  ledger: `SELECT path, sha256, bytes, phase, execution_mode, source_sha,
    applied_at::text FROM lunchlineup_migrations.raw_migration_ledger ORDER BY path`,
  empty: `SELECT (SELECT count(*)::text FROM public."Tenant") AS tenants,
    (SELECT count(*)::text FROM public."User") AS users,
    (SELECT count(*)::text FROM public."StripeUsageEvent") AS usage_events`,
  begin: 'BEGIN',
  limits: "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'",
  grantSchema: 'GRANT USAGE ON SCHEMA lunchlineup_migrations TO lunchlineup_ci_app',
  grantTable: 'GRANT SELECT ON TABLE lunchlineup_migrations.raw_migration_ledger TO lunchlineup_ci_app',
  revokeTable: 'REVOKE SELECT ON TABLE lunchlineup_migrations.raw_migration_ledger FROM lunchlineup_ci_app',
  revokeSchema: 'REVOKE USAGE ON SCHEMA lunchlineup_migrations FROM lunchlineup_ci_app',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
});

const one = (rows) => { assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1); return rows[0]; };
const oid = (value) => assert.match(value, /^[1-9][0-9]*$/);
function identity(rows, pinned) {
  const row = one(rows);
  assert.equal(row.database, 'lunchlineup_test');
  assert.equal(row.current_user, 'root'); assert.equal(row.session_user, 'root');
  assert.equal(row.timezone, 'UTC');assert.equal(row.search_path,'pg_catalog');assert.equal(row.owner_superuser, true);
  assert.match(row.system_identifier,/^[1-9][0-9]*$/);
  assert.ok(typeof row.postmaster_started_at==='string' && Number.isFinite(Date.parse(row.postmaster_started_at)));
  for (const key of ['database_oid','database_owner_oid','owner_oid','app_oid',
    'schema_oid','schema_owner_oid','table_oid','table_owner_oid']) oid(row[key]);
  assert.notEqual(row.app_oid, row.owner_oid);
  assert.equal(row.app_login, true);
  for (const key of ['app_superuser','app_createdb','app_createrole',
    'app_inherit','app_replication','app_bypassrls']) assert.equal(row[key],false);
  for (const key of ['database_owner_oid','schema_owner_oid','table_owner_oid']) {
    assert.equal(row[key], row.owner_oid);
  }
  assert.equal(row.relkind, 'r'); assert.equal(row.relpersistence, 'p');
  if (pinned) assert.deepEqual(row, pinned, 'Ledger target identity changed');
  return row;
}

const canonicalAcl = (rows) => [...rows].map(row => ({...row})).sort((a,b) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b)));
function access(state, id, granted, baseline) {
  const rights = one(state.rights);
  assert.equal(rights.schema_usage, granted); assert.equal(rights.schema_create, false);
  assert.deepEqual(rights.table_rights, granted ? ['SELECT'] : []);
  assert.deepEqual(rights.column_rights, granted ? ['SELECT'] : []);
  assert.deepEqual(state.memberships, [], 'Application role membership is forbidden');
  assert.ok(Array.isArray(state.acl) && state.acl.length > 0);
  const app = [];
  for (const row of state.acl) {
    assert.ok(['schema','table'].includes(row.object));
    assert.equal(row.grantor, id.owner_oid);
    if (row.grantee === id.app_oid) {
      assert.equal(row.is_grantable, false);
      assert.equal(row.privilege_type, row.object === 'schema' ? 'USAGE' : 'SELECT');
      app.push(row.object);
    } else {
      assert.equal(row.grantee, id.owner_oid, 'Unexpected PUBLIC/third-party ledger ACL');
    }
  }
  assert.deepEqual(app.sort(), granted ? ['schema','table'] : []);
  assert.ok(Array.isArray(state.columns) && state.columns.length > 0);
  for (const row of state.columns) assert.equal(row.attacl, null, 'Unexpected ledger column ACL');
  if (baseline) {
    assert.deepEqual(canonicalAcl(state.acl.filter(row => row.grantee !== id.app_oid)), baseline.ownerAcl);
    assert.deepEqual(state.columns, baseline.columns);
    assert.deepEqual(state.defaults, baseline.defaults, 'Default grants changed');
    assert.deepEqual(state.databaseAcl,baseline.databaseAcl,'Database ACL changed');
  }
  return {ownerAcl: canonicalAcl(state.acl.filter(row => row.grantee !== id.app_oid)),
    columns: structuredClone(state.columns), defaults: structuredClone(state.defaults),
    databaseAcl:structuredClone(state.databaseAcl)};
}

function combine(errors) {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'Native ledger window failures retained');
}

/** Fixed-scope mechanism for an independently admitted, exclusive native owner.
 * Hooks are required operations, not boolean assertions or admission receipts.
 * Supplied hooks/test clients alone cannot prove trusted physical ownership.
 * No caller may use this utility as the missing admission/source-validation layer.
 */
export async function withNativeBillingLedgerReadAccess({
  env, context, target, inventory, admission, runFixtures, createClient,
}) {
  // Capture caller data and operations before any owner hook/connection await.
  // A caller mutation must never change a later reconnect's target or ledger.
  env = Object.freeze({...env});
  for (const value of Object.values(env)) {
    assert.ok(value===undefined || typeof value==='string','Environment values must be primitive strings');
  }
  context = Object.freeze(structuredClone(context));
  target = structuredClone(target);
  if (Array.isArray(target?.containers)) Object.freeze(target.containers);
  Object.freeze(target);
  inventory = structuredClone(inventory);
  if (Array.isArray(inventory)) {
    for (const row of inventory) Object.freeze(row);
    Object.freeze(inventory);
  }
  const ownerOperations = {};
  for (const key of ['assertLiveTarget','assertDatabasePhaseClosed','assertFixtureSettlement']) {
    assert.equal(typeof admission?.[key], 'function', `Missing admitted owner operation ${key}`);
    ownerOperations[key] = admission[key].bind(admission);
  }
  admission = Object.freeze(ownerOperations);
  verifyIntegrationDatabaseTarget(env, context, target);
  assert.match(context.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(context.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/);
  assert.equal(env.CI_COMMIT_SHA, context.sourceSha);
  assert.equal(env.CI_RUN_ID, context.runId);
  assert.equal(env.CI_REPOSITORY, 'lunchlineup');
  assert.notEqual(decodeURIComponent(new URL(env.DATABASE_URL).password),
    decodeURIComponent(new URL(env.MIGRATION_DATABASE_URL).password));
  assert.ok(Array.isArray(inventory) && inventory.length > 0);
  assert.equal(typeof runFixtures, 'function');
  assert.equal(typeof createClient, 'function');
  const applicationName = 'll-billing-ledger-' + createHash('sha256').update(context.runId).digest('hex').slice(0,40);
  const binding = Object.freeze({runId:context.runId,sourceSha:context.sourceSha,applicationName,
    database:target.database,role:target.mutationRole,port:Number(new URL(env.DATABASE_URL).port),
    store:target.store,postgresContainer:target.containers[0]});
  const errors = []; const phases=[]; let pinned; let baseline; let grantAttempted = false;
  let fixtureStarted = false; let fixtureResult; let grantPhaseClosed = false;
  let revokeVerified = false;
  // Timeouts are observations only. The trusted outer owner must actually stop
  // and settle these exact clients/backends if any operation remains uncertain.
  const observe = async (operation, label) => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_,reject) => {
        timer=setTimeout(() => reject(new Error(`Native ledger ${label} observation timed out`)),15_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const phaseByClient=new WeakMap();
  const query = async (client, sql) => {
    const journal=phaseByClient.get(client);
    if (sql===ledgerWindowSql.begin) journal.beginIssued=true;
    if (sql===ledgerWindowSql.commit) journal.commitIssued=true;
    const result=await observe(client.query(sql),'query');
    if (sql===ledgerWindowSql.begin) journal.beginAcknowledged=true;
    if (sql===ledgerWindowSql.commit) journal.commitAcknowledged=true;
    return result.rows;
  };
  const state = async (client) => ({rights:await query(client,ledgerWindowSql.rights),
    memberships:await query(client,ledgerWindowSql.memberships),acl:await query(client,ledgerWindowSql.acl),
    columns:await query(client,ledgerWindowSql.columns),defaults:await query(client,ledgerWindowSql.defaults),
    databaseAcl:await query(client,ledgerWindowSql.databaseAcl)});
  const phase = async (name, operation) => {
    const journal={phase:name,beginIssued:false,beginAcknowledged:false,
      commitIssued:false,commitAcknowledged:false,clientsCreated:0,clientsEndObserved:0,
      independentPhaseClosureObserved:false};
    phases.push(journal);
    await admission.assertLiveTarget(binding, name);
    const clients = []; let transaction;
    const client = async (role) => {
      const connection = createClient({connectionString:role==='owner'?env.MIGRATION_DATABASE_URL:env.DATABASE_URL,
        connectionTimeoutMillis:5_000,statement_timeout:10_000,query_timeout:12_000,
        options:'-c timezone=UTC -c search_path=pg_catalog -c idle_in_transaction_session_timeout=10000',
        application_name:applicationName});
      clients.push(connection);journal.clientsCreated+=1;phaseByClient.set(connection,journal);
      await observe(connection.connect(), 'connect'); return connection;
    };
    let primary; let primaryCaught=false; let result;
    try {
      const owner=await client('owner');
      const id=identity(await query(owner,ledgerWindowSql.identity),pinned);
      if (!pinned) pinned=structuredClone(id);
      result=await operation(owner,id,client,(value) => {transaction=value;});
    } catch (error) { primary=error;primaryCaught=true; }
    const failure=[];
    if (primaryCaught) failure.push(primary);
    if (transaction) {
      try {await query(transaction,ledgerWindowSql.rollback);}
      catch (error) {failure.push(error);}
    }
    for (const connection of clients.reverse()) {
      try {await observe(connection.end(),'disconnect');journal.clientsEndObserved+=1;} catch(error) {failure.push(error);}
    }
    // This mandatory independent hook must substantiate backend/connection
    // absence; a resolved client.end() is not that terminal proof.
    try {await admission.assertDatabasePhaseClosed(binding,name);journal.independentPhaseClosureObserved=true;}
    catch(error) {failure.push(error);}
    if (failure.length) throw combine(failure);
    return result;
  };
  try {
    await phase('grant',async (owner,id,client,setTransaction) => {
      const app=await client('app');
      verifyRestrictedIntegrationRole(await query(app,ledgerWindowSql.role));
      baseline=access(await state(owner),id,false);
      verifyAppliedMigrationRows(inventory,await query(owner,ledgerWindowSql.ledger),context.sourceSha);
      const empty=one(await query(owner,ledgerWindowSql.empty));
      assert.deepEqual(empty,{tenants:'0',users:'0',usage_events:'0'},'Fixture database is already populated');
      setTransaction(owner); await query(owner,ledgerWindowSql.begin);
      await query(owner,ledgerWindowSql.limits);
      // Mark uncertainty BEFORE the first privilege-mutating query; a rejected
      // query/COMMIT may have taken effect. Never label it no-mutation.
      grantAttempted=true;
      await query(owner,ledgerWindowSql.grantSchema); await query(owner,ledgerWindowSql.grantTable);
      await query(owner,ledgerWindowSql.commit); setTransaction(undefined);
      identity(await query(owner,ledgerWindowSql.identity),pinned);
      access(await state(owner),id,true,baseline);
      verifyRestrictedIntegrationRole(await query(app,ledgerWindowSql.role));
      const appRights=one(await query(app,ledgerWindowSql.rights));
      assert.equal(appRights.schema_usage,true);assert.equal(appRights.schema_create,false);
      assert.deepEqual(appRights.table_rights,['SELECT']);assert.deepEqual(appRights.column_rights,['SELECT']);
      verifyAppliedMigrationRows(inventory,await query(app,ledgerWindowSql.ledger),context.sourceSha);
    });
    grantPhaseClosed=true;
    await admission.assertLiveTarget(binding,'fixtures');
    fixtureStarted=true; fixtureResult=await runFixtures(binding);
  } catch(error) {errors.push(error);}
  // A fixture assertion failure still permits one scoped revoke ONLY when the
  // trusted owner proves all mutators settled and reattests the same target.
  // Lost/uncertain ownership prohibits reconnect/revoke and downstream work.
  if (grantAttempted) {
    try {
      await admission.assertFixtureSettlement(binding,{fixtureStarted,grantPhaseClosed});
      await phase('revoke',async (owner,id,_client,setTransaction) => {
        const before=await state(owner);
        // Commit failure can leave no grant, or only the first grant. Refuse any
        // unrelated ACL/default/identity change before touching known privileges.
        assert.deepEqual(before.memberships,[]);
        assert.deepEqual(before.columns,baseline.columns);
        assert.deepEqual(before.defaults,baseline.defaults);
        assert.deepEqual(before.databaseAcl,baseline.databaseAcl);
        assert.deepEqual(canonicalAcl(before.acl.filter(row=>row.grantee!==id.app_oid)),baseline.ownerAcl);
        for(const row of before.acl.filter(row=>row.grantee===id.app_oid)) {
          assert.equal(row.grantor,id.owner_oid);assert.equal(row.is_grantable,false);
          assert.ok(['schema','table'].includes(row.object));
          assert.equal(row.privilege_type,row.object==='schema'?'USAGE':'SELECT');
        }
        setTransaction(owner); await query(owner,ledgerWindowSql.begin);
        await query(owner,ledgerWindowSql.limits);
        await query(owner,ledgerWindowSql.revokeTable); await query(owner,ledgerWindowSql.revokeSchema);
        await query(owner,ledgerWindowSql.commit); setTransaction(undefined);
        identity(await query(owner,ledgerWindowSql.identity),pinned);
        access(await state(owner),id,false,baseline); revokeVerified=true;
      });
    } catch(error) {errors.push(error);}
  }
const observations={grantAttempted,fixtureStarted,grantPhaseClosed,revokeVerified,
    phases:structuredClone(phases),nativeQualified:false,releaseQualified:false};
  if (errors.length) {
    const failure=new AggregateError(errors,'Native ledger window failed; original failures retained',
      {cause:errors[0]});
    failure.windowObservations=observations;
    throw failure;
  }
  assert.ok(grantAttempted && grantPhaseClosed && fixtureStarted && revokeVerified);
  return {fixtureResult,grantObserved:true,revokeObserved:true,windowObservations:observations,
    proofScope:'SQL-window observations only; independent native owner and terminal qualification required',
    nativeQualified:false,releaseQualified:false};
}
