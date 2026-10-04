import { ConflictException, ForbiddenException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The sole external adapter: never execute object-store/filesystem deletion.
// The authorization runner, outbox encryption and anonymizer are actual owners.
const externalStorage = vi.hoisted(() => vi.fn(async (_keys: string[]) => {}));
vi.mock('../availability-imports/availability-imports.service', () => ({
    deleteAvailabilityImportStorageKeys: externalStorage,
}));
import { expectedEffects, identity, ownerFixture, targetId, type Route } from './invitation-deletion-authority.fixture';

const routes: Route[] = ['invite', 'retry', 'reissue', 'deactivate'];
const lifetimeModes = ['stored Session', 'effective policy', 'MFA wall', 'MFA monotonic'] as const;
type Fixture = ReturnType<typeof ownerFixture>;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T13:00:00Z'));
    externalStorage.mockReset(); externalStorage.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function lifetime(h: Fixture, mode: typeof lifetimeModes[number]) {
    let jump = 1001;
    if (mode === 'stored Session') h.state.tables.session[0].expiresAt = new Date(Date.now() + 1000);
    if (mode === 'effective policy') {
        h.state.security.sessionTimeoutMinutes = 5;
        h.state.tables.session[0].createdAt = new Date(Date.now() - 4 * 60_000); jump = 60_000;
    }
    if (mode.startsWith('MFA')) h.controls.observerTtl = 1000;
    let monotonic = performance.now();
    const spy = mode === 'MFA monotonic' ? vi.spyOn(performance, 'now').mockImplementation(() => monotonic) : undefined;
    return { expire: () => mode === 'MFA monotonic' ? monotonic += jump : vi.setSystemTime(Date.now() + jump),
        restore: () => spy?.mockRestore() };
}
function assertRollback(h: Fixture, before: ReturnType<Fixture['snapshot']>, prefix: string[]) {
    expect(h.attempts).toEqual(prefix); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(before);
    expect(h.controls.active).toBe(0); expect(externalStorage).not.toHaveBeenCalled();
}
function storageBoundary(h: Fixture) {
    externalStorage.mockImplementation(async keys => {
        expect(keys).toEqual(['tenant-1/failed.pdf', 'tenant-1/succeeded.pdf']);
        expect(h.controls.active).toBe(0); expect(h.committed).toEqual(expectedEffects.deactivate);
        expect(h.state.tables.user.find(row => row.id === targetId)?.deletedAt).toBeInstanceOf(Date);
    });
}
function assertEncryption(h: Fixture) {
    const delivery = h.state.tables.staffInvitationOutbox.find(row => row.userId === targetId)!;
    expect(Buffer.isBuffer(delivery.encryptedPayload)).toBe(true);
    expect(Buffer.isBuffer(delivery.encryptionNonce)).toBe(true); expect(delivery.encryptionNonce.length).toBe(12);
    expect(delivery.encryptionTag.length).toBe(16); expect(delivery.payloadVersion).toBe(1);
    expect(delivery.encryptedPayload.toString('utf8')).not.toContain('staff-1@example.com');
    expect(h.decrypt(delivery)).toEqual({ recipient: 'staff-1@example.com', template: 'staff_invitation' });
}

describe('actual Users invitation/deletion owner authority with modeled scoped database', () => {
    for (const route of routes) {
        it(`${route}: viable populated scoped owner commits exact declared effects`, async () => {
            const h = ownerFixture(route); const before = h.snapshot();
            if (route === 'deactivate') storageBoundary(h);
            const result = await h.call();
            expect(h.attempts).toEqual(expectedEffects[route]); expect(h.committed).toEqual(expectedEffects[route]);
            expect(h.controls.transactions).toBe(2); expect(h.controls.active).toBe(0);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
            for (const [name, rows] of Object.entries(before.tables)) {
                const foreign = rows.filter(row => row.tenantId === 'foreign-tenant' || row.userId === 'foreign-user');
                expect(h.state.tables[name].filter(row => row.tenantId === 'foreign-tenant' || row.userId === 'foreign-user')).toEqual(foreign);
            }
            if (route === 'invite') {
                expect(result).toMatchObject({ id: targetId, status: 'INVITED', invitationDelivery: { status: 'queued' } });
                expect(h.state.tables.roleAssignment.find(row => row.userId === targetId)?.roleId).toBe('staff-role'); assertEncryption(h);
            }
            if (route === 'retry') {
                expect(result).toMatchObject({ invitationDelivery: { status: 'queued', attempts: 1 } });
                expect(h.state.tables.staffInvitationOutbox.find(row => row.userId === targetId)?.manualRetryCount).toBe(1);
            }
            if (route === 'reissue') { expect(result).toMatchObject({ invitationDelivery: { status: 'queued', attempts: 0 } }); assertEncryption(h); }
            if (route === 'deactivate') {
                expect(h.state.balances[0].balance).toBe(6); expect(h.state.balances[1]).toEqual(before.balances[1]);
                expect(h.state.tables.creditTransaction.find(row => row.id.startsWith('feature-refund'))).toMatchObject({ amount: 1, debtAmount: 0, balanceAfter: 6 });
                expect(h.state.tables.shift.map(row => row.userId)).toEqual([null, null, targetId, 'foreign-user']);
                expect(h.state.tables.schedule.map(row => row.revision)).toEqual([5, 7, 9]);
                expect(h.state.tables.availabilityImportJob[0]).toMatchObject({ status: 'CANCELLED', storageKey: null, requestedByUserId: null, parsedAvailability: null });
                expect(h.state.tables.availabilityImportJob[1]).toMatchObject({ status: 'SUCCEEDED', storageKey: null, requestedByUserId: null, parsedAvailability: null });
                expect(h.state.tables.user.find(row => row.id === targetId)).toMatchObject({ name: 'Deleted user', email: null, passwordHash: null, mfaBackupCodes: [] });
                expect(h.state.tables.session[1]).toMatchObject({ revokedAt: expect.any(Date), selectorHash: null, ipAddress: '[deleted]' });
                for (const name of ['refreshTokenReplay', 'passwordResetToken', 'passwordResetEmailOutbox', 'mfaTotpClaim', 'onboardingSignupAttempt', 'notificationOutbox', 'notification'])
                    expect(h.state.tables[name].some(row => row.userId === targetId)).toBe(false);
                expect(externalStorage).toHaveBeenCalledOnce();
            } else expect(externalStorage).not.toHaveBeenCalled();
        });
        it.each(['Tenant', 'PIN', 'Session', 'grant', 'policy', 'suspended actor', 'moved actor', 'foreign Session owner'] as const)(`${route}: rereads current %s after released observer`, async condition => {
            const h = ownerFixture(route); let afterChange!: ReturnType<Fixture['snapshot']>;
            h.controls.onObserver = () => {
                expect(h.controls.active).toBe(0); expect(h.controls.transactions).toBe(1);
                if (condition === 'Tenant') h.state.tables.tenant[0].status = 'SUSPENDED';
                if (condition === 'PIN') h.state.tables.user[0].pinResetRequired = true;
                if (condition === 'Session') h.state.tables.session[0].revokedAt = new Date();
                if (condition === 'foreign Session owner') h.state.tables.session[0].userId = 'foreign-user';
                if (condition === 'grant') h.state.tables.role[0].rolePermissions = [];
                if (condition === 'policy') { h.state.security.sessionTimeoutMinutes = 5; h.state.tables.session[0].createdAt = new Date(Date.now() - 6 * 60_000); }
                if (condition === 'suspended actor') h.state.tables.user[0].suspendedAt = new Date();
                if (condition === 'moved actor') h.state.tables.user[0].tenantId = 'foreign-tenant';
                afterChange = h.snapshot();
            };
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException); assertRollback(h, afterChange, []);
            expect(h.controls.transactions).toBe(2);
        });
        it.each(lifetimeModes)(`${route}: isolated %s expires at exact final full-authorizer RolePermission completion`, async mode => {
            const h = ownerFixture(route); const clock = lifetime(h, mode); const before = h.snapshot();
            h.controls.onFinalRole = () => { expect(h.controls.transactions).toBe(2); expect(h.controls.active).toBe(1); clock.expire(); };
            try { await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException); expect(h.controls.finalRoleVisits).toBe(1); assertRollback(h, before, []); }
            finally { clock.restore(); }
        });
        it.each(lifetimeModes)(`${route}: each reached effect completion rolls back isolated %s with exact attempted prefix`, async mode => {
            const positive = ownerFixture(route); if (route === 'deactivate') storageBoundary(positive);
            await positive.call(); expect(positive.committed).toEqual(expectedEffects[route]);
            for (let index = 1; index <= expectedEffects[route].length; index++) {
                externalStorage.mockClear(); const h = ownerFixture(route); const clock = lifetime(h, mode); const before = h.snapshot();
                h.controls.onEffect = completed => { if (completed === index) clock.expire(); };
                try { await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException); assertRollback(h, before, expectedEffects[route].slice(0, index)); }
                finally { clock.restore(); }
            }
        });
    }

    it('archived email invitation reactivates credentials, assignments and encrypted terminal delivery with actual helpers', async () => {
        const h = ownerFixture('invite', true); const before = h.snapshot(); await h.call();
        expect(h.committed).toEqual(expectedEffects.archivedInvite); assertEncryption(h);
        expect(h.state.tables.user[1]).toMatchObject({ deletedAt: null, passwordHash: null, pinHash: null, mfaEnabled: false });
        expect(h.state.tables.session[1].revokedAt).toBeInstanceOf(Date);
        expect(h.state.tables.passwordResetToken[0].consumedAt).toBeInstanceOf(Date);
        expect(h.state.tables.passwordResetEmailOutbox[0]).toMatchObject({ status: 'DEAD_LETTERED', deadLetteredAt: expect.any(Date) });
        expect(h.state.tables.mfaTotpClaim).toEqual([before.tables.mfaTotpClaim[1]]);
        expect(h.state.tables.staffInvitationOutbox[0].id).not.toBe(before.tables.staffInvitationOutbox[0].id);
        expect(h.state.tables.auditLog[0].action).toBe('USER_REACTIVATED');
    });
    it.each(lifetimeModes)('archived invite: each effect completion rolls back isolated %s', async mode => {
        const positive = ownerFixture('invite', true); await positive.call(); expect(positive.committed).toEqual(expectedEffects.archivedInvite);
        for (let index = 1; index <= expectedEffects.archivedInvite.length; index++) {
            const h = ownerFixture('invite', true); const clock = lifetime(h, mode); const before = h.snapshot();
            h.controls.onEffect = completed => { if (completed === index) clock.expire(); };
            try { await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException); assertRollback(h, before, expectedEffects.archivedInvite.slice(0, index)); }
            finally { clock.restore(); }
        }
    });
    for (const action of ['retry pending', 'reissue replay', 'reissue final response'] as const) {
        const prepared = async () => {
            const h = ownerFixture(action === 'retry pending' ? 'retry' : 'reissue');
            if (action === 'retry pending') h.state.tables.staffInvitationOutbox[0].status = 'PENDING';
            if (action === 'reissue replay') { await h.call(); h.resetAccounting(); }
            return h;
        };
        it(`${action}: viable late read control commits the expected readonly or write result`, async () => {
            const h = await prepared(); let reached = 0;
            h.controls.onOutboxRead = visit => { if (visit === (action === 'reissue final response' ? 3 : 1)) { expect(h.controls.active).toBe(1); reached++; } };
            await expect(h.call()).resolves.toMatchObject({ invitationDelivery: { status: 'queued' } }); expect(reached).toBe(1);
            expect(h.committed).toEqual(action === 'reissue final response' ? expectedEffects.reissue : []);
        });
        it.each(lifetimeModes)(`${action}: late readonly return refuses isolated %s before callback completion`, async mode => {
            const h = await prepared(); const clock = lifetime(h, mode); const before = h.snapshot(); let reached = 0;
            h.controls.onOutboxRead = visit => { if (visit === (action === 'reissue final response' ? 3 : 1)) { reached++; clock.expire(); } };
            try { await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException); expect(reached).toBe(1);
                assertRollback(h, before, action === 'reissue final response' ? expectedEffects.reissue : []); }
            finally { clock.restore(); }
        });
    }
    it('reissue audit receipt refuses reuse after delivery row rotation without any additional effect', async () => {
        const h = ownerFixture('reissue'); await h.call(); h.resetAccounting();
        h.state.tables.staffInvitationOutbox = h.state.tables.staffInvitationOutbox.filter(row => row.userId !== targetId);
        const before = h.snapshot(); await expect(h.call()).rejects.toBeInstanceOf(ConflictException); assertRollback(h, before, []);
    });
    it('does not delegate a current invitation role grant the actor does not hold', async () => {
        const h = ownerFixture('invite'); h.controls.onObserver = () => { h.state.tables.role[1].rolePermissions.push({ permission: { key: 'locations:write' } }); };
        await expect(h.call()).rejects.toThrow('Cannot grant a role with permissions you do not hold'); expect(h.attempts).toEqual([]);
    });
    for (const route of ['retry', 'reissue', 'deactivate'] as const) it(`${route}: preserves current target dominance`, async () => {
        const h = ownerFixture(route); h.state.tables.user[1].role = 'ADMIN'; h.state.tables.role[1].legacyRole = 'ADMIN';
        const before = h.snapshot(); await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException); assertRollback(h, before, []);
    });
    it('invalid credit debit provenance refuses deletion before refund or external cleanup', async () => {
        const h = ownerFixture('deactivate'); h.state.tables.creditTransaction[0].tenantId = 'foreign-tenant'; const before = h.snapshot();
        await expect(h.call()).rejects.toThrow('Availability import debit provenance is invalid'); assertRollback(h, before, []);
    });
    it('existing exact refund provenance prevents a second stateful refund while retaining deletion cleanup', async () => {
        const h = ownerFixture('deactivate'); h.state.tables.creditTransaction.push({ id: 'feature-refund-availability-import:failed-import', tenantId: identity.tenantId,
            amount: 1, debtAmount: 0, reason: 'Availability PDF import refund (failed-import)', balanceAfter: 6, debtAfter: 0 });
        h.state.balances[0].balance = 6;
        externalStorage.mockImplementation(async keys => { expect(keys).toEqual(['tenant-1/failed.pdf', 'tenant-1/succeeded.pdf']); expect(h.controls.active).toBe(0); });
        await h.call(); expect(h.committed).toEqual(expectedEffects.deactivate.slice(1)); expect(h.state.balances[0].balance).toBe(6);
        expect(h.state.tables.creditTransaction.filter(row => row.id.startsWith('feature-refund'))).toHaveLength(1);
    });
    it('external storage failure occurs after the single committed deletion and does not retry database effects', async () => {
        const h = ownerFixture('deactivate'); const error = new Error('Controlled external adapter failure');
        externalStorage.mockImplementation(async keys => {
            expect(keys).toEqual(['tenant-1/failed.pdf', 'tenant-1/succeeded.pdf']); expect(h.controls.active).toBe(0);
            expect(h.committed).toEqual(expectedEffects.deactivate); throw error;
        });
        await expect(h.call()).rejects.toBe(error); expect(h.committed).toEqual(expectedEffects.deactivate);
        expect(h.controls.transactions).toBe(2); expect(externalStorage).toHaveBeenCalledOnce();
        expect(h.state.tables.user.find(row => row.id === targetId)?.deletedAt).toBeInstanceOf(Date);
    });
});
