import { expect, test, type Page } from '@playwright/test';

import { dayWindow, loginAsSeedAdmin, runFullStack, seedTenant } from './support';

async function inviteStaff(page: Page, name: string, username: string, role: 'Manager' | 'Staff') {
  await page.getByPlaceholder('Full name').fill(name);
  await page.getByPlaceholder('username (lowercase)').fill(username);
  await page.getByPlaceholder('PIN (optional)').fill('135790');
  await page.locator('select').nth(1).selectOption({ label: role });
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function setupPeople(page: Page) {
  await loginAsSeedAdmin(page);
  await inviteStaff(page, 'Stress Staff', 'stress.staff', 'Staff');
  await inviteStaff(page, 'Stress Manager', 'stress.manager', 'Manager');
}

async function shiftRows(page: Page, days = 1) {
  const { startDate, endDate } = dayWindow(new Date(), days);
  const response = await page.request.get(`/api/v1/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { data?: Array<{ id: string; user?: { name?: string } | null; startTime: string; endTime: string }> };
  return payload.data ?? [];
}

async function createShiftFromToolbar(page: Page, staffName: string, start = '09:00', end = '17:00') {
  await page.getByRole('button', { name: /Add shift/ }).click();
  const shiftForm = page.locator('form.shift-form');
  await expect(shiftForm).toBeVisible();
  await shiftForm.locator('select').first().selectOption({ label: staffName });
  if (start === '09:00' && end === '17:00') {
    await expect(shiftForm.locator('input[type="time"]').first()).toHaveValue('09:00');
    await expect(shiftForm.locator('input[type="time"]').nth(1)).toHaveValue('17:00');
  }
  await shiftForm.locator('input[type="time"]').first().fill(start);
  await shiftForm.locator('input[type="time"]').nth(1).fill(end);
  await shiftForm.getByRole('button', { name: 'Create shift' }).click();
}

async function dragShiftToRow(page: Page, timeText: string, targetRowTitle: string) {
  const shiftBlock = page.locator('.shift-block').filter({ hasText: timeText }).first();
  await expect(shiftBlock).toBeVisible();
  const sourceBox = await shiftBlock.boundingBox();
  const targetBox = await page.locator(`.timeline-row[data-resource-title="${targetRowTitle}"]`).boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  if (!sourceBox || !targetBox) return;

  const sourceX = sourceBox.x + sourceBox.width / 2;
  await page.mouse.move(sourceX, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceX, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.mouse.up();
}

async function openScheduling(page: Page) {
  await page.getByRole('link', { name: /Calendar/ }).click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
}

test.describe.serial('Stress operations workflows', () => {
  test.skip(!runFullStack, 'Set E2E_FULL_STACK=1 and E2E_SEED_COMMAND to run DB-backed workflow stress tests.');

  test.beforeEach(async () => {
    await seedTenant();
  });

  test('A path: messy schedule board interactions keep assignments and validation sane', async ({ page }) => {
    await setupPeople(page);
    await openScheduling(page);

    await page.getByRole('button', { name: /Add shift/ }).click();
    const invalidForm = page.locator('form.shift-form');
    await invalidForm.locator('select').first().selectOption({ label: 'Stress Staff' });
    await invalidForm.locator('input[type="time"]').first().fill('17:00');
    await invalidForm.locator('input[type="time"]').nth(1).fill('09:00');
    await expect(invalidForm.getByRole('button', { name: 'Create shift' })).toBeDisabled();
    await invalidForm.getByRole('button', { name: 'Cancel' }).click();

    await createShiftFromToolbar(page, 'Stress Staff', '09:00', '17:00');
    await expect(page.locator('.shift-block').filter({ hasText: '09:00-17:00' })).toBeVisible();
    await expect.poll(async () => (await shiftRows(page))[0]?.user?.name ?? null).toBe('Stress Staff');

    await dragShiftToRow(page, '09:00-17:00', 'Open Shifts');
    await expect.poll(async () => (await shiftRows(page))[0]?.user?.name ?? null).toBe(null);
    await expect(page.locator('.timeline-row[data-resource-title="Open Shifts"]').filter({ hasText: '09:00-17:00' })).toBeVisible();

    await dragShiftToRow(page, '09:00-17:00', 'Stress Manager');
    await expect.poll(async () => (await shiftRows(page))[0]?.user?.name ?? null).toBe('Stress Manager');
    await expect(page.locator('.timeline-row[data-resource-title="Stress Manager"]').filter({ hasText: '09:00-17:00' })).toBeVisible();

    const staffRow = page.locator('.timeline-row[data-resource-title="Stress Staff"]');
    const staffRowBox = await staffRow.boundingBox();
    expect(staffRowBox).toBeTruthy();
    if (staffRowBox) {
      await page.mouse.click(staffRowBox.x + 420, staffRowBox.y + staffRowBox.height / 2);
    }
    const slotForm = page.locator('form.shift-form');
    await expect(slotForm).toBeVisible();
    await slotForm.locator('input[type="time"]').first().fill('12:00');
    await slotForm.locator('input[type="time"]').nth(1).fill('16:00');
    await slotForm.getByRole('button', { name: 'Create shift' }).click();
    await expect(page.locator('.shift-block').filter({ hasText: '12:00-16:00' })).toBeVisible();
    await expect.poll(async () => (await shiftRows(page, 3)).length).toBe(2);
  });

  test('B path: recovery flow handles lunch setup churn and time-card mistakes', async ({ page }) => {
    await setupPeople(page);
    await openScheduling(page);
    await createShiftFromToolbar(page, 'Stress Manager', '09:00', '17:00');
    await expect.poll(async () => (await shiftRows(page))[0]?.user?.name ?? null).toBe('Stress Manager');

    await page.getByRole('link', { name: /Lunch & Breaks/ }).click();
    const autoBreak = page.locator('button').filter({ hasText: 'Auto Break' });
    await expect(autoBreak).toHaveCount(1);
    await autoBreak.click();
    await expect(page.getByText('1 shifts available for this day')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Stress Manager')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('1 shifts available for this day')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Continue to planner' }).click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    await page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).click();
    await expect(page.getByText('Meals assigned: 1')).toBeVisible();
    await expect(page.getByText('Breaks assigned: 2')).toBeVisible();

    await page.goto('/dashboard/time-cards');
    await expect(page.getByRole('heading', { name: 'Time Cards' })).toBeVisible();
    await page.getByLabel('Employee').selectOption({ label: 'Stress Manager' });
    await page.getByRole('button', { name: 'Clock in' }).dblclick();
    await expect(page.getByText(/Clocked in at/)).toBeVisible();
    await expect(page.getByText('This employee already has an open time card.')).toHaveCount(0);
    await expect(page.getByText('1 open')).toBeVisible();

    await page.getByLabel('Break minutes').fill('999');
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByText('Break minutes must be less than worked minutes.')).toBeVisible();
    await expect(page.getByText(/Clocked in at/)).toBeVisible();

    await page.getByLabel('Break minutes').fill('0');
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByText('Clocked out.')).toBeVisible();
    await expect(page.getByText('CLOSED').first()).toBeVisible();
  });
});
