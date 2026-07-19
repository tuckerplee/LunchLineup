import {
  BreakGenerationRequestSchema,
  BreakGenerationResponseSchema,
  DemandWindowListResponseSchema,
  DemandWindowReplaceRequestSchema,
  DemandWindowReplaceResponseSchema,
  LocalDateSchema,
  ProblemDetailsSchema,
  ScheduleBoardResponseSchema,
  ScheduleChangeSetRequestSchema,
  ScheduleChangeSetResponseSchema,
  ScheduleCreateRequestSchema,
  ScheduleCreateResponseSchema,
  SchedulePublicationRequestSchema,
  SchedulePublicationResponseSchema,
  SchedulePublishPlanResponseSchema,
  ScheduleReopenResponseSchema,
  ScheduleSolveJobSchema,
  ScheduleSolveRequestSchema,
  ScheduleSolveResponseSchema,
  SchedulerViewSchema,
  UuidSchema,
  type BreakGenerationRequest,
  type BreakGenerationResponse,
  type DemandWindowListResponse,
  type DemandWindowReplaceRequest,
  type DemandWindowReplaceResponse,
  type LegacyIdentity,
  type ScheduleBoardResponse,
  type ScheduleChangeSetRequest,
  type ScheduleChangeSetResponse,
  type ScheduleCreateRequest,
  type ScheduleCreateResponse,
  type SchedulePublicationRequest,
  type SchedulePublicationResponse,
  type SchedulePublishPlanResponse,
  type ScheduleReopenResponse,
  type ScheduleSolveJob,
  type ScheduleSolveRequest,
  type ScheduleSolveResponse,
  type SchedulerView,
} from '@lunchlineup/api-contract';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { LegacyIdentityAdapter, requireAnyPermission, requirePermissions } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { ScheduleBoardService } from './board.service';
import type { ScheduleChangeSetService } from './change-set.service';
import type { ScheduleCreateService } from './schedule-create.service';
import type { DemandWindowService } from './demand-window.service';
import type { LegacySchedulingBridge } from './legacy-scheduling.bridge';
import type { ScheduleLifecycleService } from './lifecycle.service';

const BoardQuerySchema = Type.Object({
  date: LocalDateSchema,
  view: SchedulerViewSchema,
  locationId: Type.Optional(UuidSchema),
}, { additionalProperties: false });

const LocationPathSchema = Type.Object({
  locationId: UuidSchema,
}, { additionalProperties: false });

const SchedulePathSchema = Type.Object({
  scheduleId: UuidSchema,
}, { additionalProperties: false });

const ScheduleSolveJobPathSchema = Type.Object({
  scheduleId: UuidSchema,
  jobId: UuidSchema,
}, { additionalProperties: false });

const commonResponses = {
  401: ProblemDetailsSchema,
  402: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  412: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  428: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  502: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};

export type SchedulingRouteDependencies = {
  config: ApiV2Config;
  identity: LegacyIdentityAdapter;
  board: Pick<ScheduleBoardService, 'get'>;
  scheduleCreate: Pick<ScheduleCreateService, 'create'>;
  changeSets: Pick<ScheduleChangeSetService, 'apply'>;
  demandWindows: Pick<DemandWindowService, 'list' | 'replace'>;
  lifecycle: Pick<ScheduleLifecycleService, 'reopen'>;
  retainedScheduling: Pick<
    LegacySchedulingBridge,
    'publishPlan' | 'publish' | 'startSolve' | 'solveJob' | 'generateBreaks'
  >;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  identityAdapter: LegacyIdentityAdapter,
): Promise<LegacyIdentity> {
  return identityAdapter.authenticate(request, reply);
}

export async function registerSchedulingRoutes(
  app: FastifyInstance,
  dependencies: SchedulingRouteDependencies,
): Promise<void> {
  app.get<{
    Querystring: { date: string; view: SchedulerView; locationId?: string };
  }>('/v2/schedule-board', {
    schema: {
      operationId: 'getScheduleBoard',
      summary: 'Load the scheduling board read model',
      description: 'Returns identity permissions, bounded locations, roster, schedules, revisions, and shifts for one selected board window.',
      tags: ['Scheduling'],
      querystring: BoardQuerySchema,
      response: {
        200: ScheduleBoardResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<ScheduleBoardResponse> => {
    const identity = await authenticate(request, reply, dependencies.identity);
    requirePermissions(identity, ['locations:read', 'schedules:read', 'shifts:read']);
    const response = await dependencies.board.get(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { locationId: string };
    Body: ScheduleCreateRequest;
  }>('/v2/locations/:locationId/schedules', {
    schema: {
      operationId: 'createDraftSchedule',
      summary: 'Create an explicit draft schedule',
      tags: ['Scheduling'],
      params: LocationPathSchema,
      body: ScheduleCreateRequestSchema,
      response: {
        200: ScheduleCreateResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<ScheduleCreateResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    requireAnyPermission(identity, ['schedules:write', 'shifts:write']);
    const response = await dependencies.scheduleCreate.create(
      identity,
      request.params.locationId,
      request.body,
      header(request, 'idempotency-key'),
      {
        ipAddress: request.ip,
        userAgent: header(request, 'user-agent'),
      },
    );
    reply.header('ETag', response.data.etag);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { scheduleId: string };
    Body: ScheduleChangeSetRequest;
  }>('/v2/schedules/:scheduleId/change-sets', {
    schema: {
      operationId: 'applyScheduleChangeSet',
      summary: 'Apply one atomic schedule change set',
      description: 'Evaluates the final schedule state and commits all shift operations in one revision-fenced, idempotent transaction.',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      body: ScheduleChangeSetRequestSchema,
      response: {
        200: ScheduleChangeSetResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<ScheduleChangeSetResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    const response = await dependencies.changeSets.apply(
      identity,
      request.params.scheduleId,
      request.body,
      {
        ifMatch: header(request, 'if-match'),
        idempotencyKey: header(request, 'idempotency-key'),
      },
      {
        ipAddress: request.ip,
        userAgent: header(request, 'user-agent'),
      },
    );
    reply.header('ETag', response.data.etag);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{
    Params: { scheduleId: string };
  }>('/v2/schedules/:scheduleId/demand-windows', {
    schema: {
      operationId: 'getScheduleDemandWindows',
      summary: 'Read saved demand windows for one schedule',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      response: {
        200: DemandWindowListResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<DemandWindowListResponse> => {
    const identity = await authenticate(request, reply, dependencies.identity);
    const response = await dependencies.demandWindows.list(identity, request.params.scheduleId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{
    Params: { scheduleId: string };
    Body: DemandWindowReplaceRequest;
  }>('/v2/schedules/:scheduleId/demand-windows', {
    schema: {
      operationId: 'replaceScheduleDemandWindows',
      summary: 'Replace schedule demand as one revision-fenced change',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      body: DemandWindowReplaceRequestSchema,
      response: {
        200: DemandWindowReplaceResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<DemandWindowReplaceResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    const response = await dependencies.demandWindows.replace(
      identity,
      request.params.scheduleId,
      request.body,
      {
        ifMatch: header(request, 'if-match'),
        idempotencyKey: header(request, 'idempotency-key'),
      },
      {
        ipAddress: request.ip,
        userAgent: header(request, 'user-agent'),
      },
    );
    reply.header('ETag', response.etag);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{
    Params: { scheduleId: string };
  }>('/v2/schedules/:scheduleId/publish-plan', {
    schema: {
      operationId: 'getSchedulePublishPlan',
      summary: 'Review the authoritative schedule publication cost',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      response: {
        200: SchedulePublishPlanResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<SchedulePublishPlanResponse> => {
    const identity = await authenticate(request, reply, dependencies.identity);
    requirePermissions(identity, ['schedules:publish']);
    const response = await dependencies.retainedScheduling.publishPlan(
      identity,
      request.params.scheduleId,
      request,
      reply,
    );
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { scheduleId: string };
    Body: SchedulePublicationRequest;
  }>('/v2/schedules/:scheduleId/publications', {
    schema: {
      operationId: 'publishSchedule',
      summary: 'Publish a schedule with an accepted cost contract',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      body: SchedulePublicationRequestSchema,
      response: {
        200: SchedulePublicationResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<SchedulePublicationResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    requirePermissions(identity, ['schedules:publish']);
    const response = await dependencies.retainedScheduling.publish(
      identity,
      request.params.scheduleId,
      request.body,
      request,
      reply,
      header(request, 'idempotency-key'),
    );
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { scheduleId: string };
  }>('/v2/schedules/:scheduleId/reopenings', {
    schema: {
      operationId: 'reopenSchedule',
      summary: 'Reopen one published schedule as a draft',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      response: {
        200: ScheduleReopenResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<ScheduleReopenResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    const response = await dependencies.lifecycle.reopen(
      identity,
      request.params.scheduleId,
      {
        ifMatch: header(request, 'if-match'),
        idempotencyKey: header(request, 'idempotency-key'),
      },
      {
        ipAddress: request.ip,
        userAgent: header(request, 'user-agent'),
      },
    );
    reply.header('ETag', response.data.etag);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { scheduleId: string };
    Body: ScheduleSolveRequest;
  }>('/v2/schedules/:scheduleId/solve-jobs', {
    schema: {
      operationId: 'startScheduleSolve',
      summary: 'Queue one idempotent schedule solve job',
      tags: ['Scheduling'],
      params: SchedulePathSchema,
      body: ScheduleSolveRequestSchema,
      response: {
        202: ScheduleSolveResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<ScheduleSolveResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    requirePermissions(identity, ['schedules:write']);
    const response = await dependencies.retainedScheduling.startSolve(
      identity,
      request.params.scheduleId,
      request.body,
      request,
      reply,
      header(request, 'idempotency-key'),
    );
    reply.code(202);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{
    Params: { scheduleId: string; jobId: string };
  }>('/v2/schedules/:scheduleId/solve-jobs/:jobId', {
    schema: {
      operationId: 'getScheduleSolveJob',
      summary: 'Read one schedule solve job',
      tags: ['Scheduling'],
      params: ScheduleSolveJobPathSchema,
      response: {
        200: ScheduleSolveJobSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<ScheduleSolveJob> => {
    const identity = await authenticate(request, reply, dependencies.identity);
    requirePermissions(identity, ['schedules:write']);
    const response = await dependencies.retainedScheduling.solveJob(
      identity,
      request.params.scheduleId,
      request.params.jobId,
      request,
      reply,
    );
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Body: BreakGenerationRequest;
  }>('/v2/break-generations', {
    schema: {
      operationId: 'generateScheduleBreaks',
      summary: 'Generate and persist a break plan for selected shifts',
      tags: ['Scheduling'],
      body: BreakGenerationRequestSchema,
      response: {
        200: BreakGenerationResponseSchema,
        ...commonResponses,
      },
    },
  }, async (request, reply): Promise<BreakGenerationResponse> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies.identity);
    requirePermissions(identity, ['lunch_breaks:write']);
    const response = await dependencies.retainedScheduling.generateBreaks(
      identity,
      request.body,
      request,
      reply,
      header(request, 'idempotency-key'),
    );
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });
}
