import { expect, test, type Page } from '@playwright/test';

import {
  PENDING_FIRST_LOCATION_KEY,
  PENDING_FIRST_LOCATION_MAX_AGE_MS,
} from '../../app/onboarding/first-location-recovery';

const WORKSPACE_SLUG = 'test-diner-corp-a1b2c3';

async function fillAndVerifyOnboarding(page: Page) {
  await page.goto('/onboarding');
  await page.getByPlaceholder('name@company.com').fill('manager@example.com');
  await page.getByRole('button', { name: 'Continue setup' }).click();
  await page.getByPlaceholder('e.g. Harbor View Group').fill('Test Diner Corp');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('e.g. Downtown Bistro').fill('Downtown Diner');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('checkbox', { name: /I agree to the Terms/i }).check();
  await page.getByRole('checkbox', { name: /I acknowledge the Privacy notice/i }).check();
  await page.getByPlaceholder('123456').fill('123456');
  await page.getByRole('button', { name: 'Verify code and launch' }).click();
}

async function expectRecoverableFailure(page: Page) {
  await expect(page).toHaveURL(/\/onboarding\?resume=first-location$/);
  await expect(page.getByRole('heading', { name: 'Finish setting up your workspace' })).toBeVisible();
  await expect(page.getByText('Location service is temporarily unavailable.')).toBeVisible();
  await expect(page.getByText(WORKSPACE_SLUG, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry creating location' })).toBeEnabled();

  const rawRecoveryState = await page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_FIRST_LOCATION_KEY);
  expect(rawRecoveryState).not.toBeNull();
  expect(rawRecoveryState).not.toContain('123456');
  expect(rawRecoveryState).not.toMatch(/otp|token|session/i);

  const recoveryState = JSON.parse(rawRecoveryState ?? '{}') as Record<string, unknown>;
  expect(Object.keys(recoveryState).sort()).toEqual([
    'createdAt',
    'firstLocationName',
    'requestKey',
    'tenantName',
    'timezone',
    'workspaceSlug',
  ]);
  expect(recoveryState).toMatchObject({
    requestKey: expect.any(String),
    workspaceSlug: WORKSPACE_SLUG,
    tenantName: 'Test Diner Corp',
    firstLocationName: 'Downtown Diner',
  });
}

async function expectRetrySuccess(page: Page) {
  await page.getByRole('button', { name: 'Retry creating location' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace ready' })).toBeVisible();
  await expect(page.getByText(WORKSPACE_SLUG, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_FIRST_LOCATION_KEY)).toBeNull();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('lunchlineup:last-workspace-slug'))).toBe(WORKSPACE_SLUG);
}

test.describe('Onboarding first-location recovery', () => {
  let verificationCalls: number;
  let locationCalls: number;

  test.beforeEach(async ({ page }) => {
    verificationCalls = 0;
    locationCalls = 0;

    await page.route('**/api/v1/auth/email/send-otp', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, onboardingChallengeToken: 'e2e-onboarding-challenge' }),
      });
    });
    await page.route('**/api/v1/locations', async (route) => {
      locationCalls += 1;
      await route.fulfill({
        status: locationCalls === 1 ? 503 : 201,
        contentType: 'application/json',
        body: JSON.stringify(locationCalls === 1
          ? { message: 'Location service is temporarily unavailable.' }
          : { id: 'loc-onboarding', name: 'Downtown Diner' }),
      });
    });
  });

  test('retries a non-MFA 503 without resubmitting the single-use OTP', async ({ page }) => {
    await page.route('**/api/v1/auth/email/verify-otp**', async (route) => {
      verificationCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, workspaceSlug: WORKSPACE_SLUG }),
      });
    });

    await fillAndVerifyOnboarding(page);
    await expectRecoverableFailure(page);
    expect(verificationCalls).toBe(1);
    expect(locationCalls).toBe(1);

    await expectRetrySuccess(page);
    expect(verificationCalls).toBe(1);
    expect(locationCalls).toBe(2);
  });

  test('reuses the first-location idempotency key after a successful create response is lost', async ({ page }) => {
    const requestKeys: string[] = [];
    let durableLocationCreated = false;
    await page.unroute('**/api/v1/locations');
    await page.route('**/api/v1/locations', async (route) => {
      requestKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (!durableLocationCreated) {
        durableLocationCreated = true;
        await route.abort('connectionfailed');
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'loc-onboarding', name: 'Downtown Diner' }),
      });
    });
    await page.route('**/api/v1/auth/email/verify-otp**', async (route) => {
      verificationCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, workspaceSlug: WORKSPACE_SLUG }),
      });
    });

    await fillAndVerifyOnboarding(page);
    await expect(page.getByRole('heading', { name: 'Finish setting up your workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry creating location' }).click();

    await expect(page.getByRole('heading', { name: 'Workspace ready' })).toBeVisible();
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(verificationCalls).toBe(1);
  });

  test('retries a post-MFA 503 from persisted state without resubmitting the OTP', async ({ page }) => {
    await page.route('**/api/v1/auth/email/verify-otp**', async (route) => {
      verificationCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          requiresMfa: true,
          workspaceSlug: WORKSPACE_SLUG,
          redirectTo: '/mfa?next=%2Fonboarding%3Fresume%3Dfirst-location',
        }),
      });
    });

    await fillAndVerifyOnboarding(page);
    await expect(page).toHaveURL(/\/mfa\?next=/);
    expect(locationCalls).toBe(0);

    await page.goto('/onboarding?resume=first-location');
    await expectRecoverableFailure(page);
    expect(verificationCalls).toBe(1);
    expect(locationCalls).toBe(1);

    await expectRetrySuccess(page);
    expect(verificationCalls).toBe(1);
    expect(locationCalls).toBe(2);
  });

  test('clears an expired recovery record without attempting location creation', async ({ page }) => {
    await page.addInitScript(({ key, createdAt }) => {
      window.sessionStorage.setItem(key, JSON.stringify({
        requestKey: 'expired-first-location-request',
        workspaceSlug: 'expired-workspace',
        tenantName: 'Expired Corp',
        firstLocationName: 'Expired Location',
        timezone: 'America/Los_Angeles',
        createdAt,
      }));
    }, {
      key: PENDING_FIRST_LOCATION_KEY,
      createdAt: Date.now() - PENDING_FIRST_LOCATION_MAX_AGE_MS - 1,
    });

    await page.goto('/onboarding?resume=first-location');

    await expect(page.getByText('Workspace setup expired. Restart onboarding to create the first location.')).toBeVisible();
    await expect.poll(() => page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_FIRST_LOCATION_KEY)).toBeNull();
    expect(verificationCalls).toBe(0);
    expect(locationCalls).toBe(0);
  });
});
