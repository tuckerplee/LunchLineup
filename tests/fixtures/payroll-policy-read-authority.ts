import { performance } from 'node:perf_hooks';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import { observeMfaVerification, MFA_MARKER_TTL_SCRIPT, type MfaSessionObserver } from '@lunchlineup/rbac';
import { expect, vi } from 'vitest';
import { TenantDatabase } from '../../apps/api-v2/src/platform/database';
import { TenantPrismaService } from '../../apps/api/src/database/tenant-prisma.service';
import { RbacService } from '../../apps/api/src/auth/rbac.service';
import { authorizeCurrentMutation, assertCurrentMutation } from '../../apps/api-v2/src/people/mutation-authority';

// Actual policy owners and actual current-authority/MFA helpers over a closed,
// read-only committed-row model. No HTTP admission, PostgreSQL locks/MVCC/RLS,
// Redis atomicity, native execution, payroll mutations or release qualification.
export type PolicyRow = Record<string, any>;
export type PolicyDeadline = 'stored' | 'policy' | 'mfa-wall' | 'mfa-monotonic';
export type PolicyGate = 'row' | 'creator';
export type PolicyWriter = 'session' | 'grant' | 'account' | 'pin' | 'policy' | 'tenant' | 'role';
export const policyIds = { tenant: 'policy-tenant', actor: 'policy-actor', session: 'policy-session',
  role: 'policy-reader-role', creator: 'policy-historical-creator' };
export const policyUuid = (n: number) => `63215e75-1ff1-4a6d-93ee-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-05T22:00:00Z');
const clone = <T>(v: T): T => structuredClone(v);
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
export async function policyBounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = realTimeout(() => reject(new Error('Policy fixture gate did not settle')), 2000);
  })]); } finally { if (timer) realClearTimeout(timer); }
}
const flatten = (values: unknown[]): unknown[] => values.flatMap(v => v && typeof v === 'object' && 'values' in v
  ? flatten((v as { values: unknown[] }).values) : [v]);

export function payrollPolicyReadFixture(flavor: 'native' | 'retained', deadline: PolicyDeadline = 'stored') {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  let monotonic = 100_000;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const i = policyIds, historical = new Date('2026-01-01T00:00:00Z'), creatorRetired = new Date('2026-09-01T00:00:00Z');
  const tables: Record<string, PolicyRow[]> = {
    tenant: [{ id: i.tenant, status: 'ACTIVE', deletedAt: null }],
    user: [{ id: i.actor, tenantId: i.tenant, publicId: policyUuid(1), role: 'STAFF', name: 'Reader', email: null,
      username: 'reader', deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null,
      pinResetRequired: false, mfaEnabled: false },
      { id: i.creator, tenantId: i.tenant, publicId: policyUuid(2), role: 'STAFF', deletedAt: creatorRetired, suspendedAt: creatorRetired }],
    session: [{ id: i.session, userId: i.actor, createdAt: new Date(NOW - (deadline === 'policy' ? 240_000 : 60_000)),
      expiresAt: new Date(NOW + (deadline === 'stored' ? 1000 : 3_600_000)), revokedAt: null }],
    tenantSetting: [{ tenantId: i.tenant, key: 'workspace_settings', value: { security: {
      sessionTimeoutMinutes: deadline === 'policy' ? 5 : 480, requireMfaForAll: false } } }],
    role: [{ id: i.role, tenantId: i.tenant, publicId: policyUuid(3), name: 'Policy reader', slug: 'policy-reader',
      description: null, isSystem: false, isDefault: false, legacyRole: null, deletedAt: null,
      rolePermissions: [{ roleId: i.role, permissionId: 'policy-read-permission', permission: { key: 'payroll:read' } }] }],
    roleAssignment: [{ tenantId: i.tenant, userId: i.actor, roleId: i.role }],
    payrollPolicyVersion: [1, 2, 3].map(version => ({ id: `policy-${version}`, publicId: policyUuid(10 + version),
      tenantId: i.tenant, version, timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: historical,
      effectiveFrom: new Date(`${['2026-02-05', '2026-03-05', '2026-04-02'][version - 1]}T00:00:00Z`), createdByUserId: i.creator,
      createdAt: new Date(`2026-0${version}-01T12:00:00Z`) })),
  };
  // A higher foreign version makes missing tenant filtering observable.
  tables.payrollPolicyVersion.push({ ...clone(tables.payrollPolicyVersion[0]), id: 'foreign-policy', publicId: policyUuid(99),
    version: 99, tenantId: 'foreign-tenant' });
  const rowsBefore = () => clone(tables.payrollPolicyVersion);
  const errors: string[] = [], reads: PolicyRow[] = [], effects: PolicyRow[] = [], contexts: PolicyRow[] = [], observations: PolicyRow[] = [];
  let active = 0, phase = 'admission', ordinal = 0, writer: (() => void) | undefined;
  let pause: PolicyGate | undefined, gateHits = 0, pauseEntry = false, entryUsed = false;
  const arrived = deferred(), release = deferred();
  function require(ok: boolean, message: string) { if (!ok) { errors.push(message); throw new Error(message); } }
  function equal(actual: unknown, expected: unknown, label: string) {
    require(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)}`);
  }
  function match(row: PolicyRow, where: PolicyRow, snapshot: Record<string, PolicyRow[]>): boolean {
    return Object.entries(where).every(([key, wanted]) => {
      if (key === 'tenantId_key') return match(row, wanted, snapshot);
      if (key === 'role') return match(snapshot.role.find(r => r.id === row.roleId) ?? {}, wanted, snapshot);
      if (key === 'OR') return (wanted as PolicyRow[]).some(term => match(row, term, snapshot));
      if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
        return Object.entries(wanted).every(([op, value]) => {
          require(op === 'in' || op === 'lt', `Unknown selector ${key}.${op}`);
          return op === 'in' ? (value as unknown[]).includes(row[key]) : row[key] < (value as number);
        });
      }
      return row[key] === wanted;
    });
  }
  function project(row: PolicyRow, select?: PolicyRow) {
    if (!select) return clone(row);
    const out: PolicyRow = {};
    for (const [key, value] of Object.entries(select)) {
      require(value === true || (key === 'rolePermissions' && JSON.stringify(value) === JSON.stringify({ select: { permission: { select: { key: true } } } })), `Unknown projection ${key}`);
      out[key] = clone(row[key]);
    }
    return out;
  }
  const permittedFields: Record<string, string[]> = {
    tenant: ['id', 'status', 'deletedAt'], user: ['id', 'publicId', 'tenantId', 'pinResetRequired', 'mfaEnabled', 'lockedUntil', 'pinLockedUntil'],
    session: ['id', 'userId', 'createdAt', 'expiresAt', 'revokedAt'], tenantSetting: ['value'],
    roleAssignment: ['userId', 'roleId'], role: ['id', 'publicId', 'name', 'slug', 'description', 'isSystem', 'isDefault', 'legacyRole', 'rolePermissions'],
  };
  async function query(table: string, method: string, args: PolicyRow, snapshot: Record<string, PolicyRow[]>) {
    reads.push({ phase, ordinal, table, method, args: clone(args) });
    require(Object.keys(args).every(k => ['where', 'select', 'include', 'orderBy', 'take', 'cursor', 'skip'].includes(k)), `Unknown query option ${table}`);
    const where = args.where;
    require(Boolean(where), 'Every query has an explicit selector');
    if (table === 'tenant') { equal(where, { id: i.tenant }, 'Tenant selector'); require(method === 'findUnique', 'Tenant lookup'); }
    else if (table === 'session') { equal(where, { id: i.session, userId: i.actor }, 'Exact Session selector'); require(method === 'findFirst', 'Session lookup'); }
    else if (table === 'tenantSetting') { equal(where, { tenantId_key: { tenantId: i.tenant, key: 'workspace_settings' } }, 'Settings selector'); require(method === 'findUnique', 'Settings lookup'); }
    else if (table === 'user') {
      if (method === 'findMany') {
        require(flavor === 'native', 'Only native public creator mapping');
        equal(where, { tenantId: i.tenant, id: { in: [i.creator] } }, 'Historical creator selector, without activity filter');
        equal(args.select, { id: true, publicId: true }, 'Creator public projection');
      } else {
        require(method === 'findFirst', 'Actor lookup');
        equal(where, { id: i.actor, tenantId: i.tenant, deletedAt: null, suspendedAt: null }, 'Exact live actor selector');
      }
    } else if (table === 'roleAssignment') {
      require(method === 'findMany', 'Assignments lookup');
      require(where.tenantId === i.tenant && Object.keys(where).every(k => ['tenantId', 'userId', 'role'].includes(k)), 'Closed assignment selector');
      require(where.userId === i.actor || JSON.stringify(where.userId) === JSON.stringify({ in: [i.actor] }), 'Exact assigned actor');
      if (where.role) equal(where.role, { tenantId: i.tenant, deletedAt: null }, 'Active assigned role selector');
      equal(args.orderBy, [{ userId: 'asc' }, { roleId: 'asc' }], 'Assignment order');
      if (args.select) equal(args.select, { userId: true, roleId: true }, 'Assignment projection');
      if (args.include) equal(args.include, { role: { include: { rolePermissions: { include: { permission: true } } } } }, 'Retained role include');
    } else if (table === 'role') {
      require(flavor === 'native' && method === 'findMany', 'Only native current role query');
      equal(where, { tenantId: i.tenant, id: { in: [i.role] }, deletedAt: null }, 'Current roles selector');
      equal(args.orderBy, { id: 'asc' }, 'Role order');
    } else if (table === 'payrollPolicyVersion') {
      require(method === 'findFirst' || method === 'findMany', 'Only policy latest or list reads');
      const publicOrder = flavor === 'native' ? 'publicId' : 'id';
      equal(args.orderBy, [{ version: 'desc' }, { [publicOrder]: 'desc' }], 'Policy order');
      require(!args.select && !args.include, 'Exact original policy row projection');
      if (method === 'findFirst') {
        equal(Object.keys(args).sort(), ['orderBy', 'where'], 'Latest options'); equal(where, { tenantId: i.tenant }, 'Latest tenant scope');
      } else {
        require(Number.isInteger(args.take) && args.take >= 2 && args.take <= 51, 'Policy lookahead bound');
        if (flavor === 'native') {
          require(!args.cursor && args.skip === undefined, 'Native opaque cursor uses keyset predicate');
          if (where.OR) {
            equal(Object.keys(where).sort(), ['OR', 'tenantId'], 'Native continuation keys');
            require(Array.isArray(where.OR) && where.OR.length === 2, 'Two native cursor terms');
            const boundary = where.OR[0]?.version?.lt, id = where.OR[1]?.publicId?.lt;
            require(Number.isInteger(boundary) && boundary >= 0 && typeof id === 'string', 'Decoded native cursor types');
            equal(where.OR, [{ version: { lt: boundary } }, { version: boundary, publicId: { lt: id } }], 'Native version/publicId continuation');
          } else equal(where, { tenantId: i.tenant }, 'Native initial policy scope');
        } else {
          equal(where, { tenantId: i.tenant }, 'Retained policy scope');
          if (args.cursor) { equal(Object.keys(args.cursor), ['id'], 'Retained exact cursor'); require(typeof args.cursor.id === 'string', 'Cursor id'); equal(args.skip, 1, 'Cursor skip'); }
          else require(args.skip === undefined, 'No skip without cursor');
        }
      }
    } else require(false, `Unknown read table ${table}`);
    if (args.select) require(Boolean(permittedFields[table]) && Object.keys(args.select).every(k => permittedFields[table].includes(k)), 'Closed select fields');
    if (args.include) require(table === 'roleAssignment', 'Only authority role include');
    let rows = snapshot[table].filter(row => match(row, where, snapshot));
    if (args.orderBy) {
      const order: PolicyRow[] = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      rows.sort((a, b) => { for (const clause of order) for (const [key, direction] of Object.entries(clause)) {
        if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
      } return 0; });
    }
    if (args.cursor) {
      const index = rows.findIndex(row => row.id === args.cursor.id); require(index >= 0, 'Controlled retained cursor exists in tenant page'); rows = rows.slice(index + args.skip);
    }
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    const result = rows.map(row => args.include ? { ...clone(row), role: clone(snapshot.role.find(r => r.id === row.roleId)) } : project(row, args.select));
    const isRow = table === 'payrollPolicyVersion', isCreator = table === 'user' && method === 'findMany';
    if (phase === 'owner' && gateHits === 0 && ((pause === 'row' && isRow) || (pause === 'creator' && isCreator))) {
      gateHits++; arrived.release(); await release.promise;
    }
    return method === 'findMany' ? result : result[0] ?? null;
  }
  const raw = async (kind: string, sql: any, bound: unknown[], snapshot: Record<string, PolicyRow[]>) => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join('').replace(/\s+/g, ' ').trim();
    const values = flatten(Array.isArray(sql) ? bound : sql.values);
    reads.push({ phase, ordinal, table: '$raw', method: kind, text, values: clone(values) });
    if (kind === '$executeRaw') {
      equal(text, 'SELECT set_current_tenant()', 'Tenant context'); equal(values, [i.tenant], 'Exact context tenant');
      if (phase === 'owner' && pauseEntry && !entryUsed) { entryUsed = true; arrived.release(); await release.promise; }
      return 1;
    }
    if (text === "SELECT set_config('lock_timeout', '2000ms', true), set_config('statement_timeout', '12000ms', true)") { equal(values, [], 'Timeout bindings'); return [{ set_config: '12000ms' }]; }
    const nativeLocks = {
      Tenant: 'SELECT "id" FROM "Tenant" WHERE "id" = FOR UPDATE',
      User: 'SELECT "id", "publicId"::text AS "publicId", "role", "name", "email", "username", "suspendedAt", "deletedAt", "lockedUntil", "pinLockedUntil" FROM "User" WHERE "tenantId" = AND "id" IN () ORDER BY "id" FOR UPDATE',
      Session: 'SELECT "id", "userId", "expiresAt", "revokedAt" FROM "Session" WHERE "id" = AND "userId" = FOR UPDATE',
      Role: 'SELECT "id" FROM "Role" WHERE "tenantId" = AND "id" = FOR UPDATE',
      RolePermission: 'SELECT "roleId", "permissionId" FROM "RolePermission" WHERE "roleId" IN () ORDER BY "roleId", "permissionId" FOR UPDATE',
    };
    const retainedLocks = {
      Tenant: 'SELECT "id" FROM "Tenant" WHERE "id" IN () ORDER BY "id" FOR UPDATE',
      User: 'SELECT "id" FROM "User" WHERE "tenantId" = AND "id" IN () AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE',
      Session: nativeLocks.Session, Role: nativeLocks.Role, RolePermission: nativeLocks.RolePermission,
      RoleAssignment: 'SELECT "userId", "roleId" FROM "RoleAssignment" WHERE "tenantId" = AND "userId" IN () ORDER BY "userId", "roleId" FOR UPDATE',
    };
    const selected = flavor === 'native' ? nativeLocks : retainedLocks;
    const table = Object.entries(selected).find(([, statement]) => statement === text)?.[0];
    require(Boolean(table), `Unrecognized complete lock SQL ${text}`);
    if (table === 'Tenant') { equal(values, [i.tenant], 'Tenant lock'); return clone(snapshot.tenant); }
    if (table === 'User') { equal(values, [i.tenant, i.actor], 'Actor lock'); return clone(snapshot.user.filter(r => r.id === i.actor && !r.deletedAt)); }
    if (table === 'Session') { equal(values, [i.session, i.actor], 'Session lock'); return clone(snapshot.session.filter(r => r.id === i.session && r.userId === i.actor)); }
    if (table === 'RoleAssignment') { equal(values, [i.tenant, i.actor], 'Assignment lock'); return clone(snapshot.roleAssignment); }
    if (table === 'Role') { equal(values, [i.tenant, i.role], 'Role lock'); return snapshot.role.map(r => ({ id: r.id })); }
    equal(values, [i.role], 'Grant lock'); return snapshot.role.flatMap(r => r.rolePermissions.map(() => ({ roleId: r.id, permissionId: 'policy-read-permission' })));
  };
  const client: any = { $transaction: async (callback: (tx: any) => Promise<any>, options?: PolicyRow) => {
    require(active === 0, 'No nested transaction');
    if (writer) { require(phase === 'owner', 'Writer precedes owner context only'); const selected = writer; writer = undefined; selected(); }
    contexts.push({ phase, ordinal: ++ordinal, options: clone(options ?? {}), at: Date.now() });
    const snapshot = clone(tables); active++;
    const tx: any = { $queryRaw: (sql: any, ...values: unknown[]) => raw('$queryRaw', sql, values, snapshot),
      $executeRaw: (sql: any, ...values: unknown[]) => raw('$executeRaw', sql, values, snapshot) };
    for (const table of Object.keys(tables)) {
      tx[table] = {};
      for (const method of ['findFirst', 'findUnique', 'findMany']) tx[table][method] = (args: PolicyRow) => query(table, method, args, snapshot);
      for (const method of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) tx[table][method] = async (args: PolicyRow) => {
        effects.push({ table, method, args: clone(args) }); require(false, 'Policy GET attempted domain write');
      };
    }
    try { return await callback(tx); } finally { active--; }
  } };
  const nativeDb = new TenantDatabase(client), tenantDb = new TenantPrismaService(client), rbac = new RbacService(tenantDb);
  const identity: SessionIdentity = { sub: i.actor, tenantId: i.tenant, sessionId: i.session, publicUserId: policyUuid(1),
    role: 'Policy reader', legacyRole: 'STAFF', roles: [], permissions: ['payroll:read'], pinResetRequired: false, mfaRequired: true, mfaVerified: true };
  const actor = { userId: i.actor, tenantId: i.tenant, sessionId: i.session };
  const observer: MfaSessionObserver = { observeSessionMfa: async selected => {
    require(active === 0, 'Proof observed outside own DB callback'); equal(selected, { sub: i.actor, tenantId: i.tenant, sessionId: i.session }, 'Canonical proof identity');
    observations.push({ phase, selected: clone(selected) });
    return observeMfaVerification(selected, async (script, redisKey) => {
      equal(script, MFA_MARKER_TTL_SCRIPT, 'Actual atomic marker script'); equal(redisKey, `session_mfa:${i.session}`, 'Bound marker key');
      return deadline.startsWith('mfa') ? 1000 : 120_000;
    });
  } };
  async function admit() {
    if (flavor === 'native') {
      const authority = await nativeDb.withTenant(i.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:read'));
      require(authority.requiresMfa, 'Actual privileged payroll:read requires MFA even when unenrolled');
      const proof = await observer.observeSessionMfa(authority.identity); assertCurrentMutation(authority, proof);
      await nativeDb.withTenant(i.tenant, async tx => assertCurrentMutation(await authorizeCurrentMutation(tx, identity, 'payroll:read'), proof));
    } else {
      await rbac.runCurrentMutation({ actor, requiredPermission: 'payroll:read', mfaObserver: observer },
        (tx, frozen) => rbac.authorizeActorMutationInTransaction(tx, frozen, 'payroll:read'), async (_tx, _authority, assertCurrent) => { assertCurrent(); });
    }
    expect(errors).toEqual([]); expect(contexts.filter(r => r.phase === 'admission')).toHaveLength(2);
    expect(observations.filter(r => r.phase === 'admission')).toHaveLength(1); expect(active).toBe(0); phase = 'owner';
  }
  function advance(expired: boolean) {
    if (deadline === 'mfa-monotonic') monotonic += expired ? 1001 : 999;
    else vi.setSystemTime(NOW + (deadline === 'policy' ? (expired ? 60_001 : 59_999) : (expired ? 1001 : 999)));
  }
  function assertClosed(before: unknown) {
    expect(errors).toEqual([]); expect(effects).toEqual([]); expect(active).toBe(0); expect(rowsBefore()).toEqual(before);
  }
  function change(which: PolicyWriter) {
    if (which === 'session') tables.session[0].revokedAt = new Date();
    if (which === 'grant') tables.role[0].rolePermissions = [];
    if (which === 'account') tables.user[0].suspendedAt = new Date();
    if (which === 'pin') tables.user[0].pinResetRequired = true;
    if (which === 'policy') tables.tenantSetting[0].value.security.sessionTimeoutMinutes = 5;
    if (which === 'tenant') tables.tenant[0].status = 'SUSPENDED';
    if (which === 'role') tables.role[0].deletedAt = new Date();
  }
  return { tables, identity, actor, nativeDb, tenantDb, rbac, observer, reads, effects, contexts, observations, admit, advance,
    rowsBefore, assertClosed, arrived: arrived.promise, release: release.release, pause(which: PolicyGate) { pause = which; }, gateHits: () => gateHits,
    pauseEntry() { pauseEntry = true; },
    writerFirst(which: PolicyWriter) { writer = () => change(which); },
    async checkWriterDenied() {
      phase = 'countercheck';
      try {
        if (flavor === 'native') await nativeDb.withTenant(i.tenant, tx => authorizeCurrentMutation(tx, identity, 'payroll:read'));
        else await rbac.runCurrentMutation({ actor, requiredPermission: 'payroll:read', mfaObserver: observer },
          (tx, frozen) => rbac.authorizeActorMutationInTransaction(tx, frozen, 'payroll:read'), async (_tx, _authority, assertCurrent) => { assertCurrent(); });
        return null;
      } catch (error) { return error; }
      finally { phase = 'owner'; }
    },
  };
}
export async function runPolicyPaused<T>(f: ReturnType<typeof payrollPolicyReadFixture>, call: () => Promise<T>, expired: boolean) {
  const result = call().then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    expect(await policyBounded(Promise.race([f.arrived.then(() => 'entered'), result.then(() => 'settled')]))).toBe('entered');
    expect(f.gateHits()).toBe(1); f.advance(expired); f.release(); return await policyBounded(result);
  } finally { f.release(); await policyBounded(result); }
}
