import { TenantStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { purgeTenantApplicationData } from './tenant-account-lifecycle';

function buildTransaction() {
    const deleteMany = () => vi.fn().mockResolvedValue({ count: 0 });
    return {
        $queryRaw: vi.fn().mockResolvedValue([{ set_audit_log_user_redaction_tenant: null }]),
        session: { deleteMany: deleteMany() },
        passwordResetToken: { deleteMany: deleteMany() },
        notification: { deleteMany: deleteMany() },
        break: { deleteMany: deleteMany() },
        timeCard: { deleteMany: deleteMany() },
        lunchBreakGenerationRequest: { deleteMany: deleteMany() },
        scheduleSolveJob: { deleteMany: deleteMany() },
        scheduleDemandWindow: { deleteMany: deleteMany() },
        shift: { deleteMany: deleteMany() },
        staffAvailability: { deleteMany: deleteMany() },
        staffSkill: { deleteMany: deleteMany() },
        schedule: { deleteMany: deleteMany() },
        location: { deleteMany: deleteMany() },
        tenantSetting: { deleteMany: deleteMany() },
        webhookDelivery: { deleteMany: deleteMany() },
        webhookEndpoint: { deleteMany: deleteMany() },
        roleAssignment: { deleteMany: deleteMany() },
        rolePermission: { deleteMany: deleteMany() },
        role: { deleteMany: deleteMany() },
        auditLog: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
        user: { deleteMany: deleteMany() },
        tenant: { update: vi.fn().mockResolvedValue({}) },
    };
}

const tenant = {
    id: 'tenant-expired',
    slug: 'acme-dining',
    status: TenantStatus.PURGED,
    deletedAt: new Date('2026-06-01T00:00:00.000Z'),
    applicationDataPurgedAt: null,
};

describe('purgeTenantApplicationData audit redaction', () => {
    it('enables the transaction-local tenant capability before nulling audit actor references', async () => {
        const tx = buildTransaction();

        const result = await purgeTenantApplicationData(tx as any, tenant, {
            asOf: new Date('2026-07-10T12:00:00.000Z'),
        });

        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
            where: { user: { is: { tenantId: tenant.id } } },
            data: { userId: null },
        });
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.auditLog.updateMany.mock.invocationCallOrder[0],
        );
        expect(result.deletedRecordCounts.auditActorReferences).toBe(2);
    });

    it('fails closed before deleting application data when capability activation is rejected', async () => {
        const tx = buildTransaction();
        tx.$queryRaw.mockRejectedValue(new Error('audit log user redaction capability denied'));

        await expect(purgeTenantApplicationData(tx as any, tenant, {
            asOf: new Date('2026-07-10T12:00:00.000Z'),
        })).rejects.toThrow('audit log user redaction capability denied');

        expect(tx.session.deleteMany).not.toHaveBeenCalled();
        expect(tx.auditLog.updateMany).not.toHaveBeenCalled();
        expect(tx.user.deleteMany).not.toHaveBeenCalled();
    });
});
