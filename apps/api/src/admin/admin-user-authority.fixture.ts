import { performance } from 'node:perf_hooks';
import { vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

// Explicit local state model for the real RbacService wrapper and platform
// authorization. It is not a native lock/MVCC, Redis or ingress fixture.
type Row = Record<string, any>;
export const authorityActor = { userId: 'admin-1', tenantId: 'platform-tenant', sessionId: 'admin-session-1',
    ipAddress: '203.0.113.25', userAgent: 'vitest-platform-admin' };
export function syntheticAdminObserver(onRead: () => void = () => {}, ttl: () => number = () => 120_000) {
    return { observeSessionMfa: vi.fn(async (identity: { sub: string; tenantId: string; sessionId: string }) => {
        const lifetime = ttl();
        const observation = { ...identity, expiresAtEpochMs: Date.now() + lifetime,
            expiresAtMonotonicMs: performance.now() + lifetime };
        onRead(); return observation;
    }) };
}
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'role') return true; // Joined role is filtered explicitly.
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('in' in value) return value.in.includes(row[key]);
            if ('not' in value) return row[key] !== value.not;
            throw new Error('Unmodeled admin selector: ' + key);
        }
        return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
    });
}
export function adminAuthorityFixture() {
    const target = { id: 'user-1', publicId: 'public-user-1', tenantId: 'tenant-1', role: 'ADMIN',
        name: 'Admin User', email: 'admin@example.com', username: 'admin-user',
        suspendedAt: null, deletedAt: null, lockedUntil: null, pinLockedUntil: null,
        pinResetRequired: false, mfaEnabled: true,
        tenant: { id: 'tenant-1', name: 'Tenant One', slug: 'tenant-one' } };
    const actor = { ...target, id: authorityActor.userId, publicId: 'public-admin-1', tenantId: authorityActor.tenantId,
        role: 'SUPER_ADMIN', username: 'platform-admin', email: 'platform@example.com' };
    const role = (id: string, tenantId: string, legacyRole: string, slug: string, keys: string[]) => ({
        id, tenantId, legacyRole, slug, name: slug, description: null, isSystem: true, deletedAt: null,
        rolePermissions: keys.map(key => ({ permission: { key } })) });
    let state = {
        users: [actor, target] as Row[],
        tenants: [{ id: authorityActor.tenantId, status: 'ACTIVE', deletedAt: null },
            { id: 'tenant-1', status: 'ACTIVE', deletedAt: null, planTier: 'FREE', stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null, trialEndsAt: null }] as Row[],
        sessions: [{ id: authorityActor.sessionId, userId: authorityActor.userId, createdAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null },
            { id: 'target-session', userId: target.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null }] as Row[],
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        roles: [role('platform-super-role', authorityActor.tenantId, 'SUPER_ADMIN', 'super-admin', ['admin_portal:access', 'roles:assign', 'users:admin']),
            role('target-admin-role', target.tenantId, 'ADMIN', 'admin', ['users:read']),
            role('target-staff-role', target.tenantId, 'STAFF', 'staff', ['auth:login_pin'])] as Row[],
        assignments: [{ tenantId: authorityActor.tenantId, userId: authorityActor.userId, roleId: 'platform-super-role' },
            { tenantId: target.tenantId, userId: target.id, roleId: 'target-admin-role' }] as Row[],
        audits: [] as Row[], cleanups: [] as Row[],
    };
    let draft: typeof state | undefined;
    const controls = { active: 0, transactions: 0, finalOrdinal: 2, finalRoleVisits: 0, effectIndex: 0, observerTtl: 120_000,
        afterEffect: undefined as ((index: number) => void) | undefined,
        afterResponse: undefined as (() => void) | undefined,
        beforeObserverReturn: undefined as (() => void) | undefined,
        afterFinalRole: undefined as (() => void) | undefined };
    const attempts: Array<{ table: string; method: string; args: Row }> = [];
    const committed: typeof attempts = [];
    let pending: typeof attempts = [];
    const view = () => draft ?? state;
    const effect = (table: string, method: string, args: Row, mutate: (value: typeof state) => unknown) => {
        if (!draft) draft = copy(state);
        const item = { table, method, args: copy(args) }; attempts.push(item); pending.push(item);
        const result = mutate(draft); controls.effectIndex++; controls.afterEffect?.(controls.effectIndex); return copy(result);
    };
    const apply = (row: Row, data: Row) => Object.assign(row, copy(data));
    const flatten = (values: any[]): any[] => values.flatMap(value => value && typeof value === 'object' && 'values' in value
        ? flatten(value.values) : [value]);
    const prisma: any = {
        $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => {
            if (controls.active !== 0) throw new Error('Overlapping modeled transaction');
            controls.active++; controls.transactions++; draft = undefined; pending = [];
            try {
                const result = await operation(prisma);
                if (draft) { state = draft; committed.push(...pending); }
                return result;
            } finally { draft = undefined; pending = []; controls.active--; }
        }),
        $executeRaw: vi.fn(async (query: any) => {
            const sql = Array.isArray(query) ? query.join('?') : query.strings?.join('?');
            if (!sql?.includes('set_current_platform_admin') && !sql?.includes('pg_advisory_xact_lock')) {
                throw new Error('Unmodeled admin raw execute');
            }
            return 1;
        }),
        $queryRaw: vi.fn(async (query: any, ...values: any[]) => {
            const sql = Array.isArray(query) ? query.join('?') : query.strings?.join('?');
            const selected = flatten(values.length ? values : query.values ?? []);
            if (sql?.includes('FROM "Tenant"')) return copy(view().tenants.filter(row => selected.includes(row.id)));
            if (sql?.includes('FROM "User"')) return copy(view().users.filter(row => selected.includes(row.id)));
            if (sql?.includes('FROM "Session"')) return copy(view().sessions.filter(row => selected.includes(row.id) && selected.includes(row.userId)));
            if (sql?.includes('FROM "RoleAssignment"')) return copy(view().assignments.filter(row => selected.includes(row.userId)));
            if (sql?.includes('FROM "RolePermission"')) {
                if (controls.transactions === controls.finalOrdinal) { controls.finalRoleVisits++; controls.afterFinalRole?.(); }
                return [];
            }
            if (sql?.includes('FROM "Role"')) return copy(view().roles.filter(row => selected.includes(row.id)));
            if (sql?.includes('FROM "Schedule"') || sql?.includes('FROM "Shift"')) return [];
            throw new Error('Unmodeled admin raw query: ' + sql);
        }),
        tenant: { findUnique: vi.fn(async ({ where }: any) => copy(view().tenants.find(row => row.id === where.id) ?? null)) },
        tenantSetting: { findUnique: vi.fn(async ({ where }: any) => {
            if (where.tenantId_key?.tenantId !== authorityActor.tenantId || where.tenantId_key?.key !== 'workspace_settings') {
                throw new Error('Unmodeled admin setting selector');
            }
            return { value: { security: copy(view().security) } };
        }) },
        user: {
            findFirst: vi.fn(async ({ where }: any) => copy(view().users.find(row => matches(row, where)) ?? null)),
            findUnique: vi.fn(async ({ where }: any) => copy(view().users.find(row => matches(row, where)) ?? null)),
            findMany: vi.fn(async ({ where }: any) => copy(view().users.filter(row => matches(row, where)))),
            findUniqueOrThrow: vi.fn(async ({ where }: any) => {
                const row = view().users.find(row => matches(row, where)); if (!row) throw new Error('Missing fixture user');
                const response = copy(row); controls.afterResponse?.(); return response;
            }),
            count: vi.fn(async () => 1),
            update: vi.fn(async (args: any) => effect('user', 'update', args, value => {
                const row = value.users.find(row => matches(row, args.where)); if (!row) throw new Error('Missing update fixture user');
                apply(row, args.data); return row;
            })),
            updateMany: vi.fn(async (args: any) => effect('user', 'updateMany', args, value => {
                const rows = value.users.filter(row => matches(row, args.where)); rows.forEach(row => apply(row, args.data)); return { count: rows.length };
            })),
        },
        session: {
            findFirst: vi.fn(async ({ where }: any) => copy(view().sessions.find(row => matches(row, where)) ?? null)),
            updateMany: vi.fn(async (args: any) => effect('session', 'updateMany', args, value => {
                const rows = value.sessions.filter(row => matches(row, args.where)); rows.forEach(row => apply(row, args.data)); return { count: rows.length };
            })),
        },
        role: {
            findFirst: vi.fn(async ({ where }: any) => copy(view().roles.find(row => matches(row, where)) ?? null)),
            findMany: vi.fn(async ({ where }: any) => copy(view().roles.filter(row => matches(row, where)))),
        },
        roleAssignment: {
            findMany: vi.fn(async ({ where }: any) => view().assignments.filter(row => matches(row, where)).flatMap(row => {
                const role = view().roles.find(role => role.id === row.roleId && role.tenantId === row.tenantId && !role.deletedAt);
                return role ? [copy({ ...row, role })] : [];
            })),
            deleteMany: vi.fn(async (args: any) => effect('roleAssignment', 'deleteMany', args, value => {
                const before = value.assignments.length; value.assignments = value.assignments.filter(row => !matches(row, args.where));
                return { count: before - value.assignments.length };
            })),
            createMany: vi.fn(async (args: any) => effect('roleAssignment', 'createMany', args, value => {
                value.assignments.push(...copy(args.data)); return { count: args.data.length };
            })),
        },
        planDefinition: { findUnique: vi.fn(async ({ where }: any) => {
            if (where?.code !== 'FREE' || Object.keys(where).length !== 1) {
                throw new Error('Unmodeled admin plan selector');
            }
            // Actual capacity code reads the configured row when findUnique
            // exists; the default FREE definition has a finite ten-user cap.
            return { id: 'synthetic-free-plan', code: 'FREE', name: 'Free', monthlyPriceCents: null,
                locationLimit: 1, userLimit: 10, creditQuotaLimit: null, active: true,
                metadata: { features: [] }, createdAt: new Date(0), updatedAt: new Date(0) };
        }) },
        auditLog: { create: vi.fn(async (args: any) => effect('auditLog', 'create', args, value => { value.audits.push(copy(args.data)); return args.data; })) },
    };
    for (const [table, methods] of Object.entries({ onboardingSignupAttempt: ['deleteMany'], passwordResetToken: ['updateMany'],
        passwordResetEmailOutbox: ['updateMany'], mfaTotpClaim: ['deleteMany'], shift: ['updateMany'], schedule: ['updateMany'] })) {
        prisma[table] = {};
        for (const method of methods) prisma[table][method] = vi.fn(async (args: Row) => effect(table, method, args, value => {
            value.cleanups.push({ table, method, args: copy(args) }); return { count: 0 };
        }));
    }
    const observer = syntheticAdminObserver(() => {
        if (controls.active !== 0) throw new Error('Observer executed in modeled DB callback');
        controls.beforeObserverReturn?.();
    }, () => controls.observerTtl);
    const tenantDb = new TenantPrismaService(prisma);
    const rbac = new RbacService(tenantDb);
    return { prisma, tenantDb, rbac, observer, controls, attempts, committed, actor: { ...authorityActor },
        snapshot: () => copy(state), get state() { return state; } };
}

// Retained domain-composition fixtures do not model target authorization. Give
// them the real actor policy wrapper, while their existing target callback
// stubs retain only their old domain-contract scope. The full model above is
// used separately for actual target authority and rollback proof.
export function installAdminCompositionPolicy(prisma: any, actor = authorityActor) {
    const row = { id: actor.userId, tenantId: actor.tenantId, deletedAt: null, suspendedAt: null,
        lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: true };
    const session = { id: actor.sessionId, userId: actor.userId, createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null };
    const role = { id: 'composition-platform-role', tenantId: actor.tenantId, deletedAt: null,
        rolePermissions: [{ permission: { key: 'admin_portal:access' } }] };
    prisma.user ??= {};
    prisma.user.findFirst = vi.fn(async ({ where }: any) => matches(row, where) ? copy(row) : null);
    prisma.session ??= {};
    prisma.session.findFirst = vi.fn(async ({ where }: any) => matches(session, where) ? copy(session) : null);
    const tenantRead = prisma.tenant?.findUnique;
    prisma.tenant ??= {};
    prisma.tenant.findUnique = vi.fn(async (args: any) => args.where.id === actor.tenantId
        ? { id: actor.tenantId, status: 'ACTIVE', deletedAt: null } : tenantRead?.(args) ?? null);
    prisma.tenantSetting = { findUnique: vi.fn(async () => null) };
    const assignmentsRead = prisma.roleAssignment?.findMany;
    prisma.roleAssignment ??= {};
    prisma.roleAssignment.findMany = vi.fn(async (args: any) => args.where.userId === actor.userId
        ? [{ tenantId: actor.tenantId, userId: actor.userId, roleId: role.id, role: copy(role) }] : assignmentsRead?.(args) ?? []);
    const raw = prisma.$queryRaw;
    prisma.$queryRaw = vi.fn(async (query: any, ...values: any[]) => {
        const text = Array.isArray(query) ? query.join('?') : query.strings?.join('?');
        if (text?.includes('FROM "Session"')) return [copy(session)];
        return raw?.(query, ...values) ?? [];
    });
    return syntheticAdminObserver();
}
