export type PublishNotificationResult = {
  status: 'DELIVERED' | 'NOT_REQUIRED' | 'PENDING' | 'PARTIAL' | 'FAILED';
  delivered: number;
  pending: number;
  failed: number;
};

export type PublishOutcome = {
  tone: 'warning';
  message: string;
};

export function publishNotificationOutcome(result?: PublishNotificationResult | null): PublishOutcome | null {
  if (!result) return null;
  if (result.status === 'PENDING') {
    return {
      tone: 'warning',
      message: `Schedule published; ${result.pending} staff notification${result.pending === 1 ? ' is' : 's are'} pending automatic delivery.`,
    };
  }
  if (result.status === 'PARTIAL') {
    const details = [
      `${result.delivered} delivered`,
      result.pending > 0 ? `${result.pending} pending` : null,
      result.failed > 0 ? `${result.failed} failed` : null,
    ].filter((detail): detail is string => Boolean(detail));
    return {
      tone: 'warning',
      message: `Schedule published with mixed staff notification delivery: ${details.join(', ')}.`,
    };
  }
  if (result.status === 'FAILED') {
    return {
      tone: 'warning',
      message: `Schedule published, but all ${result.failed} staff notification${result.failed === 1 ? '' : 's'} failed.`,
    };
  }
  return null;
}
