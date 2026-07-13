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

  test('keeps every dashboard route within a 375px viewport with shell controls reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route('**/api/v1/users', async (route) => {
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

    for (const route of dashboardRoutes) {
      await page.goto(route);

      const shell = page.locator('.workspace-shell');
      const sidebar = page.getByLabel('Sidebar navigation');
      const settingsNav = sidebar.getByRole('link', { name: 'Settings', exact: true });

      await expect(shell, `${route} shell`).toBeVisible();
      await expect(sidebar, `${route} navigation`).toBeVisible();
      await expect(page.locator('.workspace-mobile-signout'), `${route} sign-out control`).toBeVisible();
      await expect(page.getByRole('button', { name: 'Notifications' }), `${route} notifications control`).toBeVisible();
      await expect(page.getByRole('link', { name: 'Account settings' }), `${route} account control`).toBeVisible();

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

      expect(widths.viewport, `${route} viewport width`).toBe(375);
      expect(widths.document, `${route} document overflow: ${JSON.stringify(widths.overflowing)}`).toBeLessThanOrEqual(widths.viewport);
      expect(widths.body, `${route} body overflow`).toBeLessThanOrEqual(widths.viewport);
      expect(widths.shell, `${route} shell width`).toBeLessThanOrEqual(widths.viewport);

      await settingsNav.scrollIntoViewIfNeeded();
      await expect(settingsNav, `${route} horizontally scrollable Settings navigation`).toBeInViewport();
    }
  });
});
