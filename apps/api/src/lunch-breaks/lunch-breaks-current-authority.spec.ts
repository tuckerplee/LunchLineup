import { ForbiddenException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { MfaSessionIdentity, MfaVerificationObservation } from '@lunchlineup/rbac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { LunchBreaksController } from './lunch-breaks.controller';
import { LunchBreaksService, type PersistSetupShiftsRequest } from './lunch-breaks.service';

// Actual retained controller/service, TenantPrisma and Rbac/policy. Explicit
// scoped row selectors, transaction drafts and known SQL only. This fixture
// does not model PostgreSQL locking/MVCC/RLS, HTTP guards or actual Metering.
// FeatureAccess below is a declared paid-cost adapter, not a billing proof.
type Row = Record<string, any>;
const actor = { userId: 'manager', tenantId: 'lunch-tenant', sessionId: 'exact-session' };
const permissions = ['lunch_breaks:read', 'lunch_breaks:write', 'shifts:write'];
const commands = ['list', 'getPolicy', 'updatePolicy', 'generate', 'setup', 'replace'] as const;
type Command = typeof commands[number];
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, wanted]) => {
        if (key === 'AND') return (wanted as Row[]).every(item => matches(row, item));
        if (key === 'OR') return (wanted as Row[]).some(item => matches(row, item));
        if (key === 'tenantId_key' || key === 'tenantId_requestKeyHash') return matches(row, wanted);
        if (key === 'role' && typeof row.role === 'object') return !!row.role && matches(row.role, wanted);
        const actual = row[key];
        if (wanted instanceof Date) return actual instanceof Date && actual.getTime() === wanted.getTime();
        if (wanted && typeof wanted === 'object') {
            return Object.entries(wanted).every(([op, value]) => {
                if (op === 'is') return !!actual && matches(actual, value as Row);
                if (op === 'in') return (value as any[]).includes(actual);
                if (op === 'notIn') return !(value as any[]).includes(actual);
                if (op === 'not') return actual !== value;
                if (op === 'lt') return actual < (value as any);
                if (op === 'lte') return actual <= (value as any);
                if (op === 'gt') return actual > (value as any);
                if (op === 'gte') return actual >= (value as any);
                throw new Error(`Unmodeled Lunch selector ${key}.${op}`);
            });
        }
        return actual === wanted;
    });
}
function ordered(rows: Row[], orderBy?: Row | Row[]): Row[] {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return rows.slice().sort((a, b) => {
        for (const clause of clauses) for (const [key, direction] of Object.entries(clause)) {
            const left = a[key] instanceof Date ? a[key].getTime() : a[key];
            const right = b[key] instanceof Date ? b[key].getTime() : b[key];
            if (left !== right) return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
        }
        return 0;
    });
}
type Deadline = 'stored' | 'effective' | 'mfa_wall' | 'mfa_monotonic';
function fixture(options: { deadline?: Deadline } = {}) {
    let monotonic = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-04T08:00:00.000Z'); vi.setSystemTime(now);
    const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
    const account = (id: string, tenantId: string, role: string): Row => ({ id, tenantId, role, name: id,
        deletedAt: null, suspendedAt: null, pinResetRequired: false, mfaEnabled: id === actor.userId,
        lockedUntil: null, pinLockedUntil: null });
    let state = {
        tenants: [{ id: actor.tenantId, status: 'ACTIVE', deletedAt: null, usageCredits: 10 },
            { id: 'foreign', status: 'ACTIVE', deletedAt: null, usageCredits: 99 }] as Row[],
        users: [account(actor.userId, actor.tenantId, 'MANAGER'), account('staff', actor.tenantId, 'STAFF'),
            account('foreign-staff', 'foreign', 'STAFF')],
        sessions: [{ id: actor.sessionId, userId: actor.userId, revokedAt: null, createdAt: at(-1), expiresAt: at(8) },
            { id: 'other-live-session', userId: actor.userId, revokedAt: null, createdAt: at(-1), expiresAt: at(8) }] as Row[],
        roles: [{ id: 'lunch-role', tenantId: actor.tenantId, name: 'Lunch manager', deletedAt: null,
            isSystem: false, legacyRole: null, rolePermissions: permissions.map(key => ({ roleId: 'lunch-role',
                permissionId: `permission-${key}`, permission: { key } })) }] as Row[],
        assignments: [{ tenantId: actor.tenantId, userId: actor.userId, roleId: 'lunch-role' }] as Row[],
        settings: [{ tenantId: actor.tenantId, key: 'workspace_settings', value: { security: { sessionTimeoutMinutes: 480 } } },
            { tenantId: actor.tenantId, key: 'lunch_break_policy', value: { lunchDurationMinutes: 30 } }] as Row[],
        locations: [{ id: 'location', tenantId: actor.tenantId, deletedAt: null },
            { id: 'foreign-location', tenantId: 'foreign', deletedAt: null }] as Row[],
        schedules: [{ id: 'schedule', tenantId: actor.tenantId, status: 'DRAFT', deletedAt: null,
            startDate: at(0), endDate: at(24), revision: 1 }] as Row[],
        shifts: [{ id: 'shift', tenantId: actor.tenantId, userId: 'staff', locationId: 'location', scheduleId: 'schedule',
            startTime: at(1), endTime: at(9), updatedAt: now, deletedAt: null },
            { id: 'foreign-shift', tenantId: 'foreign', userId: 'foreign-staff', locationId: 'foreign-location', scheduleId: null,
                startTime: at(1), endTime: at(9), updatedAt: now, deletedAt: null }] as Row[],
        breaks: [{ id: 'old-lunch', shiftId: 'shift', type: 'LUNCH', startTime: at(4), endTime: at(4.5), paid: false },
            { id: 'foreign-break', shiftId: 'foreign-shift', type: 'LUNCH', startTime: at(4), endTime: at(4.5), paid: false }] as Row[],
        requests: [] as Row[], credits: [] as Row[], audits: [] as Row[],
    };
    type State = typeof state;
    if (options.deadline === 'stored') state.sessions[0].expiresAt = new Date(now.getTime() + 60_000);
    if (options.deadline === 'effective') {
        state.sessions[0].createdAt = new Date(now.getTime() - 4 * 60_000);
        state.settings[0].value = { security: { sessionTimeoutMinutes: 5 } };
    }
    let draft: State | undefined; let pending: string[] = []; let serial = 0;
    const attempts: string[] = [], committed: string[] = [], transactions: string[][] = [];
    const controls = { active: 0, armed: false, contexts: 0, contextAt: 1, reached: 0, unexpected: [] as string[],
        contextHook: undefined as (() => void) | undefined,
        afterClaimHook: undefined as (() => void) | undefined,
        afterClaimReady: undefined as (() => boolean) | undefined,
        commitError: undefined as unknown, commitErrorAt: 'audit.create', afterCommitHook: undefined as (() => void) | undefined,
        readHook: undefined as ((name: string) => void) | undefined,
        effectHook: undefined as ((name: string) => void) | undefined,
        roleHook: undefined as (() => void) | undefined, roleReached: 0,
        observerHook: undefined as (() => void | Promise<void>) | undefined,
        rollbackHook: undefined as (() => void) | undefined,
        effectError: undefined as unknown, effectErrorAt: '', locked: new Set<string>(), timeline: [] as string[] };
    const view = () => draft ?? state;
    const domain = () => copy({ settings: state.settings.filter(row => row.key === 'lunch_break_policy'),
        shifts: state.shifts, breaks: state.breaks, requests: state.requests, credits: state.credits,
        audits: state.audits, balances: state.tenants.map(row => ({ id: row.id, usageCredits: row.usageCredits })) });
    const effect = (name: string, mutate: (selected: State) => any) => {
        if (!draft) draft = copy(state);
        attempts.push(name); pending.push(name); const result = copy(mutate(draft));
        controls.effectHook?.(name);
        if (controls.effectError && name === controls.effectErrorAt) {
            const error = controls.effectError; controls.effectError = undefined; throw error;
        }
        return result;
    };
    const read = (name: string, value: any) => { const result = copy(value); controls.readHook?.(name); return result; };
    const changes = (row: Row, data: Row) => {
        for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
            ? row[key] + value.increment : copy(value);
    };
    const hydrate = (row: Row): Row => ({ ...row,
        user: view().users.find(user => user.id === row.userId && user.tenantId === row.tenantId) ?? null,
        schedule: view().schedules.find(schedule => schedule.id === row.scheduleId && schedule.tenantId === row.tenantId) ?? null,
        breaks: ordered(view().breaks.filter(entry => entry.shiftId === row.id), { startTime: 'asc' }) });
    const assignments = () => view().assignments.map(row => ({ ...row,
        role: view().roles.find(role => role.id === row.roleId && role.tenantId === row.tenantId) }));
    const parts = (query: any, parameters: any[]) => {
        const flatten = (values: any[]): any[] => values.flatMap(value => Array.isArray(value?.values) ? flatten(value.values) : [value]);
        return { sql: Array.isArray(query) ? query.join('?') : query.strings.join('?'),
            values: flatten(Array.isArray(query) ? parameters : parameters.length ? parameters : query.values) };
    };
    const prisma: any = {
        $transaction: vi.fn(async (work: (tx: any) => Promise<any>) => {
            expect(controls.active).toBe(0); controls.active++; controls.locked.clear(); draft = undefined; pending = [];
            let committedHere = false; let postCommit: (() => void) | undefined;
            try {
                const result = await work(prisma);
                if (draft) state = draft;
                committed.push(...pending); transactions.push(pending.slice()); committedHere = true;
                if (controls.commitError && pending.includes(controls.commitErrorAt)) {
                    const error = controls.commitError; controls.commitError = undefined;
                    postCommit = controls.afterCommitHook; controls.afterCommitHook = undefined; throw error;
                }
                return result;
            } finally {
                controls.active--; draft = undefined; pending = [];
                controls.locked.clear();
                if (!committedHere && controls.rollbackHook) { const hook = controls.rollbackHook; controls.rollbackHook = undefined; hook(); }
                if (committedHere && postCommit) { expect(controls.active).toBe(0); postCommit(); }
            }
        }),
        $executeRaw: vi.fn(async (query: any, ...parameters: any[]) => {
            const { sql, values } = parts(query, parameters);
            if (sql.includes('set_current_tenant')) {
                expect(values).toEqual([actor.tenantId]);
                if (controls.armed) {
                    controls.contexts++;
                    const hook = (controls.contexts === controls.contextAt ? controls.contextHook : undefined)
                        ?? (state.requests.some(row => row.status === 'PENDING')
                            && (controls.afterClaimReady?.() ?? true) ? controls.afterClaimHook : undefined);
                    if (hook) {
                        if (hook === controls.contextHook) controls.contextHook = undefined;
                        if (hook === controls.afterClaimHook) controls.afterClaimHook = undefined;
                        expect(draft).toBeUndefined(); expect(pending).toEqual([]); controls.reached++; hook();
                    }
                }
                return 1;
            }
            if (sql.includes('pg_advisory_xact_lock')) {
                expect(values).toEqual([`lunchlineup:scheduling:${actor.tenantId}`]); return read('scheduling.advisory', 1);
            }
            controls.unexpected.push(sql); throw new Error(`Unmodeled Lunch executeRaw ${sql}`);
        }),
        $queryRaw: vi.fn(async (query: any, ...parameters: any[]) => {
            const { sql, values } = parts(query, parameters);
            if (sql.includes('FROM "Tenant"')) {
                expect(values).toEqual([actor.tenantId]); controls.locked.add('Tenant'); return read('Tenant.lock', view().tenants.filter(row => row.id === values[0]));
            }
            if (sql.includes('FROM "User"')) {
                controls.locked.add('User');
                if (sql.includes('"role" IN')) {
                    expect(values).toEqual(['staff', actor.tenantId, 'MANAGER', 'STAFF']);
                    return copy(view().users.filter(row => row.id === values[0] && row.tenantId === values[1]
                        && ['MANAGER', 'STAFF'].includes(row.role) && !row.deletedAt && !row.suspendedAt));
                }
                expect(values[0]).toBe(actor.tenantId); expect(values.slice(1)).toEqual([...new Set(values.slice(1))].sort());
                return copy(view().users.filter(row => row.tenantId === values[0] && values.slice(1).includes(row.id) && !row.deletedAt));
            }
            if (sql.includes('FROM "Session"')) {
                controls.locked.add('Session');
                expect(values).toEqual([actor.sessionId, actor.userId]);
                return copy(view().sessions.filter(row => row.id === values[0] && row.userId === values[1]));
            }
            if (sql.includes('FROM "RoleAssignment"')) {
                controls.locked.add('RoleAssignment');
                expect(values).toEqual([actor.tenantId, actor.userId]);
                return copy(view().assignments.filter(row => row.tenantId === values[0] && row.userId === values[1]));
            }
            if (sql.includes('FROM "RolePermission"')) {
                expect(values).toEqual(['lunch-role']); controls.locked.add('RolePermission');
                if (controls.armed && controls.contexts === 2 && controls.roleHook) { const hook = controls.roleHook; controls.roleHook = undefined; controls.roleReached++; hook(); }
                return copy(view().roles.filter(row => values.includes(row.id)).flatMap(row => row.rolePermissions));
            }
            if (sql.includes('FROM "Role"')) {
                controls.locked.add('Role');
                expect(values).toEqual([actor.tenantId, 'lunch-role']); return copy(view().roles.filter(row => row.tenantId === values[0] && row.id === values[1]));
            }
            if (sql.includes('FROM "Schedule"')) {
                expect(values).toEqual([actor.tenantId, 'schedule']); return read('Schedule.lock', view().schedules.filter(row => row.tenantId === values[0] && row.id === values[1]));
            }
            if (sql.includes('FROM "Shift"')) {
                expect(values).toEqual([actor.tenantId, 'shift']); return copy(view().shifts.filter(row => row.tenantId === values[0] && row.id === values[1] && !row.deletedAt));
            }
            if (sql.includes('FROM "Break"')) {
                expect(values).toEqual(['shift']); return copy(ordered(view().breaks.filter(row => row.shiftId === values[0]), [{ startTime: 'asc' }, { id: 'asc' }]));
            }
            controls.unexpected.push(sql); throw new Error(`Unmodeled Lunch queryRaw ${sql}`);
        }),
        tenant: { findUnique: vi.fn(async ({ where }: any) => copy(view().tenants.find(row => matches(row, where)) ?? null)) },
        user: { findFirst: vi.fn(async ({ where }: any) => copy(view().users.find(row => matches(row, where)) ?? null)) },
        session: { findFirst: vi.fn(async ({ where }: any) => copy(view().sessions.find(row => matches(row, where)) ?? null)) },
        roleAssignment: { findMany: vi.fn(async ({ where, orderBy }: any) => copy(ordered(assignments().filter(row => matches(row, where)), orderBy))) },
        tenantSetting: {
            findUnique: vi.fn(async ({ where }: any) => read(where.tenantId_key.key === 'lunch_break_policy' ? 'policy.read' : 'security.read', view().settings.find(row => matches(row, where)) ?? null)),
            upsert: vi.fn(async ({ where, create, update }: any) => effect('policy.upsert', selected => {
                expect(where.tenantId_key).toEqual({ tenantId: actor.tenantId, key: 'lunch_break_policy' });
                let row = selected.settings.find(row => matches(row, where));
                if (row) changes(row, update); else { row = copy(create); selected.settings.push(row!); }
                return row;
            })),
        },
        location: { findFirst: vi.fn(async ({ where }: any) => read('location.read', view().locations.find(row => matches(row, where)) ?? null)) },
        shift: {
            findMany: vi.fn(async ({ where, orderBy, take, select }: any) => read(select?.userId && Object.keys(select).length === 1 ? 'target.discovery' : 'shift.list', ordered(view().shifts.map(hydrate).filter(row => matches(row, where)), orderBy).slice(0, take))),
            findFirst: vi.fn(async ({ where }: any) => read('shift.detail', view().shifts.map(hydrate).find(row => matches(row, where)) ?? null)),
            count: vi.fn(async ({ where }: any) => view().shifts.map(hydrate).filter(row => matches(row, where)).length),
            updateMany: vi.fn(async ({ where, data }: any) => effect('shift.update', selected => {
                const rows = selected.shifts.filter(row => matches(row, where)); for (const row of rows) changes(row, data); return { count: rows.length };
            })),
            create: vi.fn(async ({ data }: any) => effect('shift.create', selected => {
                expect(data.tenantId).toBe(actor.tenantId); const row = { id: `created-${++serial}`, scheduleId: null, deletedAt: null, updatedAt: new Date(), ...copy(data) };
                selected.shifts.push(row); return row;
            })),
        },
        schedule: { updateMany: vi.fn(async ({ where, data }: any) => effect('schedule.revision', selected => {
            const rows = selected.schedules.filter(row => matches(row, where)); for (const row of rows) changes(row, data); return { count: rows.length };
        })) },
        break: {
            deleteMany: vi.fn(async ({ where }: any) => effect('break.delete', selected => {
                const count = selected.breaks.filter(row => matches(row, where)).length;
                selected.breaks = selected.breaks.filter(row => !matches(row, where)); return { count };
            })),
            createMany: vi.fn(async ({ data }: any) => effect('break.create', selected => {
                for (const entry of data) { expect(entry.shiftId).toBe('shift'); selected.breaks.push({ id: `break-${++serial}`, ...copy(entry) }); }
                return { count: data.length };
            })),
            updateMany: vi.fn(async ({ where, data }: any) => effect('break.translate', selected => {
                const rows = selected.breaks.filter(row => matches(row, where)); for (const row of rows) changes(row, data); return { count: rows.length };
            })),
        },
        lunchBreakGenerationRequest: {
            findUnique: vi.fn(async ({ where }: any) => read('generation.receipt', view().requests.find(row => matches(row, where)) ?? null)),
            upsert: vi.fn(async ({ where, create }: any) => {
                const prior = view().requests.find(row => matches(row, where)); if (prior) return read('generation.receipt', prior);
                return effect('generation.claim', selected => {
                    expect(create.tenantId).toBe(actor.tenantId);
                    const row = { response: null, failureStatus: null, failureMessage: null, completedAt: null, ...copy(create) };
                    selected.requests.push(row); return row;
                });
            }),
            updateMany: vi.fn(async ({ where, data }: any) => effect(data.status === 'FAILED' ? 'generation.fail' : 'generation.fence', selected => {
                const rows = selected.requests.filter(row => matches(row, where)); for (const row of rows) changes(row, data); return { count: rows.length };
            })),
            update: vi.fn(async ({ where, data }: any) => effect('generation.complete', selected => {
                const row = selected.requests.find(row => matches(row, where)); if (!row) throw new Error('Scoped generation row absent');
                changes(row, data); return row;
            })),
        },
        auditLog: {
            findFirst: vi.fn(async ({ where, orderBy }: any) => read(where.resource === 'LunchBreakSetupShiftsSemanticRequest' ? 'audit.semanticReceipt' : 'audit.receipt', ordered(view().audits.filter(row => matches(row, where)), orderBy)[0] ?? null)),
            create: vi.fn(async ({ data }: any) => effect('audit.create', selected => {
                expect(data.tenantId).toBe(actor.tenantId); expect(data.actorUserId).toBe(actor.userId);
                const row = { id: `audit-${++serial}`, createdAt: new Date(), ...copy(data) }; selected.audits.push(row); return row;
            })),
        },
    };
    const tenantDb = new TenantPrismaService(prisma); const rbac = new RbacService(tenantDb);
    const proof: MfaVerificationObservation = { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId,
        expiresAtEpochMs: now.getTime() + (options.deadline === 'mfa_wall' ? 60_000 : 3_600_000),
        expiresAtMonotonicMs: monotonic + (options.deadline === 'mfa_monotonic' ? 60_000 : 3_600_000) };
    const observer = { observeSessionMfa: vi.fn(async (identity: MfaSessionIdentity): Promise<MfaVerificationObservation | null> => {
        expect(controls.active).toBe(0); expect(identity).toEqual({ sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId });
        await controls.observerHook?.();
        return { sub: identity.sub, tenantId: identity.tenantId, sessionId: identity.sessionId,
            expiresAtEpochMs: proof.expiresAtEpochMs, expiresAtMonotonicMs: proof.expiresAtMonotonicMs };
    }) };
    const resolution = { enabled: true, source: 'credits', creditCost: 2, reason: 'Explicit modeled paid plan' };
    const feature: any = {
        assertFeatureEntitled: vi.fn((tenantId: string, key: string) => tenantDb.withTenant(tenantId,
            tx => feature.assertFeatureEntitledInTransaction(tx, tenantId, key))),
        lockTenantInTransaction: vi.fn(async (tx: any, tenantId: string) => {
            expect(tenantId).toBe(actor.tenantId); await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
        }),
        assertFeatureEntitledInTransaction: vi.fn(async (tx: any, tenantId: string, key: string) => {
            expect(['lunch_breaks', 'scheduling']).toContain(key); await feature.lockTenantInTransaction(tx, tenantId);
            if (view().tenants[0].status !== 'ACTIVE') throw new ForbiddenException('Modeled paid entitlement absent');
            return copy(resolution);
        }),
        assertFeatureEnabledInTransaction: vi.fn(async (tx: any, tenantId: string, key: string) => feature.assertFeatureEntitledInTransaction(tx, tenantId, key)),
        recordFeatureUsageInTransaction: vi.fn(async (_tx: any, tenantId: string, admitted: Row, reason: string,
            operationId: string, transactionId?: string, guard?: () => void) => {
            expect(tenantId).toBe(actor.tenantId); expect(admitted).toEqual(resolution); expect(operationId).toBeTruthy();
            guard?.();
            const prior = view().credits.find(row => row.id === (transactionId ?? operationId));
            if (prior) return { consumedCredits: 2, newBalance: prior.balanceAfter };
            if (view().tenants[0].usageCredits < 2) throw new ForbiddenException('Modeled insufficient purchased credits');
            const result = effect('credit.debit', selected => {
                const tenant = selected.tenants.find(row => row.id === tenantId)!; tenant.usageCredits -= 2;
                selected.credits.push({ id: transactionId ?? operationId, tenantId, amount: -2, reason, balanceAfter: tenant.usageCredits });
                return { consumedCredits: 2, newBalance: tenant.usageCredits };
            }); guard?.(); return result;
        }),
    };
    // Actual Rbac and trusted observer dependencies. The same extra arguments
    // were inert on the preserved original owner in the paired baseline.
    const service: LunchBreaksService = new (LunchBreaksService as any)(feature, tenantDb, rbac, observer);
    const controller = new LunchBreaksController(service);
    const request = { user: { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId,
        role: 'MANAGER', legacyRole: 'MANAGER', permissions: permissions.slice() } };
    const replacement = { locationId: 'location', breaks: [{ type: 'lunch' as const, startTime: at(5).toISOString(), durationMinutes: 30 }] };
    const setup: PersistSetupShiftsRequest = { locationId: 'location', rows: [{ shiftId: 'shift', userId: 'staff', startTime: at(2).toISOString(), endTime: at(10).toISOString() }] };
    const generation = { locationId: 'location', shiftIds: ['shift'], persist: true };
    const invoke = (command: Command, key?: string) => {
        if (command === 'list') return controller.list(request, undefined, 'location', 'shift', undefined, undefined, '10');
        if (command === 'getPolicy') return controller.getPolicy(request);
        if (command === 'updatePolicy') return controller.updatePolicy(request, { lunchDurationMinutes: 45 });
        if (command === 'generate') return controller.generate(request, generation, key ?? 'generation-attempt');
        if (command === 'setup') return controller.persistSetupShifts(request, setup, key ?? 'setup-attempt');
        return controller.updateShiftBreaks(request, 'shift', replacement, key ?? 'replace-attempt');
    };
    const verifyStartingAuthority = async (command: Command) => {
        const required = command === 'list' || command === 'getPolicy' ? 'lunch_breaks:read' : 'lunch_breaks:write';
        await rbac.runCurrentMutation({ actor, requiredPermission: required, mfaObserver: observer },
            (tx, current) => rbac.authorizeActorMutationInTransaction(tx, current, required),
            async () => 'verified');
        if (command === 'setup') await tenantDb.withTenant(actor.tenantId, tx => rbac.authorizeActorMutationInTransaction(tx, actor, 'shifts:write', ['staff']));
        expect(observer.observeSessionMfa).toHaveBeenCalledTimes(state.users[0].mfaEnabled ? 1 : 0);
        expect(controls.active).toBe(0); expect(attempts).toEqual([]); expect(committed).toEqual([]);
        observer.observeSessionMfa.mockClear(); controls.armed = true; controls.contexts = 0;
    };
    const revoke = () => { state.sessions.find(row => row.id === actor.sessionId)!.revokedAt = new Date(); };
    const expire = () => { if (options.deadline === 'mfa_monotonic') monotonic += 60_000; else vi.setSystemTime(new Date(now.getTime() + 60_000)); };
    const expectClean = () => { expect(controls.unexpected).toEqual([]); expect(controls.active).toBe(0); };
    return { invoke, verifyStartingAuthority, request, state: () => state, domain, controls,
        attempts, committed, transactions, revoke, expectClean, controller, replacement, setup, expire, observer, proof };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Retained LunchBreak current authority local owner baseline', () => {
    for (const command of commands) {
        it(`${command}: valid exact-session owner preserves scoped paid/domain outcome`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command); const before = f.domain();
            const result: any = await f.invoke(command); f.expectClean();
            expect(f.state().sessions.find(row => row.id === 'other-live-session')!.revokedAt).toBeNull();
            expect(f.state().tenants.find(row => row.id === 'foreign')!.usageCredits).toBe(99);
            expect(f.state().breaks.find(row => row.id === 'foreign-break')).toEqual(before.breaks.find(row => row.id === 'foreign-break'));
            if (command === 'list') { expect(result.data.map((row: Row) => row.shiftId)).toEqual(['shift']); expect(f.committed).toEqual([]); }
            if (command === 'getPolicy') { expect(result.lunchDurationMinutes).toBe(30); expect(f.committed).toEqual([]); }
            if (command === 'updatePolicy') { expect(result.lunchDurationMinutes).toBe(45); expect(f.committed).toEqual(['policy.upsert']); }
            if (command === 'generate') {
                expect(result.persisted).toBe(true); expect(result.reused).toBe(false); expect(result.creditConsumption).toEqual({ consumedCredits: 2, newBalance: 8, source: 'credits' });
                expect(result.data[0].breaks).toHaveLength(3); expect(f.state().requests[0].status).toBe('SUCCEEDED');
                expect(f.committed).toEqual(['generation.claim', 'generation.fence', 'credit.debit', 'break.delete', 'break.create', 'shift.update', 'schedule.revision', 'generation.complete']);
                expect(f.transactions.find(row => row.includes('credit.debit'))).toEqual(f.committed.slice(1));
            }
            if (command === 'setup') {
                expect(result.shiftIds).toEqual(['shift']); expect(f.state().shifts.find(row => row.id === 'shift')!.startTime.toISOString()).toBe('2026-10-04T10:00:00.000Z');
                expect(f.state().breaks.find(row => row.id === 'old-lunch')!.startTime.toISOString()).toBe('2026-10-04T13:00:00.000Z');
                expect(f.committed).toEqual(['credit.debit', 'shift.update', 'break.translate', 'schedule.revision', 'audit.create']);
            }
            if (command === 'replace') {
                expect(result.breaks).toEqual([{ type: 'lunch', startTime: '2026-10-04T13:00:00.000Z', endTime: '2026-10-04T13:30:00.000Z', durationMinutes: 30, paid: false }]);
                expect(f.committed).toEqual(['credit.debit', 'break.delete', 'break.create', 'schedule.revision', 'audit.create']);
            }
            if (['setup', 'replace'].includes(command)) { expect(f.state().credits).toHaveLength(1); expect(f.state().tenants[0].usageCredits).toBe(8); expect(f.state().schedules[0].revision).toBe(2); }
        });
        it(`${command}: writer-first exact-session revocation after valid request refuses without new domain effects`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command); const before = f.domain();
            f.controls.contextHook = f.revoke;
            await expect(f.invoke(command)).rejects.toBeInstanceOf(ForbiddenException);
            expect(f.controls.reached).toBe(1); expect(f.committed).toEqual([]); expect(f.attempts).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const command of ['generate', 'setup', 'replace'] as const) {
        it(`${command}: exact receipt replay after domain eligibility loss preserves receipt and never recharges`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command); const first: any = await f.invoke(command);
            const before = f.domain(); const effects = f.committed.slice();
            f.state().locations[0].deletedAt = new Date(); f.state().users.find(row => row.id === 'staff')!.suspendedAt = new Date();
            if (command === 'generate') {
                // Existing generation performs active-location/shift-count
                // validation before claim lookup. Keep those preconditions
                // viable and test loss of mutation eligibility at the receipt.
                f.state().locations[0].deletedAt = null;
                f.state().schedules[0].status = 'PUBLISHED';
            }
            const replay: any = await f.invoke(command);
            expect(replay).toEqual(command === 'generate' ? { ...first, reused: true } : first);
            expect(f.committed).toEqual(effects); expect(f.state().credits).toEqual(before.credits); expect(f.state().requests).toEqual(before.requests); f.expectClean();
        });
        it(`${command}: valid settled receipt cannot bypass writer-first revoked exact session`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command); await f.invoke(command);
            const before = f.domain(); const effects = f.committed.slice(); f.controls.contextAt = f.controls.contexts + 1; f.controls.contextHook = f.revoke;
            await expect(f.invoke(command)).rejects.toBeInstanceOf(ForbiddenException);
            expect(f.controls.reached).toBe(1); expect(f.committed).toEqual(effects); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const revoked of [false, true]) {
        it(`replace: semantic noop ${revoked ? 'refuses revoked session' : 'preserves current response without debit or receipt writes'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority('replace');
            f.replacement.breaks[0].startTime = '2026-10-04T12:00:00.000Z';
            const before = f.domain(); if (revoked) f.controls.contextHook = f.revoke;
            if (revoked) await expect(f.invoke('replace')).rejects.toBeInstanceOf(ForbiddenException);
            else { const result: any = await f.invoke('replace'); expect(result.breaks[0].startTime).toBe('2026-10-04T12:00:00.000Z'); }
            expect(f.committed).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const revoked of [false, true]) {
        it(`generate: separate committed PENDING claim ${revoked ? 'then writer-first revocation prevents debit and persistence' : 'then authorized completion retains atomic debit and persistence'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority('generate');
            f.controls.afterClaimHook = revoked ? f.revoke : () => { expect(f.state().requests[0].status).toBe('PENDING'); expect(f.state().credits).toEqual([]); };
            if (revoked) {
                await expect(f.invoke('generate')).rejects.toBeInstanceOf(ForbiddenException);
                expect(f.state().requests[0].status).toBe('FAILED');
                expect(f.state().requests[0].failureStatus).toBe(403);
                expect(f.committed).toEqual(['generation.claim', 'generation.fail']);
                expect(f.state().credits).toEqual([]); expect(f.state().tenants[0].usageCredits).toBe(10);
                expect(f.state().breaks.find(row => row.id === 'old-lunch')).toBeDefined(); expect(f.state().schedules[0].revision).toBe(1);
            } else { await f.invoke('generate'); expect(f.state().requests[0].status).toBe('SUCCEEDED'); expect(f.state().credits).toHaveLength(1); }
            expect(f.controls.reached).toBe(1); f.expectClean();
        });
    }
    for (const revoked of [false, true]) {
        it(`replace: modeled commit-before-ack P2028 ${revoked ? 'requires fresh recovery authority and keeps settled effects' : 'returns exact settled receipt without a second charge'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority('replace');
            f.controls.commitError = Object.assign(new Error('Modeled driver acknowledgement loss'), { code: 'P2028' });
            if (revoked) f.controls.afterCommitHook = f.revoke;
            if (revoked) await expect(f.invoke('replace')).rejects.toBeInstanceOf(ForbiddenException);
            else { const result: any = await f.invoke('replace'); expect(result.shiftId).toBe('shift'); expect(result.breaks[0].startTime).toBe('2026-10-04T13:00:00.000Z'); }
            expect(f.state().credits).toHaveLength(1); expect(f.state().audits).toHaveLength(1); expect(f.state().tenants[0].usageCredits).toBe(8);
            expect(f.committed).toEqual(['credit.debit', 'break.delete', 'break.create', 'schedule.revision', 'audit.create']); f.expectClean();
        });
    }
    it('replace: published schedule remains denied without debit or effects for a valid current actor', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace'); f.state().schedules[0].status = 'PUBLISHED'; const before = f.domain();
        await expect(f.invoke('replace')).rejects.toThrow('Published schedules'); expect(f.committed).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
    });
    it('replace: insufficient purchased credits preserves existing breaks and draft revision', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace'); f.state().tenants[0].usageCredits = 1; const before = f.domain();
        await expect(f.invoke('replace')).rejects.toBeInstanceOf(ForbiddenException); expect(f.committed).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
    });
});

const reachedEffects: Partial<Record<Command, string[]>> = {
    updatePolicy: ['policy.upsert'],
    generate: ['generation.claim', 'generation.fence', 'credit.debit', 'break.delete', 'break.create', 'shift.update', 'schedule.revision', 'generation.complete'],
    setup: ['credit.debit', 'shift.update', 'break.translate', 'schedule.revision', 'audit.create'],
    replace: ['credit.debit', 'break.delete', 'break.create', 'schedule.revision', 'audit.create'],
};
const deadlines: Deadline[] = ['stored', 'effective', 'mfa_wall', 'mfa_monotonic'];
const refusalMessage = (deadline: Deadline) => deadline.startsWith('mfa')
    ? 'MFA verification required before continuing' : 'Administrator session is no longer active';

describe('Retained LunchBreak fresh phases and independent lifetime controls', () => {
    for (const command of commands) {
        for (const axis of ['grant', 'pin', 'suspension', 'tenant', 'new_mfa_policy'] as const) {
            it(`${command}: released observation/final-entry ${axis} change refuses current authority`, async () => {
                const f = fixture();
                if (axis === 'new_mfa_policy') f.state().users[0].mfaEnabled = false;
                await f.verifyStartingAuthority(command); const before = f.domain();
                const change = () => {
                    if (axis === 'grant') f.state().roles[0].rolePermissions = [];
                    if (axis === 'pin') f.state().users[0].pinResetRequired = true;
                    if (axis === 'suspension') f.state().users[0].suspendedAt = new Date();
                    if (axis === 'tenant') f.state().tenants[0].status = 'SUSPENDED';
                    if (axis === 'new_mfa_policy') f.state().settings[0].value.security.requireMfaForAll = true;
                };
                if (axis === 'new_mfa_policy') {
                    // The policy changes only AFTER the originally non-MFA
                    // owner preflight has released and returned no proof.
                    f.controls.contextAt = 2; f.controls.contextHook = change;
                } else f.controls.observerHook = () => { expect(f.controls.active).toBe(0); f.controls.reached++; change(); };
                await expect(f.invoke(command)).rejects.toBeInstanceOf(ForbiddenException);
                expect(f.controls.reached).toBe(1); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]);
                expect(f.domain()).toEqual(before); f.expectClean();
            });
        }
        for (const deadline of deadlines) {
            it(`${command}: ${deadline} expires at exact first final RolePermission await`, async () => {
                const f = fixture({ deadline }); await f.verifyStartingAuthority(command); const before = f.domain();
                f.controls.roleHook = f.expire;
                await expect(f.invoke(command)).rejects.toMatchObject({ message: refusalMessage(deadline) });
                expect(f.controls.roleReached).toBe(1); expect(f.attempts).toEqual([]); expect(f.committed).toEqual([]);
                expect(f.domain()).toEqual(before); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1); f.expectClean();
            });
        }
    }
    for (const [command, effects] of Object.entries(reachedEffects) as [Command, string[]][]) {
        // Each reached effect has a distinct causal rollback prefix. Clock
        // axes are independently covered at all six final authority waits;
        // do not duplicate every effect across the same four guards.
        for (const name of effects) for (const deadline of ['effective'] as const) {
            it(`${command}: ${deadline} at completed ${name} retains attempted prefix and rolls back phase`, async () => {
                const f = fixture({ deadline }); await f.verifyStartingAuthority(command); const before = f.domain(); let reached = 0;
                f.controls.effectHook = effect => { if (effect === name && !reached) { reached++; f.expire(); } };
                await expect(f.invoke(command)).rejects.toMatchObject({ message: refusalMessage(deadline) });
                expect(reached).toBe(1); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
                const prefix = effects.slice(0, effects.indexOf(name) + 1);
                if (command === 'generate' && name !== 'generation.claim') {
                    expect(f.attempts).toEqual([...prefix, 'generation.fail']);
                    expect(f.committed).toEqual(['generation.claim', 'generation.fail']);
                    const after = f.domain();
                    expect(after.credits).toEqual(before.credits); expect(after.breaks).toEqual(before.breaks);
                    expect(after.shifts).toEqual(before.shifts); expect(after.balances).toEqual(before.balances);
                    expect(f.state().requests[0].status).toBe('FAILED'); expect(f.state().requests[0].failureStatus).toBe(403);
                } else {
                    expect(f.attempts).toEqual(prefix); expect(f.committed).toEqual([]); expect(f.domain()).toEqual(before);
                }
                f.expectClean();
            });
        }
    }
    for (const command of ['list', 'getPolicy', 'replace'] as const) for (const deadline of deadlines) {
        it(`${command}: ${deadline} after final domain response read refuses disclosure or next effects`, async () => {
            const f = fixture({ deadline }); await f.verifyStartingAuthority(command); const before = f.domain();
            let reads = 0, reached = 0;
            const target = command === 'list' ? 'shift.list' : command === 'getPolicy' ? 'policy.read' : 'shift.detail';
            f.controls.readHook = name => { if (name === target && ++reads === (command === 'replace' ? 2 : 1)) { reached++; f.expire(); } };
            await expect(f.invoke(command)).rejects.toMatchObject({ message: refusalMessage(deadline) });
            expect(reached).toBe(1); expect(f.committed).toEqual([]); expect(f.domain()).toEqual(before);
            if (command === 'replace') expect(f.attempts).toEqual(['credit.debit', 'break.delete', 'break.create', 'schedule.revision']);
            else expect(f.attempts).toEqual([]);
            f.expectClean();
        });
    }
    for (const command of ['generate', 'setup', 'replace'] as const) for (const deadline of deadlines) {
        it(`${command}: settled exact receipt read still enforces ${deadline} without changing prior financial effects`, async () => {
            const f = fixture({ deadline }); await f.verifyStartingAuthority(command); await f.invoke(command);
            const before = f.domain(); const effects = f.committed.slice(); let reached = 0;
            f.controls.readHook = name => { if ((command === 'generate' ? name === 'generation.receipt' : name === 'audit.receipt') && !reached) { reached++; f.expire(); } };
            await expect(f.invoke(command)).rejects.toMatchObject({ message: refusalMessage(deadline) });
            expect(reached).toBe(1); expect(f.committed).toEqual(effects); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const command of ['generate', 'setup', 'replace'] as const) for (const revokeOnRetry of [false, true]) {
        it(`${command}: P2034 ${revokeOnRetry ? 'retry rereads revoked session' : 'retry reuses one proof and commits one debit'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command);
            f.controls.effectErrorAt = 'credit.debit'; f.controls.effectError = Object.assign(new Error('Modeled serialization'), { code: 'P2034' });
            if (revokeOnRetry) f.controls.rollbackHook = f.revoke;
            if (revokeOnRetry) {
                await expect(f.invoke(command)).rejects.toThrow('Administrator session is no longer active');
                expect(f.state().credits).toEqual([]); expect(f.state().tenants[0].usageCredits).toBe(10);
                expect(f.committed).toEqual(command === 'generate' ? ['generation.claim', 'generation.fail'] : []);
            } else { await f.invoke(command); expect(f.state().credits).toHaveLength(1); expect(f.state().tenants[0].usageCredits).toBe(8); }
            expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1); f.expectClean();
        });
    }
    for (const command of ['generate', 'setup', 'replace'] as const) {
        it(`${command}: arbitrary error after modeled committed receipt is not converted to successful recovery`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command);
            const error = new Error('Unknown programming failure');
            f.controls.commitError = error;
            if (command === 'generate') f.controls.commitErrorAt = 'generation.complete';
            await expect(f.invoke(command)).rejects.toBe(error);
            if (command === 'generate') { expect(f.state().credits).toHaveLength(1); expect(f.state().requests[0].status).toBe('SUCCEEDED'); }
            else { expect(f.state().credits).toHaveLength(1); expect(f.state().audits).toHaveLength(1); }
            f.expectClean();
        });
    }
    for (const error of [Object.assign(new Error('Coercible driver code'), { code: { toString: () => 'P2002' } }),
        Object.assign(new Error('Coercible SQLSTATE'), { code: 'P2010', meta: { code: { toString: () => '55P03' } } })]) {
        it(`${error.message}: present receipt never authorizes unknown error recovery`, async () => {
            const f = fixture(); await f.verifyStartingAuthority('replace'); f.controls.commitError = error;
            await expect(f.invoke('replace')).rejects.toBe(error); expect(f.state().credits).toHaveLength(1); expect(f.state().audits).toHaveLength(1); f.expectClean();
        });
    }
    it('setup: current shifts write grant is independently mandatory before any receipt or mutation', async () => {
        const f = fixture(); await f.verifyStartingAuthority('setup'); const before = f.domain();
        f.controls.observerHook = () => { f.state().roles[0].rolePermissions = f.state().roles[0].rolePermissions.filter((row: Row) => row.permission.key !== 'shifts:write'); };
        await expect(f.invoke('setup')).rejects.toThrow('shifts:write permission is no longer active');
        expect(f.domain()).toEqual(before); expect(f.attempts).toEqual([]); f.expectClean();
    });
    for (const command of ['generate', 'setup'] as const) for (const revoked of [false, true]) {
        it(`${command}: committed P2028 ${revoked ? 'denies fresh receipt disclosure after revocation' : 'recovers immutable receipt without another debit'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command);
            f.controls.commitError = Object.assign(new Error('Modeled committed acknowledgement loss'), { code: 'P2028' });
            if (command === 'generate') f.controls.commitErrorAt = 'generation.complete';
            if (revoked) f.controls.afterCommitHook = f.revoke;
            if (revoked) await expect(f.invoke(command)).rejects.toThrow('Administrator session is no longer active');
            else { const result: any = await f.invoke(command); expect(command === 'generate' ? result.reused : result.shiftIds[0]).toBe(command === 'generate' ? true : 'shift'); }
            expect(f.state().credits).toHaveLength(1); expect(f.state().tenants[0].usageCredits).toBe(8);
            if (command === 'generate') expect(f.state().requests[0].status).toBe('SUCCEEDED');
            else expect(f.state().audits).toHaveLength(1);
            expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1); f.expectClean();
        });
    }
    it('original effective preflight deadline remains a request cap after an outside timeout extension', async () => {
        const f = fixture({ deadline: 'effective' }); await f.verifyStartingAuthority('replace');
        f.controls.observerHook = () => { f.state().settings[0].value.security.sessionTimeoutMinutes = 480; };
        f.controls.effectHook = name => { if (name === 'credit.debit') f.expire(); };
        await expect(f.invoke('replace')).rejects.toThrow('Administrator session is no longer active');
        expect(f.state().credits).toEqual([]); expect(f.state().tenants[0].usageCredits).toBe(10); f.expectClean();
    });
    for (const command of ['setup', 'replace'] as const) for (const deadline of ['mfa_wall', 'mfa_monotonic'] as const) {
        it(`${command}: nested debit ${deadline} refusal preserves MFA intent rather than credit remediation`, async () => {
            const f = fixture({ deadline }); await f.verifyStartingAuthority(command); const before = f.domain(); let reached = 0;
            f.controls.effectHook = name => { if (name === 'credit.debit') { reached++; f.expire(); } };
            const failure = await f.invoke(command).catch(error => error);
            expect(failure).toBeInstanceOf(ForbiddenException); expect(failure.message).toBe('MFA verification required before continuing');
            expect(failure.getResponse()).not.toMatchObject({ code: expect.stringContaining('ENTITLEMENT') });
            expect(reached).toBe(1); expect(f.domain()).toEqual(before); expect(f.committed).toEqual([]); f.expectClean();
        });
    }
    it('captured trusted observer method remains bound before preflight awaits', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace');
        const old = f.observer.observeSessionMfa;
        f.controls.contextHook = () => { f.observer.observeSessionMfa = vi.fn(async () => { throw new Error('Replaced observer must not run'); }); };
        await f.invoke('replace'); expect(old).toHaveBeenCalledTimes(1); expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); f.expectClean();
    });
    it('request payload and exact actor custody survive outside observation mutation', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace');
        f.controls.observerHook = () => { f.replacement.breaks[0].startTime = '2026-10-04T14:00:00.000Z'; f.request.user.sessionId = 'other-live-session'; };
        const result: any = await f.invoke('replace'); expect(result.breaks[0].startTime).toBe('2026-10-04T13:00:00.000Z');
        expect(f.state().credits).toHaveLength(1); f.expectClean();
    });
    for (const currentRole of ['STAFF', 'MANAGER'] as const) {
        it(`list: locked current ${currentRole} role controls own-published versus team scope independently of JWT`, async () => {
            const f = fixture(); f.state().users[0].role = currentRole;
            f.request.user.role = currentRole === 'STAFF' ? 'MANAGER' : 'STAFF'; f.request.user.legacyRole = f.request.user.role;
            f.state().schedules[0].status = 'PUBLISHED';
            f.state().shifts.push({ ...copy(f.state().shifts[0]), id: 'own-shift', userId: actor.userId });
            await f.verifyStartingAuthority('list');
            const result = await f.controller.list(f.request, undefined, 'location', undefined, undefined, undefined, '10');
            expect(result.data.map(row => row.shiftId).sort()).toEqual(currentRole === 'STAFF' ? ['own-shift'] : ['own-shift', 'shift']);
            expect(f.committed).toEqual([]); f.expectClean();
        });
    }
    for (const revoked of [false, true]) {
        it(`setup: different-key semantic receipt ${revoked ? 'requires fresh exact-session authority' : 'preserves one unassigned shift and one debit'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority('setup');
            f.setup.rows = [{ userId: null, startTime: '2026-10-04T19:00:00.000Z', endTime: '2026-10-04T21:00:00.000Z' }];
            const first: any = await f.invoke('setup', 'first-semantic-key');
            expect(f.committed).toEqual(['credit.debit', 'shift.create', 'audit.create', 'audit.create']);
            expect(f.state().audits.map(row => row.resource)).toEqual(['LunchBreakSetupShiftsRequest', 'LunchBreakSetupShiftsSemanticRequest']);
            const before = f.domain(); const effects = f.committed.slice();
            f.state().locations[0].deletedAt = new Date();
            if (revoked) { f.controls.contextAt = f.controls.contexts + 1; f.controls.contextHook = f.revoke; }
            if (revoked) await expect(f.invoke('setup', 'second-semantic-key')).rejects.toThrow('Administrator session is no longer active');
            else expect(await f.invoke('setup', 'second-semantic-key')).toEqual(first);
            expect(f.committed).toEqual(effects); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const deadline of ['effective', 'mfa_monotonic'] as const) {
        it(`setup: ${deadline} at semantic receipt read prevents stale result without changing prior settled state`, async () => {
            const f = fixture({ deadline }); await f.verifyStartingAuthority('setup');
            f.setup.rows = [{ userId: null, startTime: '2026-10-04T19:00:00.000Z', endTime: '2026-10-04T21:00:00.000Z' }];
            await f.invoke('setup', 'first-semantic-key'); const before = f.domain(); const effects = f.committed.slice(); let reached = 0;
            f.controls.readHook = name => { if (name === 'audit.semanticReceipt') { reached++; f.expire(); } };
            await expect(f.invoke('setup', 'second-semantic-key')).rejects.toMatchObject({ message: refusalMessage(deadline) });
            expect(reached).toBe(1); expect(f.domain()).toEqual(before); expect(f.committed).toEqual(effects); f.expectClean();
        });
        it(`replace: ${deadline} at semantic noop domain read refuses without debit or audit`, async () => {
            const f = fixture({ deadline }); await f.verifyStartingAuthority('replace'); f.replacement.breaks[0].startTime = '2026-10-04T12:00:00.000Z';
            const before = f.domain(); let reached = 0;
            f.controls.readHook = name => { if (name === 'shift.detail') { reached++; f.expire(); } };
            await expect(f.invoke('replace')).rejects.toMatchObject({ message: refusalMessage(deadline) });
            expect(reached).toBe(1); expect(f.attempts).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const command of commands) {
        it(`${command}: missing exact session never enters owner DB or trusted observation`, async () => {
            const f = fixture(); await f.verifyStartingAuthority(command); f.request.user.sessionId = '';
            await expect(f.invoke(command)).rejects.toThrow('A live administrator identity and session are required');
            expect(f.controls.contexts).toBe(0); expect(f.observer.observeSessionMfa).not.toHaveBeenCalled(); expect(f.attempts).toEqual([]); f.expectClean();
        });
    }
    for (const command of ['generate', 'setup', 'replace'] as const) {
        it(`${command}: effective lifetime at actual held domain lock prevents new debit and domain effects`, async () => {
            const f = fixture({ deadline: 'effective' }); await f.verifyStartingAuthority(command); let reached = 0;
            f.controls.readHook = name => {
                if (name === (command === 'generate' ? 'Schedule.lock' : 'scheduling.advisory') && !reached) { reached++; f.expire(); }
            };
            await expect(f.invoke(command)).rejects.toThrow('Administrator session is no longer active');
            expect(reached).toBe(1); expect(f.state().credits).toEqual([]); expect(f.state().tenants[0].usageCredits).toBe(10);
            expect(f.state().shifts.find(row => row.id === 'shift')!.startTime.toISOString()).toBe('2026-10-04T09:00:00.000Z');
            expect(f.state().breaks.find(row => row.id === 'old-lunch')).toBeDefined(); expect(f.state().schedules[0].revision).toBe(1);
            expect(f.committed).toEqual(command === 'generate' ? ['generation.claim', 'generation.fail'] : []); f.expectClean();
        });
    }
    for (const boundary of ['shift.create', 'second.audit'] as const) {
        it(`setup: effective expiry after unassigned ${boundary} rolls back new shift, both receipts and debit`, async () => {
            const f = fixture({ deadline: 'effective' }); await f.verifyStartingAuthority('setup');
            f.setup.rows = [{ userId: null, startTime: '2026-10-04T19:00:00.000Z', endTime: '2026-10-04T21:00:00.000Z' }];
            const before = f.domain(); let audits = 0, reached = 0;
            f.controls.effectHook = name => {
                if (name === 'audit.create') audits++;
                if ((boundary === 'shift.create' && name === 'shift.create') || (boundary === 'second.audit' && name === 'audit.create' && audits === 2)) { reached++; f.expire(); }
            };
            await expect(f.invoke('setup')).rejects.toThrow('Administrator session is no longer active');
            expect(reached).toBe(1); expect(f.attempts).toEqual(boundary === 'shift.create'
                ? ['credit.debit', 'shift.create'] : ['credit.debit', 'shift.create', 'audit.create', 'audit.create']);
            expect(f.committed).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
        });
    }
    for (const revoked of [false, true]) {
        it(`generation owned claim CAS miss ${revoked ? 'refuses revoked recovery and preserves winner receipt' : 'returns actual settled same-hash winner without a second debit'}`, async () => {
            const f = fixture(); await f.verifyStartingAuthority('generate');
            const winner = await f.invoke('generate'); const before = f.domain();
            const receipt = copy(f.state().requests[0]);
            f.state().requests[0].status = 'PENDING'; f.state().requests[0].claimToken = 'expired-other-claim';
            f.state().requests[0].claimExpiresAt = new Date(Date.now() - 1);
            let releasedClaim = 0;
            f.controls.afterClaimReady = () => {
                const current = f.state().requests[0];
                return current.status === 'PENDING' && current.attempts === receipt.attempts + 1
                    && typeof current.claimToken === 'string' && current.claimToken !== 'expired-other-claim'
                    && current.claimExpiresAt instanceof Date && current.claimExpiresAt.getTime() > Date.now();
            };
            f.controls.afterClaimHook = () => {
                // The new token/attempt increment is committed and the claim TX
                // is released. Seeded old PENDING cannot trigger this at preflight.
                expect(f.controls.afterClaimReady!()).toBe(true);
                expect(f.controls.locked.size).toBe(0);
                releasedClaim++;
                // A modeled peer's committed same-hash winner becomes visible
                // before the next authority fences, without another modeled debit.
                f.state().requests[0] = { ...copy(receipt), attempts: f.state().requests[0].attempts };
            };
            let casMiss = 0;
            f.controls.effectHook = name => {
                if (name === 'generation.fence' && f.state().requests[0].status === 'SUCCEEDED') {
                    casMiss++;
                    if (revoked) { f.controls.contextAt = f.controls.contexts + 1; f.controls.contextHook = f.revoke; }
                }
            };
            f.observer.observeSessionMfa.mockClear();
            if (revoked) await expect(f.invoke('generate')).rejects.toThrow('Administrator session is no longer active');
            else expect(await f.invoke('generate')).toEqual({ ...winner, reused: true });
            expect(releasedClaim).toBe(1); expect(casMiss).toBe(1); expect(f.state().requests[0]).toMatchObject({ status: 'SUCCEEDED', claimToken: null, response: receipt.response });
            expect(f.state().credits).toEqual(before.credits); expect(f.state().tenants[0].usageCredits).toBe(8);
            expect(f.state().breaks).toEqual(before.breaks); expect(f.state().schedules[0].revision).toBe(2);
            expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1); f.expectClean();
        });
    }
    it('generation denial cleanup cannot fail or adopt a different claim generation', async () => {
        const f = fixture(); await f.verifyStartingAuthority('generate');
        f.controls.afterClaimHook = () => { f.state().requests[0].claimToken = 'different-current-claim'; f.revoke(); };
        await expect(f.invoke('generate')).rejects.toThrow('Administrator session is no longer active');
        expect(f.state().requests[0]).toMatchObject({ status: 'PENDING', claimToken: 'different-current-claim', response: null });
        expect(f.state().credits).toEqual([]); expect(f.state().tenants[0].usageCredits).toBe(10); expect(f.state().schedules[0].revision).toBe(1); f.expectClean();
    });
    it('missing bounded MFA proof refuses before all domain phases', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace'); f.observer.observeSessionMfa.mockResolvedValue(null); const before = f.domain();
        await expect(f.invoke('replace')).rejects.toThrow('MFA verification required before continuing');
        expect(f.attempts).toEqual([]); expect(f.domain()).toEqual(before); f.expectClean();
    });
    it('trusted observation outage is controlled503 outside DB and never falls back to request markers', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace'); f.observer.observeSessionMfa.mockRejectedValue(new Error('Modeled provider failure'));
        const failure = await f.invoke('replace').catch(error => error);
        expect(failure.getStatus()).toBe(503); expect(failure.message).toBe('MFA verification service is unavailable');
        expect(f.attempts).toEqual([]); expect(f.observer.observeSessionMfa).toHaveBeenCalledTimes(1); f.expectClean();
    });
    it('foreign exact-session observation never authorizes current owner phases', async () => {
        const f = fixture(); await f.verifyStartingAuthority('replace');
        f.observer.observeSessionMfa.mockResolvedValue({ ...f.proof, sessionId: 'other-live-session' });
        await expect(f.invoke('replace')).rejects.toThrow('MFA verification required before continuing');
        expect(f.attempts).toEqual([]); expect(f.state().credits).toEqual([]); f.expectClean();
    });
});
