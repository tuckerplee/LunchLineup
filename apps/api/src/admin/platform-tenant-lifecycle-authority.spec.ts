import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { installPlatformTenantAuthorityModel } from './platform-tenant-lifecycle-authority.fixture';
import { PrismaTenantCancellationIntentStore, TenantCancellationLifecycleService } from './tenant-cancellation-lifecycle.service';
import { capturePlatformTenantActor, withPlatformTenantLifecycleAdmission } from './platform-tenant-lifecycle-authority';

// Real controller, RbacService, store and reconciliation code; modeled transaction
// and provider seams. No native MVCC/locks, JWT/CSRF, HTTP, Redis or provider proof.
const T = 'opaque-target-tenant', P = 'opaque-platform-tenant';
const actor = { userId: 'admin-a', tenantId: P, sessionId: 'exact-session-a', ipAddress: '203.0.113.7', userAgent: 'authority-unit' };
const clone = <V,>(value: V): V => structuredClone(value);
const sqlText = (query: any): string => (Array.isArray(query) ? query : query.strings ?? []).join('?');
const sqlValues = (values: any[]): any[] => values.flatMap(value => value && typeof value === 'object' && Array.isArray(value.values)
    ? sqlValues(value.values) : [value]);
function gate() {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    return { started, release, enter: async () => { entered(); await pending; } };
}
async function bounded<V>(promise: Promise<V>): Promise<V> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Authority fixture gate exceeded 1500ms')), 1500);
    })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
function harness(status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' = 'ACTIVE', paid = false) {
    let state = { tenant: { id: T, slug: 'opaque-target', planTier: paid ? 'STARTER' : 'FREE', status,
        deletedAt: status === 'CANCELLED' ? new Date('2026-01-01T00:00:00Z') : null,
        retentionLegalHoldAt: null, stripeSubscriptionId: paid ? 'sub-controlled' : null, usageCredits: 41, auditLogs: [] },
        targetSession: { id: 'target-session', revokedAt: null as Date | null },
        intents: {} as Record<string, unknown>, audits: [] as any[] };
    let draft: typeof state | undefined, active = false;
    const controls = { transactions: 0, lifecycle: undefined as (() => Promise<void>) | undefined,
        beforeCommit: undefined as ((ordinal: number) => void) | undefined,
        afterEffect: undefined as (() => void) | undefined, recovery: false, failNextProviderMark: false };
    const options: unknown[] = [], events: string[] = [];
    const read = () => draft ?? state;
    const write = () => { draft ??= clone(state); return draft; };
    const prisma: any = {
        $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>, option: unknown) => {
            if (active) throw new Error('Unmodeled overlapping transaction');
            active = true; controls.transactions++; options.push(option); events.push('begin');
            try {
                const result = await operation(prisma); controls.beforeCommit?.(controls.transactions);
                if (draft) state = draft; events.push('commit'); return result;
            } catch (error) { events.push('rollback'); throw error; }
            finally { draft = undefined; active = false; }
        }),
        $executeRaw: vi.fn(async (query: TemplateStringsArray) => {
            const sql = sqlText(query);
            if (sql.includes('set_current_platform_admin') || sql.includes('set_current_tenant')) return 1;
            if (sql.includes('lock_tenant_lifecycle')) { events.push('lifecycle-lock'); await controls.lifecycle?.(); return 1; }
            if (controls.recovery && sql.includes('WITH stale AS (')) {
                const row = read().intents['internal:tenant-lifecycle-intent:platform_archive'] as any;
                expect(read().tenant).toMatchObject({ status: 'ACTIVE', retentionLegalHoldAt: null, stripeSubscriptionId: 'sub-controlled' });
                expect(row.subscriptionFingerprint).toBe(createHash('sha256').update(T + '\0sub-controlled').digest('hex'));
                expect(row.state).toBe('PENDING_PROVIDER');
                events.push('recovery-terminalize-no-stale-rows'); return 0;
            }
            throw new Error('Unexpected lifecycle execute');
        }),
        // Deliberately narrow SQL-result seam for the single eligible archive
        // used below. Actual claimRecoverable SQL is executed by the store but
        // this model does not emulate PostgreSQL locking or query evaluation.
        $queryRaw: vi.fn(async (query: any, ...args: any[]) => {
            if (!controls.recovery) throw new Error('Unexpected recovery SQL');
            const sql = sqlText(query), values = sqlValues(args.length ? args : query.values ?? []);
            const key = 'internal:tenant-lifecycle-intent:platform_archive', row = read().intents[key] as any;
            const eligible = () => row && row.state === 'PENDING_PROVIDER'
                && new Date(row.providerLeaseExpiresAt).getTime() <= Date.now()
                && read().tenant.status === 'ACTIVE' && read().tenant.retentionLegalHoldAt === null;
            if (sql.includes('SELECT setting."id", setting."tenantId", setting."key"')) {
                expect(values).toContain(1); expect(values.some(value => value instanceof Date && value.getTime() === Date.now())).toBe(true);
                return eligible() ? [{ id: 'owned-intent-setting', tenantId: T, key }] : [];
            }
            if (sql.includes('SELECT setting."value"') && sql.includes('FOR UPDATE')) {
                expect(values).toContain('owned-intent-setting'); expect(values).toContain(T); expect(values).toContain(key);
                return eligible() ? [{ value: clone(row) }] : [];
            }
            if (sql.includes('UPDATE "TenantSetting" setting') && sql.includes('RETURNING setting."value"')) {
                const [owner, expiresAt, attempts, settingId, tenantId, selectedKey, operationId, priorState, priorAttempts, priorOwner, priorExpiry] = values;
                expect(values).toHaveLength(11); expect(eligible()).toBe(true);
                expect([settingId, tenantId, selectedKey, operationId, priorState, priorAttempts, priorOwner, priorExpiry])
                    .toEqual(['owned-intent-setting', T, key, row.operationId, row.state, String(row.providerAttempts), row.providerLeaseOwner, row.providerLeaseExpiresAt]);
                expect(owner).not.toBe(row.providerLeaseOwner); expect(typeof owner).toBe('string');
                expect(attempts).toBe(row.providerAttempts + 1); expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
                const claimed = { ...row, providerLeaseOwner: owner, providerLeaseExpiresAt: expiresAt, providerAttempts: attempts };
                write().intents[key] = clone(claimed); events.push('recovery-claim-write'); return [{ value: clone(claimed) }];
            }
            throw new Error('Unmodeled recovery query');
        }),
        tenant: {
            findUnique: vi.fn(async ({ where }: any) => where.id === T ? clone(read().tenant) : null),
            findUniqueOrThrow: vi.fn(async ({ where }: any) => {
                if (where.id !== T) throw new Error('Unexpected lifecycle target'); return clone(read().tenant);
            }),
            update: vi.fn(async ({ where, data }: any) => {
                if (where.id !== T) throw new Error('Unexpected lifecycle mutation target');
                events.push('tenant-write'); Object.assign(write().tenant, clone(data)); controls.afterEffect?.(); return clone(read().tenant);
            }),
        },
        session: { updateMany: vi.fn(async ({ where, data }: any) => {
            if (where.user?.tenantId !== T) throw new Error('Unexpected target session mutation');
            write().targetSession.revokedAt = data.revokedAt; return { count: 1 };
        }) },
        tenantSetting: {
            findUnique: vi.fn(async ({ where }: any) => {
                if (where.tenantId_key.tenantId !== T) throw new Error('Unexpected intent owner');
                const value = read().intents[where.tenantId_key.key]; return value ? { value: clone(value) } : null;
            }),
            upsert: vi.fn(async ({ where, create, update }: any) => {
                if (where.tenantId_key.tenantId !== T) throw new Error('Unexpected intent mutation owner');
                const key = where.tenantId_key.key; const value = read().intents[key] ? update.value : create.value;
                if (controls.failNextProviderMark && value.state === 'PROVIDER_APPLIED') {
                    controls.failNextProviderMark = false; events.push('injected-pre-mark-persistence-loss');
                    throw new Error('controlled provider-result persistence loss');
                }
                write().intents[key] = clone(value); events.push('intent-write'); controls.afterEffect?.(); return { value: clone(value) };
            }),
        },
        auditLog: { create: vi.fn(async ({ data }: any) => {
            if (data.tenantId !== T) throw new Error('Unexpected lifecycle audit owner');
            write().audits.push(clone(data)); events.push('audit-write'); return clone(data);
        }) },
    };
    const authority = installPlatformTenantAuthorityModel(prisma, actor);
    const tenantDb = new TenantPrismaService(prisma), rbac = new RbacService(tenantDb);
    const authorize = vi.spyOn(rbac, 'authorizePlatformAdminTenantMutationInTransaction');
    const billing = { assertTenantSubscriptionActive: vi.fn(async (): Promise<void> => undefined),
        cancelTenantSubscriptionAtPeriodEnd: vi.fn(async (..._args: any[]): Promise<any> => ({ action: 'scheduled' as const, stripeSubscriptionId: 'sub-controlled',
            stripeStatus: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2027-01-01T00:00:00.000Z', cancelAt: null,
            canceledAt: null, cancellationBehavior: 'cancel_at_period_end' as const })) };
    const store = new PrismaTenantCancellationIntentStore(tenantDb, 120_000, () => new Date(), rbac, authority.observer);
    const service = new TenantCancellationLifecycleService(tenantDb, () => billing, store);
    const controller = new AdminController({ get: vi.fn() } as any, {} as any, {} as any, tenantDb, billing as any, rbac, authority.observer as any);
    controller.onModuleDestroy(); // stop only unrelated TenantExport interval immediately
    const request = { ip: actor.ipAddress, headers: { 'user-agent': actor.userAgent },
        user: { sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId, permissions: ['admin_portal:access'] } };
    return { prisma, authority, controls, options, events, tenantDb, rbac, authorize, billing, store, service, controller, request,
        snapshot: () => clone(state), intent: () => clone(state.intents['internal:tenant-lifecycle-intent:platform_archive']) as any };
}
beforeEach(() => vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'modeled-authority-capability'));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const mutations = ['activate', 'restore'] as const;
const revocations = ['session', 'permission'] as const;
function revoke(h: ReturnType<typeof harness>, kind: typeof revocations[number]) {
    if (kind === 'session') h.authority.session.revokedAt = new Date(); else h.authority.permissions = [];
}
function noNewEffects(h: ReturnType<typeof harness>, before: ReturnType<ReturnType<typeof harness>['snapshot']>) {
    expect(h.snapshot()).toEqual(before); expect(h.prisma.tenant.update).not.toHaveBeenCalled();
    expect(h.prisma.session.updateMany).not.toHaveBeenCalled(); expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(h.prisma.tenantSetting.upsert).not.toHaveBeenCalled();
}
describe('Platform tenant live authority and durable admission', () => {
    for (const action of mutations) {
        for (const revocation of revocations) {
            it(`${action} denies ${revocation} revocation committed during provider eligibility`, async () => {
                const h = harness(action === 'restore' ? 'CANCELLED' : 'SUSPENDED', true), before = h.snapshot(), g = gate();
                h.billing.assertTenantSubscriptionActive.mockImplementation(g.enter);
                const result = h.controller[action === 'activate' ? 'activateTenant' : 'restoreTenant'](h.request, T);
                const rejection = expect(result).rejects.toBeInstanceOf(ForbiddenException);
                try { await bounded(g.started); revoke(h, revocation); }
                finally { g.release(); }
                await bounded(rejection); noNewEffects(h, before);
                expect(h.authorize).not.toHaveBeenCalled(); // real preflight rejects before final target authorization
                expect(h.prisma.user.findFirst).toHaveBeenCalled();
                expect(h.billing.assertTenantSubscriptionActive).toHaveBeenCalledWith(T, 'sub-controlled');
                expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
            });
            it(`${action} denies ${revocation} revocation before the final advisory wait returns`, async () => {
                const h = harness(action === 'restore' ? 'CANCELLED' : 'SUSPENDED'), before = h.snapshot(), g = gate();
                h.controls.lifecycle = g.enter;
                const result = h.controller[action === 'activate' ? 'activateTenant' : 'restoreTenant'](h.request, T);
                const rejection = expect(result).rejects.toBeInstanceOf(ForbiddenException);
                try { await bounded(g.started); expect(h.authorize).not.toHaveBeenCalled(); revoke(h, revocation); }
                finally { g.release(); }
                await bounded(rejection); noNewEffects(h, before);
                expect(h.billing.assertTenantSubscriptionActive).not.toHaveBeenCalled();
                expect(h.options.at(-1)).toEqual({ isolationLevel: 'Serializable' });
            });
        }
        it(`${action} keeps captured request actor and audit attribution after provider await`, async () => {
            const h = harness(action === 'restore' ? 'CANCELLED' : 'SUSPENDED', true), g = gate();
            h.billing.assertTenantSubscriptionActive.mockImplementation(g.enter);
            const pending = h.controller[action === 'activate' ? 'activateTenant' : 'restoreTenant'](h.request, T);
            try {
                await bounded(g.started); Object.assign(h.request.user, { sub: 'replacement', tenantId: 'replacement', sessionId: 'replacement' });
                h.request.ip = '198.51.100.99'; h.request.headers['user-agent'] = 'changed';
            } finally { g.release(); }
            await expect(bounded<Awaited<typeof pending>>(pending)).resolves.toEqual(action === 'activate' ? { id: T, status: 'ACTIVE' } : { id: T, restored: true });
            expect(h.authorize).toHaveBeenCalledWith(h.prisma, T, { userId: actor.userId, tenantId: P, sessionId: actor.sessionId });
            expect(h.snapshot().audits).toEqual([expect.objectContaining({ userId: null, actorUserId: actor.userId,
                actorTenantId: P, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
                action: action === 'activate' ? 'TENANT_ACTIVATED' : 'TENANT_RESTORED' })]);
            expect(h.snapshot().tenant).toMatchObject({ status: 'ACTIVE', deletedAt: null, usageCredits: 41 });
            expect(h.snapshot().targetSession.revokedAt).toBeNull();
            const order = h.prisma.$queryRaw.mock.calls.map((args: any[]) => sqlText(args[0]));
            expect(order[0]).toContain('FROM "Tenant"'); expect(order[0]).toContain('ORDER BY "id"');
            const lifecycleCall = h.prisma.$executeRaw.mock.calls.findIndex((args: any[]) => sqlText(args[0]).includes('lock_tenant_lifecycle'));
            const targetLock = h.prisma.$queryRaw.mock.calls.findIndex((args: any[]) => sqlText(args[0]).includes('FROM "Tenant"')
                && sqlValues(args.slice(1)).includes(T));
            expect(targetLock).toBeGreaterThanOrEqual(0);
            expect(h.prisma.$executeRaw.mock.invocationCallOrder[lifecycleCall]).toBeLessThan(h.prisma.$queryRaw.mock.invocationCallOrder[targetLock]);
        });
    }
    for (const existing of ['absent', 'pending', 'finalized'] as const) {
        for (const revocation of revocations) {
            it(`archive denies ${revocation} revocation before ${existing} intent admission or replay`, async () => {
                const h = harness();
                if (existing === 'pending') await h.store.prepare({ kind: 'PLATFORM_ARCHIVE', tenantId: T, actor });
                if (existing === 'finalized') await h.service.archivePlatform(actor, T);
                const before = h.snapshot(), providerBefore = h.billing.cancelTenantSubscriptionAtPeriodEnd.mock.calls.length;
                const writeBefore = h.prisma.tenantSetting.upsert.mock.calls.length, auditBefore = h.prisma.auditLog.create.mock.calls.length;
                const targetReads = () => h.prisma.tenantSetting.findUnique.mock.calls.filter((args: any[]) => args[0].where.tenantId_key.tenantId === T).length;
                const readBefore = targetReads(), g = gate();
                h.controls.lifecycle = g.enter;
                const result = h.service.archivePlatform(actor, T); const rejection = expect(result).rejects.toBeInstanceOf(ForbiddenException);
                try { await bounded(g.started); revoke(h, revocation); } finally { g.release(); }
                await bounded(rejection);
                expect(h.snapshot()).toEqual(before);
                expect(targetReads()).toBe(readBefore);
                expect(h.prisma.tenantSetting.upsert).toHaveBeenCalledTimes(writeBefore);
                expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(auditBefore);
                expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(providerBefore);
            });
        }
    }
    for (const sessionId of [undefined, null, '', '   '] as const) {
        it(`archive rejects missing request session ${JSON.stringify(sessionId)} before a custom store can admit it`, async () => {
            const h = harness(), prepare = vi.fn();
            const service = new TenantCancellationLifecycleService(h.tenantDb, () => h.billing, { prepare } as any);
            await expect(service.archivePlatform({ ...actor, sessionId } as any, T)).rejects.toBeInstanceOf(ForbiddenException);
            expect(prepare).not.toHaveBeenCalled(); expect(h.prisma.$transaction).not.toHaveBeenCalled();
        });
    }
    for (const revocation of revocations) {
        it(`admitted archive survives later ${revocation} revocation without reauthorizing reconciliation`, async () => {
            const h = harness('ACTIVE', true), g = gate();
            h.billing.cancelTenantSubscriptionAtPeriodEnd.mockImplementation(async () => { await g.enter(); return {
                action: 'scheduled', stripeSubscriptionId: 'sub-controlled', stripeStatus: 'active', cancelAtPeriodEnd: true,
                currentPeriodEnd: '2027-01-01T00:00:00.000Z', cancelAt: null, canceledAt: null, cancellationBehavior: 'cancel_at_period_end' }; });
            const result = h.service.archivePlatform(actor, T);
            let operationId: string;
            try {
                await bounded(g.started); operationId = h.intent().operationId;
                expect(h.intent()).toMatchObject({ state: 'PENDING_PROVIDER', actorUserId: actor.userId, actorTenantId: P, providerAttempts: 1 });
                expect(h.snapshot().tenant).toMatchObject({ status: 'ACTIVE', deletedAt: null });
                revoke(h, revocation);
            } finally { g.release(); }
            await expect(bounded(result)).resolves.toEqual({ id: T, archived: true });
            expect(h.authorize).toHaveBeenCalledOnce(); expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
            expect(h.intent()).toMatchObject({ operationId: operationId!, state: 'FINALIZED', providerLeaseOwner: null, providerAttempts: 1 });
            expect(h.intent()).not.toHaveProperty('sessionId');
            expect(h.snapshot().tenant).toMatchObject({ status: 'CANCELLED', deletedAt: expect.any(Date), usageCredits: 41 });
            expect(h.snapshot().targetSession.revokedAt).toBeInstanceOf(Date);
            expect(h.snapshot().audits.map(row => row.action)).toEqual(['TENANT_ARCHIVE_INTENT_RECORDED_BY_PLATFORM', 'TENANT_ARCHIVED']);
            const before = h.snapshot(); await expect(h.service.archivePlatform(actor, T)).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.snapshot()).toEqual(before);
        });
    }
    it('retries only the transaction and reauthorizes the same captured session after a serializable conflict', async () => {
        const h = harness('SUSPENDED', true), before = h.snapshot();
        h.controls.beforeCommit = ordinal => {
            if (ordinal === 3) { h.authority.session.revokedAt = new Date(); h.request.user.sessionId = 'replacement'; throw { code: 'P2034' }; }
        };
        await expect(h.controller.activateTenant(h.request, T)).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.authorize).toHaveBeenCalledTimes(2);
        expect(h.authorize.mock.calls.map(row => row[2].sessionId)).toEqual([actor.sessionId, actor.sessionId]);
        expect(h.snapshot()).toEqual(before); expect(h.billing.assertTenantSubscriptionActive).toHaveBeenCalledOnce();
        expect(h.controls.transactions).toBe(4); expect(h.events.filter(event => event === 'rollback')).toHaveLength(2);
    });
    it('stops after two serializable conflicts and preserves rolled-back target state', async () => {
        const h = harness('SUSPENDED'), before = h.snapshot();
        h.controls.beforeCommit = ordinal => { if (ordinal >= 3) throw { code: 'P2034' }; };
        await expect(h.controller.activateTenant(h.request, T)).rejects.toMatchObject({ status: 409 });
        expect(h.authorize).toHaveBeenCalledTimes(2); expect(h.controls.transactions).toBe(4); expect(h.snapshot()).toEqual(before);
    });
    it('keeps customer cancellation outside platform request authorization', async () => {
        const h = harness('ACTIVE', true); h.authority.present = false;
        await expect(h.service.cancelCustomer({ tenantId: T, userId: 'customer', ipAddress: null, userAgent: null },
            { confirmation: 'opaque-target' })).resolves.toMatchObject({ id: T, status: 'ACTIVE' });
        expect(h.authorize).not.toHaveBeenCalled();
    });
    it('does not reacquire request authority when completing an already prepared archive', async () => {
        const h = harness(); const admitted = await h.store.prepare({ kind: 'PLATFORM_ARCHIVE', tenantId: T, actor });
        const captured = clone(admitted); h.authority.present = false; h.authority.session.revokedAt = new Date();
        await expect(h.service.reconcilePrepared(captured)).resolves.toMatchObject({ intent: { state: 'FINALIZED' } });
        expect(h.authorize).toHaveBeenCalledOnce(); expect(h.intent().operationId).toBe(admitted.intent.operationId);
    });
    it('captures archive attribution before admission lock wait', async () => {
        const h = harness(), g = gate(), mutable = { ...actor }; h.controls.lifecycle = g.enter;
        const pending = h.service.archivePlatform(mutable, T);
        try { await bounded(g.started); Object.assign(mutable, { userId: 'changed', tenantId: 'changed', sessionId: 'changed', userAgent: 'changed' }); }
        finally { h.controls.lifecycle = undefined; g.release(); }
        await expect(bounded(pending)).resolves.toEqual({ id: T, archived: true });
        expect(h.authorize).toHaveBeenCalledWith(h.prisma, T, { userId: actor.userId, tenantId: P, sessionId: actor.sessionId });
        expect(h.intent()).toMatchObject({ actorUserId: actor.userId, actorTenantId: P, userAgent: actor.userAgent });
    });
    it('checks live authorization before a direct admission callback and supplies immutable captured actor', async () => {
        const h = harness(), mutation = vi.fn(async (_tx: unknown, captured: unknown) => captured);
        expect(Object.isFrozen(capturePlatformTenantActor(actor))).toBe(true);
        await expect(withPlatformTenantLifecycleAdmission(h.rbac, T, actor, h.authority.observer, mutation)).resolves.toEqual(actor);
        expect(mutation).toHaveBeenCalledOnce(); expect(Object.isFrozen(mutation.mock.calls[0][1])).toBe(true);
        h.authority.permissions = []; mutation.mockClear();
        await expect(withPlatformTenantLifecycleAdmission(h.rbac, T, actor, h.authority.observer, mutation)).rejects.toBeInstanceOf(ForbiddenException);
        expect(mutation).not.toHaveBeenCalled();
    });

    it('suspend uses the shared current policy and attributes target-session revocation', async () => {
        const h = harness();
        await expect(h.controller.suspendTenant(h.request, T)).resolves.toEqual({ id: T, status: 'SUSPENDED' });
        expect(h.authorize).toHaveBeenCalledOnce(); expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(h.snapshot().tenant).toMatchObject({ status: 'SUSPENDED', usageCredits: 41 });
        expect(h.snapshot().targetSession.revokedAt).toBeInstanceOf(Date);
        expect(h.snapshot().audits).toEqual([expect.objectContaining({ actorUserId: actor.userId,
            actorTenantId: P, action: 'TENANT_SUSPENDED' })]);
    });
    it('suspend rejects a revoked exact session before any mutation', async () => {
        const h = harness(), before = h.snapshot(); h.authority.session.revokedAt = new Date();
        await expect(h.controller.suspendTenant(h.request, T)).rejects.toBeInstanceOf(ForbiddenException);
        noNewEffects(h, before); expect(h.authority.observer.observeSessionMfa).not.toHaveBeenCalled();
    });

    // These execute the real current-mutation policy at the final lifecycle
    // boundary. Date-only fake time leaves bounded gate timers operational.
    for (const action of ['activate', 'restore', 'archive'] as const) {
        const invoke = (h: ReturnType<typeof harness>) => action === 'archive'
            ? h.service.archivePlatform(actor, T)
            : h.controller[action === 'activate' ? 'activateTenant' : 'restoreTenant'](h.request, T);
        const make = () => harness(action === 'restore' ? 'CANCELLED' : action === 'activate' ? 'SUSPENDED' : 'ACTIVE');
        for (const deadline of ['stored-session', 'workspace-timeout'] as const) {
            it(`${action} rejects ${deadline} expiry during final role authorization before any effect`, async () => {
                vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now();
                const h = make(), before = h.snapshot(); let advanced = false;
                if (deadline === 'stored-session') h.authority.session.expiresAt = new Date(now + 1);
                else {
                    h.authority.security.sessionTimeoutMinutes = 5;
                    h.authority.session.createdAt = new Date(now - 299_999);
                    expect(h.authority.session.expiresAt.getTime()).toBeGreaterThan(now + 2);
                }
                h.authority.afterAssignments = () => {
                    if (!advanced && h.authorize.mock.calls.length === 1) { advanced = true; vi.setSystemTime(now + 2); }
                };
                await expect(invoke(h)).rejects.toThrow('Administrator session is no longer active');
                expect(advanced).toBe(true); expect(h.authorize).toHaveBeenCalledOnce(); noNewEffects(h, before);
                expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledOnce();
                expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
            });
        }
        for (const workspace of ['missing', 'deleted', 'SUSPENDED', 'PURGED'] as const) {
            it(`${action} rejects actor workspace ${workspace} committed before the final lifecycle lock returns`, async () => {
                const h = make(), before = h.snapshot(), g = gate(); h.controls.lifecycle = g.enter;
                const pending = invoke(h), rejection = expect(pending).rejects.toThrow('The workspace is no longer active');
                try {
                    await bounded(g.started);
                    if (workspace === 'missing') h.authority.workspacePresent = false;
                    else if (workspace === 'deleted') h.authority.workspace.deletedAt = new Date();
                    else h.authority.workspace.status = workspace;
                } finally { g.release(); }
                await bounded(rejection); noNewEffects(h, before);
                expect(h.authorize).toHaveBeenCalledOnce(); expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
            });
        }
        for (const workspace of ['CANCELLED', 'PAST_DUE'] as const) {
            it(`${action} allows eligible nondeleted actor workspace ${workspace}`, async () => {
                const h = make(); h.authority.workspace.status = workspace;
                await expect(invoke(h)).resolves.toEqual(action === 'archive' ? { id: T, archived: true }
                    : action === 'restore' ? { id: T, restored: true } : { id: T, status: 'ACTIVE' });
                expect(h.authorize).toHaveBeenCalledOnce(); expect(h.authority.workspace.deletedAt).toBeNull();
                expect(h.snapshot().tenant.usageCredits).toBe(41);
            });
        }
        for (const proof of ['unavailable', 'absent', 'wrong-session', 'expired-during-role-wait'] as const) {
            it(`${action} fails closed for MFA proof ${proof} before effects`, async () => {
                vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now();
                const h = make(), before = h.snapshot(); let advanced = false;
                if (proof === 'unavailable') h.authority.observer.observeSessionMfa.mockRejectedValueOnce(new Error('private Redis detail'));
                if (proof === 'absent') h.authority.observer.observeSessionMfa.mockResolvedValueOnce(null as any);
                if (proof === 'wrong-session') {
                    const observe = h.authority.observer.observeSessionMfa.getMockImplementation()!;
                    h.authority.observer.observeSessionMfa.mockImplementationOnce(async identity => ({ ...(await observe(identity)), sessionId: 'another-session' }));
                }
                if (proof === 'expired-during-role-wait') h.authority.afterAssignments = () => {
                    if (!advanced && h.authorize.mock.calls.length === 1) { advanced = true; vi.setSystemTime(now + 120_001); }
                };
                await expect(invoke(h)).rejects.toBeInstanceOf(proof === 'unavailable' ? ServiceUnavailableException : ForbiddenException);
                noNewEffects(h, before); expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledOnce();
                expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledWith({ sub: actor.userId, tenantId: P, sessionId: actor.sessionId });
                expect(h.authorize).toHaveBeenCalledTimes(proof === 'expired-during-role-wait' ? 1 : 0);
                expect(advanced).toBe(proof === 'expired-during-role-wait');
                expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
            });
        }
        it(`${action} rolls back an attempted first effect when its current session expires before completion`, async () => {
            vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now();
            const h = make(), before = h.snapshot(); h.authority.session.expiresAt = new Date(now + 1);
            let effects = 0; h.controls.afterEffect = () => { effects++; vi.setSystemTime(now + 2); };
            await expect(invoke(h)).rejects.toThrow('Administrator session is no longer active');
            expect(effects).toBe(1); expect(h.snapshot()).toEqual(before); expect(h.events.at(-1)).toBe('rollback');
            expect(h.prisma.auditLog.create).not.toHaveBeenCalled(); expect(h.prisma.session.updateMany).not.toHaveBeenCalled();
            expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
            if (action === 'archive') { expect(h.prisma.tenantSetting.upsert).toHaveBeenCalledOnce(); expect(h.prisma.tenant.update).not.toHaveBeenCalled(); }
            else { expect(h.prisma.tenant.update).toHaveBeenCalledOnce(); expect(h.prisma.tenantSetting.upsert).not.toHaveBeenCalled(); }
        });
    }

    it('claims an expired admitted archive after provider success and lost result persistence, then reconciles without the actor', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now();
        const h = harness('ACTIVE', true), effects = new Set<string>(); let physicalEffects = 0;
        h.controls.failNextProviderMark = true;
        h.billing.cancelTenantSubscriptionAtPeriodEnd.mockImplementation(async (tenantId: string, subscriptionId: string, operationId: string) => {
            expect([tenantId, subscriptionId]).toEqual([T, 'sub-controlled']);
            const first = !effects.has(operationId); if (first) { effects.add(operationId); physicalEffects++; }
            return { action: first ? 'scheduled' : 'already_scheduled', stripeSubscriptionId: subscriptionId,
                stripeStatus: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2027-01-01T00:00:00.000Z',
                cancelAt: null, canceledAt: null, cancellationBehavior: 'cancel_at_period_end' };
        });
        await expect(bounded(h.service.archivePlatform(actor, T))).rejects.toThrow('Tenant billing lifecycle is pending reconciliation.');
        const retained = h.intent(); expect(retained).toMatchObject({ state: 'PENDING_PROVIDER', providerAttempts: 1,
            providerResult: null, actorUserId: actor.userId, actorTenantId: P, userAgent: actor.userAgent });
        expect(retained.providerLeaseOwner).toEqual(expect.any(String)); expect(physicalEffects).toBe(1);
        expect(h.snapshot().tenant).toMatchObject({ status: 'ACTIVE', deletedAt: null, usageCredits: 41 });
        expect(h.snapshot().audits.map(row => row.action)).toEqual(['TENANT_ARCHIVE_INTENT_RECORDED_BY_PLATFORM']);
        h.authority.present = false; h.authority.session.revokedAt = new Date(); h.authority.permissions = [];
        h.authority.workspace.deletedAt = new Date();
        h.controls.recovery = true;
        await expect(bounded(h.store.claimRecoverable(1))).resolves.toEqual([]); // live lease is not stolen
        vi.setSystemTime(Math.max(now, Date.parse(retained.providerLeaseExpiresAt)) + 1);
        const claimed = await bounded(h.store.claimRecoverable(1)); expect(claimed).toHaveLength(1);
        expect(claimed[0].intent).toMatchObject({ operationId: retained.operationId, state: 'PENDING_PROVIDER', providerAttempts: 2,
            actorUserId: actor.userId, actorTenantId: P, userAgent: actor.userAgent });
        expect(claimed[0].providerLeaseOwner).not.toBe(retained.providerLeaseOwner);
        await expect(bounded(h.service.reconcilePrepared(claimed[0]))).resolves.toMatchObject({ intent: { state: 'FINALIZED' } });
        expect(h.authorize).toHaveBeenCalledOnce(); expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
        expect(h.billing.cancelTenantSubscriptionAtPeriodEnd.mock.calls.map(row => row[2])).toEqual([retained.operationId, retained.operationId]);
        expect(physicalEffects).toBe(1); expect(effects).toEqual(new Set([retained.operationId]));
        expect(h.intent()).toMatchObject({ operationId: retained.operationId, state: 'FINALIZED', providerLeaseOwner: null,
            providerAttempts: 2, actorUserId: actor.userId, actorTenantId: P });
        expect(h.snapshot().tenant).toMatchObject({ status: 'CANCELLED', deletedAt: expect.any(Date), usageCredits: 41 });
        expect(h.snapshot().targetSession.revokedAt).toBeInstanceOf(Date);
        expect(h.snapshot().audits.map(row => row.action)).toEqual(['TENANT_ARCHIVE_INTENT_RECORDED_BY_PLATFORM', 'TENANT_ARCHIVED']);
        expect(h.events).toContain('injected-pre-mark-persistence-loss'); expect(h.events).toContain('recovery-claim-write');
    });
    it('finishes an admitted archive when session and finite MFA proof expire during provider work', async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now();
        const h = harness('ACTIVE', true), g = gate(); h.authority.session.expiresAt = new Date(now + 1);
        const provider = h.billing.cancelTenantSubscriptionAtPeriodEnd.getMockImplementation()!;
        h.billing.cancelTenantSubscriptionAtPeriodEnd.mockImplementation(async (...args: any[]) => { await g.enter(); return provider(...args); });
        const result = h.service.archivePlatform(actor, T); let operationId: string;
        try { await bounded(g.started); operationId = h.intent().operationId; vi.setSystemTime(now + 120_001); }
        finally { g.release(); }
        await expect(bounded(result)).resolves.toEqual({ id: T, archived: true });
        expect(h.intent()).toMatchObject({ operationId: operationId!, state: 'FINALIZED' });
        expect(h.authorize).toHaveBeenCalledOnce(); expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledOnce();
        expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
        const before = h.snapshot(); await expect(h.service.archivePlatform(actor, T)).rejects.toThrow('Administrator session is no longer active');
        expect(h.snapshot()).toEqual(before); expect(h.billing.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
    });
    for (const action of ['activate', 'restore', 'archive'] as const) {
        const invoke = (h: ReturnType<typeof harness>) => action === 'archive' ? h.service.archivePlatform(actor, T)
            : h.controller[action === 'activate' ? 'activateTenant' : 'restoreTenant'](h.request, T);
        const make = () => harness(action === 'restore' ? 'CANCELLED' : action === 'activate' ? 'SUSPENDED' : 'ACTIVE');
        it(`${action} accepts exact live S1 when only another session S2 was revoked`, async () => {
            const h = make(); h.authority.otherSession.revokedAt = new Date();
            await expect(invoke(h)).resolves.toMatchObject({ id: T });
            expect(h.authority.session.revokedAt).toBeNull(); expect(h.authorize).toHaveBeenCalledWith(h.prisma, T,
                { userId: actor.userId, tenantId: P, sessionId: actor.sessionId });
            expect(h.prisma.session.findFirst).toHaveBeenCalledTimes(2);
            expect(h.prisma.session.findFirst.mock.calls.every(([args]: any[]) => args.where.id === actor.sessionId)).toBe(true);
            expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledWith({ sub: actor.userId, tenantId: P, sessionId: actor.sessionId });
        });
        for (const deadline of ['stored-session', 'workspace-timeout', 'finite-mfa'] as const) {
            it(`${action} accepts near-valid ${deadline} proof through the final role wait`, async () => {
                vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now(); const h = make(); let advanced = false;
                if (deadline === 'stored-session') h.authority.session.expiresAt = new Date(now + 10);
                if (deadline === 'workspace-timeout') {
                    h.authority.security.sessionTimeoutMinutes = 5; h.authority.session.createdAt = new Date(now - 299_990);
                }
                const elapsed = deadline === 'finite-mfa' ? 119_999 : 9;
                h.authority.afterAssignments = () => {
                    if (!advanced && h.authorize.mock.calls.length === 1) { advanced = true; vi.setSystemTime(now + elapsed); }
                };
                await expect(invoke(h)).resolves.toEqual(action === 'archive' ? { id: T, archived: true }
                    : action === 'restore' ? { id: T, restored: true } : { id: T, status: 'ACTIVE' });
                expect(advanced).toBe(true); expect(h.authorize).toHaveBeenCalledOnce();
                expect(h.snapshot().tenant.usageCredits).toBe(41); expect(h.authority.observer.observeSessionMfa).toHaveBeenCalledOnce();
                const observation = await h.authority.observer.observeSessionMfa.mock.results[0].value;
                expect(observation.expiresAtEpochMs).toBe(now + 120_000); expect(observation.expiresAtEpochMs).toBeGreaterThan(Date.now());
            });
        }
    }
});
