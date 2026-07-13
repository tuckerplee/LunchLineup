export type PublishNotificationResult = {
  status: 'DELIVERED' | 'NOT_REQUIRED' | 'PARTIAL' | 'FAILED';
  delivered: number;
  failed: number;
};

export type PublishOutcome = {
  tone: 'warning';
  message: string;
};

export function publishNotificationOutcome(result?: PublishNotificationResult | null): PublishOutcome | null {
  if (!result) return null;
  if (result.status === 'PARTIAL') {
    return {
      tone: 'warning',
      message: `Schedule published, but ${result.failed} staff notification${result.failed === 1 ? '' : 's'} failed. ${result.delivered} delivered.`,
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
