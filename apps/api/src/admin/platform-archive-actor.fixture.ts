import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { MfaSessionObserver } from '@lunchlineup/rbac';
import { PrismaClient } from '@prisma/client';
import type { TenantPlatformArchiveActor } from './tenant-account-lifecycle.service';

// Explicit owned PostgreSQL fixture, never a substitute authorizer. Every row
// belongs to this invocation; the shared permission catalog is only read.
export async function createPlatformArchiveActorFixture(ownerUrl: string, capability: string,
    makeOwner: (url: string) => PrismaClient = url => new PrismaClient({ datasources: { db: { url } } })) {
    const owner = makeOwner(ownerUrl);
    const suffix = randomUUID();
    const tenantId = `archive-authority-${suffix}`, userId = `archive-actor-${suffix}`;
    const sessionId = `archive-session-${suffix}`, roleId = `archive-role-${suffix}`;
    const actor: TenantPlatformArchiveActor = { tenantId, userId, sessionId,
        ipAddress: '203.0.113.20', userAgent: 'vitest-owned-platform-archive' };
    let created = false, closed = false;
    let permissionId: string | undefined;
    async function probeSeedOutcome(): Promise<'absent' | 'complete'> {
        return owner.$transaction(async tx => {
            await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
            const [tenant, user, session, role, assignments, grants] = await Promise.all([
                tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }),
                tx.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true } }),
                tx.session.findUnique({ where: { id: sessionId }, select: { id: true, userId: true } }),
                tx.role.findUnique({ where: { id: roleId }, select: { id: true, tenantId: true } }),
                tx.roleAssignment.findMany({ where: { OR: [{ tenantId }, { userId }, { roleId }] },
                    select: { tenantId: true, userId: true, roleId: true } }),
                tx.rolePermission.findMany({ where: { roleId }, select: { roleId: true, permissionId: true } }),
            ]);
            if (!tenant && !user && !session && !role && assignments.length === 0 && grants.length === 0) return 'absent';
            if (tenant?.id === tenantId && user?.id === userId && user.tenantId === tenantId
                && session?.id === sessionId && session.userId === userId && role?.id === roleId && role.tenantId === tenantId
                && assignments.length === 1 && assignments[0].tenantId === tenantId
                && assignments[0].userId === userId && assignments[0].roleId === roleId
                && permissionId && grants.length === 1 && grants[0].roleId === roleId && grants[0].permissionId === permissionId) return 'complete';
            throw new Error('Owned archive authority seed outcome has partial or mismatched rows; cleanup refused');
        });
    }
    async function close() {
        if (closed) return;
        let failure: unknown;
        let caught = false;
        try {
            if (created) {
                await owner.$transaction(async tx => {
                    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
                    // The actor tenant is distinct from every lifecycle target;
                    // it has no lifecycle intents or target audit rows to erase.
                    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
                    if (!tenant) throw new Error('Owned archive actor tenant disappeared before cleanup');
                    await tx.tenant.update({ where: { id: tenantId }, data: { status: 'PURGED',
                        deletedAt: new Date('2000-01-01T00:00:00.000Z'), applicationDataPurgedAt: new Date('2000-01-01T00:00:00.000Z') } });
                    await tx.roleAssignment.deleteMany({ where: { tenantId, userId, roleId } });
                    await tx.rolePermission.deleteMany({ where: { roleId } });
                    await tx.role.delete({ where: { id: roleId } });
                    await tx.session.delete({ where: { id: sessionId } });
                    await tx.user.delete({ where: { id: userId } });
                    await tx.tenant.delete({ where: { id: tenantId } });
                });
                const remaining = await owner.$transaction(async tx => {
                    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
                    return Promise.all([
                        tx.tenant.count({ where: { id: tenantId } }), tx.user.count({ where: { id: userId } }),
                        tx.session.count({ where: { id: sessionId } }), tx.role.count({ where: { id: roleId } }),
                        tx.roleAssignment.count({ where: { tenantId, userId } }), tx.rolePermission.count({ where: { roleId } }),
                    ]);
                });
                if (remaining.some(count => count !== 0)) throw new Error('Owned archive authority rows remain after cleanup');
                created = false;
            }
        } catch (error) { failure = error; caught = true; }
        finally {
            closed = true;
            try { await owner.$disconnect(); }
            catch (error) { failure = caught ? new AggregateError([failure, error],
                'Owned archive authority cleanup and disconnect failed', { cause: failure }) : error; caught = true; }
        }
        if (caught) throw failure;
    }
    try {
        await owner.$transaction(async tx => {
            await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
            const permission = await tx.permission.findUnique({ where: { key: 'admin_portal:access' }, select: { id: true } });
            if (!permission) throw new Error('Migrated admin_portal permission is required for archive fixture');
            permissionId = permission.id;
            await tx.tenant.create({ data: { id: tenantId, name: 'Owned Archive Authority', slug: tenantId,
                planTier: 'FREE', status: 'ACTIVE', usageCredits: 0 } });
            await tx.user.create({ data: { id: userId, tenantId, name: 'Owned Archive Administrator',
                username: `archive-${suffix}`, role: 'STAFF', mfaEnabled: true, mfaBackupCodes: [] } });
            await tx.session.create({ data: { id: sessionId, userId, selectorHash: `selector-${suffix}`,
                refreshToken: `refresh-${suffix}`, ipAddress: actor.ipAddress!, userAgent: actor.userAgent!,
                expiresAt: new Date(Date.now() + 3_600_000) } });
            await tx.role.create({ data: { id: roleId, tenantId, name: 'Archive Fixture Access', slug: 'archive-fixture-access',
                isSystem: false, rolePermissions: { create: { permissionId: permission.id } } } });
            await tx.roleAssignment.create({ data: { tenantId, userId, roleId } });
        });
        created = true;
        // These existing native cases qualify provider/intent/DB composition,
        // not Redis MFA. Authority DB checks remain real; this explicit seam
        // supplies only a finite identity-bound MFA observation.
        const mfaObserver: MfaSessionObserver = { observeSessionMfa: async identity => {
            if (identity.sub !== userId || identity.tenantId !== tenantId || identity.sessionId !== sessionId) return null;
            return { ...identity, expiresAtEpochMs: Date.now() + 120_000, expiresAtMonotonicMs: performance.now() + 120_000 };
        } };
        return { actor: Object.freeze(actor), mfaObserver, close };
    } catch (error) {
        // A rejected commit acknowledgement is not proof that the seed rolled
        // back. Probe only this invocation's generated IDs and exact links.
        const cleanupErrors: unknown[] = [];
        try {
            const outcome = await probeSeedOutcome();
            if (outcome === 'complete') { created = true; await close(); }
        } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        if (!closed) {
            try { await owner.$disconnect(); } catch (disconnectError) { cleanupErrors.push(disconnectError); }
            finally { closed = true; }
        }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
            'Owned archive authority setup failed; exact-owned cleanup could not be verified', { cause: error });
        throw error;
    }
}
