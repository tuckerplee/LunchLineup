import { performance } from 'node:perf_hooks';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { captureCurrentMutationPolicy, assertCurrentMutationPolicy } from '../auth/current-mutation';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { TimeCardsController } from './time-cards.controller';
import { timeCardClockInOperationId, timeCardClockInRequestHash } from './time-card-idempotency';

// Real retained owner, domain helpers, TenantPrismaService and Rbac/policy.
// Explicit scoped tables, context/wait hooks and staged effects are a local
// behavioral model, not PostgreSQL locking/MVCC/RLS, HTTP guards or Redis proof.
// The closed FeatureAccess adapter models admitted cost and staged debit only;
// it is not the real entitlement/plan/Metering implementation.
type Row = Record<string, any>;
const actor = { tenantId: 'time-tenant', userId: 'manager', sessionId: 'exact-time-session' };
const keys = ['time_cards:read', 'time_cards:write', 'users:read', 'shifts:read'];
const commands = ['list', 'active', 'detail', 'clockIn', 'clockOut', 'correct'] as const;
type Command = typeof commands[number];
const writes = ['clockIn', 'clockOut', 'correct'] as const;
const reads = ['list', 'active', 'detail'] as const;
const effectNames: Record<Command, string[]> = {
    list: [], active: [], detail: [],
    clockIn: ['timeCard.create', 'credit.debit', 'auditLog.create'],
    clockOut: ['timeCard.updateMany', 'auditLog.create'],
    correct: ['timeCard.updateMany', 'timeCardBreak.deleteMany', 'timeCardBreak.createMany', 'auditLog.create'],
};
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, wanted]) => {
        if (key === 'OR') return (wanted as Row[]).some(item => matches(row, item));
        if (key === 'AND') return (wanted as Row[]).every(item => matches(row, item));
        if (key === 'tenantId_key') return matches(row, wanted);
        if (key === 'role') return !!row.role && matches(row.role, wanted);
        const actual = row[key];
        if (wanted instanceof Date) return actual instanceof Date && actual.getTime() === wanted.getTime();
        if (wanted && typeof wanted === 'object') {
            return Object.entries(wanted).every(([operator, value]) => {
                if (operator === 'in') return (value as any[]).includes(actual);
                if (operator === 'not') return actual !== value;
                if (operator === 'lt') return actual < (value as any);
                if (operator === 'lte') return actual <= (value as any);
                if (operator === 'gt') return actual > (value as any);
                if (operator === 'gte') return actual >= (value as any);
                throw new Error(`Unmodeled Time selector ${key}.${operator}`);
            });
        }
        return actual === wanted;
    });
}
function ordered(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return rows.slice().sort((left, right) => {
        for (const clause of clauses) for (const [key, direction] of Object.entries(clause)) {
            const a = left[key] instanceof Date ? left[key].getTime() : left[key];
            const b = right[key] instanceof Date ? right[key].getTime() : right[key];
            if (a !== b) return (a < b ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
        return 0;
    });
}
type Deadline = 'stored' | 'effective' | 'mfa_wall' | 'mfa_monotonic';
function fixture(command: Command, options: { deadline?: Deadline; mfa?: boolean; self?: boolean } = {}) {
    const identity = { ...actor };
    let monotonic = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    vi.useFakeTimers({ toFake: ['Date'] });
    const initialNow = new Date('2026-10-04T16:00:00.000Z');
    vi.setSystemTime(initialNow);
    const ago = (minutes: number) => new Date(initialNow.getTime() - minutes * 60_000);
    const user = (id: string, tenantId: string): Row => ({ id, tenantId, role: id === identity.userId ? 'MANAGER' : 'STAFF',
        name: id, username: id, deletedAt: null, suspendedAt: null, pinResetRequired: false,
        mfaEnabled: false, lockedUntil: null, pinLockedUntil: null });
    const card = (id: string, tenantId: string, userId: string): Row => ({ id, tenantId, userId,
        locationId: tenantId === identity.tenantId ? 'location' : 'foreign-location', shiftId: null,
        clockInAt: ago(id === 'own-card' ? 200 : 180), clockOutAt: null, breakMinutes: id === 'card' && command === 'correct' ? 30 : 0,
        status: 'OPEN', notes: null, payrollPeriodId: tenantId === identity.tenantId ? 'period' : null,
        workTimeZone: 'UTC', revision: 1, deletedAt: null, updatedAt: ago(1), clockInOperationId: null,
        clockInRequestHash: null });
    let state = {
        tenants: [{ id: identity.tenantId, status: 'ACTIVE', deletedAt: null, usageCredits: 8 },
            { id: 'foreign', status: 'ACTIVE', deletedAt: null, usageCredits: 99 }] as Row[],
        users: [user(identity.userId, identity.tenantId), user('staff', identity.tenantId), user('foreign-user', 'foreign')],
        sessions: [{ id: identity.sessionId, userId: identity.userId, revokedAt: null,
            createdAt: ago(4), expiresAt: new Date(initialNow.getTime() + 3_600_000) },
            { id: 'other-live-session', userId: identity.userId, revokedAt: null,
                createdAt: ago(1), expiresAt: new Date(initialNow.getTime() + 3_600_000) }] as Row[],
        roles: [{ id: 'time-role', tenantId: identity.tenantId, name: 'Time supervisor', isSystem: false,
            legacyRole: null, deletedAt: null, rolePermissions: keys.map(key => ({ roleId: 'time-role',
                permissionId: `permission-${key}`, permission: { key } })) },
            { id: 'foreign-role', tenantId: 'foreign', deletedAt: null, rolePermissions: keys.map(key => ({ permission: { key } })) }] as Row[],
        assignments: [{ tenantId: identity.tenantId, userId: identity.userId, roleId: 'time-role' },
            { tenantId: 'foreign', userId: 'foreign-user', roleId: 'foreign-role' }] as Row[],
        settings: [{ tenantId: identity.tenantId, key: 'workspace_settings',
            value: { security: { sessionTimeoutMinutes: 5, requireMfaForAll: false } } }] as Row[],
        cards: [...(command === 'clockIn' ? [] : [card('card', identity.tenantId, 'staff')]),
            ...(reads.includes(command as any) ? [card('own-card', identity.tenantId, identity.userId)] : []),
            card('foreign-card', 'foreign', 'foreign-user')],
        breaks: command === 'correct' ? [{ id: 'old-break', tenantId: identity.tenantId, timeCardId: 'card',
            startAt: ago(120), endAt: ago(90) }] as Row[] : [] as Row[],
        locations: [{ id: 'location', tenantId: identity.tenantId, name: 'UTC location', timezone: 'UTC', deletedAt: null }],
        shifts: [{ id: 'shift', tenantId: identity.tenantId, locationId: 'location', userId: 'staff', deletedAt: null,
            startTime: ago(120), endTime: new Date(initialNow.getTime() + 60_000) }] as Row[],
        policies: [{ id: 'policy', tenantId: identity.tenantId, version: 1, timeZone: 'UTC',
            effectiveFrom: new Date('2026-10-04T00:00:00.000Z') }],
        periods: [{ id: 'period', tenantId: identity.tenantId, policyVersionId: 'policy', status: 'OPEN',
            startsAt: ago(360), endsAt: new Date(initialNow.getTime() + 6 * 3_600_000) }] as Row[],
        credits: [] as Row[], audits: [] as Row[],
    };
    const deadline = options.deadline ?? 'effective';
    if (deadline !== 'effective') {
        state.sessions[0].createdAt = initialNow;
        state.settings[0].value.security.sessionTimeoutMinutes = 480;
        if (deadline === 'stored') state.sessions[0].expiresAt = new Date(initialNow.getTime() + 60_000);
    }
    const needsMfa = options.mfa || deadline === 'mfa_wall' || deadline === 'mfa_monotonic';
    if (needsMfa) state.users[0].mfaEnabled = true;
    if (options.self) {
        state.users[0].role = 'STAFF';
        state.roles[0].rolePermissions = state.roles[0].rolePermissions.filter((row: Row) => !['users:read', 'shifts:read'].includes(row.permission.key));
        const own = state.cards.find(row => row.id === 'card'); if (own) own.userId = identity.userId;
        state.policies = []; // Explicit viable unassigned-payroll self punch.
    }
    const proof = { sub: identity.userId, tenantId: identity.tenantId, sessionId: identity.sessionId,
        expiresAtEpochMs: initialNow.getTime() + 60_000, expiresAtMonotonicMs: monotonic + 60_000 };
    const expectedDeadline = Math.min(state.sessions[0].expiresAt.getTime(), state.sessions[0].createdAt.getTime()
        + state.settings[0].value.security.sessionTimeoutMinutes * 60_000);
    type State = typeof state;
    let draft: State | undefined; let pending: string[] = []; let serial = 0;
    const attempts: string[] = [], committed: string[] = [];
    const raw: Array<{ sql: string; values: any[] }> = [];
    const controls = { active: 0, transactions: 0, verified: false, ownerArmed: false,
        contextHook: undefined as (() => void) | undefined, domainHook: undefined as (() => void) | undefined,
        readHook: undefined as ((name: string) => void) | undefined, reached: 0, domainReached: 0,
        readReached: 0, ownerContexts: 0, contextAt: 1, effectReached: 0, roleReached: 0,
        effectHook: undefined as ((name: string) => void) | undefined,
        roleHook: undefined as (() => void) | undefined,
        observerHook: undefined as (() => void | Promise<void>) | undefined,
        commitError: undefined as unknown, contextError: undefined as unknown,
        afterRollback: undefined as (() => void) | undefined, rawTenantId: identity.tenantId, rawSessionId: identity.sessionId,
        queuedWriter: undefined as (() => void) | undefined,
        timeline: [] as string[], unexpected: [] as string[], locked: new Set<string>() };
    const view = () => draft ?? state;
    const domain = () => copy({ cards: state.cards, breaks: state.breaks, credits: state.credits,
        audits: state.audits, tenants: state.tenants.map(row => ({ id: row.id, usageCredits: row.usageCredits })) });
    const effect = (name: string, mutate: (selected: State) => any) => {
        if (!draft) draft = copy(state);
        attempts.push(name); pending.push(name);
        const value = copy(mutate(draft));
        controls.effectHook?.(name);
        return value;
    };
    const result = (name: string, value: any) => {
        const selected = copy(value);
        controls.readHook?.(name);
        return selected;
    };
    const relationAssignments = () => view().assignments.map(row => ({ ...row,
        role: view().roles.find(role => role.id === row.roleId && role.tenantId === row.tenantId) }));
    const hydrate = (row: Row | undefined | null) => !row ? null : { ...row,
        user: view().users.find(user => user.id === row.userId && user.tenantId === row.tenantId),
        location: view().locations.find(location => location.id === row.locationId && location.tenantId === row.tenantId) ?? null,
        shift: view().shifts.find(shift => shift.id === row.shiftId && shift.tenantId === row.tenantId) ?? null,
        breaks: ordered(view().breaks.filter(item => item.timeCardId === row.id && item.tenantId === row.tenantId), { startAt: 'asc' }) };
    const parts = (query: any, parameters: any[]) => {
        const flatten = (items: any[]): any[] => items.flatMap(item => Array.isArray(item?.values) ? flatten(item.values) : [item]);
        return { sql: Array.isArray(query) ? query.join('?') : query.strings.join('?'),
            values: flatten(Array.isArray(query) ? parameters : parameters.length ? parameters : query.values) };
    };
    const prisma: any = {
        $transaction: vi.fn(async (work: (tx: any) => Promise<any>, options: any) => {
            expect(controls.active).toBe(0);
            if (options) {
                expect(options.maxWait).toBe(5000); expect(options.timeout).toBe(10000);
                if (options.isolationLevel) expect(options.isolationLevel).toBe('Serializable');
            }
            controls.active++; controls.transactions++; controls.locked.clear(); draft = undefined; pending = [];
            let succeeded = false;
            try {
                const value = await work(prisma);
                succeeded = true;
                if (draft) { state = draft; committed.push(...pending); }
                controls.timeline.push(`owner-commit:${controls.ownerContexts}`);
                if (controls.commitError && pending.length) { const error = controls.commitError; controls.commitError = undefined; throw error; }
                return value;
            } finally {
                controls.active--; draft = undefined; pending = []; controls.locked.clear();
                if (!succeeded && controls.afterRollback) { const change = controls.afterRollback; controls.afterRollback = undefined; change(); }
                const writer = controls.queuedWriter; controls.queuedWriter = undefined;
                if (writer) { expect(controls.active).toBe(0); writer(); controls.timeline.push('writer-commit'); }
            }
        }),
        $executeRaw: vi.fn(async (query: any, ...parameters: any[]) => {
            const { sql, values } = parts(query, parameters); raw.push({ sql, values: copy(values) });
            if (sql.includes('set_current_tenant')) {
                expect(values).toEqual([controls.rawTenantId]);
                if (controls.ownerArmed) {
                    controls.ownerContexts++;
                    const hook = controls.ownerContexts === controls.contextAt ? controls.contextHook : undefined;
                    if (hook) controls.contextHook = undefined;
                    if (hook) {
                        expect(controls.locked.size).toBe(0); expect(pending).toEqual([]);
                        controls.reached++; hook();
                    }
                    if (controls.contextError) { const error = controls.contextError; controls.contextError = undefined; throw error; }
                }
                return 1;
            }
            if (sql.includes('pg_advisory_xact_lock')) {
                expect(values).toHaveLength(1);
                expect(['lunchlineup:payroll:time-tenant', 'lunchlineup:payroll:time-tenant:period']).toContain(values[0]);
                const hook = controls.domainHook; controls.domainHook = undefined;
                if (hook) { controls.domainReached++; hook(); }
                return 1;
            }
            if (sql.includes("SET LOCAL lock_timeout = '5s'")) { expect(values).toEqual([]); return 0; }
            controls.unexpected.push(sql); throw new Error(`Unmodeled Time executeRaw ${sql}`);
        }),
        $queryRaw: vi.fn(async (query: any, ...parameters: any[]) => {
            const { sql, values } = parts(query, parameters); raw.push({ sql, values: copy(values) });
            if (sql.includes('FROM "Tenant"')) {
                expect(values).toEqual([controls.rawTenantId]); controls.locked.add('Tenant');
                return copy(view().tenants.filter(row => row.id === values[0]));
            }
            if (sql.includes('FROM "User"')) {
                controls.locked.add('User');
                if (sql.includes('"role" IN')) {
                    expect(values.slice(1)).toEqual([identity.tenantId, 'MANAGER', 'STAFF']);
                    expect([identity.userId, 'staff']).toContain(values[0]);
                    return copy(view().users.filter(row => row.id === values[0] && row.tenantId === values[1]
                        && ['MANAGER', 'STAFF'].includes(row.role) && !row.deletedAt && !row.suspendedAt));
                }
                expect(values[0]).toBe(controls.rawTenantId);
                expect(values.slice(1)).toEqual([...new Set(values.slice(1))].sort());
                return copy(view().users.filter(row => row.tenantId === values[0] && values.slice(1).includes(row.id)
                    && !row.deletedAt));
            }
            if (sql.includes('FROM "Session"')) {
                expect(values).toEqual([controls.rawSessionId, identity.userId]); controls.locked.add('Session');
                return copy(view().sessions.filter(row => row.id === values[0] && row.userId === values[1]));
            }
            if (sql.includes('FROM "RoleAssignment"')) {
                expect(values).toEqual([identity.tenantId, identity.userId]); controls.locked.add('RoleAssignment');
                return copy(view().assignments.filter(row => row.tenantId === values[0] && row.userId === values[1]));
            }
            if (sql.includes('FROM "RolePermission"')) {
                expect(values).toEqual(['time-role']); controls.locked.add('RolePermission');
                if (controls.ownerArmed && controls.ownerContexts === 2 && controls.roleHook) {
                    const hook = controls.roleHook; controls.roleHook = undefined; controls.roleReached++; hook();
                }
                return copy(view().roles.filter(row => values.includes(row.id)).flatMap(row => row.rolePermissions));
            }
            if (sql.includes('FROM "Role"')) {
                expect(values).toEqual([identity.tenantId, 'time-role']); controls.locked.add('Role');
                return copy(view().roles.filter(row => row.tenantId === values[0] && row.id === values[1]));
            }
            if (sql.includes('FROM "PayrollPeriod"')) {
                if (sql.includes('"policyVersionId"')) {
                    expect(values[0]).toBe('period'); expect(values[1]).toBe(identity.tenantId); expect(values[2]).toBe('policy');
                    expect(values[3]).toBeInstanceOf(Date); expect(values[4]).toEqual(values[3]);
                    return copy(view().periods.filter(row => row.id === values[0] && row.tenantId === values[1]
                        && row.policyVersionId === values[2] && row.status === 'OPEN' && row.startsAt <= values[3] && row.endsAt > values[3]));
                }
                expect(values).toEqual(['period', identity.tenantId]);
                return copy(view().periods.filter(row => row.id === values[0] && row.tenantId === values[1]));
            }
            if (sql.includes('FROM "TimeCardBreak"')) {
                expect(values).toEqual(['card', identity.tenantId]);
                return copy(view().breaks.filter(row => row.timeCardId === values[0] && row.tenantId === values[1]));
            }
            if (sql.includes('FROM "TimeCard"')) {
                expect(values).toEqual(['card', identity.tenantId]);
                return copy(view().cards.filter(row => row.id === values[0] && row.tenantId === values[1]));
            }
            controls.unexpected.push(sql); throw new Error(`Unmodeled Time queryRaw ${sql}`);
        }),
        tenant: { findUnique: vi.fn(async ({ where }: any) => copy(view().tenants.find(row => matches(row, where)) ?? null)) },
        user: { findFirst: vi.fn(async ({ where }: any) => copy(view().users.find(row => matches(row, where)) ?? null)) },
        session: { findFirst: vi.fn(async ({ where }: any) => copy(view().sessions.find(row => matches(row, where)) ?? null)) },
        tenantSetting: { findUnique: vi.fn(async ({ where }: any) => copy(view().settings.find(row => matches(row, where)) ?? null)) },
        roleAssignment: { findMany: vi.fn(async ({ where, orderBy }: any) => copy(ordered(relationAssignments().filter(row => matches(row, where)), orderBy))) },
        role: { findMany: vi.fn(async ({ where }: any) => copy(view().roles.filter(row => matches(row, where)))) },
        payrollPolicyVersion: { findMany: vi.fn(async ({ where, orderBy, take }: any) => copy(ordered(view().policies.filter(row => matches(row, where)), orderBy).slice(0, take))) },
        payrollPeriod: { findFirst: vi.fn(async ({ where }: any) => copy(view().periods.find(row => matches(row, where)) ?? null)) },
        location: { findFirst: vi.fn(async ({ where }: any) => copy(view().locations.find(row => matches(row, where)) ?? null)) },
        shift: { findFirst: vi.fn(async ({ where }: any) => copy(view().shifts.find(row => matches(row, where)) ?? null)) },
        timeCard: {
            findMany: vi.fn(async ({ where, orderBy, take }: any) => result('timeCard.findMany',
                ordered(view().cards.filter(row => matches(row, where)), orderBy).slice(0, take).map(hydrate))),
            findFirst: vi.fn(async ({ where, orderBy }: any) => result('timeCard.findFirst', hydrate(
                ordered(view().cards.filter(row => matches(row, where)), orderBy)[0]))),
            findUnique: vi.fn(async ({ where }: any) => {
                expect(Object.keys(where)).toEqual(['clockInOperationId']);
                return result('timeCard.findUnique', hydrate(view().cards.find(row => matches(row, where))));
            }),
            create: vi.fn(async ({ data }: any) => {
                expect(data.tenantId).toBe(identity.tenantId); expect(data.userId).toBe(options.self ? identity.userId : 'staff');
                const created = effect('timeCard.create', value => {
                    const row = { ...card('created-card', identity.tenantId, 'staff'), ...data, updatedAt: new Date() };
                    value.cards.push(row); return row;
                });
                return copy(hydrate(created));
            }),
            updateMany: vi.fn(async ({ where, data }: any) => effect('timeCard.updateMany', value => {
                expect(where.tenantId).toBe(identity.tenantId);
                const rows = value.cards.filter(row => matches(row, where));
                for (const row of rows) {
                    for (const [key, change] of Object.entries(data)) {
                        row[key] = change && typeof change === 'object' && 'increment' in change
                            ? row[key] + (change as Row).increment : copy(change);
                    }
                    row.updatedAt = new Date();
                }
                return { count: rows.length };
            })),
        },
        timeCardBreak: {
            deleteMany: vi.fn(async ({ where }: any) => effect('timeCardBreak.deleteMany', value => {
                expect(where).toEqual({ tenantId: identity.tenantId, timeCardId: 'card' });
                const removed = value.breaks.filter(row => matches(row, where));
                value.breaks = value.breaks.filter(row => !matches(row, where)); return { count: removed.length };
            })),
            createMany: vi.fn(async ({ data }: any) => effect('timeCardBreak.createMany', value => {
                for (const item of data) {
                    expect(item.tenantId).toBe(identity.tenantId); expect(item.timeCardId).toBe('card');
                    value.breaks.push({ id: `new-break-${++serial}`, ...copy(item) });
                }
                return { count: data.length };
            })),
        },
        auditLog: { create: vi.fn(async ({ data }: any) => effect('auditLog.create', value => {
            expect(data.tenantId).toBe(identity.tenantId); expect(data.userId).toBe(identity.userId);
            const row = { id: `audit-${++serial}`, ...copy(data) }; value.audits.push(row); return row;
        })) },
    };
    const tenantDb = new TenantPrismaService(prisma); const rbac = new RbacService(tenantDb);
    const observer = { observeSessionMfa: vi.fn(async (selected: Row) => {
        expect(controls.active).toBe(0);
        expect(selected).toEqual({ sub: identity.userId, tenantId: identity.tenantId, sessionId: identity.sessionId });
        await controls.observerHook?.();
        return proof;
    }) };
    const resolution = { enabled: true, source: 'credits', reason: 'Explicit admitted Time cost', creditCost: 1 };
    const feature: any = {
        assertFeatureEntitled: vi.fn((tenantId: string, key: string) => tenantDb.withTenant(tenantId,
            tx => feature.assertFeatureEntitledInTransaction(tx, tenantId, key))),
        assertFeatureEntitledInTransaction: vi.fn(async (tx: any, tenantId: string, key: string) => {
            expect(tenantId).toBe(identity.tenantId); expect(key).toBe('time_cards');
            await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
            if (['PAST_DUE', 'CANCELLED'].includes(view().tenants[0].status)) throw new ForbiddenException('Explicit modeled paid entitlement is absent');
            return copy(resolution);
        }),
        assertFeatureEnabledInTransaction: vi.fn(async (tx: any, tenantId: string, key: string) => {
            const value = await feature.assertFeatureEntitledInTransaction(tx, tenantId, key);
            if (view().tenants[0].usageCredits <= 0) throw new ForbiddenException('Explicit modeled credit cost cannot be admitted');
            return value;
        }),
        recordFeatureUsageInTransaction: vi.fn(async (_tx: any, tenantId: string, admitted: Row,
            reason: string, operationId: string, transactionId?: string, guard?: () => void) => {
            expect(tenantId).toBe(identity.tenantId); expect(admitted).toEqual(resolution);
            expect(operationId).toMatch(/^[a-f0-9]{64}$/); expect(transactionId).toBeUndefined();
            guard?.();
            const value = effect('credit.debit', value => {
                const tenant = value.tenants.find(row => row.id === tenantId)!;
                tenant.usageCredits -= 1;
                value.credits.push({ id: `feature-usage-${operationId}`, tenantId, amount: -1,
                    operationId, reason, balanceAfter: tenant.usageCredits });
                return { consumedCredits: 1, newBalance: tenant.usageCredits };
            });
            guard?.(); return value;
        }),
    };
    // Actual current owner receives real Rbac and explicit trusted test observer.
    const controller = new (TimeCardsController as any)(feature, tenantDb, rbac, observer) as TimeCardsController;
    let req: any;
    const permission = reads.includes(command as any) ? 'time_cards:read' : 'time_cards:write';
    const current = () => tenantDb.withTenant(identity.tenantId, async tx => {
        await rbac.authorizeActorMutationInTransaction(tx, identity, permission);
        const access = await rbac.getEffectiveAccessInTransaction(tx, identity.userId, identity.tenantId);
        const policy = await captureCurrentMutationPolicy(tx, identity, access.permissions);
        assertCurrentMutationPolicy(policy, policy.requiresMfa ? proof : null);
        return { access, policy };
    });
    const prepare = async () => {
        const verified = await current();
        expect(verified.access.permissions).toEqual((options.self ? keys.filter(key => !['users:read', 'shifts:read'].includes(key)) : keys).slice().sort());
        expect(verified.policy.requiresMfa).toBe(!!needsMfa);
        expect(verified.policy.expiresAtEpochMs).toBe(expectedDeadline);
        req = { user: Object.freeze({ sub: identity.userId, tenantId: identity.tenantId, sessionId: identity.sessionId,
            permissions: Object.freeze(verified.access.permissions.slice()), role: verified.access.primaryRole,
            mfaRequired: false, mfaVerified: true, pinResetRequired: false }) };
        controls.verified = true; controls.ownerArmed = true;
    };
    const inputIn: any = { userId: options.self ? undefined : 'staff', locationId: 'location', shiftId: options.self ? undefined : 'shift',
        ...(options.self ? {} : { clockInAt: ago(60).toISOString() }), notes: 'Valid scoped punch' };
    const inputOut: any = { ...(options.self ? {} : { clockOutAt: ago(30).toISOString() }), breakMinutes: 15 };
    const inputCorrection: any = { clockInAt: ago(240).toISOString(), clockOutAt: ago(30).toISOString(),
        expectedUpdatedAt: ago(1).toISOString(), reason: 'Verified corrected punches', breakIntervals: [
            { startAt: ago(180).toISOString(), endAt: ago(150).toISOString() },
            { startAt: ago(90).toISOString(), endAt: ago(60).toISOString() }] };
    const invoke = () => {
        expect(controls.verified).toBe(true);
        switch (command) {
            case 'list': return controller.findAll(req);
            case 'active': return controller.active(req, 'staff');
            case 'detail': return controller.findOne('card', req);
            case 'clockIn': return controller.clockIn(inputIn, req, 'retained-time-authority');
            case 'clockOut': return controller.clockOut('card', inputOut, req);
            case 'correct': return controller.correct('card', inputCorrection, req);
        }
    };
    return { command, controls, attempts, committed, raw, observer, feature, domain, prepare, invoke, current, controller,
        identity, proof, inputIn, inputOut, inputCorrection, get req() { return req; },
        clearLedger: () => { attempts.length = 0; committed.length = 0; controls.timeline.length = 0; controls.ownerContexts = 0; },
        advanceDeadline: () => { if (deadline === 'mfa_monotonic') monotonic += 60_000;
            else vi.setSystemTime(initialNow.getTime() + 60_000); },
        expireEffect: (name: string) => { controls.effectHook = selected => {
            if (selected !== name) return; controls.effectHook = undefined; controls.effectReached++;
            if (deadline === 'mfa_monotonic') monotonic += 60_000; else vi.setSystemTime(initialNow.getTime() + 60_000);
        }; },
        get state() { return state; },
        writerFirst: (change: () => void) => { controls.contextHook = change; },
        revoke: () => { state.sessions.find(row => row.id === identity.sessionId)!.revokedAt = new Date(); },
        removeGrant: (key: string) => { state.roles[0].rolePermissions = state.roles[0].rolePermissions.filter((row: Row) => row.permission.key !== key); },
        expireAtDomain: () => { controls.domainHook = () => vi.setSystemTime(initialNow.getTime() + 60_000); },
        expireAtRead: () => { controls.readHook = name => {
            if (name !== (command === 'list' ? 'timeCard.findMany' : 'timeCard.findFirst')) return;
            controls.readHook = undefined; controls.readReached++;
            vi.setSystemTime(initialNow.getTime() + 60_000);
        }; },
    };
}
type Outcome = { kind: 'fulfilled'; value: any } | { kind: 'rejected'; error: any };
async function outcome(f: ReturnType<typeof fixture>, scenario: string): Promise<Outcome> {
    const value: Outcome = await f.invoke().then(value => ({ kind: 'fulfilled' as const, value }),
        error => ({ kind: 'rejected' as const, error }));
    const error = value.kind === 'rejected' ? value.error : null;
    console.log('retained-time-owner-outcome', JSON.stringify({ scenario, command: f.command, kind: value.kind,
        status: error?.getStatus?.(), name: error?.name, message: error?.message,
        attempts: f.attempts, committed: f.committed, contextReached: f.controls.reached,
        domainReached: f.controls.domainReached, readReached: f.controls.readReached,
        returnedIds: value.kind === 'fulfilled' ? (f.command === 'list' ? value.value.data.map((row: Row) => row.id)
            : f.command === 'active' ? [value.value.data?.id] : [value.value.id]) : [] }));
    return value;
}
function denied(value: Outcome, status = 403): void {
    expect(value.kind).toBe('rejected');
    if (value.kind !== 'rejected') return;
    expect(value.error.getStatus()).toBe(status);
    expect(value.error).not.toBeInstanceOf(TypeError);
    if (status === 403) expect(value.error).toBeInstanceOf(ForbiddenException);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('Retained Time current authority: closed actual-owner baseline', () => {
    it.each(commands)('allows valid scoped %s with exact effects', async command => {
        const f = fixture(command); await f.prepare();
        const value = await outcome(f, 'valid');
        expect(value.kind).toBe('fulfilled');
        expect(f.committed).toEqual(effectNames[command]); expect(f.attempts).toEqual(effectNames[command]);
        expect(f.state.tenants.find(row => row.id === 'foreign')!.usageCredits).toBe(99);
        if (value.kind !== 'fulfilled') return;
        if (command === 'list') expect(value.value.data.map((row: Row) => row.id)).toEqual(['card', 'own-card']);
        else if (command === 'active') expect(value.value.data.id).toBe('card');
        else if (command === 'detail') expect(value.value.id).toBe('card');
        else if (command === 'clockIn') {
            expect(value.value.userId).toBe('staff'); expect(value.value.payrollPeriodId).toBe('period');
            expect(f.state.credits).toHaveLength(1); expect(f.state.tenants[0].usageCredits).toBe(7);
        } else {
            expect(value.value.status).toBe('CLOSED'); expect(value.value.revision).toBe(2);
            expect(f.state.credits).toEqual([]); expect(f.state.tenants[0].usageCredits).toBe(8);
            if (command === 'correct') expect(value.value.breaks).toHaveLength(2);
        }
        expect(f.state.audits.map(row => row.action)).toEqual(command === 'clockIn' ? ['TIME_CARD_CLOCKED_IN']
            : command === 'clockOut' ? ['TIME_CARD_CLOCKED_OUT'] : command === 'correct' ? ['TIME_CARD_CORRECTED'] : []);
    });
    it.each(commands)('refuses writer-first exact Session revocation for %s', async command => {
        const f = fixture(command); await f.prepare(); const before = f.domain();
        f.writerFirst(f.revoke);
        const value = await outcome(f, 'writer-first-session');
        expect(f.controls.reached).toBe(1);
        await expect(f.current()).rejects.toBeInstanceOf(ForbiddenException);
        denied(value); expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]);
    });
    it.each(writes)('refuses writer-first current write-grant loss for %s', async command => {
        const f = fixture(command); await f.prepare(); const before = f.domain();
        f.writerFirst(() => f.removeGrant('time_cards:write'));
        const value = await outcome(f, 'writer-first-write-grant');
        expect(f.controls.reached).toBe(1);
        await expect(f.current()).rejects.toBeInstanceOf(ForbiddenException);
        denied(value); expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]);
    });
    it.each(writes)('refuses effective lifetime at a reached payroll await for %s', async command => {
        const f = fixture(command); await f.prepare(); const before = f.domain();
        f.expireAtDomain();
        const value = await outcome(f, 'effective-payroll-wait');
        expect(f.controls.domainReached).toBe(1);
        expect(f.state.sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
        await expect(f.current()).rejects.toBeInstanceOf(ForbiddenException);
        denied(value); expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]);
    });
    it.each(reads)('uses current retained self/team scope after writer-first team grant loss for %s', async command => {
        const f = fixture(command); await f.prepare(); const before = f.domain();
        f.writerFirst(() => f.removeGrant('users:read'));
        const value = await outcome(f, 'writer-first-team-scope');
        expect(f.controls.reached).toBe(1);
        const current = await f.current(); expect(current.access.permissions).not.toContain('users:read');
        if (command === 'list') {
            expect(value.kind).toBe('fulfilled');
            if (value.kind === 'fulfilled') expect(value.value.data.map((row: Row) => row.id)).toEqual(['own-card']);
        } else denied(value, command === 'active' ? 403 : 404);
        expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]);
    });
    it.each(reads)('refuses effective lifetime at final scoped read completion for %s', async command => {
        const f = fixture(command); await f.prepare(); const before = f.domain();
        f.expireAtRead();
        const value = await outcome(f, 'effective-final-read');
        expect(f.controls.readReached).toBe(1);
        expect(f.state.sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
        await expect(f.current()).rejects.toBeInstanceOf(ForbiddenException);
        denied(value); expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]);
    });
});

function settled(f: ReturnType<typeof fixture>) {
    const operationId = timeCardClockInOperationId(f.identity.tenantId, 'retained-time-authority');
    const requestHash = timeCardClockInRequestHash({ actorUserId: f.identity.userId,
        targetUserId: f.inputIn.userId?.trim() || f.identity.userId, locationId: f.inputIn.locationId ?? null,
        shiftId: f.inputIn.shiftId ?? null, clockInAt: f.inputIn.clockInAt ?? null,
        notes: f.inputIn.notes.trim() || null });
    const foreign = f.state.cards.find(row => row.id === 'foreign-card')!;
    f.state.cards.push({ ...copy(foreign), id: 'settled-card', tenantId: f.identity.tenantId,
        userId: 'staff', locationId: 'location', shiftId: 'shift', payrollPeriodId: 'period',
        clockInOperationId: operationId, clockInRequestHash: requestHash, deletedAt: null, revision: 1,
        clockInAt: f.inputIn.clockInAt ? new Date(f.inputIn.clockInAt) : new Date(), notes: f.inputIn.notes });
    f.state.credits.push({ id: `feature-usage-${operationId}`, operationId, tenantId: f.identity.tenantId, amount: -1 });
    f.state.tenants[0].usageCredits = 7;
    f.state.audits.push({ id: 'prior-audit', tenantId: f.identity.tenantId, userId: f.identity.userId,
        action: 'TIME_CARD_CLOCKED_IN', resource: 'TimeCard', resourceId: 'settled-card' });
}
function intact(f: ReturnType<typeof fixture>, before: ReturnType<ReturnType<typeof fixture>['domain']>) {
    expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]);
    expect(f.controls.unexpected).toEqual([]); expect(f.controls.active).toBe(0);
}
const extraWriterAxes = commands.flatMap(command => ['tenant', 'account', 'pin', 'permission', 'mfa-policy']
    .filter(axis => axis !== 'permission' || !writes.includes(command as any)).map(axis => ({ command, axis })));
const extraLifetimes = commands.flatMap(command => (['stored', 'mfa_wall', 'mfa_monotonic'] as const)
    .map(deadline => ({ command, deadline })));
const effectLifetimes = writes.flatMap(command => effectNames[command].flatMap((effect, index) =>
    (['stored', 'effective', 'mfa_wall', 'mfa_monotonic'] as const).map(deadline => ({ command, effect, index, deadline }))));

describe('Retained Time current authority: independent deadlines and fresh snapshots', () => {
    it.each(extraWriterAxes)('refuses $axis at writer-first authority entry for $command', async ({ command, axis }) => {
        const f = fixture(command); await f.prepare(); const before = f.domain();
        f.controls.contextAt = axis === 'mfa-policy' ? 2 : 1;
        f.writerFirst(() => {
            if (axis === 'tenant') f.state.tenants[0].status = 'SUSPENDED';
            if (axis === 'account') f.state.users[0].suspendedAt = new Date();
            if (axis === 'pin') f.state.users[0].pinResetRequired = true;
            if (axis === 'permission') f.removeGrant('time_cards:read');
            if (axis === 'mfa-policy') f.state.settings[0].value.security.requireMfaForAll = true;
        });
        const value = await outcome(f, `writer-${axis}`);
        expect(f.controls.reached).toBe(1); denied(value); intact(f, before);
        expect(f.observer.observeSessionMfa).not.toHaveBeenCalled();
    });
    it.each(extraLifetimes)('refuses independent $deadline at actual domain/last-read wait for $command', async ({ command, deadline }) => {
        const f = fixture(command, { deadline }); await f.prepare(); const before = f.domain();
        if (writes.includes(command as any)) f.controls.domainHook = f.advanceDeadline;
        else f.controls.readHook = name => {
            if (name !== (command === 'list' ? 'timeCard.findMany' : 'timeCard.findFirst')) return;
            f.controls.readHook = undefined; f.controls.readReached++; f.advanceDeadline();
        };
        const value = await outcome(f, `independent-${deadline}`);
        expect(writes.includes(command as any) ? f.controls.domainReached : f.controls.readReached).toBe(1);
        denied(value); expect(f.attempts).toEqual([]); intact(f, before);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(deadline.startsWith('mfa') ? 1 : 0);
    });
    it.each(effectLifetimes)('rolls back $command through $effect completion on $deadline', async ({ command, effect, index, deadline }) => {
        const f = fixture(command, { deadline }); await f.prepare(); const before = f.domain();
        f.expireEffect(effect);
        const value = await outcome(f, `effect-${deadline}-${effect}`);
        expect(f.controls.effectReached).toBe(1); denied(value);
        expect(f.attempts).toEqual(effectNames[command].slice(0, index + 1)); intact(f, before);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(deadline.startsWith('mfa') ? 1 : 0);
    });
    it.each(commands)('permits held-fence Time-first %s before a queued exact Session writer', async command => {
        const f = fixture(command); await f.prepare(); let queued = false;
        f.controls.roleHook = () => {
            expect(f.controls.locked.has('Session')).toBe(true);
            queued = true; f.controls.queuedWriter = f.revoke;
            expect(f.state.sessions[0].revokedAt).toBeNull();
        };
        const value = await outcome(f, 'time-first-row-fence-model');
        expect(queued).toBe(true); expect(f.controls.roleReached).toBe(1); expect(value.kind).toBe('fulfilled');
        expect(f.committed).toEqual(effectNames[command]);
        expect(f.controls.timeline.slice(-2)).toEqual(['owner-commit:2', 'writer-commit']);
        expect(f.state.sessions[0].revokedAt).toBeInstanceOf(Date);
        // This explicit queued row writer is not a real writer owner/PG lock proof.
        expect(f.controls.unexpected).toEqual([]);
    });
    it.each(commands)('observes already-required MFA once outside transactions for %s', async command => {
        const f = fixture(command, { mfa: true });
        f.state.users[0].mfaEnabled = false; f.state.settings[0].value.security.requireMfaForAll = true;
        await f.prepare();
        const value = await outcome(f, 'required-mfa-positive'); expect(value.kind).toBe('fulfilled');
        expect(f.committed).toEqual(effectNames[command]); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(f.controls.unexpected).toEqual([]);
    });
    it('rejects a foreign MFA observation even when the request marker says verified', async () => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare(); const before = f.domain();
        f.proof.sub = 'foreign-user'; denied(await outcome(f, 'foreign-proof')); intact(f, before);
    });
    it('rejects observer unavailability before any Time domain effects', async () => {
        const f = fixture('clockOut', { mfa: true }); await f.prepare(); const before = f.domain();
        f.observer.observeSessionMfa.mockRejectedValueOnce(new Error('controlled offline observation'));
        const value = await outcome(f, 'offline-proof');
        expect(value.kind).toBe('rejected'); if (value.kind === 'rejected') expect(value.error.getStatus()).toBe(503);
        intact(f, before);
    });
    it('keeps captured actor and clock-in intent across the released observer interval', async () => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare();
        f.controls.observerHook = () => { f.req.user = { sub: 'foreign-user', tenantId: 'foreign', sessionId: 'foreign-session' };
            f.inputIn.userId = 'foreign-user'; f.inputIn.notes = 'changed intent'; };
        const value = await outcome(f, 'frozen-clock-in'); expect(value.kind).toBe('fulfilled');
        if (value.kind === 'fulfilled') { expect(value.value.userId).toBe('staff'); expect(value.value.notes).toBe('Valid scoped punch'); }
        expect(f.committed).toEqual(effectNames.clockIn); expect(f.controls.unexpected).toEqual([]);
    });
    it('keeps the captured correction break inputs across the observer interval', async () => {
        const f = fixture('correct', { mfa: true }); await f.prepare();
        f.controls.observerHook = () => { f.inputCorrection.breakIntervals[0].startAt = 'garbage';
            f.inputCorrection.reason = 'changed reason'; };
        const value = await outcome(f, 'frozen-correction'); expect(value.kind).toBe('fulfilled');
        expect(f.state.breaks).toHaveLength(2); expect(f.state.audits[0].newValue.correctionReason).toBe('Verified corrected punches');
    });
    it('does not extend a copied proof when the provider object is changed at final Role wait', async () => {
        const f = fixture('clockIn', { deadline: 'mfa_wall' }); await f.prepare(); const before = f.domain();
        f.controls.roleHook = () => { f.proof.expiresAtEpochMs += 600_000; f.proof.expiresAtMonotonicMs += 600_000; f.advanceDeadline(); };
        denied(await outcome(f, 'proof-copy')); expect(f.controls.roleReached).toBe(1); intact(f, before);
    });
    it('captures the trusted observer method before preflight awaits', async () => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare();
        const original = f.observer.observeSessionMfa;
        const replacement = vi.fn(async () => { throw new Error('replacement must not run'); });
        f.writerFirst(() => { f.observer.observeSessionMfa = replacement as any; });
        expect((await outcome(f, 'bound-observer')).kind).toBe('fulfilled');
        expect(original).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    });
    it.each(['missing', 'wrong-user', 'foreign-tenant'])('refuses the %s exact request tuple without effects', async axis => {
        const f = fixture('clockIn'); await f.prepare(); const before = f.domain();
        f.req.user = { ...f.req.user, ...(axis === 'missing' ? { sessionId: undefined }
            : axis === 'wrong-user' ? { sessionId: 'foreign-exact-session' } : { tenantId: 'foreign' }) };
        if (axis === 'wrong-user') f.controls.rawSessionId = 'foreign-exact-session';
        if (axis === 'foreign-tenant') f.controls.rawTenantId = 'foreign';
        if (axis === 'wrong-user') f.state.sessions.push({ ...copy(f.state.sessions[0]), id: 'foreign-exact-session', userId: 'foreign-user' });
        const value = await outcome(f, `tuple-${axis}`); denied(value); intact(f, before);
    });
});

describe('Retained Time exact financial receipt and retry custody', () => {
    it.each(['current', 'new-session', 'target-inactive', 'location-deleted', 'shift-reassigned', 'entitlement-lost'])(
        'returns settled exact receipt after %s without reapplying new-punch eligibility', async axis => {
        const f = fixture('clockIn');
        if (axis === 'new-session') { f.identity.sessionId = 'other-live-session';
            f.controls.rawSessionId = f.identity.sessionId; f.proof.sessionId = f.identity.sessionId;
            f.state.sessions[1].createdAt = copy(f.state.sessions[0].createdAt); }
        await f.prepare(); settled(f); const before = f.domain();
        if (axis === 'target-inactive') f.state.users[1].suspendedAt = new Date();
        if (axis === 'location-deleted') f.state.locations[0].deletedAt = new Date() as any;
        if (axis === 'shift-reassigned') f.state.shifts[0].userId = f.identity.userId;
        if (axis === 'entitlement-lost') f.state.tenants[0].status = 'PAST_DUE';
        const value = await outcome(f, `receipt-${axis}`); expect(value.kind).toBe('fulfilled');
        if (value.kind === 'fulfilled') expect(value.value.id).toBe('settled-card');
        intact(f, before); expect(f.feature.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });
    it.each(['session', 'grant', 'mfa'])( 'denies current %s against a prior settled receipt without undoing it', async axis => {
        const f = fixture('clockIn', axis === 'mfa' ? { deadline: 'mfa_monotonic' } : {});
        await f.prepare(); settled(f); const before = f.domain();
        if (axis === 'session') f.writerFirst(f.revoke);
        if (axis === 'grant') f.writerFirst(() => f.removeGrant('time_cards:write'));
        if (axis === 'mfa') f.controls.readHook = name => { if (name !== 'timeCard.findUnique') return;
            f.controls.readHook = undefined; f.controls.readReached++; f.advanceDeadline(); };
        denied(await outcome(f, `settled-denied-${axis}`)); intact(f, before);
        expect(axis === 'mfa' ? f.controls.readReached : f.controls.reached).toBe(1);
    });
    it('rejects a financial payload mismatch rather than reading it as recoverable conflict', async () => {
        const f = fixture('clockIn'); await f.prepare(); settled(f); const before = f.domain();
        f.inputIn.notes = 'different financial intent'; const value = await outcome(f, 'receipt-payload-mismatch');
        expect(value.kind).toBe('rejected'); if (value.kind === 'rejected') expect(value.error.getStatus()).toBe(409);
        expect(f.controls.ownerContexts).toBe(2); intact(f, before);
    });
    it.each(['open-card', 'P2002', 'P2028'])( 'uses one fresh authorized receipt callback after admitted %s', async code => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare();
        if (code === 'open-card') {
            const copyCard = copy(f.state.cards[0]);
            f.state.cards.push({ ...copyCard, id: 'intervening-card', tenantId: actor.tenantId, userId: 'staff',
                deletedAt: null, status: 'OPEN' });
        } else f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw Object.assign(new Error('controlled driver error'), { code }); };
        // Model a competing durable receipt only after failed tx releases its
        // held rows, never force its commit under an already-held Tenant fence.
        f.controls.afterRollback = () => { f.state.cards = f.state.cards.filter(row => row.id !== 'intervening-card'); settled(f); };
        const value = await outcome(f, `catch-${code}`); expect(value.kind).toBe('fulfilled');
        if (value.kind === 'fulfilled') expect(value.value.id).toBe('settled-card');
        expect(f.committed).toEqual([]); expect(f.state.credits).toHaveLength(1);
        expect(f.controls.ownerContexts).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(f.controls.unexpected).toEqual([]);
    });
    it.each([
        ['P1001', undefined], ['P1002', undefined], ['P1017', undefined],
        ['P2010', '55P03'], ['P2010', '57014'], ['P2010', '08006'], ['P2010', '57P01'],
    ] as const)('recovers only a fresh exact receipt for driver %s/%s', async (code, sqlState) => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare();
        const driver = Object.assign(new Error('controlled recognized driver failure'),
            { code, ...(sqlState ? { meta: { code: sqlState } } : {}) });
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw driver; };
        f.controls.afterRollback = () => settled(f);
        const value = await outcome(f, `driver-${code}-${sqlState}`);
        expect(value.kind).toBe('fulfilled'); if (value.kind === 'fulfilled') expect(value.value.id).toBe('settled-card');
        expect(f.attempts).toEqual(['timeCard.create']); expect(f.committed).toEqual([]);
        expect(f.state.credits).toHaveLength(1); expect(f.state.audits).toHaveLength(1);
        expect(f.controls.ownerContexts).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(f.controls.unexpected).toEqual([]);
    });
    it.each(['http-code-lookalike', 'unrecognized-sqlstate', 'other-bad-request'])(
        'does not recover a present receipt after %s', async axis => {
        const f = fixture('clockIn'); await f.prepare();
        const error = axis === 'http-code-lookalike'
            ? Object.assign(new ForbiddenException('controlled authority refusal'), { code: 'P2002' })
            : axis === 'other-bad-request' ? new BadRequestException('Different domain validation failure.')
                : Object.assign(new Error('unrecognized SQL failure'), { code: 'P2010', meta: { code: '23514' } });
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw error; };
        f.controls.afterRollback = () => settled(f);
        const value = await outcome(f, `classifier-refusal-${axis}`); expect(value.kind).toBe('rejected');
        if (value.kind === 'rejected') expect(value.error).toBe(error);
        expect(f.attempts).toEqual(['timeCard.create']); expect(f.committed).toEqual([]);
        expect(f.state.credits).toHaveLength(1); expect(f.controls.ownerContexts).toBe(2);
        expect(f.controls.unexpected).toEqual([]);
    });
    it.each(['driver-code-object', 'sqlstate-object'])(
        'refuses coercible %s with a present exact receipt', async axis => {
        const f = fixture('clockIn'); await f.prepare();
        const toString = vi.fn(() => axis === 'driver-code-object' ? 'P2002' : '55P03');
        const error = Object.assign(new Error('unclassified coercible driver metadata'),
            axis === 'driver-code-object' ? { code: { toString } }
                : { code: 'P2010', meta: { code: { toString } } });
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw error; };
        f.controls.afterRollback = () => settled(f);
        const value = await outcome(f, `coercible-${axis}`); expect(value.kind).toBe('rejected');
        if (value.kind === 'rejected') expect(value.error).toBe(error);
        expect(toString).not.toHaveBeenCalled(); expect(f.controls.ownerContexts).toBe(2);
        expect(f.attempts).toEqual(['timeCard.create']); expect(f.committed).toEqual([]);
        expect(f.state.credits).toHaveLength(1); expect(f.state.audits).toHaveLength(1);
        expect(f.controls.unexpected).toEqual([]);
    });
    it.each(['P2002', 'P2028'])( 'preserves original absence error after %s without creating in recovery', async code => {
        const f = fixture('clockIn'); await f.prepare(); const before = f.domain();
        const driver = Object.assign(new Error('controlled absence'), { code });
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw driver; };
        const value = await outcome(f, `catch-absent-${code}`); expect(value.kind).toBe('rejected');
        if (value.kind === 'rejected') {
            if (code === 'P2002') expect(value.error).toBeInstanceOf(BadRequestException);
            else expect(value.error).toBe(driver);
        }
        expect(f.attempts).toEqual(['timeCard.create']); expect(f.controls.ownerContexts).toBe(3); intact(f, before);
    });
    it('rejects authority lost after failed transaction even when fresh receipt exists', async () => {
        const f = fixture('clockIn'); await f.prepare();
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw Object.assign(new Error('controlled failure'), { code: 'P2002' }); };
        f.controls.afterRollback = () => { settled(f); f.revoke(); };
        denied(await outcome(f, 'catch-current-denied'));
        expect(f.controls.ownerContexts).toBe(3); expect(f.state.credits).toHaveLength(1);
        expect(f.state.cards.find(row => row.id === 'settled-card')).toBeDefined(); expect(f.committed).toEqual([]);
    });
    it('rejects proof expiry at the last fresh recovery receipt read', async () => {
        const f = fixture('clockIn', { deadline: 'mfa_monotonic' }); await f.prepare();
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return;
            f.controls.effectHook = undefined; throw Object.assign(new Error('controlled failure'), { code: 'P2002' }); };
        f.controls.afterRollback = () => { settled(f); f.controls.readHook = name => {
            if (name !== 'timeCard.findUnique') return; f.controls.readHook = undefined;
            f.controls.readReached++; f.advanceDeadline(); }; };
        denied(await outcome(f, 'catch-last-proof-expiry')); expect(f.controls.readReached).toBe(1);
        expect(f.state.credits).toHaveLength(1); expect(f.committed).toEqual([]);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
    });
    it('does not turn an arbitrary programming Error into receipt success', async () => {
        const f = fixture('clockIn'); await f.prepare(); const error = new Error('unrelated programming failure');
        f.controls.effectHook = name => { if (name !== 'timeCard.create') return; f.controls.effectHook = undefined; throw error; };
        f.controls.afterRollback = () => settled(f);
        const value = await outcome(f, 'unclassified-error'); expect(value.kind).toBe('rejected');
        if (value.kind === 'rejected') expect(value.error).toBe(error);
        expect(f.controls.ownerContexts).toBe(2); expect(f.committed).toEqual([]); expect(f.state.credits).toHaveLength(1);
    });
    it.each(['replay', 'revoked', 'expired'])( 'preserves own committed-before-ack-loss state with %s outcome', async axis => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare();
        f.controls.commitError = Object.assign(new Error('controlled commit acknowledgment loss'), { code: 'P2028' });
        if (axis !== 'replay') { f.controls.contextAt = 3; f.writerFirst(axis === 'revoked' ? f.revoke : f.advanceDeadline); }
        const value = await outcome(f, `ack-loss-${axis}`);
        if (axis === 'replay') { expect(value.kind).toBe('fulfilled');
            if (value.kind === 'fulfilled') expect(value.value.id).toBe('created-card'); }
        else denied(value);
        // This is modeled commit-before-driver-response ordering, not native
        // crash/transport evidence. Prior acknowledged ledger is never undone.
        expect(f.committed).toEqual(effectNames.clockIn); expect(f.attempts).toEqual(effectNames.clockIn);
        expect(f.state.credits).toHaveLength(1); expect(f.state.tenants[0].usageCredits).toBe(7);
        expect(f.state.audits).toHaveLength(1); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(f.controls.ownerContexts).toBe(3);
    });
    it.each(writes)('retries a staged serial conflict once for %s and commits effects once', async command => {
        const f = fixture(command, { mfa: true }); await f.prepare();
        f.controls.effectHook = name => { if (name !== 'auditLog.create') return;
            f.controls.effectHook = undefined; throw Object.assign(new Error('controlled serialization conflict'), { code: 'P2034' }); };
        expect((await outcome(f, 'serial-once')).kind).toBe('fulfilled');
        expect(f.attempts).toEqual([...effectNames[command], ...effectNames[command]]);
        expect(f.committed).toEqual(effectNames[command]); expect(f.controls.ownerContexts).toBe(3);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
    });
    it.each(writes)('rereads exact current authority before serial retry for %s', async command => {
        const f = fixture(command, { mfa: true }); await f.prepare(); const before = f.domain();
        f.controls.effectHook = name => { if (name !== 'auditLog.create') return;
            f.controls.effectHook = undefined; throw Object.assign(new Error('controlled serialization conflict'), { code: 'P2034' }); };
        f.controls.afterRollback = f.revoke;
        denied(await outcome(f, 'serial-current-denied')); expect(f.attempts).toEqual(effectNames[command]); intact(f, before);
        expect(f.controls.ownerContexts).toBe(3); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
    });
    it('bounds exhausted serial retries and does not recover mapped conflict as a receipt', async () => {
        const f = fixture('clockIn'); await f.prepare(); const before = f.domain();
        f.controls.effectHook = name => { if (name === 'auditLog.create') throw Object.assign(new Error('serial'), { code: 'P2034' }); };
        const value = await outcome(f, 'serial-exhausted'); expect(value.kind).toBe('rejected');
        if (value.kind === 'rejected') expect(value.error.getStatus()).toBe(409);
        expect(f.controls.ownerContexts).toBe(3); expect(f.attempts).toEqual([...effectNames.clockIn, ...effectNames.clockIn]); intact(f, before);
    });
    it('retries preflight before making one outside observation', async () => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare();
        f.controls.contextError = Object.assign(new Error('preflight serial'), { code: 'P2034' });
        expect((await outcome(f, 'preflight-serial')).kind).toBe('fulfilled');
        expect(f.committed).toEqual(effectNames.clockIn); expect(f.controls.ownerContexts).toBe(3);
        expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
    });
    it('allows receipt recovery after a unique failure on the second final attempt', async () => {
        const f = fixture('clockIn', { mfa: true }); await f.prepare(); let failures = 0;
        f.controls.effectHook = name => { if (name !== 'auditLog.create') return;
            failures++; if (failures === 2) f.controls.effectHook = undefined;
            throw Object.assign(new Error('driver'), { code: failures === 1 ? 'P2034' : 'P2002' }); };
        f.controls.afterRollback = () => { f.controls.afterRollback = () => settled(f); };
        expect((await outcome(f, 'second-unique')).kind).toBe('fulfilled');
        expect(failures).toBe(2); expect(f.controls.ownerContexts).toBe(4); expect(f.committed).toEqual([]);
        expect(f.state.credits).toHaveLength(1); expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
    });
});

const domainControls = ['pastdue-active', 'pastdue-clockOut', 'pastdue-clockIn', 'pastdue-correct',
    'zero-list', 'zero-detail', 'self-clockIn', 'self-clockOut', 'self-manual-clockIn', 'self-manual-clockOut',
    'self-correct', 'cutoff-equal', 'cutoff-late', 'stale-correction', 'overlap-correction', 'captured-timezone'] as const;
describe('Retained Time keeps paid recovery and domain constraints', () => {
    it.each(domainControls)('preserves %s through the current owner', async name => {
        const command: Command = name.includes('active') ? 'active' : name.includes('list') ? 'list'
            : name.includes('detail') ? 'detail' : name.includes('clockIn') ? 'clockIn'
            : name.includes('clockOut') || name.startsWith('cutoff') ? 'clockOut' : 'correct';
        const f = fixture(command, { self: name.startsWith('self') }); await f.prepare();
        if (name.startsWith('pastdue')) f.state.tenants[0].status = 'PAST_DUE';
        if (name.startsWith('zero')) f.state.tenants[0].usageCredits = 0;
        if (name === 'self-manual-clockIn') f.inputIn.clockInAt = new Date(Date.now() - 60_000).toISOString();
        if (name === 'self-manual-clockOut') f.inputOut.clockOutAt = new Date(Date.now() - 60_000).toISOString();
        if (name.startsWith('cutoff')) f.state.periods[0].endsAt = new Date(Date.parse(f.inputOut.clockOutAt) - (name === 'cutoff-late' ? 1 : 0));
        if (name === 'stale-correction') f.inputCorrection.expectedUpdatedAt = new Date(Date.now() - 120_000).toISOString();
        if (name === 'overlap-correction') f.state.cards.push({ ...copy(f.state.cards[0]), id: 'overlap-card' });
        if (name === 'captured-timezone') f.state.locations[0].timezone = 'America/Los_Angeles';
        const before = f.domain(); const value = await outcome(f, `domain-${name}`);
        const refusal = ['pastdue-clockIn', 'pastdue-correct', 'self-manual-clockIn', 'self-manual-clockOut',
            'self-correct', 'cutoff-late', 'stale-correction', 'overlap-correction'].includes(name);
        if (refusal) {
            const status = name === 'overlap-correction' ? 400 : ['cutoff-late', 'stale-correction'].includes(name) ? 409 : 403;
            denied(value, status); intact(f, before);
        } else {
            expect(value.kind).toBe('fulfilled'); expect(f.committed).toEqual(effectNames[command]);
            if (command !== 'clockIn') expect(f.state.credits).toEqual([]);
            if (name === 'captured-timezone' && value.kind === 'fulfilled') expect(value.value.workTimeZone).toBe('UTC');
        }
        expect(f.controls.unexpected).toEqual([]);
    });
});

it('uses one canonical whitespace actor tuple for authorization, hash and debit scope', async () => {
    const f = fixture('clockIn', { mfa: true }); await f.prepare();
    f.req.user = { ...f.req.user, sub: ' manager ', tenantId: ' time-tenant ', sessionId: ' exact-time-session ' };
    const value = await outcome(f, 'canonical-actor'); expect(value.kind).toBe('fulfilled');
    expect(f.state.credits[0].tenantId).toBe(actor.tenantId);
    const stored = f.state.cards.find(row => row.id === 'created-card')!;
    expect(stored.clockInOperationId).toBe(timeCardClockInOperationId(actor.tenantId, 'retained-time-authority'));
    expect(stored.clockInRequestHash).toBe(timeCardClockInRequestHash({ actorUserId: actor.userId, targetUserId: 'staff',
        locationId: 'location', shiftId: 'shift', clockInAt: f.inputIn.clockInAt, notes: 'Valid scoped punch' }));
    expect(f.committed).toEqual(effectNames.clockIn); expect(f.controls.unexpected).toEqual([]);
    expect(f.observer.observeSessionMfa).toHaveBeenCalledOnce();
});
