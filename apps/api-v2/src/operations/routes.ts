import {
  LunchBreakGenerationRequestSchema,
  LunchBreakGenerationResponseSchema,
  LunchBreakListQuerySchema,
  LunchBreakListResponseSchema,
  LunchBreakRowSchema,
  LunchBreakPolicyPatchSchema,
  LunchBreakPolicySchema,
  OperationsListQuerySchema,
  OperationsRouteProblemResponses,
  ScheduleSummaryListResponseSchema,
  SetupShiftsRequestSchema,
  SetupShiftsResponseSchema,
  ShiftBreakPathSchema,
  ShiftBreakUpdateRequestSchema,
  ShiftSummaryListResponseSchema,
  StaffRosterQuerySchema,
  StaffRosterResponseSchema,
  type LunchBreakGenerationRequest,
  type LunchBreakListQuery,
  type LunchBreakPolicyPatch,
  type OperationsListQuery,
  type SetupShiftsRequest,
  type ShiftBreakUpdateRequest,
  type StaffRosterQuery,
} from '@lunchlineup/api-contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { ProblemError } from '../platform/problem';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { LunchBreakService } from './lunch-breaks.service';
import type { OperationsService } from './operations.service';

export type OperationsRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  operations: Pick<OperationsService, 'listSchedules' | 'listShifts' | 'staffRoster'>;
  lunchBreaks: Pick<LunchBreakService, 'list' | 'policy' | 'replacePolicy' | 'generate' | 'setupShifts' | 'replaceShiftBreaks'>;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: OperationsRouteDependencies,
) {
  const identity = await dependencies.identity.authenticate(request, reply);
  if (identity.pinResetRequired) {
    throw new ProblemError(
      403,
      'pin_rotation_required',
      'PIN rotation is required before this session can access operations.',
      'Forbidden',
    );
  }
  if (identity.mfaRequired && !identity.mfaVerified) {
    throw new ProblemError(
      403,
      'mfa_verification_required',
      'MFA verification is required before this session can access operations.',
      'Forbidden',
    );
  }
  return identity;
}

/**
 * Explicit public Operations resources. These routes deliberately replace the
 * generic API-01 compatibility owner, so API v2 owns validation, auth, public
 * identifier resolution, idempotency, and persistence end to end.
 */
export async function registerOperationsRoutes(
  app: FastifyInstance,
  dependencies: OperationsRouteDependencies,
): Promise<void> {
  app.get<{ Querystring: OperationsListQuery }>('/v2/schedules', {
    schema: {
      operationId: 'listScheduleSummaries',
      summary: 'List schedule summaries',
      description: 'Lists bounded operational schedule summaries with public location and schedule UUIDs.',
      tags: ['Operations'],
      querystring: OperationsListQuerySchema,
      response: { 200: ScheduleSummaryListResponseSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['schedules:read']);
    const response = await dependencies.operations.listSchedules(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Querystring: StaffRosterQuery }>('/v2/shifts/staff-roster', {
    schema: {
      operationId: 'listStaffRoster',
      summary: 'List the bounded scheduling roster',
      description: 'Lists eligible scheduling staff with public UUIDs only.',
      tags: ['Operations'],
      querystring: StaffRosterQuerySchema,
      response: { 200: StaffRosterResponseSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['shifts:read']);
    const response = await dependencies.operations.staffRoster(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Querystring: OperationsListQuery }>('/v2/shifts', {
    schema: {
      operationId: 'listShiftSummaries',
      summary: 'List shift summaries',
      description: 'Lists bounded shifts, assignments, and typed lunch/break summaries using public UUIDs.',
      tags: ['Operations'],
      querystring: OperationsListQuerySchema,
      response: { 200: ShiftSummaryListResponseSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['shifts:read']);
    const response = await dependencies.operations.listShifts(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Querystring: LunchBreakListQuery }>('/v2/lunch-breaks', {
    schema: {
      operationId: 'listLunchBreakRows',
      summary: 'List lunch and break rows',
      description: 'Lists bounded lunch/break planning rows with public shift, user, and location identifiers.',
      tags: ['Operations'],
      querystring: LunchBreakListQuerySchema,
      response: { 200: LunchBreakListResponseSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['lunch_breaks:read']);
    const response = await dependencies.lunchBreaks.list(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get('/v2/lunch-breaks/policy', {
    schema: {
      operationId: 'getLunchBreakPolicy',
      summary: 'Read the lunch and break policy',
      description: 'Reads the tenant lunch/break planning policy directly from the native owner.',
      tags: ['Operations'],
      response: { 200: LunchBreakPolicySchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['lunch_breaks:read']);
    const response = await dependencies.lunchBreaks.policy(identity);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{ Body: LunchBreakPolicyPatch }>('/v2/lunch-breaks/policy', {
    schema: {
      operationId: 'updateLunchBreakPolicy',
      summary: 'Replace the lunch and break policy',
      description: 'Validates and stores one tenant lunch/break policy without a retained API hop.',
      tags: ['Operations'],
      body: LunchBreakPolicyPatchSchema,
      response: { 200: LunchBreakPolicySchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['lunch_breaks:write']);
    const response = await dependencies.lunchBreaks.replacePolicy(identity, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: LunchBreakGenerationRequest }>('/v2/lunch-breaks/generate', {
    schema: {
      operationId: 'generateLunchBreakPlan',
      summary: 'Generate one lunch and break plan',
      description: 'Generates a bounded plan and, when requested, commits it with a durable idempotency and credit settlement record.',
      tags: ['Operations'],
      body: LunchBreakGenerationRequestSchema,
      response: { 200: LunchBreakGenerationResponseSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['lunch_breaks:write']);
    const response = await dependencies.lunchBreaks.generate(identity, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: SetupShiftsRequest }>('/v2/lunch-breaks/setup-shifts', {
    schema: {
      operationId: 'importLunchBreakShifts',
      summary: 'Import manual shifts into a break plan',
      description: 'Creates or updates bounded setup shifts with public identifiers, overlap checks, idempotency, and revision fencing.',
      tags: ['Operations'],
      body: SetupShiftsRequestSchema,
      response: { 200: SetupShiftsResponseSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['lunch_breaks:write', 'shifts:write']);
    const response = await dependencies.lunchBreaks.setupShifts(identity, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{
    Params: { shiftId: string };
    Body: ShiftBreakUpdateRequest;
  }>('/v2/lunch-breaks/shift/:shiftId', {
    schema: {
      operationId: 'updateShiftBreakPlan',
      summary: 'Replace one shift break plan',
      description: 'Atomically replaces one draft shift break plan by public shift UUID.',
      tags: ['Operations'],
      params: ShiftBreakPathSchema,
      body: ShiftBreakUpdateRequestSchema,
      response: { 200: LunchBreakRowSchema, ...OperationsRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['lunch_breaks:write']);
    const response = await dependencies.lunchBreaks.replaceShiftBreaks(
      identity,
      request.params.shiftId,
      request.body,
      header(request, 'idempotency-key'),
    );
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });
}
