import { expect, test } from '@playwright/test';

test.describe('Public SaaS entrypoints', () => {
  test('landing page exposes brand, product promise, and primary routes', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: /LunchLineup home/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /lunch/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Sign in/i }).first()).toHaveAttribute('href', '/auth/login');
    await expect(page.getByRole('link', { name: /View scheduler/i })).toHaveAttribute('href', '/dashboard/scheduling');
  });

  test('login page exposes identifier entry and links to onboarding', async ({ page }) => {
    await page.goto('/auth/login');

    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await expect(page.getByLabel('Work email or username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Create your account/i })).toHaveAttribute('href', '/onboarding');
  });

  test('login page keeps unsafe next values on the safe dashboard fallback', async ({ page }) => {
    await page.goto('/auth/login?next=https%3A%2F%2Fevil.example');

    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await expect(page.getByPlaceholder('name@company.com or username')).toBeVisible();
  });
});

test.describe('Onboarding smoke flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/auth/email/send-otp', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });
  });

  test('validates the first step before account setup can continue', async ({ page }) => {
    await page.goto('/onboarding');

    await page.getByRole('button', { name: 'Continue setup' }).click();
    await expect(page.getByText('Please enter a valid email address.')).toBeVisible();
  });

  test('collects account, organization, location, and verification details', async ({ page }) => {
    await page.goto('/onboarding');

    await page.getByPlaceholder('name@company.com').fill('manager@example.com');
    await page.getByRole('button', { name: 'Continue setup' }).click();
    await expect(page.getByRole('heading', { name: 'Name your organization' })).toBeVisible();

    await page.getByPlaceholder('e.g. Harbor View Group').fill('Test Diner Corp');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Add your first location' })).toBeVisible();

    await page.getByPlaceholder('e.g. Downtown Bistro').fill('Downtown Diner');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Verify and launch' })).toBeVisible();
    await expect(page.getByText(/Email:\s*manager@example\.com/)).toBeVisible();
    await expect(page.getByText('Test Diner Corp')).toBeVisible();
    await expect(page.getByText('Downtown Diner')).toBeVisible();
    await expect(page.getByPlaceholder('123456')).toBeVisible();
  });
});

test.describe('Protected route smoke checks', () => {
  test('redirects unauthenticated users from dashboard overview to login', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
  });

  test('redirects unauthenticated users from scheduler to login', async ({ page }) => {
    await page.goto('/dashboard/scheduling');

    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
  });
});
