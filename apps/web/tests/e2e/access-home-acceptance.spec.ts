import { createHash, randomUUID } from 'node:crypto';
import type { APIRequestContext, BrowserContext, Page, TestInfo } from '@playwright/test';
import type {
  BrowserSessionIdentity, CurrentSessionResponse, LocationSummaryResponse, NotificationListResponse,
  NotificationReadResponse, ProblemDetails, ScheduleBoardResponse, ScheduleChangeSetResponse, ScheduleCreateResponse,
  SchedulePublicationResponse, SchedulePublishPlanResponse, StaffDirectoryResponse, StaffSchedulingProfile, ShiftSummaryListResponse, WorkspaceSettings,
} from '@lunchlineup/api-contract';
import { expect, test } from './qa-isolation-fixture';
import { closeQaContexts } from './qa-context-cleanup';
import {
  csrfHeaders, dayWindow, e2eAdminUsername, e2eStaffPin, e2eStaffUsername, e2eTenantName, e2eTenantSlug,
  loginAsSeedAdmin, loginAsSeedManager, loginWithPin, runFullStack, seedTenant,
} from './support';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

type BrowserError = { kind: string; path: string; messageSha256: string; expectedNativeDenial: boolean };
let browserErrors: BrowserError[] = [];
let expectedBrowserDenials: Array<{ path: string; status: number; remaining: number }> = [];

function recordNativeFailure(path: string, error: unknown) {
  browserErrors.push({ kind: 'native-read-error', path: path.split('?')[0],
    messageSha256: createHash('sha256').update(error instanceof Error ? error.message : String(error)).digest('hex'),
    expectedNativeDenial: false });
}

function observeErrors(page: Page) {
  page.on('pageerror', error => browserErrors.push({
    kind: 'pageerror', path: new URL(page.url()).pathname,
    messageSha256: createHash('sha256').update(error.message).digest('hex'), expectedNativeDenial: false,
  }));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    let path = '';
    try { path = new URL(message.location().url).pathname; } catch { /* No URL means no expected-denial match. */ }
    const status = /^Failed to load resource: the server responded with a status of (401|403|429) \(/.exec(message.text());
    const expected = status && expectedBrowserDenials.find(item => item.path === path
      && item.status === Number(status[1]) && item.remaining > 0);
    if (expected) expected.remaining--;
    browserErrors.push({ kind: 'consoleerror', path,
      messageSha256: createHash('sha256').update(message.text()).digest('hex'), expectedNativeDenial: Boolean(expected) });
  });
}

async function readJson<T>(request: APIRequestContext, path: string, options: {
  method?: 'GET' | 'POST' | 'PUT'; data?: unknown; headers?: Record<string, string>; status?: number;
} = {}): Promise<T> {
  const response = await request.fetch(path, {
    method: options.method ?? 'GET', data: options.data, headers: options.headers,
    timeout: REQUEST_TIMEOUT_MS, maxRetries: 0, maxRedirects: 0,
  }).catch(error => { recordNativeFailure(path, error); throw error; });
  try {
    expect(response.status(), `Native status for ${path.split('?')[0]}`).toBe(options.status ?? 200);
    const bytes = await response.body();
    expect(bytes.length, 'Native readback stays within the fixture response budget').toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch (error) { recordNativeFailure(path, error); throw error; }
  finally { await response.dispose().catch(error => { recordNativeFailure(path, error); throw error; }); }
}

async function statusOnly(request: APIRequestContext, path: string, status: number, options: {
  method?: 'GET' | 'PUT' | 'POST'; data?: unknown; headers?: Record<string, string>;
} = {}) {
  const response = await request.fetch(path, { ...options, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0, maxRedirects: 0 });
  try { expect(response.status(), `Native denial for ${path.split('?')[0]}`).toBe(status); }
  finally { await response.dispose(); }
}

async function mutationHeaders(page: Page, extra: Record<string, string> = {}) {
  return { ...(await csrfHeaders(page)), Origin: new URL(page.url()).origin, ...extra };
}

async function identity(page: Page, role: BrowserSessionIdentity['role']) {
  const { user } = await readJson<CurrentSessionResponse>(page.request, '/api/v2/auth/me');
  expect(user.role).toBe(role);
  expect(user.workspaceName).toBe(e2eTenantName);
  expect(user.publicUserId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(user.mfaVerified).toBe(true);
  expect(user.pinResetRequired === true).toBe(false);
  expect(typeof user.workspaceScope === 'string' && /^[A-Za-z0-9_-]{43}$/.test(user.workspaceScope)).toBe(true);
  expect(typeof user.sessionScope === 'string' && /^[A-Za-z0-9_-]{43}$/.test(user.sessionScope)).toBe(true);
  expect(user.permissions.includes('dashboard:access')).toBe(true);
  return user;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function evidence(info: TestInfo, name: string, facts: Record<string, unknown>) {
  await info.attach(name, { body: JSON.stringify(facts, null, 2), contentType: 'application/json' });
}

async function loginStaff(page: Page) {
  await loginWithPin(page, { username: e2eStaffUsername, pin: e2eStaffPin, next: '/dashboard' });
  return identity(page, 'STAFF');
}

function fixtureDay(offset: number) {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

async function createSchedule(page: Page, offset: number, names: Array<'Staff One' | 'E2E Manager' | null>, key: string) {
  const date = fixtureDay(offset);
  const board = await readJson<ScheduleBoardResponse>(page.request, `/api/v2/schedule-board?date=${date}&view=day`);
  expect(board.data.locations).toHaveLength(1);
  const location = board.data.locations[0];
  expect(location.name).toBe('Downtown Diner');
  expect(location.timezone).toBe('America/Los_Angeles');
  const startDate = `${date}T08:00:00.000Z`;
  const endDate = new Date(Date.parse(startDate) + 24 * 60 * 60 * 1000).toISOString();
  const schedule = await readJson<ScheduleCreateResponse>(page.request, `/api/v2/locations/${location.id}/schedules`, {
    method: 'POST', data: { startDate, endDate }, headers: await mutationHeaders(page, { 'Idempotency-Key': `${key}-schedule` }),
  });
  const operations = names.map(name => {
    const matches = name ? board.data.staff.filter(member => member.name === name) : [];
    if (name) expect(matches, 'Exact seeded scheduling identity').toHaveLength(1);
    return { op: 'shift.create' as const, clientId: randomUUID(), userId: name ? matches[0].id : null,
      role: name === 'E2E Manager' ? 'MANAGER' : 'STAFF', startTime: `${date}T16:00:00.000Z`, endTime: `${date}T20:00:00.000Z` };
  });
  const changed = await readJson<ScheduleChangeSetResponse>(page.request, `/api/v2/schedules/${schedule.data.id}/change-sets`, {
    method: 'POST', data: { operations }, headers: await mutationHeaders(page, {
      'Idempotency-Key': `${key}-shifts`, 'If-Match': schedule.data.etag,
    }),
  });
  expect(changed.data.created).toHaveLength(names.length);
  return { scheduleId: schedule.data.id, locationId: location.id, date,
    assignedIds: operations.map(operation => operation.userId), shiftIds: changed.data.created.map(row => row.shiftId) };
}

async function configurePublicationAvailability(page: Page, schedules: Array<Awaited<ReturnType<typeof createSchedule>>>, info: TestInfo) {
  const locationIds = [...new Set(schedules.map(schedule => schedule.locationId))];
  expect(locationIds, 'The notification fixture uses one exact seeded location').toHaveLength(1);
  const dates = [...new Set(schedules.map(schedule => schedule.date))].sort();
  expect(dates, 'Two distinct publication dates').toHaveLength(2);
  const userIds = [...new Set(schedules.flatMap(schedule => schedule.assignedIds)
    .filter((id): id is string => id !== null))].sort();
  expect(userIds, 'The fixture has exactly two distinct assigned recipients').toHaveLength(2);
  for (const userId of userIds) {
    const path = `/api/v2/users/${userId}/scheduling-profile`;
    const before = await readJson<StaffSchedulingProfile>(page.request, path);
    expect(before.user.id).toBe(userId);
    expect(before.availabilityExceptions, 'Fresh seed has no retained dated availability').toEqual([]);
    // The four-hour shifts start at 16:00Z, within these LA local dates.
    // Configure real availability; publication readiness remains authoritative.
    const availabilityExceptions = dates.map(date => ({ locationId: locationIds[0], date,
      kind: 'AVAILABLE' as const, allDay: true, startTimeMinutes: 0, endTimeMinutes: 1440 }));
    const saved = await readJson<StaffSchedulingProfile>(page.request, path, {
      method: 'PUT', headers: await mutationHeaders(page), data: { expectedVersion: before.version,
        skills: before.skills, availability: before.availability, availabilityExceptions },
    });
    expect(saved.user.id).toBe(userId);
    expect(saved.skills).toEqual(before.skills);
    expect(saved.availability).toEqual(before.availability);
    expect(saved.availabilityExceptions).toEqual(availabilityExceptions);
    expect(saved.version).not.toBe(before.version);
    expect(await readJson<StaffSchedulingProfile>(page.request, path), 'Availability persists in an independent native read').toEqual(saved);
  }
  await evidence(info, 'native-publication-availability-setup', { locationId: locationIds[0], recipientIds: userIds,
    dates, availableDatesPerRecipient: 2, nativeVersionedWrites: true, independentReadback: true });
}

async function publishSchedule(page: Page, scheduleId: string, key: string) {
  const plan = await readJson<SchedulePublishPlanResponse>(page.request, `/api/v2/schedules/${scheduleId}/publish-plan`);
  expect(plan.sufficientCredits).toBe(true);
  const published = await readJson<SchedulePublicationResponse>(page.request, `/api/v2/schedules/${scheduleId}/publications`, {
    method: 'POST', data: { acceptedContract: plan.acceptedContract },
    headers: await mutationHeaders(page, { 'Idempotency-Key': key }),
  });
  expect(published.id).toBe(scheduleId);
  expect(published.status).toBe('PUBLISHED');
  expect(published.settlement.creditsConsumed).toBe(plan.totalConfiguredCost);
}

async function feed(page: Page) {
  const result = await readJson<NotificationListResponse>(page.request, '/api/v2/notifications?status=all&limit=100');
  expect(result.pagination.hasMore).toBe(false);
  expect(result.pagination.returned).toBe(result.data.length);
  expect(result.unreadCount).toBe(result.data.filter(item => item.readAt === null).length);
  return result;
}

async function homeSummary(page: Page) {
  const users = await readJson<StaffDirectoryResponse>(page.request, '/api/v2/users?limit=1');
  const locations = await readJson<LocationSummaryResponse>(page.request, '/api/v2/locations/summary');
  expect(users.summary).toBeDefined();
  expect(locations.count).toBe(1);
  const section = page.getByRole('region', { name: 'This week', exact: true });
  const team = section.locator('a.manager-week-link').filter({ has: page.locator('span', { hasText: /^Team$/ }) });
  const location = section.locator('a.manager-week-link').filter({ has: page.locator('span', { hasText: /^Locations$/ }) });
  await expect(team.locator('strong')).toHaveText(`${users.summary!.staffCount} ${users.summary!.staffCount === 1 ? 'person' : 'people'}`);
  await expect(team.locator('small')).toHaveText(`${users.summary!.managerCount} manager${users.summary!.managerCount === 1 ? '' : 's'}`);
  await expect(location.locator('strong')).toHaveText('1 location');
  await expect(page.locator('.manager-dashboard header .workspace-kicker')).toHaveText(e2eTenantName);
  return { staffCount: users.summary!.staffCount, managerCount: users.summary!.managerCount, locations: locations.count };
}

test.describe.serial('Native access, Home and notification acceptance', { tag: '@full-stack' }, () => {
  test.setTimeout(180_000);
  test.beforeEach(async ({ page }) => {
    browserErrors = [];
    expectedBrowserDenials = [];
    expect(runFullStack, 'Native acceptance requires the admitted full-stack lane').toBe(true);
    observeErrors(page);
    seedTenant();
  });
  test.afterEach(async ({}, info) => {
    await evidence(info, 'browser-error-classification', { events: browserErrors });
    expect(browserErrors.filter(event => !event.expectedNativeDenial), 'No unexplained browser product errors').toEqual([]);
  });

  test('navigates native public pages and rejects empty and invalid login without establishing a session', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The schedule, already thinking ahead.' })).toBeVisible();
    const legal = page.getByRole('navigation', { name: 'Legal and service links' });
    await legal.getByRole('link', { name: 'Privacy', exact: true }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Legal and service links' }).getByRole('link', { name: 'Security', exact: true }).click();
    await expect(page).toHaveURL(/\/security$/);
    await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
    await page.goto('/');
    await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    expect(await page.getByLabel('Workspace slug').evaluate((node: HTMLInputElement) => node.validity.valueMissing)).toBe(true);
    await page.getByLabel('Workspace slug').fill(e2eTenantSlug);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    expect(await page.getByLabel('Work email or username').evaluate((node: HTMLInputElement) => node.validity.valueMissing)).toBe(true);
    await screenshot(page, info, 'native-login-required-fields');
    await page.getByLabel('Work email or username').fill(e2eAdminUsername);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByPlaceholder('Enter password')).toBeVisible();
    expectedBrowserDenials.push({ path: '/api/v2/auth/password/verify', status: 401, remaining: 1 });
    await page.getByPlaceholder('Enter password').fill('000000');
    const [denied] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/auth/password/verify'
        && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Sign in with password', exact: true }).click(),
    ]);
    expect(denied.status()).toBe(401);
    await expect(page.getByRole('main').getByRole('alert')).toContainText(/Invalid username or (PIN|password)/i);
    await statusOnly(page.request, '/api/v2/auth/me', 401);
    expect((await page.context().cookies()).some(cookie => ['access_token', 'refresh_token'].includes(cookie.name))).toBe(false);
    await evidence(info, 'native-invalid-login', { verificationStatus: denied.status(), authenticatedIdentityStatus: 401 });
  });

  test('shows the native resolution rate limit without establishing a session or advancing login', async ({ page }, info) => {
    const rawLimit = process.env.E2E_RESOLUTION_IDENTIFIER_LIMIT ?? '5';
    expect(rawLimit, 'Expected-only native resolution budget is an integer').toMatch(/^\d+$/);
    const limit = Number(rawLimit);
    expect(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'Expected resolution budget is bounded to 1..500').toBe(true);
    const identifier = 'e2e.resolution.limit';
    const path = '/api/v2/auth/login/resolve';
    await page.goto(`/auth/login?tenantSlug=${encodeURIComponent(e2eTenantSlug)}&next=%2Fdashboard`);
    const origin = new URL(page.url()).origin;
    const data = { identifier, tenantSlug: e2eTenantSlug };
    const requestOptions = { method: 'POST' as const, headers: { Origin: origin }, data };
    for (let index = 0; index < limit; index++) {
      expect(await readJson(page.request, path, requestOptions)).toEqual({
        success: true, flow: 'USERNAME_PASSWORD', identifier, pinResetRequired: false,
      });
    }
    const limited = await readJson<ProblemDetails>(page.request, path, { ...requestOptions, status: 429 });
    expect(limited.code).toBe('rate_limited'); expect(limited.status).toBe(429);
    await page.getByLabel('Work email or username').fill(identifier);
    await expect(page.getByLabel('Workspace slug')).toHaveValue(e2eTenantSlug);
    const allowance = { path, status: 429, remaining: 1 }; expectedBrowserDenials.push(allowance);
    const bounded = async <T,>(operation: Promise<T>, label: string): Promise<T> => {
      let timer!: ReturnType<typeof setTimeout>;
      try { return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its finite deadline.`)), REQUEST_TIMEOUT_MS);
      })]); } finally { clearTimeout(timer); }
    };
    const observed = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).origin === origin && new URL(request.url()).pathname === path,
    { timeout: REQUEST_TIMEOUT_MS }).then(async request => {
      expect(request.postDataJSON()).toEqual(data);
      const response = await bounded(request.response(), 'Native browser resolution response');
      expect(response, 'Exact browser resolution Request receives its own response').not.toBeNull();
      expect(response!.status()).toBe(429);
      // Guarded Chromium responses can lose their body; the actual native API
      // request above owns problem-body validation, while this proves browser status.
    });
    const [response, action] = await Promise.allSettled([observed,
      bounded(Promise.resolve().then(() => page.getByRole('button', { name: 'Continue', exact: true }).click()), 'Native browser Continue action')]);
    const failures: unknown[] = [];
    if (action.status === 'rejected') failures.push(action.reason);
    if (response.status === 'rejected') failures.push(response.reason);
    if (failures.length) throw new AggregateError(failures, 'Native resolution action/response failures retained.');
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Too many sign-in attempts. Please wait and try again.');
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Enter your password', exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder('Enter password')).toHaveCount(0);
    await expect(page.getByLabel('Work email or username')).toHaveValue(identifier);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await statusOnly(page.request, '/api/v2/auth/me', 401);
    expect((await page.context().cookies()).some(cookie => ['access_token', 'refresh_token'].includes(cookie.name))).toBe(false);
    await expect.poll(() => allowance.remaining, { timeout: REQUEST_TIMEOUT_MS,
      message: 'Exactly one declared browser 429 console event is observed' }).toBe(0);
    expect(browserErrors.filter(event => event.expectedNativeDenial && event.path === path)).toHaveLength(1);
    await screenshot(page, info, 'native-resolution-rate-limit');
    await evidence(info, 'native-resolution-rate-limit-readback', { identifier, expectedIdentifierBudget: limit,
      nativeResolutionSuccesses: limit, nextNativeResolutionStatus: 429, nativeProblemCode: limited.code,
      actualBrowserResolutionStatus: 429, expectedBrowser429Events: 1, identifierStepRetained: true,
      authenticatedIdentityStatus: 401, sessionCookiesAbsent: true });
  });

  test('revokes the actual admin session on logout and rejects replay and protected navigation', async ({ page, browser }, info) => {
    await loginAsSeedAdmin(page, '/dashboard');
    const original = await identity(page, 'ADMIN');
    expect(original.mfaRequired).toBe(true);
    const replay = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: await page.context().storageState() });
    let primaryFailure: unknown;
    try {
      const before = await readJson<CurrentSessionResponse>(replay.request, '/api/v2/auth/me');
      expect(before.user.sessionScope === original.sessionScope).toBe(true);
      const replayCsrf = (await replay.cookies()).find(cookie => cookie.name === 'csrf_token')?.value;
      expect(replayCsrf, 'Replay must meet the native CSRF precondition').toBeTruthy();
      await page.getByRole('complementary', { name: 'Sidebar navigation' }).getByRole('link', { name: 'Sign out', exact: true }).click();
      await expect(page).toHaveURL(/\/auth\/login$/);
      expect((await page.context().cookies()).some(cookie => ['access_token', 'refresh_token', 'csrf_token'].includes(cookie.name))).toBe(false);
      await statusOnly(replay.request, '/api/v2/auth/me', 401);
      await statusOnly(replay.request, '/api/v2/auth/refresh', 401, {
        method: 'POST', headers: { Origin: new URL(page.url()).origin, 'x-csrf-token': replayCsrf! },
      });
      await statusOnly(page.request, '/api/v2/auth/me', 401);
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/auth\/login(?:\?|$)/);
      await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
      await screenshot(page, info, 'native-logout-protected-redirect');
      await evidence(info, 'native-session-revocation', { role: original.role, genuineMfa: original.mfaRequired && original.mfaVerified,
        sameSessionBeforeLogout: true, replayStatusAfterLogout: 401, refreshReplayStatus: 401, browserIdentityStatus: 401 });
    } catch (error) { primaryFailure = error; throw error; }
    finally { await closeQaContexts([replay], primaryFailure); }
  });

  test('authenticates the least-privilege Staff fixture and denies native privileged writes and platform access', async ({ page, browser }, info) => {
    const staff = await loginStaff(page);
    expect(staff.username).toBe(e2eStaffUsername);
    expect(staff.permissions.includes('auth:login_pin')).toBe(true);
    expect(staff.permissions.includes('notifications:read')).toBe(true);
    expect(staff.permissions.includes('users:read')).toBe(false);
    expect(staff.permissions.includes('settings:write')).toBe(false);
    expect(staff.permissions.includes('admin_portal:access')).toBe(false);
    const sidebar = page.getByRole('complementary', { name: 'Sidebar navigation' });
    await expect(sidebar.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole('link', { name: 'Admin Console', exact: true })).toHaveCount(0);
    const adminContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    let primaryFailure: unknown;
    try {
      const adminPage = await adminContext.newPage();
      observeErrors(adminPage);
      await loginAsSeedAdmin(adminPage, '/dashboard');
      const admin = await identity(adminPage, 'ADMIN');
      expect(admin.workspaceScope === staff.workspaceScope).toBe(true);
      const before = await readJson<WorkspaceSettings>(adminPage.request, '/api/v2/settings');
      const deniedWrite = await readJson<ProblemDetails>(page.request, '/api/v2/settings/general', {
        method: 'PUT', status: 403, headers: await mutationHeaders(page), data: { name: 'Denied Staff update' },
      });
      expect(deniedWrite.code, 'Staff write reaches the native RBAC denial after Origin/CSRF validation').toBe('permission_denied');
      const after = await readJson<WorkspaceSettings>(adminPage.request, '/api/v2/settings');
      expect(after, 'Denied Staff write preserves the independently read settings aggregate').toEqual(before);
    } catch (error) { primaryFailure = error; throw error; }
    finally { await closeQaContexts([adminContext], primaryFailure); }
    await statusOnly(page.request, '/api/v2/admin/tenants', 403);
    await page.goto('/admin/tenants');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Your dashboard' })).toBeVisible();
    const after = await identity(page, 'STAFF');
    expect(after.publicUserId === staff.publicUserId && after.workspaceScope === staff.workspaceScope).toBe(true);
    await screenshot(page, info, 'native-staff-permission-shell');
    await evidence(info, 'native-staff-denials', { role: staff.role, workspaceName: staff.workspaceName,
        settingsWriteStatus: 403, settingsWriteCode: 'permission_denied', settingsUnchangedAdminReadback: true,
        platformReadStatus: 403, privilegedNavigationHidden: true });
  });

  test('loads real empty Home summaries and follows actual manager task links', async ({ page }, info) => {
    await loginAsSeedAdmin(page, '/dashboard');
    await identity(page, 'ADMIN');
    const summary = await homeSummary(page);
    const { startDate, endDate } = dayWindow(new Date(), 7);
    const shifts = await readJson<ShiftSummaryListResponse>(page.request,
      `/api/v2/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&limit=200`);
    expect(shifts.pagination.hasMore).toBe(false);
    expect(shifts.data).toHaveLength(0);
    const week = page.getByRole('region', { name: 'This week', exact: true });
    await expect(week.locator('a.manager-week-link').filter({ has: page.locator('span', { hasText: /^Schedule$/ }) })).toContainText('0% covered');
    await expect(page.getByRole('region', { name: 'Daily shift coverage' })).toContainText('No scheduled shifts');
    const next = page.getByRole('region', { name: 'Needs attention', exact: true });
    await expect(next.getByRole('link', { name: /Build this week's schedule/ })).toBeVisible();
    await screenshot(page, info, 'native-home-empty');
    for (const [name, path, heading] of [
      [/Build this week's schedule/, '/dashboard/scheduling', 'Calendar'],
      [/Plan this week's breaks/, '/dashboard/lunch-breaks', /Lunch & Break Planner|Choose how to start today's plan/],
      [/Review time cards/, '/dashboard/time-cards', 'Time Cards'],
    ] as const) {
      await page.getByRole('region', { name: 'Needs attention', exact: true }).getByRole('link', { name }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await page.goto('/dashboard');
      await homeSummary(page);
    }
    await evidence(info, 'native-home-empty-readback', { ...summary, shiftCount: shifts.data.length, taskDestinations: 3 });
  });

  test('reloads populated Home with independently verified shift, coverage and team counts', async ({ page }, info) => {
    await loginAsSeedAdmin(page, '/dashboard');
    const admin = await identity(page, 'ADMIN');
    const fixture = await createSchedule(page, 0, ['Staff One', null], 'native-home-populated');
    const { startDate, endDate } = dayWindow(new Date(), 7);
    const read = await readJson<ShiftSummaryListResponse>(page.request,
      `/api/v2/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&limit=200`);
    expect(read.pagination.hasMore).toBe(false);
    expect(read.data).toHaveLength(2);
    expect(read.data.map(shift => shift.id).sort()).toEqual([...fixture.shiftIds].sort());
    expect(read.data.filter(shift => shift.userId === null)).toHaveLength(1);
    expect(read.data.filter(shift => shift.user?.name === 'Staff One')).toHaveLength(1);
    const coverage = Math.round(read.data.filter(shift => shift.userId !== null).length / read.data.length * 100);
    await page.reload();
    const summary = await homeSummary(page);
    const schedule = page.getByRole('region', { name: 'This week', exact: true }).locator('a.manager-week-link')
      .filter({ has: page.locator('span', { hasText: /^Schedule$/ }) });
    await expect(schedule.locator('strong')).toHaveText(`${coverage}% covered`);
    await expect(schedule.locator('small')).toHaveText('1 open shift remaining');
    await expect(page.getByRole('region', { name: 'Needs attention', exact: true }).getByRole('link', { name: /Assign 1 open shift/ })).toBeVisible();
    const after = await identity(page, 'ADMIN');
    expect(after.workspaceScope === admin.workspaceScope).toBe(true);
    await screenshot(page, info, 'native-home-populated');
    await evidence(info, 'native-home-populated-readback', { ...summary, shiftCount: read.data.length, openShiftCount: 1, coverage });
  });

  test('opens and closes the real empty notification dialog with keyboard focus restoration', async ({ page }, info) => {
    await loginStaff(page);
    expect((await feed(page)).data).toHaveLength(0);
    const trigger = page.getByRole('button', { name: 'Notifications', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Notifications', exact: true });
    await expect(dialog).toContainText('No notifications yet.');
    await expect(dialog.getByRole('button', { name: 'Mark all read', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close notifications', exact: true })).toBeFocused();
    await screenshot(page, info, 'native-notifications-empty');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole('button', { name: 'Close notifications', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect((await feed(page)).unreadCount).toBe(0);
    await evidence(info, 'native-empty-notification-readback', { notifications: 0, unreadCount: 0, keyboardAndCloseRestoreFocus: true });
  });

  test('delivers real publications to distinct recipients and persists owned notification reads across reload', async ({ page, browser }, info) => {
    await loginAsSeedAdmin(page, '/dashboard');
    const admin = await identity(page, 'ADMIN');
    const first = await createSchedule(page, 0, ['Staff One', 'E2E Manager'], 'native-notification-first');
    const second = await createSchedule(page, 1, ['Staff One', 'E2E Manager'], 'native-notification-second');
    await configurePublicationAvailability(page, [first, second], info);
    await publishSchedule(page, first.scheduleId, 'native-notification-first-publish');
    await publishSchedule(page, second.scheduleId, 'native-notification-second-publish');
    const contexts: BrowserContext[] = [];
    let primaryFailure: unknown;
    try {
      const staffContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
      contexts.push(staffContext);
      const managerContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
      contexts.push(managerContext);
      const staffPage = await staffContext.newPage();
      const managerPage = await managerContext.newPage();
      observeErrors(staffPage); observeErrors(managerPage);
      const staff = await loginStaff(staffPage);
      await loginAsSeedManager(managerPage, '/dashboard');
      const manager = await identity(managerPage, 'MANAGER');
      expect(staff.workspaceScope === admin.workspaceScope && manager.workspaceScope === admin.workspaceScope).toBe(true);
      expect(staff.publicUserId !== manager.publicUserId && staff.sessionScope !== manager.sessionScope).toBe(true);
      expect(first.assignedIds.includes(staff.publicUserId) && first.assignedIds.includes(manager.publicUserId)).toBe(true);
      expect(second.assignedIds.includes(staff.publicUserId) && second.assignedIds.includes(manager.publicUserId)).toBe(true);
      await expect.poll(async () => (await feed(staffPage)).data.filter(item => item.type === 'SCHEDULE_PUBLISHED').length,
        { timeout: 15_000 }).toBe(2);
      await expect.poll(async () => (await feed(managerPage)).data.filter(item => item.type === 'SCHEDULE_PUBLISHED').length,
        { timeout: 15_000 }).toBe(2);
      const staffFeed = await feed(staffPage), managerFeed = await feed(managerPage);
      const publications = staffFeed.data.filter(item => item.type === 'SCHEDULE_PUBLISHED');
      const managerPublications = managerFeed.data.filter(item => item.type === 'SCHEDULE_PUBLISHED');
      expect(new Set(publications.map(item => item.body)).size).toBe(2);
      expect(managerPublications.map(item => item.body).sort()).toEqual(publications.map(item => item.body).sort());
      for (const item of [...publications, ...managerPublications]) {
        expect(item.title).toBe('Schedule published');
        expect(item.body).toContain('Downtown Diner');
        expect(item.readAt).toBeNull();
      }
      expect(publications.every(item => !managerFeed.data.some(other => other.id === item.id))).toBe(true);
      const foreignRead = await readJson<NotificationReadResponse>(managerPage.request, '/api/v2/notifications/read', {
        method: 'POST', data: { ids: publications.map(item => item.id) }, headers: await mutationHeaders(managerPage),
      });
      expect(foreignRead.updated).toBe(0);
      expect(foreignRead.unreadCount).toBe(managerFeed.unreadCount);
      expect((await feed(staffPage)).unreadCount).toBe(staffFeed.unreadCount);
      await staffPage.getByRole('button', { name: 'Notifications', exact: true }).click();
      const dialog = staffPage.getByRole('dialog', { name: 'Notifications', exact: true });
      const chosen = publications[0];
      const item = dialog.getByRole('button').filter({ hasText: chosen.body });
      await expect(item).toHaveCount(1);
      await item.click();
      await expect.poll(async () => {
        const saved = (await feed(staffPage)).data.find(row => row.id === chosen.id)?.readAt;
        return typeof saved === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(saved) && Number.isFinite(Date.parse(saved));
      }, { timeout: 10_000 }).toBe(true);
      const afterOne = await feed(staffPage);
      expect(afterOne.unreadCount).toBe(staffFeed.unreadCount - 1);
      await expect(item).toBeDisabled();
      await screenshot(staffPage, info, 'native-notifications-one-read');
      await staffPage.reload();
      await staffPage.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(dialog.getByRole('button').filter({ hasText: chosen.body })).toBeDisabled();
      const reloadedOne = await feed(staffPage);
      expect(reloadedOne.unreadCount).toBe(afterOne.unreadCount);
      expect(reloadedOne.data.find(row => row.id === chosen.id)?.readAt).toBe(afterOne.data.find(row => row.id === chosen.id)!.readAt);
      await dialog.getByRole('button', { name: 'Mark all read', exact: true }).click();
      await expect.poll(async () => (await feed(staffPage)).unreadCount, { timeout: 10_000 }).toBe(0);
      const afterAll = await feed(staffPage);
      expect(afterAll.data.every(row => typeof row.readAt === 'string')).toBe(true);
      await staffPage.reload();
      await staffPage.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Mark all read', exact: true })).toBeDisabled();
      const reloadedAll = await feed(staffPage);
      expect(reloadedAll.unreadCount).toBe(0);
      expect(reloadedAll.data.map(row => ({ id: row.id, readAt: row.readAt })))
        .toEqual(afterAll.data.map(row => ({ id: row.id, readAt: row.readAt })));
      const managerAfter = await feed(managerPage);
      expect(managerAfter.unreadCount).toBe(managerFeed.unreadCount);
      expect(managerAfter.data.filter(row => managerPublications.some(item => item.id === row.id)).every(row => row.readAt === null)).toBe(true);
      await screenshot(staffPage, info, 'native-notifications-all-read-reloaded');
      await evidence(info, 'native-publication-recipient-readback', { staffRole: staff.role, managerRole: manager.role,
        workspaceName: staff.workspaceName, publicationsPerRecipient: 2, distinctRecipientIds: true,
        foreignReadUpdated: foreignRead.updated, staffUnreadBefore: staffFeed.unreadCount,
        staffUnreadAfterOne: afterOne.unreadCount, staffUnreadAfterAll: afterAll.unreadCount,
        managerUnreadUnchanged: managerAfter.unreadCount === managerFeed.unreadCount });
    } catch (error) { primaryFailure = error; throw error; }
    finally { await closeQaContexts(contexts, primaryFailure); }
  });
});
