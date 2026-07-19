import { Static, Type } from '@sinclair/typebox';
import { InstantSchema, ProblemDetailsSchema, UuidSchema } from './scheduling';

export const StaffLegacyRoleSchema = Type.Union([
  Type.Literal('SUPER_ADMIN'),
  Type.Literal('ADMIN'),
  Type.Literal('MANAGER'),
  Type.Literal('STAFF'),
]);

export type StaffLegacyRole = Static<typeof StaffLegacyRoleSchema>;

/** Public role shape. Both staff and roles use stable opaque UUIDs. */
export const AssignedRoleSchema = Type.Object({
  id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  isSystem: Type.Boolean(),
  legacyRole: Type.Union([StaffLegacyRoleSchema, Type.Null()]),
  permissions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
});

export type AssignedRole = Static<typeof AssignedRoleSchema>;

/**
 * This is intentionally distinct from the compact scheduling-board staff
 * projection exported by scheduling.ts.
 */
export const StaffDirectoryMemberSchema = Type.Object({
  id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  email: Type.String({ maxLength: 320 }),
  username: Type.String({ maxLength: 32 }),
  role: StaffLegacyRoleSchema,
  pinEnabled: Type.Boolean(),
  pinResetRequired: Type.Boolean(),
  assignedRoles: Type.Array(AssignedRoleSchema, { maxItems: 100 }),
});

export type StaffMember = Static<typeof StaffDirectoryMemberSchema>;

export const StaffDirectorySummarySchema = Type.Object({
  totalUsers: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  staffCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  managerCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  privilegedUsers: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  pinAccounts: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
});

export type StaffDirectorySummary = Static<typeof StaffDirectorySummarySchema>;

export const StaffDirectoryQuerySchema = Type.Object({
  limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$', maxLength: 3 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  // Kept for browser compatibility. The directory is tenant-wide; scheduling
  // profile availability owns location scope.
  locationId: Type.Optional(UuidSchema),
}, { additionalProperties: false });

export type StaffDirectoryQuery = Static<typeof StaffDirectoryQuerySchema>;

export const StaffDirectoryPaginationSchema = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
  maxLimit: Type.Literal(200),
  returned: Type.Integer({ minimum: 0, maximum: 200 }),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
});

export const StaffDirectoryResponseSchema = Type.Object({
  data: Type.Array(StaffDirectoryMemberSchema, { maxItems: 200 }),
  pagination: StaffDirectoryPaginationSchema,
  summary: Type.Optional(StaffDirectorySummarySchema),
});

export type StaffDirectoryResponse = Static<typeof StaffDirectoryResponseSchema>;

export const StaffPathSchema = Type.Object({
  userId: UuidSchema,
}, { additionalProperties: false });

export const RolePathSchema = Type.Object({
  roleId: UuidSchema,
}, { additionalProperties: false });

export const PermissionCatalogItemSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  category: Type.String({ minLength: 1, maxLength: 64 }),
});

export const RoleCatalogItemSchema = Type.Intersect([
  AssignedRoleSchema,
  Type.Object({
    slug: Type.String({ minLength: 1, maxLength: 80 }),
    isDefault: Type.Boolean(),
    userCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    canDelegate: Type.Boolean(),
  }),
]);

export const AccessCatalogResponseSchema = Type.Object({
  permissions: Type.Array(PermissionCatalogItemSchema, { maxItems: 200 }),
  defaultInviteRoleId: Type.Union([UuidSchema, Type.Null()]),
  roles: Type.Array(RoleCatalogItemSchema, { maxItems: 104 }),
});

export type AccessCatalogResponse = Static<typeof AccessCatalogResponseSchema>;

export const StaffAvailabilityWindowSchema = Type.Object({
  locationId: Type.Union([UuidSchema, Type.Null()]),
  dayOfWeek: Type.Integer({ minimum: 0, maximum: 6 }),
  startTimeMinutes: Type.Integer({ minimum: 0, maximum: 1439 }),
  endTimeMinutes: Type.Integer({ minimum: 0, maximum: 1439 }),
});

export const StaffSchedulingProfileSchema = Type.Object({
  user: Type.Object({
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
  }),
  skills: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
  availability: Type.Array(StaffAvailabilityWindowSchema, { maxItems: 21 }),
  availabilityConfigured: Type.Boolean(),
});

export type StaffSchedulingProfile = Static<typeof StaffSchedulingProfileSchema>;

export const StaffSchedulingProfileRequestSchema = Type.Object({
  skills: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 50 }),
  availability: Type.Array(StaffAvailabilityWindowSchema, { maxItems: 21 }),
}, { additionalProperties: false });

export type StaffSchedulingProfileRequest = Static<typeof StaffSchedulingProfileRequestSchema>;

export const StaffInvitationRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  email: Type.Optional(Type.String({ minLength: 3, maxLength: 320 })),
  username: Type.Optional(Type.String({ minLength: 3, maxLength: 32, pattern: '^[a-z0-9._-]+$' })),
  pin: Type.Optional(Type.String({ minLength: 4, maxLength: 8, pattern: '^\\d+$' })),
  roleId: Type.Optional(UuidSchema),
  // Deprecated compatibility input. New callers select a public role UUID.
  role: Type.Optional(StaffLegacyRoleSchema),
}, { additionalProperties: false });

export type StaffInvitationRequest = Static<typeof StaffInvitationRequestSchema>;

export const InvitationDeliveryStatusSchema = Type.Union([
  Type.Literal('NOT_APPLICABLE'),
  Type.Literal('PENDING'),
  Type.Literal('SENDING'),
  Type.Literal('FAILED'),
  Type.Literal('DELIVERED'),
  Type.Literal('DEAD_LETTERED'),
  Type.Literal('CANCELLED'),
]);

export const InvitationDeliverySchema = Type.Object({
  deliveryId: Type.Optional(UuidSchema),
  status: InvitationDeliveryStatusSchema,
  attempts: Type.Integer({ minimum: 0, maximum: 8 }),
  nextAttemptAt: Type.Optional(InstantSchema),
  deliveredAt: Type.Optional(InstantSchema),
  canRetry: Type.Boolean(),
  canReissue: Type.Boolean(),
});

export type InvitationDelivery = Static<typeof InvitationDeliverySchema>;

export const StaffInvitationResponseSchema = Type.Intersect([
  StaffDirectoryMemberSchema,
  Type.Object({
    temporaryPin: Type.Union([Type.String({ minLength: 4, maxLength: 8 }), Type.Null()]),
    invitationDelivery: InvitationDeliverySchema,
    status: Type.Literal('INVITED'),
  }),
]);

export type StaffInvitationResponse = Static<typeof StaffInvitationResponseSchema>;

export const StaffInvitationDeliveryResponseSchema = Type.Object({
  invitationDelivery: InvitationDeliverySchema,
});

export type StaffInvitationDeliveryResponse = Static<typeof StaffInvitationDeliveryResponseSchema>;

export const ResetStaffPinRequestSchema = Type.Object({
  pin: Type.Optional(Type.String({ minLength: 4, maxLength: 8, pattern: '^\\d+$' })),
}, { additionalProperties: false });

export const ResetStaffPinResponseSchema = Type.Object({
  id: UuidSchema,
  username: Type.String({ minLength: 3, maxLength: 32 }),
  temporaryPin: Type.String({ minLength: 4, maxLength: 8 }),
  pinResetRequired: Type.Literal(true),
});

export type ResetStaffPinResponse = Static<typeof ResetStaffPinResponseSchema>;

export const ReplaceCurrentPinRequestSchema = Type.Object({
  currentPin: Type.String({ minLength: 4, maxLength: 8, pattern: '^\\d+$' }),
  newPin: Type.String({ minLength: 4, maxLength: 8, pattern: '^\\d+$' }),
}, { additionalProperties: false });

export const SuccessResponseSchema = Type.Object({ success: Type.Literal(true) });

export const StaffAccessResponseSchema = Type.Object({
  primaryRole: Type.String({ minLength: 1, maxLength: 80 }),
  roles: Type.Array(Type.Object({
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    isSystem: Type.Boolean(),
    legacyRole: Type.Union([StaffLegacyRoleSchema, Type.Null()]),
  }), { maxItems: 100 }),
  permissions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
});

export type StaffAccessResponse = Static<typeof StaffAccessResponseSchema>;

export const ReplaceStaffAccessRequestSchema = Type.Object({
  roleIds: Type.Array(UuidSchema, { maxItems: 100 }),
}, { additionalProperties: false });

export const ReplaceStaffAccessResponseSchema = Type.Object({
  id: UuidSchema,
  assignedRoles: Type.Array(AssignedRoleSchema, { maxItems: 100 }),
});

export type ReplaceStaffAccessResponse = Static<typeof ReplaceStaffAccessResponseSchema>;

export const AccessRoleRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 240 })),
  permissionKeys: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
}, { additionalProperties: false });

export const AccessRoleResponseSchema = Type.Object({
  id: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  isSystem: Type.Boolean(),
  userCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647 })),
  permissions: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 200 }),
});

export type AccessRoleResponse = Static<typeof AccessRoleResponseSchema>;

export const PeopleRouteProblemResponses = {
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
};
