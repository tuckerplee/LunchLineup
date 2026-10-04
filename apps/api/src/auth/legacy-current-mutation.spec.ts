import { performance } from 'node:perf_hooks';
import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MfaSessionObserver, MfaVerificationObservation } from '@lunchlineup/rbac';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import type { CurrentMutationOptions } from './current-mutation';

const ids = { userId: 'zzz-actor', tenantId: 'zzz-home', sessionId: 'exact-session' };
const targetId = 'aaa-target', foreignTenant = 'aaa-foreign';
const epoch = Date.parse('2026-10-04T08:00:00Z');
type Scope = 'tenant' | 'platform' | 'unprivileged';
type Row = Record<string, any>;
type State = { tenants: Row[]; users: Row[]; sessions: Row[]; roles: Row[];
    assignments: Row[]; settings: Row[]; audits: Row[] };
type Effect = { ordinal: number; method: string; args: Row };
type Lock = { ordinal: number; final: boolean; table: string; values: unknown[]; text: string };
type Boundary = 'final-grants' | 'user-effect' | 'audit-effect' | 'callback-read' | 'observer';
const clone = <T>(value: T): T => structuredClone(value);
const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const flatten = (values: unknown[]): unknown[] => values.flatMap(value => value && typeof value === 'object' && 'values' in value
    ? flatten((value as { values: unknown[] }).values) : [value]);
const sqlParts = (sql: any, args: unknown[]) => ({
    text: (Array.isArray(sql) ? sql : sql.strings).join(' ').replace(/\s+/g, ' ').trim(),
    values: flatten(Array.isArray(sql) ? args : sql.values),
});
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'role') return true; // Relation conditions are applied against the actual role below.
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('in' in value) return (value as { in: unknown[] }).in.includes(row[key]);
            throw new Error(`Unsupported fixture predicate ${key}`);
        }
        return row[key] === value;
    });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(epoch);
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'synthetic-current-mutation-capability');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Actual TenantPrisma, RbacService, policy module and retry loop. This explicit
// model filters selectors and stages effects until successful callback completion.
// It does not simulate PostgreSQL lock blocking, isolation/RLS or Redis atomicity.
// The domain callback is synthetic: these cases do not qualify all route owners.
function harness(scope: Scope = 'tenant') {
    const permission = scope === 'platform' ? 'admin_portal:access'
        : scope === 'unprivileged' ? 'locations:write' : 'users:admin';
    const targetTenant = scope === 'platform' ? foreignTenant : ids.tenantId;
    const user = (id: string, tenantId: string, role: string): Row => ({ id, tenantId, role,
        username: id, name: id, email: null, deletedAt: null, suspendedAt: null,
        lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: false });
    const role = (id: string, tenantId: string, legacyRole: string, keys: string[]): Row => ({
        id, tenantId, legacyRole, name: id, isSystem: false, deletedAt: null,
        rolePermissions: keys.map((key, i) => ({ roleId: id, permissionId: `${id}-${i}`, permission: { key } })),
    });
    let state: State = {
        tenants: [...new Set([ids.tenantId, targetTenant])].map(id => ({ id, status: 'ACTIVE', deletedAt: null })),
        users: [user(ids.userId, ids.tenantId, 'ADMIN'), user(targetId, targetTenant, 'STAFF')],
        sessions: [{ id: ids.sessionId, userId: ids.userId, createdAt: new Date(epoch - 20 * 60_000),
            expiresAt: new Date(epoch + 60 * 60_000), revokedAt: null }],
        roles: [role('zzz-role', ids.tenantId, 'ADMIN', [permission, 'users:read']),
            role('aaa-role', targetTenant, 'STAFF', ['users:read'])],
        assignments: [{ tenantId: ids.tenantId, userId: ids.userId, roleId: 'zzz-role' },
            { tenantId: targetTenant, userId: targetId, roleId: 'aaa-role' }],
        settings: [{ tenantId: ids.tenantId, key: 'workspace_settings',
            value: { security: { sessionTimeoutMinutes: 480, requireMfaForAll: false } } }],
        audits: [],
    };
    let active = 0, ordinal = 0, finalPasses = 0, gateUsed = false;
    let preflightConflicts = 0, finalConflicts = 0;
    let selectedBoundary: Boundary | undefined, afterObserve: (() => void) | undefined;
    let afterConflict: (() => void) | undefined;
    let afterPreflight: (() => void) | undefined;
    let observationMode = 'valid', markerTtl = 10 * 60_000;
    let auditFailure: Error | undefined;
    let lastObservation: MfaVerificationObservation | null = null;
    const entered = gate(), release = gate();
    const locks: Lock[] = [], attempted: Effect[] = [], committed: Effect[] = [];
    const contexts: Array<{ ordinal: number; platform: boolean }> = [];
    const txContexts = new WeakMap<object, { ordinal: number; final: boolean }>();
    const pause = async (boundary: Boundary) => {
        if (selectedBoundary === boundary && !gateUsed) {
            gateUsed = true; entered.release(); await release.promise;
        }
    };
    const database: any = { $transaction: async (operation: (tx: any) => Promise<unknown>, options: Row) => {
        expect(options).toEqual({ isolationLevel: 'Serializable' });
        expect(active).toBe(0); active++;
        const context = { ordinal: ++ordinal, final: false };
        let draft: State | undefined;
        const view = () => draft ?? state;
        const staged: Effect[] = [];
        const rows = (table: keyof State, where: Row) => view()[table].filter(row => matches(row, where));
        const readUser = async ({ where, select }: Row) => {
            if (where.id === ids.userId) expect(where).toEqual({ id: ids.userId, tenantId: ids.tenantId,
                deletedAt: null, suspendedAt: null });
            else expect(where).toEqual({ id: targetId, tenantId: targetTenant });
            const found = rows('users', where)[0] ?? null;
            if (context.final && where.id === targetId && !select) await pause('callback-read');
            return clone(found);
        };
        const effect = async (method: string, args: Row, apply: (next: State) => Row, boundary: Boundary) => {
            const entry = { ordinal: context.ordinal, method, args: clone(args) };
            attempted.push(entry); staged.push(entry); draft ??= clone(state);
            const result = apply(draft);
            await pause(boundary); // Staged effect exists before the owner's await resolves.
            return clone(result);
        };
        const tx: any = {
            $executeRaw: async (sql: any, ...args: unknown[]) => {
                const parts = sqlParts(sql, args);
                if (parts.text.includes('set_current_platform_admin')) {
                    expect(parts.values).toEqual(['synthetic-current-mutation-capability']);
                    contexts.push({ ordinal: context.ordinal, platform: true });
                } else {
                    expect(parts.text).toContain('set_current_tenant');
                    expect(parts.values).toEqual([ids.tenantId]);
                    contexts.push({ ordinal: context.ordinal, platform: false });
                }
                return 1;
            },
            $queryRaw: async (sql: any, ...args: unknown[]) => {
                const { text, values } = sqlParts(sql, args);
                const table = /FROM "(Tenant|User|Session|RoleAssignment|RolePermission|Role)"/.exec(text)?.[1];
                if (!table) throw new Error(`Unsupported raw statement: ${text}`);
                expect(text).toContain('FOR UPDATE');
                locks.push({ ordinal: context.ordinal, final: context.final, table, values: clone(values), text });
                if (table === 'Tenant') {
                    expect(text).toContain('ORDER BY "id"');
                    expect(values).toEqual([...new Set(values)].sort());
                    expect(values.every(id => id === ids.tenantId || id === targetTenant)).toBe(true);
                    return clone(view().tenants.filter(row => values.includes(row.id)));
                }
                if (table === 'User') {
                    const tenantScoped = text.includes('"tenantId" =');
                    if (tenantScoped) expect(values[0]).toBe(ids.tenantId);
                    const userIds = tenantScoped ? values.slice(1) : values;
                    expect(userIds).toEqual([...new Set(userIds)].sort());
                    expect(userIds.every(id => id === ids.userId || id === targetId)).toBe(true);
                    expect(text).toContain('ORDER BY "id"');
                    return clone(view().users.filter(row => userIds.includes(row.id)
                        && (!tenantScoped || row.tenantId === values[0])
                        && (!text.includes('"deletedAt" IS NULL') || row.deletedAt === null)));
                }
                if (table === 'Session') {
                    expect(values).toEqual([ids.sessionId, ids.userId]);
                    expect(text).toContain('"userId" =');
                    return clone(view().sessions.filter(row => row.id === values[0] && row.userId === values[1]));
                }
                if (table === 'RoleAssignment') {
                    const tenantScoped = text.includes('"tenantId" =');
                    const userIds = tenantScoped ? values.slice(1) : values;
                    if (tenantScoped) expect(values[0]).toBe(ids.tenantId);
                    expect(userIds).toEqual([...new Set(userIds)].sort());
                    expect(text).toContain('ORDER BY');
                    return clone(view().assignments.filter(row => userIds.includes(row.userId)
                        && (!tenantScoped || row.tenantId === values[0]))
                        .sort((a, b) => (tenantScoped ? '' : a.tenantId.localeCompare(b.tenantId))
                            || a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId)));
                }
                if (table === 'Role') {
                    const tenantScoped = text.includes('"tenantId" =');
                    if (tenantScoped) expect(values[0]).toBe(ids.tenantId);
                    const roleIds = tenantScoped ? values.slice(1) : values;
                    expect(roleIds).toEqual([...new Set(roleIds)].sort());
                    return clone(view().roles.filter(row => roleIds.includes(row.id)
                        && (!tenantScoped || row.tenantId === values[0])));
                }
                expect(values).toEqual([...new Set(values)].sort());
                expect(text).toContain('ORDER BY "roleId", "permissionId"');
                if (context.final) await pause('final-grants');
                return clone(view().roles.filter(row => values.includes(row.id)).flatMap(row => row.rolePermissions));
            },
            tenant: { findUnique: async ({ where }: Row) => {
                expect(where).toEqual({ id: ids.tenantId });
                return clone(rows('tenants', where)[0] ?? null);
            } },
            user: {
                findFirst: readUser,
                findMany: async ({ where }: Row) => {
                    expect(where).toEqual({ tenantId: ids.tenantId, id: { in: [ids.userId, targetId] }, deletedAt: null });
                    return clone(rows('users', where));
                },
                findUnique: async ({ where, select }: Row) => {
                    expect(where).toEqual({ id: targetId }); expect(select).toEqual({ tenantId: true });
                    return clone(rows('users', where)[0] ?? null);
                },
                update: async (args: Row) => effect('user.update', args, next => {
                    expect(args.where).toEqual({ id: targetId });
                    const target = next.users.find(row => row.id === targetId);
                    if (!target) throw new Error('Missing synthetic target');
                    Object.assign(target, args.data); return target;
                }, 'user-effect'),
            },
            session: { findFirst: async ({ where }: Row) => {
                expect(where).toEqual({ id: ids.sessionId, userId: ids.userId });
                return clone(rows('sessions', where)[0] ?? null);
            } },
            tenantSetting: { findUnique: async ({ where }: Row) => {
                expect(where).toEqual({ tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } });
                return clone(rows('settings', where.tenantId_key)[0] ?? null);
            } },
            roleAssignment: { findMany: async ({ where, include }: Row) => {
                expect(where.tenantId).toBe(ids.tenantId);
                if (typeof where.userId === 'object') {
                    expect(context.final && scope === 'tenant').toBe(true);
                    expect(where.userId).toEqual({ in: [ids.userId, targetId] });
                } else expect(where.userId).toBe(ids.userId);
                if (include) expect(where.role).toEqual({ tenantId: ids.tenantId, deletedAt: null });
                else expect(where.role).toBeUndefined();
                const assignments = rows('assignments', where);
                if (!include) return clone(assignments.sort((a, b) => a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId)));
                return clone(assignments.flatMap(assignment => {
                    const role = view().roles.find(row => row.id === assignment.roleId);
                    if (!role || !matches(role, where.role ?? {})) return [];
                    return [{ ...assignment, role }];
                }));
            } },
            role: { findMany: async ({ where }: Row) => {
                const requested = view().assignments.filter(row => row.userId === ids.userId || row.userId === targetId)
                    .sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId))
                    .map(row => row.roleId);
                expect(where).toEqual({ id: { in: requested }, deletedAt: null });
                return clone(rows('roles', where).sort((a, b) => a.id.localeCompare(b.id)));
            } },
            auditLog: { create: async (args: Row) => effect('auditLog.create', args, next => {
                expect(args.data).toMatchObject({ tenantId: ids.tenantId, userId: ids.userId, action: 'synthetic.authorized' });
                if (auditFailure) throw auditFailure;
                const row = { id: `audit-${context.ordinal}`, ...args.data }; next.audits.push(row); return row;
            }, 'audit-effect') },
        };
        txContexts.set(tx, context);
        let retryError: Error | undefined;
        let completed = false;
        try {
            const result = await operation(tx);
            if (context.final ? finalConflicts > 0 : preflightConflicts > 0) {
                if (context.final) finalConflicts--; else preflightConflicts--;
                retryError = Object.assign(new Error('Synthetic serialization conflict'), { code: 'P2034' });
                throw retryError;
            }
            if (draft) state = draft;
            committed.push(...staged);
            completed = true;
            return result;
        } finally {
            active--;
            if (retryError) afterConflict?.(); // External committed change after discarded callback, never under a held model lock.
            if (completed && !context.final) afterPreflight?.();
        }
    } };
    const rbac = new RbacService(new TenantPrismaService(database));
    const observer: MfaSessionObserver = { observeSessionMfa: vi.fn(async identity => {
        expect(active).toBe(0);
        expect(identity).toEqual({ sub: ids.userId, tenantId: ids.tenantId, sessionId: ids.sessionId });
        expect(Object.isFrozen(identity)).toBe(true);
        await pause('observer');
        if (observationMode === 'error') throw new Error('synthetic-provider-secret');
        lastObservation = observationMode === 'missing' ? null : {
            ...identity, expiresAtEpochMs: Date.now() + markerTtl,
            expiresAtMonotonicMs: performance.now() + markerTtl,
        };
        if (lastObservation) {
            if (observationMode === 'wrong-user') lastObservation.sub = targetId;
            if (observationMode === 'wrong-tenant') lastObservation.tenantId = foreignTenant;
            if (observationMode === 'wrong-session') lastObservation.sessionId = 'another-session';
            if (observationMode === 'expired-wall') lastObservation.expiresAtEpochMs = Date.now();
            if (observationMode === 'expired-monotonic') lastObservation.expiresAtMonotonicMs = performance.now() - 1;
            if (observationMode === 'invalid-wall') lastObservation.expiresAtEpochMs = NaN;
            if (observationMode === 'invalid-monotonic') lastObservation.expiresAtMonotonicMs = Infinity;
        }
        afterObserve?.();
        return lastObservation;
    }) };
    const options: CurrentMutationOptions = { actor: { ...ids }, requiredPermission: permission,
        scope: scope === 'platform' ? 'platform' : 'tenant', mfaObserver: observer };
    const run = (readOnly = false, withoutExpectedTargetTenant = false) => rbac.runCurrentMutation(options,
        async (tx, actor) => {
            expect(Object.isFrozen(actor)).toBe(true); expect(actor).toEqual(ids);
            const context = txContexts.get(tx)!; context.final = true; finalPasses++;
            if (scope === 'platform') return rbac.authorizePlatformAdminUserMutationInTransaction(tx,
                targetId, actor, withoutExpectedTargetTenant ? undefined : targetTenant);
            if (scope === 'tenant') return rbac.authorizeUserAdministrationInTransaction(tx, actor.tenantId, {
                actorUserId: actor.userId, actorSessionId: actor.sessionId, targetUserId: targetId,
                requiredPermission: 'users:admin', selfMutationMessage: 'Synthetic self mutation refused',
            });
            await rbac.authorizeActorMutationInTransaction(tx, actor, permission, [targetId]);
            return tx.user.findFirst({ where: { id: targetId, tenantId: actor.tenantId } });
        }, async (tx, authority, assertCurrent, actor) => {
            expect(authority?.id).toBe(targetId); expect(actor).toEqual(ids);
            if (!readOnly) {
                assertCurrent();
                await tx.user.update({ where: { id: targetId }, data: { name: 'authorized-change' } });
                assertCurrent();
                await tx.auditLog.create({ data: { tenantId: actor.tenantId, userId: actor.userId,
                    action: 'synthetic.authorized', resource: 'User', resourceId: targetId } });
            }
            // Deliberately no local assertion: the actual wrapper must check callback completion.
            return tx.user.findFirst({ where: { id: targetId, tenantId: targetTenant } });
        });
    return { get state() { return state; }, get active() { return active; }, get ordinal() { return ordinal; },
        get finalPasses() { return finalPasses; }, get lastObservation() { return lastObservation; },
        options, observer, run, attempted, committed, locks, contexts, entered, release,
        pauseAt(boundary: Boundary) { selectedBoundary = boundary; },
        observeAs(mode: string) { observationMode = mode; }, markerLifetime(ms: number) { markerTtl = ms; },
        onObserve(callback: () => void) { afterObserve = callback; },
        onPreflightRelease(callback: () => void) { afterPreflight = callback; },
        failAudit(error: Error) { auditFailure = error; },
        conflicts(preflight: number, final: number, callback?: () => void) {
            preflightConflicts = preflight; finalConflicts = final; afterConflict = callback;
        },
    };
}

type Harness = ReturnType<typeof harness>;
const actorRow = (h: Harness) => h.state.users.find(row => row.id === ids.userId)!;
const actorRole = (h: Harness) => h.state.roles.find(row => row.id === 'zzz-role')!;
const policy = (h: Harness) => h.state.settings[0].value.security;
function assertNoEffects(h: Harness, initial: State) {
    expect(h.attempted).toEqual([]); expect(h.committed).toEqual([]);
    expect(h.state).toEqual(initial); expect(h.active).toBe(0);
}
function assertLockOrder(h: Harness) {
    const rank: Record<string, number> = { Tenant: 0, User: 1, Session: 2, RoleAssignment: 3, Role: 4, RolePermission: 5 };
    for (let ordinal = 1; ordinal <= h.ordinal; ordinal++) {
        const held = h.locks.filter(lock => lock.ordinal === ordinal);
        expect(held.map(lock => rank[lock.table])).toEqual(held.map(lock => rank[lock.table]).sort((a, b) => a - b));
        for (const table of ['Tenant', 'User', 'Session', 'RoleAssignment', 'RolePermission']) {
            expect(held.filter(lock => lock.table === table)).toHaveLength(1);
        }
    }
}

describe('actual legacy current mutation authority with explicit staged transactions', () => {
    for (const scope of ['tenant', 'platform', 'unprivileged'] as const) {
        it(`${scope}: admits current authority, preserves scoped sorted locks and staged writes`, async () => {
            const h = harness(scope);
            const result = await h.run();
            expect(result?.name).toBe('authorized-change');
            expect(h.ordinal).toBe(2); expect(h.finalPasses).toBe(1); expect(h.active).toBe(0);
            expect(h.attempted.map(effect => effect.method)).toEqual(['user.update', 'auditLog.create']);
            expect(h.committed).toEqual(h.attempted); expect(h.state.audits).toHaveLength(1);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(scope === 'unprivileged' ? 0 : 1);
            expect(h.contexts).toEqual([{ ordinal: 1, platform: scope === 'platform' }, { ordinal: 2, platform: scope === 'platform' }]);
            assertLockOrder(h);
            const finalTenant = h.locks.find(lock => lock.final && lock.table === 'Tenant')!;
            expect(finalTenant.values).toEqual(scope === 'platform' ? [foreignTenant, ids.tenantId] : [ids.tenantId]);
            const finalUsers = h.locks.find(lock => lock.final && lock.table === 'User')!;
            expect(finalUsers.values).toEqual(scope === 'platform' ? [targetId, ids.userId] : [ids.tenantId, targetId, ids.userId]);
            expect(h.locks.find(lock => lock.final && lock.table === 'RolePermission')?.values)
                .toEqual(scope === 'unprivileged' ? ['zzz-role'] : ['aaa-role', 'zzz-role']);
        });
    }
    it('platform target locator without expected tenant still takes sorted Tenant UPDATE before combined Users', async () => {
        const h = harness('platform'); await h.run(false, true); assertLockOrder(h);
        expect(h.locks.find(lock => lock.final && lock.table === 'Tenant')?.values).toEqual([foreignTenant, ids.tenantId]);
    });

    const stale: Array<[string, (h: Harness) => void]> = [
        ['missing tenant', h => { h.state.tenants = []; }],
        ['deleted tenant', h => { h.state.tenants[0].deletedAt = new Date(); }],
        ['suspended tenant', h => { h.state.tenants[0].status = 'SUSPENDED'; }],
        ['purged tenant', h => { h.state.tenants[0].status = 'PURGED'; }],
        ['deleted actor', h => { actorRow(h).deletedAt = new Date(); }],
        ['missing actor', h => { h.state.users = h.state.users.filter(row => row.id !== ids.userId); }],
        ['suspended actor', h => { actorRow(h).suspendedAt = new Date(); }],
        ['actor tenant mismatch', h => { actorRow(h).tenantId = foreignTenant; }],
        ['account lock', h => { actorRow(h).lockedUntil = new Date(epoch + 60_000); }],
        ['PIN lock', h => { actorRow(h).pinLockedUntil = new Date(epoch + 60_000); }],
        ['forced PIN reset', h => { actorRow(h).pinResetRequired = true; }],
        ['missing exact session', h => { h.state.sessions = []; }],
        ['other session ID', h => { h.state.sessions[0].id = 'other-session'; }],
        ['other session owner', h => { h.state.sessions[0].userId = targetId; }],
        ['revoked exact session', h => { h.state.sessions[0].revokedAt = new Date(); }],
        ['stored expiry', h => { h.state.sessions[0].expiresAt = new Date(epoch); }],
        ['invalid createdAt', h => { h.state.sessions[0].createdAt = new Date(NaN); }],
        ['policy shortened expiry', h => { policy(h).sessionTimeoutMinutes = 5; }],
        ['removed permission', h => { actorRole(h).rolePermissions = []; }],
        ['missing assignment', h => { h.state.assignments = h.state.assignments.filter(row => row.userId !== ids.userId); }],
        ['foreign assignment tenant', h => { h.state.assignments.find(row => row.userId === ids.userId)!.tenantId = foreignTenant; }],
        ['deleted role', h => { actorRole(h).deletedAt = new Date(); }],
        ['foreign role tenant', h => { actorRole(h).tenantId = foreignTenant; }],
    ];
    for (const scope of ['tenant', 'platform'] as const) {
        for (const [label, mutate] of stale) {
            it(`${scope}: denies ${label} before effects using actual current rows`, async () => {
                const h = harness(scope); mutate(h); const initial = clone(h.state);
                await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException);
                assertNoEffects(h, initial); expect(h.observer.observeSessionMfa).not.toHaveBeenCalled();
            });
        }
        for (const status of ['PAST_DUE', 'CANCELLED']) {
            it(`${scope}: preserves eligible ${status} workspace behavior`, async () => {
                const h = harness(scope); h.state.tenants.find(row => row.id === ids.tenantId)!.status = status;
                await h.run(); expect(h.committed).toHaveLength(2);
            });
        }
        for (const [label, mutate] of stale) {
            it(`${scope}: revalidates ${label} after outside-DB MFA observation`, async () => {
                const h = harness(scope); h.pauseAt('observer'); let changed!: State;
                const outcome = h.run().then(value => ({ value }), error => ({ error }));
                try {
                    expect(await Promise.race([h.entered.promise.then(() => 'entered'), outcome.then(() => 'settled')])).toBe('entered');
                    expect(h.active).toBe(0); expect(h.ordinal).toBe(1); expect(h.attempted).toEqual([]);
                    mutate(h); changed = clone(h.state);
                } finally { h.release.release(); await outcome; }
                const result = await outcome;
                expect('error' in result ? result.error : undefined).toBeInstanceOf(ForbiddenException);
                assertNoEffects(h, changed); expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
                expect(h.ordinal).toBe(2); expect(h.finalPasses).toBe(1);
            });
        }
    }

    for (const mode of ['missing', 'wrong-user', 'wrong-tenant', 'wrong-session', 'expired-wall', 'expired-monotonic', 'invalid-wall', 'invalid-monotonic']) {
        it(`rejects ${mode} exact-session observation without a final DB transaction`, async () => {
            const h = harness(); const initial = clone(h.state); h.observeAs(mode);
            await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException);
            assertNoEffects(h, initial); expect(h.ordinal).toBe(1);
        });
    }
    for (const capability of ['absent', 'error']) {
        it(`fails closed for ${capability} observer with bounded service error`, async () => {
            const h = harness(); const initial = clone(h.state);
            if (capability === 'absent') h.options.mfaObserver = undefined; else h.observeAs('error');
            const result = await h.run().catch(error => error);
            expect(result).toBeInstanceOf(ServiceUnavailableException);
            expect(result.message).toBe('MFA verification service is unavailable');
            expect(result.message).not.toContain('synthetic-provider-secret'); assertNoEffects(h, initial);
        });
    }
    for (const reason of ['enrolled actor', 'workspace policy']) {
        it(`requires MFA for nonprivileged grant when ${reason} is current`, async () => {
            const h = harness('unprivileged');
            if (reason === 'enrolled actor') actorRow(h).mfaEnabled = true; else policy(h).requireMfaForAll = true;
            await h.run(); expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        });
    }
    for (const timeout of [undefined, 4, 1441, 5.5, '5', NaN]) {
        it(`normalizes invalid timeout ${String(timeout)} to the existing 480 minute default`, async () => {
            const h = harness(); policy(h).sessionTimeoutMinutes = timeout;
            await h.run(); expect(h.committed).toHaveLength(2);
        });
    }
    for (const reason of ['enrolled actor', 'workspace policy', 'extra privileged grant']) {
        it(`does not accept an unobserved newly required MFA condition: ${reason}`, async () => {
            const h = harness('unprivileged'); let changed!: State;
            // Committed current rows change only after preflight releases its
            // model locks and before the full final authorizer takes any lock.
            h.onPreflightRelease(() => {
                expect(h.active).toBe(0);
                if (reason === 'enrolled actor') actorRow(h).mfaEnabled = true;
                if (reason === 'workspace policy') policy(h).requireMfaForAll = true;
                if (reason === 'extra privileged grant') actorRole(h).rolePermissions.push({ permission: { key: 'users:admin' } });
                changed = clone(h.state);
            });
            await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException);
            assertNoEffects(h, changed); expect(h.ordinal).toBe(2);
            expect(h.observer.observeSessionMfa).not.toHaveBeenCalled();
        });
    }

    it('freezes canonical actor and selected permission/scope/observer before external waits', async () => {
        const h = harness('platform');
        h.options.actor = { userId: ` ${ids.userId} `, tenantId: ` ${ids.tenantId} `, sessionId: ` ${ids.sessionId} ` };
        h.options.requiredPermission = ' ADMIN_PORTAL:ACCESS ';
        h.onObserve(() => {
            (h.options.actor as any).userId = targetId;
            h.options.scope = 'tenant'; h.options.requiredPermission = 'missing:permission';
            h.options.mfaObserver = { observeSessionMfa: async () => { throw new Error('replacement must not run'); } };
        });
        await h.run(); expect(h.contexts.every(context => context.platform)).toBe(true);
        expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1); expect(h.committed).toHaveLength(2);
    });
    for (const field of ['userId', 'tenantId', 'sessionId'] as const) {
        it(`rejects empty canonical ${field} before DB/observer`, async () => {
            const h = harness(); h.options.actor = { ...ids, [field]: '  ' };
            await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.ordinal).toBe(0); expect(h.observer.observeSessionMfa).not.toHaveBeenCalled();
        });
    }
    it('preserves tenant target hierarchy instead of replacing full authorization with actor-only permission', async () => {
        const h = harness(); h.state.users.find(row => row.id === targetId)!.role = 'ADMIN';
        h.state.roles.find(row => row.id === 'aaa-role')!.legacyRole = 'ADMIN';
        const initial = clone(h.state);
        await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException); assertNoEffects(h, initial);
        expect(h.finalPasses).toBe(1);
    });
    it('preserves platform system-target restriction', async () => {
        const h = harness('platform'); h.state.users.find(row => row.id === targetId)!.role = 'SUPER_ADMIN';
        Object.assign(h.state.roles.find(row => row.id === 'aaa-role')!, { legacyRole: 'SUPER_ADMIN', isSystem: true });
        const initial = clone(h.state);
        await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException); assertNoEffects(h, initial);
    });
    it('preserves target-not-found contract after valid preflight', async () => {
        const h = harness(); h.state.users = h.state.users.filter(row => row.id !== targetId);
        const initial = clone(h.state); await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
        assertNoEffects(h, initial); expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    });

    const lifetimes = ['stored', 'effective', 'marker-wall', 'marker-monotonic'] as const;
    function arrangeLifetime(h: Harness, lifetime: typeof lifetimes[number]) {
        let jump = 1000, mono = performance.now();
        if (lifetime === 'stored') h.state.sessions[0].expiresAt = new Date(epoch + 1000);
        if (lifetime === 'effective') {
            h.state.sessions[0].createdAt = new Date(epoch - 29 * 60_000);
            policy(h).sessionTimeoutMinutes = 30; jump = 60_000;
        }
        if (lifetime.startsWith('marker')) h.markerLifetime(1000);
        if (lifetime === 'marker-monotonic') vi.spyOn(performance, 'now').mockImplementation(() => mono);
        return () => {
            if (lifetime === 'marker-monotonic') mono += jump;
            else vi.setSystemTime(epoch + jump);
        };
    }
    for (const scope of ['tenant', 'platform'] as const) {
        for (const boundary of ['final-grants', 'user-effect', 'audit-effect', 'callback-read', 'observer'] as const) {
            it(`${scope}: viable ${boundary} gate drains and commits when all deadlines remain current`, async () => {
                const h = harness(scope); h.pauseAt(boundary);
                const outcome = h.run().then(value => ({ value }), error => ({ error }));
                try {
                    expect(await Promise.race([h.entered.promise.then(() => 'entered'), outcome.then(() => 'settled')])).toBe('entered');
                    expect(h.active).toBe(boundary === 'observer' ? 0 : 1);
                } finally { h.release.release(); await outcome; }
                const result = await outcome;
                expect('error' in result).toBe(false); expect(h.committed).toHaveLength(2);
                expect(h.state.users.find(row => row.id === targetId)?.name).toBe('authorized-change');
                expect(h.state.audits).toHaveLength(1); expect(h.active).toBe(0);
            });
        }
        it(`${scope}: current readonly callback returns without synthetic writes`, async () => {
            const h = harness(scope); const initial = clone(h.state);
            expect((await h.run(true))?.id).toBe(targetId); assertNoEffects(h, initial);
            expect(h.ordinal).toBe(2); expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        });
        for (const boundary of ['final-grants', 'user-effect', 'audit-effect', 'callback-read'] as const) {
            for (const lifetime of lifetimes) {
                it(`${scope}: expires ${lifetime} during ${boundary}, retaining exact attempted prefix and rolling back`, async () => {
                    const h = harness(scope); const expire = arrangeLifetime(h, lifetime);
                    h.pauseAt(boundary); const initial = clone(h.state);
                    const outcome = h.run().then(value => ({ value }), error => ({ error }));
                    try {
                        expect(await Promise.race([h.entered.promise.then(() => 'entered'), outcome.then(() => 'settled')])).toBe('entered');
                        expect(h.active).toBe(1);
                        expect(h.locks.filter(lock => lock.table === 'RolePermission' && lock.final)).toHaveLength(1);
                        expire();
                    } finally { h.release.release(); await outcome; }
                    const result = await outcome;
                    expect('error' in result ? result.error : undefined).toBeInstanceOf(ForbiddenException);
                    const prefix = boundary === 'final-grants' ? [] : boundary === 'user-effect'
                        ? ['user.update'] : ['user.update', 'auditLog.create'];
                    expect(h.attempted.map(effect => effect.method)).toEqual(prefix);
                    expect(h.attempted.every(effect => effect.ordinal === 2)).toBe(true);
                    expect(h.committed).toEqual([]); expect(h.state).toEqual(initial); expect(h.active).toBe(0);
                    expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
                });
            }
        }
        for (const lifetime of lifetimes) {
            it(`${scope}: readonly callback is checked after its final awaited read (${lifetime})`, async () => {
                const h = harness(scope); const expire = arrangeLifetime(h, lifetime);
                h.pauseAt('callback-read'); const initial = clone(h.state);
                const outcome = h.run(true).then(value => ({ value }), error => ({ error }));
                try {
                    expect(await Promise.race([h.entered.promise.then(() => 'entered'), outcome.then(() => 'settled')])).toBe('entered');
                    expire();
                } finally { h.release.release(); await outcome; }
                const result = await outcome;
                expect('error' in result ? result.error : undefined).toBeInstanceOf(ForbiddenException);
                assertNoEffects(h, initial);
            });
        }
    }

    it('successful final serialization retry re-locks and commits once with one finite observation', async () => {
        const h = harness(); h.conflicts(0, 1);
        await h.run(); expect(h.ordinal).toBe(3); expect(h.finalPasses).toBe(2);
        expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        expect(h.attempted.map(effect => effect.ordinal)).toEqual([2, 2, 3, 3]);
        expect(h.committed.map(effect => effect.ordinal)).toEqual([3, 3]);
        expect(h.state.audits).toHaveLength(1); assertLockOrder(h);
    });
    it('preflight serialization retry completes before the sole outside-DB observation', async () => {
        const h = harness(); h.conflicts(1, 0);
        await h.run(); expect(h.ordinal).toBe(3); expect(h.finalPasses).toBe(1);
        expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        expect(h.attempted.map(effect => effect.ordinal)).toEqual([3, 3]); assertLockOrder(h);
    });
    it('bounded final retry exhaustion rolls back both attempted ledgers with controlled conflict', async () => {
        const h = harness(); h.conflicts(0, 2); h.options.conflictMessage = 'Synthetic retry limit';
        const initial = clone(h.state);
        await expect(h.run()).rejects.toMatchObject({ message: 'Synthetic retry limit' });
        expect(h.ordinal).toBe(3); expect(h.finalPasses).toBe(2); expect(h.attempted).toHaveLength(4);
        expect(h.committed).toEqual([]); expect(h.state).toEqual(initial);
        expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    });
    it('non-serialization domain failure rolls back the staged user update without retrying', async () => {
        const h = harness(); const initial = clone(h.state);
        const failure = new Error('Synthetic audit constraint'); h.failAudit(failure);
        await expect(h.run()).rejects.toBe(failure);
        expect(h.ordinal).toBe(2); expect(h.finalPasses).toBe(1);
        expect(h.attempted.map(effect => effect.method)).toEqual(['user.update', 'auditLog.create']);
        expect(h.committed).toEqual([]); expect(h.state).toEqual(initial); expect(h.active).toBe(0);
    });
    it('captures retry classifier and conflict message before observer mutation', async () => {
        const h = harness(); h.conflicts(0, 2); h.options.conflictMessage = 'Selected retry limit';
        h.onObserve(() => {
            h.options.conflictMessage = 'Late replacement';
            h.options.isConflict = () => { throw new Error('Late classifier must not run'); };
        });
        await expect(h.run()).rejects.toMatchObject({ message: 'Selected retry limit' });
        expect(h.ordinal).toBe(3); expect(h.committed).toEqual([]);
    });
    for (const reason of ['session revocation', 'current grant removal', 'PIN reset', 'shortened policy', 'marker deadline']) {
        it(`final retry re-reads ${reason} without renewing observation`, async () => {
            const h = harness(); let changed!: State;
            h.markerLifetime(1000);
            h.conflicts(0, 1, () => {
                expect(h.active).toBe(0);
                if (reason === 'session revocation') h.state.sessions[0].revokedAt = new Date();
                if (reason === 'current grant removal') actorRole(h).rolePermissions = [];
                if (reason === 'PIN reset') actorRow(h).pinResetRequired = true;
                if (reason === 'shortened policy') policy(h).sessionTimeoutMinutes = 5;
                if (reason === 'marker deadline') vi.setSystemTime(epoch + 1000);
                changed = clone(h.state);
            });
            await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.ordinal).toBe(3); expect(h.finalPasses).toBe(2);
            expect(h.attempted.map(effect => effect.ordinal)).toEqual([2, 2]);
            expect(h.committed).toEqual([]); expect(h.state).toEqual(changed);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        });
    }
    it('copies observation so post-observer caller mutation cannot extend the next retry', async () => {
        const h = harness(); h.markerLifetime(1000);
        h.conflicts(0, 1, () => {
            vi.setSystemTime(epoch + 1000);
            h.lastObservation!.expiresAtEpochMs = epoch + 60 * 60_000;
            h.lastObservation!.expiresAtMonotonicMs = performance.now() + 60 * 60_000;
        });
        await expect(h.run()).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1); expect(h.committed).toEqual([]);
    });
    it('preflight retry exhaustion never observes MFA or enters the full authorizer', async () => {
        const h = harness(); h.conflicts(2, 0);
        await expect(h.run()).rejects.toBeInstanceOf(ConflictException);
        expect(h.ordinal).toBe(2); expect(h.finalPasses).toBe(0);
        expect(h.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(h.attempted).toEqual([]);
    });
});
