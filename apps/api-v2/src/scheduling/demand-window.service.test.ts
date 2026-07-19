import type { SessionIdentity } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { DemandWindowService } from './demand-window.service';

const scheduleId = '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e';
const demandWindowId = '831551d1-a27e-4ee7-a4f7-3f70f8916041';
const identity: SessionIdentity = {
  sub: 'user-internal',
  tenantId: 'tenant-internal',
  sessionId: 'session-internal',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['schedules:write'],
  mfaVerified: true,
  mfaRequired: true,
};

describe('demand-window public identity', () => {
  it('serializes the opaque public UUID instead of the legacy internal primary key', async () => {
    const findMany = vi.fn(async () => [{
      publicId: demandWindowId,
      startTime: new Date('2026-07-18T13:00:00.000Z'),
      endTime: new Date('2026-07-18T17:00:00.000Z'),
      requiredStaff: 3,
      skill: 'opening',
    }]);
    const transaction = {
      schedule: {
        findFirst: vi.fn(async () => ({
          id: 'demo-schedule-internal',
          locationId: 'demo-location-internal',
        })),
      },
      scheduleDemandWindow: { findMany },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId, operation) => operation(transaction)),
    };
    const service = new DemandWindowService(database as never);

    await expect(service.list(identity, scheduleId)).resolves.toEqual({
      data: [{
        id: demandWindowId,
        startTime: '2026-07-18T13:00:00.000Z',
        endTime: '2026-07-18T17:00:00.000Z',
        requiredStaff: 3,
        skill: 'opening',
      }],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ publicId: true }),
    }));
  });
});
