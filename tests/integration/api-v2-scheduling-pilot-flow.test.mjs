/**
 * Real-stack pilot flow: manager drafts a schedule week, edits shifts through
 * the change-set API, attaches a break, publishes; STAFF then sees only their
 * own published shifts. Uses the real api-v2 Fastify server (native identity,
 * Redis quota/MFA store, restricted PostgreSQL role) calling the real retained
 * Nest AppModule for publication settlement over loopback HTTP. No mocks, no
 * route interception. The tenant is entitled only through the internal-beta
 * grant path on APP_ORIGIN=https://dev.lunchlineup.com.
 *
 * Requires the same disposable services as the other integration tests:
 * MIGRATION_DATABASE_URL (owner), DATABASE_URL (restricted app role),
 * PLATFORM_ADMIN_DB_CONTEXT_SECRET and REDIS_URL, after scripts/apply-db-migrations.mjs.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const DEV_ORIGIN = 'https://dev.lunchlineup.com';
const jwtSecret = randomBytes(32).toString('hex');
const jwtRefreshSecret = randomBytes(32).toString('hex');

function requireEnv(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for the scheduling pilot-flow proof`);
  return value;
}

// The retained API and api-v2 both read these at construction or per request.
Object.assign(process.env, {
  NODE_ENV: 'test',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  APP_ORIGIN: DEV_ORIGIN,
  INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
  JWT_SECRET: jwtSecret,
  JWT_REFRESH_SECRET: jwtRefreshSecret,
  OTP_HMAC_SECRET: randomBytes(32).toString('hex'),
  RESEND_API_KEY: 're_test_scheduling_pilot_flow',
  EMAIL_FROM: 'LunchLineup Test <no-reply@example.test>',
  STRIPE_SECRET_KEY: 'sk_test_scheduling_pilot_flow',
  TS_NODE_PROJECT: resolve(root, 'apps/api/tsconfig.json'),
});

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, experimentalResolver: true });
require('tsconfig-paths/register');

const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const { NestFactory } = require('@nestjs/core');
const { VersioningType } = require('@nestjs/common');
const express = require('express');
const cookieParser = require('cookie-parser');
const { AppModule } = require('../../apps/api/src/app.module.ts');
const { JwtService } = require('../../apps/api/src/auth/jwt.service.ts');
const { RbacService } = require('../../apps/api/src/auth/rbac.service.ts');
const { ZodValidationPipe } = require('../../apps/api/src/common/pipes/zod-validation.pipe.ts');
const { buildServer } = require('../../apps/api-v2/src/server.ts');
const { loadConfig } = require('../../apps/api-v2/src/config.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');
const { NativeIdentityAdapter, RedisMfaSessionStore } = require('../../apps/api-v2/src/platform/native-identity.ts');

const HTTP_TIMEOUT_MS = 20_000;
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function bounded(operation, ms, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertLoopbackDisposable(name) {
  const url = new URL(requireEnv(name));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name} must be loopback`);
  return url;
}

async function v2(base, token, method, path, { body, headers = {} } = {}) {
  const requestHeaders = new Headers({ Accept: 'application/json', ...headers });
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error bodies are asserted via status */ }
  return { status: response.status, headers: response.headers, json, text };
}

function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: expected ${status}, got ${result.status} ${result.text.slice(0, 600)}`);
  return result.json;
}

async function purge(owner, tenantIds, userIds) {
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const tables = await tx.$queryRawUnsafe(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
        AND table_name NOT IN ('Tenant', 'User')
      ORDER BY table_name`);
    for (const { table_name: table } of tables) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    }
    await tx.$executeRawUnsafe('DELETE FROM "RefreshTokenReplay" WHERE "sessionId" IN (SELECT "id" FROM "Session" WHERE "userId" = ANY($1::text[]))', userIds);
    await tx.$executeRawUnsafe('DELETE FROM "Session" WHERE "userId" = ANY($1::text[])', userIds);
    await tx.$executeRawUnsafe('DELETE FROM "User" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])', tenantIds);
  }, { maxWait: 10_000, timeout: 60_000 });
}

async function pilotFlow(mode) {
  const betaGrant = mode === 'internal-beta';
  assertLoopbackDisposable('DATABASE_URL');
  assertLoopbackDisposable('MIGRATION_DATABASE_URL');
  const redisUrl = assertLoopbackDisposable('REDIS_URL');
  requireEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET');
  assert.equal(process.env.DATA_TARGET_ENV === 'test' || process.env.DATA_TARGET_ENV === 'disposable', true, 'DATA_TARGET_ENV must be test or disposable');

  const owner = new PrismaClient({ datasources: { db: { url: requireEnv('MIGRATION_DATABASE_URL') } } });
  const appClient = new PrismaClient({ datasources: { db: { url: requireEnv('DATABASE_URL') } } });
  const redis = new Redis(redisUrl.toString(), { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  redis.on('error', () => undefined);

  const run = randomUUID();
  const ids = {
    tenantA: `pilot-flow-a-${run}`,
    tenantB: `pilot-flow-b-${run}`,
    managerA: `pilot-flow-manager-a-${run}`,
    adminA: `pilot-flow-admin-a-${run}`,
    staffOne: `pilot-flow-staff-one-${run}`,
    staffTwo: `pilot-flow-staff-two-${run}`,
    managerB: `pilot-flow-manager-b-${run}`,
  };
  const tenantIds = [ids.tenantA, ids.tenantB];
  const userIds = [ids.managerA, ids.adminA, ids.staffOne, ids.staffTwo, ids.managerB];
  const sessionIds = Object.fromEntries(userIds.map((id) => [id, `pilot-flow-session-${id}`]));
  const GRANT_CREDITS = 12;

  let retained;
  let api;
  let store;
  let primary;
  try {
    // ---------------------------------------------------------------- stack
    retained = await bounded(NestFactory.create(AppModule, { bodyParser: false, logger: false }), 60_000, 'retained AppModule');
    retained.use(cookieParser());
    retained.use(express.json({ limit: '256kb' }));
    retained.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    retained.useGlobalPipes(new ZodValidationPipe());
    await bounded(retained.listen(0, '127.0.0.1'), 20_000, 'retained listen');
    const retainedPort = retained.getHttpServer().address().port;

    const config = loadConfig({
      NODE_ENV: 'test',
      APP_ORIGIN: DEV_ORIGIN,
      INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
      LEGACY_API_BASE_URL: `http://127.0.0.1:${retainedPort}/v1`,
      REDIS_URL: redisUrl.toString(),
      JWT_SECRET: jwtSecret,
      METRICS_TOKEN: randomBytes(32).toString('hex'),
      DEPLOY_RELEASE_SHA: 'a'.repeat(40),
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      AUTH_STATE_TIMEOUT_MS: '2000',
      STAFF_INVITATION_OUTBOX_ENABLED: 'false',
      OIDC_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    });
    const database = new TenantDatabase(appClient);
    store = new RedisMfaSessionStore(config);
    api = await bounded(buildServer(config, { database, identity: new NativeIdentityAdapter(config, database, store) }), 30_000, 'api-v2 build');
    await bounded(api.listen({ host: '127.0.0.1', port: 0 }), 20_000, 'api-v2 listen');
    const base = `http://127.0.0.1:${api.server.address().port}/v2`;
    await redis.connect();

    // ------------------------------------------------------------- fixtures
    const now = Date.now();
    const trialEndsAt = new Date(now + 30 * 86_400_000);
    const grantExpiresAt = new Date(now + 14 * 86_400_000);
    const approvedAt = new Date(now - 60_000);
    const grantId = `pilot-flow-grant-${run}`;
    const ledgerReason = 'Internal beta scheduling entitlement: pilot flow proof';
    await owner.tenant.create({
      data: betaGrant
        ? {
          id: ids.tenantA, name: 'Pilot Flow A', slug: ids.tenantA,
          planTier: 'GROWTH', status: 'TRIAL', trialEndsAt, usageCredits: GRANT_CREDITS,
        }
        : {
          id: ids.tenantA, name: 'Pilot Flow A', slug: ids.tenantA,
          planTier: 'GROWTH', status: 'ACTIVE',
          stripeSubscriptionId: `sub_pilot_flow_a_${run}`,
          stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
          usageCredits: GRANT_CREDITS,
        },
    });
    await owner.tenant.create({
      data: {
        id: ids.tenantB, name: 'Pilot Flow B', slug: ids.tenantB,
        planTier: 'GROWTH', status: 'ACTIVE',
        stripeSubscriptionId: `sub_pilot_flow_b_${run}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        usageCredits: 5,
      },
    });
    for (const [id, tenantId, name, role] of [
      [ids.managerA, ids.tenantA, 'Pilot Manager A', 'MANAGER'],
      [ids.adminA, ids.tenantA, 'Pilot Admin A', 'ADMIN'],
      [ids.staffOne, ids.tenantA, 'Pilot Staff One', 'STAFF'],
      [ids.staffTwo, ids.tenantA, 'Pilot Staff Two', 'STAFF'],
      [ids.managerB, ids.tenantB, 'Pilot Manager B', 'MANAGER'],
    ]) {
      await owner.user.create({ data: { id, tenantId, name, role, mfaEnabled: false, mfaBackupCodes: [] } });
      await owner.session.create({
        data: {
          id: sessionIds[id], userId: id,
          selectorHash: `selector-${sha(id).slice(0, 24)}`, refreshToken: `refresh-${sha(id)}`,
          ipAddress: '127.0.0.1', userAgent: 'scheduling-pilot-flow-test',
          expiresAt: new Date(now + 3_600_000),
        },
      });
    }
    // The exact stored shape the platform-admin internal-beta grant produces
    // (apps/api InternalBetaEntitlementService.grant): ledger credit + audit + setting.
    const entitlement = {
      version: 1, source: 'internal_beta', status: 'ACTIVE', features: ['scheduling'],
      grantId, auditId: `${grantId}-internal-beta-audit`, creditTransactionId: grantId,
      creditsGranted: GRANT_CREDITS, ledgerReason, reason: 'pilot flow proof',
      approvedAt: approvedAt.toISOString(), approvedByUserId: ids.managerA,
      expiresAt: grantExpiresAt.toISOString(),
    };
    if (betaGrant) {
      await owner.creditTransaction.create({
        data: { id: grantId, tenantId: ids.tenantA, amount: GRANT_CREDITS, debtAmount: 0, reason: ledgerReason, balanceAfter: GRANT_CREDITS, debtAfter: 0 },
      });
      await owner.auditLog.create({
        data: {
          id: entitlement.auditId, tenantId: ids.tenantA, userId: null, actorUserId: ids.managerA, actorTenantId: ids.tenantA,
          action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED', resource: 'TenantSetting', resourceId: grantId,
          newValue: { requestHash: sha('pilot-flow'), entitlement, response: { tenantId: ids.tenantA, grantId } },
        },
      });
      await owner.tenantSetting.create({ data: { tenantId: ids.tenantA, key: 'internal_beta_entitlement', value: entitlement } });
    }

    const location = await owner.location.create({ data: { tenantId: ids.tenantA, name: 'Pilot Flow Cafe', timezone: 'UTC' } });
    // Publication requires configured availability for every assigned person (a real publish gate).
    await owner.staffAvailability.createMany({
      data: [ids.staffOne, ids.staffTwo].flatMap((userId) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => (
        { tenantId: ids.tenantA, userId, locationId: location.id, dayOfWeek, startTimeMinutes: 0, endTimeMinutes: 1439 }
      ))),
    });
    const locationB = await owner.location.create({ data: { tenantId: ids.tenantB, name: 'Pilot Flow B Cafe', timezone: 'UTC' } });

    const rbac = retained.get(RbacService);
    for (const tenantId of tenantIds) await rbac.ensureTenantRoles(tenantId);
    await rbac.assignLegacySystemRole(ids.managerA, ids.tenantA, 'MANAGER');
    await rbac.assignLegacySystemRole(ids.adminA, ids.tenantA, 'ADMIN');
    await rbac.assignLegacySystemRole(ids.staffOne, ids.tenantA, 'STAFF');
    await rbac.assignLegacySystemRole(ids.staffTwo, ids.tenantA, 'STAFF');
    await rbac.assignLegacySystemRole(ids.managerB, ids.tenantB, 'MANAGER');

    const jwt = retained.get(JwtService);
    const tokenFor = (userId, tenantId, legacyRole) => jwt.generateAccessToken({
      sub: userId, tenantId, role: legacyRole, legacyRole,
      sessionId: sessionIds[userId], mfaVerified: true, pinResetRequired: false,
    });
    // Real Redis MFA state for the privileged managers (staff never need it).
    for (const id of [ids.managerA, ids.adminA, ids.managerB]) await redis.set(`session_mfa:${sessionIds[id]}`, '1', 'EX', 3600);
    const manager = tokenFor(ids.managerA, ids.tenantA, 'MANAGER');
    const admin = tokenFor(ids.adminA, ids.tenantA, 'ADMIN');
    const staffOne = tokenFor(ids.staffOne, ids.tenantA, 'STAFF');
    const staffTwo = tokenFor(ids.staffTwo, ids.tenantA, 'STAFF');
    const managerB = tokenFor(ids.managerB, ids.tenantB, 'MANAGER');

    const pub = async (model, id) => (await owner[model].findUniqueOrThrow({ where: { id }, select: { publicId: true } })).publicId;
    const publicLocationA = location.publicId;
    const publicStaffOne = await pub('user', ids.staffOne);
    const publicStaffTwo = await pub('user', ids.staffTwo);
    const publicManagerA = await pub('user', ids.managerA);
    const key = (label) => `pilot-flow-${label}-${run}`;
    const WEEK = { startDate: '2026-11-02T00:00:00.000Z', endDate: '2026-11-09T00:00:00.000Z' };
    const NEXT_WEEK = { startDate: '2026-11-09T00:00:00.000Z', endDate: '2026-11-16T00:00:00.000Z' };
    const at = (day, hour) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const balance = async () => (await owner.tenant.findUniqueOrThrow({ where: { id: ids.tenantA }, select: { usageCredits: true } })).usageCredits;
    const ledger = () => owner.creditTransaction.findMany({ where: { tenantId: ids.tenantA }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

    // ------------------------------------------- 1. draft schedule creation
    const created = expectStatus(await v2(base, manager, 'POST', `/locations/${publicLocationA}/schedules`, { body: WEEK, headers: { 'Idempotency-Key': key('create') } }), 200, 'create draft');
    const scheduleId = created.data.id;
    assert.equal(created.data.status, 'DRAFT');
    assert.equal(created.data.locationId, publicLocationA);
    assert.equal(created.data.publishedAt, null);
    assert.equal(created.data.startDate, WEEK.startDate);
    assert.equal(created.data.endDate, WEEK.endDate);
    assert.ok(!JSON.stringify(created).includes(ids.tenantA), 'no internal ids leak');
    const replayedCreate = expectStatus(await v2(base, manager, 'POST', `/locations/${publicLocationA}/schedules`, { body: WEEK, headers: { 'Idempotency-Key': key('create') } }), 200, 'create replay');
    assert.deepEqual(replayedCreate, created);
    assert.equal(await owner.schedule.count({ where: { tenantId: ids.tenantA } }), 1);
    assert.equal(await balance(), GRANT_CREDITS, 'draft creation is a zero-settlement control operation');
    if (betaGrant) {
      // The tenant has no subscription at all: only the internal-beta grant can have admitted the call.
      const tenantRow = await owner.tenant.findUniqueOrThrow({ where: { id: ids.tenantA } });
      assert.equal(tenantRow.status, 'TRIAL');
      assert.equal(tenantRow.stripeSubscriptionId, null);
    }

    // ------------------------------------- 2. shift create/edit/delete (CS)
    const csHeaders = (etag, label) => ({ 'If-Match': etag, 'Idempotency-Key': key(label) });
    const created1 = expectStatus(await v2(base, manager, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(created.data.etag, 'cs-1'),
      body: {
        operations: [
          { op: 'shift.create', clientId: randomUUID(), userId: publicStaffOne, startTime: at(2, 9), endTime: at(2, 17), role: 'Server' },
          { op: 'shift.create', clientId: randomUUID(), userId: publicStaffTwo, startTime: at(3, 10), endTime: at(3, 14), role: 'Cook' },
          { op: 'shift.create', clientId: randomUUID(), userId: publicStaffOne, startTime: at(4, 9), endTime: at(4, 13), role: 'Server' },
        ],
      },
    }), 200, 'change-set create shifts');
    assert.equal(created1.data.baseRevision, 0);
    assert.equal(created1.data.revision, 1);
    assert.equal(created1.data.created.length, 3);
    assert.equal(created1.data.shifts.length, 3);
    const byStart = (set, start) => set.find((shift) => shift.startTime === start);
    const staffOneMonday = byStart(created1.data.shifts, at(2, 9));
    const staffTwoTuesday = byStart(created1.data.shifts, at(3, 10));
    const staffOneWednesday = byStart(created1.data.shifts, at(4, 9));
    assert.equal(staffOneMonday.userId, publicStaffOne);
    assert.equal(staffOneMonday.role, 'Server');
    assert.equal(staffTwoTuesday.userId, publicStaffTwo);

    // stale precondition is rejected without changing the draft
    const stale = await v2(base, manager, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(created.data.etag, 'cs-stale'),
      body: { operations: [{ op: 'shift.update', shiftId: staffOneWednesday.id, endTime: at(4, 14) }] },
    });
    assert.ok([409, 412].includes(stale.status), `stale If-Match must be refused, got ${stale.status} ${stale.text}`);
    assert.equal(await owner.shift.count({ where: { tenantId: ids.tenantA, deletedAt: null } }), 3);

    // edit one shift (manager) ...
    const edited = expectStatus(await v2(base, manager, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(created1.data.etag, 'cs-2'),
      body: { operations: [{ op: 'shift.update', shiftId: staffOneMonday.id, startTime: at(2, 8), endTime: at(2, 16) }] },
    }), 200, 'change-set edit');
    assert.equal(edited.data.baseRevision, 1);
    assert.equal(edited.data.revision, 2);
    assert.equal(edited.data.shifts.length, 3);
    const mondayEdited = edited.data.shifts.find((shift) => shift.id === staffOneMonday.id);
    assert.equal(mondayEdited.startTime, at(2, 8));
    assert.equal(mondayEdited.endTime, at(2, 16));
    assert.equal(mondayEdited.role, 'Server', 'omitted fields keep their saved value');
    // ... the default Manager system role has no shifts:delete (rbac.service.ts), so deletion is refused for it ...
    await v2(base, manager, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(edited.data.etag, 'cs-manager-delete'),
      body: { operations: [{ op: 'shift.delete', shiftId: staffOneWednesday.id }] },
    }).then((result) => assert.equal(result.status, 403, `manager delete: ${result.text.slice(0, 300)}`));
    assert.equal(await owner.shift.count({ where: { tenantId: ids.tenantA, deletedAt: null } }), 3);
    // ... and an Admin (shifts:delete) deletes through the same change-set API.
    const deleted = expectStatus(await v2(base, admin, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(edited.data.etag, 'cs-3'),
      body: { operations: [{ op: 'shift.delete', shiftId: staffOneWednesday.id }] },
    }), 200, 'change-set delete');
    assert.equal(deleted.data.baseRevision, 2);
    assert.equal(deleted.data.revision, 3);
    assert.equal(deleted.data.shifts.length, 2);
    assert.equal(deleted.data.shifts.some((shift) => shift.id === staffOneWednesday.id), false);
    assert.equal(await owner.shift.count({ where: { tenantId: ids.tenantA, scheduleId: (await owner.schedule.findFirstOrThrow({ where: { tenantId: ids.tenantA } })).id, deletedAt: null } }), 2);
    // overlap for the same person is refused atomically
    const overlap = await v2(base, manager, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(deleted.data.etag, 'cs-overlap'),
      body: { operations: [{ op: 'shift.create', userId: publicStaffOne, startTime: at(2, 11), endTime: at(2, 20) }] },
    });
    assert.ok(overlap.status >= 400 && overlap.status < 500, `overlap must be a client error, got ${overlap.status}`);
    assert.equal(await owner.shift.count({ where: { tenantId: ids.tenantA, deletedAt: null } }), 2);
    assert.equal(await balance(), GRANT_CREDITS, 'change sets are zero-settlement in api-v2');

    // --------------------------------------------------------------- 3. break
    const breakPlan = await v2(base, manager, 'PUT', `/lunch-breaks/shift/${staffOneMonday.id}`, {
      headers: { 'Idempotency-Key': key('break') },
      body: {
        locationId: publicLocationA,
        breaks: [
          { type: 'break1', startTime: at(2, 10), durationMinutes: 15, skip: false },
          { type: 'lunch', startTime: at(2, 12), durationMinutes: 30, skip: false },
          { type: 'break2', startTime: at(2, 14), durationMinutes: 15, skip: false },
        ],
      },
    });
    // An 8h shift needs break1/lunch/break2 to publish; the internal-beta grant must cover lunch_breaks.
    assert.equal(breakPlan.status, 200, breakPlan.text.slice(0, 400));
    assert.equal(breakPlan.json.shiftId, staffOneMonday.id);
    assert.deepEqual(breakPlan.json.breaks.map((entry) => entry.type).sort(), ['break1', 'break2', 'lunch']);
    const breakRows = await owner.break.findMany({ where: { shift: { tenantId: ids.tenantA } }, select: { type: true } });
    assert.equal(breakRows.length, 3);
    assert.equal(await balance(), GRANT_CREDITS - 1, 'manual break replacement settles one credit');
    const creditsAfterBreak = await balance();

    // ------------------------ 4. STAFF sees nothing of a draft; denied writes
    const draftBoardStaff = expectStatus(await v2(base, staffOne, 'GET', `/schedule-board?date=2026-11-02&view=week&locationId=${publicLocationA}`), 200, 'staff board while draft');
    assert.deepEqual(draftBoardStaff.data.schedules, [], 'staff cannot see a draft schedule');
    assert.deepEqual(draftBoardStaff.data.shifts, [], 'staff cannot see draft shifts');
    const managerDraftBoard = expectStatus(await v2(base, manager, 'GET', `/schedule-board?date=2026-11-02&view=week&locationId=${publicLocationA}`), 200, 'manager board while draft');
    assert.equal(managerDraftBoard.data.schedules.length, 1);
    assert.equal(managerDraftBoard.data.shifts.length, 2);

    const denied = async (label, result, statuses = [403]) => {
      assert.ok(statuses.includes(result.status), `${label}: expected ${statuses}, got ${result.status} ${result.text.slice(0, 300)}`);
      return result;
    };
    await denied('staff create schedule', await v2(base, staffOne, 'POST', `/locations/${publicLocationA}/schedules`, { body: NEXT_WEEK, headers: { 'Idempotency-Key': key('staff-create') } }));
    await denied('staff change-set create', await v2(base, staffOne, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(deleted.data.etag, 'staff-cs'),
      body: { operations: [{ op: 'shift.create', userId: publicStaffOne, startTime: at(5, 9), endTime: at(5, 17) }] },
    }));
    await denied('staff change-set delete', await v2(base, staffOne, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(deleted.data.etag, 'staff-cs-del'),
      body: { operations: [{ op: 'shift.delete', shiftId: staffTwoTuesday.id }] },
    }));
    await denied('staff publish plan', await v2(base, staffOne, 'GET', `/schedules/${scheduleId}/publish-plan`));
    await denied('staff publish', await v2(base, staffOne, 'POST', `/schedules/${scheduleId}/publications`, {
      headers: { 'Idempotency-Key': key('staff-publish') },
      body: { acceptedContract: { version: 0, totalConfiguredCost: 1, scheduleCost: 1, matchingWebhookDeliveryCount: 0, matchingWebhookDeliveryUnitCost: 0, matchingWebhookDeliveryCost: 0 } },
    }));
    await denied('staff break edit', await v2(base, staffOne, 'PUT', `/lunch-breaks/shift/${staffOneMonday.id}`, {
      headers: { 'Idempotency-Key': key('staff-break') },
      body: { locationId: publicLocationA, breaks: [{ type: 'lunch', skip: true }] },
    }));
    await denied('unauthenticated board', await v2(base, null, 'GET', `/schedule-board?date=2026-11-02&view=week`), [401]);
    assert.equal(await balance(), creditsAfterBreak, 'denied attempts cost nothing');

    // ------------------------------------------- 5. cross-tenant manager B
    const foreignPlan = await v2(base, managerB, 'GET', `/schedules/${scheduleId}/publish-plan`);
    assert.ok([403, 404].includes(foreignPlan.status), `foreign publish plan: ${foreignPlan.status}`);
    await denied('foreign change-set', await v2(base, managerB, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(deleted.data.etag, 'foreign-cs'),
      body: { operations: [{ op: 'shift.delete', shiftId: staffTwoTuesday.id }] },
    }), [403, 404]);
    await denied('foreign publish', await v2(base, managerB, 'POST', `/schedules/${scheduleId}/publications`, {
      headers: { 'Idempotency-Key': key('foreign-publish') },
      body: { acceptedContract: { version: 0, totalConfiguredCost: 1, scheduleCost: 1, matchingWebhookDeliveryCount: 0, matchingWebhookDeliveryUnitCost: 0, matchingWebhookDeliveryCost: 0 } },
    }), [403, 404]);
    await denied('foreign draft into A location', await v2(base, managerB, 'POST', `/locations/${publicLocationA}/schedules`, { body: NEXT_WEEK, headers: { 'Idempotency-Key': key('foreign-create') } }), [403, 404]);
    const foreignBoard = expectStatus(await v2(base, managerB, 'GET', `/schedule-board?date=2026-11-02&view=week&locationId=${publicLocationA}`), 200, 'foreign board');
    assert.equal(JSON.stringify(foreignBoard).includes(scheduleId), false);
    assert.equal(foreignBoard.data.shifts.length, 0);
    assert.equal(foreignBoard.data.locations.some((entry) => entry.id === publicLocationA), false);
    assert.equal(foreignBoard.data.locations.some((entry) => entry.id === locationB.publicId), true);
    assert.equal(await owner.shift.count({ where: { tenantId: ids.tenantA, deletedAt: null } }), 2);
    assert.equal(await owner.schedule.count({ where: { tenantId: ids.tenantB } }), 0);

    // --------------------------------------------------------- 6. publication
    const creditsBefore = await balance();
    const priorLedgerIds = new Set((await ledger()).map((row) => row.id));
    const plan = expectStatus(await v2(base, manager, 'GET', `/schedules/${scheduleId}/publish-plan`), 200, 'publish plan');
    assert.equal(plan.scheduleId, scheduleId);
    assert.equal(plan.sufficientCredits, true);
    assert.equal(plan.availableCredits, creditsBefore);
    assert.ok(plan.scheduleCost >= 1);
    assert.equal(plan.totalConfiguredCost, plan.scheduleCost + plan.matchingWebhookDeliveryCost);
    const publishBody = { acceptedContract: plan.acceptedContract };
    const published = expectStatus(await v2(base, manager, 'POST', `/schedules/${scheduleId}/publications`, { body: publishBody, headers: { 'Idempotency-Key': key('publish') } }), 200, 'publish');
    assert.equal(published.id, scheduleId);
    assert.equal(published.status, 'PUBLISHED');
    assert.equal(published.settlement.scheduleCost, plan.scheduleCost);
    assert.equal(published.settlement.creditsConsumed, plan.totalConfiguredCost);
    assert.equal(published.settlement.newBalance, creditsBefore - plan.totalConfiguredCost);
    assert.equal(await balance(), creditsBefore - plan.totalConfiguredCost, 'wallet debited exactly the accepted cost');
    const rowsAfterPublish = await ledger();
    const debits = rowsAfterPublish.filter((row) => row.amount < 0 && !priorLedgerIds.has(row.id));
    assert.equal(debits.reduce((sum, row) => sum + row.amount, 0), -plan.totalConfiguredCost, 'new ledger debits during publish equal the accepted cost');
    assert.ok(debits.some((row) => row.id === published.settlement.ledgerIdentities.schedule));
    assert.equal(debits.at(-1).balanceAfter, published.settlement.newBalance);
    assert.equal((await owner.schedule.findFirstOrThrow({ where: { tenantId: ids.tenantA } })).status, 'PUBLISHED');

    // replay is exact-once
    const publishReplay = expectStatus(await v2(base, manager, 'POST', `/schedules/${scheduleId}/publications`, { body: publishBody, headers: { 'Idempotency-Key': key('publish') } }), 200, 'publish replay');
    assert.equal(publishReplay.settlement.newBalance, published.settlement.newBalance);
    assert.equal(publishReplay.settlement.ledgerIdentities.schedule, published.settlement.ledgerIdentities.schedule);
    assert.equal(await balance(), creditsBefore - plan.totalConfiguredCost, 'replay does not debit again');
    assert.equal((await ledger()).length, rowsAfterPublish.length);

    // ---------------------------- 7. STAFF sees only own published shifts
    const board = (token) => v2(base, token, 'GET', `/schedule-board?date=2026-11-02&view=week&locationId=${publicLocationA}`);
    const oneBoard = expectStatus(await board(staffOne), 200, 'staff one board').data;
    assert.deepEqual(oneBoard.schedules.map((entry) => [entry.id, entry.status]), [[scheduleId, 'PUBLISHED']]);
    assert.deepEqual(oneBoard.shifts.map((shift) => shift.id), [staffOneMonday.id]);
    assert.equal(oneBoard.shifts[0].userId, publicStaffOne);
    assert.equal(oneBoard.shifts[0].startTime, at(2, 8));
    assert.deepEqual(oneBoard.shifts[0].breaks.map((entry) => entry.startTime), [at(2, 10), at(2, 12), at(2, 14)], 'own breaks are visible when they exist');
    assert.deepEqual(oneBoard.staff.map((entry) => entry.id), [publicStaffOne], 'roster is limited to self');
    assert.equal(JSON.stringify(oneBoard).includes(publicStaffTwo), false, 'other staff never appear');
    assert.equal(JSON.stringify(oneBoard).includes(staffTwoTuesday.id), false);
    assert.equal(JSON.stringify(oneBoard).includes(staffOneWednesday.id), false, 'deleted shift never appears');
    assert.equal(oneBoard.permissions.includes('shifts:write'), false);
    const twoBoard = expectStatus(await board(staffTwo), 200, 'staff two board').data;
    assert.deepEqual(twoBoard.shifts.map((shift) => shift.id), [staffTwoTuesday.id]);
    assert.equal(JSON.stringify(twoBoard).includes(staffOneMonday.id), false);
    assert.equal(JSON.stringify(twoBoard).includes(publicStaffOne), false);
    const managerBoard = expectStatus(await board(manager), 200, 'manager published board').data;
    assert.deepEqual(new Set(managerBoard.shifts.map((shift) => shift.id)), new Set([staffOneMonday.id, staffTwoTuesday.id]));
    const staffLegacyList = expectStatus(await v2(base, staffOne, 'GET', '/shifts?limit=50'), 200, 'staff shift list').data;
    assert.ok(staffLegacyList.every((shift) => shift.userId === publicStaffOne), 'operations shift list is also self-only');

    // a later draft stays invisible to STAFF even with their own shift on it
    const nextDraft = expectStatus(await v2(base, manager, 'POST', `/locations/${publicLocationA}/schedules`, { body: NEXT_WEEK, headers: { 'Idempotency-Key': key('create-next') } }), 200, 'next-week draft');
    expectStatus(await v2(base, manager, 'POST', `/schedules/${nextDraft.data.id}/change-sets`, {
      headers: csHeaders(nextDraft.data.etag, 'cs-next'),
      body: { operations: [{ op: 'shift.create', userId: publicStaffOne, startTime: '2026-11-10T09:00:00.000Z', endTime: '2026-11-10T17:00:00.000Z', role: 'Server' }] },
    }), 200, 'next-week shift');
    const nextStaff = expectStatus(await v2(base, staffOne, 'GET', `/schedule-board?date=2026-11-09&view=week&locationId=${publicLocationA}`), 200, 'staff next-week board').data;
    assert.deepEqual(nextStaff.schedules, []);
    assert.deepEqual(nextStaff.shifts, []);
    const nextManager = expectStatus(await v2(base, manager, 'GET', `/schedule-board?date=2026-11-09&view=week&locationId=${publicLocationA}`), 200, 'manager next-week board').data;
    assert.equal(nextManager.shifts.length, 1);

    // published schedules are immutable through change sets
    const lockedEdit = await v2(base, manager, 'POST', `/schedules/${scheduleId}/change-sets`, {
      headers: csHeaders(published.id ? (await v2(base, manager, 'GET', `/schedule-board?date=2026-11-02&view=week&locationId=${publicLocationA}`)).json.data.schedules[0].etag : '', 'cs-locked'),
      body: { operations: [{ op: 'shift.delete', shiftId: staffTwoTuesday.id }] },
    });
    assert.ok(lockedEdit.status >= 400 && lockedEdit.status < 500, `published schedule edit must be refused, got ${lockedEdit.status}`);
    assert.equal(await owner.shift.count({ where: { tenantId: ids.tenantA, scheduleId: (await owner.schedule.findFirstOrThrow({ where: { tenantId: ids.tenantA, status: 'PUBLISHED' } })).id, deletedAt: null } }), 2);

    // tenant B was never touched and never charged
    assert.equal((await owner.tenant.findUniqueOrThrow({ where: { id: ids.tenantB }, select: { usageCredits: true } })).usageCredits, 5);
    assert.equal(await owner.creditTransaction.count({ where: { tenantId: ids.tenantB } }), 0);
    assert.equal(publicManagerA.length > 0, true);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const failures = [];
    const attempt = async (fn) => { try { await fn(); } catch (error) { failures.push(error); } };
    await attempt(() => api?.close());
    await attempt(() => retained?.close());
    await attempt(() => store?.close());
    await attempt(async () => { if (redis.status === 'ready') await redis.del(...Object.values(sessionIds).map((id) => `session_mfa:${id}`)); });
    await attempt(() => purge(owner, tenantIds, userIds));
    await attempt(() => redis.quit());
    await attempt(() => appClient.$disconnect());
    await attempt(() => owner.$disconnect());
    if (!primary && failures.length) throw failures[0];
  }
}

test('internal-beta entitled tenant (APP_ORIGIN dev.lunchlineup.com): draft, edit, breaks, publish, STAFF sees only own published shifts', { timeout: 240_000 }, () => pilotFlow('internal-beta'));
test('paid-subscription tenant: same flow, STAFF sees own breaks', { timeout: 240_000 }, () => pilotFlow('paid'));
