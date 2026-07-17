export const ACCOUNT_DELETION_RECEIPT_STORAGE_KEY = 'lunchlineup.account-deletion-receipt.v1';

type ReceiptStorage = Pick<Storage, 'getItem' | 'setItem'>;

type AccountDeletionRetention = {
  deletionRequestedAt?: unknown;
  applicationDataEligibleAt?: unknown;
  databaseBackupEligibleAt?: unknown;
  securityLogEligibleAt?: unknown;
  retainedDatabaseRecordsEligibleAt?: unknown;
  fullDatabasePurgeEligibleAt?: unknown;
};

export type AccountDeletionResponse = {
  deletionState?: unknown;
  billingCleanupPending?: unknown;
  deletionRequestedAt?: unknown;
  retention?: AccountDeletionRetention | null;
};

export type AccountDeletionReceipt = {
  deletionState: 'FINALIZED' | 'PENDING_BILLING_CLEANUP';
  deletionRequestedAt: string | null;
  applicationDataEligibleAt: string | null;
  databaseBackupEligibleAt: string | null;
  securityLogEligibleAt: string | null;
  fullDatabasePurgeEligibleAt: string | null;
};

type StoredAccountDeletionReceipt = {
  version: 1;
  receipt: AccountDeletionReceipt;
};

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeDeletionState(
  value: unknown,
  billingCleanupPending?: unknown,
): AccountDeletionReceipt['deletionState'] {
  if (value === 'PENDING_BILLING_CLEANUP' || billingCleanupPending === true) {
    return 'PENDING_BILLING_CLEANUP';
  }
  return 'FINALIZED';
}

function normalizeReceipt(value: unknown): AccountDeletionReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const dates = {
    deletionRequestedAt: normalizeDate(candidate.deletionRequestedAt),
    applicationDataEligibleAt: normalizeDate(candidate.applicationDataEligibleAt),
    databaseBackupEligibleAt: normalizeDate(candidate.databaseBackupEligibleAt),
    securityLogEligibleAt: normalizeDate(candidate.securityLogEligibleAt),
    fullDatabasePurgeEligibleAt: normalizeDate(candidate.fullDatabasePurgeEligibleAt),
  };

  return Object.values(dates).some(Boolean)
    ? {
      deletionState: normalizeDeletionState(candidate.deletionState),
      ...dates,
    }
    : null;
}
export function accountDeletionReceiptFromResponse(response: AccountDeletionResponse): AccountDeletionReceipt {
  const retention = response.retention ?? {};
  return {
    deletionState: normalizeDeletionState(response.deletionState, response.billingCleanupPending),
    deletionRequestedAt: normalizeDate(response.deletionRequestedAt ?? retention.deletionRequestedAt),
    applicationDataEligibleAt: normalizeDate(retention.applicationDataEligibleAt),
    databaseBackupEligibleAt: normalizeDate(retention.databaseBackupEligibleAt),
    securityLogEligibleAt: normalizeDate(retention.securityLogEligibleAt),
    fullDatabasePurgeEligibleAt: normalizeDate(
      retention.fullDatabasePurgeEligibleAt ?? retention.retainedDatabaseRecordsEligibleAt,
    ),
  };
}

export function storeAccountDeletionReceipt(storage: ReceiptStorage, receipt: AccountDeletionReceipt): void {
  const stored: StoredAccountDeletionReceipt = { version: 1, receipt };
  storage.setItem(ACCOUNT_DELETION_RECEIPT_STORAGE_KEY, JSON.stringify(stored));
}

export function readAccountDeletionReceipt(storage: ReceiptStorage): AccountDeletionReceipt | null {
  const serialized = storage.getItem(ACCOUNT_DELETION_RECEIPT_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const stored = JSON.parse(serialized) as Partial<StoredAccountDeletionReceipt>;
    return stored.version === 1 ? normalizeReceipt(stored.receipt) : null;
  } catch {
    return null;
  }
}
