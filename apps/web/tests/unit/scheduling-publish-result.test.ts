import { describe, expect, it } from 'vitest';

import { publishNotificationOutcome } from '../../app/dashboard/scheduling/publish-result';

describe('publishNotificationOutcome', () => {
  it('treats an omitted notification summary as a successful backward-compatible publish', () => {
    expect(publishNotificationOutcome(undefined)).toBeNull();
  });

  it('surfaces partial notification delivery after a committed publish', () => {
    expect(publishNotificationOutcome({ status: 'PARTIAL', delivered: 3, failed: 1 })).toEqual({
      tone: 'warning',
      message: 'Schedule published, but 1 staff notification failed. 3 delivered.',
    });
  });

  it('surfaces total notification failure after a committed publish', () => {
    expect(publishNotificationOutcome({ status: 'FAILED', delivered: 0, failed: 2 })).toEqual({
      tone: 'warning',
      message: 'Schedule published, but all 2 staff notifications failed.',
    });
  });

  it('keeps clean publish outcomes on the normal success path', () => {
    expect(publishNotificationOutcome({ status: 'DELIVERED', delivered: 4, failed: 0 })).toBeNull();
    expect(publishNotificationOutcome({ status: 'NOT_REQUIRED', delivered: 0, failed: 0 })).toBeNull();
  });
});
