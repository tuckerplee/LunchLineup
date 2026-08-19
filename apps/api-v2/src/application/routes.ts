import {
  APPLICATION_API_OPERATIONS,
  CurrentSessionResponseSchema,
  ProblemDetailsSchema,
  type ApplicationApiOperation,
  type BrowserSessionIdentity,
  type CurrentSessionResponse,
  type SessionIdentity,
} from '@lunchlineup/api-contract';
import { Type, type TSchema } from '@sinclair/typebox';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import type { IdentityAdapter } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { RetainedApplicationBridge } from '../platform/retained-application.bridge';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BROWSER_ROLES = new Set<BrowserSessionIdentity['role']>([
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'STAFF',
]);

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

function browserScope(secret: string, purpose: 'workspace' | 'session', value: string): string {
  return createHmac('sha256', secret)
    .update(`lunchlineup:browser-session-scope:v1:${purpose}:`)
    .update(value)
    .digest('base64url');
}

/** Maps internal authorization context to the intentionally narrower browser contract. */
export function browserSessionIdentity(
  identity: SessionIdentity,
  config: Pick<ApiV2Config, 'jwtSecret'>,
): BrowserSessionIdentity {
  const role = BROWSER_ROLES.has(identity.legacyRole as BrowserSessionIdentity['role'])
    ? identity.legacyRole as BrowserSessionIdentity['role']
    : 'STAFF';
  const workspaceName = identity.tenantName?.trim().slice(0, 200) || 'Workspace';
  const roleLabel = identity.role.trim().slice(0, 128) || role;

  return {
    publicUserId: identity.publicUserId,
    role,
    roleLabel,
    workspaceName,
    workspaceScope: browserScope(config.jwtSecret, 'workspace', identity.tenantId),
    sessionScope: browserScope(
      config.jwtSecret,
      'session',
      `${identity.tenantId}\u0000${identity.sub}\u0000${identity.sessionId}`,
    ),
    permissions: [...new Set(identity.permissions)].sort(),
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.username === undefined ? {} : { username: identity.username }),
    ...(identity.name === undefined ? {} : { name: identity.name }),
    mfaVerified: identity.mfaVerified,
    mfaRequired: identity.mfaRequired,
    ...(identity.pinResetRequired === undefined ? {} : { pinResetRequired: identity.pinResetRequired }),
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
          const identity = await dependencies.identity.authenticate(request as FastifyRequest, reply);
          reply.header('Cache-Control', 'private, no-store');
          return { user: browserSessionIdentity(identity, dependencies.config) } satisfies CurrentSessionResponse;
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
