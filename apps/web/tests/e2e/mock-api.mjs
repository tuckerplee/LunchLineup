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
const mockMfaSecret = 'JBSWY3DPEHPK3PXP';
const mockMfaRecoveryCodes = ['LL-4F8K-92HD', 'LL-73QW-1PZM', 'LL-8T2N-6YKC'];

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
  const location = { id: 'loc-downtown', name: process.env.E2E_LOCATION_NAME ?? 'Downtown Diner' };
  const adminTenant = {
    id: 'tenant-e2e',
    name: tenantName,
    slug: tenantSlug,
    planTier: 'ENTERPRISE',
    status: 'ACTIVE',
  };
  const admin = {
    id: 'user-admin',
    sub: 'user-admin',
    tenantId: 'tenant-e2e',
    sessionId: 'session-admin',
    email: null,
    username: adminUsername,
    name: 'E2E Admin',
    role: 'ADMIN',
    permissions,
    roles: [{ id: 'role-admin', name: 'Admin' }],
    tenantName,
  };
  const superAdmin = {
    ...admin,
    id: 'user-super-admin',
    sub: 'user-super-admin',
    sessionId: 'session-super-admin',
    username: superAdminUsername,
    name: 'E2E Super Admin',
    role: 'SUPER_ADMIN',
    permissions: [...permissions, 'admin_portal:access'],
    roles: [{ id: 'role-super-admin', name: 'System Admin' }],
  };
  const manager = {
    ...admin,
    id: 'user-manager',
    sub: 'user-manager',
    sessionId: 'session-manager',
    username: managerUsername,
    name: 'E2E Manager',
    role: 'MANAGER',
    permissions: permissions.filter((permission) => permission !== 'users:admin' && !permission.startsWith('roles:')),
    roles: [{ id: 'role-manager', name: 'Manager' }],
  };
  const mfaAdmin = {
    ...admin,
    id: 'user-mfa-admin',
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
    { id: 'user-mock-staff', name: 'Mock Staff', username: 'mock.staff', role: 'STAFF' },
    { id: 'user-mock-manager', name: 'Mock Manager', username: 'mock.manager', role: 'MANAGER' },
  ];
  const adminUsers = [
    { account: superAdmin, mfaEnabled: true },
    { account: admin, mfaEnabled: false },
    { account: mfaAdmin, mfaEnabled: true },
  ].map(({ account, mfaEnabled }) => ({
    id: account.id,
    name: account.name,
    email: account.email,
    username: account.username,
    role: account.role,
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
    schedules: [],
    demandWindowsBySchedule: new Map(),
    scheduleJobs: [],
    lunchBreakGenerationRequests: new Map(),
  };
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

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
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
  if (type.includes('application/json')) {
    return text ? JSON.parse(text) : {};
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.access_token;
  return token ? state.usersByToken.get(token) ?? null : null;
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
    locationId,
    startDate,
    endDate,
    status: 'DRAFT',
    publishedAt: null,
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

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
        sendText(res, 303, '', { location: `/auth/login?tenantSlug=${tenantSlug}&step=pin&error=invalid` });
        return;
      }
      const next = url.searchParams.get('next') || '/dashboard';
      if (url.searchParams.get('redirect') === '1') {
        sendText(res, 303, '', { location: next, 'set-cookie': authCookies(account.token) });
        return;
      }
      sendJson(res, 200, { success: true, user: account.user }, { 'set-cookie': authCookies(account.token) });
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

    if (pathname === '/v1/users' && req.method === 'GET') {
      sendJson(res, 200, { data: [{ id: user.id, name: user.name, username: user.username, role: user.role }, ...state.staff] });
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

    if (pathname === '/v1/locations' && req.method === 'GET') {
      sendJson(res, 200, { data: state.locations });
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
        locationId: location.id,
        startDate: new Date(`${body.startDate}T00:00:00.000Z`).toISOString(),
        endDate: new Date(`${body.endDate}T00:00:00.000Z`).toISOString(),
        status: 'DRAFT',
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
      const job = {
        jobId: `job-${crypto.randomUUID()}`,
        scheduleId: schedule.id,
        locationId: schedule.locationId,
        status: 'SUCCEEDED',
        statusReason: null,
        retryCount: 0,
        resultShiftCount: state.shifts.filter((shift) => shift.scheduleId === schedule.id).length,
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
    const schedulePublishMatch = /^\/v1\/schedules\/([^/]+)\/publish$/.exec(pathname);
    if (schedulePublishMatch && req.method === 'POST') {
      const schedule = state.schedules.find((candidate) => candidate.id === schedulePublishMatch[1]);
      if (!schedule || schedule.status !== 'DRAFT') {
        sendJson(res, 400, { message: 'Only draft schedules can be published.' });
        return;
      }
      if (!state.shifts.some((shift) => shift.scheduleId === schedule.id)) {
        sendJson(res, 400, { message: 'Add at least one shift before publishing this schedule.' });
        return;
      }
      schedule.status = 'PUBLISHED';
      schedule.publishedAt = new Date().toISOString();
      sendJson(res, 200, {
        id: schedule.id,
        status: schedule.status,
        publishedAt: schedule.publishedAt,
        notifications: { status: 'DELIVERED', delivered: 1, failed: 0 },
      });
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
      const body = await readBody(req);
      const index = state.shifts.findIndex((shift) => shift.id === shiftMatch[1]);
      if (index === -1) {
        sendJson(res, 404, { message: 'Shift not found.' });
        return;
      }
      state.shifts[index] = { ...state.shifts[index], ...body };
      sendJson(res, 200, decorateShift(state.shifts[index]));
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
      state.shifts = state.shifts.map((shift) => ids.includes(shift.id) ? { ...shift, breaks: shiftBreaks(shift) } : shift);
      const response = {
        source: 'shared_schedule',
        persisted: true,
        creditConsumption: { consumedCredits: 0, newBalance: 500 },
        data: lunchRows().filter((row) => ids.includes(row.shiftId)),
        reused: false,
      };
      state.lunchBreakGenerationRequests.set(idempotencyKey, { requestHash, response });
      sendJson(res, 201, response);
      return;
    }

    if (pathname === '/v1/billing/features' && req.method === 'GET') {
      sendJson(res, 200, {
        planTier: 'GROWTH',
        status: 'ACTIVE',
        stripeSubscriptionActive: true,
        usageCredits: 500,
        features: {
          scheduling: { enabled: true, source: 'plan', reason: 'Mock readiness plan includes scheduling.', creditCost: null },
          lunch_breaks: { enabled: true, source: 'plan', reason: 'Mock readiness plan includes lunch breaks.', creditCost: 0 },
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
    if (pathname === '/v1/billing/subscribe' && req.method === 'POST') {
      sendJson(res, 200, {
        sessionId: 'cs_test_mock',
        checkoutUrl: 'https://checkout.stripe.com/mock-session',
      });
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
      card.clockOutAt = new Date().toISOString();
      card.breakMinutes = Number.isFinite(breakMinutes) ? breakMinutes : 0;
      card.status = 'CLOSED';
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
