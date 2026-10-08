import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from './tenant-prisma.service';

describe('TenantPrismaService', () => {
    let tx: any;
    let prisma: any;

    beforeEach(() => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'unit-test-platform-admin-capability');
        tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn(),
        };
        prisma = {
            $transaction: vi.fn(async (callback: (txClient: any) => Promise<unknown>) => callback(tx)),
            $disconnect: vi.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('awaits every registered drain before disconnect and shares its shutdown result', async () => {
        const service = new TenantPrismaService(prisma);
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const drain = vi.fn(() => held);
        service.registerShutdownDrain(drain);
        const closing = service.onModuleDestroy();
        expect(drain).toHaveBeenCalledOnce();
        expect(service.onModuleDestroy()).toBe(closing);
        expect(prisma.$disconnect).not.toHaveBeenCalled();
        expect(() => service.registerShutdownDrain(async () => {})).toThrow('shutdown has started');
        release();
        await closing;
        expect(prisma.$disconnect).toHaveBeenCalledOnce();
        await expect(service.withTenant('tenant-1', vi.fn())).rejects.toThrow('shutting down');
        await expect(service.withPlatformAdmin(vi.fn())).rejects.toThrow('shutting down');
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each(['tenant', 'platform'] as const)('fences a late %s context continuation after disconnect', async (scope) => {
        const service = new TenantPrismaService(prisma);
        let release!: () => void;
        tx.$executeRaw.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
        const operation = vi.fn();
        const pending = scope === 'tenant' ? service.withTenant('tenant-1', operation)
            : service.withPlatformAdmin(operation);
        const rejected = expect(pending).rejects.toThrow('shutting down');
        await service.onModuleDestroy();
        release();
        await rejected;
        expect(operation).not.toHaveBeenCalled();
        expect(prisma.$disconnect).toHaveBeenCalledOnce();
    });

    it('disconnects after a rejected drain and retains the original failure', async () => {
        const service = new TenantPrismaService(prisma);
        const failure = new Error('export drain failed');
        service.registerShutdownDrain(async () => { throw failure; });
        prisma.$disconnect.mockRejectedValueOnce(new Error('disconnect also failed'));
        await expect(service.onModuleDestroy()).rejects.toBe(failure);
        expect(prisma.$disconnect).toHaveBeenCalledOnce();
    });

    it('bounds an unresponsive drain, disconnects, and rejects late database work', async () => {
        vi.useFakeTimers();
        vi.stubEnv('PROCESS_SHUTDOWN_DEADLINE_MS', '5000');
        try {
            const service = new TenantPrismaService(prisma);
            service.registerShutdownDrain(() => new Promise<void>(() => {}));
            const closing = service.onModuleDestroy();
            const rejected = expect(closing).rejects.toThrow('Database shutdown deadline exceeded');
            await vi.advanceTimersByTimeAsync(5000);
            await rejected;
            expect(prisma.$disconnect).toHaveBeenCalledOnce();
            await expect(service.withTenant('tenant-1', vi.fn())).rejects.toThrow('shutting down');
            expect(prisma.$transaction).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('sets the RLS tenant context before running tenant work', async () => {
        const service = new TenantPrismaService(prisma);
        const operation = vi.fn().mockResolvedValue('ok');

        const result = await service.withTenant('tenant-1', operation);

        expect(result).toBe('ok');
        expect(prisma.$transaction).toHaveBeenCalledOnce();
        expect(tx.$executeRaw).toHaveBeenCalledOnce();
        expect(tx.$executeRaw.mock.calls[0]?.[0]).toEqual(['SELECT set_current_tenant(', ')']);
        expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe('tenant-1');
        expect(tx.$queryRaw).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledWith(tx);
        expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
    });

    it('sets the platform admin context before running cross-tenant work', async () => {
        const service = new TenantPrismaService(prisma);
        const operation = vi.fn().mockResolvedValue('ok');

        const result = await service.withPlatformAdmin(operation);

        expect(result).toBe('ok');
        expect(prisma.$transaction).toHaveBeenCalledOnce();
        expect(tx.$executeRaw).toHaveBeenCalledOnce();
        expect(tx.$executeRaw.mock.calls[0]?.[0]).toEqual([
            'SELECT set_current_platform_admin(true, ',
            ')',
        ]);
        expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe('unit-test-platform-admin-capability');
        expect(tx.$queryRaw).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledWith(tx);
        expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
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

    it('disconnects its Prisma client during Nest module shutdown', async () => {
        const service = new TenantPrismaService(prisma);

        await service.onModuleDestroy();

        expect(prisma.$disconnect).toHaveBeenCalledOnce();
    });
});
