import type { SessionIdentity, ScheduleChangeSetRequest } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { requestHash } from './contract-helpers';
import { ScheduleChangeSetService } from './change-set.service';

const scheduleId = '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e';
const body: ScheduleChangeSetRequest = {
  operations: [{
    op: 'shift.delete',
    shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
  }],
};
const identity: SessionIdentity = {
  sub: 'user-internal',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-internal',
  sessionId: 'session-internal',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['shifts:delete'],
  mfaVerified: true,
  mfaRequired: true,
};

const storedResponse = {
  data: {
    changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
    scheduleId,
    baseRevision: 4,
    revision: 5,
    etag: `"schedule:${scheduleId}:5"`,
    shifts: [],
    created: [],
  },
};

function replayDatabase(requestHashValue: string, response: unknown = storedResponse) {
  const transaction = {
    scheduleChangeSet: {
      findUnique: vi.fn(async () => ({
        requestHash: requestHashValue,
        response,
      })),
    },
  };
  return {
    transaction,
    database: {
      withTenant: vi.fn(async (_tenantId, operation) => operation(transaction)),
    },
  };
}

describe('schedule change-set idempotency replay', () => {
  it('returns the committed result when a reloaded board sends a newer If-Match', async () => {
    const { database, transaction } = replayDatabase(
      requestHash({ schedulePublicId: scheduleId, body }),
    );
    const service = new ScheduleChangeSetService(database as never);

    await expect(service.apply(identity, scheduleId, body, {
      ifMatch: `"schedule:${scheduleId}:99"`,
      idempotencyKey: 'response-loss-attempt-1',
    })).resolves.toEqual(storedResponse);

    expect(transaction.scheduleChangeSet.findUnique).toHaveBeenCalledTimes(1);
    expect(database.withTenant).toHaveBeenCalledWith(
      identity.tenantId,
      expect.any(Function),
      expect.objectContaining({ isolationLevel: expect.anything() }),
    );
  });

  it('rejects a reused key before evaluating a different change payload', async () => {
    const { database, transaction } = replayDatabase(
      requestHash({ schedulePublicId: scheduleId, body }),
    );
    const service = new ScheduleChangeSetService(database as never);
    const changedBody: ScheduleChangeSetRequest = {
      operations: [{
        op: 'shift.delete',
        shiftId: '2fef54b7-e51f-4301-8650-e89b9534be5c',
      }],
    };

    await expect(service.apply(identity, scheduleId, changedBody, {
      ifMatch: `"schedule:${scheduleId}:5"`,
      idempotencyKey: 'response-loss-attempt-1',
    })).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_key_reused',
    });

    expect(transaction.scheduleChangeSet.findUnique).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the exact replay record has an incomplete response', async () => {
    const { database, transaction } = replayDatabase(
      requestHash({ schedulePublicId: scheduleId, body }),
      {
        data: {
          ...storedResponse.data,
          etag: undefined,
        },
      },
    );
    const service = new ScheduleChangeSetService(database as never);

    await expect(service.apply(identity, scheduleId, body, {
      ifMatch: `"schedule:${scheduleId}:5"`,
      idempotencyKey: 'response-loss-attempt-1',
    })).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_result_unavailable',
    });

    expect(transaction.scheduleChangeSet.findUnique).toHaveBeenCalledTimes(1);
  });
});
