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
      next: '/admin',
      expectedPath: '/dashboard',
    });

    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin Console' })).toHaveCount(0);

    await page.goto('/admin/tenants');
    await expect(page).toHaveURL(/\/dashboard(?:[?#].*)?$/);
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  });

  test('lets super admins inspect tenants, users, and return to tenant scheduling', async ({ page }) => {
    await loginAsSeedSuperAdmin(page, '/admin');

    await expect(page.getByRole('heading', { name: 'System Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Calendar' })).toBeVisible();

    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page).toHaveURL(/\/admin\/tenants/);
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
    await expect(page.getByText('E2E Operations Diner')).toBeVisible();
    await page.getByLabel('Search').fill('e2e-operations');
    await expect(page.getByText('e2e-operations')).toBeVisible();

    await page.getByRole('link', { name: 'Users' }).click();
    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByText('E2E Admin')).toBeVisible();
    await expect(page.getByText('E2E Super Admin')).toBeVisible();
    await expect(page.getByText(e2eSuperAdminUsername)).toBeVisible();

    await page.getByRole('link', { name: 'Calendar' }).click();
    await expect(page).toHaveURL(/\/dashboard\/scheduling/);
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });
});
