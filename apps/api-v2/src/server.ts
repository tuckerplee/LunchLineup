import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiV2Config } from './config';
import { TenantDatabase } from './platform/database';
import { LegacyIdentityAdapter } from './platform/identity';
import { installProblemHandler } from './platform/problem';
import { ScheduleBoardService } from './scheduling/board.service';
import { ScheduleChangeSetService } from './scheduling/change-set.service';
import { DemandWindowService } from './scheduling/demand-window.service';
import { LegacySchedulingBridge } from './scheduling/legacy-scheduling.bridge';
import { ScheduleLifecycleService } from './scheduling/lifecycle.service';
import {
  registerSchedulingRoutes,
  type SchedulingRouteDependencies,
} from './scheduling/routes';
import { ScheduleCreateService } from './scheduling/schedule-create.service';

const ProbeSchema = Type.Object({
  status: Type.Literal('ok'),
  service: Type.Literal('api-v2'),
});

const VersionSchema = Type.Object({
  service: Type.Literal('api-v2'),
  version: Type.Literal('v2'),
  releaseSha: Type.String({ minLength: 1, maxLength: 40 }),
});

export type ApiV2ServerDependencies = Partial<{
  database: TenantDatabase;
  routes: Omit<SchedulingRouteDependencies, 'config' | 'identity'>;
  identity: LegacyIdentityAdapter;
}>;

export async function buildServer(
  config: ApiV2Config,
  overrides: ApiV2ServerDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    ajv: {
      customOptions: {
        // Mutating removal corrupts discriminated unions while AJV probes each
        // branch. Strict schemas still reject unknown properties.
        removeAdditional: false,
      },
    },
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
    keepAliveTimeout: 72_000,
    maxRequestsPerSocket: 1000,
  }).withTypeProvider<TypeBoxTypeProvider>();
  const database = overrides.database ?? new TenantDatabase();
  const identity = overrides.identity ?? new LegacyIdentityAdapter(config);
  const routeServices = overrides.routes ?? {
    board: new ScheduleBoardService(database),
    scheduleCreate: new ScheduleCreateService(database),
    changeSets: new ScheduleChangeSetService(database),
    demandWindows: new DemandWindowService(database),
    lifecycle: new ScheduleLifecycleService(database),
    retainedScheduling: new LegacySchedulingBridge(config, database),
  };

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'LunchLineup API',
        version: '2.0.0',
        description: 'Contract-first tenant API. Scheduling writes use aggregate change sets, optimistic concurrency, and idempotency.',
      },
      servers: [{ url: '/api/v2', description: 'Same-origin tenant API' }],
      tags: [{ name: 'Scheduling', description: 'Schedule board and aggregate mutations' }],
    },
  });
  installProblemHandler(app);

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/v2/')) {
      reply.header('X-LunchLineup-API-Version', '2');
      reply.header('X-LunchLineup-Service-Release', config.releaseSha);
      reply.header('X-Content-Type-Options', 'nosniff');
    }
    return payload;
  });

  app.get('/v2/live', {
    schema: {
      hide: true,
      response: { 200: ProbeSchema },
    },
  }, async () => ({ status: 'ok' as const, service: 'api-v2' as const }));

  app.get('/v2/ready', {
    schema: {
      hide: true,
      response: { 200: ProbeSchema },
    },
  }, async () => {
    await database.ready();
    return { status: 'ok' as const, service: 'api-v2' as const };
  });

  app.get('/v2/version', {
    schema: {
      summary: 'API v2 release identity',
      response: { 200: VersionSchema },
    },
  }, async () => ({
    service: 'api-v2' as const,
    version: 'v2' as const,
    releaseSha: config.releaseSha,
  }));

  await registerSchedulingRoutes(app, {
    config,
    identity,
    ...routeServices,
  });

  app.get('/v2/openapi.json', {
    schema: {
      hide: true,
      response: { 200: Type.Any() },
    },
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return app.swagger();
  });

  app.addHook('onClose', async () => {
    await database.disconnect();
  });
  return app;
}
