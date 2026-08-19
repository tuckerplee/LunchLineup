import { describe, expect, it, vi } from 'vitest';
import { PlanTier, TenantStatus } from '@prisma/client';
import { administrativeCreditGrantTransactionId } from '../billing/metering.service';
import { InternalBetaEntitlementService } from './internal-beta-entitlement.service';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const TENANT_ID = 'tenant-beta';
const ACTOR = {
    userId: 'platform-admin',
    tenantId: 'platform-tenant',
    sessionId: 'session-live',
    ipAddress: '203.0.113.20',
    userAgent: 'vitest',
};

function harness(configOverrides: Record<string, string> = {}) {
    const configValues = {
        INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
        APP_ORIGIN: 'https://beta.lunchlineup.com',
        ...configOverrides,
    };
    const config = {
        get: vi.fn((key: string) => configValues[key as keyof typeof configValues]),
    };
    const transactionId = administrativeCreditGrantTransactionId(
        TENANT_ID,
        'internal-beta-entitlement:pilot-1',
    );
    const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        tenant: {
            findUnique: vi.fn().mockResolvedValue({
                id: TENANT_ID,
                planTier: PlanTier.STARTER,
                status: TenantStatus.TRIAL,
                trialEndsAt: new Date('2026-09-01T00:00:00.000Z'),
                deletedAt: null,
                creditDebt: 0,
            }),
        },
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
        },
        auditLog: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({}),
        },
        creditTransaction: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
        planDefinition: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
    };
    const tenantDb = {
        withPlatformAdmin: vi.fn(async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)),
    };
    const rbac = {
        authorizePlatformAdminTenantMutationInTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const metering = {
        grantCreditsInTransaction: vi.fn().mockResolvedValue({
            transactionId,
            newBalance: 25,
            replayed: false,
        }),
    };
    const service = new InternalBetaEntitlementService(
        config as never,
        metering as never,
        tenantDb as never,
        rbac as never,
        () => new Date(NOW),
    );
    return { service, config, tx, tenantDb, rbac, metering, transactionId };
}

const INPUT = {
    credits: 25,
    expiresAt: '2026-08-25T12:00:00.000Z',
    reason: 'First restaurant pilot',
};

describe('InternalBetaEntitlementService', () => {
    it('atomically grants finite ledger credits, an expiring tenant setting, and attributed audit evidence', async () => {
        const h = harness();

        const result = await h.service.grant(TENANT_ID, INPUT, 'pilot-1', ACTOR);

        expect(result).toEqual({
            tenantId: TENANT_ID,
            grantId: h.transactionId,
            creditTransactionId: h.transactionId,
            creditsGranted: 25,
            newBalance: 25,
            approvedAt: NOW.toISOString(),
            expiresAt: INPUT.expiresAt,
        });
        expect(h.rbac.authorizePlatformAdminTenantMutationInTransaction).toHaveBeenCalledWith(
            h.tx,
            TENANT_ID,
            ACTOR,
        );
        expect(h.metering.grantCreditsInTransaction).toHaveBeenCalledWith(h.tx, {
            tenantId: TENANT_ID,
            amount: 25,
            reason: 'Internal beta scheduling entitlement: First restaurant pilot',
            idempotencyKey: 'internal-beta-entitlement:pilot-1',
        });
        expect(h.tx.tenantSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId_key: {
                    tenantId: TENANT_ID,
                    key: 'internal_beta_entitlement',
                },
            },
            create: expect.objectContaining({
                tenantId: TENANT_ID,
                key: 'internal_beta_entitlement',
                value: expect.objectContaining({
                    version: 1,
                    source: 'internal_beta',
                    status: 'ACTIVE',
                    features: ['scheduling'],
                    creditTransactionId: h.transactionId,
                    auditId: `${h.transactionId}-internal-beta-audit`,
                    creditsGranted: 25,
                    approvedByUserId: ACTOR.userId,
                    expiresAt: INPUT.expiresAt,
                }),
            }),
        }));
        expect(h.tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: TENANT_ID,
                actorUserId: ACTOR.userId,
                actorTenantId: ACTOR.tenantId,
                action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED',
                resource: 'TenantSetting',
                resourceId: h.transactionId,
                newValue: expect.objectContaining({
                    requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                    response: result,
                }),
            }),
        });
    });

    it('replays the exact stored outcome without regranting credits or replacing a newer current setting', async () => {
        const h = harness();
        const first = await h.service.grant(TENANT_ID, INPUT, 'pilot-1', ACTOR);
        const auditWrite = h.tx.auditLog.create.mock.calls[0][0].data;
        h.tx.auditLog.findUnique.mockResolvedValue({
            tenantId: TENANT_ID,
            action: auditWrite.action,
            resource: auditWrite.resource,
            resourceId: auditWrite.resourceId,
            newValue: auditWrite.newValue,
        });
        h.tx.creditTransaction.findUnique.mockResolvedValue({
            tenantId: TENANT_ID,
            amount: 25,
            debtAmount: 0,
            reason: 'Internal beta scheduling entitlement: First restaurant pilot',
            balanceAfter: 25,
            debtAfter: 0,
        });

        await expect(h.service.grant(TENANT_ID, INPUT, 'pilot-1', ACTOR)).resolves.toEqual(first);

        expect(h.metering.grantCreditsInTransaction).toHaveBeenCalledTimes(1);
        expect(h.tx.tenantSetting.upsert).toHaveBeenCalledTimes(1);
        expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it.each([
        [{ INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'false' }, 'disabled'],
        [{ APP_ORIGIN: 'https://app.lunchlineup.com' }, 'not beta'],
    ])('fails closed before database access when runtime configuration is %s', async (config, _label) => {
        const h = harness(config);

        await expect(h.service.grant(TENANT_ID, INPUT, 'pilot-1', ACTOR)).rejects.toThrow(
            /disabled|not beta\.lunchlineup\.com/i,
        );
        expect(h.tenantDb.withPlatformAdmin).not.toHaveBeenCalled();
    });

    it('rejects grants that outlive the tenant trial before touching the ledger', async () => {
        const h = harness();

        await expect(h.service.grant(TENANT_ID, {
            ...INPUT,
            expiresAt: '2026-09-02T00:00:00.000Z',
        }, 'pilot-1', ACTOR)).rejects.toThrow(/cannot outlive the tenant trial/i);
        expect(h.metering.grantCreditsInTransaction).not.toHaveBeenCalled();
        expect(h.tx.tenantSetting.upsert).not.toHaveBeenCalled();
        expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects a paid-plan override that explicitly excludes scheduling', async () => {
        const h = harness();
        h.tx.planDefinition.findUnique.mockResolvedValue({
            metadata: { features: [] },
        });

        await expect(h.service.grant(TENANT_ID, INPUT, 'pilot-1', ACTOR)).rejects.toThrow(
            /does not include scheduling/i,
        );
        expect(h.metering.grantCreditsInTransaction).not.toHaveBeenCalled();
    });

    it('rejects a reused idempotency key when the requested grant changes', async () => {
        const h = harness();
        await h.service.grant(TENANT_ID, INPUT, 'pilot-1', ACTOR);
        const auditWrite = h.tx.auditLog.create.mock.calls[0][0].data;
        h.tx.auditLog.findUnique.mockResolvedValue({
            tenantId: TENANT_ID,
            action: auditWrite.action,
            resource: auditWrite.resource,
            resourceId: auditWrite.resourceId,
            newValue: auditWrite.newValue,
        });

        await expect(h.service.grant(TENANT_ID, {
            ...INPUT,
            expiresAt: '2026-08-26T12:00:00.000Z',
        }, 'pilot-1', ACTOR)).rejects.toThrow(/different internal beta grant/i);
        expect(h.metering.grantCreditsInTransaction).toHaveBeenCalledTimes(1);
    });
});
