import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from './tenant-prisma.service';

describe('TenantPrismaService', () => {
    let tx: any;
    let prisma: any;

    beforeEach(() => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'unit-test-platform-admin-capability');
        tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
        };
        prisma = {
            $transaction: vi.fn(async (callback: (txClient: any) => Promise<unknown>) => callback(tx)),
        };
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('sets the RLS tenant context before running tenant work', async () => {
        const service = new TenantPrismaService(prisma);
        const operation = vi.fn().mockResolvedValue('ok');

        const result = await service.withTenant('tenant-1', operation);

        expect(result).toBe('ok');
        expect(prisma.$transaction).toHaveBeenCalledOnce();
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(operation).toHaveBeenCalledWith(tx);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
    });

    it('sets the platform admin context before running cross-tenant work', async () => {
        const service = new TenantPrismaService(prisma);
        const operation = vi.fn().mockResolvedValue('ok');

        const result = await service.withPlatformAdmin(operation);

        expect(result).toBe('ok');
        expect(prisma.$transaction).toHaveBeenCalledOnce();
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(operation).toHaveBeenCalledWith(tx);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
    });

    it('forwards explicit interactive transaction bounds', async () => {
        const service = new TenantPrismaService(prisma);
        const options = { maxWait: 5_000, timeout: 60_000 };

        await service.withPlatformAdmin(vi.fn().mockResolvedValue('ok'), options);

        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), options);
    });

    it('rejects empty tenant ids before opening a transaction', async () => {
        const service = new TenantPrismaService(prisma);

        await expect(service.withTenant('   ', vi.fn())).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
