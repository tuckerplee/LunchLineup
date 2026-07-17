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

async function installLunchScopes(context: BrowserContext) {
  await context.route(/\/api\/v1\/locations\?limit=200$/, async (route) => {
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
  await context.route(/\/api\/v1\/lunch-breaks\?.+/, async (route) => {
    const locationId = new URL(route.request().url()).searchParams.get('locationId') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [scopedRow(locationId)],
        pagination: { hasMore: false, nextCursor: null },
      }),
    });
  });
}

async function openSetupReview(page: Page, staffName: string) {
  await page.getByRole('button', { name: 'Auto Break' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: new RegExp(staffName) })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('button', { name: 'Continue to planner' })).toBeEnabled();
}

async function enterPlanner(page: Page, staffName: string) {
  await openSetupReview(page, staffName);
  await page.getByRole('button', { name: 'Continue to planner' }).click();
  await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
}

test.describe('Lunch/break durable recovery', () => {
  test.skip(runFullStack, 'The focused recovery contract uses deterministic local API routes.');

  test('reuses one generation A key and debit across A-to-B-to-A, lost response, and reload', async ({ context, page }) => {
    await installLunchScopes(context);
    await context.route('**/api/v1/lunch-breaks/setup-shifts', async (route) => {
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
    await context.route('**/api/v1/lunch-breaks/generate', async (route) => {
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
    await context.route('**/api/v1/lunch-breaks/setup-shifts', async (route) => {
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
    await context.route('**/api/v1/lunch-breaks/generate', async (route) => {
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

    await Promise.all([
      page.getByRole('button', { name: 'Continue to planner' }).click(),
      secondPage.getByRole('button', { name: 'Continue to planner' }).click(),
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
