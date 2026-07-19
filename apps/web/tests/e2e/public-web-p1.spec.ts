import { expect, test, type Page, type Route } from '@playwright/test';
import { e2eAdminPin, e2eAdminUsername, e2eTenantSlug, loginAsSeedAdmin } from './support';

async function resetMockState(page: Page) {
  const response = await page.request.post('/api/v1/__e2e/reset');
  expect(response.ok()).toBe(true);
}

async function mockLoginResolve(page: Page, flow: 'PIN' | 'USERNAME_PASSWORD' | 'EMAIL_OTP', identifier: string) {
  await page.route('**/api/v2/auth/login/resolve', async (route) => {
    const payload = route.request().postDataJSON() as { identifier?: string; tenantSlug?: string };
    expect(payload.tenantSlug).toBe(e2eTenantSlug);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, flow, identifier, pinResetRequired: false }),
    });
  });
}

async function fulfillRejectedThenSuccess(route: Route, attempt: number, redirectTo: string) {
  const contentType = route.request().headers()['content-type'] ?? '';
  expect(contentType).toContain('application/json');
  expect(new URL(route.request().url()).searchParams.has('redirect')).toBe(false);
  await route.fulfill({
    status: attempt === 1 ? 401 : 200,
    contentType: 'application/json',
    body: JSON.stringify(attempt === 1
      ? { success: false, message: 'Rejected once. Try again.' }
      : { success: true, redirectTo }),
  });
}

async function expectBrandedFallbackBeforeHydration(page: Page, path: string, loadingText: string) {
  let releaseScripts = () => undefined;
  const scriptGate = new Promise<void>((resolve) => {
    releaseScripts = resolve;
  });
  const scriptPattern = /\/_next\/static\/.*\.js(?:\?|$)/;
  await page.route(scriptPattern, async (route) => {
    await Promise.race([
      scriptGate,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    await route.continue();
  });

  try {
    await page.goto(path, { waitUntil: 'commit' });
    const status = page.getByRole('status');
    await expect(status).toContainText('LunchLineup');
    await expect(status).toContainText(loadingText);
  } finally {
    releaseScripts();
  }
  await page.waitForLoadState('domcontentloaded');
  await page.unroute(scriptPattern);
}

test.describe('validated public-web P1 regressions', () => {
  test.beforeEach(async ({ page }) => {
    await resetMockState(page);
  });

  test('PIN rejection keeps the step, identifier, secret, and safe next before retry succeeds', async ({ page }) => {
    const redirectTo = '/status?source=pin';
    let attempts = 0;
    await mockLoginResolve(page, 'PIN', e2eAdminUsername);
    await page.route('**/api/v2/auth/pin/verify**', async (route) => {
      attempts += 1;
      const payload = route.request().postDataJSON() as Record<string, string>;
      expect(payload).toMatchObject({ identifier: e2eAdminUsername, tenantSlug: e2eTenantSlug, pin: e2eAdminPin });
      await fulfillRejectedThenSuccess(route, attempts, redirectTo);
    });

    await page.goto(`/auth/login?tenantSlug=${e2eTenantSlug}&next=${encodeURIComponent(redirectTo)}`);
    await page.getByLabel('Work email or username').fill(e2eAdminUsername);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('PIN').fill(e2eAdminPin);
    await page.getByRole('button', { name: 'Sign in with PIN' }).click();

    await expect(page.locator('.login-card__error[role="alert"]')).toHaveText('Rejected once. Try again.');
    await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
    await expect(page.getByText(`Sign in as ${e2eAdminUsername}.`)).toBeVisible();
    await expect(page.getByLabel('PIN')).toHaveValue(e2eAdminPin);
    expect(new URL(page.url()).searchParams.get('next')).toBe(redirectTo);

    await page.getByRole('button', { name: 'Sign in with PIN' }).click();
    await expect(page).toHaveURL(new RegExp('/status\\?source=pin$'));
    expect(attempts).toBe(2);
  });

  test('password rejection keeps the step, identifier, secret, and safe next before retry succeeds', async ({ page }) => {
    const redirectTo = '/status?source=password';
    const password = 'migrated-password';
    let attempts = 0;
    await mockLoginResolve(page, 'USERNAME_PASSWORD', e2eAdminUsername);
    await page.route('**/api/v2/auth/password/verify**', async (route) => {
      attempts += 1;
      const payload = route.request().postDataJSON() as Record<string, string>;
      expect(payload).toMatchObject({ identifier: e2eAdminUsername, tenantSlug: e2eTenantSlug, password });
      await fulfillRejectedThenSuccess(route, attempts, redirectTo);
    });

    await page.goto(`/auth/login?tenantSlug=${e2eTenantSlug}&next=${encodeURIComponent(redirectTo)}`);
    await page.getByLabel('Work email or username').fill(e2eAdminUsername);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in with password' }).click();

    await expect(page.locator('.login-card__error[role="alert"]')).toHaveText('Rejected once. Try again.');
    await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible();
    await expect(page.getByText(`Sign in as ${e2eAdminUsername}.`)).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveValue(password);
    expect(new URL(page.url()).searchParams.get('next')).toBe(redirectTo);

    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page).toHaveURL(new RegExp('/status\\?source=password$'));
    expect(attempts).toBe(2);
  });

  test('explicit email-password login is absent outside the beta domain', async ({ page }) => {
    await page.goto(`/auth/login?tenantSlug=${e2eTenantSlug}`);
    await expect(page.getByRole('button', { name: 'Sign in with password' })).toHaveCount(0);

    await page.goto(`/auth/login?tenantSlug=${e2eTenantSlug}&identifier=${encodeURIComponent('demo@demo.com')}&step=password`);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
  });

  test('OTP rejection keeps the step, identifier, code, and safe next before retry succeeds', async ({ page }) => {
    const redirectTo = '/status?source=otp';
    const email = 'manager@example.com';
    let attempts = 0;
    await mockLoginResolve(page, 'EMAIL_OTP', email);
    await page.route('**/api/v2/auth/email/verify-otp**', async (route) => {
      attempts += 1;
      const payload = route.request().postDataJSON() as Record<string, string>;
      expect(payload).toMatchObject({ email, tenantSlug: e2eTenantSlug, code: '123456' });
      await fulfillRejectedThenSuccess(route, attempts, redirectTo);
    });

    await page.goto(`/auth/login?tenantSlug=${e2eTenantSlug}&next=${encodeURIComponent(redirectTo)}`);
    await page.getByLabel('Work email or username').fill(email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Digit 1').fill('123456');
    await page.getByRole('button', { name: 'Verify and continue' }).click();

    await expect(page.locator('.login-card__error[role="alert"]')).toHaveText('Rejected once. Try again.');
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(`Enter the 6-digit code sent to ${email}.`)).toBeVisible();
    await expect(page.getByLabel('Digit 1')).toHaveValue('1');
    expect(new URL(page.url()).searchParams.get('next')).toBe(redirectTo);

    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(page).toHaveURL(new RegExp('/status\\?source=otp$'));
    expect(attempts).toBe(2);
  });

  test('reset token is absent from URL, history, cookies, and Referer while retryable failures preserve the form', async ({ page }) => {
    const token = 'reset-token-for-e2e';
    const seenReferrers: Array<string | undefined> = [];
    let attempts = 0;
    await page.route('**/api/v2/auth/password/reset/confirm', async (route) => {
      attempts += 1;
      seenReferrers.push(route.request().headers().referer);
      expect(route.request().postDataJSON()).toEqual({ token, password: 'new-password-123' });
      const status = attempts === 1 ? 429 : attempts === 2 ? 503 : 200;
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(status === 200 ? { success: true } : { message: 'Rejected' }),
      });
    });

    await page.goto('/privacy');
    const response = await page.goto(`/auth/reset-password?token=${encodeURIComponent(token)}`);
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page).toHaveURL(/\/auth\/reset-password$/);
    await expect(page.getByRole('heading', { name: 'Set new password' })).toBeVisible();
    expect(page.url()).not.toContain(token);
    expect((await page.context().cookies()).some((cookie) => cookie.name === 'll_password_reset_token')).toBe(false);

    await page.getByRole('textbox', { name: 'New password', exact: true }).fill('new-password-123');
    await page.getByRole('textbox', { name: 'Confirm password', exact: true }).fill('new-password-123');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('.reset-error[role="alert"]')).toHaveText('Too many reset attempts. Wait a moment, then try again.');
    await expect(page.getByRole('textbox', { name: 'New password', exact: true })).toHaveValue('new-password-123');

    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.locator('.reset-error[role="alert"]')).toHaveText('Password reset is temporarily unavailable. Please try again.');
    await expect(page.getByRole('textbox', { name: 'Confirm password', exact: true })).toHaveValue('new-password-123');

    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('status')).toHaveText('Password updated. Sign in with your new password.');
    expect(seenReferrers).toEqual([undefined, undefined, undefined]);

    let loginReferer: string | undefined;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/auth/login') loginReferer = request.headers().referer;
    });
    await page.getByRole('link', { name: 'Back to sign in' }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);
    expect(loginReferer).toBeUndefined();
    await page.goBack();
    await expect(page).toHaveURL(/\/auth\/reset-password$/);
    expect(page.url()).not.toContain(token);
  });

  test('unknown paths reach the Next.js 404 instead of the login proxy', async ({ page }) => {
    const response = await page.goto('/definitely-not-a-lunchlineup-route');

    expect(response?.status()).toBe(404);
    await expect(page).toHaveURL(/\/definitely-not-a-lunchlineup-route$/);
    await expect(page).not.toHaveURL(/\/auth\/login/);
  });

  test('login and MFA expose branded status content before delayed hydration', async ({ page }) => {
    await expectBrandedFallbackBeforeHydration(page, '/auth/login?next=%2Fdashboard', 'Loading secure sign-in...');
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();

    await expectBrandedFallbackBeforeHydration(page, '/mfa?next=%2Fdashboard', 'Loading secure verification...');
    await expect(page.getByRole('heading', { name: 'MFA setup needs help' })).toBeVisible();
  });

  test('mock login boots the dashboard without runtime loader errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await loginAsSeedAdmin(page, '/dashboard');
    await expect(page.getByRole('heading', { name: 'Welcome back, E2E' })).toBeVisible();
    await expect(page.locator('article').filter({ hasText: 'Locations online' })).toContainText('1');
    expect(pageErrors).toEqual([]);
  });

  test('dashboard endpoint failure marks only affected widgets unavailable with retry', async ({ page }) => {
    await page.route('**/api/v2/shifts?**', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable' }) });
    });

    await loginAsSeedAdmin(page, '/dashboard');
    const coverageCard = page.locator('article').filter({ hasText: "This week's coverage" });
    const locationsCard = page.locator('article').filter({ hasText: 'Locations online' });
    const openShiftWidget = page.locator('article').filter({ hasText: 'Open shift coverage' });

    await expect(coverageCard).toContainText('Unavailable');
    await expect(coverageCard.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(openShiftWidget).toContainText('Open shift data is unavailable.');
    await expect(openShiftWidget).not.toContainText('0 shifts');
    await expect(locationsCard).toContainText('1');
    await expect(locationsCard).not.toContainText('Unavailable');
  });
});
