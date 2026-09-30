import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { LocationListResponse, LocationRecord, LocationSummaryResponse } from '@lunchlineup/api-contract';
import { expect, test } from './qa-isolation-fixture';
import { csrfHeaders, e2eStaffPin, e2eStaffUsername, loginAsSeedAdmin, loginWithPin, runFullStack, seedTenant } from './support';

const readOptions = { maxRedirects: 0, maxRetries: 0, timeout: 10_000 };
const maximumReadbackBytes = 256 * 1024;
const locationPath = (id: string) => `/api/v2/locations/${encodeURIComponent(id)}`;
const browserErrors = new WeakMap<Page, string[]>();

function monitorBrowser(page: Page) {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
}

function assertBrowserHealthy(page: Page) {
  // Invalid UI input sends no request. Intentional 403/422 requests below use
  // APIRequestContext, so no browser console error is expected or suppressed.
  expect(browserErrors.get(page), 'No unexplained browser errors').toEqual([]);
}

async function retainState(page: Page, testInfo: TestInfo, name: string, evidence: unknown) {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
  const readback = testInfo.outputPath(`${name}-readback.json`);
  await writeFile(readback, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await testInfo.attach(`${name} native readback`, { path: readback, contentType: 'application/json' });
}

async function readJson<T>(response: APIResponse): Promise<T> {
  try {
    expect(response.status()).toBe(200);
    const bytes = await response.body();
    expect(bytes.byteLength, 'Bounded native response before JSON decoding').toBeLessThanOrEqual(maximumReadbackBytes);
    return JSON.parse(bytes.toString('utf8')) as T;
  } finally {
    await response.dispose();
  }
}

async function readActive(page: Page): Promise<LocationListResponse> {
  const snapshot = await readJson<LocationListResponse>(await page.request.get('/api/v2/locations?limit=100', readOptions));
  // Each case starts from the bounded disposable seed, not an unknown live directory.
  expect(snapshot.pagination.hasMore).toBe(false);
  expect(snapshot.pagination.nextCursor).toBeNull();
  expect(snapshot.pagination.returned).toBe(snapshot.data.length);
  expect(snapshot.data.length).toBeLessThanOrEqual(100);
  return snapshot;
}

async function readSummary(page: Page): Promise<LocationSummaryResponse> {
  return readJson<LocationSummaryResponse>(await page.request.get('/api/v2/locations/summary', readOptions));
}

async function readLocation(page: Page, id: string): Promise<LocationRecord> {
  return readJson<LocationRecord>(await page.request.get(locationPath(id), readOptions));
}

async function expectStatus(response: APIResponse, status: number) {
  try {
    const actual = response.status();
    expect(actual).toBe(status);
    return actual;
  }
  finally { await response.dispose(); }
}

async function expectPermissionDenied(response: APIResponse) {
  try {
    const status = response.status();
    expect(status).toBe(403);
    const bytes = await response.body();
    expect(bytes.byteLength, 'Bounded native authorization problem before JSON decoding').toBeLessThanOrEqual(maximumReadbackBytes);
    const problem = JSON.parse(bytes.toString('utf8')) as { code?: string };
    expect(problem.code, 'Native permission evaluation must own the denial').toBe('permission_denied');
    return { status, code: problem.code };
  } finally {
    await response.dispose();
  }
}

function locationCard(page: Page, name: string) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function uiMutation(page: Page, method: string, path: string) {
  // Use the browser response only for transport status; fresh API reads own body evidence.
  return page.waitForResponse(response => response.request().method() === method
    && new URL(response.url()).pathname === path);
}

async function createLocation(page: Page, name: string): Promise<LocationRecord> {
  const before = await readActive(page);
  await page.getByRole('button', { name: 'Add Location' }).click();
  const form = page.getByRole('form', { name: 'Create location', exact: true });
  await form.getByLabel('Location name', { exact: true }).fill(name);
  await form.getByLabel('Address', { exact: true }).fill('10 Private Test Lane');
  await form.getByLabel('IANA timezone', { exact: true }).fill('America/Chicago');
  const response = uiMutation(page, 'POST', '/api/v2/locations');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(locationCard(page, name)).toBeVisible();
  const after = await readActive(page);
  const matches = after.data.filter(location => location.name === name);
  expect(matches).toHaveLength(1);
  const created = matches[0]!;
  expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(created).toMatchObject({ name, address: '10 Private Test Lane', timezone: 'America/Chicago' });
  expect(after.data.filter(location => location.id !== created.id)).toEqual(before.data);
  expect(after.data).toHaveLength(before.data.length + 1);
  expect(await readLocation(page, created.id)).toEqual(created);
  expect(await readSummary(page)).toEqual({ count: after.data.length });
  return created;
}

async function mutationHeaders(page: Page) {
  return { ...(await csrfHeaders(page)), Origin: new URL(page.url()).origin };
}

test.describe.serial('Native location lifecycle acceptance', { tag: '@full-stack' }, () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    expect(runFullStack, 'Native location acceptance requires the disposable full-stack harness').toBe(true);
    await seedTenant();
    monitorBrowser(page);
  });
  test.afterEach(async ({ page }) => { assertBrowserHealthy(page); });

  test('creates and edits a location through the UI with persistent fields and public UUID schedule navigation', async ({ page }, testInfo) => {
    await loginAsSeedAdmin(page, '/dashboard/locations');
    const created = await createLocation(page, 'Native location create');
    await retainState(page, testInfo, 'location-created', created);
    const card = locationCard(page, created.name);
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = card.getByRole('form', { name: `Edit ${created.name}`, exact: true });
    await form.getByLabel('Location name', { exact: true }).fill('Native location edited');
    await form.getByLabel('Address', { exact: true }).fill('20 Private Test Lane');
    await form.getByLabel('IANA timezone', { exact: true }).fill('America/New_York');
    const response = uiMutation(page, 'PUT', locationPath(created.id));
    await form.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(locationCard(page, 'Native location edited')).toBeVisible();
    const saved = await readLocation(page, created.id);
    expect(saved).toMatchObject({ id: created.id, name: 'Native location edited', address: '20 Private Test Lane', timezone: 'America/New_York' });
    expect((await readActive(page)).data.find(location => location.id === created.id)).toEqual(saved);
    await page.reload();
    const reloaded = locationCard(page, saved.name);
    await expect(reloaded).toContainText(saved.address!);
    await expect(reloaded).toContainText(`Timezone: ${saved.timezone}`);
    expect(await readLocation(page, saved.id)).toEqual(saved);
    await retainState(page, testInfo, 'location-edited-reloaded', saved);
    const link = reloaded.getByRole('link', { name: 'View schedule', exact: true });
    await expect(link).toHaveAttribute('href', `/dashboard/scheduling?location=${saved.id}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/scheduling\\?location=${saved.id}(?:&|$)`));
    await expect(page.getByLabel('Schedule location', { exact: true })).toHaveValue(saved.id);
    await expect(page.getByLabel('Schedule location').getByRole('option', { name: saved.name, exact: true })).toHaveAttribute('value', saved.id);
  });

  test('rejects invalid IANA zones in UI and native writes and preserves cancelled edit drafts', async ({ page }, testInfo) => {
    await loginAsSeedAdmin(page, '/dashboard/locations');
    const initial = await readActive(page);
    const initialSummary = await readSummary(page);
    const writes: string[] = [];
    page.on('request', request => {
      if (['POST', 'PUT', 'DELETE'].includes(request.method())
        && /^\/api\/v2\/locations(?:\/[0-9a-f-]+)?$/i.test(new URL(request.url()).pathname)) writes.push(request.method());
    });
    await page.getByRole('button', { name: 'Add Location' }).click();
    const create = page.getByRole('form', { name: 'Create location', exact: true });
    await create.getByLabel('Location name').fill('Invalid native timezone');
    await create.getByLabel('IANA timezone').fill('Invalid/Private_Test_Zone');
    await create.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Select a valid IANA timezone.');
    await retainState(page, testInfo, 'location-invalid-create', { initial, initialSummary, browserWrites: writes });
    await page.getByRole('button', { name: 'Add Location' }).click();
    expect(await readActive(page)).toEqual(initial);
    expect(await readSummary(page)).toEqual(initialSummary);
    expect(writes).toEqual([]);

    const target = initial.data[0]!;
    expect(target, 'Fresh seed supplies one active location').toBeTruthy();
    const card = locationCard(page, target.name);
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = card.getByRole('form', { name: `Edit ${target.name}`, exact: true });
    await edit.getByLabel('Location name').fill('Uncommitted location name');
    await edit.getByLabel('IANA timezone').fill('Invalid/Private_Test_Zone');
    await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Select a valid IANA timezone.');
    await edit.getByLabel('IANA timezone').fill('America/Denver');
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await readLocation(page, target.id)).toEqual(target);
    expect(writes).toEqual([]);

    const headers = await mutationHeaders(page);
    await expectStatus(await page.request.post('/api/v2/locations', {
      ...readOptions, headers, data: { name: 'Invalid native timezone', timezone: 'Invalid/Private_Test_Zone' },
    }), 422);
    await expectStatus(await page.request.put(locationPath(target.id), {
      ...readOptions, headers, data: { name: 'Rejected native edit', timezone: 'Invalid/Private_Test_Zone', expectedUpdatedAt: target.updatedAt },
    }), 422);
    expect(await readActive(page)).toEqual(initial);
    expect(await readSummary(page)).toEqual(initialSummary);
    expect(await readLocation(page, target.id)).toEqual(target);
    await page.reload();
    await locationCard(page, target.name).getByRole('button', { name: 'Edit', exact: true }).click();
    const reloaded = page.getByRole('form', { name: `Edit ${target.name}`, exact: true });
    await expect(reloaded.getByLabel('Location name')).toHaveValue(target.name);
    await expect(reloaded.getByLabel('IANA timezone')).toHaveValue(target.timezone);
    await retainState(page, testInfo, 'location-invalid-edit-cancelled', { unchanged: await readActive(page), summary: await readSummary(page) });
  });

  test('deactivates a nonreferenced location only after exact confirmation and removes its active selector UUID', async ({ page }, testInfo) => {
    await loginAsSeedAdmin(page, '/dashboard/locations');
    const seeded = await readActive(page);
    const created = await createLocation(page, 'Native nonreferenced location');
    const before = await readActive(page);
    await locationCard(page, created.name).getByRole('button', { name: 'Deactivate', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: `Deactivate ${created.name}?`, exact: true });
    await dialog.getByLabel('Type the location name to confirm').fill('Wrong location');
    await expect(dialog.getByRole('button', { name: 'Deactivate location', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await readActive(page)).toEqual(before);
    expect(await readLocation(page, created.id)).toEqual(created);
    await locationCard(page, created.name).getByRole('button', { name: 'Deactivate', exact: true }).click();
    await dialog.getByLabel('Type the location name to confirm').fill(created.name);
    const response = uiMutation(page, 'DELETE', locationPath(created.id));
    await dialog.getByRole('button', { name: 'Deactivate location', exact: true }).click();
    expect((await response).status()).toBe(204);
    await expect(locationCard(page, created.name)).toHaveCount(0);
    expect(await readActive(page)).toEqual(seeded);
    expect(await readSummary(page)).toEqual({ count: seeded.data.length });
    await expectStatus(await page.request.get(locationPath(created.id), readOptions), 404);
    for (const original of seeded.data) expect(await readLocation(page, original.id)).toEqual(original);
    await page.reload();
    await expect(locationCard(page, created.name)).toHaveCount(0);
    await page.goto('/dashboard/scheduling');
    await expect(page.getByLabel('Schedule location')).toBeEnabled();
    await expect(page.getByLabel('Schedule location').locator(`option[value="${created.id}"]`)).toHaveCount(0);
    for (const original of seeded.data) {
      await expect(page.getByLabel('Schedule location').locator(`option[value="${original.id}"]`)).toHaveText(original.name);
    }
    await retainState(page, testInfo, 'location-deactivated-active-selector', { archivedPublicId: created.id, active: await readActive(page), summary: await readSummary(page) });
    // This deliberately unreferenced fixture does not qualify published-history retention.
  });

  test('denies staff location create update and delete while independent admin readback remains exactly unchanged', async ({ page, browser }, testInfo) => {
    await loginAsSeedAdmin(page, '/dashboard/locations');
    const before = await readActive(page);
    const summary = await readSummary(page);
    const target = before.data[0]!;
    expect(target, 'Fresh seed supplies one active location').toBeTruthy();
    const adminIdentity = await readJson<{ user: { publicUserId: string; workspaceScope: string } }>(await page.request.get('/api/v2/auth/me', readOptions));
    const staffContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const staffPage = await staffContext.newPage();
      monitorBrowser(staffPage);
      await loginWithPin(staffPage, { username: e2eStaffUsername, pin: e2eStaffPin, next: '/dashboard/locations', expectedPath: '/dashboard/locations' });
      const identity = await readJson<{ user: { publicUserId: string; username: string; workspaceScope: string; permissions: string[] } }>(await staffPage.request.get('/api/v2/auth/me', readOptions));
      expect(identity.user.username).toBe(e2eStaffUsername);
      expect(identity.user.publicUserId).not.toBe(adminIdentity.user.publicUserId);
      expect(identity.user.workspaceScope).toBe(adminIdentity.user.workspaceScope);
      expect(identity.user.permissions).toContain('locations:read');
      expect(identity.user.permissions).not.toContain('locations:write');
      expect(identity.user.permissions).not.toContain('locations:delete');
      await expect(staffPage.getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();
      await expect(staffPage.getByRole('button', { name: 'Add Location' })).toHaveCount(0);
      await expect(staffPage.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
      await expect(staffPage.getByRole('button', { name: 'Deactivate', exact: true })).toHaveCount(0);
      const headers = await mutationHeaders(staffPage);
      const createDenial = await expectPermissionDenied(await staffPage.request.post('/api/v2/locations', {
        ...readOptions, headers, data: { name: 'Forbidden staff location', timezone: 'America/Chicago' },
      }));
      expect(await readActive(page)).toEqual(before);
      expect(await readSummary(page)).toEqual(summary);
      const updateDenial = await expectPermissionDenied(await staffPage.request.put(locationPath(target.id), {
        ...readOptions, headers, data: { name: 'Forbidden staff edit', address: 'Uncommitted address', timezone: 'America/Denver', expectedUpdatedAt: target.updatedAt },
      }));
      expect(await readActive(page)).toEqual(before);
      expect(await readSummary(page)).toEqual(summary);
      const deleteDenial = await expectPermissionDenied(await staffPage.request.delete(locationPath(target.id), { ...readOptions, headers }));
      expect(await readActive(page)).toEqual(before);
      await retainState(staffPage, testInfo, 'location-staff-writes-forbidden', { createDenial, updateDenial, deleteDenial });
      await retainState(page, testInfo, 'location-admin-unchanged-after-staff-denials', { before, after: await readActive(page), beforeSummary: summary, afterSummary: await readSummary(page) });
      assertBrowserHealthy(staffPage);
      expect(await readSummary(page)).toEqual(summary);
      for (const original of before.data) expect(await readLocation(page, original.id)).toEqual(original);
      await page.reload();
      await expect(locationCard(page, target.name)).toBeVisible();
      expect(await readActive(page)).toEqual(before);
    } finally {
      await staffContext.close();
    }
  });
});
