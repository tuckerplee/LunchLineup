import { describe, expect, it, vi } from 'vitest';

import { schedulePublishAttempt } from '../../app/dashboard/scheduling/publish-attempt';

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
});
