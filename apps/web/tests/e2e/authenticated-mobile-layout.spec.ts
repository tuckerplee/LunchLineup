import { expect, test } from '@playwright/test';

import { loginAsSeedAdmin, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;

const dashboardRoutes = [
  '/dashboard',
  '/dashboard/scheduling',
  '/dashboard/lunch-breaks',
  '/dashboard/time-cards',
  '/dashboard/staff',
  '/dashboard/locations',
  '/dashboard/settings',
] as const;

test.describe('Authenticated mobile dashboard layout', () => {
  test.skip(runFullStack, 'Full-stack responsive coverage runs separately from the mock readiness layer.');
  test.skip(!runMockReadiness, 'Mobile layout readiness requires Playwright to start the local mock API.');
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'chromium' || isMobile,
    'Runs once in desktop Chromium with an explicit mobile-sized CSS viewport.',
  );

  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 900 }]) {
  test(`keeps the permission-aware manager shell reachable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/v2/users', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'user-mock-staff',
              name: 'Mock Staff',
              username: 'mock.staff',
              role: 'STAFF',
              assignedRoles: [],
            },
          ],
        }),
      });
    });
    await loginAsSeedAdmin(page, dashboardRoutes[0]);

    for (const [routeIndex, route] of dashboardRoutes.entries()) {
      await page.goto(route);

      const shell = page.locator('.workspace-shell');
      const sidebar = page.getByLabel('Sidebar navigation');
      const mobileNav = page.getByRole('navigation', { name: 'Mobile primary navigation' });
      const moreButton = mobileNav.getByRole('button', { name: 'More', exact: true });

      await expect(shell, `${route} shell`).toBeVisible();
      await expect(sidebar, `${route} navigation`).toBeVisible();
      await expect(mobileNav, `${route} mobile primary navigation`).toBeVisible();
      for (const label of ['Home', 'Schedule', 'Breaks', 'Team']) {
        await expect(mobileNav.getByRole('link', { name: label, exact: true }), `${route} ${label} destination`).toBeVisible();
      }
      await expect(moreButton, `${route} More destination`).toBeVisible();
      await expect(page.locator('.workspace-mobile-signout'), `${route} sign-out control`).toBeVisible();
      await expect(page.getByRole('button', { name: 'Notifications' }), `${route} notifications control`).toBeVisible();
      await expect(page.getByRole('link', { name: 'Account settings' }), `${route} account control`).toBeVisible();

      if (routeIndex === 0) {
        await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
        await expect(page.getByRole('link', { name: /Review time cards/ })).toHaveAttribute('href', '/dashboard/time-cards');
        await expect(page.getByRole('link', { name: /Prepare payroll/ })).toHaveAttribute('href', '/dashboard/payroll');

        await moreButton.click();
        const moreMenu = page.getByRole('menu', { name: 'More workspace destinations' });
        await expect(moreMenu).toBeVisible();
        await expect(moreMenu.getByRole('menuitem', { name: 'Settings', exact: true })).toBeInViewport();

        await moreMenu.getByRole('menuitem', { name: 'Settings', exact: true }).focus();
        await page.keyboard.press('Escape');
        await expect(moreMenu).toBeHidden();
        await expect(moreButton).toBeFocused();

        await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: 'Time Cards', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(moreButton).toBeFocused();
      }

      const widths = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        shell: Math.ceil(document.querySelector('.workspace-shell')?.getBoundingClientRect().width ?? 0),
        overflowing: Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.right <= window.innerWidth + 0.5) return false;

            let ancestor = element.parentElement;
            while (ancestor && ancestor !== document.body) {
              if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(ancestor).overflowX)) return false;
              ancestor = ancestor.parentElement;
            }
            return true;
          })
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            className: element.className,
            right: Math.ceil(element.getBoundingClientRect().right),
            scrollWidth: element.scrollWidth,
          })),
      }));

      expect(widths.viewport, `${route} viewport width`).toBe(viewport.width);
      expect(widths.document, `${route} document overflow: ${JSON.stringify(widths.overflowing)}`).toBeLessThanOrEqual(widths.viewport);
      expect(widths.body, `${route} body overflow`).toBeLessThanOrEqual(widths.viewport);
      expect(widths.shell, `${route} shell width`).toBeLessThanOrEqual(widths.viewport);
    }
  });
  }
});
