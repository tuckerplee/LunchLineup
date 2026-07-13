import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './support';

const axeSource = readFileSync(path.join(repoRoot, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

const PUBLIC_ROUTES = [
  { path: '/', heading: 'LunchLineup' },
  { path: '/status', heading: 'LunchLineup Status' },
  { path: '/privacy', heading: 'Privacy' },
  { path: '/terms', heading: 'Terms' },
  { path: '/security', heading: 'Security' },
  { path: '/subprocessors', heading: 'Subprocessors' },
  { path: '/auth/login', heading: 'Break-aware scheduling for modern teams.' },
  { path: '/onboarding', heading: 'Break-aware scheduling for modern teams.' },
];

type AxeViolation = {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: Array<{ target: string[] }>;
};

async function runAxeSmoke(page: Page): Promise<AxeViolation[]> {
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

  return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
}

test.describe('Public status page', () => {
  test('renders a public status surface with incident history and support path', async ({ page }) => {
    await page.goto('/status');

    await expect(page).toHaveTitle(/Status \| LunchLineup/);
    await expect(page.getByRole('link', { name: 'LunchLineup home' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('heading', { name: 'LunchLineup Status' })).toBeVisible();
    await expect(page.getByText('Operational').first()).toBeVisible();
    await expect(page.getByText(/Automated check .*UTC/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Automated Health', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Automated Health' }).getByText(/API (health passing|health degraded|reachable|health unavailable)/).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Automated dependency checks' }).getByText('Database')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Automated dependency checks' }).getByText('Redis')).toBeVisible();
    await expect(page.getByText('Automated server render')).toBeVisible();
    await expect(page.getByText('GET /health dependency report')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tracked Components' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Tracked service components' }).getByRole('listitem')).toHaveCount(6);
    await expect(page.getByRole('heading', { name: 'Incident History' })).toBeVisible();
    await expect(page.getByText('No active incidents', { exact: true })).toBeVisible();
    await expect(page.getByText('Active incidents').locator('..').getByText('0', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' }).last()).toHaveAttribute('href', '/auth/login');
  });

  test('supports keyboard navigation through the public status header', async ({ page }) => {
    await page.goto('/status');

    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'LunchLineup home' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Status' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Privacy' })).toBeFocused();
  });
});

test.describe('Public page accessibility smoke', () => {
  test('announces login errors as assertive alerts', async ({ page }) => {
    await page.goto('/auth/login?step=pin&error=invalid');

    const error = page.locator('.login-card__error[role="alert"]');
    await expect(error).toHaveText('Invalid username or PIN. Please try again.');
    await expect(error).toHaveAttribute('aria-live', 'assertive');
    await expect(error).toHaveAttribute('aria-atomic', 'true');
  });
  for (const route of PUBLIC_ROUTES) {
    test(`${route.path} has accessible landmarks and no serious axe violations`, async ({ page }) => {
      await page.goto(route.path);

      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible();

      const seriousViolations = await runAxeSmoke(page);
      expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
    });
  }
});
