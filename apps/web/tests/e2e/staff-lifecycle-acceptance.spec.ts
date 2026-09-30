// PRIVATE V2 SOURCE PROPOSAL ONLY. Not admitted, compiled, executed or qualified.
// Future placement: apps/web/tests/e2e/staff-lifecycle-acceptance.spec.ts.
// Separate disposable serial job: seed ONCE. No reseed after retained-history writes.
import { createHash, randomUUID } from 'node:crypto';
import type { APIRequestContext, Browser, Page, Response, TestInfo } from '@playwright/test';
import type {
  AccessCatalogResponse, CurrentSessionResponse, ProblemDetails, ResetStaffPinResponse,
  ScheduleBoardResponse, ScheduleChangeSetResponse, ScheduleCreateResponse, SchedulePublicationResponse,
  SchedulePublishPlanResponse, StaffAccessResponse, StaffDirectoryResponse, StaffLifecycleResponse,
  StaffMember, StaffSchedulingProfile,
} from '@lunchlineup/api-contract';
import { expect, test } from './qa-isolation-fixture';
import { closeQaContexts } from './qa-context-cleanup';
import {
  csrfHeaders, e2eManagerPin, e2eManagerUsername, e2eStaffPin, e2eStaffUsername,
  e2eTenantName, e2eTenantSlug, loginAsSeedAdmin, loginAsSeedManager, loginWithPin, runFullStack, seedTenant,
} from './support';

let currentStaffPin = e2eStaffPin;
let errors: Array<{ kind: string; path: string; digest: string; expected: boolean }> = [];
let intentional: Array<{ path: string; status: number; remaining: number }> = [];
function retainError(kind: string, path: string, value: unknown, expected = false) {
  errors.push({ kind, path, digest: createHash('sha256').update(value instanceof Error ? value.message : String(value)).digest('hex'), expected });
}
function observe(page: Page) {
  page.on('pageerror', error => retainError('pageerror', new URL(page.url()).pathname, error));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    let path = ''; try { path = new URL(message.location().url).pathname; } catch { /* Never broadly excuse missing locations. */ }
    const status = /^Failed to load resource: the server responded with a status of (401|403|409) \(/.exec(message.text());
    const allowed = status && intentional.find(row => row.path === path && row.status === Number(status[1]) && row.remaining > 0);
    if (allowed) allowed.remaining--;
    retainError('consoleerror', path, message.text(), Boolean(allowed));
  });
}
async function native<T>(request: APIRequestContext, path: string, options: {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE'; data?: unknown; headers?: Record<string, string>; status?: number;
} = {}): Promise<T> {
  const response = await request.fetch(path, { method: options.method ?? 'GET', data: options.data, headers: options.headers,
    timeout: 10_000, maxRetries: 0, maxRedirects: 0 });
  try {
    expect(response.status(), `Native status: ${path.split('?')[0]}`).toBe(options.status ?? 200);
    const bytes = await response.body(); expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
    return JSON.parse(bytes.toString('utf8')) as T;
  } finally { await response.dispose(); }
}
async function status(request: APIRequestContext, path: string, expected: number) {
  const response = await request.get(path, { timeout: 10_000, maxRetries: 0, maxRedirects: 0 });
  try { expect(response.status()).toBe(expected); } finally { await response.dispose(); }
}
async function headers(page: Page, extra: Record<string, string> = {}) {
  return { ...(await csrfHeaders(page)), Origin: new URL(page.url()).origin, ...extra };
}
async function me(page: Page) {
  const result = await native<CurrentSessionResponse>(page.request, '/api/v2/auth/me');
  expect(result.user.workspaceName).toBe(e2eTenantName);
  expect(result.user.mfaVerified).toBe(true);
  return result.user;
}
async function directory(page: Page) {
  const result = await native<StaffDirectoryResponse>(page.request, '/api/v2/users?limit=200');
  expect(result.pagination.hasMore).toBe(false); expect(result.pagination.returned).toBe(result.data.length);
  return result.data;
}
async function target(page: Page, username = e2eStaffUsername) {
  const rows = (await directory(page)).filter(row => row.username === username);
  expect(rows).toHaveLength(1); return rows[0];
}
function staffRow(page: Page, username: string) {
  return page.getByRole('row').filter({ has: page.getByText(username, { exact: true }) });
}
async function editor(page: Page, username: string) {
  const row = staffRow(page, username); await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Edit identity', exact: true }).click();
  const region = page.getByRole('region', { name: 'Edit staff identity', exact: true });
  await expect(region.getByRole('button', { name: 'Save identity', exact: true })).toBeEnabled(); return region;
}
async function drawer(page: Page, user: StaffMember) {
  const row = staffRow(page, user.username); await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Edit schedule profile', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Manage ${user.name}`, exact: true });
  await expect(dialog.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled(); return dialog;
}
async function bounded<T>(operation: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its finite deadline.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function mutation(page: Page, method: string, path: string, action: () => Promise<unknown>): Promise<Response> {
  const origin = new URL(page.url()).origin;
  // Register before action and attach both rejection handlers concurrently.
  // A failed click still awaits the finite observer; no pending waiter escapes.
  const observed = page.waitForRequest(request => request.method() === method
    && new URL(request.url()).origin === origin && new URL(request.url()).pathname === path,
  { timeout: 10_000 }).then(async request => {
    const response = await bounded(request.response(), 'Exact native mutation response');
    expect(response, 'The actual browser Request received its own native response').not.toBeNull();
    return response!;
  });
  const [transport, clicked] = await Promise.allSettled([
    observed, bounded(Promise.resolve().then(action), 'Native mutation action'),
  ]);
  const failures: unknown[] = [];
  if (clicked.status === 'rejected') failures.push(clicked.reason);
  if (transport.status === 'rejected') failures.push(transport.reason);
  if (failures.length) throw new AggregateError(failures, 'Native mutation action/observation failed; both failures retained.');
  if (transport.status !== 'fulfilled') throw new Error('Native mutation observation did not complete.');
  return transport.value;
}
async function browserJson<T>(response: Response): Promise<T> {
  // Browser responses have no dispose API; the owned context is closed after use.
  const bytes = await bounded(response.body(), 'Native browser response body');
  expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
  return JSON.parse(bytes.toString('utf8')) as T;
}
async function withPage(browser: Browser, origin: string, action: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ baseURL: origin }); let primary: unknown;
  try { const page = await context.newPage(); observe(page); await action(page); }
  catch (error) { primary = error; throw error; }
  finally { await closeQaContexts([context], primary); }
}
async function proof(page: Page, info: TestInfo, name: string, facts: Record<string, unknown>) {
  // Screenshots are bounded to the viewport; PIN-bearing status and all password inputs are masked.
  const path = info.outputPath(`${name}.png`);
  const image = await page.screenshot({ path, mask: [page.locator('input[type=password]'), page.locator('.staff-profile-drawer__temporary-pin')] });
  expect(image.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  await info.attach(name, { path, contentType: 'image/png' });
  await info.attach(`${name}-readback`, { body: JSON.stringify(facts, null, 2), contentType: 'application/json' });
}
async function rejectedLogin(page: Page, username: string, pin: string) {
  await page.goto(`/auth/login?tenantSlug=${encodeURIComponent(e2eTenantSlug)}&next=%2Fdashboard`);
  await page.getByLabel('Work email or username').fill(username);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByPlaceholder('Enter password')).toBeVisible();
  intentional.push({ path: '/api/v2/auth/password/verify', status: 401, remaining: 1 });
  await page.getByPlaceholder('Enter password').fill(pin);
  const pending = await mutation(page, 'POST', '/api/v2/auth/password/verify', () => page.getByRole('button', { name: 'Sign in with password', exact: true }).click());
  expect(pending.status()).toBe(401);
  await expect(page.getByRole('alert')).toContainText(/Invalid username or (PIN|password)/i);
  await status(page.request, '/api/v2/auth/me', 401);
}

// Each case starts a new genuine Admin session but does NOT reset the database.
// Failure stops the serial lane; exact candidate reporting must count all unexecuted cases as unmet.
test.describe.serial('Proposed native Staff lifecycle acceptance', { tag: '@full-stack' }, () => {
  test.setTimeout(180_000);
  test.describe.configure({ retries: 0 });
  test.beforeAll(() => { expect(runFullStack).toBe(true); seedTenant(); });
  test.beforeEach(async ({ page }) => {
    errors = []; intentional = []; observe(page);
    await loginAsSeedAdmin(page, '/dashboard/staff');
    const admin = await me(page); expect(admin.role).toBe('ADMIN'); expect(admin.mfaRequired).toBe(true);
    expect(admin.permissions.includes('users:admin')).toBe(true);
  });
  test.afterEach(async ({ page }, info) => {
    const primary = info.errors.length ? new AggregateError([...info.errors], 'Primary test failure retained.') : undefined;
    const failures: unknown[] = [];
    // Settle the current document before guarded route drain and freeze console evidence.
    // Always attempt close, attachment, and strict error checks after settling failure.
    try { if (!page.isClosed()) await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }); }
    catch (error) { failures.push(error); retainError('page-settling', '', error); }
    try { await bounded(page.close(), 'Primary framework page closure'); }
    catch (error) { failures.push(error); retainError('page-close', '', error); }
    try { await info.attach('strict-first-attempt-errors', { body: JSON.stringify(errors), contentType: 'application/json' }); }
    catch (error) { failures.push(error); }
    try { expect(errors.filter(row => !row.expected), 'No unexplained first-attempt browser errors').toEqual([]); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures],
      'Primary page settling/closure or strict evidence failed; primary failure retained when present.');
  });

  test('saves a real username change, revokes the old session, and explicitly discards unsaved identity drafts', async ({ page, browser }, info) => {
    const original = await target(page); const renamed = `${e2eStaffUsername}.renamed`;
    expect(renamed.length, 'Configured fixture username leaves room for the reviewed rename suffix').toBeLessThanOrEqual(32);
    await withPage(browser, new URL(page.url()).origin, async staffPage => {
      await loginWithPin(staffPage, { username: original.username, pin: currentStaffPin, next: '/dashboard' });
      const beforeSession = await me(staffPage); expect(beforeSession.publicUserId).toBe(original.id);
      const region = await editor(page, original.username);
      await region.getByLabel('Full name', { exact: true }).fill('Unsaved identity draft');
      page.once('dialog', dialog => dialog.dismiss());
      await region.getByRole('button', { name: 'Close identity editor', exact: true }).click();
      await expect(region.getByLabel('Full name', { exact: true })).toHaveValue('Unsaved identity draft');
      expect((await native<StaffMember>(page.request, `/api/v2/users/${original.id}`)).identityVersion).toBe(original.identityVersion);
      page.once('dialog', dialog => dialog.accept());
      await region.getByRole('button', { name: 'Reload saved identity', exact: true }).click();
      await expect(region.getByLabel('Full name', { exact: true })).toHaveValue(original.name);
      await region.getByLabel('Full name', { exact: true }).fill('Staff One Renamed');
      await region.getByLabel('Username', { exact: true }).fill(renamed);
      const pending = await mutation(page, 'PUT', `/api/v2/users/${original.id}/identity`, () => region.getByRole('button', { name: 'Save identity', exact: true }).click()); expect(pending.status()).toBe(200);
      const saved = await native<StaffMember>(page.request, `/api/v2/users/${original.id}`);
      expect({ id: saved.id, name: saved.name, username: saved.username, email: saved.email })
        .toEqual({ id: original.id, name: 'Staff One Renamed', username: renamed, email: original.email });
      expect(saved.identityVersion !== original.identityVersion).toBe(true);
      await status(staffPage.request, '/api/v2/auth/me', 401);
      await withPage(browser, new URL(page.url()).origin, async negative => { await rejectedLogin(negative, original.username, currentStaffPin); });
      await loginWithPin(staffPage, { username: renamed, pin: currentStaffPin, next: '/dashboard' });
      expect((await me(staffPage)).publicUserId).toBe(original.id);
      // Restore via the actual identity editor; next cases retain the same public UUID.
      await region.getByLabel('Full name', { exact: true }).fill(original.name);
      await region.getByLabel('Username', { exact: true }).fill(original.username);
      const restore = await mutation(page, 'PUT', `/api/v2/users/${original.id}/identity`, () => region.getByRole('button', { name: 'Save identity', exact: true }).click()); expect(restore.status()).toBe(200);
      expect((await target(page)).id).toBe(original.id);
      await proof(page, info, 'identity-saved-and-restored', { samePublicId: true, oldUsernameRejected: true, oldSessionRevoked: true });
    });
  });

  test('preserves an identity draft on a real competing-version conflict and reloads only after explicit discard', async ({ page }, info) => {
    const original = await target(page); const region = await editor(page, original.username);
    await region.getByLabel('Full name', { exact: true }).fill('Losing identity draft');
    const competitor = await native<StaffMember>(page.request, `/api/v2/users/${original.id}/identity`, {
      method: 'PUT', headers: await headers(page), data: { name: 'Concurrent saved identity', username: original.username,
        email: original.email, expectedVersion: original.identityVersion },
    });
    intentional.push({ path: `/api/v2/users/${original.id}/identity`, status: 409, remaining: 1 });
    const pending = await mutation(page, 'PUT', `/api/v2/users/${original.id}/identity`, () => region.getByRole('button', { name: 'Save identity', exact: true }).click());
    const response = pending; expect(response.status()).toBe(409);
    expect((await browserJson<ProblemDetails>(response)).code).toBe('staff_identity_conflict');
    await expect(region.getByLabel('Full name', { exact: true })).toHaveValue('Losing identity draft');
    expect(await native<StaffMember>(page.request, `/api/v2/users/${original.id}`)).toEqual(competitor);
    page.once('dialog', dialog => dialog.dismiss()); await region.getByRole('button', { name: 'Reload saved identity', exact: true }).click();
    await expect(region.getByLabel('Full name', { exact: true })).toHaveValue('Losing identity draft');
    page.once('dialog', dialog => dialog.accept()); await region.getByRole('button', { name: 'Reload saved identity', exact: true }).click();
    await expect(region.getByLabel('Full name', { exact: true })).toHaveValue(competitor.name);
    await proof(page, info, 'identity-real-version-conflict', { status: 409, code: 'staff_identity_conflict', winningVersionRetained: true });
    await region.getByLabel('Full name', { exact: true }).fill(original.name);
    const restore = await mutation(page, 'PUT', `/api/v2/users/${original.id}/identity`, () => region.getByRole('button', { name: 'Save identity', exact: true }).click()); expect(restore.status()).toBe(200);
  });

  test('cancels a staged role change and saves exact enrolled Manager downgrade and restoration through native UI', async ({ page, browser }, info) => {
    const manager = await target(page, e2eManagerUsername);
    const catalog = await native<AccessCatalogResponse>(page.request, '/api/v2/users/access/catalog');
    const staffRoles = catalog.roles.filter(role => role.isSystem && role.legacyRole === 'STAFF' && role.canDelegate);
    expect(staffRoles).toHaveLength(1); const staffRole = staffRoles[0];
    const original = await native<StaffAccessResponse>(page.request, `/api/v2/users/${manager.id}/access`);
    const originalIds = original.roles.map(role => role.id).sort();
    const group = page.getByRole('group', { name: `Role changes for ${manager.name}`, exact: true });
    await group.getByLabel(`Assigned roles for ${manager.name}`, { exact: true }).selectOption([staffRole.id]);
    const writes: string[] = []; const count = (request: import('@playwright/test').Request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/v2/users/${manager.id}/access`) writes.push(request.method());
    }; page.on('request', count);
    try { await group.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(group.getByRole('button', { name: 'Save roles', exact: true })).toBeDisabled(); expect(writes).toEqual([]);
    } finally { page.off('request', count); }
    expect(await native<StaffAccessResponse>(page.request, `/api/v2/users/${manager.id}/access`)).toEqual(original);
    await group.getByLabel(`Assigned roles for ${manager.name}`, { exact: true }).selectOption([staffRole.id]);
    const changed = await mutation(page, 'PUT', `/api/v2/users/${manager.id}/access`, () => group.getByRole('button', { name: 'Save roles', exact: true }).click()); expect(changed.status()).toBe(200);
    const downgraded = await native<StaffAccessResponse>(page.request, `/api/v2/users/${manager.id}/access`);
    expect(downgraded.roles.map(role => role.id)).toEqual([staffRole.id]); expect([...downgraded.permissions].sort()).toEqual([...staffRole.permissions].sort());
    await withPage(browser, new URL(page.url()).origin, async employee => {
      await loginWithPin(employee, { username: e2eManagerUsername, pin: e2eManagerPin, next: '/dashboard' });
      const identity = await me(employee); expect(identity.role).toBe('STAFF'); expect(identity.mfaRequired).toBe(true);
      expect([...identity.permissions].sort()).toEqual([...staffRole.permissions].sort());
    });
    await page.reload();
    await group.getByLabel(`Assigned roles for ${manager.name}`, { exact: true }).selectOption(originalIds);
    const restored = await mutation(page, 'PUT', `/api/v2/users/${manager.id}/access`, () => group.getByRole('button', { name: 'Save roles', exact: true }).click()); expect(restored.status()).toBe(200);
    expect(await native<StaffAccessResponse>(page.request, `/api/v2/users/${manager.id}/access`)).toEqual(original);
    await withPage(browser, new URL(page.url()).origin, async employee => { await loginAsSeedManager(employee, '/dashboard'); expect((await me(employee)).role).toBe('MANAGER'); });
    await proof(page, info, 'roles-cancel-downgrade-restore', { sameTarget: true, cancelledWrites: 0, exactRoleIdsRestored: true, genuineMfa: true });
  });

  test('persists real skill, recurring and dated availability and preserves a stale UI draft against a competing native write', async ({ page }, info) => {
    const user = await target(page); const dialog = await drawer(page, user);
    const profile = dialog.getByRole('region', { name: `Scheduling profile for ${user.name}`, exact: true });
    const board = await native<ScheduleBoardResponse>(page.request, `/api/v2/schedule-board?date=${new Date().toISOString().slice(0, 10)}&view=day`);
    expect(board.data.locations).toHaveLength(1); const location = board.data.locations[0];
    await profile.getByLabel('Skills', { exact: true }).fill('Native lifecycle skill'); await profile.getByRole('button', { name: 'Add skill', exact: true }).click();
    await profile.getByRole('button', { name: 'Add window', exact: true }).click();
    const window = profile.locator('.staff-scheduling-window'); await expect(window).toHaveCount(1);
    await window.getByLabel('Day', { exact: true }).selectOption('1'); await window.getByLabel('Location', { exact: true }).selectOption(location.id);
    await window.getByLabel('Start', { exact: true }).fill('09:00'); await window.getByLabel('End', { exact: true }).fill('17:00');
    await profile.getByRole('button', { name: 'Add exception', exact: true }).click();
    const exception = profile.getByRole('group', { name: 'Dated availability exception 1', exact: true });
    const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await exception.getByLabel('Local date', { exact: true }).fill(date); await exception.getByLabel('Location', { exact: true }).selectOption(location.id);
    await exception.getByLabel('Exception', { exact: true }).selectOption('UNAVAILABLE'); await exception.getByLabel('All day', { exact: true }).check();
    const saved = await mutation(page, 'PUT', `/api/v2/users/${user.id}/scheduling-profile`, () => profile.getByRole('button', { name: 'Save profile', exact: true }).click()); expect(saved.status()).toBe(200);
    const original = await native<StaffSchedulingProfile>(page.request, `/api/v2/users/${user.id}/scheduling-profile`);
    expect(original.user.id).toBe(user.id); expect(original.skills).toEqual(['Native lifecycle skill']);
    expect(original.availability).toEqual([{ locationId: location.id, dayOfWeek: 1, startTimeMinutes: 540, endTimeMinutes: 1020 }]);
    expect(original.availabilityExceptions).toEqual([{ locationId: location.id, date, kind: 'UNAVAILABLE', allDay: true, startTimeMinutes: 0, endTimeMinutes: 1440 }]);
    await profile.getByLabel('Skills', { exact: true }).fill('Losing draft skill'); await profile.getByRole('button', { name: 'Add skill', exact: true }).click();
    const competitor = await native<StaffSchedulingProfile>(page.request, `/api/v2/users/${user.id}/scheduling-profile`, {
      method: 'PUT', headers: await headers(page), data: { expectedVersion: original.version, skills: ['Winning saved skill'],
        availability: original.availability, availabilityExceptions: original.availabilityExceptions },
    });
    intentional.push({ path: `/api/v2/users/${user.id}/scheduling-profile`, status: 409, remaining: 1 });
    const conflict = await mutation(page, 'PUT', `/api/v2/users/${user.id}/scheduling-profile`, () => profile.getByRole('button', { name: 'Save profile', exact: true }).click()); const rejected = conflict;
    expect(rejected.status()).toBe(409); expect((await browserJson<ProblemDetails>(rejected)).code).toBe('scheduling_profile_changed');
    await expect(profile).toContainText('Your draft is retained'); await expect(profile.getByRole('button', { name: 'Remove Losing draft skill', exact: true })).toBeVisible();
    expect(await native<StaffSchedulingProfile>(page.request, `/api/v2/users/${user.id}/scheduling-profile`)).toEqual(competitor);
    page.once('dialog', confirmation => confirmation.dismiss()); await profile.getByRole('button', { name: 'Reload saved profile', exact: true }).click();
    await expect(profile.getByRole('button', { name: 'Remove Losing draft skill', exact: true })).toBeVisible();
    page.once('dialog', confirmation => confirmation.accept()); await profile.getByRole('button', { name: 'Reload saved profile', exact: true }).click();
    await expect(profile.getByRole('button', { name: 'Remove Winning saved skill', exact: true })).toBeVisible();
    await expect(profile.getByRole('button', { name: 'Remove Losing draft skill', exact: true })).toHaveCount(0);
    await proof(page, info, 'profile-native-version-conflict', { actualConflict: 409, persistedWindows: 1, persistedExceptions: 1, explicitReload: true });
    // Explicitly clear the saved scheduling profile through UI; empty availability is unconfigured.
    await profile.getByRole('button', { name: 'Remove Winning saved skill', exact: true }).click();
    await profile.getByRole('button', { name: 'Remove availability window', exact: true }).click();
    await profile.getByRole('button', { name: 'Remove dated availability exception', exact: true }).click();
    const clear = await mutation(page, 'PUT', `/api/v2/users/${user.id}/scheduling-profile`, () => profile.getByRole('button', { name: 'Save profile', exact: true }).click()); expect(clear.status()).toBe(200);
    const cleared = await native<StaffSchedulingProfile>(page.request, `/api/v2/users/${user.id}/scheduling-profile`);
    expect([cleared.skills, cleared.availability, cleared.availabilityExceptions]).toEqual([[], [], []]);
  });

  test('resets the exact employee PIN, rejects the old credential and enforces actual mandatory replacement', async ({ page, browser }, info) => {
    const user = await target(page);
    await withPage(browser, new URL(page.url()).origin, async employee => {
      await loginWithPin(employee, { username: user.username, pin: currentStaffPin, next: '/dashboard' });
      const row = staffRow(page, user.username); await row.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: `Reset PIN for ${user.name}?`, exact: true });
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect((await native<StaffMember>(page.request, `/api/v2/users/${user.id}`)).pinResetRequired).toBe(false);
      expect((await me(employee)).publicUserId).toBe(user.id);
      await row.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      const pending = await mutation(page, 'POST', `/api/v2/users/${user.id}/pin/reset`, () => confirmation.getByRole('button', { name: 'Reset PIN', exact: true }).click());
      const response = pending; expect(response.status()).toBe(200);
      // Secret-bearing browser response stays in memory; do not attach/assert the raw credential.
      const reset = await browserJson<ResetStaffPinResponse>(response);
      expect(reset.id).toBe(user.id); expect(reset.username).toBe(user.username); expect(/^\d{4,8}$/.test(reset.temporaryPin)).toBe(true);
      expect((await native<StaffMember>(page.request, `/api/v2/users/${user.id}`)).pinResetRequired).toBe(true);
      await status(employee.request, '/api/v2/auth/me', 401);
      await withPage(browser, new URL(page.url()).origin, async negative => { await rejectedLogin(negative, user.username, currentStaffPin); });
      // Existing helper waits only for mfa/dashboard/admin, so drive the real mandatory reset route explicitly.
      await employee.goto(`/auth/login?tenantSlug=${encodeURIComponent(e2eTenantSlug)}&next=%2Fdashboard`);
      await employee.getByLabel('Work email or username').fill(user.username); await employee.getByRole('button', { name: 'Continue', exact: true }).click();
      await employee.getByPlaceholder('Enter password').fill(reset.temporaryPin);
      await employee.getByRole('button', { name: 'Sign in with password', exact: true }).click();
      await expect(employee).toHaveURL(/\/auth\/reset-pin(?:\?|$)/);
      const gated = await native<CurrentSessionResponse>(employee.request, '/api/v2/auth/me');
      expect(gated.user.publicUserId).toBe(user.id); expect(gated.user.pinResetRequired).toBe(true);
      const denied = await native<ProblemDetails>(employee.request, '/api/v2/notifications', { status: 403 }); expect(denied.code).toBe('pin_rotation_required');
      const replacement = reset.temporaryPin === '975310' ? '975311' : '975310';
      await employee.getByLabel('Temporary PIN', { exact: true }).fill(reset.temporaryPin);
      await employee.getByLabel('New PIN', { exact: true }).fill(replacement); await employee.getByLabel('Confirm new PIN', { exact: true }).fill(`${replacement.slice(0, 5)}2`);
      await employee.getByRole('button', { name: 'Update PIN', exact: true }).click(); await expect(employee.getByRole('alert')).toContainText('New PINs do not match');
      await employee.getByLabel('Confirm new PIN', { exact: true }).fill(replacement);
      const rotate = await mutation(employee, 'PUT', '/api/v2/users/me/pin', () => employee.getByRole('button', { name: 'Update PIN', exact: true }).click()); expect(rotate.status()).toBe(200);
      await expect(employee).toHaveURL(/\/auth\/login(?:\?|$)/); await status(employee.request, '/api/v2/auth/me', 401);
      currentStaffPin = replacement;
      await loginWithPin(employee, { username: user.username, pin: currentStaffPin, next: '/dashboard' });
      const fresh = await me(employee); expect(fresh.publicUserId).toBe(user.id); expect(fresh.pinResetRequired).toBe(false);
      await withPage(browser, new URL(page.url()).origin, async negative => { await rejectedLogin(negative, user.username, reset.temporaryPin); });
      await proof(employee, info, 'native-required-pin-replacement', { oldSessionRevoked: true, oldPinRejected: true, temporaryPinReplaced: true, samePublicId: true });
    });
  });

  test('deactivates and reactivates the exact employee while preserving a real published assignment and revoked session', async ({ page, browser }, info) => {
    const user = await target(page); const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const boardPath = `/api/v2/schedule-board?date=${date}&view=day`;
    const board = await native<ScheduleBoardResponse>(page.request, boardPath); expect(board.data.locations).toHaveLength(1);
    const location = board.data.locations[0];
    const created = await native<ScheduleCreateResponse>(page.request, `/api/v2/locations/${location.id}/schedules`, {
      method: 'POST', headers: await headers(page, { 'Idempotency-Key': 'future-staff-history-schedule' }),
      data: { startDate: `${date}T08:00:00.000Z`, endDate: new Date(Date.parse(`${date}T08:00:00.000Z`) + 86400000).toISOString() },
    });
    const shiftStart = `${date}T16:00:00.000Z`; const shiftEnd = `${date}T20:00:00.000Z`;
    const changed = await native<ScheduleChangeSetResponse>(page.request, `/api/v2/schedules/${created.data.id}/change-sets`, {
      method: 'POST', headers: await headers(page, { 'Idempotency-Key': 'future-staff-history-shift', 'If-Match': created.data.etag }),
      data: { operations: [{ op: 'shift.create', clientId: randomUUID(), userId: user.id, role: 'STAFF', startTime: shiftStart, endTime: shiftEnd }] },
    }); expect(changed.data.created).toHaveLength(1);
    // Exact assigned shift dates in the authoritative native location timezone.
    // End is exclusive; no extra availability is added for a midnight end.
    const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: location.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = (instant: Date) => {
      const parts = Object.fromEntries(dateParts.formatToParts(instant).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const requiredDates = [...new Set([localDate(new Date(shiftStart)), localDate(new Date(Date.parse(shiftEnd) - 1))])].sort();
    expect(requiredDates.length).toBeGreaterThanOrEqual(1); expect(requiredDates.length).toBeLessThanOrEqual(2);
    const profilePath = `/api/v2/users/${user.id}/scheduling-profile`;
    const beforeCoverage = await native<StaffSchedulingProfile>(page.request, profilePath);
    expect(beforeCoverage.user.id).toBe(user.id);
    expect(beforeCoverage.availabilityExceptions, 'Earlier explicit clear retained no dated restrictions').toEqual([]);
    const coverage = requiredDates.map(localDate => ({ locationId: location.id, date: localDate,
      kind: 'AVAILABLE' as const, allDay: true, startTimeMinutes: 0, endTimeMinutes: 1440 }));
    const configured = await native<StaffSchedulingProfile>(page.request, profilePath, {
      method: 'PUT', headers: await headers(page), data: { expectedVersion: beforeCoverage.version,
        skills: beforeCoverage.skills, availability: beforeCoverage.availability, availabilityExceptions: coverage },
    });
    expect(configured.user.id).toBe(user.id); expect(configured.skills).toEqual(beforeCoverage.skills);
    expect(configured.availability).toEqual(beforeCoverage.availability);
    expect(configured.availabilityExceptions).toEqual(coverage); expect(configured.availabilityConfigured).toBe(true);
    expect(configured.version).not.toBe(beforeCoverage.version);
    expect(await native<StaffSchedulingProfile>(page.request, profilePath)).toEqual(configured);
    await info.attach('native-staff-history-publication-availability', { body: JSON.stringify({
      userId: user.id, locationId: location.id, timeZone: location.timezone, shiftStart, shiftEnd,
      beforeVersion: beforeCoverage.version, savedVersion: configured.version, availabilityExceptions: coverage,
      independentReadback: true,
    }), contentType: 'application/json' });
    // Profile changes invalidate drafts, so acquire the fresh accepted publication contract now.
    const plan = await native<SchedulePublishPlanResponse>(page.request, `/api/v2/schedules/${created.data.id}/publish-plan`); expect(plan.sufficientCredits).toBe(true);
    await native<SchedulePublicationResponse>(page.request, `/api/v2/schedules/${created.data.id}/publications`, {
      method: 'POST', headers: await headers(page, { 'Idempotency-Key': 'future-staff-history-publish' }), data: { acceptedContract: plan.acceptedContract },
    });
    const published = await native<ScheduleBoardResponse>(page.request, boardPath);
    const originalShift = published.data.shifts.filter(shift => shift.id === changed.data.created[0].shiftId); expect(originalShift).toHaveLength(1);
    await withPage(browser, new URL(page.url()).origin, async employee => {
      await loginWithPin(employee, { username: user.username, pin: currentStaffPin, next: '/dashboard' });
      const dialog = await drawer(page, user); const account = dialog.getByRole('region', { name: 'Employee account status', exact: true });
      await expect(account).toContainText('Current and future assignments (1)');
      await account.getByRole('button', { name: 'Deactivate employee', exact: true }).click(); await account.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect((await native<StaffLifecycleResponse>(page.request, `/api/v2/users/${user.id}/lifecycle`)).user.suspendedAt).toBeNull();
      await account.getByRole('button', { name: 'Deactivate employee', exact: true }).click();
      const deactivate = await mutation(page, 'PUT', `/api/v2/users/${user.id}/lifecycle`, () => account.getByRole('button', { name: 'Confirm deactivation', exact: true }).click()); expect(deactivate.status()).toBe(200);
      const suspended = await native<StaffLifecycleResponse>(page.request, `/api/v2/users/${user.id}/lifecycle`);
      expect(typeof suspended.user.suspendedAt === 'string').toBe(true); expect(suspended.user.id).toBe(user.id); expect(suspended.futureAssignments.map(row => row.id)).toEqual([originalShift[0].id]);
      const inactiveBoard = await native<ScheduleBoardResponse>(page.request, boardPath);
      expect(inactiveBoard.data.staff.some(row => row.id === user.id)).toBe(false);
      expect(inactiveBoard.data.shifts.filter(row => row.id === originalShift[0].id)).toEqual(originalShift);
      expect(inactiveBoard.data.schedules.find(row => row.id === created.data.id)?.status).toBe('PUBLISHED');
      await status(employee.request, '/api/v2/auth/me', 401);
      await withPage(browser, new URL(page.url()).origin, async negative => { await rejectedLogin(negative, user.username, currentStaffPin); });
      await account.getByRole('button', { name: 'Reactivate employee', exact: true }).click();
      const reactivate = await mutation(page, 'PUT', `/api/v2/users/${user.id}/lifecycle`, () => account.getByRole('button', { name: 'Confirm reactivation', exact: true }).click()); expect(reactivate.status()).toBe(200);
      expect((await native<StaffLifecycleResponse>(page.request, `/api/v2/users/${user.id}/lifecycle`)).user.suspendedAt).toBeNull();
      await status(employee.request, '/api/v2/auth/me', 401);
      await loginWithPin(employee, { username: user.username, pin: currentStaffPin, next: '/dashboard' }); expect((await me(employee)).publicUserId).toBe(user.id);
      expect((await native<ScheduleBoardResponse>(page.request, boardPath)).data.shifts.filter(row => row.id === originalShift[0].id)).toEqual(originalShift);
      await proof(page, info, 'suspension-retains-published-assignment', { historyKind: 'published shift', preservedShiftCount: 1, samePublicId: true, previousSessionRemainsRevoked: true });
    });
  });

  test('cancels irreversible removal then actually removes only an unused seeded employee with independent absence proof', async ({ page }, info) => {
    const unused = await target(page, 'staff-2');
    const before = await native<StaffLifecycleResponse>(page.request, `/api/v2/users/${unused.id}/lifecycle`); expect(before.futureAssignmentCount).toBe(0);
    const row = staffRow(page, unused.username); await row.getByRole('button', { name: 'Remove permanently', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: `Permanently remove ${unused.name}?`, exact: true });
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await native<StaffMember>(page.request, `/api/v2/users/${unused.id}`)).id).toBe(unused.id);
    await row.getByRole('button', { name: 'Remove permanently', exact: true }).click();
    const removed = await mutation(page, 'DELETE', `/api/v2/users/${unused.id}`, () => confirm.getByRole('button', { name: 'Remove permanently', exact: true }).click()); expect(removed.status()).toBe(204);
    await status(page.request, `/api/v2/users/${unused.id}`, 404); expect((await directory(page)).some(member => member.id === unused.id)).toBe(false);
    await page.reload(); await expect(staffRow(page, unused.username)).toHaveCount(0);
    await proof(page, info, 'native-unused-staff-tombstone', { directoryAbsent: true, directReadStatus: 404, targetHadNoAssignments: true });
  });

  test('rejects real least-privilege staff administration and self-role mutation without changing saved identity or access', async ({ page, browser }, info) => {
    const user = await target(page); const before = await native<StaffMember>(page.request, `/api/v2/users/${user.id}`);
    const access = await native<StaffAccessResponse>(page.request, `/api/v2/users/${user.id}/access`);
    await withPage(browser, new URL(page.url()).origin, async employee => {
      await loginWithPin(employee, { username: user.username, pin: currentStaffPin, next: '/dashboard' });
      const identity = await me(employee); expect(identity.permissions.includes('users:admin')).toBe(false); expect(identity.permissions.includes('roles:assign')).toBe(false);
      const rejected = await native<ProblemDetails>(employee.request, `/api/v2/users/${user.id}/identity`, {
        method: 'PUT', status: 403, headers: await headers(employee), data: { name: 'Forbidden overwrite', username: user.username, email: user.email, expectedVersion: before.identityVersion },
      }); expect(rejected.code).toBe('permission_denied');
      const rejectedRoles = await native<ProblemDetails>(employee.request, `/api/v2/users/${user.id}/access`, {
        method: 'PUT', status: 403, headers: await headers(employee), data: { roleIds: access.roles.map(role => role.id) },
      }); expect(rejectedRoles.code).toBe('permission_denied');
      await employee.goto('/dashboard/staff'); await expect(employee).toHaveURL(/\/dashboard$/);
    });
    expect(await native<StaffMember>(page.request, `/api/v2/users/${user.id}`)).toEqual(before);
    expect(await native<StaffAccessResponse>(page.request, `/api/v2/users/${user.id}/access`)).toEqual(access);
    const admin = await me(page); const ownBefore = await native<StaffAccessResponse>(page.request, `/api/v2/users/${admin.publicUserId}/access`);
    const self = await native<ProblemDetails>(page.request, `/api/v2/users/${admin.publicUserId}/access`, {
      method: 'PUT', status: 403, headers: await headers(page), data: { roleIds: ownBefore.roles.map(role => role.id) },
    }); expect(self.code).toBe('permission_denied');
    expect(await native<StaffAccessResponse>(page.request, `/api/v2/users/${admin.publicUserId}/access`)).toEqual(ownBefore);
    await proof(page, info, 'least-privilege-and-self-denials', { nativeCode: 'permission_denied', staffIdentityUnchanged: true, targetAccessUnchanged: true, adminOwnAccessUnchanged: true });
  });
});
