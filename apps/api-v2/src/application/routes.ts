import {
  APPLICATION_API_OPERATIONS,
  CurrentSessionResponseSchema,
  ProblemDetailsSchema,
  type ApplicationApiOperation,
  type CurrentSessionResponse,
} from '@lunchlineup/api-contract';
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import type { IdentityAdapter } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { RetainedApplicationBridge } from '../platform/retained-application.bridge';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const commonResponses = {
  400: ProblemDetailsSchema,
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

export type ApplicationRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  retainedApplication: Pick<RetainedApplicationBridge, 'execute'>;
};

function pathParameters(path: string): TSchema | undefined {
  const names = path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  if (names.length === 0) return undefined;
  return Type.Object(Object.fromEntries(names.map((name) => [
    name,
    Type.String({ minLength: 1, maxLength: 512 }),
  ])), { additionalProperties: false });
}

function routeSchema(operation: ApplicationApiOperation) {
  const params = pathParameters(operation.path);
  const native = operation.native === true;
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: native
      ? 'Native API-02 session-context owner. Roles, permissions, revocation, MFA state, and session policy are validated directly by API v2.'
      : 'API-01 public contract. The mature implementation is isolated behind the named API-02 compatibility owner.',
    tags: [operation.tag],
    ...(params ? { params } : {}),
    response: {
      200: native ? CurrentSessionResponseSchema : Type.Any(),
      201: Type.Any(),
      202: Type.Any(),
      204: Type.Any(),
      302: Type.Any(),
      303: Type.Any(),
      307: Type.Any(),
      ...commonResponses,
    },
  };
}

export async function registerApplicationRoutes(
  app: FastifyInstance,
  dependencies: ApplicationRouteDependencies,
): Promise<void> {
  for (const catalogOperation of APPLICATION_API_OPERATIONS) {
    const operation: ApplicationApiOperation = catalogOperation;
    // Locations use the native API-02 module. The session-context route lives
    // here because it is the application-wide identity envelope.
    if (operation.native && operation.operationId !== 'getCurrentSession') continue;
    app.route({
      method: operation.method,
      url: `/v2${operation.path}`,
      bodyLimit: operation.bodyLimitBytes,
      schema: routeSchema(operation),
      handler: async (request, reply) => {
        if (operation.operationId === 'getCurrentSession') {
          const user = await dependencies.identity.authenticate(request as FastifyRequest, reply);
          reply.header('Cache-Control', 'private, no-store');
          return { user } satisfies CurrentSessionResponse;
        }
        // Retained authentication routes own their existing login/reset/session
        // CSRF rules. Requiring the application-session double submit token here
        // would reject valid pre-session and reset-token flows.
        if (unsafeMethods.has(operation.method) && operation.tag !== 'Authentication') {
          assertUnsafeRequestSecurity(request as FastifyRequest, dependencies.config);
        }
        // API-02 location translation has to resolve a tenant-scoped public
        // UUID before a retained implementation can see its storage key. The
        // native identity boundary also prevents this compatibility owner from
        // trusting caller-supplied tenant context.
        const identity = operation.tag === 'Authentication'
          ? undefined
          : await dependencies.identity.authenticate(request as FastifyRequest, reply);
        return dependencies.retainedApplication.execute({
          operation,
          request: request as FastifyRequest,
          reply,
          identity,
        });
      },
    });
  }
}
