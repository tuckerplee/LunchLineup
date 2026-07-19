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
  tenantId: 'tenant-internal',
  sessionId: 'session-internal',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['shifts:delete'],
  mfaVerified: true,
  mfaRequired: true,
};

describe('schedule change-set idempotency replay', () => {
  it('returns the committed result when a reloaded board sends a newer If-Match', async () => {
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
    const transaction = {
      scheduleChangeSet: {
        findUnique: vi.fn(async () => ({
          requestHash: requestHash({ schedulePublicId: scheduleId, body }),
          response: storedResponse,
        })),
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId, operation) => operation(transaction)),
    };
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
});
