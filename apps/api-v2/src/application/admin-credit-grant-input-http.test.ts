import 'reflect-metadata';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { BadRequestException, ConflictException, VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import inject from 'light-my-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '../../../api/src/admin/admin.controller';
import { grantActorRequest, grantInputHarness, rejectedGrantInputs, validGrantInput } from '../../../api/src/admin/admin-credit-grant-input.fixture';
import { JwtAuthGuard } from '../../../api/src/auth/jwt-auth.guard';
import { ProductionExceptionFilter } from '../../../api/src/common/production-exception.filter';
import { captureRawBody, resolveRequestBodyLimit } from '../../../api/src/common/bootstrap-security';
import { ZodValidationPipe } from '../../../api/src/common/pipes/zod-validation.pipe';
import { loadConfig } from '../config';
import { installProblemHandler } from '../platform/problem';
import { RetainedApplicationBridge } from '../platform/retained-application.bridge';
import { registerApplicationRoutes } from './routes';

// Real Nest HTTP adapter/router/parser/pipe/filter and inherited AdminController
// method, plus registered API-v2 route/bridge. light-my-request dispatches into
// Express without listeners/sockets. JWT/session and actor authority are explicit
// synthetic seams; actual Metering runs over the staged transaction fixture.
const legacyRequire = createRequire(resolve(process.cwd(), '../api/package.json'));
const express = legacyRequire('express') as typeof import('express');
const origin = 'https://private.example.invalid', csrf = 'synthetic-grant-csrf-token';
const config = loadConfig({ APP_ORIGIN: origin, ALLOWED_ORIGINS: origin,
  LEGACY_API_BASE_URL: 'http://retained.example.invalid/v1', JWT_SECRET: 'synthetic-grant-http-secret',
  NODE_ENV: 'test', LOG_LEVEL: 'silent', METRICS_TOKEN: 'synthetic-grant-http-metrics-token-0000000000000000' });
const capacityMessage = 'Credit amount exceeds the available wallet capacity. Refresh balances and enter a smaller amount.';
const capacityRemediation = 'Refresh balances and enter a smaller amount. Outstanding debt is repaid before adding spendable credits.';
const owners: Array<{ native: INestApplication; app: FastifyInstance; model: ReturnType<typeof grantInputHarness> }> = [];
beforeEach(() => vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'closed-native-http-capability'));
afterEach(async () => {
  try { for (const h of owners.splice(0)) { try { await h.app.close(); } finally { await h.native.close(); h.model.close(); } } }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});
async function harness(initial?: { wallet: number; debt: number }) {
  const model = grantInputHarness(initial), dependencies = model.dependencies;
  class BoundAdminController extends AdminController {
    constructor() {
      super(dependencies.config, dependencies.metrics, dependencies.metering,
        dependencies.tenantDb, undefined, dependencies.rbac);
      // No export maintenance may run during Nest compile/init or grant HTTP tests.
      this.onModuleDestroy();
    }
  }
  // Only constructor dependencies are closed. Original inherited route/method
  // metadata and handler still pass through the actual Nest HTTP adapter.
  Reflect.defineMetadata('design:paramtypes', [], BoundAdminController);
  const module = await Test.createTestingModule({ controllers: [BoundAdminController] })
    .overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
      context.switchToHttp().getRequest().user = { ...grantActorRequest.user }; return true;
    } }).compile();
  const native = module.createNestApplication({ logger: false, bodyParser: false });
  const app = Fastify({ logger: false }); owners.push({ native, app, model });
  const bodyLimit = resolveRequestBodyLimit();
  native.use(express.json({ limit: bodyLimit, verify: captureRawBody }));
  native.use(express.urlencoded({ extended: true, limit: bodyLimit, verify: captureRawBody }));
  native.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  native.useGlobalPipes(new ZodValidationPipe()); native.useGlobalFilters(new ProductionExceptionFilter());
  await native.init();
  const nativeReceipts: Array<{ requestBody: string; status: number; body: string }> = [];
  const nativeWire = async (requestBody: string, key = 'http-grant-key') => {
    const response = await inject(native.getHttpAdapter().getInstance(), { method: 'POST', url: '/v1/admin/credits/grant',
      headers: { 'content-type': 'application/json', 'idempotency-key': key }, payload: requestBody });
    nativeReceipts.push({ requestBody, status: response.statusCode, body: response.body }); return response;
  };
  const nativeRequest = (body: unknown, key = 'http-grant-key') => {
    const requestBody = JSON.stringify(body);
    if (requestBody === undefined) throw new Error('HTTP fixture requires a serializable JSON body');
    return nativeWire(requestBody, key);
  };
  const forwarded = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    expect(String(target)).toBe('http://retained.example.invalid/v1/admin/credits/grant'); expect(init?.method).toBe('POST');
    const response = await nativeWire(String(init?.body), new Headers(init?.headers).get('idempotency-key')!);
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', forwarded);
  await app.register(cookie); installProblemHandler(app);
  const authenticate = vi.fn(async () => ({ tenantId: 'platform-opaque-id', userId: 'actor-opaque-id' }));
  await registerApplicationRoutes(app, { config, identity: { authenticate } as never,
    quota: { consume: vi.fn() }, retainedApplication: new RetainedApplicationBridge(config) });
  await app.ready();
  const request = (body: unknown, overrides: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/v2/admin/credits/grant',
    headers: { 'content-type': 'application/json', cookie: `csrf_token=${csrf}`, origin,
      'x-csrf-token': csrf, 'idempotency-key': 'http-grant-key', ...overrides }, payload: JSON.stringify(body) });
  return { nativeRequest, nativeReceipts, request, model, forwarded, authenticate };
}
describe('Registered credit grant HTTP input boundary', () => {
  it.each(rejectedGrantInputs)('maps native refusal for $label to422 with zero settlement work', async ({ body }) => {
    const h = await harness(); const response = await h.request(body);
    expect(response.statusCode).toBe(422); expect(response.json()).toMatchObject({ status: 422, message: 'Bad request', detail: 'Bad request' });
    expect(response.json()).not.toHaveProperty('success'); expect(response.json()).not.toHaveProperty('newBalance');
    expect(h.nativeReceipts).toHaveLength(1); expect(h.nativeReceipts[0].status).toBe(400);
    expect(h.forwarded).toHaveBeenCalledOnce(); expect(h.authenticate).toHaveBeenCalledOnce();
    expect(h.model.prisma.$transaction).not.toHaveBeenCalled(); expect(h.model.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.model.prisma.$executeRaw).not.toHaveBeenCalled(); expect(h.model.authority).not.toHaveBeenCalled(); expect(h.model.settle).not.toHaveBeenCalled();
    expect(h.model.state()).toEqual({ wallet: 40, debt: 0, ledger: [], audits: [] });
  });
  it('preserves padded500 input and opaque tenant identity through both actual HTTP boundaries', async () => {
    const h = await harness(); const body = { ...validGrantInput, tenantId: '  legacy-opaque-tenant  ', reason: `  ${'😀'.repeat(250)}  ` };
    const first = await h.request(body); expect(first.statusCode).toBe(201); expect(first.json()).toEqual({ success: true, newBalance: 65 });
    const second = await h.request(body); expect(second.statusCode).toBe(201); expect(second.json()).toEqual(first.json());
    expect(h.model.settle).toHaveBeenCalledWith(h.model.prisma, { tenantId: validGrantInput.tenantId, amount: 25, reason: body.reason.trim(), idempotencyKey: 'http-grant-key' });
    expect(h.model.prisma.tenant.update).toHaveBeenCalledOnce(); expect(h.model.ledger.size).toBe(1); expect(h.model.audits.size).toBe(1);
    expect(h.nativeReceipts.every(receipt => receipt.requestBody === JSON.stringify(body))).toBe(true);
  });
  it('exposes only allowlisted capacity guidance through installed native filter and API-v2 mapping', async () => {
    const h = await harness({ wallet: 2_147_483_647, debt: 0 }); const body = { ...validGrantInput, amount: 1 };
    const native = await h.nativeRequest(body); expect(native.statusCode).toBe(400);
    expect(native.json()).toMatchObject({ statusCode: 400, code: 'CREDIT_WALLET_CAPACITY_EXCEEDED', message: capacityMessage, remediation: capacityRemediation });
    const response = await h.request(body); expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 422, message: capacityMessage, detail: capacityMessage,
      legacyCode: 'CREDIT_WALLET_CAPACITY_EXCEEDED', remediation: capacityRemediation });
    expect(response.json()).not.toHaveProperty('success'); expect(response.json()).not.toHaveProperty('newBalance');
    expect(h.model.prisma.$transaction).toHaveBeenCalledTimes(2); expect(h.model.authority).toHaveBeenCalledTimes(2);
    expect(h.model.prisma.tenant.findUniqueOrThrow).toHaveBeenCalledTimes(2);
    expect(h.model.prisma.tenant.update).not.toHaveBeenCalled(); expect(h.model.ledger.size).toBe(0); expect(h.model.audits.size).toBe(0);
  });
  it.each([
    { label: 'unknown code', failure: new BadRequestException({ code: 'PRIVATE_STORAGE_FAILURE', message: 'private capacity detail' }), status: 422, message: 'Bad request' },
    { label: 'mismatched status', failure: new ConflictException({ code: 'CREDIT_WALLET_CAPACITY_EXCEEDED', message: 'private capacity detail' }), status: 409, message: 'Conflict' },
  ])('redacts $label in the native HTTP filter before forwarding', async ({ failure, status, message }) => {
    const h = await harness(); h.model.settle.mockRejectedValueOnce(failure);
    const response = await h.request(validGrantInput); expect(response.statusCode).toBe(status); expect(response.json().message).toBe(message);
    expect(response.json()).not.toHaveProperty('legacyCode'); expect(response.json()).not.toHaveProperty('remediation');
    expect(response.body).not.toContain('private'); expect(h.nativeReceipts[0].body).not.toContain('private');
    expect(h.model.prisma.tenant.update).not.toHaveBeenCalled(); expect(h.model.ledger.size).toBe(0); expect(h.model.audits.size).toBe(0);
  });
  it('uses fixed capacity text instead of a private message attached to the allowlisted code', async () => {
    const h = await harness(); h.model.settle.mockRejectedValueOnce(new BadRequestException({
      code: 'CREDIT_WALLET_CAPACITY_EXCEEDED', message: 'private database row detail', remediation: 'private remediation',
    }));
    const response = await h.request(validGrantInput); expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ message: capacityMessage, detail: capacityMessage,
      legacyCode: 'CREDIT_WALLET_CAPACITY_EXCEEDED', remediation: capacityRemediation });
    expect(response.body).not.toContain('private'); expect(h.nativeReceipts[0].body).not.toContain('private');
    expect(h.model.prisma.tenant.update).not.toHaveBeenCalled(); expect(h.model.ledger.size).toBe(0); expect(h.model.audits.size).toBe(0);
  });
  it('keeps CSRF refusal before native dispatch', async () => {
    const h = await harness(); const response = await h.request(validGrantInput, { 'x-csrf-token': 'wrong-token' });
    expect(response.statusCode).toBe(403); expect(h.forwarded).not.toHaveBeenCalled(); expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.model.prisma.$transaction).not.toHaveBeenCalled();
  });
});
