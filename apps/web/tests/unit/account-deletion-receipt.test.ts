import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETION_RECEIPT_STORAGE_KEY,
  accountDeletionReceiptFromResponse,
  readAccountDeletionReceipt,
  storeAccountDeletionReceipt,
} from '../../app/auth/account-deleted/account-deletion-receipt';

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, nextValue: string) => {
      value = nextValue;
    }),
  };
}

describe('account deletion receipt', () => {
  it('keeps only normalized retention dates from the DELETE response', () => {
    const response = {
      id: 'tenant-secret-id',
      slug: 'private-workspace',
      token: 'secret-token',
      deletionRequestedAt: '2026-07-13T12:00:00-07:00',
      retention: {
        applicationDataEligibleAt: '2026-08-12T19:00:00.000Z',
        databaseBackupEligibleAt: '2026-08-17T19:00:00.000Z',
        securityLogEligibleAt: '2026-10-11T19:00:00.000Z',
        retainedDatabaseRecordsEligibleAt: '2033-07-13T19:00:00.000Z',
      },
    };

    const receipt = accountDeletionReceiptFromResponse(response);

    expect(receipt).toEqual({
      deletionState: 'FINALIZED',
      deletionRequestedAt: '2026-07-13T19:00:00.000Z',
      applicationDataEligibleAt: '2026-08-12T19:00:00.000Z',
      databaseBackupEligibleAt: '2026-08-17T19:00:00.000Z',
      securityLogEligibleAt: '2026-10-11T19:00:00.000Z',
      fullDatabasePurgeEligibleAt: '2033-07-13T19:00:00.000Z',
    });
    expect(JSON.stringify(receipt)).not.toMatch(/tenant-secret-id|private-workspace|secret-token/);
  });

  it('preserves a pending billing-cleanup acknowledgement without external error details', () => {
    const receipt = accountDeletionReceiptFromResponse({
      deletionState: 'PENDING_BILLING_CLEANUP',
      billingCleanupPending: true,
      deletionRequestedAt: '2026-07-13T19:00:00.000Z',
      retention: {
        applicationDataEligibleAt: '2026-08-12T19:00:00.000Z',
      },
    });

    expect(receipt).toMatchObject({
      deletionState: 'PENDING_BILLING_CLEANUP',
      deletionRequestedAt: '2026-07-13T19:00:00.000Z',
      applicationDataEligibleAt: '2026-08-12T19:00:00.000Z',
    });
    expect(JSON.stringify(receipt)).not.toMatch(/stripe|error|tenant/i);
  });
  it('round-trips a versioned tab receipt and rejects malformed storage', () => {
    const storage = memoryStorage();
    const receipt = accountDeletionReceiptFromResponse({
      deletionRequestedAt: '2026-07-13T19:00:00.000Z',
      retention: { fullDatabasePurgeEligibleAt: '2033-07-13T19:00:00.000Z' },
    });

    storeAccountDeletionReceipt(storage, receipt);

    expect(storage.setItem).toHaveBeenCalledWith(
      ACCOUNT_DELETION_RECEIPT_STORAGE_KEY,
      expect.stringContaining('2033-07-13T19:00:00.000Z'),
    );
    expect(readAccountDeletionReceipt(storage)).toEqual(receipt);
    expect(readAccountDeletionReceipt(memoryStorage('{not-json'))).toBeNull();
    expect(readAccountDeletionReceipt(memoryStorage(JSON.stringify({ version: 2, receipt })))).toBeNull();
  });
});
