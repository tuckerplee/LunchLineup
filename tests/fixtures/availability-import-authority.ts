import { performance } from 'node:perf_hooks';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import { createDecipheriv, createHash } from 'node:crypto';
import { expect, vi, type Mock } from 'vitest';
import { AuthService } from '../../apps/api/src/auth/auth.service';
import { RbacService } from '../../apps/api/src/auth/rbac.service';
import { TenantPrismaService } from '../../apps/api/src/database/tenant-prisma.service';
import { AvailabilityImportsController } from '../../apps/api/src/availability-imports/availability-imports.controller';
import { AvailabilityImportsService, availabilityImportAccountIdentityHash,
    availabilityImportDocumentIdentityHash, availabilityImportSourceAad } from '../../apps/api/src/availability-imports/availability-imports.service';
import { MFA_MARKER_TTL_SCRIPT } from '@lunchlineup/rbac';

// Actual owners/current-authority helpers over a closed staged row model and
// memory upload/Redis boundaries. No SQL locks, MVCC/RLS, Redis atomicity,
// RabbitMQ, worker, HTTP guard or filesystem durability is qualified here.
export const importIds = { tenant: 'import-tenant', actor: 'import-actor', session: 'import-session',
    target: 'import-target', role: 'import-role', job: 'import-existing' };
export type ImportMode = 'new' | 'replay' | 'cancel' | 'terminal';
export type ImportLifetime = 'stored' | 'policy' | 'mfa-wall' | 'mfa-monotonic';
export type ImportGate = 'file' | 'entitlement' | 'job-created' | 'debit' | 'job-updated'
    | 'job-read' | 'refund' | 'job-cancelled' | 'audit' | 'replay-read' | 'result-ledger';
type Row = Record<string, any>;
const NOW = Date.parse('2026-10-05T22:00:00Z');
function copy<T>(v: T): T {
    if (Buffer.isBuffer(v)) return Buffer.from(v) as T;
    if (v instanceof Date) return new Date(v.getTime()) as T;
    if (Array.isArray(v)) return v.map(item => copy(item)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)])) as T;
    return v;
}
const key = Buffer.alloc(32, 0x71);
const pdf = Buffer.from('%PDF-1.7\ncontrolled availability');
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
export async function importBounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof realTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = realTimeout(() => reject(new Error('Controlled import gate did not settle')), 2000);
    })]); } finally { if (timer) realClearTimeout(timer); }
}
const flatten = (values: unknown[]): unknown[] => values.flatMap(v => v && typeof v === 'object' && 'values' in v
    ? flatten((v as { values: unknown[] }).values) : [v]);
const parts = (sql: any, args: unknown[]) => ({ text: (Array.isArray(sql) ? sql : sql.strings).join(' ').replace(/\s+/g, ' ').trim(),
    values: flatten(Array.isArray(sql) ? args : sql.values) });
function match(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, v]) => {
        if (k === 'tenantId_requestKeyHash' || k === 'tenantId_key') return match(row, v as Row);
        if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
            return Object.entries(v).every(([op, value]) => {
                if (op === 'in') return (value as unknown[]).includes(row[k]);
                if (op === 'gte') return row[k] >= (value as number);
                throw new Error(`Unsupported import selector ${k}.${op}`);
            });
        }
        return row[k] === v;
    });
}

export function availabilityAuthorityFixture(mode: ImportMode = 'new', lifetime: ImportLifetime = 'stored') {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    vi.stubEnv('AVAILABILITY_IMPORT_ENCRYPTION_KEY', key.toString('base64'));
    let monotonic = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const i = importIds;
    const savedJob: Row = { id: i.job, tenantId: i.tenant, userId: i.target, requestedByUserId: i.actor,
        requestKeyHash: createHash('sha256').update(`${i.tenant}:import-key`).digest('hex'),
        requestHash: availabilityImportDocumentIdentityHash('employee-1'),
        targetIdentityHash: availabilityImportAccountIdentityHash({ id: i.target, username: 'target' }),
        fileSha256: createHash('sha256').update(pdf).digest('hex'), fileSize: pdf.length,
        status: mode === 'terminal' ? 'CANCELLED' : 'PENDING', parsedAvailability: null, failureCode: null,
        resultErasedAt: mode === 'terminal' ? new Date(NOW) : null, storageKey: null,
        encryptedSourcePayload: null, creditConsumption: { consumedCredits: 1 },
        createdAt: new Date(NOW - 1000), completedAt: mode === 'terminal' ? new Date(NOW) : null };
    let state: Record<string, Row[]> = {
        tenant: [{ id: i.tenant, status: 'ACTIVE', deletedAt: null, usageCredits: mode === 'new' ? 10 : 9, creditDebt: 0 }],
        user: [{ id: i.actor, tenantId: i.tenant, role: 'ADMIN', username: 'actor', deletedAt: null, suspendedAt: null,
            lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: true },
            { id: i.target, tenantId: i.tenant, role: 'STAFF', username: 'target', deletedAt: null, suspendedAt: null }],
        session: [{ id: i.session, userId: i.actor, createdAt: new Date(NOW - (lifetime === 'policy' ? 240_000 : 0)),
            expiresAt: new Date(NOW + (lifetime === 'stored' ? 1000 : 3_600_000)), revokedAt: null }],
        role: [{ id: i.role, tenantId: i.tenant, legacyRole: null, isSystem: false, deletedAt: null,
            rolePermissions: [{ roleId: i.role, permissionId: 'import-permission', permission: { key: 'users:write' } }] }],
        roleAssignment: [{ tenantId: i.tenant, userId: i.actor, roleId: i.role }],
        tenantSetting: [{ tenantId: i.tenant, key: 'workspace_settings', value: { security: {
            sessionTimeoutMinutes: lifetime === 'policy' ? 5 : 480, requireMfaForAll: false } } }],
        availabilityImportJob: mode === 'new' ? [] : [savedJob],
        creditTransaction: mode === 'new' ? [] : [{ id: `feature-usage-availability-import:${i.job}`, tenantId: i.tenant,
            amount: -1, debtAmount: 0, balanceAfter: 9, debtAfter: 0 }], auditLog: [],
    };
    if (mode === 'terminal') state.creditTransaction.push({ id: `feature-refund-availability-import:${i.job}`,
        tenantId: i.tenant, amount: 1, debtAmount: 0, balanceAfter: 10, debtAfter: 0 });
    const files = new Map<string, Buffer>(), attempted: string[] = [], committed: string[] = [], locks: Row[] = [];
    const reads: string[] = [], reached: ImportGate[] = [];
    let active = false, ordinal = 0, draft: typeof state | undefined;
    let entryPause = false, pausedEntry = false, boundary: ImportGate | undefined, boundaryUsed = false;
    let race = false, raceFailureUsed = false, afterRace: (() => void) | undefined;
    let serializeConflict = false, serializeConflictUsed = false, afterConflict: (() => void) | undefined;
    let marker: unknown = lifetime.startsWith('mfa') ? 1000 : 3_600_000;
    let redisReady = true, redisThrows = false, publishingReady = true, collide = false;
    const arrived = gate(), released = gate();
    const view = () => draft ?? state;
    async function pause(name: ImportGate) {
        reached.push(name);
        if (boundary === name && !boundaryUsed) { boundaryUsed = true; arrived.release(); await released.promise; }
    }
    const get = (table: string, where: Row) => {
        if (!(table in view())) throw new Error(`Unknown import table ${table}`);
        return view()[table].filter(row => match(row, where));
    };
    const effect = async (name: string, apply: () => any, at: ImportGate) => {
        expect(active).toBe(true); attempted.push(name); const value = apply(); await pause(at); return copy(value);
    };
    function client(): any {
        const tx: any = {
            $executeRaw: async (sql: any, ...args: unknown[]) => {
                const q = parts(sql, args); expect(q.text).toBe('SELECT set_current_tenant( )');
                expect(q.values).toEqual([i.tenant]);
                if (entryPause && !pausedEntry) { pausedEntry = true; arrived.release(); await released.promise; draft = copy(state); }
                return 1;
            },
            $queryRaw: async (sql: any, ...args: unknown[]) => {
                const q = parts(sql, args);
                if (q.text.includes('public.settle_positive_credit_value')) {
                    expect(q.values[0]).toBe(i.tenant); expect(q.values[1]).toBe(1);
                    expect(q.values[2]).toBe(`Availability PDF import refund (${i.job})`);
                    expect(q.values[3]).toBe(`feature-refund-availability-import:${i.job}`);
                    return effect('refund', () => { const wallet = view().tenant[0]; const repaid = Math.min(wallet.creditDebt, 1); wallet.usageCredits += 1 - repaid; wallet.creditDebt -= repaid;
                        view().creditTransaction.push({ id: q.values[3], tenantId: i.tenant, amount: 1 - repaid, debtAmount: -repaid,
                            balanceAfter: wallet.usageCredits, debtAfter: wallet.creditDebt });
                        return [{ creditedValue: 1, replayed: false }]; }, 'refund');
                }
                const table = /FROM "(Tenant|User|Session|RoleAssignment|RolePermission|Role|AvailabilityImportJob)"/.exec(q.text)?.[1];
                if (!table) throw new Error(`Unsupported import SQL ${q.text}`);
                expect(q.text).toContain('FOR UPDATE'); locks.push({ table, values: copy(q.values), ordinal });
                if (table === 'Tenant') { expect(q.values).toEqual([i.tenant]); return copy(view().tenant); }
                if (table === 'Session') { expect(q.values).toEqual([i.session, i.actor]); return copy(get('session', { id: i.session, userId: i.actor })); }
                if (table === 'AvailabilityImportJob') { expect(q.values).toEqual([i.job, i.tenant]); return copy(get('availabilityImportJob', { id: i.job, tenantId: i.tenant })); }
                if (table === 'User') {
                    expect(q.values[0]).toBe(i.tenant); const ids = q.values.slice(1);
                    expect(ids).toEqual([...new Set(ids)].sort()); expect(ids.every(id => id === i.actor || id === i.target)).toBe(true);
                    return copy(get('user', { tenantId: i.tenant, id: { in: ids }, deletedAt: null }));
                }
                if (table === 'RoleAssignment') { expect(q.values).toEqual([i.tenant, i.actor]); return copy(get('roleAssignment', { tenantId: i.tenant, userId: i.actor })); }
                if (table === 'Role') { expect(q.values).toEqual([i.tenant, i.role]); return copy(get('role', { id: i.role, tenantId: i.tenant })); }
                expect(q.values).toEqual([i.role]); return copy(view().role.flatMap(r => r.rolePermissions));
            },
        };
        for (const table of Object.keys(state)) tx[table] = {
            findFirst: async ({ where }: Row) => { reads.push(`${table}.findFirst`);
                let selected = where;
                if (table === 'user' && where.role?.in) selected = { ...where, role: { in: where.role.in } };
                const result = copy(get(table, selected)[0] ?? null);
                if (table === 'availabilityImportJob') await pause('job-read'); return result; },
            findUnique: async ({ where }: Row) => { reads.push(`${table}.findUnique`); const row = copy(get(table, where)[0] ?? null);
                if (table === 'availabilityImportJob') await pause('replay-read'); return row; },
            findMany: async ({ where }: Row) => {
                reads.push(`${table}.findMany`);
                if (table === 'roleAssignment' && where.role) {
                    const { role, ...selected } = where;
                    return copy(get(table, selected).flatMap(a => { const r = view().role.find(r => r.id === a.roleId);
                        return r && match(r, role) ? [{ ...a, role: r }] : []; }));
                }
                const result = copy(get(table, where)); if (table === 'creditTransaction') await pause('result-ledger'); return result;
            },
            create: async ({ data }: Row) => {
                if (table === 'availabilityImportJob' && race && !raceFailureUsed) {
                    raceFailureUsed = true; throw Object.assign(new Error('Controlled unique race'), { code: 'P2002' });
                }
                if (table === 'availabilityImportJob') return effect('job-create', () => {
                    const row = { ...copy(data), status: 'PENDING', parsedAvailability: null, resultErasedAt: null,
                        failureCode: null, createdAt: new Date(NOW), completedAt: null }; view()[table].push(row); return row;
                }, 'job-created');
                if (table === 'auditLog') return effect('audit', () => { view()[table].push(copy(data)); return data; }, 'audit');
                throw new Error(`Unsupported import create ${table}`);
            },
            update: async ({ where, data }: Row) => {
                expect(table).toBe('availabilityImportJob');
                return effect('job-update', () => { const row = get(table, where)[0]; if (!row) throw new Error('Missing import update row');
                    Object.assign(row, copy(data)); return row; }, 'job-updated');
            },
            updateMany: async ({ where, data }: Row) => {
                expect(table).toBe('availabilityImportJob');
                return effect('job-cancel', () => { const rows = get(table, where); for (const row of rows) Object.assign(row, copy(data)); return { count: rows.length }; }, 'job-cancelled');
            },
        };
        return tx;
    }
    const database: any = { $transaction: async (operation: (tx: any) => Promise<any>, options: any) => {
        expect(active).toBe(false); if (options) expect(options).toMatchObject({ isolationLevel: 'Serializable' });
        active = true; ordinal++; draft = copy(state); const start = attempted.length;
        try { const result = await operation(client());
            if (serializeConflict && !serializeConflictUsed && attempted.length > start) {
                serializeConflictUsed = true; throw Object.assign(new Error('Controlled serialization retry'), { code: 'P2034' });
            }
            state = draft!; committed.push(...attempted.slice(start)); return result;
        } catch (error) {
            if (raceFailureUsed && !state.availabilityImportJob.length) {
                state.availabilityImportJob.push(copy(savedJob)); state.tenant[0].usageCredits = 9;
                state.creditTransaction.push({ id: `feature-usage-availability-import:${i.job}`, tenantId: i.tenant,
                    amount: -1, debtAmount: 0, balanceAfter: 9, debtAfter: 0 }); afterRace?.();
            }
            if (serializeConflictUsed && (error as any)?.code === 'P2034') afterConflict?.();
            throw error;
        } finally { active = false; draft = undefined; }
    } };
    const tenantDb = new TenantPrismaService(database), rbac = new RbacService(tenantDb);
    // Invoke the actual Auth method without its Prisma/Redis-creating constructor.
    // Only getRedis is injected; TTL conversion and bound identity are real code.
    const auth = Object.create(AuthService.prototype) as AuthService;
    const evalMarker: Mock<(script: string, n: number, redisKey: string) => Promise<unknown>> = vi.fn(async (script: string, n: number, redisKey: string) => {
        expect(active).toBe(false); expect(script).toBe(MFA_MARKER_TTL_SCRIPT); expect(n).toBe(1);
        expect(redisKey).toBe(`session_mfa:${i.session}`); if (redisThrows) throw new Error('private-redis-error'); return marker;
    });
    Object.defineProperty(auth, 'getRedis', { value: () => ({ status: redisReady ? 'ready' : 'end', eval: evalMarker }) });
    const publisher: { isReady: () => boolean; kick: Mock<() => void> } = { isReady: () => publishingReady, kick: vi.fn() };
    const featureAccess = {
        lockTenantInTransaction: async (tx: any, tenant: string) => { expect(tenant).toBe(i.tenant); await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenant} FOR UPDATE`; },
        assertFeatureEnabledInTransaction: async (_tx: any, tenant: string, feature: string) => {
            expect(tenant).toBe(i.tenant); expect(feature).toBe('scheduling'); await pause('entitlement');
            return { enabled: true, source: 'credits', creditCost: 1 }; },
        recordFeatureUsageInTransaction: async (_tx: any, tenant: string, _resolution: unknown, reason: string,
            operationId: string, transactionId?: string, assertCurrent?: () => void) => {
            expect(tenant).toBe(i.tenant); expect(transactionId).toBeUndefined();
            assertCurrent?.(); const id = `feature-usage-${operationId}`;
            const result = await effect('debit', () => { view().tenant[0].usageCredits--;
                view().creditTransaction.push({ id, tenantId: tenant, amount: -1, debtAmount: 0,
                    balanceAfter: view().tenant[0].usageCredits, debtAfter: 0, reason });
                return { consumedCredits: 1, newBalance: view().tenant[0].usageCredits }; }, 'debit');
            assertCurrent?.(); return result;
        },
    };
    // Original three-argument constructor ignores appended trusted dependencies;
    // exactly the same owner path remains callable in the failing baseline.
    const service = Reflect.construct(AvailabilityImportsService, [tenantDb, featureAccess, publisher, rbac, auth]) as AvailabilityImportsService;
    vi.spyOn(service as any, 'writeExclusive').mockImplementation(async (...args: any[]) => {
        const [path, bytes, created] = args; expect(files.has(path)).toBe(false);
        if (collide) { files.set(path, Buffer.from('preexisting-foreign-source')); throw Object.assign(new Error('Controlled exclusive collision'), { code: 'EEXIST' }); }
        files.set(path, Buffer.from(bytes)); if (typeof created === 'function') created(); await pause('file');
    });
    vi.spyOn(service as any, 'safeUnlink').mockImplementation(async (...args: any[]) => { files.delete(args[0]); });
    const controller = new AvailabilityImportsController(service);
    const request: any = { user: { sub: i.actor, tenantId: i.tenant, sessionId: i.session,
        permissions: ['users:write'], mfaVerified: true }, headers: { 'idempotency-key': 'import-key' } };
    const upload = { buffer: Buffer.from(pdf), size: pdf.length, originalname: 'availability.pdf', mimetype: 'application/pdf' };
    const input = { tenantId: i.tenant, userId: i.target, requestedByUserId: i.actor, requestedBySessionId: i.session,
        idempotencyKey: 'import-key', staffIdentity: 'EMPLOYEE-1', file: upload };
    let direct = false;
    const call = () => direct ? service.createImport(input) : mode === 'new' || mode === 'replay'
        ? controller.create(request, i.target, upload, 'EMPLOYEE-1') : controller.cancel(request, i.job);
    const financial = () => copy({ wallet: state.tenant.map(t => ({ id: t.id, usageCredits: t.usageCredits, creditDebt: t.creditDebt })),
        jobs: state.availabilityImportJob, ledger: state.creditTransaction, audits: state.auditLog });
    function expire() {
        if (lifetime === 'mfa-monotonic') monotonic += 1000;
        else vi.setSystemTime(NOW + (lifetime === 'policy' ? 60_000 : 1000));
    }
    function near() {
        if (lifetime === 'mfa-monotonic') monotonic += 999;
        else vi.setSystemTime(NOW + (lifetime === 'policy' ? 59_999 : 999));
    }
    function decrypt(row: Row) {
        const envelope = row.encryptedSourcePayload as Buffer;
        expect(envelope.subarray(0, 4).toString()).toBe('LLAI'); expect(envelope[4]).toBe(3);
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(5, 17));
        decipher.setAAD(availabilityImportSourceAad({ envelopeVersion: 3, tenantId: row.tenantId, importId: row.id,
            fileSha256: row.fileSha256, requestHash: row.requestHash, targetIdentityHash: row.targetIdentityHash }));
        decipher.setAuthTag(envelope.subarray(17, 33)); return Buffer.concat([decipher.update(envelope.subarray(33)), decipher.final()]);
    }
    return { call, request, input, direct() { direct = true; }, service, publisher, evalMarker, files, attempted, committed, locks, reads, reached, arrived, released,
        get state() { return state; }, get active() { return active; }, get ordinal() { return ordinal; }, financial, expire, near, decrypt,
        pauseAt(at: ImportGate) { boundary = at; }, pauseEntry() { entryPause = true; },
        drain() { publishingReady = false; }, collision() { collide = true; },
        marker(value: unknown) { marker = value; }, redisOffline() { redisReady = false; }, redisFailure() { redisThrows = true; },
        uniqueRace(change?: () => void) { race = true; afterRace = change; },
        serializationRetry(change?: () => void) { serializeConflict = true; afterConflict = change; },
        assertNoFilesOrKick() { expect(files.size).toBe(0); expect(publisher.kick).not.toHaveBeenCalled(); expect(active).toBe(false); },
        assertEncrypted() { const row = state.availabilityImportJob[0]; expect(decrypt(row)).toEqual(pdf);
            expect(row.encryptedSourcePayload.includes(pdf)).toBe(false); expect(files.size).toBe(1);
            expect([...files.values()][0]).toEqual(row.encryptedSourcePayload); },
    };
}
export type AvailabilityAuthorityFixture = ReturnType<typeof availabilityAuthorityFixture>;
