import { expect, test, type Page } from '@playwright/test';

import { csrfHeaders, loginAsSeedAdmin, loginWithPin, runFullStack } from './support';

const runMockReadiness = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
const publicOnlyOverride = process.env.E2E_PUBLIC_SMOKE_ONLY === '1';
const v2Ids = {
  downtown: '10000000-0000-4000-8000-000000000001',
  uptown: '10000000-0000-4000-8000-000000000002',
  staff: '20000000-0000-4000-8000-000000000001',
  manager: '20000000-0000-4000-8000-000000000002',
  downtownSchedule: '30000000-0000-4000-8000-000000000001',
  uptownSchedule: '30000000-0000-4000-8000-000000000002',
  downtownShift: '40000000-0000-4000-8000-000000000001',
  uptownShift: '40000000-0000-4000-8000-000000000002',
  recoveryJob: '50000000-0000-4000-8000-000000000001',
};

async function saveDemandWindow(page: Page, date: string) {
  const editor = page.getByLabel('Schedule demand setup').first();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Edit demand' }).click();
  await editor.getByRole('button', { name: 'Add window' }).click();
  const row = editor.locator('.demand-editor__row').last();
  await row.getByLabel('Date').fill(date);
  await row.getByLabel('Start').fill('10:00');
  await row.getByLabel('End').fill('18:00');
  await row.getByLabel('Staff').fill('1');
  await editor.getByRole('button', { name: 'Save demand' }).click();
  await expect(editor.getByText('1 demand window saved.')).toBeVisible();
}

async function openBillingSettings(page: Page) {
  await loginAsSeedAdmin(page, '/dashboard/settings');
  await expect(page.getByLabel('Organization Name')).toHaveValue('E2E Operations Diner');
  const billingTab = page.getByRole('tab', { name: 'Billing' });
  await billingTab.click();
  await expect(billingTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
}

test('E2E configuration includes an authenticated readiness layer', () => {
  expect(
    runFullStack || runMockReadiness || publicOnlyOverride,
    'Default E2E must not pass with only unauthenticated public smoke. Use the mock readiness server, E2E_FULL_STACK=1, or explicit E2E_PUBLIC_SMOKE_ONLY=1.',
  ).toBeTruthy();
});

test.describe('Authenticated scheduling SaaS readiness', () => {
  test.skip(runFullStack, 'DB-backed authenticated specs cover this path when E2E_FULL_STACK=1.');
  test.skip(!runMockReadiness, 'Mock API readiness runs only when Playwright starts the local web app.');
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'Authenticated readiness mutates shared mock state and runs once on desktop Chromium.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok(), `mock API reset returned ${response.status()}`).toBeTruthy();
  });

  test('logs in and proves scheduler, break generation, and time-card writes', async ({ page }) => {
    const publishKeys: string[] = [];
    const publishBodies: unknown[] = [];
    await page.route('**/api/v2/schedules/*/publications', async (route) => {
      publishKeys.push(route.request().headers()['idempotency-key'] ?? '');
      publishBodies.push(route.request().postDataJSON());
      if (publishKeys.length === 1) {
        const committedResponse = await route.fetch();
        expect(committedResponse.ok()).toBe(true);
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Publish response lost.' }) });
        return;
      }
      await route.continue();
    });
    await loginAsSeedAdmin(page, '/dashboard/scheduling');

    const initialBillingResponse = await page.request.get('/api/v1/billing/features');
    expect(initialBillingResponse.ok()).toBe(true);
    const initialBilling = await initialBillingResponse.json() as {
      status: string;
      stripeSubscriptionActive: boolean;
      stripeSubscriptionPresent: boolean;
      usageCredits: number;
      features: Record<string, { source: string; creditCost: number | null }>;
    };
    expect(initialBilling).toMatchObject({
      status: 'ACTIVE',
      stripeSubscriptionActive: true,
      stripeSubscriptionPresent: true,
      usageCredits: 500,
      features: {
        scheduling: { source: 'credits', creditCost: 1 },
        lunch_breaks: { source: 'credits', creditCost: 1 },
        time_cards: { source: 'credits', creditCost: 1 },
      },
    });

    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    await expect(page.getByText('E2E Operations Diner')).toBeVisible();
    await expect(page.getByRole('link', { name: /Lunch & Breaks/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Time Cards/ })).toBeVisible();
    await expect(page.getByText(/No saved shifts in this range/)).toBeVisible();

    const missingBreakAttemptKey = await page.request.post('/api/v2/break-generations', {
      headers: await csrfHeaders(page),
      data: {
        locationId: v2Ids.downtown,
        shiftIds: [v2Ids.downtownShift],
        persist: true,
      },
    });
    expect(missingBreakAttemptKey.status()).toBe(428);
    expect(await missingBreakAttemptKey.json()).toMatchObject({
      code: 'idempotency_key_required',
    });

    await page.getByRole('button', { name: /Add shift/ }).click();
    const shiftForm = page.locator('form.shift-form');
    await expect(shiftForm).toBeVisible();
    await shiftForm.locator('select').first().selectOption({ label: 'Mock Staff' });
    await shiftForm.locator('input[type="time"]').first().fill('10:00');
    await shiftForm.locator('input[type="time"]').nth(1).fill('18:00');
    const demandDate = await shiftForm.locator('input[type="date"]').inputValue();
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();

    await expect(page.getByText(/Shift created and saved/)).toBeVisible();
    await expect(page.locator('.timeline-row[data-resource-title="Mock Staff"]').filter({ hasText: '10:00-18:00' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Publish review' })).toBeVisible();
    await saveDemandWindow(page, demandDate);

    await page.getByRole('button', { name: /Auto-schedule/ }).click();
    await expect(page.getByText(/will replace every shift/i)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm replace' }).click();
    await expect(page.getByText(/Auto-schedule solved/)).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Advanced settings' }).click();
    await page.getByRole('button', { name: /Generate breaks/ }).click();
    await expect(page.getByText(/Breaks generated and saved for 1 shift/)).toBeVisible();
    await expect(page.locator('.shift-marker-lunch')).toBeVisible();
    await expect(page.locator('.shift-marker-break').first()).toBeVisible();

    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.locator('.scheduler-publish-row__cost').getByText('Configured total: 1 credit')).toBeVisible();
    const confirmPublish = page.getByRole('button', { name: 'Confirm - 1 credit' });
    await confirmPublish.evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(page.getByText(/Retry uses the original Idempotency-Key and settlement attempt/)).toBeVisible();
    expect(publishKeys).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry publish' }).click();
    await expect(page.locator('.scheduler-publish-row__settlement')).toContainText('1 credit was debited exactly once');
    expect(publishKeys).toHaveLength(2);
    expect(publishKeys[1]).toBe(publishKeys[0]);
    expect(publishBodies).toEqual([
      {
        acceptedContract: {
          version: 2,
          totalConfiguredCost: 1,
          scheduleCost: 1,
          matchingWebhookDeliveryCount: 0,
          matchingWebhookDeliveryUnitCost: 0,
          matchingWebhookDeliveryCost: 0,
        },
      },
      {
        acceptedContract: {
          version: 2,
          totalConfiguredCost: 1,
          scheduleCost: 1,
          matchingWebhookDeliveryCount: 0,
          matchingWebhookDeliveryUnitCost: 0,
          matchingWebhookDeliveryCost: 0,
        },
      },
    ]);

    await page.locator('.shift-block').first().click();
    const publishedShiftEditor = page.getByRole('dialog', { name: 'Edit shift' });
    await expect(publishedShiftEditor).toBeVisible();
    await expect(publishedShiftEditor.getByText('Published schedule')).toBeVisible();
    await expect(publishedShiftEditor.getByRole('button', { name: 'Save shift' })).toBeDisabled();
    await publishedShiftEditor.getByRole('button', { name: 'Reopen schedule to edit' }).click();
    await publishedShiftEditor.getByRole('button', { name: 'Confirm reopen schedule' }).click();
    await expect(publishedShiftEditor.getByText('Published schedule')).toHaveCount(0);
    await expect(publishedShiftEditor.getByRole('button', { name: 'Save shift' })).toBeEnabled();
    await publishedShiftEditor.getByRole('button', { name: 'Close shift editor' }).click();

    await page.getByRole('link', { name: /Time Cards/ }).click();
    await expect(page.getByRole('heading', { name: 'Time Cards' })).toBeVisible();
    await page.getByLabel('Employee').selectOption({ label: 'Mock Staff' });
    await page.getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByText('Clocked in.')).toBeVisible();
    await expect(page.getByText(/Clocked in at/)).toBeVisible();
    await page.getByLabel('Break minutes').fill('0');
    await page.getByRole('button', { name: 'Clock out' }).click();
    await expect(page.getByText('Clocked out.')).toBeVisible();
    await expect(page.getByText('CLOSED').first()).toBeVisible();

    const endingBillingResponse = await page.request.get('/api/v1/billing/features');
    expect(endingBillingResponse.ok()).toBe(true);
    expect(await endingBillingResponse.json()).toMatchObject({
      usageCredits: 495,
      features: {
        scheduling: { enabled: true, source: 'credits', creditCost: 1 },
        lunch_breaks: { enabled: true, source: 'credits', creditCost: 1 },
        time_cards: { enabled: true, source: 'credits', creditCost: 1 },
      },
    });
  });

  test('creates and edits an overnight shift inside the containing weekly draft', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/scheduling?date=2026-07-11');
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();

    const createScheduleResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && /\/api\/v2\/locations\/[0-9a-f-]{36}\/schedules$/.test(new URL(response.url()).pathname));
    await page.getByRole('button', { name: 'Create schedule' }).click();
    const weeklyScheduleResponse = await (await createScheduleResponsePromise).json() as { data: { id: string } };
    const weeklySchedule = weeklyScheduleResponse.data;
    await expect(page.getByText(/Draft schedule created/)).toBeVisible();

    await page.getByRole('button', { name: /Add shift/ }).click();
    const shiftForm = page.locator('form.shift-form');
    await shiftForm.locator('select').first().selectOption({ label: 'Mock Staff' });
    await shiftForm.getByLabel('Date').fill('2026-07-11');
    await shiftForm.getByLabel('Start').fill('22:00');
    await shiftForm.getByLabel('End').fill('02:00');

    const createRequestPromise = page.waitForRequest((request) =>
      request.method() === 'POST'
      && /\/api\/v2\/schedules\/[0-9a-f-]{36}\/change-sets$/.test(new URL(request.url()).pathname));
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();
    const createRequest = await createRequestPromise;
    expect(createRequest.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}:shift$/i);
    expect(new URL(createRequest.url()).pathname).toContain(`/api/v2/schedules/${weeklySchedule.id}/change-sets`);
    const createPayload = createRequest.postDataJSON() as {
      operations: Array<{ op: string; startTime: string; endTime: string }>;
    };
    expect(createPayload.operations).toEqual([expect.objectContaining({
      op: 'shift.create',
      startTime: '2026-07-12T05:00:00.000Z',
      endTime: '2026-07-12T09:00:00.000Z',
    })]);
    await expect(page.getByText(/Shift created and saved/)).toBeVisible();

    const overnightShift = page.locator('.shift-block').filter({ hasText: '22:00-02:00' }).first();
    await expect(overnightShift).toBeVisible();
    await overnightShift.click();
    await expect(page.getByRole('dialog', { name: 'Edit shift' })).toBeVisible();
    await expect(shiftForm.getByLabel('Date')).toHaveValue('2026-07-11');
    await expect(shiftForm.getByLabel('Start')).toHaveValue('22:00');
    await expect(shiftForm.getByLabel('End')).toHaveValue('02:00');

    const editKeys: string[] = [];
    await page.route('**/api/v2/schedules/*/change-sets', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      editKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (editKeys.length === 1) {
        const committed = await route.fetch();
        expect(committed.ok()).toBe(true);
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Shift update response lost.' }),
        });
        return;
      }
      await route.continue();
    });
    await shiftForm.getByLabel('End').fill('01:30');
    await shiftForm.getByRole('button', { name: 'Save shift' }).click();
    await expect(page.getByText('Shift save failed. Schedule was not changed.')).toBeVisible();
    expect(editKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('lunchlineup:shift-update-recovery:v1'))).not.toBeNull();
    const afterLostResponse = await page.request.get('/api/v1/billing/features');
    expect(await afterLostResponse.json()).toMatchObject({ usageCredits: 500 });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    const recoveredShift = page.locator('.shift-block').filter({ hasText: '22:00-01:30' }).first();
    await expect(recoveredShift).toBeVisible();
    await recoveredShift.click();
    await expect(page.getByRole('dialog', { name: 'Edit shift' })).toBeVisible();
    const recoveredForm = page.locator('form.shift-form');
    const editRequestPromise = page.waitForRequest((request) =>
      request.method() === 'POST'
      && /\/api\/v2\/schedules\/[0-9a-f-]{36}\/change-sets$/.test(new URL(request.url()).pathname));
    await recoveredForm.getByRole('button', { name: 'Save shift' }).click();
    const editPayload = (await editRequestPromise).postDataJSON() as {
      operations: Array<{
        op: string;
        shiftId: string;
        startTime?: string;
        endTime?: string;
        userId?: string | null;
        role?: string | null;
      }>;
    };
    expect(editPayload.operations).toEqual([{
      op: 'shift.update',
      shiftId: expect.any(String),
      endTime: '2026-07-12T08:30:00.000Z',
    }]);
    await expect(page.getByText(/Shift changes saved/)).toBeVisible();
    expect(editKeys).toHaveLength(2);
    expect(editKeys[1]).toBe(editKeys[0]);
    const afterReplay = await page.request.get('/api/v1/billing/features');
    expect(await afterReplay.json()).toMatchObject({ usageCredits: 500 });
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('lunchlineup:shift-update-recovery:v1'))).toBeNull();

    const editor = page.getByLabel('Schedule demand setup').first();
    await editor.getByRole('button', { name: 'Edit demand' }).click();
    await editor.getByRole('button', { name: 'Add window' }).click();
    const demandRow = editor.locator('.demand-editor__row').last();
    await demandRow.getByLabel('Date').fill('2026-07-11');
    await demandRow.getByLabel('Start').fill('23:00');
    await demandRow.getByLabel('End').fill('01:00');
    await demandRow.getByLabel('Staff').fill('2');

    const demandRequestPromise = page.waitForRequest((request) =>
      request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/demand-windows'));
    await editor.getByRole('button', { name: 'Save demand' }).click();
    const demandPayload = (await demandRequestPromise).postDataJSON() as {
      windows: Array<{ startTime: string; endTime: string; requiredStaff: number }>;
    };
    expect(demandPayload.windows).toEqual([expect.objectContaining({
      startTime: '2026-07-12T06:00:00.000Z',
      endTime: '2026-07-12T08:00:00.000Z',
      requiredStaff: 2,
    })]);
    await expect(editor.getByText('1 demand window saved.')).toBeVisible();
    await expect(demandRow.getByLabel('Date')).toHaveValue('2026-07-11');
    await expect(demandRow.getByLabel('Start')).toHaveValue('23:00');
    await expect(demandRow.getByLabel('End')).toHaveValue('01:00');
  });

  test('moves a draft shift in time and reassigns it with one drag', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/scheduling?date=2026-07-09');
    await page.getByRole('button', { name: /Add shift/ }).click();
    const shiftForm = page.locator('form.shift-form');
    await shiftForm.locator('select').first().selectOption({ label: 'Mock Staff' });
    await shiftForm.getByLabel('Start').fill('10:00');
    await shiftForm.getByLabel('End').fill('18:00');
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();
    await expect(page.getByText(/Shift created and saved/)).toBeVisible();

    const shift = page.locator('.timeline-row[data-resource-title="Mock Staff"] .shift-block').filter({ hasText: '10:00-18:00' }).first();
    const targetRow = page.locator('.timeline-row[data-resource-title="Mock Manager"]');
    const hourCell = page.locator('.hour-label').first();
    const [shiftBox, targetBox, hourBox] = await Promise.all([
      shift.boundingBox(),
      targetRow.boundingBox(),
      hourCell.boundingBox(),
    ]);
    expect(shiftBox).toBeTruthy();
    expect(targetBox).toBeTruthy();
    expect(hourBox).toBeTruthy();
    if (!shiftBox || !targetBox || !hourBox) return;

    const updateRequest = page.waitForRequest((request) =>
      request.method() === 'POST'
      && /\/api\/v2\/schedules\/[0-9a-f-]{36}\/change-sets$/.test(new URL(request.url()).pathname));
    const sourceX = shiftBox.x + Math.min(20, shiftBox.width / 3);
    await page.mouse.move(sourceX, shiftBox.y + shiftBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceX + hourBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
    await page.mouse.up();

    const payload = (await updateRequest).postDataJSON() as {
      operations: Array<{ userId: string; startTime: string; endTime: string }>;
    };
    expect(payload.operations[0].userId).toBe(v2Ids.manager);
    expect(
      new Date(payload.operations[0].endTime).getTime() - new Date(payload.operations[0].startTime).getTime(),
    ).toBe(8 * 60 * 60 * 1000);
    await expect(page.getByText(/Board change saved/)).toBeVisible();
    await expect(targetRow.locator('.shift-block').filter({ hasText: '10:30-18:30' })).toBeVisible();
  });

  test('retains the active location through break generation and refresh', async ({ page }) => {
    const locations = [
      { id: v2Ids.downtown, name: 'Downtown Diner', timezone: 'America/Los_Angeles' },
      { id: v2Ids.uptown, name: 'Uptown Diner', timezone: 'America/Los_Angeles' },
    ];
    const staff = [
      { id: v2Ids.staff, name: 'Mock Staff', role: 'STAFF' },
      { id: v2Ids.manager, name: 'Mock Manager', role: 'MANAGER' },
    ];
    const schedules = [
      {
        id: v2Ids.downtownSchedule,
        locationId: v2Ids.downtown,
        startDate: '2026-07-09T07:00:00.000Z',
        endDate: '2026-07-10T07:00:00.000Z',
        status: 'DRAFT',
        publishedAt: null,
        revision: 0,
        etag: `"schedule:${v2Ids.downtownSchedule}:0"`,
      },
      {
        id: v2Ids.uptownSchedule,
        locationId: v2Ids.uptown,
        startDate: '2026-07-09T07:00:00.000Z',
        endDate: '2026-07-10T07:00:00.000Z',
        status: 'DRAFT',
        publishedAt: null,
        revision: 0,
        etag: `"schedule:${v2Ids.uptownSchedule}:0"`,
      },
    ];
    const shifts = [
      {
        id: v2Ids.downtownShift,
        locationId: v2Ids.downtown,
        scheduleId: v2Ids.downtownSchedule,
        userId: v2Ids.staff,
        role: 'STAFF',
        startTime: '2026-07-09T17:00:00.000Z',
        endTime: '2026-07-10T01:00:00.000Z',
        breaks: [],
        user: { id: v2Ids.staff, name: 'Mock Staff', role: 'STAFF' },
      },
      {
        id: v2Ids.uptownShift,
        locationId: v2Ids.uptown,
        scheduleId: v2Ids.uptownSchedule,
        userId: v2Ids.manager,
        role: 'MANAGER',
        startTime: '2026-07-09T18:00:00.000Z',
        endTime: '2026-07-10T02:00:00.000Z',
        breaks: [],
        user: { id: v2Ids.manager, name: 'Mock Manager', role: 'MANAGER' },
      },
    ];
    const requestedLocationIds: Array<string | null> = [];
    let generatedShiftIds: string[] = [];
    let generatedLocationId = '';
    let releaseDowntownLoad: (() => void) | undefined;
    const downtownLoadGate = new Promise<void>((resolve) => {
      releaseDowntownLoad = resolve;
    });

    await page.route('**/api/v2/schedule-board?*', async (route) => {
      const url = new URL(route.request().url());
      const locationId = url.searchParams.get('locationId') ?? locations[0].id;
      requestedLocationIds.push(locationId);
      if (locationId === v2Ids.downtown) await downtownLoadGate;
      const selectedSchedules = schedules.filter((schedule) => schedule.locationId === locationId);
      const scheduleIds = new Set(selectedSchedules.map((schedule) => schedule.id));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            permissions: [
              'locations:read',
              'schedules:read',
              'schedules:write',
              'schedules:publish',
              'shifts:read',
              'shifts:write',
              'shifts:delete',
              'lunch_breaks:write',
            ],
            locations,
            locationsTruncated: false,
            selectedLocationId: locationId,
            staff,
            schedules: selectedSchedules,
            shifts: shifts.filter((shift) => scheduleIds.has(shift.scheduleId)),
            range: {
              start: '2026-07-09T07:00:00.000Z',
              end: '2026-07-12T07:00:00.000Z',
            },
          },
          meta: { generatedAt: '2026-07-09T08:00:00.000Z' },
        }),
      });
    });
    await page.route('**/api/v2/break-generations', async (route) => {
      const payload = route.request().postDataJSON() as { locationId?: string; shiftIds?: string[] };
      generatedLocationId = payload.locationId ?? '';
      generatedShiftIds = payload.shiftIds ?? [];
      const selectedShift = shifts.find((shift) => shift.id === generatedShiftIds[0]) ?? shifts[0];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          locationId: generatedLocationId,
          source: 'shared_schedule',
          persisted: true,
          policy: {
            break1OffsetMinutes: 120,
            lunchOffsetMinutes: 240,
            break2OffsetMinutes: 360,
            break1DurationMinutes: 10,
            lunchDurationMinutes: 30,
            break2DurationMinutes: 10,
            timeStepMinutes: 5,
          },
          creditConsumption: { consumedCredits: 1, newBalance: 499, source: 'credits' },
          data: [{
            shiftId: selectedShift.id,
            userId: selectedShift.userId,
            employeeName: selectedShift.user.name,
            startTime: selectedShift.startTime,
            endTime: selectedShift.endTime,
            breaks: [],
          }],
          reused: false,
        }),
      });
    });

    await loginAsSeedAdmin(page, `/dashboard/scheduling?date=2026-07-09&location=${v2Ids.uptown}`);
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    await expect.poll(() => requestedLocationIds.at(-1)).toBe(v2Ids.uptown);
    await expect(page.locator('.timeline-row[data-resource-title="Mock Manager"] .shift-block')).toBeVisible();

    const locationSelect = page.getByLabel('Schedule location');
    await expect(locationSelect).toHaveValue(v2Ids.uptown);
    const requestsBeforeSwitch = requestedLocationIds.length;
    await locationSelect.selectOption(v2Ids.downtown);
    await page.getByRole('button', { name: 'Advanced settings' }).click();
    const generateButton = page.getByRole('button', { name: /Generate breaks/ });
    await expect(generateButton).toBeDisabled();
    expect(generatedShiftIds).toEqual([]);
    releaseDowntownLoad?.();
    await expect.poll(() => requestedLocationIds.at(-1)).toBe(v2Ids.downtown);
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    await expect(page.getByText(/Breaks generated and saved for 1 shift/)).toBeVisible();
    await expect(locationSelect).toHaveValue(v2Ids.downtown);
    expect(generatedLocationId).toBe(v2Ids.downtown);
    expect(generatedShiftIds).toEqual([v2Ids.downtownShift]);
    expect(requestedLocationIds.slice(requestsBeforeSwitch)).toEqual(
      expect.arrayContaining([v2Ids.downtown]),
    );
    expect(
      requestedLocationIds.slice(requestsBeforeSwitch).every((locationId) => locationId === v2Ids.downtown),
      `Requests after switching location: ${requestedLocationIds.slice(requestsBeforeSwitch).join(', ')}`,
    ).toBe(true);
  });

  test('keeps the selected calendar scope when an older auto-schedule job completes', async ({ page }) => {
    const shiftLoadStarts: string[] = [];
    let releaseSolvePoll: (() => void) | undefined;
    let markSolvePollStarted: (() => void) | undefined;
    let completedSolvePolls = 0;
    const solvePollGate = new Promise<void>((resolve) => {
      releaseSolvePoll = resolve;
    });
    const solvePollStarted = new Promise<void>((resolve) => {
      markSolvePollStarted = resolve;
    });

    await page.route('**/api/v2/schedule-board?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has('date')) shiftLoadStarts.push(url.searchParams.get('date') ?? '');
      await route.fallback();
    });
    await page.route('**/api/v2/schedules/*/solve-jobs/*', async (route) => {
      markSolvePollStarted?.();
      await solvePollGate;
      completedSolvePolls += 1;
      const pathParts = new URL(route.request().url()).pathname.split('/');
      const scheduleId = pathParts.at(-3) ?? v2Ids.downtownSchedule;
      const jobId = pathParts.at(-1) ?? v2Ids.recoveryJob;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId,
          scheduleId,
          locationId: v2Ids.downtown,
          status: 'SUCCEEDED',
          statusReason: null,
          retryCount: 0,
          resultShiftCount: 1,
          publicationStatus: 'DRAFT',
          startedAt: '2026-07-09T18:00:00.000Z',
          completedAt: '2026-07-09T18:00:01.000Z',
          statusUrl: `/api/v2/schedules/${scheduleId}/solve-jobs/${jobId}`,
        }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/scheduling?date=2026-07-09');
    await page.getByRole('button', { name: /Add shift/ }).click();
    const shiftForm = page.locator('form.shift-form');
    await shiftForm.locator('select').first().selectOption({ label: 'Mock Staff' });
    const demandDate = await shiftForm.locator('input[type="date"]').inputValue();
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();
    await expect(page.getByText(/Shift created and saved/)).toBeVisible();
    await saveDemandWindow(page, demandDate);

    await page.getByRole('button', { name: /Auto-schedule/ }).click();
    await page.getByRole('button', { name: 'Confirm replace' }).click();
    await solvePollStarted;

    const dateInput = page.locator('input[type="date"]:not([disabled])').first();
    await dateInput.fill('2026-08-01');
    await expect(page.getByText(/No saved shifts in this range/)).toBeVisible();
    const loadCountAfterScopeChange = shiftLoadStarts.length;

    releaseSolvePoll?.();
    await expect.poll(() => completedSolvePolls).toBe(1);
    await page.waitForTimeout(250);

    await expect(dateInput).toHaveValue('2026-08-01');
    await expect(page.getByText(/No saved shifts in this range/)).toBeVisible();
    await expect(page.getByText(/Auto-schedule solved/)).toHaveCount(0);
    expect(shiftLoadStarts).toHaveLength(loadCountAfterScopeChange);
  });

  test('reload resumes the same auto-schedule job without a duplicate paid request', async ({ page }) => {
    let queueRequests = 0;
    let solvePolls = 0;
    const attemptKeys: string[] = [];
    let queuedScheduleId = v2Ids.downtownSchedule;
    await page.route('**/api/v2/schedules/*/solve-jobs', async (route) => {
      queueRequests += 1;
      attemptKeys.push(route.request().headers()['idempotency-key'] ?? '');
      queuedScheduleId = new URL(route.request().url()).pathname.split('/').at(-2) ?? queuedScheduleId;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: v2Ids.recoveryJob,
          status: 'QUEUED',
          statusUrl: `/api/v2/schedules/${queuedScheduleId}/solve-jobs/${v2Ids.recoveryJob}`,
        }),
      });
    });
    await page.route(`**/api/v2/schedules/*/solve-jobs/${v2Ids.recoveryJob}`, async (route) => {
      solvePolls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: v2Ids.recoveryJob,
          scheduleId: queuedScheduleId,
          locationId: v2Ids.downtown,
          status: solvePolls === 1 ? 'RUNNING' : 'SUCCEEDED',
          statusReason: null,
          retryCount: 0,
          resultShiftCount: 1,
          publicationStatus: 'DRAFT',
          startedAt: '2026-07-09T18:00:00.000Z',
          completedAt: solvePolls === 1 ? null : '2026-07-09T18:00:01.000Z',
          statusUrl: `/api/v2/schedules/${queuedScheduleId}/solve-jobs/${v2Ids.recoveryJob}`,
        }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/scheduling?date=2026-07-09');
    await page.getByRole('button', { name: /Add shift/ }).click();
    const shiftForm = page.locator('form.shift-form');
    await shiftForm.locator('select').first().selectOption({ label: 'Mock Staff' });
    const demandDate = await shiftForm.locator('input[type="date"]').inputValue();
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();
    await saveDemandWindow(page, demandDate);
    await page.getByRole('button', { name: /Auto-schedule/ }).click();
    await page.getByRole('button', { name: 'Confirm replace' }).click();
    await expect.poll(() => solvePolls).toBe(1);

    await page.reload();

    await expect(page.getByText(/Auto-schedule solved/)).toBeVisible();
    expect(queueRequests).toBe(1);
    expect(attemptKeys[0]).toBeTruthy();
    expect(solvePolls).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem('lunchlineup:auto-schedule-recovery:v1'))).toBeNull();
  });

  test('renders paused resume and delinquent portal recovery from normalized billing state', async ({ page }) => {
    let recoveryAction: 'resume' | 'portal' = 'resume';

    await page.route('**/api/v2/billing/features', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          planTier: 'GROWTH',
          effectivePlanTier: 'FREE',
          status: 'PAST_DUE',
          stripeSubscriptionActive: false,
          stripeSubscriptionPresent: true,
          subscriptionRecoveryAction: recoveryAction,
          usageCredits: 0,
          features: {
            scheduling: {
              enabled: false,
              source: 'disabled',
              reason: 'An active paid subscription and separately purchased usage credits are required.',
              creditCost: 1,
            },
          },
        }),
      });
    });

    await openBillingSettings(page);

    await expect(page.getByRole('button', { name: 'Resume paused subscription' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Payment & invoices' })).toBeVisible();
    await expect(page.getByText('An active paid subscription and separately purchased usage credits are required.')).toBeVisible();
    const purchaseButtons = page
      .locator('section[aria-labelledby=credit-packs-title]')
      .getByRole('button', { name: 'Purchase' });
    await expect(purchaseButtons).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(purchaseButtons.nth(index)).toBeDisabled();
    }

    recoveryAction = 'portal';
    await page.getByRole('button', { name: 'Refresh billing' }).click();

    await expect(page.getByRole('button', { name: 'Resolve payment issue' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume paused subscription' })).toHaveCount(0);
  });

  test('starts credit-pack checkout from purchased-credit billing state without making a real charge', async ({ page }) => {
    await page.route('https://checkout.stripe.com/mock-credit-pack', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Mock Stripe Checkout</title><h1>Mock Stripe Checkout</h1><p>No payment was submitted.</p>',
      });
    });

    await openBillingSettings(page);

    await expect(page.getByText('Enabled - Credits', { exact: true })).toHaveCount(3);
    await expect(page.getByText(
      'Active paid subscription and separately purchased credits authorize this billable feature.',
      { exact: true },
    )).toHaveCount(3);
    const purchasedCredits = page.getByText('Purchased credits', { exact: true }).locator('..');
    await expect(purchasedCredits.getByText('500', { exact: true })).toBeVisible();

    const creditPackSection = page.locator('section[aria-labelledby=credit-packs-title]');
    await expect(creditPackSection.getByText(
      'Subscriptions provide plan access. Credits are purchased separately; subscriptions include no recurring or unlimited credits.',
      { exact: true },
    )).toBeVisible();
    const selectedPack = creditPackSection
      .getByText('500 credits', { exact: true })
      .locator('xpath=../..');
    await expect(selectedPack.getByRole('button', { name: 'Purchase' })).toBeEnabled();

    const checkoutRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v2/billing/credit-packs/checkout'
    ));
    await selectedPack.getByRole('button', { name: 'Purchase' }).click();
    const checkoutRequest = await checkoutRequestPromise;

    expect(checkoutRequest.postDataJSON()).toEqual({ code: 'CREDITS_500' });
    await expect(page).toHaveURL('https://checkout.stripe.com/mock-credit-pack');
    await expect(page.getByRole('heading', { name: 'Mock Stripe Checkout' })).toBeVisible();
    await expect(page.getByText('No payment was submitted.')).toBeVisible();

    await page.goto('/dashboard/settings?billing=credit-purchase-success&session_id=cs_test_mock_credit_pack');
    await expect(page.getByRole('tab', { name: 'Billing' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(
      'Stripe Checkout completed. This return does not confirm fulfillment; rely on the server-reported balance below.',
      { exact: true },
    )).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/settings$/);
    await expect(page.getByText('Purchased credits', { exact: true }).locator('..').getByText('500', { exact: true })).toBeVisible();
  });

  test('keeps settings writes disabled after a transient read failure until retry hydrates them', async ({ page }) => {
    let settingsReads = 0;
    let settingsWrites = 0;
    await page.route('**/api/v2/settings', async (route) => {
      settingsReads += 1;
      if (settingsReads === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Settings temporarily unavailable.' }) });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/v2/settings/**', async (route) => {
      if (route.request().method() === 'PUT') settingsWrites += 1;
      await route.continue();
    });

    await loginAsSeedAdmin(page, '/dashboard/settings');

    await expect(page.getByText('Settings changes are disabled until the current values load.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    await expect(page.getByLabel('Organization Name')).toBeDisabled();
    expect(settingsReads).toBe(1);
    expect(settingsWrites).toBe(0);

    await page.getByRole('button', { name: 'Retry settings load' }).click();
    await expect(page.getByLabel('Organization Name')).toHaveValue('E2E Operations Diner');
    await expect(page.getByLabel('Organization Name')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(settingsReads).toBe(2);
    expect(settingsWrites).toBe(0);
  });

  test('keeps demand writes disabled after a transient read failure until retry hydrates them', async ({ page }) => {
    let demandReads = 0;
    let demandWrites = 0;
    let demandAvailable = false;
    await page.route('**/api/v2/schedules/*/demand-windows', async (route) => {
      if (route.request().method() === 'PUT') {
        demandWrites += 1;
        await route.continue();
        return;
      }
      demandReads += 1;
      if (!demandAvailable) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Demand temporarily unavailable.' }) });
        return;
      }
      await route.continue();
    });

    await loginAsSeedAdmin(page, '/dashboard/scheduling');
    await page.getByRole('button', { name: 'Create schedule' }).click();

    const editor = page.getByLabel('Schedule demand setup').first();
    await expect(editor.getByText('Existing demand has not been replaced.')).toBeVisible();
    await editor.getByRole('button', { name: 'Edit demand' }).click();
    await expect(editor.getByRole('button', { name: 'Add window' })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Save demand' })).toBeDisabled();
    expect(demandWrites).toBe(0);

    demandAvailable = true;
    await editor.getByRole('button', { name: 'Retry demand load' }).click();
    await expect(editor.getByRole('button', { name: 'Add window' })).toBeEnabled();
    await expect(editor.getByRole('button', { name: 'Save demand' })).toBeEnabled();
    expect(demandReads).toBeGreaterThanOrEqual(2);
    expect(demandWrites).toBe(0);
  });

  test('enrolls and disables MFA from account security settings', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/settings');

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Security' }).click();
    await expect(page.getByRole('heading', { name: 'Multi-factor authentication' })).toBeVisible();
    await expect(page.getByText('Not enrolled')).toBeVisible();

    await page.getByRole('button', { name: /Start MFA setup/ }).click();
    await expect(page.getByLabel('Manual setup key')).toHaveValue('JBSWY3DPEHPK3PXP');
    await page.getByLabel('Authenticator code').fill('123456');
    await page.getByRole('button', { name: /Verify and enable/ }).click();

    await expect(page.getByText('MFA is enabled.')).toBeVisible();
    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
    await expect(page.getByText('LL-4F8K-92HD')).toBeVisible();

    await page.getByLabel('Authenticator or backup code').fill('123456');
    await page.getByRole('button', { name: /Disable MFA/ }).click();

    await expect(page.getByText('MFA is disabled.')).toBeVisible();
    await expect(page.getByText('Not enrolled')).toBeVisible();
  });

  test('uses the deletion response as a public receipt and ends the browser session', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/settings');

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
    await expect(page.getByText('Open')).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download export' }).click();
    expect((await download).suggestedFilename()).toBe('e2e-operations-account-export-2026-07-11.ndjson');
    await expect(page.getByText('Account export download started.')).toBeVisible();

    await page.getByLabel('Confirm workspace slug').first().fill('e2e-operations');
    await page.getByLabel('Reason').fill('readiness test');
    await page.getByRole('button', { name: 'Cancel renewal' }).click();
    await expect(page.getByText(/Subscription renewal cancelled/)).toBeVisible();
    await expect(page.locator('.surface-muted').filter({ hasText: 'Lifecycle' }).getByText('Open')).toBeVisible();

    let postDeleteStatusReads = 0;
    await page.route('**/api/v2/admin/account/status', async (route) => {
      postDeleteStatusReads += 1;
      await route.continue();
    });
    const deletionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === '/api/v2/admin/account'
    ));
    const localLogoutResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/auth/logout'
    ));

    await page.getByLabel('Confirm workspace slug').nth(1).fill('e2e-operations');
    await page.getByRole('button', { name: 'Request deletion' }).click();

    const deletionResponse = await deletionResponsePromise;
    const deletionPayload = await deletionResponse.json() as {
      id: string;
      slug: string;
      deletionRequestedAt: string;
      retention: {
        applicationDataEligibleAt: string;
        databaseBackupEligibleAt: string;
        securityLogEligibleAt: string;
        fullDatabasePurgeEligibleAt: string;
      };
    };
    const localLogoutResponse = await localLogoutResponsePromise;
    expect(localLogoutResponse.status()).toBe(204);
    await expect(page).toHaveURL(/\/auth\/account-deleted$/);
    await expect(page.getByRole('heading', { name: 'Account deletion requested' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retention and purge schedule' })).toBeVisible();
    await expect(page.getByText('Application data purge eligible')).toBeVisible();
    await expect(page.getByText('Full database purge eligible')).toBeVisible();
    await expect(page.getByRole('link', { name: 'support@lunchlineup.test' })).toHaveAttribute(
      'href',
      'mailto:support@lunchlineup.test',
    );
    expect(postDeleteStatusReads).toBe(0);

    const receiptUrl = new URL(page.url());
    expect(receiptUrl.search).toBe('');
    expect(receiptUrl.hash).toBe('');
    expect(page.url()).not.toContain(deletionPayload.id);
    expect(page.url()).not.toContain(deletionPayload.slug);

    const serializedReceipt = await page.evaluate(() => (
      window.sessionStorage.getItem('lunchlineup.account-deletion-receipt.v1')
    ));
    expect(serializedReceipt).not.toBeNull();
    expect(JSON.parse(serializedReceipt ?? '{}')).toMatchObject({
      version: 1,
      receipt: {
        deletionRequestedAt: deletionPayload.deletionRequestedAt,
        applicationDataEligibleAt: deletionPayload.retention.applicationDataEligibleAt,
        databaseBackupEligibleAt: deletionPayload.retention.databaseBackupEligibleAt,
        securityLogEligibleAt: deletionPayload.retention.securityLogEligibleAt,
        fullDatabasePurgeEligibleAt: deletionPayload.retention.fullDatabasePurgeEligibleAt,
      },
    });
    expect(serializedReceipt).not.toContain(deletionPayload.id);
    expect(serializedReceipt).not.toContain(deletionPayload.slug);

    const remainingCookieNames = (await page.context().cookies()).map((cookie) => cookie.name);
    expect(remainingCookieNames).not.toContain('access_token');
    expect(remainingCookieNames).not.toContain('refresh_token');
    expect(remainingCookieNames).not.toContain('csrf_token');
  });

  test('redirects unverified enrolled MFA sessions to the MFA gate and continues after verification', async ({ page }) => {
    await loginWithPin(page, {
      username: 'e2e.mfa',
      pin: '135790',
      next: '/dashboard/scheduling?date=2026-07-09',
      expectedPath: '/mfa',
    });

    const gateUrl = new URL(page.url());
    expect(gateUrl.pathname).toBe('/mfa');
    expect(gateUrl.searchParams.get('next')).toBe('/dashboard/scheduling?date=2026-07-09');

    await expect(page.getByRole('heading', { name: 'Verify your sign-in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Contact LunchLineup support' })).toHaveAttribute('href', 'mailto:support@lunchlineup.test');
    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(page.locator('.mfa-error[role="alert"]')).toHaveText('Invalid MFA code.');
    await page.getByLabel('Authentication code').fill('123456');
    await page.getByRole('button', { name: 'Verify and continue' }).click();

    await expect(page).toHaveURL(/\/dashboard\/scheduling\?date=2026-07-09/);
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  });

  test('offers enrollment for required MFA sessions that are not enrolled', async ({ page }) => {
    await loginWithPin(page, {
      username: 'e2e.unenrolled',
      pin: '975310',
      next: '/dashboard',
      expectedPath: '/mfa',
    });

    const gateUrl = new URL(page.url());
    expect(gateUrl.pathname).toBe('/mfa');
    expect(gateUrl.searchParams.get('next')).toBe('/dashboard');

    await expect(page.getByRole('heading', { name: 'Set up multi-factor authentication' })).toBeVisible();
    await expect(page.getByLabel('Manual setup key')).toHaveValue('JBSWY3DPEHPK3PXP');
    await page.getByLabel('Authenticator code').fill('123456');
    await page.getByRole('button', { name: 'Enable MFA and continue' }).click();

    await expect(page).toHaveURL(/\/mfa/);
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    await expect(page.getByText('LL-4F8K-92HD')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy codes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print codes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to LunchLineup' })).toBeDisabled();
    await page.getByLabel('I saved these recovery codes in a secure place.').check();
    await page.getByRole('button', { name: 'Continue to LunchLineup' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('E2E Operations Diner', { exact: true })).toBeVisible();
  });
});

test.describe('Mobile schedule publish readiness', () => {
  test.skip(runFullStack, 'DB-backed authenticated specs cover this path when E2E_FULL_STACK=1.');
  test.skip(!runMockReadiness, 'Mock API readiness runs only when Playwright starts the local web app.');
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || !isMobile, 'Runs on the configured mobile Chromium project.');

  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/v1/__e2e/reset');
    expect(response.ok(), `mock API reset returned ${response.status()}`).toBeTruthy();
  });

  test('confirms the bound publish preflight and exact settlement on mobile', async ({ page }) => {
    await loginAsSeedAdmin(page, '/dashboard/scheduling');
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();

    await page.getByRole('button', { name: /Add shift/ }).click();
    const shiftForm = page.locator('form.shift-form');
    await shiftForm.locator('select').first().selectOption({ label: 'Mock Staff' });
    await shiftForm.locator('input[type="time"]').first().fill('10:00');
    await shiftForm.locator('input[type="time"]').nth(1).fill('18:00');
    await shiftForm.getByRole('button', { name: 'Create shift' }).click();
    await expect(page.getByText(/Shift created and saved/)).toBeVisible();

    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.locator('.scheduler-publish-row__cost').getByText('Configured total: 1 credit')).toBeVisible();
    const publishRequestPromise = page.waitForRequest((request) => (
      request.method() === 'POST'
      && /\/api\/v2\/schedules\/[0-9a-f-]{36}\/publications$/.test(new URL(request.url()).pathname)
    ));
    await page.getByRole('button', { name: 'Confirm - 1 credit' }).click();
    const publishRequest = await publishRequestPromise;

    expect(publishRequest.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(publishRequest.postDataJSON()).toEqual({
      acceptedContract: {
        version: 1,
        totalConfiguredCost: 1,
        scheduleCost: 1,
        matchingWebhookDeliveryCount: 0,
        matchingWebhookDeliveryUnitCost: 0,
        matchingWebhookDeliveryCost: 0,
      },
    });
    await expect(page.locator('.scheduler-publish-row__settlement')).toContainText('1 credit was debited exactly once');

    const billingResponse = await page.request.get('/api/v1/billing/features');
    expect(await billingResponse.json()).toMatchObject({ usageCredits: 499 });
  });
});
