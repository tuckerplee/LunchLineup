import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { LegacySchedulingBridge } from './legacy-scheduling.bridge';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  ALLOWED_ORIGINS: 'https://beta.lunchlineup.com',
  LEGACY_API_BASE_URL: 'http://api:3000/v1',
  JWT_SECRET: 'test-api-v2-jwt-secret',
  DEPLOY_RELEASE_SHA: 'a'.repeat(40),
  LOG_LEVEL: 'silent',
});

const identity = {
  sub: 'user-internal',
  tenantId: 'tenant-internal',
  sessionId: 'session-internal',
  role: 'MANAGER',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['schedules:publish', 'lunch_breaks:write'],
  mfaVerified: true,
  mfaRequired: true,
};

const request = {
  id: 'request-1',
  headers: {
    cookie: 'access_token=test',
    origin: 'https://beta.lunchlineup.com',
    'x-csrf-token': 'csrf-token-value',
    'user-agent': 'vitest',
  },
} as never;

const reply = { header: vi.fn() } as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('retained scheduling anti-corruption bridge', () => {
  it('keeps legacy schedule identifiers private while returning the v2 public resource', async () => {
    const transaction = {
      schedule: {
        findFirst: vi.fn(async () => ({
          id: 'legacy-schedule-1',
          publicId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
          locationId: 'legacy-location-1',
          location: { publicId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f' },
        })),
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId, operation) => operation(transaction)),
    } as never;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      scheduleId: 'legacy-schedule-1',
      totalConfiguredCost: 2,
      scheduleCost: 2,
      matchingWebhookDeliveryCount: 0,
      matchingWebhookDeliveryUnitCost: 0,
      matchingWebhookDeliveryCost: 0,
      acceptedContract: {
        version: 4,
        totalConfiguredCost: 2,
        scheduleCost: 2,
        matchingWebhookDeliveryCount: 0,
        matchingWebhookDeliveryUnitCost: 0,
        matchingWebhookDeliveryCost: 0,
      },
      availableCredits: 10,
      sufficientCredits: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const bridge = new LegacySchedulingBridge(config, database);
    const result = await bridge.publishPlan(
      identity,
      '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      request,
      reply,
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://api:3000/v1/schedules/legacy-schedule-1/publish/preflight',
    );
    expect(result.scheduleId).toBe('88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e');
    expect(JSON.stringify(result)).not.toContain('legacy-schedule-1');
  });

  it('translates break-generation scope and results in both directions', async () => {
    const transaction = {
      location: {
        findFirst: vi.fn(async () => ({
          id: 'legacy-location-1',
          publicId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        })),
      },
      shift: {
        findMany: vi.fn(async () => [{
          id: 'legacy-shift-1',
          publicId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
          user: {
            id: 'legacy-user-1',
            publicId: '8e5c1904-5376-4c28-98c8-cbbfdff467d0',
          },
        }]),
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId, operation) => operation(transaction)),
    } as never;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      locationId: 'legacy-location-1',
      source: 'shared_schedule',
      persisted: true,
      policy: {
        break1OffsetMinutes: 120,
        lunchOffsetMinutes: 240,
        break2OffsetMinutes: 360,
        break1DurationMinutes: 10,
        lunchDurationMinutes: 30,
        break2DurationMinutes: 10,
        timeStepMinutes: 5,
      },
      creditConsumption: {
        consumedCredits: 1,
        newBalance: 9,
        source: 'credits',
      },
      data: [{
        shiftId: 'legacy-shift-1',
        userId: 'legacy-user-1',
        employeeName: 'Casey',
        startTime: '2026-07-18T16:00:00.000Z',
        endTime: '2026-07-19T00:00:00.000Z',
        breaks: [],
      }],
      reused: false,
      echoedBody: init?.body,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const bridge = new LegacySchedulingBridge(config, database);
    const result = await bridge.generateBreaks(identity, {
      locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
      shiftIds: ['bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f'],
      persist: true,
    }, request, reply, 'attempt-key-1');

    const outbound = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(outbound).toEqual({
      locationId: 'legacy-location-1',
      shiftIds: ['legacy-shift-1'],
      persist: true,
    });
    expect(result.locationId).toBe('34aa4812-63f5-4e5c-8b3a-06b564987a1f');
    expect(result.data[0]).toMatchObject({
      shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
      userId: '8e5c1904-5376-4c28-98c8-cbbfdff467d0',
    });
    expect(JSON.stringify(result)).not.toContain('legacy-shift-1');
    expect(JSON.stringify(result)).not.toContain('legacy-user-1');
  });
});
