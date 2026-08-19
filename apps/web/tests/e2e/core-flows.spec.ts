import { expect, test, type Page } from '@playwright/test';

type FormSubmission = { url: string; body: string | null };

async function installTurnstileStub(page: Page) {
  await page.addInitScript(() => {
    const tokens = ['turnstile-send-token', 'turnstile-verify-token'];
    let nextTokenIndex = 0;
    let activeOptions: { callback?: (token: string) => void } | null = null;
    const testWindow = window as Window & {
      turnstile: {
        render: (container: Element, options: { callback: (token: string) => void }) => string;
        reset: () => void;
        remove: () => void;
      };
    };

    testWindow.turnstile = {
      render: (_container, options) => {
        activeOptions = options;
        window.setTimeout(() => options.callback(tokens[nextTokenIndex++] ?? 'turnstile-extra-token'), 0);
        return 'test-turnstile-widget';
      },
      reset: () => {
        window.setTimeout(() => activeOptions?.callback?.(tokens[nextTokenIndex++] ?? 'turnstile-reset-token'), 0);
      },
      remove: () => {
        activeOptions = null;
      },
    };
  });
}

async function acceptOnboardingLegalAssent(page: Page) {
  await page.getByRole('checkbox', { name: /I agree to the Terms/i }).check();
  await page.getByRole('checkbox', { name: /I acknowledge the Privacy notice/i }).check();
}

async function mockLoginResolve(page: Page, payload: Record<string, unknown>) {
  await page.route('**/api/v2/auth/login/resolve', async (route) => {
    const requestPayload = route.request().postDataJSON() as { tenantSlug?: string };
    expect(requestPayload.tenantSlug).toBe('e2e-operations');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, ...payload }),
    });
  });
}

test.describe('Public SaaS entrypoints', () => {
  test('root route renders public SaaS entrypoints', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'LunchLineup home' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('heading', { name: 'LunchLineup' })).toBeVisible();
    await expect(page.getByText('Workforce scheduling SaaS')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start with email verification' })).toHaveAttribute('href', '/onboarding');
    await expect(page.getByRole('link', { name: 'Open existing workspace' })).toHaveAttribute('href', '/auth/login');
    await expect(page.getByLabel('Schedule preview')).toContainText('Frontline schedule');
  });

  test('login page exposes identifier entry and links to onboarding', async ({ page }) => {
    await page.goto('/auth/login');

    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await expect(page.getByLabel('Workspace slug')).toBeVisible();
    await expect(page.getByLabel('Work email or username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Create your account/i })).toHaveAttribute('href', '/onboarding');
  });

  test('login page keeps unsafe next values on the safe dashboard fallback', async ({ page }) => {
    await page.goto('/auth/login?next=https%3A%2F%2Fevil.example');

    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
    await expect(page.getByPlaceholder('your-workspace')).toBeVisible();
    await expect(page.getByPlaceholder('name@company.com or username')).toBeVisible();
  });

  test('login resolves username PIN flow and posts only a safe redirect target', async ({ page }) => {
    let resolvePinSubmission!: (submission: FormSubmission) => void;
    const pinSubmissionPromise = new Promise<FormSubmission>((resolve) => {
      resolvePinSubmission = resolve;
    });

    await mockLoginResolve(page, {
      flow: 'PIN',
      identifier: 'e2e.admin',
      pinResetRequired: false,
    });
    await page.route('**/api/v2/auth/pin/verify**', async (route) => {
      resolvePinSubmission({
        url: route.request().url(),
        body: route.request().postData(),
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, redirectTo: '/status' }),
      });
    });

    await page.goto('/auth/login?next=https%3A%2F%2Fevil.example');
    await page.getByLabel('Workspace slug').fill('e2e-operations');
    await page.getByLabel('Work email or username').fill('E2E.Admin');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible();
    await page.getByLabel('PIN').fill('246810');

    await Promise.all([
      pinSubmissionPromise,
      page.getByRole('button', { name: 'Sign in with PIN' }).click(),
    ]);

    const pinSubmission = await pinSubmissionPromise;
    const submissionUrl = new URL(pinSubmission.url);
    const submissionBody = JSON.parse(pinSubmission.body ?? '{}') as Record<string, string>;
    expect(submissionUrl.searchParams.get('next')).toBe('/dashboard');
    expect(submissionUrl.searchParams.has('redirect')).toBe(false);
    expect(submissionBody.identifier).toBe('e2e.admin');
    expect(submissionBody.tenantSlug).toBe('e2e-operations');
    expect(submissionBody.pin).toBe('246810');
  });

  test('login resolves email OTP flow and submits the requested workspace redirect', async ({ page }) => {
    let sentOtpEmail: string | null = null;
    let resolveOtpSubmission!: (submission: FormSubmission) => void;
    const otpSubmissionPromise = new Promise<FormSubmission>((resolve) => {
      resolveOtpSubmission = resolve;
    });

    await mockLoginResolve(page, {
      flow: 'EMAIL_OTP',
      identifier: 'manager@example.com',
    });
    await page.route('**/api/v2/auth/email/send-otp', async (route) => {
      let payload: { email?: string; tenantSlug?: string } = {};
      try {
        payload = route.request().postDataJSON() as { email?: string; tenantSlug?: string };
      } catch {
        payload = {};
      }
      sentOtpEmail = payload.email ?? null;
      expect(payload.tenantSlug).toBe('e2e-operations');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });
    await page.route('**/api/v2/auth/email/verify-otp**', async (route) => {
      resolveOtpSubmission({
        url: route.request().url(),
        body: route.request().postData(),
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, redirectTo: '/status' }),
      });
    });

    await page.goto('/auth/login?next=/dashboard/scheduling');
    await page.getByLabel('Workspace slug').fill('e2e-operations');
    await page.getByLabel('Work email or username').fill('Manager@Example.com');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText('Enter the 6-digit code sent to manager@example.com.')).toBeVisible();
    expect(sentOtpEmail).toBe('manager@example.com');

    await page.getByLabel('Digit 1').fill('123456');
    await Promise.all([
      otpSubmissionPromise,
      page.getByRole('button', { name: 'Verify and continue' }).click(),
    ]);

    const otpSubmission = await otpSubmissionPromise;
    const submissionUrl = new URL(otpSubmission.url);
    const submissionBody = JSON.parse(otpSubmission.body ?? '{}') as Record<string, string>;
    expect(submissionUrl.searchParams.get('next')).toBe('/dashboard/scheduling');
    expect(submissionUrl.searchParams.has('redirect')).toBe(false);
    expect(submissionBody.email).toBe('manager@example.com');
    expect(submissionBody.tenantSlug).toBe('e2e-operations');
    expect(submissionBody.code).toBe('123456');
  });

  test('MFA page gives unauthenticated users a recovery path', async ({ page }) => {
    await page.goto('/mfa?next=%2Fdashboard%2Fstaff');

    await expect(page.getByRole('heading', { name: 'MFA setup needs help' })).toBeVisible();
    await expect(page.getByText('Your sign-in expired. Sign in again to continue.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Use a different account' })).toHaveAttribute('href', '/auth/login');
  });
});

test.describe('Onboarding smoke flow', () => {
  let sentOnboardingOtpPayload: Record<string, unknown> | null;

  test.beforeEach(async ({ page }) => {
    sentOnboardingOtpPayload = null;
    await page.route('**/api/v2/auth/email/send-otp', async (route) => {
      sentOnboardingOtpPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, onboardingChallengeToken: 'e2e-onboarding-challenge' }),
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
    await acceptOnboardingLegalAssent(page);

    await expect(page.getByRole('heading', { name: 'Verify and launch' })).toBeVisible();
    await expect(page.getByText(/Email:\s*manager@example\.com/)).toBeVisible();
    await expect(page.getByText('Test Diner Corp')).toBeVisible();
    await expect(page.getByText('Downtown Diner')).toBeVisible();
    await expect(page.getByPlaceholder('123456')).toBeVisible();
    await expect.poll(() => sentOnboardingOtpPayload).toMatchObject({
      email: 'manager@example.com',
      tenantName: 'Test Diner Corp',
      onboarding: true,
    });
  });

  test('defers first-location provisioning until required MFA is complete', async ({ page }) => {
    let locationCalls = 0;
    let locationPayload: Record<string, unknown> | null = null;
    await page.route('**/api/v2/auth/email/verify-otp**', async (route) => {
      expect(new URL(route.request().url()).searchParams.get('next')).toBe('/onboarding?resume=first-location');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          requiresMfa: true,
          workspaceSlug: 'test-diner-corp-a1b2c3',
          redirectTo: '/mfa?next=%2Fonboarding%3Fresume%3Dfirst-location',
        }),
      });
    });
    await page.route('**/api/v2/locations', async (route) => {
      locationCalls += 1;
      locationPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'loc-onboarding', name: 'Downtown Diner' }),
      });
    });

    await page.goto('/onboarding');
    await page.getByPlaceholder('name@company.com').fill('manager@example.com');
    await page.getByRole('button', { name: 'Continue setup' }).click();
    await page.getByPlaceholder('e.g. Harbor View Group').fill('Test Diner Corp');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByPlaceholder('e.g. Downtown Bistro').fill('Downtown Diner');
    await page.getByRole('button', { name: 'Continue' }).click();
    await acceptOnboardingLegalAssent(page);
    await page.getByPlaceholder('123456').fill('123456');
    await page.getByRole('button', { name: 'Verify code and launch' }).click();

    await expect(page).toHaveURL(/\/mfa\?next=/);
    expect(locationCalls).toBe(0);

    await page.goto('/onboarding?resume=first-location');
    await expect.poll(() => locationCalls).toBe(1);
    expect(locationPayload).toMatchObject({
      tenantName: 'Test Diner Corp',
      name: 'Downtown Diner',
    });
  });

  test('open signup with Turnstile sends challenge tokens with OTP requests', async ({ page }) => {
    test.skip(!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, 'requires NEXT_PUBLIC_TURNSTILE_SITE_KEY at build time');

    await installTurnstileStub(page);
    let resolveVerifyPayload!: (payload: Record<string, unknown>) => void;
    const verifyPayloadPromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveVerifyPayload = resolve;
    });

    await page.route('**/api/v2/auth/email/verify-otp**', async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      resolveVerifyPayload(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, workspaceSlug: 'test-diner-corp-a1b2c3' }),
      });
    });
    await page.route('**/api/v2/locations', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'loc-onboarding', name: 'Downtown Diner' }),
      });
    });

    await page.goto('/onboarding');
    await page.getByPlaceholder('name@company.com').fill('manager@example.com');
    await page.getByRole('button', { name: 'Continue setup' }).click();
    await page.getByPlaceholder('e.g. Harbor View Group').fill('Test Diner Corp');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByPlaceholder('e.g. Downtown Bistro').fill('Downtown Diner');
    await page.getByRole('button', { name: 'Continue' }).click();
    await acceptOnboardingLegalAssent(page);

    await expect(page.getByText('Signup security check')).toBeVisible();
    await expect.poll(() => sentOnboardingOtpPayload).toMatchObject({
      email: 'manager@example.com',
      tenantName: 'Test Diner Corp',
      onboarding: true,
      turnstileToken: 'turnstile-send-token',
    });

    const verifyButton = page.getByRole('button', { name: 'Verify code and launch' });
    await expect(verifyButton).toBeEnabled();
    await page.getByPlaceholder('123456').fill('123456');
    const [verifyPayload] = await Promise.all([
      verifyPayloadPromise,
      verifyButton.click(),
    ]);

    expect(verifyPayload).toMatchObject({
      email: 'manager@example.com',
      tenantName: 'Test Diner Corp',
      onboarding: true,
      onboardingChallengeToken: 'e2e-onboarding-challenge',
      code: '123456',
      turnstileToken: 'turnstile-verify-token',
    });
  });

  test('open signup blocks when the Turnstile script is unavailable', async ({ page }) => {
    test.skip(!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY, 'requires NEXT_PUBLIC_TURNSTILE_SITE_KEY at build time');

    await page.route('https://challenges.cloudflare.com/**', async (route) => {
      await route.abort();
    });

    await page.goto('/onboarding');
    await page.getByPlaceholder('name@company.com').fill('manager@example.com');
    await page.getByRole('button', { name: 'Continue setup' }).click();
    await page.getByPlaceholder('e.g. Harbor View Group').fill('Test Diner Corp');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByPlaceholder('e.g. Downtown Bistro').fill('Downtown Diner');
    await page.getByRole('button', { name: 'Continue' }).click();
    await acceptOnboardingLegalAssent(page);

    await expect(page.locator('.onb-challenge__hint', { hasText: 'Security check is unavailable. Refresh the page and try again.' })).toBeVisible({ timeout: 7000 });
    await expect(page.getByRole('button', { name: 'Verify code and launch' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Resend code' })).toBeDisabled();
    expect(sentOnboardingOtpPayload).toBeNull();
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

  test('redirects unauthenticated users from time cards to login', async ({ page }) => {
    await page.goto('/dashboard/time-cards');

    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
  });

  test('redirects unauthenticated users from admin to login', async ({ page }) => {
    await page.goto('/admin/tenants');

    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in to LunchLineup' })).toBeVisible();
  });
});
