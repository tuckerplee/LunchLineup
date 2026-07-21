import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  BrowserSessionIdentitySchema,
  CurrentSessionResponseSchema,
  SessionIdentitySchema,
} from './authentication';

const identity = {
  sub: 'user-internal',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-internal',
  sessionId: 'session-internal',
  role: 'Manager',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: ['dashboard:access', 'schedules:read'],
  mfaVerified: true,
  mfaRequired: true,
  pinResetRequired: false,
};

const browserIdentity = {
  publicUserId: identity.publicUserId,
  role: 'MANAGER',
  roleLabel: 'Manager',
  workspaceName: 'Demo',
  workspaceScope: 'A'.repeat(43),
  sessionScope: 'B'.repeat(43),
  permissions: identity.permissions,
  mfaVerified: true,
  mfaRequired: true,
  pinResetRequired: false,
};

describe('API v2 native authentication contract', () => {
  it('models the current session as a typed user envelope', () => {
    expect(Value.Check(CurrentSessionResponseSchema, { user: browserIdentity })).toBe(true);
  });

  it('keeps internal authorization identity separate from browser session data', () => {
    expect(Value.Check(SessionIdentitySchema, { ...identity, mfaVerified: undefined })).toBe(false);
    expect(Value.Check(SessionIdentitySchema, { ...identity, publicUserId: undefined })).toBe(false);
    expect(Value.Check(BrowserSessionIdentitySchema, browserIdentity)).toBe(true);
    expect(Value.Check(BrowserSessionIdentitySchema, { ...browserIdentity, sub: identity.sub })).toBe(false);
    expect(Value.Check(BrowserSessionIdentitySchema, { ...browserIdentity, tenantId: identity.tenantId })).toBe(false);
    expect(Value.Check(BrowserSessionIdentitySchema, { ...browserIdentity, sessionId: identity.sessionId })).toBe(false);
    expect(Value.Check(BrowserSessionIdentitySchema, { ...browserIdentity, roles: identity.roles })).toBe(false);
    expect(Value.Check(CurrentSessionResponseSchema, { identity })).toBe(false);
  });
});
