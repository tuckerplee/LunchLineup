import { expect, test } from '@playwright/test';

import {
  e2eAdminPin,
  e2eAdminUsername,
  e2eSuperAdminUsername,
  loginAsSeedSuperAdmin,
  loginWithPin,
  runFullStack,
  seedTenant,
} from './support';

test.describe.serial('Tenant and admin SaaS workflows', () => {
  test.skip(!runFullStack, 'Set E2E_FULL_STACK=1 and E2E_SEED_COMMAND to run DB-backed tenant/admin workflows.');

  test.beforeEach(() => {
    seedTenant();
  });

  test('keeps tenant admins out of platform admin while preserving dashboard access', async ({ page }) => {
    await loginWithPin(page, {
      username: e2eAdminUsername,
      pin: e2eAdminPin,
      next: '/dashboard',
      expectedPath: '/dashboard',
    });

    await expect(page.getByRole('heading', { name: 'Manager dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin Console' })).toHaveCount(0);

    const denial = await page.request.get('/admin/tenants', { maxRedirects: 0 });
    expect([307, 308]).toContain(denial.status());
    expect(new URL(denial.headers().location).pathname).toBe('/dashboard');

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard(?:[?#].*)?$/);
    await expect(page.getByRole('heading', { name: 'Manager dashboard' })).toBeVisible();
  });

  test('lets super admins inspect tenants, users, and return to tenant scheduling', async ({ page }) => {
    await loginAsSeedSuperAdmin(page, '/admin');

    await expect(page.getByRole('heading', { name: 'System Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin Overview', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Calendar', exact: true })).toBeVisible();

    await page.getByRole('link', { name: 'Tenants', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/tenants/);
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
    const operationsTenantRow = page.getByRole('row').filter({ hasText: 'E2E Operations Diner' });
    await expect(operationsTenantRow).toBeVisible();
    await page.getByLabel('Search').fill('e2e-operations');
    await expect(operationsTenantRow).toContainText('e2e-operations');

    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByText('E2E Admin')).toBeVisible();
    await expect(page.getByText('E2E Super Admin')).toBeVisible();
    await expect(page.getByText(e2eSuperAdminUsername)).toBeVisible();

    await page.getByRole('link', { name: 'Calendar', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/scheduling/);
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });
});
