import { Static, Type } from '@sinclair/typebox';

export const SessionIdentitySchema = Type.Object({
  sub: Type.String({ minLength: 1, maxLength: 128 }),
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

export const CurrentSessionResponseSchema = Type.Object({
  user: SessionIdentitySchema,
});

export type CurrentSessionResponse = Static<typeof CurrentSessionResponseSchema>;
