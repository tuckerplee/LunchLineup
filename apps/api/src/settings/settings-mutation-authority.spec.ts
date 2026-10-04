import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ProblemError } from '../../../api-v2/src/platform/problem';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { SettingsController } from './settings.controller';
import { WorkspaceSettingsService } from '../../../api-v2/src/settings/settings.service';
import { verifiedSettingsObserver } from './settings-test-mfa.fixture';

type Owner = 'legacy' | 'native';
type Section = 'general' | 'team' | 'security';
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const flattenedValues = (values: unknown[]): unknown[] => values.flatMap(value => (
    value && typeof value === 'object' && 'values' in value
        ? flattenedValues((value as { values: unknown[] }).values) : [value]
));

// Actual owner methods and RBAC helpers over controlled committed snapshots.
// This proves local decisions and write refusal, not PostgreSQL lock semantics.
function harness(owner: Owner) {
    const tenantId = 'tenant-authority', actorId = 'actor-authority', sessionId = 'session-authority';
    const actor: any = { id: actorId, tenantId, publicId: 'actor-public-id', role: 'ADMIN', name: 'Actor',
        email: 'actor@example.test', username: 'actor', deletedAt: null, suspendedAt: null,
        lockedUntil: null, pinLockedUntil: null, pinResetRequired: false };
    const session: any = { id: sessionId, userId: actorId, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null };
    const role: any = { id: 'role-authority', publicId: 'role-public-id', name: 'Admin', slug: 'admin',
        isSystem: true, isDefault: false, description: null, legacyRole: 'ADMIN', deletedAt: null,
        rolePermissions: [{ permission: { key: 'settings:write' } }, { permission: { key: 'settings:read' } }] };
    let assigned = true, sessionPresent = true;
    const entered = deferred(), gate = deferred();
    const writes = vi.fn(), audits = vi.fn(), reads = vi.fn();
    const tx: any = {
        $executeRaw: vi.fn(async () => 1),
        $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
            const text = (Array.isArray(sql) ? sql : sql.strings).join('');
            const values = flattenedValues(Array.isArray(sql) ? args : sql.values);
            if (text.includes('FROM "Tenant"')) {
                expect(values).toContain(tenantId);
                entered.release();
                await gate.promise;
                return [{ id: tenantId }];
            }
            if (text.includes('FROM "Session"')) {
                expect(values).toEqual([sessionId, actorId]);
                return sessionPresent && session.userId === actorId ? [structuredClone(session)] : [];
            }
            if (text.includes('FROM "User"')) {
                expect(values).toContain(actorId);
                expect(values).toContain(tenantId);
                return actor.tenantId === tenantId ? [structuredClone(actor)] : [];
            }
            return [];
        }),
        user: { findFirst: vi.fn(async ({ where }: any) => {
            expect(where).toMatchObject({ id: actorId, tenantId, deletedAt: null, suspendedAt: null });
            return actor.deletedAt || actor.suspendedAt || actor.tenantId !== tenantId ? null : structuredClone(actor);
        }) },
        roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
            expect(where.tenantId).toBe(tenantId);
            return assigned ? [{ userId: actorId, roleId: role.id }] : [];
        }) },
        role: { findMany: vi.fn(async ({ where }: any) => {
            expect(where.tenantId).toBe(tenantId);
            return assigned && !role.deletedAt ? [structuredClone(role)] : [];
        }) },
        session: { findFirst: vi.fn(async ({ where }: any) => {
            expect(where).toEqual({ id: sessionId, userId: actorId });
            return sessionPresent && session.userId === actorId ? structuredClone(session) : null;
        }) },
        tenant: {
            findUnique: vi.fn(async () => { reads(); return { name: 'Original', slug: 'original', status: 'ACTIVE', deletedAt: null }; }),
            findUniqueOrThrow: vi.fn(async () => { reads(); return { name: 'Original', slug: 'original' }; }),
            update: vi.fn(async ({ data }: any) => { writes('Tenant', data); return { name: 'Original', slug: 'original', ...data }; }),
        },
        tenantSetting: {
            findUnique: vi.fn(async () => { reads(); return null; }),
            upsert: vi.fn(async ({ update }: any) => { writes('TenantSetting', update.value); return { value: update.value }; }),
        },
        auditLog: { create: vi.fn(async ({ data }: any) => { audits(data); return {}; }) },
    };
    const req = { user: { sub: actorId, tenantId, sessionId, permissions: ['settings:read', 'settings:write'] } };
    const identity = { ...req.user, role: 'ADMIN', legacyRole: 'ADMIN', roles: [], mfaVerified: true, mfaRequired: false };
    const legacy = new SettingsController(new TenantPrismaService({ $transaction: (op: any) => op(tx) } as any), undefined, verifiedSettingsObserver as never);
    const native = new WorkspaceSettingsService({ withTenant: async (selected: string, op: any) => {
        expect(selected).toBe(tenantId); return op(tx);
    } } as never, { oidcSsoAvailable: false }, verifiedSettingsObserver);
    const call = (section: Section) => {
        if (owner === 'legacy') {
            if (section === 'general') return legacy.updateGeneral({ name: 'Changed' }, req);
            if (section === 'team') return legacy.updateTeam({ defaultInviteRole: 'MANAGER' }, req);
            return legacy.updateSecurity({ requireMfaForAll: true }, req);
        }
        if (section === 'general') return native.updateGeneral(identity as never, { name: 'Changed' });
        if (section === 'team') return native.updateTeam(identity as never, { defaultInviteRole: 'MANAGER' });
        return native.updateSecurity(identity as never, { requireMfaForAll: true });
    };
    return { actor, session, role, entered, gate, writes, audits, reads, call,
        removeAssignment: () => { assigned = false; }, removeSession: () => { sessionPresent = false; } };
}

const revocations: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ['permission removed', h => { h.role.rolePermissions = []; }],
    ['role deleted', h => { h.role.deletedAt = new Date(); }],
    ['assignment removed', h => { h.removeAssignment(); }],
    ['session revoked', h => { h.session.revokedAt = new Date(); }],
    ['session expired', h => { h.session.expiresAt = new Date(0); }],
    ['session removed', h => { h.removeSession(); }],
    ['session belongs to another user', h => { h.session.userId = 'another-user'; }],
    ['user deleted', h => { h.actor.deletedAt = new Date(); }],
    ['user suspended', h => { h.actor.suspendedAt = new Date(); }],
    ['user moved to another tenant', h => { h.actor.tenantId = 'another-tenant'; }],
    ['account locked', h => { h.actor.lockedUntil = new Date(Date.now() + 60_000); }],
    ['PIN locked', h => { h.actor.pinLockedUntil = new Date(Date.now() + 60_000); }],
];

describe('settings mutation current authority', () => {
    for (const owner of ['legacy', 'native'] as const) for (const section of ['general', 'team', 'security'] as const) {
        it.each(revocations)(`${owner} ${section} rejects %s committed during Tenant wait`, async (_label, revoke) => {
            const h = harness(owner);
            const pending = h.call(section).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
            try {
                expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
                revoke(h);
                h.gate.release();
                const result = await pending;
                expect(result.error).toBeDefined();
                if (owner === 'native') {
                    expect(result.error).toBeInstanceOf(ProblemError);
                    expect(result.error.status).toBe(403);
                } else expect(result.error).toBeInstanceOf(
                    _label === 'role deleted' || _label === 'assignment removed' ? UnauthorizedException : ForbiddenException,
                );
                expect(result.value).toBeUndefined();
                expect(h.reads).not.toHaveBeenCalled();
                expect(h.writes).not.toHaveBeenCalled();
                expect(h.audits).not.toHaveBeenCalled();
            } finally { h.gate.release(); await pending; }
        });

        it(`${owner} ${section} permits current role-derived authority after the wait`, async () => {
            const h = harness(owner), pending = h.call(section);
            try {
                expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled', () => 'settled')])).toBe('entered');
                h.actor.role = 'STAFF';
                h.role.name = 'Custom settings editor';
                h.role.isSystem = false;
                h.role.legacyRole = null;
                h.gate.release();
                const value = await pending;
                expect(value).toHaveProperty('security');
                expect(h.writes).toHaveBeenCalled();
                if (section === 'security') expect(h.audits).toHaveBeenCalledOnce();
            } finally { h.gate.release(); await Promise.allSettled([pending]); }
        });
    }
});
