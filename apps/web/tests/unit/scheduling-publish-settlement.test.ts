import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseSchedulePublishPreflight,
  parseSchedulePublishResponse,
  publishPreflightSummary,
  publishSettlementSummary,
  schedulePublishCostMatches,
  schedulePublishFailure,
} from '../../app/dashboard/scheduling/publish-settlement';

const preflightPayload = (overrides: Record<string, unknown> = {}) => ({
  scheduleId: 'schedule-1',
  totalConfiguredCost: 8,
  scheduleCost: 2,
  matchingWebhookDeliveryCount: 2,
  matchingWebhookDeliveryUnitCost: 3,
  matchingWebhookDeliveryCost: 6,
  acceptedContract: {
    version: 4,
    totalConfiguredCost: 8,
    scheduleCost: 2,
    matchingWebhookDeliveryCount: 2,
    matchingWebhookDeliveryUnitCost: 3,
    matchingWebhookDeliveryCost: 6,
  },
  availableCredits: 10,
  sufficientCredits: true,
  ...overrides,
});

const publishPayload = (settlementOverrides: Record<string, unknown> = {}) => ({
  id: 'schedule-1',
  status: 'PUBLISHED',
  publishedAt: '2026-07-16T18:00:00.000Z',
  settlement: {
    totalConfiguredCost: 8,
    scheduleCost: 2,
    matchingWebhookDeliveryCount: 2,
    matchingWebhookDeliveryUnitCost: 3,
    matchingWebhookDeliveryCost: 6,
    acceptedContract: {
      version: 4,
      totalConfiguredCost: 8,
      scheduleCost: 2,
      matchingWebhookDeliveryCount: 2,
      matchingWebhookDeliveryUnitCost: 3,
      matchingWebhookDeliveryCost: 6,
    },
    creditsConsumed: 8,
    newBalance: 2,
    ledgerIdentities: {
      schedule: 'feature-usage-schedule-publish:attempt-1',
      webhookDeliveries: [
        { deliveryId: 'delivery-1', ledgerId: 'feature-usage-webhook-delivery:delivery-1' },
        { deliveryId: 'delivery-2', ledgerId: 'feature-usage-webhook-delivery:delivery-2' },
      ],
    },
    ...settlementOverrides,
  },
  notifications: { status: 'DELIVERED', delivered: 4, pending: 0, failed: 0 },
});

describe('schedule publish settlement UI contract', () => {
  it('wires preflight, stable-key publish, single-flight protection, and settlement display', () => {
    const source = readFileSync(resolve(__dirname, '../../app/dashboard/scheduling/page.tsx'), 'utf8');

    expect(source).toContain('if (publishingScheduleIdRef.current) return;');
    expect(source).toContain('apiV2.getSchedulePublishPlan(scheduleId)');
    expect(source).toContain('apiV2.publishSchedule(');
    expect(source).toContain('acceptedContract: publishReview!.acceptedContract');
    expect(source).toContain('parseSchedulePublishResponse(scheduleId, publishedPayload)');
    expect(source).toContain('publishSettlementByScheduleId[schedule.id]');
  });

  it('parses and clearly summarizes the aggregate configured cost and projected balance', () => {
    const preflight = parseSchedulePublishPreflight('schedule-1', preflightPayload());

    expect(preflight).toMatchObject({
      totalConfiguredCost: 8,
      scheduleCost: 2,
      matchingWebhookDeliveryCost: 6,
      availableCredits: 10,
      sufficientCredits: true,
    });
    expect(publishPreflightSummary(preflight))
      .toBe('Configured total: 8 credits. Balance after publish: 2 credits.');
  });

  it('shows aggregate insufficiency rather than only the schedule cost', () => {
    const preflight = parseSchedulePublishPreflight('schedule-1', preflightPayload({
      availableCredits: 7,
      sufficientCredits: false,
    }));

    expect(publishPreflightSummary(preflight))
      .toBe('Configured total: 8 credits. Balance: 7 credits. 1 credit more required.');
  });

  it('requires reconfirmation when any configured cost component changes', () => {
    const original = parseSchedulePublishPreflight('schedule-1', preflightPayload());
    const sameCost = parseSchedulePublishPreflight('schedule-1', preflightPayload({ availableCredits: 9 }));
    const changedCost = parseSchedulePublishPreflight('schedule-1', preflightPayload({
      totalConfiguredCost: 11,
      matchingWebhookDeliveryCount: 3,
      matchingWebhookDeliveryCost: 9,
      acceptedContract: {
        version: 4,
        totalConfiguredCost: 11,
        scheduleCost: 2,
        matchingWebhookDeliveryCount: 3,
        matchingWebhookDeliveryUnitCost: 3,
        matchingWebhookDeliveryCost: 9,
      },
      availableCredits: 20,
    }));
    const changedVersion = parseSchedulePublishPreflight('schedule-1', preflightPayload({
      acceptedContract: {
        ...preflightPayload().acceptedContract,
        version: 5,
      },
    }));

    expect(schedulePublishCostMatches(original, sameCost)).toBe(true);
    expect(schedulePublishCostMatches(original, changedCost)).toBe(false);
    expect(schedulePublishCostMatches(original, changedVersion)).toBe(false);
  });

  it.each([
    preflightPayload({ scheduleId: 'schedule-2' }),
    preflightPayload({ totalConfiguredCost: 7 }),
    preflightPayload({ matchingWebhookDeliveryCost: 5 }),
    preflightPayload({ matchingWebhookDeliveryUnitCost: 0 }),
    preflightPayload({ acceptedContract: { ...preflightPayload().acceptedContract, version: -1 } }),
    preflightPayload({ acceptedContract: { ...preflightPayload().acceptedContract, totalConfiguredCost: 7 } }),
    preflightPayload({ sufficientCredits: false }),
  ])('fails closed for malformed or internally inconsistent preflight %#', (payload) => {
    expect(() => parseSchedulePublishPreflight('schedule-1', payload)).toThrow('invalid schedule publish preflight');
  });

  it('accepts and reports only an authoritative exact-once settlement', () => {
    const published = parseSchedulePublishResponse('schedule-1', publishPayload());

    expect(published.settlement).toMatchObject({ creditsConsumed: 8, newBalance: 2 });
    expect(publishSettlementSummary(published.settlement))
      .toBe('Schedule published. 8 credits were debited exactly once; 2 credits remain.');
  });

  it.each([
    publishPayload({ creditsConsumed: 7 }),
    publishPayload({ newBalance: -1 }),
    publishPayload({ ledgerIdentities: { schedule: '', webhookDeliveries: [] } }),
    publishPayload({ acceptedContract: { ...preflightPayload().acceptedContract, version: -1 } }),
    { ...publishPayload(), publishedAt: 'not-an-instant' },
  ])('rejects an unverified or contradictory publish settlement %#', (payload) => {
    expect(() => parseSchedulePublishResponse('schedule-1', payload)).toThrow('unconfirmed schedule publication');
  });

  it('maps payment, conflict, replay, and retry outcomes without rotating a valid attempt', () => {
    expect(schedulePublishFailure(402, 'Payment required')).toMatchObject({
      retryMode: 'review',
      resetAttempt: false,
      message: expect.stringContaining('active paid subscription'),
    });
    expect(schedulePublishFailure(409, 'Wait for active auto-schedule jobs.')).toMatchObject({
      retryMode: 'review',
      resetAttempt: false,
      message: expect.stringContaining('same publish attempt'),
    });
    expect(schedulePublishFailure(409, 'The stored outcome is unavailable. Use a new Idempotency-Key.')).toMatchObject({
      retryMode: 'review',
      resetAttempt: true,
    });
    expect(schedulePublishFailure(503, 'Unavailable')).toMatchObject({
      retryMode: 'replay',
      resetAttempt: false,
      message: expect.stringContaining('cannot be debited twice'),
    });
    expect(schedulePublishFailure(null, 'The request timed out.')).toMatchObject({
      retryMode: 'replay',
      resetAttempt: false,
    });
  });
});
