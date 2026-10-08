import type { TimeCardActiveResponse, TimeCardRecord } from '@lunchlineup/api-contract';

import { expect, test } from './qa-isolation-fixture';

import {
  addHours,
  assertInputHit,
  changeSetRequests,
  closeShiftDialogIfOpen,
  createProofShift,
  moveHandle,
  pointerGeometry,
  readShifts,
  resetAndOpenCalendar,
  shiftBlock,
  visibleInputBounds,
} from './internal-beta-interaction-support';

test.describe('Internal beta desktop interaction proof', () => {
  test.beforeEach(async ({ page }) => resetAndOpenCalendar(page));

  test('click, slight movement, outside drop, Escape, and pointercancel issue no move request', async ({ page }) => {
    await createProofShift(page, 'Staff One', '10:00', '14:00');
    const block = shiftBlock(page, '10:00-14:00');
    // Native generation clamps the default breaks into this four-hour shift.
    // Keep actual break markers in the compact-card reachability regression.
    await page.getByRole('button', { name: 'Advanced settings' }).click();
    await page.getByRole('button', { name: /Generate breaks/ }).click();
    const markers = block.getByRole('list', { name: 'Shift breaks' });
    await expect(markers).toBeVisible();
    expect(await markers.getByRole('listitem').count()).toBeGreaterThan(0);
    const mutations = changeSetRequests(page);

    // This fitted three-day card previously let the move handle cover the
    // details button. Prove both actual controls remain separately hittable.
    await expect(block).toHaveClass(/shift-block--compact/);
    const details = block.getByRole('button', { name: /^Edit STAFF shift,/ });
    const handle = moveHandle(block);
    await details.scrollIntoViewIfNeeded();
    await handle.scrollIntoViewIfNeeded();
    const detailsBounds = await visibleInputBounds(details);
    const handleBounds = await visibleInputBounds(handle);
    const timeBounds = await visibleInputBounds(details.locator('.shift-time'));
    const markerBounds = await visibleInputBounds(markers);
    expect(timeBounds.y + timeBounds.height, 'compact time and actual break strip do not overlap')
      .toBeLessThanOrEqual(markerBounds.y);
    expect(markerBounds.y + markerBounds.height, 'actual break strip stays inside details')
      .toBeLessThanOrEqual(detailsBounds.y + detailsBounds.height);
    const markerItems = markers.getByRole('listitem');
    for (let index = 0; index < await markerItems.count(); index++) {
      const item = markerItems.nth(index);
      await expect(item).toHaveAttribute('aria-label', /^(Meal|Break) \d/);
      const bounds = await visibleInputBounds(item);
      expect(bounds.y).toBeGreaterThanOrEqual(markerBounds.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(markerBounds.y + markerBounds.height);
    }
    expect(detailsBounds.y + detailsBounds.height, 'compact controls have disjoint visible hit areas')
      .toBeLessThanOrEqual(handleBounds.y);
    await assertInputHit(details, detailsBounds.x + detailsBounds.width / 2, detailsBounds.y + detailsBounds.height / 2);
    await assertInputHit(handle, handleBounds.x + handleBounds.width / 2, handleBounds.y + handleBounds.height / 2);
    await details.click();
    await closeShiftDialogIfOpen(page);

    let geometry = await pointerGeometry(page, handle, 'Staff One');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + 2, geometry.sourceY + 2, { steps: 2 });
    await page.mouse.up();
    await closeShiftDialogIfOpen(page);

    geometry = await pointerGeometry(page, handle, 'Staff One');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(2, 2, { steps: 8 });
    await page.mouse.up();

    geometry = await pointerGeometry(page, handle, 'Staff One');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.sourceY, { steps: 6 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    geometry = await pointerGeometry(page, handle, 'Staff One');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.sourceY, { steps: 6 });
    await page.locator('.scheduler-root').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    await page.mouse.up();

    await page.waitForTimeout(250);
    expect(mutations).toEqual([]);
    await expect(block).toContainText('10:00-14:00');
  });

  test('valid drag announces and commits the exact proposed employee and time with local Saved and Undo with persisted reversal', async ({ page }) => {
    const original = await createProofShift(page, 'Staff 10', '10:00', '14:00');
    expect(original).toBeTruthy();
    const block = shiftBlock(page, '10:00-14:00');
    const geometry = await pointerGeometry(page, moveHandle(block), 'E2E Manager');
    const requestPromise = page.waitForRequest((request) => request.method() === 'POST' && /\/change-sets$/.test(request.url()));

    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.targetY, { steps: 10 });
    const proposal = page.locator('.scheduler-status').getByRole('status');
    await expect(proposal).toContainText('E2E Manager');
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
    await expect(page.locator('.timeline-row[data-resource-title="E2E Manager"]')).toContainText('11:00-15:00');

    const feedback = page.locator('.schedule-mutation-feedback');
    const saved = feedback.getByRole('status').filter({ hasText: /^Saved E2E Manager/ });
    await expect(saved).toBeVisible();
    const undo = saved.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await expect.poll(async () => (await readShifts(page)).find((row) => row.id === original!.id)).toMatchObject({
      id: original!.id,
      user: { name: 'E2E Manager' },
      startTime: addHours(original!.startTime, 1),
      endTime: addHours(original!.endTime, 1),
    });
    const undoRequestPromise = page.waitForRequest((candidate) => candidate.method() === 'POST' && /\/change-sets$/.test(candidate.url()));
    await undo.click();
    const undoRequest = await undoRequestPromise;
    expect((undoRequest.postDataJSON() as { operations: any[] }).operations[0]).toMatchObject({
      op: 'shift.update',
      shiftId: original!.id,
      userId: original!.userId ?? original!.user?.id,
      startTime: original!.startTime,
      endTime: original!.endTime,
    });
    await expect(feedback.getByRole('status')).toContainText('Move undone');
    await expect(page.locator('.timeline-row[data-resource-title="Staff 10"]')).toContainText('10:00-14:00');
    await expect.poll(async () => (await readShifts(page)).find((row) => row.id === original!.id)).toMatchObject({
      id: original!.id,
      user: { name: 'Staff 10' },
      startTime: original!.startTime,
      endTime: original!.endTime,
    });
  });

  test('failed move restores only that shift and keyboard editing remains an exact fallback', async ({ page }) => {
    const first = await createProofShift(page, 'Staff 10', '10:00', '14:00');
    const second = await createProofShift(page, 'E2E Manager', '15:00', '18:00');
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
    const geometry = await pointerGeometry(page, firstHandle, 'E2E Manager');
    await page.mouse.move(geometry.sourceX, geometry.sourceY);
    await page.mouse.down();
    await page.mouse.move(geometry.sourceX + geometry.hourWidth, geometry.targetY, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.scheduler-error')).toContainText('Proof injected move failure.');
    await expect(page.locator('.timeline-row[data-resource-title="Staff 10"]')).toContainText('10:00-14:00');
    await expect(page.locator('.timeline-row[data-resource-title="E2E Manager"]')).toContainText('15:00-18:00');
    await page.waitForTimeout(250);
    expect(wholeBoardReloads, 'failed move must roll back only its object without a whole-board read').toEqual([]);

    await firstHandle.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /Move or copy shift/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Team member').selectOption({ label: 'E2E Manager' });
    await dialog.getByLabel('Time adjustment in minutes').fill('60');
    await expect(dialog.getByRole('status')).toContainText('E2E Manager');
    await expect(dialog.getByRole('status')).toContainText('11:00');
    await expect(dialog.getByRole('status')).toContainText('15:00');
    await dialog.getByRole('button', { name: 'Apply move' }).click();
    await expect(page.locator('.timeline-row[data-resource-title="E2E Manager"]')).toContainText('11:00-15:00');
    await expect.poll(async () => (await readShifts(page)).find((row) => row.id === second!.id)?.startTime).toBe(second!.startTime);
  });

  test('overnight values survive Calendar and Lunch while Lunch and Time Cards expose only supported explicit actions', async ({ page }, info) => {
    const overnight = await createProofShift(page, 'Staff One', '22:00', '06:00');
    expect(overnight).toBeTruthy();
    const before = { startTime: overnight!.startTime, endTime: overnight!.endTime };

    await page.getByRole('link', { name: /Lunch & Breaks/ }).click();
    await expect(page.getByRole('heading', { name: /Lunch & Breaks|Choose how to start today/ })).toBeVisible();
    await page.getByRole('button', { name: /Auto Break|Import from Scheduling System/ }).click();
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
    const timeout = 10_000;
    const bounded = async <T,>(operation: Promise<T>, label: string): Promise<T> => {
      let timer!: ReturnType<typeof setTimeout>;
      try { return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its finite deadline.`)), timeout);
      })]); } finally { clearTimeout(timer); }
    };
    const nativeRead = async <T,>(path: string): Promise<T> => {
      const response = await page.request.get(path, { timeout, maxRetries: 0, maxRedirects: 0 });
      let primary: unknown;
      try {
        expect(response.status(), `Native time-card readback for ${path}`).toBe(200);
        const bytes = await bounded(response.body(), 'Native time-card body');
        expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
        return JSON.parse(bytes.toString('utf8')) as T;
      } catch (error) { primary = error; throw error; }
      finally { try { await bounded(response.dispose(), 'Native time-card response cleanup'); } catch (cleanup) {
        throw new AggregateError(primary === undefined ? [cleanup] : [primary, cleanup], 'Native time-card readback/cleanup failures retained.');
      } }
    };
    const activePath = `/api/v2/time-cards/active?userId=${encodeURIComponent(target.userId)}`;
    expect((await nativeRead<TimeCardActiveResponse>(activePath)).data, 'Fresh selected employee has no open card before the sole clock-in').toBeNull();
    const origin = new URL(page.url()).origin;
    const observed = page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).origin === origin && new URL(request.url()).pathname === '/api/v2/time-cards/clock-in',
    { timeout }).then(async request => {
      expect(request.postDataJSON()).toMatchObject(target);
      const response = await bounded(request.response(), 'Exact clock-in Request response');
      expect(response, 'The actual clock-in Request receives its own native response').not.toBeNull();
      // Canonical fresh clock-in is 201; 200 denotes an existing/reused card.
      expect(response!.status()).toBe(201);
      // Guarded Chromium response bodies can be unavailable; independent native
      // reads below own saved-card evidence rather than reusing browser JSON.
    });
    const [response, action] = await Promise.allSettled([observed,
      bounded(Promise.resolve().then(() => clockIn.click()), 'Clock-in action')]);
    const failures: unknown[] = [];
    if (action.status === 'rejected') failures.push(action.reason);
    if (response.status === 'rejected') failures.push(response.reason);
    if (failures.length) throw new AggregateError(failures, 'Clock-in action/actual Request response failures retained.');
    await expect(page.getByText('Staff One was clocked in at Downtown Diner.')).toBeVisible();
    expect(clockInRequests).toHaveLength(1);
    expect(clockInRequests[0]).toMatchObject(target);
    const settled = async () => {
      const main = page.getByRole('main');
      await expect(main.getByRole('button', { name: 'Clock out Staff One from Downtown Diner', exact: true })).toBeEnabled({ timeout });
      const currentStatus = main.getByText('Current status', { exact: true }).locator('..');
      await expect(currentStatus).toContainText('Clocked in at');
      await expect(currentStatus).toContainText('Downtown Diner');
      await expect(main.getByRole('alert')).toHaveCount(0);
      await expect(main.getByText(/^(Loading time cards|Loading status|Loading time card history|Status unavailable|Time card history is unavailable)/)).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^Clocking (in|out) / })).toHaveCount(0);
      await expect(main.getByRole('button', { name: 'Clock in Staff One at Downtown Diner', exact: true })).toHaveCount(0);
      const row = main.getByRole('row').filter({ hasText: 'Staff One' });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Downtown Diner'); await expect(row).toContainText('OPEN');
    };
    await settled();
    const active = (await nativeRead<TimeCardActiveResponse>(activePath)).data;
    expect(active, 'Native active card exists after settled clock-in').not.toBeNull();
    expect(active!).toMatchObject({ ...target, status: 'OPEN', clockOutAt: null,
      user: { id: target.userId, name: 'Staff One' }, location: { id: target.locationId, name: 'Downtown Diner' } });
    expect(active!.id).toMatch(/^[a-f0-9-]{36}$/i);
    const saved = await nativeRead<TimeCardRecord>(`/api/v2/time-cards/${encodeURIComponent(active!.id)}`);
    const persisted = { id: active!.id, ...target, status: 'OPEN' as const, clockInAt: active!.clockInAt,
      clockOutAt: null, createdAt: active!.createdAt };
    expect(saved).toMatchObject(persisted);
    await page.reload();
    await page.getByRole('button', { name: 'Team Time', exact: true }).click();
    await expect(employee).toHaveValue(''); await expect(location).toBeDisabled();
    await employee.selectOption(target.userId); await expect(location).toBeEnabled();
    await location.selectOption(target.locationId);
    await expect(employee).toHaveValue(target.userId); await expect(location).toHaveValue(target.locationId);
    await settled();
    const reloaded = (await nativeRead<TimeCardActiveResponse>(activePath)).data;
    expect(reloaded).toMatchObject(persisted);
    expect(await nativeRead<TimeCardRecord>(`/api/v2/time-cards/${encodeURIComponent(saved.id)}`)).toMatchObject(persisted);
    expect(clockInRequests).toHaveLength(1);
    const screenshotPath = info.outputPath('settled-time-card-after-reload.png');
    const screenshot = await page.screenshot({ path: screenshotPath });
    expect(screenshot.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    await info.attach('settled-time-card-after-reload', { path: screenshotPath, contentType: 'image/png' });
    await info.attach('native-time-card-persistence', { body: JSON.stringify({
      saved: persisted, user: saved.user, location: saved.location, actualClockInStatus: 201,
      clockInRequestCount: clockInRequests.length, settledClockOutEnabled: true, reloadedSameActiveCard: true,
    }), contentType: 'application/json' });
  });
});
