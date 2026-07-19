import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { CurrentSessionResponseSchema, SessionIdentitySchema } from './authentication';

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

describe('API v2 native authentication contract', () => {
  it('models the current session as a typed user envelope', () => {
    expect(Value.Check(CurrentSessionResponseSchema, { user: identity })).toBe(true);
  });

  it('requires session-bound MFA state and rejects untyped user envelopes', () => {
    expect(Value.Check(SessionIdentitySchema, { ...identity, mfaVerified: undefined })).toBe(false);
    expect(Value.Check(SessionIdentitySchema, { ...identity, publicUserId: undefined })).toBe(false);
    expect(Value.Check(CurrentSessionResponseSchema, { identity })).toBe(false);
  });
});
