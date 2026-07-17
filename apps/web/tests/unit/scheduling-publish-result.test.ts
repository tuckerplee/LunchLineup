import { describe, expect, it } from 'vitest';

import { publishNotificationOutcome } from '../../app/dashboard/scheduling/publish-result';

describe('publishNotificationOutcome', () => {
  it('treats an omitted notification summary as a successful backward-compatible publish', () => {
    expect(publishNotificationOutcome(undefined)).toBeNull();
  });

  it('surfaces partial notification delivery after a committed publish', () => {
    expect(publishNotificationOutcome({ status: 'PARTIAL', delivered: 3, pending: 2, failed: 1 })).toEqual({
      tone: 'warning',
      message: 'Schedule published with mixed staff notification delivery: 3 delivered, 2 pending, 1 failed.',
    });
  });

  it('surfaces retryable notification delivery as pending rather than failed', () => {
    expect(publishNotificationOutcome({ status: 'PENDING', delivered: 0, pending: 2, failed: 0 })).toEqual({
      tone: 'warning',
      message: 'Schedule published; 2 staff notifications are pending automatic delivery.',
    });
  });

  it('surfaces total notification failure after a committed publish', () => {
    expect(publishNotificationOutcome({ status: 'FAILED', delivered: 0, pending: 0, failed: 2 })).toEqual({
      tone: 'warning',
      message: 'Schedule published, but all 2 staff notifications failed.',
    });
  });

  it('keeps clean publish outcomes on the normal success path', () => {
    expect(publishNotificationOutcome({ status: 'DELIVERED', delivered: 4, pending: 0, failed: 0 })).toBeNull();
    expect(publishNotificationOutcome({ status: 'NOT_REQUIRED', delivered: 0, pending: 0, failed: 0 })).toBeNull();
  });
});
