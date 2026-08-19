import {
  BreakGenerationResponseSchema,
  SchedulePublicationResponseSchema,
  SchedulePublishPlanResponseSchema,
  ScheduleSolveJobSchema,
  ScheduleSolveResponseSchema,
  type BreakGenerationRequest,
  type BreakGenerationResponse,
  type SessionIdentity,
  type SchedulePublicationRequest,
  type SchedulePublicationResponse,
  type SchedulePublishPlanResponse,
  type ScheduleSolveJob,
  type ScheduleSolveRequest,
  type ScheduleSolveResponse,
} from '@lunchlineup/api-contract';
import type { TSchema } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { matchesContract } from '../platform/contract-check';
import { TenantDatabase } from '../platform/database';
import { ProblemError } from '../platform/problem';
import { requireIdempotencyKey } from './contract-helpers';

const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

type PublicScheduleReference = {
  id: string;
  publicId: string;
  locationId: string;
  location: { publicId: string };
};

type LegacyResult = {
  payload: unknown;
  headers: Headers;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeLegacyDetail(value: unknown, fallback: string): string {
  const candidate = typeof value === 'string' ? value : '';
  if (
    !candidate
    || candidate.length > 240
    || /[\r\n\0<>]/.test(candidate)
    || /(?:https?:\/\/|file:\/\/|\\\\|\b(?:bearer|authorization|cookie|set-cookie|stack|sqlstate)\b|(?:token|password|secret)\s*[:=]|localhost|127\.0\.0\.1|\.internal\b)/i.test(candidate)
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

function copySetCookies(reply: FastifyReply, headers: Headers): void {
  for (const cookie of forwardedSetCookies(headers)) reply.header('set-cookie', cookie);
}

function checked<T>(schema: TSchema, value: unknown): T {
  if (!matchesContract(schema, value)) {
    throw new ProblemError(
      502,
      'invalid_compatibility_response',
      'A retained scheduling subsystem returned an invalid response.',
      'Bad gateway',
    );
  }
  return value as T;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function publishCost(value: Record<string, unknown>): Record<string, unknown> {
  return {
    totalConfiguredCost: value.totalConfiguredCost,
    scheduleCost: value.scheduleCost,
    matchingWebhookDeliveryCount: value.matchingWebhookDeliveryCount,
    matchingWebhookDeliveryUnitCost: value.matchingWebhookDeliveryUnitCost,
    matchingWebhookDeliveryCost: value.matchingWebhookDeliveryCost,
  };
}

function acceptedPublishContract(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    version: value.version,
    ...publishCost(value),
  };
}

export class LegacySchedulingBridge {
  constructor(
    private readonly config: ApiV2Config,
    private readonly database: TenantDatabase,
  ) {}

  private async schedule(identity: SessionIdentity, publicId: string): Promise<PublicScheduleReference> {
    const schedule = await this.database.withTenant(identity.tenantId, (transaction) => (
      transaction.schedule.findFirst({
        where: {
          tenantId: identity.tenantId,
          publicId,
          deletedAt: null,
          location: { is: { deletedAt: null } },
        },
        select: {
          id: true,
          publicId: true,
          locationId: true,
          location: { select: { publicId: true } },
        },
      })
    ));
    if (!schedule) {
      throw new ProblemError(404, 'schedule_not_found', 'The selected schedule was not found.', 'Schedule not found');
    }
    return schedule;
  }

  private async call(
    request: FastifyRequest,
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
  ): Promise<LegacyResult> {
    if (!/^[a-z0-9][a-z0-9._~!$&'()*+,;=:@%/-]*$/i.test(path) || path.includes('..')) {
      throw new Error('Invalid retained scheduling path.');
    }
    const headers = new Headers({
      Accept: 'application/json',
      'X-Request-Id': request.id,
    });
    if (request.headers.cookie) headers.set('Cookie', request.headers.cookie);
    if (request.headers.authorization) headers.set('Authorization', request.headers.authorization);
    if (request.headers.origin) headers.set('Origin', request.headers.origin);
    if (request.headers['user-agent']) headers.set('User-Agent', request.headers['user-agent']);
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf === 'string') headers.set('X-CSRF-Token', csrf);
    if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetch(`${this.config.legacyApiBaseUrl}/${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.legacyRequestTimeoutMs),
      });
    } catch {
      throw new ProblemError(
        503,
        'retained_scheduling_unavailable',
        'This scheduling operation is temporarily unavailable.',
        'Service unavailable',
      );
    }

    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProblemError(
        502,
        'invalid_compatibility_response',
        'A retained scheduling subsystem returned an invalid response.',
        'Bad gateway',
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > RESPONSE_LIMIT_BYTES) {
      throw new ProblemError(
        502,
        'invalid_compatibility_response',
        'A retained scheduling subsystem returned an invalid response.',
        'Bad gateway',
      );
    }
    let payload: unknown = null;
    try {
      payload = bytes.byteLength === 0
        ? null
        : JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new ProblemError(
        response.ok ? 502 : 503,
        'invalid_compatibility_response',
        'A retained scheduling subsystem returned an invalid response.',
        response.ok ? 'Bad gateway' : 'Service unavailable',
      );
    }
    if (!response.ok) {
      const status = response.status === 400
        ? 422
        : response.status >= 500
          ? 503
          : response.status;
      const fallback = status >= 500
        ? 'This scheduling operation is temporarily unavailable.'
        : 'The scheduling operation was rejected.';
      const detail = safeLegacyDetail(isRecord(payload) ? payload.message : undefined, fallback);
      throw new ProblemError(
        status,
        status === 402 ? 'payment_required' : 'retained_scheduling_rejected',
        detail,
        status === 402 ? 'Payment required' : status === 409 ? 'Conflict' : 'Request rejected',
      );
    }
    return { payload, headers: response.headers };
  }

  async publishPlan(
    identity: SessionIdentity,
    schedulePublicId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SchedulePublishPlanResponse> {
    const schedule = await this.schedule(identity, schedulePublicId);
    const result = await this.call(
      request,
      `schedules/${encodeURIComponent(schedule.id)}/publish/preflight`,
      { method: 'GET' },
    );
    copySetCookies(reply, result.headers);
    if (!isRecord(result.payload)) return checked(SchedulePublishPlanResponseSchema, result.payload);
    return checked(SchedulePublishPlanResponseSchema, {
      ...publishCost(result.payload),
      scheduleId: schedule.publicId,
      acceptedContract: acceptedPublishContract(result.payload.acceptedContract),
      availableCredits: result.payload.availableCredits,
      sufficientCredits: result.payload.sufficientCredits,
    });
  }

  async publish(
    identity: SessionIdentity,
    schedulePublicId: string,
    body: SchedulePublicationRequest,
    request: FastifyRequest,
    reply: FastifyReply,
    idempotencyKeyValue?: string,
  ): Promise<SchedulePublicationResponse> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const schedule = await this.schedule(identity, schedulePublicId);
    const result = await this.call(
      request,
      `schedules/${encodeURIComponent(schedule.id)}/publish`,
      { method: 'POST', body, idempotencyKey },
    );
    copySetCookies(reply, result.headers);
    if (!isRecord(result.payload)) return checked(SchedulePublicationResponseSchema, result.payload);
    const settlement = isRecord(result.payload.settlement)
      ? result.payload.settlement
      : {};
    const ledgerIdentities = isRecord(settlement.ledgerIdentities)
      ? settlement.ledgerIdentities
      : {};
    const webhookDeliveries = Array.isArray(ledgerIdentities.webhookDeliveries)
      ? ledgerIdentities.webhookDeliveries.map((entry) => {
        const delivery = isRecord(entry) ? entry : {};
        return {
          deliveryId: delivery.deliveryId,
          ledgerId: delivery.ledgerId,
        };
      })
      : ledgerIdentities.webhookDeliveries;
    const notifications = isRecord(result.payload.notifications)
      ? result.payload.notifications
      : {};
    return checked(SchedulePublicationResponseSchema, {
      id: schedule.publicId,
      status: result.payload.status,
      publishedAt: result.payload.publishedAt,
      settlement: {
        ...publishCost(settlement),
        acceptedContract: acceptedPublishContract(settlement.acceptedContract),
        creditsConsumed: settlement.creditsConsumed,
        newBalance: settlement.newBalance,
        ledgerIdentities: {
          schedule: ledgerIdentities.schedule,
          webhookDeliveries,
        },
      },
      notifications: {
        status: notifications.status,
        delivered: notifications.delivered,
        pending: notifications.pending,
        failed: notifications.failed,
      },
    });
  }

  async startSolve(
    identity: SessionIdentity,
    schedulePublicId: string,
    body: ScheduleSolveRequest,
    request: FastifyRequest,
    reply: FastifyReply,
    idempotencyKeyValue?: string,
  ): Promise<ScheduleSolveResponse> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const schedule = await this.schedule(identity, schedulePublicId);
    const result = await this.call(
      request,
      `schedules/${encodeURIComponent(schedule.id)}/auto-schedule`,
      { method: 'POST', body, idempotencyKey },
    );
    copySetCookies(reply, result.headers);
    if (!isRecord(result.payload) || typeof result.payload.jobId !== 'string') {
      return checked(ScheduleSolveResponseSchema, result.payload);
    }
    const internalJobId = result.payload.jobId;
    const job = await this.database.withTenant(identity.tenantId, (transaction) => (
      transaction.scheduleSolveJob.findFirst({
        where: {
          id: internalJobId,
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
        },
        select: { publicId: true },
      })
    ));
    if (!job) {
      throw new ProblemError(
        502,
        'invalid_compatibility_response',
        'The queued scheduling job could not be resolved.',
        'Bad gateway',
      );
    }
    const creditConsumption = isRecord(result.payload.creditConsumption)
      ? {
        consumedCredits: result.payload.creditConsumption.consumedCredits,
        newBalance: result.payload.creditConsumption.newBalance,
        source: result.payload.creditConsumption.source,
      }
      : result.payload.creditConsumption;
    return checked(ScheduleSolveResponseSchema, {
      jobId: job.publicId,
      status: result.payload.status,
      statusUrl: `/api/v2/schedules/${schedule.publicId}/solve-jobs/${job.publicId}`,
      ...(result.payload.creditConsumption === undefined
        ? {}
        : { creditConsumption }),
      ...(result.payload.publicationStatus === undefined
        ? {}
        : { publicationStatus: result.payload.publicationStatus }),
      ...(result.payload.reused === undefined ? {} : { reused: result.payload.reused }),
    });
  }

  async solveJob(
    identity: SessionIdentity,
    schedulePublicId: string,
    jobPublicId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ScheduleSolveJob> {
    const schedule = await this.schedule(identity, schedulePublicId);
    const job = await this.database.withTenant(identity.tenantId, (transaction) => (
      transaction.scheduleSolveJob.findFirst({
        where: {
          publicId: jobPublicId,
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
        },
        select: { id: true, publicId: true },
      })
    ));
    if (!job) {
      throw new ProblemError(404, 'solve_job_not_found', 'The selected solve job was not found.', 'Solve job not found');
    }
    const result = await this.call(
      request,
      `schedules/${encodeURIComponent(schedule.id)}/auto-schedule/jobs/${encodeURIComponent(job.id)}`,
      { method: 'GET' },
    );
    copySetCookies(reply, result.headers);
    const payload = isRecord(result.payload) ? result.payload : {};
    return checked(ScheduleSolveJobSchema, {
      jobId: job.publicId,
      scheduleId: schedule.publicId,
      locationId: schedule.location.publicId,
      status: typeof payload.status === 'string' ? payload.status : '',
      statusReason: stringOrNull(payload.statusReason),
      retryCount: numberOrNull(payload.retryCount) ?? 0,
      resultShiftCount: numberOrNull(payload.resultShiftCount),
      publicationStatus: typeof payload.publicationStatus === 'string' ? payload.publicationStatus : '',
      startedAt: stringOrNull(payload.startedAt),
      completedAt: stringOrNull(payload.completedAt),
      statusUrl: `/api/v2/schedules/${schedule.publicId}/solve-jobs/${job.publicId}`,
    });
  }

  async generateBreaks(
    identity: SessionIdentity,
    body: BreakGenerationRequest,
    request: FastifyRequest,
    reply: FastifyReply,
    idempotencyKeyValue?: string,
  ): Promise<BreakGenerationResponse> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const references = await this.database.withTenant(identity.tenantId, async (transaction) => {
      const location = await transaction.location.findFirst({
        where: {
          tenantId: identity.tenantId,
          publicId: body.locationId,
          deletedAt: null,
        },
        select: { id: true, publicId: true },
      });
      if (!location) return null;
      const shifts = await transaction.shift.findMany({
        where: {
          tenantId: identity.tenantId,
          publicId: { in: body.shiftIds },
          locationId: location.id,
          deletedAt: null,
        },
        select: {
          id: true,
          publicId: true,
          user: { select: { id: true, publicId: true } },
        },
      });
      return { location, shifts };
    });
    if (!references || references.shifts.length !== new Set(body.shiftIds).size) {
      throw new ProblemError(
        422,
        'invalid_break_generation_scope',
        'Every selected shift must belong to the selected active location.',
        'Break generation validation failed',
      );
    }
    const internalShiftByPublic = new Map(references.shifts.map((shift) => [shift.publicId, shift.id]));
    const publicShiftByInternal = new Map(references.shifts.map((shift) => [shift.id, shift.publicId]));
    const publicUserByInternal = new Map(references.shifts.flatMap((shift) => (
      shift.user ? [[shift.user.id, shift.user.publicId] as const] : []
    )));
    const result = await this.call(request, 'lunch-breaks/generate', {
      method: 'POST',
      idempotencyKey,
      body: {
        locationId: references.location.id,
        shiftIds: body.shiftIds.map((publicId) => internalShiftByPublic.get(publicId)),
        persist: true,
      },
    });
    copySetCookies(reply, result.headers);
    const payload = isRecord(result.payload) ? result.payload : {};
    const data = Array.isArray(payload.data) ? payload.data.map((entry) => {
      const item = isRecord(entry) ? entry : {};
      const shiftId = typeof item.shiftId === 'string'
        ? publicShiftByInternal.get(item.shiftId) ?? null
        : null;
      const userId = typeof item.userId === 'string'
        ? publicUserByInternal.get(item.userId) ?? null
        : null;
      const breaks = Array.isArray(item.breaks) ? item.breaks.map((entry) => {
        const scheduleBreak = isRecord(entry) ? entry : {};
        return {
          type: scheduleBreak.type,
          startTime: scheduleBreak.startTime,
          endTime: scheduleBreak.endTime,
          durationMinutes: scheduleBreak.durationMinutes,
          paid: scheduleBreak.paid,
        };
      }) : item.breaks;
      return {
        shiftId,
        userId,
        employeeName: item.employeeName,
        startTime: item.startTime,
        endTime: item.endTime,
        breaks,
      };
    }) : [];
    const policy = isRecord(payload.policy) ? payload.policy : {};
    const creditConsumption = isRecord(payload.creditConsumption) ? payload.creditConsumption : {};
    return checked(BreakGenerationResponseSchema, {
      locationId: references.location.publicId,
      source: payload.source,
      persisted: payload.persisted,
      policy: {
        break1OffsetMinutes: policy.break1OffsetMinutes,
        lunchOffsetMinutes: policy.lunchOffsetMinutes,
        break2OffsetMinutes: policy.break2OffsetMinutes,
        break1DurationMinutes: policy.break1DurationMinutes,
        lunchDurationMinutes: policy.lunchDurationMinutes,
        break2DurationMinutes: policy.break2DurationMinutes,
        timeStepMinutes: policy.timeStepMinutes,
      },
      creditConsumption: {
        consumedCredits: creditConsumption.consumedCredits,
        newBalance: creditConsumption.newBalance,
        source: creditConsumption.source,
      },
      data,
      reused: payload.reused,
    });
  }
}
