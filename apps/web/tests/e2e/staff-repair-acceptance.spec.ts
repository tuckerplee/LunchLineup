import { expect, test } from '@playwright/test';
import { loginAsSeedAdmin, seedTenant } from './support';

test.describe.serial('Staff repair acceptance', { tag: '@full-stack' }, () => {
  test.beforeEach(() => seedTenant());

  test('repairs corrupt creation recovery only after a fresh directory load and acknowledgement', async ({ page }) => {
    await loginAsSeedAdmin(page);
    const form = page.getByRole('form', { name: 'Add team member' });
    await form.getByLabel('Full name').fill('Corrupt Recovery');
    await form.getByLabel('Username', { exact: true }).fill(`corrupt.${Date.now()}`);
    await form.getByLabel('Temporary PIN', { exact: true }).fill('567812');
    // This case exercises browser recovery storage; the creation is never transmitted.
    await page.route('**/api/v2/users/invite', route => route.abort('connectionfailed'));
    await form.getByRole('button', { name: 'Create team member' }).click();
    await expect(form.getByRole('button', { name: 'Create team member' })).toBeEnabled();
    const scopedKey = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.startsWith('lunchlineup:staff-create:'))!;
      sessionStorage.setItem(key, '{');
      sessionStorage.setItem('unrelated-recovery', 'preserve');
      return key;
    });
    await page.reload();
    await expect(form.getByRole('button', { name: 'Create team member' })).toBeDisabled();
    await page.route('**/api/v2/users?*', route => route.abort('connectionfailed'));
    await page.getByRole('button', { name: 'Reload directory to repair recovery' }).click();
    await expect(page.getByText('Directory refresh failed. Recovery storage is unchanged.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acknowledge directory review and retry recovery' })).toHaveCount(0);
    expect(await page.evaluate(key => sessionStorage.getItem(key), scopedKey)).toBe('{');
    await page.unroute('**/api/v2/users?*');
    const refreshed = page.waitForResponse(response => response.url().includes('/api/v2/users?') && response.ok());
    await page.getByRole('button', { name: 'Reload directory to repair recovery' }).click();
    await refreshed;
    const acknowledgement = page.getByRole('button', { name: 'Acknowledge directory review and retry recovery' });
    await expect(acknowledgement).toBeVisible();
    page.once('dialog', dialog => dialog.dismiss());
    await acknowledgement.click();
    expect(await page.evaluate(key => sessionStorage.getItem(key), scopedKey)).toBe('{');
    page.once('dialog', dialog => dialog.accept());
    await acknowledgement.click();
    await expect(form.getByRole('button', { name: 'Create team member' })).toBeEnabled();
    expect(await page.evaluate(key => sessionStorage.getItem(key), scopedKey)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('unrelated-recovery'))).toBe('preserve');
  });

  test('recovers a committed staff creation after response loss and reload without retaining the PIN', async ({ page }, testInfo) => {
    const independent = await page.context().browser()!.newContext({ baseURL: testInfo.project.use.baseURL });
    const reader = await independent.newPage();
    try {
      await loginAsSeedAdmin(reader);
      await loginAsSeedAdmin(page);
      const form = page.getByRole('form', { name: 'Add team member' });
      const username = `recovery.${Date.now()}`;
      const pin = '567812';
      await form.getByLabel('Full name').fill('Reload Recovery');
      await form.getByLabel('Username', { exact: true }).fill(username);
      await form.getByLabel('Temporary PIN', { exact: true }).fill(pin);
      const keys: string[] = [];
      let createdId = '';
      await page.route('**/api/v2/users/invite', async route => {
        keys.push(route.request().headers()['idempotency-key']);
        if (keys.length > 1) return route.continue();
        const committed = await route.fetch();
        expect(committed.ok()).toBeTruthy();
        createdId = (await committed.json()).id;
        const beforeWithholding = await reader.request.get(`/api/v2/users/${createdId}`);
        expect(beforeWithholding.ok()).toBeTruthy();
        expect(await beforeWithholding.json()).toMatchObject({ id: createdId, username });
        await route.abort('connectionfailed');
      });
      await form.getByRole('button', { name: 'Create team member' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'awaiting confirmation' })).toBeVisible();
      await expect(form.getByRole('button', { name: 'Create team member' })).toBeEnabled();
      await page.goto('/dashboard');
      await page.goto('/dashboard/staff');
      await page.reload();
      await expect(form.getByLabel('Full name')).toHaveValue('Reload Recovery');
      await expect(form.getByLabel('Username', { exact: true })).toHaveValue(username);
      await expect(form.getByLabel('Temporary PIN', { exact: true })).toHaveValue('');
      const retained = await page.evaluate(() => Object.keys(sessionStorage)
        .filter(key => key.startsWith('lunchlineup:staff-create:')).map(key => sessionStorage.getItem(key)).join(''));
      expect(retained).not.toContain(pin);
      expect(retained).not.toContain('payloadFingerprint');
      await form.getByLabel('Temporary PIN', { exact: true }).fill(pin);
      await form.getByRole('button', { name: 'Create team member' }).click();
      await expect(page.getByRole('dialog', { name: 'Save temporary credentials' })).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      const directory = await reader.request.get('/api/v2/users');
      expect(directory.ok()).toBeTruthy();
      const matching = (await directory.json()).data.filter((user: { username: string }) => user.username === username);
      expect(matching).toHaveLength(1);
      expect(matching[0].id).toBe(createdId);
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('lunchlineup:staff-create:')))).toEqual([]);
    } finally {
      await independent.close();
    }
  });

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

  test('reconciles a lost profile response against the real committed backend state', async ({ page }, testInfo) => {
    const readbackContext = await page.context().browser()!.newContext({ baseURL: testInfo.project.use.baseURL });
    const readbackPage = await readbackContext.newPage();
    try {
    await loginAsSeedAdmin(readbackPage);
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
      const independentlySaved = await readbackPage.request.get(new URL(route.request().url()).pathname);
      expect(independentlySaved.ok()).toBeTruthy();
      const savedProfile = await independentlySaved.json();
      expect(savedProfile.skills).toContain('response recovery');
      expect(savedProfile.user.id).toBe((await committed.json()).user.id);
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
    } finally {
      await readbackContext.close();
    }
  });
});
