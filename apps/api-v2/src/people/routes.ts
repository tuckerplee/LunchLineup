import {
  AccessCatalogResponseSchema,
  AccessRoleRequestSchema,
  AccessRoleResponseSchema,
  PeopleRouteProblemResponses,
  ReplaceCurrentPinRequestSchema,
  ReplaceStaffAccessRequestSchema,
  ReplaceStaffAccessResponseSchema,
  ResetStaffPinRequestSchema,
  ResetStaffPinResponseSchema,
  RolePathSchema,
  StaffAccessResponseSchema,
  StaffDirectoryQuerySchema,
  StaffDirectoryResponseSchema,
  StaffInvitationDeliveryResponseSchema,
  StaffInvitationRequestSchema,
  StaffInvitationResponseSchema,
  StaffDirectoryMemberSchema,
  StaffPathSchema,
  StaffSchedulingProfileRequestSchema,
  StaffSchedulingProfileSchema,
  SuccessResponseSchema,
  type StaffDirectoryQuery,
  type StaffInvitationRequest,
  type StaffSchedulingProfileRequest,
} from '@lunchlineup/api-contract';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { ProblemError } from '../platform/problem';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { PeopleService } from './people.service';

export type PeopleRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  people: Pick<
    PeopleService,
    | 'list'
    | 'accessCatalog'
    | 'get'
    | 'schedulingProfile'
    | 'replaceSchedulingProfile'
    | 'invite'
    | 'invitation'
    | 'retryInvitation'
    | 'reissueInvitation'
    | 'resetPin'
    | 'replaceOwnPin'
    | 'deactivate'
    | 'access'
    | 'replaceAccess'
    | 'createRole'
    | 'updateRole'
    | 'deleteRole'
  >;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: PeopleRouteDependencies,
  options: { mfa?: boolean } = {},
) {
  const identity = await dependencies.identity.authenticate(request, reply);
  if (options.mfa && identity.mfaRequired && !identity.mfaVerified) {
    throw new ProblemError(
      403,
      'mfa_verification_required',
      'MFA verification is required before changing staff or access controls.',
      'Forbidden',
    );
  }
  return identity;
}

export async function registerPeopleRoutes(
  app: FastifyInstance,
  dependencies: PeopleRouteDependencies,
): Promise<void> {
  app.get<{ Querystring: StaffDirectoryQuery }>('/v2/users', {
    schema: {
      operationId: 'listStaffMembers',
      summary: 'List staff members',
      description: 'Lists a bounded tenant staff directory using opaque public UUIDs only.',
      tags: ['People'],
      querystring: StaffDirectoryQuerySchema,
      response: { 200: StaffDirectoryResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['users:read']);
    const response = await dependencies.people.list(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get('/v2/users/access/catalog', {
    schema: {
      operationId: 'getAccessCatalog',
      summary: 'Read the access-role catalog',
      description: 'Reads tenant roles and the permission catalog without exposing internal role keys.',
      tags: ['People'],
      response: { 200: AccessCatalogResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['roles:read']);
    const response = await dependencies.people.accessCatalog(identity);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: StaffInvitationRequest }>('/v2/users/invite', {
    schema: {
      operationId: 'createStaffInvitation',
      summary: 'Invite a staff member',
      description: 'Creates or reactivates one staff account and emits an encrypted invitation outbox command when email delivery applies.',
      tags: ['People'],
      body: StaffInvitationRequestSchema,
      response: { 201: StaffInvitationResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['users:write']);
    const response = await dependencies.people.invite(identity, request.body);
    reply.code(201).header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Body: { name: string; description?: string; permissionKeys: string[] } }>('/v2/users/roles', {
    schema: {
      operationId: 'createAccessRole',
      summary: 'Create an access role',
      description: 'Creates a tenant-defined access role with a public UUID identifier.',
      tags: ['People'],
      body: AccessRoleRequestSchema,
      response: { 201: AccessRoleResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['roles:write']);
    const response = await dependencies.people.createRole(identity, request.body);
    reply.code(201).header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{
    Params: { roleId: string };
    Body: { name: string; description?: string; permissionKeys: string[] };
  }>('/v2/users/roles/:roleId', {
    schema: {
      operationId: 'updateAccessRole',
      summary: 'Replace an access role',
      description: 'Replaces one tenant-defined access role by public UUID.',
      tags: ['People'],
      params: RolePathSchema,
      body: AccessRoleRequestSchema,
      response: { 200: AccessRoleResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['roles:write']);
    const response = await dependencies.people.updateRole(identity, request.params.roleId, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.delete<{ Params: { roleId: string } }>('/v2/users/roles/:roleId', {
    schema: {
      operationId: 'deleteAccessRole',
      summary: 'Delete an access role',
      description: 'Archives an unused tenant-defined access role by public UUID.',
      tags: ['People'],
      params: RolePathSchema,
      response: { 204: Type.Null(), ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['roles:write']);
    await dependencies.people.deleteRole(identity, request.params.roleId);
    reply.code(204).header('Cache-Control', 'private, no-store').send();
  });

  app.put<{
    Body: { currentPin: string; newPin: string };
  }>('/v2/users/me/pin', {
    schema: {
      operationId: 'replaceCurrentPin',
      summary: 'Replace the current user PIN',
      description: 'Rotates the signed-in username account PIN and revokes active sessions.',
      tags: ['People'],
      body: ReplaceCurrentPinRequestSchema,
      response: { 200: SuccessResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies);
    await dependencies.people.replaceOwnPin(identity, request.body.currentPin, request.body.newPin);
    reply.header('Cache-Control', 'private, no-store');
    return { success: true as const };
  });

  app.get<{ Params: { userId: string } }>('/v2/users/:userId/scheduling-profile', {
    schema: {
      operationId: 'getStaffSchedulingProfile',
      summary: 'Read one staff scheduling profile',
      description: 'Reads one active schedulable staff profile with public location UUID references.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 200: StaffSchedulingProfileSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['users:read']);
    const response = await dependencies.people.schedulingProfile(identity, request.params.userId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{
    Params: { userId: string };
    Body: StaffSchedulingProfileRequest;
  }>('/v2/users/:userId/scheduling-profile', {
    schema: {
      operationId: 'updateStaffSchedulingProfile',
      summary: 'Replace one staff scheduling profile',
      description: 'Atomically replaces staff skills and availability and invalidates only affected draft schedules.',
      tags: ['People'],
      params: StaffPathSchema,
      body: StaffSchedulingProfileRequestSchema,
      response: { 200: StaffSchedulingProfileSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['users:write']);
    const response = await dependencies.people.replaceSchedulingProfile(identity, request.params.userId, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Params: { userId: string } }>('/v2/users/:userId/invitation', {
    schema: {
      operationId: 'getStaffInvitation',
      summary: 'Read invitation delivery state',
      description: 'Reads one invitation delivery state without exposing recipient payload data.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 200: StaffInvitationDeliveryResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['users:admin']);
    const response = await dependencies.people.invitation(identity, request.params.userId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Params: { userId: string } }>('/v2/users/:userId/invitation/retry', {
    schema: {
      operationId: 'retryStaffInvitation',
      summary: 'Retry invitation delivery',
      description: 'Moves one failed invitation delivery back to its bounded pending state.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 200: StaffInvitationDeliveryResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['users:admin']);
    const response = await dependencies.people.retryInvitation(identity, request.params.userId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{ Params: { userId: string } }>('/v2/users/:userId/invitation/reissue', {
    schema: {
      operationId: 'reissueStaffInvitation',
      summary: 'Reissue an invitation',
      description: 'Reissues a dead-lettered invitation with a durable idempotency key.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 200: StaffInvitationDeliveryResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['users:admin']);
    const response = await dependencies.people.reissueInvitation(
      identity,
      request.params.userId,
      header(request, 'idempotency-key'),
    );
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Params: { userId: string };
    Body: { pin?: string };
  }>('/v2/users/:userId/pin/reset', {
    schema: {
      operationId: 'resetStaffPin',
      summary: 'Reset a staff PIN',
      description: 'Resets one eligible username account PIN and revokes active sessions.',
      tags: ['People'],
      params: StaffPathSchema,
      body: ResetStaffPinRequestSchema,
      response: { 200: ResetStaffPinResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['users:admin']);
    const response = await dependencies.people.resetPin(identity, request.params.userId, request.body.pin);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Params: { userId: string } }>('/v2/users/:userId/access', {
    schema: {
      operationId: 'getStaffAccess',
      summary: 'Read one staff access assignment',
      description: 'Reads role-derived staff access by public identifiers.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 200: StaffAccessResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['roles:read']);
    const response = await dependencies.people.access(identity, request.params.userId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{
    Params: { userId: string };
    Body: { roleIds: string[] };
  }>('/v2/users/:userId/access', {
    schema: {
      operationId: 'updateStaffAccess',
      summary: 'Replace one staff access assignment',
      description: 'Atomically replaces a staff member role assignments using public role UUIDs.',
      tags: ['People'],
      params: StaffPathSchema,
      body: ReplaceStaffAccessRequestSchema,
      response: { 200: ReplaceStaffAccessResponseSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['roles:assign']);
    const response = await dependencies.people.replaceAccess(identity, request.params.userId, request.body.roleIds);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{ Params: { userId: string } }>('/v2/users/:userId', {
    schema: {
      operationId: 'getStaffMember',
      summary: 'Read one staff member',
      description: 'Reads one staff member by public UUID.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 200: StaffDirectoryMemberSchema, ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    const identity = await authenticate(request, reply, dependencies);
    requirePermissions(identity, ['users:read']);
    const response = await dependencies.people.get(identity, request.params.userId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.delete<{ Params: { userId: string } }>('/v2/users/:userId', {
    schema: {
      operationId: 'deleteStaffMember',
      summary: 'Deactivate a staff member',
      description: 'Tombstones one staff account and atomically clears its editable schedule and availability-import lifecycle state.',
      tags: ['People'],
      params: StaffPathSchema,
      response: { 204: Type.Null(), ...PeopleRouteProblemResponses },
    },
  }, async (request, reply) => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await authenticate(request, reply, dependencies, { mfa: true });
    requirePermissions(identity, ['users:admin']);
    await dependencies.people.deactivate(identity, request.params.userId);
    reply.code(204).header('Cache-Control', 'private, no-store').send();
  });
}
