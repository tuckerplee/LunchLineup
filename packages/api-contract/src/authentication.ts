import { Static, Type } from '@sinclair/typebox';
import { UuidSchema } from './scheduling';

export const SessionIdentitySchema = Type.Object({
  sub: Type.String({ minLength: 1, maxLength: 128 }),
  publicUserId: UuidSchema,
  tenantId: Type.String({ minLength: 1, maxLength: 128 }),
  sessionId: Type.String({ minLength: 1, maxLength: 128 }),
  role: Type.String({ minLength: 1, maxLength: 128 }),
  legacyRole: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  roles: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name: Type.String({ minLength: 1, maxLength: 128 }),
    isSystem: Type.Optional(Type.Boolean()),
    legacyRole: Type.Optional(Type.Union([Type.String({ maxLength: 128 }), Type.Null()])),
  }), { maxItems: 100 }),
  permissions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
  email: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
  username: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  name: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  tenantName: Type.Optional(Type.String({ maxLength: 200 })),
  mfaVerified: Type.Boolean(),
  mfaRequired: Type.Boolean(),
  pinResetRequired: Type.Optional(Type.Boolean()),
});

export type SessionIdentity = Static<typeof SessionIdentitySchema>;

/**
 * Browser-facing session data. This deliberately is not the same shape as
 * SessionIdentity: storage IDs and RBAC storage keys are authorization-only
 * implementation details and must never leave API v2.
 */
export const BrowserSessionRoleSchema = Type.Union([
  Type.Literal('SUPER_ADMIN'),
  Type.Literal('ADMIN'),
  Type.Literal('MANAGER'),
  Type.Literal('STAFF'),
]);

export const BrowserSessionIdentitySchema = Type.Object({
  publicUserId: UuidSchema,
  role: BrowserSessionRoleSchema,
  roleLabel: Type.String({ minLength: 1, maxLength: 128 }),
  workspaceName: Type.String({ minLength: 1, maxLength: 200 }),
  // These are HMAC-derived, non-authoritative browser scopes. They allow
  // browser retry state to be partitioned without exposing tenant/session IDs.
  workspaceScope: Type.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' }),
  sessionScope: Type.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' }),
  permissions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
  email: Type.Optional(Type.Union([Type.String({ maxLength: 320 }), Type.Null()])),
  username: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  name: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  mfaVerified: Type.Boolean(),
  mfaRequired: Type.Boolean(),
  pinResetRequired: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type BrowserSessionIdentity = Static<typeof BrowserSessionIdentitySchema>;

export const CurrentSessionResponseSchema = Type.Object({
  user: BrowserSessionIdentitySchema,
});

export type CurrentSessionResponse = Static<typeof CurrentSessionResponseSchema>;
