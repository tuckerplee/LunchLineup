import { describe, expect, it, vi } from 'vitest';

import {
  formatInvitationDeliveryDate,
  invitationDeliveryView,
  isTerminalInvitationDelivery,
  parseInvitationDelivery,
  parseInvitationDeliveryResponse,
  stableInvitationRetryKey,
  type InvitationDeliveryStatus,
} from '../../app/dashboard/staff/invitation-delivery';

describe('staff invitation delivery public contract', () => {
  it.each([
    ['not_applicable', 'NOT_APPLICABLE', 'Not required'],
    ['queued', 'PENDING', 'Queued'],
    ['sending', 'SENDING', 'Sending'],
    ['failed', 'FAILED', 'Delivery failed'],
    ['delivered', 'DELIVERED', 'Delivered'],
    ['dead_lettered', 'DEAD_LETTERED', 'Dead-lettered'],
    ['cancelled', 'CANCELLED', 'Cancelled'],
  ] as const)('parses and labels lowercase API status %s', (publicStatus, normalizedStatus, label) => {
    const delivery = parseInvitationDeliveryResponse({
      invitationDelivery: { status: publicStatus, attempts: 2, canRetry: publicStatus === 'failed' },
    });

    expect(delivery).toMatchObject({
      status: normalizedStatus,
      attempts: 2,
      canRetry: publicStatus === 'failed',
      canReissue: false,
    });
    expect(invitationDeliveryView(delivery!).label).toBe(label);
    expect(JSON.stringify(invitationDeliveryView(delivery!)).toLowerCase()).not.toContain('credit');
  });

  it.each([
    null,
    {},
    { invitationDelivery: null },
    { invitationDelivery: { status: 'retrying', attempts: 1, canRetry: false } },
    { invitationDelivery: { status: 'queued', attempts: -1, canRetry: false } },
    { invitationDelivery: { status: 'queued', attempts: 1.5, canRetry: false } },
    { invitationDelivery: { status: 'queued', attempts: 1, canRetry: 'false' } },
    { invitationDelivery: { status: 'failed', attempts: 1, canRetry: true, nextAttemptAt: 'not-a-date' } },
    { invitationDelivery: { status: 'delivered', attempts: 1, canRetry: false, deliveredAt: 42 } },
  ])('fails closed for an unknown or malformed payload', (payload) => {
    expect(parseInvitationDeliveryResponse(payload)).toBeNull();
  });

  it('marks only completed, stopped, cancelled, and inapplicable states terminal', () => {
    const terminal: InvitationDeliveryStatus[] = [
      'NOT_APPLICABLE',
      'DELIVERED',
      'DEAD_LETTERED',
      'CANCELLED',
    ];
    const active: InvitationDeliveryStatus[] = ['PENDING', 'SENDING', 'FAILED'];

    for (const status of terminal) expect(isTerminalInvitationDelivery(status)).toBe(true);
    for (const status of active) expect(isTerminalInvitationDelivery(status)).toBe(false);
  });

  it('allows retry only when a failed response explicitly says it can retry', () => {
    expect(parseInvitationDelivery({ status: 'failed', attempts: 2, canRetry: true })?.canRetry).toBe(true);
    expect(parseInvitationDelivery({ status: 'failed', attempts: 2, canRetry: false })?.canRetry).toBe(false);
    expect(parseInvitationDelivery({ status: 'delivered', attempts: 2, canRetry: true })?.canRetry).toBe(false);
    expect(parseInvitationDelivery({ status: 'queued', attempts: 2, canRetry: true })?.canRetry).toBe(false);
  });

  it('offers a fresh reissue only for an explicitly recoverable dead letter', () => {
    const recoverable = parseInvitationDelivery({
      deliveryId: 'dead-outbox',
      status: 'dead_lettered',
      attempts: 8,
      canRetry: false,
      canReissue: true,
    });
    const legacy = parseInvitationDelivery({
      status: 'dead_lettered',
      attempts: 8,
      canRetry: false,
    });

    expect(recoverable).toMatchObject({
      deliveryId: 'dead-outbox',
      status: 'DEAD_LETTERED',
      canRetry: false,
      canReissue: true,
    });
    expect(invitationDeliveryView(recoverable!).detail).toContain('fresh delivery action');
    expect(invitationDeliveryView(recoverable!).canReissue).toBe(true);
    expect(legacy?.canReissue).toBe(false);
  });

  it('drops recipient and diagnostic fields from parsed and rendered state', () => {
    const delivery = parseInvitationDelivery({
      status: 'failed',
      attempts: 3,
      canRetry: true,
      recipient: 'private@example.com',
      lastError: 'provider diagnostic text',
      providerMessageId: 'provider-secret-id',
    });

    expect(delivery).not.toBeNull();
    const renderedState = JSON.stringify({ delivery, view: invitationDeliveryView(delivery!) });
    expect(renderedState).not.toContain('private@example.com');
    expect(renderedState).not.toContain('provider diagnostic text');
    expect(renderedState).not.toContain('provider-secret-id');
  });

  it('formats delivery dates in an explicit timezone and omits invalid labels', () => {
    expect(formatInvitationDeliveryDate('2026-07-16T14:30:00.000Z', 'en-US', 'UTC'))
      .toBe('Jul 16, 2026, 2:30 PM');
    expect(formatInvitationDeliveryDate('not-a-date', 'en-US', 'UTC')).toBeNull();

    const delivered = parseInvitationDelivery({
      status: 'delivered',
      attempts: 1,
      canRetry: false,
      deliveredAt: '2026-07-16T14:30:00.000Z',
    });
    expect(invitationDeliveryView(delivered!).detail).toContain('Jul 16, 2026');
  });

  it('reuses one retry key until an authoritative result clears the attempt', () => {
    const factory = vi.fn(() => 'retry-attempt-1');

    expect(stableInvitationRetryKey(null, factory)).toBe('retry-attempt-1');
    expect(stableInvitationRetryKey('retry-attempt-1', factory)).toBe('retry-attempt-1');
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
