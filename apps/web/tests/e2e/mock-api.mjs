import crypto from 'node:crypto';
import http from 'node:http';

const port = Number.parseInt(
  process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] ?? '' : process.env.PLAYWRIGHT_API_PORT ?? '3110',
  10,
);

const tenantSlug = process.env.E2E_TENANT_SLUG ?? 'e2e-operations';
const tenantName = process.env.E2E_TENANT_NAME ?? 'E2E Operations Diner';
const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'e2e.admin';
const adminPin = process.env.E2E_ADMIN_PIN ?? '246810';
const managerUsername = process.env.E2E_MANAGER_USERNAME ?? 'e2e.manager';
const managerPin = process.env.E2E_MANAGER_PIN ?? '112233';
const superAdminUsername = process.env.E2E_SUPER_ADMIN_USERNAME ?? 'e2e.superadmin';
const superAdminPin = process.env.E2E_SUPER_ADMIN_PIN ?? '864200';
const mfaUsername = process.env.E2E_MFA_USERNAME ?? 'e2e.mfa';
const mfaPin = process.env.E2E_MFA_PIN ?? '135790';
const unenrolledMfaUsername = process.env.E2E_UNENROLLED_MFA_USERNAME ?? 'e2e.unenrolled';
const unenrolledMfaPin = process.env.E2E_UNENROLLED_MFA_PIN ?? '975310';
const csrfToken = 'mock-e2e-csrf';
const publicIds = {
  downtown: '10000000-0000-4000-8000-000000000001',
  uptown: '10000000-0000-4000-8000-000000000002',
  staff: '20000000-0000-4000-8000-000000000001',
  manager: '20000000-0000-4000-8000-000000000002',
  admin: '20000000-0000-4000-8000-000000000101',
  managerAccount: '20000000-0000-4000-8000-000000000102',
  superAdmin: '20000000-0000-4000-8000-000000000103',
  mfaAdmin: '20000000-0000-4000-8000-000000000104',
  unenrolledMfaAdmin: '20000000-0000-4000-8000-000000000105',
};
const mockMfaSecret = 'JBSWY3DPEHPK3PXP';
const mockMfaRecoveryCodes = ['LL-4F8K-92HD', 'LL-73QW-1PZM', 'LL-8T2N-6YKC'];
const creditPackOptions = [
  { code: 'CREDITS_100', credits: 100, configured: true, amount: 1200, currency: 'usd' },
  { code: 'CREDITS_500', credits: 500, configured: true, amount: 5000, currency: 'usd' },
  { code: 'CREDITS_2000', credits: 2000, configured: true, amount: 18000, currency: 'usd' },
];

const payrollPolicy = {
  id: 'payroll-policy-1',
  version: 1,
  timeZone: 'America/Los_Angeles',
  cadence: 'WEEKLY',
  anchorDate: '2026-07-06',
  effectiveFrom: '2026-07-06',
  createdByUserId: 'user-admin',
  createdAt: '2026-07-06T16:00:00.000Z',
};

function payrollExportBatch(newBalance) {
  return {
    id: 'payroll-batch-1',
    periodId: 'payroll-period-1',
    formatVersion: 1,
    status: 'GENERATED',
    contentSha256: 'b'.repeat(64),
    rowCount: 1,
    totalPayableMinutes: 450,
    settlement: { consumedCredits: 1, newBalance },
    createdAt: '2026-07-16T17:00:00.000Z',
    downloadedAt: null,
    reconciledAt: null,
    lines: [{
      id: 'payroll-line-1',
      lineNumber: 1,
      lockedEntryId: 'payroll-entry-1',
      employeeId: 'user-mock-staff',
      payableMinutes: 450,
      canonicalSha256: 'c'.repeat(64),
      reconciliationStatus: 'PENDING',
      reconciliationReason: null,
    }],
    nextLineCursor: null,
    reconciliation: {
      acceptedCount: 0,
      rejectedCount: 0,
      pendingCount: 1,
      providerTotalMinutes: null,
      latestProvider: null,
      latestProviderEventId: null,
    },
  };
}

function payrollPeriod(exportCreated, newBalance) {
  return {
    id: 'payroll-period-1',
    policyVersionId: payrollPolicy.id,
    localStartDate: '2026-07-06',
    localEndDateExclusive: '2026-07-13',
    startsAt: '2026-07-06T07:00:00.000Z',
    endsAt: '2026-07-13T07:00:00.000Z',
    timeZone: payrollPolicy.timeZone,
    cadence: payrollPolicy.cadence,
    status: 'LOCKED',
    revision: 2,
    reviewStartedAt: '2026-07-14T16:00:00.000Z',
    lockedAt: '2026-07-15T16:00:00.000Z',
    lockedEntrySha256: 'a'.repeat(64),
    lockedEntryCount: 1,
    totalPayableMinutes: 450,
    summary: {
      cardCount: 1,
      closedCardCount: 1,
      approvedCardCount: 1,
      rejectedCardCount: 0,
      pendingCardCount: 0,
      amendmentCount: 0,
      pendingAmendmentCount: 0,
      approvedAmendmentCount: 0,
      lockedEntryCount: 1,
    },
    exportBatch: exportCreated ? payrollExportBatch(newBalance) : null,
  };
}

function payrollPeriodDetail(exportCreated, newBalance) {
  return {
    period: payrollPeriod(exportCreated, newBalance),
    cards: [],
    nextCardCursor: null,
    lockedEntries: [{
      id: 'payroll-entry-1',
      sequence: 0,
      sourceType: 'TIME_CARD',
      sourceId: 'time-card-1',
      sourceRevision: 3,
      employeeId: 'user-mock-staff',
      employeeName: 'Mock Staff',
      locationId: 'loc-downtown',
      workTimeZone: payrollPolicy.timeZone,
      clockInAt: '2026-07-08T16:00:00.000Z',
      clockOutAt: '2026-07-09T00:00:00.000Z',
      breakMinutes: 30,
      payableMinutes: 450,
      approvedAt: '2026-07-14T17:00:00.000Z',
      approvedByUserId: 'user-admin',
      canonicalSha256: 'd'.repeat(64),
    }],
    amendments: [],
  };
}

const permissions = [
  'dashboard:access',
  'auth:login_pin',
  'users:read',
  'users:write',
  'users:admin',
  'roles:read',
  'roles:write',
  'roles:assign',
  'locations:read',
  'locations:write',
  'locations:delete',
  'shifts:read',
  'shifts:write',
  'shifts:delete',
  'schedules:read',
  'schedules:write',
  'schedules:publish',
  'lunch_breaks:read',
  'lunch_breaks:write',
  'lunch_breaks:delete',
  'time_cards:read',
  'time_cards:write',
  'time_cards:approve',
  'payroll:read',
  'payroll:policy_write',
  'payroll:lock',
  'payroll:export',
  'payroll:reconcile',
  'notifications:read',
  'notifications:write',
  'billing:read',
  'billing:write',
  'settings:read',
  'settings:write',
  'account:data_export',
  'tenant_account:lifecycle',
];

let state = resetState();

function resetState() {
  const now = new Date();
  const location = {
    id: 'loc-downtown',
    publicId: publicIds.downtown,
    name: process.env.E2E_LOCATION_NAME ?? 'Downtown Diner',
    address: null,
    timezone: 'America/Los_Angeles',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const adminTenant = {
    id: 'tenant-e2e',
    name: tenantName,
    slug: tenantSlug,
    planTier: 'GROWTH',
    status: 'ACTIVE',
  };
  const admin = {
    id: 'user-admin',
    publicUserId: publicIds.admin,
    sub: 'user-admin',
    tenantId: 'tenant-e2e',
    sessionId: 'session-admin',
    email: null,
    username: adminUsername,
    name: 'E2E Admin',
    role: 'Admin',
    legacyRole: 'ADMIN',
    permissions,
    roles: [{ id: 'role-admin', name: 'Admin' }],
    tenantName,
  };
  const superAdmin = {
    ...admin,
    id: 'user-super-admin',
    publicUserId: publicIds.superAdmin,
    sub: 'user-super-admin',
    sessionId: 'session-super-admin',
    username: superAdminUsername,
    name: 'E2E Super Admin',
    role: 'System Admin',
    legacyRole: 'SUPER_ADMIN',
    permissions: [...permissions, 'admin_portal:access'],
    roles: [{ id: 'role-super-admin', name: 'System Admin' }],
  };
  const manager = {
    ...admin,
    id: 'user-manager',
    publicUserId: publicIds.managerAccount,
    sub: 'user-manager',
    sessionId: 'session-manager',
    username: managerUsername,
    name: 'E2E Manager',
    role: 'Manager',
    legacyRole: 'MANAGER',
    permissions: permissions.filter((permission) => (
      permission !== 'users:admin'
      && !permission.startsWith('roles:')
      && (!permission.startsWith('payroll:') || permission === 'payroll:read')
    )),
    roles: [{ id: 'role-manager', name: 'Manager' }],
  };
  const mfaAdmin = {
    ...admin,
    id: 'user-mfa-admin',
    publicUserId: publicIds.mfaAdmin,
    sub: 'user-mfa-admin',
    sessionId: 'session-mfa-admin',
    username: mfaUsername,
    name: 'E2E MFA Admin',
    mfaRequired: true,
    mfaVerified: false,
    mfaEnrolled: true,
    mfaVerifiedAt: now.toISOString(),
    mfaRecoveryCodesRemaining: mockMfaRecoveryCodes.length,
    mfaSetup: null,
  };
  const unenrolledMfaAdmin = {
    ...admin,
    id: 'user-unenrolled-mfa-admin',
    publicUserId: publicIds.unenrolledMfaAdmin,
    sub: 'user-unenrolled-mfa-admin',
    sessionId: 'session-unenrolled-mfa-admin',
    username: unenrolledMfaUsername,
    name: 'E2E Unenrolled MFA Admin',
    mfaRequired: true,
    mfaVerified: false,
    mfaEnrolled: false,
    mfaVerifiedAt: null,
    mfaRecoveryCodesRemaining: 0,
    mfaSetup: null,
  };
  const staff = [
    { id: 'user-mock-staff', publicId: publicIds.staff, name: 'Mock Staff', username: 'mock.staff', role: 'STAFF' },
    { id: 'user-mock-manager', publicId: publicIds.manager, name: 'Mock Manager', username: 'mock.manager', role: 'MANAGER' },
  ];
  const adminUsers = [
    { account: superAdmin, mfaEnabled: true },
    { account: admin, mfaEnabled: false },
    { account: mfaAdmin, mfaEnabled: true },
  ].map(({ account, mfaEnabled }) => ({
    id: account.publicUserId,
    name: account.name,
    email: account.email,
    username: account.username,
    role: account.legacyRole,
    createdAt: now.toISOString(),
    lastLoginAt: now.toISOString(),
    lockedUntil: null,
    pinLockedUntil: null,
    deletedAt: null,
    mfaEnabled,
    status: 'ACTIVE',
    tenant: adminTenant,
  }));

  return {
    usersByToken: new Map([
      ['mock-admin-access', admin],
      ['mock-manager-access', manager],
      ['mock-super-admin-access', superAdmin],
      ['mock-mfa-access', mfaAdmin],
      ['mock-unenrolled-mfa-access', unenrolledMfaAdmin],
    ]),
    usersByUsername: new Map([
      [adminUsername, { user: admin, pin: adminPin, token: 'mock-admin-access' }],
      [managerUsername, { user: manager, pin: managerPin, token: 'mock-manager-access' }],
      [superAdminUsername, { user: superAdmin, pin: superAdminPin, token: 'mock-super-admin-access' }],
      [mfaUsername, { user: mfaAdmin, pin: mfaPin, token: 'mock-mfa-access' }],
      [unenrolledMfaUsername, { user: unenrolledMfaAdmin, pin: unenrolledMfaPin, token: 'mock-unenrolled-mfa-access' }],
    ]),
    adminTenants: [adminTenant],
    adminUsers,
    staff,
    schedulingProfiles: new Map(staff.map((member) => [member.id, { skills: [], availability: [] }])),
    locations: [location],
    shifts: [],
    timeCards: [],
    settings: {
      general: {
        organizationName: tenantName,
        slug: tenantSlug,
        timezone: 'America/Los_Angeles',
      },
      team: {
        defaultRole: 'STAFF',
        shiftApprovalPolicy: 'MANAGER_APPROVAL',
      },
      security: {
        requireMfaForAll: false,
        sessionTimeoutMinutes: 60,
        ssoOidcOnly: false,
      },
    },
    account: {
      id: 'tenant-e2e',
      slug: tenantSlug,
      status: 'ACTIVE',
      lifecycleStatus: 'OPEN',
      cancelledAt: null,
      deletionRequestedAt: null,
      retention: null,
      retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'auditLogs', 'databaseBackups', 'securityLogs'],
    },
    mfaEnrollment: {
      enabled: false,
      verifiedAt: null,
      recoveryCodesRemaining: 0,
      setup: null,
    },
    notifications: [
      {
        id: 'note-schedule',
        type: 'SCHEDULE_PUBLISHED',
        title: 'Schedule ready',
        body: 'The current week is ready for review.',
        readAt: null,
        createdAt: new Date(now.getTime() - 5 * 60000).toISOString(),
      },
    ],
    billing: {
      planTier: 'GROWTH',
      effectivePlanTier: 'GROWTH',
      status: 'ACTIVE',
      trialEndsAt: null,
      stripeSubscriptionActive: true,
      stripeSubscriptionPresent: true,
      subscriptionRecoveryAction: null,
      usageCredits: 500,
    },
    schedules: [],
    demandWindowsBySchedule: new Map(),
    scheduleJobs: [],
    schedulePublishRequests: new Map(),
    lunchBreakGenerationRequests: new Map(),
    shiftUpdateRequests: new Map(),
    v2Idempotency: new Map(),
    payroll: {
      exportCreated: false,
      exportRequests: new Map(),
    },
  };
}

function hasActivePaidSubscription() {
  const tier = state.billing.effectivePlanTier.trim().toUpperCase();
  return state.billing.status === 'ACTIVE'
    && state.billing.stripeSubscriptionActive
    && state.billing.stripeSubscriptionPresent
    && tier !== 'FREE'
    && tier !== 'UNKNOWN';
}

function billableFeatureResolution() {
  if (!hasActivePaidSubscription()) {
    return {
      enabled: false,
      source: 'disabled',
      reason: 'An active paid subscription is required for billable actions.',
      creditCost: 1,
    };
  }
  if (state.billing.usageCredits <= 0) {
    return {
      enabled: false,
      source: 'disabled',
      reason: 'Separately purchased or granted usage credits are required for billable actions.',
      creditCost: 1,
    };
  }
  return {
    enabled: true,
    source: 'credits',
    reason: 'Active paid subscription and separately purchased credits authorize this billable feature.',
    creditCost: 1,
  };
}

function requireBillableAccess(res) {
  const resolution = billableFeatureResolution();
  if (resolution.enabled) return true;
  sendJson(res, 403, { message: resolution.reason });
  return false;
}

function consumeMockUsageCredit() {
  state.billing.usageCredits -= 1;
  return { consumedCredits: 1, newBalance: state.billing.usageCredits, source: 'credits' };
}

function schedulePublishPreflight(schedule) {
  const acceptedContract = {
    version: schedule.revision ?? 0,
    totalConfiguredCost: 1,
    scheduleCost: 1,
    matchingWebhookDeliveryCount: 0,
    matchingWebhookDeliveryUnitCost: 0,
    matchingWebhookDeliveryCost: 0,
  };
  return {
    scheduleId: schedule.id,
    ...acceptedContract,
    acceptedContract,
    availableCredits: state.billing.usageCredits,
    sufficientCredits: state.billing.usageCredits >= acceptedContract.totalConfiguredCost,
  };
}

function schedulePublishContractMatches(accepted, current) {
  return accepted
    && Object.keys(current).every((key) => accepted[key] === current[key])
    && Object.keys(accepted).length === Object.keys(current).length;
}

function mockQrCodeDataUrl() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">',
    '<rect width="120" height="120" fill="#fff"/>',
    '<rect x="10" y="10" width="28" height="28" fill="#111827"/>',
    '<rect x="82" y="10" width="28" height="28" fill="#111827"/>',
    '<rect x="10" y="82" width="28" height="28" fill="#111827"/>',
    '<rect x="48" y="48" width="12" height="12" fill="#2563eb"/>',
    '<rect x="66" y="48" width="12" height="12" fill="#111827"/>',
    '<rect x="48" y="66" width="12" height="12" fill="#111827"/>',
    '<rect x="66" y="66" width="12" height="12" fill="#0f766e"/>',
    '<rect x="88" y="76" width="10" height="10" fill="#111827"/>',
    '<rect x="76" y="92" width="22" height="10" fill="#2563eb"/>',
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function mfaStatusPayload() {
  return {
    enabled: state.mfaEnrollment.enabled,
    verifiedAt: state.mfaEnrollment.verifiedAt,
    recoveryCodesRemaining: state.mfaEnrollment.recoveryCodesRemaining,
  };
}

function hasUserScopedMfa(user) {
  return Object.prototype.hasOwnProperty.call(user, 'mfaEnrolled');
}

function currentToken(req) {
  return parseCookies(req.headers.cookie).access_token;
}

function effectiveMfaStatusPayload(user) {
  if (!hasUserScopedMfa(user)) return mfaStatusPayload();
  return {
    enabled: user.mfaEnrolled === true,
    verifiedAt: user.mfaVerifiedAt,
    recoveryCodesRemaining: user.mfaRecoveryCodesRemaining ?? 0,
  };
}

function currentMfaSetup(user) {
  return hasUserScopedMfa(user) ? user.mfaSetup : state.mfaEnrollment.setup;
}

function setCurrentMfaSetup(user, setup) {
  if (hasUserScopedMfa(user)) {
    user.mfaSetup = setup;
    return;
  }
  state.mfaEnrollment.setup = setup;
}

function markCurrentMfaEnrolled(user) {
  if (hasUserScopedMfa(user)) {
    user.mfaEnrolled = true;
    user.mfaVerified = true;
    user.mfaVerifiedAt = new Date().toISOString();
    user.mfaRecoveryCodesRemaining = mockMfaRecoveryCodes.length;
    user.mfaSetup = null;
    return;
  }
  state.mfaEnrollment = {
    enabled: true,
    verifiedAt: new Date().toISOString(),
    recoveryCodesRemaining: mockMfaRecoveryCodes.length,
    setup: null,
  };
}

function markCurrentMfaDisabled(user) {
  if (hasUserScopedMfa(user)) {
    user.mfaEnrolled = false;
    user.mfaVerified = false;
    user.mfaVerifiedAt = null;
    user.mfaRecoveryCodesRemaining = 0;
    user.mfaSetup = null;
    return;
  }
  state.mfaEnrollment = {
    enabled: false,
    verifiedAt: null,
    recoveryCodesRemaining: 0,
    setup: null,
  };
}

function mfaSetupPayload(user) {
  const accountLabel = user.username ?? user.email ?? user.id;
  return {
    enrollmentId: `mfa-${user.id}`,
    issuer: 'LunchLineup',
    accountLabel,
    manualEntryKey: mockMfaSecret,
    otpauthUrl: `otpauth://totp/LunchLineup:${encodeURIComponent(accountLabel)}?secret=${mockMfaSecret}&issuer=LunchLineup`,
    qrCodeDataUrl: mockQrCodeDataUrl(),
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
  };
}

function translateLocationReferences(value, identifiers) {
  if (Array.isArray(value)) return value.map((entry) => translateLocationReferences(entry, identifiers));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'locationId' && typeof child === 'string') return [key, identifiers.get(child) ?? child];
    if (key === 'locationIds' && Array.isArray(child)) {
      return [key, child.map((entry) => typeof entry === 'string' ? identifiers.get(entry) ?? entry : entry)];
    }
    return [key, translateLocationReferences(child, identifiers)];
  }));
}

function publicLocation(location) {
  return {
    id: location.publicId,
    name: location.name,
    address: location.address ?? null,
    timezone: location.timezone ?? 'America/Los_Angeles',
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
  };
}

function nativeLocationCursor(location) {
  return Buffer.from(JSON.stringify({ name: location.name, publicId: location.publicId })).toString('base64url');
}

function parseNativeLocationCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof parsed?.name === 'string' && typeof parsed?.publicId === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = res.__translateV2LocationReferences
    ? translateLocationReferences(payload, new Map(state.locations.map((location) => [location.id, location.publicId])))
    : payload;
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf('=');
        if (index === -1) return [entry, ''];
        return [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
      }),
  );
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  const parsed = type.includes('application/json')
    ? (text ? JSON.parse(text) : {})
    : Object.fromEntries(new URLSearchParams(text));
  return req.__translateV2LocationReferences
    ? translateLocationReferences(parsed, new Map(state.locations.map((location) => [location.publicId, location.id])))
    : parsed;
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.access_token;
  return token ? state.usersByToken.get(token) ?? null : null;
}

function browserScope(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function browserSessionUser(user) {
  return {
    publicUserId: user.publicUserId,
    role: user.legacyRole,
    roleLabel: user.role,
    workspaceName: user.tenantName,
    workspaceScope: browserScope(`workspace:${user.tenantId}`),
    sessionScope: browserScope(`session:${user.tenantId}:${user.sub}:${user.sessionId}`),
    permissions: [...new Set(user.permissions)].sort(),
    email: user.email ?? null,
    username: user.username ?? null,
    name: user.name ?? null,
    mfaVerified: user.mfaVerified ?? true,
    mfaRequired: user.mfaRequired ?? false,
    pinResetRequired: user.pinResetRequired ?? false,
  };
}

function requireAuth(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { message: 'Authentication required.' });
    return null;
  }
  return user;
}

function requireCsrf(req, res, pathname) {
  const exempt = pathname.startsWith('/v1/auth/') || pathname === '/v1/__e2e/reset';
  if (exempt || req.method === 'GET' || req.method === 'HEAD') return true;
  if (req.headers['x-csrf-token'] === csrfToken) return true;
  sendJson(res, 403, { message: 'Invalid CSRF token.' });
  return false;
}

function authCookies(token) {
  return [
    `access_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    `refresh_token=mock-refresh; Path=/; HttpOnly; SameSite=Lax`,
    `csrf_token=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Lax`,
  ];
}

function healthPayload() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    checks: [
      { name: 'database', status: 'online', latencyMs: 3, details: 'query succeeded' },
      { name: 'redis', status: 'online', latencyMs: 2, details: 'ping succeeded' },
    ],
  };
}

function toTimeCard(card) {
  const user = [...state.usersByToken.values()].find((candidate) => candidate.id === card.userId)
    ?? state.staff.find((candidate) => candidate.id === card.userId)
    ?? null;
  const location = state.locations.find((candidate) => candidate.id === card.locationId) ?? null;
  const clockIn = new Date(card.clockInAt).getTime();
  const clockOut = card.clockOutAt ? new Date(card.clockOutAt).getTime() : Date.now();
  const grossMinutes = Math.max(1, Math.round((clockOut - clockIn) / 60000));
  const workedMinutes = Math.max(0, grossMinutes - card.breakMinutes);

  return {
    ...card,
    grossMinutes,
    workedMinutes,
    user: user ? { id: user.id, name: user.name, username: user.username ?? null, role: user.role } : null,
    location,
  };
}

function shiftBreaks(shift) {
  const start = new Date(shift.startTime);
  const firstBreakStart = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const lunchStart = new Date(start.getTime() + 4 * 60 * 60 * 1000);
  const secondBreakStart = new Date(start.getTime() + 6 * 60 * 60 * 1000);
  return [
    { type: 'break1', startTime: firstBreakStart.toISOString(), endTime: new Date(firstBreakStart.getTime() + 10 * 60000).toISOString(), durationMinutes: 10, paid: true },
    { type: 'lunch', startTime: lunchStart.toISOString(), endTime: new Date(lunchStart.getTime() + 30 * 60000).toISOString(), durationMinutes: 30, paid: false },
    { type: 'break2', startTime: secondBreakStart.toISOString(), endTime: new Date(secondBreakStart.getTime() + 10 * 60000).toISOString(), durationMinutes: 10, paid: true },
  ];
}

function decorateShift(shift) {
  const user = shift.userId ? state.staff.find((candidate) => candidate.id === shift.userId) ?? null : null;
  return {
    ...shift,
    user: user ? { id: user.id, name: user.name, role: user.role } : null,
  };
}

function dayScheduleWindow(startIso, endIso = startIso) {
  const start = new Date(startIso);
  start.setUTCHours(0, 0, 0, 0);
  const inclusiveEnd = new Date(Date.parse(endIso) - 1);
  inclusiveEnd.setUTCHours(0, 0, 0, 0);
  const end = new Date(inclusiveEnd);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function scheduleForShift(locationId, startTime, endTime, scheduleId) {
  const shiftStart = Date.parse(startTime);
  const shiftEnd = Date.parse(endTime);
  const containingDraft = (candidate) =>
    candidate.locationId === locationId &&
    candidate.status === 'DRAFT' &&
    Date.parse(candidate.startDate) <= shiftStart &&
    Date.parse(candidate.endDate) >= shiftEnd;
  if (scheduleId) {
    return state.schedules.find((candidate) => candidate.id === scheduleId && containingDraft(candidate)) ?? null;
  }

  let schedule = state.schedules.find(containingDraft);
  if (schedule) return schedule;
  const { startDate, endDate } = dayScheduleWindow(startTime, endTime);
  schedule = {
    id: `sched-${crypto.randomUUID()}`,
    publicId: crypto.randomUUID(),
    locationId,
    startDate,
    endDate,
    status: 'DRAFT',
    publishedAt: null,
    revision: 0,
  };
  state.schedules.push(schedule);
  return schedule;
}

function lunchRows() {
  return state.shifts.map((shift) => ({
    shiftId: shift.id,
    userId: shift.userId,
    employeeName: state.staff.find((user) => user.id === shift.userId)?.name ?? 'Open shift',
    startTime: shift.startTime,
    endTime: shift.endTime,
    breaks: shift.breaks ?? [],
  }));
}

function scheduleEtag(schedule) {
  return `"schedule:${schedule.publicId}:${schedule.revision ?? 0}"`;
}

function publicSchedule(schedule) {
  const location = state.locations.find((candidate) => candidate.id === schedule.locationId);
  if (!location) return null;
  return {
    id: schedule.publicId,
    locationId: location.publicId,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    status: schedule.status,
    publishedAt: schedule.publishedAt ?? null,
    revision: schedule.revision ?? 0,
    etag: scheduleEtag(schedule),
  };
}

function publicShift(shift) {
  const location = state.locations.find((candidate) => candidate.id === shift.locationId);
  const schedule = state.schedules.find((candidate) => candidate.id === shift.scheduleId);
  const user = shift.userId ? state.staff.find((candidate) => candidate.id === shift.userId) ?? null : null;
  if (!location || !schedule) return null;
  return {
    id: shift.publicId,
    userId: user?.publicId ?? null,
    locationId: location.publicId,
    scheduleId: schedule.publicId,
    startTime: shift.startTime,
    endTime: shift.endTime,
    role: shift.role ?? null,
    user: user ? { id: user.publicId, name: user.name, role: user.role } : null,
    breaks: (shift.breaks ?? []).map((item) => ({
      startTime: item.startTime,
      endTime: item.endTime,
      paid: item.paid,
    })),
  };
}

function mockBoardRange(date, view) {
  const start = new Date(`${date}T00:00:00.000Z`);
  const days = view === 'day' ? 1 : view === 'week' ? 7 : 3;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return { start, end };
}

function sendV2Problem(res, status, code, detail, currentEtag) {
  sendJson(res, status, {
    type: `https://lunchlineup.com/problems/${code.replaceAll('_', '-')}`,
    title: status === 412 ? 'Precondition failed' : status === 409 ? 'Conflict' : 'Request rejected',
    status,
    detail,
    code,
    ...(currentEtag ? { currentEtag } : {}),
  }, { 'content-type': 'application/problem+json' });
}

function beginV2IdempotentRequest(req, res, pathname, body) {
  const key = typeof req.headers['idempotency-key'] === 'string'
    ? req.headers['idempotency-key'].trim()
    : '';
  if (!key) {
    sendV2Problem(res, 428, 'idempotency_key_required', 'This write requires an Idempotency-Key.');
    return { handled: true };
  }
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ pathname, body }))
    .digest('hex');
  const existing = state.v2Idempotency.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      sendV2Problem(res, 409, 'idempotency_key_reused', 'Idempotency-Key was already used for a different request.');
      return { handled: true };
    }
    sendJson(res, existing.status, existing.response);
    return { handled: true };
  }
  return { handled: false, key, fingerprint };
}

function commitV2IdempotentRequest(attempt, status, response) {
  state.v2Idempotency.set(attempt.key, {
    fingerprint: attempt.fingerprint,
    status,
    response,
  });
}

function requireCurrentScheduleEtag(req, res, schedule) {
  const current = scheduleEtag(schedule);
  if (req.headers['if-match'] === current) return true;
  sendV2Problem(
    res,
    412,
    'stale_schedule_revision',
    'The schedule changed after this board loaded. Reload before saving.',
    current,
  );
  return false;
}

async function handleV2(req, res, url, pathname) {
  if (!requireCsrf(req, res, pathname)) return;
  if (pathname === '/v2/auth/refresh' && req.method === 'POST') {
    sendJson(res, 200, { success: true }, { 'set-cookie': authCookies('mock-admin-access') });
    return;
  }
  const user = requireAuth(req, res);
  if (!user) return;

  if (pathname === '/v2/auth/me' && req.method === 'GET') {
    sendJson(res, 200, { user: browserSessionUser(user) });
    return;
  }

  if (pathname === '/v2/locations' && req.method === 'GET') {
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
    const cursor = parseNativeLocationCursor(url.searchParams.get('cursor'));
    if (url.searchParams.has('cursor') && !cursor) {
      sendV2Problem(res, 422, 'invalid_location_cursor', 'The location page cursor is invalid.');
      return;
    }
    const ordered = state.locations.slice().sort((left, right) => (
      left.name.localeCompare(right.name) || left.publicId.localeCompare(right.publicId)
    ));
    const start = cursor
      ? ordered.findIndex((location) => (
        location.name.localeCompare(cursor.name) > 0
        || (location.name === cursor.name && location.publicId.localeCompare(cursor.publicId) > 0)
      ))
      : 0;
    const page = (start < 0 ? [] : ordered.slice(start, start + limit + 1));
    const data = page.slice(0, limit);
    const hasMore = page.length > limit;
    sendJson(res, 200, {
      data: data.map(publicLocation),
      pagination: {
        limit,
        maxLimit: 200,
        returned: data.length,
        hasMore,
        nextCursor: hasMore ? nativeLocationCursor(data[data.length - 1]) : null,
      },
    });
    return;
  }

  if (pathname === '/v2/locations/summary' && req.method === 'GET') {
    sendJson(res, 200, { count: state.locations.length });
    return;
  }

  if (pathname === '/v2/locations' && req.method === 'POST') {
    const body = await readBody(req);
    const hasIdempotencyKey = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim();
    const attempt = hasIdempotencyKey ? beginV2IdempotentRequest(req, res, pathname, body) : null;
    if (attempt?.handled) return;
    if (typeof body.name !== 'string' || !body.name.trim() || typeof body.timezone !== 'string' || !body.timezone.trim()) {
      sendV2Problem(res, 422, 'invalid_location_input', 'Name and a valid IANA timezone are required.');
      return;
    }
    const now = new Date().toISOString();
    const location = {
      id: `loc-${crypto.randomUUID()}`,
      publicId: crypto.randomUUID(),
      name: body.name.trim(),
      address: typeof body.address === 'string' ? body.address.trim() || null : null,
      timezone: body.timezone.trim(),
      createdAt: now,
      updatedAt: now,
    };
    state.locations.push(location);
    const response = publicLocation(location);
    if (attempt) commitV2IdempotentRequest(attempt, 201, response);
    sendJson(res, 201, response);
    return;
  }

  const locationMatch = /^\/v2\/locations\/([0-9a-f-]{36})$/.exec(pathname);
  if (locationMatch) {
    const location = state.locations.find((candidate) => candidate.publicId === locationMatch[1]);
    if (!location) {
      sendV2Problem(res, 404, 'location_not_found', 'The selected location was not found.');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, publicLocation(location));
      return;
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (typeof body.timezone !== 'string' || !body.timezone.trim()) {
        sendV2Problem(res, 422, 'invalid_location_input', 'A valid IANA timezone is required.');
        return;
      }
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) {
          sendV2Problem(res, 422, 'invalid_location_input', 'Location name must be non-empty.');
          return;
        }
        location.name = body.name.trim();
      }
      if (body.address !== undefined) {
        if (body.address !== null && typeof body.address !== 'string') {
          sendV2Problem(res, 422, 'invalid_location_input', 'Location address must be a string or null.');
          return;
        }
        location.address = typeof body.address === 'string' ? body.address.trim() || null : null;
      }
      location.timezone = body.timezone.trim();
      location.updatedAt = new Date().toISOString();
      sendJson(res, 200, publicLocation(location));
      return;
    }
    if (req.method === 'DELETE') {
      state.locations = state.locations.filter((candidate) => candidate.id !== location.id);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
  }

  if (pathname === '/v2/schedule-board' && req.method === 'GET') {
    const requestedLocationId = url.searchParams.get('locationId');
    const selectedLocation = state.locations.find((candidate) => candidate.publicId === requestedLocationId)
      ?? state.locations[0]
      ?? null;
    const range = mockBoardRange(
      url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10),
      url.searchParams.get('view') ?? 'threeDay',
    );
    const schedules = selectedLocation
      ? state.schedules.filter((schedule) => (
        schedule.locationId === selectedLocation.id
        && Date.parse(schedule.startDate) < range.end.getTime()
        && Date.parse(schedule.endDate) > range.start.getTime()
      ))
      : [];
    const scheduleIds = new Set(schedules.map((schedule) => schedule.id));
    sendJson(res, 200, {
      data: {
        permissions: user.permissions,
        locations: state.locations.map((location) => ({
          id: location.publicId,
          name: location.name,
          timezone: location.timezone ?? 'America/Los_Angeles',
        })),
        locationsTruncated: false,
        selectedLocationId: selectedLocation?.publicId ?? null,
        staff: state.staff.map((member) => ({
          id: member.publicId,
          name: member.name,
          role: member.role,
        })),
        schedules: schedules.map(publicSchedule).filter(Boolean),
        shifts: state.shifts
          .filter((shift) => scheduleIds.has(shift.scheduleId))
          .map(publicShift)
          .filter(Boolean),
        range: {
          start: range.start.toISOString(),
          end: range.end.toISOString(),
        },
      },
      meta: { generatedAt: new Date().toISOString() },
    });
    return;
  }

  const createScheduleMatch = /^\/v2\/locations\/([0-9a-f-]{36})\/schedules$/.exec(pathname);
  if (createScheduleMatch && req.method === 'POST') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const location = state.locations.find((candidate) => candidate.publicId === createScheduleMatch[1]);
    if (!location) {
      sendV2Problem(res, 404, 'location_not_found', 'The selected location was not found.');
      return;
    }
    const schedule = {
      id: `schedule-${crypto.randomUUID()}`,
      publicId: crypto.randomUUID(),
      locationId: location.id,
      startDate: body.startDate,
      endDate: body.endDate,
      status: 'DRAFT',
      revision: 0,
      publishedAt: null,
    };
    state.schedules.push(schedule);
    const response = { data: publicSchedule(schedule) };
    commitV2IdempotentRequest(attempt, 200, response);
    sendJson(res, 200, response);
    return;
  }

  const changeSetMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/change-sets$/.exec(pathname);
  if (changeSetMatch && req.method === 'POST') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const schedule = state.schedules.find((candidate) => candidate.publicId === changeSetMatch[1]);
    if (!schedule) {
      sendV2Problem(res, 404, 'schedule_not_found', 'The selected schedule was not found.');
      return;
    }
    if (!requireCurrentScheduleEtag(req, res, schedule)) return;
    const created = [];
    for (const operation of body.operations ?? []) {
      if (operation.op === 'shift.create') {
        const assigned = operation.userId
          ? state.staff.find((candidate) => candidate.publicId === operation.userId)
          : null;
        const shift = {
          id: `shift-${crypto.randomUUID()}`,
          publicId: crypto.randomUUID(),
          locationId: schedule.locationId,
          scheduleId: schedule.id,
          userId: assigned?.id ?? null,
          role: operation.role ?? assigned?.role ?? null,
          startTime: operation.startTime,
          endTime: operation.endTime,
          breaks: [],
        };
        state.shifts.push(shift);
        created.push({ clientId: operation.clientId ?? null, shiftId: shift.publicId });
        continue;
      }
      const shift = state.shifts.find((candidate) => (
        candidate.publicId === operation.shiftId && candidate.scheduleId === schedule.id
      ));
      if (!shift) {
        sendV2Problem(res, 404, 'shift_not_found', 'A selected shift was not found.');
        return;
      }
      if (operation.op === 'shift.delete') {
        state.shifts = state.shifts.filter((candidate) => candidate !== shift);
        continue;
      }
      if (Object.hasOwn(operation, 'userId')) {
        shift.userId = operation.userId
          ? state.staff.find((candidate) => candidate.publicId === operation.userId)?.id ?? null
          : null;
      }
      if (operation.startTime) shift.startTime = operation.startTime;
      if (operation.endTime) shift.endTime = operation.endTime;
      if (Object.hasOwn(operation, 'role')) shift.role = operation.role;
    }
    const baseRevision = schedule.revision ?? 0;
    schedule.revision = baseRevision + 1;
    const response = {
      data: {
        changeSetId: crypto.randomUUID(),
        scheduleId: schedule.publicId,
        baseRevision,
        revision: schedule.revision,
        etag: scheduleEtag(schedule),
        shifts: state.shifts
          .filter((shift) => shift.scheduleId === schedule.id)
          .map(publicShift)
          .filter(Boolean),
        created,
      },
    };
    commitV2IdempotentRequest(attempt, 200, response);
    sendJson(res, 200, response);
    return;
  }

  const demandMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/demand-windows$/.exec(pathname);
  if (demandMatch && req.method === 'GET') {
    const schedule = state.schedules.find((candidate) => candidate.publicId === demandMatch[1]);
    if (!schedule) {
      sendV2Problem(res, 404, 'schedule_not_found', 'The selected schedule was not found.');
      return;
    }
    sendJson(res, 200, { data: state.demandWindowsBySchedule.get(schedule.id) ?? [] });
    return;
  }
  if (demandMatch && req.method === 'PUT') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const schedule = state.schedules.find((candidate) => candidate.publicId === demandMatch[1]);
    if (!schedule) {
      sendV2Problem(res, 404, 'schedule_not_found', 'The selected schedule was not found.');
      return;
    }
    if (!requireCurrentScheduleEtag(req, res, schedule)) return;
    const windows = (body.windows ?? []).map((window) => ({
      id: crypto.randomUUID(),
      startTime: window.startTime,
      endTime: window.endTime,
      requiredStaff: window.requiredStaff,
      skill: window.skill ?? null,
    }));
    state.demandWindowsBySchedule.set(schedule.id, windows);
    const baseRevision = schedule.revision ?? 0;
    schedule.revision = baseRevision + 1;
    const response = {
      data: windows,
      changeSetId: crypto.randomUUID(),
      scheduleId: schedule.publicId,
      baseRevision,
      revision: schedule.revision,
      etag: scheduleEtag(schedule),
    };
    commitV2IdempotentRequest(attempt, 200, response);
    sendJson(res, 200, response);
    return;
  }

  const publishPlanMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/publish-plan$/.exec(pathname);
  if (publishPlanMatch && req.method === 'GET') {
    const schedule = state.schedules.find((candidate) => candidate.publicId === publishPlanMatch[1]);
    if (!schedule) {
      sendV2Problem(res, 404, 'schedule_not_found', 'The selected schedule was not found.');
      return;
    }
    const plan = schedulePublishPreflight(schedule);
    sendJson(res, 200, { ...plan, scheduleId: schedule.publicId });
    return;
  }

  const publicationMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/publications$/.exec(pathname);
  if (publicationMatch && req.method === 'POST') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const schedule = state.schedules.find((candidate) => candidate.publicId === publicationMatch[1]);
    if (!schedule || schedule.status !== 'DRAFT') {
      sendV2Problem(res, 409, 'schedule_not_draft', 'Only a draft schedule can be published.');
      return;
    }
    if (!state.shifts.some((shift) => shift.scheduleId === schedule.id)) {
      sendV2Problem(res, 422, 'schedule_empty', 'Add at least one shift before publishing this schedule.');
      return;
    }
    const preflight = schedulePublishPreflight(schedule);
    if (!schedulePublishContractMatches(body.acceptedContract, preflight.acceptedContract)) {
      sendV2Problem(res, 409, 'publish_plan_changed', 'The publication plan changed. Review it again.');
      return;
    }
    const creditConsumption = consumeMockUsageCredit();
    schedule.status = 'PUBLISHED';
    schedule.publishedAt = new Date().toISOString();
    const response = {
      id: schedule.publicId,
      status: 'PUBLISHED',
      publishedAt: schedule.publishedAt,
      settlement: {
        ...preflight.acceptedContract,
        acceptedContract: preflight.acceptedContract,
        creditsConsumed: 1,
        newBalance: creditConsumption.newBalance,
        ledgerIdentities: {
          schedule: `feature-usage-schedule-publish:${attempt.fingerprint}`,
          webhookDeliveries: [],
        },
      },
      notifications: { status: 'DELIVERED', delivered: 1, pending: 0, failed: 0 },
    };
    commitV2IdempotentRequest(attempt, 200, response);
    sendJson(res, 200, response);
    return;
  }

  const reopeningMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/reopenings$/.exec(pathname);
  if (reopeningMatch && req.method === 'POST') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const schedule = state.schedules.find((candidate) => candidate.publicId === reopeningMatch[1]);
    if (!schedule || schedule.status !== 'PUBLISHED') {
      sendV2Problem(res, 409, 'schedule_not_published', 'Only a published schedule can be reopened.');
      return;
    }
    if (!requireCurrentScheduleEtag(req, res, schedule)) return;
    schedule.status = 'DRAFT';
    schedule.publishedAt = null;
    schedule.revision = (schedule.revision ?? 0) + 1;
    const response = { data: publicSchedule(schedule) };
    commitV2IdempotentRequest(attempt, 200, response);
    sendJson(res, 200, response);
    return;
  }

  const solveMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/solve-jobs$/.exec(pathname);
  if (solveMatch && req.method === 'POST') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const schedule = state.schedules.find((candidate) => candidate.publicId === solveMatch[1]);
    if (!schedule || schedule.status !== 'DRAFT') {
      sendV2Problem(res, 409, 'schedule_not_draft', 'Only a draft schedule can be solved.');
      return;
    }
    if ((state.demandWindowsBySchedule.get(schedule.id) ?? []).length === 0) {
      sendV2Problem(res, 422, 'demand_required', 'Configure at least one demand window before solving.');
      return;
    }
    const location = state.locations.find((candidate) => candidate.id === schedule.locationId);
    const creditConsumption = consumeMockUsageCredit();
    const now = new Date().toISOString();
    const job = {
      id: `job-${crypto.randomUUID()}`,
      publicId: crypto.randomUUID(),
      scheduleId: schedule.id,
      locationId: location.id,
      status: 'SUCCEEDED',
      statusReason: null,
      retryCount: 0,
      resultShiftCount: state.shifts.filter((shift) => shift.scheduleId === schedule.id).length,
      publicationStatus: 'DRAFT',
      startedAt: now,
      completedAt: now,
    };
    state.scheduleJobs.push(job);
    const response = {
      jobId: job.publicId,
      status: 'QUEUED',
      statusUrl: `/api/v2/schedules/${schedule.publicId}/solve-jobs/${job.publicId}`,
      creditConsumption,
    };
    commitV2IdempotentRequest(attempt, 202, response);
    sendJson(res, 202, response);
    return;
  }

  const solveJobMatch = /^\/v2\/schedules\/([0-9a-f-]{36})\/solve-jobs\/([0-9a-f-]{36})$/.exec(pathname);
  if (solveJobMatch && req.method === 'GET') {
    const schedule = state.schedules.find((candidate) => candidate.publicId === solveJobMatch[1]);
    const job = schedule
      ? state.scheduleJobs.find((candidate) => candidate.scheduleId === schedule.id && candidate.publicId === solveJobMatch[2])
      : null;
    const location = schedule
      ? state.locations.find((candidate) => candidate.id === schedule.locationId)
      : null;
    if (!schedule || !job || !location) {
      sendV2Problem(res, 404, 'solve_job_not_found', 'The selected solve job was not found.');
      return;
    }
    sendJson(res, 200, {
      jobId: job.publicId,
      scheduleId: schedule.publicId,
      locationId: location.publicId,
      status: job.status,
      statusReason: job.statusReason,
      retryCount: job.retryCount,
      resultShiftCount: job.resultShiftCount,
      publicationStatus: job.publicationStatus,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      statusUrl: `/api/v2/schedules/${schedule.publicId}/solve-jobs/${job.publicId}`,
    });
    return;
  }

  if (pathname === '/v2/break-generations' && req.method === 'POST') {
    const body = await readBody(req);
    const attempt = beginV2IdempotentRequest(req, res, pathname, body);
    if (attempt.handled) return;
    const location = state.locations.find((candidate) => candidate.publicId === body.locationId);
    const selectedPublicIds = new Set(body.shiftIds ?? []);
    const selected = state.shifts.filter((shift) => (
      shift.locationId === location?.id && selectedPublicIds.has(shift.publicId)
    ));
    if (!location || selected.length !== selectedPublicIds.size) {
      sendV2Problem(res, 422, 'invalid_break_generation_scope', 'Every shift must belong to the selected location.');
      return;
    }
    const creditConsumption = consumeMockUsageCredit();
    for (const shift of selected) shift.breaks = shiftBreaks(shift);
    const response = {
      locationId: location.publicId,
      source: 'shared_schedule',
      persisted: true,
      policy: {
        break1OffsetMinutes: 120,
        lunchOffsetMinutes: 240,
        break2OffsetMinutes: 360,
        break1DurationMinutes: 10,
        lunchDurationMinutes: 30,
        break2DurationMinutes: 10,
        timeStepMinutes: 5,
      },
      creditConsumption,
      data: selected.map((shift) => {
        const serialized = publicShift(shift);
        return {
          shiftId: serialized.id,
          userId: serialized.userId,
          employeeName: serialized.user?.name ?? null,
          startTime: serialized.startTime,
          endTime: serialized.endTime,
          breaks: shift.breaks,
        };
      }),
      reused: false,
    };
    commitV2IdempotentRequest(attempt, 200, response);
    sendJson(res, 200, response);
    return;
  }

  sendV2Problem(res, 404, 'route_not_found', 'The requested API route does not exist.');
}

function isNativeV2Path(pathname) {
  return pathname === '/v2/auth/me'
    || pathname === '/v2/auth/refresh'
    || pathname === '/v2/locations'
    || pathname === '/v2/locations/summary'
    || /^\/v2\/locations\/[0-9a-f-]{36}$/.test(pathname)
    || pathname === '/v2/schedule-board'
    || pathname === '/v2/break-generations'
    || /^\/v2\/locations\/[0-9a-f-]{36}\/schedules$/.test(pathname)
    || /^\/v2\/schedules\/[0-9a-f-]{36}\/(?:change-sets|demand-windows|publish-plan|publications|reopenings|solve-jobs(?:\/[0-9a-f-]{36})?)$/.test(pathname);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    let pathname = url.pathname;

    if (pathname === '/__mock-api/ready') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if ((pathname === '/health' || pathname === '/v1/health') && req.method === 'GET') {
      sendJson(res, 200, healthPayload(), { date: new Date().toUTCString() });
      return;
    }
    if (pathname === '/v1/__e2e/reset' && req.method === 'POST') {
      state = resetState();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname.startsWith('/v2/') && isNativeV2Path(pathname)) {
      await handleV2(req, res, url, pathname);
      return;
    }
    if (pathname.startsWith('/v2/')) {
      req.__translateV2LocationReferences = true;
      res.__translateV2LocationReferences = true;
      const publicToInternal = new Map(state.locations.map((location) => [location.publicId, location.id]));
      const requestedLocationIds = url.searchParams.getAll('locationId');
      if (requestedLocationIds.length > 0) {
        url.searchParams.delete('locationId');
        for (const locationId of requestedLocationIds) {
          url.searchParams.append('locationId', publicToInternal.get(locationId) ?? locationId);
        }
      }
      pathname = `/v1/${pathname.slice('/v2/'.length)}`;
    }
    if (!pathname.startsWith('/v1/')) {
      sendJson(res, 404, { message: 'Unknown mock endpoint.' });
      return;
    }
    if (!requireCsrf(req, res, pathname)) return;

    if (pathname === '/v1/auth/login/resolve' && req.method === 'POST') {
      const body = await readBody(req);
      const identifier = String(body.identifier ?? '').trim().toLowerCase();
      if (body.tenantSlug !== tenantSlug || !state.usersByUsername.has(identifier)) {
        sendJson(res, 404, { success: false, message: 'No matching user.' });
        return;
      }
      sendJson(res, 200, { success: true, flow: 'PIN', identifier, pinResetRequired: false });
      return;
    }

    if ((pathname === '/v1/auth/pin/verify' || pathname === '/v1/auth/password/verify' || pathname === '/v1/auth/email/verify-otp') && req.method === 'POST') {
      const body = await readBody(req);
      const identifier = String(body.identifier ?? body.email ?? adminUsername).trim().toLowerCase();
      const account = state.usersByUsername.get(identifier);
      if (!account || body.tenantSlug !== tenantSlug || (body.pin && body.pin !== account.pin)) {
        if (url.searchParams.get('redirect') === '1') {
          sendText(res, 303, '', { location: `/auth/login?tenantSlug=${tenantSlug}&step=pin&error=invalid` });
        } else {
          sendJson(res, 401, { success: false, message: 'Invalid username or PIN. Please try again.' });
        }
        return;
      }
      const next = url.searchParams.get('next') || '/dashboard';
      if (url.searchParams.get('redirect') === '1') {
        sendText(res, 303, '', { location: next, 'set-cookie': authCookies(account.token) });
        return;
      }
      sendJson(res, 200, { success: true, user: account.user, redirectTo: next }, { 'set-cookie': authCookies(account.token) });
      return;
    }

    if (pathname === '/v1/auth/email/send-otp' && req.method === 'POST') {
      sendJson(res, 200, { success: true, onboardingChallengeToken: 'e2e-onboarding-challenge' });
      return;
    }

    if (pathname === '/v1/auth/refresh' && req.method === 'POST') {
      sendJson(res, 200, { success: true }, { 'set-cookie': authCookies('mock-admin-access') });
      return;
    }

    if (pathname === '/v1/auth/me' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      sendJson(res, 200, { user });
      return;
    }

    const user = requireAuth(req, res);
    if (!user) return;

    if (pathname === '/v1/settings' && req.method === 'GET') {
      sendJson(res, 200, { settings: state.settings });
      return;
    }
    if (pathname === '/v1/settings/security' && req.method === 'PUT') {
      const body = await readBody(req);
      state.settings.security = {
        ...state.settings.security,
        requireMfaForAll: Boolean(body.requireMfaForAll),
        sessionTimeoutMinutes: Number.parseInt(String(body.sessionTimeoutMinutes ?? state.settings.security.sessionTimeoutMinutes), 10),
        ssoOidcOnly: Boolean(body.ssoOidcOnly),
      };
      sendJson(res, 200, { settings: state.settings });
      return;
    }

    if (pathname === '/v1/admin/account/status' && req.method === 'GET') {
      sendJson(res, 200, state.account);
      return;
    }
    if (pathname === '/v1/admin/tenants' && req.method === 'GET') {
      sendJson(res, 200, { data: state.adminTenants });
      return;
    }
    if (pathname === '/v1/admin/users' && req.method === 'GET') {
      sendJson(res, 200, { data: state.adminUsers });
      return;
    }
    const adminMfaResetMatch = /^\/v1\/admin\/users\/([^/]+)\/mfa\/reset$/.exec(pathname);
    if (adminMfaResetMatch && req.method === 'POST') {
      const target = state.adminUsers.find((candidate) => candidate.id === adminMfaResetMatch[1]);
      const body = await readBody(req);
      if (!target) {
        sendJson(res, 404, { message: 'User not found.' });
        return;
      }
      const expectedConfirmation = 'reset-mfa:' + target.id;
      if (body.confirmation !== expectedConfirmation || String(body.reason ?? '').trim().length < 10) {
        sendJson(res, 400, { message: 'Exact confirmation and a recovery reason are required.' });
        return;
      }
      target.mfaEnabled = false;
      sendJson(res, 200, { success: true });
      return;
    }
    if (pathname === '/v1/admin/account/exports' && req.method === 'GET') {
      sendJson(res, 200, {
        jobs: [{
          id: 'export-e2e',
          state: 'ready',
          createdAt: '2026-07-11T12:00:00.000Z',
          expiresAt: '2026-07-18T12:00:00.000Z',
          statusPath: '/admin/account/exports/export-e2e',
          downloadPath: '/admin/account/exports/export-e2e/download',
        }],
      });
      return;
    }
    if (pathname === '/v1/admin/account/export' && req.method === 'POST') {
      sendJson(res, 200, {
        id: 'export-e2e',
        state: 'ready',
        statusPath: '/admin/account/exports/export-e2e',
        downloadPath: '/admin/account/exports/export-e2e/download',
      });
      return;
    }
    if (pathname === '/v1/admin/account/exports/export-e2e/download' && req.method === 'GET') {
      const payload = `${JSON.stringify({ type: 'manifest', format: 'lunchlineup-tenant-export-ndjson', version: 1 })}\n`;
      res.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'content-disposition': `attachment; filename="${tenantSlug}-account-export-2026-07-11.ndjson"`,
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }
    if (pathname === '/v1/admin/account/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      if (String(body.confirmation ?? '').trim().toLowerCase() !== tenantSlug.toLowerCase()) {
        sendJson(res, 400, { message: 'confirmation must match the tenant slug.' });
        return;
      }
      const cancellationEffectiveAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      sendJson(res, 200, {
        id: state.account.id,
        slug: tenantSlug,
        status: state.account.status,
        cancellationEffectiveAt,
        billingCancellation: {
          action: 'scheduled',
          stripeSubscriptionId: 'sub-e2e',
          stripeStatus: 'active',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: cancellationEffectiveAt,
          cancelAt: null,
          canceledAt: null,
          cancellationBehavior: 'cancel_at_period_end',
        },
      });
      return;
    }
    if (pathname === '/v1/admin/account' && req.method === 'DELETE') {
      const body = await readBody(req);
      if (String(body.confirmation ?? '').trim().toLowerCase() !== tenantSlug.toLowerCase()) {
        sendJson(res, 400, { message: 'confirmation must match the tenant slug.' });
        return;
      }
      const deletionRequestedAt = new Date().toISOString();
      const fullDatabasePurgeEligibleAt = new Date(Date.now() + 7 * 365 * 24 * 60 * 60 * 1000).toISOString();
      state.account = {
        ...state.account,
        status: 'PURGED',
        lifecycleStatus: 'DELETION_REQUESTED',
        deletionRequestedAt,
        retention: {
          deletionRequestedAt,
          applicationDataEligibleAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          databaseBackupEligibleAt: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString(),
          securityLogEligibleAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
          retainedDatabaseRecordsEligibleAt: fullDatabasePurgeEligibleAt,
          fullDatabasePurgeEligibleAt,
          retainedRecords: state.account.retainedRecords,
        },
      };
      sendJson(res, 200, state.account);
      return;
    }

    if (pathname === '/v1/auth/mfa/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const code = String(body.code ?? '').trim();
      if (user.mfaRequired && !effectiveMfaStatusPayload(user).enabled) {
        sendJson(res, 409, { message: 'MFA enrollment required.' });
        return;
      }
      if (code !== '123456' && !mockMfaRecoveryCodes.includes(code)) {
        sendJson(res, 403, { message: 'Invalid MFA code.' });
        return;
      }
      user.mfaVerified = true;
      sendJson(res, 200, { success: true, mfaVerified: true }, { 'set-cookie': authCookies(currentToken(req) ?? 'mock-admin-access') });
      return;
    }

    if (pathname === '/v1/auth/mfa/enrollment' && req.method === 'GET') {
      sendJson(res, 200, {
        ...effectiveMfaStatusPayload(user),
        setup: currentMfaSetup(user),
      });
      return;
    }
    if (pathname === '/v1/auth/mfa/enrollment' && req.method === 'POST') {
      const setup = mfaSetupPayload(user);
      setCurrentMfaSetup(user, setup);
      sendJson(res, 200, { setup });
      return;
    }
    if (pathname === '/v1/auth/mfa/enrollment' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!currentMfaSetup(user)) {
        sendJson(res, 409, { message: 'MFA setup has not been started.' });
        return;
      }
      if (String(body.code ?? '').trim() !== '123456') {
        sendJson(res, 400, { message: 'Invalid authenticator code.' });
        return;
      }
      markCurrentMfaEnrolled(user);
      sendJson(res, 200, {
        ...effectiveMfaStatusPayload(user),
        recoveryCodes: mockMfaRecoveryCodes,
      }, { 'set-cookie': authCookies(currentToken(req) ?? 'mock-admin-access') });
      return;
    }
    if (pathname === '/v1/auth/mfa/enrollment' && req.method === 'DELETE') {
      const body = await readBody(req);
      const code = String(body.code ?? '').trim();
      if (!effectiveMfaStatusPayload(user).enabled) {
        sendJson(res, 409, { message: 'MFA is not enabled.' });
        return;
      }
      if (code !== '123456' && !mockMfaRecoveryCodes.includes(code)) {
        sendJson(res, 400, { message: 'Invalid authenticator or recovery code.' });
        return;
      }
      markCurrentMfaDisabled(user);
      sendJson(res, 200, effectiveMfaStatusPayload(user));
      return;
    }

    if (pathname === '/v1/notifications' && req.method === 'GET') {
      sendJson(res, 200, { data: state.notifications, unreadCount: state.notifications.filter((item) => !item.readAt).length });
      return;
    }
    if ((pathname === '/v1/notifications/read' || pathname === '/v1/notifications/read-all') && req.method === 'POST') {
      state.notifications = state.notifications.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }));
      sendJson(res, 200, { success: true });
      return;
    }

    if (pathname === '/v1/users/directory-summary' && req.method === 'GET') {
      const directoryUsers = [{ role: user.role }, ...state.staff];
      sendJson(res, 200, {
        totalUsers: directoryUsers.length,
        staffCount: directoryUsers.filter((candidate) => candidate.role === 'STAFF' || candidate.role === 'MANAGER').length,
        managerCount: directoryUsers.filter((candidate) => candidate.role === 'MANAGER').length,
        privilegedUsers: directoryUsers.filter((candidate) => candidate.role === 'SUPER_ADMIN' || candidate.role === 'ADMIN').length,
        pinAccounts: directoryUsers.length,
      });
      return;
    }
    if (pathname === '/v1/users' && req.method === 'GET') {
      const directoryUsers = [{ id: user.id, name: user.name, username: user.username, role: user.role }, ...state.staff];
      sendJson(res, 200, {
        data: directoryUsers,
        summary: {
          totalUsers: directoryUsers.length,
          staffCount: directoryUsers.filter((candidate) => candidate.role === 'STAFF' || candidate.role === 'MANAGER').length,
          managerCount: directoryUsers.filter((candidate) => candidate.role === 'MANAGER').length,
          privilegedUsers: directoryUsers.filter((candidate) => candidate.role === 'SUPER_ADMIN' || candidate.role === 'ADMIN').length,
          pinAccounts: directoryUsers.length,
        },
      });
      return;
    }
    if (pathname === '/v1/users/access/catalog' && req.method === 'GET') {
      sendJson(res, 200, { roles: [], permissions: [] });
      return;
    }
    const schedulingProfileMatch = /^\/v1\/users\/([^/]+)\/scheduling-profile$/.exec(pathname);
    if (schedulingProfileMatch && req.method === 'GET') {
      const staffMember = state.staff.find((candidate) => candidate.id === schedulingProfileMatch[1]);
      if (!staffMember) {
        sendJson(res, 404, { message: 'User not found.' });
        return;
      }
      const profile = state.schedulingProfiles.get(staffMember.id) ?? { skills: [], availability: [] };
      sendJson(res, 200, {
        user: { id: staffMember.id, name: staffMember.name },
        ...profile,
        availabilityConfigured: profile.availability.length > 0,
      });
      return;
    }
    if (schedulingProfileMatch && req.method === 'PUT') {
      const staffMember = state.staff.find((candidate) => candidate.id === schedulingProfileMatch[1]);
      const body = await readBody(req);
      if (!staffMember || !Array.isArray(body.skills) || !Array.isArray(body.availability)) {
        sendJson(res, 400, { message: 'Invalid scheduling profile.' });
        return;
      }
      const profile = {
        skills: [...new Set(body.skills.map((skill) => String(skill).trim().replace(/\s+/g, ' ').toLowerCase()))].sort(),
        availability: body.availability,
      };
      state.schedulingProfiles.set(staffMember.id, profile);
      sendJson(res, 200, {
        user: { id: staffMember.id },
        ...profile,
        availabilityConfigured: profile.availability.length > 0,
      });
      return;
    }

    if (pathname === '/v1/locations/summary' && req.method === 'GET') {
      sendJson(res, 200, { count: state.locations.length });
      return;
    }
    const locationReadMatch = new RegExp('^/v1/locations/([^/]+)$').exec(pathname);
    if (locationReadMatch && req.method === 'GET') {
      const location = state.locations.find((candidate) => candidate.id === decodeURIComponent(locationReadMatch[1]));
      if (!location) {
        sendJson(res, 404, { message: 'Location not found.' });
        return;
      }
      sendJson(res, 200, location);
      return;
    }
    if (pathname === '/v1/locations' && req.method === 'GET') {
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
      const requestedOffset = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10);
      const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
      const ordered = state.locations.slice().sort((left, right) => (
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      ));
      const data = ordered.slice(offset, offset + limit);
      const hasMore = offset + data.length < ordered.length;
      sendJson(res, 200, {
        data,
        pagination: {
          limit,
          maxLimit: 200,
          returned: data.length,
          hasMore,
          nextCursor: hasMore ? String(offset + data.length) : null,
        },
      });
      return;
    }

    if (pathname === '/v1/schedules' && req.method === 'POST') {
      const body = await readBody(req);
      const location = state.locations.find((candidate) => candidate.id === body.locationId);
      if (!location || typeof body.startDate !== 'string' || typeof body.endDate !== 'string') {
        sendJson(res, 400, { message: 'locationId, startDate, and endDate are required.' });
        return;
      }
      const schedule = {
        id: `schedule-${crypto.randomUUID()}`,
        publicId: crypto.randomUUID(),
        locationId: location.id,
        startDate: new Date(`${body.startDate}T00:00:00.000Z`).toISOString(),
        endDate: new Date(`${body.endDate}T00:00:00.000Z`).toISOString(),
        status: 'DRAFT',
        revision: 0,
        publishedAt: null,
      };
      state.schedules.push(schedule);
      sendJson(res, 201, schedule);
      return;
    }
    if (pathname === '/v1/schedules' && req.method === 'GET') {
      sendJson(res, 200, { data: state.schedules });
      return;
    }
    const scheduleDemandMatch = /^\/v1\/schedules\/([^/]+)\/demand-windows$/.exec(pathname);
    if (scheduleDemandMatch && req.method === 'GET') {
      const schedule = state.schedules.find((candidate) => candidate.id === scheduleDemandMatch[1]);
      if (!schedule) {
        sendJson(res, 404, { message: 'Schedule not found.' });
        return;
      }
      sendJson(res, 200, { data: state.demandWindowsBySchedule.get(schedule.id) ?? [] });
      return;
    }
    if (scheduleDemandMatch && req.method === 'PUT') {
      const schedule = state.schedules.find((candidate) => candidate.id === scheduleDemandMatch[1]);
      const body = await readBody(req);
      if (!schedule || schedule.status !== 'DRAFT' || !Array.isArray(body.windows)) {
        sendJson(res, 400, { message: 'Draft schedule demand windows are required.' });
        return;
      }
      const windows = body.windows.map((window) => ({ id: `demand-${crypto.randomUUID()}`, ...window }));
      state.demandWindowsBySchedule.set(schedule.id, windows);
      sendJson(res, 200, { data: windows });
      return;
    }
    const scheduleAutoMatch = /^\/v1\/schedules\/([^/]+)\/auto-schedule$/.exec(pathname);
    if (scheduleAutoMatch && req.method === 'POST') {
      if (typeof req.headers['idempotency-key'] !== 'string' || !req.headers['idempotency-key'].trim()) {
        sendJson(res, 400, { message: 'Idempotency-Key header is required for auto-schedule requests.' });
        return;
      }
      const schedule = state.schedules.find((candidate) => candidate.id === scheduleAutoMatch[1]);
      if (!schedule || schedule.status !== 'DRAFT') {
        sendJson(res, 400, { message: 'Only draft schedules can be auto-scheduled.' });
        return;
      }
      if ((state.demandWindowsBySchedule.get(schedule.id) ?? []).length === 0) {
        sendJson(res, 400, { message: 'Configure at least one demand window before auto-scheduling.' });
        return;
      }
      if (!requireBillableAccess(res)) return;
      const creditConsumption = consumeMockUsageCredit();
      const job = {
        jobId: `job-${crypto.randomUUID()}`,
        scheduleId: schedule.id,
        locationId: schedule.locationId,
        status: 'SUCCEEDED',
        statusReason: null,
        retryCount: 0,
        resultShiftCount: state.shifts.filter((shift) => shift.scheduleId === schedule.id).length,
        creditConsumption,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      state.scheduleJobs.push(job);
      sendJson(res, 202, {
        jobId: job.jobId,
        status: 'QUEUED',
        statusUrl: `/v1/schedules/${schedule.id}/auto-schedule/jobs/${job.jobId}`,
      });
      return;
    }
    const scheduleJobMatch = /^\/v1\/schedules\/([^/]+)\/auto-schedule\/jobs\/([^/]+)$/.exec(pathname);
    if (scheduleJobMatch && req.method === 'GET') {
      const job = state.scheduleJobs.find((candidate) => candidate.scheduleId === scheduleJobMatch[1] && candidate.jobId === scheduleJobMatch[2]);
      if (!job) {
        sendJson(res, 404, { message: 'Auto-schedule job not found.' });
        return;
      }
      sendJson(res, 200, job);
      return;
    }
    const schedulePublishPreflightMatch = /^\/v1\/schedules\/([^/]+)\/publish\/preflight$/.exec(pathname);
    if (schedulePublishPreflightMatch && req.method === 'GET') {
      const schedule = state.schedules.find((candidate) => candidate.id === schedulePublishPreflightMatch[1]);
      if (!schedule || schedule.status !== 'DRAFT') {
        sendJson(res, 404, { message: 'Draft schedule not found.' });
        return;
      }
      if (!hasActivePaidSubscription()) {
        sendJson(res, 403, { message: 'An active paid subscription is required for schedule publication.' });
        return;
      }
      sendJson(res, 200, schedulePublishPreflight(schedule));
      return;
    }

    const scheduleReopenMatch = /^\/v1\/schedules\/([^/]+)\/reopen$/.exec(pathname);
    if (scheduleReopenMatch && req.method === 'POST') {
      const schedule = state.schedules.find((candidate) => candidate.id === scheduleReopenMatch[1]);
      if (!schedule || schedule.status !== 'PUBLISHED') {
        sendJson(res, 400, { message: 'Only published schedules can be reopened.' });
        return;
      }
      schedule.status = 'DRAFT';
      schedule.publishedAt = null;
      sendJson(res, 200, { id: schedule.id, status: schedule.status, publishedAt: null });
      return;
    }

    const schedulePublishMatch = /^\/v1\/schedules\/([^/]+)\/publish$/.exec(pathname);
    if (schedulePublishMatch && req.method === 'POST') {
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].trim()
        : '';
      if (!idempotencyKey) {
        sendJson(res, 400, { message: 'Idempotency-Key header is required for schedule publication.' });
        return;
      }
      const body = await readBody(req);
      const requestHash = crypto.createHash('sha256')
        .update(JSON.stringify({
          action: 'schedule.publish',
          scheduleId: schedulePublishMatch[1],
          acceptedContract: body.acceptedContract,
        }))
        .digest('hex');
      const existingRequest = state.schedulePublishRequests.get(idempotencyKey);
      if (existingRequest) {
        if (existingRequest.requestHash !== requestHash) {
          sendJson(res, 409, { message: 'Idempotency-Key was already used with a different schedule publish request.' });
          return;
        }
        sendJson(res, 200, existingRequest.response);
        return;
      }
      const schedule = state.schedules.find((candidate) => candidate.id === schedulePublishMatch[1]);
      if (!schedule || schedule.status !== 'DRAFT') {
        sendJson(res, 400, { message: 'Only draft schedules can be published.' });
        return;
      }
      if (!state.shifts.some((shift) => shift.scheduleId === schedule.id)) {
        sendJson(res, 400, { message: 'Add at least one shift before publishing this schedule.' });
        return;
      }
      if (!hasActivePaidSubscription()) {
        sendJson(res, 403, { message: 'An active paid subscription is required for schedule publication.' });
        return;
      }
      const preflight = schedulePublishPreflight(schedule);
      if (!schedulePublishContractMatches(body.acceptedContract, preflight.acceptedContract)) {
        sendJson(res, 409, {
          message: 'Schedule or configured publish cost changed after confirmation. Review and confirm the current preflight.',
          preflight,
        });
        return;
      }
      if (!preflight.sufficientCredits) {
        sendJson(res, 403, {
          message: 'Insufficient usage credits balance for schedule publication and matching webhook deliveries.',
          preflight,
        });
        return;
      }
      const creditConsumption = consumeMockUsageCredit();
      schedule.status = 'PUBLISHED';
      schedule.publishedAt = new Date().toISOString();
      const response = {
        id: schedule.id,
        status: schedule.status,
        publishedAt: schedule.publishedAt,
        settlement: {
          ...preflight.acceptedContract,
          acceptedContract: preflight.acceptedContract,
          creditsConsumed: preflight.totalConfiguredCost,
          newBalance: creditConsumption.newBalance,
          ledgerIdentities: {
            schedule: `feature-usage-schedule-publish:${requestHash}`,
            webhookDeliveries: [],
          },
        },
        notifications: { status: 'DELIVERED', delivered: 1, pending: 0, failed: 0 },
      };
      state.schedulePublishRequests.set(idempotencyKey, { requestHash, response });
      sendJson(res, 200, response);
      return;
    }

    if (pathname === '/v1/shifts/staff-roster' && req.method === 'GET') {
      sendJson(res, 200, { data: state.staff });
      return;
    }
    if (pathname === '/v1/shifts' && req.method === 'GET') {
      const scheduleId = url.searchParams.get('scheduleId');
      const locationId = url.searchParams.get('locationId');
      const startDate = url.searchParams.get('startDate');
      const endDate = url.searchParams.get('endDate');
      const startTs = startDate ? Date.parse(startDate) : null;
      const endTs = endDate ? Date.parse(endDate) : null;
      const shifts = state.shifts.filter((shift) => {
        if (scheduleId && shift.scheduleId !== scheduleId) return false;
        if (locationId && shift.locationId !== locationId) return false;
        if (startTs !== null && Date.parse(shift.endTime) <= startTs) return false;
        if (endTs !== null && Date.parse(shift.startTime) >= endTs) return false;
        return true;
      });
      sendJson(res, 200, { data: shifts.map(decorateShift) });
      return;
    }
    if (pathname === '/v1/shifts' && req.method === 'POST') {
      const body = await readBody(req);
      const schedule = scheduleForShift(body.locationId, body.startTime, body.endTime, body.scheduleId);
      if (!schedule) {
        sendJson(res, 400, { message: 'A containing draft schedule is required.' });
        return;
      }
      const shift = {
        id: `shift-${crypto.randomUUID()}`,
        publicId: crypto.randomUUID(),
        locationId: body.locationId,
        scheduleId: schedule.id,
        userId: body.userId ?? null,
        role: body.role ?? 'STAFF',
        startTime: body.startTime,
        endTime: body.endTime,
        breaks: [],
      };
      state.shifts.push(shift);
      sendJson(res, 201, decorateShift(shift));
      return;
    }
    const shiftMatch = /^\/v1\/shifts\/([^/]+)$/.exec(pathname);
    if (shiftMatch && req.method === 'PUT') {
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].trim()
        : '';
      if (!idempotencyKey) {
        sendJson(res, 400, { message: 'Idempotency-Key header is required for shift updates.' });
        return;
      }
      const body = await readBody(req);
      const requestHash = crypto.createHash('sha256')
        .update(JSON.stringify({ shiftId: shiftMatch[1], ...body }))
        .digest('hex');
      const existingRequest = state.shiftUpdateRequests.get(idempotencyKey);
      if (existingRequest) {
        if (existingRequest.requestHash !== requestHash) {
          sendJson(res, 409, { message: 'Idempotency-Key was already used with a different shift update request.' });
          return;
        }
        sendJson(res, 200, existingRequest.response);
        return;
      }
      const index = state.shifts.findIndex((shift) => shift.id === shiftMatch[1]);
      if (index === -1) {
        sendJson(res, 404, { message: 'Shift not found.' });
        return;
      }
      if (!requireBillableAccess(res)) return;
      state.shifts[index] = { ...state.shifts[index], ...body };
      consumeMockUsageCredit();
      const response = decorateShift(state.shifts[index]);
      state.shiftUpdateRequests.set(idempotencyKey, { requestHash, response });
      sendJson(res, 200, response);
      return;
    }
    if (shiftMatch && req.method === 'DELETE') {
      state.shifts = state.shifts.filter((shift) => shift.id !== shiftMatch[1]);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/v1/lunch-breaks' && req.method === 'GET') {
      sendJson(res, 200, { data: lunchRows() });
      return;
    }
    if (pathname === '/v1/lunch-breaks/policy' && req.method === 'GET') {
      sendJson(res, 200, {
        break1OffsetMinutes: 120,
        lunchOffsetMinutes: 240,
        break2OffsetMinutes: 360,
        break1DurationMinutes: 10,
        lunchDurationMinutes: 30,
        break2DurationMinutes: 10,
        timeStepMinutes: 5,
      });
      return;
    }
    if (pathname === '/v1/lunch-breaks/generate' && req.method === 'POST') {
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].trim()
        : '';
      if (!idempotencyKey) {
        sendJson(res, 400, { message: 'Idempotency-Key header is required for lunch/break generation requests.' });
        return;
      }
      const body = await readBody(req);
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const existingRequest = state.lunchBreakGenerationRequests.get(idempotencyKey);
      if (existingRequest) {
        if (existingRequest.requestHash !== requestHash) {
          sendJson(res, 409, { message: 'Idempotency-Key was already used with a different lunch/break generation request.' });
          return;
        }
        sendJson(res, 201, { ...existingRequest.response, reused: true });
        return;
      }
      const ids = Array.isArray(body.shiftIds) ? body.shiftIds : [];
      if (!requireBillableAccess(res)) return;
      state.shifts = state.shifts.map((shift) => ids.includes(shift.id) ? { ...shift, breaks: shiftBreaks(shift) } : shift);
      const response = {
        source: 'shared_schedule',
        persisted: true,
        creditConsumption: consumeMockUsageCredit(),
        data: lunchRows().filter((row) => ids.includes(row.shiftId)),
        reused: false,
      };
      state.lunchBreakGenerationRequests.set(idempotencyKey, { requestHash, response });
      sendJson(res, 201, response);
      return;
    }

    if (pathname === '/v1/billing/features' && req.method === 'GET') {
      const billableFeature = billableFeatureResolution();
      sendJson(res, 200, {
        ...state.billing,
        features: {
          scheduling: billableFeature,
          lunch_breaks: billableFeature,
          time_cards: billableFeature,
        },
      });
      return;
    }
    if (pathname === '/v1/billing/price-options' && req.method === 'GET') {
      sendJson(res, 200, {
        data: [
          { code: 'STARTER', label: 'Starter', priceId: 'price_mock_starter', configured: true },
          { code: 'GROWTH', label: 'Growth', priceId: 'price_mock_growth', configured: true },
          { code: 'ENTERPRISE', label: 'Enterprise', priceId: null, configured: false },
        ],
      });
      return;
    }
    if (pathname === '/v1/billing/credit-packs' && req.method === 'GET') {
      sendJson(res, 200, { data: creditPackOptions });
      return;
    }
    if (pathname === '/v1/billing/credit-packs/checkout' && req.method === 'POST') {
      if (!hasActivePaidSubscription()) {
        sendJson(res, 403, { message: 'An active paid subscription is required to purchase credits.' });
        return;
      }
      const body = await readBody(req);
      const option = creditPackOptions.find((candidate) => candidate.code === body.code);
      if (!option?.configured) {
        sendJson(res, 400, { message: 'Credit pack is not available.' });
        return;
      }
      sendJson(res, 200, {
        sessionId: 'cs_test_mock_credit_pack',
        checkoutUrl: 'https://checkout.stripe.com/mock-credit-pack',
      });
      return;
    }
    if (pathname === '/v1/billing/subscribe' && req.method === 'POST') {
      sendJson(res, 200, {
        sessionId: 'cs_test_mock',
        checkoutUrl: 'https://checkout.stripe.com/mock-session',
      });
      return;
    }

    if (pathname === '/v1/payroll/export-entitlement' && req.method === 'GET') {
      const resolution = billableFeatureResolution();
      sendJson(res, 200, {
        enabled: resolution.enabled && user.permissions.includes('payroll:export'),
        creditCost: resolution.creditCost,
        usageCredits: state.billing.usageCredits,
      });
      return;
    }
    if (pathname === '/v1/payroll/policy' && req.method === 'GET') {
      sendJson(res, 200, payrollPolicy);
      return;
    }
    if (pathname === '/v1/payroll/policies' && req.method === 'GET') {
      sendJson(res, 200, { data: [payrollPolicy], nextCursor: null });
      return;
    }
    if (pathname === '/v1/payroll/periods' && req.method === 'GET') {
      sendJson(res, 200, {
        data: [payrollPeriod(state.payroll.exportCreated, state.billing.usageCredits)],
        nextCursor: null,
      });
      return;
    }
    if (pathname === '/v1/payroll/periods/payroll-period-1' && req.method === 'GET') {
      sendJson(res, 200, payrollPeriodDetail(state.payroll.exportCreated, state.billing.usageCredits));
      return;
    }
    if (pathname === '/v1/payroll/periods/payroll-period-1/exports' && req.method === 'POST') {
      if (!user.permissions.includes('payroll:export')) {
        sendJson(res, 403, { message: 'Payroll export permission is required.' });
        return;
      }
      if (!requireBillableAccess(res)) return;
      const body = await readBody(req);
      if (body.expectedCreditCost !== 1) {
        sendJson(res, 409, { message: 'Payroll export credit cost changed.' });
        return;
      }
      const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
      if (!idempotencyKey) {
        sendJson(res, 400, { message: 'Idempotency-Key is required.' });
        return;
      }
      const replay = state.payroll.exportRequests.get(idempotencyKey);
      if (replay) {
        sendJson(res, 200, replay);
        return;
      }
      if (!state.payroll.exportCreated) {
        consumeMockUsageCredit();
        state.payroll.exportCreated = true;
      }
      const batch = payrollExportBatch(state.billing.usageCredits);
      state.payroll.exportRequests.set(idempotencyKey, batch);
      sendJson(res, 201, batch);
      return;
    }
    if (pathname === '/v1/payroll/exports/payroll-batch-1' && req.method === 'GET') {
      if (!state.payroll.exportCreated) {
        sendJson(res, 404, { message: 'Payroll export not found.' });
        return;
      }
      sendJson(res, 200, payrollExportBatch(state.billing.usageCredits));
      return;
    }
    if (pathname === '/v1/payroll/exports/payroll-batch-1/download' && req.method === 'GET') {
      if (!state.payroll.exportCreated) {
        sendJson(res, 404, { message: 'Payroll export not found.' });
        return;
      }
      sendText(res, 200, 'employee_id,payable_minutes\nuser-mock-staff,450\n', {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="payroll-period-1.csv"',
      });
      return;
    }
    if (pathname === '/v1/payroll/exports/payroll-batch-1/reconciliation' && req.method === 'POST') {
      if (!user.permissions.includes('payroll:reconcile')) {
        sendJson(res, 403, { message: 'Payroll reconciliation permission is required.' });
        return;
      }
      await readBody(req);
      sendJson(res, 200, { recorded: true });
      return;
    }

    if (pathname === '/v1/time-cards/active' && req.method === 'GET') {
      const selectedUserId = url.searchParams.get('userId') ?? user.id;
      const card = state.timeCards.find((entry) => entry.userId === selectedUserId && entry.status === 'OPEN') ?? null;
      sendJson(res, 200, { data: card ? toTimeCard(card) : null });
      return;
    }
    if (pathname === '/v1/time-cards' && req.method === 'GET') {
      const selectedUserId = url.searchParams.get('userId');
      const cards = state.timeCards
        .filter((entry) => !selectedUserId || entry.userId === selectedUserId)
        .map(toTimeCard);
      sendJson(res, 200, { data: cards });
      return;
    }
    if (pathname === '/v1/time-cards/clock-in' && req.method === 'POST') {
      if (!String(req.headers['idempotency-key'] ?? '').trim()) {
        sendJson(res, 400, { message: 'Idempotency-Key header is required.' });
        return;
      }
      if (!requireBillableAccess(res)) return;
      const body = await readBody(req);
      const card = {
        id: `time-card-${crypto.randomUUID()}`,
        userId: body.userId ?? user.id,
        locationId: body.locationId ?? state.locations[0]?.id ?? null,
        clockInAt: new Date(Date.now() - 30 * 60000).toISOString(),
        clockOutAt: null,
        breakMinutes: 0,
        status: 'OPEN',
        notes: body.notes ?? null,
      };
      state.timeCards.push(card);
      consumeMockUsageCredit();
      sendJson(res, 201, { data: toTimeCard(card) });
      return;
    }
    const clockOutMatch = /^\/v1\/time-cards\/([^/]+)\/clock-out$/.exec(pathname);
    if (clockOutMatch && req.method === 'POST') {
      const body = await readBody(req);
      const card = state.timeCards.find((entry) => entry.id === clockOutMatch[1]);
      if (!card) {
        sendJson(res, 404, { message: 'Time card not found.' });
        return;
      }
      const breakMinutes = Number.parseInt(String(body.breakMinutes ?? '0'), 10);
      if (breakMinutes >= 30) {
        sendJson(res, 400, { message: 'Break minutes must be less than worked minutes.' });
        return;
      }
      if (!requireBillableAccess(res)) return;
      card.clockOutAt = new Date().toISOString();
      card.breakMinutes = Number.isFinite(breakMinutes) ? breakMinutes : 0;
      card.status = 'CLOSED';
      consumeMockUsageCredit();
      sendJson(res, 200, { data: toTimeCard(card) });
      return;
    }

    sendJson(res, 404, { message: `Unhandled mock endpoint: ${req.method} ${pathname}` });
  } catch (error) {
    sendJson(res, 500, { message: error instanceof Error ? error.message : 'Mock API error.' });
  }
});

server.on('error', (error) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(`LunchLineup E2E mock API port ${port} is already in use. Set PLAYWRIGHT_API_PORT to a free port.`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`LunchLineup E2E mock API listening on http://127.0.0.1:${port}`);
});
