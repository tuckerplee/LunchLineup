import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api-v2/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');
const { WorkspaceSettingsService } = require('../../apps/api-v2/src/settings/settings.service.ts');

function identity(tenantId, userId) {
  return {
    sub: userId,
    publicUserId: randomUUID(),
    tenantId,
    sessionId: `settings-session-${randomUUID()}`,
    role: 'ADMIN',
    legacyRole: 'ADMIN',
    roles: [],
    permissions: ['settings:read', 'settings:write'],
    mfaVerified: true,
    mfaRequired: false,
  };
}

async function boundedBarrier(promise, description, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('native API v2 workspace settings stay tenant-scoped, audit security changes, and reject unavailable SSO-only policy', { timeout: 30_000 }, async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `api-v2-settings-${runId}`,
    otherTenantId: `api-v2-settings-other-${runId}`,
    userId: `api-v2-settings-user-${runId}`,
    otherUserId: `api-v2-settings-other-user-${runId}`,
  };
  const settings = new WorkspaceSettingsService(new TenantDatabase(app), { oidcSsoAvailable: false });

  try {
    const [tenant, otherTenant] = await Promise.all([
      owner.tenant.create({ data: { id: fixture.tenantId, name: 'Settings Primary', slug: `settings-primary-${runId}`, status: 'ACTIVE' } }),
      owner.tenant.create({ data: { id: fixture.otherTenantId, name: 'Settings Isolated', slug: `settings-isolated-${runId}`, status: 'ACTIVE' } }),
    ]);
    const [user, otherUser] = await Promise.all([
      owner.user.create({ data: { id: fixture.userId, tenantId: tenant.id, name: 'Settings Admin', role: 'ADMIN', mfaBackupCodes: [] } }),
      owner.user.create({ data: { id: fixture.otherUserId, tenantId: otherTenant.id, name: 'Settings Other Admin', role: 'ADMIN', mfaBackupCodes: [] } }),
    ]);
    const primaryIdentity = identity(tenant.id, user.id);
    const isolatedIdentity = identity(otherTenant.id, otherUser.id);

    const defaults = await settings.get(primaryIdentity);
    assert.equal(defaults.general.name, 'Settings Primary');
    assert.equal(defaults.general.timezone, 'America/New_York');

    const general = await settings.updateGeneral(primaryIdentity, {
      name: 'Settings Renamed',
      slug: `settings-renamed-${runId}`,
      timezone: 'America/Los_Angeles',
    });
    const team = await settings.updateTeam(primaryIdentity, {
      defaultInviteRole: 'MANAGER',
      shiftApprovalPolicy: 'ADMIN_APPROVAL',
    });
    const security = await settings.updateSecurity(primaryIdentity, {
      requireMfaForAll: true,
      sessionTimeoutMinutes: 120,
      oidcIssuerUrl: 'https://issuer.example.test/settings',
    });
    assert.equal(general.general.name, 'Settings Renamed');
    assert.equal(team.team.defaultInviteRole, 'MANAGER');
    assert.equal(security.security.requireMfaForAll, true);
    assert.equal(JSON.stringify(security).includes(tenant.id), false);
    assert.equal(JSON.stringify(security).includes(user.id), false);

    // Hold the first save after its read, then start another section save.
    // The second writer must read the newly committed aggregate, not its stale
    // predecessor. Both transactions use the restricted application role.
    let releaseFirst;
    let firstAtPersist;
    let secondAtLock;
    let firstReleased = false;
    let secondRead = false;
    let secondLockCompleted = false;
    const paused = new Promise(resolve => { firstAtPersist = resolve; });
    const release = new Promise(resolve => { releaseFirst = resolve; });
    const lockEntered = new Promise(resolve => { secondAtLock = resolve; });
    const database = new TenantDatabase(app);
    const delayed = new WorkspaceSettingsService({
      withTenant: (tenantId, operation) => database.withTenant(tenantId, tx => operation(new Proxy(tx, {
        get(target, key) {
          if (key === 'tenantSetting') return new Proxy(target.tenantSetting, {
            get(model, method) {
              if (method === 'upsert') return async args => {
                firstAtPersist();
                await release;
                return model.upsert(args);
              };
              const value = model[method];
              return typeof value === 'function' ? value.bind(model) : value;
            },
          });
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }, { oidcSsoAvailable: false });
    const observedSecond = new WorkspaceSettingsService({
      withTenant: (tenantId, operation) => database.withTenant(tenantId, tx => operation(new Proxy(tx, {
        get(target, key) {
          if (key === '$executeRaw') return async (statement, ...args) => {
            if (!statement.sql?.includes('pg_advisory_xact_lock')) return target.$executeRaw(statement, ...args);
            secondAtLock();
            const result = await target.$executeRaw(statement, ...args);
            secondLockCompleted = true;
            assert.equal(firstReleased, true, 'second writer acquired the lock before the first writer was released');
            return result;
          };
          if (key === 'tenantSetting') return new Proxy(target.tenantSetting, {
            get(model, method) {
              if (method === 'findUnique') return args => {
                secondRead = true;
                assert.equal(firstReleased, true, 'second writer read the aggregate while the first writer was paused');
                assert.equal(secondLockCompleted, true, 'second writer read before acquiring the settings lock');
                return model.findUnique(args);
              };
              const value = model[method];
              return typeof value === 'function' ? value.bind(model) : value;
            },
          });
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    }, { oidcSsoAvailable: false });
    const firstSave = delayed.updateTeam(primaryIdentity, { defaultInviteRole: 'STAFF' });
    // Attach rejection observers immediately so a broken lock cannot generate an
    // unhandled rejection while the explicit barrier is waiting.
    void firstSave.catch(() => {});
    let secondSave;
    try {
      await boundedBarrier(paused, 'first writer aggregate persist');
      secondSave = observedSecond.updateSecurity(primaryIdentity, { sessionTimeoutMinutes: 240 });
      void secondSave.catch(() => {});
      await boundedBarrier(lockEntered, 'second writer advisory lock entry');
      assert.equal(secondRead, false, 'second writer must not read before the first writer is released');
      assert.equal(secondLockCompleted, false, 'first writer must still own the settings lock');
      firstReleased = true;
      releaseFirst();
      await boundedBarrier(Promise.all([firstSave, secondSave]), 'both serialized settings saves', 10_000);
      assert.equal(secondRead, true, 'second writer must read after acquiring the released lock');
    } finally {
      firstReleased = true;
      releaseFirst();
      // Prisma's finite transaction deadlines bound cleanup on a failed barrier.
      await Promise.allSettled([firstSave, ...(secondSave ? [secondSave] : [])]);
    }
    const afterConcurrentSave = await settings.get(primaryIdentity);
    assert.equal(afterConcurrentSave.team.defaultInviteRole, 'STAFF');
    assert.equal(afterConcurrentSave.security.sessionTimeoutMinutes, 240);
    assert.equal(afterConcurrentSave.general.name, 'Settings Renamed');

    await assert.rejects(
      () => settings.updateSecurity(primaryIdentity, { ssoOidcOnly: true }),
      (error) => error?.code === 'oidc_not_configured',
    );
    const isolated = await settings.get(isolatedIdentity);
    assert.equal(isolated.general.name, 'Settings Isolated');
    assert.equal(isolated.team.defaultInviteRole, 'STAFF');

    const [persisted, audits] = await Promise.all([
      owner.tenantSetting.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: tenant.id, key: 'workspace_settings' } },
        select: { value: true },
      }),
      owner.auditLog.findMany({
        where: { tenantId: tenant.id, action: 'SECURITY_POLICY_UPDATED' },
        select: { oldValue: true, newValue: true, actorUserId: true },
      }),
    ]);
    assert.equal(persisted.value.general.timezone, 'America/Los_Angeles');
    assert.equal(audits.length, 2);
    assert.equal(audits[0]?.actorUserId, user.id);
    assert.equal(JSON.stringify(audits[0]).includes('issuer.example.test'), false);
  } finally {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const tenantIds = [fixture.tenantId, fixture.otherTenantId];
      await transaction.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.tenantSetting.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }).catch(() => {});
    await Promise.allSettled([app.$disconnect(), owner.$disconnect()]);
  }
});
