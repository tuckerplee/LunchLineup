import {
    BadRequestException,
    Injectable,
    type OnModuleDestroy,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { resolveProcessShutdownDeadlineMs } from '../common/shutdown-deadline';

export type TenantPrismaTransaction = Prisma.TransactionClient;
export type TenantPrismaTransactionOptions = {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
};

@Injectable()
export class TenantPrismaService implements OnModuleDestroy {
    private readonly prisma: PrismaClient;
    private readonly shutdownDrains = new Set<() => Promise<void>>();
    private shutdownPromise?: Promise<void>;
    private closed = false;

    constructor(@Optional() prisma?: PrismaClient) {
        this.prisma = prisma ?? new PrismaClient();
    }

    get client(): PrismaClient {
        return this.prisma;
    }

    registerShutdownDrain(drain: () => Promise<void>): void {
        if (this.shutdownPromise || this.closed) {
            throw new ServiceUnavailableException('Database shutdown has started');
        }
        this.shutdownDrains.add(drain);
    }

    onModuleDestroy(): Promise<void> {
        this.shutdownPromise ??= this.drainAndDisconnect();
        return this.shutdownPromise;
    }

    private async drainAndDisconnect(): Promise<void> {
        const deadline = Date.now() + resolveProcessShutdownDeadlineMs();
        let failure: unknown;
        const bounded = async (operation: Promise<unknown>) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    operation,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Database shutdown deadline exceeded')), Math.max(1, deadline - Date.now()));
                    }),
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };
        try {
            // Invoke synchronously so every owner stops admission before yielding.
            await bounded(Promise.allSettled([...this.shutdownDrains].map(async (drain) => drain()))
                .then((results) => {
                    const rejected = results.find((result) => result.status === 'rejected');
                    if (rejected?.status === 'rejected') throw rejected.reason;
                }));
        } catch (error) {
            failure = error;
        }
        // A timed-out background continuation must not reopen the Prisma client.
        this.closed = true;
        this.shutdownDrains.clear();
        try {
            await bounded(this.prisma.$disconnect());
        } catch (error) {
            failure ??= error;
        }
        if (failure) throw failure;
    }

    async withTenant<T>(
        tenantId: string,
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
        options?: TenantPrismaTransactionOptions,
    ): Promise<T> {
        this.assertOpen();
        this.assertTenantId(tenantId);
        return this.prisma.$transaction(async (tx) => {
            await this.setTenantContext(tx, tenantId);
            this.assertOpen();
            return operation(tx);
        }, options);
    }

    async withPlatformAdmin<T>(
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
        options?: TenantPrismaTransactionOptions,
    ): Promise<T> {
        this.assertOpen();
        return this.prisma.$transaction(async (tx) => {
            await this.setPlatformAdminContext(tx);
            this.assertOpen();
            return operation(tx);
        }, options);
    }

    private async setTenantContext(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
    }

    private async setPlatformAdminContext(tx: TenantPrismaTransaction): Promise<void> {
        const capability = String(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET ?? '').trim();
        if (!capability) {
            throw new ServiceUnavailableException('Platform admin database capability is not configured');
        }
        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
    }

    private assertOpen(): void {
        if (this.closed) throw new ServiceUnavailableException('Database is shutting down');
    }

    private assertTenantId(tenantId: string): void {
        if (typeof tenantId !== 'string' || !tenantId.trim()) {
            throw new BadRequestException('tenantId is required for tenant-scoped database access');
        }
    }
}
