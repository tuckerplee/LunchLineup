import { expect, test } from '@playwright/test';

import { loginAsSeedAdmin, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;

test.describe('Public launch workflow gaps', () => {
  test.skip(runFullStack, 'Mock workflow coverage is separate from DB-backed full-stack coverage.');
  test.skip(!runMockReadiness, 'Workflow coverage requires the local mock API.');
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Focused mutable workflow coverage runs once in desktop Chromium.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok()).toBeTruthy();
  });

  test('recovers a failed first-admin location read and routes setup before scheduling', async ({ page }) => {
    let locationReads = 0;
    await page.route('**/api/v2/locations/summary', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      locationReads += 1;
      if (locationReads <= 2) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Location service is temporarily unavailable.' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0 }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard');
    await expect(page.getByText('Some dashboard data is unavailable. Retry to refresh affected widgets.')).toBeVisible();
    const locationsCard = page.locator('article').filter({ hasText: 'Locations online' });
    await expect(locationsCard).toContainText('Unavailable');
    await locationsCard.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByRole('heading', { name: 'Complete workspace setup' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Build Weekly Schedule' })).toHaveCount(0);
    const firstLocationLink = page.getByRole('link', { name: 'Add First Location' });
    await expect(firstLocationLink).toBeVisible();
    await firstLocationLink.click();
    await expect(page).toHaveURL(/\/dashboard\/locations$/);
    expect(locationReads).toBeGreaterThanOrEqual(2);
  });
  test('loads another location page only after explicit operator continuation', async ({ page }) => {
    const requestedCursors: Array<string | null> = [];
    await page.route('**/api/v2/locations?*', async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get('cursor');
      requestedCursors.push(cursor);
      const firstPage = cursor === null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: firstPage
            ? [{ id: 'loc-alpha', name: 'Alpha Cafe', timezone: 'America/Los_Angeles' }]
            : [{ id: 'loc-beta', name: 'Beta Cafe', timezone: 'America/Los_Angeles' }],
          pagination: {
            limit: 100,
            maxLimit: 200,
            returned: 1,
            hasMore: firstPage,
            nextCursor: firstPage ? 'location-page-2' : null,
          },
        }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/locations');
    await expect(page.getByRole('heading', { name: 'Alpha Cafe' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Beta Cafe' })).toHaveCount(0);
    expect(requestedCursors.length).toBeGreaterThanOrEqual(1);
    expect(requestedCursors.every((cursor) => cursor === null)).toBe(true);
    const initialReadCount = requestedCursors.length;

    await page.getByRole('button', { name: 'Load more locations' }).click();

    await expect(page.getByRole('heading', { name: 'Alpha Cafe' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Beta Cafe' })).toBeVisible();
    expect(requestedCursors.slice(initialReadCount)).toEqual(['location-page-2']);
  });

  test('creates, edits, and deactivates a location with permission-safe confirmations', async ({ page }) => {
    const locations: Array<{ id: string; name: string; address?: string | null; timezone?: string | null }> = [{
      id: 'loc-downtown',
      name: 'E2E Operations Diner',
      address: '100 Main Street',
      timezone: 'America/Los_Angeles',
    }];
    let createRequestKey = '';
    let createRequestPayload: { name: string; address?: string; timezone: string } | null = null;
    let updateRequestPayload: { name: string; address: string | null; timezone: string } | null = null;

    await page.route('**/api/v2/locations**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/v2/locations' && request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: locations, pagination: { limit: 100, maxLimit: 200, returned: locations.length, hasMore: false, nextCursor: null } }) });
        return;
      }
      if (url.pathname === '/api/v2/locations' && request.method() === 'POST') {
        createRequestKey = request.headers()['idempotency-key'] ?? '';
        const payload = request.postDataJSON() as { name: string; address?: string; timezone: string };
        createRequestPayload = payload;
        const created = { id: 'loc-launch', ...payload };
        locations.unshift(created);
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
        return;
      }

      const match = /^\/api\/v2\/locations\/([^/]+)$/.exec(url.pathname);
      if (match && request.method() === 'PUT') {
        const index = locations.findIndex((location) => location.id === match[1]);
        const payload = request.postDataJSON() as { name: string; address: string | null; timezone: string };
        updateRequestPayload = payload;
        locations[index] = { ...locations[index], ...payload };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(locations[index]) });
        return;
      }
      if (match && request.method() === 'DELETE') {
        const index = locations.findIndex((location) => location.id === match[1]);
        if (index >= 0) locations.splice(index, 1);
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fallback();
    });

    await loginAsSeedAdmin(page, '/dashboard/locations');
    await expect(page.getByRole('heading', { name: 'Locations' })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });

    const addLocationButton = page.getByRole('button', { name: 'Add Location' });
    await addLocationButton.click();
    await expect(addLocationButton).toHaveAttribute('aria-expanded', 'true');
    const createForm = page.getByRole('form', { name: 'Create location' });
    await expect(createForm).toBeVisible();
    const openCreateWidths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      formRight: Math.ceil(document.querySelector<HTMLElement>('#create-location-form')?.getBoundingClientRect().right ?? 0),
    }));
    expect(openCreateWidths.viewport).toBe(375);
    expect(openCreateWidths.document).toBeLessThanOrEqual(openCreateWidths.viewport);
    expect(openCreateWidths.body).toBeLessThanOrEqual(openCreateWidths.viewport);
    expect(openCreateWidths.formRight).toBeLessThanOrEqual(openCreateWidths.viewport);
    await createForm.getByLabel('Location name').fill('Launch Cafe');
    await createForm.getByLabel('Address').fill('500 Market Street');
    await createForm.getByLabel('IANA timezone').fill('America/Chicago');
    await createForm.getByLabel('IANA timezone').press('Enter');

    await expect(page.getByRole('status')).toHaveText('Location added.');
    expect(createRequestKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(createRequestPayload).toEqual({
      name: 'Launch Cafe',
      address: '500 Market Street',
      timezone: 'America/Chicago',
    });
    const launchCard = page.getByRole('article').filter({ hasText: 'Launch Cafe' });
    await expect(launchCard).toContainText('500 Market Street');

    await launchCard.getByRole('button', { name: 'Edit' }).click();
    let editForm = page.getByRole('form', { name: 'Edit Launch Cafe' });
    await editForm.getByLabel('Location name').fill('Unsaved Cafe');
    await editForm.getByLabel('Address').fill('999 Unsaved Street');
    await editForm.getByLabel('IANA timezone').fill('America/Denver');
    await editForm.getByRole('button', { name: 'Cancel' }).click();

    await launchCard.getByRole('button', { name: 'Edit' }).click();
    editForm = page.getByRole('form', { name: 'Edit Launch Cafe' });
    await expect(editForm.getByLabel('Location name')).toHaveValue('Launch Cafe');
    await expect(editForm.getByLabel('Address')).toHaveValue('500 Market Street');
    await expect(editForm.getByLabel('IANA timezone')).toHaveValue('America/Chicago');
    await editForm.getByLabel('Address').fill('501 Market Street');
    await editForm.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Location updated.');
    expect(updateRequestPayload).toEqual({
      name: 'Launch Cafe',
      address: '501 Market Street',
      timezone: 'America/Chicago',
    });
    await expect(launchCard).toContainText('501 Market Street');

    const deactivateTrigger = launchCard.getByRole('button', { name: 'Deactivate' });
    await deactivateTrigger.click();
    let dialog = page.getByRole('alertdialog', { name: 'Deactivate Launch Cafe?' });
    let confirmationInput = dialog.getByLabel('Type the location name to confirm');
    let cancelDeactivation = dialog.getByRole('button', { name: 'Cancel' });
    await expect(confirmationInput).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancelDeactivation).toBeFocused();
    await cancelDeactivation.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(deactivateTrigger).toBeFocused();

    await deactivateTrigger.press('Enter');
    dialog = page.getByRole('alertdialog', { name: 'Deactivate Launch Cafe?' });
    confirmationInput = dialog.getByLabel('Type the location name to confirm');
    const confirmButton = dialog.getByRole('button', { name: 'Deactivate location' });
    await expect(confirmButton).toBeDisabled();
    await confirmationInput.fill('Launch Cafe');
    await expect(confirmButton).toBeEnabled();
    await confirmButton.focus();
    await page.keyboard.press('Tab');
    await expect(confirmationInput).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirmButton).toBeFocused();
    await confirmButton.click();
    await expect(page.getByRole('status')).toHaveText('Launch Cafe deactivated.');
    await expect(launchCard).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('submits staff invitations by keyboard and clears a stale temporary PIN before a failed retry', async ({ page }) => {
    await page.route('**/api/v2/users/access/catalog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          defaultInviteRoleId: 'role-staff',
          permissions: [],
          roles: [{
            id: 'role-staff',
            name: 'Staff',
            slug: 'staff',
            isSystem: true,
            isDefault: true,
            legacyRole: 'STAFF',
            userCount: 2,
            permissions: ['auth:login_pin'],
            canDelegate: true,
          }],
        }),
      });
    });

    let invitationCount = 0;
    await page.route('**/api/v2/users/invite', async (route) => {
      invitationCount += 1;
      if (invitationCount === 1) {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'user-launch-staff', temporaryPin: '135790' }),
        });
        return;
      }
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Username already exists.' }) });
    });

    await loginAsSeedAdmin(page, '/dashboard/staff');
    const inviteForm = page.getByRole('form', { name: 'Invite team member' });
    await inviteForm.getByLabel('Login method').selectOption('username');
    const roleSelector = inviteForm.getByLabel('Role');
    await expect(roleSelector.getByRole('option', { name: 'Staff' })).toHaveCount(1);
    await roleSelector.selectOption({ label: 'Staff' });
    await inviteForm.getByLabel('Username').fill('launch.staff');
    await inviteForm.getByLabel('Temporary PIN').fill('135790');
    await inviteForm.getByLabel('Full name').fill('Launch Staff');
    await expect(inviteForm.getByLabel('Full name')).toHaveValue('Launch Staff');
    await inviteForm.getByLabel('Full name').press('Enter');
    await expect(page.getByRole('status')).toContainText('Temporary PIN:');

    await inviteForm.getByLabel('Full name').fill('Duplicate Staff');
    await inviteForm.getByLabel('Username').fill('launch.staff');
    await inviteForm.getByLabel('Temporary PIN').press('Enter');
    await expect(page.locator('div[role=alert]').filter({ hasText: 'Username already exists.' })).toHaveText('Username already exists.');
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('announces password-reset request, failure, and success without a blank recovery page', async ({ page }) => {
    await page.route('**/api/v2/auth/password/reset/request', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
    });
    let confirmAttempts = 0;
    await page.route('**/api/v2/auth/password/reset/confirm', async (route) => {
      confirmAttempts += 1;
      await route.fulfill({
        status: confirmAttempts === 1 ? 410 : 200,
        contentType: 'application/json',
        body: JSON.stringify(confirmAttempts === 1 ? { message: 'Expired' } : { success: true }),
      });
    });

    await page.goto('/auth/reset-password');
    await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
    await page.getByLabel('Workspace slug').fill('e2e-operations');
    await page.getByLabel('Username or email').fill('E2E.Admin');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const requestStatus = page.getByRole('status');
    await expect(requestStatus).toContainText('If a matching account exists');
    await expect(requestStatus).toBeFocused();

    await page.goto('/auth/reset-password?token=expired-token');
    await expect(page.getByRole('heading', { name: 'Set new password' })).toBeVisible();
    await page.getByRole('textbox', { name: 'New password', exact: true }).fill('new-password-123');
    await page.getByRole('textbox', { name: 'Confirm password', exact: true }).fill('new-password-123');
    await page.getByRole('button', { name: 'Update password' }).click();
    const error = page.locator('.reset-error[role=alert]');
    await expect(error).toHaveText('Reset link is invalid or expired.');
    await expect(error).toBeFocused();

    await page.getByRole('button', { name: 'Update password' }).click();
    const success = page.getByRole('status');
    await expect(success).toHaveText('Password updated. Sign in with your new password.');
    await expect(success).toBeFocused();
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/auth/login');
  });
});
