import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roleOwnerAuthorityFixture } from './role-owner-authority.fixture';

const owners = ['create', 'update', 'delete', 'legacy', 'roleIds'] as const;
type Owner = typeof owners[number];
const modes = ['stored Session', 'effective policy', 'MFA wall', 'MFA monotonic'] as const;
type Mode = typeof modes[number];
const prefix = (rows: Array<{ table: string; method: string }>) => rows.map(({ table, method }) => ({ table, method }));
function fixture(owner: Owner, roleId = 'custom-reader') {
    const h = roleOwnerAuthorityFixture();
    const options = { actorUserId: h.actor.userId, actorSessionId: h.actor.sessionId,
        ipAddress: h.actor.ipAddress, userAgent: h.actor.userAgent, mfaObserver: h.observer };
    const input = { name: 'Reader', description: 'Read-only staff access', permissionKeys: ['users:read'] };
    const request = { ...options, targetUserId: 'user-1', requiredPermission: 'roles:assign' as const,
        selfMutationMessage: 'Use another administrator for your own role', auditAction: owner === 'legacy' ? 'USER_ROLE_UPDATED' as const : 'USER_ACCESS_UPDATED' as const,
        ...(owner === 'legacy' ? { legacyRole: 'STAFF' as const } : { roleIds: ['custom-reader'] }) };
    const call = () => {
        switch (owner) {
            case 'create': return h.rbac.createRole(h.actor.tenantId, input, options);
            case 'update': return h.rbac.updateRole(h.actor.tenantId, roleId, input, options);
            case 'delete': return h.rbac.deleteRole(h.actor.tenantId, roleId, options);
            case 'legacy': case 'roleIds': return h.rbac.replaceUserRolesAsActor(h.actor.tenantId, request);
        }
    };
    return { ...h, get state() { return h.state; }, options, input, request, call, owner };
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Role fixture timed out: ' + label)), milliseconds);
    })]); } finally { if (timer) clearTimeout(timer); }
}
async function atStage(h: ReturnType<typeof fixture>, stage: typeof h.controls.stage,
    change: () => void | Promise<void>, operation: () => Promise<unknown> = h.call) {
    h.controls.stage = stage;
    const result = operation().then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error }));
    try {
        expect(await bounded(Promise.race([h.entered.then(() => 'entered'), result.then(() => 'settled')]), 'arrival')).toBe('entered');
        expect(h.controls.transactions).toBe(stage === 'observer' ? 1 : 2);
        expect(h.controls.active).toBe(stage === 'observer' ? 0 : 1);
        await change(); h.release(); return await bounded(result, 'result');
    } finally { h.release(); await bounded(result, 'drain'); }
}
function isolated(h: ReturnType<typeof fixture>, mode: Mode): () => Promise<void> {
    let jump = 1001;
    if (mode === 'stored Session') h.state.sessions[0].expiresAt = new Date(Date.now() + 1000);
    if (mode === 'effective policy') { h.state.security.sessionTimeoutMinutes = 5;
        h.state.sessions[0].createdAt = new Date(Date.now() - 4 * 60_000); jump = 60_000; }
    if (mode === 'MFA wall') h.controls.observerTtl = 1000;
    if (mode === 'MFA monotonic') h.controls.monotonicTtl = 1000;
    return async () => {
        if (mode === 'MFA monotonic') {
            const epoch = Date.now(); await new Promise<void>(resolve => setTimeout(resolve, 1150));
            expect(Date.now()).toBe(epoch); // Stored/effective/wall deadlines stay current.
        } else vi.setSystemTime(Date.now() + jump);
    };
}
function rolledBack(h: ReturnType<typeof fixture>, result: { error: unknown }, snapshot: ReturnType<typeof h.snapshot>, expected: ReturnType<typeof prefix>) {
    expect(result.error).toBeInstanceOf(ForbiddenException); expect(prefix(h.attempts)).toEqual(expected);
    expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot); expect(h.controls.active).toBe(0);
}
function finalConflicts(h: ReturnType<typeof fixture>, count: number, afterRelease?: () => void | Promise<void>) {
    const transaction = h.prisma.$transaction;
    h.prisma.$transaction = vi.fn(async (operation: (tx: any) => Promise<unknown>, options: any) => {
        const finalAttempt = h.controls.transactions >= 1, conflict = { code: 'P2034' };
        try {
            return await transaction(async (tx: any) => {
                const result = await operation(tx);
                if (finalAttempt && count-- > 0) throw conflict;
                return result;
            }, options);
        } catch (error) {
            if (error === conflict) { expect(h.controls.active).toBe(0); await afterRelease?.(); }
            throw error;
        }
    });
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T09:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('real role owner current authority, full delegation and write lifetime', () => {
    for (const owner of owners) {
        it(owner + ' has actual owner effects and one current observation without seeding', async () => {
            const h = fixture(owner), result = await h.call();
            expect(h.controls.transactions).toBe(2); expect(h.controls.active).toBe(0);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
            expect(h.committed.length).toBeGreaterThan(0); expect(prefix(h.attempts)).toEqual(prefix(h.committed));
            expect(h.state.audits).toHaveLength(1);
            expect(h.state.audits[0]).toMatchObject({ tenantId: h.actor.tenantId, userId: h.actor.userId,
                actorUserId: h.actor.userId, actorTenantId: h.actor.tenantId });
            if (owner === 'create') {
                expect(prefix(h.committed)).toEqual([{ table: 'role', method: 'create' }, { table: 'auditLog', method: 'create' }]);
                expect(result).toMatchObject({ id: 'created-custom-role', name: 'Reader', isSystem: false });
            } else if (owner === 'update') {
                expect(prefix(h.committed)).toEqual([{ table: 'rolePermission', method: 'deleteMany' },
                    { table: 'role', method: 'update' }, { table: 'auditLog', method: 'create' }]);
                expect(h.state.roles.find(row => row.id === 'custom-reader')).toMatchObject({ name: 'Reader' });
            } else if (owner === 'delete') {
                expect(result).toBe(true); expect(h.state.roles.find(row => row.id === 'custom-reader')?.deletedAt).toBeInstanceOf(Date);
            } else {
                expect(h.state.audits[0].action).toBe(owner === 'legacy' ? 'USER_ROLE_UPDATED' : 'USER_ACCESS_UPDATED');
                const id = owner === 'legacy' ? 'target-staff-role' : 'custom-reader';
                expect(result).toMatchObject({ changed: true, sessionsRevoked: 1, legacyRole: 'STAFF',
                    assignedRoles: [expect.objectContaining({ id })] });
                expect(h.state.assignments.filter(row => row.userId === 'user-1')).toEqual([{ tenantId: h.actor.tenantId, userId: 'user-1', roleId: id }]);
                expect(h.state.users[1].role).toBe('STAFF'); expect(h.state.sessions[1].revokedAt).toBeInstanceOf(Date);
                expect(h.state.sessions[0].revokedAt).toBeNull();
            }
        });
        it.each(['Tenant', 'actor', 'grant', 'Session', 'PIN', 'policy'] as const)(owner + ' rereads %s after released observer', async field => {
            const h = fixture(owner); let snapshot!: ReturnType<typeof h.snapshot>;
            const result = await atStage(h, 'observer', () => {
                if (field === 'Tenant') h.state.tenants[0].status = 'SUSPENDED';
                if (field === 'actor') h.state.users[0].suspendedAt = new Date();
                if (field === 'grant') h.state.roles[0].rolePermissions = h.state.roles[0].rolePermissions.filter((row: any) =>
                    row.permission.key !== (owner === 'legacy' || owner === 'roleIds' ? 'roles:assign' : 'roles:write'));
                if (field === 'Session') h.state.sessions[0].revokedAt = new Date();
                if (field === 'PIN') h.state.users[0].pinResetRequired = true;
                if (field === 'policy') { h.state.security.sessionTimeoutMinutes = 5;
                    h.state.sessions[0].createdAt = new Date(Date.now() - 6 * 60_000); }
                snapshot = h.snapshot();
            });
            rolledBack(h, result, snapshot, []);
        });
        it.each(modes)(owner + ' refuses independent %s expiry at exact final RolePermission wait ordinal2', async mode => {
            const h = fixture(owner), change = isolated(h, mode), snapshot = h.snapshot();
            const result = await atStage(h, 'finalRole', change);
            expect(h.controls.finalRoleVisits).toBe(1); rolledBack(h, result, snapshot, []);
        });
        it.each(modes)(owner + ' refuses independent %s expiry across its final domain read before first effect', async mode => {
            const h = fixture(owner), change = isolated(h, mode), snapshot = h.snapshot();
            rolledBack(h, await atStage(h, 'domain', change), snapshot, []);
        });
        it.each(modes)(owner + ' rolls back every reached effect prefix on independent %s expiry', async mode => {
            const positive = fixture(owner); await positive.call(); const ledger = prefix(positive.committed);
            expect(ledger.length).toBeGreaterThan(0);
            for (let index = 1; index <= ledger.length; index++) {
                const h = fixture(owner), change = isolated(h, mode), snapshot = h.snapshot(); h.controls.stageIndex = index;
                const result = await atStage(h, 'effect', change); rolledBack(h, result, snapshot, ledger.slice(0, index));
            }
        }, 15_000);
        it(owner + ' retries discarded final conflict with one finite observation and fresh authorization', async () => {
            const h = fixture(owner); finalConflicts(h, 1); await h.call();
            expect(h.controls.transactions).toBe(3); expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
            expect(prefix(h.attempts)).toEqual([...prefix(h.committed), ...prefix(h.committed)]);
            expect(h.state.audits).toHaveLength(1);
        });
        it.each(['grant', 'policy'] as const)(owner + ' refreshes %s after released conflict before retry effects', async field => {
            const h = fixture(owner); let snapshot!: ReturnType<typeof h.snapshot>;
            finalConflicts(h, 1, () => {
                if (field === 'grant') h.state.roles[0].rolePermissions = [];
                else { h.state.security.sessionTimeoutMinutes = 5; h.state.sessions[0].createdAt = new Date(Date.now() - 6 * 60_000); }
                snapshot = h.snapshot();
            });
            await expect(h.call()).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.controls.transactions).toBe(3); expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
            expect(h.attempts.length).toBeGreaterThan(0); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
        });
        it(owner + ' bounds two final conflicts without effects committing', async () => {
            const h = fixture(owner), snapshot = h.snapshot(); finalConflicts(h, 2);
            await expect(h.call()).rejects.toBeInstanceOf(ConflictException);
            expect(h.controls.transactions).toBe(3); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
            expect(h.observer.observeSessionMfa).toHaveBeenCalledOnce();
        });
    }
    for (const owner of ['update', 'delete'] as const) {
        it(owner + ' has a missing-role readonly noop with no audit or seeding', async () => {
            const h = fixture(owner, 'missing-role'), snapshot = h.snapshot();
            expect(await h.call()).toBe(owner === 'update' ? null : false);
            expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
        });
        it.each(modes)(owner + ' readonly noop still refuses %s expiry before final callback returns', async mode => {
            const h = fixture(owner, 'missing-role'), change = isolated(h, mode), snapshot = h.snapshot();
            rolledBack(h, await atStage(h, 'response', change), snapshot, []);
        });
        it(owner + ' rejects existing system role with zero effects', async () => {
            const h = fixture(owner, 'actor-role'); await expect(h.call()).rejects.toThrow('System roles'); expect(h.attempts).toEqual([]);
        });
    }
    for (const owner of ['legacy', 'roleIds'] as const) {
        it(owner + ' preserves unchanged replacement audit/assignment effects without revoking sessions', async () => {
            const make = () => { const h = fixture(owner); h.state.users[1].role = 'STAFF';
                h.state.assignments[1].roleId = owner === 'legacy' ? 'target-staff-role' : 'custom-reader'; return h; };
            const control = make(); expect(await control.call()).toMatchObject({ changed: false, sessionsRevoked: 0 });
            expect(prefix(control.committed)).toEqual([{ table: 'roleAssignment', method: 'deleteMany' },
                { table: 'roleAssignment', method: 'createMany' }, { table: 'auditLog', method: 'create' }]);
            expect(control.state.audits[0].action).toBe(owner === 'legacy' ? 'USER_ROLE_UPDATED' : 'USER_ACCESS_UPDATED');
            expect(control.state.sessions[1].revokedAt).toBeNull();
            for (const mode of modes) { const h = make(), change = isolated(h, mode), snapshot = h.snapshot(); h.controls.stageIndex = 3;
                rolledBack(h, await atStage(h, 'effect', change), snapshot, prefix(control.committed)); }
        }, 15_000);
        it(owner + ' rejects self and equal current target hierarchy without effects', async () => {
            const h = fixture(owner); h.request.targetUserId = h.actor.userId;
            await expect(h.call()).rejects.toThrow('your own role'); expect(h.controls.transactions).toBe(0);
            const equal = fixture(owner); equal.state.users[1].role = 'ADMIN'; equal.state.assignments[1].roleId = 'actor-role';
            await expect(equal.call()).rejects.toThrow('equal or greater access'); expect(equal.attempts).toEqual([]);
        });
    }
    it.each(['create', 'update'] as const)('%s preserves held-grant subset and protected permission rejection', async owner => {
        const subset = fixture(owner); subset.input.permissionKeys = ['auth:login_email'];
        subset.state.permissions.push({ id: 'permission-auth:login_email', key: 'auth:login_email' });
        await expect(subset.call()).rejects.toThrow('permissions you do not currently hold'); expect(subset.attempts).toEqual([]);
        const protectedRole = fixture(owner); protectedRole.input.permissionKeys = ['admin_portal:access'];
        protectedRole.state.roles[0].rolePermissions.push({ permission: { key: 'admin_portal:access' } });
        await expect(protectedRole.call()).rejects.toThrow('protected admin permissions'); expect(protectedRole.attempts).toEqual([]);
    });
    it('legacy and roleIds replacement preserve protected delegation and foreign-role rejection', async () => {
        const protectedRole = fixture('roleIds'); protectedRole.state.roles[3].rolePermissions = [{ permission: { key: 'admin_portal:access' } }];
        await expect(protectedRole.call()).rejects.toThrow('Only system admins'); expect(protectedRole.attempts).toEqual([]);
        const elevated = fixture('legacy');
        elevated.state.roles[0].rolePermissions.push({ permission: { key: 'admin_portal:access' } });
        elevated.state.roles.push({ ...structuredClone(elevated.state.roles[0]), id: 'selected-super-role',
            legacyRole: 'SUPER_ADMIN', slug: 'super-admin', rolePermissions: [{ permission: { key: 'admin_portal:access' } }] });
        await expect(elevated.rbac.replaceUserRolesAsActor(elevated.actor.tenantId,
            { ...elevated.request, legacyRole: 'SUPER_ADMIN' as const })).rejects.toThrow('Only system admins');
        expect(elevated.attempts).toEqual([]);
        const foreign = fixture('roleIds'); foreign.state.roles[3].tenantId = 'foreign-tenant';
        await expect(foreign.call()).rejects.toBeInstanceOf(BadRequestException); expect(foreign.attempts).toEqual([]);
    });
    it('delete preserves assigned-role exclusion and create preserves configured custom-role bound', async () => {
        const assigned = fixture('delete'); assigned.state.assignments[1].roleId = 'custom-reader';
        await expect(assigned.call()).rejects.toBeInstanceOf(ConflictException); expect(assigned.attempts).toEqual([]);
        const full = fixture('create'); const custom = full.state.roles[3];
        for (let n = 0; n < 99; n++) full.state.roles.push({ ...structuredClone(custom), id: 'extra-role-' + n });
        await expect(full.call()).rejects.toThrow('at most 100'); expect(full.attempts).toEqual([]);
    });
    it('role read owners never seed missing access or mutate permission catalog', async () => {
        const h = fixture('create'); h.state.assignments = []; const snapshot = h.snapshot();
        await expect(h.rbac.getEffectiveAccess(h.actor.userId, h.actor.tenantId)).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(h.rbac.getUserRoleAssignments(h.actor.userId, h.actor.tenantId)).resolves.toEqual([]);
        expect((await h.rbac.listRolesForTenant(h.actor.tenantId)).length).toBe(4);
        expect((await h.rbac.listPermissions()).length).toBe(h.state.permissions.length);
        expect(h.attempts).toEqual([]); expect(h.committed).toEqual([]); expect(h.snapshot()).toEqual(snapshot);
    });
});
