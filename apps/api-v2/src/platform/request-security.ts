import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { ProblemError } from './problem';

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function assertUnsafeRequestSecurity(request: FastifyRequest, config: ApiV2Config): void {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return;

  const origin = request.headers.origin?.trim();
  if (!origin || !config.allowedOrigins.has(origin)) {
    throw new ProblemError(
      403,
      'origin_not_allowed',
      'The request origin is not allowed.',
      'Forbidden',
    );
  }

  const cookieToken = request.cookies.csrf_token;
  const headerValue = request.headers['x-csrf-token'];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (
    typeof cookieToken !== 'string'
    || typeof headerToken !== 'string'
    || cookieToken.length < 16
    || cookieToken.length > 512
    || headerToken.length > 512
    || !safeEqual(cookieToken, headerToken)
  ) {
    throw new ProblemError(
      403,
      'csrf_validation_failed',
      'The request CSRF token is missing or invalid.',
      'Forbidden',
    );
  }
}
