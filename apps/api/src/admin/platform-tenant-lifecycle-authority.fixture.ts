import { vi } from 'vitest';
import { syntheticAdminObserver } from './admin-user-authority.fixture';

// Read model for executing the real RbacService in source/unit fixtures. This
// does not implement authorization, simulate PostgreSQL locks, or prove RLS.
export function installPlatformTenantAuthorityModel(prisma: any,
    identity: { userId: string; tenantId: string; sessionId: string }) {
    const actor = { id: identity.userId, tenantId: identity.tenantId, role: 'STAFF',
        suspendedAt: null as Date | null, deletedAt: null as Date | null, pinResetRequired: false, mfaEnabled: true,
        lockedUntil: null as Date | null, pinLockedUntil: null as Date | null };
    const session = { id: identity.sessionId, userId: identity.userId,
        createdAt: new Date(Date.now() - 60_000), revokedAt: null as Date | null, expiresAt: new Date(Date.now() + 3_600_000) };
    const otherSession = { ...session, id: 'other-session-of-same-actor' };
    const state = { actor, session, otherSession, permissions: ['admin_portal:access'], present: true, workspacePresent: true,
        workspace: { id: identity.tenantId, status: 'ACTIVE', deletedAt: null as Date | null },
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        afterAssignments: undefined as (() => void) | undefined, observer: syntheticAdminObserver() };
    prisma.__platformTenantMfaObserver = state.observer;
    const previousTenantRead = prisma.tenant.findUnique;
    prisma.tenant.findUnique = vi.fn(async (args: any) => args.where.id === identity.tenantId
        ? (state.workspacePresent ? { ...state.workspace } : null) : previousTenantRead?.(args));
    prisma.session ??= {};
    prisma.session.findFirst = vi.fn(async ({ where }: any) => {
        const row = [state.session, state.otherSession].find(item => item.id === where.id && item.userId === where.userId);
        return row ? { ...row } : null;
    });
    prisma.tenantSetting ??= {};
    const previousSettingRead = prisma.tenantSetting.findUnique;
    prisma.tenantSetting.findUnique = vi.fn(async (args: any) => args.where.tenantId_key.tenantId === identity.tenantId
        && args.where.tenantId_key.key === 'workspace_settings' ? { value: { security: { ...state.security } } } : previousSettingRead?.(args));
    const roleId = `role-${identity.userId}`;
    const role = () => ({ id: roleId, tenantId: identity.tenantId, name: 'Fixture platform access', isSystem: false,
        legacyRole: null, deletedAt: null, rolePermissions: state.permissions.map(key => ({ permission: { key } })) });
    const text = (query: any) => Array.isArray(query) ? query.join('?') : query.strings?.join('?') ?? '';
    const flatten = (values: any[]): any[] => values.flatMap(value => value && typeof value === 'object' && Array.isArray(value.values)
        ? flatten(value.values) : [value]);
    const previous = prisma.$queryRaw;
    prisma.$queryRaw = vi.fn(async (query: any, ...args: any[]) => {
        const sql = text(query), values = flatten(args.length ? args : query.values ?? []);
        if (sql.includes('FROM "Session"') && sql.includes('FOR UPDATE')) {
            return [state.session, state.otherSession].filter(row => values.includes(row.id) && values.includes(row.userId)).map(row => ({ ...row }));
        }
        if (sql.includes('FROM "Tenant"') && sql.includes('FOR UPDATE')) return values.map(id => ({ id }));
        if (sql.includes('FROM "User"') && sql.includes('FOR UPDATE')) return state.present ? [{ ...state.actor }] : [];
        if (sql.includes('FROM "RoleAssignment"') && sql.includes('FOR UPDATE')) return [{ userId: identity.userId, roleId }];
        if ((sql.includes('FROM "Role"') || sql.includes('FROM "RolePermission"')) && sql.includes('FOR UPDATE')) return [];
        if (previous) return previous(query, ...args);
        throw new Error('Unmodeled authority SQL');
    });
    prisma.user ??= {};
    prisma.user.findFirst = vi.fn(async ({ where }: any) => state.present && where.id === identity.userId
        && where.tenantId === identity.tenantId && state.actor.deletedAt === null
        && (!('suspendedAt' in where) || state.actor.suspendedAt === where.suspendedAt) ? { ...state.actor } : null);
    prisma.roleAssignment ??= {};
    prisma.roleAssignment.findMany = vi.fn(async ({ where, include }: any) => {
        if (where.tenantId !== identity.tenantId || where.userId !== identity.userId) return [];
        const rows = [{ userId: identity.userId, roleId, ...(include ? { role: role() } : {}) }];
        state.afterAssignments?.(); return rows;
    });
    prisma.role ??= {};
    prisma.role.findMany = vi.fn(async () => [role()]);
    return Object.assign(state, { domainTenantRead: previousTenantRead, domainSettingRead: previousSettingRead });
}
