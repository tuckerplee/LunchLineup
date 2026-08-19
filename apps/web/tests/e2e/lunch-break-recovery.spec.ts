import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { loginAsSeedAdmin, runFullStack } from './support';

const policy = {
  break1OffsetMinutes: 120,
  lunchOffsetMinutes: 240,
  break2OffsetMinutes: 360,
  break1DurationMinutes: 10,
  lunchDurationMinutes: 30,
  break2DurationMinutes: 10,
  timeStepMinutes: 5,
};

function scopedRow(locationId: string) {
  const uptown = locationId === 'loc-uptown';
  return {
    shiftId: uptown ? 'shift-uptown' : 'shift-downtown',
    userId: uptown ? 'user-uptown' : 'user-downtown',
    employeeName: uptown ? 'Scope B Staff' : 'Scope A Staff',
    startTime: '2026-07-16T13:00:00.000Z',
    endTime: '2026-07-16T21:00:00.000Z',
    breaks: [],
  };
}

async function installLunchScopes(
  context: BrowserContext,
  rowsForLocation: (locationId: string) => ReturnType<typeof scopedRow>[] = (locationId) => [scopedRow(locationId)],
) {
  await context.route(/\/api\/v2\/locations\?limit=200$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'loc-downtown', name: 'Harbor Grill', timezone: 'America/Los_Angeles' },
          { id: 'loc-uptown', name: 'Uptown Kitchen', timezone: 'America/New_York' },
        ],
        pagination: { hasMore: false, nextCursor: null },
      }),
    });
  });
  await context.route(/\/api\/v2\/lunch-breaks\?.+/, async (route) => {
    const locationId = new URL(route.request().url()).searchParams.get('locationId') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: rowsForLocation(locationId),
        pagination: { hasMore: false, nextCursor: null },
      }),
    });
  });
}

async function openSetupReview(page: Page, staffName: string) {
  await page.getByRole('button', { name: 'Auto Break' }).click();
  await page.getByRole('button', { name: 'Select staff' }).click();
  await expect(page.getByRole('button', { name: new RegExp(staffName) })).toBeVisible();
  await page.getByRole('button', { name: /Review \d+ shifts?/ }).click();
  await expect(page.getByRole('button', { name: /Save \d+ setup shift records? · exactly \d+ usage credits?/ })).toBeEnabled();
}

async function enterPlanner(page: Page, staffName: string) {
  await openSetupReview(page, staffName);
  page.once('dialog', async (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Save \d+ setup shift records? · exactly \d+ usage credits?/ }).click();
  await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
}

test.describe('Lunch/break durable recovery', () => {
  test.skip(runFullStack, 'The focused recovery contract uses deterministic local API routes.');

  test('preserves a schedule-backed overnight shift and requires exact-cost confirmation before setup mutation', async ({ context, page }) => {
    const overnight = {
      ...scopedRow('loc-downtown'),
      shiftId: 'shift-overnight',
      userId: 'user-overnight',
      employeeName: 'Night Staff',
      startTime: '2026-07-17T06:00:00.000Z',
      endTime: '2026-07-17T14:00:00.000Z',
    };
    await installLunchScopes(context, () => [overnight]);
    const setupBodies: Array<{ rows: Array<{ startTime: string; endTime: string }> }> = [];
    await context.route('**/api/v2/lunch-breaks/setup-shifts', async (route) => {
      setupBodies.push(route.request().postDataJSON() as { rows: Array<{ startTime: string; endTime: string }> });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ shiftIds: ['shift-overnight'] }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await openSetupReview(page, 'Night Staff');

    await expect(page.getByText('Overnight · 23:00 to 07:00 next day')).toBeVisible();
    await expect(page.getByLabel('Start time for Night Staff')).toHaveValue('23:00');
    await expect(page.getByLabel('Start time for Night Staff')).toBeDisabled();
    await expect(page.getByLabel('End day for Night Staff')).toHaveValue('1');
    await expect(page.getByLabel('End day for Night Staff')).toBeDisabled();
    await expect(page.getByLabel('End time for Night Staff')).toHaveValue('07:00');
    await expect(page.getByLabel('End time for Night Staff')).toBeDisabled();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open Calendar to correct this shift' })).toHaveAttribute('href', '/dashboard/scheduling');
    expect(setupBodies).toHaveLength(0);

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('save 1 unchanged schedule-backed shift record');
      expect(dialog.message()).toContain('uses exactly 1 usage credit');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Save 1 setup shift record · exactly 1 usage credit' }).click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();

    expect(setupBodies).toHaveLength(1);
    expect(setupBodies[0].rows).toEqual([expect.objectContaining({
      startTime: overnight.startTime,
      endTime: overnight.endTime,
    })]);
    await expect(page.locator('.schedule-header .schedule-toggle')).toHaveCount(0);
  });

  test('shows and searches every scheduled staff member beyond the former 24-person cap', async ({ context, page }) => {
    await installLunchScopes(context, (locationId) => Array.from({ length: 30 }, (_, index) => ({
      ...scopedRow(locationId),
      shiftId: `shift-${index + 1}`,
      userId: `user-${index + 1}`,
      employeeName: `Roster Person ${String(index + 1).padStart(2, '0')}`,
    })));

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await page.getByRole('button', { name: 'Auto Break' }).click();
    await page.getByRole('button', { name: 'Select staff' }).click();

    await expect(page.getByText('Showing 30 of 30 staff')).toBeVisible();
    await expect(page.getByRole('button', { name: /Roster Person 30/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select scheduled (30)' })).toBeVisible();
    await page.getByLabel('Search staff').fill('Roster Person 30');
    await expect(page.getByText('Showing 1 of 30 staff')).toBeVisible();
    await expect(page.getByRole('button', { name: /Roster Person 30/ })).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await page.getByRole('button', { name: 'Select scheduled (30)' }).click();
    await expect(page.getByText('30 selected')).toBeVisible();
  });

  test('reuses one generation A key and debit across A-to-B-to-A, lost response, and reload', async ({ context, page }) => {
    await installLunchScopes(context);
    await context.route('**/api/v2/lunch-breaks/setup-shifts', async (route) => {
      const body = route.request().postDataJSON() as { locationId: string };
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          shiftIds: [body.locationId === 'loc-uptown' ? 'shift-uptown' : 'shift-downtown'],
        }),
      });
    });

    const calls: Array<{ locationId: string; key: string }> = [];
    const committed = new Map<string, Record<string, unknown>>();
    const debits = new Map<string, number>();
    let loseFirstAResponse = true;
    await context.route('**/api/v2/lunch-breaks/generate', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { locationId: string };
      const key = request.headers()['idempotency-key'] ?? '';
      calls.push({ locationId: body.locationId, key });
      let response = committed.get(key);
      if (!response) {
        response = {
          source: 'shared_schedule',
          persisted: true,
          policy,
          creditConsumption: { consumedCredits: 1, newBalance: 98 },
          data: [scopedRow(body.locationId)],
        };
        committed.set(key, response);
        debits.set(key, (debits.get(key) ?? 0) + 1);
      }
      if (body.locationId === 'loc-downtown' && loseFirstAResponse) {
        loseFirstAResponse = false;
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await enterPlanner(page, 'Scope A Staff');
    await page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click();
    await expect.poll(() => calls.filter((call) => call.locationId === 'loc-downtown').length).toBe(1);

    await page.getByLabel('Location').selectOption('loc-uptown');
    await enterPlanner(page, 'Scope B Staff');
    await page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click();
    await expect.poll(() => calls.filter((call) => call.locationId === 'loc-uptown').length).toBe(1);

    await page.getByLabel('Location').selectOption('loc-downtown');
    await page.reload();
    await enterPlanner(page, 'Scope A Staff');
    await page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click();
    await expect.poll(() => calls.filter((call) => call.locationId === 'loc-downtown').length).toBe(2);

    const aCalls = calls.filter((call) => call.locationId === 'loc-downtown');
    const bCalls = calls.filter((call) => call.locationId === 'loc-uptown');
    expect(aCalls[0].key).toBeTruthy();
    expect(aCalls[1].key).toBe(aCalls[0].key);
    expect(bCalls[0].key).toBeTruthy();
    expect(bCalls[0].key).not.toBe(aCalls[0].key);
    expect(debits.get(aCalls[0].key)).toBe(1);
    expect(debits.get(bCalls[0].key)).toBe(1);
    expect(committed.size).toBe(2);
  });

  test('uses one setup and generation identity when two pages submit the same intents together', async ({ context, page }) => {
    await installLunchScopes(context);
    const calls: Array<{ key: string; body: unknown }> = [];
    const committed = new Map<string, { shiftIds: string[] }>();
    let debitCount = 0;
    let releaseBoth: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => { releaseBoth = resolve; });
    await context.route('**/api/v2/lunch-breaks/setup-shifts', async (route) => {
      const key = route.request().headers()['idempotency-key'] ?? '';
      const body = route.request().postDataJSON();
      calls.push({ key, body });
      if (calls.length === 2) releaseBoth?.();
      await bothArrived;
      let response = committed.get(key);
      if (!response) {
        response = { shiftIds: ['server-created-shift'] };
        committed.set(key, response);
        debitCount += 1;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });
    const generationCalls: Array<{ key: string; body: unknown }> = [];
    const generationCommits = new Map<string, Record<string, unknown>>();
    let generationDebitCount = 0;
    let releaseBothGenerations: (() => void) | undefined;
    const bothGenerationsArrived = new Promise<void>((resolve) => { releaseBothGenerations = resolve; });
    await context.route('**/api/v2/lunch-breaks/generate', async (route) => {
      const key = route.request().headers()['idempotency-key'] ?? '';
      const body = route.request().postDataJSON();
      generationCalls.push({ key, body });
      if (generationCalls.length === 2) releaseBothGenerations?.();
      await bothGenerationsArrived;
      let response = generationCommits.get(key);
      if (!response) {
        response = {
          source: 'shared_schedule',
          persisted: true,
          policy,
          creditConsumption: { consumedCredits: 1, newBalance: 98 },
          data: [scopedRow('loc-downtown')],
        };
        generationCommits.set(key, response);
        generationDebitCount += 1;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    const secondPage = await context.newPage();
    await secondPage.goto('/dashboard/lunch-breaks');
    await openSetupReview(page, 'Scope A Staff');
    await openSetupReview(secondPage, 'Scope A Staff');

    page.once('dialog', async (dialog) => dialog.accept());
    secondPage.once('dialog', async (dialog) => dialog.accept());
    await Promise.all([
      page.getByRole('button', { name: /Save \d+ setup shift records? · exactly \d+ usage credits?/ }).click(),
      secondPage.getByRole('button', { name: /Save \d+ setup shift records? · exactly \d+ usage credits?/ }).click(),
    ]);
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    await expect(secondPage.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();

    expect(calls).toHaveLength(2);
    expect(calls[0].key).toBeTruthy();
    expect(calls[1].key).toBe(calls[0].key);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(committed.size).toBe(1);
    expect(debitCount).toBe(1);

    await Promise.all([
      page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click(),
      secondPage.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click(),
    ]);
    await expect.poll(() => generationCalls.length).toBe(2);
    expect(generationCalls[0].key).toBeTruthy();
    expect(generationCalls[1].key).toBe(generationCalls[0].key);
    expect(generationCalls[1].body).toEqual(generationCalls[0].body);
    expect(generationCommits.size).toBe(1);
    expect(generationDebitCount).toBe(1);
  });
});
