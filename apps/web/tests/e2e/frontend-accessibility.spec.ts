import { expect, test } from '@playwright/test';

import { loginAsSeedAdmin } from './support';

test.describe.serial('Frontend accessibility launch contracts', () => {
  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok(), 'mock API reset returned ' + response.status()).toBeTruthy();
  });

  test('submits onboarding steps with Enter and focuses validation errors', async ({ page }) => {
    await page.goto('/onboarding');

    const email = page.getByLabel('Work email');
    await email.fill('invalid');
    await email.press('Enter');

    const alert = page.locator('.onb-card__error');
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toHaveAttribute('aria-live', 'assertive');
    await expect(alert).toHaveText('Please enter a valid email address.');
    await expect(alert).toBeFocused();

    await email.fill('owner@example.com');
    await email.press('Enter');
    await expect(page.getByRole('heading', { name: 'Name your organization' })).toBeVisible();

    const organization = page.getByLabel('Organization name');
    await organization.fill('Accessible Diner');
    await organization.press('Enter');
    await expect(page.getByRole('heading', { name: 'Add your first location' })).toBeVisible();

    const location = page.getByLabel('Location name');
    await location.fill('Main Street');
    await location.press('Enter');
    await expect(page.getByRole('heading', { name: 'Verify and launch' })).toBeVisible();
  });

  test('operates dashboard dialogs, settings tabs, pack labels, and mobile sign-out by keyboard', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/settings');
    await expect(page.getByLabel('Organization Name')).toHaveValue('E2E Operations Diner');

    const notificationsTrigger = page.getByRole('button', { name: 'Notifications' });
    await notificationsTrigger.click();
    const notificationsDialog = page.getByRole('dialog', { name: 'Notifications' });
    const closeNotifications = notificationsDialog.getByRole('button', { name: 'Close notifications' });
    await expect(closeNotifications).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => notificationsDialog.evaluate(
      (dialog) => dialog.contains(document.activeElement),
    )).toBe(true);

    await page.keyboard.press('Escape');
    await expect(notificationsDialog).toHaveCount(0);
    await expect(notificationsTrigger).toBeFocused();

    const generalTab = page.getByRole('tab', { name: 'General' });
    await generalTab.focus();
    await generalTab.press('ArrowRight');
    const teamTab = page.getByRole('tab', { name: 'Team' });
    await expect(teamTab).toBeFocused();
    await expect(teamTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#settings-panel-team')).toBeVisible();

    await teamTab.press('End');
    const accountTab = page.getByRole('tab', { name: 'Account' });
    await expect(accountTab).toBeFocused();
    await expect(accountTab).toHaveAttribute('aria-selected', 'true');

    await accountTab.press('Home');
    await expect(generalTab).toBeFocused();
    await expect(generalTab).toHaveAttribute('aria-selected', 'true');

    const billingTab = page.getByRole('tab', { name: 'Billing' });
    await billingTab.click();
    await expect(page.getByRole('button', { name: 'Purchase 100 credits' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Purchase 500 credits' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Purchase 2,000 credits' })).toBeVisible();

    await page.setViewportSize({ width: 375, height: 812 });
    const mobileSignOut = page.locator('.workspace-mobile-signout');
    await expect(mobileSignOut).toBeVisible();
    await expect(mobileSignOut).toHaveAccessibleName('Sign out');
    const box = await mobileSignOut.boundingBox();
    expect(box?.width).toBeCloseTo(32, 3);
    expect(box?.height).toBeCloseTo(32, 3);
    await expect(mobileSignOut).toHaveText('');
  });
});
