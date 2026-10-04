import { createHash, scryptSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { MfaSessionIdentity, MfaVerificationObservation } from '@lunchlineup/rbac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleService } from './people.service';
import { profileVersion } from './profile-version';
import { ProblemError } from '../platform/problem';

const cryptoWork = vi.hoisted(() => ({
  paused: false,
  pending: [] as Array<() => void>,
  onStart: undefined as ((pin: string) => void) | undefined,
}));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scrypt: vi.fn((pin: string, salt: string, length: number,
    callback: (error: Error | null, key: Buffer) => void) => {
    cryptoWork.onStart?.(pin);
    const run = () => actual.scrypt(pin, salt, length, callback);
    if (cryptoWork.paused) cryptoWork.pending.push(run); else run();
  }) };
});

const ids = { tenant: 'authority-tenant', actor: 'authority-actor', target: 'authority-target',
  session: 'authority-session', actorRole: 'authority-admin-role', staffRole: 'authority-staff-role',
  customRole: 'authority-custom-role' };
const pub = { actor: 'e62f911a-7d9d-4c44-8450-b378691b6011', target: 'e62f911a-7d9d-4c44-8450-b378691b6012',
  staff: 'e62f911a-7d9d-4c44-8450-b378691b6013', custom: 'e62f911a-7d9d-4c44-8450-b378691b6014',
  actorRole: 'e62f911a-7d9d-4c44-8450-b378691b6015', invited: 'e62f911a-7d9d-4c44-8450-b378691b6016' };
const oldPin = '246810', newPin = '135790', salt = '0123456789abcdef0123456789abcdef';
const pinHash = salt + ':' + scryptSync(oldPin, salt, 64).toString('hex');
const privileges = ['auth:login_pin', 'auth:login_email', 'users:read', 'users:write', 'users:admin',
  'roles:read', 'roles:write', 'roles:assign'];
const actions = ['updateIdentity', 'replaceSchedulingProfile', 'invite', 'retryInvitation', 'reissueInvitation',
  'resetPin', 'setSuspended', 'remove', 'replaceAccess', 'createRole', 'updateRole', 'deleteRole'] as const;
type PrivilegedAction = typeof actions[number];
type Action = PrivilegedAction | 'replaceOwnPin';
type Row = Record<string, any>;
type State = { tenant: Row | null; users: Row[]; sessions: Row[]; roles: Row[]; assignments: Row[];
  security: Row; skills: Row[]; availability: Row[]; exceptions: Row[]; outboxes: Row[]; audits: Row[];
  cleanup: Row[] };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flatten = (items: unknown[]): unknown[] => items.flatMap(x => x && typeof x === 'object' && 'values' in x
  ? flatten((x as { values: unknown[] }).values) : [x]);
const clone = <T,>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'role') return true; // Role relation is independently filtered below.
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('lt' in value) return row[key] < value.lt;
      if ('gt' in value) return row[key] > value.gt;
      throw new Error('Unexpected scalar selector: ' + key);
    }
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
}
function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
    ? (row[key] ?? 0) + value.increment : clone(value);
}
function user(id: string, publicId: string, role: string): Row {
  return { id, publicId, tenantId: ids.tenant, role, name: id, email: null, username: id.replace(/-/g, '.'),
    deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null, pinLoginAttempts: 0,
    pinHash, pinResetRequired: false, mfaEnabled: false, oidcSubject: null };
}
function role(id: string, publicId: string, legacyRole: string | null, permissions: string[]): Row {
  return { id, publicId, tenantId: ids.tenant, name: id, slug: id, description: null, isSystem: legacyRole !== null,
    isDefault: false, legacyRole, deletedAt: null, rolePermissions: permissions.map(key => ({ permission: { key } })),
    _count: { assignments: 0 } };
}
const config = { staffInvitationOutboxEnabled: true, staffInvitationOutboxEncryptionKey: '11'.repeat(32), staffInvitationMaxAttempts: 8 };
// The optional observer constructor is deliberately supplied to the unchanged
// owner too. Baseline's two-argument constructor ignores it; no production mock.
type PeopleWithObserver = new (database: any, configuration: typeof config,
  observer?: Partial<{ observeSessionMfa(identity: MfaSessionIdentity): Promise<MfaVerificationObservation | null> }>) => PeopleService;

function fixture(action: Action) {
  let state: State = {
    tenant: { id: ids.tenant, status: 'ACTIVE', deletedAt: null, planTier: 'FREE', stripeSubscriptionId: null,
      stripeSubscriptionCurrentPeriodEnd: null, trialEndsAt: null },
    users: [user(ids.actor, pub.actor, 'ADMIN'), user(ids.target, pub.target, 'STAFF')],
    sessions: [{ id: ids.session, userId: ids.actor, createdAt: new Date(Date.now() - 20 * 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: null },
    { id: 'target-session', userId: ids.target, createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: null }],
    roles: [role(ids.actorRole, pub.actorRole, 'ADMIN', privileges), role(ids.staffRole, pub.staff, 'STAFF', ['auth:login_pin', 'users:read']),
      role(ids.customRole, pub.custom, null, ['users:read'])],
    assignments: [{ tenantId: ids.tenant, userId: ids.actor, roleId: ids.actorRole },
      { tenantId: ids.tenant, userId: ids.target, roleId: ids.staffRole }],
    security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
    skills: [], availability: [], exceptions: [], outboxes: [], audits: [], cleanup: [],
  };
  if (action === 'replaceOwnPin') {
    state.users[0].role = 'STAFF'; state.roles[0].legacyRole = 'STAFF';
    state.roles[0].rolePermissions = [{ permission: { key: 'auth:login_pin' } }];
  }
  if (action === 'retryInvitation' || action === 'reissueInvitation') {
    state.users[1].email = 'staff@example.test';
    state.outboxes.push({ id: 'delivery-original', tenantId: ids.tenant, userId: ids.target, purpose: 'STAFF_INVITATION',
      recipientHash: 'synthetic', encryptedPayload: Buffer.from('synthetic-encrypted-payload'),
      status: action === 'retryInvitation' ? 'FAILED' : 'DEAD_LETTERED', attempts: 1, manualRetryCount: 0,
      retryAt: null, deliveredAt: null, deadLetteredAt: null, lastErrorCode: null });
  }
  const identity: SessionIdentity = { sub: ids.actor, publicUserId: pub.actor, tenantId: ids.tenant, sessionId: ids.session,
    role: 'ADMIN', legacyRole: 'ADMIN', roles: [], permissions: privileges, mfaRequired: true, mfaVerified: true,
    pinResetRequired: false };
  const initial = gate(), initialRelease = gate(), late = gate(), lateRelease = gate();
  const attempts: Row[] = [], committed: Row[] = [];
  const controls = { active: 0, ttl: 60_000, observerFailure: false, observerOffline: false,
    stage: 'tenant' as 'tenant' | 'role' | 'domain', entered: false, tenantVisits: 0,
    failAudit: false, conflictOnce: false, rejectCas: false, onConflict: undefined as (() => void) | undefined };
  const initialSnapshot = () => clone(state);
  const observeSessionMfa = vi.fn(async (selected: MfaSessionIdentity) => {
    expect(controls.active).toBe(0);
    expect(selected).toEqual({ sub: ids.actor, tenantId: ids.tenant, sessionId: ids.session });
    if (controls.observerFailure) throw new Error('controlled.redis.provider.secret');
    if (controls.ttl <= 0) return null;
    return { ...selected, expiresAtEpochMs: Date.now() + controls.ttl, expiresAtMonotonicMs: performance.now() + controls.ttl };
  });
  const observer: Partial<{ observeSessionMfa: typeof observeSessionMfa }> = {};
  Object.defineProperty(observer, 'observeSessionMfa', { get: () => controls.observerOffline ? undefined : observeSessionMfa });
  const withTenant = vi.fn(async (tenantId: string, operation: (tx: any) => Promise<any>) => {
    expect(tenantId).toBe(ids.tenant); expect(controls.active).toBe(0); controls.active++;
    let draft: State | undefined;
    const pending: Row[] = [];
    const view = () => draft ?? state;
    const startDraft = () => { draft ??= clone(state); return draft; };
    const effect = (table: string, method: string, args: Row) => {
      const entry = { table, method, args: clone(args) }; attempts.push(entry); pending.push(entry); return startDraft();
    };
    const pause = async (kind: 'role' | 'domain') => {
      if (controls.stage === kind && !controls.entered) { controls.entered = true; late.release(); await lateRelease.promise; }
    };
    const targetWhere = (where: Row) => {
      expect(where.tenantId).toBe(ids.tenant);
      if (where.id && typeof where.id === 'string') expect([ids.actor, ids.target, 'invited-storage']).toContain(where.id);
    };
    const updateRows = (table: string, rows: Row[], args: Row) => {
      const chosen = rows.filter(row => matches(row, args.where));
      chosen.forEach(row => apply(row, args.data)); return { count: chosen.length };
    };
    const tx: any = {
      $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
        const text = (Array.isArray(sql) ? sql : sql.strings).join('');
        const values = flatten(Array.isArray(sql) ? args : sql.values);
        if (text.includes('FROM "Tenant"')) {
          expect(values).toEqual([ids.tenant]); controls.tenantVisits++;
          if (controls.tenantVisits === 1) { initial.release(); await initialRelease.promise; }
          return state.tenant ? [{ id: ids.tenant }] : [];
        }
        if (text.includes('FROM "Session"')) {
          expect(values).toEqual([ids.session, ids.actor]);
          return clone(view().sessions.filter(row => row.id === values[0] && row.userId === values[1]));
        }
        if (text.includes('FROM "User"')) {
          expect(values).toContain(ids.tenant);
          const selectedIds = values.filter(value => typeof value === 'string' && value !== ids.tenant);
          expect(selectedIds.every(id => [ids.actor, ids.target].includes(id as string))).toBe(true);
          return clone(view().users.filter(row => row.tenantId === ids.tenant && selectedIds.includes(row.id)
            && (!text.includes('"suspendedAt" IS NULL') || !row.suspendedAt)
            && (!text.includes('"deletedAt" IS NULL') || !row.deletedAt)));
        }
        if (text.includes('FROM "RolePermission"')) {
          expect(values.every(id => view().roles.some(row => row.id === id))).toBe(true);
          await pause('role'); return [];
        }
        if (text.includes('FROM "Role"')) {
          expect(values).toContain(ids.tenant); return clone(view().roles.filter(row => values.includes(row.id) && row.tenantId === ids.tenant));
        }
        if (text.includes('FROM "AvailabilityImportJob"')) { expect(values).toContain(ids.tenant); await pause('domain'); return []; }
        if (text.includes('FROM "Schedule"')) { expect(values).toContain(ids.tenant); if (action === 'replaceSchedulingProfile') await pause('domain'); return []; }
        if (text.includes('FROM "Shift"')) { expect(values).toContain(ids.tenant); return []; }
        throw new Error('Unmodeled raw read: ' + text);
      }),
      $executeRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
        const text = (Array.isArray(sql) ? sql : sql.strings).join('');
        const values = flatten(Array.isArray(sql) ? args : sql.values);
        if (text.includes('pg_advisory_xact_lock')) {
          if (action === 'setSuspended' && values.includes('lunchlineup:scheduling:' + ids.tenant)) await pause('domain');
          return 1;
        }
        if (text.includes('UPDATE "Session"')) {
          expect(values).toContain(ids.target); const d = effect('session', 'redactRaw', { userId: ids.target });
          d.sessions.filter(row => row.userId === ids.target).forEach(row => { row.revokedAt = new Date(); }); return 1;
        }
        throw new Error('Unmodeled raw effect: ' + text);
      }),
      tenant: { findUnique: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ id: ids.tenant }); return clone(view().tenant); }) },
      tenantSetting: { findUnique: vi.fn(async ({ where }: Row) => {
        expect(where).toEqual({ tenantId_key: { tenantId: ids.tenant, key: 'workspace_settings' } });
        return { value: { security: clone(view().security), team: { defaultInviteRole: 'STAFF' } } };
      }) },
      user: {
        findFirst: vi.fn(async ({ where, select }: Row) => {
          targetWhere(where);
          if (where.id === ids.target && action === 'updateIdentity' && !select) await pause('domain');
          if (where.id === ids.target && action === 'resetPin' && select?.username) await pause('domain');
          return clone(view().users.find(row => matches(row, where)) ?? null);
        }),
        findUnique: vi.fn(async ({ where }: Row) => clone(view().users.find(row => matches(row, where)) ?? null)),
        findFirstOrThrow: vi.fn(async ({ where }: Row) => { targetWhere(where); const row = view().users.find(row => matches(row, where));
          if (!row) throw new Error('Fixture target disappeared'); return clone(row); }),
        findMany: vi.fn(async ({ where }: Row) => { targetWhere(where); return clone(view().users.filter(row => matches(row, where))); }),
        count: vi.fn(async ({ where }: Row) => { targetWhere(where); return view().users.filter(row => matches(row, where)).length; }),
        create: vi.fn(async (args: Row) => { expect(args.data.tenantId).toBe(ids.tenant);
          const d = effect('user', 'create', args); const row = { ...user('invited-storage', pub.invited, 'STAFF'), ...clone(args.data) };
          d.users.push(row); return clone(row); }),
        update: vi.fn(async (args: Row) => { expect([ids.actor, ids.target]).toContain(args.where.id);
          const d = effect('user', 'update', args); const row = d.users.find(row => matches(row, args.where));
          if (!row) throw new Error('Fixture update missed'); apply(row, args.data); return clone(row); }),
        updateMany: vi.fn(async (args: Row) => { targetWhere(args.where); const d = effect('user', 'updateMany', args);
          if (controls.rejectCas && args.where.pinHash) return { count: 0 };
          return updateRows('user', d.users, args); }),
      },
      session: {
        findFirst: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ id: ids.session, userId: ids.actor });
          return clone(view().sessions.find(row => matches(row, where)) ?? null); }),
        findMany: vi.fn(async ({ where }: Row) => { expect(where.userId).toBe(ids.actor); return clone(view().sessions.filter(row => matches(row, where))); }),
        updateMany: vi.fn(async (args: Row) => { expect([ids.actor, ids.target]).toContain(args.where.userId);
          expect(args.where.revokedAt).toBeNull(); const d = effect('session', 'updateMany', args); return updateRows('session', d.sessions, args); }),
      },
      roleAssignment: {
        findMany: vi.fn(async ({ where }: Row) => { expect(where.tenantId).toBe(ids.tenant);
          const assigned = view().assignments.filter(row => matches(row, where));
          return clone(assigned.flatMap(row => {
            const selected = view().roles.find(role => role.id === row.roleId && role.tenantId === ids.tenant && !role.deletedAt);
            return selected ? [{ ...row, role: selected }] : [];
          })); }),
        count: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ tenantId: ids.tenant, roleId: ids.customRole });
          if (action === 'deleteRole') await pause('domain'); return view().assignments.filter(row => matches(row, where)).length; }),
        deleteMany: vi.fn(async (args: Row) => { expect(args.where.tenantId).toBe(ids.tenant);
          const d = effect('roleAssignment', 'deleteMany', args); const old = d.assignments.length;
          d.assignments = d.assignments.filter(row => !matches(row, args.where)); return { count: old - d.assignments.length }; }),
        create: vi.fn(async (args: Row) => { expect(args.data.tenantId).toBe(ids.tenant);
          effect('roleAssignment', 'create', args).assignments.push(clone(args.data)); return clone(args.data); }),
        createMany: vi.fn(async (args: Row) => { expect(args.data.every((row: Row) => row.tenantId === ids.tenant)).toBe(true);
          effect('roleAssignment', 'createMany', args).assignments.push(...clone(args.data)); return { count: args.data.length }; }),
      },
      role: {
        findFirst: vi.fn(async ({ where }: Row) => { expect(where.tenantId).toBe(ids.tenant);
          if (action === 'invite' && where.id === ids.staffRole) await pause('domain');
          return clone(view().roles.find(row => matches(row, where)) ?? null); }),
        findMany: vi.fn(async ({ where }: Row) => { expect(where.tenantId).toBe(ids.tenant);
          if (action === 'replaceAccess' && where.id?.in?.length === 1 && where.id.in[0] === ids.staffRole) await pause('domain');
          return clone(view().roles.filter(row => matches(row, where))); }),
        count: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ tenantId: ids.tenant, isSystem: false, deletedAt: null });
          if (action === 'createRole') await pause('domain'); return view().roles.filter(row => matches(row, where)).length; }),
        create: vi.fn(async (args: Row) => { expect(args.data.tenantId).toBe(ids.tenant);
          const d = effect('role', 'create', args); const row = { ...role('new-role-storage', pub.invited, null, ['users:read']), ...clone(args.data),
            rolePermissions: [{ permission: { key: 'users:read' } }] }; d.roles.push(row); return clone(row); }),
        update: vi.fn(async (args: Row) => { expect(args.where).toEqual({ id: ids.customRole });
          const d = effect('role', 'update', args); const row = d.roles.find(row => row.id === ids.customRole)!;
          const { rolePermissions: nested, ...data } = args.data; apply(row, data);
          if (nested) row.rolePermissions = nested.createMany.data.map((x: Row) => ({ permission: { key: x.permissionId.replace('permission:', '') } }));
          return clone(row); }),
      },
      permission: { findMany: vi.fn(async ({ where }: Row) => { expect(Array.isArray(where.key.in)).toBe(true);
        if (action === 'updateRole') await pause('domain'); return where.key.in.map((key: string) => ({ id: 'permission:' + key, key })); }) },
      rolePermission: { deleteMany: vi.fn(async (args: Row) => { expect(args.where).toEqual({ roleId: ids.customRole });
        const d = effect('rolePermission', 'deleteMany', args); d.roles.find(row => row.id === ids.customRole)!.rolePermissions = []; return { count: 1 }; }) },
      auditLog: { create: vi.fn(async (args: Row) => { expect(args.data).toMatchObject({ tenantId: ids.tenant, actorUserId: ids.actor, actorTenantId: ids.tenant });
        effect('auditLog', 'create', args).audits.push(clone(args.data)); if (controls.failAudit) throw new Error('controlled audit failure'); return clone(args.data); }) },
      planDefinition: { findUnique: vi.fn(async () => ({ code: 'FREE', userLimit: 100 })) },
      location: { findMany: vi.fn(async () => []) },
      shift: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      schedule: { updateMany: vi.fn(async (args: Row) => { effect('schedule', 'updateMany', args); return { count: 0 }; }) },
      staffSkill: {
        findMany: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ tenantId: ids.tenant, userId: ids.target });
          return clone(view().skills.filter(row => matches(row, where))); }),
        deleteMany: vi.fn(async (args: Row) => { expect(args.where).toEqual({ tenantId: ids.tenant, userId: ids.target });
          const d = effect('staffSkill', 'deleteMany', args); const before = d.skills.length;
          d.skills = d.skills.filter(row => !matches(row, args.where)); return { count: before - d.skills.length }; }),
        createMany: vi.fn(async (args: Row) => { expect(args.data).toEqual([{ tenantId: ids.tenant, userId: ids.target, skill: 'expo' }]);
          effect('staffSkill', 'createMany', args).skills.push(...clone(args.data)); return { count: args.data.length }; }),
      },
      staffAvailability: {
        findMany: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ tenantId: ids.tenant, userId: ids.target });
          return clone(view().availability.filter(row => matches(row, where))); }),
        deleteMany: vi.fn(async (args: Row) => { expect(args.where).toEqual({ tenantId: ids.tenant, userId: ids.target });
          const d = effect('staffAvailability', 'deleteMany', args); const before = d.availability.length;
          d.availability = d.availability.filter(row => !matches(row, args.where)); return { count: before - d.availability.length }; }),
        createMany: vi.fn(async (args: Row) => { expect(args.data.every((row: Row) => row.tenantId === ids.tenant && row.userId === ids.target)).toBe(true);
          effect('staffAvailability', 'createMany', args).availability.push(...clone(args.data)); return { count: args.data.length }; }),
      },
      staffAvailabilityException: {
        findMany: vi.fn(async ({ where }: Row) => { expect(where).toEqual({ tenantId: ids.tenant, userId: ids.target });
          return clone(view().exceptions.filter(row => matches(row, where))); }),
        deleteMany: vi.fn(async (args: Row) => { expect(args.where).toEqual({ tenantId: ids.tenant, userId: ids.target });
          const d = effect('staffAvailabilityException', 'deleteMany', args); const before = d.exceptions.length;
          d.exceptions = d.exceptions.filter(row => !matches(row, args.where)); return { count: before - d.exceptions.length }; }),
        createMany: vi.fn(async (args: Row) => { expect(args.data.every((row: Row) => row.tenantId === ids.tenant && row.userId === ids.target)).toBe(true);
          effect('staffAvailabilityException', 'createMany', args).exceptions.push(...clone(args.data)); return { count: args.data.length }; }),
      },
      staffInvitationOutbox: {
        findUnique: vi.fn(async ({ where }: Row) => {
          if (where.tenantId_userId_purpose) {
            expect(where.tenantId_userId_purpose).toEqual({ tenantId: ids.tenant, userId: ids.target, purpose: 'STAFF_INVITATION' });
            await pause('domain'); return clone(view().outboxes.find(row => matches(row, where.tenantId_userId_purpose)) ?? null);
          }
          return clone(view().outboxes.find(row => row.id === where.id) ?? null);
        }),
        updateMany: vi.fn(async (args: Row) => { expect(args.where.tenantId).toBe(ids.tenant); expect(args.where.userId).toBe(ids.target);
          const d = effect('staffInvitationOutbox', 'updateMany', args); return updateRows('outbox', d.outboxes, args); }),
      },
    };
    // Explicit empty cleanup stores keep actual anonymization viable without
    // mocking the owner or a blanket permissive ORM Proxy. No storage keys exist.
    for (const name of ['availabilityImportJob', 'passwordResetToken', 'passwordResetEmailOutbox', 'mfaTotpClaim',
      'onboardingSignupAttempt', 'notificationOutbox', 'notification']) {
      tx[name] = {
        updateMany: vi.fn(async (args: Row) => { expect(args.where.tenantId).toBe(ids.tenant);
          effect(name, 'updateMany', args).cleanup.push({ table: name }); return { count: 0 }; }),
        deleteMany: vi.fn(async (args: Row) => { expect(args.where.tenantId).toBe(ids.tenant); expect(args.where.userId).toBe(ids.target);
          effect(name, 'deleteMany', args).cleanup.push({ table: name }); return { count: 0 }; }),
      };
    }
    tx.refreshTokenReplay = { deleteMany: vi.fn(async (args: Row) => { expect(args.where).toEqual({ session: { userId: ids.target } });
      effect('refreshTokenReplay', 'deleteMany', args).cleanup.push({ table: 'refreshTokenReplay' }); return { count: 0 }; }) };
    try {
      const result = await operation(tx);
      if (pending.length && controls.conflictOnce) { controls.conflictOnce = false; controls.onConflict?.(); throw { code: '40001' }; }
      if (pending.length) { state = draft!; committed.push(...clone(pending)); }
      return result;
    } finally { controls.active--; }
  });
  const service = new (PeopleService as unknown as PeopleWithObserver)({ withTenant }, config, observer);
  const version = createHash('sha256').update(JSON.stringify([state.users[1].name, '', state.users[1].username])).digest('hex');
  const call = () => {
    switch (action) {
      case 'updateIdentity': return service.updateIdentity(identity, pub.target, { name: 'Changed name', email: '', username: state.users[1].username, expectedVersion: version });
      case 'replaceSchedulingProfile': return service.replaceSchedulingProfile(identity, pub.target, { skills: ['expo'], availability: [], expectedVersion: profileVersion(ids.target, [], [], []) });
      case 'invite': return service.invite(identity, { name: 'New staff', username: 'new.staff', pin: newPin, roleId: pub.staff });
      case 'retryInvitation': return service.retryInvitation(identity, pub.target);
      case 'reissueInvitation': return service.reissueInvitation(identity, pub.target, 'controlled-reissue-key');
      case 'resetPin': return service.resetPin(identity, pub.target, newPin);
      case 'replaceOwnPin': return service.replaceOwnPin(identity, oldPin, newPin);
      case 'setSuspended': return service.setSuspended(identity, pub.target, { suspended: true, expectedSuspendedAt: null });
      case 'remove': return service.remove(identity, pub.target);
      case 'replaceAccess': return service.replaceAccess(identity, pub.target, [pub.staff]);
      case 'createRole': return service.createRole(identity, { name: 'Reader', permissionKeys: ['users:read'] });
      case 'updateRole': return service.updateRole(identity, pub.custom, { name: 'Renamed reader', permissionKeys: ['users:read'] });
      case 'deleteRole': return service.deleteRole(identity, pub.custom);
    }
  };
  return { service, identity, controls, observeSessionMfa, attempts, committed, withTenant, call, initial, initialRelease, late, lateRelease,
    snapshot: initialSnapshot, get state() { return state; } };
}
type Fixture = ReturnType<typeof fixture>;
async function runAt(h: Fixture, change: () => void, stage: 'tenant' | 'role' | 'domain' = 'tenant') {
  h.controls.stage = stage;
  const result = h.call().then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
  try {
    expect(await Promise.race([h.initial.promise.then(() => 'entered'), result.then(() => 'settled')])).toBe('entered');
    if (stage !== 'tenant') {
      h.initialRelease.release();
      expect(await Promise.race([h.late.promise.then(() => 'entered'), result.then(() => 'settled')])).toBe('entered');
    }
    change(); h.initialRelease.release(); h.lateRelease.release(); return await result;
  } finally { h.initialRelease.release(); h.lateRelease.release(); await result; }
}
function denied(result: { error: unknown }, h: Fixture, status: number | number[] = [401, 403]) {
  expect(result.error).toBeInstanceOf(ProblemError);
  expect(Array.isArray(status) ? status : [status]).toContain((result.error as ProblemError).status);
  expect((result.error as ProblemError).code).not.toBe('internal_error');
  expect(String((result.error as Error).message)).not.toContain('controlled.redis.provider.secret');
  expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]);
}
function resumeCrypto() { cryptoWork.paused = false; cryptoWork.pending.splice(0).forEach(run => run()); }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T09:00:00Z'));
  cryptoWork.paused = false; cryptoWork.pending = []; cryptoWork.onStart = undefined; });
afterEach(() => { resumeCrypto(); cryptoWork.onStart = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

// Missing Tenant with retained User rows is a deliberately inconsistent local
// state model (real FK reachability is unproven), not a native exploit assertion.
const invalidTenants: Array<[string, (h: Fixture) => void]> = [
  ['missing', h => { h.state.tenant = null; }], ['deleted', h => { h.state.tenant!.deletedAt = new Date(); }],
  ['SUSPENDED', h => { h.state.tenant!.status = 'SUSPENDED'; }], ['PURGED', h => { h.state.tenant!.status = 'PURGED'; }],
];
describe('actual People privileged mutation current authority', () => {
  for (const action of actions) {
    it(action + ' has a viable exact-session bounded-MFA positive', async () => {
      const h = fixture(action); const result = await runAt(h, () => {});
      expect(result.error).toBeUndefined(); expect(h.committed.length).toBeGreaterThan(0);
      if (action === 'replaceSchedulingProfile') {
        expect(h.state.skills).toEqual([{ tenantId: ids.tenant, userId: ids.target, skill: 'expo' }]);
        expect(result.value).toMatchObject({ user: { id: pub.target }, skills: ['expo'],
          version: profileVersion(ids.target, ['expo'], [], []) });
        expect(h.state.audits).toEqual([]); // This owner has no existing audit side effect.
      } else {
        expect(h.state.audits.length).toBe(1);
        expect(h.state.audits[0]).toMatchObject({ actorUserId: ids.actor, actorTenantId: ids.tenant, tenantId: ids.tenant });
      }
    });
    it.each(invalidTenants)(action + ' denies current %s Tenant before effects', async (_label, change) => {
      const h = fixture(action); const result = await runAt(h, () => change(h)); denied(result, h);
    });
    it(action + ' refuses a current forced-PIN actor', async () => {
      const h = fixture(action); const result = await runAt(h, () => { h.state.users[0].pinResetRequired = true; }); denied(result, h, 403);
    });
    it(action + ' uses current shortened policy lifetime', async () => {
      const h = fixture(action); const result = await runAt(h, () => { h.state.security.sessionTimeoutMinutes = 5; }); denied(result, h);
    });
    it(action + ' requires current bounded MFA despite verified request claims', async () => {
      const h = fixture(action); h.controls.ttl = -2; const result = await runAt(h, () => {}); denied(result, h, 403);
    });
    it.each(['offline', 'read failure'])(action + ' fails closed on MFA %s', async failure => {
      const h = fixture(action); h.controls.observerOffline = failure === 'offline'; h.controls.observerFailure = failure === 'read failure';
      const result = await runAt(h, () => {}); denied(result, h, 503);
    });
    it(action + ' refuses stored expiry across the final RBAC wait', async () => {
      const h = fixture(action); const result = await runAt(h, () => { vi.setSystemTime(Date.now() + 3_600_000); }, 'role'); denied(result, h);
    });
    it(action + ' refuses stored expiry across its final domain wait', async () => {
      const h = fixture(action); const result = await runAt(h, () => { vi.setSystemTime(Date.now() + 3_600_000); }, 'domain'); denied(result, h);
    });
    it(action + ' refuses effective policy expiry while stored expiry remains future', async () => {
      const h = fixture(action); h.state.security.sessionTimeoutMinutes = 30;
      const result = await runAt(h, () => { vi.setSystemTime(Date.now() + 10 * 60_000); }, 'domain'); denied(result, h);
    });
    it(action + ' refuses observation expiry across its final domain wait', async () => {
      const h = fixture(action); h.controls.ttl = 1000;
      const result = await runAt(h, () => { vi.setSystemTime(Date.now() + 1001); }, 'domain'); denied(result, h, 403);
    });
  }
  it.each(['updateIdentity', 'resetPin', 'setSuspended', 'remove', 'replaceAccess', 'retryInvitation', 'reissueInvitation'] as const)(
    '%s preserves target dominance after current actor authorization', async action => {
      const h = fixture(action); h.state.users[1].role = 'ADMIN'; h.state.roles[1].legacyRole = 'ADMIN';
      const result = await runAt(h, () => {}); denied(result, h, 403);
    });
  it.each(['createRole', 'updateRole'] as const)('%s retains current subset delegation', async action => {
    const h = fixture(action); h.state.roles[0].rolePermissions = h.state.roles[0].rolePermissions.filter((x: Row) => x.permission.key !== 'users:read');
    const result = await runAt(h, () => {}); denied(result, h, 403);
  });
  it('role assignment refuses a foreign or deleted role without effects', async () => {
    const h = fixture('replaceAccess'); h.state.roles[1].deletedAt = new Date();
    const result = await runAt(h, () => {}); expect(result.error).toBeInstanceOf(ProblemError);
    expect(result.error).toMatchObject({ status: 422, code: 'invalid_role' }); expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]);
  });
  it('audit failure discards attempted role mutation without a committed publication', async () => {
    const h = fixture('createRole'); h.controls.failAudit = true;
    const result = await runAt(h, () => {}); expect(result.error).toEqual(new Error('controlled audit failure'));
    expect(h.attempts.map(x => x.table)).toEqual(['role', 'auditLog']); expect(h.committed).toEqual([]);
    expect(h.state.roles.some(row => row.id === 'new-role-storage')).toBe(false); expect(h.state.audits).toEqual([]);
  });
  it('serialization conflict maps to controlled409 without automatic retry or publication', async () => {
    const h = fixture('createRole'); h.controls.conflictOnce = true;
    const result = await runAt(h, () => {}); expect(result.error).toBeInstanceOf(ProblemError);
    expect(result.error).toMatchObject({ status: 409, code: 'concurrent_change' });
    expect(h.committed).toEqual([]); expect(h.state.audits).toEqual([]);
    expect(h.attempts.filter(x => x.table === 'auditLog')).toHaveLength(1);
  });
  it('explicit client retry refreshes revoked exact session after discarded conflict', async () => {
    const h = fixture('createRole'); h.controls.conflictOnce = true;
    h.controls.onConflict = () => { h.state.sessions[0].revokedAt = new Date(); };
    const first = await runAt(h, () => {}); expect(first.error).toMatchObject({ status: 409, code: 'concurrent_change' });
    const second = await h.call().then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
    expect(second.error).toBeInstanceOf(ProblemError); expect(second.error).toMatchObject({ status: 403 });
    expect(h.committed).toEqual([]); expect(h.state.audits).toEqual([]);
    expect(h.attempts.filter(x => x.table === 'auditLog')).toHaveLength(1);
  });
  it('explicit client retry can publish one role and audit after discarded conflict', async () => {
    const h = fixture('createRole'); h.controls.conflictOnce = true;
    const first = await runAt(h, () => {}); expect(first.error).toMatchObject({ status: 409, code: 'concurrent_change' });
    await h.call(); expect(h.state.roles.filter(row => row.id === 'new-role-storage')).toHaveLength(1);
    expect(h.state.audits).toHaveLength(1); expect(h.attempts.filter(x => x.table === 'auditLog')).toHaveLength(2);
    expect(h.committed.filter(x => x.table === 'auditLog')).toHaveLength(1);
  });
  it('response and audit expose public identities without storage ids or PIN material', async () => {
    const h = fixture('invite'); const result = await runAt(h, () => {}); expect(result.error).toBeUndefined();
    const serialized = JSON.stringify(result.value); expect(serialized).not.toContain('invited-storage'); expect(serialized).not.toContain('pinHash');
    expect(JSON.stringify(h.state.audits)).not.toContain(newPin); expect(JSON.stringify(h.state.audits)).not.toContain(pinHash);
  });
});

async function duringKdf(h: Fixture, change: () => void, currentPin = oldPin) {
  const entered = gate(); cryptoWork.paused = true;
  cryptoWork.onStart = () => { expect(h.controls.active).toBe(0); entered.release(); };
  const result = h.service.replaceOwnPin(h.identity, currentPin, newPin).then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
  try {
    h.initialRelease.release();
    expect(await Promise.race([entered.promise.then(() => 'entered'), result.then(() => 'settled')])).toBe('entered');
    change(); resumeCrypto(); return await result;
  } finally { resumeCrypto(); h.initialRelease.release(); h.lateRelease.release(); await result; }
}
describe('actual People self PIN recovery and async proof authority', () => {
  it('forced reset remains usable without MFA and keeps both KDFs outside transactions', async () => {
    const h = fixture('replaceOwnPin'); h.state.users[0].pinResetRequired = true; h.state.security.requireMfaForAll = true; h.controls.ttl = -2;
    const result = await duringKdf(h, () => {}); expect(result.error).toBeUndefined(); expect(h.observeSessionMfa).not.toHaveBeenCalled();
    expect(h.state.users[0].pinResetRequired).toBe(false); expect(h.state.sessions[0].revokedAt).toBeInstanceOf(Date);
    expect(h.state.sessions[1].revokedAt).toBeNull(); expect(h.state.audits).toHaveLength(1);
    const [nextSalt, hash] = h.state.users[0].pinHash.split(':'); expect(hash).toBe(scryptSync(newPin, nextSalt, 64).toString('hex'));
    expect(h.withTenant.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('ordinary rotation refuses MFA policy that becomes required during KDF', async () => {
    const h = fixture('replaceOwnPin'); h.controls.ttl = -2;
    const result = await duringKdf(h, () => { h.state.security.requireMfaForAll = true; }); denied(result, h, 403);
  });
  it('ordinary rotation refuses enrolled MFA that becomes current during KDF', async () => {
    const h = fixture('replaceOwnPin'); h.controls.ttl = -2;
    const result = await duringKdf(h, () => { h.state.users[0].mfaEnabled = true; }); denied(result, h, 403);
  });
  it('forced reset becoming ordinary during KDF requires current MFA', async () => {
    const h = fixture('replaceOwnPin'); h.state.users[0].pinResetRequired = true; h.state.users[0].mfaEnabled = true; h.controls.ttl = -2;
    const result = await duringKdf(h, () => { h.state.users[0].pinResetRequired = false; }); denied(result, h, 403);
  });
  it('ordinary rotation accepts canonical current observation with async CAS proof', async () => {
    const h = fixture('replaceOwnPin'); h.state.users[0].mfaEnabled = true;
    const result = await duringKdf(h, () => {}); expect(result.error).toBeUndefined();
    expect(h.state.users[0].pinHash).not.toBe(pinHash); expect(h.state.audits).toHaveLength(1);
    const attempted = h.attempts.find(x => x.table === 'user' && x.method === 'updateMany')!;
    expect(attempted.args.where).toMatchObject({ id: ids.actor, tenantId: ids.tenant, username: h.state.users[0].username, pinHash, role: 'STAFF' });
  });
  it('ordinary rotation refuses an observation exhausted during async KDF', async () => {
    const h = fixture('replaceOwnPin'); h.state.users[0].mfaEnabled = true; h.controls.ttl = 1000;
    const result = await duringKdf(h, () => { vi.setSystemTime(Date.now() + 1001); }); denied(result, h, 403);
  });
  it('changed credential during KDF refuses CAS without charging the replacement', async () => {
    const h = fixture('replaceOwnPin'); const replacement = 'changed:' + '0'.repeat(128);
    const result = await duringKdf(h, () => { h.state.users[0].pinHash = replacement; });
    expect(result.error).toBeInstanceOf(ProblemError); expect(result.error).toMatchObject({ status: 409, code: 'pin_rotation_changed' });
    expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.state.users[0].pinHash).toBe(replacement);
  });
  it('zero-row credential CAS discards attempts and returns controlled conflict', async () => {
    const h = fixture('replaceOwnPin'); h.controls.rejectCas = true;
    const result = await duringKdf(h, () => {}); expect(result.error).toBeInstanceOf(ProblemError);
    expect(result.error).toMatchObject({ status: 409, code: 'pin_rotation_changed' }); expect(h.committed).toEqual([]);
    expect(h.state.users[0].pinHash).toBe(pinHash); expect(h.state.audits).toEqual([]);
  });
  it('wrong PIN commits the shared guessing budget before returning unauthorized', async () => {
    const h = fixture('replaceOwnPin'); h.state.users[0].pinResetRequired = true; h.initialRelease.release();
    cryptoWork.onStart = () => expect(h.controls.active).toBe(0);
    for (let n = 1; n <= 5; n++) {
      await expect(h.service.replaceOwnPin(h.identity, '111111', newPin)).rejects.toMatchObject({ status: 401, code: 'invalid_current_pin' });
      expect(h.state.users[0].pinLoginAttempts).toBe(n);
    }
    expect(h.state.users[0].pinLockedUntil.getTime()).toBe(Date.now() + 15 * 60_000);
    expect(h.state.users[0].pinHash).toBe(pinHash); expect(h.state.audits).toEqual([]); expect(h.state.sessions[0].revokedAt).toBeNull();
    expect(h.committed.filter(x => x.table === 'user')).toHaveLength(5);
  });
});
