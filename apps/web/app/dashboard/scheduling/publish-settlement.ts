import type { PublishNotificationResult } from './publish-result';

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
  scheduleId: string;
  acceptedContract: SchedulePublishAcceptedContract;
  availableCredits: number;
  sufficientCredits: boolean;
};

export type SchedulePublishSettlement = SchedulePublishCostBreakdown & {
  acceptedContract: SchedulePublishAcceptedContract;
  creditsConsumed: number;
  newBalance: number;
};

export type SchedulePublishResponse = {
  id: string;
  status: 'PUBLISHED';
  publishedAt: string;
  settlement: SchedulePublishSettlement;
  notifications: PublishNotificationResult;
};

export type SchedulePublishFailure = {
  retryMode: 'review' | 'replay';
  resetAttempt: boolean;
  message: string;
};

const NOTIFICATION_STATUSES = new Set<PublishNotificationResult['status']>([
  'DELIVERED',
  'NOT_REQUIRED',
  'PENDING',
  'PARTIAL',
  'FAILED',
]);

export function parseSchedulePublishPreflight(
  scheduleId: string,
  payload: unknown,
): SchedulePublishPreflight {
  const invalid = 'The service returned an invalid schedule publish preflight.';
  if (!isRecord(payload) || payload.scheduleId !== scheduleId) throw new Error(invalid);
  const costs = parseCostBreakdown(payload, invalid);
  if (!isRecord(payload.acceptedContract)
    || !isNonNegativeSafeInteger(payload.acceptedContract.version)
    || !schedulePublishContractMatches(
      payload.acceptedContract as SchedulePublishAcceptedContract,
      { version: payload.acceptedContract.version, ...costs },
    )
    || !isNonNegativeSafeInteger(payload.availableCredits)
    || typeof payload.sufficientCredits !== 'boolean'
    || payload.sufficientCredits !== (payload.availableCredits >= costs.totalConfiguredCost)) {
    throw new Error(invalid);
  }
  return {
    scheduleId,
    ...costs,
    acceptedContract: {
      version: payload.acceptedContract.version,
      ...costs,
    },
    availableCredits: payload.availableCredits,
    sufficientCredits: payload.sufficientCredits,
  };
}

export function parseSchedulePublishResponse(
  scheduleId: string,
  payload: unknown,
): SchedulePublishResponse {
  const invalid = 'The service returned an unconfirmed schedule publication.';
  if (!isRecord(payload)
    || payload.id !== scheduleId
    || payload.status !== 'PUBLISHED'
    || !isIsoInstant(payload.publishedAt)
    || !isRecord(payload.settlement)
    || !isRecord(payload.notifications)) {
    throw new Error(invalid);
  }
  const settlement = parseSettlement(payload.settlement, invalid);
  const notificationStatus = payload.notifications.status;
  if (typeof notificationStatus !== 'string'
    || !NOTIFICATION_STATUSES.has(notificationStatus as PublishNotificationResult['status'])
    || !isNonNegativeSafeInteger(payload.notifications.delivered)
    || !isNonNegativeSafeInteger(payload.notifications.pending)
    || !isNonNegativeSafeInteger(payload.notifications.failed)) {
    throw new Error(invalid);
  }
  return {
    id: scheduleId,
    status: 'PUBLISHED',
    publishedAt: payload.publishedAt,
    settlement,
    notifications: {
      status: notificationStatus as PublishNotificationResult['status'],
      delivered: payload.notifications.delivered,
      pending: payload.notifications.pending,
      failed: payload.notifications.failed,
    },
  };
}

export function publishPreflightSummary(preflight: SchedulePublishPreflight): string {
  const total = creditCount(preflight.totalConfiguredCost);
  const balance = creditCount(preflight.availableCredits);
  if (!preflight.sufficientCredits) {
    const shortfall = preflight.totalConfiguredCost - preflight.availableCredits;
    return `Configured total: ${total}. Balance: ${balance}. ${creditCount(shortfall)} more required.`;
  }
  return `Configured total: ${total}. Balance after publish: ${creditCount(
    preflight.availableCredits - preflight.totalConfiguredCost,
  )}.`;
}

export function schedulePublishCostMatches(
  left: SchedulePublishPreflight,
  right: SchedulePublishPreflight,
): boolean {
  return schedulePublishContractMatches(left.acceptedContract, right.acceptedContract);
}

export function publishSettlementSummary(settlement: SchedulePublishSettlement): string {
  return `Schedule published. ${creditCount(settlement.creditsConsumed)} ${
    settlement.creditsConsumed === 1 ? 'was' : 'were'
  } debited exactly once; ${creditCount(settlement.newBalance)} remain.`;
}

export function schedulePublishFailure(
  status: number | null,
  serverMessage: string,
): SchedulePublishFailure {
  const billingRejection = status === 402
    || (status === 403 && /(?:paid subscription|credit|payment)/i.test(serverMessage));
  if (billingRejection) {
    return {
      retryMode: 'review',
      resetAttempt: false,
      message: 'Publishing requires an active paid subscription and enough separately purchased or administrator-granted credits. No settlement was confirmed. Recheck the configured total before retrying.',
    };
  }
  if (status === 409) {
    const resetAttempt = /use a new idempotency-key/i.test(serverMessage);
    return {
      retryMode: 'review',
      resetAttempt,
      message: resetAttempt
        ? 'The service could not replay the stored publication outcome. No new settlement was confirmed; review the schedule before starting a new publish attempt.'
        : 'Publishing conflicted with current schedule state. No settlement was confirmed. Resolve the conflict, then retry with the same publish attempt.',
    };
  }
  if (status === null || status >= 500 || status === 408) {
    return {
      retryMode: 'replay',
      resetAttempt: false,
      message: 'The publish outcome is not yet confirmed. Retry replays the same publish attempt so the configured credits cannot be debited twice.',
    };
  }
  return {
    retryMode: 'review',
    resetAttempt: false,
    message: 'Schedule publication was rejected before a settlement was confirmed. Review the schedule and preflight before retrying with the same publish attempt.',
  };
}

export function creditCount(count: number): string {
  return `${count} ${count === 1 ? 'credit' : 'credits'}`;
}

function parseSettlement(value: Record<string, unknown>, invalid: string): SchedulePublishSettlement {
  const costs = parseCostBreakdown(value, invalid);
  if (!isRecord(value.acceptedContract)
    || !isNonNegativeSafeInteger(value.acceptedContract.version)
    || !schedulePublishContractMatches(
      value.acceptedContract as SchedulePublishAcceptedContract,
      { version: value.acceptedContract.version, ...costs },
    )
    || !isNonNegativeSafeInteger(value.creditsConsumed)
    || value.creditsConsumed !== costs.totalConfiguredCost
    || !isNonNegativeSafeInteger(value.newBalance)
    || !isRecord(value.ledgerIdentities)
    || typeof value.ledgerIdentities.schedule !== 'string'
    || value.ledgerIdentities.schedule.length === 0
    || !Array.isArray(value.ledgerIdentities.webhookDeliveries)
    || value.ledgerIdentities.webhookDeliveries.length !== costs.matchingWebhookDeliveryCount
    || !value.ledgerIdentities.webhookDeliveries.every((entry) => (
      isRecord(entry)
      && typeof entry.deliveryId === 'string'
      && entry.deliveryId.length > 0
      && typeof entry.ledgerId === 'string'
      && entry.ledgerId.length > 0
    ))) {
    throw new Error(invalid);
  }
  return {
    ...costs,
    acceptedContract: {
      version: value.acceptedContract.version,
      ...costs,
    },
    creditsConsumed: value.creditsConsumed,
    newBalance: value.newBalance,
  };
}

function parseCostBreakdown(
  value: Record<string, unknown>,
  invalid: string,
): SchedulePublishCostBreakdown {
  if (!isPositiveSafeInteger(value.totalConfiguredCost)
    || !isPositiveSafeInteger(value.scheduleCost)
    || !isNonNegativeSafeInteger(value.matchingWebhookDeliveryCount)
    || !isNonNegativeSafeInteger(value.matchingWebhookDeliveryUnitCost)
    || !isNonNegativeSafeInteger(value.matchingWebhookDeliveryCost)
    || (value.matchingWebhookDeliveryCount > 0 && value.matchingWebhookDeliveryUnitCost <= 0)
    || (value.matchingWebhookDeliveryCount === 0 && value.matchingWebhookDeliveryUnitCost !== 0)
    || value.matchingWebhookDeliveryCost
      !== value.matchingWebhookDeliveryCount * value.matchingWebhookDeliveryUnitCost
    || value.totalConfiguredCost !== value.scheduleCost + value.matchingWebhookDeliveryCost) {
    throw new Error(invalid);
  }
  return {
    totalConfiguredCost: value.totalConfiguredCost,
    scheduleCost: value.scheduleCost,
    matchingWebhookDeliveryCount: value.matchingWebhookDeliveryCount,
    matchingWebhookDeliveryUnitCost: value.matchingWebhookDeliveryUnitCost,
    matchingWebhookDeliveryCost: value.matchingWebhookDeliveryCost,
  };
}

function schedulePublishContractMatches(
  left: SchedulePublishAcceptedContract,
  right: SchedulePublishAcceptedContract,
): boolean {
  return left.version === right.version
    && left.totalConfiguredCost === right.totalConfiguredCost
    && left.scheduleCost === right.scheduleCost
    && left.matchingWebhookDeliveryCount === right.matchingWebhookDeliveryCount
    && left.matchingWebhookDeliveryUnitCost === right.matchingWebhookDeliveryUnitCost
    && left.matchingWebhookDeliveryCost === right.matchingWebhookDeliveryCost;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
