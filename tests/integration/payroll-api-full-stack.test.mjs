import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECURE = 'false';
process.env.JWT_SECRET ||= 'payroll-full-stack-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'payroll-full-stack-refresh-secret';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const cookieParser = require('cookie-parser');
const { payrollRequestIdentity } = require('../../apps/api/src/payroll/payroll-idempotency.ts');
const { Module, VersioningType } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { APP_GUARD, NestFactory } = require('@nestjs/core');
const { AuthModule } = require('../../apps/api/src/auth/auth.module.ts');
const { AuthService } = require('../../apps/api/src/auth/auth.service.ts');
const { JwtAuthGuard } = require('../../apps/api/src/auth/jwt-auth.guard.ts');
const { JwtService } = require('../../apps/api/src/auth/jwt.service.ts');
const { OtpService } = require('../../apps/api/src/auth/otp.service.ts');
const { RbacGuard } = require('../../apps/api/src/auth/rbac.guard.ts');
const { RbacService } = require('../../apps/api/src/auth/rbac.service.ts');
const { ZodValidationPipe } = require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
const { PayrollModule } = require('../../apps/api/src/payroll/payroll.module.ts');

class PayrollFullStackModule {}
Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    PayrollModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
  ],
})(PayrollFullStackModule);

const HTTP_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 20_000;

function serviceUrl(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for payroll full-stack proof`);
  return value;
}

function prisma(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function fixture() {
  const suffix = randomUUID();
  return {
    suffix,
    primaryTenantId: `tenant-payroll-api-primary-${suffix}`,
    isolatedTenantId: `tenant-payroll-api-isolated-${suffix}`,
    primarySlug: `payroll-api-primary-${suffix}`,
    isolatedSlug: `payroll-api-isolated-${suffix}`,
    adminId: `admin-payroll-api-${suffix}`,
    nonMfaAdminId: `admin-payroll-no-mfa-${suffix}`,
    managerId: `manager-payroll-api-${suffix}`,
    employeeId: `employee-payroll-api-${suffix}`,
    isolatedAdminId: `admin-payroll-isolated-${suffix}`,
    adminSessionId: `session-payroll-admin-${suffix}`,
    nonMfaAdminSessionId: `session-payroll-no-mfa-${suffix}`,
    managerSessionId: `session-payroll-manager-${suffix}`,
    isolatedAdminSessionId: `session-payroll-isolated-${suffix}`,
    locationId: `location-payroll-api-${suffix}`,
    policyId: `policy-payroll-api-${suffix}`,
    periodId: `period-payroll-api-${suffix}`,
    timeCardId: `card-payroll-api-${suffix}`,
  };
}

async function bounded(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startApi() {
  const app = await bounded(
    NestFactory.create(PayrollFullStackModule, { logger: false }),
    STARTUP_TIMEOUT_MS,
    'Nest application creation',
  );
  app.use(cookieParser());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ZodValidationPipe());
  await bounded(app.listen(0, '127.0.0.1'), STARTUP_TIMEOUT_MS, 'Nest HTTP startup');
  const address = app.getHttpServer().address();
  assert.ok(address && typeof address === 'object', 'Nest HTTP server did not expose a bound address');
  return { app, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function apiRequest(baseUrl, token, method, path, options = {}) {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const content = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  let json = null;
  if (contentType.includes('application/json') && content.length > 0) {
    json = JSON.parse(content.toString('utf8'));
  }
  return { response, content, json };
}

async function holdPayrollTenantBarrier(owner, tenantId) {
  let releaseBarrier;
  let resolveReady;
  let rejectReady;
  const released = new Promise((resolveRelease) => { releaseBarrier = resolveRelease; });
  const ready = new Promise((resolvePid, rejectPid) => {
    resolveReady = resolvePid;
    rejectReady = rejectPid;
  });
  const transaction = owner.$transaction(async (tx) => {
    try {
      const [backend] = await tx.$queryRawUnsafe('SELECT pg_backend_pid()::integer AS pid');
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        `lunchlineup:payroll:${tenantId}`,
      );
      resolveReady(Number(backend.pid));
      await released;
    } catch (error) {
      rejectReady(error);
      throw error;
    }
  }, { maxWait: 5_000, timeout: 20_000 });
  const holderPid = await bounded(ready, 5_000, 'payroll advisory barrier acquisition');
  let releasedOnce = false;
  return {
    holderPid,
    async release() {
      if (!releasedOnce) {
        releasedOnce = true;
        releaseBarrier();
      }
      await transaction;
    },
  };
}

async function waitForPayrollBarrierWaiters(owner, holderPid, expected, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await owner.$queryRawUnsafe(`
      SELECT count(DISTINCT waiter.pid)::integer AS "count"
      FROM pg_locks holder
      JOIN pg_locks waiter
        ON waiter.locktype = holder.locktype
       AND waiter.database IS NOT DISTINCT FROM holder.database
       AND waiter.classid IS NOT DISTINCT FROM holder.classid
       AND waiter.objid IS NOT DISTINCT FROM holder.objid
       AND waiter.objsubid IS NOT DISTINCT FROM holder.objsubid
       AND waiter.mode = holder.mode
      WHERE holder.pid = $1
        AND holder.locktype = 'advisory'
        AND holder.granted = true
        AND waiter.pid <> holder.pid
        AND waiter.granted = false
    `, holderPid);
    if (Number(row?.count ?? 0) >= expected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`${label} did not place ${expected} payroll transactions behind the advisory barrier`);
}

async function runSameKeyBehindPayrollBarrier(owner, tenantId, request, label) {
  const barrier = await holdPayrollTenantBarrier(owner, tenantId);
  const requests = Promise.all([request(), request()]);
  let barrierError = null;
  try {
    await waitForPayrollBarrierWaiters(owner, barrier.holderPid, 2, label);
  } catch (error) {
    barrierError = error;
  }
  await barrier.release();
  if (barrierError) {
    await Promise.allSettled([requests]);
    throw barrierError;
  }
  return bounded(requests, HTTP_TIMEOUT_MS * 2, label);
}

function assertJsonStatus(result, status, message) {
  assert.equal(result.response.status, status, `${message}: ${result.content.toString('utf8')}`);
  assert.ok(result.json && typeof result.json === 'object', `${message}: expected a JSON response`);
  return result.json;
}

async function createFixture(owner, values) {
  await owner.tenant.createMany({
    data: [
      {
        id: values.primaryTenantId,
        name: 'Payroll API Primary',
        slug: values.primarySlug,
        planTier: 'GROWTH',
        stripeSubscriptionId: `sub_payroll_primary_${values.suffix}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        status: 'ACTIVE',
        usageCredits: 5,
      },
      {
        id: values.isolatedTenantId,
        name: 'Payroll API Isolated',
        slug: values.isolatedSlug,
        status: 'ACTIVE',
      },
    ],
  });
  await owner.user.createMany({
    data: [
      {
        id: values.adminId,
        tenantId: values.primaryTenantId,
        name: 'Payroll MFA Admin',
        role: 'ADMIN',
        mfaEnabled: false,
        mfaBackupCodes: [],
      },
      {
        id: values.nonMfaAdminId,
        tenantId: values.primaryTenantId,
        name: 'Payroll Non-MFA Admin',
        role: 'ADMIN',
        mfaEnabled: false,
        mfaBackupCodes: [],
      },
      {
        id: values.managerId,
        tenantId: values.primaryTenantId,
        name: 'Payroll Read-Only Manager',
        role: 'MANAGER',
        mfaEnabled: false,
        mfaBackupCodes: [],
      },
      {
        id: values.employeeId,
        tenantId: values.primaryTenantId,
        name: 'Payroll Employee',
        role: 'STAFF',
        mfaEnabled: false,
        mfaBackupCodes: [],
      },
      {
        id: values.isolatedAdminId,
        tenantId: values.isolatedTenantId,
        name: 'Payroll Isolated Admin',
        role: 'ADMIN',
        mfaEnabled: false,
        mfaBackupCodes: [],
      },
    ],
  });
  await owner.session.createMany({
    data: [
      [values.adminSessionId, values.adminId, 'admin'],
      [values.nonMfaAdminSessionId, values.nonMfaAdminId, 'non-mfa-admin'],
      [values.managerSessionId, values.managerId, 'manager'],
      [values.isolatedAdminSessionId, values.isolatedAdminId, 'isolated-admin'],
    ].map(([id, userId, label]) => ({
      id,
      userId,
      selectorHash: `selector-${label}-${values.suffix}`,
      refreshToken: `refresh-${label}-${values.suffix}`,
      ipAddress: '127.0.0.1',
      userAgent: 'payroll-api-full-stack-test',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
  });
  await owner.location.create({
    data: {
      id: values.locationId,
      tenantId: values.primaryTenantId,
      name: 'Payroll API Location',
      timezone: 'America/Los_Angeles',
    },
  });
  await owner.payrollPolicyVersion.create({
    data: {
      id: values.policyId,
      tenantId: values.primaryTenantId,
      version: 1,
      timeZone: 'America/Los_Angeles',
      cadence: 'WEEKLY',
      anchorDate: new Date('2026-06-01T00:00:00.000Z'),
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      operationId: `policy-op-${values.suffix}`,
      requestHash: 'a'.repeat(64),
      createdByUserId: values.adminId,
    },
  });
  await owner.payrollPeriod.create({
    data: {
      id: values.periodId,
      tenantId: values.primaryTenantId,
      policyVersionId: values.policyId,
      localStartDate: new Date('2026-06-01T00:00:00.000Z'),
      localEndDateExclusive: new Date('2026-06-08T00:00:00.000Z'),
      startsAt: new Date('2026-06-01T07:00:00.000Z'),
      endsAt: new Date('2026-06-08T07:00:00.000Z'),
      timeZone: 'America/Los_Angeles',
      cadence: 'WEEKLY',
      status: 'OPEN',
      revision: 0,
    },
  });
  await owner.timeCard.create({
    data: {
      id: values.timeCardId,
      tenantId: values.primaryTenantId,
      userId: values.employeeId,
      locationId: values.locationId,
      clockInAt: new Date('2026-06-02T16:00:00.000Z'),
      clockOutAt: new Date('2026-06-03T00:00:00.000Z'),
      payrollPeriodId: values.periodId,
      workTimeZone: 'America/Los_Angeles',
      revision: 1,
      breakMinutes: 0,
      status: 'CLOSED',
    },
  });
}

async function provisionAccess(rbac, values) {
  await rbac.ensureTenantRoles(values.primaryTenantId);
  await rbac.ensureTenantRoles(values.isolatedTenantId);
  await rbac.assignLegacySystemRole(values.adminId, values.primaryTenantId, 'ADMIN');
  await rbac.assignLegacySystemRole(values.nonMfaAdminId, values.primaryTenantId, 'ADMIN');
  await rbac.assignLegacySystemRole(values.managerId, values.primaryTenantId, 'MANAGER');
  await rbac.assignLegacySystemRole(values.isolatedAdminId, values.isolatedTenantId, 'ADMIN');
}

function accessToken(jwt, userId, tenantId, sessionId, legacyRole, mfaVerified) {
  return jwt.generateAccessToken({
    sub: userId,
    tenantId,
    role: legacyRole,
    legacyRole,
    sessionId,
    mfaVerified,
    pinResetRequired: false,
  });
}

async function cleanupFixture(owner, values) {
  const tenantIds = [values.primaryTenantId, values.isolatedTenantId];
  const userIds = [values.adminId, values.nonMfaAdminId, values.managerId, values.employeeId, values.isolatedAdminId];
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    for (const table of [
      'PayrollReconciliationLineState',
      'PayrollReconciliationLineEvent',
      'PayrollReconciliationReceipt',
      'PayrollExportLine',
      'PayrollExportBatch',
      'PayrollLockedEntry',
      'PayrollAmendmentDecision',
      'PayrollAmendment',
      'PayrollOperation',
      'PayrollTimeCardApproval',
      'TimeCardBreak',
      'TimeCard',
      'PayrollPeriod',
      'PayrollPolicyVersion',
      'AuditLog',
      'CreditTransaction',
      'Notification',
      'NotificationOutbox',
      'TenantSetting',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    }
    await tx.$executeRawUnsafe('DELETE FROM "RefreshTokenReplay" WHERE "sessionId" IN (SELECT "id" FROM "Session" WHERE "userId" = ANY($1::text[]))', userIds);
    await tx.$executeRawUnsafe('DELETE FROM "Session" WHERE "userId" = ANY($1::text[])', userIds);
    await tx.$executeRawUnsafe('DELETE FROM "RoleAssignment" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "RolePermission" WHERE "roleId" IN (SELECT "id" FROM "Role" WHERE "tenantId" = ANY($1::text[]))', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "Role" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "Location" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "User" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])', tenantIds);
  });
}

test('real payroll HTTP/auth/services use PostgreSQL for guarded exact-once export and reconciliation', { timeout: 120_000 }, async () => {
  serviceUrl('PLATFORM_ADMIN_DB_CONTEXT_SECRET');
  const owner = prisma(serviceUrl('MIGRATION_DATABASE_URL'));
  const restricted = prisma(serviceUrl('DATABASE_URL'));
  const redis = new Redis(serviceUrl('REDIS_URL'), {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 5_000,
  });
  const values = fixture();
  const mfaSessionIds = [values.adminSessionId, values.managerSessionId, values.isolatedAdminSessionId];
  let app;
  let authService;
  let otpService;

  try {
    const [ownerIdentity, restrictedIdentity, schemaState] = await Promise.all([
      owner.$queryRawUnsafe('SELECT current_user AS "user"'),
      restricted.$queryRawUnsafe('SELECT current_user AS "user"'),
      owner.$queryRawUnsafe(`SELECT to_regclass('"PayrollExportBatch"') IS NOT NULL AS ready`),
    ]);
    assert.notEqual(
      ownerIdentity[0].user,
      restrictedIdentity[0].user,
      'the API must use a restricted database role distinct from the migration owner',
    );
    assert.equal(schemaState[0].ready, true, 'payroll migrations must be applied before fixtures are created');
    await bounded(redis.connect(), 5_000, 'Redis connection');
    assert.equal(await bounded(redis.ping(), 5_000, 'Redis readiness'), 'PONG');

    await createFixture(owner, values);
    const started = await startApi();
    app = started.app;
    const jwt = app.get(JwtService);
    const rbac = app.get(RbacService);
    authService = app.get(AuthService);
    otpService = app.get(OtpService);
    await provisionAccess(rbac, values);
    await redis.set(
      `session_mfa:${values.adminSessionId}`,
      '1',
      'EX',
      3_600,
    );
    await redis.set(`session_mfa:${values.managerSessionId}`, '1', 'EX', 3_600);
    await redis.set(`session_mfa:${values.isolatedAdminSessionId}`, '1', 'EX', 3_600);

    const adminToken = accessToken(
      jwt,
      values.adminId,
      values.primaryTenantId,
      values.adminSessionId,
      'ADMIN',
      true,
    );
    const nonMfaAdminToken = accessToken(
      jwt,
      values.nonMfaAdminId,
      values.primaryTenantId,
      values.nonMfaAdminSessionId,
      'ADMIN',
      false,
    );
    const managerToken = accessToken(
      jwt,
      values.managerId,
      values.primaryTenantId,
      values.managerSessionId,
      'MANAGER',
      true,
    );
    const isolatedAdminToken = accessToken(
      jwt,
      values.isolatedAdminId,
      values.isolatedTenantId,
      values.isolatedAdminSessionId,
      'ADMIN',
      true,
    );

    const nonMfaDenied = await apiRequest(
      started.baseUrl,
      nonMfaAdminToken,
      'POST',
      `/payroll/periods/${values.periodId}/review`,
      { body: { expectedRevision: 0 }, idempotencyKey: `non-mfa-review-${values.suffix}` },
    );
    assert.match(
      String(assertJsonStatus(nonMfaDenied, 403, 'non-MFA admin denial').message),
      /MFA verification required/i,
    );

    const managerRead = await apiRequest(
      started.baseUrl,
      managerToken,
      'GET',
      `/payroll/periods/${values.periodId}`,
    );
    assert.equal(assertJsonStatus(managerRead, 200, 'read-only manager read').period.id, values.periodId);
    const managerDenied = await apiRequest(
      started.baseUrl,
      managerToken,
      'POST',
      `/payroll/periods/${values.periodId}/review`,
      { body: { expectedRevision: 0 }, idempotencyKey: `manager-review-${values.suffix}` },
    );
    assert.match(
      String(assertJsonStatus(managerDenied, 403, 'read-only manager mutation denial').message),
      /Insufficient permissions for payroll:lock/i,
    );

    const isolatedDenied = await apiRequest(
      started.baseUrl,
      isolatedAdminToken,
      'GET',
      `/payroll/periods/${values.periodId}`,
    );
    assert.match(
      String(assertJsonStatus(isolatedDenied, 404, 'cross-tenant period denial').message),
      /Payroll period not found/i,
    );

    const reviewKey = `review-${values.suffix}`;
    const reviewBody = { expectedRevision: 0 };
    const reviewIdentity = payrollRequestIdentity({
      tenantId: values.primaryTenantId,
      actorUserId: values.adminId,
      operation: 'REVIEW',
      idempotencyKey: reviewKey,
      body: { periodId: values.periodId, expectedRevision: reviewBody.expectedRevision },
    });
    const reviewResults = await runSameKeyBehindPayrollBarrier(
      owner,
      values.primaryTenantId,
      () => apiRequest(
        started.baseUrl,
        adminToken,
        'POST',
        `/payroll/periods/${values.periodId}/review`,
        { body: reviewBody, idempotencyKey: reviewKey },
      ),
      'same-key payroll review HTTP requests',
    );
    const review = assertJsonStatus(reviewResults[0], 201, 'first same-key MFA admin review');
    const replayedReview = assertJsonStatus(reviewResults[1], 201, 'second same-key MFA admin review');
    assert.deepEqual(replayedReview, review, 'same-key review responses must be identical');
    assert.equal(review.status, 'REVIEW');
    assert.equal(review.revision, 1);
    assert.equal(review.reviewStartedByUserId, values.adminId);
    const storedReviewOperation = await owner.payrollOperation.findUnique({
      where: { operationId: reviewIdentity.operationId },
    });
    assert.deepEqual({
      tenantId: storedReviewOperation?.tenantId,
      periodId: storedReviewOperation?.periodId,
      kind: storedReviewOperation?.kind,
      requestHash: storedReviewOperation?.requestHash,
      response: storedReviewOperation?.response,
    }, {
      tenantId: values.primaryTenantId,
      periodId: values.periodId,
      kind: 'REVIEW',
      requestHash: reviewIdentity.requestHash,
      response: review,
    }, 'same-key review preserves one exact tenant-scoped operation response and request digest');
    assert.equal(await owner.payrollOperation.count({
      where: { operationId: reviewIdentity.operationId },
    }), 1, 'same-key review creates one operation row');
    assert.equal(await owner.auditLog.count({
      where: { tenantId: values.primaryTenantId, action: 'PAYROLL_PERIOD_REVIEW_STARTED', resourceId: values.periodId },
    }), 1, 'same-key review creates one audit row');

    const approval = assertJsonStatus(await apiRequest(
      started.baseUrl,
      adminToken,
      'POST',
      `/payroll/periods/${values.periodId}/decisions`,
      {
        body: {
          decisions: [{
            timeCardId: values.timeCardId,
            expectedRevision: 1,
            decision: 'APPROVED',
            reason: 'Verified against the closed payroll source.',
          }],
        },
        idempotencyKey: `approve-${values.suffix}`,
      },
    ), 201, 'MFA admin approval');
    assert.equal(approval.decisions.length, 1);
    assert.equal(approval.decisions[0].decidedByUserId, values.adminId);

    const lockKey = `lock-${values.suffix}`;
    const lockBody = { expectedRevision: 1 };
    const lockIdentity = payrollRequestIdentity({
      tenantId: values.primaryTenantId,
      actorUserId: values.adminId,
      operation: 'LOCK',
      idempotencyKey: lockKey,
      body: { periodId: values.periodId, expectedRevision: lockBody.expectedRevision },
    });
    const lockResults = await runSameKeyBehindPayrollBarrier(
      owner,
      values.primaryTenantId,
      () => apiRequest(
        started.baseUrl,
        adminToken,
        'POST',
        `/payroll/periods/${values.periodId}/lock`,
        { body: lockBody, idempotencyKey: lockKey },
      ),
      'same-key payroll lock HTTP requests',
    );
    const locked = assertJsonStatus(lockResults[0], 201, 'first same-key MFA admin lock');
    const replayedLock = assertJsonStatus(lockResults[1], 201, 'second same-key MFA admin lock');
    assert.deepEqual(replayedLock, locked, 'same-key lock responses must be identical');
    assert.equal(locked.status, 'LOCKED');
    assert.equal(locked.revision, 2);
    assert.equal(locked.lockedByUserId, values.adminId);
    assert.equal(locked.lockedEntryCount, 1);
    assert.equal(locked.totalPayableMinutes, 480);
    assert.equal(await owner.payrollPeriod.count({
      where: {
        id: values.periodId,
        tenantId: values.primaryTenantId,
        lockOperationId: lockIdentity.operationId,
        lockRequestHash: lockIdentity.requestHash,
      },
    }), 1, 'same-key lock preserves one exact tenant-scoped operation identity and request digest');
    assert.equal(await owner.auditLog.count({
      where: { tenantId: values.primaryTenantId, action: 'PAYROLL_PERIOD_LOCKED', resourceId: values.periodId },
    }), 1, 'same-key lock creates one audit row');

    const entitlement = assertJsonStatus(await apiRequest(
      started.baseUrl,
      adminToken,
      'GET',
      '/payroll/export-entitlement',
    ), 200, 'payroll export entitlement');
    assert.deepEqual(entitlement, { creditCost: 1, eligible: true });

    const exportKey = `export-${values.suffix}`;
    const firstExport = assertJsonStatus(await apiRequest(
      started.baseUrl,
      adminToken,
      'POST',
      `/payroll/periods/${values.periodId}/exports`,
      { body: { expectedCreditCost: entitlement.creditCost }, idempotencyKey: exportKey },
    ), 201, 'exact-cost payroll export');
    const replayedExport = assertJsonStatus(await apiRequest(
      started.baseUrl,
      adminToken,
      'POST',
      `/payroll/periods/${values.periodId}/exports`,
      { body: { expectedCreditCost: entitlement.creditCost }, idempotencyKey: exportKey },
    ), 201, 'same-key payroll export replay');
    assert.deepEqual(replayedExport, firstExport);
    assert.deepEqual(firstExport.settlement, { consumedCredits: 1, newBalance: 4 });
    assert.equal(firstExport.rowCount, 1);
    assert.equal(firstExport.totalPayableMinutes, 480);

    const [debits, batches, lines, tenantAfterExport] = await Promise.all([
      owner.creditTransaction.findMany({ where: { tenantId: values.primaryTenantId } }),
      owner.payrollExportBatch.findMany({ where: { tenantId: values.primaryTenantId } }),
      owner.payrollExportLine.findMany({ where: { tenantId: values.primaryTenantId } }),
      owner.tenant.findUniqueOrThrow({ where: { id: values.primaryTenantId } }),
    ]);
    assert.equal(debits.length, 1, 'same-key replay creates one debit');
    assert.equal(debits[0].amount, -entitlement.creditCost, 'debit matches configured export cost');
    assert.equal(batches.length, 1, 'same-key replay creates one export batch');
    assert.equal(lines.length, 1, 'one locked entry creates one immutable export line');
    assert.equal(tenantAfterExport.usageCredits, 4);

    const isolatedDownloadDenied = await apiRequest(
      started.baseUrl,
      isolatedAdminToken,
      'GET',
      `/payroll/exports/${firstExport.id}/download`,
    );
    assert.match(
      String(assertJsonStatus(isolatedDownloadDenied, 404, 'cross-tenant export denial').message),
      /Payroll export not found/i,
    );

    const download = await apiRequest(
      started.baseUrl,
      adminToken,
      'GET',
      `/payroll/exports/${firstExport.id}/download`,
    );
    assert.equal(download.response.status, 200, download.content.toString('utf8'));
    assert.match(download.response.headers.get('content-type') ?? '', /^text\/csv; charset=utf-8/i);
    assert.match(
      download.response.headers.get('content-disposition') ?? '',
      new RegExp(`attachment; filename="payroll-2026-06-01-${firstExport.id}\\.csv"`),
    );
    assert.equal(download.response.headers.get('cache-control'), 'private, no-store');
    const csv = download.content.toString('utf8');
    assert.equal(csv, [
      'payroll_line_id,source_type,source_id,employee_id,location_id,work_time_zone,clock_in_utc,clock_out_utc,break_minutes,payable_minutes',
      `"${lines[0].id}","TIME_CARD","${values.timeCardId}","${values.employeeId}","${values.locationId}","America/Los_Angeles","2026-06-02T16:00:00.000Z","2026-06-03T00:00:00.000Z","0","480"`,
      '',
    ].join('\n'));

    const receipt = assertJsonStatus(await apiRequest(
      started.baseUrl,
      adminToken,
      'POST',
      `/payroll/exports/${firstExport.id}/reconciliation`,
      {
        body: {
          provider: 'integration-payroll-provider',
          providerEventId: `provider-event-${values.suffix}`,
          providerTotalMinutes: 480,
          outcomes: [{ lineId: lines[0].id, status: 'ACCEPTED' }],
        },
      },
    ), 201, 'payroll reconciliation');
    assert.equal(receipt.acceptedCount, 1);
    assert.equal(receipt.rejectedCount, 0);
    assert.equal(receipt.pendingCount, 0);
    assert.equal(receipt.receivedByUserId, values.adminId);

    const [terminalBatch, receipts, lineStates, auditRows] = await Promise.all([
      owner.payrollExportBatch.findUniqueOrThrow({ where: { id: firstExport.id } }),
      owner.payrollReconciliationReceipt.findMany({ where: { tenantId: values.primaryTenantId } }),
      owner.payrollReconciliationLineState.findMany({ where: { tenantId: values.primaryTenantId } }),
      owner.auditLog.findMany({
        where: { tenantId: values.primaryTenantId, action: { startsWith: 'PAYROLL_' } },
        select: { action: true },
      }),
    ]);
    assert.equal(terminalBatch.status, 'RECONCILED');
    assert.ok(terminalBatch.downloadedAt);
    assert.ok(terminalBatch.reconciledAt);
    assert.equal(receipts.length, 1);
    assert.deepEqual(lineStates.map((state) => state.status), ['ACCEPTED']);
    assert.deepEqual(new Set(auditRows.map((row) => row.action)), new Set([
      'PAYROLL_PERIOD_REVIEW_STARTED',
      'PAYROLL_TIME_CARD_DECISIONS_RECORDED',
      'PAYROLL_PERIOD_LOCKED',
      'PAYROLL_EXPORT_GENERATED',
      'PAYROLL_EXPORT_DOWNLOADED',
      'PAYROLL_RECONCILIATION_RECEIVED',
    ]));
  } finally {
    const cleanupErrors = [];
    await redis.del(...mfaSessionIds.map((sessionId) => `session_mfa:${sessionId}`))
      .catch((error) => cleanupErrors.push(error));
    authService?.redis?.disconnect(false);
    otpService?.redis?.disconnect(false);
    if (app) {
      await bounded(app.close(), 10_000, 'Nest HTTP shutdown')
        .catch((error) => cleanupErrors.push(error));
    }
    await cleanupFixture(owner, values).catch((error) => cleanupErrors.push(error));
    redis.disconnect(false);
    await Promise.all([
      restricted.$disconnect(),
      owner.$disconnect(),
    ]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Payroll full-stack fixture cleanup failed');
    }
  }
});
