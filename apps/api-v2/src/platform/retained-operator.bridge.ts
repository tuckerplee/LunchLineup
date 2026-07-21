import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { ProblemError } from './problem';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SAFE_BEARER = /^Bearer [\x21-\x7e]{1,4096}$/;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

function operatorUnavailable(): ProblemError {
  return new ProblemError(
    503,
    'retained_operator_unavailable',
    'The protected operator service is temporarily unavailable.',
    'Service unavailable',
  );
}

function invalidOperatorResponse(): ProblemError {
  return new ProblemError(
    502,
    'invalid_operator_response',
    'The protected operator service returned an invalid response.',
    'Bad gateway',
  );
}

export function requireRetentionOperatorBearer(request: FastifyRequest): string {
  const value = request.headers.authorization;
  const authorization = Array.isArray(value) ? value[0] : value;
  if (!authorization || !SAFE_BEARER.test(authorization)) {
    throw new ProblemError(
      401,
      'authentication_required',
      'A protected operator credential is required.',
      'Unauthorized',
    );
  }
  return authorization;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidOperatorResponse();
  }
  if (!response.body || !JSON_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
    throw invalidOperatorResponse();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw invalidOperatorResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    throw invalidOperatorResponse();
  }
}

/**
 * Narrow private seam for scheduled/operator calls that have a safe v2 route
 * but whose durable domain owner has not been migrated yet. It never forwards
 * cookies or caller-selected targets, and only accepts an explicit bearer
 * credential intended for the legacy service-token gate.
 */
export class RetainedOperatorBridge {
  constructor(private readonly config: Pick<ApiV2Config, 'appOrigin' | 'legacyApiBaseUrl' | 'legacyRequestTimeoutMs'>) {}

  async executeRetentionPurge(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const authorization = requireRetentionOperatorBearer(request);
    const origin = new URL(this.config.appOrigin);
    let response: Response;
    try {
      response = await fetch(`${this.config.legacyApiBaseUrl}/admin/retention/purge-expired`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: authorization,
          'Content-Type': 'application/json',
          'X-Request-Id': request.id,
          'X-Forwarded-Host': origin.host,
          'X-Forwarded-Proto': origin.protocol.slice(0, -1),
        },
        body: JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(this.config.legacyRequestTimeoutMs),
      });
    } catch {
      throw operatorUnavailable();
    }

    const retryAfter = response.headers.get('retry-after');
    if (retryAfter && /^[0-9]{1,6}$/.test(retryAfter)) reply.header('Retry-After', retryAfter);
    const payload = await readBoundedJson(response);
    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 || response.status === 429
        ? response.status
        : response.status >= 500
          ? 503
          : 422;
      throw new ProblemError(
        status,
        status === 401 ? 'authentication_required' : status === 403 ? 'permission_denied' : status === 429 ? 'rate_limited' : 'operator_request_rejected',
        status >= 500 ? 'The protected operator service is temporarily unavailable.' : 'The protected operator request was rejected.',
        status >= 500 ? 'Service unavailable' : 'Request rejected',
      );
    }
    reply.code(response.status).header('Cache-Control', 'no-store').header('X-LunchLineup-Compatibility-Owner', 'API-03');
    return payload;
  }
}
