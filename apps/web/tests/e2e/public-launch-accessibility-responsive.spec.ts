import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  loginAsSeedAdmin,
  loginAsSeedSuperAdmin,
  repoRoot,
  runFullStack,
} from './support';

const axeSource = readFileSync(path.join(repoRoot, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const emptyPagination = {
  limit: 50,
  maxLimit: 200,
  returned: 0,
  hasMore: false,
  nextCursor: null,
};

type AxeViolation = {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: Array<{ target: string[] }>;
};

async function seriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & {
      axe: {
        run: (
          context: Document,
          options: Record<string, unknown>,
        ) => Promise<{ violations: AxeViolation[] }>;
      };
    }).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
    return result.violations;
  });

  return violations.filter((violation) => (
    violation.impact === 'serious' || violation.impact === 'critical'
  ));
}

async function expectDocumentToFitViewport(page: Page, route: string) {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    overflowing: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.right <= window.innerWidth + 0.5) return false;

        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body) {
          if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(ancestor).overflowX)) {
            return false;
          }
          ancestor = ancestor.parentElement;
        }
        return true;
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className,
        right: Math.ceil(element.getBoundingClientRect().right),
      })),
  }));

  expect(
    layout.document,
    `${route} document overflow: ${JSON.stringify(layout.overflowing)}`,
  ).toBeLessThanOrEqual(layout.viewport);
  expect(layout.body, `${route} body overflow`).toBeLessThanOrEqual(layout.viewport);
}

async function expectAccessibleRoute(page: Page, route: string) {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expectDocumentToFitViewport(page, route);
  const violations = await seriousAxeViolations(page);
  expect(violations, `${route}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function mockAdminReads(page: Page) {
  await page.route('**/api/v1/admin/stats', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ totalTenants: 1, totalUsers: 2, activeSessions: 1, solverQueue: 0 }),
  }));
  await page.route('**/api/v1/admin/audit?*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));
  await page.route('**/api/v1/admin/health', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      checkedAt: new Date().toISOString(),
      overall: 'online',
      components: [{ label: 'API', status: 'online', latencyMs: 8 }],
    }),
  }));
  await page.route('**/api/v1/admin/tenants?*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [], pagination: emptyPagination }),
  }));
  await page.route('**/api/v1/admin/users', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));
  await page.route('**/api/v1/admin/plans', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }));
  await page.route('**/api/v1/admin/credits?*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      tenants: [],
      history: [],
      tenantPagination: emptyPagination,
      historyPagination: emptyPagination,
    }),
  }));
}

test.describe('Bounded public launch accessibility and responsive gate', () => {
  test.skip(runFullStack, 'Mock browser accessibility coverage is separate from DB-backed workflows.');
  test.skip(!runMockReadiness, 'This browser gate requires the local mock API.');
  test.skip(({ browserName }) => browserName !== 'chromium', 'Runs on desktop and mobile Chromium projects.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok()).toBeTruthy();
  });

  for (const route of [
    '/',
    '/auth/login',
    '/auth/reset-password',
    '/privacy',
    '/terms',
    '/security',
    '/subprocessors',
    '/status',
  ]) {
    test(`${route} has no serious accessibility or viewport overflow blocker`, async ({ page }) => {
      await page.goto(route);
      await expectAccessibleRoute(page, route);
    });
  }

  for (const route of [
    '/dashboard',
    '/dashboard/staff',
    '/dashboard/scheduling',
    '/dashboard/lunch-breaks',
    '/dashboard/settings',
  ]) {
    test(`${route} keeps the authenticated workspace accessible and responsive`, async ({ page }) => {
      await loginAsSeedAdmin(page, route);
      await expect(page.getByLabel('Sidebar navigation')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
      await expectAccessibleRoute(page, route);
    });
  }

  for (const route of [
    '/admin',
    '/admin/tenants',
    '/admin/credits',
    '/admin/plans',
    '/admin/users',
  ]) {
    test(`${route} keeps platform administration accessible and responsive`, async ({ page }) => {
      await mockAdminReads(page);
      await loginAsSeedSuperAdmin(page, route);
      await expect(page.getByLabel('Admin sidebar')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign out' }).last()).toBeVisible();
      await expectAccessibleRoute(page, route);
    });
  }
});
