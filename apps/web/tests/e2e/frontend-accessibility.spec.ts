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

  test('operates dashboard dialogs, settings tabs, pack labels, and mobile sign-out by keyboard', async ({ page }, testInfo) => {
    const notifications = Array.from({ length: 20 }, (_, index) => ({
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      type: 'INFO', title: `Notification ${index + 1}`,
      body: 'Long notification detail ' + 'unbroken'.repeat(24),
      readAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }));
    await page.route('**/api/v2/notifications?*', route => route.fulfill({
      json: { data: notifications, unreadCount: notifications.length },
    }));
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

    // Exercise the actual filtered topbar, account button and long feed together.
    for (const width of [320, 393, 1280]) {
      await page.setViewportSize({ width, height: 740 });
      await notificationsTrigger.press('Enter');
      await expect(closeNotifications).toBeFocused();
      await expect(notificationsDialog.getByRole('button', { name: /^Notification 20 / })).toHaveCount(1);
      const bounds = await notificationsDialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(12);
      expect(bounds!.y).toBeGreaterThanOrEqual(12);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 12);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740 - 12);
      expect(await notificationsDialog.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
      // Reverse tab reaches the last feed action and scrolls it into view;
      // the close/read-all header remains available above the scrolling feed.
      await page.keyboard.press('Shift+Tab');
      const lastNotification = notificationsDialog.getByRole('button', { name: /^Notification 20 / });
      await expect(lastNotification).toBeFocused();
      await expect(lastNotification).toBeInViewport();
      await expect(closeNotifications).toBeInViewport();
      await expect(notificationsDialog.getByRole('button', { name: 'Mark all read' })).toBeInViewport();
      await page.keyboard.press('Tab');
      await expect(closeNotifications).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`notifications-${width}px.png`) });
      await page.keyboard.press('Escape');
      await expect(notificationsDialog).toHaveCount(0);
      await expect(notificationsTrigger).toBeFocused();
    }

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
    expect(box?.width).toBeCloseTo(44, 3);
    expect(box?.height).toBeCloseTo(44, 3);
    await expect(mobileSignOut).toHaveText('');
  });
});
