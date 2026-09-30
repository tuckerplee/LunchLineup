// PRIVATE V3 SOURCE PROPOSAL. No lane admission or native qualification.
// Future placement: apps/web/tests/e2e/logout-surfaces-acceptance.spec.ts.
// One fresh disposable seed; never reset history after this lane starts.
import { createHash } from 'node:crypto';
import type { APIRequestContext, Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import type { CurrentSessionResponse, ResetStaffPinResponse, StaffDirectoryResponse, StaffMember } from '@lunchlineup/api-contract';
import { expect, test } from './qa-isolation-fixture';
import { closeQaContexts } from './qa-context-cleanup';
import {
  csrfHeaders, e2eStaffUsername, e2eSuperAdminUsername, e2eTenantName, e2eTenantSlug,
  loginAsSeedAdmin, loginAsSeedSuperAdmin, loginWithPin, runFullStack, seedTenant,
} from './support';

const timeout = 10_000;
type ErrorFact = { kind: string; path: string; sha256: string };
let errors: ErrorFact[] = [];
let temporaryPin: string | undefined;
let staffId: string | undefined;
function observe(page: Page) {
  const record = (kind: string, path: string, message: string) => errors.push({ kind, path,
    sha256: createHash('sha256').update(message).digest('hex') });
  page.on('pageerror', error => record('pageerror', new URL(page.url()).pathname, error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    let path = ''; try { path = new URL(message.location().url).pathname; } catch { /* Unclassified errors fail. */ }
    record('consoleerror', path, message.text());
  });
}
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its finite deadline.`)), timeout);
  })]); } finally { clearTimeout(timer); }
}
async function native<T>(request: APIRequestContext, path: string, options: {
  method?: 'GET' | 'POST'; data?: unknown; headers?: Record<string, string>;
} = {}): Promise<T> {
  const response = await request.fetch(path, { ...options, method: options.method ?? 'GET',
    timeout, maxRetries: 0, maxRedirects: 0 });
  let primary: unknown;
  try {
    expect(response.status(), `Native status for ${path}`).toBe(200);
    const bytes = await bounded(response.body(), 'Native readback body'); expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch (error) { primary = error; throw error; }
  finally { try { await bounded(response.dispose(), 'Native response cleanup'); } catch (cleanup) {
    throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], 'Native readback and cleanup failures retained.');
  } }
}
async function denied(request: APIRequestContext, path: string, options: {
  method?: 'GET' | 'POST'; headers?: Record<string, string>;
} = {}) {
  const response = await request.fetch(path, { ...options, method: options.method ?? 'GET',
    timeout, maxRetries: 0, maxRedirects: 0 });
  let primary: unknown;
  try { expect(response.status(), `Revoked native session at ${path}`).toBe(401); }
  catch (error) { primary = error; throw error; }
  finally { try { await bounded(response.dispose(), 'Native response cleanup'); } catch (cleanup) {
    throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], 'Native denial and cleanup failures retained.');
  } }
}
async function session(page: Page, role: 'SUPER_ADMIN' | 'STAFF', pinResetRequired: boolean) {
  const { user } = await native<CurrentSessionResponse>(page.request, '/api/v2/auth/me');
  expect(user.role).toBe(role); expect(user.workspaceName).toBe(e2eTenantName);
  expect(user.username).toBe(role === 'SUPER_ADMIN' ? e2eSuperAdminUsername : e2eStaffUsername);
  expect(user.mfaVerified).toBe(true); expect(user.pinResetRequired).toBe(pinResetRequired);
  expect(user.publicUserId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(user.workspaceScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(user.sessionScope).toMatch(/^[A-Za-z0-9_-]{43}$/);
  if (role === 'SUPER_ADMIN') {
    expect(user.mfaRequired).toBe(true); expect(user.permissions).toContain('admin_portal:access');
  } else { expect(user.publicUserId).toBe(staffId); expect(user.permissions).not.toContain('admin_portal:access'); }
  return user;
}
async function attach(page: Page, info: TestInfo, name: string, facts: Record<string, unknown>) {
  const path = info.outputPath(`${name}.png`);
  const image = await page.screenshot({ path, mask: [page.locator('input[type=password]')] });
  expect(image.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  await info.attach(name, { path, contentType: 'image/png' });
  await info.attach(`${name}-native-readback`, { body: JSON.stringify(facts), contentType: 'application/json' });
}
async function withEmployee(browser: Browser, origin: string, action: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ baseURL: origin }); let primary: unknown;
  try { const page = await context.newPage(); observe(page); await action(page); }
  catch (error) { primary = error; throw error; }
  finally { await closeQaContexts([context], primary); }
}
async function mandatoryPinLogin(page: Page) {
  if (!temporaryPin || !staffId) throw new Error('Exact native temporary-PIN fixture was not established.');
  await page.goto(`/auth/login?tenantSlug=${encodeURIComponent(e2eTenantSlug)}&next=%2Fdashboard`);
  await page.getByLabel('Work email or username').fill(e2eStaffUsername);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByPlaceholder('Enter password')).toBeVisible();
  await page.getByPlaceholder('Enter password').fill(temporaryPin);
  await page.getByRole('button', { name: 'Sign in with password', exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/reset-pin(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'Set a new PIN', exact: true })).toBeVisible();
  return session(page, 'STAFF', true);
}
async function proveRevocation(page: Page, browser: Browser, info: TestInfo, name: string,
  action: () => Promise<void>, role: 'SUPER_ADMIN' | 'STAFF', pinResetRequired: boolean, protectedPath: string) {
  const original = await session(page, role, pinResetRequired);
  const contexts: BrowserContext[] = []; let primary: unknown;
  try {
    const replay = await browser.newContext({ baseURL: new URL(page.url()).origin,
      storageState: await page.context().storageState() }); contexts.push(replay);
    const before = await native<CurrentSessionResponse>(replay.request, '/api/v2/auth/me');
    expect(before.user.sessionScope === original.sessionScope).toBe(true);
    const copied = await replay.cookies();
    const copiedAccess = copied.find(cookie => cookie.name === 'access_token')?.value;
    const copiedRefresh = copied.find(cookie => cookie.name === 'refresh_token')?.value;
    const csrf = copied.find(cookie => cookie.name === 'csrf_token')?.value;
    expect(Boolean(copiedAccess && copiedRefresh && csrf), 'Copied access/refresh/CSRF credentials exist before activation').toBe(true);
    const origin = new URL(page.url()).origin;
    const mainFrame = page.mainFrame();
    const navigation = page.waitForRequest(request => request.method() === 'GET'
      && request.isNavigationRequest() && request.resourceType() === 'document'
      && request.frame() === mainFrame && new URL(request.url()).origin === origin
      && new URL(request.url()).pathname === '/auth/logout', { timeout }).then(async request => {
      const response = await bounded(request.response(), 'Exact document logout response');
      expect(response, 'Actual main-frame logout Request received its own response').not.toBeNull();
      expect(response!.request() === request).toBe(true); expect(response!.status()).toBe(307);
      const headers = await bounded(request.allHeaders(), 'Complete document navigation request headers');
      expect(headers['rsc']).toBeUndefined(); expect(headers['next-router-prefetch']).toBeUndefined();
      expect(`${headers['purpose'] ?? ''} ${headers['sec-purpose'] ?? ''}`.toLowerCase().includes('prefetch')).toBe(false);
      expect(headers['sec-fetch-dest']).toBe('document'); expect(headers['sec-fetch-mode']).toBe('navigate');
      const responseHeaders = await bounded(response!.allHeaders(), 'Document redirect headers');
      expect(responseHeaders['content-type']?.includes('text/x-component') ?? false).toBe(false);
      const redirect = new URL(responseHeaders.location, origin);
      expect(redirect.href).toBe(new URL('/auth/login', origin).href);
    });
    const outcomes = await Promise.allSettled([navigation, bounded(Promise.resolve().then(action), 'Document logout trigger')]);
    const navigationFailures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (navigationFailures.length) throw new AggregateError(navigationFailures, 'Document logout trigger/actual navigation observation failed.');
    await expect(page).toHaveURL(/\/auth\/login(?:\?|$)/);
    expect((await page.context().cookies()).some(cookie =>
      ['access_token', 'refresh_token', 'csrf_token'].includes(cookie.name))).toBe(false);
    await denied(replay.request, '/api/v2/auth/me');
    const beforeRefresh = await replay.cookies();
    expect(Boolean(copiedRefresh) && beforeRefresh.find(cookie => cookie.name === 'refresh_token')?.value === copiedRefresh,
      'The copied refresh credential is still present unchanged at its replay').toBe(true);
    expect(Boolean(csrf) && beforeRefresh.find(cookie => cookie.name === 'csrf_token')?.value === csrf,
      'The retained CSRF cookie still matches the replay header').toBe(true);
    await denied(replay.request, '/api/v2/auth/refresh', { method: 'POST',
      headers: { Origin: new URL(page.url()).origin, 'x-csrf-token': csrf! } });
    await denied(page.request, '/api/v2/auth/me');
    await page.goto(protectedPath); await expect(page).toHaveURL(/\/auth\/login(?:\?|$)/);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await attach(page, info, name, { role, pinResetRequiredBefore: pinResetRequired,
      genuineMfa: role === 'SUPER_ADMIN' && original.mfaRequired && original.mfaVerified,
      sameSessionReplayBefore: true, copiedCredentialsPresentBefore: true, copiedRefreshAndCsrfPreservedAtReplay: true,
      mainFrameDocumentGet: true, nativeLogoutRedirectStatus: 307, exactLoginRedirect: true, nonRscNonPrefetchNavigation: true,
      identityReplayAfter: 401, validCsrfRefreshReplayAfter: 401,
      currentIdentityAfter: 401, allSessionCookiesAbsent: true, protectedRedirect: true });
  } catch (error) { primary = error; throw error; }
  finally { await closeQaContexts(contexts, primary); }
}
async function anchor(link: Locator) {
  await expect(link).toBeVisible(); await expect(link).toHaveAttribute('href', '/auth/logout');
  expect(await link.evaluate(element => element.tagName)).toBe('A');
}

test.describe.serial('Proposed native document logout surfaces', { tag: '@full-stack' }, () => {
  test.setTimeout(180_000); test.describe.configure({ retries: 0 });
  test.beforeAll(() => { expect(runFullStack).toBe(true); seedTenant(); });
  test.beforeEach(({ page }) => { errors = []; observe(page); });
  test.afterEach(async ({ page }, info) => {
    const failures: unknown[] = [];
    try { if (!page.isClosed()) await page.waitForLoadState('networkidle', { timeout: 5_000 }); }
    catch (error) { failures.push(error); }
    try { await bounded(page.close(), 'Primary page closure'); } catch (error) { failures.push(error); }
    try { await info.attach('strict-first-attempt-browser-errors', { body: JSON.stringify(errors), contentType: 'application/json' }); }
    catch (error) { failures.push(error); }
    try { expect(errors, 'No unclassified native browser errors').toEqual([]); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError([...info.errors, ...failures], 'Native logout cleanup/evidence failed.');
  });

  test('revokes the enrolled platform session through the actual desktop Admin sidebar document link', async ({ page, browser }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 }); await loginAsSeedSuperAdmin(page, '/admin');
    await expect(page.getByRole('heading', { name: 'System Overview', exact: true })).toBeVisible();
    const link = page.getByRole('complementary', { name: 'Admin sidebar' }).getByRole('link', { name: 'Sign out', exact: true });
    await anchor(link);
    await proveRevocation(page, browser, info, 'native-platform-desktop-document-logout', () => link.click(), 'SUPER_ADMIN', false, '/admin');
  });
  test('revokes the enrolled platform session through keyboard activation of the actual mobile Admin document link', async ({ page, browser }, info) => {
    await page.setViewportSize({ width: 375, height: 812 }); await loginAsSeedSuperAdmin(page, '/admin');
    const link = page.locator('.workspace-topbar').getByRole('link', { name: 'Sign out', exact: true });
    await anchor(link); await link.focus(); await expect(link).toBeFocused();
    await proveRevocation(page, browser, info, 'native-platform-mobile-keyboard-logout', () => link.press('Enter'), 'SUPER_ADMIN', false, '/admin');
  });
  test('revokes the native mandatory-PIN-reset session through its actual document sign-out link', async ({ page, browser }, info) => {
    await loginAsSeedAdmin(page, '/dashboard');
    const directory = await native<StaffDirectoryResponse>(page.request, '/api/v2/users?limit=200');
    expect(directory.pagination.hasMore).toBe(false);
    const matches = directory.data.filter(user => user.username === e2eStaffUsername); expect(matches).toHaveLength(1);
    staffId = matches[0].id;
    const reset = await native<ResetStaffPinResponse>(page.request, `/api/v2/users/${staffId}/pin/reset`, {
      method: 'POST', headers: { ...(await csrfHeaders(page)), Origin: new URL(page.url()).origin } });
    expect(reset.id).toBe(staffId); expect(reset.username).toBe(e2eStaffUsername);
    expect(/^\d{4,8}$/.test(reset.temporaryPin)).toBe(true); temporaryPin = reset.temporaryPin;
    expect((await native<StaffMember>(page.request, `/api/v2/users/${staffId}`)).pinResetRequired).toBe(true);
    await withEmployee(browser, new URL(page.url()).origin, async employee => {
      await mandatoryPinLogin(employee);
      const link = employee.getByRole('link', { name: 'Sign out', exact: true }); await anchor(link);
      await proveRevocation(employee, browser, info, 'native-required-pin-document-signout', () => link.click(), 'STAFF', true, '/dashboard');
    });
    expect((await native<StaffMember>(page.request, `/api/v2/users/${staffId}`)).pinResetRequired).toBe(true);
  });
  test('retains its session on invalid PIN confirmation and clears the revoked session after genuine native PIN replacement', async ({ page, browser }, info) => {
    await loginAsSeedAdmin(page, '/dashboard');
    await withEmployee(browser, new URL(page.url()).origin, async employee => {
      const original = await mandatoryPinLogin(employee);
      const replacement = temporaryPin === '975310' ? '975311' : '975310';
      await employee.getByLabel('Temporary PIN', { exact: true }).fill(temporaryPin!);
      await employee.getByLabel('New PIN', { exact: true }).fill(replacement);
      await employee.getByLabel('Confirm new PIN', { exact: true }).fill('975312');
      let invalidWrites = 0;
      const countInvalid = (request: import('@playwright/test').Request) => {
        if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v2/users/me/pin') invalidWrites++;
      };
      employee.on('request', countInvalid);
      try {
        await employee.getByRole('button', { name: 'Update PIN', exact: true }).click();
        await expect(employee.getByRole('alert')).toContainText('New PINs do not match');
        await expect(employee).toHaveURL(/\/auth\/reset-pin(?:\?|$)/);
        expect((await session(employee, 'STAFF', true)).sessionScope === original.sessionScope).toBe(true);
        expect((await native<StaffMember>(page.request, `/api/v2/users/${staffId}`)).pinResetRequired).toBe(true);
        expect(invalidWrites, 'Invalid confirmation does not dispatch native PIN replacement').toBe(0);
      } finally { employee.off('request', countInvalid); }
      await employee.getByLabel('Confirm new PIN', { exact: true }).fill(replacement);
      await proveRevocation(employee, browser, info, 'native-pin-rotation-document-logout', async () => {
        const request = employee.waitForRequest(request => request.method() === 'PUT'
          && new URL(request.url()).origin === new URL(employee.url()).origin
          && new URL(request.url()).pathname === '/api/v2/users/me/pin', { timeout });
        const [observed, action] = await Promise.allSettled([
          request.then(async value => { const response = await bounded(value.response(), 'Actual rotation Request response'); expect(response).not.toBeNull(); expect(response!.status()).toBe(200); }),
          employee.getByRole('button', { name: 'Update PIN', exact: true }).click(),
        ]);
        const failures = [observed, action].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Native rotation action/actual Request observation failed.');
      }, 'STAFF', true, '/dashboard');
      expect((await native<StaffMember>(page.request, `/api/v2/users/${staffId}`)).pinResetRequired).toBe(false);
      await loginWithPin(employee, { username: e2eStaffUsername, pin: replacement, next: '/dashboard' });
      const fresh = await session(employee, 'STAFF', false);
      expect(fresh.sessionScope === original.sessionScope).toBe(false);
      await attach(employee, info, 'native-replaced-pin-fresh-session', { samePublicUser: fresh.publicUserId === staffId,
        genuineCredentialLogin: true, newSessionScope: true, pinResetRequired: false });
    });
  });
});
