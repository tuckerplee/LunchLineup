import type {
  DemandWindowReplaceRequest,
  LegacyIdentity,
} from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { requestHash } from './contract-helpers';
import { DemandWindowService } from './demand-window.service';
import { ScheduleLifecycleService } from './lifecycle.service';

const scheduleId = '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e';
const identity: LegacyIdentity = {
  sub: 'user-internal',
  tenantId: 'tenant-internal',
  sessionId: 'session-internal',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['schedules:write', 'schedules:publish'],
  mfaVerified: true,
  mfaRequired: true,
};

function replayDatabase(response: unknown, hash: string) {
  const transaction = {
    scheduleChangeSet: {
      findUnique: vi.fn(async () => ({
        requestHash: hash,
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

describe('schedule mutation idempotency replay', () => {
  it('replays a demand replacement after the board has a newer ETag', async () => {
    const body: DemandWindowReplaceRequest = { windows: [] };
    const storedResponse = {
      data: [],
      changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
      scheduleId,
      baseRevision: 4,
      revision: 5,
      etag: `"schedule:${scheduleId}:5"`,
    };
    const { database, transaction } = replayDatabase(
      storedResponse,
      requestHash({
        operation: 'demand-windows.replace',
        schedulePublicId: scheduleId,
        body,
      }),
    );
    const service = new DemandWindowService(database as never);

    await expect(service.replace(identity, scheduleId, body, {
      ifMatch: `"schedule:${scheduleId}:99"`,
      idempotencyKey: 'response-loss-demand-1',
    })).resolves.toEqual(storedResponse);

    expect(transaction.scheduleChangeSet.findUnique).toHaveBeenCalledTimes(1);
  });

  it('replays a reopening after the board has a newer ETag', async () => {
    const storedResponse = {
      data: {
        id: scheduleId,
        locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        startDate: '2026-07-13T07:00:00.000Z',
        endDate: '2026-07-20T07:00:00.000Z',
        status: 'DRAFT',
        publishedAt: null,
        revision: 5,
        etag: `"schedule:${scheduleId}:5"`,
      },
    };
    const { database, transaction } = replayDatabase(
      storedResponse,
      requestHash({
        operation: 'schedule.reopen',
        schedulePublicId: scheduleId,
      }),
    );
    const service = new ScheduleLifecycleService(database as never);

    await expect(service.reopen(identity, scheduleId, {
      ifMatch: `"schedule:${scheduleId}:99"`,
      idempotencyKey: 'response-loss-reopen-1',
    })).resolves.toEqual(storedResponse);

    expect(transaction.scheduleChangeSet.findUnique).toHaveBeenCalledTimes(1);
  });
});
