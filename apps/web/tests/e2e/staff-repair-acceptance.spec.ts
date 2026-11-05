import { expect, test } from '@playwright/test';
import { loginAsSeedAdmin, seedTenant } from './support';

test.describe.serial('Staff repair acceptance', { tag: '@full-stack' }, () => {
  test.beforeEach(() => seedTenant());

  test('deactivates and reactivates the same employee with fresh persisted readback', async ({ page }) => {
    await loginAsSeedAdmin(page);
    const directory = await page.request.get('/api/v2/users');
    expect(directory.ok()).toBeTruthy();
    const employee = (await directory.json()).data.find((user: { name: string }) => user.name === 'Staff One');
    expect(employee?.id).toBeTruthy();
    await page.getByRole('row').filter({ hasText: 'Staff One' }).getByText('Staff One', { exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Manage Staff One' });
    await drawer.getByRole('button', { name: 'Deactivate employee', exact: true }).click();
    await drawer.getByRole('button', { name: 'Confirm deactivation' }).click();
    await expect(drawer.getByRole('button', { name: 'Reactivate employee', exact: true })).toBeVisible();
    const suspended = await page.request.get(`/api/v2/users/${employee.id}/lifecycle`);
    expect(suspended.ok()).toBeTruthy();
    const saved = await suspended.json();
    expect(saved.user.id).toBe(employee.id);
    expect(saved.user.name).toBe(employee.name);
    expect(saved.user.suspendedAt).toBeTruthy();
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'Staff One' }).getByText('Staff One', { exact: true }).click();
    await drawer.getByRole('button', { name: 'Reactivate employee', exact: true }).click();
    await drawer.getByRole('button', { name: 'Confirm reactivation' }).click();
    await expect(drawer.getByRole('button', { name: 'Deactivate employee', exact: true })).toBeVisible();
    const active = await page.request.get(`/api/v2/users/${employee.id}/lifecycle`);
    expect(active.ok()).toBeTruthy();
    expect((await active.json()).user).toMatchObject({ id: employee.id, name: employee.name, suspendedAt: null });
  });

  test('reconciles a lost profile response against the real committed backend state', async ({ page }) => {
    await loginAsSeedAdmin(page);
    await page.getByRole('row').filter({ hasText: 'Staff One' }).getByText('Staff One', { exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Manage Staff One' });
    await drawer.getByLabel('Skills', { exact: true }).fill('response recovery');
    await drawer.getByRole('button', { name: 'Add skill', exact: true }).click();
    let writes = 0;
    await page.route('**/api/v2/users/*/scheduling-profile', async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes += 1;
      // Forward the real mutation and lose only its response after commit.
      const committed = await route.fetch();
      expect(committed.ok()).toBeTruthy();
      await route.abort('connectionfailed');
    });
    await drawer.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(drawer.getByText('Saved profile matches your submitted draft. Confirmed by a fresh read.', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Save profile', exact: true })).toBeEnabled();
    expect(writes).toBe(1);
    await page.unroute('**/api/v2/users/*/scheduling-profile');
    await page.reload();
    await page.getByRole('row').filter({ hasText: 'Staff One' }).getByText('Staff One', { exact: true }).click();
    await expect(drawer.getByRole('button', { name: 'Remove response recovery', exact: true })).toBeVisible();
  });
});
