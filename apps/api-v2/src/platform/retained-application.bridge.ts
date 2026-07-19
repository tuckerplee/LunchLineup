import {
  applicationApiOperation,
  type ApplicationApiOperation,
  type ApplicationApiResponseKind,
} from '@lunchlineup/api-contract';
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { ProblemError } from './problem';

const DEFAULT_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_RESPONSE_LIMIT_BYTES = 25 * 1024 * 1024;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,128}$/;
const SAFE_HEADER_VALUE = /^[^\r\n]{1,1024}$/;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

type RetainedCall = {
  operation: ApplicationApiOperation;
  request: FastifyRequest;
  reply: FastifyReply;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safePublicText(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (
    !candidate
    || candidate.length > 240
    || /[\r\n\0<>]/.test(candidate)
    || /(?:https?:\/\/|file:\/\/|\\\\|\b(?:bearer|authorization|cookie|set-cookie|stack|sqlstate)\b|(?:token|password|secret|key)\s*[:=]|localhost|127\.0\.0\.1|\.internal\b|\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}

function forwardedSetCookies(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') return extended.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function copyResponseHeaders(reply: FastifyReply, headers: Headers): void {
  for (const cookie of forwardedSetCookies(headers)) reply.header('set-cookie', cookie);
  for (const name of ['content-disposition', 'etag', 'last-modified', 'retry-after']) {
    const value = headers.get(name);
    if (value && SAFE_HEADER_VALUE.test(value)) reply.header(name, value);
  }
}

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProblemError(
      502,
      'invalid_compatibility_response',
      'A retained application subsystem returned an invalid response.',
      'Bad gateway',
    );
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new ProblemError(
          502,
          'invalid_compatibility_response',
          'A retained application subsystem returned an invalid response.',
          'Bad gateway',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function requestBody(request: FastifyRequest): string | Buffer | undefined {
  if (['GET', 'HEAD'].includes(request.method.toUpperCase()) || request.body === undefined) {
    return undefined;
  }
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === 'string') return request.body;
  return JSON.stringify(request.body);
}

function retainedTarget(
  config: ApiV2Config,
  operation: ApplicationApiOperation,
  request: FastifyRequest,
): string {
  const target = request.raw.url ?? request.url;
  if (
    !target.startsWith('/v2/')
    || target.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(target)
  ) {
    throw new Error('Invalid API-v2 compatibility target.');
  }
  const relative = target.slice('/v2/'.length);
  const pathname = relative.split('?', 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error('Invalid API-v2 compatibility target.');
  }
  if (
    !relative
    || decoded.includes('..')
    || decoded.includes('\\')
    || decoded.includes('//')
    || decoded.split('/').length !== pathname.split('/').length
    || /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    throw new Error('Invalid API-v2 compatibility target.');
  }
  const matchedOperation = applicationApiOperation(`/${relative}`, operation.method);
  if (!matchedOperation || matchedOperation.operationId !== operation.operationId) {
    throw new Error('Invalid API-v2 compatibility operation.');
  }
  return `${config.legacyApiBaseUrl}/${relative}`;
}

function requestHeaders(config: ApiV2Config, request: FastifyRequest): Headers {
  const publicOrigin = new URL(config.appOrigin);
  const headers = new Headers({
    Accept: request.headers.accept ?? 'application/json',
    'X-Request-Id': request.id,
    'X-Forwarded-Host': publicOrigin.host,
    'X-Forwarded-Proto': publicOrigin.protocol.slice(0, -1),
  });
  const allowed = [
    'authorization',
    'cookie',
    'content-type',
    'idempotency-key',
    'if-match',
    'if-none-match',
    'origin',
    'referer',
    'user-agent',
    'x-csrf-token',
  ] as const;
  for (const name of allowed) {
    const value = request.headers[name];
    const normalized = Array.isArray(value) ? value[0] : value;
    if (typeof normalized === 'string') headers.set(name, normalized);
  }
  if (isIP(request.ip)) headers.set('X-Forwarded-For', request.ip);
  return headers;
}

function parsedJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function errorCode(status: number): string {
  if (status === 401) return 'authentication_required';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'resource_not_found';
  if (status === 409) return 'resource_conflict';
  if (status === 412) return 'precondition_failed';
  if (status === 422) return 'request_validation_failed';
  if (status === 428) return 'precondition_required';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'retained_application_unavailable';
  return 'request_rejected';
}

function errorTitle(status: number): string {
  if (status === 401) return 'Unauthorized';
  if (status === 402) return 'Payment required';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not found';
  if (status === 409) return 'Conflict';
  if (status === 412) return 'Precondition failed';
  if (status === 422) return 'Request validation failed';
  if (status === 428) return 'Precondition required';
  if (status === 429) return 'Too many requests';
  if (status >= 500) return 'Service unavailable';
  return 'Request rejected';
}

function errorFallback(status: number): string {
  if (status === 401) return 'Sign in to continue.';
  if (status === 403) return 'You do not have permission to perform this action.';
  if (status === 404) return 'The requested resource was not found.';
  if (status === 409) return 'The request conflicts with the current resource state.';
  if (status === 429) return 'Too many requests. Please wait and try again.';
  if (status >= 500) return 'This application operation is temporarily unavailable.';
  return 'The application operation was rejected.';
}

function compatibilityProblem(response: Response, payload: unknown): ProblemError {
  const status = response.status === 400
    ? 422
    : response.status >= 500
      ? 503
      : response.status;
  const record = isRecord(payload) ? payload : {};
  const rawMessage = Array.isArray(record.message)
    ? record.message.filter((entry): entry is string => typeof entry === 'string').join(' ')
    : record.message ?? record.detail ?? record.error;
  const legacyCode = typeof record.code === 'string' && SAFE_ERROR_CODE.test(record.code)
    ? record.code
    : undefined;
  const remediation = typeof record.remediation === 'string'
    ? safePublicText(record.remediation, '')
    : '';
  const retryAfterSeconds = typeof record.retryAfterSeconds === 'number'
    && Number.isSafeInteger(record.retryAfterSeconds)
    && record.retryAfterSeconds >= 0
    && record.retryAfterSeconds <= 86_400
    ? record.retryAfterSeconds
    : undefined;
  return new ProblemError(
    status,
    errorCode(status),
    safePublicText(rawMessage, errorFallback(status)),
    errorTitle(status),
    undefined,
    undefined,
    {
      ...(legacyCode ? { legacyCode } : {}),
      ...(remediation ? { remediation } : {}),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  );
}

function isJsonContentType(value: string | null): boolean {
  return Boolean(value && JSON_CONTENT_TYPE.test(value.trim()));
}

function responseLimit(kind: ApplicationApiResponseKind | undefined): number {
  return kind === 'download' ? DOWNLOAD_RESPONSE_LIMIT_BYTES : DEFAULT_RESPONSE_LIMIT_BYTES;
}

export class RetainedApplicationBridge {
  constructor(private readonly config: ApiV2Config) {}

  async execute({ operation, request, reply }: RetainedCall): Promise<unknown> {
    const target = retainedTarget(this.config, operation, request);
    const headers = requestHeaders(this.config, request);
    const body = requestBody(request);
    let response: Response;
    try {
      response = await fetch(target, {
        method: operation.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.legacyRequestTimeoutMs),
      });
    } catch {
      throw new ProblemError(
        503,
        'retained_application_unavailable',
        'This application operation is temporarily unavailable.',
        'Service unavailable',
      );
    }

    copyResponseHeaders(reply, response.headers);
    const bytes = await readBoundedBytes(response, responseLimit(operation.responseKind));
    const contentType = response.headers.get('content-type');

    if (response.status >= 300 && response.status < 400) {
      if (operation.responseKind !== 'redirect') {
        throw new ProblemError(
          502,
          'invalid_compatibility_response',
          'A retained application subsystem returned an invalid response.',
          'Bad gateway',
        );
      }
      const location = response.headers.get('location');
      if (!location || location.length > 4096 || /[\r\n\0]/.test(location)) {
        throw new ProblemError(
          502,
          'invalid_compatibility_response',
          'The sign-in service returned an invalid redirect.',
          'Bad gateway',
        );
      }
      reply.code(response.status).header('location', location).header('Cache-Control', 'no-store');
      return reply.send();
    }

    let json: unknown = null;
    if (bytes.byteLength > 0 && isJsonContentType(contentType)) {
      try {
        json = parsedJson(bytes);
      } catch {
        throw new ProblemError(
          response.ok ? 502 : 503,
          'invalid_compatibility_response',
          'A retained application subsystem returned an invalid response.',
          response.ok ? 'Bad gateway' : 'Service unavailable',
        );
      }
    }

    if (!response.ok) throw compatibilityProblem(response, json);

    reply
      .code(response.status)
      .header('Cache-Control', 'private, no-store')
      .header('X-LunchLineup-Compatibility-Owner', 'API-02');

    if (response.status === 204 || bytes.byteLength === 0) return reply.send();
    if (operation.responseKind === 'download') {
      if (contentType && SAFE_HEADER_VALUE.test(contentType)) reply.type(contentType);
      return reply.send(Buffer.from(bytes));
    }
    if (!isJsonContentType(contentType)) {
      throw new ProblemError(
        502,
        'invalid_compatibility_response',
        'A retained application subsystem returned an invalid response.',
        'Bad gateway',
      );
    }
    return json;
  }
}
