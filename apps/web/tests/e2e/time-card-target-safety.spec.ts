import { expect, test, type Page, type Request } from '@playwright/test';

import { loginAsSeedAdmin, runFullStack } from './support';

const runMockTimeCardSafety = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;

function clockInWrites(page: Page): Array<Record<string, unknown>> {
  const writes: Array<Record<string, unknown>> = [];
  page.on('request', (request: Request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/v2/time-cards/clock-in')) return;
    writes.push(request.postDataJSON() as Record<string, unknown>);
  });
  return writes;
}

test.describe('Time Card target safety', () => {
  test.skip(runFullStack, 'The focused target-safety proof uses the resettable local mock API.');
  test.skip(!runMockTimeCardSafety, 'The focused target-safety proof runs with the local mock API.');
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Run once on desktop Chromium.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok(), `mock API reset returned ${response.status()}`).toBeTruthy();
  });

  test('keeps My Time bound to the session user and sends no delegated user id', async ({ page }) => {
    const writes = clockInWrites(page);
    await loginAsSeedAdmin(page, '/dashboard/time-cards');

    await expect(page.getByRole('button', { name: 'My Time' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('time-card-selected-person')).toContainText('You - signed-in account');
    await expect(page.getByLabel('Team member')).toHaveCount(0);

    const blockedClockIn = page.getByRole('button', { name: 'Select a location for yourself' });
    await expect(blockedClockIn).toBeDisabled();
    expect(writes).toHaveLength(0);

    await page.getByLabel('My location').selectOption({ label: 'Downtown Diner' });
    await page.getByRole('button', { name: 'Clock in yourself at Downtown Diner' }).click();

    await expect(page.getByText('Your clock-in was recorded at Downtown Diner.')).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ locationId: expect.any(String) });
    expect(writes[0]).not.toHaveProperty('userId');

    await page.getByLabel('Break minutes').fill('0');
    await page.getByRole('button', { name: 'Clock out yourself from Downtown Diner' }).click();
    await expect(page.getByText('Your clock-out was recorded from Downtown Diner.')).toBeVisible();
  });

  test('requires an explicit Team Time person and location and clears person-specific drafts', async ({ page }) => {
    const writes = clockInWrites(page);
    await loginAsSeedAdmin(page, '/dashboard/time-cards');
    await page.getByRole('button', { name: 'Team Time' }).click();

    await expect(page.getByTestId('time-card-selected-person')).toContainText('No team member selected');
    await expect(page.getByLabel('Team member')).toHaveValue('');
    await expect(page.getByLabel('Team location')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Select a team member and location' })).toBeDisabled();
    expect(writes).toHaveLength(0);

    await page.getByLabel('Team member').selectOption({ label: 'Mock Staff' });
    await expect(page.getByTestId('time-card-selected-person')).toContainText('Mock Staff');
    await expect(page.getByRole('button', { name: 'Select a location for Mock Staff' })).toBeDisabled();
    expect(writes).toHaveLength(0);

    await page.getByLabel('Notes').fill('clear this location draft');
    await page.getByLabel('Team location').selectOption({ label: 'Downtown Diner' });
    await expect(page.getByLabel('Notes')).toHaveValue('');
    expect(writes).toHaveLength(0);

    await page.getByRole('button', { name: 'Clock in Mock Staff at Downtown Diner' }).click();
    await expect(page.getByText('Mock Staff was clocked in at Downtown Diner.')).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ userId: expect.any(String), locationId: expect.any(String) });

    await page.getByLabel('Break minutes').fill('0');
    await page.getByRole('button', { name: 'Clock out Mock Staff from Downtown Diner' }).click();
    await expect(page.getByText('Mock Staff was clocked out from Downtown Diner.')).toBeVisible();

    await page.getByRole('button', { name: 'Clock in Mock Staff at Downtown Diner' }).click();
    await page.getByLabel('Break minutes').fill('7');
    await page.getByLabel('Notes').fill('Mock Staff only');
    await page.getByRole('button', { name: /Correct time card for Mock Staff/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Correct Mock Staff time card' })).toBeVisible();
    await page.getByLabel('Correction reason').fill('Reviewing the prior punch');

    await page.getByLabel('Team member').selectOption({ label: 'Mock Manager' });
    await expect(page.getByTestId('time-card-selected-person')).toContainText('Mock Manager');
    await expect(page.getByLabel('Team location')).toHaveValue('');
    await expect(page.getByLabel('Notes')).toHaveValue('');
    await expect(page.getByLabel('Break minutes')).toHaveValue('30');
    await expect(page.getByRole('heading', { name: 'Correct Mock Staff time card' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select a location for Mock Manager' })).toBeDisabled();
    expect(writes).toHaveLength(2);
  });
});
