import { describe, expect, it, vi } from 'vitest';
import { TenantProvisioningService } from './tenant-provisioning.service';

const input = {
    name: 'Acme Dining',
    slug: 'acme-dining',
    planTier: 'STARTER' as const,
    status: 'TRIAL' as const,
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    usageCredits: 0,
    ownerName: 'Alex Owner',
    ownerEmail: 'owner@example.com',
    auditActor: {
        actorUserId: 'platform-admin-1',
        actorTenantId: 'platform-tenant',
        ipAddress: '203.0.113.20',
        userAgent: 'vitest-platform-admin',
    },
};

describe('TenantProvisioningService', () => {
    it('creates the tenant, owner, default roles, assignment, and audit in one transaction', async () => {
        let transactionActive = false;
        const tx = {
            tenant: { create: vi.fn().mockResolvedValue({ id: 'tenant-1', slug: 'acme-dining' }) },
            user: { create: vi.fn().mockResolvedValue({ id: 'owner-1' }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        const tenantDb = {
            withPlatformAdmin: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => {
                transactionActive = true;
                try {
                    return await operation(tx);
                } finally {
                    transactionActive = false;
                }
            }),
        };
        const rbacService = {
            provisionLegacySystemRole: vi.fn(async (transaction: unknown) => {
                expect(transaction).toBe(tx);
                expect(transactionActive).toBe(true);
            }),
        };
        const service = new TenantProvisioningService(tenantDb as any, rbacService as any);

        await expect(service.createPlatformTenant(input)).resolves.toEqual({
            id: 'tenant-1',
            ownerId: 'owner-1',
            planTier: 'STARTER',
            status: 'TRIAL',
            trialEndsAt: input.trialEndsAt,
        });

        expect(tx.tenant.create).toHaveBeenCalledWith({
            data: {
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'STARTER',
                status: 'TRIAL',
                trialEndsAt: input.trialEndsAt,
                usageCredits: 0,
            },
        });

        expect(tx.user.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                email: 'owner@example.com',
                name: 'Alex Owner',
                role: 'ADMIN',
            },
        });
        expect(rbacService.provisionLegacySystemRole).toHaveBeenCalledWith(
            tx,
            'owner-1',
            'tenant-1',
            'ADMIN',
        );
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: null,
                actorUserId: 'platform-admin-1',
                actorTenantId: 'platform-tenant',
                ipAddress: '203.0.113.20',
                userAgent: 'vitest-platform-admin',
                action: 'TENANT_CREATED',
                resource: 'Tenant',
                resourceId: 'tenant-1',
            },
        });
    });

    it('rejects nonzero initial credits before opening a transaction', async () => {
        const tenantDb = { withPlatformAdmin: vi.fn() };
        const service = new TenantProvisioningService(tenantDb as any, {} as any);

        await expect(service.createPlatformTenant({
            ...input,
            usageCredits: 25,
        })).rejects.toThrow(/start with zero credits/i);

        expect(tenantDb.withPlatformAdmin).not.toHaveBeenCalled();
    });
    it('rejects paid ACTIVE creation before opening a transaction', async () => {
        const tenantDb = { withPlatformAdmin: vi.fn() };
        const service = new TenantProvisioningService(tenantDb as any, {} as any);

        await expect(service.createPlatformTenant({
            ...input,
            status: 'ACTIVE',
            trialEndsAt: null,
        })).rejects.toThrow(/cannot be created ACTIVE/i);

        expect(tenantDb.withPlatformAdmin).not.toHaveBeenCalled();
    });

    it('rejects a trial without a concrete future end before opening a transaction', async () => {
        const tenantDb = { withPlatformAdmin: vi.fn() };
        const service = new TenantProvisioningService(tenantDb as any, {} as any);

        await expect(service.createPlatformTenant({
            ...input,
            trialEndsAt: null,
        })).rejects.toThrow(/future trialEndsAt/i);

        expect(tenantDb.withPlatformAdmin).not.toHaveBeenCalled();
    });

    it('rolls back tenant and owner staging when default-role provisioning fails', async () => {
        const committed = { tenants: [] as string[], users: [] as string[] };
        const tenantDb = {
            withPlatformAdmin: vi.fn(async (operation: (transaction: any) => Promise<unknown>) => {
                const staged = { tenants: [] as string[], users: [] as string[] };
                const tx = {
                    tenant: {
                        create: vi.fn(async () => {
                            staged.tenants.push('tenant-1');
                            return { id: 'tenant-1', slug: 'acme-dining' };
                        }),
                    },
                    user: {
                        create: vi.fn(async () => {
                            staged.users.push('owner-1');
                            return { id: 'owner-1' };
                        }),
                    },
                    auditLog: { create: vi.fn() },
                };
                const result = await operation(tx);
                committed.tenants.push(...staged.tenants);
                committed.users.push(...staged.users);
                return result;
            }),
        };
        const rbacService = {
            provisionLegacySystemRole: vi.fn().mockRejectedValue(new Error('default role provisioning failed')),
        };
        const service = new TenantProvisioningService(tenantDb as any, rbacService as any);

        await expect(service.createPlatformTenant(input)).rejects.toThrow('default role provisioning failed');

        expect(committed).toEqual({ tenants: [], users: [] });
    });
});
