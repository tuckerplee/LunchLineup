import { performance } from 'node:perf_hooks';
import { expect, vi } from 'vitest';
import { RBAC_PERMISSION_CATALOG, RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

// Explicit staged local state model for real RbacService role owners and
// tenant authority. It is not a native lock/MVCC, Redis or ingress fixture.
type Row = Record<string, any>;
export const roleActor = { userId: 'admin-1', tenantId: 'platform-tenant', sessionId: 'admin-session-1',
    ipAddress: '203.0.113.25', userAgent: 'vitest-platform-admin' };
const copy = <T>(value: T): T => structuredClone(value);
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'role') return true; // Joined role is filtered explicitly.
        if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('in' in value) return value.in.includes(row[key]);
            if ('not' in value) return row[key] !== value.not;
            throw new Error('Unmodeled role-owner selector: ' + key);
        }
        return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
    });
}
export function roleOwnerAuthorityFixture() {
    const target = { id: 'user-1', publicId: 'public-user-1', tenantId: roleActor.tenantId, role: 'MANAGER',
        name: 'Admin User', email: 'admin@example.com', username: 'admin-user',
        suspendedAt: null, deletedAt: null, lockedUntil: null, pinLockedUntil: null,
        pinResetRequired: false, mfaEnabled: true,
        tenant: { id: roleActor.tenantId, name: 'Tenant One', slug: 'tenant-one' } };
    const actor = { ...target, id: roleActor.userId, publicId: 'public-admin-1', tenantId: roleActor.tenantId,
        role: 'ADMIN', username: 'platform-admin', email: 'platform@example.com' };
    const role = (id: string, tenantId: string, legacyRole: string | null, slug: string, keys: string[]) => ({
        id, tenantId, legacyRole, slug, name: slug, description: null, isSystem: legacyRole !== null, deletedAt: null,
        rolePermissions: keys.map(key => ({ permission: { key } })) });
    let state = {
        users: [actor, target] as Row[],
        tenants: [{ id: roleActor.tenantId, status: 'ACTIVE', deletedAt: null }] as Row[],
        sessions: [{ id: roleActor.sessionId, userId: roleActor.userId, createdAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null },
            { id: 'target-session', userId: target.id, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null }] as Row[],
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        roles: [role('actor-role', roleActor.tenantId, 'ADMIN', 'admin', ['roles:write', 'roles:assign', 'users:read', 'auth:login_pin', 'locations:read']),
            role('target-manager-role', target.tenantId, 'MANAGER', 'manager', ['users:read']),
            role('target-staff-role', target.tenantId, 'STAFF', 'staff', ['auth:login_pin']),
            role('custom-reader', target.tenantId, null, 'reader', ['users:read'])] as Row[],
        assignments: [{ tenantId: roleActor.tenantId, userId: roleActor.userId, roleId: 'actor-role' },
            { tenantId: target.tenantId, userId: target.id, roleId: 'target-manager-role' }] as Row[],
        permissions: ['roles:write', 'roles:assign', 'users:read', 'auth:login_pin', 'locations:read',
            'admin_portal:access', 'account:data_export', 'tenant_account:lifecycle'].map(key => {
                const definition = RBAC_PERMISSION_CATALOG.find(row => row.key === key);
                if (!definition) throw new Error('Unknown configured role fixture permission');
                return { id: 'permission-' + key, ...copy(definition) };
            }) as Row[],
        audits: [] as Row[], cleanups: [] as Row[],
    };
    let draft: typeof state | undefined;
    const controls = { stage: 'none' as 'none' | 'observer' | 'finalRole' | 'effect' | 'domain' | 'response',
        stageIndex: 0, entered: false, monotonicTtl: 120_000, active: 0, transactions: 0, finalOrdinal: 2, finalRoleVisits: 0, effectIndex: 0, observerTtl: 120_000,
        afterEffect: undefined as ((index: number) => void) | undefined,
        afterResponse: undefined as (() => void) | undefined,
        beforeObserverReturn: undefined as (() => void) | undefined,
        afterFinalRole: undefined as (() => void) | undefined };
    let release!: () => void, enter!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pause = async (point: typeof controls.stage, index = 0) => {
        if (controls.stage !== point || controls.entered || (point === 'effect' && index !== controls.stageIndex)) return;
        expect(controls.transactions).toBe(point === 'observer' ? 1 : 2);
        expect(controls.active).toBe(point === 'observer' ? 0 : 1);
        controls.entered = true; enter(); await released;
    };
    const attempts: Array<{ table: string; method: string; args: Row }> = [];
    const committed: typeof attempts = [];
    let pending: typeof attempts = [];
    const view = () => draft ?? state;
    const effect = async (table: string, method: string, args: Row, mutate: (value: typeof state) => unknown) => {
        if (!draft) draft = copy(state);
        const item = { table, method, args: copy(args) }; attempts.push(item); pending.push(item);
        const result = mutate(draft); controls.effectIndex++; controls.afterEffect?.(controls.effectIndex);
        await pause('effect', controls.effectIndex); return copy(result);
    };
    const apply = (row: Row, data: Row) => Object.assign(row, copy(data));
    const flatten = (values: any[]): any[] => values.flatMap(value => value && typeof value === 'object' && 'values' in value
        ? flatten(value.values) : [value]);
    const prisma: any = {
        $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => {
            if (controls.active !== 0) throw new Error('Overlapping role-owner transaction');
            controls.active++; controls.transactions++; draft = undefined; pending = [];
            try {
                const result = await operation(prisma);
                if (draft) { state = draft; committed.push(...pending); }
                return result;
            } finally { draft = undefined; pending = []; controls.active--; }
        }),
        $executeRaw: vi.fn(async (query: any, ...values: any[]) => {
            const sql = Array.isArray(query) ? query.join('?') : query.strings?.join('?');
            const selected = flatten(values.length ? values : query.values ?? []);
            if (sql?.includes('set_current_tenant')) { expect(selected).toEqual([roleActor.tenantId]); return 1; }
            if (sql?.includes('pg_advisory_xact_lock')) { expect(selected).toEqual(['lunchlineup:scheduling:' + roleActor.tenantId]); return 1; }
            throw new Error('Unmodeled role-owner raw execute');
        }),
        $queryRaw: vi.fn(async (query: any, ...values: any[]) => {
            const sql = Array.isArray(query) ? query.join('?') : query.strings?.join('?');
            const selected = flatten(values.length ? values : query.values ?? []);
            if (sql?.includes('FROM "Tenant"')) return copy(view().tenants.filter(row => selected.includes(row.id)));
            if (sql?.includes('FROM "User"')) return copy(view().users.filter(row => selected.includes(row.id)));
            if (sql?.includes('FROM "Session"')) return copy(view().sessions.filter(row => selected.includes(row.id) && selected.includes(row.userId)));
            if (sql?.includes('FROM "RoleAssignment"')) return copy(view().assignments.filter(row => selected.includes(row.userId)));
            if (sql?.includes('FROM "RolePermission"')) {
                if (controls.transactions === controls.finalOrdinal) { controls.finalRoleVisits++; controls.afterFinalRole?.(); await pause('finalRole'); }
                return [];
            }
            if (sql?.includes('FROM "Role"')) return copy(view().roles.filter(row => selected.includes(row.id)));
            if (sql?.includes('FROM "Schedule"') || sql?.includes('FROM "Shift"')) return [];
            throw new Error('Unmodeled role-owner raw query: ' + sql);
        }),
        tenant: { findUnique: vi.fn(async ({ where }: any) => copy(view().tenants.find(row => row.id === where.id) ?? null)) },
        tenantSetting: { findUnique: vi.fn(async ({ where }: any) => {
            if (where.tenantId_key?.tenantId !== roleActor.tenantId || where.tenantId_key?.key !== 'workspace_settings') {
                throw new Error('Unmodeled role-owner setting selector');
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
            findFirst: vi.fn(async ({ where, select }: any) => {
                const row = copy(view().roles.find(row => matches(row, where)) ?? null);
                if (controls.transactions === 2 && where.id === 'missing-role') await pause('response');
                if (controls.transactions === 2 && select?.rolePermissions) await pause('domain');
                return row;
            }),
            findMany: vi.fn(async ({ where, select }: any) => {
                const rows = copy(view().roles.filter(row => matches(row, where))
                    .map(row => ({ ...row, _count: { assignments: view().assignments.filter(item => item.roleId === row.id).length } })));
                if (controls.transactions === 2 && select?.rolePermissions) await pause('domain');
                return rows;
            }),
            count: vi.fn(async (args: any) => {
                expect(args).toEqual({ where: { tenantId: roleActor.tenantId, isSystem: false, deletedAt: null } });
                const count = view().roles.filter(row => matches(row, args.where)).length;
                if (controls.transactions === 2) await pause('domain'); return count;
            }),
            create: vi.fn(async (args: any) => effect('role', 'create', args, value => {
                expect(args.data.tenantId).toBe(roleActor.tenantId); expect(args.data.isSystem).toBe(false);
                const rolePermissions = args.data.rolePermissions.createMany.data.map(({ permissionId }: any) => {
                    const permission = value.permissions.find(row => row.id === permissionId);
                    if (!permission) throw new Error('Unknown role create permission ID'); return { permission: copy(permission) };
                });
                const row = { ...copy(args.data), id: 'created-custom-role', legacyRole: null, deletedAt: null, rolePermissions };
                value.roles.push(row); return row;
            })),
            update: vi.fn(async (args: any) => effect('role', 'update', args, value => {
                expect(Object.keys(args.where)).toEqual(['id']);
                const row = value.roles.find(row => row.id === args.where.id);
                if (!row) throw new Error('Unknown role update ID');
                const data = copy(args.data);
                if (data.rolePermissions) {
                    data.rolePermissions = data.rolePermissions.createMany.data.map(({ permissionId }: any) => {
                        const permission = value.permissions.find(row => row.id === permissionId);
                        if (!permission) throw new Error('Unknown role update permission ID'); return { permission: copy(permission) };
                    });
                }
                Object.assign(row, data); return row;
            })),
        },
        permission: { findMany: vi.fn(async (args: any) => {
            if (!args.where) {
                expect(args).toEqual({ orderBy: [{ category: 'asc' }, { key: 'asc' }] });
                return copy(view().permissions);
            }
            expect(Object.keys(args.where)).toEqual(['key']); expect(Object.keys(args.where.key)).toEqual(['in']);
            expect(args.select).toEqual({ id: true, key: true });
            return copy(view().permissions.filter(row => args.where.key.in.includes(row.key)));
        }) },
        rolePermission: { deleteMany: vi.fn(async (args: any) => effect('rolePermission', 'deleteMany', args, value => {
            expect(Object.keys(args.where)).toEqual(['roleId']);
            const row = value.roles.find(row => row.id === args.where.roleId);
            if (!row) throw new Error('Unknown role permission delete ID');
            const count = row.rolePermissions.length; row.rolePermissions = []; return { count };
        })) },
        roleAssignment: {
            count: vi.fn(async (args: any) => {
                expect(Object.keys(args.where).sort()).toEqual(['roleId', 'tenantId']);
                const count = view().assignments.filter(row => matches(row, args.where)).length;
                if (controls.transactions === 2) await pause('domain'); return count;
            }),
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
        auditLog: { create: vi.fn(async (args: any) => effect('auditLog', 'create', args, value => { value.audits.push(copy(args.data)); return args.data; })) },
    };
    for (const [table, methods] of Object.entries({ shift: ['updateMany'], schedule: ['updateMany'] })) {
        prisma[table] = {};
        for (const method of methods) prisma[table][method] = vi.fn(async (args: Row) => effect(table, method, args, value => {
            value.cleanups.push({ table, method, args: copy(args) }); return { count: 0 };
        }));
    }
    const observer = { observeSessionMfa: vi.fn(async (identity: { sub: string; tenantId: string; sessionId: string }) => {
        expect(controls.active).toBe(0);
        expect(identity).toEqual({ sub: roleActor.userId, tenantId: roleActor.tenantId, sessionId: roleActor.sessionId });
        const observation = { ...identity, expiresAtEpochMs: Date.now() + controls.observerTtl,
            expiresAtMonotonicMs: performance.now() + controls.monotonicTtl };
        await pause('observer'); expect(controls.active).toBe(0); return observation;
    }) };
    const tenantDb = new TenantPrismaService(prisma);
    const rbac = new RbacService(tenantDb);
    return { prisma, tenantDb, rbac, observer, controls, attempts, committed, actor: { ...roleActor },
        entered, release, snapshot: () => copy(state), get state() { return state; } };
}

