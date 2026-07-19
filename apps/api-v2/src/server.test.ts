import type { LegacyIdentity } from '@lunchlineup/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { ProblemError } from './platform/problem';
import { buildServer } from './server';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  ALLOWED_ORIGINS: 'https://beta.lunchlineup.com',
  LEGACY_IDENTITY_URL: 'http://api:3000/v1/auth/me',
  DEPLOY_RELEASE_SHA: 'a'.repeat(40),
  LOG_LEVEL: 'silent',
});

const identity: LegacyIdentity = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  role: 'MANAGER',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: [
    'locations:read',
    'schedules:read',
    'schedules:write',
    'schedules:publish',
    'shifts:read',
    'shifts:write',
    'shifts:delete',
    'lunch_breaks:write',
  ],
  mfaVerified: true,
  mfaRequired: true,
};

const apps: Array<Awaited<ReturnType<typeof buildServer>>> = [];

async function harness() {
  const board = vi.fn(async () => ({
    data: {
      permissions: identity.permissions,
      locations: [],
      locationsTruncated: false,
      selectedLocationId: null,
      staff: [],
      schedules: [],
      shifts: [],
      range: {
        start: '2026-07-18T00:00:00.000Z',
        end: '2026-07-19T00:00:00.000Z',
      },
    },
    meta: { generatedAt: '2026-07-18T00:00:00.000Z' },
  }));
  const apply = vi.fn(async () => ({
    data: {
      changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
      scheduleId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      baseRevision: 4,
      revision: 5,
      etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
      shifts: [],
      created: [],
    },
  }));
  const demandList = vi.fn(async () => ({ data: [] }));
  const demandReplace = vi.fn(async () => ({
    data: [],
    changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
    scheduleId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
    baseRevision: 4,
    revision: 5,
    etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
  }));
  const reopen = vi.fn(async () => ({
    data: {
      id: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
      startDate: '2026-07-18T00:00:00.000Z',
      endDate: '2026-07-19T00:00:00.000Z',
      status: 'DRAFT' as const,
      publishedAt: null,
      revision: 5,
      etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
    },
  }));
  const app = await buildServer(config, {
    database: {
      ready: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    } as never,
    identity: {
      authenticate: vi.fn(async () => identity),
    } as never,
    routes: {
      board: { get: board },
      scheduleCreate: {
        create: vi.fn(async () => {
          throw new Error('unused');
        }),
      },
      changeSets: { apply },
      demandWindows: { list: demandList, replace: demandReplace },
      lifecycle: { reopen },
      retainedScheduling: {
        publishPlan: vi.fn(async () => { throw new Error('unused'); }),
        publish: vi.fn(async () => { throw new Error('unused'); }),
        startSolve: vi.fn(async () => { throw new Error('unused'); }),
        solveJob: vi.fn(async () => { throw new Error('unused'); }),
        generateBreaks: vi.fn(async () => { throw new Error('unused'); }),
      },
    },
  });
  apps.push(app);
  return { app, board, apply, demandList, demandReplace, reopen };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API v2 HTTP contract', () => {
  it('publishes an OpenAPI 3.1 document with aggregate schedule operations', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/v2/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v2/schedules/{scheduleId}/change-sets'].post.operationId).toBe('applyScheduleChangeSet');
    expect(document.paths['/v2/schedule-board'].get.operationId).toBe('getScheduleBoard');
    expect(document.paths['/v2/locations/{locationId}/schedules'].post.operationId).toBe('createDraftSchedule');
    expect(document.paths['/v2/schedules/{scheduleId}/demand-windows'].put.operationId).toBe('replaceScheduleDemandWindows');
    expect(document.paths['/v2/schedules/{scheduleId}/publications'].post.operationId).toBe('publishSchedule');
    expect(document.paths['/v2/schedules/{scheduleId}/reopenings'].post.operationId).toBe('reopenSchedule');
    expect(document.paths['/v2/schedules/{scheduleId}/solve-jobs'].post.operationId).toBe('startScheduleSolve');
    expect(document.paths['/v2/break-generations'].post.operationId).toBe('generateScheduleBreaks');
    expect(JSON.stringify(document.paths)).not.toContain('/shifts/{person');
    expect(JSON.stringify(document.paths)).not.toContain('demo-shift');
  });

  it('loads one screen-oriented board request', async () => {
    const { app, board } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/schedule-board?date=2026-07-18&view=day',
    });
    expect(response.statusCode).toBe(200);
    expect(board).toHaveBeenCalledTimes(1);
    expect(response.headers['x-lunchlineup-api-version']).toBe('2');
  });

  it('requires same-origin CSRF proof for cookie-authenticated writes', async () => {
    const { app, apply } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: {
        operations: [{
          op: 'shift.delete',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('origin_not_allowed');
    expect(apply).not.toHaveBeenCalled();
  });

  it('preserves every discriminated change operation during HTTP validation', async () => {
    const { app, apply } = await harness();
    const operations = [
      {
        op: 'shift.create',
        clientId: '37ea171d-4e93-4c2c-931d-9c540f00bb98',
        userId: null,
        startTime: '2026-07-18T08:00:00.000Z',
        endTime: '2026-07-18T12:00:00.000Z',
        role: 'STAFF',
      },
      {
        op: 'shift.update',
        shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        userId: 'f241cd2b-c1be-4a3f-a8e7-bbf2aec70417',
        startTime: '2026-07-18T16:00:00.000Z',
        endTime: '2026-07-19T00:15:00.000Z',
        role: 'STAFF',
      },
      {
        op: 'shift.delete',
        shiftId: '2fef54b7-e51f-4301-8650-e89b9534be5c',
      },
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: { operations },
    });

    expect(response.statusCode).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[2]).toEqual({ operations });

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '250c2b7c-8418-4191-9413-21f08723fda8',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
      },
      payload: {
        operations: [{
          op: 'shift.update',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
          unexpected: true,
        }],
      },
    });

    expect(invalidResponse.statusCode).toBe(422);
    expect(invalidResponse.json()).toMatchObject({ code: 'contract_validation_failed' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('returns machine-readable stale revision details', async () => {
    const { app, apply } = await harness();
    apply.mockRejectedValueOnce(new ProblemError(
      412,
      'stale_schedule_revision',
      'The schedule changed after this board loaded. Reload before saving.',
      'Precondition failed',
      undefined,
      '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:6"',
    ));
    const response = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: {
        operations: [{
          op: 'shift.delete',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        }],
      },
    });
    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      code: 'stale_schedule_revision',
      currentEtag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:6"',
    });
  });

  it('replaces demand through the aggregate schedule resource with ETag and idempotency', async () => {
    const { app, demandReplace } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/demand-windows',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: { windows: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toContain(':5');
    expect(demandReplace).toHaveBeenCalledWith(
      identity,
      '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      { windows: [] },
      expect.objectContaining({
        idempotencyKey: '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        ifMatch: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      }),
      expect.any(Object),
    );
  });
});
