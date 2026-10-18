import type { NativeQuotaAdapter } from '../platform/native-quota';
import {
  ClientEventBatchRequestSchema,
  ClientEventBatchResponseSchema,
  ClientEventRouteProblemResponses,
  type ClientEvent,
  type ClientEventBatchRequest,
} from '@lunchlineup/api-contract';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ApiV2Config } from '../config';
import type { IdentityAdapter } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';

export type ClientEventRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  quota: Pick<NativeQuotaAdapter, 'consume'>;
};

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[0-9]+)$/;

/** Defense in depth: identifiers in a route become `:id` even if a client forgot to. */
export function normalizeClientRoute(route: string): string {
  const segments = route.split('/').map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment));
  return segments.join('/') || '/';
}

export type UiMessageLogRecord = {
  event: 'ui_message';
  code: string;
  level: ClientEvent['level'];
  kind: ClientEvent['kind'];
  route: string;
  outcome?: ClientEvent['outcome'];
  detail?: string;
  tenantId: string;
  userId: string;
};

/**
 * Builds the single structured log shape. Only allow-listed scalar fields are
 * copied; identity always comes from the authenticated session, never the body.
 */
export function uiMessageLogRecord(
  event: ClientEvent,
  identity: { tenantId: string; sub: string },
): UiMessageLogRecord {
  return {
    event: 'ui_message',
    code: event.code,
    level: event.level,
    kind: event.kind,
    route: normalizeClientRoute(event.route),
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    tenantId: identity.tenantId,
    userId: identity.sub,
  };
}

export function logUiMessages(
  log: Pick<FastifyBaseLogger, 'info'>,
  events: readonly ClientEvent[],
  identity: { tenantId: string; sub: string },
): void {
  for (const event of events) log.info(uiMessageLogRecord(event, identity), 'ui_message');
}

/**
 * Same-origin UI message tracking. Stdout (pino) is the sink the estate ships to
 * Loki, so this route stores nothing: it validates, authenticates, rate limits and
 * writes one structured `ui_message` log line per event.
 */
export async function registerClientEventRoutes(
  app: FastifyInstance,
  dependencies: ClientEventRouteDependencies,
): Promise<void> {
  app.post<{ Body: ClientEventBatchRequest }>('/v2/client-events', {
    bodyLimit: 8 * 1024,
    schema: {
      operationId: 'recordClientEvents',
      summary: 'Record a bounded batch of UI message events',
      description: 'Records up to 20 allow-listed UI message events (code, level, route, outcome) for the authenticated session. Free text is never accepted.',
      tags: ['Notifications'],
      body: ClientEventBatchRequestSchema,
      response: { 202: ClientEventBatchResponseSchema, ...ClientEventRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    await dependencies.quota.consume('recordClientEvents', identity, reply);
    logUiMessages(request.log, request.body.events, identity);
    reply.header('Cache-Control', 'private, no-store');
    reply.code(202);
    return { accepted: request.body.events.length };
  });
}
