import { Prisma } from '@prisma/client';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ProblemDetails } from '@lunchlineup/api-contract';

export type ProblemViolation = {
  pointer: string;
  code: string;
  message: string;
};

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly title = 'Request could not be completed',
    readonly violations?: ProblemViolation[],
    readonly currentEtag?: string,
  ) {
    super(detail);
    this.name = 'ProblemError';
  }
}

export function problemType(code: string): string {
  return `https://lunchlineup.com/problems/${encodeURIComponent(code.replace(/_/g, '-'))}`;
}

function validationViolations(error: FastifyError): ProblemViolation[] | undefined {
  if (!error.validation) return undefined;
  return error.validation.slice(0, 100).map((entry) => ({
    pointer: entry.instancePath || '/',
    code: entry.keyword || 'invalid',
    message: String(entry.message || 'Value does not match the API contract.').slice(0, 240),
  }));
}

function mappedDatabaseProblem(error: unknown): ProblemError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return new ProblemError(409, 'unique_conflict', 'The request conflicts with an existing resource.', 'Conflict');
    }
    if (error.code === 'P2025') {
      return new ProblemError(404, 'resource_not_found', 'The requested resource was not found.', 'Not found');
    }
  }
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === '23P01') {
    return new ProblemError(
      422,
      'schedule_overlap',
      'The requested final schedule contains overlapping assigned shifts.',
      'Schedule overlap',
    );
  }
  if (['23503', '23514'].includes(code)) {
    return new ProblemError(
      422,
      'schedule_invariant_failed',
      'The requested schedule change violates a persisted scheduling rule.',
      'Schedule validation failed',
    );
  }
  if (code === '40001') {
    return new ProblemError(
      409,
      'concurrent_change',
      'Another scheduling change committed at the same time. Reload and retry.',
      'Concurrent change',
    );
  }
  return null;
}

function toProblem(error: FastifyError | Error | unknown, request: FastifyRequest): ProblemDetails {
  if (error instanceof ProblemError) {
    return {
      type: problemType(error.code),
      title: error.title,
      status: error.status,
      detail: error.message,
      instance: request.url,
      code: error.code,
      requestId: request.id,
      ...(error.violations ? { violations: error.violations } : {}),
      ...(error.currentEtag ? { currentEtag: error.currentEtag } : {}),
    };
  }

  const fastifyError = error as FastifyError;
  if (fastifyError.validation) {
    return {
      type: problemType('contract_validation_failed'),
      title: 'Request contract validation failed',
      status: 422,
      detail: 'One or more request values do not match the API contract.',
      instance: request.url,
      code: 'contract_validation_failed',
      requestId: request.id,
      violations: validationViolations(fastifyError),
    };
  }

  const databaseProblem = mappedDatabaseProblem(error);
  if (databaseProblem) return toProblem(databaseProblem, request);

  return {
    type: problemType('internal_error'),
    title: 'Service error',
    status: 500,
    detail: 'The service could not complete the request.',
    instance: request.url,
    code: 'internal_error',
    requestId: request.id,
  };
}

function sendProblem(reply: FastifyReply, problem: ProblemDetails): void {
  reply
    .code(problem.status)
    .header('Cache-Control', 'no-store')
    .type('application/problem+json')
    .send(problem);
}

export function installProblemHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error, request);
    if (problem.status >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'api_v2_request_failed');
    } else {
      request.log.info({ code: problem.code, status: problem.status, requestId: request.id }, 'api_v2_request_rejected');
    }
    sendProblem(reply, problem);
  });

  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, {
      type: problemType('route_not_found'),
      title: 'Not found',
      status: 404,
      detail: 'The requested API route does not exist.',
      instance: request.url,
      code: 'route_not_found',
      requestId: request.id,
    });
  });
}
