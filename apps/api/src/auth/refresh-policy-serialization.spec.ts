import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
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
type Family = 'selected' | 'legacy';

// Actual refresh authorization/crypto/RBAC methods with controlled statement
// reads and transaction-private writes. No native PostgreSQL lock proof.
type RefreshWaitStage = 'rbac' | 'replay' | 'session';
function harness(family: Family, waitStage?: RefreshWaitStage) {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'unit-test-capability');
    const tenantId = 'tenant-refresh-policy', userId = 'user-refresh-policy', sessionId = 'session-refresh-policy';
    const live: any = {
        tenant: { id: tenantId, status: 'ACTIVE', deletedAt: null },
        user: { id: userId, tenantId, role: 'STAFF', deletedAt: null, suspendedAt: null,
            mfaEnabled: false, pinResetRequired: false },
        session: { id: sessionId, userId, selectorHash: null, refreshToken: '', revokedAt: null,
            createdAt: new Date(now.getTime() - 20 * 60_000), expiresAt: new Date(now.getTime() + 60 * 60_000) },
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        role: { id: 'role-refresh-policy', tenantId, name: 'Current staff', isSystem: false,
            legacyRole: null, deletedAt: null, rolePermissions: [{ permission: { key: 'dashboard:access' } }] },
        assigned: true, ledger: new Map<string, string>(),
    };
    const entered = deferred(), gate = deferred(), stageEntered = deferred(), stageRelease = deferred(); let waited = false;
    const stages: RefreshWaitStage[] = [];
    const afterStage = async (stage: RefreshWaitStage) => {
        if (!waitStage) return;
        stages.push(stage);
        if (stage === waitStage) { stageEntered.release(); await stageRelease.promise; }
    };
    let protectedTransactions = 0, activeTransactions = 0, maximumTransactions = 0;
    let failAccess = false, failCas = false, failCommit = false;
    const locks: string[] = [], replayWrites = vi.fn(), rotationWrites = vi.fn(), revocations = vi.fn();
    const accessReads = vi.fn();
    const client: any = { $transaction: async (operation: (tx: any) => Promise<unknown>) => {
        activeTransactions++; maximumTransactions = Math.max(maximumTransactions, activeTransactions);
        let protectedTx = false, draftSession: any = null;
        const draftLedger = new Map<string, string>();
        const tx: any = {
            $executeRaw: vi.fn(async () => 1),
            $queryRaw: vi.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
                const text = sql.join('');
                if (!text.includes('FOR UPDATE')) return [];
                if (!protectedTx) { protectedTx = true; protectedTransactions++; }
                const table = text.includes('FROM "Tenant"') ? 'Tenant' : text.includes('FROM "User"') ? 'User' : 'Session';
                locks.push(table);
                if (table === 'Tenant') expect(values).toEqual([tenantId]);
                if (table === 'User') expect(values).toEqual([userId, tenantId]);
                if (table === 'Session') expect(values[0]).toBe(text.includes('"selectorHash"') ? live.session.selectorHash : sessionId);
                if (table === 'Session' && !text.includes('"selectorHash"')) expect(values).toEqual([sessionId, userId]);
                if (!waited) { waited = true; entered.release(); await gate.promise; }
                return [{ id: table === 'Tenant' ? tenantId : table === 'User' ? userId : sessionId }];
            }),
            tenant: { findUnique: vi.fn(async ({ where }: any) => {
                expect(where.id).toBe(tenantId); return structuredClone(live.tenant);
            }) },
            tenantSetting: { findUnique: vi.fn(async ({ where }: any) => {
                expect(where.tenantId_key).toEqual({ tenantId, key: 'workspace_settings' });
                return { value: { security: structuredClone(live.security) } };
            }) },
            session: {
                findFirst: vi.fn(async ({ where }: any) => {
                    const s = draftSession ?? live.session;
                    if (!s || where.id && where.id !== s.id || where.userId && where.userId !== s.userId
                        || where.selectorHash && where.selectorHash !== s.selectorHash
                        || where.refreshToken?.in && !where.refreshToken.in.includes(s.refreshToken)) return null;
                    return { ...structuredClone(s), user: structuredClone(live.user) };
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                    const s = draftSession ?? live.session;
                    if (data.revokedAt) revocations(); else rotationWrites();
                    if (!s || where.id !== s.id || s.revokedAt
                        || where.selectorHash && where.selectorHash !== s.selectorHash
                        || typeof where.refreshToken === 'string' && where.refreshToken !== s.refreshToken
                        || where.refreshToken?.in && !where.refreshToken.in.includes(s.refreshToken)
                        || data.refreshToken && failCas) return { count: 0 };
                    draftSession = { ...structuredClone(s), ...data };
                    if (!data.revokedAt) await afterStage('session');
                    return { count: 1 };
                }),
            },
            refreshTokenReplay: {
                findUnique: vi.fn(async ({ where }: any) => {
                    const id = draftLedger.get(where.validatorHash) ?? live.ledger.get(where.validatorHash);
                    return id ? { sessionId: id } : null;
                }),
                create: vi.fn(async ({ data }: any) => {
                    replayWrites(); expect(data.sessionId).toBe(sessionId);
                    if (draftLedger.has(data.validatorHash) || live.ledger.has(data.validatorHash)) throw { code: 'P2002' };
                    draftLedger.set(data.validatorHash, data.sessionId); await afterStage('replay'); return { id: 'replay-policy' };
                }),
            },
            roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
                accessReads(); expect(where).toMatchObject({ tenantId, userId, role: { tenantId, deletedAt: null } });
                if (failAccess) throw new Error('controlled access failure');
                await afterStage('rbac');
                return live.assigned && !live.role.deletedAt ? [{ role: structuredClone(live.role) }] : [];
            }) },
        };
        try {
            const result = await operation(tx);
            if (failCommit && protectedTx) throw new Error('controlled commit failure');
            if (draftSession) live.session = draftSession;
            for (const [hash, id] of draftLedger) live.ledger.set(hash, id);
            return result;
        } finally { activeTransactions--; if (protectedTx) protectedTransactions--; }
    } };
    const db = new TenantPrismaService(client), rbac = new RbacService(db);
    const jwt = {
        generateAccessToken: vi.fn(() => { expect(protectedTransactions).toBe(0); return 'current-access-token'; }),
        generateCsrfToken: vi.fn(() => { expect(protectedTransactions).toBe(0); return 'current-csrf-token'; }),
    };
    const service = new AuthService({ get: (_key: string, fallback: unknown) => fallback } as any,
        jwt as any, rbac, db);
    const redis = {
        get: vi.fn(async (_key: string): Promise<string | null> => { expect(protectedTransactions).toBe(0); return null; }),
        del: vi.fn(async (_key: string) => { expect(protectedTransactions).toBe(0); return 1; }),
    };
    (service as any).redis = {
        get: (key: string) => { expect(protectedTransactions).toBe(0); return redis.get(key); },
        del: (key: string) => { expect(protectedTransactions).toBe(0); return redis.del(key); },
    };
    const credential = (service as any).generateSelectedRefreshCredential();
    const raw = family === 'selected' ? credential.token : 'legacy-refresh-policy-token';
    live.session.selectorHash = family === 'selected' ? credential.selectorHash : null;
    live.session.refreshToken = family === 'selected' ? credential.validatorHash : (service as any).hashRefreshToken(raw);
    const initialHash = live.session.refreshToken;
    return { live, entered, gate, stageEntered, stageRelease, stages, locks, replayWrites, rotationWrites, revocations, accessReads, redis, jwt,
        raw, credential, initialHash, call: (token = raw) => service.refreshAccessToken(token),
        failAccess: () => { failAccess = true; }, failCas: () => { failCas = true; }, failCommit: () => { failCommit = true; },
        maximumTransactions: () => maximumTransactions,
        compete: () => {
            live.ledger.set(initialHash, sessionId);
            live.session.refreshToken = (service as any).hashRefreshToken('competing-winner');
        } };
}

async function changeDuringWait(h: ReturnType<typeof harness>, change: () => void) {
    const pending = h.call().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        change(); h.gate.release(); return await pending;
    } finally { h.gate.release(); await pending; }
}
function expectUnspent(h: ReturnType<typeof harness>) {
    expect(h.live.session.refreshToken).toBe(h.initialHash); expect(h.live.ledger.size).toBe(0);
    expect(h.live.session.revokedAt).toBeNull(); expect(h.replayWrites).not.toHaveBeenCalled();
    expect(h.rotationWrites).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
}

describe('refresh committed policy and retryable credentials', () => {
    for (const family of ['selected', 'legacy'] as const) {
        it.each(['shortened expiry', 'tenant suspended', 'tenant deleted', 'assignment removed', 'role deleted'])(
            `${family} refuses %s committed during lock wait without spending the credential`, async reason => {
                const h = harness(family);
                const result = await changeDuringWait(h, () => {
                    if (reason === 'shortened expiry') h.live.security.sessionTimeoutMinutes = 5;
                    if (reason === 'tenant suspended') h.live.tenant.status = 'SUSPENDED';
                    if (reason === 'tenant deleted') h.live.tenant.deletedAt = now;
                    if (reason === 'assignment removed') h.live.assigned = false;
                    if (reason === 'role deleted') h.live.role.deletedAt = now;
                });
                expect(result.error).toBeInstanceOf(UnauthorizedException); expectUnspent(h);
            });

        it.each(['workspace policy', 'privileged permission'])(
            `${family} returns an unverified challenge when %s now requires MFA`, async reason => {
                const h = harness(family);
                const result = await changeDuringWait(h, () => {
                    if (reason === 'workspace policy') h.live.security.requireMfaForAll = true;
                    else h.live.role.rolePermissions.push({ permission: { key: 'payroll:read' } });
                });
                expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ requiresMfa: true, mfaVerified: false });
                expect(h.redis.get).toHaveBeenCalledWith('session_mfa:session-refresh-policy');
                expect(h.live.ledger.size).toBe(1); expect(h.rotationWrites).toHaveBeenCalledOnce();
            });

        it(`${family} reports current role, PIN boundary and effective lifetime`, async () => {
            const h = harness(family);
            const result = await changeDuringWait(h, () => {
                h.live.role.name = 'Current custom role'; h.live.user.pinResetRequired = true;
                h.live.security.sessionTimeoutMinutes = 30;
            });
            expect(result.error).toBeUndefined();
            expect(result.value).toMatchObject({ accessTokenMaxAgeMs: 600_000, sessionMaxAgeMs: 600_000, pinResetRequired: true });
            expect(h.jwt.generateAccessToken).toHaveBeenCalledWith(expect.objectContaining({ role: 'Current custom role', pinResetRequired: true }));
            expect(h.redis.get).not.toHaveBeenCalled(); expect(h.maximumTransactions()).toBe(1);
            expect(h.locks).toEqual(['Tenant', 'User', 'Session']);
            if (family === 'selected') expect(result.value?.refreshToken.split('.')[1]).toBe(h.credential.selector);
            else expect(result.value?.refreshToken).toMatch(/^v2\./);
        });

        it(`${family} keeps the old credential retryable after access failure during the wait`, async () => {
            const h = harness(family);
            const result = await changeDuringWait(h, h.failAccess);
            expect(result.error?.message).toBe('controlled access failure'); expectUnspent(h);
        });

        it.each(['CAS', 'commit'])(`${family} rolls back the replay ledger and rotation after %s failure`, async failure => {
            const h = harness(family);
            const result = await changeDuringWait(h, failure === 'CAS' ? h.failCas : h.failCommit);
            if (failure === 'CAS') expect(result.error).toBeInstanceOf(UnauthorizedException);
            else expect(result.error?.message).toBe('controlled commit failure');
            expect(h.replayWrites).toHaveBeenCalledOnce(); expect(h.rotationWrites).toHaveBeenCalledOnce();
            expect(h.live.ledger.size).toBe(0); expect(h.live.session.refreshToken).toBe(h.initialHash);
            expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });

        it(`${family} does not spend a credential if Redis fails after MFA becomes required`, async () => {
            const h = harness(family);
            h.redis.get.mockRejectedValueOnce(new Error('controlled Redis failure'));
            const result = await changeDuringWait(h, () => { h.live.security.requireMfaForAll = true; });
            expect(result.error?.message).toBe('controlled Redis failure'); expectUnspent(h);
        });

        it(`${family} honors expiry shortened while Redis is read outside locks`, async () => {
            const h = harness(family); h.live.security.requireMfaForAll = true;
            h.redis.get.mockImplementation(async () => { h.live.security.sessionTimeoutMinutes = 5; return '1'; });
            const result = await changeDuringWait(h, () => {});
            expect(result.error).toBeInstanceOf(UnauthorizedException); expectUnspent(h);
        });

        it(`${family} reclassifies a competitor during Redis observation as terminal replay`, async () => {
            const h = harness(family); h.live.security.requireMfaForAll = true;
            h.redis.get.mockImplementation(async () => { h.compete(); h.live.assigned = false; return '1'; });
            const result = await changeDuringWait(h, () => {});
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(h.live.session.revokedAt).toEqual(now); expect(h.revocations).toHaveBeenCalledOnce();
            expect(h.rotationWrites).not.toHaveBeenCalled(); expect(h.redis.del).toHaveBeenCalledOnce();
        });

        it(`${family} terminalizes a known predecessor despite current tenant/access/Redis failures`, async () => {
            const h = harness(family); h.compete(); h.live.tenant.status = 'SUSPENDED';
            h.live.assigned = false; h.failAccess(); h.redis.get.mockRejectedValue(new Error('Redis down'));
            const result = await changeDuringWait(h, () => {});
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(h.live.session.revokedAt).toEqual(now); expect(h.accessReads).not.toHaveBeenCalled();
            expect(h.redis.get).not.toHaveBeenCalled(); expect(h.rotationWrites).not.toHaveBeenCalled();
        });

        it(`${family} uses a verified marker without Redis under locks`, async () => {
            const h = harness(family); h.live.user.mfaEnabled = true;
            h.redis.get.mockResolvedValue('1');
            const result = await changeDuringWait(h, () => {});
            expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ requiresMfa: true, mfaVerified: true });
            expect(h.redis.get).toHaveBeenCalledOnce(); expect(h.rotationWrites).toHaveBeenCalledOnce();
        });

        it(`${family} ignores an unverified marker when MFA is relaxed during observation`, async () => {
            const h = harness(family); h.live.security.requireMfaForAll = true;
            h.redis.get.mockImplementation(async () => { h.live.security.requireMfaForAll = false; return null; });
            const result = await changeDuringWait(h, () => {});
            expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ requiresMfa: false, mfaVerified: true });
            expect(h.redis.get).toHaveBeenCalledOnce(); expect(h.rotationWrites).toHaveBeenCalledOnce();
        });

        it(`${family} retains terminal revocation and Unauthorized when replay marker cleanup fails`, async () => {
            const h = harness(family); h.compete(); h.redis.del.mockRejectedValueOnce(new Error('controlled cleanup failure'));
            const result = await changeDuringWait(h, () => {});
            expect(result.error).toBeInstanceOf(UnauthorizedException); expect(h.live.session.revokedAt).toEqual(now);
            expect(h.redis.del).toHaveBeenCalledOnce(); expect(h.rotationWrites).not.toHaveBeenCalled();
            expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });

        it.each(['user identity', 'tenant identity'])(`${family} refuses a changed %s after locator lookup`, async identity => {
            const h = harness(family);
            const result = await changeDuringWait(h, () => {
                if (identity === 'user identity') h.live.user.id = 'other-user';
                else h.live.user.tenantId = 'other-tenant';
            });
            expect(result.error).toBeInstanceOf(UnauthorizedException); expectUnspent(h);
        });
    }

    it('refuses a changed selector after locator lookup', async () => {
        const h = harness('selected');
        const result = await changeDuringWait(h, () => { h.live.session.selectorHash = 'other-selector-hash'; });
        expect(result.error).toBeInstanceOf(UnauthorizedException); expectUnspent(h);
    });

    it('never lets an unrelated random validator revoke a selected family', async () => {
        const h = harness('selected'); h.gate.release(); h.live.tenant.status = 'SUSPENDED'; h.failAccess();
        await expect(h.call(`v2.${h.credential.selector}.${'A'.repeat(43)}`)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(h.live.session.revokedAt).toBeNull(); expect(h.revocations).not.toHaveBeenCalled();
        expect(h.accessReads).not.toHaveBeenCalled(); expect(h.redis.get).not.toHaveBeenCalled();
    });

    it('keeps a replay from another family from revoking the selected family', async () => {
        const h = harness('selected'); h.gate.release();
        const randomValidator = 'A'.repeat(43);
        // Canonical hash matches credential parser format, but the ledger belongs elsewhere.
        const crypto = await import('node:crypto');
        h.live.ledger.set('sha256:' + crypto.createHash('sha256').update(randomValidator).digest('hex'), 'other-session');
        await expect(h.call(`v2.${h.credential.selector}.${randomValidator}`)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(h.live.session.revokedAt).toBeNull(); expect(h.revocations).not.toHaveBeenCalled();
    });
});


describe('refresh effective expiry after dependent waits inside rotation', () => {
  for (const family of ['selected', 'legacy'] as const) {
    for (const stage of ['rbac', 'replay', 'session'] as const) {
      for (const lifetime of ['stored', 'policy'] as const) {
        it.each([true, false])(`${family} ${stage} ${lifetime}: equality refusal=%s preserves atomic credential custody`, async expires => {
          const h = harness(family, stage);
          const deadline = now.getTime() + 1000;
          if (lifetime === 'stored') h.live.session.expiresAt = new Date(deadline);
          else { h.live.security.sessionTimeoutMinutes = 5; h.live.session.createdAt = new Date(deadline - 5 * 60_000); }
          const pending = h.call().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
          let result: Awaited<typeof pending>;
          try {
            expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
            h.gate.release();
            expect(await Promise.race([h.stageEntered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
            expect(h.stages).toEqual(['rbac', 'replay', 'session'].slice(0, ['rbac', 'replay', 'session'].indexOf(stage) + 1));
            expect(h.live.session.refreshToken).toBe(h.initialHash); expect(h.live.ledger.size).toBe(0);
            vi.setSystemTime(deadline - (expires ? 0 : 1)); h.stageRelease.release(); result = await pending;
          } finally { h.gate.release(); h.stageRelease.release(); await pending; }
          if (expires) {
            expect(result!.error).toBeInstanceOf(UnauthorizedException);
            expect(h.live.session.refreshToken).toBe(h.initialHash); expect(h.live.ledger.size).toBe(0);
            expect(h.replayWrites).toHaveBeenCalledTimes(stage === 'rbac' ? 0 : 1);
            expect(h.rotationWrites).toHaveBeenCalledTimes(stage === 'session' ? 1 : 0);
            expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
          } else {
            expect(result!.error).toBeUndefined(); expect(result!.value).toBeDefined();
            expect(h.live.session.refreshToken).not.toBe(h.initialHash); expect(h.live.ledger.get(h.initialHash)).toBe(h.live.session.id);
            expect(h.replayWrites).toHaveBeenCalledTimes(1); expect(h.rotationWrites).toHaveBeenCalledTimes(1);
            expect(h.jwt.generateAccessToken).toHaveBeenCalledTimes(1);
          }
          expect(h.revocations).not.toHaveBeenCalled(); expect(h.live.session.revokedAt).toBeNull();
        });
      }
    }
  }
});
