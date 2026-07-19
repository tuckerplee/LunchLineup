import { PRIVILEGED_MFA_PERMISSION_KEYS } from '@lunchlineup/rbac';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import Redis from 'ioredis';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import type { TenantDatabase } from './database';
import type { IdentityAdapter } from './identity';
import { ProblemError } from './problem';

const ACCESS_TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 480;
const MIN_SESSION_TIMEOUT_MINUTES = 5;
const MAX_SESSION_TIMEOUT_MINUTES = 1440;
const MFA_SESSION_KEY = (sessionId: string) => `session_mfa:${sessionId}`;
const ROLE_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_ROLE_NAME_LENGTH = 80;

type AccessTokenClaims = {
  sub: string;
  tenantId: string;
  sessionId: string;
};

type TenantSecuritySettings = {
  requireMfaForAll: boolean;
  sessionTimeoutMinutes: number;
};

type AuthorizationSnapshot = {
  user: {
    id: string;
    tenantId: string;
    email: string | null;
    username: string | null;
    name: string;
    role: string | null;
    mfaEnabled: boolean;
    pinResetRequired: boolean;
    deletedAt: Date | null;
    suspendedAt: Date | null;
    tenant: {
      name: string;
      status: string;
      deletedAt: Date | null;
    };
  };
  session: {
    id: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  };
  settings: TenantSecuritySettings;
  roles: SessionIdentity['roles'];
  permissions: string[];
  effectiveExpiresAt: Date;
  mfaRequired: boolean;
};

export type MfaSessionStore = {
  isVerified(sessionId: string): Promise<boolean>;
  ready?(): Promise<void>;
  close?(): Promise<void>;
};

export class RedisMfaSessionStore implements MfaSessionStore {
  private readonly client: Redis;

  constructor(config: Pick<ApiV2Config, 'redisUrl' | 'authStateTimeoutMs'>) {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: config.authStateTimeoutMs,
      commandTimeout: config.authStateTimeoutMs,
      connectionName: 'lunchlineup-api-v2-auth',
    });
    this.client.on('error', () => undefined);
  }

  async ready(): Promise<void> {
    if (this.client.status === 'ready') return;
    try {
      await this.client.connect();
    } catch {
      this.client.disconnect(false);
      throw new Error('MFA session store is unavailable.');
    }
  }

  async isVerified(sessionId: string): Promise<boolean> {
    try {
      if (this.client.status !== 'ready') await this.ready();
      return await this.client.get(MFA_SESSION_KEY(sessionId)) === '1';
    } catch {
      throw new Error('MFA session store is unavailable.');
    }
  }

  async close(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') return;
    await this.client.quit().catch(() => {
      this.client.disconnect(false);
    });
  }
}

function unauthorized(): ProblemError {
  return new ProblemError(401, 'authentication_required', 'Sign in to continue.', 'Unauthorized');
}

function identityUnavailable(): ProblemError {
  return new ProblemError(
    503,
    'identity_service_unavailable',
    'Session validation is temporarily unavailable.',
    'Service unavailable',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedClaim(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function accessClaims(token: string, config: Pick<ApiV2Config, 'jwtSecret'>): AccessTokenClaims {
  let verified: string | JwtPayload;
  try {
    verified = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'lunchlineup',
      audience: 'lunchlineup-api',
    });
  } catch {
    throw unauthorized();
  }

  if (
    typeof verified === 'string'
    || !boundedClaim(verified.sub)
    || !boundedClaim(verified.tenantId)
    || !boundedClaim(verified.sessionId)
  ) {
    throw unauthorized();
  }
  return {
    sub: verified.sub,
    tenantId: verified.tenantId,
    sessionId: verified.sessionId,
  };
}

function requestToken(request: FastifyRequest): { token: string; cookieAuthenticated: boolean } {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization.trim());
    if (!match) throw unauthorized();
    return { token: match[1], cookieAuthenticated: false };
  }

  const token = request.cookies.access_token;
  if (!token) throw unauthorized();
  return { token, cookieAuthenticated: true };
}

function normalizeSessionTimeoutMinutes(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_SESSION_TIMEOUT_MINUTES
    && value <= MAX_SESSION_TIMEOUT_MINUTES
    ? value
    : DEFAULT_SESSION_TIMEOUT_MINUTES;
}

function securitySettings(value: unknown): TenantSecuritySettings {
  const record = isRecord(value) ? value : {};
  const security = isRecord(record.security) ? record.security : {};
  return {
    requireMfaForAll: security.requireMfaForAll === true,
    sessionTimeoutMinutes: normalizeSessionTimeoutMinutes(security.sessionTimeoutMinutes),
  };
}

function safeRoleName(value: string): string {
  const normalized = value
    .replace(ROLE_NAME_CONTROL_CHARACTERS, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, MAX_ROLE_NAME_LENGTH);
  return normalized || 'Unknown role';
}

function assertActiveSnapshot(snapshot: AuthorizationSnapshot): AuthorizationSnapshot {
  if (
    snapshot.user.deletedAt
    || snapshot.user.suspendedAt
    || snapshot.user.tenant.deletedAt
    || ['SUSPENDED', 'PURGED'].includes(snapshot.user.tenant.status)
    || snapshot.session.revokedAt
    || snapshot.effectiveExpiresAt <= new Date()
  ) {
    throw unauthorized();
  }
  return snapshot;
}

function sessionCookieMaxAgeSeconds(expiresAt: Date): number {
  const remaining = Math.max(0, expiresAt.getTime() - Date.now());
  return Math.floor(Math.min(ACCESS_TOKEN_MAX_AGE_MS, remaining) / 1000);
}

/**
 * Native v2 access-token validation. It re-derives roles, permissions, session
 * policy, revocation, MFA state, and user context from the tenant data store;
 * token claims are only a signed session locator.
 */
export class NativeIdentityAdapter implements IdentityAdapter {
  constructor(
    private readonly config: ApiV2Config,
    private readonly database: Pick<TenantDatabase, 'withTenant'>,
    private readonly mfaSessions: MfaSessionStore = new RedisMfaSessionStore(config),
  ) {}

  async ready(): Promise<void> {
    await this.mfaSessions.ready?.();
  }

  async close(): Promise<void> {
    await this.mfaSessions.close?.();
  }

  async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<SessionIdentity> {
    const source = requestToken(request);
    const claims = accessClaims(source.token, this.config);

    let firstSnapshot: AuthorizationSnapshot;
    try {
      firstSnapshot = await this.loadSnapshot(claims);
    } catch (error) {
      if (error instanceof ProblemError) throw error;
      throw identityUnavailable();
    }

    let firstMfaVerified = false;
    if (firstSnapshot.mfaRequired) {
      try {
        firstMfaVerified = await this.mfaSessions.isVerified(firstSnapshot.session.id);
      } catch {
        throw identityUnavailable();
      }
    }

    let snapshot: AuthorizationSnapshot;
    try {
      snapshot = await this.loadSnapshot(claims);
    } catch (error) {
      if (error instanceof ProblemError) throw error;
      throw identityUnavailable();
    }

    let mfaVerified = false;
    if (snapshot.mfaRequired) {
      if (firstSnapshot.mfaRequired) {
        mfaVerified = firstMfaVerified;
      } else {
        try {
          mfaVerified = await this.mfaSessions.isVerified(snapshot.session.id);
        } catch {
          throw identityUnavailable();
        }
      }
    }

    const identity: SessionIdentity = {
      sub: snapshot.user.id,
      tenantId: snapshot.user.tenantId,
      sessionId: snapshot.session.id,
      role: snapshot.roles[0]?.name ?? 'Unknown role',
      legacyRole: snapshot.user.role,
      roles: snapshot.roles,
      permissions: snapshot.permissions,
      email: snapshot.user.email,
      username: snapshot.user.username,
      name: snapshot.user.name,
      tenantName: snapshot.user.tenant.name,
      mfaRequired: snapshot.mfaRequired,
      mfaVerified: !snapshot.mfaRequired || mfaVerified,
      pinResetRequired: snapshot.user.pinResetRequired,
    };

    if (source.cookieAuthenticated) this.rotateCookie(reply, identity, snapshot.effectiveExpiresAt);
    return identity;
  }

  private async loadSnapshot(claims: AccessTokenClaims): Promise<AuthorizationSnapshot> {
    const snapshot = await this.database.withTenant(claims.tenantId, async (transaction) => {
      const session = await transaction.session.findFirst({
        where: { id: claims.sessionId, userId: claims.sub },
        select: {
          id: true,
          userId: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
          user: {
            select: {
              id: true,
              tenantId: true,
              email: true,
              username: true,
              name: true,
              role: true,
              mfaEnabled: true,
              pinResetRequired: true,
              deletedAt: true,
              suspendedAt: true,
              tenant: {
                select: {
                  name: true,
                  status: true,
                  deletedAt: true,
                },
              },
            },
          },
        },
      });
      if (!session || session.user.tenantId !== claims.tenantId) throw unauthorized();

      const setting = await transaction.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId: claims.tenantId, key: 'workspace_settings' } },
        select: { value: true },
      });
      const assignments = await transaction.roleAssignment.findMany({
        where: {
          tenantId: claims.tenantId,
          userId: claims.sub,
          role: { tenantId: claims.tenantId, deletedAt: null },
        },
        select: {
          role: {
            select: {
              id: true,
              name: true,
              isSystem: true,
              legacyRole: true,
              rolePermissions: {
                select: { permission: { select: { key: true } } },
              },
            },
          },
        },
      });
      if (assignments.length === 0) throw unauthorized();

      const permissions = new Set<string>();
      const roles = assignments.map(({ role }) => {
        for (const rolePermission of role.rolePermissions) permissions.add(rolePermission.permission.key);
        return {
          id: role.id,
          name: safeRoleName(role.name),
          isSystem: role.isSystem,
          legacyRole: role.legacyRole,
        };
      });
      const settings = securitySettings(setting?.value);
      const effectiveExpiresAt = new Date(Math.min(
        session.expiresAt.getTime(),
        session.createdAt.getTime() + settings.sessionTimeoutMinutes * 60 * 1000,
      ));
      const sortedPermissions = [...permissions].sort();
      return {
        user: session.user,
        session: {
          id: session.id,
          userId: session.userId,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
        },
        settings,
        roles,
        permissions: sortedPermissions,
        effectiveExpiresAt,
        mfaRequired: session.user.mfaEnabled
          || settings.requireMfaForAll
          || sortedPermissions.some((permission) => PRIVILEGED_MFA_PERMISSION_KEYS.has(permission)),
      } satisfies AuthorizationSnapshot;
    });
    return assertActiveSnapshot(snapshot);
  }

  private rotateCookie(reply: FastifyReply, identity: SessionIdentity, expiresAt: Date): void {
    const maxAge = sessionCookieMaxAgeSeconds(expiresAt);
    const token = jwt.sign({
      sub: identity.sub,
      tenantId: identity.tenantId,
      role: identity.role,
      legacyRole: identity.legacyRole,
      sessionId: identity.sessionId,
      mfaVerified: identity.mfaVerified,
      pinResetRequired: identity.pinResetRequired === true,
    }, this.config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '30m',
      issuer: 'lunchlineup',
      audience: 'lunchlineup-api',
    });
    reply.setCookie('access_token', token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
  }
}
