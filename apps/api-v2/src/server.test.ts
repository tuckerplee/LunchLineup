import type { SessionIdentity } from '@lunchlineup/api-contract';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyLoggerOptions } from 'fastify';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { installProblemHandler, ProblemError } from './platform/problem';
import { buildServer, type ApiV2ServerDependencies } from './server';
import type { NativeQuotaAdapter } from './platform/native-quota';
import type { LightMyRequestResponse } from 'fastify';

const config = loadConfig({
  APP_ORIGIN: 'https://beta.lunchlineup.com',
  ALLOWED_ORIGINS: 'https://beta.lunchlineup.com',
  LEGACY_API_BASE_URL: 'http://api:3000/v1',
  JWT_SECRET: 'test-api-v2-jwt-secret',
  NODE_ENV: 'test',
  METRICS_TOKEN: 'synthetic-config-metrics-token-00000000000000000000',
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
    get: vi.fn(async (..._args: Parameters<NonNullable<ApiV2ServerDependencies['people']>['get']>) => staffMember),
    schedulingProfile: vi.fn(async () => ({
      user: { id: staffMember.id, name: staffMember.name },
      skills: [], availability: [], availabilityExceptions: [], availabilityConfigured: false,
    })),
    updateIdentity: vi.fn(),
    replaceSchedulingProfile: vi.fn(async () => ({
      user: { id: staffMember.id, name: staffMember.name },
      skills: [], availability: [], availabilityExceptions: [], availabilityConfigured: false,
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
    lifecycle: vi.fn(),
    setSuspended: vi.fn(),
    remove: vi.fn(async () => undefined),
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
  const apply = vi.fn(async (..._args: Parameters<NonNullable<ApiV2ServerDependencies['routes']>['changeSets']['apply']>) => ({
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
  const scheduleCreate = { create: vi.fn(async () => { throw new Error('unused'); }) };
  const retainedScheduling = {
    publishPlan: vi.fn(async () => { throw new Error('unused'); }),
    publish: vi.fn(async () => { throw new Error('unused'); }),
    startSolve: vi.fn(async () => { throw new Error('unused'); }),
    solveJob: vi.fn(async () => { throw new Error('unused'); }),
  };
  const authenticate = vi.fn(async () => identityResponse);
  const quota = { ready: vi.fn(async () => undefined), consume: vi.fn<NativeQuotaAdapter['consume']>(async () => undefined) };
  const app = await buildServer(config, {
    quota,
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
      scheduleCreate,
      changeSets: { apply },
      demandWindows: { list: demandList, replace: demandReplace },
      lifecycle: { reopen },
      retainedScheduling,
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
    quota,
    scheduleCreate,
    retainedScheduling,
  };
}

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } finally {
    // Mock call histories retain request/reply graphs after the app closes.
    vi.clearAllMocks();
  }
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
    const schedulingProfileExceptionSchema = document.paths['/v2/users/{userId}/scheduling-profile'].put
      .requestBody.content['application/json'].schema.properties.availabilityExceptions.items;
    expect(schedulingProfileExceptionSchema.required).toEqual(expect.arrayContaining([
      'locationId',
      'date',
      'kind',
      'allDay',
      'startTimeMinutes',
      'endTimeMinutes',
    ]));
    expect(schedulingProfileExceptionSchema.properties.date.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(JSON.stringify(schedulingProfileExceptionSchema.properties.kind)).toContain('AVAILABLE');
    expect(JSON.stringify(schedulingProfileExceptionSchema.properties.kind)).toContain('UNAVAILABLE');
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
  }, 15_000);

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
  }, 15_000);

  it('routes account-state reads and writes to the native owner with a required precondition', async () => {
    const { app, people, retainedApplication } = await harness();
    const user = await people.get(identity, identity.publicUserId);
    const state = { user, futureAssignmentCount: 0, futureAssignments: [] };
    people.lifecycle.mockResolvedValue(state);
    people.setSuspended.mockResolvedValue(state);
    const url = `/v2/users/${identity.publicUserId}/lifecycle`;
    const read = await app.inject({ method: 'GET', url });
    expect(read.statusCode).toBe(200);
    expect(people.lifecycle).toHaveBeenCalledWith(identity, identity.publicUserId);
    const missing = await app.inject({ method: 'PUT', url, payload: { suspended: true } });
    expect(missing.statusCode).toBe(422);
    expect(people.setSuspended).not.toHaveBeenCalled();
    const body = { suspended: true, expectedSuspendedAt: null };
    const write = await app.inject({ method: 'PUT', url, payload: body });
    expect(write.statusCode).toBe(200);
    expect(write.headers['cache-control']).toBe('private, no-store');
    expect(people.setSuspended).toHaveBeenCalledWith(identity, identity.publicUserId, body);
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('permanently removes staff through the native People owner rather than the retained application bridge', async () => {
    const { app, people, retainedApplication, authenticate } = await harness();
    const response = await app.inject({
      method: 'DELETE',
      url: '/v2/users/f6776d21-bb21-4c35-a6ed-5da8df5ed238',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(people.remove).toHaveBeenCalledWith(identity, identity.publicUserId);
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

  it('forwards dated availability through the protected native People profile contract', async () => {
    const { app, people, retainedApplication } = await harness();
    const payload = {
      skills: ['expo'],
      availability: [],
      availabilityExceptions: [{
        locationId: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        date: '2026-08-21',
        kind: 'UNAVAILABLE',
        allDay: true,
        startTimeMinutes: 0,
        endTimeMinutes: 1440,
      }],
    };
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/users/f6776d21-bb21-4c35-a6ed-5da8df5ed238/scheduling-profile',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(people.replaceSchedulingProfile).toHaveBeenCalledWith(identity, identity.publicUserId, payload);
    expect(retainedApplication).not.toHaveBeenCalled();
  });

  it('requires live users:write authority before changing dated availability', async () => {
    const deniedIdentity = {
      ...identity,
      permissions: identity.permissions.filter((permission) => permission !== 'users:write'),
    };
    const { app, people } = await harness(deniedIdentity);
    const response = await app.inject({
      method: 'PUT',
      url: '/v2/users/f6776d21-bb21-4c35-a6ed-5da8df5ed238/scheduling-profile',
      headers: {
        cookie: 'access_token=test; csrf_token=abcdefghijklmnop',
        origin: 'https://beta.lunchlineup.com',
        'x-csrf-token': 'abcdefghijklmnop',
        'content-type': 'application/json',
      },
      payload: { skills: [], availability: [], availabilityExceptions: [] },
    });

    expect(response.statusCode).toBe(403);
    expect(people.replaceSchedulingProfile).not.toHaveBeenCalled();
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

  it.each([
    {
      code: 'idempotency_key_reused',
      error: new ProblemError(
        409,
        'idempotency_key_reused',
        'Idempotency-Key was already used for a different schedule change.',
        'Idempotency conflict',
      ),
    },
    {
      code: 'idempotency_result_unavailable',
      error: new ProblemError(
        409,
        'idempotency_result_unavailable',
        'The stored idempotent result is unavailable. Use a new Idempotency-Key.',
        'Idempotency conflict',
      ),
    },
    {
      code: 'concurrent_change',
      error: Object.assign(new Error('transaction write conflict'), { code: 'P2034' }),
    },
  ])('returns a machine-readable HTTP 409 for $code', async ({ code, error }) => {
    const { app, apply } = await harness();
    apply.mockRejectedValueOnce(error);
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

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 409, code });
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


// Use the actual buildServer logger option with the installed Fastify/Pino sink.
// These injected requests do not start a listener or qualify deployed logging.
function requestLoggerOptions(): FastifyLoggerOptions {
  const source = readFileSync(resolve(__dirname, 'server.ts'), 'utf8');
  const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  const expressions: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'Fastify') {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'logger') {
            expressions.push(property.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(expressions).toHaveLength(1);
  const javascript = ts.transpileModule(`const options = ${expressions[0].getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('config', `${javascript}\nreturn options;`)({ logLevel: 'debug' }) as FastifyLoggerOptions;
}

describe('API v2 request-object log privacy', () => {
  it.each([
    { url: '/v2/auth/callback?code=sentinel-code&state=sentinel-state', route: '/v2/auth/callback', status: 200 },
    { url: '/v2/users/sentinel-path?code=sentinel-code&state=sentinel-state', route: '/v2/users/:userId', status: 200 },
    { url: '/v2/reject?code=sentinel-code&state=sentinel-state', route: '/v2/reject', status: 401 },
    { url: '/v2/fail?code=sentinel-code&state=sentinel-state', route: '/v2/fail', status: 500 },
    { url: '/v2/missing/sentinel-path?code=sentinel-code&state=sentinel-state', route: '[unmatched]', status: 404 },
  ])('keeps request diagnostics without query/path/credential bytes for $route ($status)', async ({ url, route, status }) => {
    const lines: string[] = [];
    const app = Fastify({ logger: { ...requestLoggerOptions(), stream: { write: (line: string) => { lines.push(line); } } } });
    apps.push(app);
    installProblemHandler(app);
    app.get('/v2/auth/callback', async () => ({ ok: true }));
    app.get('/v2/users/:userId', async () => ({ ok: true }));
    app.get('/v2/reject', async () => { throw new ProblemError(401, 'synthetic_rejection', 'Synthetic rejection.'); });
    app.get('/v2/fail', async () => { throw new Error('Synthetic failure.'); });
    const response = await app.inject({
      method: 'GET', url,
      headers: { authorization: 'Bearer sentinel-auth', cookie: 'access_token=sentinel-cookie' },
    });
    expect(response.statusCode).toBe(status);
    const records = lines.flatMap((line) => line.trim().split('\n').filter(Boolean).map((record) => JSON.parse(record)));
    const incoming = records.find((record) => record.msg === 'incoming request');
    const completed = records.find((record) => record.msg === 'request completed');
    expect(incoming?.req).toEqual({ method: 'GET', url: route });
    expect(incoming?.reqId).toEqual(expect.any(String));
    expect(incoming.reqId.length).toBeGreaterThan(0);
    expect(completed?.reqId).toBe(incoming.reqId);
    expect(completed?.res.statusCode).toBe(status);
    expect(completed?.responseTime).toEqual(expect.any(Number));
    for (const sentinel of ['sentinel-code', 'sentinel-state', 'sentinel-path', 'sentinel-auth', 'sentinel-cookie']) {
      expect(lines.join('')).not.toContain(sentinel);
    }
    if (status === 401) expect(records.some((record) => record.msg === 'api_v2_request_rejected')).toBe(true);
    if (status === 500) expect(records.some((record) => record.msg === 'api_v2_request_failed')).toBe(true);
  });
});

describe('native quota dispatch boundary', () => {
  it('rejects before the location read when quota is denied', async () => {
    const { app, quota, locations } = await harness();
    quota.consume.mockRejectedValueOnce(new ProblemError(429, 'rate_limited', 'Too many requests.', 'Too many requests'));
    const response = await app.inject({ method: 'GET', url: '/v2/locations?limit=100' });
    expect(response.statusCode).toBe(429);
    expect(response.json().code).toBe('rate_limited');
    expect(quota.consume).toHaveBeenCalledWith('listLocations', identity, expect.anything());
    expect(locations.list).not.toHaveBeenCalled();
  });
  it('rejects missing pure permissions before consuming quota', async () => {
    const { app, quota, locations } = await harness({ ...identity, permissions: [] });
    const response = await app.inject({ method: 'GET', url: '/v2/locations?limit=100' });
    expect(response.statusCode).toBe(403);
    expect(quota.consume).not.toHaveBeenCalled();
    expect(locations.list).not.toHaveBeenCalled();
  });
  it('charges session context during recovery without requiring a completed MFA challenge', async () => {
    const recovery = { ...identity, mfaVerified: false, pinResetRequired: true };
    const { app, quota } = await harness(recovery);
    const response = await app.inject({ method: 'GET', url: '/v2/auth/me' });
    expect(response.statusCode).toBe(200);
    expect(quota.consume).toHaveBeenCalledWith('getCurrentSession', recovery, expect.anything());
  });
  it('leaves retained billing and public authentication quota ownership downstream', async () => {
    const { app, quota, retainedApplication } = await harness();
    const response = await app.inject({ method: 'GET', url: '/v2/billing/features' });
    expect(response.statusCode).toBe(200);
    expect(retainedApplication).toHaveBeenCalledOnce();
    expect(quota.consume).not.toHaveBeenCalled();
    const publicResponse = await app.inject({ method: 'POST', url: '/v2/auth/login/resolve', payload: { tenantSlug: 'test', email: 'example@example.test' } });
    expect(publicResponse.statusCode).toBe(200);
    expect(quota.consume).not.toHaveBeenCalled();
  });
  it('checks readiness without consuming customer quota and returns a redacted failure', async () => {
    const { app, quota } = await harness();
    quota.ready.mockRejectedValueOnce(new Error('redis-sensitive-message'));
    const response = await app.inject({ method: 'GET', url: '/v2/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('readiness_unavailable');
    expect(response.body).not.toContain('redis-sensitive-message');
    expect(quota.consume).not.toHaveBeenCalled();
  });
});

// Private source draft: static schema comparison only; all execution remains held.
const nativeQuotaHttpFixtures = [
  {
    "operationId": "listLocations",
    "request": {
      "method": "GET",
      "url": "/v2/locations",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "locations.list",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createLocation",
    "request": {
      "method": "POST",
      "url": "/v2/locations",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "name": "Quota fixture",
        "timezone": "America/Los_Angeles"
      }
    },
    "domainSpy": "locations.create",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getLocationSummary",
    "request": {
      "method": "GET",
      "url": "/v2/locations/summary",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "locations.summary",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getLocation",
    "request": {
      "method": "GET",
      "url": "/v2/locations/34aa4812-63f5-4e5c-8b3a-06b564987a1f",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "locations.get",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateLocation",
    "request": {
      "method": "PUT",
      "url": "/v2/locations/34aa4812-63f5-4e5c-8b3a-06b564987a1f",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "timezone": "America/Los_Angeles",
        "name": "Quota fixture",
        "expectedUpdatedAt": "2026-07-18T16:00:00.000Z"
      }
    },
    "domainSpy": "locations.update",
    "explicitRouteMfa": false
  },
  {
    "operationId": "deleteLocation",
    "request": {
      "method": "DELETE",
      "url": "/v2/locations/34aa4812-63f5-4e5c-8b3a-06b564987a1f",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a"
      }
    },
    "domainSpy": "locations.remove",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listStaffMembers",
    "request": {
      "method": "GET",
      "url": "/v2/users",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.list",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getAccessCatalog",
    "request": {
      "method": "GET",
      "url": "/v2/users/access/catalog",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.accessCatalog",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createStaffInvitation",
    "request": {
      "method": "POST",
      "url": "/v2/users/invite",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "name": "Quota fixture",
        "username": "quota.fixture",
        "pin": "123456"
      }
    },
    "domainSpy": "people.invite",
    "explicitRouteMfa": true
  },
  {
    "operationId": "createAccessRole",
    "request": {
      "method": "POST",
      "url": "/v2/users/roles",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "name": "Quota fixture",
        "permissionKeys": [
          "users:read"
        ]
      }
    },
    "domainSpy": "people.createRole",
    "explicitRouteMfa": true
  },
  {
    "operationId": "updateAccessRole",
    "request": {
      "method": "PUT",
      "url": "/v2/users/roles/2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "name": "Quota fixture",
        "permissionKeys": [
          "users:read"
        ]
      }
    },
    "domainSpy": "people.updateRole",
    "explicitRouteMfa": true
  },
  {
    "operationId": "deleteAccessRole",
    "request": {
      "method": "DELETE",
      "url": "/v2/users/roles/2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a"
      }
    },
    "domainSpy": "people.deleteRole",
    "explicitRouteMfa": true
  },
  {
    "operationId": "replaceCurrentPin",
    "request": {
      "method": "PUT",
      "url": "/v2/users/me/pin",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "currentPin": "123456",
        "newPin": "654321"
      }
    },
    "domainSpy": "people.replaceOwnPin",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateStaffIdentity",
    "request": {
      "method": "PUT",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/identity",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "name": "Quota fixture",
        "email": "staff@example.test",
        "username": "",
        "expectedVersion": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    "domainSpy": "people.updateIdentity",
    "explicitRouteMfa": true
  },
  {
    "operationId": "getStaffSchedulingProfile",
    "request": {
      "method": "GET",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/scheduling-profile",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.schedulingProfile",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateStaffSchedulingProfile",
    "request": {
      "method": "PUT",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/scheduling-profile",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "skills": [],
        "availability": [],
        "availabilityExceptions": [],
        "expectedVersion": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    "domainSpy": "people.replaceSchedulingProfile",
    "explicitRouteMfa": true
  },
  {
    "operationId": "getStaffInvitation",
    "request": {
      "method": "GET",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/invitation",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.invitation",
    "explicitRouteMfa": false
  },
  {
    "operationId": "retryStaffInvitation",
    "request": {
      "method": "POST",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/invitation/retry",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a"
      }
    },
    "domainSpy": "people.retryInvitation",
    "explicitRouteMfa": true
  },
  {
    "operationId": "reissueStaffInvitation",
    "request": {
      "method": "POST",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/invitation/reissue",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a"
      }
    },
    "domainSpy": "people.reissueInvitation",
    "explicitRouteMfa": true
  },
  {
    "operationId": "resetStaffPin",
    "request": {
      "method": "POST",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/pin/reset",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "pin": "123456"
      }
    },
    "domainSpy": "people.resetPin",
    "explicitRouteMfa": true
  },
  {
    "operationId": "getStaffAccess",
    "request": {
      "method": "GET",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/access",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.access",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateStaffAccess",
    "request": {
      "method": "PUT",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/access",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "roleIds": [
          "2680ed8d-a36a-43ea-b83a-5f4ebf9bea4f"
        ]
      }
    },
    "domainSpy": "people.replaceAccess",
    "explicitRouteMfa": true
  },
  {
    "operationId": "getStaffMember",
    "request": {
      "method": "GET",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.get",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getStaffLifecycle",
    "request": {
      "method": "GET",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/lifecycle",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "people.lifecycle",
    "explicitRouteMfa": true
  },
  {
    "operationId": "setStaffSuspension",
    "request": {
      "method": "PUT",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/lifecycle",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "suspended": true,
        "expectedSuspendedAt": null
      }
    },
    "domainSpy": "people.setSuspended",
    "explicitRouteMfa": true
  },
  {
    "operationId": "deleteStaffMember",
    "request": {
      "method": "DELETE",
      "url": "/v2/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a"
      }
    },
    "domainSpy": "people.remove",
    "explicitRouteMfa": true
  },
  {
    "operationId": "listScheduleSummaries",
    "request": {
      "method": "GET",
      "url": "/v2/schedules",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "operations.listSchedules",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listStaffRoster",
    "request": {
      "method": "GET",
      "url": "/v2/shifts/staff-roster",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "operations.staffRoster",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listShiftSummaries",
    "request": {
      "method": "GET",
      "url": "/v2/shifts",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "operations.listShifts",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listLunchBreakRows",
    "request": {
      "method": "GET",
      "url": "/v2/lunch-breaks",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "lunchBreaks.list",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getLunchBreakPolicy",
    "request": {
      "method": "GET",
      "url": "/v2/lunch-breaks/policy",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "lunchBreaks.policy",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateLunchBreakPolicy",
    "request": {
      "method": "PUT",
      "url": "/v2/lunch-breaks/policy",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "lunchDurationMinutes": 30
      }
    },
    "domainSpy": "lunchBreaks.replacePolicy",
    "explicitRouteMfa": false
  },
  {
    "operationId": "generateLunchBreakPlan",
    "request": {
      "method": "POST",
      "url": "/v2/lunch-breaks/generate",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "locationId": "34aa4812-63f5-4e5c-8b3a-06b564987a1f",
        "shiftIds": [
          "a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068"
        ],
        "persist": true
      }
    },
    "domainSpy": "lunchBreaks.generate",
    "explicitRouteMfa": false
  },
  {
    "operationId": "importLunchBreakShifts",
    "request": {
      "method": "POST",
      "url": "/v2/lunch-breaks/setup-shifts",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "locationId": "34aa4812-63f5-4e5c-8b3a-06b564987a1f",
        "rows": [
          {
            "userId": "f241cd2b-c1be-4a3f-a8e7-bbf2aec70417",
            "startTime": "2026-07-18T16:00:00.000Z",
            "endTime": "2026-07-18T23:00:00.000Z"
          }
        ]
      }
    },
    "domainSpy": "lunchBreaks.setupShifts",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateShiftBreakPlan",
    "request": {
      "method": "PUT",
      "url": "/v2/lunch-breaks/shift/a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "locationId": "34aa4812-63f5-4e5c-8b3a-06b564987a1f",
        "breaks": [
          {
            "type": "lunch",
            "skip": false,
            "startTime": "2026-07-18T20:00:00.000Z",
            "durationMinutes": 30
          }
        ]
      }
    },
    "domainSpy": "lunchBreaks.replaceShiftBreaks",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listNotifications",
    "request": {
      "method": "GET",
      "url": "/v2/notifications",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "notifications.list",
    "explicitRouteMfa": false
  },
  {
    "operationId": "markNotificationRead",
    "request": {
      "method": "POST",
      "url": "/v2/notifications/read",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "ids": [
          "668196db-7db2-4eb7-9808-5cd1a21717b7"
        ]
      }
    },
    "domainSpy": "notifications.markRead",
    "explicitRouteMfa": false
  },
  {
    "operationId": "markAllNotificationsRead",
    "request": {
      "method": "POST",
      "url": "/v2/notifications/read-all",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a"
      }
    },
    "domainSpy": "notifications.markAllRead",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getPayrollExportEntitlement",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/export-entitlement",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.exportEntitlement",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listPayrollPolicies",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/policies",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.listPolicies",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getPayrollPolicy",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/policy",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.latestPolicy",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createPayrollPolicy",
    "request": {
      "method": "PUT",
      "url": "/v2/payroll/policy",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "timeZone": "America/Los_Angeles",
        "cadence": "WEEKLY",
        "anchorDate": "2026-07-20",
        "effectiveFrom": "2026-07-20"
      }
    },
    "domainSpy": "payroll.createPolicy",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listPayrollPeriods",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/periods",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.listPeriods",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createPayrollPeriod",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/periods",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "localStartDate": "2026-07-20"
      }
    },
    "domainSpy": "payroll.createPeriod",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getPayrollPeriod",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.getPeriod",
    "explicitRouteMfa": false
  },
  {
    "operationId": "adoptPayrollTimeCards",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913/adopt",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "cards": [
          {
            "id": "74023f56-a8ca-441f-8d01-afbcb75892d3",
            "expectedRevision": 1
          }
        ]
      }
    },
    "domainSpy": "payroll.adoptCards",
    "explicitRouteMfa": false
  },
  {
    "operationId": "startPayrollReview",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913/review",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "expectedRevision": 4
      }
    },
    "domainSpy": "payroll.startReview",
    "explicitRouteMfa": false
  },
  {
    "operationId": "decidePayrollEntries",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913/decisions",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "decisions": [
          {
            "timeCardId": "74023f56-a8ca-441f-8d01-afbcb75892d3",
            "expectedRevision": 1,
            "decision": "APPROVED",
            "reason": "Quota fixture"
          }
        ]
      }
    },
    "domainSpy": "payroll.decideCards",
    "explicitRouteMfa": false
  },
  {
    "operationId": "lockPayrollPeriod",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913/lock",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "expectedRevision": 4
      }
    },
    "domainSpy": "payroll.lockPeriod",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createPayrollAmendment",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/entries/bdcbf0a0-674c-45d3-a69a-fdb9b28c9b2f/amendments",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "adjustmentPeriodId": "98a5e6c4-41c1-4d06-95df-0a4b0ff3d913",
        "reason": "Quota fixture",
        "replacementClockInAt": "2026-07-18T16:00:00.000Z",
        "replacementClockOutAt": "2026-07-18T23:00:00.000Z",
        "replacementBreakMinutes": 30
      }
    },
    "domainSpy": "payroll.createAmendment",
    "explicitRouteMfa": false
  },
  {
    "operationId": "decidePayrollAmendment",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/amendments/2fef54b7-e51f-4301-8650-e89b9534be5c/decision",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "decision": "APPROVED",
        "reason": "Quota fixture"
      }
    },
    "domainSpy": "payroll.decideAmendment",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createPayrollExport",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/periods/98a5e6c4-41c1-4d06-95df-0a4b0ff3d913/exports",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "expectedCreditCost": 1
      }
    },
    "domainSpy": "payroll.createExport",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getPayrollExport",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/exports/62e5c71b-d3fd-4226-842e-ad84ae79173e",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.getExport",
    "explicitRouteMfa": false
  },
  {
    "operationId": "downloadPayrollExport",
    "request": {
      "method": "GET",
      "url": "/v2/payroll/exports/62e5c71b-d3fd-4226-842e-ad84ae79173e/download",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "payroll.downloadExport",
    "explicitRouteMfa": false
  },
  {
    "operationId": "reconcilePayrollExport",
    "request": {
      "method": "POST",
      "url": "/v2/payroll/exports/62e5c71b-d3fd-4226-842e-ad84ae79173e/reconciliation",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "provider": "fixture-provider",
        "providerEventId": "fixture-event",
        "providerTotalMinutes": 390,
        "outcomes": [
          {
            "lineId": "37ea171d-4e93-4c2c-931d-9c540f00bb98",
            "status": "ACCEPTED"
          }
        ]
      }
    },
    "domainSpy": "payroll.reconcileExport",
    "explicitRouteMfa": false
  },
  {
    "operationId": "listTimeCards",
    "request": {
      "method": "GET",
      "url": "/v2/time-cards",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "timeCards.list",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getActiveTimeCard",
    "request": {
      "method": "GET",
      "url": "/v2/time-cards/active",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "timeCards.active",
    "explicitRouteMfa": false
  },
  {
    "operationId": "clockIn",
    "request": {
      "method": "POST",
      "url": "/v2/time-cards/clock-in",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "locationId": "34aa4812-63f5-4e5c-8b3a-06b564987a1f",
        "shiftId": "a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068"
      }
    },
    "domainSpy": "timeCards.clockIn",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getTimeCard",
    "request": {
      "method": "GET",
      "url": "/v2/time-cards/74023f56-a8ca-441f-8d01-afbcb75892d3",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "timeCards.get",
    "explicitRouteMfa": false
  },
  {
    "operationId": "clockOut",
    "request": {
      "method": "POST",
      "url": "/v2/time-cards/74023f56-a8ca-441f-8d01-afbcb75892d3/clock-out",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "clockOutAt": "2026-07-18T23:00:00.000Z",
        "breakMinutes": 30
      }
    },
    "domainSpy": "timeCards.clockOut",
    "explicitRouteMfa": false
  },
  {
    "operationId": "correctTimeCard",
    "request": {
      "method": "PATCH",
      "url": "/v2/time-cards/74023f56-a8ca-441f-8d01-afbcb75892d3/correction",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "expectedUpdatedAt": "2026-07-18T16:00:00.000Z",
        "reason": "Fixture correction",
        "clockInAt": "2026-07-18T16:00:00.000Z",
        "clockOutAt": "2026-07-18T23:00:00.000Z"
      }
    },
    "domainSpy": "timeCards.correct",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getWorkspaceSettings",
    "request": {
      "method": "GET",
      "url": "/v2/settings",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "settings.get",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateGeneralSettings",
    "request": {
      "method": "PUT",
      "url": "/v2/settings/general",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "name": "Quota fixture"
      }
    },
    "domainSpy": "settings.updateGeneral",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateTeamSettings",
    "request": {
      "method": "PUT",
      "url": "/v2/settings/team",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "defaultInviteRole": "MANAGER",
        "shiftApprovalPolicy": "ADMIN_APPROVAL"
      }
    },
    "domainSpy": "settings.updateTeam",
    "explicitRouteMfa": false
  },
  {
    "operationId": "updateSecuritySettings",
    "request": {
      "method": "PUT",
      "url": "/v2/settings/security",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "requireMfaForAll": false,
        "sessionTimeoutMinutes": 120,
        "ssoOidcOnly": false,
        "oidcIssuerUrl": null
      }
    },
    "domainSpy": "settings.updateSecurity",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getScheduleBoard",
    "request": {
      "method": "GET",
      "url": "/v2/schedule-board?date=2026-07-18&view=day",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "board.get",
    "explicitRouteMfa": false
  },
  {
    "operationId": "createDraftSchedule",
    "request": {
      "method": "POST",
      "url": "/v2/locations/34aa4812-63f5-4e5c-8b3a-06b564987a1f/schedules",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "startDate": "2026-07-18T00:00:00.000Z",
        "endDate": "2026-07-19T00:00:00.000Z"
      }
    },
    "domainSpy": "scheduleCreate.create",
    "explicitRouteMfa": false
  },
  {
    "operationId": "applyScheduleChangeSet",
    "request": {
      "method": "POST",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/change-sets",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json",
        "if-match": "\"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4\""
      },
      "payload": {
        "operations": [
          {
            "op": "shift.delete",
            "shiftId": "2fef54b7-e51f-4301-8650-e89b9534be5c"
          },
          {
            "op": "shift.update",
            "shiftId": "a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068",
            "userId": "f241cd2b-c1be-4a3f-a8e7-bbf2aec70417",
            "startTime": "2026-07-18T16:00:00.000Z",
            "endTime": "2026-07-18T23:00:00.000Z",
            "role": "STAFF"
          }
        ]
      }
    },
    "domainSpy": "changeSets.apply",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getScheduleDemandWindows",
    "request": {
      "method": "GET",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/demand-windows",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": "demandWindows.list",
    "explicitRouteMfa": false
  },
  {
    "operationId": "replaceScheduleDemandWindows",
    "request": {
      "method": "PUT",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/demand-windows",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json",
        "if-match": "\"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4\""
      },
      "payload": {
        "windows": []
      }
    },
    "domainSpy": "demandWindows.replace",
    "explicitRouteMfa": false
  },
  {
    "operationId": "reopenSchedule",
    "request": {
      "method": "POST",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/reopenings",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "if-match": "\"schedule:88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e:4\""
      }
    },
    "domainSpy": "lifecycle.reopen",
    "explicitRouteMfa": false
  },
  {
    "operationId": "generateScheduleBreaks",
    "request": {
      "method": "POST",
      "url": "/v2/break-generations",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "locationId": "34aa4812-63f5-4e5c-8b3a-06b564987a1f",
        "shiftIds": [
          "a49bc1a3-f1f2-4d6d-8b8c-c2c8ab481068"
        ],
        "persist": true
      }
    },
    "domainSpy": "lunchBreaks.generate",
    "explicitRouteMfa": false
  },
  {
    "operationId": "getCurrentSession",
    "request": {
      "method": "GET",
      "url": "/v2/auth/me",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "domainSpy": null,
    "explicitRouteMfa": false
  }
] as const;

// Generic retained payloads exercise ingress routing only, not retained business validity.
const retainedQuotaHttpFixtures = [
  {
    "operationId": "prepareAccountDeletionReceipt",
    "request": {
      "method": "POST",
      "url": "/v2/account-deletion/prepare",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "readAccountDeletionReceipt",
    "request": {
      "method": "POST",
      "url": "/v2/account-deletion/receipt",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "resolveLoginMethod",
    "request": {
      "method": "POST",
      "url": "/v2/auth/login/resolve",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "verifyPasswordLogin",
    "request": {
      "method": "POST",
      "url": "/v2/auth/password/verify",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "requestPasswordReset",
    "request": {
      "method": "POST",
      "url": "/v2/auth/password/reset/request",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "confirmPasswordReset",
    "request": {
      "method": "POST",
      "url": "/v2/auth/password/reset/confirm",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "startOidcLogin",
    "request": {
      "method": "GET",
      "url": "/v2/auth/login",
      "headers": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "completeOidcLogin",
    "request": {
      "method": "GET",
      "url": "/v2/auth/callback",
      "headers": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "sendEmailLoginCode",
    "request": {
      "method": "POST",
      "url": "/v2/auth/email/send-otp",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "verifyEmailLoginCode",
    "request": {
      "method": "POST",
      "url": "/v2/auth/email/verify-otp",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "verifyPinLogin",
    "request": {
      "method": "POST",
      "url": "/v2/auth/pin/verify",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "refreshSession",
    "request": {
      "method": "POST",
      "url": "/v2/auth/refresh",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "getMfaEnrollment",
    "request": {
      "method": "GET",
      "url": "/v2/auth/mfa/enrollment",
      "headers": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "startMfaEnrollment",
    "request": {
      "method": "POST",
      "url": "/v2/auth/mfa/enrollment",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "confirmMfaEnrollment",
    "request": {
      "method": "PUT",
      "url": "/v2/auth/mfa/enrollment",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "deleteMfaEnrollment",
    "request": {
      "method": "DELETE",
      "url": "/v2/auth/mfa/enrollment",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "verifyMfaChallenge",
    "request": {
      "method": "POST",
      "url": "/v2/auth/mfa/verify",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "deleteSession",
    "request": {
      "method": "POST",
      "url": "/v2/auth/logout",
      "headers": {
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 0
  },
  {
    "operationId": "getBillingFeatures",
    "request": {
      "method": "GET",
      "url": "/v2/billing/features",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getSubscriptionRecoveryAction",
    "request": {
      "method": "GET",
      "url": "/v2/billing/subscription-recovery-action",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listBillingPriceOptions",
    "request": {
      "method": "GET",
      "url": "/v2/billing/price-options",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listCreditPacks",
    "request": {
      "method": "GET",
      "url": "/v2/billing/credit-packs",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createCreditPackCheckout",
    "request": {
      "method": "POST",
      "url": "/v2/billing/credit-packs/checkout",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createSubscriptionCheckout",
    "request": {
      "method": "POST",
      "url": "/v2/billing/subscribe",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createBillingPortalSession",
    "request": {
      "method": "POST",
      "url": "/v2/billing/portal",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "changeSubscriptionPlan",
    "request": {
      "method": "POST",
      "url": "/v2/billing/change-plan",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "resumeSubscription",
    "request": {
      "method": "POST",
      "url": "/v2/billing/resume",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createAvailabilityImport",
    "request": {
      "method": "POST",
      "url": "/v2/availability-imports/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "cancelAvailabilityImport",
    "request": {
      "method": "POST",
      "url": "/v2/availability-imports/6e465894-106a-492b-aef0-29f4d9b4a6b5/cancel",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getAvailabilityImport",
    "request": {
      "method": "GET",
      "url": "/v2/availability-imports/6e465894-106a-492b-aef0-29f4d9b4a6b5",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getAdminStats",
    "request": {
      "method": "GET",
      "url": "/v2/admin/stats",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listAdminTenants",
    "request": {
      "method": "GET",
      "url": "/v2/admin/tenants",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createAdminTenant",
    "request": {
      "method": "POST",
      "url": "/v2/admin/tenants",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "updateAdminTenant",
    "request": {
      "method": "PUT",
      "url": "/v2/admin/tenants/21e7ae71-3838-4a20-8c6d-53d7ee02ab9a",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "suspendAdminTenant",
    "request": {
      "method": "POST",
      "url": "/v2/admin/tenants/21e7ae71-3838-4a20-8c6d-53d7ee02ab9a/suspend",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "activateAdminTenant",
    "request": {
      "method": "POST",
      "url": "/v2/admin/tenants/21e7ae71-3838-4a20-8c6d-53d7ee02ab9a/activate",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "archiveAdminTenant",
    "request": {
      "method": "POST",
      "url": "/v2/admin/tenants/21e7ae71-3838-4a20-8c6d-53d7ee02ab9a/archive",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "restoreAdminTenant",
    "request": {
      "method": "POST",
      "url": "/v2/admin/tenants/21e7ae71-3838-4a20-8c6d-53d7ee02ab9a/restore",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "deleteAdminTenant",
    "request": {
      "method": "DELETE",
      "url": "/v2/admin/tenants/21e7ae71-3838-4a20-8c6d-53d7ee02ab9a",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createAccountExport",
    "request": {
      "method": "POST",
      "url": "/v2/admin/account/export",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listAccountExports",
    "request": {
      "method": "GET",
      "url": "/v2/admin/account/exports",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getAccountExport",
    "request": {
      "method": "GET",
      "url": "/v2/admin/account/exports/250c2b7c-8418-4191-9413-21f08723fda8",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "downloadAccountExport",
    "request": {
      "method": "GET",
      "url": "/v2/admin/account/exports/250c2b7c-8418-4191-9413-21f08723fda8/download",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getAccountLifecycleStatus",
    "request": {
      "method": "GET",
      "url": "/v2/admin/account/status",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "cancelAccountRenewal",
    "request": {
      "method": "POST",
      "url": "/v2/admin/account/cancel",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "deleteTenantAccount",
    "request": {
      "method": "DELETE",
      "url": "/v2/admin/account",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listAdminUsers",
    "request": {
      "method": "GET",
      "url": "/v2/admin/users",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "updateAdminUser",
    "request": {
      "method": "PUT",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "resetAdminUserPin",
    "request": {
      "method": "POST",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/pin/reset",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "resetAdminUserMfa",
    "request": {
      "method": "POST",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/mfa/reset",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "lockAdminUser",
    "request": {
      "method": "POST",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/lock",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "unlockAdminUser",
    "request": {
      "method": "POST",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/unlock",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "suspendAdminUser",
    "request": {
      "method": "POST",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/suspend",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "activateAdminUser",
    "request": {
      "method": "POST",
      "url": "/v2/admin/users/f241cd2b-c1be-4a3f-a8e7-bbf2aec70417/activate",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listAdminAudit",
    "request": {
      "method": "GET",
      "url": "/v2/admin/audit",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getAdminCredits",
    "request": {
      "method": "GET",
      "url": "/v2/admin/credits",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "grantAdminCredits",
    "request": {
      "method": "POST",
      "url": "/v2/admin/credits/grant",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "listAdminPlans",
    "request": {
      "method": "GET",
      "url": "/v2/admin/plans",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "createAdminPlan",
    "request": {
      "method": "POST",
      "url": "/v2/admin/plans",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "updateAdminPlan",
    "request": {
      "method": "PUT",
      "url": "/v2/admin/plans/STARTER",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "deleteAdminPlan",
    "request": {
      "method": "DELETE",
      "url": "/v2/admin/plans/STARTER",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {}
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getAdminHealth",
    "request": {
      "method": "GET",
      "url": "/v2/admin/health",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedApplication.execute",
    "bridgeMockResponse": {
      "ok": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "getSchedulePublishPlan",
    "request": {
      "method": "GET",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/publish-plan",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedScheduling.publishPlan",
    "bridgeMockResponse": {
      "totalConfiguredCost": 1,
      "scheduleCost": 1,
      "matchingWebhookDeliveryCount": 0,
      "matchingWebhookDeliveryUnitCost": 0,
      "matchingWebhookDeliveryCost": 0,
      "scheduleId": "88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e",
      "acceptedContract": {
        "totalConfiguredCost": 1,
        "scheduleCost": 1,
        "matchingWebhookDeliveryCount": 0,
        "matchingWebhookDeliveryUnitCost": 0,
        "matchingWebhookDeliveryCost": 0,
        "version": 4
      },
      "availableCredits": 10,
      "sufficientCredits": true
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "publishSchedule",
    "request": {
      "method": "POST",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/publications",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "acceptedContract": {
          "totalConfiguredCost": 1,
          "scheduleCost": 1,
          "matchingWebhookDeliveryCount": 0,
          "matchingWebhookDeliveryUnitCost": 0,
          "matchingWebhookDeliveryCost": 0,
          "version": 4
        }
      }
    },
    "bridgeSpy": "retainedScheduling.publish",
    "bridgeMockResponse": {
      "id": "88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e",
      "status": "PUBLISHED",
      "publishedAt": "2026-07-18T16:00:00.000Z",
      "settlement": {
        "totalConfiguredCost": 1,
        "scheduleCost": 1,
        "matchingWebhookDeliveryCount": 0,
        "matchingWebhookDeliveryUnitCost": 0,
        "matchingWebhookDeliveryCost": 0,
        "acceptedContract": {
          "totalConfiguredCost": 1,
          "scheduleCost": 1,
          "matchingWebhookDeliveryCount": 0,
          "matchingWebhookDeliveryUnitCost": 0,
          "matchingWebhookDeliveryCost": 0,
          "version": 4
        },
        "creditsConsumed": 1,
        "newBalance": 9,
        "ledgerIdentities": {
          "schedule": "fixture-schedule-ledger",
          "webhookDeliveries": []
        }
      },
      "notifications": {
        "status": "NOT_REQUIRED",
        "delivered": 0,
        "pending": 0,
        "failed": 0
      }
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  },
  {
    "operationId": "startScheduleSolve",
    "request": {
      "method": "POST",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/solve-jobs",
      "headers": {
        "cookie": "access_token=test; csrf_token=abcdefghijklmnop",
        "origin": "https://beta.lunchlineup.com",
        "x-csrf-token": "abcdefghijklmnop",
        "idempotency-key": "4daaf25a-92d7-4fba-975c-f54e4ce15c4a",
        "content-type": "application/json"
      },
      "payload": {
        "constraints": {},
        "confirmReplace": false
      }
    },
    "bridgeSpy": "retainedScheduling.startSolve",
    "bridgeMockResponse": {
      "jobId": "250c2b7c-8418-4191-9413-21f08723fda8",
      "status": "QUEUED",
      "statusUrl": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/solve-jobs/250c2b7c-8418-4191-9413-21f08723fda8"
    },
    "expectedStatus": 202,
    "authenticateCalls": 1
  },
  {
    "operationId": "getScheduleSolveJob",
    "request": {
      "method": "GET",
      "url": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/solve-jobs/250c2b7c-8418-4191-9413-21f08723fda8",
      "headers": {
        "cookie": "access_token=test"
      }
    },
    "bridgeSpy": "retainedScheduling.solveJob",
    "bridgeMockResponse": {
      "jobId": "250c2b7c-8418-4191-9413-21f08723fda8",
      "scheduleId": "88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e",
      "locationId": "34aa4812-63f5-4e5c-8b3a-06b564987a1f",
      "status": "QUEUED",
      "statusReason": null,
      "retryCount": 0,
      "resultShiftCount": null,
      "publicationStatus": "DRAFT",
      "startedAt": null,
      "completedAt": null,
      "statusUrl": "/v2/schedules/88d8d86a-7e8d-4246-8ad3-eb7eedb44c1e/solve-jobs/250c2b7c-8418-4191-9413-21f08723fda8"
    },
    "expectedStatus": 200,
    "authenticateCalls": 1
  }
] as const;

const quotaPermissionDenials = [
  {
    "caseId": "0:listLocations:locations:read",
    "operationId": "listLocations",
    "permissions": [
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "1:createLocation:locations:write",
    "operationId": "createLocation",
    "permissions": [
      "locations:read",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "2:getLocationSummary:locations:read",
    "operationId": "getLocationSummary",
    "permissions": [
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "3:getLocation:locations:read",
    "operationId": "getLocation",
    "permissions": [
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "4:updateLocation:locations:write",
    "operationId": "updateLocation",
    "permissions": [
      "locations:read",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "5:deleteLocation:locations:delete",
    "operationId": "deleteLocation",
    "permissions": [
      "locations:read",
      "locations:write",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "6:listStaffMembers:users:read",
    "operationId": "listStaffMembers",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "7:getAccessCatalog:roles:read",
    "operationId": "getAccessCatalog",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "8:createStaffInvitation:users:write",
    "operationId": "createStaffInvitation",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "9:createAccessRole:roles:write",
    "operationId": "createAccessRole",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "10:updateAccessRole:roles:write",
    "operationId": "updateAccessRole",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "11:deleteAccessRole:roles:write",
    "operationId": "deleteAccessRole",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "12:updateStaffIdentity:users:admin",
    "operationId": "updateStaffIdentity",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "13:getStaffSchedulingProfile:users:read",
    "operationId": "getStaffSchedulingProfile",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "14:updateStaffSchedulingProfile:users:write",
    "operationId": "updateStaffSchedulingProfile",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "15:getStaffInvitation:users:admin",
    "operationId": "getStaffInvitation",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "16:retryStaffInvitation:users:admin",
    "operationId": "retryStaffInvitation",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "17:reissueStaffInvitation:users:admin",
    "operationId": "reissueStaffInvitation",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "18:resetStaffPin:users:admin",
    "operationId": "resetStaffPin",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "19:getStaffAccess:roles:read",
    "operationId": "getStaffAccess",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "20:updateStaffAccess:roles:assign",
    "operationId": "updateStaffAccess",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "21:getStaffMember:users:read",
    "operationId": "getStaffMember",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "22:getStaffLifecycle:users:admin",
    "operationId": "getStaffLifecycle",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "23:setStaffSuspension:users:admin",
    "operationId": "setStaffSuspension",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "24:deleteStaffMember:users:admin",
    "operationId": "deleteStaffMember",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "25:listScheduleSummaries:schedules:read",
    "operationId": "listScheduleSummaries",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "26:listStaffRoster:shifts:read",
    "operationId": "listStaffRoster",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "27:listShiftSummaries:shifts:read",
    "operationId": "listShiftSummaries",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "28:listLunchBreakRows:lunch_breaks:read",
    "operationId": "listLunchBreakRows",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "29:getLunchBreakPolicy:lunch_breaks:read",
    "operationId": "getLunchBreakPolicy",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "30:updateLunchBreakPolicy:lunch_breaks:write",
    "operationId": "updateLunchBreakPolicy",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "31:generateLunchBreakPlan:lunch_breaks:write",
    "operationId": "generateLunchBreakPlan",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "32:importLunchBreakShifts:lunch_breaks:write",
    "operationId": "importLunchBreakShifts",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "33:importLunchBreakShifts:shifts:write",
    "operationId": "importLunchBreakShifts",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "34:updateShiftBreakPlan:lunch_breaks:write",
    "operationId": "updateShiftBreakPlan",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "35:listNotifications:notifications:read",
    "operationId": "listNotifications",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "36:markNotificationRead:notifications:write",
    "operationId": "markNotificationRead",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "37:markAllNotificationsRead:notifications:write",
    "operationId": "markAllNotificationsRead",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "38:getPayrollExportEntitlement:payroll:export",
    "operationId": "getPayrollExportEntitlement",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "39:listPayrollPolicies:payroll:read",
    "operationId": "listPayrollPolicies",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "40:getPayrollPolicy:payroll:read",
    "operationId": "getPayrollPolicy",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "41:createPayrollPolicy:payroll:policy_write",
    "operationId": "createPayrollPolicy",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "42:listPayrollPeriods:payroll:read",
    "operationId": "listPayrollPeriods",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "43:createPayrollPeriod:payroll:policy_write",
    "operationId": "createPayrollPeriod",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "44:getPayrollPeriod:payroll:read",
    "operationId": "getPayrollPeriod",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "45:adoptPayrollTimeCards:payroll:policy_write",
    "operationId": "adoptPayrollTimeCards",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "46:startPayrollReview:payroll:lock",
    "operationId": "startPayrollReview",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "47:decidePayrollEntries:time_cards:approve",
    "operationId": "decidePayrollEntries",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "48:lockPayrollPeriod:payroll:lock",
    "operationId": "lockPayrollPeriod",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "49:createPayrollAmendment:payroll:reconcile",
    "operationId": "createPayrollAmendment",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "50:decidePayrollAmendment:time_cards:approve",
    "operationId": "decidePayrollAmendment",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "51:createPayrollExport:payroll:export",
    "operationId": "createPayrollExport",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "52:getPayrollExport:payroll:read",
    "operationId": "getPayrollExport",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "53:downloadPayrollExport:payroll:export",
    "operationId": "downloadPayrollExport",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "54:reconcilePayrollExport:payroll:reconcile",
    "operationId": "reconcilePayrollExport",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "55:listTimeCards:time_cards:read",
    "operationId": "listTimeCards",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "56:getActiveTimeCard:time_cards:read",
    "operationId": "getActiveTimeCard",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "57:clockIn:time_cards:write",
    "operationId": "clockIn",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "58:getTimeCard:time_cards:read",
    "operationId": "getTimeCard",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "59:clockOut:time_cards:write",
    "operationId": "clockOut",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "60:correctTimeCard:time_cards:write",
    "operationId": "correctTimeCard",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "61:getWorkspaceSettings:settings:read",
    "operationId": "getWorkspaceSettings",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:write"
    ]
  },
  {
    "caseId": "62:updateGeneralSettings:settings:write",
    "operationId": "updateGeneralSettings",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read"
    ]
  },
  {
    "caseId": "63:updateTeamSettings:settings:write",
    "operationId": "updateTeamSettings",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read"
    ]
  },
  {
    "caseId": "64:updateSecuritySettings:settings:write",
    "operationId": "updateSecuritySettings",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read"
    ]
  },
  {
    "caseId": "65:getScheduleBoard:locations:read",
    "operationId": "getScheduleBoard",
    "permissions": [
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "66:getScheduleBoard:schedules:read",
    "operationId": "getScheduleBoard",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "67:getScheduleBoard:shifts:read",
    "operationId": "getScheduleBoard",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "68:createDraftSchedule:schedules:write,shifts:write",
    "operationId": "createDraftSchedule",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:publish",
      "shifts:read",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "69:applyScheduleChangeSet:shifts:delete",
    "operationId": "applyScheduleChangeSet",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "70:applyScheduleChangeSet:shifts:write",
    "operationId": "applyScheduleChangeSet",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "71:getScheduleDemandWindows:schedules:write",
    "operationId": "getScheduleDemandWindows",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "72:replaceScheduleDemandWindows:schedules:write",
    "operationId": "replaceScheduleDemandWindows",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "73:reopenSchedule:schedules:publish",
    "operationId": "reopenSchedule",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "lunch_breaks:write",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  },
  {
    "caseId": "74:generateScheduleBreaks:lunch_breaks:write",
    "operationId": "generateScheduleBreaks",
    "permissions": [
      "locations:read",
      "locations:write",
      "locations:delete",
      "schedules:read",
      "schedules:write",
      "schedules:publish",
      "shifts:read",
      "shifts:write",
      "shifts:delete",
      "lunch_breaks:read",
      "time_cards:read",
      "time_cards:write",
      "time_cards:approve",
      "payroll:read",
      "payroll:policy_write",
      "payroll:lock",
      "payroll:export",
      "payroll:reconcile",
      "users:read",
      "users:write",
      "users:admin",
      "roles:read",
      "roles:write",
      "roles:assign",
      "notifications:read",
      "notifications:write",
      "settings:read",
      "settings:write"
    ]
  }
] as const;

type QuotaHttpHarness = Awaited<ReturnType<typeof harness>>;

function quotaBoundarySpies(h: QuotaHttpHarness) {
  const groups = {
    locations: h.locations, people: h.people, operations: h.operations,
    lunchBreaks: h.lunchBreaks, notifications: h.notifications, payroll: h.payroll,
    timeCards: h.timeCards, settings: h.settings, scheduleCreate: h.scheduleCreate,
    retainedScheduling: h.retainedScheduling, retainedOperators: h.retainedOperators,
    board: { get: h.board }, changeSets: { apply: h.apply },
    demandWindows: { list: h.demandList, replace: h.demandReplace },
    lifecycle: { reopen: h.reopen }, retainedApplication: { execute: h.retainedApplication },
  };
  const spies = new Map<string, unknown>();
  for (const [groupName, group] of Object.entries(groups)) {
    for (const [methodName, candidate] of Object.entries(group)) {
      if (!vi.isMockFunction(candidate)) throw new Error('Non-mock boundary: ' + groupName + '.' + methodName);
      spies.set(groupName + '.' + methodName, candidate);
    }
  }
  return spies;
}

function quotaBoundarySpy(h: QuotaHttpHarness, path: string) {
  const spy = quotaBoundarySpies(h).get(path);
  if (!vi.isMockFunction(spy)) throw new Error('Missing quota boundary spy: ' + path);
  return spy;
}

function expectNoQuotaDomainCalls(h: QuotaHttpHarness, except?: string) {
  for (const [path, spy] of quotaBoundarySpies(h)) {
    if (path !== except) expect(spy, path).not.toHaveBeenCalled();
  }
}

function nativeQuotaFixture(operationId: string) {
  const fixture = nativeQuotaHttpFixtures.find((row) => row.operationId === operationId);
  if (!fixture) throw new Error('Missing HTTP fixture: ' + operationId);
  return fixture;
}

function rejectQuota(h: QuotaHttpHarness) {
  h.quota.consume.mockImplementationOnce(async (_operation, _actor, reply) => {
    reply.header('Retry-After', '17');
    throw new ProblemError(429, 'rate_limited', 'Too many requests.', 'Too many requests', undefined, undefined, {
      retryAfterSeconds: 17,
    });
  });
}

describe('complete native quota HTTP dispatch regression draft', () => {
  it.each(nativeQuotaHttpFixtures)('denies $operationId before any domain dispatch', async (fixture) => {
    const h = await harness();
    try {
      rejectQuota(h);
      const response = await h.app.inject(fixture.request);
      expect(response.statusCode).toBe(429);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['retry-after']).toBe('17');
      expect(response.json()).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 17 });
      expect(response.json().user).toBeUndefined();
      expect(h.authenticate).toHaveBeenCalledOnce();
      expect(h.quota.consume).toHaveBeenCalledOnce();
      expect(h.quota.consume).toHaveBeenCalledWith(fixture.operationId, identity, expect.anything());
      expect(h.quota.consume.mock.calls[0][1]).toBe(identity);
      expectNoQuotaDomainCalls(h);
    } finally {
      await h.app.close();
    }
  });

  it.each(nativeQuotaHttpFixtures)('allows $operationId only after quota settles', async (fixture) => {
    const h = await harness();
    let quotaSettled = false;
    try {
      h.quota.consume.mockImplementationOnce(async () => { quotaSettled = true; });
      if (fixture.domainSpy) {
        quotaBoundarySpy(h, fixture.domainSpy).mockImplementationOnce(async () => {
          expect(quotaSettled).toBe(true);
          throw new ProblemError(409, 'domain_entered', 'Domain boundary reached.', 'Domain boundary');
        });
      }
      const response = await h.app.inject(fixture.request);
      expect(h.quota.consume).toHaveBeenCalledOnce();
      expect(h.quota.consume).toHaveBeenCalledWith(fixture.operationId, identity, expect.anything());
      expect(quotaSettled).toBe(true);
      if (fixture.domainSpy) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ status: 409, code: 'domain_entered' });
        const domain = quotaBoundarySpy(h, fixture.domainSpy);
        expect(domain).toHaveBeenCalledOnce();
        expect(domain.mock.invocationCallOrder[0]).toBeGreaterThan(h.quota.consume.mock.invocationCallOrder[0]);
      } else {
        expect(response.statusCode).toBe(200);
        expect(response.json().user.publicUserId).toBe(identity.publicUserId);
      }
      expectNoQuotaDomainCalls(h, fixture.domainSpy ?? undefined);
    } finally {
      await h.app.close();
    }
  });

  it.each(quotaPermissionDenials)('rejects pure permission variant $caseId before quota', async (denial) => {
    const actor = { ...identity, permissions: [...denial.permissions] };
    const h = await harness(actor);
    try {
      const response = await h.app.inject(nativeQuotaFixture(denial.operationId).request);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('permission_denied');
      expect(h.authenticate).toHaveBeenCalledOnce();
      expect(h.quota.consume).not.toHaveBeenCalled();
      expectNoQuotaDomainCalls(h);
    } finally {
      await h.app.close();
    }
  });

  for (const failure of [
    { status: 401, code: 'authentication_required' },
    { status: 503, code: 'identity_service_unavailable' },
  ]) {
    it.each(nativeQuotaHttpFixtures)('rejects ' + failure.code + ' for $operationId before quota', async (fixture) => {
      const h = await harness();
      try {
        h.authenticate.mockRejectedValueOnce(new ProblemError(failure.status, failure.code, 'Identity unavailable.', 'Identity'));
        const response = await h.app.inject(fixture.request);
        expect(response.statusCode).toBe(failure.status);
        expect(response.json().code).toBe(failure.code);
        expect(h.authenticate).toHaveBeenCalledOnce();
        expect(h.quota.consume).not.toHaveBeenCalled();
        expectNoQuotaDomainCalls(h);
      } finally {
        await h.app.close();
      }
    });
  }

  for (const securityFailure of ['origin_not_allowed', 'csrf_validation_failed'] as const) {
    it.each(nativeQuotaHttpFixtures.filter((row) => !['GET', 'HEAD', 'OPTIONS'].includes(row.request.method)))
      ('rejects ' + securityFailure + ' for $operationId before authentication and quota', async (fixture) => {
        const h = await harness();
        try {
          const headers: Record<string, string> = { ...fixture.request.headers };
          if (securityFailure === 'origin_not_allowed') delete headers.origin;
          else headers['x-csrf-token'] = 'ponmlkjihgfedcba';
          const response = await h.app.inject({ ...fixture.request, headers });
          expect(response.statusCode).toBe(403);
          expect(response.json().code).toBe(securityFailure);
          expect(h.authenticate).not.toHaveBeenCalled();
          expect(h.quota.consume).not.toHaveBeenCalled();
          expectNoQuotaDomainCalls(h);
        } finally {
          await h.app.close();
        }
      });
  }

  it.each(nativeQuotaHttpFixtures.filter((row) => row.explicitRouteMfa))
    ('rejects the explicit People MFA gate for $operationId before quota', async (fixture) => {
      const actor = { ...identity, mfaRequired: true, mfaVerified: false };
      const h = await harness(actor);
      try {
        const response = await h.app.inject(fixture.request);
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('mfa_verification_required');
        expect(h.quota.consume).not.toHaveBeenCalled();
        expectNoQuotaDomainCalls(h);
      } finally {
        await h.app.close();
      }
    });

  it.each(retainedQuotaHttpFixtures)('keeps $operationId quota ownership downstream', async (fixture) => {
    const h = await harness();
    try {
      const bridge = quotaBoundarySpy(h, fixture.bridgeSpy);
      bridge.mockResolvedValueOnce(fixture.bridgeMockResponse);
      const response = await h.app.inject(fixture.request);
      expect(response.statusCode).toBe(fixture.expectedStatus);
      expect(h.quota.consume).not.toHaveBeenCalled();
      expect(h.authenticate).toHaveBeenCalledTimes(fixture.authenticateCalls);
      expect(bridge).toHaveBeenCalledOnce();
      if (fixture.bridgeSpy === 'retainedApplication.execute') {
        expect(bridge.mock.calls[0][0].operation.operationId).toBe(fixture.operationId);
        expect(bridge.mock.calls[0][0].identity).toBe(fixture.authenticateCalls === 1 ? identity : undefined);
      }
      expectNoQuotaDomainCalls(h, fixture.bridgeSpy);
    } finally {
      await h.app.close();
    }
  });

  it.each(['getCurrentSession', 'replaceCurrentPin'] as const)
    ('preserves mandatory PIN and MFA recovery for %s when quota allows', async (operationId) => {
      const actor = { ...identity, permissions: [], pinResetRequired: true, mfaRequired: true, mfaVerified: false };
      const h = await harness(actor);
      try {
        const fixture = nativeQuotaFixture(operationId);
        const response = await h.app.inject(fixture.request);
        expect(response.statusCode).toBe(200);
        expect(h.quota.consume).toHaveBeenCalledOnce();
        expect(h.quota.consume.mock.calls[0][1]).toBe(actor);
        if (operationId === 'getCurrentSession') {
          expect(response.json().user).toMatchObject({ pinResetRequired: true, mfaRequired: true, mfaVerified: false });
          expectNoQuotaDomainCalls(h);
        } else {
          expect(response.json()).toEqual({ success: true });
          expect(h.people.replaceOwnPin).toHaveBeenCalledOnce();
          expectNoQuotaDomainCalls(h, 'people.replaceOwnPin');
        }
      } finally {
        await h.app.close();
      }
    });

  it.each(['getCurrentSession', 'replaceCurrentPin'] as const)
    ('applies quota denial to mandatory recovery %s without leaking user data', async (operationId) => {
      const actor = { ...identity, permissions: [], pinResetRequired: true, mfaRequired: true, mfaVerified: false };
      const h = await harness(actor);
      try {
        rejectQuota(h);
        const response = await h.app.inject(nativeQuotaFixture(operationId).request);
        expect(response.statusCode).toBe(429);
        expect(response.json().code).toBe('rate_limited');
        expect(response.json().user).toBeUndefined();
        expect(h.quota.consume).toHaveBeenCalledOnce();
        expect(h.quota.consume.mock.calls[0][1]).toBe(actor);
        expectNoQuotaDomainCalls(h);
      } finally {
        await h.app.close();
      }
    });
});

async function quotaFixtureDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Quota fixture deadline: ' + label)), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('pending quota settlement before native dispatch', () => {
  for (const result of ['allow', 'deny'] as const) {
    it.each(nativeQuotaHttpFixtures)('waits for pending ' + result + ' quota on $operationId', async (fixture) => {
      const h = await harness();
      let enter!: () => void;
      let allow!: () => void;
      let deny!: (reason: Error) => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const pending = new Promise<void>((resolve, reject) => { allow = resolve; deny = reject; });
      let quotaSettled = false;
      let request: Promise<LightMyRequestResponse> | undefined;
      try {
        h.quota.consume.mockImplementationOnce(async (_operation, _actor, reply) => {
          reply.header('Retry-After', '17');
          enter();
          await pending;
          quotaSettled = true;
        });
        if (fixture.domainSpy) {
          quotaBoundarySpy(h, fixture.domainSpy).mockImplementationOnce(async () => {
            expect(quotaSettled).toBe(true);
            throw new ProblemError(409, 'domain_entered', 'Domain boundary reached.', 'Domain boundary');
          });
        }
        request = h.app.inject(fixture.request);
        await quotaFixtureDeadline(Promise.race([
          entered,
          request.then(() => { throw new Error('Request settled before quota entered.'); }),
        ]), 'quota entry');
        // No release yet: invocation ordering alone cannot satisfy this oracle.
        expect(quotaSettled).toBe(false);
        expectNoQuotaDomainCalls(h);
        expect(h.quota.consume).toHaveBeenCalledOnce();
        expect(h.quota.consume.mock.calls[0][1]).toBe(identity);
        if (result === 'allow') allow();
        else deny(new ProblemError(429, 'rate_limited', 'Too many requests.', 'Too many requests',
          undefined, undefined, { retryAfterSeconds: 17 }));
        const response = await quotaFixtureDeadline(request, 'request settlement');
        if (result === 'deny') {
          expect(response.statusCode).toBe(429);
          expect(response.json()).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 17 });
          expect(response.headers['retry-after']).toBe('17');
          expect(quotaSettled).toBe(false);
          expectNoQuotaDomainCalls(h);
        } else {
          expect(quotaSettled).toBe(true);
          if (fixture.domainSpy) {
            expect(response.statusCode).toBe(409);
            expect(response.json().code).toBe('domain_entered');
            expect(quotaBoundarySpy(h, fixture.domainSpy)).toHaveBeenCalledOnce();
          } else {
            expect(response.statusCode).toBe(200);
            expect(response.json().user.publicUserId).toBe(identity.publicUserId);
          }
          expectNoQuotaDomainCalls(h, fixture.domainSpy ?? undefined);
        }
      } finally {
        // Own and release the only held fixture promise even when an assertion fails.
        // Timeout is evidence of failure; it does not cancel arbitrary application work.
        allow();
        try {
          if (request !== undefined) await quotaFixtureDeadline(request, 'cleanup request settlement');
        } finally {
          await quotaFixtureDeadline(h.app.close(), 'app close');
        }
      }
    }, 30_000);
  }
});

describe('quota preserves actual helper permission and factor gates', () => {
  it.each(['schedules:write', 'shifts:write'] as const)
    ('accepts either create-draft permission %s independently before quota', async (permission) => {
      const actor = { ...identity, permissions: [permission] };
      const h = await harness(actor);
      try {
        rejectQuota(h);
        const response = await h.app.inject(nativeQuotaFixture('createDraftSchedule').request);
        expect(response.statusCode).toBe(429);
        expect(response.json().code).toBe('rate_limited');
        expect(h.quota.consume).toHaveBeenCalledOnce();
        expect(h.quota.consume).toHaveBeenCalledWith('createDraftSchedule', actor, expect.anything());
        expectNoQuotaDomainCalls(h);
      } finally {
        await h.app.close();
      }
    });

  const factorGateOperations = [
  "listScheduleSummaries",
  "listStaffRoster",
  "listShiftSummaries",
  "listLunchBreakRows",
  "getLunchBreakPolicy",
  "updateLunchBreakPolicy",
  "generateLunchBreakPlan",
  "importLunchBreakShifts",
  "updateShiftBreakPlan",
  "listTimeCards",
  "getActiveTimeCard",
  "clockIn",
  "getTimeCard",
  "clockOut",
  "correctTimeCard",
  "getScheduleBoard",
  "createDraftSchedule",
  "applyScheduleChangeSet",
  "getScheduleDemandWindows",
  "replaceScheduleDemandWindows",
  "reopenSchedule",
  "generateScheduleBreaks"
] as const;
  for (const failure of [
    { code: 'pin_rotation_required', pinResetRequired: true, mfaVerified: false },
    { code: 'mfa_verification_required', pinResetRequired: false, mfaVerified: false },
  ]) {
    it.each(factorGateOperations)('rejects ' + failure.code + ' for %s before quota', async (operationId) => {
      const actor = { ...identity, pinResetRequired: failure.pinResetRequired, mfaRequired: true, mfaVerified: failure.mfaVerified };
      const h = await harness(actor);
      try {
        const response = await h.app.inject(nativeQuotaFixture(operationId).request);
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe(failure.code);
        expect(h.authenticate).toHaveBeenCalledOnce();
        expect(h.quota.consume).not.toHaveBeenCalled();
        expectNoQuotaDomainCalls(h);
      } finally {
        await h.app.close();
      }
    });
  }
});
