import { Static, Type } from '@sinclair/typebox';
import { ProblemDetailsSchema } from './scheduling';

const WorkspaceNameSchema = Type.String({ minLength: 1, maxLength: 200 });
const WorkspaceSlugSchema = Type.String({ minLength: 1, maxLength: 128 });
const TimeZoneSchema = Type.String({ minLength: 1, maxLength: 100 });
const OidcIssuerUrlSchema = Type.String({ minLength: 1, maxLength: 2_000 });

export const WorkspaceGeneralSettingsSchema = Type.Object({
  name: WorkspaceNameSchema,
  slug: WorkspaceSlugSchema,
  timezone: TimeZoneSchema,
}, { additionalProperties: false });

export type WorkspaceGeneralSettings = Static<typeof WorkspaceGeneralSettingsSchema>;

export const WorkspaceTeamSettingsSchema = Type.Object({
  defaultInviteRole: Type.Union([Type.Literal('STAFF'), Type.Literal('MANAGER')]),
  shiftApprovalPolicy: Type.Union([
    Type.Literal('AUTO_APPROVE'),
    Type.Literal('MANAGER_APPROVAL'),
    Type.Literal('ADMIN_APPROVAL'),
  ]),
}, { additionalProperties: false });

export type WorkspaceTeamSettings = Static<typeof WorkspaceTeamSettingsSchema>;

export const WorkspaceSecuritySettingsSchema = Type.Object({
  requireMfaForAll: Type.Boolean(),
  sessionTimeoutMinutes: Type.Integer({ minimum: 5, maximum: 1_440 }),
  ssoOidcOnly: Type.Boolean(),
  oidcIssuerUrl: Type.Union([OidcIssuerUrlSchema, Type.Null()]),
}, { additionalProperties: false });

export type WorkspaceSecuritySettings = Static<typeof WorkspaceSecuritySettingsSchema>;

export const WorkspaceSettingsSchema = Type.Object({
  general: WorkspaceGeneralSettingsSchema,
  team: WorkspaceTeamSettingsSchema,
  security: WorkspaceSecuritySettingsSchema,
}, { additionalProperties: false });

export type WorkspaceSettings = Static<typeof WorkspaceSettingsSchema>;

export const WorkspaceGeneralSettingsUpdateSchema = Type.Object({
  name: Type.Optional(WorkspaceNameSchema),
  slug: Type.Optional(WorkspaceSlugSchema),
  timezone: Type.Optional(TimeZoneSchema),
}, { additionalProperties: false, minProperties: 1 });

export type WorkspaceGeneralSettingsUpdate = Static<typeof WorkspaceGeneralSettingsUpdateSchema>;

export const WorkspaceTeamSettingsUpdateSchema = Type.Object({
  defaultInviteRole: Type.Optional(WorkspaceTeamSettingsSchema.properties.defaultInviteRole),
  shiftApprovalPolicy: Type.Optional(WorkspaceTeamSettingsSchema.properties.shiftApprovalPolicy),
}, { additionalProperties: false, minProperties: 1 });

export type WorkspaceTeamSettingsUpdate = Static<typeof WorkspaceTeamSettingsUpdateSchema>;

export const WorkspaceSecuritySettingsUpdateSchema = Type.Object({
  requireMfaForAll: Type.Optional(Type.Boolean()),
  sessionTimeoutMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1_440 })),
  ssoOidcOnly: Type.Optional(Type.Boolean()),
  oidcIssuerUrl: Type.Optional(Type.Union([OidcIssuerUrlSchema, Type.Null()])),
}, { additionalProperties: false, minProperties: 1 });

export type WorkspaceSecuritySettingsUpdate = Static<typeof WorkspaceSecuritySettingsUpdateSchema>;

export const WorkspaceSettingsRouteProblemResponses = {
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  422: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
};
