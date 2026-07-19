import { expect, test } from '@playwright/test';

import { loginAsSeedAdmin, loginAsSeedManager, loginAsSeedSuperAdmin, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;

test.describe('Staff and platform admin safety controls', () => {
  test.skip(runFullStack, 'Mock safety coverage is separate from full-stack tenant workflows.');
  test.skip(!runMockReadiness, 'Safety coverage requires Playwright to start the local mock API.');
  test.skip(({ browserName }) => browserName !== 'chromium', 'Focused safety coverage runs once in Chromium.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok()).toBeTruthy();
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
    await removeDrawer.getByRole('button', { name: 'Remove' }).click();
    const removeDialog = page.getByRole('alertdialog', { name: 'Remove Remove Candidate?' });
    await expect(removeDialog).toBeVisible();
    expect(removeRequests).toBe(0);
    await removeDialog.getByRole('button', { name: 'Remove staff member' }).click();
    await expect.poll(() => removeRequests).toBe(1);
    await expect(removeRow).toHaveCount(0);
  });

  test('allows managers to edit skills and location-scoped overnight availability without admin controls', async ({ page }) => {
    await loginAsSeedManager(page, '/dashboard/staff');

    await expect(page.getByText('Invite team member')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset PIN' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);

    const staffRow = page.getByRole('row').filter({ hasText: 'Mock Staff' });
    await staffRow.getByText('Mock Staff', { exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Manage Mock Staff' })).toBeVisible();
    const editor = page.getByRole('region', { name: 'Scheduling profile for Mock Staff' });
    await expect(editor.getByText('Availability is not configured. This staff member is unavailable to auto-scheduling.')).toBeVisible();

    await editor.getByLabel('Skills').fill('  Line   Cook ');
    await editor.getByRole('button', { name: 'Add skill' }).click();
    await editor.getByRole('button', { name: 'Add window' }).click();
    await editor.getByLabel('Location').selectOption('loc-downtown');
    await editor.getByLabel('Start').fill('22:00');
    await editor.getByLabel(/End/).fill('02:00');
    await expect(editor.getByText(/overnight/)).toBeVisible();
    await editor.getByRole('button', { name: 'Save profile' }).click();
    await expect(editor.getByText('Scheduling profile saved.')).toBeVisible();

    await page.getByRole('dialog', { name: 'Manage Mock Staff' }).getByRole('button', { name: 'Close staff management' }).click();
    await staffRow.getByRole('button', { name: 'Edit schedule profile' }).click();
    const reopened = page.getByRole('region', { name: 'Scheduling profile for Mock Staff' });
    await expect(reopened.getByText('line cook')).toBeVisible();
    await expect(reopened.getByLabel('Location')).toHaveValue('loc-downtown');
    await expect(reopened.getByLabel('Start')).toHaveValue('22:00');
    await expect(reopened.getByLabel(/End/)).toHaveValue('02:00');
  });

  test('reviews and explicitly applies a PDF import with one stable paid attempt', async ({ page }) => {
    const idempotencyKeys: string[] = [];
    const csrfHeaders: string[] = [];
    let uploadRequests = 0;
    let statusRequests = 0;
    let profileWrites = 0;
    let appliedProfile: { skills?: string[]; availability?: unknown[] } | null = null;

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
        await route.continue();
        return;
      }
      profileWrites += 1;
      appliedProfile = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          skills: appliedProfile?.skills ?? [],
          availability: appliedProfile?.availability ?? [],
          availabilityConfigured: true,
        }),
      });
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
    expect(appliedProfile).toEqual({
      skills: [],
      availability: [{
        locationId: null,
        dayOfWeek: 1,
        startTimeMinutes: 540,
        endTimeMinutes: 1020,
      }],
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
    await page.getByLabel('Username').fill('launch.staff');
    await page.getByRole('button', { name: 'Invite' }).click();
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

    const confirmation = 'reset-mfa:user-mfa-admin';
    const reason = 'Support verified account ownership.';
    const promptMessages: string[] = [];
    const promptResponses = [confirmation, reason];
    page.on('dialog', async (dialog) => {
      promptMessages.push(dialog.message());
      await dialog.accept(promptResponses.shift());
    });

    const resetRequestPromise = page.waitForRequest((request) =>
      request.method() === 'POST' && request.url().endsWith('/api/v2/admin/users/user-mfa-admin/mfa/reset'),
    );
    await resetMfaButton.click();
    const resetRequest = await resetRequestPromise;

    expect(promptMessages).toEqual([
      'Type reset-mfa:user-mfa-admin to clear MFA factors and revoke all sessions.',
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
