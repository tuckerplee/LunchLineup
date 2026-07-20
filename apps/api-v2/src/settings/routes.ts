import {
  WorkspaceGeneralSettingsUpdateSchema,
  WorkspaceSecuritySettingsUpdateSchema,
  WorkspaceSettingsRouteProblemResponses,
  WorkspaceSettingsSchema,
  WorkspaceTeamSettingsUpdateSchema,
  type WorkspaceGeneralSettingsUpdate,
  type WorkspaceSecuritySettingsUpdate,
  type WorkspaceSettings,
  type WorkspaceTeamSettingsUpdate,
} from '@lunchlineup/api-contract';
import type { FastifyInstance } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { WorkspaceSettingsService } from './settings.service';

export type WorkspaceSettingsRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  settings: Pick<WorkspaceSettingsService, 'get' | 'updateGeneral' | 'updateTeam' | 'updateSecurity'>;
};

/** Explicit native routes for the workspace settings aggregate. */
export async function registerWorkspaceSettingsRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceSettingsRouteDependencies,
): Promise<void> {
  app.get('/v2/settings', {
    schema: {
      operationId: 'getWorkspaceSettings',
      summary: 'Read workspace settings',
      description: 'Reads the tenant workspace configuration through the native API-v2 owner.',
      tags: ['Settings'],
      response: { 200: WorkspaceSettingsSchema, ...WorkspaceSettingsRouteProblemResponses },
    },
  }, async (request, reply): Promise<WorkspaceSettings> => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['settings:read']);
    const settings = await dependencies.settings.get(identity);
    reply.header('Cache-Control', 'private, no-store');
    return settings;
  });

  app.put<{ Body: WorkspaceGeneralSettingsUpdate }>('/v2/settings/general', {
    schema: {
      operationId: 'updateGeneralSettings',
      summary: 'Update general workspace settings',
      description: 'Updates the tenant name, slug, or workspace timezone as one native settings aggregate.',
      tags: ['Settings'],
      body: WorkspaceGeneralSettingsUpdateSchema,
      response: { 200: WorkspaceSettingsSchema, ...WorkspaceSettingsRouteProblemResponses },
    },
  }, async (request, reply): Promise<WorkspaceSettings> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['settings:write']);
    const settings = await dependencies.settings.updateGeneral(identity, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return settings;
  });

  app.put<{ Body: WorkspaceTeamSettingsUpdate }>('/v2/settings/team', {
    schema: {
      operationId: 'updateTeamSettings',
      summary: 'Update team workspace settings',
      description: 'Updates invite-role and shift-approval defaults through the native settings aggregate.',
      tags: ['Settings'],
      body: WorkspaceTeamSettingsUpdateSchema,
      response: { 200: WorkspaceSettingsSchema, ...WorkspaceSettingsRouteProblemResponses },
    },
  }, async (request, reply): Promise<WorkspaceSettings> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['settings:write']);
    const settings = await dependencies.settings.updateTeam(identity, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return settings;
  });

  app.put<{ Body: WorkspaceSecuritySettingsUpdate }>('/v2/settings/security', {
    schema: {
      operationId: 'updateSecuritySettings',
      summary: 'Update workspace security settings',
      description: 'Updates MFA, session, and OIDC-only policy with an append-only security audit record.',
      tags: ['Settings'],
      body: WorkspaceSecuritySettingsUpdateSchema,
      response: { 200: WorkspaceSettingsSchema, ...WorkspaceSettingsRouteProblemResponses },
    },
  }, async (request, reply): Promise<WorkspaceSettings> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['settings:write']);
    const settings = await dependencies.settings.updateSecurity(identity, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return settings;
  });
}
