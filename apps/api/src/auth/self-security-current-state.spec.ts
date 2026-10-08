import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { MFA_MARKER_TTL_SCRIPT } from '@lunchlineup/rbac';
import { performance } from 'node:perf_hooks';

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
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'synthetic-self-security-platform-capability');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Actual AuthService and RBAC; exact selector-filtered current rows. The model
// stages writes until successful callback completion, without real SQL locks,
// isolation, rollback, Redis execution or native qualification.
type PinEffectStage = 'user' | 'sessions' | 'audit';
type PinAttempt = { stage: PinEffectStage; args: any; active: number };
function harness(action: Action, pinEffectStage?: PinEffectStage) {
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
    const pinEffectEntered = gate(), pinEffectRelease = gate();
    const pinAttempts: PinAttempt[] = [], pinRaw: Array<{ text: string; values: unknown[]; execute: boolean }> = [];
    const pinReads: Array<{ model: string; args: any }> = [], redisBoundaries: Array<{ method: string; active: number; args: unknown[] }> = [];
    const pinTransactionOptions: unknown[] = [];
    const recordPinRead = (model: string, args: any) => {
        if (pinEffectStage) pinReads.push({ model, args: structuredClone(args) });
    };
    const afterPinEffect = async (stage: PinEffectStage, args: any) => {
        if (!pinEffectStage) return;
        pinAttempts.push({ stage, args: structuredClone(args), active });
        if (stage === pinEffectStage) { pinEffectEntered.release(); await pinEffectRelease.promise; }
    };
    const database: any = { $transaction: async (operation: any, options?: unknown) => {
        if (pinEffectStage) pinTransactionOptions.push(options);
        expect(active).toBe(0); active++;
        const staged: unknown[] = [];
        const tx: any = {
            $executeRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
                if (pinEffectStage) pinRaw.push({ text: (Array.isArray(sql) ? sql : sql.strings).join('').replace(/\s+/g, ' ').trim(),
                    values: flatten(Array.isArray(sql) ? args : sql.values), execute: true });
                return 1;
            }),
            $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
                const text = (Array.isArray(sql) ? sql : sql.strings).join('');
                const values = flatten(Array.isArray(sql) ? args : sql.values);
                if (pinEffectStage) pinRaw.push({ text: text.replace(/\s+/g, ' ').trim(), values, execute: false });
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
            tenant: { findUnique: vi.fn(async (args: any) => {
                recordPinRead('tenant.findUnique', args); const { where } = args;
                expect(where).toEqual({ id: ids.tenantId }); return structuredClone(state.tenant);
            }) },
            user: {
                findFirst: vi.fn(async (args: any) => {
                    recordPinRead('user.findFirst', args); const { where } = args;
                    expect(where).toMatchObject({ id: ids.userId, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null });
                    return state.user.deletedAt || state.user.suspendedAt || state.user.tenantId !== ids.tenantId ? null : structuredClone(state.user);
                }),
                update: vi.fn(async ({ where, data }: any) => {
                    expect(where).toEqual({ id: ids.userId }); writes('user', data); staged.push(data);
                    await afterPinEffect('user', { where, data }); return {};
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                    writes('user', data); staged.push(data);
                    await afterPinEffect('user', { where, data });
                    expect(where).toMatchObject({ id: ids.userId, tenantId: ids.tenantId }); return { count: 1 };
                }),
            },
            session: {
                findFirst: vi.fn(async (args: any) => {
                    recordPinRead('session.findFirst', args); const { where } = args;
                    expect(where).toEqual({ id: ids.sessionId, userId: ids.userId });
                    return state.session?.id === ids.sessionId && state.session.userId === ids.userId ? structuredClone(state.session) : null;
                }),
                findMany: vi.fn(async (args: any) => {
                    recordPinRead('session.findMany', args); const { where } = args;
                    expect(where).toEqual({ userId: ids.userId, revokedAt: null });
                    if (pauseList) { listEntered.release(); await listRelease.promise; }
                    return [{ id: ids.sessionId }];
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                    writes('sessions', data); staged.push(data);
                    await afterPinEffect('sessions', { where, data });
                    expect(where).toEqual({ userId: ids.userId, revokedAt: null }); return { count: 1 };
                }),
            },
            tenantSetting: { findUnique: vi.fn(async (args: any) => {
                recordPinRead('tenantSetting.findUnique', args); const { where } = args;
                expect(where).toEqual({ tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } });
                return { value: { security: structuredClone(state.security) } };
            }) },
            roleAssignment: { findMany: vi.fn(async (args: any) => {
                recordPinRead('roleAssignment.findMany', args); const { where } = args;
                expect(where).toMatchObject({ tenantId: ids.tenantId });
                if (pauseRoles && !rolesPaused) { rolesPaused = true; rolesEntered.release(); await rolesRelease.promise; }
                return state.assigned ? [{ userId: ids.userId, roleId: state.role.id, role: structuredClone(state.role) }] : [];
            }) },
            role: { findMany: vi.fn(async (args: any) => {
                recordPinRead('role.findMany', args); const { where } = args;
                expect(where.tenantId).toBe(ids.tenantId); return state.assigned ? [structuredClone(state.role)] : [];
            }) },
            auditLog: { create: vi.fn(async ({ data }: any) => {
                audits(data); staged.push(data); await afterPinEffect('audit', { data });
                expect(data).toMatchObject({ tenantId: ids.tenantId, actorUserId: ids.userId }); return {};
            }) },
            mfaTotpClaim: { create: vi.fn(async ({ data }: any) => {
                expect(data).toMatchObject({ tenantId: ids.tenantId, userId: ids.userId }); proofs(data); staged.push(data);
                if (pauseProof) { proofEntered.release(); await proofRelease.promise; }
                return {};
            }) },
        };
        try {
            const result = await operation(tx); if (staged.length) onCommit?.();
            if (pinEffectStage && staged.length) {
                // Publish staged state only after callback success. Its captured
                // actor Session snapshot remains active while this owner revokes
                // the live row; a later guard must not reject its own revocation.
                const credential = pinAttempts.find(attempt => attempt.stage === 'user')?.args.data;
                const revocation = pinAttempts.find(attempt => attempt.stage === 'sessions')?.args.data;
                if (credential) Object.assign(state.user, structuredClone(credential));
                if (revocation) Object.assign(state.session, structuredClone(revocation));
            }
            for (const value of staged) committed(value); return result;
        }
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
            if (pinEffectStage) redisBoundaries.push({ method: 'eval', active, args: [_script, count, key] });
            expect(active).toBe(0); expect(count).toBe(1); expect(key).toBe(`session_mfa:${ids.sessionId}`);
            const ttl = state.markerTtl; onObserve?.(); return ttl;
        }),
        set: vi.fn(async () => { expect(active).toBe(0); return 'OK'; }),
        del: vi.fn(async (...args: unknown[]) => {
            if (pinEffectStage) redisBoundaries.push({ method: 'del', active, args });
            expect(active).toBe(0); return 1;
        }),
    };
    (service as any).redis = redis;
    const code = (service as any).generateTotpCode((service as any).secretToBuffer(secret), Math.floor(Date.now() / 30_000));
    const claims = { tenantId: ids.tenantId, sessionId: ids.sessionId };
    const call = () => action === 'enroll' ? service.confirmMfaEnrollment(ids.userId, code, claims)
        : action === 'disable' ? service.disableMfa(ids.userId, code, claims)
        : action === 'verify' ? service.validateMfa(ids.userId, code, claims)
        : service.rotateOwnPin(ids.userId, '1111', '2222', ids.tenantId, ids.sessionId);
    return { state, entered, release, rolesEntered, rolesRelease, finalEntered, finalRelease, listEntered, listRelease, proofEntered, proofRelease, writes, audits, proofs, committed, jwt, redis, call,
        pinEffectEntered, pinEffectRelease, pinAttempts, pinRaw, pinReads, redisBoundaries, pinTransactionOptions,
        activeTransactions: () => active,
        verifyPin: (pin: string, hash: string) => (service as any).verifyPin(pin, hash),
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

// These controlled gates are after the actual owner's staged writes, not actor
// writers committing under modeled held locks. Only the selected wall or
// monotonic clock advances; SQL/SSI, commit latency and Redis remain unproved.
type PinDeadlineMode = 'stored session' | 'effective policy' | 'bounded MFA' | 'monotonic MFA';
async function boundedPinWait<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`PIN fixture bounded wait: ${label}`)), 2000);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}
async function throughPinEffect(h: Fixture, advanceMs: number, monotonic = false) {
    const pending = h.call().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await boundedPinWait(Promise.race([
            h.entered.promise.then(() => 'entered'), pending.then(() => 'settled'),
        ]), 'initial Tenant arrival')).toBe('entered');
        h.release.release();
        expect(await boundedPinWait(Promise.race([
            h.pinEffectEntered.promise.then(() => 'entered'), pending.then(() => 'settled'),
        ]), 'post-staged-effect arrival')).toBe('entered');
        // All reached effects are attempted, but none has committed while the
        // callback is suspended. This assertion independently proves arrival.
        expect(h.pinAttempts.length).toBeGreaterThan(0);
        expect(h.committed).not.toHaveBeenCalled();
        expect(h.redis.del).not.toHaveBeenCalled();
        if (monotonic) vi.spyOn(performance, 'now').mockReturnValue(100_000 + advanceMs);
        else vi.setSystemTime(Date.now() + advanceMs);
        h.pinEffectRelease.release();
        return await boundedPinWait(pending, 'completion');
    } finally {
        h.release.release(); h.rolesRelease.release(); h.finalRelease.release();
        h.listRelease.release(); h.proofRelease.release(); h.pinEffectRelease.release();
        await boundedPinWait(pending, 'finally release and drain');
    }
}
function configurePinDeadline(h: Fixture, mode: PinDeadlineMode): number {
    if (mode === 'stored session') { h.state.session.expiresAt = new Date(Date.now() + 1000); return 1000; }
    if (mode === 'effective policy') {
        h.state.security.sessionTimeoutMinutes = 5;
        h.state.session.createdAt = new Date(Date.now() - 4 * 60_000); return 60_000;
    }
    if (mode === 'monotonic MFA') vi.spyOn(performance, 'now').mockReturnValue(100_000);
    h.state.user.mfaEnabled = true; h.state.markerTtl = 1000; return 1001;
}
function assertPinAttemptContract(h: Fixture, stage: PinEffectStage, startedAt: number, observedMfa: boolean) {
    // Run outside the owner's catches BEFORE the primary expiry/success oracle.
    // A caught mock assertion cannot masquerade as the expected auth exception.
    const ordered = ['user', 'sessions', 'audit'];
    expect(h.pinAttempts.map(attempt => attempt.stage)).toEqual(ordered.slice(0, h.pinAttempts.length));
    expect(h.pinAttempts.length).toBeGreaterThanOrEqual(ordered.indexOf(stage) + 1);
    expect(h.pinAttempts.length).toBeLessThanOrEqual(3);
    expect(h.activeTransactions()).toBe(0);
    for (const attempt of h.pinAttempts) {
        expect(attempt.active).toBe(1);
        const { where, data } = attempt.args;
        if (attempt.stage === 'user') {
            expect(where).toEqual({ id: ids.userId, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null });
            expect(Object.keys(data).sort()).toEqual(['pinHash', 'pinLockedUntil', 'pinLoginAttempts', 'pinResetRequired', 'pinSetAt']);
            expect(data).toMatchObject({ pinResetRequired: false, pinLoginAttempts: 0, pinLockedUntil: null });
            expect(data.pinSetAt).toEqual(new Date(startedAt));
            expect(data.pinHash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
            expect(h.verifyPin('2222', data.pinHash)).toBe(true);
            expect(h.verifyPin('1111', data.pinHash)).toBe(false);
        } else if (attempt.stage === 'sessions') {
            expect(where).toEqual({ userId: ids.userId, revokedAt: null });
            expect(data).toEqual({ revokedAt: new Date(startedAt) });
        } else {
            expect(attempt.args).toEqual({ data: {
                tenantId: ids.tenantId, userId: ids.userId, actorUserId: ids.userId, actorTenantId: ids.tenantId,
                action: 'USER_PIN_ROTATED', resource: 'User', resourceId: ids.userId,
                newValue: { pinResetRequired: false, sessionsRevoked: 1 }, ipAddress: null, userAgent: null,
            } });
            expect(JSON.stringify(data)).not.toMatch(/pinHash|1111|2222|mfaSecret|mfaBackupCodes/);
        }
    }
    expect(h.writes.mock.calls.map(call => call[0])).toEqual(h.pinAttempts.filter(attempt => attempt.stage !== 'audit').map(attempt => attempt.stage));
    expect(h.audits).toHaveBeenCalledTimes(h.pinAttempts.filter(attempt => attempt.stage === 'audit').length);
    expect(h.proofs).not.toHaveBeenCalled(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
    expect(h.redis.get).not.toHaveBeenCalled(); expect(h.redis.set).not.toHaveBeenCalled();
    expect(h.redis.eval).toHaveBeenCalledTimes(observedMfa ? 1 : 0);
    for (const call of h.redisBoundaries) {
        expect(call.active).toBe(0);
        expect(call.args).toEqual(call.method === 'eval'
            ? [MFA_MARKER_TTL_SCRIPT, 1, `session_mfa:${ids.sessionId}`]
            : [`session_mfa:${ids.sessionId}`]);
    }
    expect(h.pinTransactionOptions).toEqual([undefined, { isolationLevel: 'Serializable' }]);
    const rawCycle = [
        { execute: true, text: 'SELECT set_current_tenant()', values: [ids.tenantId] },
        { execute: false, text: 'SELECT "id" FROM "Tenant" WHERE "id" IN () ORDER BY "id" FOR UPDATE', values: [ids.tenantId] },
        { execute: false, text: 'SELECT "id" FROM "User" WHERE "tenantId" = AND "id" IN () AND "deletedAt" IS NULL ORDER BY "id" FOR UPDATE', values: [ids.tenantId, ids.userId] },
        { execute: false, text: 'SELECT "id", "userId", "expiresAt", "revokedAt" FROM "Session" WHERE "id" = AND "userId" = FOR UPDATE', values: [ids.sessionId, ids.userId] },
        { execute: false, text: 'SELECT "userId", "roleId" FROM "RoleAssignment" WHERE "tenantId" = AND "userId" IN () ORDER BY "userId", "roleId" FOR UPDATE', values: [ids.tenantId, ids.userId] },
        { execute: false, text: 'SELECT "id" FROM "Role" WHERE "tenantId" = AND "id" = FOR UPDATE', values: [ids.tenantId, h.state.role.id] },
        { execute: false, text: 'SELECT "roleId", "permissionId" FROM "RolePermission" WHERE "roleId" IN () ORDER BY "roleId", "permissionId" FOR UPDATE', values: [h.state.role.id] },
    ];
    expect(h.pinRaw).toEqual([...rawCycle, ...rawCycle]);
    const readCycle = [
        { model: 'user.findFirst', args: { where: { id: ids.userId, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null },
            select: { id: true, role: true, lockedUntil: true, pinLockedUntil: true } } },
        { model: 'roleAssignment.findMany', args: { where: { tenantId: ids.tenantId, userId: ids.userId }, select: { userId: true, roleId: true }, orderBy: [{ userId: 'asc' }, { roleId: 'asc' }] } },
        { model: 'role.findMany', args: { where: { tenantId: ids.tenantId, id: { in: [h.state.role.id] }, deletedAt: null }, include: { rolePermissions: { include: { permission: true } } }, orderBy: { id: 'asc' } } },
        { model: 'tenant.findUnique', args: { where: { id: ids.tenantId }, select: { id: true, status: true, deletedAt: true } } },
        { model: 'user.findFirst', args: { where: { id: ids.userId, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null },
            select: { id: true, tenantId: true, role: true, email: true, username: true, pinHash: true, pinResetRequired: true, mfaEnabled: true, mfaSecret: true, mfaBackupCodes: true } } },
        { model: 'session.findFirst', args: { where: { id: ids.sessionId, userId: ids.userId } } },
        { model: 'tenantSetting.findUnique', args: { where: { tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } }, select: { value: true } } },
    ];
    expect(h.pinReads).toEqual([...readCycle, ...readCycle,
        { model: 'session.findMany', args: { where: { userId: ids.userId, revokedAt: null }, select: { id: true } } },
    ]);
}
function assertPinCommitted(h: Fixture) {
    expect(h.pinAttempts.map(attempt => attempt.stage)).toEqual(['user', 'sessions', 'audit']);
    expect(h.committed.mock.calls.map(call => call[0])).toEqual(h.pinAttempts.map(attempt => attempt.args.data));
    expect(h.verifyPin('2222', h.state.user.pinHash)).toBe(true);
    expect(h.state.user.pinResetRequired).toBe(false);
    expect(h.state.session.revokedAt).toEqual(h.pinAttempts[1].args.data.revokedAt);
    expect(h.redis.del).toHaveBeenCalledExactlyOnceWith(`session_mfa:${ids.sessionId}`);
}
describe('retained PIN late-effect bounded current authority', () => {
    for (const stage of ['user', 'sessions', 'audit'] as const) {
        for (const mode of ['stored session', 'effective policy', 'bounded MFA', 'monotonic MFA'] as const) {
            it(`PIN rolls back ${mode} expiry after staged ${stage} effect`, async () => {
                const h = harness('pin', stage), startedAt = Date.now(), originalHash = h.state.user.pinHash;
                const expiresAfter = configurePinDeadline(h, mode);
                const result = await throughPinEffect(h, expiresAfter, mode === 'monotonic MFA');
                if (mode === 'monotonic MFA') expect(Date.now()).toBe(startedAt);
                assertPinAttemptContract(h, stage, startedAt, mode.endsWith('MFA'));
                expect(result.error).toBeInstanceOf(mode.endsWith('MFA') ? ForbiddenException : UnauthorizedException);
                expect(result.value).toBeUndefined(); expect(h.committed).not.toHaveBeenCalled();
                expect(h.state.user.pinHash).toBe(originalHash); expect(h.state.session.revokedAt).toBeNull();
                expect(h.redis.del).not.toHaveBeenCalled();
            });
            it(`PIN commits still-valid ${mode} after staged ${stage} effect`, async () => {
                const h = harness('pin', stage), startedAt = Date.now();
                const expiresAfter = configurePinDeadline(h, mode);
                const result = await throughPinEffect(h, expiresAfter - (mode.endsWith('MFA') ? 2 : 1), mode === 'monotonic MFA');
                if (mode === 'monotonic MFA') expect(Date.now()).toBe(startedAt);
                assertPinAttemptContract(h, stage, startedAt, mode.endsWith('MFA'));
                expect(result.error).toBeUndefined(); assertPinCommitted(h);
            });
        }
        it(`forced PIN recovery commits after staged ${stage} effect without MFA observation`, async () => {
            const h = harness('pin', stage), startedAt = Date.now();
            h.state.user.pinResetRequired = true; h.state.user.mfaEnabled = true;
            h.state.security.requireMfaForAll = true; h.state.markerTtl = -2;
            h.state.session.expiresAt = new Date(Date.now() + 1000);
            const result = await throughPinEffect(h, 999);
            assertPinAttemptContract(h, stage, startedAt, false);
            expect(result.error).toBeUndefined(); assertPinCommitted(h);
        });
    }
});


// Reuse the existing staged transaction effect gate for the actual disableMfa
// owner. This models rollback; it is not native PG/TOTP/Redis acceptance.
describe('MFA removal expiry after staged account/session/audit waits', () => {
  for (const stage of ['user', 'sessions', 'audit'] as const) {
    for (const lifetime of ['stored session', 'effective policy'] as const) {
      for (const proof of ['totp', 'recovery'] as const) {
        it.each([true, false])(`${stage}, ${lifetime}, ${proof}: exact-deadline refusal=%s is atomic`, async expires => {
          const h = harness('disable', stage);
          if (proof === 'recovery') h.useBackupProof();
          const userBefore = structuredClone(h.state.user); const sessionBefore = structuredClone(h.state.session);
          const remaining = configurePinDeadline(h, lifetime);
          const expirySession = structuredClone(h.state.session);
          const result = await throughPinEffect(h, remaining - (expires ? 0 : 1));
          const expectedStages = ['user', 'sessions', 'audit'];
          expect(h.pinAttempts.map(attempt => attempt.stage)).toEqual(expires ? expectedStages.slice(0, expectedStages.indexOf(stage) + 1) : expectedStages);
          expect(h.activeTransactions()).toBe(0);
          expect(h.proofs).toHaveBeenCalledTimes(proof === 'totp' ? 1 : 0);
          const userAttempt = h.pinAttempts[0];
          expect(userAttempt.args).toEqual({ where: { id: ids.userId }, data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] } });
          for (const attempt of h.pinAttempts) expect(attempt.active).toBe(1);
          if (expires) {
            expect(result.error).toBeInstanceOf(UnauthorizedException); expect(result.value).toBeUndefined();
            expect(h.committed).not.toHaveBeenCalled(); expect(h.state.user).toEqual(userBefore);
            expect(h.state.session).toEqual(expirySession); expect(h.redis.del).not.toHaveBeenCalled();
          } else {
            expect(result.error).toBeUndefined(); expect(result.value).toEqual({ success: true, mfaEnabled: false });
            expect(h.state.user).toMatchObject({ mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] });
            expect(h.state.session.revokedAt).toBeInstanceOf(Date);
            expect(h.committed).toHaveBeenCalledTimes(proof === 'totp' ? 4 : 3);
            expect(h.audits).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'MFA_DISABLED', resourceId: ids.userId }));
            expect(h.redis.del).toHaveBeenCalledExactlyOnceWith(`session_mfa:${ids.sessionId}`);
          }
          expect(sessionBefore.revokedAt).toBeNull(); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
        });
      }
    }
  }
});
