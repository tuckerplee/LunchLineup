import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { ProblemError } from '../../../api-v2/src/platform/problem';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { SettingsController } from './settings.controller';
import { WorkspaceSettingsService } from '../../../api-v2/src/settings/settings.service';

type Owner = 'legacy' | 'native';
type Section = 'general' | 'team' | 'security';
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const flatten = (values: unknown[]): unknown[] => values.flatMap(value => (
    value && typeof value === 'object' && 'values' in value
        ? flatten((value as { values: unknown[] }).values) : [value]
));

// Actual settings owners and RBAC helpers, controlled current database state.
// Database callbacks overlap only explicit gates; no real locks/RLS/rollback.
function harness(owner: Owner, observerAvailable = true) {
    const ids = { sub: 'mfa-actor', tenantId: 'mfa-tenant', sessionId: 'mfa-session' };
    const user = { id: ids.sub, tenantId: ids.tenantId, role: 'STAFF', publicId: 'actor-public',
        deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null, pinResetRequired: false };
    const tenant = { name: 'Original', slug: 'original', status: 'ACTIVE', deletedAt: null as Date | null };
    const session = { id: ids.sessionId, userId: ids.sub, createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null as Date | null };
    const state = { assigned: true, value: { general: { timezone: 'America/Chicago' },
        security: { requireMfaForAll: false, sessionTimeoutMinutes: 120 } } };
    const role = { id: 'settings-role', name: 'Settings editor', isSystem: false, legacyRole: null,
        rolePermissions: [{ permission: { key: 'settings:write' } }] };
    const firstEntered = deferred(), firstGate = deferred();
    const finalEntered = deferred(), finalGate = deferred();
    const observerEntered = deferred(), observerGate = deferred();
    let active = 0, calls = 0;
    let pauseFinal: 'Tenant' | 'User' | 'Session' | 'Role' | undefined;
    let pauseObserver = false;
    let observation: any = { ...ids, expiresAtEpochMs: Date.now() + 60_000,
        expiresAtMonotonicMs: performance.now() + 60_000 };
    let readerError: Error | undefined;
    const writes = vi.fn(), audits = vi.fn();
    const tx: any = {
        $executeRaw: vi.fn(async () => { expect(active).toBe(1); return 1; }),
        $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
            expect(active).toBe(1);
            const text = (Array.isArray(sql) ? sql : sql.strings).join('');
            const values = flatten(Array.isArray(sql) ? args : sql.values);
            const table = (['Tenant', 'User', 'Session', 'Role'] as const).find(name => text.includes(`FROM "${name}"`));
            if (table === 'Tenant') expect(values).toEqual([ids.tenantId]);
            if (table === 'Session') expect(values).toEqual([ids.sessionId, ids.sub]);
            if (calls === 1 && table === 'Tenant') { firstEntered.release(); await firstGate.promise; }
            if (pauseFinal && calls === 2 && table === pauseFinal) { finalEntered.release(); await finalGate.promise; }
            if (table === 'User') return [structuredClone(user)];
            if (table === 'Session') return [structuredClone(session)];
            return [];
        }),
        tenant: {
            findUnique: vi.fn(async ({ where }: any) => {
                expect(active).toBe(1); expect(where).toEqual({ id: ids.tenantId }); return structuredClone(tenant);
            }),
            findUniqueOrThrow: vi.fn(async () => { expect(active).toBe(1); return structuredClone(tenant); }),
            update: vi.fn(async ({ where, data }: any) => {
                expect(active).toBe(1); expect(where).toEqual({ id: ids.tenantId }); writes('Tenant', data); return { ...tenant, ...data };
            }),
        },
        user: { findFirst: vi.fn(async ({ where }: any) => {
            expect(active).toBe(1); expect(where).toMatchObject({ id: ids.sub, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null });
            return user.deletedAt || user.suspendedAt ? null : structuredClone(user);
        }) },
        session: { findFirst: vi.fn(async ({ where }: any) => {
            expect(active).toBe(1); expect(where).toEqual({ id: ids.sessionId, userId: ids.sub }); return structuredClone(session);
        }) },
        roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
            expect(active).toBe(1); expect(where.tenantId).toBe(ids.tenantId); return state.assigned ? [{ userId: ids.sub, roleId: role.id }] : [];
        }) },
        role: { findMany: vi.fn(async ({ where }: any) => {
            expect(active).toBe(1); expect(where.tenantId).toBe(ids.tenantId); return state.assigned ? [structuredClone(role)] : [];
        }) },
        tenantSetting: {
            findUnique: vi.fn(async ({ where }: any) => {
                expect(active).toBe(1); expect(where).toEqual({ tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } });
                return { value: structuredClone(state.value) };
            }),
            upsert: vi.fn(async ({ where, create, update }: any) => {
                expect(active).toBe(1); expect(where).toEqual({ tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } });
                expect(create).toMatchObject({ tenantId: ids.tenantId, key: 'workspace_settings' });
                expect(create.value).toEqual(update.value); writes('TenantSetting', update.value); return {};
            }),
        },
        auditLog: { create: vi.fn(async ({ data }: any) => {
            expect(active).toBe(1); expect(data).toMatchObject({ tenantId: ids.tenantId, actorUserId: ids.sub }); audits(data); return {};
        }) },
    };
    const transaction = async (operation: any) => {
        expect(active).toBe(0); active++; calls++;
        try { return await operation(tx); } finally { active--; }
    };
    const observer = { observeSessionMfa: vi.fn(async (identity: any) => {
        expect(active).toBe(0); expect(writes).not.toHaveBeenCalled(); expect(audits).not.toHaveBeenCalled();
        expect(identity).toEqual(ids); observerEntered.release();
        if (pauseObserver) await observerGate.promise;
        if (readerError) throw readerError;
        return structuredClone(observation);
    }) };
    const identity: any = { ...ids, permissions: ['settings:write'], mfaVerified: true, mfaRequired: false };
    // The extra observer argument is ignored by the unchanged baseline classes.
    const legacy = new (SettingsController as any)(new TenantPrismaService({ $transaction: transaction } as any), undefined,
        observerAvailable ? observer : undefined);
    const native = new (WorkspaceSettingsService as any)({ withTenant: async (tenantId: string, operation: any) => {
        expect(tenantId).toBe(ids.tenantId); return transaction(operation);
    } }, { oidcSsoAvailable: false }, observerAvailable ? observer : undefined);
    const call = (section: Section) => {
        if (owner === 'legacy') {
            if (section === 'general') return legacy.updateGeneral({ name: 'Changed' }, { user: identity });
            if (section === 'team') return legacy.updateTeam({ defaultInviteRole: 'MANAGER' }, { user: identity });
            return legacy.updateSecurity({ sessionTimeoutMinutes: 60 }, { user: identity });
        }
        if (section === 'general') return native.updateGeneral(identity, { name: 'Changed' });
        if (section === 'team') return native.updateTeam(identity, { defaultInviteRole: 'MANAGER' });
        return native.updateSecurity(identity, { sessionTimeoutMinutes: 60 });
    };
    return { ids, identity, user, tenant, session, state, role, writes, audits, tx, observer,
        firstEntered, firstGate, finalEntered, finalGate, observerEntered, observerGate, call,
        setObservation: (value: any) => { observation = value; }, observation: () => structuredClone(observation),
        setReaderError: () => { readerError = new Error('private reader failure'); },
        setPauseFinal: (table: 'Tenant' | 'User' | 'Session' | 'Role') => { pauseFinal = table; },
        setPauseObserver: () => { pauseObserver = true; }, calls: () => calls };
}

type Fixture = ReturnType<typeof harness>;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T07:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function afterFirstWait(h: Fixture, section: Section, change: (h: Fixture) => void) {
    const pending = h.call(section).then((value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.firstEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        change(h); h.firstGate.release(); return await pending;
    } finally { h.firstGate.release(); h.finalGate.release(); h.observerGate.release(); await pending; }
}

const denials: Array<[string, (h: Fixture) => void, number]> = [
    ['absent marker despite verified JWT claim', h => { h.setObservation(null); }, 403],
    ['expired marker despite verified JWT claim', h => { h.setObservation({ ...h.observation(), expiresAtEpochMs: Date.now() }); }, 403],
    ['unbounded verification deadline', h => { h.setObservation({ ...h.observation(), expiresAtEpochMs: Infinity }); }, 403],
    ['wrong actor observation', h => { h.setObservation({ ...h.observation(), sub: 'other-user' }); }, 403],
    ['wrong workspace observation', h => { h.setObservation({ ...h.observation(), tenantId: 'other-tenant' }); }, 403],
    ['wrong session observation', h => { h.setObservation({ ...h.observation(), sessionId: 'other-session' }); }, 403],
    ['unavailable observer capability', () => {}, 503],
    ['verification reader rejection', h => { h.setReaderError(); }, 503],
    ['forced PIN reset committed during first Tenant wait', h => { h.user.pinResetRequired = true; }, 403],
];


const finalChanges: Array<[string, (h: Fixture) => void]> = [
    ['forced PIN reset', h => { h.user.pinResetRequired = true; }],
    ['account suspension', h => { (h.user as any).suspendedAt = new Date(); }],
    ['revoked session', h => { h.session.revokedAt = new Date(); }],
    ['expired stored session', h => { h.session.expiresAt = new Date(Date.now()); }],
    ['removed role assignment', h => { h.state.assigned = false; }],
    ['removed role permission', h => { h.role.rolePermissions = []; }],
    ['inactive workspace', h => { h.tenant.status = 'SUSPENDED'; }],
    ['policy-shortened lifetime', h => {
        h.session.createdAt = new Date(Date.now() - 10 * 60_000);
        h.state.value.security.sessionTimeoutMinutes = 5;
    }],
];
function expectDenied(h: Fixture, owner: Owner, result: any, assignmentRemoved = false) {
    expect(result.error).toBeInstanceOf(owner === 'native' ? ProblemError : assignmentRemoved ? UnauthorizedException : ForbiddenException);
    if (owner === 'native') expect(result.error.status).toBe(403);
    expect(result.value).toBeUndefined(); expect(h.writes).not.toHaveBeenCalled(); expect(h.audits).not.toHaveBeenCalled();
}
async function afterLaterWait(h: Fixture, section: Section, stage: 'observer' | 'final', change: () => void) {
    const pending = h.call(section).then((value: any) => ({ value, error: undefined }), (error: any) => ({ value: undefined, error }));
    const entered = stage === 'observer' ? h.observerEntered : h.finalEntered;
    try {
        expect(await Promise.race([h.firstEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        h.firstGate.release();
        expect(await Promise.race([entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        change(); h.observerGate.release(); h.finalGate.release(); return await pending;
    } finally { h.firstGate.release(); h.observerGate.release(); h.finalGate.release(); await pending; }
}

describe('settings mutation MFA/PIN boundary', () => {
    for (const owner of ['legacy', 'native'] as const) for (const section of ['general', 'team', 'security'] as const) {
        it.each(denials)(`${owner} ${section} rejects %s`, async (label, change, status) => {
            const h = harness(owner, label !== 'unavailable observer capability');
            const result = await afterFirstWait(h, section, change);
            expect(result.error).toBeInstanceOf(owner === 'native' ? ProblemError : status === 503 ? ServiceUnavailableException : ForbiddenException);
            if (owner === 'native') expect(result.error.status).toBe(status);
            expect(result.value).toBeUndefined(); expect(h.writes).not.toHaveBeenCalled(); expect(h.audits).not.toHaveBeenCalled();
            if (label.startsWith('forced PIN')) expect(h.observer.observeSessionMfa).not.toHaveBeenCalled();
        });

        it.each(['Tenant', 'User', 'Session', 'Role'] as const)(`${owner} ${section} expires verification after the final %s wait`, async table => {
            const h = harness(owner); h.setPauseFinal(table);
            const result = await afterLaterWait(h, section, 'final', () => {
                vi.setSystemTime(Date.now() + 60_000);
            });
            expectDenied(h, owner, result);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
            expect(h.calls()).toBe(2);
        });
        it.each(['Tenant', 'User', 'Session', 'Role'] as const)(`${owner} ${section} rejects a monotonic deadline after the final %s wait`, async table => {
            const h = harness(owner); h.setPauseFinal(table);
            // Wall time remains valid even after a backwards wall-clock change.
            const result = await afterLaterWait(h, section, 'final', () => {
                vi.setSystemTime(Date.now() - 3_600_000);
                vi.spyOn(performance, 'now').mockReturnValue(h.observation().expiresAtMonotonicMs);
            });
            expectDenied(h, owner, result);
        });
        it.each(finalChanges)(`${owner} ${section} rechecks %s after external verification`, async (_label, change) => {
            const h = harness(owner); h.setPauseObserver();
            const result = await afterLaterWait(h, section, 'observer', () => change(h));
            expectDenied(h, owner, result, _label === 'removed role assignment');
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(h.calls()).toBe(2);
        });
        it(`${owner} ${section} merges the second-pass aggregate`, async () => {
            const h = harness(owner); h.setPauseObserver();
            const result = await afterLaterWait(h, section, 'observer', () => {
                h.state.value.general.timezone = 'America/Los_Angeles';
                h.state.value.security.sessionTimeoutMinutes = 300;
            });
            expect(result.error).toBeUndefined();
            expect(result.value.general.timezone).toBe('America/Los_Angeles');
            const saved = h.writes.mock.calls.find(([model]) => model === 'TenantSetting')![1];
            expect(saved.general.timezone).toBe('America/Los_Angeles');
            expect(saved.security.sessionTimeoutMinutes).toBe(section === 'security' ? 60 : 300);
        });
        it(`${owner} ${section} binds padded request IDs to canonical writes and audit`, async () => {
            const h = harness(owner); h.identity.sub = ` ${h.ids.sub} `; h.identity.sessionId = ` ${h.ids.sessionId} `;
            const result = await afterFirstWait(h, section, () => {});
            expect(result.error).toBeUndefined(); expect(h.observer.observeSessionMfa).toHaveBeenCalledWith(h.ids);
            expect(h.writes).toHaveBeenCalledTimes(section === 'general' ? 2 : 1);
            expect(h.audits).toHaveBeenCalledTimes(section === 'security' ? 1 : 0);
        });
        it(`${owner} ${section} cannot be retargeted by observer argument mutation`, async () => {
            const h = harness(owner);
            h.observer.observeSessionMfa.mockImplementationOnce(async argument => {
                expect(argument).toEqual(h.ids); argument.sub = 'different'; argument.sessionId = 'different';
                argument.tenantId = 'different'; return h.observation();
            });
            const result = await afterFirstWait(h, section, () => {});
            expect(result.error).toBeUndefined(); expect(h.calls()).toBe(2);
            expect(h.writes).toHaveBeenCalledTimes(section === 'general' ? 2 : 1);
        });
        it(`${owner} ${section} admits a current marker with live custom role authority`, async () => {
            const h = harness(owner);
            const result = await afterFirstWait(h, section, h => { h.identity.mfaVerified = false; });
            expect(result.error).toBeUndefined(); expect(result.value).toHaveProperty('general');
            expect(h.writes).toHaveBeenCalledTimes(section === 'general' ? 2 : 1);
            expect(h.audits).toHaveBeenCalledTimes(section === 'security' ? 1 : 0);
        });
    }
});
