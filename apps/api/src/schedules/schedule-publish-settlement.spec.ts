import { describe, expect, it } from 'vitest';
import {
    assertSchedulePublishCredits,
    buildSchedulePublishPreflight,
    buildSchedulePublishSettlement,
    parseSchedulePublishAcceptedContract,
    schedulePublishContractMatches,
} from './schedule-publish-settlement';

const billable = (creditCost: number) => ({
    enabled: true,
    source: 'credits' as const,
    creditCost,
    reason: 'Billable',
});

describe('schedule publish settlement', () => {
    it('prices a publication with zero matching webhook endpoints', () => {
        expect(buildSchedulePublishPreflight({
            schedulingEntitlement: billable(2),
            webhookEntitlement: null,
            matchingWebhookDeliveryCount: 0,
            availableCredits: 2,
            scheduleVersion: 4,
        })).toEqual({
            totalConfiguredCost: 2,
            scheduleCost: 2,
            matchingWebhookDeliveryCount: 0,
            matchingWebhookDeliveryUnitCost: 0,
            matchingWebhookDeliveryCost: 0,
            acceptedContract: {
                version: 4,
                totalConfiguredCost: 2,
                scheduleCost: 2,
                matchingWebhookDeliveryCount: 0,
                matchingWebhookDeliveryUnitCost: 0,
                matchingWebhookDeliveryCost: 0,
            },
            availableCredits: 2,
            sufficientCredits: true,
        });
    });

    it('prices every matching webhook endpoint separately and rejects aggregate insufficiency', () => {
        const preflight = buildSchedulePublishPreflight({
            schedulingEntitlement: billable(2),
            webhookEntitlement: billable(3),
            matchingWebhookDeliveryCount: 2,
            availableCredits: 7,
            scheduleVersion: 4,
        });

        expect(preflight).toMatchObject({
            totalConfiguredCost: 8,
            scheduleCost: 2,
            matchingWebhookDeliveryCount: 2,
            matchingWebhookDeliveryUnitCost: 3,
            matchingWebhookDeliveryCost: 6,
            sufficientCredits: false,
        });
        expect(() => assertSchedulePublishCredits(preflight)).toThrow('Insufficient usage credits balance');
    });

    it('returns stable ledger identities in the final settlement', () => {
        const preflight = buildSchedulePublishPreflight({
            schedulingEntitlement: billable(1),
            webhookEntitlement: billable(2),
            matchingWebhookDeliveryCount: 2,
            availableCredits: 10,
            scheduleVersion: 4,
        });

        expect(buildSchedulePublishSettlement({
            preflight,
            operationId: 'operation-1',
            newBalance: 5,
            webhookDeliveryIds: ['delivery-1', 'delivery-2'],
        })).toEqual({
            totalConfiguredCost: 5,
            scheduleCost: 1,
            matchingWebhookDeliveryCount: 2,
            matchingWebhookDeliveryUnitCost: 2,
            matchingWebhookDeliveryCost: 4,
            acceptedContract: preflight.acceptedContract,
            creditsConsumed: 5,
            newBalance: 5,
            ledgerIdentities: {
                schedule: 'feature-usage-schedule-publish:operation-1',
                webhookDeliveries: [
                    { deliveryId: 'delivery-1', ledgerId: 'feature-usage-webhook-delivery:delivery-1' },
                    { deliveryId: 'delivery-2', ledgerId: 'feature-usage-webhook-delivery:delivery-2' },
                ],
            },
        });
    });

    it('validates and compares the manager-accepted schedule version and full cost plan', () => {
        const accepted = parseSchedulePublishAcceptedContract({
            version: 4,
            totalConfiguredCost: 5,
            scheduleCost: 1,
            matchingWebhookDeliveryCount: 2,
            matchingWebhookDeliveryUnitCost: 2,
            matchingWebhookDeliveryCost: 4,
        });

        expect(schedulePublishContractMatches(accepted, { ...accepted })).toBe(true);
        expect(schedulePublishContractMatches(accepted, { ...accepted, version: 5 })).toBe(false);
        expect(schedulePublishContractMatches(accepted, {
            ...accepted,
            totalConfiguredCost: 7,
            matchingWebhookDeliveryCount: 3,
            matchingWebhookDeliveryCost: 6,
        })).toBe(false);
        expect(() => parseSchedulePublishAcceptedContract({ ...accepted, totalConfiguredCost: 4 }))
            .toThrow('accepted schedule publish preflight contract');
    });
});
