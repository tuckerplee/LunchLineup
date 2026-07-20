import {
  PayrollAmendmentDecisionRequestSchema,
  PayrollAmendmentDecisionResponseSchema,
  PayrollAmendmentPathSchema,
  PayrollAmendmentRequestSchema,
  PayrollAmendmentSchema,
  PayrollCardsAdoptRequestSchema,
  PayrollCardsAdoptResponseSchema,
  PayrollDecisionsRequestSchema,
  PayrollDecisionsResponseSchema,
  PayrollEntryPathSchema,
  PayrollExpectedRevisionRequestSchema,
  PayrollExportEntitlementSchema,
  PayrollExportPathSchema,
  PayrollExportQuerySchema,
  PayrollExportRequestSchema,
  PayrollExportSchema,
  PayrollPeriodCreateRequestSchema,
  PayrollPeriodDetailQuerySchema,
  PayrollPeriodDetailResponseSchema,
  PayrollPeriodListQuerySchema,
  PayrollPeriodListResponseSchema,
  PayrollPeriodPathSchema,
  PayrollPeriodSchema,
  PayrollPolicyListQuerySchema,
  PayrollPolicyListResponseSchema,
  PayrollPolicyRequestSchema,
  PayrollPolicyResponseSchema,
  PayrollPolicySchema,
  PayrollReconciliationReceiptSchema,
  PayrollReconciliationRequestSchema,
  PayrollRouteProblemResponses,
  type PayrollAmendmentDecisionRequest,
  type PayrollAmendmentRequest,
  type PayrollCardsAdoptRequest,
  type PayrollDecisionsRequest,
  type PayrollExpectedRevisionRequest,
  type PayrollExportQuery,
  type PayrollExportRequest,
  type PayrollPeriodCreateRequest,
  type PayrollPeriodDetailQuery,
  type PayrollPeriodListQuery,
  type PayrollPolicyListQuery,
  type PayrollPolicyRequest,
  type PayrollReconciliationRequest,
} from '@lunchlineup/api-contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { PayrollService } from './payroll.service';

export type PayrollRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  payroll: Pick<PayrollService,
    | 'listPolicies'
    | 'latestPolicy'
    | 'createPolicy'
    | 'listPeriods'
    | 'createPeriod'
    | 'getPeriod'
    | 'startReview'
    | 'adoptCards'
    | 'decideCards'
    | 'lockPeriod'
    | 'createAmendment'
    | 'decideAmendment'
    | 'exportEntitlement'
    | 'createExport'
    | 'getExport'
    | 'downloadExport'
    | 'reconcileExport'
  >;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Native API-02 Payroll owner. Every resource identifier on this surface is a
 * tenant-scoped public UUID; no retained HTTP controller or internal database
 * identifier is exposed to the browser.
 */
export async function registerPayrollRoutes(
  app: FastifyInstance,
  dependencies: PayrollRouteDependencies,
): Promise<void> {
  app.get('/v2/payroll/export-entitlement', {
    schema: {
      operationId: 'getPayrollExportEntitlement',
      summary: 'Read payroll export entitlement',
      description: 'Reads the current paid time-card credit eligibility required to create a payroll export.',
      tags: ['Payroll'],
      response: { 200: PayrollExportEntitlementSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:export']);
    const response = await dependencies.payroll.exportEntitlement(identity);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Querystring: PayrollPolicyListQuery }>('/v2/payroll/policies', {
    schema: {
      operationId: 'listPayrollPolicies',
      summary: 'List payroll policy versions',
      description: 'Lists immutable payroll policy versions with opaque cursors and public UUIDs.',
      tags: ['Payroll'],
      querystring: PayrollPolicyListQuerySchema,
      response: { 200: PayrollPolicyListResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:read']);
    const response = await dependencies.payroll.listPolicies(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get('/v2/payroll/policy', {
    schema: {
      operationId: 'getPayrollPolicy',
      summary: 'Read the current payroll policy',
      description: 'Reads the latest immutable payroll policy version for the tenant.',
      tags: ['Payroll'],
      response: { 200: PayrollPolicyResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:read']);
    const response = await dependencies.payroll.latestPolicy(identity);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{ Body: PayrollPolicyRequest }>('/v2/payroll/policy', {
    schema: {
      operationId: 'createPayrollPolicy',
      summary: 'Create a payroll policy version',
      description: 'Creates a future-effective immutable payroll policy with durable idempotency.',
      tags: ['Payroll'],
      body: PayrollPolicyRequestSchema,
      response: { 200: PayrollPolicySchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:policy_write']);
    const response = await dependencies.payroll.createPolicy(identity, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Querystring: PayrollPeriodListQuery }>('/v2/payroll/periods', {
    schema: {
      operationId: 'listPayrollPeriods',
      summary: 'List payroll periods',
      description: 'Lists payroll period summaries with opaque public-ID cursors.',
      tags: ['Payroll'],
      querystring: PayrollPeriodListQuerySchema,
      response: { 200: PayrollPeriodListResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:read']);
    const response = await dependencies.payroll.listPeriods(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: PayrollPeriodCreateRequest }>('/v2/payroll/periods', {
    schema: {
      operationId: 'createPayrollPeriod',
      summary: 'Create a payroll period',
      description: 'Creates one policy-aligned payroll period with durable idempotency.',
      tags: ['Payroll'],
      body: PayrollPeriodCreateRequestSchema,
      response: { 200: PayrollPeriodSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:policy_write']);
    const response = await dependencies.payroll.createPeriod(identity, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{
    Params: { periodId: string };
    Querystring: PayrollPeriodDetailQuery;
  }>('/v2/payroll/periods/:periodId', {
    schema: {
      operationId: 'getPayrollPeriod',
      summary: 'Read one payroll period',
      description: 'Reads a tenant payroll period, card decisions, immutable entries, amendments, and export state by public UUID.',
      tags: ['Payroll'],
      params: PayrollPeriodPathSchema,
      querystring: PayrollPeriodDetailQuerySchema,
      response: { 200: PayrollPeriodDetailResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:read']);
    const response = await dependencies.payroll.getPeriod(identity, request.params.periodId, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { periodId: string };
    Body: PayrollCardsAdoptRequest;
  }>('/v2/payroll/periods/:periodId/adopt', {
    schema: {
      operationId: 'adoptPayrollTimeCards',
      summary: 'Adopt time cards into a payroll period',
      description: 'Adopts closed public time cards with revision fencing and durable idempotency.',
      tags: ['Payroll'],
      params: PayrollPeriodPathSchema,
      body: PayrollCardsAdoptRequestSchema,
      response: { 200: PayrollCardsAdoptResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:policy_write']);
    const response = await dependencies.payroll.adoptCards(identity, request.params.periodId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { periodId: string };
    Body: PayrollExpectedRevisionRequest;
  }>('/v2/payroll/periods/:periodId/review', {
    schema: {
      operationId: 'startPayrollReview',
      summary: 'Start payroll review',
      description: 'Moves an open payroll period into review with optimistic revision fencing.',
      tags: ['Payroll'],
      params: PayrollPeriodPathSchema,
      body: PayrollExpectedRevisionRequestSchema,
      response: { 200: PayrollPeriodSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:lock']);
    const response = await dependencies.payroll.startReview(identity, request.params.periodId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { periodId: string };
    Body: PayrollDecisionsRequest;
  }>('/v2/payroll/periods/:periodId/decisions', {
    schema: {
      operationId: 'decidePayrollEntries',
      summary: 'Record payroll entry decisions',
      description: 'Records public time-card approval decisions with revision fencing and durable idempotency.',
      tags: ['Payroll'],
      params: PayrollPeriodPathSchema,
      body: PayrollDecisionsRequestSchema,
      response: { 200: PayrollDecisionsResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['time_cards:approve']);
    const response = await dependencies.payroll.decideCards(identity, request.params.periodId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { periodId: string };
    Body: PayrollExpectedRevisionRequest;
  }>('/v2/payroll/periods/:periodId/lock', {
    schema: {
      operationId: 'lockPayrollPeriod',
      summary: 'Lock a payroll period',
      description: 'Locks approved payroll evidence as immutable snapshots with an aggregate integrity hash.',
      tags: ['Payroll'],
      params: PayrollPeriodPathSchema,
      body: PayrollExpectedRevisionRequestSchema,
      response: { 200: PayrollPeriodSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:lock']);
    const response = await dependencies.payroll.lockPeriod(identity, request.params.periodId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { entryId: string };
    Body: PayrollAmendmentRequest;
  }>('/v2/payroll/entries/:entryId/amendments', {
    schema: {
      operationId: 'createPayrollAmendment',
      summary: 'Create a payroll amendment',
      description: 'Creates a public payroll amendment against immutable locked evidence with durable idempotency.',
      tags: ['Payroll'],
      params: PayrollEntryPathSchema,
      body: PayrollAmendmentRequestSchema,
      response: { 200: PayrollAmendmentSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:reconcile']);
    const response = await dependencies.payroll.createAmendment(identity, request.params.entryId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { amendmentId: string };
    Body: PayrollAmendmentDecisionRequest;
  }>('/v2/payroll/amendments/:amendmentId/decision', {
    schema: {
      operationId: 'decidePayrollAmendment',
      summary: 'Decide a payroll amendment',
      description: 'Records a public payroll amendment approval or rejection with durable idempotency.',
      tags: ['Payroll'],
      params: PayrollAmendmentPathSchema,
      body: PayrollAmendmentDecisionRequestSchema,
      response: { 200: PayrollAmendmentDecisionResponseSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['time_cards:approve']);
    const response = await dependencies.payroll.decideAmendment(identity, request.params.amendmentId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { periodId: string };
    Body: PayrollExportRequest;
  }>('/v2/payroll/periods/:periodId/exports', {
    schema: {
      operationId: 'createPayrollExport',
      summary: 'Create a payroll export',
      description: 'Creates one paid, immutable payroll export with exactly-once credit settlement and public CSV identifiers.',
      tags: ['Payroll'],
      params: PayrollPeriodPathSchema,
      body: PayrollExportRequestSchema,
      response: { 200: PayrollExportSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:export']);
    const response = await dependencies.payroll.createExport(identity, request.params.periodId, request.body, header(request, 'idempotency-key'));
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{
    Params: { exportId: string };
    Querystring: PayrollExportQuery;
  }>('/v2/payroll/exports/:exportId', {
    schema: {
      operationId: 'getPayrollExport',
      summary: 'Read one payroll export',
      description: 'Reads a payroll export, bounded line page, and reconciliation summary by public UUID.',
      tags: ['Payroll'],
      params: PayrollExportPathSchema,
      querystring: PayrollExportQuerySchema,
      response: { 200: PayrollExportSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:read']);
    const response = await dependencies.payroll.getExport(identity, request.params.exportId, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Params: { exportId: string } }>('/v2/payroll/exports/:exportId/download', {
    schema: {
      operationId: 'downloadPayrollExport',
      summary: 'Download one payroll export',
      description: 'Downloads verified immutable payroll CSV evidence using public CSV identifiers only.',
      tags: ['Payroll'],
      params: PayrollExportPathSchema,
      response: PayrollRouteProblemResponses,
    },
  }, async (request, reply) => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:export']);
    const artifact = await dependencies.payroll.downloadExport(identity, request.params.exportId);
    reply
      .header('Cache-Control', 'private, no-store')
      .header('Pragma', 'no-cache')
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Length', String(artifact.content.length))
      .header('Content-Disposition', `attachment; filename="${artifact.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
      .send(artifact.content);
  });

  app.post<{
    Params: { exportId: string };
    Body: PayrollReconciliationRequest;
  }>('/v2/payroll/exports/:exportId/reconciliation', {
    schema: {
      operationId: 'reconcilePayrollExport',
      summary: 'Reconcile a payroll export',
      description: 'Records a provider event and public export-line outcomes exactly once.',
      tags: ['Payroll'],
      params: PayrollExportPathSchema,
      body: PayrollReconciliationRequestSchema,
      response: { 200: PayrollReconciliationReceiptSchema, ...PayrollRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['payroll:reconcile']);
    const response = await dependencies.payroll.reconcileExport(identity, request.params.exportId, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });
}
