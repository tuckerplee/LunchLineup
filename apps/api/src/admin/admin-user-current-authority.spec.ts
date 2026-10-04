import { performance } from 'node:perf_hooks';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from './admin.controller';
import { adminAuthorityFixture } from './admin-user-authority.fixture';

const actions = ['patch', 'role', 'lock', 'unlock', 'pin', 'mfa', 'suspend', 'activate'] as const;
type Action = typeof actions[number];
function fixture(action: Action, observer = true) {
    const h = adminAuthorityFixture();
    h.controls.finalOrdinal = ['pin', 'mfa', 'suspend', 'activate'].includes(action) ? 3 : 2;
    if (action === 'activate') h.state.users[1].suspendedAt = new Date(Date.now() - 1000);
    const controller = new AdminController({ get: vi.fn() } as any, {} as any, {} as any,
        h.tenantDb, undefined, h.rbac, observer ? h.observer as any : undefined);
    const req = { ip: h.actor.ipAddress, headers: { 'user-agent': h.actor.userAgent },
        user: { sub: h.actor.userId, tenantId: h.actor.tenantId, sessionId: h.actor.sessionId,
            permissions: ['admin_portal:access'], role: 'SUPER_ADMIN', mfaVerified: true } };
    const call = () => {
        switch (action) {
            case 'patch': return controller.updateUser(req, 'user-1', { name: 'Changed', email: 'changed@example.com' });
            case 'role': return controller.updateUser(req, 'user-1', { role: 'STAFF' });
            case 'lock': return controller.lockUser(req, 'user-1', { minutes: 30 });
            case 'unlock': return controller.unlockUser(req, 'user-1');
            case 'pin': return controller.resetUserPin(req, 'user-1');
            case 'mfa': return controller.resetUserMfa(req, 'user-1', { confirmation: 'reset-mfa:user-1', reason: 'Lost all registered authenticators' });
            case 'suspend': return controller.suspendUser(req, 'user-1');
            case 'activate': return controller.activateUser(req, 'user-1');
        }
    };
    return { ...h, get state() { return h.state; }, controller, req, call };
}
const lifetimeModes = ['stored Session', 'effective policy', 'bounded MFA'] as const;
function isolateLifetime(h: ReturnType<typeof fixture>, mode: typeof lifetimeModes[number]) {
    if (mode === 'stored Session') { h.state.sessions[0].expiresAt = new Date(Date.now() + 1000); return 1001; }
    if (mode === 'effective policy') { h.state.security.sessionTimeoutMinutes = 5;
        h.state.sessions[0].createdAt = new Date(Date.now() - 4 * 60_000); return 60_000; }
    h.controls.observerTtl = 1000; return 1001;
}
const prefix = (items: Array<{ table: string; method: string }>) => items.map(({ table, method }) => ({ table, method }));
beforeEach(() => { vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'synthetic-admin-test-capability');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T09:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('real platform admin user current authority owner boundaries', () => {
    for (const action of actions) {
        it(action + ' has an actual current-RBAC positive and observes outside DB', async () => {
            const h = fixture(action); await expect(h.call()).resolves.toBeDefined();
            expect(h.committed.length).toBeGreaterThan(0); expect(prefix(h.attempts)).toEqual(prefix(h.committed));
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce(); expect(h.controls.active).toBe(0);
            // Service routes resolve identifiers in a separate readonly callback.
            expect(h.controls.transactions).toBe(['pin', 'mfa', 'suspend', 'activate'].includes(action) ? 3 : 2);
            expect(h.prisma.auditLog.create).toHaveBeenCalledOnce();
        });
        it.each(['Tenant', 'PIN', 'Session', 'policy', 'grant'] as const)(action + ' rereads current %s after unlocked observer', async field => {
            const h = fixture(action); let outside: ReturnType<typeof h.snapshot>;
            h.controls.beforeObserverReturn = () => {
                expect(h.controls.active).toBe(0);
                if (field === 'Tenant') h.state.tenants[0].status = 'SUSPENDED';
                if (field === 'PIN') h.state.users[0].pinResetRequired = true;
                if (field === 'Session') h.state.sessions[0].revokedAt = new Date();
                if (field === 'policy') { h.state.security.sessionTimeoutMinutes = 5;
                    h.state.sessions[0].createdAt = new Date(Date.now() - 6 * 60_000); }
                if (field === 'grant') h.state.roles[0].rolePermissions = [];
                outside = h.snapshot();
            };
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(outside!);
        });
        it.each(lifetimeModes)(action + ' refuses isolated %s expiry at exact final RolePermission authorization', async mode => {
            const h = fixture(action), jump = isolateLifetime(h, mode), snapshot = h.snapshot();
            h.controls.afterFinalRole = () => {
                expect(h.controls.transactions).toBe(h.controls.finalOrdinal); expect(h.controls.active).toBe(1);
                vi.setSystemTime(Date.now() + jump);
            };
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.controls.finalRoleVisits).toBe(1); expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]);
            expect(h.snapshot()).toEqual(snapshot);
        });
        it(action + ' refuses a missing trusted observer despite request MFA claims', async () => {
            const h = fixture(action, false);
            await expect(h.call()).rejects.toBeInstanceOf(ServiceUnavailableException);
            expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]);
        });
        it.each(lifetimeModes)(action + ' discards each reached effect prefix on isolated %s expiry after completion', async mode => {
            const positive = fixture(action); await positive.call(); const ledger = prefix(positive.committed);
            expect(ledger.length).toBeGreaterThan(0);
            for (let index = 1; index <= ledger.length; index++) {
                const h = fixture(action), jump = isolateLifetime(h, mode);
                const snapshot = h.snapshot(); h.controls.afterEffect = ordinal => {
                    if (ordinal === index) vi.setSystemTime(Date.now() + jump);
                };
                await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
                expect(prefix(h.attempts)).toEqual(ledger.slice(0, index)); expect(h.committed).toEqual([]);
                expect(h.snapshot()).toEqual(snapshot); expect(h.controls.active).toBe(0);
            }
        });
    }
    it('preserves normalized email intent when caller changes the request during unlocked observer', async () => {
        const h = fixture('patch'); const body: { name?: string; email?: string } = { email: ' CHANGED@example.com ' };
        h.controls.beforeObserverReturn = () => { expect(h.controls.active).toBe(0); body.email = undefined; };
        await expect(h.controller.updateUser(h.req, 'user-1', body)).resolves.toMatchObject({ email: 'changed@example.com' });
        expect(h.state.users[1].email).toBe('changed@example.com');
        expect(prefix(h.committed)).toEqual([
            { table: 'onboardingSignupAttempt', method: 'deleteMany' },
            { table: 'passwordResetToken', method: 'updateMany' },
            { table: 'passwordResetEmailOutbox', method: 'updateMany' },
            { table: 'user', method: 'update' }, { table: 'session', method: 'updateMany' },
            { table: 'auditLog', method: 'create' },
        ]);
        expect(h.state.sessions[1].revokedAt).toBeInstanceOf(Date);
        expect(h.state.audits[0].newValue.emailIdentityChanged).toBe(true);
    });
    it('guards final callback after PUT final readonly response', async () => {
        const h = fixture('patch'); h.state.sessions[0].expiresAt = new Date(Date.now() + 1000);
        const snapshot = h.snapshot(); h.controls.afterResponse = () => vi.setSystemTime(Date.now() + 1001);
        await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.attempts.length).toBeGreaterThan(0); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
    });
    it('denies delegated current actor administration of dual-source system-admin target', async () => {
        const h = fixture('patch'); h.state.users[0].role = 'ADMIN'; h.state.roles[0].legacyRole = null;
        h.state.roles[0].isSystem = false; h.state.users[1].role = 'SUPER_ADMIN';
        h.state.roles[1].legacyRole = 'SUPER_ADMIN';
        await expect(h.call()).rejects.toThrow('Only system admins can administer system admins');
        expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]);
    });
    it('keeps activation noop readonly but still refuses final policy expiry', async () => {
        const h = fixture('activate'); h.state.users[1].suspendedAt = null;
        await expect(h.call()).resolves.toMatchObject({ changed: false });
        expect(h.attempts).toEqual([]);
        const denied = fixture('activate'); denied.state.users[1].suspendedAt = null;
        denied.state.sessions[0].expiresAt = new Date(Date.now() + 1000);
        denied.controls.afterFinalRole = () => vi.setSystemTime(Date.now() + 1001);
        await expect(denied.call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(denied.attempts).toEqual([]); expect(denied.committed).toEqual([]);
    });
});

describe('Admin user owner integrated monotonic observation lifetime', () => {
    for (const action of actions) {
        it(action + ' refuses monotonic-only expiry at exact final RolePermission completion', async () => {
            let monotonic = 100_000;
            vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
            const h = fixture(action); h.controls.observerTtl = 1000;
            const wall = Date.now(), snapshot = h.snapshot();
            h.controls.afterFinalRole = () => {
                expect(h.controls.transactions).toBe(h.controls.finalOrdinal);
                expect(h.controls.active).toBe(1); monotonic += 1001;
            };
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
            expect(Date.now()).toBe(wall); expect(h.state.sessions[0].expiresAt.getTime()).toBeGreaterThan(wall);
            expect(h.controls.finalRoleVisits).toBe(1); expect(h.attempts).toEqual([]);
            expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
        });
        it(action + ' rolls back each reached effect completion on monotonic-only expiry', async () => {
            let monotonic = 100_000;
            vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
            const positive = fixture(action); await positive.call(); const ledger = prefix(positive.committed);
            expect(ledger.length).toBeGreaterThan(0);
            for (let index = 1; index <= ledger.length; index++) {
                monotonic = 100_000;
                const h = fixture(action); h.controls.observerTtl = 1000;
                const wall = Date.now(), snapshot = h.snapshot();
                h.controls.afterEffect = ordinal => { if (ordinal === index) monotonic += 1001; };
                await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
                expect(Date.now()).toBe(wall);
                expect(prefix(h.attempts)).toEqual(ledger.slice(0, index)); expect(h.committed).toEqual([]);
                expect(h.snapshot()).toEqual(snapshot); expect(h.controls.active).toBe(0);
                expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
            }
        });
    }
});
