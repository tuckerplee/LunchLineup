import { performance } from 'node:perf_hooks';
import { PERMISSIONS, ROLE_DEFINITIONS } from './legacy-import-plan.mjs';

function refuse(message) { throw new Error(`Legacy import conflict: ${message}`); }
function one(rows, label, optional = false) {
  if (!Array.isArray(rows) || rows.length > 1 || (!optional && rows.length !== 1)) refuse(`${label} is absent or ambiguous`);
  return rows[0] ?? null;
}
function rolesObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== 'ADMIN|MANAGER|STAFF|SUPER_ADMIN') refuse('malformed bootstrap role receipt');
  if (Object.values(value).some((id) => typeof id !== 'string' || !id)) refuse('malformed bootstrap role ID');
  if (new Set(Object.values(value)).size !== 4) refuse('ambiguous bootstrap role IDs');
  return value;
}
function runValues(plan) {
  return { generation_uuid: plan.generationUuid, source_sha256: plan.sourceSha256, adapter_version: plan.adapterVersion, role_plan_sha256: plan.rolePlanSha256, approval_plan_sha256: plan.approvalPlanSha256, expected_company_count: plan.counts.company, expected_location_count: plan.counts.location, expected_user_count: plan.counts.user, expected_staff_count: plan.counts.staff };
}
function assertRun(row, plan) {
  if (row.namespace !== plan.namespace || !['INITIALIZED', 'COMPLETE'].includes(row.status)) refuse('malformed run receipt');
  for (const [key, value] of Object.entries(runValues(plan))) if (String(row[key]) !== String(value)) refuse('namespace is already bound to a different admitted plan');
}
function budget(plan) {
  const end = performance.now() + plan.limits.maxDurationMs;
  return () => { if (performance.now() >= end) refuse('monotonic execution budget exhausted; reconcile committed receipts before retry'); };
}
async function transaction(db, plan, check, operation) {
  check();
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_catalog.set_config('statement_timeout', ${String(plan.limits.transactionTimeoutMs)}, true), pg_catalog.set_config('lock_timeout', ${String(plan.limits.transactionMaxWaitMs)}, true)`;
    check();
    const result = await operation(tx);
    check();
    return result;
  }, { maxWait: plan.limits.transactionMaxWaitMs, timeout: plan.limits.transactionTimeoutMs, isolationLevel: 'ReadCommitted' });
}
async function admittedRun(tx, plan, create) {
  await tx.$executeRaw`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${JSON.stringify(['legacy-import-namespace-v1', plan.namespace])}, 0))`;
  const generation = one(await tx.$queryRaw`SELECT generation_uuid FROM legacy_import.target_generation WHERE singleton = TRUE`, 'target generation');
  if (String(generation.generation_uuid).toLowerCase() !== plan.generationUuid) refuse('database generation does not match admitted target');
  let run = one(await tx.$queryRaw`SELECT * FROM legacy_import.run WHERE namespace = ${plan.namespace} FOR UPDATE`, 'run receipt', true);
  if (!run && create) {
    run = one(await tx.$queryRaw`INSERT INTO legacy_import.run (namespace, generation_uuid, source_sha256, adapter_version, role_plan_sha256, approval_plan_sha256, expected_company_count, expected_location_count, expected_user_count, expected_staff_count, status) VALUES (${plan.namespace}, ${plan.generationUuid}::uuid, ${plan.sourceSha256}, ${plan.adapterVersion}, ${plan.rolePlanSha256}, ${plan.approvalPlanSha256}, ${plan.counts.company}, ${plan.counts.location}, ${plan.counts.user}, ${plan.counts.staff}, 'INITIALIZED') RETURNING *`, 'created run receipt');
  }
  if (!run) refuse('run receipt is absent; report recovery cannot initialize a run');
  assertRun(run, plan);
  return run;
}
async function companyReceipt(tx, plan, companyId, optional = false) {
  const row = one(await tx.$queryRaw`SELECT * FROM legacy_import.company WHERE namespace = ${plan.namespace} AND company_id = ${companyId}::bigint FOR UPDATE`, 'company receipt', optional);
  if (row) {
    const source = plan.companies.find((entry) => entry.id === companyId);
    if (!source || row.namespace !== plan.namespace || String(row.company_id) !== companyId || row.source_row_sha256 !== source.rowSha256 || typeof row.target_tenant_id !== 'string' || !row.target_tenant_id) refuse('company receipt binding changed');
    rolesObject(row.bootstrap_role_ids);
  }
  return row;
}
async function tenant(tx, receipt, check, { writing = false } = {}) {
  await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${receipt.target_tenant_id})`;
  await tx.$queryRaw`SELECT "id" FROM public."Tenant" WHERE "id" = ${receipt.target_tenant_id} FOR UPDATE`;
  check();
  const row = await tx.tenant.findUnique({ where: { id: receipt.target_tenant_id } });
  if (!row || row.id !== receipt.target_tenant_id) refuse('mapped tenant is missing; durable receipt cannot be recreated');
  if (row.applicationDataPurgedAt || row.status === 'PURGED') refuse('mapped tenant is purged; durable receipt cannot be recreated');
  if (writing && (row.deletedAt || row.applicationDataPurgedAt || row.status !== 'ACTIVE')) refuse('mapped tenant is no longer eligible for unfinished import writes');
  return row;
}
async function bootstrapRoles(tx, tenantId) {
  let permissions = await tx.permission.findMany({ where: { key: { in: PERMISSIONS.map(([key]) => key) } }, select: { id: true, key: true } });
  const existing = new Set(permissions.map((row) => row.key));
  const missing = PERMISSIONS.filter(([key]) => !existing.has(key));
  if (missing.length) {
    await tx.permission.createMany({ data: missing.map(([key, label, description, category]) => ({ key, label, description, category })), skipDuplicates: true });
    permissions = await tx.permission.findMany({ where: { key: { in: PERMISSIONS.map(([key]) => key) } }, select: { id: true, key: true } });
  }
  const byKey = new Map(permissions.map((row) => [row.key, row.id]));
  if (byKey.size !== PERMISSIONS.length || [...byKey.values()].some((id) => typeof id !== 'string' || !id)) refuse('permission catalog is incomplete or ambiguous');
  const ids = {};
  for (const definition of ROLE_DEFINITIONS) {
    const row = await tx.role.create({ data: { tenantId, slug: definition.slug, name: definition.name, legacyRole: definition.legacyRole, isSystem: true, isDefault: Boolean(definition.isDefault) } });
    await tx.rolePermission.createMany({ data: definition.permissions.map((key) => ({ roleId: row.id, permissionId: byKey.get(key) })) });
    ids[definition.legacyRole] = row.id;
  }
  return rolesObject(ids);
}
async function assertRolePlan(tx, company, check) {
  const ids = rolesObject(company.bootstrap_role_ids);
  const sortedIds = Object.values(ids).sort();
  await tx.$queryRaw`SELECT "id" FROM public."Role" WHERE "tenantId" = ${company.target_tenant_id} AND "id" = ANY(${sortedIds}::text[]) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "roleId", "permissionId" FROM public."RolePermission" WHERE "roleId" = ANY(${sortedIds}::text[]) ORDER BY "roleId", "permissionId" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM public."Permission" WHERE "id" IN (SELECT "permissionId" FROM public."RolePermission" WHERE "roleId" = ANY(${sortedIds}::text[])) ORDER BY "id" FOR UPDATE`;
  check();
  const rows = await tx.role.findMany({ where: { tenantId: company.target_tenant_id, id: { in: Object.values(ids) } }, include: { rolePermissions: { include: { permission: true } } } });
  check();
  if (rows.length !== ROLE_DEFINITIONS.length) refuse('bootstrap roles are missing or changed before unfinished account creation');
  for (const definition of ROLE_DEFINITIONS) {
    const row = rows.find((entry) => entry.id === ids[definition.legacyRole]);
    const keys = row?.rolePermissions?.map((grant) => grant.permission?.key).sort();
    if (!row || row.tenantId !== company.target_tenant_id || row.deletedAt || row.slug !== definition.slug || row.name !== definition.name || row.legacyRole !== definition.legacyRole || row.isSystem !== true || Boolean(row.isDefault) !== Boolean(definition.isDefault) || !keys || keys.join('|') !== [...definition.permissions].sort().join('|')) refuse('bootstrap role plan drift before unfinished account creation');
  }
  return ids;
}
async function mappedEntity(tx, plan, company, source, check, optional = false) {
  const row = one(await tx.$queryRaw`SELECT * FROM legacy_import.entity WHERE namespace = ${plan.namespace} AND company_id = ${source.companyId}::bigint AND source_type = ${source.sourceType ?? 'location'} AND legacy_id = ${source.id}::bigint FOR UPDATE`, 'entity receipt', optional);
  if (!row) return null;
  const type = source.sourceType ?? 'location';
  if (row.namespace !== plan.namespace || String(row.company_id) !== source.companyId || row.source_type !== type || String(row.legacy_id) !== source.id || row.source_row_sha256 !== source.rowSha256 || row.target_tenant_id !== company.target_tenant_id || row.target_kind !== (type === 'location' ? 'location' : 'account') || typeof row.target_id !== 'string' || !row.target_id) refuse('entity receipt scope or digest changed');
  if (type === 'location' ? row.initial_role_id !== null : row.initial_role_id !== company.bootstrap_role_ids[source.role]) refuse('entity initial role receipt changed');
  const target = type === 'location'
    ? await tx.location.findUnique({ where: { id: row.target_id } })
    : await tx.user.findUnique({ where: { id: row.target_id } });
  check();
  if (!target || target.id !== row.target_id || target.tenantId !== company.target_tenant_id) refuse('mapped entity is missing or foreign; durable receipt cannot be recreated');
  return { receipt: row, target };
}
async function insertEntity(tx, plan, company, source, targetId, roleId) {
  await tx.$executeRaw`INSERT INTO legacy_import.entity (namespace, company_id, source_type, legacy_id, target_id, target_tenant_id, initial_role_id, source_row_sha256) VALUES (${plan.namespace}, ${source.companyId}::bigint, ${source.sourceType ?? 'location'}, ${source.id}::bigint, ${targetId}, ${company.target_tenant_id}, ${roleId}, ${source.rowSha256})`;
}
async function allocateUsername(tx, plan, tenantId, base, check) {
  for (let ordinal = 1; ordinal <= plan.limits.usernameCollisionLimit; ordinal += 1) {
    const candidate = ordinal === 1 ? base : `${base}.${ordinal}`;
    const exists = await tx.user.findFirst({ where: { tenantId, username: candidate }, select: { id: true } });
    check();
    if (!exists) return candidate;
  }
  refuse('username collision bound exhausted; no existing account can be adopted');
}
async function verifyCardinality(tx, plan) {
  const companyRows = await tx.$queryRaw`SELECT company_id FROM legacy_import.company WHERE namespace = ${plan.namespace}`;
  const entityRows = await tx.$queryRaw`SELECT company_id, source_type, legacy_id FROM legacy_import.entity WHERE namespace = ${plan.namespace}`;
  const expected = new Set([...plan.locations.map((row) => `${row.companyId}:location:${row.id}`), ...plan.accounts.map((row) => `${row.companyId}:${row.sourceType}:${row.id}`)]);
  const actual = entityRows.map((row) => `${row.company_id}:${row.source_type}:${row.legacy_id}`);
  if (companyRows.length !== plan.companies.length || new Set(companyRows.map((row) => String(row.company_id))).size !== plan.companies.length || companyRows.some((row) => !plan.companies.some((entry) => entry.id === String(row.company_id))) || actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some((key) => !expected.has(key))) refuse('durable receipt cardinality is incomplete or ambiguous');
}
async function readback(tx, plan, check) {
  await verifyCardinality(tx, plan);
  const companies = new Map();
  for (const source of plan.companies) companies.set(source.id, await companyReceipt(tx, plan, source.id));
  for (const receipt of [...companies.values()].sort((a,b) => a.target_tenant_id.localeCompare(b.target_tenant_id))) await tenant(tx, receipt, check);
  const report = [];
  for (const source of [...plan.locations, ...plan.accounts]) {
    const company = companies.get(source.companyId);
    const { receipt, target } = await mappedEntity(tx, plan, company, source, check);
    report.push({ sourceType: source.sourceType ?? 'location', legacyId: source.id, companyId: source.companyId, tenantId: company.target_tenant_id, targetId: receipt.target_id, currentUsername: source.sourceType ? target.username ?? '' : '', currentName: target.name, initialRole: source.role ?? '', currentPasswordCredentialPresent: source.sourceType ? Boolean(target.passwordHash) : false, importNote: source.note ?? '', deleted: Boolean(target.deletedAt) });
  }
  return { namespace: plan.namespace, targetGenerationId: plan.generationUuid, sourceSha256: plan.sourceSha256, counts: { ...plan.counts }, companies: [...companies.entries()].map(([companyId, receipt]) => ({ companyId, tenantId: receipt.target_tenant_id })), rows: report };
}
export async function executeLegacyImport(plan, { db }) {
  const check = budget(plan);
  await transaction(db, plan, check, (tx) => admittedRun(tx, plan, true));
  for (const source of plan.companies) {
    await transaction(db, plan, check, async (tx) => {
      const run = await admittedRun(tx, plan, false);
      const existing = await companyReceipt(tx, plan, source.id, true);
      if (existing) { await tenant(tx, existing, check); return; }
      if (run.status === 'COMPLETE') refuse('completed run is missing company receipt');
      // Unmapped tenants, including older imports, are never adopted by a slug.
      if (await tx.tenant.findUnique({ where: { slug: source.slug } })) refuse('unmapped tenant slug requires independent older-import reconciliation');
      const created = await tx.tenant.create({ data: { slug: source.slug, name: source.name, planTier: 'ENTERPRISE', status: 'ACTIVE', usageCredits: 0 } });
      await tx.platformConfig.create({ data: { id: `legacy-import-credit-provenance-${created.id}`, key: `legacy-import.credit-provenance.v1.${created.id}`, value: { version: 1, tenantId: created.id, sourceSha256: plan.sourceSha256, initialCreditPolicy: 'zero-wallet-no-ledger', initialCreditGrant: 0 }, updatedBy: 'scripts/import-legacy-users.mjs' } });
      const roleIds = await bootstrapRoles(tx, created.id);
      check();
      await tx.$executeRaw`INSERT INTO legacy_import.company (namespace, company_id, target_tenant_id, source_row_sha256, bootstrap_role_ids) VALUES (${plan.namespace}, ${source.id}::bigint, ${created.id}, ${source.rowSha256}, ${JSON.stringify(roleIds)}::jsonb)`;
    });
  }
  for (const source of [...plan.locations, ...plan.accounts]) {
    await transaction(db, plan, check, async (tx) => {
      const run = await admittedRun(tx, plan, false);
      const company = await companyReceipt(tx, plan, source.companyId);
      await tenant(tx, company, check);
      if (await mappedEntity(tx, plan, company, source, check, true)) return;
      if (run.status === 'COMPLETE') refuse('completed run is missing entity receipt');
      await tenant(tx, company, check, { writing: true });
      if (!source.sourceType) {
        const row = await tx.location.create({ data: { tenantId: company.target_tenant_id, name: source.name, address: source.address, timezone: source.timezone } });
        check();
        await insertEntity(tx, plan, company, source, row.id, null);
        return;
      }
      const roles = await assertRolePlan(tx, company, check);
      const username = await allocateUsername(tx, plan, company.target_tenant_id, source.usernameBase, check);
      const row = await tx.user.create({ data: { tenantId: company.target_tenant_id, username, email: source.email, name: source.name, role: source.role, passwordHash: source.passwordHash, pinResetRequired: false } });
      check();
      await tx.roleAssignment.create({ data: { tenantId: company.target_tenant_id, userId: row.id, roleId: roles[source.role] } });
      check();
      await insertEntity(tx, plan, company, source, row.id, roles[source.role]);
    });
  }
  return transaction(db, plan, check, async (tx) => {
    const run = await admittedRun(tx, plan, false);
    const report = await readback(tx, plan, check);
    if (run.status !== 'COMPLETE') {
      await tx.$executeRaw`UPDATE legacy_import.run SET status = 'COMPLETE', completed_at = pg_catalog.clock_timestamp() WHERE namespace = ${plan.namespace} AND status = 'INITIALIZED'`;
    }
    return report;
  });
}
export async function readLegacyImportReport(plan, { db }) {
  const check = budget(plan);
  return transaction(db, plan, check, async (tx) => {
    await admittedRun(tx, plan, false);
    return readback(tx, plan, check);
  });
}
