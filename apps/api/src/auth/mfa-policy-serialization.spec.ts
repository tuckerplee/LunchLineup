import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const now = new Date('2026-10-03T12:00:00Z');
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

// Actual AuthService, proof validation and RBAC reader over controlled committed
// reads and transaction-private writes. This does not qualify PostgreSQL locking.
function harness(options: { mfaEnabled?: boolean; requireMfa?: boolean; sessionWriter?: boolean } = {}) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'unit-test-capability');
    const tenantId = 'tenant-mfa', userId = 'user-mfa', sessionId = 'session-mfa';
    const live: any = {
        tenant: { id: tenantId, status: 'ACTIVE', deletedAt: null },
        user: { id: userId, tenantId, role: 'STAFF', deletedAt: null, suspendedAt: null,
            mfaEnabled: options.mfaEnabled ?? true, mfaSecret: 'JBSWY3DPEHPK3PXP', mfaBackupCodes: [] },
        session: { id: sessionId, userId, createdAt: new Date(now.getTime() - 20 * 60_000),
            expiresAt: new Date(now.getTime() + 60 * 60_000), revokedAt: null },
        security: { requireMfaForAll: options.requireMfa ?? false, sessionTimeoutMinutes: 480 },
        role: { id: 'role-mfa', tenantId, name: 'Current staff', isSystem: false, legacyRole: null,
            deletedAt: null, rolePermissions: [{ permission: { key: 'dashboard:access' } }] },
        assigned: true,
        claims: [] as bigint[],
    };
    const entered = deferred(), gate = deferred(), writerEntered = deferred(), writerGate = deferred();
    const locks: string[] = [];
    let waited = false, protectedTransactions = 0, transactions = 0, maximumTransactions = 0;
    let failCommit = false;
    const backupWrites = vi.fn(), proofWrites = vi.fn();
    const client: any = { $transaction: async (op: (tx: any) => Promise<unknown>) => {
        transactions++; maximumTransactions = Math.max(maximumTransactions, transactions);
        let protectedTx = false;
        let stagedBackup: string[] | undefined;
        const stagedClaims: bigint[] = [];
        const tx: any = {
            $executeRaw: vi.fn(async () => 1),
            $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
                const text = sql.join('');
                if (!text.includes('FOR UPDATE')) return [];
                if (!protectedTx) { protectedTx = true; protectedTransactions++; }
                const table = text.includes('FROM "Tenant"') ? 'Tenant'
                    : text.includes('FROM "User"') ? 'User' : 'Session';
                locks.push(table);
                if (table === 'Tenant') expect(values).toEqual([tenantId]);
                if (table === 'User') expect(values).toEqual([userId, tenantId]);
                if (table === 'Session') {
                    expect(values).toEqual([sessionId, userId]);
                    if (options.sessionWriter) { writerEntered.release(); await writerGate.promise; }
                }
                if (!waited) { waited = true; entered.release(); await gate.promise; }
                return [{ id: table === 'Tenant' ? tenantId : table === 'User' ? userId : sessionId }];
            }),
            tenant: { findUnique: vi.fn(async () => structuredClone(live.tenant)) },
            tenantSetting: { findUnique: vi.fn(async () => ({ value: { security: structuredClone(live.security) } })) },
            user: {
                findFirst: vi.fn(async ({ where }: any) => live.user.deletedAt || live.user.suspendedAt
                    || live.user.tenantId !== where.tenantId ? null : structuredClone(live.user)),
                update: vi.fn(async ({ data }: any) => {
                    backupWrites(); stagedBackup = [...data.mfaBackupCodes];
                    return { ...structuredClone(live.user), mfaBackupCodes: stagedBackup };
                }),
            },
            session: { findFirst: vi.fn(async ({ where }: any) => {
                const snapshot = live.session && live.session.id === where.id && live.session.userId === where.userId
                    ? structuredClone(live.session) : null;
                // A reader without the Session lock can retain its pre-revocation
                // statement result. A locking reader waits before this statement.
                if (options.sessionWriter && !locks.includes('Session')) {
                    writerEntered.release(); await writerGate.promise;
                }
                return snapshot;
            }) },
            roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
                expect(where).toMatchObject({ tenantId, userId, role: { tenantId, deletedAt: null } });
                return live.assigned && !live.role.deletedAt ? [{ role: structuredClone(live.role) }] : [];
            }) },
            mfaTotpClaim: { create: vi.fn(async ({ data }: any) => {
                proofWrites();
                if (live.claims.includes(data.timeStep)) throw { code: 'P2002' };
                stagedClaims.push(data.timeStep); return { id: 'claim-mfa' };
            }) },
        };
        try {
            const result = await op(tx);
            if (failCommit && protectedTx) throw new Error('controlled commit failure');
            if (stagedBackup) live.user.mfaBackupCodes = stagedBackup;
            live.claims.push(...stagedClaims);
            return result;
        } finally { transactions--; if (protectedTx) protectedTransactions--; }
    } };
    const tenantDb = new TenantPrismaService(client), rbac = new RbacService(tenantDb);
    const jwt = { generateAccessToken: vi.fn(() => {
        expect(protectedTransactions).toBe(0); return 'verified-token';
    }) };
    const service = new AuthService({ get: (_key: string, fallback: unknown) => fallback } as any,
        jwt as any, rbac, tenantDb);
    const redis = { set: vi.fn(async () => { expect(protectedTransactions).toBe(0); return 'OK'; }) };
    (service as any).redis = redis;
    const backupCode = 'BACKUP-ONE-USE';
    const backupHash = (service as any).hashBackupCode(backupCode);
    live.user.mfaBackupCodes = [backupHash];
    const totpCode = (service as any).generateTotpCode((service as any).secretToBuffer(live.user.mfaSecret),
        Math.floor(now.getTime() / 30_000));
    const call = (code: string) => service.validateMfa(userId, code, { tenantId, sessionId });
    return { live, entered, gate, writerEntered, writerGate, locks, backupWrites, proofWrites,
        jwt, redis, backupCode, backupHash, totpCode, call,
        failCommit: () => { failCommit = true; }, maximumTransactions: () => maximumTransactions };
}

async function changeDuringWait(h: ReturnType<typeof harness>, code: string, change: () => void) {
    const pending = h.call(code).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        change(); h.gate.release(); return await pending;
    } finally { h.gate.release(); h.writerGate.release(); await pending; }
}

describe('MFA committed policy and proof consumption', () => {
    const invalidations: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
        ['policy-shortened expiry', h => { h.live.security.sessionTimeoutMinutes = 5; }],
        ['tenant suspended', h => { h.live.tenant.status = 'SUSPENDED'; }],
        ['tenant deleted', h => { h.live.tenant.deletedAt = now; }],
        ['role assignment removed', h => { h.live.assigned = false; }],
        ['role deleted', h => { h.live.role.deletedAt = now; }],
    ];
    for (const proof of ['backup', 'totp'] as const) it.each(invalidations)(
        `${proof} proof remains available after %s during the wait`, async (_label, change) => {
            const h = harness();
            const result = await changeDuringWait(h, proof === 'backup' ? h.backupCode : h.totpCode, () => change(h));
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(result.value).toBeUndefined();
            expect(h.live.user.mfaBackupCodes).toEqual([h.backupHash]);
            expect(h.live.claims).toEqual([]);
            expect(h.backupWrites).not.toHaveBeenCalled(); expect(h.proofWrites).not.toHaveBeenCalled();
            expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });

    it.each(['workspace policy', 'privileged role permission'])(
        'requires a proof after %s becomes required during the wait', async reason => {
            const h = harness({ mfaEnabled: false });
            const result = await changeDuringWait(h, 'invalid', () => {
                if (reason === 'workspace policy') h.live.security.requireMfaForAll = true;
                else h.live.role.rolePermissions.push({ permission: { key: 'payroll:read' } });
            });
            expect(result.error).toBeInstanceOf(ForbiddenException);
            expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });

    it('uses a current relaxation without requiring or consuming a proof', async () => {
        const h = harness({ mfaEnabled: false, requireMfa: true });
        const result = await changeDuringWait(h, 'invalid', () => { h.live.security.requireMfaForAll = false; });
        expect(result.error).toBeUndefined(); expect(result.value).toEqual({ success: true, mfaVerified: true });
        expect(h.backupWrites).not.toHaveBeenCalled(); expect(h.proofWrites).not.toHaveBeenCalled();
        expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
    });

    for (const proof of ['backup', 'totp'] as const) it(`${proof} waits for an exact Session writer before consuming proof`, async () => {
        const h = harness({ sessionWriter: true });
        h.gate.release();
        const pending = h.call(proof === 'backup' ? h.backupCode : h.totpCode)
            .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        try {
            expect(await Promise.race([h.writerEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
            h.live.session.revokedAt = now; h.writerGate.release();
            expect((await pending).error).toBeInstanceOf(UnauthorizedException);
            expect(h.live.user.mfaBackupCodes).toEqual([h.backupHash]); expect(h.live.claims).toEqual([]);
            expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        } finally { h.writerGate.release(); await pending; }
    });

    it('returns current role and effective expiry, with external work after commit', async () => {
        const h = harness();
        const result = await changeDuringWait(h, h.backupCode, () => {
            h.live.role.name = 'Current custom role'; h.live.security.sessionTimeoutMinutes = 30;
        });
        expect(result.error).toBeUndefined();
        expect(result.value).toMatchObject({ accessToken: 'verified-token', accessTokenMaxAgeMs: 600_000 });
        expect(h.redis.set).toHaveBeenCalledWith('session_mfa:session-mfa', '1', 'EX', 600);
        expect(h.jwt.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'Current custom role' }));
        expect(h.live.user.mfaBackupCodes).toEqual([]);
        expect(h.maximumTransactions()).toBe(1);
        expect(h.locks).toEqual(['Tenant', 'User', 'Session']);
    });

    it.each(['revoked session', 'expired session', 'wrong session owner', 'deleted user', 'suspended user'])(
        'retains existing refusal of %s without consuming proof', async reason => {
            const h = harness();
            const result = await changeDuringWait(h, h.backupCode, () => {
                if (reason === 'revoked session') h.live.session.revokedAt = now;
                if (reason === 'expired session') h.live.session.expiresAt = new Date(0);
                if (reason === 'wrong session owner') h.live.session.userId = 'other-user';
                if (reason === 'deleted user') h.live.user.deletedAt = now;
                if (reason === 'suspended user') h.live.user.suspendedAt = now;
            });
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(h.live.user.mfaBackupCodes).toEqual([h.backupHash]); expect(h.live.claims).toEqual([]);
            expect(h.redis.set).not.toHaveBeenCalled();
        });

    for (const proof of ['backup', 'totp'] as const) it(`${proof} rolls back a staged proof on commit failure`, async () => {
        const h = harness(); h.failCommit();
        const result = await changeDuringWait(h, proof === 'backup' ? h.backupCode : h.totpCode, () => {});
        expect(result.error?.message).toBe('controlled commit failure');
        expect(proof === 'backup' ? h.backupWrites : h.proofWrites).toHaveBeenCalledOnce();
        expect(h.live.user.mfaBackupCodes).toEqual([h.backupHash]); expect(h.live.claims).toEqual([]);
        expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
    });

    for (const proof of ['backup', 'totp'] as const) it(`${proof} is consumed once when postcommit Redis publication fails`, async () => {
        const h = harness();
        h.redis.set.mockRejectedValueOnce(new Error('controlled Redis failure'));
        const result = await changeDuringWait(h, proof === 'backup' ? h.backupCode : h.totpCode, () => {});
        expect(result.error?.message).toBe('controlled Redis failure');
        expect(proof === 'backup' ? h.backupWrites : h.proofWrites).toHaveBeenCalledOnce();
        expect(h.live.user.mfaBackupCodes).toEqual(proof === 'backup' ? [] : [h.backupHash]);
        expect(h.live.claims).toHaveLength(proof === 'totp' ? 1 : 0);
        expect(h.redis.set).toHaveBeenCalledOnce(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
    });

    it.each(['missing tenant', 'missing session', 'user moved to another tenant'])(
        'refuses %s before proof consumption', async reason => {
            const h = harness();
            const result = await changeDuringWait(h, h.backupCode, () => {
                if (reason === 'missing tenant') h.live.tenant = null;
                if (reason === 'missing session') h.live.session = null;
                if (reason === 'user moved to another tenant') h.live.user.tenantId = 'other-tenant';
            });
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(h.live.user.mfaBackupCodes).toEqual([h.backupHash]); expect(h.live.claims).toEqual([]);
            expect(h.backupWrites).not.toHaveBeenCalled(); expect(h.proofWrites).not.toHaveBeenCalled();
            expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });

    it('refuses an already consumed TOTP step with no marker or token', async () => {
        const h = harness(); h.live.claims.push(BigInt(Math.floor(now.getTime() / 30_000)));
        const result = await changeDuringWait(h, h.totpCode, () => {});
        expect(result.error).toBeInstanceOf(ForbiddenException);
        expect(h.live.claims).toHaveLength(1); expect(h.live.user.mfaBackupCodes).toEqual([h.backupHash]);
        expect(h.redis.set).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
    });

    it.each(['PAST_DUE', 'CANCELLED'])('retains permitted authentication for a %s tenant', async status => {
        const h = harness();
        const result = await changeDuringWait(h, h.totpCode, () => {
            h.live.tenant.status = status; (h.live.security as any).ssoOidcOnly = true;
        });
        expect(result.error).toBeUndefined(); expect(result.value).toHaveProperty('accessToken', 'verified-token');
        expect(h.live.claims).toHaveLength(1); expect(h.redis.set).toHaveBeenCalledOnce();
    });
});
