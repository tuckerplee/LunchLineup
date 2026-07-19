import { Value } from '@sinclair/typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  LegacyIdentitySchema,
  ProblemDetailsSchema,
  ScheduleChangeSetRequestSchema,
  createApiV2Client,
} from './index';

describe('API v2 scheduling contract', () => {
  it('requires semantic change operations instead of person-specific paths', () => {
    expect(Value.Check(ScheduleChangeSetRequestSchema, {
      operations: [{
        op: 'shift.update',
        shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        userId: '8e5c1904-5376-4c28-98c8-cbbfdff467d0',
        startTime: '2026-07-18T17:00:00.000Z',
        endTime: '2026-07-19T01:00:00.000Z',
      }],
    })).toBe(true);
  });

  it('rejects empty or untyped change sets', () => {
    expect(Value.Check(ScheduleChangeSetRequestSchema, { operations: [] })).toBe(false);
    expect(Value.Check(ScheduleChangeSetRequestSchema, {
      operations: [{ shiftId: 'casey' }],
    })).toBe(false);
    expect(Value.Check(ScheduleChangeSetRequestSchema, {
      operations: [{
        op: 'shift.delete',
        shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        personSlug: 'casey',
      }],
    })).toBe(false);
  });

  it('models RFC 9457 problem details with stable machine codes', () => {
    expect(Value.Check(ProblemDetailsSchema, {
      type: 'https://lunchlineup.com/problems/schedule-overlap',
      title: 'Schedule overlap',
      status: 422,
      detail: 'The requested final schedule contains overlapping shifts.',
      code: 'schedule_overlap',
      violations: [{
        pointer: '/operations/0',
        code: 'shift_overlap',
        message: 'The staff member already has an overlapping shift.',
      }],
    })).toBe(true);
  });

  it('matches the structured RBAC roles returned by the live identity boundary', () => {
    expect(Value.Check(LegacyIdentitySchema, {
      sub: 'user-internal',
      tenantId: 'tenant-internal',
      sessionId: 'session-internal',
      role: 'Manager',
      legacyRole: 'MANAGER',
      roles: [{
        id: 'role-manager',
        name: 'Manager',
        isSystem: true,
        legacyRole: 'MANAGER',
      }],
      permissions: ['dashboard:access', 'schedules:read'],
      mfaVerified: true,
      mfaRequired: true,
    })).toBe(true);
  });

  it('generates one aggregate endpoint call with concurrency and idempotency headers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: {
        changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
        scheduleId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
        baseRevision: 4,
        revision: 5,
        etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
        shifts: [],
        created: [],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = createApiV2Client({ fetch: fetcher });
    await client.applyScheduleChangeSet(
      '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      {
        operations: [{
          op: 'shift.delete',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        }],
      },
      '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0];
    expect(path).toBe('/api/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets');
    expect(new Headers(init?.headers).get('if-match')).toContain(':4');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('4daaf25a-92d7-4fba-975c-f54e4ce15c4a');
  });
});
