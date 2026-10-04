import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { createDecipheriv } from 'node:crypto';

function decryptedOutbox(row: any) {
    const envelope = JSON.parse(row.encryptedPayload);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from('11'.repeat(32), 'hex'), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
}

const epoch = new Date('2026-10-04T12:00:00Z');
const bearer = 'reset_current_authority_token_1234567890123456789';
const nextHash = '$2b$10$controlled-prepared-credential';
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });

// Actual AuthService/TenantPrismaService/RbacService over controlled statement
// results and transaction-private effects. The SQL-clock adapter is explicit:
// this does not execute PostgreSQL, qualify row locks, or prove native rollback.
function harness(hold: 'hash' | 'access' | 'consume' | 'sessions' | undefined = undefined) {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(epoch);
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'unit-reset-capability');
    const live: any = {
        tenant: { id: 't-reset', slug: 'reset', status: 'ACTIVE', deletedAt: null },
        user: { id: 'u-reset', tenantId: 't-reset', username: 'reset.user', email: 'current@example.test',
            passwordHash: 'old-credential', deletedAt: null, suspendedAt: null,
            lockedUntil: new Date(epoch.getTime() + 3_600_000), pinLockedUntil: new Date(epoch.getTime() + 3_600_000),
            pinResetRequired: true, mfaEnabled: true, loginAttempts: 5 },
        security: { ssoOidcOnly: false, sessionTimeoutMinutes: 480 },
        permissions: ['auth:login_password'],
        tokens: [] as any[], outboxes: [] as any[],
        sessions: [{ id: 's-reset', userId: 'u-reset', revokedAt: null }], audits: [] as any[],
    };
    const entered = deferred(), gate = deferred(); let held = false, sequence = 0, activeWrites = 0, activeCallbacks = 0;
    const hashCallbackCounts: number[] = [];
    const cleanupObservations: Array<{ callbacks:number; writes:number }> = [];
    let conflictCount = 0, onConflict: (() => void) | undefined;
    let commitFailure = false, auditFailure = false, consumeFailure = false;
    let lockTail = Promise.resolve();
    const effects = { user: vi.fn(), session: vi.fn(), token: vi.fn(), outbox: vi.fn(), audit: vi.fn() };
    const locks: string[] = [], scopes: unknown[] = [];
    const pause = async (stage: string) => {
        if (hold === stage && !held) { held = true; entered.release(); await gate.promise; }
    };
    const client: any = { $transaction: async (operation: (tx: any) => Promise<unknown>, options?: { isolationLevel?: string }) => {
        activeCallbacks++;
        let draft: any, releaseLock: (() => void) | undefined;
        const state = () => draft ?? live;
        const mutate = () => { if (!draft) { draft = structuredClone(live); activeWrites++; } return draft; };
        const tx: any = {
            $executeRaw: vi.fn(async () => 1),
            $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
                const strings = Array.isArray(sql) ? sql : sql.strings;
                const values = Array.isArray(sql) ? args : sql.values;
                const text = strings.join('?');
                if (text.includes('FOR UPDATE')) {
                    expect(options?.isolationLevel).toBe('ReadCommitted');
                    const table = text.includes('FROM "Tenant"') ? 'Tenant'
                        : text.includes('FROM "User"') ? 'User' : 'PasswordResetToken';
                    locks.push(table); scopes.push({ table, values });
                    if (table === 'Tenant' && !releaseLock) {
                        const previous = lockTail; const lock = deferred(); lockTail = lock.promise;
                        await previous; releaseLock = lock.release;
                    }
                    return [{ id: table === 'Tenant' ? live.tenant.id : table === 'User' ? live.user.id : 'token-current' }];
                }
                if (text.includes('UPDATE "PasswordResetToken"')) {
                    expect(text.replace(/\s+/g,' ')).toContain('"expiresAt" > timezone(\'UTC\', clock_timestamp())');
                    expect(text).toContain('RETURNING "id", "consumedAt"');
                    await pause('consume'); if (consumeFailure) throw new Error('controlled consume failure');
                    const [id, tenantId, userId, tokenHash] = values;
                    const selected = state().tokens.find((row: any) => row.id === id && row.tenantId === tenantId
                        && row.userId === userId && row.tokenHash === tokenHash && !row.consumedAt && row.expiresAt > new Date());
                    if (!selected) return [];
                    effects.token(); const row = mutate().tokens.find((item: any) => item.id === id);
                    row.consumedAt = new Date(); return [{ id: row.id, consumedAt: row.consumedAt }];
                }
                throw new Error('Unexpected reset SQL statement');
            }),
            tenant: { findUnique: vi.fn(async () => structuredClone(state().tenant)) },
            tenantSetting: { findUnique: vi.fn(async () => ({ value: { security: structuredClone(state().security) } })) },
            user: {
                findFirst: vi.fn(async ({ where }: any) => {
                    const user = state().user;
                    return user && user.tenantId === where.tenantId && (!where.id || user.id === where.id)
                        && !user.deletedAt && !user.suspendedAt && user.passwordHash ? structuredClone(user) : null;
                }),
                update: vi.fn(async ({ where, data }: any) => {
                    expect(where.id).toBe(live.user.id); effects.user(); Object.assign(mutate().user, data); return structuredClone(state().user);
                }),
            },
            roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ tenantId:'t-reset', userId:'u-reset', role:{ tenantId:'t-reset', deletedAt:null } });
                const permissions = [...state().permissions]; await pause('access');
                return permissions.length ? [{ role: { id: 'role-reset', name: 'Password staff', isSystem: false,
                    legacyRole: null, rolePermissions: permissions.map(key => ({ permission: { key } })) } }] : [];
            }) },
            passwordResetToken: {
                findFirst: vi.fn(async ({ where, include }: any) => {
                    const token = state().tokens.find((row: any) => Object.entries(where).every(([key, value]) => row[key] === value));
                    return token ? { ...structuredClone(token), ...(include?.user ? { user: structuredClone(state().user) } : {}) } : null;
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                    if (where.id) {
                        await pause('consume');
                        if (consumeFailure) throw new Error('controlled consume failure');
                    }
                    const matches = (row: any) => (!where.id || row.id === where.id)
                        && (!where.tenantId || row.tenantId === where.tenantId) && (!where.userId || row.userId === where.userId)
                        && (!where.expiresAt || row.expiresAt > where.expiresAt.gt) && row.consumedAt === null;
                    const selected = state().tokens.filter(matches); if (!selected.length) return { count: 0 };
                    effects.token(); mutate().tokens.filter(matches).forEach((row: any) => Object.assign(row, data));
                    return { count: selected.length };
                }),
                create: vi.fn(async ({ data }: any) => { effects.token(); const row = { id: 'token-'+(++sequence), consumedAt: null, ...data }; mutate().tokens.push(row); return row; }),
            },
            passwordResetEmailOutbox: {
                updateMany: vi.fn(async ({ where, data }: any) => {
                    const matches = (row: any) => row.userId === where.userId && row.tenantId === where.tenantId
                        && where.status.in.includes(row.status);
                    const selected = state().outboxes.filter(matches); if (!selected.length) return { count: 0 };
                    effects.outbox(); mutate().outboxes.filter(matches).forEach((row: any) => Object.assign(row, data)); return { count: selected.length };
                }),
                create: vi.fn(async ({ data }: any) => { effects.outbox(); mutate().outboxes.push({ id: 'outbox-'+sequence, status: 'PENDING', ...data }); return data; }),
            },
            session: {
                findMany: vi.fn(async ({ where }: any) => { expect(where).toEqual({ userId:'u-reset', revokedAt:null }); await pause('sessions'); return structuredClone(state().sessions.filter((row: any) => !row.revokedAt)); }),
                updateMany: vi.fn(async ({ data }: any) => { effects.session(); mutate().sessions.forEach((row: any) => Object.assign(row, data)); return { count: state().sessions.length }; }),
            },
            auditLog: { create: vi.fn(async ({ data }: any) => { effects.audit(); if (auditFailure) throw new Error('controlled audit failure'); mutate().audits.push(data); return data; }) },
        };
        try {
            const result = await operation(tx);
            if (draft) {
                if (conflictCount > 0) { conflictCount--; onConflict?.(); throw { code: 'P2034' }; }
                if (commitFailure) throw new Error('controlled commit failure'); Object.assign(live, draft);
            }
            return result;
        } finally { activeCallbacks--; if (draft) activeWrites--; releaseLock?.(); }
    } };
    const tenantDb = new TenantPrismaService(client), rbac = new RbacService(tenantDb);
    const service = new AuthService({ get: (key: string, fallback: unknown) => ({ APP_ORIGIN: 'https://reset.example.test',
        PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: '11'.repeat(32) } as Record<string, unknown>)[key] ?? fallback } as any,
        { generateAccessToken: vi.fn() } as any, rbac, tenantDb);
    // Inspect these observations outside the owner's best-effort catch; an
    // assertion thrown inside DEL could otherwise be swallowed as Redis loss.
    const redis = { del: vi.fn(async () => { cleanupObservations.push({ callbacks:activeCallbacks, writes:activeWrites }); return 1; }) }; (service as any).redis = redis;
    vi.spyOn(service as any, 'hashNewPassword').mockImplementation(async () => { hashCallbackCounts.push(activeCallbacks); await pause('hash'); return nextHash; });
    live.tokens.push({ id: 'token-current', tenantId: live.tenant.id, userId: live.user.id,
        tokenHash: (service as any).hashPasswordResetToken(bearer), expiresAt: new Date(epoch.getTime() + 10_000), consumedAt: null });
    const confirm = () => service.resetPasswordWithToken(bearer, 'new-password-1', { ipAddress: '192.0.2.4', userAgent: 'reset-unit' });
    const request = () => service.createPasswordReset('reset.user', 'reset');
    return { live, entered, gate, effects, redis, locks, scopes, confirm, request, hashCallbackCounts, cleanupObservations,
        conflicts: (count: number, change?: () => void) => { conflictCount = count; onConflict = change; },
        failCommit: () => { commitFailure = true; }, failAudit: () => { auditFailure = true; }, failConsume: () => { consumeFailure = true; } };
}
async function during(h: ReturnType<typeof harness>, operation: () => Promise<unknown>, change: () => void) {
    const pending = operation().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.entered.promise.then(() => 'entered'), pending.then(() => 'settled')])).toBe('entered');
        change(); h.gate.release(); return await pending;
    } finally { h.gate.release(); await pending; }
}
const unchanged = (h: ReturnType<typeof harness>) => {
    expect(h.live.user.passwordHash).toBe('old-credential'); expect(h.live.sessions[0].revokedAt).toBeNull();
    expect(h.live.tokens[0].consumedAt).toBeNull(); expect(h.live.audits).toEqual([]); expect(h.redis.del).not.toHaveBeenCalled();
};

describe('password reset current authority and expiry', () => {
    it.each(['tenant suspended', 'tenant deleted', 'user suspended', 'user deleted', 'password removed', 'user moved'])(
        'refuses %s committed while hashing without durable effects', async reason => {
            const h = harness('hash');
            const result = await during(h, h.confirm, () => {
                if (reason === 'tenant suspended') h.live.tenant.status = 'SUSPENDED';
                if (reason === 'tenant deleted') h.live.tenant.deletedAt = new Date();
                if (reason === 'user suspended') h.live.user.suspendedAt = new Date();
                if (reason === 'user deleted') h.live.user.deletedAt = new Date();
                if (reason === 'password removed') h.live.user.passwordHash = null;
                if (reason === 'user moved') h.live.user.tenantId = 'other-tenant';
            });
            expect(result.error).toBeInstanceOf(UnauthorizedException);
            expect(h.effects.user).not.toHaveBeenCalled(); expect(h.effects.session).not.toHaveBeenCalled();
            expect(h.effects.token).not.toHaveBeenCalled(); expect(h.effects.audit).not.toHaveBeenCalled();
            expect(h.live.sessions[0].revokedAt).toBeNull(); expect(h.live.tokens[0].consumedAt).toBeNull(); expect(h.redis.del).not.toHaveBeenCalled();
        });
    it('refuses a reset that expires while hashing and preserves all reset effects', async () => {
        const h = harness('hash'); const result = await during(h, h.confirm, () => vi.setSystemTime(epoch.getTime()+10_000));
        expect(result.error).toBeInstanceOf(UnauthorizedException); unchanged(h);
    });
    it('uses the consumption statement clock when the token expires while SQL waits', async () => {
        const h = harness('consume'); const result = await during(h, h.confirm, () => vi.setSystemTime(epoch.getTime()+10_000));
        expect(result.error).toBeInstanceOf(UnauthorizedException); unchanged(h);
    });
    it('checks expiry after a delayed active-session read', async () => {
        const h = harness('sessions'); const result = await during(h, h.confirm, () => vi.setSystemTime(epoch.getTime()+10_000));
        expect(result.error).toBeInstanceOf(UnauthorizedException); unchanged(h);
    });
    it.each(['tenant suspended', 'tenant deleted', 'user suspended', 'user deleted', 'password removed', 'email removed', 'SSO required', 'password grant removed'])(
        'requests remain generic and create no effects after %s during preflight', async reason => {
            const h = harness('access');
            const result = await during(h, h.request, () => {
                if (reason === 'tenant suspended') h.live.tenant.status = 'SUSPENDED';
                if (reason === 'tenant deleted') h.live.tenant.deletedAt = new Date();
                if (reason === 'user suspended') h.live.user.suspendedAt = new Date();
                if (reason === 'user deleted') h.live.user.deletedAt = new Date();
                if (reason === 'password removed') h.live.user.passwordHash = null;
                if (reason === 'email removed') h.live.user.email = null;
                if (reason === 'SSO required') h.live.security.ssoOidcOnly = true;
                if (reason === 'password grant removed') h.live.permissions = ['dashboard:access'];
            });
            expect(result.error).toBeUndefined(); expect(result.value).toBeNull();
            expect(h.live.tokens).toHaveLength(1); expect(h.live.tokens[0].consumedAt).toBeNull(); expect(h.live.outboxes).toEqual([]);
            expect(h.effects.token).not.toHaveBeenCalled(); expect(h.effects.outbox).not.toHaveBeenCalled();
        });
    it('encrypts a reset for the current recipient after an email change in preflight', async () => {
        const h = harness('access');
        const result = await during(h, h.request, () => { h.live.user.email = 'replacement@example.test'; });
        expect(result.error).toBeUndefined(); expect(result.value).toBeNull(); expect(h.live.outboxes).toHaveLength(1);
        const payload = decryptedOutbox(h.live.outboxes[0]);
        expect(payload.email).toBe('replacement@example.test'); expect(h.live.outboxes[0].encryptedPayload).not.toContain('replacement@example.test');
    });
    it('preserves recovery for a locked account with PIN rotation and MFA required', async () => {
        const h = harness(); await expect(h.confirm()).resolves.toBeUndefined();
        expect(h.live.user.passwordHash).toBe(nextHash); expect(h.live.user.loginAttempts).toBe(0); expect(h.live.user.lockedUntil).toBeNull();
        expect(h.live.user.pinResetRequired).toBe(true); expect(h.live.user.mfaEnabled).toBe(true);
        expect(h.live.tokens[0].consumedAt).toEqual(epoch); expect(h.live.sessions[0].revokedAt).toEqual(epoch);
        expect(h.live.audits).toEqual([expect.objectContaining({ action: 'PASSWORD_RESET_COMPLETED', actorTenantId: 't-reset', actorUserId: 'u-reset' })]);
        expect(h.redis.del).toHaveBeenCalledWith('session_mfa:s-reset');
        expect(h.cleanupObservations).toEqual([{ callbacks:0,writes:0 }]);
        expect(h.locks).toEqual(['Tenant','User','PasswordResetToken']);
        expect(h.scopes).toEqual([{ table:'Tenant',values:['t-reset'] },{ table:'User',values:['u-reset','t-reset'] },
            { table:'PasswordResetToken',values:['token-current','t-reset','u-reset',h.live.tokens[0].tokenHash] }]);
    });
    it('keeps an issued recovery capability valid after SSO and password-login grants change', async () => {
        const h = harness(); h.live.security.ssoOidcOnly = true; h.live.permissions = [];
        await expect(h.confirm()).resolves.toBeUndefined(); expect(h.live.user.passwordHash).toBe(nextHash);
    });
    it('keeps requests generic when the account has no current RBAC assignment', async () => {
        const h = harness(); h.live.permissions = [];
        await expect(h.request()).resolves.toBeNull(); expect(h.live.tokens).toHaveLength(1); expect(h.live.outboxes).toEqual([]);
        expect(h.effects.token).not.toHaveBeenCalled(); expect(h.effects.outbox).not.toHaveBeenCalled();
    });
    it('prepares the credential outside database callbacks before the protected write', async () => {
        const h = harness(); await expect(h.confirm()).resolves.toBeUndefined(); expect(h.hashCallbackCounts).toEqual([0]);
    });
    it('refuses reuse of the consumed reset without a second credential or audit write', async () => {
        const h = harness(); await h.confirm(); await expect(h.confirm()).rejects.toBeInstanceOf(UnauthorizedException);
        expect(h.effects.user).toHaveBeenCalledOnce(); expect(h.effects.audit).toHaveBeenCalledOnce(); expect(h.redis.del).toHaveBeenCalledOnce();
    });
    it('rechecks eligibility and rolls back the first attempt when a conflict retry sees suspension', async () => {
        const h = harness(); h.conflicts(1, () => { h.live.user.suspendedAt = new Date(); });
        await expect(h.confirm()).rejects.toBeInstanceOf(UnauthorizedException); unchanged(h);
        expect(h.effects.user).toHaveBeenCalledOnce(); expect(h.redis.del).not.toHaveBeenCalled();
    });
    it('rechecks the current recipient when reset issuance retries after a conflict', async () => {
        const h = harness(); h.conflicts(1, () => { h.live.user.email = 'retry@example.test'; });
        await expect(h.request()).resolves.toBeNull(); expect(h.live.outboxes).toHaveLength(1);
        expect(h.live.tokens.filter((row: any) => !row.consumedAt)).toHaveLength(1); expect(h.effects.outbox).toHaveBeenCalledTimes(2);
        expect(decryptedOutbox(h.live.outboxes[0]).email).toBe('retry@example.test');
    });
    it('surfaces repeated serialization conflict without committed reset effects', async () => {
        const h = harness(); h.conflicts(2); await expect(h.confirm()).rejects.toMatchObject({ status:409 }); unchanged(h);
        expect(h.effects.user).toHaveBeenCalledTimes(2); expect(h.hashCallbackCounts).toEqual([0]);
    });
    it('starts a matching token and encrypted-message lifetime after the eligibility wait', async () => {
        const h = harness('access'); const result = await during(h,h.request,() => vi.setSystemTime(epoch.getTime()+90_000));
        expect(result.error).toBeUndefined(); expect(result.value).toBeNull();
        const token = h.live.tokens.find((row: any) => !row.consumedAt), outbox = h.live.outboxes[0];
        expect(token.expiresAt).toEqual(new Date(epoch.getTime()+90_000+3_600_000)); expect(outbox.expiresAt).toEqual(token.expiresAt);
        expect(outbox.tokenHash).toBe(token.tokenHash); expect(decryptedOutbox(outbox).expiresAt).toBe(token.expiresAt.toISOString());
    });
    it.each(['audit', 'commit', 'consume'])(
        'does not publish credential or session effects after %s failure', async failure => {
            const h = harness(); if (failure === 'audit') h.failAudit(); if (failure === 'commit') h.failCommit(); if (failure === 'consume') h.failConsume();
            await expect(h.confirm()).rejects.toThrow('controlled '+failure+' failure'); unchanged(h);
        });
    it('serializes concurrent reset requests so only the latest token and message remain live', async () => {
        const h = harness(); const results = await Promise.allSettled([h.request(),h.request()]);
        expect(results).toEqual([{ status:'fulfilled',value:null },{ status:'fulfilled',value:null }]);
        expect(h.live.tokens.filter((row: any) => !row.consumedAt)).toHaveLength(1);
        expect(h.live.outboxes.filter((row: any) => row.status === 'PENDING')).toHaveLength(1);
        expect(h.live.outboxes.filter((row: any) => row.status === 'DEAD_LETTERED')).toHaveLength(1);
    });
});
