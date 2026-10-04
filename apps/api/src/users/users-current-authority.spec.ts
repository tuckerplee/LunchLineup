import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { UsersController } from './users.controller';

// Actual UsersController -> RbacService -> TenantPrismaService callbacks.
// Explicit scoped local rows and staged effects model callback rollback only;
// they do not prove PostgreSQL locks/MVCC/RLS, Redis, HTTP ingress or native QA.
type Row = Record<string, any>;
const actor = { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' };
const targetId = 'staff-1';
const copy = <T>(value: T): T => structuredClone(value);
const effects = ['schedule.updateMany', 'staffAvailability.deleteMany', 'staffSkill.deleteMany',
    'staffSkill.createMany', 'staffAvailability.createMany'];
const profile = { skills: ['new-skill'], availability: [
    { locationId: null, dayOfWeek: 1, startTimeMinutes: 540, endTimeMinutes: 1020 },
] };
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'role' && value && typeof value === 'object' && !('in' in value)) return true;
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('in' in value) return value.in.includes(row[key]);
            throw new Error(`Unmodeled Users selector ${key}`);
        }
        return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
    });
}
function fixture() {
    const initialNow = Date.now();
    let now = initialNow;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const user = (id: string, tenantId: string, role: string): Row => ({ id, tenantId, role,
        name: id, email: `${id}@example.com`, username: id, pinHash: 'stored-hash', createdAt: new Date(initialNow - 1000),
        deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null,
        pinResetRequired: false, mfaEnabled: true });
    const role = (id: string, tenantId: string): Row => ({ id, tenantId, name: 'custom editor',
        isSystem: false, legacyRole: null, deletedAt: null,
        rolePermissions: [{ permission: { key: 'users:write' } }, { permission: { key: 'users:read' } }] });
    let state = {
        tenants: [{ id: actor.tenantId, status: 'ACTIVE', deletedAt: null },
            { id: 'foreign-tenant', status: 'ACTIVE', deletedAt: null }] as Row[],
        users: [user(actor.userId, actor.tenantId, 'ADMIN'), user(targetId, actor.tenantId, 'STAFF'),
            user('foreign-user', 'foreign-tenant', 'STAFF')] as Row[],
        sessions: [{ id: actor.sessionId, userId: actor.userId, revokedAt: null,
            createdAt: new Date(initialNow - 60_000), expiresAt: new Date(initialNow + 3_600_000) },
            { id: 'foreign-session', userId: 'foreign-user', revokedAt: null,
                createdAt: new Date(initialNow), expiresAt: new Date(initialNow + 3_600_000) }] as Row[],
        roles: [role('editor-role', actor.tenantId), role('foreign-role', 'foreign-tenant')] as Row[],
        assignments: [{ tenantId: actor.tenantId, userId: actor.userId, roleId: 'editor-role' },
            { tenantId: 'foreign-tenant', userId: 'foreign-user', roleId: 'foreign-role' }] as Row[],
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        skills: [{ tenantId: actor.tenantId, userId: targetId, skill: 'old-skill' },
            { tenantId: 'foreign-tenant', userId: 'foreign-user', skill: 'untouched' }] as Row[],
        availability: [{ tenantId: actor.tenantId, userId: targetId, locationId: null,
            dayOfWeek: 2, startTimeMinutes: 600, endTimeMinutes: 960 }] as Row[],
        schedules: [{ id: 'draft-1', tenantId: actor.tenantId, status: 'DRAFT', deletedAt: null, revision: 4 },
            { id: 'published-1', tenantId: actor.tenantId, status: 'PUBLISHED', deletedAt: null, revision: 7 },
            { id: 'foreign-draft', tenantId: 'foreign-tenant', status: 'DRAFT', deletedAt: null, revision: 9 }] as Row[],
    };
    type State = typeof state;
    let draft: State | undefined;
    let pending: string[] = [];
    const attempts: string[] = [];
    const committed: string[] = [];
    const rawReads: Array<{ sql: string; values: any[]; ordinal: number }> = [];
    const controls = { active: 0, transactions: 0, observerTtl: 120_000, finalRoleVisits: 0,
        observerHook: undefined as (() => void | Promise<void>) | undefined,
        finalRoleHook: undefined as (() => void) | undefined,
        effectHook: undefined as ((index: number) => void) | undefined,
        observationChange: undefined as ((observation: Row) => Row | null) | undefined };
    const view = () => draft ?? state;
    const flatten = (values: any[]): any[] => values.flatMap(value => value && typeof value === 'object' && 'values' in value
        ? flatten(value.values) : [value]);
    const queryParts = (query: any, values: any[]) => ({
        sql: Array.isArray(query) ? query.join('?') : query.strings?.join('?') ?? '',
        values: flatten(values.length ? values : query.values ?? []),
    });
    const effect = (name: string, mutate: (value: State) => unknown) => {
        if (!draft) draft = copy(state);
        attempts.push(name); pending.push(name);
        const result = mutate(draft);
        controls.effectHook?.(attempts.length);
        return copy(result);
    };
    const prisma: any = {
        $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>, options: any) => {
            expect(controls.active).toBe(0);
            if (options) expect(options.isolationLevel).toBe('Serializable');
            controls.active++; controls.transactions++; draft = undefined; pending = [];
            try {
                const result = await operation(prisma);
                if (draft) { state = draft; committed.push(...pending); }
                return result;
            } finally { draft = undefined; pending = []; controls.active--; }
        }),
        $executeRaw: vi.fn(async (query: any, ...values: any[]) => {
            const parts = queryParts(query, values);
            if (parts.sql.includes('set_current_tenant')) { expect(parts.values).toEqual([actor.tenantId]); return 1; }
            if (parts.sql.includes('pg_advisory_xact_lock')) {
                expect(parts.values).toEqual([`lunchlineup:scheduling:${actor.tenantId}`]); return 1;
            }
            throw new Error(`Unmodeled Users raw effect ${parts.sql}`);
        }),
        $queryRaw: vi.fn(async (query: any, ...values: any[]) => {
            const { sql, values: selected } = queryParts(query, values);
            rawReads.push({ sql, values: copy(selected), ordinal: controls.transactions });
            if (sql.includes('COUNT(*)')) {
                expect(selected).toEqual([actor.tenantId]);
                const rows = view().users.filter(row => row.tenantId === actor.tenantId && !row.deletedAt);
                return [{ totalUsers: rows.length, staffCount: rows.filter(row => row.role === 'STAFF').length,
                    managerCount: 0, privilegedUsers: rows.filter(row => row.role === 'ADMIN').length, pinAccounts: rows.length }];
            }
            if (sql.includes('FROM "Tenant"')) return copy(view().tenants.filter(row => selected.includes(row.id)));
            if (sql.includes('FROM "Session"')) {
                expect(selected).toEqual([actor.sessionId, actor.userId]);
                return copy(view().sessions.filter(row => row.id === selected[0] && row.userId === selected[1]));
            }
            if (sql.includes('FROM "User"')) {
                if (sql.includes('"role" IN')) {
                    const [id, tenantId] = selected;
                    return copy(view().users.filter(row => row.id === id && row.tenantId === tenantId
                        && ['MANAGER', 'STAFF'].includes(row.role) && !row.deletedAt && !row.suspendedAt));
                }
                const [tenantId, ...ids] = selected;
                return copy(view().users.filter(row => row.tenantId === tenantId && ids.includes(row.id) && !row.deletedAt));
            }
            if (sql.includes('FROM "RoleAssignment"')) {
                const [tenantId, ...ids] = selected;
                return copy(view().assignments.filter(row => row.tenantId === tenantId && ids.includes(row.userId)));
            }
            if (sql.includes('FROM "RolePermission"')) {
                if (controls.transactions === 2) { controls.finalRoleVisits++; controls.finalRoleHook?.(); }
                return copy(view().roles.filter(row => selected.includes(row.id)).flatMap(row => row.rolePermissions));
            }
            if (sql.includes('FROM "Role"')) {
                const [tenantId, id] = selected;
                return copy(view().roles.filter(row => row.id === id && row.tenantId === tenantId));
            }
            if (sql.includes('FROM "Schedule" schedule')) {
                expect(selected[0]).toBe(actor.tenantId);
                // Changed skills TRUE predicate affects every active tenant DRAFT;
                // timezone/availability-only SQL branches are outside this model.
                return copy(view().schedules.filter(row => row.tenantId === selected[0] && row.status === 'DRAFT' && !row.deletedAt));
            }
            throw new Error(`Unmodeled Users raw read ${sql}`);
        }),
        tenant: { findUnique: vi.fn(async ({ where }: any) => copy(view().tenants.find(row => row.id === where.id) ?? null)) },
        tenantSetting: { findUnique: vi.fn(async ({ where }: any) => {
            expect(where).toEqual({ tenantId_key: { tenantId: actor.tenantId, key: 'workspace_settings' } });
            return { value: { security: copy(view().security) } };
        }) },
        user: {
            findFirst: vi.fn(async ({ where }: any) => copy(view().users.find(row => matches(row, where)) ?? null)),
            findMany: vi.fn(async ({ where, take }: any) => copy(view().users.filter(row => matches(row, where))
                .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take))),
        },
        session: { findFirst: vi.fn(async ({ where }: any) => {
            expect(where).toEqual({ id: actor.sessionId, userId: actor.userId });
            return copy(view().sessions.find(row => matches(row, where)) ?? null);
        }) },
        roleAssignment: { findMany: vi.fn(async ({ where }: any) => view().assignments.filter(row => matches(row, where)).flatMap(row => {
            const role = view().roles.find(role => role.id === row.roleId && role.tenantId === row.tenantId
                && (!where.role || matches(role, where.role)));
            return role ? [copy({ ...row, role })] : [];
        })) },
        schedule: { updateMany: vi.fn(async (args: any) => effect('schedule.updateMany', value => {
            const rows = value.schedules.filter(row => matches(row, args.where));
            rows.forEach(row => row.revision += args.data.revision.increment); return { count: rows.length };
        })) },
    };
    for (const [table, key] of [['staffSkill', 'skills'], ['staffAvailability', 'availability']] as const) {
        prisma[table] = {
            findMany: vi.fn(async ({ where }: any) => copy(view()[key].filter(row => matches(row, where)))),
            deleteMany: vi.fn(async ({ where }: any) => effect(`${table}.deleteMany`, value => {
                const before = value[key].length; value[key] = value[key].filter(row => !matches(row, where));
                return { count: before - value[key].length };
            })),
            createMany: vi.fn(async ({ data }: any) => effect(`${table}.createMany`, value => {
                data.forEach((row: Row) => expect({ tenantId: row.tenantId, userId: row.userId })
                    .toEqual({ tenantId: actor.tenantId, userId: targetId }));
                value[key].push(...copy(data)); return { count: data.length };
            })),
        };
    }
    const observer = { observeSessionMfa: vi.fn(async (identity: Row) => {
        expect(controls.active).toBe(0);
        expect(identity).toEqual({ sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId });
        const observation = { ...identity, expiresAtEpochMs: now + controls.observerTtl,
            expiresAtMonotonicMs: performance.now() + controls.observerTtl };
        await controls.observerHook?.(); return (controls.observationChange ? controls.observationChange(observation) : observation) as any;
    }) };
    const tenantDb = new TenantPrismaService(prisma);
    const rbac = new RbacService(tenantDb);
    const controller = new UsersController(observer as any, rbac, {} as any, tenantDb);
    const req = { user: { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId,
        mfaVerified: true, permissions: ['users:write'], legacyRole: 'ADMIN' } };
    return { controller, rbac, prisma, controls, observer, req, rawReads, attempts, committed,
        get state() { return state; }, snapshot: () => copy(state), advance: (ms: number) => { now += ms; },
        replace: () => controller.replaceSchedulingProfile(targetId, profile, req) };
}
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Users authority fixture gate did not settle')), 2000);
    })]); } finally { clearTimeout(timer); }
}
afterEach(() => vi.restoreAllMocks());

describe('Users actual owner current authority (modeled database)', () => {
    it('commits the valid scoped profile, retaining foreign and published rows', async () => {
        const f = fixture(); const before = f.snapshot();
        const result = await f.replace();
        expect(result).toEqual({ user: { id: targetId }, ...profile, availabilityConfigured: true });
        expect(f.attempts).toEqual(effects); expect(f.committed).toEqual(effects);
        expect(f.controls.transactions).toBe(2); expect(f.controls.active).toBe(0);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        expect(f.state.schedules.map(row => row.revision)).toEqual([5, 7, 9]);
        expect(f.state.skills).toEqual([before.skills[1], { tenantId: actor.tenantId, userId: targetId, skill: 'new-skill' }]);
        expect(f.state.users).toEqual(before.users); expect(f.state.roles).toEqual(before.roles);
        expect(f.rawReads.filter(row => row.sql.includes('FROM "User"') && !row.sql.includes('"role" IN'))
            .map(row => row.values)).toEqual([[actor.tenantId, actor.userId], [actor.tenantId, actor.userId, targetId]]);
    });

    const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
        ['missing Tenant (synthetic absent FK parent)', f => { f.state.tenants = f.state.tenants.filter(row => row.id !== actor.tenantId); }],
        ['deleted Tenant', f => { f.state.tenants[0].deletedAt = new Date(); }],
        ['suspended Tenant', f => { f.state.tenants[0].status = 'SUSPENDED'; }],
        ['purged Tenant', f => { f.state.tenants[0].status = 'PURGED'; }],
        ['forced PIN reset', f => { f.state.users[0].pinResetRequired = true; }],
        ['suspended actor', f => { f.state.users[0].suspendedAt = new Date(); }],
        ['deleted actor', f => { f.state.users[0].deletedAt = new Date(); }],
        ['actor moved to foreign tenant', f => { f.state.users[0].tenantId = 'foreign-tenant'; }],
        ['account lock', f => { f.state.users[0].lockedUntil = new Date(Date.now() + 60_000); }],
        ['PIN lock', f => { f.state.users[0].pinLockedUntil = new Date(Date.now() + 60_000); }],
        ['revoked exact session', f => { f.state.sessions[0].revokedAt = new Date(); }],
        ['removed exact session despite another live row', f => { f.state.sessions.shift(); }],
        ['session owned by another user', f => { f.state.sessions[0].userId = 'foreign-user'; }],
        ['removed role assignment', f => { f.state.assignments.shift(); }],
        ['role moved to foreign tenant', f => { f.state.roles[0].tenantId = 'foreign-tenant'; }],
        ['deleted role', f => { f.state.roles[0].deletedAt = new Date(); }],
        ['removed custom-role users:write grant', f => { f.state.roles[0].rolePermissions = [{ permission: { key: 'users:read' } }]; }],
        ['shortened current timeout', f => { f.state.sessions[0].createdAt = new Date(Date.now() - 6 * 60_000); f.state.security.sessionTimeoutMinutes = 5; }],
    ];
    for (const [name, change] of changes) it(`refuses ${name} changed during released observer interval`, async () => {
        const f = fixture(); const entered = deferred(); const release = deferred();
        f.controls.observerHook = async () => { entered.resolve(); await release.promise; };
        const running = f.replace();
        // Attach the expected rejection before releasing the asynchronous wait.
        const denied = expect(running).rejects.toBeInstanceOf(ForbiddenException);
        try {
            await bounded(entered.promise); expect(f.controls.active).toBe(0);
            expect(f.controls.transactions).toBe(1); change(f); const afterChange = f.snapshot();
            release.resolve(); await bounded(denied);
            expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]);
            expect(f.snapshot()).toEqual(afterChange); expect(f.controls.transactions).toBe(2);
        } finally { release.resolve(); await running.catch(() => {}); }
    });

    for (const boundary of ['stored session', 'effective timeout', 'MFA observation'] as const) {
        it(`refuses ${boundary} expiry at final transaction RolePermission completion`, async () => {
            const f = fixture();
            if (boundary === 'stored session') f.state.sessions[0].expiresAt = new Date(Date.now() + 1000);
            if (boundary === 'effective timeout') {
                f.state.security.sessionTimeoutMinutes = 5;
                f.state.sessions[0].createdAt = new Date(Date.now() - 299_000);
            }
            if (boundary === 'MFA observation') f.controls.observerTtl = 1000;
            const before = f.snapshot(); f.controls.finalRoleHook = () => f.advance(2000);
            await expect(f.replace()).rejects.toBeInstanceOf(ForbiddenException);
            expect(f.controls.finalRoleVisits).toBe(1); expect(f.controls.transactions).toBe(2);
            expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before);
        });
        for (let index = 1; index <= effects.length; index++) it(`rolls back ${boundary} expiry after effect ${index}: ${effects[index - 1]}`, async () => {
            const f = fixture();
            if (boundary === 'stored session') f.state.sessions[0].expiresAt = new Date(Date.now() + 1000);
            if (boundary === 'effective timeout') {
                f.state.security.sessionTimeoutMinutes = 5;
                f.state.sessions[0].createdAt = new Date(Date.now() - 299_000);
            }
            if (boundary === 'MFA observation') f.controls.observerTtl = 1000;
            const before = f.snapshot(); f.controls.effectHook = completed => { if (completed === index) f.advance(2000); };
            await expect(f.replace()).rejects.toBeInstanceOf(ForbiddenException);
            expect(f.attempts).toEqual(effects.slice(0, index)); expect(f.committed).toEqual([]);
            expect(f.snapshot()).toEqual(before); expect(f.controls.transactions).toBe(2); expect(f.controls.active).toBe(0);
        });
    }

    it('rejects absent trusted MFA observation despite request verification marker', async () => {
        const f = fixture(); f.controls.observationChange = () => null;
        await expect(f.replace()).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.controls.transactions).toBe(1); expect(f.attempts).toEqual([]);
    });
    for (const field of ['sub', 'tenantId', 'sessionId'] as const) it(`refuses a trusted observation bound to a different ${field}`, async () => {
        const f = fixture(); f.controls.observationChange = observation => ({ ...observation, [field]: 'foreign-identity' });
        await expect(f.replace()).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.controls.transactions).toBe(1); expect(f.controls.active).toBe(0); expect(f.attempts).toEqual([]);
    });
    it('refuses expired monotonic MFA proof while wall and session deadlines remain future', async () => {
        const f = fixture(); f.controls.observationChange = observation => ({ ...observation, expiresAtMonotonicMs: performance.now() - 1 });
        await expect(f.replace()).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.controls.transactions).toBe(1); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]);
    });
    it('keeps privileged MFA observation when current user and workspace MFA flags are relaxed', async () => {
        const f = fixture(); f.controls.observerHook = () => {
            expect(f.controls.active).toBe(0); f.state.users[0].mfaEnabled = false; f.state.security.requireMfaForAll = false;
        };
        await f.replace(); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
        expect(f.committed).toEqual(effects); expect(f.controls.transactions).toBe(2);
    });
    it('rejects observer failure outside DB before final transaction or effects', async () => {
        const f = fixture(); f.controls.observerHook = () => { throw new Error('controlled observer unavailable'); };
        await expect(f.replace()).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(f.controls.transactions).toBe(1); expect(f.controls.active).toBe(0); expect(f.attempts).toEqual([]);
    });
    it('returns scoped directory reads without role seeding or any model effects', async () => {
        const f = fixture(); const before = f.snapshot(); const seed = vi.spyOn(f.rbac, 'ensureTenantRoles');
        const result = await f.controller.findAll(f.req);
        expect(result.tenantId).toBe(actor.tenantId);
        expect(result.data.map(row => row.id)).toEqual([actor.userId, targetId]);
        expect(result.summary?.totalUsers).toBe(2); expect(seed).not.toHaveBeenCalled();
        expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(f.attempts).toEqual([]);
        expect(f.committed).toEqual([]); expect(f.snapshot()).toEqual(before);
    });
});
