import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { scryptSync } from 'node:crypto';
import { MFA_MARKER_TTL_SCRIPT } from '@lunchlineup/rbac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminAuthorityFixture } from '../admin/admin-user-authority.fixture';
import { AuthService } from './auth.service';

// This is a finite local real-owner fixture. Exact model selectors and rollback
// ledger are reused; native locks/Redis/durability are not modeled or qualified.
const pin = '246810';
const prefix = (rows: Array<{ table: string; method: string }>) => rows.map(({ table, method }) => ({ table, method }));
function fixture() {
    const h = adminAuthorityFixture(), tenantId = h.actor.tenantId;
    h.state.users[0].role = 'ADMIN';
    h.state.roles[0].legacyRole = 'ADMIN';
    h.state.roles[0].rolePermissions = ['users:admin', 'users:read', 'auth:login_pin'].map(key => ({ permission: { key } }));
    h.state.users[1].tenantId = tenantId; h.state.users[1].role = 'STAFF';
    h.state.users[1].pinHash = 'unchanged-credential'; h.state.users[1].pinLoginAttempts = 3;
    h.state.users[1].pinLockedUntil = new Date(Date.now() - 1000);
    h.state.roles[1].tenantId = tenantId; h.state.roles[2].tenantId = tenantId;
    h.state.assignments[1].tenantId = tenantId; h.state.assignments[1].roleId = 'target-staff-role';
    const controls = { ttl: 120_000, status: 'ready', providerFailure: false, conflictsRemaining: 0,
        duringObserver: undefined as (() => void) | undefined,
        afterSessionRead: undefined as (() => void) | undefined,
        afterConflict: undefined as (() => void) | undefined };
    const modelExecute = h.prisma.$executeRaw;
    h.prisma.$executeRaw = vi.fn(async (query: any, ...values: any[]) => {
        const sql = Array.isArray(query) ? query.join('?') : query.strings?.join('?');
        if (sql?.includes('set_current_tenant')) {
            expect(values).toEqual([tenantId]); return 1;
        }
        return modelExecute(query, ...values);
    });
    h.prisma.session.findMany = vi.fn(async (args: any) => {
        expect(args).toEqual({ where: { userId: 'user-1', revokedAt: null }, select: { id: true } });
        const rows = h.state.sessions.filter(row => row.userId === args.where.userId && row.revokedAt === null)
            .map(({ id }) => ({ id }));
        controls.afterSessionRead?.(); return rows;
    });
    // Inject a conflict before the explicit model commits, then permit external
    // state changes only after callback finally has released its modeled locks.
    const modelTransaction = h.prisma.$transaction;
    h.prisma.$transaction = vi.fn(async (operation: (tx: any) => Promise<unknown>, options: any) => {
        const finalAttempt = h.controls.transactions >= 1;
        const conflict = { code: 'P2034' };
        try {
            return await modelTransaction(async (tx: any) => {
                const result = await operation(tx);
                if (finalAttempt && controls.conflictsRemaining > 0) {
                    controls.conflictsRemaining--; throw conflict;
                }
                return result;
            }, options);
        } catch (error) {
            if (error === conflict) { expect(h.controls.active).toBe(0); controls.afterConflict?.(); }
            throw error;
        }
    });
    const service = new AuthService({ get: vi.fn() } as any, {} as any, h.rbac, h.tenantDb);
    const redis = {
        get status() { return controls.status; },
        eval: vi.fn(async (script: string, count: number, key: string) => {
            expect(h.controls.active).toBe(0); expect(script).toBe(MFA_MARKER_TTL_SCRIPT);
            expect(count).toBe(1); expect(key).toBe('session_mfa:' + h.actor.sessionId);
            if (controls.providerFailure) throw new Error('synthetic.provider.private.failure');
            const ttl = controls.ttl; controls.duringObserver?.(); return ttl;
        }),
        del: vi.fn(async (...keys: string[]) => {
            expect(keys).toEqual(['session_mfa:target-session']); expect(h.controls.active).toBe(0);
            expect(prefix(h.committed)).toEqual([
                { table: 'user', method: 'updateMany' }, { table: 'session', method: 'updateMany' },
                { table: 'auditLog', method: 'create' },
            ]);
            expect(h.state.sessions[1].revokedAt).toBeInstanceOf(Date); expect(h.state.audits).toHaveLength(1);
            return 1;
        }),
    };
    // Only the external provider is synthetic; actual AuthService observer and
    // atomic marker TTL validation execute, including the finite read timer.
    vi.spyOn(service as any, 'getRedis').mockReturnValue(redis);
    const call = () => service.resetUserPinAsAdmin('user-1', pin, tenantId, h.actor.userId, h.actor.sessionId,
        { ipAddress: '203.0.113.25', userAgent: 'local-admin-pin-fixture' });
    return { ...h, get state() { return h.state; }, controls: h.controls, providerControls: controls,
        service, redis, call, tenantId };
}
const modes = ['stored Session', 'effective policy', 'bounded MFA'] as const;
function isolate(h: ReturnType<typeof fixture>, mode: typeof modes[number]) {
    if (mode === 'stored Session') { h.state.sessions[0].expiresAt = new Date(Date.now() + 1000); return 1001; }
    if (mode === 'effective policy') { h.state.security.sessionTimeoutMinutes = 5;
        h.state.sessions[0].createdAt = new Date(Date.now() - 4 * 60_000); return 60_000; }
    h.providerControls.ttl = 1000; return 1001;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T09:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('real AuthService admin PIN reset current authority and postcommit cleanup', () => {
    it('commits the actual credential, target-session revocation and redacted attributed audit before Redis cleanup', async () => {
        const h = fixture(); const result = await h.call();
        expect(result).toEqual({ username: 'admin-user' }); expect(h.controls.transactions).toBe(2);
        const [salt, hash] = h.state.users[1].pinHash.split(':');
        expect(scryptSync(pin, salt, 64).toString('hex')).toBe(hash);
        expect(h.state.users[1]).toMatchObject({ pinResetRequired: true, pinLoginAttempts: 0, pinLockedUntil: null });
        expect(h.state.sessions[0].revokedAt).toBeNull(); expect(h.state.sessions[1].revokedAt).toBeInstanceOf(Date);
        expect(h.state.audits).toEqual([expect.objectContaining({ tenantId: h.tenantId, userId: h.actor.userId,
            actorUserId: h.actor.userId, actorTenantId: h.tenantId, action: 'USER_PIN_RESET',
            newValue: { pinResetRequired: true, sessionsRevoked: 1 }, ipAddress: '203.0.113.25',
            userAgent: 'local-admin-pin-fixture' })]);
        const audit = JSON.stringify(h.state.audits); expect(audit).not.toContain(pin);
        expect(audit).not.toContain(h.state.users[1].pinHash); expect(audit).not.toContain('pinHash');
        expect(h.redis.eval).toHaveBeenCalledOnce(); expect(h.redis.del).toHaveBeenCalledOnce();
        expect(prefix(h.attempts)).toEqual(prefix(h.committed)); expect(h.controls.active).toBe(0);
    });
    it.each(['Tenant', 'PIN', 'Session', 'policy', 'grant', 'hierarchy'] as const)(
        'rereads current %s after real observer provider handoff with zero effects', async field => {
            const h = fixture(); let snapshot!: ReturnType<typeof h.snapshot>;
            h.providerControls.duringObserver = () => {
                expect(h.controls.active).toBe(0);
                if (field === 'Tenant') h.state.tenants[0].status = 'SUSPENDED';
                if (field === 'PIN') h.state.users[0].pinResetRequired = true;
                if (field === 'Session') h.state.sessions[0].revokedAt = new Date();
                if (field === 'policy') { h.state.security.sessionTimeoutMinutes = 5;
                    h.state.sessions[0].createdAt = new Date(Date.now() - 6 * 60_000); }
                if (field === 'grant') h.state.roles[0].rolePermissions = h.state.roles[0].rolePermissions
                    .filter((row: any) => row.permission.key !== 'users:admin');
                if (field === 'hierarchy') { h.state.users[1].role = 'ADMIN';
                    h.state.assignments[1].roleId = h.state.roles[0].id; }
                snapshot = h.snapshot();
            };
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
            expect(h.redis.del).not.toHaveBeenCalled(); expect(h.controls.active).toBe(0);
        });
    it.each(modes)('refuses isolated %s expiry at final authorization exactly2', async mode => {
        const h = fixture(), jump = isolate(h, mode), snapshot = h.snapshot();
        h.controls.afterFinalRole = () => { expect(h.controls.transactions).toBe(2);
            expect(h.controls.active).toBe(1); vi.setSystemTime(Date.now() + jump); };
        await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.controls.finalRoleVisits).toBe(1); expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]);
        expect(h.snapshot()).toEqual(snapshot); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it.each(modes)('rolls back every reached effect completion on isolated %s expiry', async mode => {
        const control = fixture(); await control.call(); const ledger = prefix(control.committed);
        expect(ledger).toEqual([{ table: 'user', method: 'updateMany' }, { table: 'session', method: 'updateMany' },
            { table: 'auditLog', method: 'create' }]);
        for (let index = 1; index <= ledger.length; index++) {
            const h = fixture(), jump = isolate(h, mode), snapshot = h.snapshot();
            h.controls.afterEffect = ordinal => { if (ordinal === index) vi.setSystemTime(Date.now() + jump); };
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
            expect(prefix(h.attempts)).toEqual(ledger.slice(0, index)); expect(h.committed).toEqual([]);
            expect(h.snapshot()).toEqual(snapshot); expect(h.redis.del).not.toHaveBeenCalled(); expect(h.controls.active).toBe(0);
        }
    });
    it.each(modes)('refuses isolated %s expiry across target-session list read before first write', async mode => {
        const h = fixture(), jump = isolate(h, mode), snapshot = h.snapshot();
        h.providerControls.afterSessionRead = () => vi.setSystemTime(Date.now() + jump);
        await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
        expect(h.redis.del).not.toHaveBeenCalled();
    });
    it.each(['unbounded marker', 'offline', 'provider failure'] as const)('fails closed on %s without cleanup or private provider detail', async failure => {
        const h = fixture();
        if (failure === 'unbounded marker') h.providerControls.ttl = -1;
        if (failure === 'offline') h.providerControls.status = 'offline';
        if (failure === 'provider failure') h.providerControls.providerFailure = true;
        const error = await h.call().then(() => undefined, error => error);
        expect(error).toBeInstanceOf(failure === 'unbounded marker' ? ForbiddenException : ServiceUnavailableException);
        expect(String(error)).not.toContain('synthetic.provider.private.failure');
        expect(h.attempts).toEqual([]); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('retries one discarded final conflict with fresh policy, one observation and the prepared credential', async () => {
        const h = fixture(); h.providerControls.conflictsRemaining = 1;
        await expect(h.call()).resolves.toEqual({ username: 'admin-user' });
        expect(h.controls.transactions).toBe(3); expect(h.redis.eval).toHaveBeenCalledOnce();
        expect(h.prisma.user.updateMany).toHaveBeenCalledTimes(2);
        expect(h.prisma.user.updateMany.mock.calls[0][0].data.pinHash).toBe(h.prisma.user.updateMany.mock.calls[1][0].data.pinHash);
        expect(h.attempts).toHaveLength(6); expect(h.committed).toHaveLength(3);
        expect(h.state.audits).toHaveLength(1); expect(h.redis.del).toHaveBeenCalledOnce();
    });
    it.each(['grant', 'policy'] as const)('refreshes %s after released conflict and refuses a second attempt before writes', async field => {
        const h = fixture(); h.providerControls.conflictsRemaining = 1;
        h.providerControls.afterConflict = () => {
            expect(h.controls.active).toBe(0);
            if (field === 'grant') h.state.roles[0].rolePermissions = [];
            else h.state.security.sessionTimeoutMinutes = 5;
            if (field === 'policy') h.state.sessions[0].createdAt = new Date(Date.now() - 6 * 60_000);
        };
        await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.controls.transactions).toBe(3); expect(h.attempts).toHaveLength(3); expect(h.committed).toEqual([]);
        expect(h.state.users[1].pinHash).toBe('unchanged-credential'); expect(h.state.audits).toEqual([]);
        expect(h.redis.eval).toHaveBeenCalledOnce(); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('maps exactly two final conflicts without credential/session/audit commit or external cleanup', async () => {
        const h = fixture(), snapshot = h.snapshot(); h.providerControls.conflictsRemaining = 2;
        await expect(h.call()).rejects.toBeInstanceOf(ConflictException);
        expect(h.controls.transactions).toBe(3); expect(h.attempts).toHaveLength(6); expect(h.committed).toEqual([]);
        expect(h.snapshot()).toEqual(snapshot); expect(h.redis.eval).toHaveBeenCalledOnce(); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('retries username bootstrap uniqueness once with real authorization and one prepared credential', async () => {
        const h = fixture(); h.state.users[1].username = null; h.state.users[1].email = null;
        const update = h.prisma.user.updateMany; let failures = 1;
        h.prisma.user.updateMany = vi.fn(async (args: any) => {
            if (failures-- > 0) throw { code: 'P2002' }; return update(args);
        });
        await expect(h.call()).resolves.toEqual({ username: 'admin.user' });
        expect(h.controls.transactions).toBe(3); expect(h.prisma.user.updateMany).toHaveBeenCalledTimes(2);
        expect(h.prisma.user.updateMany.mock.calls[0][0].data.pinHash).toBe(h.prisma.user.updateMany.mock.calls[1][0].data.pinHash);
        expect(h.state.users[1].username).toBe('admin.user'); expect(h.committed).toHaveLength(3);
        expect(h.redis.eval).toHaveBeenCalledOnce(); expect(h.redis.del).toHaveBeenCalledOnce();
    });
    it('bounds repeated bootstrap uniqueness conflicts without effects or cleanup', async () => {
        const h = fixture(); h.state.users[1].username = null; h.state.users[1].email = null;
        h.prisma.user.updateMany = vi.fn(async () => { throw { code: 'P2002' }; });
        await expect(h.call()).rejects.toThrow('Unable to reserve a unique username');
        expect(h.controls.transactions).toBe(3); expect(h.prisma.user.updateMany).toHaveBeenCalledTimes(2);
        expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('keeps successful commit when postcommit external Redis cleanup fails', async () => {
        const h = fixture(); h.redis.del.mockImplementation(async () => {
            expect(h.controls.active).toBe(0); expect(h.committed).toHaveLength(3);
            throw new Error('synthetic cleanup unavailable');
        });
        vi.spyOn((h.service as any).logger, 'warn').mockImplementation(() => undefined);
        await expect(h.call()).resolves.toEqual({ username: 'admin-user' });
        expect(h.committed).toHaveLength(3); expect(h.state.audits).toHaveLength(1); expect(h.redis.del).toHaveBeenCalledOnce();
    });
    it('rejects self-reset and invalid PIN before database and provider work', async () => {
        const h = fixture();
        await expect(h.service.resetUserPinAsAdmin(h.actor.userId, pin, h.tenantId, h.actor.userId, h.actor.sessionId))
            .rejects.toBeInstanceOf(ForbiddenException);
        await expect(h.service.resetUserPinAsAdmin('user-1', 'x', h.tenantId, h.actor.userId, h.actor.sessionId))
            .rejects.toBeInstanceOf(BadRequestException);
        expect(h.controls.transactions).toBe(0); expect(h.redis.eval).not.toHaveBeenCalled(); expect(h.redis.del).not.toHaveBeenCalled();
    });
});
