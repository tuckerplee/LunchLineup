import { describe, expect, it, vi } from 'vitest';
import { createPlatformArchiveActorFixture } from './platform-archive-actor.fixture';

// Actual fixture setup/probe/cleanup code over isolated transaction seams.
// No PostgreSQL, network, permission-catalog mutation or native claim.
function seedHarness(mode: 'rollback' | 'commit-loss' | 'mismatch' | 'partial' | 'probe-failure' | 'cleanup-failure' | 'absence-failure' | 'cleanup-and-disconnect-failure' | 'success',
    faults: { cleanup?: unknown; disconnect?: unknown } = {}) {
    type Rows = { tenant: any; user: any; session: any; role: any; assignments: any[]; grants: any[] };
    let state: Rows = { tenant: null, user: null, session: null, role: null, assignments: [], grants: [] };
    let draft: Rows | undefined, ordinal = 0;
    const ids: Partial<Record<'tenant' | 'user' | 'session' | 'role', string>> = {};
    const seedError = new Error('controlled seed acknowledgement loss'), probeError = new Error('controlled probe failure');
    const cleanupError = 'cleanup' in faults ? faults.cleanup : new Error('controlled cleanup failure');
    const disconnectError = 'disconnect' in faults ? faults.disconnect : new Error('controlled disconnect failure');
    const writes: Array<{ method: string; args: any }> = [], contexts: number[] = [];
    const read = () => draft ?? state, copy = <T,>(value: T): T => structuredClone(value);
    const write = (method: string, args: any) => { writes.push({ method, args: copy(args) }); return read(); };
    const owner: any = {
        $transaction: vi.fn(async (operation: (tx: any) => Promise<any>) => {
            ordinal++;
            if (ordinal === 2 && mode === 'probe-failure') throw probeError;
            if (ordinal === (mode === 'success' ? 2 : 3) && ('cleanup' in faults || ['cleanup-failure', 'cleanup-and-disconnect-failure'].includes(mode))) throw cleanupError;
            draft = copy(state);
            try {
                const result = await operation(owner);
                if (ordinal === 1 && mode === 'rollback') throw seedError;
                state = draft;
                if (ordinal === 1 && mode !== 'success') {
                    if (mode === 'mismatch') state.user.tenantId = 'unrelated-tenant';
                    if (mode === 'partial') state.session = null;
                    throw seedError;
                }
                return result;
            } finally { draft = undefined; }
        }),
        $executeRaw: vi.fn(async (query: TemplateStringsArray, capability: string) => {
            expect(query.join('?')).toBe('SELECT set_current_platform_admin(true, ?)');
            expect(capability).toBe('isolated-fixture-capability'); contexts.push(ordinal); return 1;
        }),
        $disconnect: vi.fn(async () => { if ('disconnect' in faults || mode === 'cleanup-and-disconnect-failure') throw disconnectError; }),
        permission: { findUnique: vi.fn(async (args: any) => {
            expect(args).toEqual({ where: { key: 'admin_portal:access' }, select: { id: true } }); return { id: 'shared-permission' };
        }) },
    };
    for (const table of ['tenant', 'user', 'session', 'role'] as const) {
        owner[table] = {
            create: vi.fn(async ({ data }: any) => {
                ids[table] = data.id; write(table + '.create', data)[table] = copy(data);
                if (table === 'role') read().grants.push({ roleId: data.id, permissionId: data.rolePermissions.create.permissionId });
                return copy(data);
            }),
            findUnique: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ id: ids[table] });
                const row = read()[table]; return row ? copy(row) : null;
            }),
            delete: vi.fn(async (args: any) => {
                const row = read()[table]; expect(args).toEqual({ where: { id: row.id } });
                write(table + '.delete', args)[table] = null; return row;
            }),
            count: vi.fn(async ({ where }: any) => {
                expect(where).toEqual({ id: ids[table] });
                if (ordinal === 4 && mode === 'absence-failure' && table === 'tenant') return 1;
                return read()[table]?.id === where.id ? 1 : 0;
            }),
        };
    }
    owner.tenant.update = vi.fn(async (args: any) => {
        expect(args.where).toEqual({ id: read().tenant.id }); expect(args.data.status).toBe('PURGED');
        Object.assign(write('tenant.update', args).tenant, copy(args.data)); return copy(read().tenant);
    });
    owner.roleAssignment = {
        create: vi.fn(async ({ data }: any) => { write('assignment.create', data).assignments.push(copy(data)); return copy(data); }),
        findMany: vi.fn(async ({ where }: any) => {
            expect(where).toEqual({ OR: [{ tenantId: ids.tenant }, { userId: ids.user }, { roleId: ids.role }] });
            return copy(read().assignments);
        }),
        deleteMany: vi.fn(async (args: any) => {
            expect(args).toEqual({ where: read().assignments[0] }); write('assignment.deleteMany', args).assignments = []; return { count: 1 };
        }),
        count: vi.fn(async ({ where }: any) => {
            expect(where).toEqual({ tenantId: ids.tenant, userId: ids.user });
            return read().assignments.filter(row => row.tenantId === where.tenantId && row.userId === where.userId).length;
        }),
    };
    owner.rolePermission = {
        findMany: vi.fn(async ({ where }: any) => { expect(where).toEqual({ roleId: ids.role }); return copy(read().grants); }),
        deleteMany: vi.fn(async (args: any) => {
            expect(args).toEqual({ where: { roleId: read().role.id } }); write('grant.deleteMany', args).grants = []; return { count: 1 };
        }),
        count: vi.fn(async ({ where }: any) => { expect(where).toEqual({ roleId: ids.role }); return read().grants.filter(row => row.roleId === where.roleId).length; }),
    };
    const factory = vi.fn(() => owner);
    return { owner, factory, seedError, probeError, cleanupError, disconnectError, writes, contexts,
        snapshot: () => copy(state), start: () => createPlatformArchiveActorFixture('isolated-no-network', 'isolated-fixture-capability', factory) };
}
const deletes = (h: ReturnType<typeof seedHarness>) => h.writes.filter(row => /\.delete/.test(row.method));
function retainedOriginal(error: unknown, h: ReturnType<typeof seedHarness>) {
    expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).cause).toBe(h.seedError);
    expect((error as AggregateError).errors[0]).toBe(h.seedError);
    expect((error as Error).message).toBe('Owned archive authority setup failed; exact-owned cleanup could not be verified');
    expect(h.factory).toHaveBeenCalledOnce(); expect(h.owner.permission.findUnique).toHaveBeenCalledOnce();
    expect(h.owner.$disconnect).toHaveBeenCalledOnce();
}
describe('Owned platform archive actor fixture uncertain seed cleanup', () => {
    it('rethrows acknowledged seed rollback after proving all exact-owned row sets absent without deletes', async () => {
        const h = seedHarness('rollback');
        await expect(h.start()).rejects.toBe(h.seedError);
        expect(h.snapshot()).toEqual({ tenant: null, user: null, session: null, role: null, assignments: [], grants: [] });
        expect(h.owner.$transaction).toHaveBeenCalledTimes(2); expect(h.contexts).toEqual([1, 2]); expect(deletes(h)).toEqual([]);
        expect(h.owner.$disconnect).toHaveBeenCalledOnce(); expect(h.owner.permission.findUnique).toHaveBeenCalledOnce();
    });
    it('reconciles lost seed commit acknowledgement using exact owned cleanup and independent absence readback', async () => {
        const h = seedHarness('commit-loss');
        await expect(h.start()).rejects.toBe(h.seedError);
        expect(h.owner.$transaction).toHaveBeenCalledTimes(4); expect(h.contexts).toEqual([1, 2, 3, 4]);
        expect(deletes(h).map(row => row.method)).toEqual(['assignment.deleteMany', 'grant.deleteMany', 'role.delete', 'session.delete', 'user.delete', 'tenant.delete']);
        expect(h.snapshot()).toEqual({ tenant: null, user: null, session: null, role: null, assignments: [], grants: [] });
        for (const table of ['tenant', 'user', 'session', 'role', 'roleAssignment', 'rolePermission']) expect(h.owner[table].count).toHaveBeenCalledOnce();
        expect(h.owner.permission.findUnique).toHaveBeenCalledOnce(); expect(h.owner.$disconnect).toHaveBeenCalledOnce();
    });
    for (const state of ['mismatch', 'partial'] as const) {
        it(`refuses cleanup of ${state} seed rows while retaining original failure and residual detail`, async () => {
            const h = seedHarness(state); const error = await h.start().catch(error => error);
            retainedOriginal(error, h); expect(error.errors[1].message).toContain('partial or mismatched rows');
            expect(h.owner.$transaction).toHaveBeenCalledTimes(2); expect(deletes(h)).toEqual([]); expect(h.snapshot().tenant).not.toBeNull();
        });
    }
    it('retains seed and fresh probe errors and disconnects without blind cleanup or reseeding', async () => {
        const h = seedHarness('probe-failure'); const error = await h.start().catch(error => error);
        retainedOriginal(error, h); expect(error.errors).toEqual([h.seedError, h.probeError]);
        expect(h.owner.$transaction).toHaveBeenCalledTimes(2); expect(deletes(h)).toEqual([]); expect(h.snapshot().tenant).not.toBeNull();
    });
    it('retains seed and exact cleanup failure without retrying destructive cleanup', async () => {
        const h = seedHarness('cleanup-failure'); const error = await h.start().catch(error => error);
        retainedOriginal(error, h); expect(error.errors).toEqual([h.seedError, h.cleanupError]);
        expect(h.owner.$transaction).toHaveBeenCalledTimes(3); expect(deletes(h)).toEqual([]); expect(h.snapshot().tenant).not.toBeNull();
    });
    it('preserves original failure when the independent absence verification cannot confirm cleanup', async () => {
        const h = seedHarness('absence-failure'); const error = await h.start().catch(error => error);
        retainedOriginal(error, h); expect(error.errors[1].message).toBe('Owned archive authority rows remain after cleanup');
        expect(h.owner.$transaction).toHaveBeenCalledTimes(4); expect(deletes(h)).toHaveLength(6);
    });
    it('preserves seed, cleanup and disconnect failures together without a second attempt', async () => {
        const h = seedHarness('cleanup-and-disconnect-failure'); const error = await h.start().catch(error => error);
        retainedOriginal(error, h); expect(error.errors[1]).toBeInstanceOf(AggregateError);
        expect(error.errors[1].cause).toBe(h.cleanupError); expect(error.errors[1].errors).toEqual([h.cleanupError, h.disconnectError]);
        expect(h.owner.$transaction).toHaveBeenCalledTimes(3); expect(deletes(h)).toEqual([]);
    });
    it('rethrows falsey cleanup or disconnect failures and preserves a falsey first cause when disconnect also fails', async () => {
        for (const fault of [undefined, null, false, 0, '']) {
            const cleanup = seedHarness('success', { cleanup: fault });
            const owned = await cleanup.start();
            await expect(owned.close()).rejects.toBe(fault);
            expect(cleanup.owner.$disconnect).toHaveBeenCalledOnce(); expect(cleanup.owner.$transaction).toHaveBeenCalledTimes(2);
            expect(deletes(cleanup)).toEqual([]); expect(cleanup.snapshot().tenant).not.toBeNull();

            const disconnected = seedHarness('success', { disconnect: fault });
            const disconnectOwned = await disconnected.start();
            await expect(disconnectOwned.close()).rejects.toBe(fault);
            expect(disconnected.owner.$disconnect).toHaveBeenCalledOnce(); expect(disconnected.owner.$transaction).toHaveBeenCalledTimes(3);
            expect(deletes(disconnected)).toHaveLength(6); expect(disconnected.snapshot().tenant).toBeNull();

            const second = new Error('controlled second disconnect failure');
            const combined = seedHarness('success', { cleanup: fault, disconnect: second });
            const combinedOwned = await combined.start(); const error = await combinedOwned.close().catch(error => error);
            expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(fault); expect(error.errors).toEqual([fault, second]);
            expect(combined.owner.$disconnect).toHaveBeenCalledOnce(); expect(combined.owner.$transaction).toHaveBeenCalledTimes(2);
            expect(deletes(combined)).toEqual([]); expect(combined.snapshot().tenant).not.toBeNull();
        }
    });
});
