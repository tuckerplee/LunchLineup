import type { ApplicationApiOperation, SessionIdentity } from '@lunchlineup/api-contract';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { LocationIdentifierTranslator } from '../locations/identifier-translation';
import { PeopleIdentifierTranslator } from '../people/identifier-translation';
import { ProblemError } from './problem';
import { RetainedApplicationBridge } from './retained-application.bridge';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  LEGACY_API_BASE_URL: 'http://api:3000/v1',
  JWT_SECRET: 'test-api-v2-jwt-secret',
  LOG_LEVEL: 'silent',
});

function operation(
  overrides: Partial<ApplicationApiOperation> = {},
): ApplicationApiOperation {
  return {
    operationId: 'updateGeneralSettings',
    method: 'PUT',
    path: '/settings/general',
    tag: 'Settings',
    summary: 'Replace general workspace settings',
    ...overrides,
  };
}

function request(
  url = '/v2/settings/general?mode=full',
  body: unknown = { name: 'Diner' },
): FastifyRequest {
  return {
    id: 'request-1',
    method: 'PUT',
    ip: '203.0.113.8',
    url,
    raw: { url },
    body,
    headers: {
      accept: 'application/json',
      cookie: 'access_token=session',
      'content-type': 'application/json',
      origin: 'https://beta.lunchlineup.com',
      'x-csrf-token': 'abcdefghijklmnop',
      'x-forwarded-for': '198.51.100.99',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      host: 'evil.example',
      'idempotency-key': 'request-key',
    },
  } as unknown as FastifyRequest;
}

function reply() {
  const target = {
    code: vi.fn(),
    header: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
  };
  target.code.mockReturnValue(target);
  target.header.mockReturnValue(target);
  target.type.mockReturnValue(target);
  target.send.mockReturnValue(target);
  return target as unknown as FastifyReply & typeof target;
}

const identity: SessionIdentity = {
  sub: 'user-1',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-1', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['locations:read', 'time_cards:write'],
  mfaVerified: true,
  mfaRequired: false,
};

const publicLocationId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';
const internalLocationId = 'location-storage-1';
const publicUserId = 'f6776d21-bb21-4c35-a6ed-5da8df5ed238';
const internalUserId = 'user-storage-1';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retained application compatibility bridge', () => {
  it('calls only the fixed retained API base with bounded forwarded headers and JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await new RetainedApplicationBridge(config).execute({
      operation: operation(),
      request: request(),
      reply: reply(),
    });

    expect(response).toEqual({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe('http://api:3000/v1/settings/general?mode=full');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify({ name: 'Diner' }));
    const headers = new Headers(init.headers);
    expect(headers.get('host')).toBeNull();
    expect(headers.get('x-forwarded-host')).toBe('beta.lunchlineup.com');
    expect(headers.get('x-forwarded-proto')).toBe('https');
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.8');
    expect(headers.get('x-csrf-token')).toBe('abcdefghijklmnop');
  });

  it('translates retained errors to bounded Problem Details extensions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'SETUP_SHIFTS_CONFLICT',
      message: 'The saved request conflicts with this payload.',
      remediation: 'Retry the unchanged request or create a new attempt.',
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(new RetainedApplicationBridge(config).execute({
      operation: operation({
        operationId: 'importLunchBreakShifts',
        method: 'POST',
        path: '/lunch-breaks/setup-shifts',
        tag: 'Operations',
      }),
      request: request('/v2/lunch-breaks/setup-shifts'),
      reply: reply(),
    })).rejects.toMatchObject<Partial<ProblemError>>({
      status: 409,
      code: 'resource_conflict',
      message: 'The saved request conflicts with this payload.',
      extensions: {
        legacyCode: 'SETUP_SHIFTS_CONFLICT',
        remediation: 'Retry the unchanged request or create a new attempt.',
      },
    });
  });

  it('translates declared retained location references only after native identity binding', async () => {
    const resolver = {
      resolvePublicIds: vi.fn(async () => new Map([[publicLocationId, internalLocationId]])),
      resolveInternalIds: vi.fn(async () => new Map([[internalLocationId, publicLocationId]])),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ locationId: internalLocationId }],
      unrelatedId: internalLocationId,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await new RetainedApplicationBridge(
      config,
      new LocationIdentifierTranslator(resolver),
    ).execute({
      operation: operation({
        operationId: 'clockIn',
        method: 'POST',
        path: '/time-cards/clock-in',
        tag: 'Time',
      }),
      request: request(
        `/v2/time-cards/clock-in?locationId=${publicLocationId}`,
        { locationId: publicLocationId, id: publicLocationId },
      ),
      reply: reply(),
      identity,
    });

    expect(response).toEqual({
      data: [{ locationId: publicLocationId }],
      unrelatedId: internalLocationId,
    });
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe(`http://api:3000/v1/time-cards/clock-in?locationId=${internalLocationId}`);
    expect(JSON.parse(String(init.body))).toEqual({ locationId: internalLocationId, id: publicLocationId });
    expect(resolver.resolvePublicIds).toHaveBeenCalledWith('tenant-1', [publicLocationId]);
    expect(resolver.resolveInternalIds).toHaveBeenCalledWith('tenant-1', [internalLocationId]);
  });

  it('composes narrow location and people translators without exposing either storage key', async () => {
    const locationResolver = {
      resolvePublicIds: vi.fn(async () => new Map([[publicLocationId, internalLocationId]])),
      resolveInternalIds: vi.fn(async () => new Map([[internalLocationId, publicLocationId]])),
    };
    const peopleResolver = {
      resolvePublicUserIds: vi.fn(async () => new Map([[publicUserId, internalUserId]])),
      resolveInternalUserIds: vi.fn(async () => new Map([[internalUserId, publicUserId]])),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      locationId: internalLocationId,
      userId: internalUserId,
      id: internalUserId,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await new RetainedApplicationBridge(config, [
      new LocationIdentifierTranslator(locationResolver),
      new PeopleIdentifierTranslator(peopleResolver),
    ]).execute({
      operation: operation({
        operationId: 'clockIn',
        method: 'POST',
        path: '/time-cards/clock-in',
        tag: 'Time',
      }),
      request: request(
        `/v2/time-cards/clock-in?locationId=${publicLocationId}&userId=${publicUserId}`,
        { locationId: publicLocationId, userId: publicUserId, id: publicUserId },
      ),
      reply: reply(),
      identity,
    });

    expect(response).toEqual({
      locationId: publicLocationId,
      userId: publicUserId,
      id: internalUserId,
    });
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe(`http://api:3000/v1/time-cards/clock-in?locationId=${internalLocationId}&userId=${internalUserId}`);
    expect(JSON.parse(String(init.body))).toEqual({
      locationId: internalLocationId,
      userId: internalUserId,
      id: publicUserId,
    });
  });

  it('rejects traversal and oversized retained responses', async () => {
    const bridge = new RetainedApplicationBridge(config);
    await expect(bridge.execute({
      operation: operation(),
      request: request('/v2/admin/health'),
      reply: reply(),
    })).rejects.toThrow('Invalid API-v2 compatibility operation.');
    await expect(bridge.execute({
      operation: operation(),
      request: request('/v2/users/%2e%2e/admin'),
      reply: reply(),
    })).rejects.toThrow('Invalid API-v2 compatibility target.');
    await expect(bridge.execute({
      operation: operation(),
      request: request('/v2/users/user%2Fadmin'),
      reply: reply(),
    })).rejects.toThrow('Invalid API-v2 compatibility target.');
    await expect(bridge.execute({
      operation: operation(),
      request: request('/v2/users/%00'),
      reply: reply(),
    })).rejects.toThrow('Invalid API-v2 compatibility target.');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(2 * 1024 * 1024 + 1),
      },
    })));
    await expect(bridge.execute({
      operation: operation(),
      request: request(),
      reply: reply(),
    })).rejects.toMatchObject({ status: 502, code: 'invalid_compatibility_response' });
  });
});
