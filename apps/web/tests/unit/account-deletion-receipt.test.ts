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
      deletionState: 'FINALIZED',
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
      deletionState: 'FINALIZED',
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

it('does not manufacture a finalized receipt from an empty response', () => {
  expect(() => accountDeletionReceiptFromResponse({})).toThrow('not been confirmed');
});

it.each([
  { deletionState: 'UNKNOWN', deletionRequestedAt: '2026-07-13T19:00:00.000Z' },
  { deletionRequestedAt: '2026-07-13T19:00:00.000Z' },
  { deletionState: 'FINALIZED', applicationDataEligibleAt: '2026-08-12T19:00:00.000Z' },
  { deletionState: 'PENDING_BILLING_CLEANUP', deletionRequestedAt: 'invalid', securityLogEligibleAt: '2026-10-11T19:00:00.000Z' },
])('rejects a version-one cached receipt lacking explicit state and request time: %j', receipt => {
  expect(readAccountDeletionReceipt(memoryStorage(JSON.stringify({ version: 1, receipt })))).toBeNull();
});

it('round-trips a pending cached receipt without promoting it to finalized', () => {
  const receipt = accountDeletionReceiptFromResponse({
    deletionState: 'PENDING_BILLING_CLEANUP', deletionRequestedAt: '2026-07-13T19:00:00.000Z',
  });
  const storage = memoryStorage(); storeAccountDeletionReceipt(storage, receipt);
  expect(readAccountDeletionReceipt(storage)).toEqual(receipt);
});
