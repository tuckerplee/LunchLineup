import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { FeatureResolution } from '../billing/feature-access.service';

export type SchedulePublishCostBreakdown = {
    totalConfiguredCost: number;
    scheduleCost: number;
    matchingWebhookDeliveryCount: number;
    matchingWebhookDeliveryUnitCost: number;
    matchingWebhookDeliveryCost: number;
};

export type SchedulePublishAcceptedContract = SchedulePublishCostBreakdown & {
    version: number;
};

export type SchedulePublishPreflight = SchedulePublishCostBreakdown & {
    acceptedContract: SchedulePublishAcceptedContract;
    availableCredits: number;
    sufficientCredits: boolean;
};

export type SchedulePublishSettlement = SchedulePublishCostBreakdown & {
    acceptedContract: SchedulePublishAcceptedContract;
    creditsConsumed: number;
    newBalance: number;
    ledgerIdentities: {
        schedule: string;
        webhookDeliveries: Array<{
            deliveryId: string;
            ledgerId: string;
        }>;
    };
};

export function buildSchedulePublishPreflight(args: {
    schedulingEntitlement: FeatureResolution;
    webhookEntitlement: FeatureResolution | null;
    matchingWebhookDeliveryCount: number;
    availableCredits: number;
    scheduleVersion: number;
}): SchedulePublishPreflight {
    const scheduleCost = positiveConfiguredCost(args.schedulingEntitlement, 'Schedule publication');
    const matchingWebhookDeliveryCount = nonNegativeSafeInteger(
        args.matchingWebhookDeliveryCount,
        'Matching webhook delivery count',
    );
    const matchingWebhookDeliveryUnitCost = matchingWebhookDeliveryCount === 0
        ? 0
        : positiveConfiguredCost(args.webhookEntitlement, 'Webhook delivery');
    const matchingWebhookDeliveryCost = safeCostProduct(
        matchingWebhookDeliveryCount,
        matchingWebhookDeliveryUnitCost,
    );
    const totalConfiguredCost = safeCostSum(scheduleCost, matchingWebhookDeliveryCost);
    const availableCredits = nonNegativeSafeInteger(args.availableCredits, 'Available credit balance');
    const acceptedContract = {
        version: nonNegativeSafeInteger(args.scheduleVersion, 'Schedule version'),
        totalConfiguredCost,
        scheduleCost,
        matchingWebhookDeliveryCount,
        matchingWebhookDeliveryUnitCost,
        matchingWebhookDeliveryCost,
    };

    return {
        totalConfiguredCost,
        scheduleCost,
        matchingWebhookDeliveryCount,
        matchingWebhookDeliveryUnitCost,
        matchingWebhookDeliveryCost,
        acceptedContract,
        availableCredits,
        sufficientCredits: availableCredits >= totalConfiguredCost,
    };
}

export function parseSchedulePublishAcceptedContract(value: unknown): SchedulePublishAcceptedContract {
    if (!isSchedulePublishAcceptedContract(value)) {
        throw new BadRequestException('A valid accepted schedule publish preflight contract is required.');
    }
    return value;
}

export function schedulePublishContractMatches(
    accepted: SchedulePublishAcceptedContract,
    current: SchedulePublishAcceptedContract,
): boolean {
    return accepted.version === current.version
        && accepted.totalConfiguredCost === current.totalConfiguredCost
        && accepted.scheduleCost === current.scheduleCost
        && accepted.matchingWebhookDeliveryCount === current.matchingWebhookDeliveryCount
        && accepted.matchingWebhookDeliveryUnitCost === current.matchingWebhookDeliveryUnitCost
        && accepted.matchingWebhookDeliveryCost === current.matchingWebhookDeliveryCost;
}

export function assertSchedulePublishCredits(preflight: SchedulePublishPreflight): void {
    if (preflight.sufficientCredits) return;

    throw new ForbiddenException({
        message: 'Insufficient usage credits balance for schedule publication and matching webhook deliveries.',
        preflight,
    });
}

export function buildSchedulePublishSettlement(args: {
    preflight: SchedulePublishPreflight;
    operationId: string;
    newBalance: number;
    webhookDeliveryIds: string[];
}): SchedulePublishSettlement {
    if (args.webhookDeliveryIds.length !== args.preflight.matchingWebhookDeliveryCount) {
        throw new Error('Webhook delivery settlement does not match the authoritative publish preflight.');
    }
    const expectedNewBalance = args.preflight.availableCredits - args.preflight.totalConfiguredCost;
    if (args.newBalance !== expectedNewBalance) {
        throw new Error('Schedule publication credit balance does not match the authoritative publish preflight.');
    }

    return {
        totalConfiguredCost: args.preflight.totalConfiguredCost,
        scheduleCost: args.preflight.scheduleCost,
        matchingWebhookDeliveryCount: args.preflight.matchingWebhookDeliveryCount,
        matchingWebhookDeliveryUnitCost: args.preflight.matchingWebhookDeliveryUnitCost,
        matchingWebhookDeliveryCost: args.preflight.matchingWebhookDeliveryCost,
        acceptedContract: args.preflight.acceptedContract,
        creditsConsumed: args.preflight.totalConfiguredCost,
        newBalance: nonNegativeSafeInteger(args.newBalance, 'New credit balance'),
        ledgerIdentities: {
            schedule: schedulePublishLedgerId(args.operationId),
            webhookDeliveries: args.webhookDeliveryIds.map((deliveryId) => ({
                deliveryId,
                ledgerId: webhookDeliveryLedgerId(deliveryId),
            })),
        },
    };
}

export function schedulePublishLedgerId(operationId: string): string {
    return `feature-usage-schedule-publish:${operationId}`;
}

export function webhookDeliveryLedgerId(deliveryId: string): string {
    return `feature-usage-webhook-delivery:${deliveryId}`;
}

export function isSchedulePublishSettlement(value: unknown): value is SchedulePublishSettlement {
    if (!isRecord(value)
        || !isNonNegativeSafeInteger(value.totalConfiguredCost)
        || !isNonNegativeSafeInteger(value.scheduleCost)
        || !isNonNegativeSafeInteger(value.matchingWebhookDeliveryCount)
        || !isNonNegativeSafeInteger(value.matchingWebhookDeliveryUnitCost)
        || !isNonNegativeSafeInteger(value.matchingWebhookDeliveryCost)
        || !isSchedulePublishAcceptedContract(value.acceptedContract)
        || !isNonNegativeSafeInteger(value.creditsConsumed)
        || !isNonNegativeSafeInteger(value.newBalance)
        || !isRecord(value.ledgerIdentities)
        || typeof value.ledgerIdentities.schedule !== 'string'
        || !Array.isArray(value.ledgerIdentities.webhookDeliveries)) {
        return false;
    }
    if (value.scheduleCost <= 0
        || (value.matchingWebhookDeliveryCount > 0 && value.matchingWebhookDeliveryUnitCost <= 0)
        || value.totalConfiguredCost !== value.scheduleCost + value.matchingWebhookDeliveryCost
        || value.matchingWebhookDeliveryCost
            !== value.matchingWebhookDeliveryCount * value.matchingWebhookDeliveryUnitCost
        || !schedulePublishContractMatches(value.acceptedContract, {
            version: value.acceptedContract.version,
            totalConfiguredCost: value.totalConfiguredCost,
            scheduleCost: value.scheduleCost,
            matchingWebhookDeliveryCount: value.matchingWebhookDeliveryCount,
            matchingWebhookDeliveryUnitCost: value.matchingWebhookDeliveryUnitCost,
            matchingWebhookDeliveryCost: value.matchingWebhookDeliveryCost,
        })
        || value.creditsConsumed !== value.totalConfiguredCost
        || value.ledgerIdentities.webhookDeliveries.length !== value.matchingWebhookDeliveryCount) {
        return false;
    }
    return value.ledgerIdentities.webhookDeliveries.every((entry) => (
        isRecord(entry)
        && typeof entry.deliveryId === 'string'
        && entry.deliveryId.length > 0
        && entry.ledgerId === webhookDeliveryLedgerId(entry.deliveryId)
    ));
}

function positiveConfiguredCost(
    entitlement: FeatureResolution | null,
    operation: string,
): number {
    const cost = entitlement?.creditCost;
    if (!entitlement?.enabled
        || entitlement.source !== 'credits'
        || typeof cost !== 'number'
        || !Number.isSafeInteger(cost)
        || cost <= 0) {
        throw new ForbiddenException(
            `${operation} requires an active paid subscription and a positive configured credit cost.`,
        );
    }
    return cost;
}

function nonNegativeSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ForbiddenException(`${label} is invalid.`);
    }
    return value;
}

function safeCostProduct(count: number, unitCost: number): number {
    const value = count * unitCost;
    if (!Number.isSafeInteger(value)) {
        throw new ForbiddenException('Webhook delivery credit configuration is invalid.');
    }
    return value;
}

function safeCostSum(scheduleCost: number, webhookCost: number): number {
    const value = scheduleCost + webhookCost;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ForbiddenException('Schedule publication credit configuration is invalid.');
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSchedulePublishAcceptedContract(value: unknown): value is SchedulePublishAcceptedContract {
    return isRecord(value)
        && isNonNegativeSafeInteger(value.version)
        && isNonNegativeSafeInteger(value.totalConfiguredCost)
        && value.totalConfiguredCost > 0
        && isNonNegativeSafeInteger(value.scheduleCost)
        && value.scheduleCost > 0
        && isNonNegativeSafeInteger(value.matchingWebhookDeliveryCount)
        && isNonNegativeSafeInteger(value.matchingWebhookDeliveryUnitCost)
        && isNonNegativeSafeInteger(value.matchingWebhookDeliveryCost)
        && (value.matchingWebhookDeliveryCount > 0
            ? value.matchingWebhookDeliveryUnitCost > 0
            : value.matchingWebhookDeliveryUnitCost === 0)
        && value.matchingWebhookDeliveryCost
            === value.matchingWebhookDeliveryCount * value.matchingWebhookDeliveryUnitCost
        && value.totalConfiguredCost === value.scheduleCost + value.matchingWebhookDeliveryCost;
}
