import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRetentionOperatorBearer, type RetainedOperatorBridge } from '../platform/retained-operator.bridge';

const RetentionPurgeRequestSchema = Type.Object({
  dryRun: Type.Boolean(),
  stage: Type.Union([Type.Literal('application_data'), Type.Literal('retained_records')]),
  executeConfirmation: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
}, { additionalProperties: false });

const RetentionPurgeResponseSchema = Type.Object({}, { additionalProperties: true });

export type RetentionOperatorRouteDependencies = {
  retainedOperators: Pick<RetainedOperatorBridge, 'executeRetentionPurge'>;
};

/** Registers the one v2-only operator ingress used by the scheduled retention job. */
export async function registerRetentionOperatorRoutes(
  app: FastifyInstance,
  dependencies: RetentionOperatorRouteDependencies,
): Promise<void> {
  app.post<{ Body: { dryRun: boolean; stage: 'application_data' | 'retained_records'; executeConfirmation?: string } }>(
    '/v2/admin/retention/purge-expired',
    {
      bodyLimit: 16 * 1024,
      schema: {
        operationId: 'runRetentionPurge',
        summary: 'Run the protected retention purge operator',
        description: 'Service-token-only operator ingress. Browser cookies are never accepted or forwarded.',
        tags: ['Administration'],
        body: RetentionPurgeRequestSchema,
        response: { 200: RetentionPurgeResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireRetentionOperatorBearer(request);
      return dependencies.retainedOperators.executeRetentionPurge(request, reply);
    },
  );
}
