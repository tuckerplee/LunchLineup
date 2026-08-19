import { expect, test } from '@playwright/test';

import {
  addHours,
  changeSetRequests,
  closeShiftDialogIfOpen,
  createProofShift,
  moveHandle,
  pointerGeometry,
  readShifts,
  resetAndOpenCalendar,
  shiftBlock,
} from './internal-beta-interaction-support';

test.describe('Internal beta desktop interaction proof', () => {
  test.beforeEach(async ({ page }) => resetAndOpenCalendar(page));

  test('click, slight movement, outside drop, Escape, and pointercancel issue no move request', async ({ page }) => {
    await createProofShift(page, 'Staff One', '10:00', '14:00');
    const block = shiftBlock(page, '10:00-14:00');
    const mutations = changeSetRequests(page);

    await block.getByRole('button', { name: /Edit Staff One shift/ }).click();
    await closeShiftDialogIfOpen(page);

    const handle = moveHandle(block);
    const geometry = await pointerGeometry(page, handle, 'Staff One');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + 2, geometry.sourceY + 2, { steps: 2 });
    await page.mouse.up();
    await closeShiftDialogIfOpen(page);

    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(2, 2, { steps: 8 });
    await page.mouse.up();

    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.sourceY, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.sourceY, { steps: 6 });
    await page.locator('.scheduler-root').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up();

    await page.waitForTimeout(250);
    expect(mutations).toEqual([]);
    await expect(block).toContainText('10:00-14:00');
  });

  test('valid drag announces and commits the exact proposed employee and time with local Saved and Undo when exposed', async ({ page }) => {
    const original = await createProofShift(page, 'Staff One', '10:00', '14:00');
    expect(original).toBeTruthy();
    const block = shiftBlock(page, '10:00-14:00');
    const geometry = await pointerGeometry(page, moveHandle(block), 'E2E Admin');
    const requestPromise = page.waitForRequest((request) => request.method() === 'POST' && /\/change-sets$/.test(request.url()));

    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.targetY, { steps: 10 });
    const proposal = page.locator('.scheduler-status').getByRole('status');
    await expect(proposal).toContainText('E2E Admin');
    await expect(proposal).toContainText('11:00');
    await expect(proposal).toContainText('15:00');
    await page.mouse.up();

    const request = await requestPromise;
    const operation = (request.postDataJSON() as { operations: any[] }).operations[0];
    expect(operation).toMatchObject({
      op: 'shift.update',
      shiftId: original!.id,
      userId: geometry.targetUserId,
      startTime: addHours(original!.startTime, 1),
      endTime: addHours(original!.endTime, 1),
    });
    await expect(page.locator('.timeline-row[data-resource-title="E2E Admin"]')).toContainText('11:00-15:00');

    const saved = page.getByRole('status').filter({ hasText: /Saved/ });
    if (await saved.count()) await expect(saved).toBeVisible();
    const undo = page.getByRole('button', { name: /Undo move/ });
    if (await undo.count()) {
      await undo.click();
      await expect(page.locator('.timeline-row[data-resource-title="Staff One"]')).toContainText('10:00-14:00');
    }
  });

  test('failed move restores only that shift and keyboard editing remains an exact fallback', async ({ page }) => {
    const first = await createProofShift(page, 'Staff One', '10:00', '14:00');
    const second = await createProofShift(page, 'E2E Admin', '15:00', '18:00');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    let failed = false;
    const wholeBoardReloads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/api/v2/schedule-board')) {
        wholeBoardReloads.push(request.url());
      }
    });
    await page.route(/\/api\/v2\/schedules\/[^/]+\/change-sets$/, async (route) => {
      if (!failed && route.request().postData()?.includes(first!.id)) {
        failed = true;
        await route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://lunchlineup.com/problems/proof-injected-move-failure',
            title: 'Proof injected move failure',
            status: 422,
            detail: 'Proof injected move failure.',
            code: 'proof_injected_move_failure',
          }),
        });
        return;
      }
      await route.continue();
    });

    const firstBlock = shiftBlock(page, '10:00-14:00');
    const firstHandle = moveHandle(firstBlock);
    const geometry = await pointerGeometry(page, firstHandle, 'E2E Admin');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.targetY, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.scheduler-error')).toContainText('Proof injected move failure.');
    await expect(page.locator('.timeline-row[data-resource-title="Staff One"]')).toContainText('10:00-14:00');
    await expect(page.locator('.timeline-row[data-resource-title="E2E Admin"]')).toContainText('15:00-18:00');
    await page.waitForTimeout(250);
    expect(wholeBoardReloads, 'failed move must roll back only its object without a whole-board read').toEqual([]);

    await firstHandle.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /Move or copy shift/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Team member').selectOption({ label: 'E2E Admin' });
    await dialog.getByLabel('Time adjustment in minutes').fill('60');
    await expect(dialog.getByRole('status')).toContainText('E2E Admin');
    await expect(dialog.getByRole('status')).toContainText('11:00');
    await expect(dialog.getByRole('status')).toContainText('15:00');
    await dialog.getByRole('button', { name: 'Apply move' }).click();
    await expect(page.locator('.timeline-row[data-resource-title="E2E Admin"]')).toContainText('11:00-15:00');
    await expect.poll(async () => (await readShifts(page)).find((row) => row.id === second!.id)?.startTime).toBe(second!.startTime);
  });

  test('overnight values survive Calendar and Lunch while Lunch and Time Cards expose only supported explicit actions', async ({ page }) => {
    const overnight = await createProofShift(page, 'Staff One', '22:00', '06:00');
    expect(overnight).toBeTruthy();
    const before = { startTime: overnight!.startTime, endTime: overnight!.endTime };

    await page.getByRole('link', { name: /Lunch & Breaks/ }).click();
    await expect(page.getByRole('heading', { name: /Lunch & Breaks|Choose how to start today/ })).toBeVisible();
    await page.getByRole('button', { name: 'Auto Break' }).click();
    await page.getByRole('button', { name: 'Select staff' }).click();
    await page.getByRole('button', { name: 'Review 1 shift' }).click();
    await expect(page.getByText('Staff One · Schedule-backed · Overnight')).toBeVisible();
    await expect(page.getByLabel('Start time for Staff One')).toHaveValue('22:00');
    await expect(page.getByLabel('Start time for Staff One')).toBeDisabled();
    await expect(page.getByLabel('End day for Staff One')).toHaveValue('1');
    await expect(page.getByLabel('End day for Staff One')).toBeDisabled();
    await expect(page.getByLabel('End time for Staff One')).toHaveValue('06:00');
    await expect(page.getByLabel('End time for Staff One')).toBeDisabled();
    const billingDisclosure = page.locator('#setup-shifts-billing-requirement');
    await expect(billingDisclosure).toContainText(/confirmed action saves exactly 1 setup shift record and uses exactly \d+ separately purchased usage credit/i);
    const billingText = await billingDisclosure.innerText();
    const exactCost = billingText.match(/uses exactly (\d+) separately purchased usage credit/i)?.[1];
    expect(exactCost, 'Lunch setup exact credit cost').toBeTruthy();
    const saveSetup = page.getByRole('button', { name: new RegExp(`Save 1 setup shift record · exactly ${exactCost} usage credit`) });
    await expect(saveSetup).toBeEnabled();
    const confirmPromise = page.waitForEvent('dialog');
    const savePromise = saveSetup.click();
    const confirm = await confirmPromise;
    expect(confirm.message()).toMatch(new RegExp(`Confirm setup: save 1 unchanged schedule-backed shift record.*uses exactly ${exactCost} usage credit`, 'i'));
    await confirm.accept();
    await savePromise;
    const overnightRow = page.locator('button.schedule-row').filter({ hasText: 'Staff One' });
    await expect(overnightRow).toContainText('10:00 PM');
    await expect(overnightRow).toContainText('6:00 AM');
    for (const unsupported of ['Timeline', 'Staff', 'Conflicts']) {
      await expect(page.getByRole('button', { name: unsupported, exact: true })).toHaveCount(0);
    }
    await expect(page.getByText(/Credit cost\/run:/)).toContainText(exactCost!);
    expect((await readShifts(page)).find((row) => row.id === overnight!.id)).toMatchObject(before);

    await page.goto('/dashboard/time-cards');
    await page.getByRole('button', { name: 'Team Time' }).click();
    const employee = page.getByLabel('Team member');
    const location = page.getByLabel('Team location');
    const clockInRequests: Array<Record<string, unknown>> = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/v2/time-cards/clock-in')) {
        clockInRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    });
    await expect(employee).toHaveValue('');
    await expect(location).toHaveValue('');
    await expect(location).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Select a team member and location' })).toBeDisabled();
    await employee.selectOption({ label: 'Staff One' });
    await expect(location).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Select a location for Staff One' })).toBeDisabled();
    expect(clockInRequests).toEqual([]);
    await location.selectOption({ label: 'Downtown Diner' });
    const clockIn = page.getByRole('button', { name: 'Clock in Staff One at Downtown Diner' });
    await expect(clockIn).toBeEnabled();
    const target = { userId: await employee.inputValue(), locationId: await location.inputValue() };
    expect(target.userId).not.toBe('');
    expect(target.locationId).not.toBe('');
    await clockIn.click();
    await expect(page.getByText('Staff One was clocked in at Downtown Diner.')).toBeVisible();
    expect(clockInRequests).toHaveLength(1);
    expect(clockInRequests[0]).toMatchObject(target);
  });
});
