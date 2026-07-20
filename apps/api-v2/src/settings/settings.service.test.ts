import type { SessionIdentity } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSettingsService } from './settings.service';

const identity: SessionIdentity = {
  sub: 'user-storage-id',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-storage-id',
  sessionId: 'session-1',
  role: 'ADMIN',
  legacyRole: 'ADMIN',
  roles: [],
  permissions: ['settings:read', 'settings:write'],
  mfaVerified: true,
  mfaRequired: false,
};

function harness(initialValue: unknown = null, oidcSsoAvailable = false) {
  let value = initialValue;
  const tenant = {
    name: 'Harbor & Main',
    slug: 'harbor-main',
  };
  const transaction = {
    tenant: {
      findUnique: vi.fn(async () => ({ ...tenant })),
      update: vi.fn(async ({ data }: { data: Partial<typeof tenant> }) => {
        Object.assign(tenant, data);
        return { ...tenant };
      }),
    },
    tenantSetting: {
      findUnique: vi.fn(async () => (value === null ? null : { value })),
      upsert: vi.fn(async ({ create, update }: { create: { value: unknown }; update: { value: unknown } }) => {
        value = update.value ?? create.value;
        return { value };
      }),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  const withTenant = vi.fn(async (_tenantId: string, operation: (tx: unknown) => unknown) => operation(transaction));
  return {
    instance: new WorkspaceSettingsService({ withTenant } as never, { oidcSsoAvailable } as never),
    transaction,
    withTenant,
  };
}

describe('native API v2 workspace settings owner', () => {
  it('normalizes malformed stored JSON without allowing it to choose a tenant', async () => {
    const { instance, withTenant } = harness({
      general: { timezone: 'not-a-timezone' },
      team: { defaultInviteRole: 'SUPER_ADMIN' },
      security: { sessionTimeoutMinutes: 1, oidcIssuerUrl: 'ftp://invalid.example' },
    });

    const result = await instance.get(identity);

    expect(result).toEqual({
      general: { name: 'Harbor & Main', slug: 'harbor-main', timezone: 'America/New_York' },
      team: { defaultInviteRole: 'STAFF', shiftApprovalPolicy: 'MANAGER_APPROVAL' },
      security: {
        requireMfaForAll: false,
        sessionTimeoutMinutes: 480,
        ssoOidcOnly: false,
        oidcIssuerUrl: null,
      },
    });
    expect(withTenant).toHaveBeenCalledWith(identity.tenantId, expect.any(Function));
    expect(JSON.stringify(result)).not.toContain('tenant-storage-id');
  });

  it('persists general/team changes through the tenant aggregate', async () => {
    const { instance, transaction } = harness();
    const general = await instance.updateGeneral(identity, {
      name: 'Harbor Main',
      slug: 'Harbor-Main',
      timezone: 'America/Chicago',
    });
    const team = await instance.updateTeam(identity, {
      defaultInviteRole: 'MANAGER',
      shiftApprovalPolicy: 'ADMIN_APPROVAL',
    });

    expect(general.general).toEqual({ name: 'Harbor Main', slug: 'harbor-main', timezone: 'America/Chicago' });
    expect(team.team).toEqual({ defaultInviteRole: 'MANAGER', shiftApprovalPolicy: 'ADMIN_APPROVAL' });
    expect(transaction.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: identity.tenantId },
      data: { name: 'Harbor Main', slug: 'harbor-main' },
    }));
    expect(transaction.tenantSetting.upsert).toHaveBeenCalledTimes(2);
  });

  it('writes one redacted security audit only when an effective policy changes', async () => {
    const { instance, transaction } = harness();
    await instance.updateSecurity(identity, {
      requireMfaForAll: true,
      sessionTimeoutMinutes: 120,
      oidcIssuerUrl: 'https://issuer.example.test/tenant',
    });
    await instance.updateSecurity(identity, { sessionTimeoutMinutes: 120 });

    expect(transaction.auditLog.create).toHaveBeenCalledOnce();
    expect(transaction.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: identity.tenantId,
        actorUserId: identity.sub,
        action: 'SECURITY_POLICY_UPDATED',
        oldValue: expect.objectContaining({ oidcIssuerConfigured: false }),
        newValue: expect.objectContaining({ oidcIssuerConfigured: true }),
      }),
    }));
    expect(JSON.stringify(transaction.auditLog.create.mock.calls)).not.toContain('issuer.example.test');
  });

  it('fails closed before persisting an SSO-only policy when OIDC is unavailable', async () => {
    const { instance, transaction } = harness();

    await expect(instance.updateSecurity(identity, { ssoOidcOnly: true }))
      .rejects.toMatchObject({ status: 422, code: 'oidc_not_configured' });
    expect(transaction.tenantSetting.upsert).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
  });
});
