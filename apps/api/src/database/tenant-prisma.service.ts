import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type TenantPrismaTransaction = Prisma.TransactionClient;
export type TenantPrismaTransactionOptions = {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
};

@Injectable()
export class TenantPrismaService {
    private readonly prisma: PrismaClient;

    constructor(@Optional() prisma?: PrismaClient) {
        this.prisma = prisma ?? new PrismaClient();
    }

    get client(): PrismaClient {
        return this.prisma;
    }

    async withTenant<T>(
        tenantId: string,
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
        options?: TenantPrismaTransactionOptions,
    ): Promise<T> {
        this.assertTenantId(tenantId);
        return this.prisma.$transaction(async (tx) => {
            await this.setTenantContext(tx, tenantId);
            return operation(tx);
        }, options);
    }

    async withPlatformAdmin<T>(
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
        options?: TenantPrismaTransactionOptions,
    ): Promise<T> {
        return this.prisma.$transaction(async (tx) => {
            await this.setPlatformAdminContext(tx);
            return operation(tx);
        }, options);
    }

    private async setTenantContext(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await tx.$queryRaw`SELECT set_current_tenant(${tenantId})`;
    }

    private async setPlatformAdminContext(tx: TenantPrismaTransaction): Promise<void> {
        const capability = String(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET ?? '').trim();
        if (!capability) {
            throw new ServiceUnavailableException('Platform admin database capability is not configured');
        }
        await tx.$queryRaw`SELECT set_current_platform_admin(true, ${capability})`;
    }

    private assertTenantId(tenantId: string): void {
        if (typeof tenantId !== 'string' || !tenantId.trim()) {
            throw new BadRequestException('tenantId is required for tenant-scoped database access');
        }
    }
}
