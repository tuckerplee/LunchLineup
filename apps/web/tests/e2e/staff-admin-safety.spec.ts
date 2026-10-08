import { expect, test } from '@playwright/test';

import { loginAsSeedAdmin, loginAsSeedManager, loginAsSeedSuperAdmin, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const DOWNTOWN_LOCATION_ID = '10000000-0000-4000-8000-000000000001';
const MFA_ADMIN_USER_ID = '20000000-0000-4000-8000-000000000104';

test.describe('Staff and platform admin safety controls', { tag: '@chromium' }, () => {
  test.skip(runFullStack, 'Mock safety coverage is separate from full-stack tenant workflows.');
  test.skip(!runMockReadiness, 'Safety coverage requires Playwright to start the local mock API.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok()).toBeTruthy();
  });

  test('keeps the populated staff directory and exact-person drawer reachable at narrow widths', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await loginAsSeedManager(page, '/dashboard/staff');
    const writes: { method: string; path: string }[] = [];
    const evidence: unknown[] = [];
    const observeWrite = (request: import('@playwright/test').Request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v2/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        writes.push({ method: request.method(), path });
      }
    };
    page.on('request', observeWrite);
    const tabTo = async (target: import('@playwright/test').Locator, limit = 64) => {
      for (let step = 0; step < limit; step += 1) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
      }
      await expect(target, 'Native Tab must reach the intended control within the bounded traversal').toBeFocused();
    };
    const geometry = async (target: import('@playwright/test').Locator, label: string, control = false) => {
      const result = await target.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(element);
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        const ancestors = [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
            left = Math.max(left, rect.left + parent.clientLeft);
            right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
          }
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
            top = Math.max(top, rect.top + parent.clientTop);
            bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
          }
          ancestors.push({ tag: parent.tagName, className: parent.className, overflowX: style.overflowX, overflowY: style.overflowY, rect: rect.toJSON() });
        }
        return {
          rect: bounds.toJSON(), clip: { left, top, right, bottom }, ancestors,
          textRects: Array.from(text.getClientRects()).map((rect) => rect.toJSON()),
          documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewport: innerWidth,
        };
      });
      evidence.push({ label, ...result });
      expect.soft(result.documentWidth, `${label}: document overflow`).toBeLessThanOrEqual(result.viewport);
      expect.soft(result.bodyWidth, `${label}: body overflow`).toBeLessThanOrEqual(result.viewport);
      for (const rect of result.textRects.filter((rect) => rect.width > 0 && rect.height > 0)) {
        expect.soft(rect.left, `${label}: text left clipping`).toBeGreaterThanOrEqual(result.clip.left - 0.5);
        expect.soft(rect.right, `${label}: text right clipping`).toBeLessThanOrEqual(result.clip.right + 0.5);
        expect.soft(rect.top, `${label}: text top clipping`).toBeGreaterThanOrEqual(result.clip.top - 0.5);
        expect.soft(rect.bottom, `${label}: text bottom clipping`).toBeLessThanOrEqual(result.clip.bottom + 0.5);
      }
      if (control) {
        await expect.soft(target, `${label}: focused control fully visible`).toBeInViewport({ ratio: 1 });
        expect.soft(result.rect.width, `${label}: target width`).toBeGreaterThanOrEqual(44);
        expect.soft(result.rect.height, `${label}: target height`).toBeGreaterThanOrEqual(44);
      }
    };
    try {
      for (const width of [320, 393, 768]) {
        await page.setViewportSize({ width, height: width === 320 ? 720 : width === 393 ? 851 : 900 });
        await page.goto('/dashboard/staff');
        const directory = page.getByRole('region', { name: 'Staff directory table', exact: true });
        const staffRow = directory.getByRole('row', { name: 'Manage Mock Staff', exact: true });
        const profileAction = staffRow.getByRole('button', { name: 'Edit schedule profile', exact: true });
        await expect(staffRow).toBeVisible();
        await expect(staffRow.getByText('Mock Staff', { exact: true })).toHaveCount(1);
        await expect(directory.getByRole('columnheader')).toHaveText(['Member', 'Login', 'Assigned roles', 'Actions']);
        const directoryCells = await staffRow.getByRole('cell').allTextContents();
        expect(directoryCells).toHaveLength(4);
        evidence.push({ width, directoryCells });
        const savedResponse = await page.request.get('/api/v2/users/user-mock-staff/scheduling-profile');
        expect(savedResponse.ok()).toBe(true);
        const savedProfile: unknown = await savedResponse.json();
        await tabTo(directory);
        // A table may legitimately scroll internally. Prove that real Arrow keys
        // reveal its fields and headings, without moving the document horizontally.
        for (const target of [staffRow.getByText('Mock Staff', { exact: true }), staffRow.getByText('mock.staff', { exact: true }), directory.getByRole('columnheader', { name: 'Assigned roles', exact: true }), directory.getByRole('columnheader', { name: 'Actions', exact: true })]) {
          for (let key = 0; key < 40; key += 1) {
            const position = await target.evaluate((element) => {
              const range = document.createRange(); range.selectNodeContents(element);
              const rect = range.getBoundingClientRect();
              const region = element.closest('.staff-table-scroll')!;
              const outer = region.getBoundingClientRect();
              return { left: rect.left, right: rect.right, clipLeft: Math.max(0, outer.left + region.clientLeft), clipRight: Math.min(innerWidth, outer.left + region.clientLeft + region.clientWidth) };
            });
            if (position.left >= position.clipLeft && position.right <= position.clipRight) break;
            await expect(directory).toBeFocused();
            const before = await directory.evaluate((element) => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));
            const direction = position.left < position.clipLeft ? -1 : 1;
            if ((direction < 0 && before.left <= 0) || (direction > 0 && before.left >= before.max)) break;
            await page.keyboard.press(direction < 0 ? 'ArrowLeft' : 'ArrowRight');
            await expect.poll(async () => direction * ((await directory.evaluate((element) => element.scrollLeft)) - before.left), { timeout: 2_000 }).toBeGreaterThan(0);
            // Read-only settling avoids attributing native smooth-scroll latency
            // to a clipping failure. It never writes a scroll position.
            let last = Number.NaN, stable = 0;
            await expect.poll(async () => {
              const current = await directory.evaluate((element) => element.scrollLeft);
              stable = Math.abs(current - last) < 0.1 ? stable + 1 : 0;
              last = current;
              return stable;
            }, { timeout: 2_000, intervals: [50, 50, 50] }).toBeGreaterThanOrEqual(2);
          }
          await geometry(target, `${width}: table ${await target.innerText()}`);
        }
        await tabTo(profileAction);
        await geometry(profileAction, `${width}: profile action`, true);
        await testInfo.attach(`staff-${width}-directory-action`, { body: await page.screenshot(), contentType: 'image/png' });
        await page.keyboard.press('Enter');
        const drawer = page.getByRole('dialog', { name: 'Manage Mock Staff', exact: true });
        const editor = drawer.getByRole('region', { name: 'Scheduling profile for Mock Staff', exact: true });
        const close = drawer.getByRole('button', { name: 'Close staff management', exact: true });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('heading', { name: 'Mock Staff', exact: true })).toBeVisible();
        await expect(close).toBeFocused();
        await geometry(close, `${width}: drawer Close`, true);
        await geometry(drawer.getByRole('heading', { name: 'Mock Staff', exact: true }), `${width}: drawer identity`);
        await expect(editor.getByLabel('Skills', { exact: true })).toBeEnabled();
        await tabTo(editor.getByLabel('Skills', { exact: true }));
        await page.keyboard.type('unsaved mobile draft');
        await expect(editor.getByLabel('Skills', { exact: true })).toHaveValue('unsaved mobile draft');
        await geometry(editor.getByLabel('Skills', { exact: true }), `${width}: skill draft`, true);
        await tabTo(editor.getByRole('button', { name: 'Save profile', exact: true }));
        await geometry(editor.getByRole('button', { name: 'Save profile', exact: true }), `${width}: profile Save`, true);
        await testInfo.attach(`staff-${width}-drawer-save`, { body: await page.screenshot(), contentType: 'image/png' });
        // Escape cancels this drawer visit. Saving is deliberately not invoked.
        await expect(editor.getByLabel('Skills', { exact: true })).toHaveValue('unsaved mobile draft');
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect.soft(profileAction, `${width}: Escape returns focus to the actual opener`).toBeFocused();
        await geometry(profileAction, `${width}: returned profile action`, true);
        await tabTo(profileAction);
        await page.keyboard.press('Enter');
        await expect(drawer).toBeVisible();
        await expect(editor.getByLabel('Skills', { exact: true })).toHaveValue('');
        await expect(close).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(drawer).toHaveCount(0);
        await expect.soft(profileAction, `${width}: Close returns focus to the actual opener`).toBeFocused();
        // Also exercise the labelled row's native Enter path, not only its button.
        await tabTo(staffRow);
        await page.keyboard.press('Enter');
        await expect(drawer).toBeVisible();
        await expect(close).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(drawer).toHaveCount(0);
        await expect.soft(staffRow, `${width}: row-origin Escape focus return`).toBeFocused();
        expect(await staffRow.getByRole('cell').allTextContents()).toEqual(directoryCells);
        const afterResponse = await page.request.get('/api/v2/users/user-mock-staff/scheduling-profile');
        expect(afterResponse.ok()).toBe(true);
        expect(await afterResponse.json()).toEqual(savedProfile);
        expect(writes, `${width}: drawer cancellation must send no API mutation`).toEqual([]);
      }
    } finally {
      page.off('request', observeWrite);
      await testInfo.attach('staff-mobile-geometry-and-write-observations', { body: Buffer.from(JSON.stringify({ evidence, writes }, null, 2)), contentType: 'application/json' });
    }
  });

  test('requires explicit confirmation before resetting a PIN or removing staff', async ({ page }) => {
    let resetRequests = 0;
    let removeRequests = 0;

    await page.route('**/api/v2/users?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'user-admin', name: 'E2E Admin', username: 'e2e.admin', email: '', role: 'ADMIN', assignedRoles: [] },
            { id: 'user-reset', name: 'Reset Candidate', username: 'reset.candidate', email: '', role: 'STAFF', assignedRoles: [] },
            { id: 'user-remove', name: 'Remove Candidate', username: 'remove.candidate', email: '', role: 'STAFF', assignedRoles: [] },
          ],
          summary: {
            totalUsers: 3,
            staffCount: 2,
            managerCount: 0,
            privilegedUsers: 1,
            pinAccounts: 3,
          },
        }),
      });
    });
    await page.route('**/api/v2/users/user-reset/pin/reset', async (route) => {
      resetRequests += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ temporaryPin: '123456' }) });
    });
    await page.route('**/api/v2/users/user-remove', async (route) => {
      removeRequests += 1;
      await route.fulfill({ status: 204, body: '' });
    });

    await loginAsSeedAdmin(page, '/dashboard/staff');

    const resetRow = page.getByRole('row').filter({ hasText: 'Reset Candidate' });
    await resetRow.getByText('Reset Candidate', { exact: true }).click();
    const resetDrawer = page.getByRole('dialog', { name: 'Manage Reset Candidate' });
    await expect(resetDrawer).toBeVisible();
    await expect(resetDrawer.getByText('No delegable roles available.')).toBeVisible();
    await resetDrawer.getByRole('button', { name: 'Reset PIN' }).click();
    const resetDialog = page.getByRole('alertdialog', { name: 'Reset PIN for Reset Candidate?' });
    await expect(resetDialog).toBeVisible();
    expect(resetRequests).toBe(0);
    await resetDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(resetDialog).toHaveCount(0);
    expect(resetRequests).toBe(0);

    await resetDrawer.getByRole('button', { name: 'Reset PIN' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset PIN' }).click();
    await expect.poll(() => resetRequests).toBe(1);
    await expect(resetDrawer.getByText('Temporary PIN:')).toContainText('123456');
    await resetDrawer.getByRole('button', { name: 'Close staff management' }).click();

    const removeRow = page.getByRole('row').filter({ hasText: 'Remove Candidate' });
    await removeRow.getByText('Remove Candidate', { exact: true }).click();
    const removeDrawer = page.getByRole('dialog', { name: 'Manage Remove Candidate' });
    await removeDrawer.getByRole('button', { name: 'Remove permanently' }).click();
    const removeDialog = page.getByRole('alertdialog', { name: 'Permanently remove Remove Candidate?' });
    await expect(removeDialog).toBeVisible();
    expect(removeRequests).toBe(0);
    await removeDialog.getByRole('button', { name: 'Remove permanently' }).click();
    await expect.poll(() => removeRequests).toBe(1);
    await expect(removeRow).toHaveCount(0);
  });

  test('allows managers to edit recurring and dated location availability without admin controls', async ({ page }) => {
    await loginAsSeedManager(page, '/dashboard/staff');

    await expect(page.getByText('Add team member')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create team member' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset PIN' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove permanently' })).toHaveCount(0);

    const staffRow = page.getByRole('row').filter({ hasText: 'Mock Staff' });
    await staffRow.getByText('Mock Staff', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Manage Mock Staff' })).toBeVisible();
    const editor = page.getByRole('region', { name: 'Scheduling profile for Mock Staff' });
    await expect(editor.getByText('No recurring availability is configured. This staff member is unavailable except on dates with an Available exception.')).toBeVisible();

    await editor.getByLabel('Skills').fill('  Line   Cook ');
    await editor.getByRole('button', { name: 'Add skill' }).click();
    await editor.getByRole('button', { name: 'Add window' }).click();
    await editor.getByLabel('Location').selectOption(DOWNTOWN_LOCATION_ID);
    await editor.getByLabel('Start').fill('22:00');
    await editor.getByLabel(/End/).fill('02:00');
    await expect(editor.getByText(/overnight/)).toBeVisible();
    await editor.getByRole('button', { name: 'Add exception' }).click();
    const datedException = editor.getByRole('group', { name: 'Dated availability exception 1' });
    await datedException.getByLabel('Local date').fill('2026-03-12');
    await datedException.getByLabel('Location').selectOption(DOWNTOWN_LOCATION_ID);
    await datedException.getByRole('combobox').nth(1).selectOption('AVAILABLE');
    await datedException.getByLabel('All day').uncheck();
    await datedException.getByLabel('Start').fill('12:00');
    await datedException.getByLabel('End').fill('14:00');
    await editor.getByRole('button', { name: 'Save profile' }).click();
    await expect(editor.getByText('Scheduling profile saved and confirmed.')).toBeVisible();

    await page.getByRole('dialog', { name: 'Manage Mock Staff' }).getByRole('button', { name: 'Close staff management' }).click();
    await staffRow.getByRole('button', { name: 'Edit schedule profile' }).click();
    const reopened = page.getByRole('region', { name: 'Scheduling profile for Mock Staff' });
    await expect(reopened.getByText('line cook')).toBeVisible();
    await expect(reopened.getByLabel('Location').first()).toHaveValue(DOWNTOWN_LOCATION_ID);
    await expect(reopened.getByLabel('Start').first()).toHaveValue('22:00');
    await expect(reopened.getByLabel(/End/).first()).toHaveValue('02:00');
    const reopenedException = reopened.getByRole('group', { name: 'Dated availability exception 1' });
    await expect(reopenedException.getByLabel('Local date')).toHaveValue('2026-03-12');
    await expect(reopenedException.getByLabel('Location')).toHaveValue(DOWNTOWN_LOCATION_ID);
    await expect(reopenedException.getByRole('combobox').nth(1)).toHaveValue('AVAILABLE');
    await expect(reopenedException.getByLabel('All day')).not.toBeChecked();
    await expect(reopenedException.getByLabel('Start')).toHaveValue('12:00');
    await expect(reopenedException.getByLabel('End')).toHaveValue('14:00');
  });

  test('reviews and explicitly applies a PDF import with one stable paid attempt', async ({ page }) => {
    const idempotencyKeys: string[] = [];
    const csrfHeaders: string[] = [];
    let uploadRequests = 0;
    let statusRequests = 0;
    let profileWrites = 0;
    let loadedProfileVersion = '';
    let appliedProfile: {
      expectedVersion?: string;
      skills?: string[];
      availability?: unknown[];
      availabilityExceptions?: unknown[];
    } | null = null;

    await page.route('**/api/v2/billing/features', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          features: { scheduling: { creditCost: 3 } },
        }),
      });
    });
    await page.route('**/api/v2/availability-imports/users/user-mock-staff', async (route) => {
      uploadRequests += 1;
      idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
      csrfHeaders.push(route.request().headers()['x-csrf-token'] ?? '');
      if (uploadRequests === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Temporary import handoff failure.' }),
        });
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'availability-import-1',
          userId: 'user-mock-staff',
          status: 'PENDING',
          parsedAvailability: null,
          settlement: { chargedCredits: 3, refundedCredits: 0, pending: true },
        }),
      });
    });
    await page.route('**/api/v2/availability-imports/availability-import-1', async (route) => {
      statusRequests += 1;
      const succeeded = statusRequests >= 2;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'availability-import-1',
          userId: 'user-mock-staff',
          status: succeeded ? 'SUCCEEDED' : 'RUNNING',
          parsedAvailability: succeeded ? [{
            locationId: null,
            dayOfWeek: 1,
            startTimeMinutes: 540,
            endTimeMinutes: 1020,
          }] : null,
          settlement: { chargedCredits: 3, refundedCredits: 0, pending: true },
        }),
      });
    });
    await page.route('**/api/v2/users/user-mock-staff/scheduling-profile', async (route) => {
      if (route.request().method() !== 'PUT') {
        const response = await route.fetch({ timeout: 10_000, maxRetries: 0, maxRedirects: 0 });
        const profile = await response.json();
        loadedProfileVersion = profile.version;
        await route.fulfill({ response });
        return;
      }
      profileWrites += 1;
      appliedProfile = route.request().postDataJSON();
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await loginAsSeedManager(page, '/dashboard/staff');
    const staffRow = page.getByRole('row').filter({ hasText: 'Mock Staff' });
    await staffRow.getByRole('button', { name: 'Edit schedule profile' }).click();
    const editor = page.getByRole('region', { name: 'Scheduling profile for Mock Staff' });

    await expect(editor.getByText('PDF only, up to 5 MiB. This import costs 3 paid credits.')).toBeVisible();
    await editor.locator('#availability-pdf-file').setInputFiles({
      name: 'availability.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 availability'),
    });
    await editor.getByRole('button', { name: 'Upload PDF' }).click();
    await expect(editor.getByRole('button', { name: 'Retry upload' })).toBeVisible();
    expect(profileWrites).toBe(0);

    await editor.getByRole('button', { name: 'Retry upload' }).click();
    await expect(editor.getByText('Succeeded')).toBeVisible({ timeout: 10_000 });
    await expect(editor.getByText('3 paid credits were charged for this completed import.')).toBeVisible();
    await expect(editor.getByText('Monday')).toBeVisible();
    await expect(editor.getByText('9:00 AM to 5:00 PM')).toBeVisible();
    expect(profileWrites).toBe(0);
    expect(uploadRequests).toBe(2);
    expect(idempotencyKeys[0]).toBeTruthy();
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(csrfHeaders.every(Boolean)).toBe(true);

    await editor.getByRole('button', { name: 'Apply imported availability' }).click();
    await expect(editor.getByText('Imported availability applied and scheduling profile saved.')).toBeVisible();
    expect(profileWrites).toBe(1);
    expect(loadedProfileVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(appliedProfile).toEqual({
      expectedVersion: loadedProfileVersion,
      skills: [],
      availability: [{
        locationId: null,
        dayOfWeek: 1,
        startTimeMinutes: 540,
        endTimeMinutes: 1020,
      }],
      availabilityExceptions: [],
    });
  });
  test('defaults tenant admin invites to Staff and hides non-delegable Admin', async ({ page }) => {
    let invitedRoleId = '';
    await page.route('**/api/v2/users/access/catalog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          defaultInviteRoleId: 'role-staff',
          permissions: [],
          roles: [
            { id: 'role-admin', name: 'Admin', slug: 'admin', legacyRole: 'ADMIN', isSystem: true, isDefault: true, userCount: 1, permissions: ['users:admin'], canDelegate: false },
            { id: 'role-staff', name: 'Staff', slug: 'staff', legacyRole: 'STAFF', isSystem: true, isDefault: false, userCount: 2, permissions: ['auth:login_pin'], canDelegate: true },
          ],
        }),
      });
    });
    await page.route('**/api/v2/users/invite', async (route) => {
      invitedRoleId = (await route.request().postDataJSON()).roleId;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-staff', temporaryPin: '123456' }) });
    });

    await loginAsSeedAdmin(page, '/dashboard/staff');
    const roleSelector = page.getByLabel('Role', { exact: true });
    await expect(roleSelector).toHaveValue('role-staff');
    await expect(roleSelector.getByRole('option', { name: 'Staff' })).toHaveCount(1);
    await expect(roleSelector.getByRole('option', { name: 'Admin' })).toHaveCount(0);
    await page.getByLabel('Full name').fill('Launch Staff');
    await page.getByLabel('Username', { exact: true }).fill('launch.staff');
    await page.getByLabel('Temporary PIN', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Create team member' }).click();
    await expect.poll(() => invitedRoleId).toBe('role-staff');
  });

  test('keeps a failed scheduling-profile read non-writable until retry succeeds', async ({ page }) => {
    let profileReads = 0;
    let profileWrites = 0;
    let profileAvailable = false;
    await page.route('**/api/v2/users/user-mock-staff/scheduling-profile', async (route) => {
      if (route.request().method() === 'PUT') {
        profileWrites += 1;
        await route.continue();
        return;
      }
      profileReads += 1;
      if (!profileAvailable) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Profile temporarily unavailable.' }) });
        return;
      }
      await route.continue();
    });

    await loginAsSeedManager(page, '/dashboard/staff');
    const staffRow = page.getByRole('row').filter({ hasText: 'Mock Staff' });
    await staffRow.getByRole('button', { name: 'Edit schedule profile' }).click();

    const editor = page.getByRole('region', { name: 'Scheduling profile for Mock Staff' });
    await expect(editor.getByText('Existing profile data has not been replaced.')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    await expect(editor.getByLabel('Skills')).toHaveCount(0);
    expect(profileWrites).toBe(0);

    profileAvailable = true;
    await editor.getByRole('button', { name: 'Retry profile load' }).click();
    await expect(editor.getByLabel('Skills')).toBeEnabled();
    await expect(editor.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(profileReads).toBeGreaterThanOrEqual(2);
    expect(profileWrites).toBe(0);
  });

  test('requires an exact role name and blocks deletion while assignments exist', async ({ page }) => {
    let deleteRequests = 0;
    await page.route('**/api/v2/users/access/catalog', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          permissions: [],
          roles: [
            { id: 'role-unused', name: 'Weekend Lead', slug: 'weekend-lead', isSystem: false, isDefault: false, userCount: 0, permissions: [], canDelegate: true },
            { id: 'role-assigned', name: 'Closer', slug: 'closer', isSystem: false, isDefault: false, userCount: 2, permissions: [], canDelegate: true },
          ],
        }),
      });
    });
    await page.route('**/api/v2/users/roles/role-unused', async (route) => {
      deleteRequests += 1;
      await route.fulfill({ status: 204, body: '' });
    });

    await loginAsSeedAdmin(page, '/dashboard/staff');

    const rolesSection = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Roles & Permissions' }),
    });
    const roleDeleteButtons = rolesSection.getByRole('button', { name: 'Delete' });
    await roleDeleteButtons.nth(1).click();
    const blockedDialog = page.getByRole('alertdialog', { name: 'Delete Closer?' });
    await expect(blockedDialog).toContainText('2 assignments');
    await expect(blockedDialog).toContainText('Reassign');
    await expect(blockedDialog.getByRole('button', { name: 'Delete role' })).toBeDisabled();
    await blockedDialog.getByRole('button', { name: 'Cancel' }).click();

    await roleDeleteButtons.first().click();
    const deletionDialog = page.getByRole('alertdialog', { name: 'Delete Weekend Lead?' });
    await expect(deletionDialog).toContainText('0 assignments');
    const deleteButton = deletionDialog.getByRole('button', { name: 'Delete role' });
    await expect(deleteButton).toBeDisabled();
    await deletionDialog.getByRole('textbox', { name: 'Role name' }).fill('Weekend Lead');
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    await expect.poll(() => deleteRequests).toBe(1);
  });

  test('requires exact confirmation and a reason for another user MFA reset', async ({ page }) => {
    await loginAsSeedSuperAdmin(page, '/admin/users');

    const resetMfaButton = page.getByRole('button', { name: 'Reset MFA' });
    await expect(resetMfaButton).toBeDisabled();

    const unenrolledRow = page.getByRole('row').filter({ hasText: 'E2E Admin' });
    await unenrolledRow.getByRole('button').first().click();
    await expect(resetMfaButton).toBeDisabled();

    const enrolledRow = page.getByRole('row').filter({ hasText: 'E2E MFA Admin' });
    await enrolledRow.getByRole('button').first().click();
    await expect(resetMfaButton).toBeEnabled();

    const confirmation = `reset-mfa:${MFA_ADMIN_USER_ID}`;
    const reason = 'Support verified account ownership.';
    const promptMessages: string[] = [];
    const promptResponses = [confirmation, reason];
    page.on('dialog', async (dialog) => {
      promptMessages.push(dialog.message());
      await dialog.accept(promptResponses.shift());
    });

    const resetRequestPromise = page.waitForRequest((request) =>
      request.method() === 'POST' && request.url().endsWith(`/api/v2/admin/users/${MFA_ADMIN_USER_ID}/mfa/reset`),
    );
    await resetMfaButton.click();
    const resetRequest = await resetRequestPromise;

    expect(promptMessages).toEqual([
      `Type reset-mfa:${MFA_ADMIN_USER_ID} to clear MFA factors and revoke all sessions.`,
      'Enter the support reason for this MFA recovery.',
    ]);
    expect(promptResponses).toHaveLength(0);
    expect(resetRequest.postDataJSON()).toEqual({ confirmation, reason });
    await expect(page.getByText('MFA factors cleared for E2E MFA Admin; all sessions were revoked.')).toBeVisible();
    await expect(resetMfaButton).toBeDisabled();
  });

  test('keeps platform admin sign-out reachable in the compact top bar at 1024px and mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await loginAsSeedSuperAdmin(page, '/admin');

    const signOut = page.locator('.workspace-topbar').getByRole('link', { name: 'Sign out' });
    await expect(signOut).toBeVisible();
    await expect(signOut).toBeInViewport();
    await expect(signOut.getByText('Sign out')).toBeVisible();

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(signOut).toBeVisible();
    await expect(signOut).toBeInViewport();
    await expect(signOut.getByText('Sign out')).toBeHidden();
  });
});
