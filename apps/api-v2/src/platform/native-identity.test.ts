import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { NativeIdentityAdapter, type MfaSessionStore } from './native-identity';
import { ProblemError } from './problem';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  LEGACY_API_BASE_URL: 'http://api:3000/v1',
  JWT_SECRET: 'test-api-v2-jwt-secret',
  COOKIE_SECURE: 'false',
  LOG_LEVEL: 'silent',
});

type FixtureOptions = {
  permissions?: string[];
  mfaEnabled?: boolean;
  pinResetRequired?: boolean;
  revokedAt?: Date | null;
  tenantStatus?: string;
};

function signedAccessToken(): string {
  return jwt.sign({
    sub: 'user-1',
    tenantId: 'tenant-1',
    role: 'MANAGER',
    legacyRole: 'MANAGER',
    sessionId: 'session-1',
    mfaVerified: false,
    pinResetRequired: false,
  }, config.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: '30m',
    issuer: 'lunchlineup',
    audience: 'lunchlineup-api',
  });
}

function request(token = signedAccessToken(), authorization?: string): FastifyRequest {
  return {
    id: 'request-1',
    headers: authorization === undefined ? {} : { authorization },
    cookies: { access_token: token },
  } as unknown as FastifyRequest;
}

function reply(): FastifyReply {
  return { setCookie: vi.fn() } as unknown as FastifyReply;
}

function fixture(options: FixtureOptions = {}) {
  const permissions = options.permissions ?? ['locations:read', 'schedules:read'];
  const transaction = {
    session: {
      findFirst: vi.fn(async () => ({
        id: 'session-1',
        userId: 'user-1',
        createdAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: options.revokedAt ?? null,
        user: {
          id: 'user-1',
          publicId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
          tenantId: 'tenant-1',
          email: 'manager@example.com',
          username: 'manager',
          name: 'Manager One',
          role: 'MANAGER',
          mfaEnabled: options.mfaEnabled ?? false,
          pinResetRequired: options.pinResetRequired ?? false,
          deletedAt: null,
          suspendedAt: null,
          tenant: {
            name: 'Demo',
            status: options.tenantStatus ?? 'ACTIVE',
            deletedAt: null,
          },
        },
      })),
    },
    tenantSetting: {
      findUnique: vi.fn(async () => ({ value: { security: { sessionTimeoutMinutes: 480 } } })),
    },
    roleAssignment: {
      findMany: vi.fn(async () => [{
        role: {
          id: 'role-manager',
          name: 'Manager',
          isSystem: true,
          legacyRole: 'MANAGER',
          rolePermissions: permissions.map((key) => ({ permission: { key } })),
        },
      }]),
    },
  };
  const database = {
    withTenant: vi.fn(async (tenantId: string, operation: (value: typeof transaction) => unknown) => {
      expect(tenantId).toBe('tenant-1');
      return operation(transaction);
    }),
  };
  const mfaSessions: MfaSessionStore = { isVerified: vi.fn(async () => true) };
  return { transaction, database, mfaSessions };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('native API v2 identity', () => {
  it('validates a cookie session directly without calling the retained identity endpoint', async () => {
    const { database, mfaSessions } = fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);
    const response = reply();

    await expect(adapter.authenticate(request(), response)).resolves.toEqual({
      sub: 'user-1',
      publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      role: 'Manager',
      legacyRole: 'MANAGER',
      roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
      permissions: ['locations:read', 'schedules:read'],
      email: 'manager@example.com',
      username: 'manager',
      name: 'Manager One',
      tenantName: 'Demo',
      mfaRequired: false,
      mfaVerified: true,
      pinResetRequired: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mfaSessions.isVerified).not.toHaveBeenCalled();
    expect((response.setCookie as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'access_token',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict', maxAge: expect.any(Number) }),
    );
  });

  it('uses the shared privileged-permission policy and MFA session marker', async () => {
    const { database, mfaSessions } = fixture({ permissions: ['settings:write'] });
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

    await expect(adapter.authenticate(request(), reply())).resolves.toMatchObject({
      permissions: ['settings:write'],
      mfaRequired: true,
      mfaVerified: true,
    });
    expect(mfaSessions.isVerified).toHaveBeenCalledOnce();
    expect(mfaSessions.isVerified).toHaveBeenCalledWith('session-1');
  });

  it('derives forced PIN rotation from live session state rather than token claims', async () => {
    const { database, mfaSessions } = fixture({ pinResetRequired: true });
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

    await expect(adapter.authenticate(request(), reply())).resolves.toMatchObject({
      pinResetRequired: true,
    });
  });

  it('fails closed when tenant session state or MFA state is unavailable', async () => {
    const revoked = fixture({ revokedAt: new Date() });
    const revokedAdapter = new NativeIdentityAdapter(config, revoked.database as never, revoked.mfaSessions);
    await expect(revokedAdapter.authenticate(request(), reply())).rejects.toMatchObject<Partial<ProblemError>>({
      status: 401,
      code: 'authentication_required',
    });

    const mfaUnavailable = fixture({ mfaEnabled: true });
    mfaUnavailable.mfaSessions.isVerified = vi.fn(async () => {
      throw new Error('redis down');
    });
    const unavailableAdapter = new NativeIdentityAdapter(
      config,
      mfaUnavailable.database as never,
      mfaUnavailable.mfaSessions,
    );
    await expect(unavailableAdapter.authenticate(request(), reply())).rejects.toMatchObject<Partial<ProblemError>>({
      status: 503,
      code: 'identity_service_unavailable',
    });
  });

  it('does not fall back to a cookie when an Authorization header is malformed', async () => {
    const { database, mfaSessions } = fixture();
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

    await expect(adapter.authenticate(request(undefined, 'Basic stale'), reply())).rejects.toMatchObject<Partial<ProblemError>>({
      status: 401,
      code: 'authentication_required',
    });
    expect(database.withTenant).not.toHaveBeenCalled();
  });
});
