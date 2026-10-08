import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RbacService } from './rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

const ids = { tenantId: 'enrollment-tenant', userId: 'enrollment-user', sessionId: 'enrollment-session' };
const firstSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const secondSecret = 'KRSXG5DSNFXGOIDBKRSXG5DSNFXGOIDB';
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};
const flatten = (values: unknown[]): unknown[] => values.flatMap(value => value && typeof value === 'object' && 'values' in value
    ? flatten((value as { values: unknown[] }).values) : [value]);
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'synthetic-enrollment-platform-capability');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// Real owners and selectors over explicit synthetic rows. Each callback has a
// private write draft; successful completion publishes it. SQL clock predicates
// are modeled with controlled Date, not executed by PostgreSQL. No native locks,
// isolation, RLS, Redis, cryptographic key custody or provider qualification.
function fixture() {
    const live: any = {
        tenant: { id: ids.tenantId, status: 'ACTIVE', deletedAt: null },
        user: { id: ids.userId, tenantId: ids.tenantId, role: 'STAFF', username: 'enrollment.user', email: null,
            deletedAt: null, suspendedAt: null, lockedUntil: null, pinLockedUntil: null, pinResetRequired: false,
            mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] },
        session: { id: ids.sessionId, userId: ids.userId, createdAt: new Date(Date.now() - 60_000),
            expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null,
            mfaEnrollmentSecret: null, mfaEnrollmentExpiresAt: null },
        security: { sessionTimeoutMinutes: 480, requireMfaForAll: false },
        role: { id: 'enrollment-role', tenantId: ids.tenantId, name: 'Current self service', isSystem: false,
            legacyRole: null, deletedAt: null, rolePermissions: [{ permission: { key: 'auth:login_pin' } }] },
        assigned: true, claims: [] as bigint[], audits: [] as any[],
    };
    const attempts: string[] = [], committed: string[] = [], locks: string[] = [], redisCalls: any[] = [], transactionOptions: any[] = [];
    const entered = deferred(), release = deferred();
    let active = 0, pauseAt: string | undefined, paused = false, failAt: string | undefined;
    let casZero = false, conflictCount = 0, onConflict: (() => void) | undefined, databaseOffset = 0;
    const clock = () => new Date(Date.now() + databaseOffset);
    const client: any = { $transaction: async (operation: any, options: any) => {
        transactionOptions.push(options);
        active++;
        let draft: any;
        const current = () => draft ?? live;
        const write = () => draft ??= structuredClone(live);
        const localEffects: string[] = [];
        const wait = async (name: string) => {
            if (pauseAt === name && !paused) { paused = true; entered.release(); await release.promise; }
            if (failAt === name) throw new Error(`controlled ${name} failure`);
        };
        const effect = async (name: string, change: (state: any) => void) => {
            attempts.push(name); localEffects.push(name); change(write()); await wait(name);
        };
        const tx: any = {
            $executeRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
                const text = (Array.isArray(sql) ? sql : sql.strings).join('');
                const values = flatten(Array.isArray(sql) ? args : sql.values);
                if (text.includes('set_current_tenant')) expect(values).toEqual([ids.tenantId]);
                else if (text.includes('set_current_platform_admin')) {
                    expect(text).toContain('set_current_platform_admin(true,');
                    expect(values).toEqual(['synthetic-enrollment-platform-capability']);
                }
                else throw new Error(`Unexpected execute SQL: ${text}`);
                return 1;
            }),
            $queryRaw: vi.fn(async (sql: any, ...args: unknown[]) => {
                const text = (Array.isArray(sql) ? sql : sql.strings).join('');
                const values = flatten(Array.isArray(sql) ? args : sql.values);
                if (text.includes('UPDATE "Session"')) {
                    return sessionStatement(text, values, current, effect, wait, () => casZero, clock);
                }
                if (text.includes('"mfaEnrollmentSecret"') && text.includes('FROM "Session"')) {
                    expect(text).toContain('FOR UPDATE'); expect(values).toEqual([ids.sessionId, ids.userId]);
                    await wait('pending');
                    const row = current().session;
                    return row?.id === ids.sessionId && row.userId === ids.userId && !row.revokedAt ? [structuredClone(row)] : [];
                }
                if (text.includes('FOR UPDATE')) {
                    const table = ['Tenant', 'User', 'Session', 'RoleAssignment', 'RolePermission', 'Role']
                        .find(name => text.includes(`FROM "${name}"`));
                    if (!table) throw new Error(`Unexpected locking SQL: ${text}`);
                    locks.push(table); await wait(`lock:${table}`);
                    if (table === 'Tenant') { expect(values).toEqual([ids.tenantId]); return live.tenant ? [{ id: live.tenant.id }] : []; }
                    if (table === 'User') { expect(values).toEqual([ids.tenantId, ids.userId]); return live.user?.tenantId === ids.tenantId ? [structuredClone(live.user)] : []; }
                    if (table === 'Session') { expect(values).toEqual([ids.sessionId, ids.userId]); return current().session?.id === ids.sessionId && current().session.userId === ids.userId ? [structuredClone(current().session)] : []; }
                    if (table === 'RoleAssignment') expect(values).toEqual([ids.tenantId, ids.userId]);
                    if (table === 'Role') expect(values).toEqual([ids.tenantId, live.role.id]);
                    if (table === 'RolePermission') expect(values).toEqual([live.role.id]);
                    return [];
                }
                expect(text).toMatch(/SELECT\s+timezone\('UTC',\s*clock_timestamp\(\)\)\s+AS\s+"now"/);
                expect(values).toEqual([]); return [{ now: clock() }];
            }),
            tenant: { findUnique: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ id: ids.tenantId }); return structuredClone(live.tenant);
            }) },
            user: {
                findFirst: vi.fn(async ({ where }: any) => {
                    expect(where).toMatchObject({ id: ids.userId, tenantId: ids.tenantId, deletedAt: null, suspendedAt: null });
                    const user = current().user;
                    return user && user.id === where.id && user.tenantId === where.tenantId && !user.deletedAt && !user.suspendedAt ? structuredClone(user) : null;
                }),
                update: vi.fn(async ({ where, data }: any) => {
                    expect(where).toEqual({ id: ids.userId }); await effect('enable', state => Object.assign(state.user, data)); return structuredClone(current().user);
                }),
            },
            session: { findFirst: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ id: ids.sessionId, userId: ids.userId }); const session = current().session;
                return session?.id === where.id && session.userId === where.userId ? structuredClone(session) : null;
            }) },
            tenantSetting: { findUnique: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ tenantId_key: { tenantId: ids.tenantId, key: 'workspace_settings' } });
                return { value: { security: structuredClone(live.security) } };
            }) },
            roleAssignment: { findMany: vi.fn(async ({ where }: any) => {
                expect(where).toMatchObject({ tenantId: ids.tenantId, userId: ids.userId });
                return live.assigned && !live.role.deletedAt ? [{ userId: ids.userId, roleId: live.role.id, role: structuredClone(live.role) }] : [];
            }) },
            role: { findMany: vi.fn(async ({ where }: any) => {
                expect(where.tenantId).toBe(ids.tenantId);
                expect(where.id.in).toEqual(live.assigned ? [live.role.id] : []);
                return live.assigned && !live.role.deletedAt ? [structuredClone(live.role)] : [];
            }) },
            mfaTotpClaim: { create: vi.fn(async ({ data }: any) => {
                expect(data).toMatchObject({ tenantId: ids.tenantId, userId: ids.userId });
                if (current().claims.includes(data.timeStep)) throw { code: 'P2002' };
                await effect('proof', state => state.claims.push(data.timeStep)); return { id: 'synthetic-proof' };
            }) },
            auditLog: { create: vi.fn(async ({ data }: any) => {
                expect(data).toMatchObject({ tenantId: ids.tenantId, userId: ids.userId, actorUserId: ids.userId,
                    actorTenantId: ids.tenantId, resourceId: ids.userId, action: 'MFA_ENABLED' });
                await effect('audit', state => state.audits.push(structuredClone(data))); return {};
            }) },
        };
        try {
            const result = await operation(tx);
            if (localEffects.length && conflictCount > 0) { conflictCount--; onConflict?.(); throw { code: 'P2034' }; }
            if (failAt === 'commit' && localEffects.length) throw new Error('controlled commit failure');
            if (draft) Object.assign(live, draft);
            committed.push(...localEffects); return result;
        } finally { active--; }
    } };
    const db = new TenantPrismaService(client);
    const jwt = { generateAccessToken: vi.fn(() => 'synthetic-enrollment-token') };
    const encryption: Record<string, string> = { MFA_SECRET_ENCRYPTION_KEY: 'synthetic-durable-enrollment-key' };
    const service = new AuthService({ get: (key: string, fallback: unknown) => encryption[key] ?? fallback } as never,
        jwt as never, new RbacService(db), db);
    let generated = 0;
    vi.spyOn(service as any, 'generateBase32Secret').mockImplementation(() => generated++ === 0 ? firstSecret : secondSecret);
    // The actual owner hashes these synthetic backup values and validates real
    // encrypted TOTP. The deterministic codes make snapshot checks inexpensive.
    vi.spyOn(service as any, 'generateBackupCodes').mockReturnValue(['BACKUP-DURABLE-A', 'BACKUP-DURABLE-B']);
    const redis: any = { status: 'ready',
        get: vi.fn(async (key: string) => { redisCalls.push({ method: 'get', key, active }); return firstSecret; }),
        set: vi.fn(async (key: string, ...args: unknown[]) => { redisCalls.push({ method: 'set', key, args, active }); if (failAt === 'marker') throw new Error('controlled marker failure'); return 'OK'; }),
        del: vi.fn(async (key: string) => { redisCalls.push({ method: 'del', key, active }); return 1; }),
    };
    (service as any).redis = redis;
    const claims = { tenantId: ids.tenantId, sessionId: ids.sessionId };
    const code = (secret = firstSecret) => (service as any).generateTotpCode((service as any).secretToBuffer(secret), Math.floor(Date.now() / 30_000));
    const seed = (secret = firstSecret) => {
        live.session.mfaEnrollmentSecret = (service as any).encryptMfaSecret(secret);
        live.session.mfaEnrollmentExpiresAt = new Date(Date.now() + 600_000);
    };
    return { live, attempts, committed, locks, redisCalls, transactionOptions, jwt, service, seed, code, encryption,
        begin: () => service.beginMfaEnrollment(ids.userId, claims),
        confirm: (value = code()) => service.confirmMfaEnrollment(ids.userId, value, claims),
        pause: (name: string) => { pauseAt = name; }, entered, release,
        fail: (name: string) => { failAt = name; }, zeroCas: () => { casZero = true; },
        conflict: (count: number, change?: () => void) => { conflictCount = count; onConflict = change; },
        advanceDatabase: (milliseconds: number) => { databaseOffset += milliseconds; },
        clearLedger: () => { attempts.length = 0; committed.length = 0; redisCalls.length = 0; locks.length = 0; transactionOptions.length = 0; },
        removeEncryptionKey: () => { for (const key of Object.keys(encryption)) delete encryption[key]; },
    };
}

// SQL adapters below are intentionally closed; unknown statements fail rather
// than supply permissive rows. Exact owner SQL seams are filled from the source.
async function sessionStatement(text: string, values: unknown[], current: () => any,
    effect: (name: string, change: (state: any) => void) => Promise<void>, wait: (name: string) => Promise<void>, zero: () => boolean,
    clock: () => Date): Promise<any[]> {
    expect(text).toContain('timezone(\'UTC\', clock_timestamp())');
    expect(text).toContain('"revokedAt" IS NULL'); expect(text).toContain('RETURNING "id"');
    const row = current().session;
    if (text.includes('"mfaEnrollmentSecret" = NULL')) {
        expect(values).toEqual([ids.sessionId, ids.userId, row.mfaEnrollmentSecret, row.mfaEnrollmentExpiresAt.toISOString()]);
        expect(text).toContain('::timestamptz AT TIME ZONE \'UTC\'');
        expect(text).toContain('"mfaEnrollmentSecret" ='); expect(text).toContain('"mfaEnrollmentExpiresAt" =');
        await wait('consume:before');
        if (zero() || !row || row.id !== values[0] || row.userId !== values[1] || row.revokedAt
            || row.mfaEnrollmentExpiresAt <= clock() || row.expiresAt <= clock()) return [];
        await effect('consume', state => { state.session.mfaEnrollmentSecret = null; state.session.mfaEnrollmentExpiresAt = null; });
        return [{ id: ids.sessionId }];
    }
    expect(values).toEqual([expect.stringMatching(/^enc:v[12]:/), 600, ids.sessionId, ids.userId]);
    expect(text).toContain("interval '1 second'");
    await wait('begin:before');
    if (zero() || !row || row.id !== values[2] || row.userId !== values[3] || row.revokedAt || row.expiresAt <= clock()) return [];
    const expiresAt = new Date(clock().getTime() + 600_000);
    await effect('begin', state => { state.session.mfaEnrollmentSecret = values[0]; state.session.mfaEnrollmentExpiresAt = expiresAt; });
    return [{ id: ids.sessionId, mfaEnrollmentExpiresAt: expiresAt }];
}

type Fixture = ReturnType<typeof fixture>;
async function during(h: Fixture, operation: () => Promise<unknown>, change: () => void) {
    const settled = operation().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
        expect(await Promise.race([h.entered.promise.then(() => 'entered'), settled.then(() => 'settled')])).toBe('entered');
        change(); h.release.release(); return await settled;
    } finally { h.release.release(); await settled; }
}
function noPendingRedis(h: Fixture) {
    expect(h.redisCalls.filter(call => call.key.startsWith('mfa_enrollment:'))).toEqual([]);
    expect(h.redisCalls.every(call => call.active === 0)).toBe(true);
}
function rolledBack(h: Fixture, before: any, prefix: string[]) {
    expect(h.attempts).toEqual(prefix); expect(h.committed).toEqual([]);
    expect(h.live).toEqual(before); expect(h.redisCalls).toEqual([]);
}

describe('durable MFA enrollment on the exact live Session', () => {
    it('begins with encrypted durable material and a fresh SQL-clock lifetime', async () => {
        const h = fixture(); const started = await h.begin();
        expect(started).toMatchObject({ secret: firstSecret, expiresInSeconds: 600 });
        expect(started.otpauthUrl).toContain(firstSecret);
        expect(h.live.session.mfaEnrollmentSecret).toMatch(/^enc:v1:/);
        expect(h.live.session.mfaEnrollmentSecret).not.toContain(firstSecret);
        expect((h.service as any).decryptMfaSecret(h.live.session.mfaEnrollmentSecret)).toBe(firstSecret);
        expect(h.live.session.mfaEnrollmentExpiresAt).toEqual(new Date(Date.now() + 600_000));
        expect(h.attempts).toEqual(['begin']); expect(h.committed).toEqual(['begin']);
        expect(h.locks.slice(0, 3)).toEqual(['Tenant', 'User', 'Session']);
        expect(h.transactionOptions).toEqual([{ isolationLevel: 'ReadCommitted' }]);
        expect(h.jwt.generateAccessToken).not.toHaveBeenCalled(); noPendingRedis(h); expect(h.redisCalls).toEqual([]);
    });
    it('issues the full lifetime after a delayed current RolePermission lock', async () => {
        const h = fixture(); h.pause('lock:RolePermission');
        const result = await during(h, h.begin, () => { vi.setSystemTime(Date.now() + 60_000); });
        expect(result.error).toBeUndefined(); expect(result.value).toMatchObject({ expiresInSeconds: 600 });
        expect(h.live.session.mfaEnrollmentExpiresAt).toEqual(new Date(Date.now() + 600_000)); noPendingRedis(h);
    });
    it('confirms the durable generation and commits proof, consumption, enable and audit once', async () => {
        const h = fixture(); h.seed(); const result = await h.confirm();
        expect(result).toMatchObject({ success: true, mfaVerified: true, accessToken: 'synthetic-enrollment-token',
            backupCodes: ['BACKUP-DURABLE-A', 'BACKUP-DURABLE-B'] });
        expect(h.attempts).toEqual(['proof', 'consume', 'enable', 'audit']); expect(h.committed).toEqual(h.attempts);
        expect(h.live.session.mfaEnrollmentSecret).toBeNull(); expect(h.live.session.mfaEnrollmentExpiresAt).toBeNull();
        expect(h.live.user.mfaEnabled).toBe(true);
        expect((h.service as any).decryptMfaSecret(h.live.user.mfaSecret)).toBe(firstSecret);
        expect(h.live.user.mfaBackupCodes).toHaveLength(2); expect(h.live.user.mfaBackupCodes).not.toContain('BACKUP-DURABLE-A');
        expect(h.live.claims).toEqual([BigInt(Math.floor(Date.now() / 30_000))]); expect(h.live.audits).toHaveLength(1);
        expect(h.redisCalls).toEqual([{ method: 'set', key: `session_mfa:${ids.sessionId}`, args: ['1', 'EX', 3600], active: 0 }]);
        expect(h.transactionOptions).toEqual([{ isolationLevel: 'ReadCommitted' }]); noPendingRedis(h);
    });
    it('a new begin supersedes the old durable generation without enabling MFA', async () => {
        const h = fixture(); await h.begin(); const old = h.live.session.mfaEnrollmentSecret;
        const next = await h.begin(); expect(next.secret).toBe(secondSecret); expect(h.live.session.mfaEnrollmentSecret).not.toBe(old);
        expect(h.code(firstSecret)).not.toBe(h.code(secondSecret));
        expect(h.live.user.mfaEnabled).toBe(false); h.clearLedger();
        await expect(h.confirm(h.code(firstSecret))).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); noPendingRedis(h);
        const result = await h.confirm(h.code(secondSecret)); expect(result.success).toBe(true);
        expect((h.service as any).decryptMfaSecret(h.live.user.mfaSecret)).toBe(secondSecret);
    });
    it('a replay after success returns no new codes, token, proof or marker', async () => {
        const h = fixture(); h.seed(); await h.confirm(); h.clearLedger(); h.jwt.generateAccessToken.mockClear();
        const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(BadRequestException);
        rolledBack(h, before, []); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
    });
    it('missing durable authority is refused even when legacy Redis supplies a valid secret', async () => {
        const h = fixture(); const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(BadRequestException); rolledBack(h, before, []);
    });
    it('begin fails closed without configured encryption even in development', async () => {
        const h = fixture(); h.removeEncryptionKey(); const before = structuredClone(h.live);
        await expect(h.begin()).rejects.toBeInstanceOf(ServiceUnavailableException); rolledBack(h, before, []);
    });
    it('previous-key-only decrypt succeeds but absence of a current write key rolls back confirmation', async () => {
        const h = fixture(); h.removeEncryptionKey(); const key = Buffer.alloc(32, 7).toString('base64');
        h.encryption.MFA_SECRET_ENCRYPTION_KEY_CURRENT = key; h.seed();
        delete h.encryption.MFA_SECRET_ENCRYPTION_KEY_CURRENT; h.encryption.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS = key;
        const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(ServiceUnavailableException);
        rolledBack(h, before, ['proof', 'consume']);
    });
    it('current and previous managed keys confirm the old envelope and write using the current key', async () => {
        const h = fixture(); h.removeEncryptionKey(); const oldKey = Buffer.alloc(32, 7).toString('base64');
        h.encryption.MFA_SECRET_ENCRYPTION_KEY_CURRENT = oldKey; h.seed(); const oldEnvelope = h.live.session.mfaEnrollmentSecret;
        h.encryption.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS = oldKey;
        h.encryption.MFA_SECRET_ENCRYPTION_KEY_CURRENT = Buffer.alloc(32, 8).toString('base64');
        const result = await h.confirm(); expect(result.success).toBe(true);
        expect(h.live.user.mfaSecret).toMatch(/^enc:v2:/); expect(h.live.user.mfaSecret.split(':')[2]).not.toBe(oldEnvelope.split(':')[2]);
        expect((h.service as any).decryptMfaSecret(h.live.user.mfaSecret)).toBe(firstSecret); noPendingRedis(h);
    });
    it('an unreadable key envelope never consumes proof or pending authority', async () => {
        const h = fixture(); h.seed(); h.removeEncryptionKey(); const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(BadRequestException); rolledBack(h, before, []);
    });
    for (const [label, alter] of [
        ['plaintext', (h: Fixture) => { h.live.session.mfaEnrollmentSecret = firstSecret; }],
        ['invalid authentication tag', (h: Fixture) => { h.live.session.mfaEnrollmentSecret = 'enc:v1:a:b:c'; }],
        ['encrypted wrong format secret', (h: Fixture) => { h.live.session.mfaEnrollmentSecret = (h.service as any).encryptMfaSecret('not-base32'); }],
        ['secret without deadline', (h: Fixture) => { h.live.session.mfaEnrollmentExpiresAt = null; }],
        ['deadline without secret', (h: Fixture) => { h.live.session.mfaEnrollmentSecret = null; }],
        ['invalid deadline', (h: Fixture) => { h.live.session.mfaEnrollmentExpiresAt = new Date(NaN); }],
        ['expired deadline', (h: Fixture) => { h.live.session.mfaEnrollmentExpiresAt = new Date(Date.now()); }],
    ] as const) {
        it(`refuses ${label} durable pending material without effects`, async () => {
            const h = fixture(); h.seed(); alter(h); const before = structuredClone(h.live);
            await expect(h.confirm()).rejects.toBeInstanceOf(BadRequestException); rolledBack(h, before, []);
        });
    }
    it('wrong proof retains the pending generation without durable effects', async () => {
        const h = fixture(); h.seed(); const before = structuredClone(h.live);
        await expect(h.confirm('not-a-code')).rejects.toBeInstanceOf(ForbiddenException); rolledBack(h, before, []);
    });
    it('an already claimed TOTP step cannot consume enrollment', async () => {
        const h = fixture(); h.seed(); h.live.claims.push(BigInt(Math.floor(Date.now() / 30_000))); const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(ForbiddenException); rolledBack(h, before, []);
    });
    it('zero-row exact generation consumption rolls back the staged proof', async () => {
        const h = fixture(); h.seed(); h.zeroCas(); const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(BadRequestException); rolledBack(h, before, ['proof']);
    });
    it('zero-row begin returns no challenge and commits no authority', async () => {
        const h = fixture(); h.zeroCas(); const before = structuredClone(h.live);
        await expect(h.begin()).rejects.toBeInstanceOf(UnauthorizedException); rolledBack(h, before, []);
    });
    it('confirmation reads the generation committed while it waits behind the Tenant fence', async () => {
        const h = fixture(); h.seed(); const staleCode = h.code(firstSecret); h.pause('lock:Tenant'); let before: any;
        const result = await during(h, () => h.confirm(staleCode), () => { h.seed(secondSecret); before = structuredClone(h.live); });
        expect(result.error).toBeInstanceOf(ForbiddenException); rolledBack(h, before, []);
    });
    it('SQL consumption expiry while the statement waits rolls back its earlier proof', async () => {
        const h = fixture(); h.seed(); h.live.session.mfaEnrollmentExpiresAt = new Date(Date.now() + 1000);
        const before = structuredClone(h.live); h.pause('consume:before');
        const result = await during(h, h.confirm, () => { h.advanceDatabase(1001); });
        expect(result.error).toBeInstanceOf(BadRequestException); rolledBack(h, before, ['proof']);
    });
    it('begin rolls back its durable write if its new challenge expires while the statement completes', async () => {
        const h = fixture(); const before = structuredClone(h.live); h.pause('begin');
        const result = await during(h, h.begin, () => { h.advanceDatabase(600_001); });
        expect(result.error).toBeInstanceOf(BadRequestException); rolledBack(h, before, ['begin']);
    });

    const invalidations: Array<[string, (h: Fixture) => void, any]> = [
        ['missing Tenant', h => { h.live.tenant = null; }, UnauthorizedException],
        ['suspended Tenant', h => { h.live.tenant.status = 'SUSPENDED'; }, UnauthorizedException],
        ['purged Tenant', h => { h.live.tenant.status = 'PURGED'; }, UnauthorizedException],
        ['deleted Tenant', h => { h.live.tenant.deletedAt = new Date(); }, UnauthorizedException],
        ['suspended user', h => { h.live.user.suspendedAt = new Date(); }, ForbiddenException],
        ['deleted user', h => { h.live.user.deletedAt = new Date(); }, ForbiddenException],
        ['user moved away from claimed Tenant', h => { h.live.user.tenantId = 'foreign-tenant'; }, ForbiddenException],
        ['foreign Session owner', h => { h.live.session.userId = 'foreign-user'; }, ForbiddenException],
        ['foreign Session id', h => { h.live.session.id = 'foreign-session'; }, ForbiddenException],
        ['revoked Session', h => { h.live.session.revokedAt = new Date(); }, ForbiddenException],
        ['stored Session expiry', h => { h.live.session.expiresAt = new Date(Date.now()); }, ForbiddenException],
        ['policy-shortened Session', h => { h.live.session.createdAt = new Date(Date.now() - 600_000); h.live.security.sessionTimeoutMinutes = 5; }, UnauthorizedException],
        ['forced PIN rotation', h => { h.live.user.pinResetRequired = true; }, ForbiddenException],
        ['current role removed', h => { h.live.assigned = false; }, UnauthorizedException],
        ['current account lock', h => { h.live.user.lockedUntil = new Date(Date.now() + 60_000); }, ForbiddenException],
    ];
    for (const action of ['begin', 'confirm'] as const) for (const [label, change, ErrorType] of invalidations) {
        it(`${action} refreshes ${label} after the Tenant lock wait`, async () => {
            const h = fixture(); if (action === 'confirm') h.seed(); h.pause('lock:Tenant');
            let before: any;
            const result = await during(h, h[action], () => { change(h); before = structuredClone(h.live); });
            expect(result.error).toBeInstanceOf(ErrorType); rolledBack(h, before, []);
        });
    }
    for (const action of ['begin', 'confirm'] as const) {
        it(`${action} retains recovery eligibility with no PIN-login grant on an assigned role`, async () => {
            const h = fixture(); h.live.role.rolePermissions = []; h.live.security.requireMfaForAll = true;
            if (action === 'confirm') h.seed(); const result = await h[action](); expect(result).toBeDefined(); expect(h.committed.length).toBeGreaterThan(0); noPendingRedis(h);
        });
    }
    for (const [stage, prefix] of [
        ['lock:RolePermission', []], ['pending', []], ['proof', ['proof']], ['consume', ['proof', 'consume']],
        ['enable', ['proof', 'consume', 'enable']], ['audit', ['proof', 'consume', 'enable', 'audit']],
    ] as Array<[string, string[]]>) {
        for (const deadline of ['enrollment', 'stored Session', 'effective Session'] as const) {
            it(`rolls back ${deadline} expiry after ${stage} completion using the SQL clock`, async () => {
                const h = fixture(); h.seed();
                if (deadline === 'enrollment') h.live.session.mfaEnrollmentExpiresAt = new Date(Date.now() + 1000);
                if (deadline === 'stored Session') h.live.session.expiresAt = new Date(Date.now() + 1000);
                if (deadline === 'effective Session') {
                    // Five minutes is the smallest accepted policy. Four have
                    // elapsed; its deadline is one minute away while the stored
                    // Session and enrollment deadlines remain in the future.
                    h.live.session.createdAt = new Date(Date.now() - 4 * 60_000);
                    h.live.security.sessionTimeoutMinutes = 5;
                }
                const before = structuredClone(h.live); h.pause(stage);
                const result = await during(h, h.confirm, () => { h.advanceDatabase(deadline === 'effective Session' ? 60_001 : 1001); });
                expect(result.error).toBeInstanceOf(deadline === 'enrollment' ? BadRequestException : UnauthorizedException);
                rolledBack(h, before, prefix); expect(h.jwt.generateAccessToken).not.toHaveBeenCalled();
            });
        }
    }
    for (const stage of ['proof', 'consume', 'enable', 'audit']) {
        it(`refuses a proof window that lapses during ${stage} completion`, async () => {
            const h = fixture(); h.seed(); const before = structuredClone(h.live); h.pause(stage);
            const result = await during(h, h.confirm, () => { vi.setSystemTime(Date.now() + 120_000); });
            expect(result.error).toBeInstanceOf(ForbiddenException);
            const prefix = stage === 'proof' ? ['proof'] : stage === 'consume' ? ['proof', 'consume']
                : stage === 'enable' ? ['proof', 'consume', 'enable'] : ['proof', 'consume', 'enable', 'audit'];
            rolledBack(h, before, prefix);
        });
    }
    for (const [stage, prefix] of [['lock:RolePermission', []], ['begin', ['begin']]] as Array<[string, string[]]>) {
        it(`begin refuses SQL-clock Session expiry after ${stage}`, async () => {
            const h = fixture(); h.live.session.expiresAt = new Date(Date.now() + 1000); h.pause(stage); const before = structuredClone(h.live);
            const result = await during(h, h.begin, () => { h.advanceDatabase(1001); });
            expect(result.error).toBeInstanceOf(UnauthorizedException); rolledBack(h, before, prefix);
        });
    }
    for (const [stage, prefix] of [['proof', ['proof']], ['consume', ['proof', 'consume']],
        ['enable', ['proof', 'consume', 'enable']], ['audit', ['proof', 'consume', 'enable', 'audit']],
        ['commit', ['proof', 'consume', 'enable', 'audit']]] as Array<[string, string[]]>) {
        it(`a controlled ${stage} failure leaves the challenge and all durable effects unchanged`, async () => {
            const h = fixture(); h.seed(); h.fail(stage); const before = structuredClone(h.live);
            await expect(h.confirm()).rejects.toThrow(`controlled ${stage} failure`); rolledBack(h, before, prefix);
        });
    }
    it('retry rereads a superseding generation rather than enabling from the first draft', async () => {
        const h = fixture(); h.seed(); h.conflict(1, () => { h.seed(secondSecret); });
        await expect(h.confirm(h.code(firstSecret))).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.attempts).toEqual(['proof', 'consume', 'enable', 'audit']); expect(h.committed).toEqual([]);
        expect(h.live.user.mfaEnabled).toBe(false); expect(h.live.claims).toEqual([]); expect(h.live.audits).toEqual([]);
        expect((h.service as any).decryptMfaSecret(h.live.session.mfaEnrollmentSecret)).toBe(secondSecret); expect(h.redisCalls).toEqual([]);
    });
    it('retry rereads a Session revocation committed after a conflict', async () => {
        const h = fixture(); h.seed(); h.conflict(1, () => { h.live.session.revokedAt = new Date(); });
        await expect(h.confirm()).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.committed).toEqual([]); expect(h.live.user.mfaEnabled).toBe(false); expect(h.redisCalls).toEqual([]);
    });
    it('a retry with unchanged authority commits one proof, audit and marker', async () => {
        const h = fixture(); h.seed(); h.conflict(1); const result = await h.confirm(); expect(result.success).toBe(true);
        expect(h.attempts).toEqual(['proof', 'consume', 'enable', 'audit', 'proof', 'consume', 'enable', 'audit']);
        expect(h.committed).toEqual(['proof', 'consume', 'enable', 'audit']); expect(h.live.claims).toHaveLength(1); expect(h.live.audits).toHaveLength(1);
        expect(h.redisCalls).toHaveLength(1); noPendingRedis(h);
    });
    it('exhausted bounded conflicts return no success and publish no effects', async () => {
        const h = fixture(); h.seed(); h.conflict(2); const before = structuredClone(h.live);
        await expect(h.confirm()).rejects.toBeInstanceOf(ConflictException);
        rolledBack(h, before, ['proof', 'consume', 'enable', 'audit', 'proof', 'consume', 'enable', 'audit']);
    });
    it('postcommit marker loss cannot recreate or retry durable authority', async () => {
        const h = fixture(); h.seed(); h.fail('marker'); const result = await h.confirm(); expect(result.success).toBe(true);
        expect(h.committed).toEqual(['proof', 'consume', 'enable', 'audit']); expect(h.redisCalls).toHaveLength(1); noPendingRedis(h);
        expect(h.live.session.mfaEnrollmentSecret).toBeNull(); h.clearLedger();
        await expect(h.confirm()).rejects.toBeInstanceOf(BadRequestException); expect(h.attempts).toEqual([]); expect(h.redisCalls).toEqual([]);
    });
});
