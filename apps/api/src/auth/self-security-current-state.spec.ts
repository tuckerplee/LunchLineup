import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

type Action = 'enroll' | 'disable' | 'verify' | 'pin';
const ids = { tenantId: 'self-tenant', userId: 'self-user', sessionId: 'self-session' };
const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const gate = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const flatten = (items: unknown[]): unknown[] => items.flatMap(x => x && typeof x === 'object' && 'values' in x
    ? flatten((x as { values: unknown[] }).values) : [x]);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    vi.stubEnv('MFA_SECRET_ENCRYPTION_KEY', 'synthetic-self-security-encryption-key');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Actual AuthService and RBAC; exact selector-filtered current rows. The model
// stages writes until successful callback completion, without real SQL locks,
// isolation, rollback, Redis execution or native qualification.
function harness(action: Action) {
    const entered = gate(), release = gate(), rolesEntered = gate(), rolesRelease = gate(), finalEntered = gate(), finalRelease = gate(), listEntered = gate(), listRelease = gate(), proofEntered = gate(), proofRelease = gate();
    const state: any = {
        tenant: { id: ids.tenantId, status: 'ACTIVE', deletedAt: null },
        user: { id: ids.userId, tenantId: ids.tenantId, role: 'STAFF', username: 'self.user', email: null,
            deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null,
            pinResetRequired: false, mfaEnabled: action === 'disable' || action === 'verify',
            mfaSecret: secret, mfaBackupCodes: [] },
        session: { id: ids.sessionId, userId: ids.userId, createdAt: new Date(Date.now() - 20 * 60_000),
            expiresAt: new Date(Date.now() + 60 * 60_000), revokedAt: null },
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        role: { id: 'self-role', tenantId: ids.tenantId, name: 'Self service', isSystem: false, legacyRole: null,
            deletedAt: null, rolePermissions: [{ permission: { key: 'auth:login_pin' } }] },
        assigned: true, markerTtl: 60_000,
    };
    let first = true, pauseRoles = false, rolesPaused = false, active = 0, tenantVisits = 0, pauseFinal = false, pauseList = false, pauseProof = false;
    let onObserve: (() => void) | undefined, onCommit: (() => void) | undefined;
    const writes = vi.fn(), audits = vi.fn(), proofs = vi.fn(), committed = vi.fn();
    const database: any = { $transaction: async (operation: any) => {
        expect(active).toBe(0); active++;
        const staged: unknown[] = [];
        const tx: any = {
            $executeRaw: vi.fn(async () => 1),
            $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
                const text = (Array.isArray(sql) ? sql : sql.strings).join('');
                const values = flatten(Array.isArray(sql) ? args : sql.values);
                if (text.includes('AS "now"')) return [{ now: new Date() }];
                if (text.includes('UPDATE "Session"') && text.includes('"mfaEnrollmentSecret" = NULL')) {
                    expect(values).toEqual([ids.sessionId, ids.userId, state.session.mfaEnrollmentSecret, state.session.mfaEnrollmentExpiresAt.toISOString()]);
                    staged.push({ enrollmentConsumed: true }); return [{ id: ids.sessionId }];
                }
                if (text.includes('FROM "Tenant"')) {
                    expect(values).toEqual([ids.tenantId]);
                    tenantVisits++;
                    if (first) { first = false; entered.release(); await release.promise; }
                    if (pauseFinal && tenantVisits === 2) { finalEntered.release(); await finalRelease.promise; }
                }
                if (text.includes('FROM "User"')) {
                    expect(values).toContain(ids.userId); expect(values).toContain(ids.tenantId);
                    return state.user.tenantId === ids.tenantId ? [structuredClone(state.user)] : [];
                }
                if (text.includes('FROM "Session"')) {
                    expect(values).toEqual([ids.sessionId, ids.userId]);
                    return state.session?.id === ids.sessionId && state.session.userId === ids.userId ? [structuredClone(state.session)] : [];
                }
                return [];
            }),
            tenant: { findUnique: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ id: ids.tenantId }); return structuredClone(state.tenant);
            }) },
            user: {
                findFirst: vi.fn(async ({ where }: any) => {
                    expect(where).toMatchObject({ id: ids.userId, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null });
                    return state.user.deletedAt || state.user.suspendedAt || state.user.tenantId !== ids.tenantId ? null : structuredClone(state.user);
                }),
                update: vi.fn(async ({ where, data }: any) => {
                    expect(where).toEqual({ id: ids.userId }); writes('user', data); staged.push(data); return {};
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                    expect(where).toMatchObject({ id: ids.userId, tenantId: ids.tenantId }); writes('user', data); staged.push(data); return { count: 1 };
                }),
            },
            session: {
                findFirst: vi.fn(async ({ where }: any) => {
                    expect(where).toEqual({ id: ids.sessionId, userId: ids.userId });
                    return state.session?.id === ids.sessionId && state.session.userId === ids.userId ? structuredClone(state.session) : null;
                }),
                findMany: vi.fn(async ({ where }: any) => {
                    expect(where).toEqual({ userId: ids.userId, revokedAt: null });
                    if (pauseList) { listEntered.release(); await listRelease.promise; }
                    return [{ id: ids.sessionId }];
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                    expect(where).toEqual({ userId: ids.userId, revokedAt: null }); writes('sessions', data); staged.push(data); return { count: 1 };
                }),
            },
            tenantSetting: { findUnique: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } });
                return { value: { security: structuredClone(state.security) } };
            }) },
            roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
                expect(where).toMatchObject({ tenantId: ids.tenantId });
                if (pauseRoles && !rolesPaused) { rolesPaused = true; rolesEntered.release(); await rolesRelease.promise; }
                return state.assigned ? [{ userId: ids.userId, roleId: state.role.id, role: structuredClone(state.role) }] : [];
            }) },
            role: { findMany: vi.fn(async ({ where }: any) => {
                expect(where.tenantId).toBe(ids.tenantId); return state.assigned ? [structuredClone(state.role)] : [];
            }) },
            auditLog: { create: vi.fn(async ({ data }: any) => {
                expect(data).toMatchObject({ tenantId: ids.tenantId, actorUserId: ids.userId }); audits(data); staged.push(data); return {};
            }) },
            mfaTotpClaim: { create: vi.fn(async ({ data }: any) => {
                expect(data).toMatchObject({ tenantId: ids.tenantId, userId: ids.userId }); proofs(data); staged.push(data);
                if (pauseProof) { proofEntered.release(); await proofRelease.promise; }
                return {};
            }) },
        };
        try { const result = await operation(tx); if (staged.length) onCommit?.(); for (const value of staged) committed(value); return result; }
        finally { active--; }
    } };
    const tenantDb = new TenantPrismaService(database);
    const jwt = { generateAccessToken: vi.fn(() => 'controlled-self-token') };
    const service = new AuthService({ get: (key: string, fallback: unknown) => process.env[key] ?? fallback } as never,
        jwt as never, new RbacService(tenantDb), tenantDb);
    state.session.mfaEnrollmentSecret = (service as any).encryptMfaSecret(secret);
    state.session.mfaEnrollmentExpiresAt = new Date(Date.now() + 600_000);
    if (action === 'pin') state.user.pinHash = (service as any).hashPin('1111');
    const redis = {
        status: 'ready', get: vi.fn(async (key: string) => {
            expect(active).toBe(0); expect(key).toBe(`mfa_enrollment:${ids.sessionId}:${ids.userId}`); return secret;
        }),
        eval: vi.fn(async (_script: string, count: number, key: string) => {
            expect(active).toBe(0); expect(count).toBe(1); expect(key).toBe(`session_mfa:${ids.sessionId}`);
            const ttl = state.markerTtl; onObserve?.(); return ttl;
        }),
        set: vi.fn(async () => { expect(active).toBe(0); return 'OK'; }),
        del: vi.fn(async () => { expect(active).toBe(0); return 1; }),
    };
    (service as any).redis = redis;
    const code = (service as any).generateTotpCode((service as any).secretToBuffer(secret), Math.floor(Date.now() / 30_000));
    const claims = { tenantId: ids.tenantId, sessionId: ids.sessionId };
    const call = () => action === 'enroll' ? service.confirmMfaEnrollment(ids.userId, code, claims)
        : action === 'disable' ? service.disableMfa(ids.userId, code, claims)
        : action === 'verify' ? service.validateMfa(ids.userId, code, claims)
        : service.rotateOwnPin(ids.userId, '1111', '2222', ids.tenantId, ids.sessionId);
    return { state, entered, release, rolesEntered, rolesRelease, finalEntered, finalRelease, listEntered, listRelease, proofEntered, proofRelease, writes, audits, proofs, committed, jwt, redis, call,
        pauseFinal: () => { pauseFinal = true; }, pauseList: () => { pauseList = true; }, pauseProof: () => { pauseProof = true; },
        expireDuringPinHash: () => {
            const hash = (service as any).buildPinCredentialData.bind(service);
            vi.spyOn(service as any, 'buildPinCredentialData').mockImplementation((...args: unknown[]) => {
                expect(active).toBe(0); const value = hash(...args); vi.setSystemTime(Date.now() + 1001); return value;
            });
        },
        expireDuringBackupHash: () => {
            const hash = (service as any).hashBackupCode.bind(service); let firstHash = true;
            vi.spyOn(service as any, 'hashBackupCode').mockImplementation((...args: unknown[]) => {
                const value = hash(...args); if (firstHash) { firstHash = false; vi.setSystemTime(Date.now() + 3_600_000); } return value;
            });
        },
        afterObserve: (operation: () => void) => { onObserve = operation; },
        beforeCommit: (operation: () => void) => { onCommit = operation; },
        pauseRoles: () => { pauseRoles = true; },
        useBackupProof: () => { state.user.mfaSecret = null; state.user.mfaBackupCodes = [(service as any).hashBackupCode(code)]; } };
}
type Fixture = ReturnType<typeof harness>;
async function afterWait(h: Fixture, change: () => void, stage: 'tenant' | 'roles' | 'final' | 'list' | 'proof' = 'tenant') {
    const result = h.call().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.entered.promise.then(() => 'entered'), result.then(() => 'settled')])).toBe('entered');
        if (stage === 'roles') {
            h.release.release();
            expect(await Promise.race([h.rolesEntered.promise.then(() => 'entered'), result.then(() => 'settled')])).toBe('entered');
        }
        if (stage === 'final' || stage === 'list' || stage === 'proof') {
            h.release.release();
            const selected = stage === 'final' ? h.finalEntered : stage === 'list' ? h.listEntered : h.proofEntered;
            expect(await Promise.race([selected.promise.then(() => 'entered'), result.then(() => 'settled')])).toBe('entered');
        }
        change(); h.release.release(); h.rolesRelease.release(); h.finalRelease.release(); h.listRelease.release(); h.proofRelease.release(); return await result;
    } finally { h.release.release(); h.rolesRelease.release(); h.finalRelease.release(); h.listRelease.release(); h.proofRelease.release(); await result; }
}
function noEffects(h: Fixture) {
    expect(h.writes).not.toHaveBeenCalled(); expect(h.audits).not.toHaveBeenCalled(); expect(h.proofs).not.toHaveBeenCalled();
    expect(h.committed).not.toHaveBeenCalled(); expect(h.redis.set).not.toHaveBeenCalled(); expect(h.redis.del).not.toHaveBeenCalled();
    expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
}
const invalidTenants: Array<[string, (h: Fixture) => void]> = [
    ['suspended', h => { h.state.tenant.status = 'SUSPENDED'; }],
    ['purged', h => { h.state.tenant.status = 'PURGED'; }],
    ['deleted', h => { h.state.tenant.deletedAt = new Date(); }],
    ['missing', h => { h.state.tenant = null; }],
];
describe('self-security current state at mutation boundaries', () => {
    for (const action of ['enroll', 'disable', 'verify', 'pin'] as const) {
        it.each(invalidTenants)(`${action} refuses a %s workspace committed during Tenant wait`, async (_label, change) => {
            const h = harness(action); const result = await afterWait(h, () => change(h));
            expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
        });
        it(`${action} refuses policy-shortened expiry committed during Tenant wait`, async () => {
            const h = harness(action); const result = await afterWait(h, () => { h.state.security.sessionTimeoutMinutes = 5; });
            expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
        });
        it(`${action} refuses expiry while the final role read waits`, async () => {
            const h = harness(action); h.pauseRoles();
            if (action === 'verify') h.useBackupProof();
            const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 3_600_000); }, 'roles');
            expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
        });
        it(`${action} retains an active account/session positive control`, async () => {
            const h = harness(action); const result = await afterWait(h, () => {});
            expect(result.error).toBeUndefined(); expect(h.writes).toHaveBeenCalledTimes(action === 'verify' ? 0 : action === 'pin' || action === 'disable' ? 2 : 1);
            expect(h.committed).toHaveBeenCalled();
        });
    }
    for (const action of ['enroll', 'disable', 'verify'] as const) {
        it(`${action} refuses current forced-PIN state before proof consumption`, async () => {
            const h = harness(action); const result = await afterWait(h, () => { h.state.user.pinResetRequired = true; });
            expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
            // Controlled state omission test; normal PIN-reset writers also
            // revoke sessions. This is not proof of an ordinary reset bypass.
        });
    }
    it('ordinary PIN rotation requires current MFA when workspace policy becomes required', async () => {
        const h = harness('pin'); h.state.markerTtl = -2;
        const result = await afterWait(h, () => { h.state.security.requireMfaForAll = true; });
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it('forced-PIN recovery remains available without completed MFA', async () => {
        const h = harness('pin'); h.state.markerTtl = -2;
        const result = await afterWait(h, () => { h.state.user.pinResetRequired = true; h.state.security.requireMfaForAll = true; });
        expect(result.error).toBeUndefined(); expect(h.writes).toHaveBeenCalledTimes(2); expect(h.redis.eval).not.toHaveBeenCalled();
    });
    it('ordinary PIN rotation accepts a current bounded MFA observation', async () => {
        const h = harness('pin'); const result = await afterWait(h, () => { h.state.security.requireMfaForAll = true; });
        expect(result.error).toBeUndefined(); expect(h.writes).toHaveBeenCalledTimes(2);
    });
    for (const action of ['enroll', 'disable', 'verify', 'pin'] as const) {
        it.each(['PAST_DUE', 'CANCELLED'])(`${action} keeps %s workspace recovery eligible`, async status => {
            const h = harness(action); const result = await afterWait(h, () => { h.state.tenant.status = status; });
            expect(result.error).toBeUndefined(); expect(h.committed).toHaveBeenCalled();
        });
    }
    it.each(['lockedUntil', 'pinLockedUntil'])(`MFA verification rejects current %s`, async field => {
        const h = harness('verify'); const result = await afterWait(h, () => { h.state.user[field] = new Date(Date.now() + 60_000); });
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it.each([-2, -1, 0, 1.5, NaN, Infinity, '60000', 1440 * 60_000 + 1001])('ordinary PIN change refuses invalid MFA TTL %s', async ttl => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.state.markerTtl = ttl;
        const result = await afterWait(h, () => {});
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h); expect(h.redis.eval).toHaveBeenCalledTimes(1);
    });
    it.each(['offline', 'read failure'])('ordinary PIN change fails closed on MFA %s', async failure => {
        const h = harness('pin'); h.state.user.mfaEnabled = true;
        if (failure === 'offline') h.redis.status = 'reconnecting';
        else h.redis.eval.mockRejectedValue(new Error('synthetic observer failure'));
        const result = await afterWait(h, () => {});
        expect(result.error).toBeInstanceOf(ServiceUnavailableException); noEffects(h);
        expect(h.redis.eval).toHaveBeenCalledTimes(failure === 'offline' ? 0 : 1);
    });
    it.each(invalidTenants)('PIN write transaction refreshes %s workspace after observation', async (_label, change) => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.pauseFinal();
        const result = await afterWait(h, () => change(h), 'final');
        expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h); expect(h.redis.eval).toHaveBeenCalledTimes(1);
    });
    it('PIN write transaction refreshes exact-session revocation after observation', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.pauseFinal();
        const result = await afterWait(h, () => { h.state.session.revokedAt = new Date(); }, 'final');
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it('PIN write transaction refreshes current permission after observation', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.pauseFinal();
        const result = await afterWait(h, () => { h.state.role.rolePermissions = []; }, 'final');
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it('PIN write transaction refuses policy that becomes MFA-required after preflight', async () => {
        const h = harness('pin'); h.pauseFinal();
        const result = await afterWait(h, () => { h.state.security.requireMfaForAll = true; }, 'final');
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h); expect(h.redis.eval).not.toHaveBeenCalled();
    });
    it('PIN write transaction refuses shortened policy lifetime after preflight', async () => {
        const h = harness('pin'); h.pauseFinal();
        const result = await afterWait(h, () => { h.state.security.sessionTimeoutMinutes = 5; }, 'final');
        expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
    });
    it('PIN write transaction refuses MFA observation exhausted during its Tenant wait', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.state.markerTtl = 1000; h.pauseFinal();
        const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 1001); }, 'final');
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it('PIN write boundary refuses MFA observation exhausted during session enumeration', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.state.markerTtl = 1000; h.pauseList();
        const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 1001); }, 'list');
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it('PIN write boundary refuses session expiry during session enumeration', async () => {
        const h = harness('pin'); h.pauseList();
        const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 3_600_000); }, 'list');
        expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
    });
    it('PIN recovery remains available when forced reset becomes current after an absent observation', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.state.markerTtl = -2; h.pauseFinal();
        const result = await afterWait(h, () => { h.state.user.pinResetRequired = true; }, 'final');
        expect(result.error).toBeUndefined(); expect(h.writes).toHaveBeenCalledTimes(2); expect(h.committed).toHaveBeenCalled();
    });
    it('PIN serialization retry reauthorizes revocation without publishing first-attempt effects', async () => {
        const h = harness('pin'); let attempts = 0;
        h.beforeCommit(() => { attempts++; h.state.session.revokedAt = new Date(); throw Object.assign(new Error('synthetic conflict'), { code: 'P2034' }); });
        const result = await afterWait(h, () => {});
        expect(result.error).toBeInstanceOf(ForbiddenException); expect(attempts).toBe(1);
        expect(h.committed).not.toHaveBeenCalled(); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('PIN serialization retry retains one observation and refuses its exhausted deadline', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.state.markerTtl = 1000; let attempts = 0;
        h.beforeCommit(() => { attempts++; vi.setSystemTime(Date.now() + 1001); throw Object.assign(new Error('synthetic conflict'), { code: 'P2034' }); });
        const result = await afterWait(h, () => {});
        expect(result.error).toBeInstanceOf(ForbiddenException); expect(attempts).toBe(1);
        expect(h.redis.eval).toHaveBeenCalledTimes(1); expect(h.committed).not.toHaveBeenCalled(); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('PIN serialization retry can commit once with a still-current observation', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; let attempts = 0;
        h.beforeCommit(() => { if (++attempts === 1) throw Object.assign(new Error('synthetic conflict'), { code: 'P2034' }); });
        const result = await afterWait(h, () => {});
        expect(result.error).toBeUndefined(); expect(attempts).toBe(2); expect(h.redis.eval).toHaveBeenCalledTimes(1);
        expect(h.committed).toHaveBeenCalledTimes(3); expect(h.audits).toHaveBeenCalledTimes(2); expect(h.redis.del).toHaveBeenCalledTimes(1);
        // Audit spy counts attempts; the staged ledger commits exactly one audit.
    });

    it('MFA disable refuses session expiry during session enumeration before consuming proof', async () => {
        const h = harness('disable'); h.pauseList(); h.useBackupProof();
        const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 3_600_000); }, 'list');
        expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
    });

    it('PIN write refuses an observation exhausted during new credential hashing', async () => {
        const h = harness('pin'); h.state.user.mfaEnabled = true; h.state.markerTtl = 1000; h.expireDuringPinHash();
        const result = await afterWait(h, () => {});
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    it('MFA enrollment refuses expiry during backup hashing before proof consumption', async () => {
        const h = harness('enroll'); h.expireDuringBackupHash();
        const result = await afterWait(h, () => {});
        expect(result.error).toBeInstanceOf(UnauthorizedException); noEffects(h);
    });
    it('MFA enrollment refreshes the TOTP window after its role wait', async () => {
        const h = harness('enroll'); h.pauseRoles();
        const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 120_000); }, 'roles');
        expect(result.error).toBeInstanceOf(ForbiddenException); noEffects(h);
    });
    for (const action of ['enroll', 'disable', 'verify'] as const) {
        it(`${action} rolls back an attempted TOTP claim when expiry crosses the proof await`, async () => {
            const h = harness(action); h.pauseProof();
            const result = await afterWait(h, () => { vi.setSystemTime(Date.now() + 3_600_000); }, 'proof');
            expect(result.error).toBeInstanceOf(UnauthorizedException); expect(h.proofs).toHaveBeenCalledTimes(1);
            expect(h.committed).not.toHaveBeenCalled(); expect(h.writes).not.toHaveBeenCalled(); expect(h.audits).not.toHaveBeenCalled();
            expect(h.redis.set).not.toHaveBeenCalled(); expect(h.redis.del).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });
    }

});
