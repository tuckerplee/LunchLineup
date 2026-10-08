import { performance } from 'node:perf_hooks';
import { expect, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';

/** Positive scoped authority rows for existing financial/domain unit fixtures.
 * Actual Rbac/current-policy callbacks run; declared domain query queues remain
 * separate. No database locks, transaction rollback, Redis or native proof.
 * The independent payroll-current-authority spec owns stateful negative proof.
 */
export function payrollDomainAuthority(db: any, tx: any,
    actor: { tenantId: string; userId: string; sessionId: string }) {
    const keys = ['payroll:read', 'payroll:policy_write', 'payroll:lock', 'payroll:export', 'payroll:reconcile', 'time_cards:approve'];
    const user = { id: actor.userId, tenantId: actor.tenantId, deletedAt: null, suspendedAt: null,
        pinResetRequired: false, mfaEnabled: true, lockedUntil: null, pinLockedUntil: null };
    const tenant = { id: actor.tenantId, status: 'ACTIVE', deletedAt: null };
    const session = { id: actor.sessionId, userId: actor.userId, revokedAt: null,
        createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 3_600_000) };
    const role = { id: 'domain-payroll-role', tenantId: actor.tenantId, deletedAt: null,
        isSystem: false, legacyRole: null, rolePermissions: keys.map(key => ({ permission: { key } })) };
    const assignment = { tenantId: actor.tenantId, userId: actor.userId, roleId: role.id, role };
    const flatten = (values: any[]): any[] => values.flatMap(value => Array.isArray(value?.values) ? flatten(value.values) : [value]);
    const domainRaw = tx.$queryRaw;
    tx.$queryRaw = vi.fn(async (query: any, ...values: any[]) => {
        const sql = Array.isArray(query) ? query.join('?') : query.strings.join('?');
        const bound = flatten(Array.isArray(query) ? values : query.values);
        if (sql.includes('FROM "Tenant"')) { expect(bound).toEqual([actor.tenantId]); return [tenant]; }
        if (sql.includes('FROM "User"')) { expect(bound).toEqual([actor.tenantId, actor.userId]); return [user]; }
        if (sql.includes('FROM "Session"')) { expect(bound).toEqual([actor.sessionId, actor.userId]); return [session]; }
        if (sql.includes('FROM "RoleAssignment"')) { expect(bound).toEqual([actor.tenantId, actor.userId]); return [assignment]; }
        if (sql.includes('FROM "RolePermission"')) { expect(bound).toEqual([role.id]); return role.rolePermissions; }
        if (sql.includes('FROM "Role"')) { expect(bound).toEqual([actor.tenantId, role.id]); return [role]; }
        if (!sql.includes('set_config') && !sql.includes('FROM "TimeCard" card') && !sql.includes('FROM "TimeCardBreak"')
            && !sql.includes('FROM "PayrollPeriod"') && !sql.includes('FROM "PayrollExportBatch"')) throw new Error('Unmodeled domain raw query');
        if (domainRaw) return domainRaw(query, ...values);
        if (sql.includes('set_config')) return [];
        throw new Error('Missing declared financial query fixture');
    });
    tx.tenant = { findUnique: vi.fn(async ({ where }: any) => { expect(where).toEqual({ id: actor.tenantId }); return tenant; }) };
    tx.user = { findFirst: vi.fn(async ({ where }: any) => {
        expect(where).toEqual({ id: actor.userId, tenantId: actor.tenantId, deletedAt: null, suspendedAt: null }); return user;
    }) };
    tx.session = { findFirst: vi.fn(async ({ where }: any) => { expect(where).toEqual({ id: actor.sessionId, userId: actor.userId }); return session; }) };
    tx.tenantSetting = { findUnique: vi.fn(async ({ where }: any) => {
        expect(where).toEqual({ tenantId_key: { tenantId: actor.tenantId, key: 'workspace_settings' } });
        return { value: { security: { sessionTimeoutMinutes: 480, requireMfaForAll: false } } };
    }) };
    tx.roleAssignment = { findMany: vi.fn(async ({ where }: any) => {
        expect(where.tenantId).toBe(actor.tenantId); expect(where.userId).toBe(actor.userId);
        if (where.role) expect(where.role).toEqual({ tenantId: actor.tenantId, deletedAt: null }); return [assignment];
    }) };
    db.client = tx;
    let active = 0;
    const run = db.withTenant.getMockImplementation();
    db.withTenant.mockImplementation((tenantId: string, work: (tx: any) => unknown, options: any) => {
        expect(tenantId).toBe(actor.tenantId); expect(options).toEqual({ isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000 });
        return run(tenantId, async (selected: any) => { active++; try { return await work(selected); } finally { active--; } }, options);
    });
    const observer = { observeSessionMfa: vi.fn(async (identity: any) => {
        expect(active).toBe(0); expect(identity).toEqual({ sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId });
        return { ...identity, expiresAtEpochMs: Date.now() + 120_000, expiresAtMonotonicMs: performance.now() + 120_000 };
    }) };
    return [new RbacService(db), observer as any] as const;
}
