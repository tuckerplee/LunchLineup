import { BadRequestException, Body, Controller, Header, HttpCode, NotFoundException, Post, Req, SetMetadata, UseGuards } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { buildTenantRetentionSchedule } from './tenant-account-lifecycle';

const RECEIPT_ACTION = 'TENANT_DELETION_RECEIPT_PREPARED';
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

@Controller({ path: 'account-deletion', version: '1' })
@UseGuards(JwtAuthGuard)
export class AccountDeletionReceiptController {
  constructor(private readonly database: TenantPrismaService) {}

  @Post('prepare')
  @RequirePermission('tenant_account:lifecycle')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async prepare(@Req() request: any, @Body() body: { confirmation?: unknown }) {
    const token = randomBytes(32).toString('hex');
    await this.database.withTenant(request.user.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: request.user.tenantId }, select: { slug: true, status: true } });
      if (typeof body?.confirmation !== 'string' || body.confirmation.trim().toLowerCase() !== tenant.slug.toLowerCase()) {
        throw new BadRequestException('Confirmation must match the workspace slug.');
      }
      await tx.auditLog.create({ data: {
        tenantId: request.user.tenantId, userId: request.user.sub,
        action: RECEIPT_ACTION, resource: 'AccountDeletionReceipt', resourceId: tokenHash(token),
      } });
    });
    return { token, expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString() };
  }

  // A bounded read capability remains usable after deletion revokes every session.
  // Only its hash is stored; no tenant identifiers or personal data are returned.
  @Post('receipt')
  @SetMetadata('isPublic', true)
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async receipt(@Body() body: { token?: unknown }) {
    if (typeof body?.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new NotFoundException('Receipt unavailable or expired.');
    const hash = tokenHash(body.token);
    return this.database.withPlatformAdmin(async (tx) => {
      const issued = await tx.auditLog.findFirst({ where: {
        action: RECEIPT_ACTION, resource: 'AccountDeletionReceipt', resourceId: hash,
        createdAt: { gte: new Date(Date.now() - RECEIPT_TTL_MS) },
      }, select: { tenantId: true } });
      if (!issued) throw new NotFoundException('Receipt unavailable or expired.');
      const tenant = await tx.tenant.findUnique({ where: { id: issued.tenantId }, select: { status: true, deletedAt: true } });
      if (!tenant) throw new NotFoundException('Receipt unavailable or expired.');
      const finalized = tenant.status === 'PURGED' && Boolean(tenant.deletedAt);
      const barrier = finalized ? null : await tx.auditLog.findFirst({ where: {
        tenantId: issued.tenantId, action: 'TENANT_DELETION_BARRIER_COMMITTED', resource: 'Tenant', resourceId: issued.tenantId,
      }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
      const requestedAt = finalized ? tenant.deletedAt : tenant.status === 'SUSPENDED' ? barrier?.createdAt : null;
      if (!requestedAt) return { state: 'NOT_RECORDED' as const, receipt: null };
      return { state: 'CONFIRMED' as const, receipt: {
        deletionState: finalized ? 'FINALIZED' : 'PENDING_BILLING_CLEANUP',
        billingCleanupPending: !finalized,
        deletionRequestedAt: requestedAt.toISOString(),
        retention: buildTenantRetentionSchedule(requestedAt),
      } };
    });
  }
}
