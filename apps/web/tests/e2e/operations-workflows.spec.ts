import { expect, test } from '@playwright/test';

import { dayWindow, loginAsSeedAdmin, runFullStack, seedTenant } from './support';

async function inviteStaff(page: import('@playwright/test').Page, name: string, username: string, role: 'Manager' | 'Staff') {
  await page.getByPlaceholder('Full name').fill(name);
  await page.getByPlaceholder('username (lowercase)').fill(username);
  await page.getByPlaceholder('PIN (optional)').fill('135790');
  await page.locator('select').nth(1).selectOption({ label: role });
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function shiftOwner(page: import('@playwright/test').Page): Promise<string | null> {
  const { startDate, endDate } = dayWindow();
  const response = await page.request.get(`/api/v1/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { data?: Array<{ user?: { name?: string } | null }> };
  return payload.data?.[0]?.user?.name ?? null;
}

test.describe.serial('Full-stack operations workflows', () => {
  test.skip(!runFullStack, 'Set E2E_FULL_STACK=1 and E2E_SEED_COMMAND to run DB-backed workflow E2E.');

  test.beforeAll(() => {
    seedTenant();
  });

  test('adds employees, creates a schedule shift, reassigns by drag/drop, generates lunches/breaks, and runs time cards', async ({ page }) => {
    await loginAsSeedAdmin(page);

    await expect(page.getByRole('heading', { name: 'Staff & Access' })).toBeVisible();
    await inviteStaff(page, 'Jordan Shift', 'jordan.shift', 'Staff');
    await inviteStaff(page, 'Casey Manager', 'casey.manager', 'Manager');

    await page.getByRole('link', { name: /Calendar/ }).click();
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    await page.getByRole('button', { name: /Add shift/ }).click();

    const shiftForm = page.locator('form.shift-form');
    await expect(shiftForm).toBeVisible();
    await shiftForm.locator('select').first().selectOption({ label: 'Jordan Shift' });
    await shiftForm.locator('input[type="time"]').first().fill('10:00');
    await shiftForm.locator('input[type="time"]').nth(1).fill('18:00');
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();

    const shiftBlock = page.locator('.shift-block').filter({ hasText: '10:00-18:00' }).first();
    await expect(shiftBlock).toBeVisible();
    await expect.poll(() => shiftOwner(page)).toBe('Jordan Shift');

    const sourceBox = await shiftBlock.boundingBox();
    const targetBox = await page.locator('.timeline-row[data-resource-title="Casey Manager"]').boundingBox();
    expect(sourceBox).toBeTruthy();
    expect(targetBox).toBeTruthy();
    if (!sourceBox || !targetBox) return;

    const sourceX = sourceBox.x + sourceBox.width / 2;
    await page.mouse.move(sourceX, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceX, targetBox.y + targetBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => shiftOwner(page)).toBe('Casey Manager');

    await page.getByRole('button', { name: 'Advanced settings' }).click();
    await page.getByRole('button', { name: /Generate breaks/ }).click();
    await expect(page.locator('.shift-marker-lunch')).toBeVisible();

    const { startDate, endDate } = dayWindow();
    const breaksResponse = await page.request.get(`/api/v1/lunch-breaks?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
    expect(breaksResponse.ok()).toBeTruthy();
    const breaksPayload = await breaksResponse.json() as { data?: Array<{ breaks?: unknown[] }> };
    expect(breaksPayload.data?.[0]?.breaks?.length).toBeGreaterThanOrEqual(3);

    await page.getByRole('link', { name: /Lunch & Breaks/ }).click();
    await page.getByRole('button', { name: /Auto Break/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Casey Manager')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Continue to planner' }).click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    await expect(page.locator('.meal-event').filter({ hasText: 'Lunch' })).toBeVisible();
    await expect(page.locator('.break-event').filter({ hasText: 'Break' }).first()).toBeVisible();

    await page.goto('/dashboard/time-cards');
    await expect(page.getByRole('heading', { name: 'Time Cards' })).toBeVisible();
    await page.getByLabel('Employee').selectOption({ label: 'Casey Manager' });
    await page.getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByText('Clocked in.')).toBeVisible();
    await expect(page.getByText(/Clocked in at/)).toBeVisible();
    await page.getByLabel('Break minutes').fill('0');
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByText('Clocked out.')).toBeVisible();
    await expect(page.getByText('CLOSED').first()).toBeVisible();
  });
});
