import { describe, expect, it, vi } from 'vitest';

import { readSchedulePublishAttempt, schedulePublishAttempt } from '../../app/dashboard/scheduling/publish-attempt';

const acceptedContract = {
  version: 3,
  totalConfiguredCost: 4,
  scheduleCost: 1,
  matchingWebhookDeliveryCount: 3,
  matchingWebhookDeliveryUnitCost: 1,
  matchingWebhookDeliveryCost: 3,
};

describe('schedule publish attempt identity', () => {
  it('reuses one key for the same schedule and publish payload', () => {
    const keyFactory = vi.fn(() => 'publish-attempt-1');
    const first = schedulePublishAttempt('schedule-1', acceptedContract, null, keyFactory);
    const retry = schedulePublishAttempt('schedule-1', acceptedContract, first, keyFactory);

    expect(retry).toBe(first);
    expect(keyFactory).toHaveBeenCalledOnce();
  });

  it('rotates when the schedule or accepted aggregate preflight contract changes', () => {
    const keyFactory = vi.fn()
      .mockReturnValueOnce('publish-attempt-1')
      .mockReturnValueOnce('publish-attempt-2')
      .mockReturnValueOnce('publish-attempt-3');
    const first = schedulePublishAttempt('schedule-1', acceptedContract, null, keyFactory);
    const differentSchedule = schedulePublishAttempt('schedule-2', acceptedContract, first, keyFactory);
    const changedContract = schedulePublishAttempt('schedule-2', {
      ...acceptedContract,
      version: 4,
    }, differentSchedule, keyFactory);

    expect(differentSchedule.key).toBe('publish-attempt-2');
    expect(changedContract.key).toBe('publish-attempt-3');
    expect(keyFactory).toHaveBeenCalledTimes(3);
  });
  it('copies and freezes the original wire payload rather than retaining a mutable review', () => {
    const review = { ...acceptedContract };
    const first = schedulePublishAttempt('schedule-1', review, null, () => 'original-key');
    review.version = 99; review.scheduleCost = 99;
    expect(first.payload).toEqual({ scheduleId: 'schedule-1', body: { acceptedContract } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload)).toBe(true);
    expect(Object.isFrozen(first.payload.body)).toBe(true);
    expect(Object.isFrozen(first.payload.body.acceptedContract)).toBe(true);
    expect(readSchedulePublishAttempt('schedule-1', first)).toBe(first);
    expect(readSchedulePublishAttempt('schedule-2', first)).toBeNull();
  });
  it('refuses missing, mutable or damaged replay records instead of synthesizing their request', () => {
    const first = schedulePublishAttempt('schedule-1', acceptedContract, null, () => 'original-key');
    for (const damaged of [null, undefined, {}, { ...first }, Object.freeze({ ...first, key: '' }), Object.freeze({ ...first, payloadFingerprint: 'damaged' })]) {
      expect(readSchedulePublishAttempt('schedule-1', damaged)).toBeNull();
    }
  });

});
