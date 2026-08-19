import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  WorkspaceSecuritySettingsUpdateSchema,
  WorkspaceSettingsSchema,
  WorkspaceTeamSettingsUpdateSchema,
} from './settings';

const settings = {
  general: { name: 'Harbor & Main', slug: 'harbor-main', timezone: 'America/Los_Angeles' },
  team: { defaultInviteRole: 'STAFF', shiftApprovalPolicy: 'MANAGER_APPROVAL' },
  security: {
    requireMfaForAll: true,
    sessionTimeoutMinutes: 120,
    ssoOidcOnly: false,
    oidcIssuerUrl: null,
  },
};

describe('API v2 workspace settings contract', () => {
  it('accepts the complete public settings aggregate', () => {
    expect(Value.Check(WorkspaceSettingsSchema, settings)).toBe(true);
  });

  it('requires a bounded explicit update and rejects tenant-control fields', () => {
    expect(Value.Check(WorkspaceTeamSettingsUpdateSchema, {})).toBe(false);
    expect(Value.Check(WorkspaceTeamSettingsUpdateSchema, {
      defaultInviteRole: 'MANAGER',
      tenantId: 'caller-selected-tenant',
    })).toBe(false);
    expect(Value.Check(WorkspaceSecuritySettingsUpdateSchema, {
      sessionTimeoutMinutes: 1,
    })).toBe(false);
  });
});
