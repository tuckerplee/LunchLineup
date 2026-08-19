import type { SessionIdentity } from '@lunchlineup/api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { ProblemError } from './platform/problem';
import { buildServer } from './server';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  ALLOWED_ORIGINS: 'https://beta.lunchlineup.com',
  LEGACY_API_BASE_URL: 'http://api:3000/v1',
  JWT_SECRET: 'test-api-v2-jwt-secret',
  DEPLOY_RELEASE_SHA: 'a'.repeat(40),
  LOG_LEVEL: 'silent',
});

const identity: SessionIdentity = {
  sub: 'user-1',
  publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  role: 'MANAGER',
  legacyRole: 'MANAGER',
  roles: [{ id: 'role-manager', name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
  permissions: [
    'locations:read',
    'locations:write',
    'locations:delete',
    'schedules:read',
    'schedules:write',
    'schedules:publish',
    'shifts:read',
    'shifts:write',
    'shifts:delete',
    'lunch_breaks:read',
    'lunch_breaks:write',
    'time_cards:read',
    'time_cards:write',
    'time_cards:approve',
    'payroll:read',
    'payroll:policy_write',
    'payroll:lock',
    'payroll:export',
    'payroll:reconcile',
    'users:read',
    'users:write',
    'users:admin',
    'roles:read',
    'roles:write',
    'roles:assign',
    'notifications:read',
    'notifications:write',
    'settings:read',
    'settings:write',
  ],
  mfaVerified: true,
  mfaRequired: true,
  pinResetRequired: false,
};

const apps: Array<Awaited<ReturnType<typeof buildServer>>> = [];

async function harness(identityResponse: SessionIdentity = identity) {
  const retainedApplication = vi.fn(async () => ({ ok: true }));
  const retainedOperators = {
    executeRetentionPurge: vi.fn(async () => ({
      dryRun: true,
      stage: 'application_data',
      processedTenantCount: 0,
    })),
  };
  const location = {
    id: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
    name: 'Downtown Diner',
    address: '100 Main Street',
    timezone: 'America/Los_Angeles',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
  const locations = {
    list: vi.fn(async () => ({
      data: [location],
      pagination: {
        limit: 100,
        maxLimit: 200 as const,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    })),
    summary: vi.fn(async () => ({ count: 1 })),
    get: vi.fn(async () => location),
    create: vi.fn(async () => location),
    update: vi.fn(async () => location),
    remove: vi.fn(async () => undefined),
    resolvePublicIds: vi.fn(async () => new Map()),
    resolveInternalIds: vi.fn(async () => new Map()),
  };
  const staffMember = {
    id: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
    name: 'Casey Server Test',
    email: 'casey@example.test',
    username: '',
    role: 'STAFF' as const,
    pinEnabled: false,
    pinResetRequired: false,
    assignedRoles: [{
      id: '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f',
      name: 'Staff',
      description: null,
      isSystem: true,
      legacyRole: 'STAFF' as const,
      permissions: ['users:read'],
    }],
  };
  const people = {
    list: vi.fn(async () => ({
      data: [staffMember],
      pagination: { limit: 1, maxLimit: 200 as const, returned: 1, hasMore: false, nextCursor: null },
      summary: { totalUsers: 1, staffCount: 1, managerCount: 0, privilegedUsers: 0, pinAccounts: 0 },
    })),
    accessCatalog: vi.fn(async () => ({
      permissions: [],
      defaultInviteRoleId: '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f',
      roles: [{
        ...staffMember.assignedRoles[0],
        slug: 'staff',
        isDefault: true,
        userCount: 1,
        canDelegate: true,
      }],
    })),
    get: vi.fn(async () => staffMember),
    schedulingProfile: vi.fn(async () => ({
      user: { id: staffMember.id, name: staffMember.name },
      skills: [], availability: [], availabilityConfigured: false,
    })),
    replaceSchedulingProfile: vi.fn(async () => ({
      user: { id: staffMember.id, name: staffMember.name },
      skills: [], availability: [], availabilityConfigured: false,
    })),
    invite: vi.fn(async () => ({
      ...staffMember,
      temporaryPin: null,
      invitationDelivery: { status: 'NOT_APPLICABLE' as const, attempts: 0, canRetry: false, canReissue: false },
      status: 'INVITED' as const,
    })),
    invitation: vi.fn(async () => ({
      invitationDelivery: { status: 'NOT_APPLICABLE' as const, attempts: 0, canRetry: false, canReissue: false },
    })),
    retryInvitation: vi.fn(async () => ({
      invitationDelivery: { status: 'PENDING' as const, attempts: 0, canRetry: true, canReissue: false },
    })),
    reissueInvitation: vi.fn(async () => ({
      invitationDelivery: { status: 'PENDING' as const, attempts: 0, canRetry: true, canReissue: false },
    })),
    resetPin: vi.fn(async () => ({
      id: staffMember.id, username: 'casey', temporaryPin: '123456', pinResetRequired: true as const,
    })),
    replaceOwnPin: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined),
    access: vi.fn(async () => ({
      primaryRole: 'Staff', roles: [{ id: '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f', name: 'Staff', isSystem: true, legacyRole: 'STAFF' as const }], permissions: ['users:read'],
    })),
    replaceAccess: vi.fn(async () => ({ id: staffMember.id, assignedRoles: staffMember.assignedRoles })),
    createRole: vi.fn(async () => ({
      id: '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f', name: 'Staff', description: null, isSystem: true, userCount: 1, permissions: ['users:read'],
    })),
    updateRole: vi.fn(async () => ({
      id: '2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f', name: 'Staff', description: null, isSystem: true, userCount: 1, permissions: ['users:read'],
    })),
    deleteRole: vi.fn(async () => undefined),
    resolvePublicUserIds: vi.fn(async () => new Map()),
    resolveInternalUserIds: vi.fn(async () => new Map()),
  };
  const operationsPagination = {
    limit: 1,
    maxLimit: 200 as const,
    returned: 1,
    hasMore: false,
    nextCursor: null,
    window: { startDate: null, endDate: null },
  };
  const breakPolicy = {
    break1OffsetMinutes: 120,
    lunchOffsetMinutes: 240,
    break2OffsetMinutes: 120,
    break1DurationMinutes: 10,
    lunchDurationMinutes: 30,
    break2DurationMinutes: 10,
    timeStepMinutes: 5,
  };
  const lunchBreakRow = {
    shiftId: 'a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068',
    userId: staffMember.id,
    employeeName: staffMember.name,
    startTime: '2026-07-18T16:00:00.000Z',
    endTime: '2026-07-18T23:00:00.000Z',
    breaks: [{
      type: 'lunch' as const,
      startTime: '2026-07-18T20:00:00.000Z',
      endTime: '2026-07-18T20:30:00.000Z',
      durationMinutes: 30,
      paid: false,
    }],
  };
  const operations = {
    listSchedules: vi.fn(async () => ({
      data: [{
        id: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
        locationId: location.id,
        startDate: '2026-07-18T00:00:00.000Z',
        endDate: '2026-07-19T00:00:00.000Z',
        status: 'DRAFT' as const,
        publishedAt: null,
        revision: 4,
      }],
      pagination: operationsPagination,
    })),
    listShifts: vi.fn(async () => ({
      data: [{
        id: lunchBreakRow.shiftId,
        userId: lunchBreakRow.userId,
        locationId: location.id,
        scheduleId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
        startTime: lunchBreakRow.startTime,
        endTime: lunchBreakRow.endTime,
        role: 'STAFF',
        user: { id: staffMember.id, name: staffMember.name, role: 'STAFF' as const },
        breaks: lunchBreakRow.breaks,
      }],
      pagination: operationsPagination,
    })),
    staffRoster: vi.fn(async () => ({
      data: [{ id: staffMember.id, name: staffMember.name, role: 'STAFF' as const }],
      pagination: operationsPagination,
    })),
  };
  const lunchBreaks = {
    list: vi.fn(async () => ({ data: [lunchBreakRow], pagination: operationsPagination })),
    policy: vi.fn(async () => breakPolicy),
    replacePolicy: vi.fn(async () => breakPolicy),
    generate: vi.fn(async () => ({
      locationId: location.id,
      source: 'shared_schedule' as const,
      persisted: true,
      policy: breakPolicy,
      creditConsumption: { consumedCredits: 1, newBalance: 4, source: 'credits' as const },
      data: [lunchBreakRow],
      reused: false,
    })),
    setupShifts: vi.fn(async () => ({ shiftIds: [lunchBreakRow.shiftId] })),
    replaceShiftBreaks: vi.fn(async () => lunchBreakRow),
  };
  const timeCard = {
    id: '74023f56-a8ca-441f-8d01-afbcb75892d3',
    userId: staffMember.id,
    locationId: location.id,
    shiftId: lunchBreakRow.shiftId,
    clockInAt: '2026-07-18T16:00:00.000Z',
    clockOutAt: null,
    breakMinutes: 0,
    status: 'OPEN' as const,
    revision: 1,
    grossMinutes: 60,
    workedMinutes: 60,
    notes: null,
    createdAt: '2026-07-18T16:00:00.000Z',
    updatedAt: '2026-07-18T16:00:00.000Z',
    displayTimeZone: 'America/Los_Angeles',
    breaks: [],
    user: { id: staffMember.id, name: staffMember.name, username: null, role: 'STAFF' },
    location: { id: location.id, name: location.name, timezone: location.timezone },
  };
  const timeCards = {
    list: vi.fn(async () => ({
      data: [timeCard],
      pagination: { ...operationsPagination, window: { startDate: null, endDate: null } },
    })),
    active: vi.fn(async () => ({ data: timeCard })),
    get: vi.fn(async () => timeCard),
    clockIn: vi.fn(async () => ({ data: timeCard, reused: false })),
    clockOut: vi.fn(async () => ({ ...timeCard, clockOutAt: '2026-07-18T17:00:00.000Z', status: 'CLOSED' as const, revision: 2 })),
    correct: vi.fn(async () => timeCard),
  };
  const notification = {
    id: '668196db-7db2-4eb7-9808-5cd1a21717b7',
    type: 'INFO' as const,
    title: 'Schedule updated',
    body: 'Your shift changed.',
    readAt: null,
    createdAt: '2026-07-19T16:00:00.000Z',
  };
  const notifications = {
    list: vi.fn(async () => ({
      data: [notification],
      unreadCount: 1,
      pagination: { limit: 20, maxLimit: 100 as const, returned: 1, hasMore: false, nextCursor: null },
    })),
    markRead: vi.fn(async () => ({ updated: 1, unreadCount: 0 })),
    markAllRead: vi.fn(async () => ({ success: true as const, updated: 1, unreadCount: 0 as const })),
  };
  const workspaceSettings = {
    general: { name: 'Harbor & Main Demo Cafe', slug: 'harbor-main-demo', timezone: 'America/Los_Angeles' },
    team: { defaultInviteRole: 'STAFF' as const, shiftApprovalPolicy: 'MANAGER_APPROVAL' as const },
    security: { requireMfaForAll: false, sessionTimeoutMinutes: 120, ssoOidcOnly: false, oidcIssuerUrl: null },
  };
  const settings = {
    get: vi.fn(async () => workspaceSettings),
    updateGeneral: vi.fn(async () => workspaceSettings),
    updateTeam: vi.fn(async () => workspaceSettings),
    updateSecurity: vi.fn(async () => workspaceSettings),
  };
  const payroll = {
    listPolicies: vi.fn(async () => ({ data: [], nextCursor: null })),
    latestPolicy: vi.fn(async () => ({ data: null })),
    createPolicy: vi.fn(async () => { throw new Error('unused'); }),
    listPeriods: vi.fn(async () => ({ data: [], nextCursor: null })),
    createPeriod: vi.fn(async () => { throw new Error('unused'); }),
    getPeriod: vi.fn(async () => { throw new Error('unused'); }),
    startReview: vi.fn(async () => { throw new Error('unused'); }),
    adoptCards: vi.fn(async () => { throw new Error('unused'); }),
    decideCards: vi.fn(async () => { throw new Error('unused'); }),
    lockPeriod: vi.fn(async () => { throw new Error('unused'); }),
    createAmendment: vi.fn(async () => { throw new Error('unused'); }),
    decideAmendment: vi.fn(async () => { throw new Error('unused'); }),
    exportEntitlement: vi.fn(async () => ({ creditCost: 1, eligible: true, reason: 'Payroll export is eligible.' })),
    createExport: vi.fn(async () => { throw new Error('unused'); }),
    getExport: vi.fn(async () => { throw new Error('unused'); }),
    downloadExport: vi.fn(async () => { throw new Error('unused'); }),
    reconcileExport: vi.fn(async () => { throw new Error('unused'); }),
  };
  const board = vi.fn(async () => ({
    data: {
      permissions: identity.permissions,
      locations: [],
      locationsTruncated: false,
      selectedLocationId: null,
      staff: [],
      schedules: [],
      shifts: [],
      range: {
        start: '2026-07-18T00:00:00.000Z',
        end: '2026-07-19T00:00:00.000Z',
      },
    },
    meta: { generatedAt: '2026-07-18T00:00:00.000Z' },
  }));
  const apply = vi.fn(async () => ({
    data: {
      changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
      scheduleId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      baseRevision: 4,
      revision: 5,
      etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
      shifts: [],
      created: [],
    },
  }));
  const demandList = vi.fn(async () => ({ data: [] }));
  const demandReplace = vi.fn(async () => ({
    data: [],
    changeSetId: '62e5c71b-d3fd-4226-842e-ad84ae79173e',
    scheduleId: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
    baseRevision: 4,
    revision: 5,
    etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
  }));
  const reopen = vi.fn(async () => ({
    data: {
      id: '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
      startDate: '2026-07-18T00:00:00.000Z',
      endDate: '2026-07-19T00:00:00.000Z',
      status: 'DRAFT' as const,
      publishedAt: null,
      revision: 5,
      etag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
    },
  }));
  const authenticate = vi.fn(async () => identityResponse);
  const app = await buildServer(config, {
    database: {
      ready: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    } as never,
    identity: {
      authenticate,
    } as never,
    retainedApplication: { execute: retainedApplication },
    retainedOperators,
    locations,
    people: people as never,
    operations,
    lunchBreaks,
    notifications,
    timeCards,
    settings,
    payroll: payroll as never,
    routes: {
      board: { get: board },
      scheduleCreate: {
        create: vi.fn(async () => {
          throw new Error('unused');
        }),
      },
      changeSets: { apply },
      demandWindows: { list: demandList, replace: demandReplace },
      lifecycle: { reopen },
      retainedScheduling: {
        publishPlan: vi.fn(async () => { throw new Error('unused'); }),
        publish: vi.fn(async () => { throw new Error('unused'); }),
        startSolve: vi.fn(async () => { throw new Error('unused'); }),
        solveJob: vi.fn(async () => { throw new Error('unused'); }),
      },
    },
  });
  apps.push(app);
  return {
    app,
    board,
    apply,
    demandList,
    demandReplace,
    reopen,
    retainedApplication,
    retainedOperators,
    locations,
    people,
    operations,
    lunchBreaks,
    notifications,
    timeCards,
    settings,
    payroll,
    authenticate,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('API v2 HTTP contract', () => {
  it('publishes an OpenAPI 3.1 document with aggregate schedule operations', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/v2/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v2/schedules/{scheduleId}/change-sets'].post.operationId).toBe('applyScheduleChangeSet');
    expect(document.paths['/v2/schedule-board'].get.operationId).toBe('getScheduleBoard');
    expect(document.paths['/v2/locations/{locationId}/schedules'].post.operationId).toBe('createDraftSchedule');
    expect(document.paths['/v2/schedules/{scheduleId}/demand-windows'].put.operationId).toBe('replaceScheduleDemandWindows');
    expect(document.paths['/v2/schedules/{scheduleId}/publications'].post.operationId).toBe('publishSchedule');
    expect(document.paths['/v2/schedules/{scheduleId}/reopenings'].post.operationId).toBe('reopenSchedule');
    expect(document.paths['/v2/schedules/{scheduleId}/solve-jobs'].post.operationId).toBe('startScheduleSolve');
    expect(document.paths['/v2/break-generations'].post.operationId).toBe('generateScheduleBreaks');
    expect(document.paths['/v2/auth/me'].get.operationId).toBe('getCurrentSession');
    expect(document.paths['/v2/locations'].get.operationId).toBe('listLocations');
    expect(document.paths['/v2/locations'].post.operationId).toBe('createLocation');
    expect(document.paths['/v2/locations/{locationId}'].put.operationId).toBe('updateLocation');
    expect(document.paths['/v2/locations'].post.responses['500']).toBeDefined();
    expect(document.paths['/v2/users'].get.operationId).toBe('listStaffMembers');
    expect(document.paths['/v2/users/{userId}'].delete.operationId).toBe('deleteStaffMember');
    expect(document.paths['/v2/users/access/catalog'].get.operationId).toBe('getAccessCatalog');
    expect(document.paths['/v2/users/{userId}/access'].put.operationId).toBe('updateStaffAccess');
    expect(
      document.paths['/v2/auth/me'].get.responses['200'].content['application/json'].schema
        .properties.user.properties.mfaVerified.type,
    ).toBe('boolean');
    const browserSessionProperties = document.paths['/v2/auth/me'].get.responses['200'].content['application/json'].schema
      .properties.user.properties;
    expect(browserSessionProperties.sub).toBeUndefined();
    expect(browserSessionProperties.tenantId).toBeUndefined();
    expect(browserSessionProperties.sessionId).toBeUndefined();
    expect(browserSessionProperties.roles).toBeUndefined();
    expect(document.paths['/v2/users/{userId}/scheduling-profile'].put.operationId)
      .toBe('updateStaffSchedulingProfile');
    expect(document.paths['/v2/schedules'].get.operationId).toBe('listScheduleSummaries');
    expect(document.paths['/v2/shifts'].get.operationId).toBe('listShiftSummaries');
    expect(document.paths['/v2/shifts/staff-roster'].get.operationId).toBe('listStaffRoster');
    expect(document.paths['/v2/lunch-breaks'].get.operationId).toBe('listLunchBreakRows');
    expect(document.paths['/v2/lunch-breaks/policy'].get.operationId).toBe('getLunchBreakPolicy');
    expect(document.paths['/v2/lunch-breaks/policy'].put.operationId).toBe('updateLunchBreakPolicy');
    expect(document.paths['/v2/lunch-breaks/generate'].post.operationId).toBe('generateLunchBreakPlan');
    expect(document.paths['/v2/lunch-breaks/setup-shifts'].post.operationId).toBe('importLunchBreakShifts');
    expect(document.paths['/v2/lunch-breaks/shift/{shiftId}'].put.operationId).toBe('updateShiftBreakPlan');
    expect(document.paths['/v2/time-cards'].get.operationId).toBe('listTimeCards');
    expect(document.paths['/v2/time-cards/active'].get.operationId).toBe('getActiveTimeCard');
    expect(document.paths['/v2/time-cards/clock-in'].post.operationId).toBe('clockIn');
    expect(document.paths['/v2/time-cards/{timeCardId}/clock-out'].post.operationId).toBe('clockOut');
    expect(document.paths['/v2/time-cards/{timeCardId}/correction'].patch.operationId).toBe('correctTimeCard');
    expect(document.paths['/v2/notifications'].get.operationId).toBe('listNotifications');
    expect(document.paths['/v2/notifications/read'].post.operationId).toBe('markNotificationRead');
    expect(document.paths['/v2/notifications/read-all'].post.operationId).toBe('markAllNotificationsRead');
    expect(document.paths['/v2/settings'].get.operationId).toBe('getWorkspaceSettings');
    expect(document.paths['/v2/settings/security'].put.operationId).toBe('updateSecuritySettings');
    expect(document.paths['/v2/payroll/periods/{periodId}/exports'].post.operationId)
      .toBe('createPayrollExport');
    expect(document.paths['/v2/payroll/export-entitlement'].get.operationId)
      .toBe('getPayrollExportEntitlement');
    expect(document.paths['/v2/admin/account/exports/{jobId}/download'].get.operationId)
      .toBe('downloadAccountExport');
    expect(JSON.stringify(document.paths)).not.toContain('/shifts/{person');
    expect(JSON.stringify(document.paths)).not.toContain('demo-shift');
    expect(document.paths['/v2/shifts/{shiftId}']).toBeUndefined();
  });

  it('serves current session context through the native API-02 owner', async () => {
    const { app, retainedApplication, authenticate } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/auth/me',
      headers: { cookie: 'access_token=test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: {
        publicUserId: identity.publicUserId,
        role: 'MANAGER',
        roleLabel: 'MANAGER',
        workspaceName: 'Workspace',
        permissions: [...identity.permissions].sort(),
        mfaVerified: true,
        mfaRequired: true,
        pinResetRequired: false,
      },
    });
    const user = response.json().user as Record<string, unknown>;
    expect(user.workspaceScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user.sessionScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user).not.toHaveProperty('sub');
    expect(user).not.toHaveProperty('tenantId');
    expect(user).not.toHaveProperty('sessionId');
    expect(user).not.toHaveProperty('roles');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(authenticate).toHaveBeenCalledOnce();
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('deactivates staff through the native People owner rather than the retained application bridge', async () => {
    const { app, people, retainedApplication, authenticate } = await harness();
    const response = await app.inject({
      method: 'DELETE',
      url: '/v2/users/f6776d21-bb21-4c35-a6ed-5da8df5ed238',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(people.deactivate).toHaveBeenCalledWith(identity, identity.publicUserId);
    expect(retainedApplication).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('accepts the protected retention operator only through the v2 bearer ingress', async () => {
    const { app, retainedOperators, authenticate } = await harness();
    const denied = await app.inject({
      method: 'POST',
      url: '/v2/admin/retention/purge-expired',
      payload: { dryRun: true, stage: 'application_data' },
      headers: { cookie: 'access_token=browser-session' },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/v2/admin/retention/purge-expired',
      payload: { dryRun: true, stage: 'application_data' },
      headers: { authorization: 'Bearer retention-service-token' },
    });

    expect(denied.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ dryRun: true, stage: 'application_data' });
    expect(retainedOperators.executeRetentionPurge).toHaveBeenCalledOnce();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('serves tenant locations through the native API-02 owner and public UUID contract', async () => {
    const { app, retainedApplication, locations } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/locations?limit=100',
      headers: { cookie: 'access_token=test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ id: '34aa4812-63f5-4e5c-8b3a-06b564987a1f', name: 'Downtown Diner' }],
      pagination: { returned: 1, hasMore: false },
    });
    expect(response.headers['x-lunchlineup-compatibility-owner']).toBeUndefined();
    expect(locations.list).toHaveBeenCalledOnce();
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('serves the staff directory natively with public UUIDs and no retained hop', async () => {
    const { app, people, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/users?limit=1',
      headers: { cookie: 'access_token=test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ id: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238', name: 'Casey Server Test' }],
      pagination: { returned: 1, hasMore: false },
    });
    expect(response.headers['x-lunchlineup-compatibility-owner']).toBeUndefined();
    expect(people.list).toHaveBeenCalledWith(identity, { limit: '1' });
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('serves operations read models with public identifiers and no retained hop', async () => {
    const { app, operations, lunchBreaks, retainedApplication } = await harness();
    const shifts = await app.inject({
      method: 'GET',
      url: '/v2/shifts?limit=1',
      headers: { cookie: 'access_token=test' },
    });
    const policy = await app.inject({
      method: 'GET',
      url: '/v2/lunch-breaks/policy',
      headers: { cookie: 'access_token=test' },
    });

    expect(shifts.statusCode).toBe(200);
    expect(shifts.json()).toMatchObject({
      data: [{
        id: 'a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068',
        locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        user: { id: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238' },
      }],
      pagination: { returned: 1, hasMore: false },
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toMatchObject({ lunchDurationMinutes: 30 });
    expect(shifts.headers['x-lunchlineup-compatibility-owner']).toBeUndefined();
    expect(operations.listShifts).toHaveBeenCalledWith(identity, { limit: '1' });
    expect(lunchBreaks.policy).toHaveBeenCalledWith(identity);
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('serves native time cards with public identifiers and no retained hop', async () => {
    const { app, timeCards, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/time-cards?userId=f6776d21-bb21-4c35-a6ed-5da8df5ed238&limit=1',
      headers: { cookie: 'access_token=test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{
        id: '74023f56-a8ca-441f-8d01-afbcb75892d3',
        userId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
        locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
      }],
      pagination: { returned: 1, hasMore: false },
    });
    expect(response.headers['x-lunchlineup-compatibility-owner']).toBeUndefined();
    expect(timeCards.list).toHaveBeenCalledWith(identity, {
      userId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
      limit: '1',
    });
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('serves native notifications and their read-state commands without a retained hop', async () => {
    const { app, notifications, retainedApplication } = await harness();
    const read = await app.inject({
      method: 'GET',
      url: '/v2/notifications?status=all&limit=20',
      headers: { cookie: 'access_token=test' },
    });
    const markOne = await app.inject({
      method: 'POST',
      url: '/v2/notifications/read',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { ids: ['668196db-7db2-4eb7-9808-5cd1a21717b7'] },
    });
    const markAll = await app.inject({
      method: 'POST',
      url: '/v2/notifications/read-all',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
      },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      data: [{ id: '668196db-7db2-4eb7-9808-5cd1a21717b7' }],
      unreadCount: 1,
    });
    expect(read.headers['x-lunchlineup-compatibility-owner']).toBeUndefined();
    expect(markOne.statusCode).toBe(200);
    expect(markAll.statusCode).toBe(200);
    expect(notifications.list).toHaveBeenCalledWith(identity, { status: 'all', limit: '20' });
    expect(notifications.markRead).toHaveBeenCalledWith(identity, ['668196db-7db2-4eb7-9808-5cd1a21717b7']);
    expect(notifications.markAllRead).toHaveBeenCalledWith(identity);
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('serves payroll through its native owner and fences unsafe payroll exports with CSRF', async () => {
    const { app, payroll, retainedApplication } = await harness();
    const entitlement = await app.inject({
      method: 'GET',
      url: '/v2/payroll/export-entitlement',
      headers: { cookie: 'access_token=test' },
    });
    const rejectedExport = await app.inject({
      method: 'POST',
      url: '/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913/exports',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': 'payroll-export-test-key',
      },
      payload: { expectedCreditCost: 1 },
    });

    expect(entitlement.statusCode).toBe(200);
    expect(entitlement.json()).toEqual({ creditCost: 1, eligible: true, reason: 'Payroll export is eligible.' });
    expect(payroll.exportEntitlement).toHaveBeenCalledWith(identity);
    expect(rejectedExport.statusCode).toBe(403);
    expect(rejectedExport.json()).toMatchObject({ code: 'origin_not_allowed' });
    expect(payroll.createExport).not.toHaveBeenCalled();
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('requires same-origin CSRF proof before a native time-card clock-in', async () => {
    const { app, timeCards, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/time-cards/clock-in',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': 'clock-in-test-key',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_not_allowed' });
    expect(timeCards.clockIn).not.toHaveBeenCalled();
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('serves workspace settings through the native owner without a retained hop', async () => {
    const { app, settings, retainedApplication } = await harness();
    const read = await app.inject({
      method: 'GET',
      url: '/v2/settings',
      headers: { cookie: 'access_token=test' },
    });
    const write = await app.inject({
      method: 'PUT',
      url: '/v2/settings/team',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { defaultInviteRole: 'MANAGER', shiftApprovalPolicy: 'ADMIN_APPROVAL' },
    });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ general: { name: 'Harbor & Main Demo Cafe' } });
    expect(read.headers['x-lunchlineup-compatibility-owner']).toBeUndefined();
    expect(write.statusCode).toBe(200);
    expect(settings.get).toHaveBeenCalledWith(identity);
    expect(settings.updateTeam).toHaveBeenCalledWith(identity, {
      defaultInviteRole: 'MANAGER',
      shiftApprovalPolicy: 'ADMIN_APPROVAL',
    });
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('requires same-origin CSRF proof before a native lunch and break generation', async () => {
    const { app, lunchBreaks, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/lunch-breaks/generate',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
      },
      payload: {
        locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        shiftIds: ['a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068'],
        persist: true,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_not_allowed' });
    expect(lunchBreaks.generate).not.toHaveBeenCalled();
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('uses the native lunch-break owner for the legacy scheduling generation resource', async () => {
    const { app, lunchBreaks, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/break-generations',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
      },
      payload: {
        locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        shiftIds: ['a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068'],
        persist: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
      creditConsumption: { consumedCredits: 1, newBalance: 4 },
    });
    expect(lunchBreaks.generate).toHaveBeenCalledWith(identity, {
      locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
      shiftIds: ['a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068'],
      persist: true,
    }, '4daaf25a-92d7-4fba-975c-f54e4ce15c4a');
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('requires MFA and same-origin CSRF proof before a native staff invitation', async () => {
    const { app, people } = await harness({ ...identity, mfaVerified: false });
    const response = await app.inject({
      method: 'POST',
      url: '/v2/users/invite',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { name: 'Jamie', username: 'jamie', pin: '123456' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'mfa_verification_required' });
    expect(people.invite).not.toHaveBeenCalled();
  });

  it('requires CSRF and location permission before a native location mutation', async () => {
    const restricted = { ...identity, permissions: ['locations:read'] };
    const { app, locations } = await harness(restricted);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/locations',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { name: 'Downtown Diner', timezone: 'America/Los_Angeles' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'permission_denied' });
    expect(locations.create).not.toHaveBeenCalled();
  });

  it('rejects unsafe native settings writes before either owner is called', async () => {
    const { app, retainedApplication, settings } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/settings/general',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { name: 'Diner' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_not_allowed' });
    expect(settings.updateGeneral).not.toHaveBeenCalled();
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('leaves pre-session authentication CSRF policy with the retained auth owner', async () => {
    const { app, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/auth/password/reset/confirm',
      headers: {
        cookie: 'll_password_reset_token=opaque-reset-state',
        'content-type': 'application/json',
      },
      payload: { password: 'new-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(retainedApplication).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ operationId: 'confirmPasswordReset' }),
    }));
  });

  it('does not expose old per-shift mutation routes', async () => {
    const { app, retainedApplication } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/shifts/demo-shift-05-casey-v1',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { userId: 'casey' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'route_not_found' });
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('loads one screen-oriented board request', async () => {
    const { app, board } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/v2/schedule-board?date=2026-07-18&view=day',
    });
    expect(response.statusCode).toBe(200);
    expect(board).toHaveBeenCalledTimes(1);
    expect(response.headers['x-lunchlineup-api-version']).toBe('2');
    expect(response.headers['x-correlation-id']).toMatch(/^req-/);
  });

  it('blocks native scheduling while MFA verification is incomplete', async () => {
    const { app, board } = await harness({ ...identity, mfaVerified: false });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/schedule-board?date=2026-07-18&view=day',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'mfa_verification_required' });
    expect(board).not.toHaveBeenCalled();
  });

  it('blocks native scheduling while PIN rotation is required', async () => {
    const { app, board } = await harness({ ...identity, pinResetRequired: true });
    const response = await app.inject({
      method: 'GET',
      url: '/v2/schedule-board?date=2026-07-18&view=day',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'pin_rotation_required' });
    expect(board).not.toHaveBeenCalled();
  });

  it('requires same-origin CSRF proof for cookie-authenticated writes', async () => {
    const { app, apply } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: {
        operations: [{
          op: 'shift.delete',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('origin_not_allowed');
    expect(apply).not.toHaveBeenCalled();
  });

  it('preserves every discriminated change operation during HTTP validation', async () => {
    const { app, apply } = await harness();
    const operations = [
      {
        op: 'shift.create',
        clientId: '37ea171d-4e93-4c2c-931d-9c540f00bb98',
        userId: null,
        startTime: '2026-07-18T08:00:00.000Z',
        endTime: '2026-07-18T12:00:00.000Z',
        role: 'STAFF',
      },
      {
        op: 'shift.update',
        shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        userId: 'f241cd2b-c1be-4a3f-a8e7-bbf2aec70417',
        startTime: '2026-07-18T16:00:00.000Z',
        endTime: '2026-07-19T00:15:00.000Z',
        role: 'STAFF',
      },
      {
        op: 'shift.delete',
        shiftId: '2fef54b7-e51f-4301-8650-e89b9534be5c',
      },
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: { operations },
    });

    expect(response.statusCode).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[2]).toEqual({ operations });

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '250c2b7c-8418-4191-9413-21f08723fda8',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:5"',
      },
      payload: {
        operations: [{
          op: 'shift.update',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
          unexpected: true,
        }],
      },
    });

    expect(invalidResponse.statusCode).toBe(422);
    expect(invalidResponse.json()).toMatchObject({ code: 'contract_validation_failed' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('returns machine-readable stale revision details', async () => {
    const { app, apply } = await harness();
    apply.mockRejectedValueOnce(new ProblemError(
      412,
      'stale_schedule_revision',
      'The schedule changed after this board loaded. Reload before saving.',
      'Precondition failed',
      undefined,
      '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:6"',
    ));
    const response = await app.inject({
      method: 'POST',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: {
        operations: [{
          op: 'shift.delete',
          shiftId: 'bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f',
        }],
      },
    });
    expect(response.statusCode).toBe(412);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      code: 'stale_schedule_revision',
      currentEtag: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:6"',
    });
  });

  it('replaces demand through the aggregate schedule resource with ETag and idempotency', async () => {
    const { app, demandReplace } = await harness();
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/demand-windows',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
        'idempotency-key': '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        'if-match': '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      },
      payload: { windows: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toContain(':5');
    expect(demandReplace).toHaveBeenCalledWith(
      identity,
      '88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e',
      { windows: [] },
      expect.objectContaining({
        idempotencyKey: '4daaf25a-92d7-4fba-975c-f54e4ce15c4a',
        ifMatch: '"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4"',
      }),
      expect.any(Object),
    );
  });
});
