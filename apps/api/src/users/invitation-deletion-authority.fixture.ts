import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createDecipheriv } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { expect, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { StaffInvitationOutboxService, staffInvitationOutboxAad } from './staff-invitation-outbox.service';
import { UsersController } from './users.controller';

// Explicit local rows and staged callbacks, with actual owner/helper decisions.
// No native PostgreSQL/RLS/Redis/transport/storage behavior is modeled here.
export type Row = Record<string, any>;
export type Route = 'invite' | 'retry' | 'reissue' | 'deactivate';
export const identity = { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'actor-session' };
export const targetId = 'staff-1';
export const key = Buffer.alloc(32, 0x42);
export const requestKey = 'phase69-deterministic-action';
export function copy<T>(value: T): T {
    if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
    if (value instanceof Date) return new Date(value.getTime()) as T;
    if (Array.isArray(value)) return value.map(copy) as T;
    if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, copy(entry)])) as T;
    return value;
}
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([name, value]) => {
        if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
            const ops = Object.keys(value);
            if (ops.some(op => !['in', 'not', 'lt'].includes(op))) throw new Error(`Unmodeled predicate ${name}`);
            return (!('in' in value) || value.in.includes(row[name]))
                && (!('not' in value) || row[name] !== value.not)
                && (!('lt' in value) || row[name] < value.lt);
        }
        return value instanceof Date ? row[name]?.getTime() === value.getTime() : row[name] === value;
    });
}
export const expectedEffects: Record<Route | 'archivedInvite', string[]> = {
    invite: ['user.create', 'roleAssignment.deleteMany', 'roleAssignment.createMany', 'staffInvitationOutbox.create', 'auditLog.create'],
    archivedInvite: ['user.update', 'roleAssignment.deleteMany', 'roleAssignment.createMany', 'session.updateMany',
        'passwordResetToken.updateMany', 'passwordResetEmailOutbox.updateMany', 'mfaTotpClaim.deleteMany',
        'staffInvitationOutbox.update', 'auditLog.create'],
    retry: ['staffInvitationOutbox.updateMany', 'auditLog.create'],
    reissue: ['staffInvitationOutbox.updateMany', 'auditLog.create'],
    deactivate: ['credit.refund', 'availabilityImportJob.updateMany', 'availabilityImportJob.updateMany',
        'shift.updateMany', 'schedule.updateMany', 'staffInvitationOutbox.updateMany', 'user.updateMany',
        'availabilityImportJob.updateMany', 'refreshTokenReplay.deleteMany', 'session.redact',
        'passwordResetEmailOutbox.deleteMany', 'passwordResetToken.deleteMany', 'mfaTotpClaim.deleteMany',
        'roleAssignment.deleteMany', 'onboardingSignupAttempt.deleteMany', 'notificationOutbox.deleteMany',
        'notification.deleteMany', 'auditLog.create'],
};

export function ownerFixture(route: Route, archivedInvite = false) {
    const epoch = Date.now();
    const user = (id: string, tenantId: string, role: string): Row => ({ id, tenantId, role, name: id,
        email: `${id}@example.com`, username: null, deletedAt: null, suspendedAt: null,
        lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: true,
        passwordHash: 'credential', pinHash: 'pin-credential', mfaSecret: 'encrypted-secret',
        mfaBackupCodes: ['backup-hash'], oidcIssuer: 'issuer', oidcSubject: id });
    const roleRow = (id: string, tenantId: string, legacyRole: string, permissions: string[]): Row => ({
        id, tenantId, legacyRole, isSystem: legacyRole === 'STAFF', name: id, description: null, deletedAt: null,
        rolePermissions: permissions.map(key => ({ roleId: id, permissionId: `${id}:${key}`, permission: { key } })),
    });
    const target = user(targetId, identity.tenantId, 'STAFF');
    if (archivedInvite) target.deletedAt = new Date(epoch - 60_000);
    const delivery = (id: string, tenantId: string, userId: string, status: string): Row => ({
        id, tenantId, userId, purpose: 'STAFF_INVITATION', recipientHash: 'old-recipient-hash',
        encryptedPayload: Buffer.from('old-ciphertext'), encryptionNonce: Buffer.alloc(12), encryptionTag: Buffer.alloc(16),
        encryptionKeyRef: 'old-key', payloadVersion: 1, status, attempts: 1, manualRetryCount: 0,
        retryAt: null, deliveredAt: null, deadLetteredAt: status === 'DEAD_LETTERED' ? new Date(epoch - 1000) : null,
        lastErrorCode: 'CONTROLLED_FAILURE', leaseOwner: null, leaseExpiresAt: null });
    const tenant = (id: string): Row => ({ id, status: 'ACTIVE', deletedAt: null, planTier: 'FREE',
        stripeSubscriptionId: null, stripeSubscriptionCurrentPeriodEnd: null, trialEndsAt: null });
    const session = (id: string, userId: string): Row => ({ id, userId, createdAt: new Date(epoch - 60_000),
        expiresAt: new Date(epoch + 3_600_000), revokedAt: null, refreshToken: 'opaque-token', selectorHash: 'selector',
        ipAddress: '192.0.2.10', userAgent: 'modeled-agent' });
    const dependent = (table: string, tenantId: string, userId: string): Row => ({ id: `${table}:${userId}`, tenantId, userId,
        sessionId: userId === targetId ? 'target-session' : 'foreign-session', consumedAt: null,
        status: 'FAILED', leaseUntil: null, lastError: 'controlled failure' });
    let state = {
        tables: {
            tenant: [tenant(identity.tenantId), tenant('foreign-tenant')],
            user: [user(identity.userId, identity.tenantId, 'ADMIN'),
                ...(route === 'invite' && !archivedInvite ? [] : [target]), user('foreign-user', 'foreign-tenant', 'STAFF')],
            session: [session(identity.sessionId, identity.userId), session('target-session', targetId), session('foreign-session', 'foreign-user')],
            role: [roleRow('actor-role', identity.tenantId, 'ADMIN', ['users:write', 'users:admin', 'roles:assign', 'users:read', 'auth:login_email', 'auth:login_pin']),
                roleRow('staff-role', identity.tenantId, 'STAFF', ['auth:login_email']),
                roleRow('foreign-role', 'foreign-tenant', 'STAFF', ['auth:login_email'])],
            roleAssignment: [{ tenantId: identity.tenantId, userId: identity.userId, roleId: 'actor-role' },
                ...(route === 'invite' && !archivedInvite ? [] : [{ tenantId: identity.tenantId, userId: targetId, roleId: 'staff-role' }]),
                { tenantId: 'foreign-tenant', userId: 'foreign-user', roleId: 'foreign-role' }],
            staffInvitationOutbox: [...(route === 'invite' && !archivedInvite ? [] : [delivery('delivery-1', identity.tenantId, targetId,
                route === 'reissue' ? 'DEAD_LETTERED' : archivedInvite ? 'DELIVERED' : 'FAILED')]),
                delivery('foreign-delivery', 'foreign-tenant', 'foreign-user', 'FAILED')],
            auditLog: [],
            availabilityImportJob: [
                { id: 'failed-import', tenantId: identity.tenantId, userId: targetId, requestedByUserId: targetId,
                    status: 'FAILED', storageKey: 'tenant-1/failed.pdf', encryptedSourcePayload: Buffer.from('source'),
                    parsedAvailability: [{ day: 1 }], creditConsumption: { source: 'credits', consumedCredits: 1, newBalance: 5 } },
                { id: 'succeeded-import', tenantId: identity.tenantId, userId: targetId, requestedByUserId: targetId,
                    status: 'SUCCEEDED', storageKey: 'tenant-1/succeeded.pdf', encryptedSourcePayload: Buffer.from('source'),
                    parsedAvailability: [{ day: 2 }], creditConsumption: null },
                { id: 'foreign-import', tenantId: 'foreign-tenant', userId: 'foreign-user', requestedByUserId: 'foreign-user',
                    status: 'FAILED', storageKey: 'foreign/file.pdf', creditConsumption: null },
            ],
            creditTransaction: [{ id: 'feature-usage-availability-import:failed-import', tenantId: identity.tenantId,
                amount: -1, debtAmount: 0, reason: 'Availability PDF import (failed-import)', balanceAfter: 5, debtAfter: 0 }],
            shift: [{ id: 'draft-shift', tenantId: identity.tenantId, userId: targetId, scheduleId: 'draft', deletedAt: null },
                { id: 'standalone-shift', tenantId: identity.tenantId, userId: targetId, scheduleId: null, deletedAt: null },
                { id: 'published-shift', tenantId: identity.tenantId, userId: targetId, scheduleId: 'published', deletedAt: null },
                { id: 'foreign-shift', tenantId: 'foreign-tenant', userId: 'foreign-user', scheduleId: 'foreign-draft', deletedAt: null }],
            schedule: [{ id: 'draft', tenantId: identity.tenantId, status: 'DRAFT', deletedAt: null, revision: 4 },
                { id: 'published', tenantId: identity.tenantId, status: 'PUBLISHED', deletedAt: null, revision: 7 },
                { id: 'foreign-draft', tenantId: 'foreign-tenant', status: 'DRAFT', deletedAt: null, revision: 9 }],
        } as Record<string, Row[]>,
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        balances: [{ tenantId: identity.tenantId, balance: 5, debt: 0 }, { tenantId: 'foreign-tenant', balance: 100, debt: 0 }],
    };
    for (const name of ['refreshTokenReplay', 'passwordResetToken', 'passwordResetEmailOutbox', 'mfaTotpClaim',
        'onboardingSignupAttempt', 'notificationOutbox', 'notification']) {
        state.tables[name] = [dependent(name, identity.tenantId, targetId), dependent(name, 'foreign-tenant', 'foreign-user')];
    }
    if (route === 'invite' && !archivedInvite) {
        for (const [name, table] of Object.entries(state.tables)) {
            if (name === 'user' || name === 'role') continue;
            state.tables[name] = table.filter(row => row.userId !== targetId && row.requestedByUserId !== targetId);
        }
        state.tables.creditTransaction = [];
    }
    type State = typeof state;
    let draft: State | undefined, pending: string[] = [];
    const attempts: string[] = [], committed: string[] = [];
    const reads: Array<{ table: string; where: Row; ordinal: number }> = [];
    const controls = { active: 0, transactions: 0, observerTtl: 120_000, finalRoleVisits: 0, outboxReadVisits: 0,
        onObserver: undefined as (() => void) | undefined, onFinalRole: undefined as (() => void) | undefined,
        onEffect: undefined as ((index: number) => void) | undefined,
        onOutboxRead: undefined as ((index: number) => void) | undefined };
    const view = () => draft ?? state;
    const rows = (name: string, where: Row = {}) => {
        const table = view().tables[name];
        if (!table) throw new Error(`Unmodeled table ${name}`);
        return table.filter(row => matches(row, where));
    };
    const apply = (row: Row, data: Row) => {
        for (const [name, value] of Object.entries(data)) {
            if (value === Prisma.DbNull) row[name] = null;
            else if (value && typeof value === 'object' && Object.keys(value).join() === 'increment') row[name] += value.increment;
            else row[name] = copy(value);
        }
    };
    const effect = (name: string, mutate: (draft: State) => unknown) => {
        expect(controls.active).toBe(1);
        draft ??= copy(state); attempts.push(name); pending.push(name);
        const result = mutate(draft); controls.onEffect?.(attempts.length); return copy(result);
    };
    const flatten = (values: any[]): any[] => values.flatMap(value => value && typeof value === 'object' && 'values' in value ? flatten(value.values) : [value]);
    const parts = (query: any, values: any[]) => ({ sql: (Array.isArray(query) ? query : query.strings).join(' ').replace(/\s+/g, ' ').trim(),
        values: flatten(Array.isArray(query) ? values : query.values) });
    const prisma: any = {
        $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>, options: Row) => {
            expect(controls.active).toBe(0); expect(options).toEqual({ isolationLevel: 'Serializable' });
            controls.active++; controls.transactions++; draft = undefined; pending = [];
            try { const result = await operation(prisma); if (draft) state = draft; committed.push(...pending); return result; }
            finally { controls.active--; draft = undefined; pending = []; }
        }),
        $executeRaw: vi.fn(async (query: any, ...args: any[]) => {
            const { sql, values } = parts(query, args);
            if (sql.includes('set_current_tenant')) { expect(values).toEqual([identity.tenantId]); return 1; }
            if (sql.includes('pg_advisory_xact_lock')) {
                expect(values).toHaveLength(1);
                expect([identity.tenantId, `lunchlineup:scheduling:${identity.tenantId}`]).toContain(values[0]); return 1;
            }
            if (sql.startsWith('UPDATE "Session"')) {
                expect(values[0]).toBeInstanceOf(Date); expect(values[1]).toBe(targetId);
                return effect('session.redact', next => {
                    const selected = next.tables.session.filter(row => row.userId === values[1]);
                    selected.forEach(row => Object.assign(row, { selectorHash: null, refreshToken: `modeled-sha256:deleted-session:${row.id}`,
                        ipAddress: '[deleted]', userAgent: '[deleted]', revokedAt: copy(values[0]) })); return selected.length;
                });
            }
            throw new Error(`Unmodeled raw execute ${sql}`);
        }),
        $queryRaw: vi.fn(async (query: any, ...args: any[]) => {
            const { sql, values } = parts(query, args);
            if (sql.includes('settle_positive_credit_value')) {
                expect(values).toEqual([identity.tenantId, 1, 'Availability PDF import refund (failed-import)', 'feature-refund-availability-import:failed-import']);
                return effect('credit.refund', next => {
                    if (next.tables.creditTransaction.some(row => row.id === values[3])) throw new Error('Duplicate modeled refund');
                    const balance = next.balances.find(row => row.tenantId === values[0])!; balance.balance += values[1];
                    next.tables.creditTransaction.push({ id: values[3], tenantId: values[0], amount: values[1], debtAmount: 0,
                        reason: values[2], balanceAfter: balance.balance, debtAfter: balance.debt });
                    return [{ transactionId: values[3], creditedValue: values[1], spendableAmount: values[1], repaidDebt: 0,
                        newBalance: balance.balance, debtAfter: balance.debt, replayed: false }];
                });
            }
            expect(sql).toContain('FOR UPDATE');
            if (sql.includes('FROM "AvailabilityImportJob" job')) {
                expect(values).toEqual([identity.tenantId, targetId]);
                return copy(rows('availabilityImportJob', { tenantId: values[0], userId: values[1] }).map(job => {
                    const debit = rows('creditTransaction', { id: `feature-usage-availability-import:${job.id}` });
                    const refund = rows('creditTransaction', { id: `feature-refund-availability-import:${job.id}` });
                    const aggregate = (prefix: string, selected: Row[]) => Object.fromEntries([
                        [`${prefix}Count`, selected.length], ...['tenantId', 'amount', 'debtAmount', 'reason', 'balanceAfter', 'debtAfter']
                            .map(name => [`${prefix}${name[0].toUpperCase()}${name.slice(1)}`, selected[0]?.[name] ?? null]),
                    ]);
                    return { ...job, ...aggregate('debit', debit), ...aggregate('refund', refund) };
                }));
            }
            if (sql.includes('FROM "Shift" shift_row')) {
                expect(values).toEqual([identity.tenantId, targetId]);
                return copy(rows('shift', { tenantId: values[0], userId: values[1], deletedAt: null }).map(shift => {
                    const schedule = view().tables.schedule.find(row => row.id === shift.scheduleId);
                    return { ...shift, scheduleTenantId: schedule?.tenantId ?? null, scheduleStatus: schedule?.status ?? null,
                        scheduleDeletedAt: schedule?.deletedAt ?? null };
                }));
            }
            if (sql.includes('FROM "Schedule" schedule_row')) {
                expect(values).toEqual([identity.tenantId, targetId]);
                const referenced = rows('shift', { tenantId: values[0], userId: values[1], deletedAt: null }).map(row => row.scheduleId);
                return copy(rows('schedule', { id: { in: referenced } }).sort((a, b) => a.id.localeCompare(b.id)));
            }
            if (sql.includes('FROM "Tenant"')) {
                expect(values).toEqual([identity.tenantId]); return copy(rows('tenant', { id: { in: values } }));
            }
            if (sql.includes('FROM "Session"')) {
                expect(values).toEqual([identity.sessionId, identity.userId]);
                return copy(rows('session', { id: values[0], userId: values[1] }));
            }
            if (sql.includes('FROM "User"')) {
                if (sql.includes('"id" =')) {
                    expect(values).toEqual([targetId, identity.tenantId]);
                    return copy(rows('user', { id: values[0], tenantId: values[1], deletedAt: null }));
                }
                expect(values[0]).toBe(identity.tenantId);
                const ids = values.slice(1); expect(ids).toEqual([...new Set(ids)].sort());
                expect(ids.every(id => id === identity.userId || id === targetId)).toBe(true);
                return copy(rows('user', { tenantId: values[0], id: { in: ids }, ...(sql.includes('"deletedAt" IS NULL') ? { deletedAt: null } : {}) }));
            }
            if (sql.includes('FROM "RoleAssignment"')) {
                expect(values[0]).toBe(identity.tenantId); const ids = values.slice(1); expect(ids).toEqual([...new Set(ids)].sort());
                return copy(rows('roleAssignment', { tenantId: values[0], userId: { in: ids } }));
            }
            if (sql.includes('FROM "RolePermission"')) {
                expect(values).toEqual([...new Set(values)].sort());
                if (controls.transactions === 2 && values.includes('actor-role')) {
                    controls.finalRoleVisits++; controls.onFinalRole?.();
                }
                return copy(rows('role', { id: { in: values } }).flatMap(row => row.rolePermissions));
            }
            if (sql.includes('FROM "Role"')) {
                expect(values[0]).toBe(identity.tenantId); expect(values).toHaveLength(2);
                return copy(rows('role', { tenantId: values[0], id: values[1] }));
            }
            throw new Error(`Unmodeled raw query ${sql}`);
        }),
    };
    const read = (table: string, args: Row) => {
        if (table === 'user' || table === 'role') expect(args.where.tenantId).toBe(identity.tenantId);
        reads.push({ table, where: copy(args.where), ordinal: controls.transactions });
        return copy(rows(table, args.where));
    };
    prisma.tenant = { findUnique: vi.fn(async (args: Row) => {
        expect(args.where).toEqual({ id: identity.tenantId }); return read('tenant', args)[0] ?? null;
    }) };
    prisma.tenantSetting = { findUnique: vi.fn(async ({ where }: Row) => {
        expect(where).toEqual({ tenantId_key: { tenantId: identity.tenantId, key: 'workspace_settings' } });
        return { value: { security: copy(view().security) } };
    }) };
    prisma.planDefinition = { findUnique: vi.fn(async ({ where }: Row) => {
        expect(where).toEqual({ code: 'FREE' }); return { id: 'free-plan', code: 'FREE', name: 'Free', active: true,
            monthlyPriceCents: null, userLimit: 10, locationLimit: 1, creditQuotaLimit: null, metadata: { features: [] } };
    }) };
    prisma.user = {
        findFirst: vi.fn(async (args: Row) => read('user', args)[0] ?? null),
        findMany: vi.fn(async (args: Row) => read('user', args)),
        count: vi.fn(async (args: Row) => { expect(args.where).toEqual({ tenantId: identity.tenantId, deletedAt: null, suspendedAt: null }); return read('user', args).length; }),
        create: vi.fn(async ({ data }: Row) => effect('user.create', next => {
            expect(data.tenantId).toBe(identity.tenantId); expect(data.email).toBe('staff-1@example.com');
            if (next.tables.user.some(row => row.id === targetId || row.email === data.email)) throw new Error('Duplicate modeled User create');
            const row = { ...user(targetId, identity.tenantId, 'STAFF'), ...copy(data), mfaEnabled: false,
                passwordHash: null, pinHash: null, oidcIssuer: null, oidcSubject: null };
            next.tables.user.push(row); return row;
        })),
    };
    prisma.session = { findFirst: vi.fn(async (args: Row) => {
        expect(args.where).toEqual({ id: identity.sessionId, userId: identity.userId }); return read('session', args)[0] ?? null;
    }) };
    prisma.role = { findFirst: vi.fn(async (args: Row) => read('role', args)[0] ?? null), findMany: vi.fn(async (args: Row) => read('role', args)) };
    prisma.roleAssignment = { findMany: vi.fn(async (args: Row) => {
        const { role, ...where } = args.where;
        expect(where.tenantId).toBe(identity.tenantId);
        reads.push({ table: 'roleAssignment', where: copy(args.where), ordinal: controls.transactions });
        return rows('roleAssignment', where).flatMap<Row>(assignment => {
            const selected = view().tables.role.find(row => row.id === assignment.roleId && row.tenantId === assignment.tenantId
                && (!role || matches(row, role)));
            return selected ? [copy({ ...assignment, role: selected })] : [];
        }).sort((a, b) => a.userId.localeCompare(b.userId) || a.roleId.localeCompare(b.roleId));
    }) };
    prisma.staffInvitationOutbox = { findUnique: vi.fn(async (args: Row) => {
        const where = args.where.tenantId_userId_purpose ?? args.where;
        if (args.where.tenantId_userId_purpose) expect(where).toEqual({ tenantId: identity.tenantId, userId: targetId, purpose: 'STAFF_INVITATION' });
        else expect(Object.keys(where)).toEqual(['id']);
        const found = read('staffInvitationOutbox', { ...args, where })[0] ?? null;
        controls.outboxReadVisits++; controls.onOutboxRead?.(controls.outboxReadVisits); return copy(found);
    }) };
    prisma.auditLog = {
        findFirst: vi.fn(async (args: Row) => { expect(args.where).toMatchObject({ tenantId: identity.tenantId, action: 'USER_INVITATION_DELIVERY_REISSUED', resource: 'StaffInvitationOutbox' }); return read('auditLog', args)[0] ?? null; }),
        create: vi.fn(async ({ data }: Row) => effect('auditLog.create', next => {
            expect(data.tenantId).toBe(identity.tenantId); expect(data.userId).toBe(identity.userId);
            const row = { id: `audit-${next.tables.auditLog.length}`, ...copy(data) }; next.tables.auditLog.push(row); return row;
        })),
    };
    const mutationMethods: Record<string, string[]> = {
        user: ['update', 'updateMany'], session: ['updateMany'], roleAssignment: ['deleteMany', 'createMany'],
        staffInvitationOutbox: ['create', 'update', 'updateMany'], availabilityImportJob: ['updateMany'],
        shift: ['updateMany'], schedule: ['updateMany'], refreshTokenReplay: ['deleteMany'],
        passwordResetToken: ['updateMany', 'deleteMany'], passwordResetEmailOutbox: ['updateMany', 'deleteMany'],
        mfaTotpClaim: ['deleteMany'], onboardingSignupAttempt: ['deleteMany'], notificationOutbox: ['deleteMany'], notification: ['deleteMany'],
    };
    for (const [table, methods] of Object.entries(mutationMethods)) {
        prisma[table] ??= {};
        for (const method of methods) prisma[table][method] = vi.fn(async (args: Row) => effect(`${table}.${method}`, next => {
            let selected: Row[];
            if (table === 'refreshTokenReplay') {
                expect(args.where).toEqual({ session: { userId: targetId } });
                const ids = next.tables.session.filter(row => row.userId === args.where.session.userId).map(row => row.id);
                selected = next.tables[table].filter(row => ids.includes(row.sessionId));
            } else selected = args.where ? next.tables[table].filter(row => matches(row, args.where)) : [];
            if (method === 'deleteMany') { next.tables[table] = next.tables[table].filter(row => !selected.includes(row)); return { count: selected.length }; }
            if (method === 'createMany') { next.tables[table].push(...copy(args.data)); return { count: args.data.length }; }
            if (method === 'create') {
                expect(args.data.tenantId).toBe(identity.tenantId); expect(args.data.userId).toBe(targetId);
                next.tables[table].push(copy(args.data)); return args.data;
            }
            if (method === 'update' && selected.length !== 1) throw new Error(`Missing exact ${table} update row`);
            selected.forEach(row => apply(row, args.data)); return method === 'update' ? selected[0] : { count: selected.length };
        }));
    }
    const observer = { observeSessionMfa: vi.fn(async (selected: Row) => {
        expect(controls.active).toBe(0); expect(selected).toEqual({ sub: identity.userId, tenantId: identity.tenantId, sessionId: identity.sessionId });
        const observed = { ...selected, expiresAtEpochMs: Date.now() + controls.observerTtl,
            expiresAtMonotonicMs: performance.now() + controls.observerTtl };
        controls.onObserver?.(); return observed;
    }) };
    const tenantDb = new TenantPrismaService(prisma);
    const rbac = new RbacService(tenantDb);
    const outbox = new StaffInvitationOutboxService(new ConfigService({ STAFF_INVITATION_OUTBOX_ENABLED: 'true',
        STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY: key.toString('hex'), STAFF_INVITATION_MAX_ATTEMPTS: '8' }));
    const controller = new UsersController(observer as any, rbac, outbox, tenantDb);
    const req = { user: { sub: identity.userId, tenantId: identity.tenantId, sessionId: identity.sessionId,
        mfaVerified: true, legacyRole: 'ADMIN', permissions: ['users:write', 'users:admin'] } };
    const call = () => route === 'invite' ? controller.invite({ name: 'Invited Staff', email: ' STAFF-1@example.com ', roleId: 'staff-role' }, req)
        : route === 'retry' ? controller.retryInvitation(targetId, req)
        : route === 'reissue' ? controller.reissueInvitation(targetId, req, requestKey) : controller.deactivate(targetId, req);
    return { controller, rbac, outbox, observer, req, prisma, controls, reads, attempts, committed, call,
        get state() { return state; }, snapshot: () => copy(state),
        resetAccounting() { expect(controls.active).toBe(0); attempts.length = 0; committed.length = 0;
            controls.transactions = 0; controls.finalRoleVisits = 0; controls.outboxReadVisits = 0; },
        decrypt(row: Row) {
            const decipher = createDecipheriv('aes-256-gcm', key, row.encryptionNonce, { authTagLength: 16 });
            decipher.setAAD(staffInvitationOutboxAad({ ...row, outboxId: row.id } as any)); decipher.setAuthTag(row.encryptionTag);
            return JSON.parse(Buffer.concat([decipher.update(row.encryptedPayload), decipher.final()]).toString('utf8'));
        },
    };
}
