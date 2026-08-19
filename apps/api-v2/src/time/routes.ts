import {
  TimeCardActiveQuerySchema,
  TimeCardActiveResponseSchema,
  TimeCardClockInRequestSchema,
  TimeCardClockInResponseSchema,
  TimeCardClockOutRequestSchema,
  TimeCardCorrectionRequestSchema,
  TimeCardListQuerySchema,
  TimeCardListResponseSchema,
  TimeCardPathSchema,
  TimeCardRecordSchema,
  TimeCardRouteProblemResponses,
  type TimeCardActiveQuery,
  type TimeCardClockInRequest,
  type TimeCardClockOutRequest,
  type TimeCardCorrectionRequest,
  type TimeCardListQuery,
} from '@lunchlineup/api-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { ProblemError } from '../platform/problem';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { TimeCardService } from './time-cards.service';

export type TimeCardRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  timeCards: Pick<TimeCardService, 'list' | 'active' | 'get' | 'clockIn' | 'clockOut' | 'correct'>;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: TimeCardRouteDependencies,
) {
  const identity = await dependencies.identity.authenticate(request, reply);
  if (identity.pinResetRequired) {
    throw new ProblemError(
      403,
      'pin_rotation_required',
      'PIN rotation is required before this session can access time cards.',
      'Forbidden',
    );
  }
  if (identity.mfaRequired && !identity.mfaVerified) {
    throw new ProblemError(
      403,
      'mfa_verification_required',
      'MFA verification is required before this session can access time cards.',
      'Forbidden',
    );
  }
  return identity;
}

/**
 * Explicit public Time resources. These routes intentionally own all six
 * catalog operations, so no v1 time-card identifier or response can cross the
 * API-v2 public boundary.
 */
export async function registerTimeCardRoutes(
  app: FastifyInstance,
  dependencies: TimeCardRouteDependencies,
): Promise<void> {
  app.get<{ Querystring: TimeCardListQuery }>('/v2/time-cards', {
    schema: {
      operationId: 'listTimeCards',
      summary: 'List time cards',
      description: 'Lists bounded time cards using opaque cursors and public UUID resources only.',
      tags: ['Time'],
      querystring: TimeCardListQuerySchema,
      response: { 200: TimeCardListResponseSchema, ...TimeCardRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['time_cards:read']);
    const response = await dependencies.timeCards.list(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Querystring: TimeCardActiveQuery }>('/v2/time-cards/active', {
    schema: {
      operationId: 'getActiveTimeCard',
      summary: 'Read the active time card',
      description: 'Reads an open time card for the current worker or an authorized team member. Recovery stays available after entitlement loss.',
      tags: ['Time'],
      querystring: TimeCardActiveQuerySchema,
      response: { 200: TimeCardActiveResponseSchema, ...TimeCardRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['time_cards:read']);
    const response = await dependencies.timeCards.active(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: TimeCardClockInRequest }>('/v2/time-cards/clock-in', {
    schema: {
      operationId: 'clockIn',
      summary: 'Create a clock-in event',
      description: 'Creates one public time-card resource with durable idempotency and exactly-once credit settlement.',
      tags: ['Time'],
      body: TimeCardClockInRequestSchema,
      response: {
        200: TimeCardClockInResponseSchema,
        201: TimeCardClockInResponseSchema,
        ...TimeCardRouteProblemResponses,
      },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['time_cards:write']);
    const response = await dependencies.timeCards.clockIn(identity, request.body, header(request, 'idempotency-key'));
    reply.code(response.reused ? 200 : 201).header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Params: { timeCardId: string } }>('/v2/time-cards/:timeCardId', {
    schema: {
      operationId: 'getTimeCard',
      summary: 'Read one time card',
      description: 'Reads one tenant-scoped time-card resource by public UUID.',
      tags: ['Time'],
      params: TimeCardPathSchema,
      response: { 200: TimeCardRecordSchema, ...TimeCardRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['time_cards:read']);
    const response = await dependencies.timeCards.get(identity, request.params.timeCardId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { timeCardId: string };
    Body: TimeCardClockOutRequest;
  }>('/v2/time-cards/:timeCardId/clock-out', {
    schema: {
      operationId: 'clockOut',
      summary: 'Create a clock-out event',
      description: 'Closes one public time-card resource with payroll cutoff and optimistic concurrency protection.',
      tags: ['Time'],
      params: TimeCardPathSchema,
      body: TimeCardClockOutRequestSchema,
      response: { 200: TimeCardRecordSchema, ...TimeCardRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['time_cards:write']);
    const response = await dependencies.timeCards.clockOut(identity, request.params.timeCardId, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.patch<{
    Params: { timeCardId: string };
    Body: TimeCardCorrectionRequest;
  }>('/v2/time-cards/:timeCardId/correction', {
    schema: {
      operationId: 'correctTimeCard',
      summary: 'Correct a time card',
      description: 'Corrects one team time card with expected-updated-at fencing, payroll locks, and public break resources.',
      tags: ['Time'],
      params: TimeCardPathSchema,
      body: TimeCardCorrectionRequestSchema,
      response: { 200: TimeCardRecordSchema, ...TimeCardRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['time_cards:write']);
    const response = await dependencies.timeCards.correct(identity, request.params.timeCardId, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });
}
