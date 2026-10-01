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
  requireMfaForAll?: boolean;
  mfaVerified?: boolean;
  pinResetRequired?: boolean;
  revokedAt?: Date | null;
  tenantStatus?: string;
};

function signedAccessToken(mfaVerified = false): string {
  return jwt.sign({
    sub: 'user-1',
    tenantId: 'tenant-1',
    role: 'MANAGER',
    legacyRole: 'MANAGER',
    sessionId: 'session-1',
    mfaVerified,
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
    method: 'GET',
    url: '/v2/auth/me',
    headers: authorization === undefined ? {} : { authorization },
    cookies: { access_token: token },
  } as unknown as FastifyRequest;
}

function operationRequest(method: string, url: string, credential: 'cookie' | 'bearer', token = signedAccessToken()): FastifyRequest {
  return {
    ...request(token, credential === 'bearer' ? `Bearer ${token}` : undefined),
    method,
    url,
    cookies: credential === 'cookie' ? { access_token: token } : {},
  } as FastifyRequest;
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
      findUnique: vi.fn(async () => ({ value: { security: {
        sessionTimeoutMinutes: 480,
        requireMfaForAll: options.requireMfaForAll ?? false,
      } } })),
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
  const mfaSessions: MfaSessionStore = { isVerified: vi.fn(async () => options.mfaVerified ?? true) };
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

  describe.each(['cookie', 'bearer'] as const)('%s session boundaries', (credential) => {
    it.each([
      ['GET', '/v2/settings'],
      ['PUT', '/v2/settings/security'],
      ['GET', '/v2/payroll/periods'],
      ['POST', '/v2/payroll/periods'],
      ['GET', '/v2/notifications'],
      ['PUT', '/v2/users/me/pin'],
      ['DELETE', '/v2/auth/mfa/enrollment'],
      ['POST', '/v2/auth/mfa/disable'],
      ['GET', '/v2/auth/mfa/verify'],
      ['POST', '/v2/auth/me'],
      ['GET', '/v2/auth/me/extra'],
      ['POST', '/v2/auth/mfa/enrollment/extra'],
    ])('rejects pending MFA for %s %s before rotating a cookie', async (method, url) => {
      const { database, mfaSessions } = fixture({ permissions: ['settings:write'], mfaVerified: false });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);
      const response = reply();

      await expect(adapter.authenticate(operationRequest(method, url, credential), response))
        .rejects.toMatchObject({ status: 403, code: 'mfa_verification_required' });
      expect(response.setCookie).not.toHaveBeenCalled();
    });

    it.each([
      ['GET', '/v2/auth/me'],
      ['POST', '/v2/auth/refresh'],
      ['POST', '/v2/auth/logout'],
      ['POST', '/v2/auth/mfa/verify'],
      ['GET', '/v2/auth/mfa/enrollment'],
      ['POST', '/v2/auth/mfa/enrollment'],
      ['PUT', '/v2/auth/mfa/enrollment'],
      ['POST', '/v2/auth/mfa/enroll'],
      ['POST', '/v2/auth/mfa/enroll/confirm'],
    ])('allows pending MFA recovery through %s %s with a query string', async (method, url) => {
      const { database, mfaSessions } = fixture({ mfaEnabled: true, mfaVerified: false });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);
      const response = reply();

      await expect(adapter.authenticate(operationRequest(method, `${url}?source=recovery`, credential), response))
        .resolves.toMatchObject({ mfaRequired: true, mfaVerified: false });
      if (credential === 'cookie') {
        expect(response.setCookie).toHaveBeenCalledOnce();
        const rotatedToken = vi.mocked(response.setCookie).mock.calls[0][1];
        expect(jwt.verify(rotatedToken, config.jwtSecret)).toMatchObject({ mfaVerified: false });
      } else {
        expect(response.setCookie).not.toHaveBeenCalled();
      }
    });

    it.each([
      { permissions: ['settings:write'] },
      { mfaEnabled: true },
      { requireMfaForAll: true },
    ])('requires live MFA for %j regardless of a verified token claim', async (options) => {
      const { database, mfaSessions } = fixture({ ...options, mfaVerified: false });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

      await expect(adapter.authenticate(operationRequest('GET', '/v2/notifications', credential, signedAccessToken(true)), reply()))
        .rejects.toMatchObject({ status: 403, code: 'mfa_verification_required' });
    });

    it('allows protected operations after the session MFA marker is verified', async () => {
      const { database, mfaSessions } = fixture({ permissions: ['payroll:read'], mfaVerified: true });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

      await expect(adapter.authenticate(operationRequest('GET', '/v2/payroll/periods', credential), reply()))
        .resolves.toMatchObject({ mfaRequired: true, mfaVerified: true });
    });

    it('allows protected operations when live policy does not require MFA', async () => {
      const { database, mfaSessions } = fixture({ mfaVerified: false });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

      await expect(adapter.authenticate(operationRequest('GET', '/v2/notifications', credential), reply()))
        .resolves.toMatchObject({ mfaRequired: false, mfaVerified: true });
      expect(mfaSessions.isVerified).not.toHaveBeenCalled();
    });

    it.each([
      ['GET', '/v2/auth/me'], ['POST', '/v2/auth/refresh'], ['POST', '/v2/auth/logout'], ['PUT', '/v2/users/me/pin'],
    ])('preserves mandatory PIN recovery before pending MFA through %s %s', async (method, url) => {
      const { database, mfaSessions } = fixture({ pinResetRequired: true, mfaEnabled: true, mfaVerified: false });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

      await expect(adapter.authenticate(operationRequest(method, url, credential), reply()))
        .resolves.toMatchObject({ pinResetRequired: true, mfaRequired: true, mfaVerified: false });
    });

    it.each([
      ['GET', '/v2/settings'], ['POST', '/v2/auth/mfa/verify'], ['GET', '/v2/auth/mfa/enrollment'],
      ['POST', '/v2/users/me/pin'], ['GET', '/v2/users/me/pin'],
    ])('prioritizes mandatory PIN recovery over MFA for %s %s', async (method, url) => {
      const { database, mfaSessions } = fixture({ pinResetRequired: true, mfaEnabled: true, mfaVerified: false });
      const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);
      const response = reply();

      await expect(adapter.authenticate(operationRequest(method, url, credential), response))
        .rejects.toMatchObject({ status: 403, code: 'pin_rotation_required' });
      expect(response.setCookie).not.toHaveBeenCalled();
    });
  });

  it('derives forced PIN rotation from live session state rather than token claims', async () => {
    const { database, mfaSessions } = fixture({ pinResetRequired: true });
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);

    await expect(adapter.authenticate(request(), reply())).resolves.toMatchObject({
      pinResetRequired: true,
    });
  });

  it.each([
    ['GET', '/v2/locations'], ['GET', '/v2/notifications'], ['POST', '/v2/users'],
    ['GET', '/v2/users/me/pin'], ['POST', '/v2/users/me/pin'],
  ])('blocks temporary PIN sessions from %s %s before route work', async (method, url) => {
    const { database, mfaSessions } = fixture({ pinResetRequired: true });
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);
    await expect(adapter.authenticate({ ...request(), method, url } as FastifyRequest, reply()))
      .rejects.toMatchObject({ status: 403, code: 'pin_rotation_required' });
  });

  it.each([
    ['GET', '/v2/auth/me'], ['POST', '/v2/auth/refresh'], ['POST', '/v2/auth/logout'], ['PUT', '/v2/users/me/pin'],
  ])('preserves temporary PIN recovery through %s %s', async (method, url) => {
    const { database, mfaSessions } = fixture({ pinResetRequired: true });
    const adapter = new NativeIdentityAdapter(config, database as never, mfaSessions);
    await expect(adapter.authenticate({ ...request(), method, url } as FastifyRequest, reply()))
      .resolves.toMatchObject({ pinResetRequired: true });
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
