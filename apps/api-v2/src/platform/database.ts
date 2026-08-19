import { Prisma, PrismaClient } from '@prisma/client';

export type TenantTransaction = Prisma.TransactionClient;

export class TenantDatabase {
  constructor(private readonly prisma: PrismaClient = new PrismaClient()) {}

  async withTenant<T>(
    tenantId: string,
    operation: (transaction: TenantTransaction) => Promise<T>,
    options: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    } = {},
  ): Promise<T> {
    if (!tenantId.trim()) throw new Error('A tenant is required for tenant-scoped database access.');
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      return operation(transaction);
    }, {
      maxWait: options.maxWait ?? 5000,
      timeout: options.timeout ?? 20_000,
      isolationLevel: options.isolationLevel,
    });
  }

  async ready(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
