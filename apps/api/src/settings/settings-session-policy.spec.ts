import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ProblemError } from '../../../api-v2/src/platform/problem';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { SettingsController } from './settings.controller';
import { WorkspaceSettingsService } from '../../../api-v2/src/settings/settings.service';
import { verifiedSettingsObserver } from './settings-test-mfa.fixture';

type Owner = 'legacy' | 'native';
type Section = 'general' | 'team' | 'security';
type Boundary = 'Tenant' | 'Session' | 'Role';
const minute = 60_000;
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const flatten = (values: unknown[]): unknown[] => values.flatMap(value => (
    value && typeof value === 'object' && 'values' in value
        ? flatten((value as { values: unknown[] }).values) : [value]
));

// Controlled committed snapshots and waits exercise the actual settings owners
// and RBAC helpers. This is not proof of PostgreSQL locks, RLS, or rollback.
function harness(owner: Owner, boundary: Boundary = 'Tenant') {
    const tenantId = 'tenant-policy', actorId = 'actor-policy', sessionId = 'session-policy';
    const tenant = { id: tenantId, name: 'Original', slug: 'original', status: 'ACTIVE', deletedAt: null as Date | null };
    const session = { id: sessionId, userId: actorId, createdAt: new Date(Date.now() - 10 * minute),
        expiresAt: new Date(Date.now() + 60 * minute), revokedAt: null as Date | null };
    const actor = { id: actorId, tenantId, publicId: 'actor-public', role: 'ADMIN', deletedAt: null,
        suspendedAt: null, lockedUntil: null, pinLockedUntil: null, pinResetRequired: false };
    const role = { id: 'role-policy', name: 'Custom settings editor', isSystem: false, legacyRole: null,
        rolePermissions: [{ permission: { key: 'settings:write' } }] };
    const state: { tenantPresent: boolean; value: any } = {
        tenantPresent: true,
        value: { general: { timezone: 'America/Chicago' }, security: { sessionTimeoutMinutes: 120 } },
    };
    const entered = deferred(), gate = deferred(), writes = vi.fn(), audits = vi.fn();
    let active = false, reached = false;
    const assertActive = () => expect(active).toBe(true);
    const tx: any = {
        $executeRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
            assertActive();
            const text = Array.from(sql).join('').replace(/\s+/g, ' ').trim();
            if (text.startsWith('UPDATE')) {
                expect(text).toBe('UPDATE "Tenant" SET "updatedAt" = "updatedAt" WHERE "id" =');
            } else expect(text).toContain('set_current_tenant');
            expect(values).toEqual([tenantId]);
            return 1;
        }),
        $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
            assertActive();
            const text = (Array.isArray(sql) ? sql : sql.strings).join('');
            const values = flatten(Array.isArray(sql) ? args : sql.values);
            const table = (['Tenant', 'User', 'Session', 'Role'] as const).find(name => text.includes(`FROM "${name}"`));
            if (table === 'Tenant') expect(values).toEqual([tenantId]);
            if (table === 'User') expect(values).toContain(tenantId);
            if (table === 'Session') expect(values).toEqual([sessionId, actorId]);
            if (!reached && table === boundary) {
                reached = true; entered.release(); await gate.promise;
            }
            if (table === 'Tenant') return state.tenantPresent ? [{ id: tenantId }] : [];
            if (table === 'User') return [structuredClone(actor)];
            if (table === 'Session') return [structuredClone(session)];
            return [];
        }),
        user: { findFirst: vi.fn(async () => { assertActive(); return structuredClone(actor); }) },
        roleAssignment: { findMany: vi.fn(async () => { assertActive(); return [{ userId: actorId, roleId: role.id }]; }) },
        role: { findMany: vi.fn(async () => { assertActive(); return [structuredClone(role)]; }) },
        session: { findFirst: vi.fn(async ({ where, select }: any) => {
            assertActive();
            expect(where).toEqual({ id: sessionId, userId: actorId });
            expect(select).toMatchObject({ createdAt: true, expiresAt: true, revokedAt: true });
            return structuredClone(session);
        }) },
        tenant: {
            findUnique: vi.fn(async ({ where }: any) => {
                assertActive(); expect(where).toEqual({ id: tenantId });
                return state.tenantPresent ? structuredClone(tenant) : null;
            }),
            findUniqueOrThrow: vi.fn(async ({ where }: any) => {
                assertActive(); expect(where).toEqual({ id: tenantId });
                if (!state.tenantPresent) throw new Error('tenant missing');
                return structuredClone(tenant);
            }),
            update: vi.fn(async ({ data }: any) => { assertActive(); writes('Tenant', data); return { ...tenant, ...data }; }),
        },
        tenantSetting: {
            findUnique: vi.fn(async ({ where }: any) => {
                assertActive(); expect(where).toEqual({ tenantId_key: { tenantId, key: 'workspace_settings' } });
                return state.value === null ? null : { value: structuredClone(state.value) };
            }),
            upsert: vi.fn(async ({ update }: any) => { assertActive(); writes('TenantSetting', update.value); return {}; }),
        },
        auditLog: { create: vi.fn(async ({ data }: any) => { assertActive(); audits(data); return {}; }) },
    };
    const transaction = async (operation: any) => {
        expect(active).toBe(false); active = true;
        try { return await operation(tx); } finally { active = false; }
    };
    const identity: any = { sub: ` ${actorId} `, tenantId, sessionId: ` ${sessionId} `, role: 'ADMIN',
        permissions: ['settings:write'], roles: [], mfaVerified: true, mfaRequired: false };
    const legacy = new SettingsController(new TenantPrismaService({ $transaction: transaction } as any), undefined, verifiedSettingsObserver as never);
    const native = new WorkspaceSettingsService({ withTenant: async (selected: string, operation: any) => {
        expect(selected).toBe(tenantId); return transaction(operation);
    } } as never, { oidcSsoAvailable: false }, verifiedSettingsObserver);
    const call = (section: Section, security: any = { sessionTimeoutMinutes: 60 }) => {
        if (owner === 'legacy') {
            if (section === 'general') return legacy.updateGeneral({ name: 'Changed' }, { user: identity });
            if (section === 'team') return legacy.updateTeam({ defaultInviteRole: 'MANAGER' }, { user: identity });
            return legacy.updateSecurity(security, { user: identity });
        }
        if (section === 'general') return native.updateGeneral(identity, { name: 'Changed' });
        if (section === 'team') return native.updateTeam(identity, { defaultInviteRole: 'MANAGER' });
        return native.updateSecurity(identity, security);
    };
    return { tenant, session, state, tx, identity, entered, gate, writes, audits, call };
}

type Fixture = ReturnType<typeof harness>;
const denials: Array<[string, (h: Fixture) => void]> = [
    ['Tenant suspended', h => { h.tenant.status = 'SUSPENDED'; }],
    ['Tenant purged', h => { h.tenant.status = 'PURGED'; }],
    ['Tenant deleted', h => { h.tenant.deletedAt = new Date(); }],
    ['timeout shortened below current session age', h => { h.state.value.security.sessionTimeoutMinutes = 5; }],
    ['effective expiry is exactly now', h => { h.state.value.security.sessionTimeoutMinutes = 10; }],
    ['missing policy uses expired default', h => { h.state.value = null; h.session.createdAt = new Date(Date.now() - 480 * minute); }],
    ['invalid policy uses expired default', h => { h.state.value.security.sessionTimeoutMinutes = 1; h.session.createdAt = new Date(Date.now() - 481 * minute); }],
];
const allowances: Array<[string, (h: Fixture) => void]> = [
    ['ACTIVE workspace', () => {}],
    ['TRIAL workspace', h => { h.tenant.status = 'TRIAL'; }],
    ['PAST_DUE workspace', h => { h.tenant.status = 'PAST_DUE'; }],
    ['CANCELLED workspace', h => { h.tenant.status = 'CANCELLED'; }],
    ['minimum timeout with younger session', h => { h.state.value.security.sessionTimeoutMinutes = 5; h.session.createdAt = new Date(Date.now() - 4 * minute); }],
    ['missing policy with unexpired default', h => { h.state.value = null; h.session.createdAt = new Date(Date.now() - 479 * minute); }],
    ['invalid policy with unexpired default', h => { h.state.value.security.sessionTimeoutMinutes = 1; h.session.createdAt = new Date(Date.now() - 479 * minute); }],
    ['relaxed timeout uses committed policy', h => { h.state.value.security.sessionTimeoutMinutes = 60; }],
];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T06:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function settleAfterWait(h: Fixture, section: Section, change: (h: Fixture) => void, security?: any) {
    const pending = h.call(section, security).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        change(h); h.gate.release(); return await pending;
    } finally { h.gate.release(); await pending; }
}

function expectDenied(h: Fixture, result: Awaited<ReturnType<typeof settleAfterWait>>, owner: Owner) {
    expect(result.error).toBeInstanceOf(owner === 'legacy' ? ForbiddenException : ProblemError);
    if (owner === 'native') expect(result.error).toMatchObject({ status: 403, code: 'permission_denied' });
    expect(result.value).toBeUndefined();
    expect(h.writes).not.toHaveBeenCalled();
    expect(h.audits).not.toHaveBeenCalled();
}

describe('settings writes use current workspace/session policy after waits', () => {
    for (const owner of ['legacy', 'native'] as const) for (const section of ['general', 'team', 'security'] as const) {
        it.each(denials)(`${owner} ${section} rejects %s committed before Tenant acquisition`, async (_label, change) => {
            const h = harness(owner);
            expectDenied(h, await settleAfterWait(h, section, change), owner);
        });
        it.each(allowances)(`${owner} ${section} permits %s with current authority`, async (label, change) => {
            const h = harness(owner);
            if (label === 'relaxed timeout uses committed policy') h.state.value.security.sessionTimeoutMinutes = 5;
            const result = await settleAfterWait(h, section, change);
            expect(result.error).toBeUndefined();
            expect(result.value?.team.defaultInviteRole).toBe(section === 'team' ? 'MANAGER' : 'STAFF');
            expect(h.writes).toHaveBeenCalledTimes(section === 'general' ? 2 : 1);
            expect(h.audits).toHaveBeenCalledTimes(section === 'security' && label !== 'relaxed timeout uses committed policy' ? 1 : 0);
        });
        it(`${owner} ${section} fails closed when the workspace disappears before acquisition`, async () => {
            const h = harness(owner);
            expectDenied(h, await settleAfterWait(h, section, h => { h.state.tenantPresent = false; }), owner);
        });
        for (const boundary of ['Session', 'Role'] as const) {
            it(`${owner} ${section} rejects effective expiry reached while waiting on ${boundary}`, async () => {
                const h = harness(owner, boundary);
                h.state.value.security.sessionTimeoutMinutes = 15;
                expectDenied(h, await settleAfterWait(h, section, () => { vi.setSystemTime(Date.now() + 5 * minute); }), owner);
            });
        }
    }
    for (const owner of ['legacy', 'native'] as const) {
        it(`${owner} cannot extend an already expired session by submitting a longer new timeout`, async () => {
            const h = harness(owner);
            expectDenied(h, await settleAfterWait(h, 'security', h => { h.state.value.security.sessionTimeoutMinutes = 5; }, { sessionTimeoutMinutes: 1440 }), owner);
        });
        it(`${owner} policy relaxation does not revive an expired stored session`, async () => {
            const h = harness(owner);
            expectDenied(h, await settleAfterWait(h, 'general', h => {
                h.session.expiresAt = new Date(Date.now()); h.state.value.security.sessionTimeoutMinutes = 1440;
            }), owner);
        });
    }
});
