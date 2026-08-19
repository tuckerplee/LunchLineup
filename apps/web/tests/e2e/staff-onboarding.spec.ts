import { expect, test, type Page } from '@playwright/test';

import { loginAsSeedAdmin, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;

const roles = [
  {
    id: 'role-staff',
    name: 'Staff',
    slug: 'staff',
    legacyRole: 'STAFF',
    isSystem: true,
    isDefault: true,
    userCount: 1,
    permissions: ['auth:login_pin'],
    canDelegate: true,
  },
  {
    id: 'role-manager',
    name: 'Manager',
    slug: 'manager',
    legacyRole: 'MANAGER',
    isSystem: true,
    isDefault: false,
    userCount: 0,
    permissions: ['users:write'],
    canDelegate: true,
  },
];

async function routeCatalog(page: Page, emailInvitationAvailable: boolean) {
  await page.route('**/api/v2/users/access/catalog', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        defaultInviteRoleId: 'role-staff',
        emailInvitationAvailable,
        permissions: [],
        roles,
      }),
    });
  });
}

test.describe('Staff onboarding', () => {
  test.skip(runFullStack, 'Focused onboarding UX coverage uses deterministic mock delivery readiness.');
  test.skip(!runMockReadiness, 'Focused onboarding UX coverage requires the local mock API.');
  test.skip(({ browserName }) => browserName !== 'chromium', 'Focused onboarding coverage runs once in Chromium.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok()).toBeTruthy();
  });

  test('uses explicit email and PIN flows without cross-mode payload fields and protects temporary credentials', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await routeCatalog(page, true);

    const invitations: Array<Record<string, unknown>> = [];
    await page.route('**/api/v2/users/invite', async (route) => {
      const payload = await route.request().postDataJSON() as Record<string, unknown>;
      invitations.push(payload);
      const pinMethod = typeof payload.username === 'string';
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: pinMethod ? 'user-pin-onboarding' : 'user-email-onboarding',
          temporaryPin: pinMethod ? payload.pin : null,
          invitationDelivery: {
            status: pinMethod ? 'NOT_APPLICABLE' : 'PENDING',
            attempts: 0,
            canRetry: false,
            canReissue: false,
          },
        }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/staff');
    const form = page.getByRole('form', { name: 'Add team member' });
    await expect(form.getByRole('status', { name: 'Email invitation availability' })).toContainText('Email delivery: Available');

    await form.getByRole('radio', { name: /Email invitation/ }).check();
    await expect(form.getByLabel('Work email')).toBeVisible();
    await expect(form.getByLabel('Username', { exact: true })).toHaveCount(0);
    await expect(form.getByLabel('Temporary PIN', { exact: true })).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Send email invitation' })).toBeVisible();
    await form.getByLabel('Full name').fill('Email Teammate');
    await form.getByLabel('Work email').fill('email.teammate@example.test');
    await form.getByRole('button', { name: 'Send email invitation' }).click();
    await expect(page.getByText('Email invitation created. Delivery status is shown below.')).toBeVisible();
    expect(invitations[0]).toEqual({
      name: 'Email Teammate',
      email: 'email.teammate@example.test',
      roleId: 'role-staff',
    });

    await form.getByRole('radio', { name: /Username \+ temporary PIN/ }).check();
    await expect(form.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(form.getByLabel('Temporary PIN', { exact: true })).toBeVisible();
    await expect(form.getByLabel('Work email')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Create team member' })).toBeVisible();
    await form.getByLabel('Full name').fill('PIN Teammate');
    await form.getByLabel('Username', { exact: true }).fill('pin.teammate');
    await form.getByRole('button', { name: 'Generate PIN' }).click();
    const generatedPin = await form.getByLabel('Temporary PIN', { exact: true }).inputValue();
    expect(generatedPin).toMatch(/^\d{6}$/);
    await form.getByRole('button', { name: 'Create team member' }).click();

    expect(invitations[1]).toEqual({
      name: 'PIN Teammate',
      username: 'pin.teammate',
      pin: generatedPin,
      roleId: 'role-staff',
    });
    const credentials = page.getByRole('dialog', { name: 'Save temporary credentials' });
    await expect(credentials).toBeVisible();
    await expect(credentials.getByLabel('Created temporary PIN')).toHaveText(generatedPin);
    await expect(credentials.getByRole('button', { name: 'Done' })).toBeDisabled();
    await credentials.getByRole('button', { name: 'Copy temporary PIN' }).click();
    await expect(credentials.getByRole('button', { name: 'PIN copied' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(generatedPin);
    await credentials.getByLabel('I have copied and stored these credentials securely.').check();
    await credentials.getByRole('button', { name: 'Done' }).click();
    await expect(credentials).toHaveCount(0);
    await expect(page.getByText('Temporary credentials were acknowledged.')).toBeVisible();
  });

  test('fails closed when email invitation delivery is disabled', async ({ page }) => {
    await routeCatalog(page, false);
    await loginAsSeedAdmin(page, '/dashboard/staff');

    const form = page.getByRole('form', { name: 'Add team member' });
    await expect(form.getByRole('status', { name: 'Email invitation availability' })).toContainText('Email delivery: Unavailable');
    await expect(form.getByRole('radio', { name: /Email invitation/ })).toBeDisabled();
    await expect(form.getByLabel('Work email')).toHaveCount(0);
    await expect(form.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Create team member' })).toBeVisible();
  });

  test('stages role changes until Save and restores authoritative roles on Cancel', async ({ page }) => {
    await routeCatalog(page, true);
    await page.route('**/api/v2/users?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{
            id: 'user-role-candidate',
            name: 'Role Candidate',
            username: 'role.candidate',
            email: '',
            role: 'STAFF',
            pinEnabled: true,
            pinResetRequired: false,
            assignedRoles: [roles[0]],
          }],
          summary: {
            totalUsers: 1,
            staffCount: 1,
            managerCount: 0,
            privilegedUsers: 0,
            pinAccounts: 1,
          },
        }),
      });
    });

    let roleWrites = 0;
    let lastRolePayload: unknown = null;
    await page.route('**/api/v2/users/user-role-candidate/access', async (route) => {
      roleWrites += 1;
      lastRolePayload = await route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ assignedRoles: roles }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/staff');
    const row = page.getByRole('row').filter({ hasText: 'Role Candidate' });
    const editor = row.getByRole('group', { name: 'Role changes for Role Candidate' });
    const selector = editor.getByLabel('Assigned roles for Role Candidate');

    await selector.selectOption(['role-staff', 'role-manager']);
    await expect(editor.getByText('Unsaved role changes')).toBeVisible();
    expect(roleWrites).toBe(0);
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(selector).toHaveValues(['role-staff']);
    await expect(editor.getByText('Unsaved role changes cancelled.')).toBeVisible();
    expect(roleWrites).toBe(0);

    await selector.selectOption(['role-staff', 'role-manager']);
    await editor.getByRole('button', { name: 'Save roles' }).click();
    await expect.poll(() => roleWrites).toBe(1);
    expect(lastRolePayload).toEqual({ roleIds: ['role-staff', 'role-manager'] });
    await expect(editor.getByText('Access roles saved.')).toBeVisible();
    await expect(selector).toHaveValues(['role-staff', 'role-manager']);
  });
});
