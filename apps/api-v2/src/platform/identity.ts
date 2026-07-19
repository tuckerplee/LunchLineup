import { LegacyIdentitySchema, type LegacyIdentity } from '@lunchlineup/api-contract';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { matchesContract } from './contract-check';
import { ProblemError } from './problem';

const IDENTITY_RESPONSE_LIMIT = 64 * 1024;

type LegacyIdentityEnvelope = {
  user?: unknown;
};

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > IDENTITY_RESPONSE_LIMIT) {
    throw new Error('Identity response exceeded its safety limit.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > IDENTITY_RESPONSE_LIMIT) {
    throw new Error('Identity response exceeded its safety limit.');
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function forwardedSetCookies(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') return extended.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

export class LegacyIdentityAdapter {
  constructor(private readonly config: ApiV2Config) {}

  async authenticate(request: FastifyRequest, reply: FastifyReply): Promise<LegacyIdentity> {
    const headers = new Headers({
      Accept: 'application/json',
      'X-Request-Id': request.id,
    });
    if (request.headers.cookie) headers.set('Cookie', request.headers.cookie);
    if (request.headers.authorization) headers.set('Authorization', request.headers.authorization);
    if (request.headers['user-agent']) headers.set('User-Agent', request.headers['user-agent']);

    let response: Response;
    try {
      response = await fetch(this.config.legacyIdentityUrl, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.identityTimeoutMs),
      });
    } catch {
      throw new ProblemError(
        503,
        'identity_service_unavailable',
        'Session validation is temporarily unavailable.',
        'Service unavailable',
      );
    }

    for (const cookie of forwardedSetCookies(response.headers)) {
      reply.header('set-cookie', cookie);
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProblemError(401, 'authentication_required', 'Sign in to continue.', 'Unauthorized');
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProblemError(403, 'session_restricted', 'The current session cannot access this resource.', 'Forbidden');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProblemError(
        503,
        'identity_service_unavailable',
        'Session validation is temporarily unavailable.',
        'Service unavailable',
      );
    }

    let payload: LegacyIdentityEnvelope;
    try {
      payload = await boundedJson(response) as LegacyIdentityEnvelope;
    } catch {
      throw new ProblemError(
        502,
        'invalid_identity_response',
        'Session validation returned an invalid response.',
        'Bad gateway',
      );
    }
    if (!matchesContract(LegacyIdentitySchema, payload?.user)) {
      throw new ProblemError(
        502,
        'invalid_identity_response',
        'Session validation returned an invalid response.',
        'Bad gateway',
      );
    }
    return payload.user;
  }
}

export function requirePermissions(identity: LegacyIdentity, permissions: readonly string[]): void {
  const missing = permissions.filter((permission) => !identity.permissions.includes(permission));
  if (missing.length > 0) {
    throw new ProblemError(
      403,
      'permission_denied',
      'You do not have permission to perform this action.',
      'Forbidden',
    );
  }
}

export function requireAnyPermission(identity: LegacyIdentity, permissions: readonly string[]): void {
  if (!permissions.some((permission) => identity.permissions.includes(permission))) {
    throw new ProblemError(
      403,
      'permission_denied',
      'You do not have permission to perform this action.',
      'Forbidden',
    );
  }
}
