import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
process.env.JWT_SECRET ||= 'integration-auth-access-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.JWT_REFRESH_SECRET ||= 'integration-auth-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
process.env.RESEND_API_KEY ||= 're_test_integration_auth_boundary';
process.env.STRIPE_SECRET_KEY ||= 'sk_test_integration_auth_boundary';
const require = createRequire(import.meta.url);
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { AdminController } = require('../../apps/api/src/admin/admin.controller.ts');
const { AdminUserLifecycleService } = require('../../apps/api/src/admin/admin-user-lifecycle.service.ts');
const { AdminUserMfaRecoveryService } = require('../../apps/api/src/admin/admin-user-mfa-recovery.service.ts');
const { AppModule } = require('../../apps/api/src/app.module.ts');
const { AuthService } = require('../../apps/api/src/auth/auth.service.ts');
const { JwtAuthGuard } = require('../../apps/api/src/auth/jwt-auth.guard.ts');
const { RbacService } = require('../../apps/api/src/auth/rbac.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { UsersController } = require('../../apps/api/src/users/users.controller.ts');
const { Test } = requireApi('@nestjs/testing');
const bcrypt = require('bcryptjs');

function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 64).toString('hex')}`;
}

function verifyPin(pin, storedHash) {
  const [salt, expected] = storedHash.split(':');
  return Boolean(salt && expected && scryptSync(pin, salt, 64).toString('hex') === expected);
}

function sessionRows(userId, prefix, activeCount, now) {
  const rows = Array.from({ length: activeCount }, (_, index) => ({
    id: `${prefix}-active-${index}`,
    userId,
    selectorHash: `selector-${prefix}-active-${index}`,
    refreshToken: `refresh-${prefix}-active-${index}`,
    ipAddress: '',
    userAgent: '',
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    createdAt: new Date(now.getTime() - (activeCount - index + 10) * 1000),
    revokedAt: null,
  }));
  rows.push({
    id: `${prefix}-expired`,
    userId,
    selectorHash: `selector-${prefix}-expired`,
    refreshToken: `refresh-${prefix}-expired`,
    ipAddress: '',
    userAgent: '',
    expiresAt: new Date(now.getTime() - 60 * 1000),
    createdAt: new Date(now.getTime() - 120 * 1000),
    revokedAt: null,
  });
  rows.push({
    id: `${prefix}-revoked`,
    userId,
    selectorHash: `selector-${prefix}-revoked`,
    refreshToken: `refresh-${prefix}-revoked`,
    ipAddress: '',
    userAgent: '',
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    createdAt: new Date(now.getTime() - 110 * 1000),
    revokedAt: new Date(now.getTime() - 30 * 1000),
  });
  return rows;
}

async function createFixture(prisma, fixture, sessions) {
  await prisma.tenant.create({
    data: {
      id: fixture.tenantId,
      name: fixture.tenantName,
      slug: fixture.tenantSlug,
      status: 'ACTIVE',
    },
  });
  await prisma.user.create({
    data: {
      id: fixture.userId,
      tenantId: fixture.tenantId,
      name: fixture.userName,
      role: 'STAFF',
      mfaEnabled: false,
      mfaBackupCodes: [],
    },
  });
  await prisma.session.createMany({ data: sessions });
}

async function cleanupFixture(prisma, tenantIds, userIds) {
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.roleAssignment.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.role.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantSetting.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

function normalizedSessions(rows) {
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    selectorHash: row.selectorHash,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

function rawQueryText(query) {
  if (Array.isArray(query)) return query.join('?');
  if (Array.isArray(query?.strings)) return query.strings.join('?');
  return String(query);
}

function authBoundaryTenantDb(tenantDb, auditCreate = async ({ data }) => ({ id: randomUUID(), ...data })) {
  return {
    client: tenantDb.client,
    withTenant(tenantId, operation, options) {
      return tenantDb.withTenant(tenantId, async (tx) => {
        return operation({
          $executeRaw: tx.$executeRaw.bind(tx),
          $queryRaw: tx.$queryRaw.bind(tx),
          tenant: tx.tenant,
          session: tx.session,
          user: tx.user,
          role: tx.role,
          roleAssignment: tx.roleAssignment,
          rolePermission: tx.rolePermission,
          permission: tx.permission,
          tenantSetting: tx.tenantSetting,
          // Fresh audit records are intentionally not created because retention
          // controls correctly prevent deleting them during fixture cleanup.
          auditLog: { create: auditCreate },
        });
      }, options);
    },
  };
}

function platformBoundaryTenantDb(
  tenantDb,
  auditCreate = async ({ data }) => ({ id: randomUUID(), ...data }),
  beforeQueryRaw = async () => {},
) {
  const scoped = (tx) => new Proxy(tx, {
    get(target, property) {
      if (property === 'auditLog') return { create: auditCreate };
      if (property === '$queryRaw') {
        return async (...args) => {
          await beforeQueryRaw(...args);
          return target.$queryRaw(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    client: tenantDb.client,
    withTenant(tenantId, operation, options) {
      return tenantDb.withTenant(tenantId, (tx) => operation(scoped(tx)), options);
    },
    withPlatformAdmin(operation, options) {
      return tenantDb.withPlatformAdmin((tx) => operation(scoped(tx)), options);
    },
  };
}

async function cleanupTenantWithAudit(ownerPrisma, tenantId, capability, userIds = []) {
  await ownerPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return;
    await tx.$executeRaw`
      UPDATE "Tenant"
      SET "status" = 'PURGED'::"TenantStatus",
          "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
          "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
          "retentionLegalHoldAt" = NULL,
          "retentionLegalHoldReason" = NULL,
          "retentionLegalHoldByUserId" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${tenantId}
    `;
    await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
  });
  if (userIds.length > 0) {
    await cleanupFixture(ownerPrisma, [tenantId], userIds);
    return;
  }
  await ownerPrisma.tenant.deleteMany({ where: { id: tenantId } });
}

function createTransactionGate() {
  let signalEntered;
  let release;
  const entered = new Promise((resolveEntered) => { signalEntered = resolveEntered; });
  const released = new Promise((resolveReleased) => { release = resolveReleased; });
  return {
    entered,
    release: () => release(),
    holdAfterOperation: async () => {
      signalEntered();
      await released;
    },
  };
}

function gatedTenantDb(tenantDb, auditCreate, holdAfterOperation) {
  const scoped = authBoundaryTenantDb(tenantDb, auditCreate);
  return {
    client: scoped.client,
    withTenant(tenantId, operation, options) {
      return scoped.withTenant(tenantId, async (tx) => {
        const result = await operation(tx);
        await holdAfterOperation();
        return result;
      }, options);
    },
  };
}

function proxiedTenantDb(tenantDb, hooks = {}) {
  return {
    client: tenantDb.client,
    async withTenant(tenantId, operation, options) {
      try {
        return await tenantDb.withTenant(tenantId, async (tx) => {
          const user = hooks.beforeUserUpdateMany
            ? new Proxy(tx.user, {
                get(target, property) {
                  if (property === 'updateMany') {
                    return async (args) => {
                      await hooks.beforeUserUpdateMany(args);
                      return target.updateMany(args);
                    };
                  }
                  const value = Reflect.get(target, property);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              })
            : tx.user;
          const scoped = new Proxy(tx, {
            get(target, property) {
              if (property === 'auditLog' && hooks.auditCreate) {
                return { create: hooks.auditCreate };
              }
              if (property === 'user') return user;
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const result = await operation(scoped);
          if (hooks.holdAfterOperation) await hooks.holdAfterOperation();
          return result;
        }, options);
      } catch (error) {
        hooks.onTransactionError?.(error);
        throw error;
      }
    },
  };
}

function createTwoPartyBarrier() {
  let arrivals = 0;
  let release;
  const released = new Promise((resolveReleased) => { release = resolveReleased; });
  return async () => {
    if (arrivals >= 2) return;
    arrivals += 1;
    if (arrivals === 2) release();
    await released;
  };
}

async function within(promise, timeoutMs, message) {
  const timeoutController = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(timeoutMs, undefined, { signal: timeoutController.signal }).then(() => { throw new Error(message); }),
    ]);
  } finally {
    timeoutController.abort();
  }
}

function createAuthService(tenantDb, options = {}) {
  const config = { get: (_key, fallback) => fallback };
  const jwt = {
    generateAccessToken: (payload) => payload.sessionId,
    generateCsrfToken: () => 'integration-csrf',
  };
  const rbac = options.rbac ?? {
    getEffectiveAccess: async () => ({
      primaryRole: 'STAFF',
      roles: ['STAFF'],
      permissions: [],
    }),
    authorizeUserAdministrationInTransaction: async (tx, tenantId, request) => tx.user.findFirstOrThrow({
      where: { id: request.targetUserId, tenantId, deletedAt: null },
      select: { id: true, role: true, username: true, name: true, email: true },
    }),
    authorizeSelfSecurityMutationInTransaction: async () => ({
      primaryRole: 'STAFF',
      roles: [{ id: 'fixture-staff', name: 'Staff', isSystem: true, legacyRole: 'STAFF' }],
      permissions: ['auth:login_pin'],
    }),
  };
  const service = new AuthService(
    config,
    jwt,
    rbac,
    authBoundaryTenantDb(tenantDb, options.auditCreate),
  );
  if (options.redis) service.redis = options.redis;
  // The CI integration step does not expose the platform-admin capability.
  // Tenant state is fixture-controlled; the actual bounded session transaction
  // and restricted app-role database calls remain unmodified.
  service.assertTenantIdCanAuthenticate = async () => {};
  service.getTenantSecuritySettings = async () => ({
    requireMfaForAll: false,
    sessionTimeoutMinutes: 480,
    ssoOidcOnly: false,
  });
  return service;
}

function authenticatedUser(fixture) {
  return {
    id: fixture.userId,
    tenantId: fixture.tenantId,
    role: 'STAFF',
    email: null,
    username: null,
    mfaEnabled: false,
    pinResetRequired: false,
  };
}

test('AuthService serializes session ownership, prunes inactive rows, and retains at most 20 active sessions', { timeout: 30_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const lockPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const target = {
    tenantId: `tenant-auth-bound-${runId}`,
    tenantName: 'Auth Session Bound Target',
    tenantSlug: `auth-session-bound-target-${runId}`,
    userId: `user-auth-bound-${runId}`,
    userName: 'Auth Session Target',
  };
  const control = {
    tenantId: `tenant-auth-control-${runId}`,
    tenantName: 'Auth Session Bound Control',
    tenantSlug: `auth-session-bound-control-${runId}`,
    userId: `user-auth-control-${runId}`,
    userName: 'Auth Session Control',
  };
  const tenantIds = [target.tenantId, control.tenantId];
  const userIds = [target.userId, control.userId];
  const now = new Date();
  const targetFixtureRows = sessionRows(target.userId, `target-${runId}`, 24, now);
  const controlFixtureRows = sessionRows(control.userId, `control-${runId}`, 4, now);
  let releaseUserLock;
  let lockAcquired;
  const userLockReady = new Promise((resolveReady) => {
    lockAcquired = resolveReady;
  });
  const releaseUserLockPromise = new Promise((resolveRelease) => {
    releaseUserLock = resolveRelease;
  });

  try {
    await createFixture(ownerPrisma, target, targetFixtureRows);
    await createFixture(ownerPrisma, control, controlFixtureRows);
    const controlBefore = normalizedSessions(await ownerPrisma.session.findMany({
      where: { userId: control.userId },
      orderBy: { id: 'asc' },
    }));

    const tenantDb = new TenantPrismaService(appPrisma);
    const lockTenantDb = new TenantPrismaService(lockPrisma);
    const service = createAuthService(tenantDb);
    const user = authenticatedUser(target);
    const sessionAudit = {
      loginMethod: 'USERNAME_PASSWORD',
      ipAddress: '',
      userAgent: '',
    };

    const blockingTransaction = lockTenantDb.withTenant(target.tenantId, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${target.userId} AND "tenantId" = ${target.tenantId}
        FOR UPDATE
      `);
      lockAcquired();
      await releaseUserLockPromise;
    }, { timeout: 10_000 });

    await userLockReady;
    let firstAttemptState = 'pending';
    const firstAttempt = service.createSessionTokens(user, sessionAudit)
      .then((result) => {
        firstAttemptState = 'fulfilled';
        return result;
      }, (error) => {
        firstAttemptState = 'rejected';
        throw error;
      });

    try {
      await delay(250);
      assert.equal(
        firstAttemptState,
        'pending',
        'AuthService session creation must wait for serialized ownership of the user row',
      );
    } finally {
      releaseUserLock();
      await blockingTransaction;
    }
    await firstAttempt;

    await Promise.all(Array.from({ length: 6 }, () => (
      service.createSessionTokens(user, sessionAudit)
    )));

    const targetAfter = await ownerPrisma.session.findMany({
      where: { userId: target.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const controlAfter = normalizedSessions(await ownerPrisma.session.findMany({
      where: { userId: control.userId },
      orderBy: { id: 'asc' },
    }));

    assert.equal(targetAfter.length, 20, 'target user retains exactly the active-session cap');
    assert.ok(
      targetAfter.every((row) => row.revokedAt === null && row.expiresAt > new Date()),
      'expired and revoked target sessions are removed before the cap is applied',
    );
    assert.ok(
      !targetAfter.some((row) => row.id.endsWith('-expired') || row.id.endsWith('-revoked')),
      'inactive target fixture rows do not survive session creation',
    );
    assert.deepEqual(
      controlAfter,
      controlBefore,
      'another tenant and user remain byte-for-byte unchanged',
    );
  } finally {
    if (releaseUserLock) releaseUserLock();
    await cleanupFixture(ownerPrisma, tenantIds, userIds);
    await Promise.all([
      appPrisma.$disconnect(),
      lockPrisma.$disconnect(),
      ownerPrisma.$disconnect(),
    ]);
  }
});

test('JwtAuthGuard never combines a pre-promotion session and MFA result with post-promotion permissions', { timeout: 30_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-guard-promotion-${runId}`;
  const userId = `user-guard-promotion-${runId}`;
  const sessionId = `session-guard-promotion-${runId}`;
  const staffRoleId = `role-guard-staff-${runId}`;
  const adminRoleId = `role-guard-admin-${runId}`;
  const gate = createTransactionGate();

  try {
    await ownerPrisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Guard Promotion Boundary',
        slug: `guard-promotion-${runId}`,
        status: 'ACTIVE',
      },
    });
    await ownerPrisma.user.create({
      data: { id: userId, tenantId, name: 'Guard Promotion User', role: 'STAFF' },
    });
    for (const key of ['dashboard:access', 'admin_portal:access']) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable guard promotion permission',
          category: key === 'dashboard:access' ? 'AUTH' : 'ADMIN',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: ['dashboard:access', 'admin_portal:access'] } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: staffRoleId,
          tenantId,
          name: `Guard Staff ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
        {
          id: adminRoleId,
          tenantId,
          name: `Guard Admin ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        { roleId: staffRoleId, permissionId: permissionId.get('dashboard:access') },
        { roleId: adminRoleId, permissionId: permissionId.get('dashboard:access') },
        { roleId: adminRoleId, permissionId: permissionId.get('admin_portal:access') },
      ],
    });
    await ownerPrisma.roleAssignment.create({
      data: { tenantId, userId, roleId: staffRoleId },
    });
    await ownerPrisma.session.create({
      data: {
        id: sessionId,
        userId,
        selectorHash: `selector-guard-promotion-${runId}`,
        refreshToken: `refresh-guard-promotion-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'guard-promotion-proof',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const appTenantDb = new TenantPrismaService(appPrisma);
    const mutationTenantDb = new TenantPrismaService(mutationPrisma);
    const liveRbac = new RbacService(appTenantDb);
    const auth = createAuthService(appTenantDb, { rbac: liveRbac });
    const claims = {
      sub: userId,
      tenantId,
      role: 'Staff',
      legacyRole: 'STAFF',
      sessionId,
      mfaVerified: true,
    };
    const request = {
      method: 'GET',
      path: '/api/v1/admin/users',
      headers: { authorization: 'Bearer guard-promotion-token' },
      cookies: {},
    };
    const context = {
      getHandler: () => (() => undefined),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ cookie: () => undefined }),
      }),
    };
    const guardedAuth = {
      validateAccessSession: async (verified) => {
        const state = await auth.validateAccessSession(verified);
        await gate.holdAfterOperation();
        return state;
      },
    };
    const guard = new JwtAuthGuard(
      { verifyAccessToken: () => claims },
      guardedAuth,
      { get: () => false },
    );
    const guarded = guard.canActivate(context);
    await gate.entered;

    await mutationTenantDb.withTenant(tenantId, async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${userId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      await tx.roleAssignment.deleteMany({ where: { tenantId, userId } });
      await tx.roleAssignment.create({ data: { tenantId, userId, roleId: adminRoleId } });
      await tx.user.update({ where: { id: userId }, data: { role: 'SUPER_ADMIN' } });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    gate.release();
    assert.equal(await guarded, true);
    assert.deepEqual(request.user.permissions, ['dashboard:access']);
    assert.equal(request.user.role, `Guard Staff ${runId}`);
    assert.equal(request.user.mfaRequired, false);
    assert.equal(request.user.permissions.includes('admin_portal:access'), false);
    assert.ok(
      (await ownerPrisma.session.findUniqueOrThrow({ where: { id: sessionId } })).revokedAt,
      'the concurrent promotion committed its session revocation',
    );
  } finally {
    gate.release();
    await ownerPrisma.session.deleteMany({ where: { userId } });
    await ownerPrisma.roleAssignment.deleteMany({ where: { tenantId } });
    await ownerPrisma.role.deleteMany({ where: { tenantId } });
    await ownerPrisma.user.deleteMany({ where: { id: userId } });
    await ownerPrisma.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('password login cannot mint a session after suspension wins the post-credential user lock', { timeout: 30_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-login-suspension-${runId}`;
  const tenantSlug = `login-suspension-${runId}`;
  const userId = `user-login-suspension-${runId}`;
  const username = `login.${runId}`;
  const password = 'correct-horse-battery-staple';
  const credentialGate = createTransactionGate();
  const suspensionGate = createTransactionGate();
  let accessReads = 0;

  try {
    await ownerPrisma.tenant.create({
      data: { id: tenantId, name: 'Login Suspension Boundary', slug: tenantSlug, status: 'ACTIVE' },
    });
    await ownerPrisma.user.create({
      data: {
        id: userId,
        tenantId,
        name: 'Login Suspension User',
        username,
        role: 'STAFF',
        passwordHash: bcrypt.hashSync(password, 10),
      },
    });

    const appTenantDb = new TenantPrismaService(appPrisma);
    const mutationTenantDb = new TenantPrismaService(mutationPrisma);
    const rbac = {
      getEffectiveAccess: async () => {
        accessReads += 1;
        if (accessReads === 1) await credentialGate.holdAfterOperation();
        return {
          primaryRole: 'Staff',
          roles: [{ id: 'fixture-staff', name: 'Staff', isSystem: true, legacyRole: 'STAFF' }],
          permissions: ['auth:login_password', 'dashboard:access'],
        };
      },
    };
    const auth = createAuthService(appTenantDb, { rbac });
    auth.resolveLoginTenantContext = async () => ({ tenantId, tenantSlug });

    let loginState = 'pending';
    const login = auth.loginWithUsernamePassword(username, password, tenantSlug).then(
      (value) => { loginState = 'fulfilled'; return value; },
      (error) => { loginState = 'rejected'; throw error; },
    );
    await credentialGate.entered;

    const suspension = mutationTenantDb.withTenant(tenantId, async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${userId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const now = new Date();
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.user.update({ where: { id: userId }, data: { suspendedAt: now } });
      await suspensionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await suspensionGate.entered;

    credentialGate.release();
    await delay(200);
    assert.equal(loginState, 'pending', 'session issuance waits for the suspension-owned user row');
    suspensionGate.release();
    await suspension;
    await assert.rejects(login, /User account inactive/);

    assert.equal(await ownerPrisma.session.count({ where: { userId } }), 0);
    assert.ok((await ownerPrisma.user.findUniqueOrThrow({ where: { id: userId } })).suspendedAt);
    await ownerPrisma.user.update({ where: { id: userId }, data: { suspendedAt: null } });
    assert.equal(
      await ownerPrisma.session.count({ where: { userId, revokedAt: null } }),
      0,
      'later activation cannot make a stale login session valid because none was created',
    );
  } finally {
    credentialGate.release();
    suspensionGate.release();
    await ownerPrisma.session.deleteMany({ where: { userId } });
    await ownerPrisma.user.deleteMany({ where: { id: userId } });
    await ownerPrisma.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('MFA disable and PIN mutation remain database-authoritative across Redis and audit failures', { timeout: 30_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const now = new Date();
  const mfa = {
    tenantId: `tenant-auth-mfa-${runId}`,
    tenantName: 'Auth MFA Atomicity',
    tenantSlug: `auth-mfa-atomicity-${runId}`,
    userId: `user-auth-mfa-${runId}`,
    userName: 'Auth MFA User',
  };
  const pin = {
    tenantId: `tenant-auth-pin-${runId}`,
    tenantName: 'Auth PIN Atomicity',
    tenantSlug: `auth-pin-atomicity-${runId}`,
    userId: `user-auth-pin-${runId}`,
    userName: 'Auth PIN User',
  };
  const tenantIds = [mfa.tenantId, pin.tenantId];
  const userIds = [mfa.userId, pin.userId];
  const mfaSessionId = `session-auth-mfa-${runId}`;
  const pinSessionId = `session-auth-pin-${runId}`;
  const backupCode = 'ABCD-EFGH-IJKL';
  const oldPin = '2468';
  const rotatedPin = '1357';
  const resetPin = '9753';

  try {
    await ownerPrisma.tenant.createMany({
      data: [
        { id: mfa.tenantId, name: mfa.tenantName, slug: mfa.tenantSlug, status: 'ACTIVE' },
        { id: pin.tenantId, name: pin.tenantName, slug: pin.tenantSlug, status: 'ACTIVE' },
      ],
    });
    await ownerPrisma.user.createMany({
      data: [
        {
          id: mfa.userId,
          tenantId: mfa.tenantId,
          name: mfa.userName,
          role: 'STAFF',
          mfaEnabled: true,
          mfaSecret: null,
          mfaBackupCodes: [bcrypt.hashSync(backupCode, 4)],
        },
        {
          id: pin.userId,
          tenantId: pin.tenantId,
          name: pin.userName,
          username: `pin.${runId}`,
          role: 'STAFF',
          pinHash: hashPin(oldPin),
          pinResetRequired: true,
          mfaEnabled: false,
          mfaBackupCodes: [],
        },
      ],
    });
    await ownerPrisma.session.createMany({
      data: [
        {
          id: mfaSessionId,
          userId: mfa.userId,
          selectorHash: `selector-mfa-${runId}`,
          refreshToken: `refresh-mfa-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'auth-atomicity-test',
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        },
        {
          id: pinSessionId,
          userId: pin.userId,
          selectorHash: `selector-pin-${runId}`,
          refreshToken: `refresh-pin-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'auth-atomicity-test',
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        },
      ],
    });

    const tenantDb = new TenantPrismaService(appPrisma);
    const mfaAudits = [];
    const staleMarkerRedis = {
      get: async () => '1',
      del: async () => { throw new Error('forced Redis cleanup failure'); },
    };
    const mfaService = createAuthService(tenantDb, {
      redis: staleMarkerRedis,
      auditCreate: async ({ data }) => {
        mfaAudits.push(data);
        return { id: randomUUID(), ...data };
      },
    });

    await mfaService.disableMfa(
      mfa.userId,
      backupCode,
      { tenantId: mfa.tenantId, sessionId: mfaSessionId },
      { ipAddress: '127.0.0.1', userAgent: 'auth-atomicity-test' },
    );

    const mfaAfter = await ownerPrisma.user.findUniqueOrThrow({ where: { id: mfa.userId } });
    const mfaSessionAfter = await ownerPrisma.session.findUniqueOrThrow({ where: { id: mfaSessionId } });
    assert.equal(mfaAfter.mfaEnabled, false);
    assert.equal(mfaAfter.mfaSecret, null);
    assert.deepEqual(mfaAfter.mfaBackupCodes, []);
    assert.ok(mfaSessionAfter.revokedAt, 'the database session is revoked before Redis cleanup');
    await assert.rejects(
      mfaService.validateAccessSession({
        sub: mfa.userId,
        tenantId: mfa.tenantId,
        role: 'Staff',
        legacyRole: 'STAFF',
        sessionId: mfaSessionId,
      }),
      /Invalid or expired session/,
    );
    assert.equal(mfaAudits.length, 1);
    assert.equal(mfaAudits[0].action, 'MFA_DISABLED');
    assert.doesNotMatch(JSON.stringify(mfaAudits), /ABCD|EFGH|IJKL/i);

    const pinBefore = await ownerPrisma.user.findUniqueOrThrow({ where: { id: pin.userId } });
    const pinSessionBefore = await ownerPrisma.session.findUniqueOrThrow({ where: { id: pinSessionId } });
    const failedAuditService = createAuthService(tenantDb, {
      redis: { get: async () => null, del: async () => 1 },
      auditCreate: async () => { throw new Error('forced audit failure'); },
    });
    await assert.rejects(
      failedAuditService.rotateOwnPin(
        pin.userId,
        oldPin,
        rotatedPin,
        pin.tenantId,
        pinSessionId,
        { ipAddress: '127.0.0.1', userAgent: 'auth-atomicity-test' },
      ),
      /forced audit failure/,
    );
    const pinAfterFailure = await ownerPrisma.user.findUniqueOrThrow({ where: { id: pin.userId } });
    const pinSessionAfterFailure = await ownerPrisma.session.findUniqueOrThrow({ where: { id: pinSessionId } });
    assert.equal(pinAfterFailure.pinHash, pinBefore.pinHash);
    assert.equal(pinAfterFailure.pinResetRequired, pinBefore.pinResetRequired);
    assert.equal(pinSessionAfterFailure.revokedAt?.toISOString() ?? null, pinSessionBefore.revokedAt?.toISOString() ?? null);

    const pinAudits = [];
    const resetService = createAuthService(tenantDb, {
      redis: { get: async () => null, del: async () => 1 },
      auditCreate: async ({ data }) => {
        pinAudits.push(data);
        return { id: randomUUID(), ...data };
      },
    });
    await resetService.resetUserPinAsAdmin(
      pin.userId,
      resetPin,
      pin.tenantId,
      pin.userId,
      pinSessionId,
      { ipAddress: '127.0.0.1', userAgent: 'auth-atomicity-test' },
    );
    const pinAfterReset = await ownerPrisma.user.findUniqueOrThrow({ where: { id: pin.userId } });
    const pinSessionAfterReset = await ownerPrisma.session.findUniqueOrThrow({ where: { id: pinSessionId } });
    assert.ok(verifyPin(resetPin, pinAfterReset.pinHash));
    assert.equal(pinAfterReset.pinResetRequired, true);
    assert.ok(pinSessionAfterReset.revokedAt);
    assert.equal(pinAudits.length, 1);
    assert.equal(pinAudits[0].action, 'USER_PIN_RESET');
    assert.doesNotMatch(JSON.stringify(pinAudits), new RegExp(`${oldPin}|${rotatedPin}|${resetPin}`));
    assert.doesNotMatch(JSON.stringify(pinAudits), /\$2[aby]\$/);
  } finally {
    await cleanupFixture(ownerPrisma, tenantIds, userIds);
    await Promise.all([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('admin PIN reset locks live RBAC state and rolls back username bootstrap on every denial', { timeout: 45_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-pin-admin-${runId}`;
  const superId = `00-super-${runId}`;
  const actorId = `10-actor-${runId}`;
  const rollbackTargetId = `20-rollback-${runId}`;
  const revocationTargetId = `30-revocation-${runId}`;
  const promotionTargetId = `40-promotion-${runId}`;
  const userIds = [superId, actorId, rollbackTargetId, revocationTargetId, promotionTargetId];
  const roleIds = {
    super: `role-super-${runId}`,
    admin: `role-admin-${runId}`,
    staff: `role-staff-${runId}`,
  };
  const targetIds = [rollbackTargetId, revocationTargetId, promotionTargetId];
  const sessionIds = new Map(targetIds.map((userId, index) => [userId, `session-pin-admin-${index}-${runId}`]));
  const superSessionId = `session-pin-admin-super-${runId}`;
  let actorSessionId = `session-pin-admin-actor-0-${runId}`;
  let actorSessionSequence = 0;
  const resetAudits = [];

  async function issueActorSession() {
    actorSessionSequence += 1;
    actorSessionId = `session-pin-admin-actor-${actorSessionSequence}-${runId}`;
    await ownerPrisma.session.create({
      data: {
        id: actorSessionId,
        userId: actorId,
        selectorHash: `selector-pin-admin-actor-${actorSessionSequence}-${runId}`,
        refreshToken: `refresh-pin-admin-actor-${actorSessionSequence}-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'admin-pin-transaction-test',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  async function targetCredentialState(userId) {
    const [user, sessions] = await Promise.all([
      ownerPrisma.user.findUniqueOrThrow({ where: { id: userId } }),
      ownerPrisma.session.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    ]);
    return {
      username: user.username,
      pinHash: user.pinHash,
      pinResetRequired: user.pinResetRequired,
      sessions: sessions.map((session) => ({
        id: session.id,
        revokedAt: session.revokedAt?.toISOString() ?? null,
      })),
    };
  }

  async function replaceRoleWithGate(targetUserId, legacyRole, gate) {
    const mutationDb = new TenantPrismaService(mutationPrisma);
    const roleService = new RbacService(gatedTenantDb(
      mutationDb,
      async ({ data }) => ({ id: randomUUID(), ...data }),
      gate.holdAfterOperation,
    ));
    return roleService.replaceUserRolesAsActor(tenantId, {
      actorUserId: superId,
      actorSessionId: superSessionId,
      targetUserId,
      requiredPermission: 'roles:assign',
      selfMutationMessage: 'Cannot change own role',
      auditAction: 'USER_ROLE_UPDATED',
      legacyRole,
    });
  }

  async function runLockedRace({
    mutationTargetId,
    mutationRole,
    resetTargetId,
    pin,
    expectRoleMutationSessionRevocation = false,
  }) {
    const before = await targetCredentialState(resetTargetId);
    const gate = createTransactionGate();
    const mutation = replaceRoleWithGate(mutationTargetId, mutationRole, gate);
    let gateTimeout;
    try {
      await Promise.race([
        gate.entered,
        mutation.then(
          () => { throw new Error('role mutation committed before reaching the transaction gate'); },
          (error) => { throw error; },
        ),
        new Promise((_, reject) => {
          gateTimeout = setTimeout(
            () => reject(new Error('role mutation did not reach the transaction gate')),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(gateTimeout);
    }

    const tenantDb = new TenantPrismaService(appPrisma);
    const resetService = createAuthService(tenantDb, {
      rbac: new RbacService(tenantDb),
      redis: { get: async () => null, del: async () => 1 },
      auditCreate: async ({ data }) => {
        resetAudits.push(data);
        return { id: randomUUID(), ...data };
      },
    });
    let resetState = 'pending';
    const resetAttempt = resetService.resetUserPinAsAdmin(
      resetTargetId,
      pin,
      tenantId,
      actorId,
      actorSessionId,
      { ipAddress: '127.0.0.1', userAgent: 'admin-pin-race-test' },
    ).then(
      (value) => {
        resetState = 'fulfilled';
        return { status: 'fulfilled', value };
      },
      (error) => {
        resetState = 'rejected';
        return { status: 'rejected', error };
      },
    );

    let stateWhileLocked;
    try {
      await delay(250);
      stateWhileLocked = resetState;
    } finally {
      gate.release();
    }
    await mutation;
    const outcome = await resetAttempt;
    assert.equal(stateWhileLocked, 'pending', 'PIN reset must wait for the overlapping role mutation');
    assert.equal(outcome.status, 'rejected');
    assert.match(
      String(outcome.error?.message ?? outcome.error),
      /Administrator session is no longer active|permission is no longer active|equal or greater access|Authorization changed during PIN reset/,
    );
    const after = await targetCredentialState(resetTargetId);
    if (expectRoleMutationSessionRevocation) {
      assert.deepEqual(
        { ...after, sessions: undefined },
        { ...before, sessions: undefined },
        'the denied PIN reset must not change target credentials',
      );
      assert.ok(
        after.sessions.every((session) => session.revokedAt !== null),
        'the committed role promotion must revoke the promoted target sessions',
      );
    } else {
      assert.deepEqual(after, before);
    }
  }

  try {
    await ownerPrisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Admin PIN Transaction Boundary',
        slug: `admin-pin-transaction-${runId}`,
        status: 'ACTIVE',
      },
    });
    await ownerPrisma.user.createMany({
      data: [
        { id: superId, tenantId, name: 'System Admin', role: 'SUPER_ADMIN' },
        { id: actorId, tenantId, name: 'Tenant Admin', role: 'ADMIN' },
        ...targetIds.map((id, index) => ({
          id,
          tenantId,
          name: `Username Less Target ${index}`,
          role: 'STAFF',
          username: null,
          email: null,
          pinHash: hashPin(`${index + 4}864`),
          pinResetRequired: false,
        })),
      ],
    });
    const permissionKeys = ['users:admin', 'roles:assign', 'auth:login_pin', 'dashboard:access'];
    for (const key of permissionKeys) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable auth transaction integration permission',
          category: key.startsWith('auth:') ? 'AUTH' : 'USERS',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    const permissionIdFor = (key) => {
      const id = permissionId.get(key);
      assert.ok(id, `missing integration permission ${key}`);
      return id;
    };
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.super,
          tenantId,
          name: `System Admin ${runId}`,
          slug: `system-admin-${runId}`,
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.admin,
          tenantId,
          name: `Admin ${runId}`,
          slug: `admin-${runId}`,
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.staff,
          tenantId,
          name: `Staff ${runId}`,
          slug: `staff-${runId}`,
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        ...permissionKeys.map((key) => ({ roleId: roleIds.super, permissionId: permissionIdFor(key) })),
        ...['users:admin', 'auth:login_pin', 'dashboard:access']
          .map((key) => ({ roleId: roleIds.admin, permissionId: permissionIdFor(key) })),
        ...['auth:login_pin', 'dashboard:access']
          .map((key) => ({ roleId: roleIds.staff, permissionId: permissionIdFor(key) })),
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId, userId: superId, roleId: roleIds.super },
        { tenantId, userId: actorId, roleId: roleIds.admin },
        ...targetIds.map((userId) => ({ tenantId, userId, roleId: roleIds.staff })),
      ],
    });
    await ownerPrisma.session.createMany({
      data: [
        ...targetIds.map((userId) => ({
          id: sessionIds.get(userId),
          userId,
          selectorHash: `selector-${userId}`,
          refreshToken: `refresh-${userId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'admin-pin-transaction-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })),
        {
          id: superSessionId,
          userId: superId,
          selectorHash: `selector-pin-admin-super-${runId}`,
          refreshToken: `refresh-pin-admin-super-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'admin-pin-transaction-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          id: actorSessionId,
          userId: actorId,
          selectorHash: `selector-pin-admin-actor-0-${runId}`,
          refreshToken: `refresh-pin-admin-actor-0-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'admin-pin-transaction-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });

    const tenantDb = new TenantPrismaService(appPrisma);
    const liveRbac = new RbacService(tenantDb);
    const malformedService = createAuthService(tenantDb, {
      rbac: liveRbac,
      redis: { get: async () => null, del: async () => 1 },
      auditCreate: async ({ data }) => {
        resetAudits.push(data);
        return { id: randomUUID(), ...data };
      },
    });
    const rollbackBefore = await targetCredentialState(rollbackTargetId);
    await assert.rejects(
      malformedService.resetUserPinAsAdmin(
        rollbackTargetId,
        '12x4',
        tenantId,
        actorId,
        actorSessionId,
      ),
      /PIN must be 4-8 numeric digits/,
    );
    assert.deepEqual(await targetCredentialState(rollbackTargetId), rollbackBefore);
    assert.equal(resetAudits.length, 0);

    let forcedAuditCalls = 0;
    const forcedAuditService = createAuthService(tenantDb, {
      rbac: liveRbac,
      redis: { get: async () => null, del: async () => 1 },
      auditCreate: async () => {
        forcedAuditCalls += 1;
        throw new Error('forced admin PIN audit failure');
      },
    });
    await assert.rejects(
      forcedAuditService.resetUserPinAsAdmin(
        rollbackTargetId,
        '8642',
        tenantId,
        actorId,
        actorSessionId,
      ),
      /forced admin PIN audit failure/,
    );
    assert.equal(forcedAuditCalls, 1);
    assert.deepEqual(await targetCredentialState(rollbackTargetId), rollbackBefore);
    assert.equal(resetAudits.length, 0);

    await runLockedRace({
      mutationTargetId: actorId,
      mutationRole: 'STAFF',
      resetTargetId: revocationTargetId,
      pin: '7531',
    });

    const normalRoleDb = authBoundaryTenantDb(
      new TenantPrismaService(mutationPrisma),
      async ({ data }) => ({ id: randomUUID(), ...data }),
    );
    await new RbacService(normalRoleDb).replaceUserRolesAsActor(tenantId, {
      actorUserId: superId,
      actorSessionId: superSessionId,
      targetUserId: actorId,
      requiredPermission: 'roles:assign',
      selfMutationMessage: 'Cannot change own role',
      auditAction: 'USER_ROLE_UPDATED',
      legacyRole: 'ADMIN',
    });
    await issueActorSession();

    await runLockedRace({
      mutationTargetId: promotionTargetId,
      mutationRole: 'ADMIN',
      resetTargetId: promotionTargetId,
      pin: '9753',
      expectRoleMutationSessionRevocation: true,
    });
    assert.equal(resetAudits.length, 0, 'denied reset attempts do not create PIN-reset audit records');
  } finally {
    await cleanupFixture(ownerPrisma, [tenantId], userIds);
    await Promise.all([
      appPrisma.$disconnect(),
      mutationPrisma.$disconnect(),
      ownerPrisma.$disconnect(),
    ]);
  }
});

test('suspended actors lose locked PIN-reset and role-replacement authority while suspended targets remain recoverable', { timeout: 45_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-suspended-actor-${runId}`;
  const actorId = `actor-suspended-${runId}`;
  const targetId = `target-suspended-${runId}`;
  let actorSessionId;
  let actorSessionSequence = 0;
  const userIds = [actorId, targetId];
  const roleIds = {
    admin: `role-suspended-admin-${runId}`,
    staff: `role-suspended-staff-${runId}`,
  };
  const auditWrites = [];
  const auditCreate = async ({ data }) => {
    auditWrites.push(data);
    return { id: randomUUID(), ...data };
  };

  async function issueActorSession() {
    actorSessionSequence += 1;
    actorSessionId = `session-suspended-actor-${actorSessionSequence}-${runId}`;
    await ownerPrisma.session.create({
      data: {
        id: actorSessionId,
        userId: actorId,
        selectorHash: `selector-suspended-actor-${actorSessionSequence}-${runId}`,
        refreshToken: `refresh-suspended-actor-${actorSessionSequence}-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'suspended-actor-test',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  }

  async function suspendActorWithGate() {
    const gate = createTransactionGate();
    const mutationDb = proxiedTenantDb(new TenantPrismaService(mutationPrisma), {
      holdAfterOperation: gate.holdAfterOperation,
    });
    const suspension = mutationDb.withTenant(tenantId, (tx) => tx.user.update({
      where: { id: actorId },
      data: { suspendedAt: new Date() },
    }), { isolationLevel: 'Serializable', timeout: 10_000 });
    await gate.entered;
    return { gate, suspension };
  }

  try {
    await ownerPrisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Suspended Actor Boundary',
        slug: `suspended-actor-${runId}`,
        status: 'ACTIVE',
      },
    });
    await ownerPrisma.user.createMany({
      data: [
        {
          id: actorId,
          tenantId,
          name: 'Live Administrator',
          username: `admin.${runId.slice(0, 8)}`,
          role: 'ADMIN',
        },
        {
          id: targetId,
          tenantId,
          name: 'Recovery Target',
          username: `target.${runId.slice(0, 8)}`,
          role: 'STAFF',
          pinHash: hashPin('2468'),
        },
      ],
    });
    const permissionKeys = [
      'users:admin',
      'users:write',
      'roles:assign',
      'roles:write',
      'dashboard:access',
      'auth:login_email',
    ];
    for (const key of permissionKeys) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable suspended actor permission',
          category: key === 'dashboard:access' ? 'AUTH' : 'USERS',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.admin,
          tenantId,
          name: `Suspension Admin ${runId}`,
          slug: `suspension-admin-${runId}`,
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.staff,
          tenantId,
          name: `Suspension Staff ${runId}`,
          slug: `suspension-staff-${runId}`,
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        ...permissionKeys.map((key) => ({ roleId: roleIds.admin, permissionId: permissionId.get(key) })),
        { roleId: roleIds.staff, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.staff, permissionId: permissionId.get('auth:login_email') },
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId, userId: actorId, roleId: roleIds.admin },
        { tenantId, userId: targetId, roleId: roleIds.staff },
      ],
    });
    await issueActorSession();

    const serviceDb = proxiedTenantDb(new TenantPrismaService(appPrisma), { auditCreate });
    const liveRbac = new RbacService(serviceDb);
    const auth = createAuthService(serviceDb, {
      rbac: liveRbac,
      redis: { get: async () => null, del: async () => 1 },
      auditCreate,
    });

    const firstSuspension = await suspendActorWithGate();
    let resetState = 'pending';
    const reset = auth.resetUserPinAsAdmin(targetId, '1357', tenantId, actorId, actorSessionId)
      .then(() => { resetState = 'fulfilled'; }, (error) => { resetState = 'rejected'; throw error; });
    await delay(200);
    assert.equal(resetState, 'pending', 'PIN reset waits for the actor suspension row lock');
    firstSuspension.gate.release();
    await firstSuspension.suspension;
    await assert.rejects(
      reset,
      /Authorization changed during PIN reset|Administrator account is suspended/,
    );
    const afterDeniedReset = await ownerPrisma.user.findUniqueOrThrow({ where: { id: targetId } });
    assert.ok(verifyPin('2468', afterDeniedReset.pinHash));
    await assert.rejects(
      auth.resetUserPinAsAdmin(targetId, '1357', tenantId, actorId, actorSessionId),
      /Administrator account is suspended/,
    );

    await ownerPrisma.user.update({ where: { id: actorId }, data: { suspendedAt: null } });
    await issueActorSession();
    const secondSuspension = await suspendActorWithGate();
    let replacementState = 'pending';
    const replacement = liveRbac.replaceUserRolesAsActor(tenantId, {
      actorUserId: actorId,
      actorSessionId,
      targetUserId: targetId,
      requiredPermission: 'roles:assign',
      selfMutationMessage: 'Cannot change own role',
      auditAction: 'USER_ACCESS_UPDATED',
      roleIds: [roleIds.staff],
    }).then(
      () => { replacementState = 'fulfilled'; },
      (error) => { replacementState = 'rejected'; throw error; },
    );
    await delay(200);
    assert.equal(replacementState, 'pending', 'role replacement waits for the actor suspension row lock');
    secondSuspension.gate.release();
    await secondSuspension.suspension;
    await assert.rejects(
      replacement,
      /Authorization or access state changed concurrently|Administrator account is suspended/,
    );
    const assignmentsAfterDenial = await ownerPrisma.roleAssignment.findMany({
      where: { tenantId, userId: targetId },
      select: { roleId: true },
    });
    assert.deepEqual(assignmentsAfterDenial, [{ roleId: roleIds.staff }]);
    await assert.rejects(
      liveRbac.replaceUserRolesAsActor(tenantId, {
        actorUserId: actorId,
        actorSessionId,
        targetUserId: targetId,
        requiredPermission: 'roles:assign',
        selfMutationMessage: 'Cannot change own role',
        auditAction: 'USER_ACCESS_UPDATED',
        roleIds: [roleIds.staff],
      }),
      /Administrator account is suspended/,
    );

    await ownerPrisma.user.update({ where: { id: actorId }, data: { suspendedAt: null } });
    await issueActorSession();
    await ownerPrisma.user.update({ where: { id: targetId }, data: { suspendedAt: new Date() } });
    await auth.resetUserPinAsAdmin(targetId, '9753', tenantId, actorId, actorSessionId);
    const recoveredTarget = await ownerPrisma.user.findUniqueOrThrow({ where: { id: targetId } });
    assert.ok(recoveredTarget.suspendedAt, 'recovery does not silently unsuspend the target');
    assert.ok(verifyPin('9753', recoveredTarget.pinHash), 'an active actor may recover a suspended target PIN');

    const runExactSessionRevocationRace = async (label, operation) => {
      const sessionId = actorSessionId;
      const gate = createTransactionGate();
      const revocation = new TenantPrismaService(mutationPrisma).withTenant(tenantId, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${sessionId} FOR UPDATE`;
        await tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
        await gate.holdAfterOperation();
      }, { isolationLevel: 'Serializable', timeout: 10_000 });
      await gate.entered;
      let state = 'pending';
      const attempt = operation(sessionId).then(
        (value) => { state = 'fulfilled'; return value; },
        (error) => { state = 'rejected'; throw error; },
      );
      await delay(200);
      assert.equal(state, 'pending', `${label} waits for the exact actor session lock`);
      gate.release();
      await revocation;
      await assert.rejects(
        attempt,
        /session is no longer active|Authorization or access state changed concurrently|Authorization or invitation state changed concurrently/,
      );
      await issueActorSession();
    };

    const targetAssignmentsBefore = await ownerPrisma.roleAssignment.findMany({
      where: { tenantId, userId: targetId },
      select: { roleId: true },
    });
    const auditCountBeforeRoleRace = auditWrites.length;
    await runExactSessionRevocationRace('tenant role replacement', (sessionId) => (
      liveRbac.replaceUserRolesAsActor(tenantId, {
        actorUserId: actorId,
        actorSessionId: sessionId,
        targetUserId: targetId,
        requiredPermission: 'roles:assign',
        selfMutationMessage: 'Cannot change own role',
        auditAction: 'USER_ACCESS_UPDATED',
        roleIds: [roleIds.staff],
      })
    ));
    assert.deepEqual(await ownerPrisma.roleAssignment.findMany({
      where: { tenantId, userId: targetId },
      select: { roleId: true },
    }), targetAssignmentsBefore);
    assert.equal(auditWrites.length, auditCountBeforeRoleRace);

    const deniedRoleName = `Denied Role ${runId}`;
    const auditCountBeforeCustomRole = auditWrites.length;
    await runExactSessionRevocationRace('custom-role creation', (sessionId) => (
      liveRbac.createRole(tenantId, {
        name: deniedRoleName,
        permissionKeys: ['dashboard:access'],
      }, {
        actorUserId: actorId,
        actorSessionId: sessionId,
      })
    ));
    assert.equal(await ownerPrisma.role.count({ where: { tenantId, name: deniedRoleName } }), 0);
    assert.equal(auditWrites.length, auditCountBeforeCustomRole);

    let invitationOutboxCalls = 0;
    const usersController = new UsersController(
      {},
      liveRbac,
      {
        enqueueInTransaction: async () => {
          invitationOutboxCalls += 1;
          return { id: randomUUID(), status: 'PENDING', attempts: 0 };
        },
        toResponse: (row) => row,
        notApplicable: () => ({ status: 'not_applicable' }),
      },
      serviceDb,
    );
    const invitedEmail = `denied-invite-${runId}@example.test`;
    const auditCountBeforeInvite = auditWrites.length;
    await runExactSessionRevocationRace('invitation creation', (sessionId) => (
      usersController.invite(
        { name: 'Denied Invite', email: invitedEmail, roleId: roleIds.staff },
        { user: { tenantId, sub: actorId, sessionId } },
      )
    ));
    assert.equal(await ownerPrisma.user.count({ where: { tenantId, email: invitedEmail } }), 0);
    assert.equal(invitationOutboxCalls, 0);
    assert.equal(auditWrites.length, auditCountBeforeInvite);
  } finally {
    await cleanupFixture(ownerPrisma, [tenantId], userIds);
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('platform user lifecycle reauthorizes live actors under stable cross-user locks', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const capability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET?.trim();
  assert.ok(capability, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for platform lifecycle integration proof');
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-platform-lifecycle-${runId}`;
  const actorId = `actor-platform-lifecycle-${runId}`;
  const stableActorA = `actor-platform-a-${runId}`;
  const stableActorB = `actor-platform-b-${runId}`;
  const tenantLockTargetId = `target-platform-tenant-lock-${runId}`;
  const suspendTargetId = `target-platform-suspend-${runId}`;
  const activateTargetId = `target-platform-activate-${runId}`;
  const userIds = [
    actorId,
    stableActorA,
    stableActorB,
    tenantLockTargetId,
    suspendTargetId,
    activateTargetId,
  ];
  const roleIds = {
    super: `role-platform-super-${runId}`,
    staff: `role-platform-staff-${runId}`,
  };
  const targetSessionId = `session-platform-target-${runId}`;
  const actorSessionIds = new Map();
  let actorSessionSequence = 0;
  const mutationTenantDb = new TenantPrismaService(mutationPrisma);
  const appTenantDb = new TenantPrismaService(appPrisma);
  const guardRbac = new RbacService(appTenantDb);
  const mutationRbac = new RbacService(mutationTenantDb);
  const appLifecycle = new AdminUserLifecycleService(appTenantDb, guardRbac);
  const mutationLifecycle = new AdminUserLifecycleService(mutationTenantDb, mutationRbac);
  const actor = (userId) => {
    const sessionId = actorSessionIds.get(userId);
    assert.ok(sessionId, `active actor session is required for ${userId}`);
    return {
      userId,
      tenantId,
      sessionId,
      ipAddress: '203.0.113.77',
      userAgent: 'restricted-platform-lifecycle-proof',
    };
  };

  async function issueActorSession(userId) {
    actorSessionSequence += 1;
    const sessionId = `session-platform-actor-${actorSessionSequence}-${runId}`;
    await ownerPrisma.session.create({
      data: {
        id: sessionId,
        userId,
        selectorHash: `selector-platform-actor-${actorSessionSequence}-${runId}`,
        refreshToken: `refresh-platform-actor-${actorSessionSequence}-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'platform-lifecycle-actor',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    actorSessionIds.set(userId, sessionId);
    return sessionId;
  }

  async function targetSnapshot(targetUserId) {
    const [user, sessions, auditCount] = await Promise.all([
      ownerPrisma.user.findUniqueOrThrow({
        where: { id: targetUserId },
        select: { id: true, tenantId: true, suspendedAt: true, deletedAt: true },
      }),
      ownerPrisma.session.findMany({
        where: { userId: targetUserId },
        select: { id: true, revokedAt: true },
        orderBy: { id: 'asc' },
      }),
      ownerPrisma.auditLog.count({
        where: {
          tenantId,
          resource: 'User',
          resourceId: targetUserId,
          action: { in: ['USER_SUSPENDED', 'USER_ACTIVATED'] },
        },
      }),
    ]);
    return {
      ...user,
      suspendedAt: user.suspendedAt?.toISOString() ?? null,
      deletedAt: user.deletedAt?.toISOString() ?? null,
      sessions: sessions.map((session) => ({
        id: session.id,
        revokedAt: session.revokedAt?.toISOString() ?? null,
      })),
      auditCount,
    };
  }

  async function assertGuardEraPlatformAuthority() {
    const access = await guardRbac.getEffectiveAccess(actorId, tenantId);
    assert.ok(
      access.permissions.includes('admin_portal:access'),
      'the actor is platform-authorized before the concurrent state change',
    );
  }

  async function runSuspensionBarrier(operation, targetUserId) {
    await assertGuardEraPlatformAuthority();
    const before = await targetSnapshot(targetUserId);
    const gate = createTransactionGate();
    const actorSuspension = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.user.update({
        where: { id: actorId },
        data: { suspendedAt: new Date() },
        select: { id: true },
      });
      await gate.holdAfterOperation();
    }, { isolationLevel: 'Serializable', timeout: 10_000 });
    await gate.entered;

    let attemptState = 'pending';
    const attempt = appLifecycle[operation](targetUserId, actor(actorId)).then(
      (value) => { attemptState = 'fulfilled'; return value; },
      (error) => { attemptState = 'rejected'; throw error; },
    );
    try {
      await delay(200);
      assert.equal(attemptState, 'pending', `${operation} waits for the actor suspension row lock`);
    } finally {
      gate.release();
      await actorSuspension;
    }
    await assert.rejects(
      attempt,
      /Platform administrator account is suspended|Authorization or user lifecycle changed concurrently/,
    );
    assert.deepEqual(await targetSnapshot(targetUserId), before);
    await ownerPrisma.user.updateMany({ where: { id: actorId }, data: { suspendedAt: null } });
    await issueActorSession(actorId);
  }

  async function runSessionRevocationBarrier(operation, targetUserId) {
    const before = await targetSnapshot(targetUserId);
    const sessionId = actorSessionIds.get(actorId);
    const gate = createTransactionGate();
    const revocation = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Session"
        WHERE "id" = ${sessionId}
        FOR UPDATE
      `;
      await tx.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
      await gate.holdAfterOperation();
    }, { isolationLevel: 'Serializable', timeout: 10_000 });
    await gate.entered;

    let attemptState = 'pending';
    const attempt = appLifecycle[operation](targetUserId, actor(actorId)).then(
      (value) => { attemptState = 'fulfilled'; return value; },
      (error) => { attemptState = 'rejected'; throw error; },
    );
    try {
      await delay(200);
      assert.equal(attemptState, 'pending', `${operation} waits for the exact actor session lock`);
    } finally {
      gate.release();
      await revocation;
    }
    await assert.rejects(
      attempt,
      /Platform administrator session is no longer active|Authorization or user lifecycle changed concurrently/,
    );
    assert.deepEqual(await targetSnapshot(targetUserId), before);
    await issueActorSession(actorId);
  }

  async function runRevocationBarrier(operation, targetUserId) {
    await assertGuardEraPlatformAuthority();
    const before = await targetSnapshot(targetUserId);
    const gate = createTransactionGate();
    const revocation = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await mutationRbac.replaceLegacySystemRoleForPlatformAdminInTransaction(
        tx,
        actorId,
        tenantId,
        'STAFF',
      );
      await gate.holdAfterOperation();
    }, { isolationLevel: 'Serializable', timeout: 10_000 });
    await gate.entered;

    let attemptState = 'pending';
    const attempt = appLifecycle[operation](targetUserId, actor(actorId)).then(
      (value) => { attemptState = 'fulfilled'; return value; },
      (error) => { attemptState = 'rejected'; throw error; },
    );
    try {
      await delay(200);
      assert.equal(attemptState, 'pending', `${operation} waits for the actor RBAC revocation lock`);
    } finally {
      gate.release();
      await revocation;
    }
    await assert.rejects(
      attempt,
      /Platform administrator authority is no longer active|Authorization or user lifecycle changed concurrently/,
    );
    assert.deepEqual(await targetSnapshot(targetUserId), before);
    await mutationTenantDb.withPlatformAdmin((tx) => (
      mutationRbac.replaceLegacySystemRoleForPlatformAdminInTransaction(
        tx,
        actorId,
        tenantId,
        'SUPER_ADMIN',
      )
    ), { isolationLevel: 'Serializable', timeout: 10_000 });
  }

  async function runTenantUserAuditBarrier() {
    const gate = createTransactionGate();
    const tenantFirstMutation = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "Tenant"
        WHERE "id" = ${tenantId}
        FOR UPDATE
      `;
      await gate.holdAfterOperation();
      await tx.$queryRaw`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${tenantLockTargetId}
        FOR UPDATE
      `;
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: null,
          actorUserId: actorId,
          actorTenantId: tenantId,
          action: 'PLATFORM_USER_LIFECYCLE_LOCK_BARRIER',
          resource: 'User',
          resourceId: tenantLockTargetId,
          oldValue: { tenantLock: true },
          newValue: { userLock: true },
        },
      });
    }, { isolationLevel: 'Serializable', timeout: 10_000 });
    await gate.entered;

    let lifecycleState = 'pending';
    const lifecycle = appLifecycle.suspend(tenantLockTargetId, actor(actorId)).then(
      (value) => { lifecycleState = 'fulfilled'; return value; },
      (error) => { lifecycleState = 'rejected'; throw error; },
    );
    try {
      await delay(200);
      assert.equal(lifecycleState, 'pending', 'lifecycle waits on the tenant lock before locking users');
    } finally {
      gate.release();
    }

    const [, result] = await Promise.race([
      Promise.all([tenantFirstMutation, lifecycle]),
      delay(10_000).then(() => { throw new Error('tenant/user lifecycle lock hierarchy timed out'); }),
    ]);
    assert.equal(result.changed, true);
    assert.equal(result.status, 'SUSPENDED');
    assert.ok(
      (await ownerPrisma.user.findUniqueOrThrow({ where: { id: tenantLockTargetId } })).suspendedAt,
      'the lifecycle mutation commits after the tenant-first transaction',
    );
    assert.equal(await ownerPrisma.auditLog.count({
      where: {
        tenantId,
        resourceId: tenantLockTargetId,
        action: { in: ['PLATFORM_USER_LIFECYCLE_LOCK_BARRIER', 'USER_SUSPENDED'] },
      },
    }), 2, 'both restricted-role transactions commit their real audit inserts without deadlock');
  }

  async function cleanup() {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
      if (!tenant) return;
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "status" = 'PURGED'::"TenantStatus",
            "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
            "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
      await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      await tx.roleAssignment.deleteMany({ where: { tenantId } });
      await tx.role.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`;
    });
  }

  try {
    await ownerPrisma.$executeRaw`
      INSERT INTO "Tenant" ("id", "name", "slug", "status", "createdAt", "updatedAt")
      VALUES (
        ${tenantId},
        'Platform Lifecycle Authorization Boundary',
        ${`platform-lifecycle-${runId}`},
        'ACTIVE'::"TenantStatus",
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
    `;
    await ownerPrisma.user.createMany({
      data: [
        { id: actorId, tenantId, name: 'Platform Lifecycle Actor', role: 'SUPER_ADMIN' },
        { id: stableActorA, tenantId, name: 'Stable Platform Actor A', role: 'SUPER_ADMIN' },
        { id: stableActorB, tenantId, name: 'Stable Platform Actor B', role: 'SUPER_ADMIN' },
        { id: tenantLockTargetId, tenantId, name: 'Tenant Lock Target', role: 'STAFF' },
        { id: suspendTargetId, tenantId, name: 'Suspension Target', role: 'STAFF' },
        {
          id: activateTargetId,
          tenantId,
          name: 'Activation Target',
          role: 'STAFF',
          suspendedAt: new Date('2026-07-16T12:00:00.000Z'),
        },
      ],
    });
    for (const key of ['admin_portal:access', 'dashboard:access']) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable platform lifecycle permission',
          category: key === 'dashboard:access' ? 'AUTH' : 'ADMIN',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: ['admin_portal:access', 'dashboard:access'] } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.super,
          tenantId,
          name: `Platform Super ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.staff,
          tenantId,
          name: `Platform Staff ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        { roleId: roleIds.super, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.super, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.staff, permissionId: permissionId.get('dashboard:access') },
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId, userId: actorId, roleId: roleIds.super },
        { tenantId, userId: stableActorA, roleId: roleIds.super },
        { tenantId, userId: stableActorB, roleId: roleIds.super },
        { tenantId, userId: tenantLockTargetId, roleId: roleIds.staff },
        { tenantId, userId: suspendTargetId, roleId: roleIds.staff },
        { tenantId, userId: activateTargetId, roleId: roleIds.staff },
      ],
    });
    await Promise.all([actorId, stableActorA, stableActorB].map(issueActorSession));
    await ownerPrisma.session.createMany({
      data: [{
        id: targetSessionId,
        userId: suspendTargetId,
        selectorHash: `selector-${runId}`,
        refreshToken: `refresh-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'platform-lifecycle-target',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }],
    });

    await runTenantUserAuditBarrier();
    await runSuspensionBarrier('suspend', suspendTargetId);
    await runSuspensionBarrier('activate', activateTargetId);
    await runSessionRevocationBarrier('suspend', suspendTargetId);
    await runSessionRevocationBarrier('activate', activateTargetId);
    await runRevocationBarrier('suspend', suspendTargetId);
    await runRevocationBarrier('activate', activateTargetId);

    const selfBefore = await targetSnapshot(actorId);
    await assert.rejects(
      appLifecycle.suspend(actorId, actor(actorId)),
      /cannot suspend their own account/i,
    );
    await assert.rejects(
      appLifecycle.activate(actorId, actor(actorId)),
      /cannot activate their own account/i,
    );
    assert.deepEqual(await targetSnapshot(actorId), selfBefore);

    const stableOperations = Promise.allSettled([
      appLifecycle.suspend(stableActorB, actor(stableActorA)),
      mutationLifecycle.suspend(stableActorA, actor(stableActorB)),
    ]);
    const stableResults = await Promise.race([
      stableOperations,
      delay(10_000).then(() => { throw new Error('stable lifecycle lock ordering timed out'); }),
    ]);
    const fulfilled = stableResults.filter((result) => result.status === 'fulfilled');
    const rejected = stableResults.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'one cross-suspension wins without a deadlock');
    assert.equal(rejected.length, 1, 'the newly suspended actor cannot complete the opposing mutation');
    assert.match(
      String(rejected[0].reason?.message ?? rejected[0].reason),
      /Platform administrator account is suspended|Authorization or user lifecycle changed concurrently/,
    );

    const stableA = await ownerPrisma.user.findUniqueOrThrow({
      where: { id: stableActorA },
      select: { suspendedAt: true },
    });
    const activeActorId = stableA.suspendedAt ? stableActorB : stableActorA;
    const suspendedActorId = stableA.suspendedAt ? stableActorA : stableActorB;
    const recoveryService = activeActorId === stableActorA ? appLifecycle : mutationLifecycle;
    const recovery = await recoveryService.activate(suspendedActorId, actor(activeActorId));
    assert.equal(recovery.changed, true);
    assert.equal(recovery.status, 'ACTIVE');
    assert.equal(
      (await ownerPrisma.user.findUniqueOrThrow({ where: { id: suspendedActorId } })).suspendedAt,
      null,
      'an active platform actor can recover a different suspended target',
    );
    assert.equal(await ownerPrisma.auditLog.count({
      where: {
        tenantId,
        resource: 'User',
        resourceId: { in: [stableActorA, stableActorB] },
        action: { in: ['USER_SUSPENDED', 'USER_ACTIVATED'] },
      },
    }), 2);
  } finally {
    await cleanup();
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('user deactivation reauthorizes after concurrent role change and rolls every tombstone write back on audit failure', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-deactivation-auth-${runId}`;
  const superId = `super-deactivation-${runId}`;
  const actorId = `actor-deactivation-${runId}`;
  const raceTargetId = `target-deactivation-race-${runId}`;
  const rollbackTargetId = `target-deactivation-rollback-${runId}`;
  const userIds = [superId, actorId, raceTargetId, rollbackTargetId];
  const roleIds = {
    super: `role-deactivation-super-${runId}`,
    admin: `role-deactivation-admin-${runId}`,
    staff: `role-deactivation-staff-${runId}`,
  };
  const rollbackSessionId = `session-deactivation-rollback-${runId}`;
  const superSessionId = `session-deactivation-super-${runId}`;
  let actorSessionId = `session-deactivation-actor-0-${runId}`;
  const auditCreate = async ({ data }) => ({ id: randomUUID(), ...data });

  try {
    await ownerPrisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Deactivation Authorization Boundary',
        slug: `deactivation-authorization-${runId}`,
        status: 'ACTIVE',
      },
    });
    await ownerPrisma.user.createMany({
      data: [
        { id: superId, tenantId, name: 'System Admin', role: 'SUPER_ADMIN' },
        { id: actorId, tenantId, name: 'User Administrator', role: 'ADMIN' },
        {
          id: raceTargetId,
          tenantId,
          name: 'Race Target',
          email: `race.${runId}@example.test`,
          role: 'STAFF',
          pinHash: hashPin('2468'),
        },
        {
          id: rollbackTargetId,
          tenantId,
          name: 'Rollback Target',
          email: `rollback.${runId}@example.test`,
          username: `rollback.${runId.slice(0, 8)}`,
          role: 'STAFF',
          pinHash: hashPin('1357'),
        },
      ],
    });
    const permissionKeys = ['users:admin', 'roles:assign', 'dashboard:access'];
    for (const key of permissionKeys) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable deactivation permission',
          category: key === 'dashboard:access' ? 'AUTH' : 'USERS',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.super,
          tenantId,
          name: `Deactivation Super ${runId}`,
          slug: `deactivation-super-${runId}`,
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.admin,
          tenantId,
          name: `Deactivation Admin ${runId}`,
          slug: `deactivation-admin-${runId}`,
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.staff,
          tenantId,
          name: `Deactivation Staff ${runId}`,
          slug: `deactivation-staff-${runId}`,
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        ...permissionKeys.map((key) => ({ roleId: roleIds.super, permissionId: permissionId.get(key) })),
        ...['users:admin', 'dashboard:access']
          .map((key) => ({ roleId: roleIds.admin, permissionId: permissionId.get(key) })),
        { roleId: roleIds.staff, permissionId: permissionId.get('dashboard:access') },
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId, userId: superId, roleId: roleIds.super },
        { tenantId, userId: actorId, roleId: roleIds.admin },
        { tenantId, userId: raceTargetId, roleId: roleIds.staff },
        { tenantId, userId: rollbackTargetId, roleId: roleIds.staff },
      ],
    });
    await ownerPrisma.session.createMany({
      data: [
        {
          id: rollbackSessionId,
          userId: rollbackTargetId,
          selectorHash: `selector-${runId}`,
          refreshToken: `refresh-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'deactivation-rollback-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          id: superSessionId,
          userId: superId,
          selectorHash: `selector-deactivation-super-${runId}`,
          refreshToken: `refresh-deactivation-super-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'deactivation-auth-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          id: actorSessionId,
          userId: actorId,
          selectorHash: `selector-deactivation-actor-0-${runId}`,
          refreshToken: `refresh-deactivation-actor-0-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'deactivation-auth-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });

    const controllerDb = proxiedTenantDb(new TenantPrismaService(appPrisma), { auditCreate });
    const controllerRbac = new RbacService(controllerDb);
    const controller = new UsersController({}, controllerRbac, {}, controllerDb);
    const gate = createTransactionGate();
    const mutationDb = gatedTenantDb(
      new TenantPrismaService(mutationPrisma),
      auditCreate,
      gate.holdAfterOperation,
    );
    const demotion = new RbacService(mutationDb).replaceUserRolesAsActor(tenantId, {
      actorUserId: superId,
      actorSessionId: superSessionId,
      targetUserId: actorId,
      requiredPermission: 'roles:assign',
      selfMutationMessage: 'Cannot change own role',
      auditAction: 'USER_ROLE_UPDATED',
      legacyRole: 'STAFF',
    });
    await gate.entered;

    let deactivationState = 'pending';
    const deactivation = controller.deactivate(raceTargetId, {
      user: { tenantId, sub: actorId, sessionId: actorSessionId },
    }).then(
      () => { deactivationState = 'fulfilled'; },
      (error) => { deactivationState = 'rejected'; throw error; },
    );
    await delay(250);
    assert.equal(deactivationState, 'pending', 'deactivation waits for the actor assignment mutation');
    gate.release();
    await demotion;
    await assert.rejects(
      deactivation,
      /Authorization changed during user deactivation|Administrator session is no longer active|users:admin permission is no longer active/,
    );
    const raceTargetAfter = await ownerPrisma.user.findUniqueOrThrow({ where: { id: raceTargetId } });
    assert.equal(raceTargetAfter.deletedAt, null);
    assert.equal(raceTargetAfter.email, `race.${runId}@example.test`);
    await assert.rejects(
      controller.deactivate(raceTargetId, { user: { tenantId, sub: actorId, sessionId: actorSessionId } }),
      /Administrator session is no longer active|users:admin permission is no longer active/,
    );

    const normalMutationDb = proxiedTenantDb(new TenantPrismaService(mutationPrisma), { auditCreate });
    await new RbacService(normalMutationDb).replaceUserRolesAsActor(tenantId, {
      actorUserId: superId,
      actorSessionId: superSessionId,
      targetUserId: actorId,
      requiredPermission: 'roles:assign',
      selfMutationMessage: 'Cannot change own role',
      auditAction: 'USER_ROLE_UPDATED',
      legacyRole: 'ADMIN',
    });
    actorSessionId = `session-deactivation-actor-1-${runId}`;
    await ownerPrisma.session.create({
      data: {
        id: actorSessionId,
        userId: actorId,
        selectorHash: `selector-deactivation-actor-1-${runId}`,
        refreshToken: `refresh-deactivation-actor-1-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'deactivation-auth-test',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const failedAuditDb = proxiedTenantDb(new TenantPrismaService(appPrisma), {
      auditCreate: async () => { throw new Error('forced deactivation audit failure'); },
    });
    const failedAuditController = new UsersController(
      {},
      new RbacService(failedAuditDb),
      {},
      failedAuditDb,
    );
    const rollbackBefore = await ownerPrisma.user.findUniqueOrThrow({ where: { id: rollbackTargetId } });
    await assert.rejects(
      failedAuditController.deactivate(rollbackTargetId, {
        user: { tenantId, sub: actorId, sessionId: actorSessionId },
      }),
      /forced deactivation audit failure/,
    );
    const rollbackAfter = await ownerPrisma.user.findUniqueOrThrow({ where: { id: rollbackTargetId } });
    assert.equal(rollbackAfter.deletedAt, null);
    assert.equal(rollbackAfter.email, rollbackBefore.email);
    assert.equal(rollbackAfter.username, rollbackBefore.username);
    assert.equal(rollbackAfter.pinHash, rollbackBefore.pinHash);
    const rollbackAssignments = await ownerPrisma.roleAssignment.findMany({
      where: { tenantId, userId: rollbackTargetId },
      select: { roleId: true },
    });
    assert.deepEqual(rollbackAssignments, [{ roleId: roleIds.staff }]);
    const rollbackSession = await ownerPrisma.session.findUniqueOrThrow({ where: { id: rollbackSessionId } });
    assert.equal(rollbackSession.revokedAt, null);
    assert.equal(rollbackSession.selectorHash, `selector-${runId}`);
    assert.equal(rollbackSession.refreshToken, `refresh-${runId}`);
  } finally {
    await cleanupFixture(ownerPrisma, [tenantId], userIds);
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('username bootstrap resolves concurrent same-name reservations and includes soft-deleted collisions', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-username-bootstrap-${runId}`;
  const actorA = `actor-username-a-${runId}`;
  const actorB = `actor-username-b-${runId}`;
  const actorSessionA = `session-username-actor-a-${runId}`;
  const actorSessionB = `session-username-actor-b-${runId}`;
  const targetA = `target-username-a-${runId}`;
  const targetB = `target-username-b-${runId}`;
  const softTarget = `target-username-soft-${runId}`;
  const deletedCollision = `deleted-username-${runId}`;
  const userIds = [actorA, actorB, targetA, targetB, softTarget, deletedCollision];
  const roleIds = {
    adminA: `role-username-admin-a-${runId}`,
    adminB: `role-username-admin-b-${runId}`,
    staffA: `role-username-staff-a-${runId}`,
    staffB: `role-username-staff-b-${runId}`,
  };
  const observedTransactionErrors = [];
  const startBarrier = createTwoPartyBarrier();
  const auditCreate = async ({ data }) => ({ id: randomUUID(), ...data });

  try {
    await ownerPrisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Username Bootstrap Boundary',
        slug: `username-bootstrap-${runId}`,
        status: 'ACTIVE',
      },
    });
    await ownerPrisma.user.createMany({
      data: [
        { id: actorA, tenantId, name: 'Administrator A', role: 'ADMIN' },
        { id: actorB, tenantId, name: 'Administrator B', role: 'ADMIN' },
        { id: targetA, tenantId, name: 'Concurrent Crew', role: 'STAFF', pinHash: hashPin('1111') },
        { id: targetB, tenantId, name: 'Concurrent Crew', role: 'STAFF', pinHash: hashPin('2222') },
        { id: softTarget, tenantId, name: 'Legacy Crew', role: 'STAFF', pinHash: hashPin('3333') },
        {
          id: deletedCollision,
          tenantId,
          name: 'Deleted Legacy Crew',
          username: 'legacy.crew',
          role: 'STAFF',
          deletedAt: new Date(),
        },
      ],
    });
    // The current deletion trigger clears usernames immediately. Recreate a
    // retained historical tombstone so bootstrap proves it never reuses an
    // old username even when the active application cannot create such a row.
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.user.update({
        where: { id: deletedCollision },
        data: { username: 'legacy.crew' },
      });
    });
    const permissionKeys = ['users:admin', 'dashboard:access'];
    for (const key of permissionKeys) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable username bootstrap permission',
          category: key === 'dashboard:access' ? 'AUTH' : 'USERS',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.adminA,
          tenantId,
          name: `Username Admin A ${runId}`,
          slug: `username-admin-a-${runId}`,
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.adminB,
          tenantId,
          name: `Username Admin B ${runId}`,
          slug: `username-admin-b-${runId}`,
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.staffA,
          tenantId,
          name: `Username Staff A ${runId}`,
          slug: `username-staff-a-${runId}`,
          isSystem: true,
          legacyRole: 'STAFF',
        },
        {
          id: roleIds.staffB,
          tenantId,
          name: `Username Staff B ${runId}`,
          slug: `username-staff-b-${runId}`,
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        ...[roleIds.adminA, roleIds.adminB].flatMap((roleId) => permissionKeys
          .map((key) => ({ roleId, permissionId: permissionId.get(key) }))),
        ...[roleIds.staffA, roleIds.staffB].map((roleId) => ({
          roleId,
          permissionId: permissionId.get('dashboard:access'),
        })),
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId, userId: actorA, roleId: roleIds.adminA },
        { tenantId, userId: actorB, roleId: roleIds.adminB },
        { tenantId, userId: targetA, roleId: roleIds.staffA },
        { tenantId, userId: targetB, roleId: roleIds.staffB },
        { tenantId, userId: softTarget, roleId: roleIds.staffA },
      ],
    });
    await ownerPrisma.session.createMany({
      data: [
        {
          id: actorSessionA,
          userId: actorA,
          selectorHash: `selector-username-actor-a-${runId}`,
          refreshToken: `refresh-username-actor-a-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'username-bootstrap-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          id: actorSessionB,
          userId: actorB,
          selectorHash: `selector-username-actor-b-${runId}`,
          refreshToken: `refresh-username-actor-b-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'username-bootstrap-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });

    const tenantDb = proxiedTenantDb(new TenantPrismaService(appPrisma), {
      auditCreate,
      onTransactionError: (error) => {
        observedTransactionErrors.push(error?.code ?? error?.constructor?.name ?? 'unknown');
      },
    });
    const rbac = new RbacService(tenantDb);
    const auth = createAuthService(tenantDb, {
      rbac,
      redis: { get: async () => null, del: async () => 1 },
      auditCreate,
    });
    const resetAtBarrier = async (targetId, pin, actorId, sessionId) => {
      await startBarrier();
      return auth.resetUserPinAsAdmin(targetId, pin, tenantId, actorId, sessionId);
    };
    const outcomes = await within(Promise.allSettled([
      resetAtBarrier(targetA, '4444', actorA, actorSessionA),
      resetAtBarrier(targetB, '5555', actorB, actorSessionB),
    ]), 20_000, 'Concurrent username bootstrap did not settle within 20 seconds');
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 2);
    const concurrentUsers = await ownerPrisma.user.findMany({
      where: { id: { in: [targetA, targetB] } },
      orderBy: { id: 'asc' },
      select: { id: true, username: true, pinHash: true },
    });
    assert.ok(concurrentUsers.every((user) => user.username), 'both targets receive a committed username');
    assert.equal(new Set(concurrentUsers.map((user) => user.username)).size, 2, 'same-name targets remain unique');
    assert.ok(
      observedTransactionErrors.some((value) =>
        value === 'UsernameReservationConflict' || value === 'P2034' || value === 'P2010'),
      `expected an internally controlled reservation/serialization retry, observed ${observedTransactionErrors.join(', ')}`,
    );

    const softReset = await auth.resetUserPinAsAdmin(
      softTarget,
      '6666',
      tenantId,
      actorA,
      actorSessionA,
    );
    assert.notEqual(softReset.username, 'legacy.crew');
    assert.match(softReset.username, /^legacy\.crew\./);
    const deletedAfter = await ownerPrisma.user.findUniqueOrThrow({ where: { id: deletedCollision } });
    assert.equal(deletedAfter.username, 'legacy.crew');
    assert.ok(deletedAfter.deletedAt);
  } finally {
    await cleanupFixture(ownerPrisma, [tenantId], userIds);
    await Promise.all([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('opposing cross-tenant platform role assignments use one global role lock order', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const capability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET?.trim();
  assert.ok(capability, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for platform role lock proof');
  const appPrismaA = createPrisma(appUrl);
  const appPrismaB = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantA = `tenant-role-lock-a-${runId}`;
  const tenantB = `tenant-role-lock-b-${runId}`;
  const actorA = `actor-role-lock-a-${runId}`;
  const actorB = `actor-role-lock-b-${runId}`;
  const targetA = `target-role-lock-a-${runId}`;
  const targetB = `target-role-lock-b-${runId}`;
  const actorSessionA = `session-role-lock-actor-a-${runId}`;
  const actorSessionB = `session-role-lock-actor-b-${runId}`;
  const targetSessionA = `session-role-lock-target-a-${runId}`;
  const targetSessionB = `session-role-lock-target-b-${runId}`;
  const roleIds = {
    superA: `role-10-super-a-${runId}`,
    staffA: `role-11-staff-a-${runId}`,
    superB: `role-20-super-b-${runId}`,
    staffB: `role-21-staff-b-${runId}`,
  };
  const roleLockBarrier = createTwoPartyBarrier();
  const roleLockQueries = { a: [], b: [] };
  const roleLockValues = { a: [], b: [] };
  const auditWrites = { a: [], b: [] };
  const flattenSqlValues = (value) => Array.isArray(value?.values)
    ? value.values.flatMap(flattenSqlValues)
    : [value];
  const roleLockHook = (side) => {
    let synchronized = false;
    return async (...args) => {
      const sql = rawQueryText(args[0]);
      if (sql.includes('FROM "Tenant"') && sql.includes('FOR UPDATE') && !synchronized) {
        synchronized = true;
        await within(
          roleLockBarrier(),
          5_000,
          `Timed out synchronizing platform mutation ${side}`,
        );
      }
      if (!sql.includes('FROM "Role"') || sql.includes('FROM "RolePermission"') || !sql.includes('FOR UPDATE')) {
        return;
      }
      roleLockQueries[side].push(sql);
      roleLockValues[side].push(args.slice(1).flatMap(flattenSqlValues));
    };
  };

  try {
    await ownerPrisma.tenant.createMany({
      data: [
        { id: tenantA, name: 'Role Lock Tenant A', slug: `role-lock-a-${runId}`, status: 'ACTIVE' },
        { id: tenantB, name: 'Role Lock Tenant B', slug: `role-lock-b-${runId}`, status: 'ACTIVE' },
      ],
    });
    await ownerPrisma.user.createMany({
      data: [
        { id: actorA, tenantId: tenantA, name: 'Platform Actor A', role: 'SUPER_ADMIN' },
        { id: targetA, tenantId: tenantA, name: 'Cross Tenant Target A', role: 'STAFF' },
        { id: actorB, tenantId: tenantB, name: 'Platform Actor B', role: 'SUPER_ADMIN' },
        { id: targetB, tenantId: tenantB, name: 'Cross Tenant Target B', role: 'STAFF' },
      ],
    });
    for (const key of ['admin_portal:access', 'dashboard:access']) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable platform role lock permission',
          category: key === 'admin_portal:access' ? 'ADMIN' : 'AUTH',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: ['admin_portal:access', 'dashboard:access'] } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.superA,
          tenantId: tenantA,
          name: `System Admin A ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.staffA,
          tenantId: tenantA,
          name: `Staff A ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
        {
          id: roleIds.superB,
          tenantId: tenantB,
          name: `System Admin B ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.staffB,
          tenantId: tenantB,
          name: `Staff B ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        { roleId: roleIds.superA, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.superA, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.staffA, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.superB, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.superB, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.staffB, permissionId: permissionId.get('dashboard:access') },
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId: tenantA, userId: actorA, roleId: roleIds.superA },
        { tenantId: tenantA, userId: targetA, roleId: roleIds.staffA },
        { tenantId: tenantB, userId: actorB, roleId: roleIds.superB },
        { tenantId: tenantB, userId: targetB, roleId: roleIds.staffB },
      ],
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await ownerPrisma.session.createMany({
      data: [
        {
          id: actorSessionA,
          userId: actorA,
          selectorHash: `selector-role-lock-actor-a-${runId}`,
          refreshToken: `refresh-role-lock-actor-a-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'platform-role-lock-proof',
          expiresAt,
        },
        {
          id: actorSessionB,
          userId: actorB,
          selectorHash: `selector-role-lock-actor-b-${runId}`,
          refreshToken: `refresh-role-lock-actor-b-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'platform-role-lock-proof',
          expiresAt,
        },
        {
          id: targetSessionA,
          userId: targetA,
          selectorHash: `selector-role-lock-target-a-${runId}`,
          refreshToken: `refresh-role-lock-target-a-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'platform-role-lock-proof',
          expiresAt,
        },
        {
          id: targetSessionB,
          userId: targetB,
          selectorHash: `selector-role-lock-target-b-${runId}`,
          refreshToken: `refresh-role-lock-target-b-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'platform-role-lock-proof',
          expiresAt,
        },
      ],
    });

    const tenantDbA = platformBoundaryTenantDb(
      new TenantPrismaService(appPrismaA),
      async ({ data }) => {
        auditWrites.a.push(data);
        return { id: randomUUID(), ...data };
      },
      roleLockHook('a'),
    );
    const tenantDbB = platformBoundaryTenantDb(
      new TenantPrismaService(appPrismaB),
      async ({ data }) => {
        auditWrites.b.push(data);
        return { id: randomUUID(), ...data };
      },
      roleLockHook('b'),
    );
    const controllerA = Object.create(AdminController.prototype);
    controllerA.tenantDb = tenantDbA;
    controllerA.prisma = tenantDbA.client;
    controllerA.rbac = new RbacService(tenantDbA);
    const controllerB = Object.create(AdminController.prototype);
    controllerB.tenantDb = tenantDbB;
    controllerB.prisma = tenantDbB.client;
    controllerB.rbac = new RbacService(tenantDbB);
    const requestFor = (userId, tenantId, sessionId) => ({
      ip: '203.0.113.92',
      headers: { 'user-agent': 'platform-role-lock-proof' },
      user: {
        tenantId,
        role: 'SUPER_ADMIN',
        permissions: ['admin_portal:access'],
        sub: userId,
        sessionId,
      },
    });

    const results = await within(
      Promise.allSettled([
        controllerA.updateUser(
          requestFor(actorA, tenantA, actorSessionA),
          targetB,
          { role: 'SUPER_ADMIN' },
        ),
        controllerB.updateUser(
          requestFor(actorB, tenantB, actorSessionB),
          targetA,
          { role: 'SUPER_ADMIN' },
        ),
      ]),
      15_000,
      'Opposing platform role assignments did not complete within 15 seconds',
    );
    const transactionCode = (error) => error?.meta?.code ?? error?.code ?? error?.response?.statusCode ?? 'unknown';
    assert.equal(
      results.some((result) => result.status === 'rejected'
        && ['40P01', 'P2034'].includes(transactionCode(result.reason))),
      false,
      'opposing assignments expose no PostgreSQL deadlock or Prisma write-conflict code',
    );
    for (const [index, result] of results.entries()) {
      assert.equal(
        result.status,
        'fulfilled',
        `platform role assignment ${index + 1} failed with ${result.status === 'rejected' ? transactionCode(result.reason) : 'unknown'}`,
      );
    }
    assert.ok(roleLockQueries.a.length >= 1 && roleLockQueries.a.length <= 2);
    assert.ok(roleLockQueries.b.length >= 1 && roleLockQueries.b.length <= 2);
    assert.equal(roleLockQueries.a.every((sql) => sql.includes('ORDER BY "id"')), true);
    assert.equal(roleLockQueries.b.every((sql) => sql.includes('ORDER BY "id"')), true);
    for (const values of roleLockValues.a) {
      assert.deepEqual(values, [roleIds.superA, roleIds.superB, roleIds.staffB]);
    }
    for (const values of roleLockValues.b) {
      assert.deepEqual(values, [roleIds.superA, roleIds.staffA, roleIds.superB]);
    }

    const targets = await ownerPrisma.user.findMany({
      where: { id: { in: [targetA, targetB] } },
      select: { id: true, role: true },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(targets.map((target) => target.role), ['SUPER_ADMIN', 'SUPER_ADMIN']);
    const targetAssignments = await ownerPrisma.roleAssignment.findMany({
      where: { userId: { in: [targetA, targetB] } },
      select: { userId: true, roleId: true },
      orderBy: { userId: 'asc' },
    });
    assert.deepEqual(new Map(targetAssignments.map((assignment) => [assignment.userId, assignment.roleId])), new Map([
      [targetA, roleIds.superA],
      [targetB, roleIds.superB],
    ]));
    const targetSessions = await ownerPrisma.session.findMany({
      where: { id: { in: [targetSessionA, targetSessionB] } },
      select: { id: true, revokedAt: true },
      orderBy: { id: 'asc' },
    });
    assert.equal(targetSessions.every((session) => session.revokedAt instanceof Date), true);
    assert.deepEqual([auditWrites.a.length, auditWrites.b.length], [1, 1]);
  } finally {
    await cleanupFixture(ownerPrisma, [tenantA, tenantB], [actorA, actorB, targetA, targetB]);
    await Promise.all([appPrismaA.$disconnect(), appPrismaB.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('platform and tenant role replacements lock Tenant before User without a transaction cycle', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const capability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET?.trim();
  assert.ok(capability, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for mixed role lock proof');
  const platformPrisma = createPrisma(appUrl);
  const tenantPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const platformTenantId = `tenant-mixed-platform-${runId}`;
  const targetTenantId = `tenant-mixed-target-${runId}`;
  const platformActorId = `actor-mixed-platform-${runId}`;
  const tenantActorId = `actor-mixed-tenant-${runId}`;
  const tenantTargetId = `target-mixed-tenant-${runId}`;
  const platformSessionId = `session-mixed-platform-${runId}`;
  const tenantActorSessionId = `session-mixed-actor-${runId}`;
  const tenantTargetSessionId = `session-mixed-target-${runId}`;
  const roleIds = {
    platformSuper: `role-10-mixed-platform-super-${runId}`,
    tenantSuper: `role-20-mixed-tenant-super-${runId}`,
    tenantAdmin: `role-21-mixed-tenant-admin-${runId}`,
    tenantManager: `role-22-mixed-tenant-manager-${runId}`,
    tenantStaff: `role-23-mixed-tenant-staff-${runId}`,
  };
  const tenantLockBarrier = createTwoPartyBarrier();
  const queryOrder = { platform: [], tenant: [] };
  const auditWrites = { platform: [], tenant: [] };
  const lockHook = (side) => {
    let synchronized = false;
    return async (...args) => {
      const sql = rawQueryText(args[0]);
      if (sql.includes('FROM "Tenant"') && sql.includes('FOR UPDATE')) {
        queryOrder[side].push('Tenant');
        if (!synchronized) {
          synchronized = true;
          await within(
            tenantLockBarrier(),
            5_000,
            `Timed out synchronizing mixed role mutation ${side}`,
          );
        }
      } else if (sql.includes('FROM "User"') && sql.includes('FOR UPDATE')) {
        queryOrder[side].push('User');
      }
    };
  };

  try {
    await ownerPrisma.tenant.createMany({
      data: [
        {
          id: platformTenantId,
          name: 'Mixed Platform Tenant',
          slug: `mixed-platform-${runId}`,
          status: 'ACTIVE',
        },
        {
          id: targetTenantId,
          name: 'Mixed Target Tenant',
          slug: `mixed-target-${runId}`,
          status: 'ACTIVE',
        },
      ],
    });
    await ownerPrisma.user.createMany({
      data: [
        {
          id: platformActorId,
          tenantId: platformTenantId,
          name: 'Mixed Platform Actor',
          role: 'SUPER_ADMIN',
        },
        {
          id: tenantActorId,
          tenantId: targetTenantId,
          name: 'Mixed Tenant Actor',
          role: 'ADMIN',
        },
        {
          id: tenantTargetId,
          tenantId: targetTenantId,
          name: 'Mixed Tenant Target',
          role: 'STAFF',
        },
      ],
    });
    for (const key of ['admin_portal:access', 'dashboard:access', 'roles:assign']) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable mixed role lock permission',
          category: key === 'dashboard:access' ? 'AUTH' : 'ADMIN',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: ['admin_portal:access', 'dashboard:access', 'roles:assign'] } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.platformSuper,
          tenantId: platformTenantId,
          name: `Mixed Platform Super ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.tenantSuper,
          tenantId: targetTenantId,
          name: `Mixed Tenant Super ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.tenantAdmin,
          tenantId: targetTenantId,
          name: `Mixed Tenant Admin ${runId}`,
          slug: 'admin',
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.tenantManager,
          tenantId: targetTenantId,
          name: `Mixed Tenant Manager ${runId}`,
          slug: 'manager',
          isSystem: true,
          legacyRole: 'MANAGER',
        },
        {
          id: roleIds.tenantStaff,
          tenantId: targetTenantId,
          name: `Mixed Tenant Staff ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        { roleId: roleIds.platformSuper, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.platformSuper, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.tenantSuper, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.tenantSuper, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.tenantSuper, permissionId: permissionId.get('roles:assign') },
        { roleId: roleIds.tenantAdmin, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.tenantAdmin, permissionId: permissionId.get('roles:assign') },
        { roleId: roleIds.tenantManager, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.tenantStaff, permissionId: permissionId.get('dashboard:access') },
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId: platformTenantId, userId: platformActorId, roleId: roleIds.platformSuper },
        { tenantId: targetTenantId, userId: tenantActorId, roleId: roleIds.tenantAdmin },
        { tenantId: targetTenantId, userId: tenantTargetId, roleId: roleIds.tenantStaff },
      ],
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await ownerPrisma.session.createMany({
      data: [
        {
          id: platformSessionId,
          userId: platformActorId,
          selectorHash: `selector-mixed-platform-${runId}`,
          refreshToken: `refresh-mixed-platform-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'mixed-role-lock-proof',
          expiresAt,
        },
        {
          id: tenantActorSessionId,
          userId: tenantActorId,
          selectorHash: `selector-mixed-actor-${runId}`,
          refreshToken: `refresh-mixed-actor-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'mixed-role-lock-proof',
          expiresAt,
        },
        {
          id: tenantTargetSessionId,
          userId: tenantTargetId,
          selectorHash: `selector-mixed-target-${runId}`,
          refreshToken: `refresh-mixed-target-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'mixed-role-lock-proof',
          expiresAt,
        },
      ],
    });

    const platformTenantDb = platformBoundaryTenantDb(
      new TenantPrismaService(platformPrisma),
      async ({ data }) => {
        auditWrites.platform.push(data);
        return { id: randomUUID(), ...data };
      },
      lockHook('platform'),
    );
    const tenantTenantDb = platformBoundaryTenantDb(
      new TenantPrismaService(tenantPrisma),
      async ({ data }) => {
        auditWrites.tenant.push(data);
        return { id: randomUUID(), ...data };
      },
      lockHook('tenant'),
    );
    const platformController = Object.create(AdminController.prototype);
    platformController.tenantDb = platformTenantDb;
    platformController.prisma = platformTenantDb.client;
    platformController.rbac = new RbacService(platformTenantDb);
    const tenantRbac = new RbacService(tenantTenantDb);
    const platformRequest = {
      ip: '203.0.113.93',
      headers: { 'user-agent': 'mixed-role-lock-proof' },
      user: {
        tenantId: platformTenantId,
        role: 'SUPER_ADMIN',
        permissions: ['admin_portal:access'],
        sub: platformActorId,
        sessionId: platformSessionId,
      },
    };

    const results = await within(
      Promise.allSettled([
        platformController.updateUser(platformRequest, tenantActorId, { role: 'ADMIN' }),
        tenantRbac.replaceUserRolesAsActor(targetTenantId, {
          actorUserId: tenantActorId,
          actorSessionId: tenantActorSessionId,
          targetUserId: tenantTargetId,
          legacyRole: 'MANAGER',
          requiredPermission: 'roles:assign',
          selfMutationMessage: 'Administrators cannot change their own role',
          auditAction: 'USER_ACCESS_UPDATED',
        }),
      ]),
      20_000,
      'Platform-vs-tenant role replacements did not complete within 20 seconds',
    );
    const transactionCode = (error) => error?.meta?.code ?? error?.code ?? error?.response?.statusCode ?? 'unknown';
    assert.equal(
      results.some((result) => result.status === 'rejected'
        && ['40P01', 'P2034'].includes(transactionCode(result.reason))),
      false,
      'mixed role replacements expose no PostgreSQL deadlock or Prisma write-conflict code',
    );
    for (const [index, result] of results.entries()) {
      assert.equal(
        result.status,
        'fulfilled',
        `mixed role replacement ${index + 1} failed with ${result.status === 'rejected' ? transactionCode(result.reason) : 'unknown'}`,
      );
    }
    for (const side of ['platform', 'tenant']) {
      assert.ok(queryOrder[side].includes('Tenant'), `${side} mutation locks Tenant`);
      assert.ok(queryOrder[side].includes('User'), `${side} mutation locks User`);
      assert.ok(
        queryOrder[side].indexOf('Tenant') < queryOrder[side].indexOf('User'),
        `${side} mutation locks Tenant before User`,
      );
    }

    const users = await ownerPrisma.user.findMany({
      where: { id: { in: [tenantActorId, tenantTargetId] } },
      select: { id: true, role: true },
    });
    assert.deepEqual(new Map(users.map((user) => [user.id, user.role])), new Map([
      [tenantActorId, 'ADMIN'],
      [tenantTargetId, 'MANAGER'],
    ]));
    const assignments = await ownerPrisma.roleAssignment.findMany({
      where: { userId: { in: [tenantActorId, tenantTargetId] } },
      select: { userId: true, roleId: true },
    });
    assert.deepEqual(new Map(assignments.map((assignment) => [assignment.userId, assignment.roleId])), new Map([
      [tenantActorId, roleIds.tenantAdmin],
      [tenantTargetId, roleIds.tenantManager],
    ]));
    const sessions = await ownerPrisma.session.findMany({
      where: { id: { in: [tenantActorSessionId, tenantTargetSessionId] } },
      select: { id: true, revokedAt: true },
    });
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    assert.equal(sessionById.get(tenantActorSessionId)?.revokedAt, null);
    assert.ok(sessionById.get(tenantTargetSessionId)?.revokedAt instanceof Date);
    assert.deepEqual([auditWrites.platform.length, auditWrites.tenant.length], [1, 1]);
  } finally {
    await cleanupFixture(
      ownerPrisma,
      [platformTenantId, targetTenantId],
      [platformActorId, tenantActorId, tenantTargetId],
    );
    await Promise.all([platformPrisma.$disconnect(), tenantPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('platform role, profile, lock, tenant suspension, and MFA mutations reauthorize live actors', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const capability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET?.trim();
  assert.ok(capability, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for platform authorization proof');
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const usernameSuffix = runId.replaceAll('-', '').slice(0, 12);
  const actorTenantId = `tenant-platform-actor-${runId}`;
  const targetTenantId = `tenant-platform-target-${runId}`;
  const actorUserId = `actor-platform-admin-${runId}`;
  const targetUserId = `target-platform-admin-${runId}`;
  const actorSessionId = `session-platform-admin-${runId}`;
  const targetSessionId = `session-platform-target-${runId}`;
  const lockSessionId = `session-platform-lock-${runId}`;
  const tenantSuspendSessionId = `session-platform-tenant-suspend-${runId}`;
  const replacementSessionId = `session-platform-replacement-${runId}`;
  const delegatedSessionId = `session-platform-delegated-${runId}`;
  const roleIds = {
    actorSuper: `role-platform-actor-super-${runId}`,
    actorDelegated: `role-platform-actor-delegated-${runId}`,
    actorStaff: `role-platform-actor-staff-${runId}`,
    targetStaff: `role-platform-target-staff-${runId}`,
    targetAdmin: `role-platform-target-admin-${runId}`,
    targetSuper: `role-platform-target-super-${runId}`,
  };
  const auditWrites = [];
  const auditCreate = async ({ data }) => {
    auditWrites.push(data);
    return { id: randomUUID(), ...data };
  };
  const mutationTenantDb = new TenantPrismaService(mutationPrisma);
  let demotionGate;
  let sessionGate;

  try {
    await ownerPrisma.tenant.createMany({
      data: [
        { id: actorTenantId, name: 'Platform Actor Tenant', slug: `platform-actor-${runId}`, status: 'ACTIVE' },
        { id: targetTenantId, name: 'Platform Target Tenant', slug: `platform-target-${runId}`, status: 'ACTIVE' },
      ],
    });
    await ownerPrisma.user.createMany({
      data: [
        { id: actorUserId, tenantId: actorTenantId, name: 'Platform Actor', role: 'SUPER_ADMIN' },
        {
          id: targetUserId,
          tenantId: targetTenantId,
          name: 'Platform Recovery Target',
          email: `platform-target-${runId}@example.com`,
          username: `platform.${usernameSuffix}`,
          role: 'STAFF',
          pinResetRequired: false,
          mfaEnabled: true,
          mfaSecret: 'integration-mfa-secret',
          mfaBackupCodes: ['integration-backup-code'],
        },
      ],
    });
    for (const key of ['admin_portal:access', 'dashboard:access']) {
      await ownerPrisma.permission.upsert({
        where: { key },
        update: {},
        create: {
          key,
          label: `Integration ${key}`,
          description: 'Disposable platform authorization permission',
          category: key === 'admin_portal:access' ? 'ADMIN' : 'AUTH',
        },
      });
    }
    const permissions = await ownerPrisma.permission.findMany({
      where: { key: { in: ['admin_portal:access', 'dashboard:access'] } },
      select: { id: true, key: true },
    });
    const permissionId = new Map(permissions.map((permission) => [permission.key, permission.id]));
    await ownerPrisma.role.createMany({
      data: [
        {
          id: roleIds.actorSuper,
          tenantId: actorTenantId,
          name: `Platform System Admin ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
        {
          id: roleIds.actorDelegated,
          tenantId: actorTenantId,
          name: `Delegated Platform Admin ${runId}`,
          slug: `delegated-platform-${runId}`,
          isSystem: false,
          legacyRole: null,
        },
        {
          id: roleIds.actorStaff,
          tenantId: actorTenantId,
          name: `Platform Staff ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
        {
          id: roleIds.targetStaff,
          tenantId: targetTenantId,
          name: `Target Staff ${runId}`,
          slug: 'staff',
          isSystem: true,
          legacyRole: 'STAFF',
        },
        {
          id: roleIds.targetAdmin,
          tenantId: targetTenantId,
          name: `Target Admin ${runId}`,
          slug: 'admin',
          isSystem: true,
          legacyRole: 'ADMIN',
        },
        {
          id: roleIds.targetSuper,
          tenantId: targetTenantId,
          name: `Target System Admin ${runId}`,
          slug: 'super-admin',
          isSystem: true,
          legacyRole: 'SUPER_ADMIN',
        },
      ],
    });
    await ownerPrisma.rolePermission.createMany({
      data: [
        { roleId: roleIds.actorSuper, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.actorSuper, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.actorDelegated, permissionId: permissionId.get('admin_portal:access') },
        { roleId: roleIds.actorStaff, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.targetStaff, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.targetAdmin, permissionId: permissionId.get('dashboard:access') },
        { roleId: roleIds.targetSuper, permissionId: permissionId.get('admin_portal:access') },
      ],
    });
    await ownerPrisma.roleAssignment.createMany({
      data: [
        { tenantId: actorTenantId, userId: actorUserId, roleId: roleIds.actorSuper },
        { tenantId: targetTenantId, userId: targetUserId, roleId: roleIds.targetStaff },
      ],
    });
    await ownerPrisma.session.createMany({
      data: [
        {
          id: actorSessionId,
          userId: actorUserId,
          selectorHash: `selector-platform-admin-${runId}`,
          refreshToken: `refresh-platform-admin-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'platform-authorization-proof',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        {
          id: targetSessionId,
          userId: targetUserId,
          selectorHash: `selector-platform-target-${runId}`,
          refreshToken: `refresh-platform-target-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'platform-profile-rollback-proof',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });

    const appTenantDb = platformBoundaryTenantDb(new TenantPrismaService(appPrisma), auditCreate);
    const rbac = new RbacService(appTenantDb);
    const guardEraAccess = await rbac.getEffectiveAccess(actorUserId, actorTenantId);
    assert.ok(guardEraAccess.permissions.includes('admin_portal:access'));
    const controller = Object.create(AdminController.prototype);
    controller.tenantDb = appTenantDb;
    controller.prisma = appTenantDb.client;
    controller.rbac = rbac;
    const platformRequest = {
      ip: '203.0.113.90',
      headers: { 'user-agent': 'platform-profile-rollback-proof' },
      user: {
        tenantId: actorTenantId,
        role: 'SUPER_ADMIN',
        permissions: ['admin_portal:access'],
        sub: actorUserId,
        sessionId: actorSessionId,
      },
    };

    demotionGate = createTransactionGate();
    const demotion = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.user.update({ where: { id: actorUserId }, data: { role: 'STAFF' } });
      await tx.roleAssignment.deleteMany({ where: { tenantId: actorTenantId, userId: actorUserId } });
      await tx.roleAssignment.create({
        data: { tenantId: actorTenantId, userId: actorUserId, roleId: roleIds.actorStaff },
      });
      await demotionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await demotionGate.entered;

    let escalationState = 'pending';
    const escalation = appTenantDb.withPlatformAdmin((tx) => (
      rbac.replaceLegacySystemRoleForPlatformAdminActorInTransaction(
        tx,
        targetUserId,
        targetTenantId,
        'ADMIN',
        { userId: actorUserId, tenantId: actorTenantId, sessionId: actorSessionId },
      )
    )).then(
      (value) => { escalationState = 'fulfilled'; return value; },
      (error) => { escalationState = 'rejected'; throw error; },
    );
    let profileUpdateState = 'pending';
    const profileUpdate = controller.updateUser(platformRequest, targetUserId, {
      name: 'Unauthorized Concurrent Update',
      email: `mutated-platform-target-${runId}@example.com`,
      username: `mutated.${usernameSuffix}`,
      pinResetRequired: true,
    }).then(
      (value) => { profileUpdateState = 'fulfilled'; return value; },
      (error) => { profileUpdateState = 'rejected'; throw error; },
    );
    await delay(250);
    assert.equal(escalationState, 'pending', 'role escalation waits for the actor account lock');
    assert.equal(profileUpdateState, 'pending', 'profile update waits for live actor authorization');
    demotionGate.release();
    await demotion;
    await assert.rejects(escalation, /authority is no longer active/);
    await assert.rejects(
      profileUpdate,
      /authority is no longer active|Authorization or access state changed concurrently/,
    );
    const targetAfterDeniedUpdate = await ownerPrisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    assert.equal(targetAfterDeniedUpdate.role, 'STAFF');
    assert.equal(targetAfterDeniedUpdate.name, 'Platform Recovery Target');
    assert.equal(targetAfterDeniedUpdate.email, `platform-target-${runId}@example.com`);
    assert.equal(targetAfterDeniedUpdate.username, `platform.${usernameSuffix}`);
    assert.equal(targetAfterDeniedUpdate.pinResetRequired, false);
    assert.equal(
      (await ownerPrisma.session.findUniqueOrThrow({ where: { id: targetSessionId } })).revokedAt,
      null,
      'denied profile update leaves the target session active',
    );
    assert.equal(auditWrites.length, 0, 'denied role and profile mutations create no audit record');
    assert.deepEqual(
      await ownerPrisma.roleAssignment.findMany({
        where: { tenantId: targetTenantId, userId: targetUserId },
        select: { roleId: true },
      }),
      [{ roleId: roleIds.targetStaff }],
    );

    await mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.user.update({ where: { id: actorUserId }, data: { role: 'SUPER_ADMIN' } });
      await tx.roleAssignment.deleteMany({ where: { tenantId: actorTenantId, userId: actorUserId } });
      await tx.roleAssignment.create({
        data: { tenantId: actorTenantId, userId: actorUserId, roleId: roleIds.actorSuper },
      });
    });
    await ownerPrisma.session.create({
      data: {
        id: lockSessionId,
        userId: actorUserId,
        selectorHash: `selector-platform-lock-${runId}`,
        refreshToken: `refresh-platform-lock-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'platform-lock-proof',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const lockRequest = {
      ...platformRequest,
      user: { ...platformRequest.user, sessionId: lockSessionId },
    };
    let lockSessionGate = createTransactionGate();
    const lockSessionRevocation = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${lockSessionId} FOR UPDATE`;
      await tx.session.update({ where: { id: lockSessionId }, data: { revokedAt: new Date() } });
      await lockSessionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await lockSessionGate.entered;
    let lockState = 'pending';
    const lockAttempt = controller.lockUser(lockRequest, targetUserId, { minutes: 30 }).then(
      (value) => { lockState = 'fulfilled'; return value; },
      (error) => { lockState = 'rejected'; throw error; },
    );
    await delay(200);
    assert.equal(lockState, 'pending', 'user lock waits for the exact actor session lock');
    lockSessionGate.release();
    await lockSessionRevocation;
    await assert.rejects(
      lockAttempt,
      /session is no longer active|Authorization or access state changed concurrently/,
    );
    const targetAfterDeniedLock = await ownerPrisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: { lockedUntil: true, pinLockedUntil: true },
    });
    assert.equal(targetAfterDeniedLock.lockedUntil, null);
    assert.equal(targetAfterDeniedLock.pinLockedUntil, null);
    assert.equal(
      (await ownerPrisma.session.findUniqueOrThrow({ where: { id: targetSessionId } })).revokedAt,
      null,
      'denied user lock leaves the target session active',
    );
    assert.equal(auditWrites.length, 0, 'denied user lock creates no audit record');

    await ownerPrisma.session.create({
      data: {
        id: tenantSuspendSessionId,
        userId: actorUserId,
        selectorHash: `selector-platform-tenant-suspend-${runId}`,
        refreshToken: `refresh-platform-tenant-suspend-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'platform-tenant-suspend-proof',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const tenantSuspendRequest = {
      ...platformRequest,
      user: { ...platformRequest.user, sessionId: tenantSuspendSessionId },
    };
    const actorSuspensionGate = createTransactionGate();
    const actorSuspension = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.user.update({ where: { id: actorUserId }, data: { suspendedAt: new Date() } });
      await actorSuspensionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await actorSuspensionGate.entered;
    let tenantSuspendState = 'pending';
    const tenantSuspendAttempt = controller.suspendTenant(tenantSuspendRequest, targetTenantId).then(
      (value) => { tenantSuspendState = 'fulfilled'; return value; },
      (error) => { tenantSuspendState = 'rejected'; throw error; },
    );
    await delay(200);
    assert.equal(tenantSuspendState, 'pending', 'tenant suspension waits for the live actor account lock');
    actorSuspensionGate.release();
    await actorSuspension;
    await assert.rejects(
      tenantSuspendAttempt,
      /account is suspended|session is no longer active|Authorization or access state changed concurrently/,
    );
    assert.equal(
      (await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: targetTenantId } })).status,
      'ACTIVE',
    );
    assert.equal(
      (await ownerPrisma.session.findUniqueOrThrow({ where: { id: targetSessionId } })).revokedAt,
      null,
      'denied tenant suspension leaves target-tenant sessions active',
    );
    assert.equal(auditWrites.length, 0, 'denied tenant suspension creates no audit record');
    await ownerPrisma.user.update({ where: { id: actorUserId }, data: { suspendedAt: null } });

    await ownerPrisma.session.create({
      data: {
        id: replacementSessionId,
        userId: actorUserId,
        selectorHash: `selector-platform-replacement-${runId}`,
        refreshToken: `refresh-platform-replacement-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'platform-mfa-recovery-proof',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    sessionGate = createTransactionGate();
    const revocation = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${replacementSessionId} FOR UPDATE`;
      await tx.session.update({ where: { id: replacementSessionId }, data: { revokedAt: new Date() } });
      await sessionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await sessionGate.entered;

    const recovery = new AdminUserMfaRecoveryService(appTenantDb, rbac);
    let recoveryState = 'pending';
    const recoveryAttempt = recovery.reset({
      targetUserId,
      confirmation: `reset-mfa:${targetUserId}`,
      reason: 'Lost authenticator and all registered recovery codes',
      actorUserId,
      actorTenantId,
      actorSessionId: replacementSessionId,
      ipAddress: '203.0.113.90',
      userAgent: 'platform-mfa-recovery-proof',
    }).then(
      (value) => { recoveryState = 'fulfilled'; return value; },
      (error) => { recoveryState = 'rejected'; throw error; },
    );
    await delay(250);
    assert.equal(recoveryState, 'pending', 'MFA recovery waits for the exact actor session lock');
    sessionGate.release();
    await revocation;
    await assert.rejects(
      recoveryAttempt,
      /session is no longer active|Authorization or MFA state changed concurrently/,
    );
    const targetAfter = await ownerPrisma.user.findUniqueOrThrow({ where: { id: targetUserId } });
    assert.equal(targetAfter.mfaEnabled, true);
    assert.equal(targetAfter.mfaSecret, 'integration-mfa-secret');
    assert.deepEqual(targetAfter.mfaBackupCodes, ['integration-backup-code']);
    assert.equal(auditWrites.length, 0, 'denied role and MFA mutations create no audit record');

    await mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.roleAssignment.deleteMany({ where: { tenantId: actorTenantId, userId: actorUserId } });
      await tx.roleAssignment.create({
        data: { tenantId: actorTenantId, userId: actorUserId, roleId: roleIds.actorDelegated },
      });
    });
    await ownerPrisma.session.create({
      data: {
        id: delegatedSessionId,
        userId: actorUserId,
        selectorHash: `selector-platform-delegated-${runId}`,
        refreshToken: `refresh-platform-delegated-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'platform-system-admin-target-proof',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const delegatedRequest = {
      ...platformRequest,
      user: { ...platformRequest.user, sessionId: delegatedSessionId },
    };
    const targetPromotionGate = createTransactionGate();
    const targetPromotion = mutationTenantDb.withPlatformAdmin(async (tx) => {
      await tx.user.update({ where: { id: targetUserId }, data: { role: 'SUPER_ADMIN' } });
      await tx.roleAssignment.deleteMany({ where: { tenantId: targetTenantId, userId: targetUserId } });
      await tx.roleAssignment.create({
        data: { tenantId: targetTenantId, userId: targetUserId, roleId: roleIds.targetSuper },
      });
      await targetPromotionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await targetPromotionGate.entered;
    let targetDenialState = 'pending';
    const targetDenial = controller.updateUser(delegatedRequest, targetUserId, {
      name: 'Forbidden System Admin Mutation',
      pinResetRequired: true,
    }).then(
      (value) => { targetDenialState = 'fulfilled'; return value; },
      (error) => { targetDenialState = 'rejected'; throw error; },
    );
    await delay(200);
    assert.equal(targetDenialState, 'pending', 'target mutation waits for the target system-admin promotion lock');
    targetPromotionGate.release();
    await targetPromotion;
    await assert.rejects(targetDenial, /Only system admins can administer system admins/);

    const systemAdminSnapshot = async () => {
      const [user, sessions, assignments] = await Promise.all([
        ownerPrisma.user.findUniqueOrThrow({
          where: { id: targetUserId },
          select: {
            name: true,
            email: true,
            username: true,
            role: true,
            pinResetRequired: true,
            mfaEnabled: true,
            mfaSecret: true,
            mfaBackupCodes: true,
            suspendedAt: true,
            lockedUntil: true,
            pinLockedUntil: true,
          },
        }),
        ownerPrisma.session.findMany({
          where: { userId: targetUserId },
          orderBy: { id: 'asc' },
          select: { id: true, revokedAt: true },
        }),
        ownerPrisma.roleAssignment.findMany({
          where: { tenantId: targetTenantId, userId: targetUserId },
          select: { roleId: true },
        }),
      ]);
      return {
        ...user,
        suspendedAt: user.suspendedAt?.toISOString() ?? null,
        lockedUntil: user.lockedUntil?.toISOString() ?? null,
        pinLockedUntil: user.pinLockedUntil?.toISOString() ?? null,
        sessions: sessions.map((session) => ({
          id: session.id,
          revokedAt: session.revokedAt?.toISOString() ?? null,
        })),
        assignments,
      };
    };
    const deniedTargetBefore = await systemAdminSnapshot();
    const deniedAuditCount = auditWrites.length;
    const delegatedLifecycle = new AdminUserLifecycleService(appTenantDb, rbac);
    const delegatedRecovery = new AdminUserMfaRecoveryService(appTenantDb, rbac);
    await assert.rejects(
      controller.lockUser(delegatedRequest, targetUserId, { minutes: 30 }),
      /Only system admins can administer system admins/,
    );
    await assert.rejects(
      delegatedLifecycle.suspend(targetUserId, {
        userId: actorUserId,
        tenantId: actorTenantId,
        sessionId: delegatedSessionId,
        ipAddress: '203.0.113.90',
        userAgent: 'platform-system-admin-target-proof',
      }),
      /Only system admins can administer system admins/,
    );
    await assert.rejects(
      delegatedRecovery.reset({
        targetUserId,
        confirmation: `reset-mfa:${targetUserId}`,
        reason: 'Lost authenticator and all registered recovery codes',
        actorUserId,
        actorTenantId,
        actorSessionId: delegatedSessionId,
        ipAddress: '203.0.113.90',
        userAgent: 'platform-system-admin-target-proof',
      }),
      /Only system admins can administer system admins/,
    );
    await assert.rejects(
      controller.updateUser(delegatedRequest, targetUserId, { role: 'STAFF' }),
      /Only system admins can administer system admins/,
    );
    assert.deepEqual(await systemAdminSnapshot(), deniedTargetBefore);
    assert.equal(auditWrites.length, deniedAuditCount, 'all denied target-system-admin paths create zero audits');
  } finally {
    demotionGate?.release();
    sessionGate?.release();
    await cleanupFixture(ownerPrisma, [actorTenantId, targetTenantId], [actorUserId, targetUserId]);
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('custom-role create and update persist one canonical attributed audit atomically', { timeout: 45_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const capability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET?.trim();
  assert.ok(capability, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for custom-role audit proof');
  const appPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-role-audit-${runId}`;
  const actorUserId = `actor-role-audit-${runId}`;
  const actorSessionId = `session-role-audit-${runId}`;
  const tenantDb = new TenantPrismaService(appPrisma);
  let moduleRef;

  try {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const rbac = moduleRef.get(RbacService);
    assert.ok(rbac instanceof RbacService, 'production AppModule resolves the canonical RbacService through Nest DI');
    await ownerPrisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Custom Role Audit Boundary',
        slug: `custom-role-audit-${runId}`,
        status: 'ACTIVE',
      },
    });
    await ownerPrisma.user.create({
      data: {
        id: actorUserId,
        tenantId,
        name: 'Role Audit System Admin',
        role: 'SUPER_ADMIN',
      },
    });
    await rbac.ensureTenantRoles(tenantId);
    const superRole = await ownerPrisma.role.findFirstOrThrow({
      where: { tenantId, isSystem: true, legacyRole: 'SUPER_ADMIN', deletedAt: null },
      select: { id: true },
    });
    await ownerPrisma.roleAssignment.create({
      data: { tenantId, userId: actorUserId, roleId: superRole.id },
    });
    await ownerPrisma.session.create({
      data: {
        id: actorSessionId,
        userId: actorUserId,
        selectorHash: `selector-role-audit-${runId}`,
        refreshToken: `refresh-role-audit-${runId}`,
        ipAddress: '127.0.0.1',
        userAgent: 'custom-role-audit-proof',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const staffRole = await ownerPrisma.role.findFirstOrThrow({
      where: { tenantId, isSystem: true, legacyRole: 'STAFF', deletedAt: null },
      select: { id: true, name: true },
    });
    const dashboardPermission = await ownerPrisma.permission.findUniqueOrThrow({
      where: { key: 'dashboard:access' },
      select: { id: true },
    });
    await ownerPrisma.role.update({ where: { id: staffRole.id }, data: { name: 'Drifted Staff' } });
    await ownerPrisma.rolePermission.deleteMany({
      where: { roleId: staffRole.id, permissionId: dashboardPermission.id },
    });
    await ownerPrisma.session.update({ where: { id: actorSessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(
      rbac.createRole(tenantId, {
        name: 'Denied Reconciliation Role',
        permissionKeys: ['dashboard:access'],
      }, { actorUserId, actorSessionId }),
      /session is no longer active/,
    );
    assert.equal((await ownerPrisma.role.findUniqueOrThrow({ where: { id: staffRole.id } })).name, 'Drifted Staff');
    assert.equal(await ownerPrisma.rolePermission.count({
      where: { roleId: staffRole.id, permissionId: dashboardPermission.id },
    }), 0, 'denied creation commits no system-role or permission reconciliation drift');
    assert.equal(await ownerPrisma.role.count({ where: { tenantId, name: 'Denied Reconciliation Role' } }), 0);
    await ownerPrisma.session.update({ where: { id: actorSessionId }, data: { revokedAt: null } });

    const created = await rbac.createRole(tenantId, {
      name: 'Integration Reader',
      description: 'Reads users and dashboards',
      permissionKeys: [' users:read ', 'DASHBOARD:ACCESS'],
    }, {
      actorUserId,
      actorSessionId,
      ipAddress: '203.0.113.111',
      userAgent: 'custom-role-audit-proof',
    });
    const createAudits = await ownerPrisma.auditLog.findMany({
      where: { tenantId, action: 'ACCESS_ROLE_CREATED', resourceId: created.id },
    });
    assert.equal(createAudits.length, 1);
    assert.equal(createAudits[0].actorUserId, actorUserId);
    assert.equal(createAudits[0].actorTenantId, tenantId);
    assert.equal(createAudits[0].ipAddress, '203.0.113.111');
    assert.equal(createAudits[0].userAgent, 'custom-role-audit-proof');
    assert.deepEqual(createAudits[0].oldValue, {
      name: null,
      description: null,
      permissions: [],
    });
    assert.deepEqual(createAudits[0].newValue, {
      name: 'Integration Reader',
      description: 'Reads users and dashboards',
      permissions: ['dashboard:access', 'users:read'],
    });

    await rbac.updateRole(tenantId, created.id, {
      name: 'Integration Dashboard Reader',
      description: 'Dashboard only',
      permissionKeys: [' DASHBOARD:ACCESS '],
    }, {
      actorUserId,
      actorSessionId,
      ipAddress: '203.0.113.112',
      userAgent: 'custom-role-update-proof',
    });
    const updateAudits = await ownerPrisma.auditLog.findMany({
      where: { tenantId, action: 'ACCESS_ROLE_UPDATED', resourceId: created.id },
    });
    assert.equal(updateAudits.length, 1);
    assert.equal(updateAudits[0].actorUserId, actorUserId);
    assert.equal(updateAudits[0].actorTenantId, tenantId);
    assert.deepEqual(updateAudits[0].oldValue, {
      name: 'Integration Reader',
      description: 'Reads users and dashboards',
      permissions: ['dashboard:access', 'users:read'],
    });
    assert.deepEqual(updateAudits[0].newValue, {
      name: 'Integration Dashboard Reader',
      description: 'Dashboard only',
      permissions: ['dashboard:access'],
    });

    await ownerPrisma.role.update({ where: { id: staffRole.id }, data: { name: 'Drifted Staff' } });
    await ownerPrisma.rolePermission.deleteMany({
      where: { roleId: staffRole.id, permissionId: dashboardPermission.id },
    });
    const auditFailureDb = proxiedTenantDb(tenantDb, {
      auditCreate: async () => { throw new Error('forced custom-role audit failure'); },
    });
    await assert.rejects(
      new RbacService(auditFailureDb).createRole(tenantId, {
        name: 'Rolled Back Role',
        permissionKeys: ['dashboard:access'],
      }, {
        actorUserId,
        actorSessionId,
      }),
      /forced custom-role audit failure/,
    );
    assert.equal(await ownerPrisma.role.count({ where: { tenantId, name: 'Rolled Back Role' } }), 0);
    assert.equal(await ownerPrisma.auditLog.count({
      where: { tenantId, action: 'ACCESS_ROLE_CREATED', newValue: { path: ['name'], equals: 'Rolled Back Role' } },
    }), 0);
    assert.equal((await ownerPrisma.role.findUniqueOrThrow({ where: { id: staffRole.id } })).name, 'Drifted Staff');
    assert.equal(await ownerPrisma.rolePermission.count({
      where: { roleId: staffRole.id, permissionId: dashboardPermission.id },
    }), 0, 'audit failure rolls system-role and permission reconciliation back with the custom role');

    let transactionSequence = 0;
    const retryDb = {
      client: tenantDb.client,
      withTenant(tenant, operation, options) {
        transactionSequence += 1;
        const currentSequence = transactionSequence;
        return tenantDb.withTenant(tenant, async (tx) => {
          const result = await operation(tx);
          if (currentSequence === 1) throw { code: 'P2034' };
          return result;
        }, options);
      },
    };
    const retried = await new RbacService(retryDb).createRole(tenantId, {
      name: 'Retried Role',
      permissionKeys: ['dashboard:access'],
    }, {
      actorUserId,
      actorSessionId,
      ipAddress: '203.0.113.113',
      userAgent: 'custom-role-retry-proof',
    });
    assert.equal(transactionSequence, 2, 'one bounded whole-role-transaction retry executes');
    assert.equal(await ownerPrisma.role.count({ where: { id: retried.id } }), 1);
    assert.equal(await ownerPrisma.auditLog.count({
      where: { tenantId, action: 'ACCESS_ROLE_CREATED', resourceId: retried.id },
    }), 1, 'the rolled-back first attempt leaves exactly one committed audit');
    assert.equal((await ownerPrisma.role.findUniqueOrThrow({ where: { id: staffRole.id } })).name, 'Staff');
    assert.equal(await ownerPrisma.rolePermission.count({
      where: { roleId: staffRole.id, permissionId: dashboardPermission.id },
    }), 1, 'the successful authorized and audited transaction commits system-role reconciliation');
  } finally {
    await cleanupTenantWithAudit(ownerPrisma, tenantId, capability, [actorUserId]);
    await moduleRef?.close();
    await Promise.all([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('tenant activation and restoration wait behind the canonical deletion barrier', { timeout: 60_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const capability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET?.trim();
  assert.ok(capability, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for tenant activation proof');
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const mutationTenantDb = new TenantPrismaService(mutationPrisma);
  const runId = randomUUID();

  try {
    for (const action of ['activateTenant', 'restoreTenant']) {
      const tenantId = `tenant-${action.toLowerCase()}-${runId}`;
      const gate = createTransactionGate();
      try {
        await ownerPrisma.tenant.create({
          data: { id: tenantId, name: `${action} Boundary`, slug: `${action.toLowerCase()}-${runId}`, status: 'ACTIVE' },
        });
        const controllerAuditWrites = [];
        const appTenantDb = platformBoundaryTenantDb(
          new TenantPrismaService(appPrisma),
          async ({ data }) => {
            controllerAuditWrites.push(data);
            return { id: randomUUID(), ...data };
          },
        );
        const controller = Object.create(AdminController.prototype);
        controller.tenantDb = appTenantDb;
        controller.prisma = appTenantDb.client;
        controller.stripeBilling = undefined;
        const deletionBarrier = mutationTenantDb.withPlatformAdmin(async (tx) => {
          await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${tenantId})`;
          await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
          await tx.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED', deletedAt: null } });
          await tx.auditLog.create({
            data: {
              tenantId,
              action: 'TENANT_DELETION_BARRIER_COMMITTED',
              resource: 'Tenant',
              resourceId: tenantId,
              newValue: { status: 'SUSPENDED' },
            },
          });
          await gate.holdAfterOperation();
        }, { timeout: 10_000 });
        await gate.entered;

        const request = {
          ip: '203.0.113.91',
          headers: { 'user-agent': 'tenant-activation-barrier-proof' },
          user: {
            tenantId: 'platform-tenant',
            permissions: ['admin_portal:access'],
            sub: 'platform-actor',
            sessionId: 'platform-session',
          },
        };
        let activationState = 'pending';
        const activation = controller[action](request, tenantId).then(
          (value) => { activationState = 'fulfilled'; return value; },
          (error) => { activationState = 'rejected'; throw error; },
        );
        await delay(250);
        assert.equal(activationState, 'pending', `${action} waits for the lifecycle advisory lock`);
        gate.release();
        await deletionBarrier;
        await assert.rejects(activation, /deletion is irreversible/);

        const tenant = await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        assert.equal(tenant.status, 'SUSPENDED');
        assert.equal(tenant.deletedAt, null);
        assert.equal(await ownerPrisma.auditLog.count({
          where: { tenantId, action: 'TENANT_DELETION_BARRIER_COMMITTED' },
        }), 1);
        assert.equal(controllerAuditWrites.length, 0, 'blocked activation writes no success audit');
      } finally {
        gate.release();
        await cleanupTenantWithAudit(ownerPrisma, tenantId, capability);
      }
    }
  } finally {
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('tenant suspension linearizes ahead of session issuance and later activation cannot revive the credential', { timeout: 45_000 }, async () => {
  const appUrl = requireServiceUrl('DATABASE_URL').toString();
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const appPrisma = createPrisma(appUrl);
  const mutationPrisma = createPrisma(appUrl);
  const ownerPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-session-suspension-${runId}`;
  const tenantSlug = `session-suspension-${runId}`;
  const userId = `user-session-suspension-${runId}`;
  const username = `session.${runId}`;
  const password = 'correct-horse-battery-staple';
  const credentialGate = createTransactionGate();
  const suspensionGate = createTransactionGate();
  let accessReads = 0;

  try {
    await ownerPrisma.tenant.create({
      data: { id: tenantId, name: 'Tenant Session Suspension', slug: tenantSlug, status: 'ACTIVE' },
    });
    await ownerPrisma.user.create({
      data: {
        id: userId,
        tenantId,
        name: 'Tenant Session User',
        username,
        role: 'STAFF',
        passwordHash: bcrypt.hashSync(password, 10),
      },
    });

    const appTenantDb = new TenantPrismaService(appPrisma);
    const mutationTenantDb = new TenantPrismaService(mutationPrisma);
    const auth = createAuthService(appTenantDb, {
      rbac: {
        getEffectiveAccess: async () => {
          accessReads += 1;
          if (accessReads === 1) await credentialGate.holdAfterOperation();
          return {
            primaryRole: 'Staff',
            roles: [{ id: 'fixture-staff', name: 'Staff', isSystem: true, legacyRole: 'STAFF' }],
            permissions: ['auth:login_password', 'dashboard:access'],
          };
        },
      },
    });
    auth.resolveLoginTenantContext = async () => ({ tenantId, tenantSlug });

    let loginState = 'pending';
    const login = auth.loginWithUsernamePassword(username, password, tenantSlug).then(
      (value) => { loginState = 'fulfilled'; return value; },
      (error) => { loginState = 'rejected'; throw error; },
    );
    await credentialGate.entered;

    const suspension = mutationTenantDb.withTenant(tenantId, async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
      await tx.session.updateMany({
        where: { user: { tenantId }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await suspensionGate.holdAfterOperation();
    }, { timeout: 10_000 });
    await suspensionGate.entered;

    credentialGate.release();
    await delay(250);
    assert.equal(loginState, 'pending', 'session issuance waits for the suspension-owned tenant row');
    suspensionGate.release();
    await suspension;
    await assert.rejects(login, /Invalid workspace or login/);
    assert.equal(await ownerPrisma.session.count({ where: { userId } }), 0);
    assert.equal((await ownerPrisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status, 'SUSPENDED');

    await ownerPrisma.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
    assert.equal(
      await ownerPrisma.session.count({ where: { userId, revokedAt: null } }),
      0,
      'later tenant activation does not revive the captured credential',
    );
  } finally {
    credentialGate.release();
    suspensionGate.release();
    await cleanupFixture(ownerPrisma, [tenantId], [userId]);
    await Promise.all([appPrisma.$disconnect(), mutationPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});
