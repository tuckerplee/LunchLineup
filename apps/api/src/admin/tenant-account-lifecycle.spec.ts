import { Prisma, TenantStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
    applyDormantSessionRetention,
    applyPasswordResetTokenRetention,
    projectScheduledTenantCancellation,
    purgeExpiredTenantRecords,
    purgeTenantApplicationData,
    serializeTenantLifecycleStatus,
} from './tenant-account-lifecycle';

function rawQueryText(query: any): string {
    if (Array.isArray(query?.strings)) return query.strings.join(' ');
    if (Array.isArray(query)) return query.join(' ');
    return String(query);
}

function buildTransaction() {
    const deleteMany = () => vi.fn().mockResolvedValue({ count: 0 });
    return {
        $queryRaw: vi.fn().mockImplementation(async (query: any) => {
            const sql = rawQueryText(query);
            if (sql.includes('purge_payroll_operational_time_cards')) return [{ purgedCount: 5n }];
            if (sql.includes('purge_expired_payroll_records')) return [{ purgedCount: 7n }];
            if (sql.includes('purge_expired_audit_logs')) return [{ purge_expired_audit_logs: 2n }];
            return [{ redactedCount: 2n }];
        }),
        billingEvent: {
            updateMany: vi.fn().mockResolvedValue({ count: 3 }),
            deleteMany: deleteMany(),
        },
        stripeUsageEvent: {
            updateMany: vi.fn().mockResolvedValue({ count: 4 }),
            deleteMany: deleteMany(),
        },
        session: { deleteMany: deleteMany() },
        passwordResetToken: { deleteMany: deleteMany() },
        onboardingSignupAttempt: { deleteMany: deleteMany() },
        tenantExportJob: { deleteMany: deleteMany() },
        availabilityImportJob: { deleteMany: deleteMany() },
        notificationOutbox: { deleteMany: deleteMany() },
        staffInvitationOutbox: { deleteMany: deleteMany() },
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
        creditTransaction: { deleteMany: deleteMany() },
        roleAssignment: { deleteMany: deleteMany() },
        rolePermission: { deleteMany: deleteMany() },
        role: { deleteMany: deleteMany() },
        user: { deleteMany: deleteMany() },
        tenant: {
            update: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
        },
    };
}

const tenant = {
    id: 'tenant-expired',
    slug: 'acme-dining',
    status: TenantStatus.PURGED,
    deletedAt: new Date('2026-06-01T00:00:00.000Z'),
    applicationDataPurgedAt: null,
};

describe('tenant cancellation status projection', () => {
    const cancellationEffectiveAt = '2027-01-15T08:00:00.000Z';
    const finalizedCustomerIntent = {
        tenantId: 'tenant-active',
        kind: 'CUSTOMER_CANCELLATION',
        state: 'FINALIZED',
        providerResult: {
            action: 'scheduled',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: cancellationEffectiveAt,
        },
    };
    const activeTenant = {
        id: 'tenant-active',
        slug: 'acme-dining',
        status: TenantStatus.ACTIVE,
        deletedAt: null,
        applicationDataPurgedAt: null,
    };

    it('projects a provider-applied or finalized customer intent into the API status contract', () => {
        expect(projectScheduledTenantCancellation(activeTenant.id, finalizedCustomerIntent)).toEqual({
            lifecycleStatus: 'CANCELLATION_SCHEDULED',
            cancellationEffectiveAt,
        });
        expect(serializeTenantLifecycleStatus(activeTenant, finalizedCustomerIntent)).toMatchObject({
            status: TenantStatus.ACTIVE,
            lifecycleStatus: 'CANCELLATION_SCHEDULED',
            cancellationEffectiveAt,
        });
        expect(projectScheduledTenantCancellation(activeTenant.id, {
            ...finalizedCustomerIntent,
            state: 'PROVIDER_APPLIED',
        })).toEqual({
            lifecycleStatus: 'CANCELLATION_SCHEDULED',
            cancellationEffectiveAt,
        });
    });

    it('does not project provider-pending, malformed, or stale terminal cancellation intents', () => {
        expect(projectScheduledTenantCancellation(activeTenant.id, {
            ...finalizedCustomerIntent,
            state: 'PENDING_PROVIDER',
        })).toBeNull();
        expect(projectScheduledTenantCancellation(activeTenant.id, {
            ...finalizedCustomerIntent,
            providerResult: {
                ...finalizedCustomerIntent.providerResult,
                currentPeriodEnd: 'not-a-date',
            },
        })).toBeNull();
        expect(serializeTenantLifecycleStatus({
            ...activeTenant,
            status: TenantStatus.CANCELLED,
            deletedAt: new Date('2027-01-15T08:00:00.000Z'),
        }, finalizedCustomerIntent)).toMatchObject({
            lifecycleStatus: 'CANCELLED',
            cancellationEffectiveAt: null,
        });
    });
});

describe('purgeTenantApplicationData retained-record redaction', () => {
    it('minimizes audit and billing payloads before deleting application data', async () => {
        const tx = buildTransaction();

        const result = await purgeTenantApplicationData(tx as any, tenant, {
            asOf: new Date('2026-07-10T12:00:00.000Z'),
        });

        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        const payrollPurgeQuery = tx.$queryRaw.mock.calls[0][0];
        expect(rawQueryText(payrollPurgeQuery)).toContain('purge_payroll_operational_time_cards');
        expect(payrollPurgeQuery.values).toEqual([tenant.id]);
        expect(tx.billingEvent.updateMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
            data: { metadata: Prisma.DbNull },
        });
        expect(tx.stripeUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
            data: { metadata: Prisma.DbNull, lastError: null },
        });
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.session.deleteMany.mock.invocationCallOrder[0],
        );
        expect(tx.timeCard.deleteMany).not.toHaveBeenCalled();
        expect(tx.notificationOutbox.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
        });
        expect(tx.staffInvitationOutbox.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
        });
        expect(tx.onboardingSignupAttempt.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
        });
        expect(tx.tenantExportJob.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
        });
        expect(tx.availabilityImportJob.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: tenant.id },
        });
        expect(result.deletedRecordCounts).toMatchObject({
            auditRecordsRedacted: 2,
            billingEventPayloadsRedacted: 3,
            stripeUsagePayloadsRedacted: 4,
            timeCards: 5,
            onboardingSignupAttempts: 0,
            tenantExportJobs: 0,
            availabilityImportJobs: 0,
            notificationOutbox: 0,
            staffInvitationOutbox: 0,
        });
    });

    it('fails closed before deleting application data when audit redaction is rejected', async () => {
        const tx = buildTransaction();
        tx.$queryRaw
            .mockResolvedValueOnce([{ purgedCount: 5n }])
            .mockRejectedValueOnce(new Error('audit log retained-record redaction denied'));

        await expect(purgeTenantApplicationData(tx as any, tenant, {
            asOf: new Date('2026-07-10T12:00:00.000Z'),
        })).rejects.toThrow('audit log retained-record redaction denied');

        expect(tx.billingEvent.updateMany).not.toHaveBeenCalled();
        expect(tx.stripeUsageEvent.updateMany).not.toHaveBeenCalled();
        expect(tx.session.deleteMany).not.toHaveBeenCalled();
        expect(tx.onboardingSignupAttempt.deleteMany).not.toHaveBeenCalled();
        expect(tx.tenantExportJob.deleteMany).not.toHaveBeenCalled();
        expect(tx.availabilityImportJob.deleteMany).not.toHaveBeenCalled();
        expect(tx.user.deleteMany).not.toHaveBeenCalled();
        expect(tx.tenant.update).not.toHaveBeenCalled();
    });

    it.each([
        'open time cards block payroll operational purge',
        'all payroll periods must be locked before application-data purge',
        'time cards require current immutable payroll snapshots before purge',
    ])('fails closed before any application cleanup when payroll rejects: %s', async (message) => {
        const tx = buildTransaction();
        tx.$queryRaw.mockRejectedValueOnce(new Error(message));

        await expect(purgeTenantApplicationData(tx as any, tenant, {
            asOf: new Date('2026-07-10T12:00:00.000Z'),
        })).rejects.toThrow(message);

        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(tx.billingEvent.updateMany).not.toHaveBeenCalled();
        expect(tx.session.deleteMany).not.toHaveBeenCalled();
        expect(tx.timeCard.deleteMany).not.toHaveBeenCalled();
        expect(tx.user.deleteMany).not.toHaveBeenCalled();
        expect(tx.tenant.update).not.toHaveBeenCalled();
    });
});

describe('purgeExpiredTenantRecords payroll retention', () => {
    it('purges retained payroll evidence before dependent records and the tenant tombstone', async () => {
        const tx = buildTransaction();

        const result = await purgeExpiredTenantRecords(tx as any, {
            ...tenant,
            applicationDataPurgedAt: new Date('2026-07-10T12:00:00.000Z'),
        }, {
            asOf: new Date('2033-07-10T12:00:00.000Z'),
        });

        const payrollPurgeCall = tx.$queryRaw.mock.calls.findIndex(([query]) => (
            rawQueryText(query).includes('purge_expired_payroll_records')
        ));
        const auditPurgeCall = tx.$queryRaw.mock.calls.findIndex(([query]) => (
            rawQueryText(query).includes('purge_expired_audit_logs')
        ));
        expect(payrollPurgeCall).toBeGreaterThanOrEqual(0);
        expect(tx.$queryRaw.mock.calls[payrollPurgeCall][0].values).toEqual([tenant.id]);
        expect(tx.$queryRaw.mock.invocationCallOrder[payrollPurgeCall]).toBeLessThan(
            tx.timeCard.deleteMany.mock.invocationCallOrder[0],
        );
        expect(tx.$queryRaw.mock.invocationCallOrder[auditPurgeCall]).toBeLessThan(
            tx.user.deleteMany.mock.invocationCallOrder[0],
        );
        expect(tx.tenant.delete).toHaveBeenCalledWith({ where: { id: tenant.id } });
        expect(result.deletedRecordCounts).toMatchObject({ payrollRecords: 7, auditLogs: 2 });
    });
});
describe('applyDormantSessionRetention', () => {
    const asOf = new Date('2026-07-14T12:00:00.000Z');

    it('dry-runs the explicit expired and revoked cutoffs without deleting sessions', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ eligibleCount: 7n }]),
        };

        await expect(applyDormantSessionRetention(tx as any, asOf, true)).resolves.toEqual({
            expiredGraceHours: 24,
            revokedRetentionDays: 30,
            batchLimit: 5_000,
            expiredBefore: '2026-07-13T12:00:00.000Z',
            revokedBefore: '2026-06-14T12:00:00.000Z',
            eligibleCount: 7,
            purgedCount: 0,
        });
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
    });

    it('executes one bounded database purge batch after counting eligible sessions', async () => {
        const tx = {
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([{ eligibleCount: 7n }])
                .mockResolvedValueOnce([{ purgedCount: 5n }]),
        };

        const result = await applyDormantSessionRetention(tx as any, asOf, false);

        expect(result).toMatchObject({ eligibleCount: 7, purgedCount: 5, batchLimit: 5_000 });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        const purgeQuery = tx.$queryRaw.mock.calls[1][0];
        expect(purgeQuery.strings.join(' ')).toContain('purge_dormant_sessions');
        expect(purgeQuery.values).toEqual([asOf, 5_000]);
    });
});

describe('applyPasswordResetTokenRetention', () => {
    const asOf = new Date('2026-07-14T12:00:00.000Z');

    it('dry-runs the fixed terminal grace without deleting reset credentials', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ eligibleCount: 9n }]),
        };

        await expect(applyPasswordResetTokenRetention(tx as any, asOf, true)).resolves.toEqual({
            terminalGraceHours: 24,
            batchLimit: 5_000,
            terminalBefore: '2026-07-13T12:00:00.000Z',
            eligibleCount: 9,
            purgedCount: 0,
        });
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        const eligibilityQuery = tx.$queryRaw.mock.calls[0][0];
        expect(eligibilityQuery.strings.join(' ')).toContain('COALESCE');
        expect(eligibilityQuery.values).toEqual([new Date(
'2026-07-13T12:00:00.000Z'
)]);
    });

    it('executes one bounded privileged database purge after counting eligible hashes', async () => {
        const tx = {
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([{ eligibleCount: 9n }])
                .mockResolvedValueOnce([{ purgedCount: 5n }]),
        };

        const result = await applyPasswordResetTokenRetention(tx as any, asOf, false);

        expect(result).toMatchObject({ eligibleCount: 9, purgedCount: 5, batchLimit: 5_000 });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        const purgeQuery = tx.$queryRaw.mock.calls[1][0];
        expect(purgeQuery.strings.join(' ')).toContain('purge_expired_password_reset_tokens');
        expect(purgeQuery.values).toEqual([asOf, 5_000]);
    });
});
