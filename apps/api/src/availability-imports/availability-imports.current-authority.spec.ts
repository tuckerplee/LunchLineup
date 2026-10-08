import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availabilityAuthorityFixture, importBounded, importIds,
    type AvailabilityAuthorityFixture, type ImportGate, type ImportLifetime, type ImportMode } from '../../../../tests/fixtures/availability-import-authority';

// Actual Controller -> Service -> Rbac/TenantPrisma and Auth MFA observation.
// Closed committed-row/transaction model; no native locks/RLS/Redis/filesystem,
// publisher or HTTP-guard acceptance is claimed by these local regressions.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const clone = <T>(v: T): T => structuredClone(v);
const capture = <T>(p: Promise<T>) => p.then(value => ({ value, error: null }), error => ({ value: null, error }));
async function paused(f: AvailabilityAuthorityFixture, change: () => void) {
    const result = capture(f.call());
    try {
        expect(await importBounded(Promise.race([f.arrived.promise.then(() => 'entered'), result.then(() => 'settled')]))).toBe('entered');
        change();
    } finally { f.released.release(); await importBounded(result); }
    return result;
}
function refused(result: Awaited<ReturnType<typeof paused>>, f: AvailabilityAuthorityFixture, before: unknown) {
    expect(result.error).toBeInstanceOf(ForbiddenException); expect(result.value).toBeNull();
    expect(f.financial()).toEqual(before); expect(f.committed).toEqual([]); f.assertNoFilesOrKick();
}
const modes: ImportMode[] = ['new', 'replay', 'cancel', 'terminal'];
const writers: Array<[string, (f: AvailabilityAuthorityFixture) => void]> = [
    ['session revoked', f => { f.state.session[0].revokedAt = new Date(); }],
    ['session expired', f => { f.state.session[0].expiresAt = new Date(0); }],
    ['session removed', f => { f.state.session = []; }],
    ['session owned by another actor', f => { f.state.session[0].userId = 'foreign-actor'; }],
    ['grant removed', f => { f.state.role[0].rolePermissions = []; }],
    ['role deleted', f => { f.state.role[0].deletedAt = new Date(); }],
    ['assignment removed', f => { f.state.roleAssignment = []; }],
    ['PIN reset required', f => { f.state.user[0].pinResetRequired = true; }],
];
const lifetimes: ImportLifetime[] = ['stored', 'policy', 'mfa-wall', 'mfa-monotonic'];
const awaits: Array<[ImportMode, ImportGate]> = [['new', 'file'], ['new', 'debit'], ['cancel', 'refund'],
    ['cancel', 'audit'], ['replay', 'result-ledger']];
function populated(mode: ImportMode, value: any) {
    expect(value).toMatchObject({ userId: importIds.target,
        status: mode === 'cancel' || mode === 'terminal' ? 'CANCELLED' : 'PENDING',
        parsedAvailability: null, settlement: { chargedCredits: 1,
            refundedCredits: mode === 'cancel' || mode === 'terminal' ? 1 : 0,
            pending: mode === 'new' || mode === 'replay' } });
    expect(value.id).toEqual(expect.any(String)); expect(value.createdAt).toBeInstanceOf(Date);
    for (const secret of ['encryptedSourcePayload', 'storageKey', 'requestHash', 'requestKeyHash', 'targetIdentityHash', 'creditConsumption']) {
        expect(value).not.toHaveProperty(secret);
    }
}

describe('retained availability import current mutation authority', () => {
    for (const mode of modes) it.each(writers)(`${mode} rejects %s committed after entry admission`, async (_name, change) => {
        const f = availabilityAuthorityFixture(mode), before = f.financial();
        f.pauseEntry(); const result = await paused(f, () => change(f)); refused(await result, f, before);
    });

    for (const [mode, at] of awaits) for (const lifetime of lifetimes) {
        it(`${mode} rejects ${lifetime} expiry across ${at} without committed effects`, async () => {
            const f = availabilityAuthorityFixture(mode, lifetime), before = f.financial(); f.pauseAt(at);
            const result = await paused(f, f.expire); refused(await result, f, before);
            expect(f.reached).toContain(at); expect(f.evalMarker).toHaveBeenCalledOnce();
            if (at === 'debit' || at === 'refund' || at === 'audit') expect(f.attempted.length).toBeGreaterThan(0);
        });
        it(`${mode} returns a populated result while ${lifetime} remains current across ${at}`, async () => {
            const f = availabilityAuthorityFixture(mode, lifetime); f.pauseAt(at);
            const result = await paused(f, f.near); const value = await result;
            expect(value.error).toBeNull(); populated(mode, value.value); expect(f.active).toBe(false);
            // Legacy domain success is a populated control; exact new protocol
            // observation/locks are asserted separately below.
            expect(f.evalMarker.mock.calls.length).toBeLessThanOrEqual(1);
            if (mode === 'new') f.assertEncrypted();
            else expect(f.files.size).toBe(0);
        });
    }

    it.each([-2, -1, 0, NaN, Infinity, '1000'])('refuses unverified/nonfinite/unbounded MFA marker %s despite request flags', async marker => {
        const f = availabilityAuthorityFixture(), before = f.financial(); f.marker(marker);
        const result = await capture(f.call()); refused(result, f, before);
        expect(f.evalMarker).toHaveBeenCalledOnce(); expect(f.attempted).toEqual([]);
    });
    for (const reason of ['offline', 'failure'] as const) it(`withholds import when trusted MFA observer is ${reason}`, async () => {
        const f = availabilityAuthorityFixture(), before = f.financial();
        if (reason === 'offline') f.redisOffline(); else f.redisFailure();
        const result = await capture(f.call()); expect(result.error).toBeInstanceOf(ServiceUnavailableException);
        expect((result.error as Error).message).not.toContain('private-redis-error');
        expect(f.financial()).toEqual(before); expect(f.attempted).toEqual([]); f.assertNoFilesOrKick();
    });

    for (const change of ['session', 'grant', 'marker'] as const) it(`unique-race recovery refuses newly invalid ${change} without a new MFA proof`, async () => {
        const f = availabilityAuthorityFixture('new', change === 'marker' ? 'mfa-wall' : 'stored'); f.uniqueRace(() => {
            if (change === 'session') f.state.session[0].revokedAt = new Date();
            if (change === 'grant') f.state.role[0].rolePermissions = [];
            if (change === 'marker') { f.expire(); f.marker(-2); }
        });
        const result = await capture(f.call()); expect(result.error).toBeInstanceOf(ForbiddenException); expect(result.value).toBeNull();
        expect(f.state.availabilityImportJob).toHaveLength(1); expect(f.state.creditTransaction).toHaveLength(1);
        expect(f.committed).toEqual([]); f.assertNoFilesOrKick(); expect(f.evalMarker).toHaveBeenCalledOnce();
    });
    it('recovers a matching concurrent committed import in a fresh authorized callback without duplicate charge or failed files', async () => {
        const f = availabilityAuthorityFixture(); f.uniqueRace(); const result = await f.call(); populated('replay', result);
        expect(f.state.availabilityImportJob).toHaveLength(1); expect(f.state.creditTransaction).toHaveLength(1);
        expect(f.state.tenant[0].usageCredits).toBe(9); expect(f.committed).toEqual([]);
        expect(f.files.size).toBe(0); expect(f.publisher.kick).toHaveBeenCalledOnce(); expect(f.evalMarker).toHaveBeenCalledOnce();
    });
    it('retries one serialization conflict with the original MFA proof and retains only the successful encrypted file', async () => {
        const f = availabilityAuthorityFixture(); f.serializationRetry(); const result = await f.call(); populated('new', result);
        expect(f.state.availabilityImportJob).toHaveLength(1); expect(f.state.creditTransaction).toHaveLength(1);
        expect(f.committed).toEqual(['job-create', 'debit', 'job-update']);
        expect(f.state.tenant[0].usageCredits).toBe(9); f.assertEncrypted(); expect(f.evalMarker).toHaveBeenCalledOnce();
    });
    it('serialization retry re-reads committed grants without refreshing MFA or retaining abandoned files', async () => {
        const f = availabilityAuthorityFixture(); const before = f.financial();
        f.serializationRetry(() => { f.state.role[0].rolePermissions = []; });
        const result = await capture(f.call()); refused(result, f, before); expect(f.evalMarker).toHaveBeenCalledOnce();
        expect(f.attempted).toEqual(['job-create', 'debit', 'job-update']);
    });

    for (const at of ['file', 'entitlement', 'job-updated'] as ImportGate[]) it(`refuses new charge/commit when publishing drains across ${at}`, async () => {
        const f = availabilityAuthorityFixture(), before = f.financial(); f.pauseAt(at);
        const result = await paused(f, f.drain); const value = await result;
        expect(value.error).toBeInstanceOf(ServiceUnavailableException); expect(value.value).toBeNull();
        expect(f.financial()).toEqual(before); expect(f.committed).toEqual([]); f.assertNoFilesOrKick();
    });
    it('refuses a new import when publishing drains during authority admission', async () => {
        const f = availabilityAuthorityFixture(), before = f.financial(); f.pauseEntry();
        const result = await paused(f, f.drain);
        expect(result.error).toBeInstanceOf(ServiceUnavailableException); expect(result.value).toBeNull();
        expect(f.financial()).toEqual(before); expect(f.committed).toEqual([]); f.assertNoFilesOrKick();
    });
    it('binds the initial actor, target and bounded PDF bytes before authority awaits', async () => {
        const f = availabilityAuthorityFixture(); f.direct(); f.pauseEntry();
        const originalSize = f.input.file.size;
        const result = await paused(f, () => {
            f.input.tenantId = 'foreign-tenant'; f.input.userId = 'foreign-target';
            f.input.requestedByUserId = 'foreign-actor'; f.input.requestedBySessionId = 'foreign-session';
            f.input.file.buffer.fill(0); f.input.file.size = 1;
        });
        expect(result.error).toBeNull(); populated('new', result.value); f.assertEncrypted();
        expect(f.state.availabilityImportJob[0]).toMatchObject({ tenantId: importIds.tenant,
            userId: importIds.target, requestedByUserId: importIds.actor, fileSize: originalSize });
        expect(f.locks.some(lock => lock.table === 'User' && lock.values.includes(importIds.target))).toBe(true);
    });
    it('never deletes an unowned colliding upload while durable encrypted storage remains available', async () => {
        const f = availabilityAuthorityFixture(); f.collision(); const result = await f.call(); populated('new', result);
        expect(f.files.size).toBe(1); expect([...f.files.values()][0].toString()).toBe('preexisting-foreign-source');
        expect(f.state.availabilityImportJob[0].storageKey).toBeNull();
        expect(f.decrypt(f.state.availabilityImportJob[0])).toEqual(Buffer.from('%PDF-1.7\ncontrolled availability'));
    });
    it('settles cancellation into debt first and records one attributable audit; repeated terminal cancel is read-only', async () => {
        const f = availabilityAuthorityFixture('cancel'); f.state.tenant[0].creditDebt = 1;
        const first = await f.call(); populated('cancel', first);
        expect(f.state.tenant[0]).toMatchObject({ usageCredits: 9, creditDebt: 0 });
        expect(f.state.creditTransaction.find(r => r.id.startsWith('feature-refund'))).toMatchObject({ amount: 0, debtAmount: -1 });
        expect(f.state.auditLog).toEqual([expect.objectContaining({ tenantId: importIds.tenant, userId: importIds.actor,
            action: 'AVAILABILITY_IMPORT_CANCELLED', resourceId: importIds.job })]);
        const before = clone(f.financial()), committed = [...f.committed]; await f.call();
        expect(f.financial()).toEqual(before); expect(f.committed).toEqual(committed); expect(f.publisher.kick).not.toHaveBeenCalled();
    });
    it('uses one fresh MFA proof and ordered target-inclusive authority locks for a populated custom-role import', async () => {
        const f = availabilityAuthorityFixture(); f.state.user[0].role = 'STAFF'; f.request.user.permissions = [];
        f.request.user.mfaVerified = false; const result = await f.call(); populated('new', result);
        f.assertEncrypted(); expect(f.evalMarker).toHaveBeenCalledOnce();
        const finalLocks = f.locks.filter(lock => lock.ordinal === f.ordinal);
        expect(finalLocks.map(lock => lock.table)).toEqual(['Tenant', 'User', 'Session', 'RoleAssignment', 'Role', 'RolePermission']);
        expect(finalLocks[1].values).toEqual([importIds.tenant, ...[importIds.actor, importIds.target].sort()]);
        expect(finalLocks[2].values).toEqual([importIds.session, importIds.actor]);
    });
});
