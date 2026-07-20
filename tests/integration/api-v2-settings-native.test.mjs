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
    assert.equal(audits.length, 1);
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
