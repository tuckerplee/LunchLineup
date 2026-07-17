import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import {
  SETUP_SHIFTS_RECOVERY_KEY,
  SETUP_SHIFTS_RECOVERY_TTL_MS,
} from '../../app/dashboard/lunch-breaks/setup-shifts-recovery';
import { SHIFT_BREAK_UPDATE_RECOVERY_KEY_PREFIX } from '../../app/dashboard/lunch-breaks/shift-break-update-recovery';
import { dayWindow, loginAsSeedAdmin, repoRoot, runFullStack, seedTenant } from './support';

const axeSource = readFileSync(path.join(repoRoot, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

type AxeViolation = {
  id: string;
  impact?: string | null;
  nodes: Array<{ target: string[] }>;
};

async function expectAccessibleGuidedScreen(page: Page) {
  const levelOneHeading = page.getByRole('heading', { level: 1 });
  await expect(levelOneHeading).toHaveCount(1);
  await expect(levelOneHeading).toBeVisible();
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & {
      axe: {
        run: (
          context: Document,
          options: Record<string, unknown>,
        ) => Promise<{ violations: AxeViolation[] }>;
      };
    }).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      },
    });
    return result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  });
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

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

const lunchBreakPolicy = {
  break1OffsetMinutes: 120,
  lunchOffsetMinutes: 240,
  break2OffsetMinutes: 360,
  break1DurationMinutes: 10,
  lunchDurationMinutes: 30,
  break2DurationMinutes: 10,
  timeStepMinutes: 5,
};

function scopedLunchRow(locationId: string) {
  const isUptown = locationId === 'loc-uptown';
  return {
    shiftId: isUptown ? 'shift-uptown' : 'shift-downtown',
    userId: isUptown ? 'user-uptown' : 'user-downtown',
    employeeName: isUptown ? 'Scope B Staff' : 'Scope A Staff',
    startTime: '2026-07-16T13:00:00.000Z',
    endTime: '2026-07-16T21:00:00.000Z',
    breaks: [],
  };
}

async function installTwoLocationLunchScopes(page: Page) {
  await page.route(/\/api\/v1\/locations\?limit=200$/, async (route) => {
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
  await page.route(/\/api\/v1\/lunch-breaks\?.+/, async (route) => {
    const locationId = new URL(route.request().url()).searchParams.get('locationId') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [scopedLunchRow(locationId)],
        pagination: { hasMore: false, nextCursor: null },
      }),
    });
  });
}

async function expectScopeBPlannerReset(page: Page) {
  await expect(page.getByLabel('Location')).toHaveValue('loc-uptown');
  await expect(page.getByRole('button', { name: 'Auto Break' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toHaveCount(0);
  await expect(page.getByText(/Last run:/)).toHaveCount(0);
  await expect(page.getByText('Plan preview', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Standalone preview', { exact: true })).toHaveCount(0);
}

async function expectScopeBRowsInGuide(page: Page) {
  await page.getByRole('button', { name: 'Auto Break' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: /Scope B Staff/ })).toBeVisible();
  await expect(page.getByText('Scope A Staff', { exact: true })).toHaveCount(0);
}

test.describe('Lunch setup editor safety', () => {
  test.skip(runFullStack, 'The focused editor contract uses the local deterministic API fixture.');

  test('keeps 375px controls keyboard-accessible and reuses scoped recovery after a 403', async ({ page }) => {
    const setupKeys: string[] = [];
    const shiftBreakKeys: string[] = [];
    const shiftBreakBodies: unknown[] = [];
    let setupRequests = 0;
    let shiftBreakRequests = 0;
    let dayReadRequests = 0;
    await page.route(/\/api\/v1\/lunch-breaks\?.+/, async (route) => {
      dayReadRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{
            shiftId: 'shift-1',
            userId: 'user-mock-staff',
            employeeName: 'Mock Staff',
            startTime: '2026-07-16T13:00:00.000Z',
            endTime: '2026-07-16T21:00:00.000Z',
            breaks: [],
          }],
          pagination: { hasMore: false, nextCursor: null },
        }),
      });
    });
    await page.route('**/api/v1/lunch-breaks/setup-shifts', async (route) => {
      setupRequests += 1;
      setupKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (setupRequests === 1) {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            statusCode: 403,
            code: 'SETUP_SHIFTS_ENTITLEMENT_REQUIRED',
            message: 'Setup shifts require an active paid subscription and enough usage credits.',
            remediation: 'Activate a paid subscription or add usage credits, then retry the unchanged setup.',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ shiftIds: ['shift-1'] }),
      });
    });
    await page.route('**/api/v1/lunch-breaks/shift/shift-1', async (route) => {
      shiftBreakRequests += 1;
      shiftBreakKeys.push(route.request().headers()['idempotency-key'] ?? '');
      shiftBreakBodies.push(route.request().postDataJSON());
      if (shiftBreakRequests === 1) {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            statusCode: 403,
            code: 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED',
            message: 'Manual lunch/break replacement requires an active paid subscription and enough usage credits.',
            remediation: 'Add the configured credits, then retry the unchanged save.',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          shiftId: 'shift-1',
          userId: 'user-mock-staff',
          employeeName: 'Mock Staff',
          startTime: '2026-07-16T13:00:00.000Z',
          endTime: '2026-07-16T21:00:00.000Z',
          breaks: [{
            type: 'lunch',
            startTime: '2026-07-16T19:00:00.000Z',
            endTime: '2026-07-16T19:30:00.000Z',
            durationMinutes: 30,
            paid: false,
          }],
        }),
      });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await expectAccessibleGuidedScreen(page);
    await expect.poll(() => dayReadRequests).toBe(1);
    await page.waitForTimeout(100);
    expect(dayReadRequests).toBe(1);
    await page.getByRole('button', { name: 'Auto Break' }).click();

    const dateHeading = page.getByRole('heading', { name: /Start with today/ });
    await expect(dateHeading).toBeFocused();
    await expectAccessibleGuidedScreen(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    const scheduleHeading = page.getByRole('heading', { name: /Ready to create today/ });
    await expect(scheduleHeading).toBeFocused();
    await expectAccessibleGuidedScreen(page);
    const employeeToggle = page.getByRole('button', { name: /Mock Staff/ });
    await expect(employeeToggle).toHaveAttribute('aria-pressed', 'true');
    await employeeToggle.focus();
    await page.keyboard.press('Space');
    await expect(employeeToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
    await page.keyboard.press('Space');
    await expect(employeeToggle).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Next' }).click();

    const editorHeading = page.getByRole('heading', { name: 'Adjust who works when' });
    await expect(editorHeading).toBeFocused();
    await expectAccessibleGuidedScreen(page);
    const shiftSlider = page.getByRole('slider', { name: 'Shift window for Mock Staff' });
    await expect(shiftSlider).toHaveAttribute('aria-valuetext', '09:00 to 17:00');
    await shiftSlider.focus();
    await page.keyboard.press('ArrowRight');
    await expect(shiftSlider).toHaveAttribute('aria-valuetext', '09:15 to 17:15');
    await expect(page.getByLabel('Start time for Mock Staff')).toHaveValue('09:15');
    await expect(page.getByLabel('End time for Mock Staff')).toHaveValue('17:15');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const continueButton = page.getByRole('button', { name: 'Continue to planner' });
    await continueButton.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Subscription and credits required' })).toBeVisible();
    await expect(continueButton).toBeFocused();

    const retained = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) as Array<{
        attempt?: { key?: string; payloadFingerprint?: string };
        expiresAt?: number;
      }> : null;
    }, SETUP_SHIFTS_RECOVERY_KEY);
    expect(retained).toHaveLength(1);
    expect(retained?.[0]?.attempt?.key).toBe(setupKeys[0]);
    expect(retained?.[0]?.attempt?.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(retained?.[0]?.expiresAt).toBeGreaterThan(Date.now());
    expect(retained?.[0]?.expiresAt).toBeLessThanOrEqual(Date.now() + SETUP_SHIFTS_RECOVERY_TTL_MS);
    expect(JSON.stringify(retained)).not.toMatch(/requestBody|rows|Mock Staff|user-mock-staff|loc-downtown/);

    await continueButton.click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeFocused();
    await expectAccessibleGuidedScreen(page);
    expect(dayReadRequests).toBe(2);
    expect(setupKeys).toHaveLength(2);
    expect(setupKeys[0]).toBeTruthy();
    expect(setupKeys[1]).toBe(setupKeys[0]);
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), SETUP_SHIFTS_RECOVERY_KEY)).toBeNull();

    await page.locator('button.schedule-row').filter({ hasText: 'Mock Staff' }).click();
    await page.getByRole('checkbox', { name: 'Skip meal' }).uncheck();
    await page.getByLabel('Meal time for Mock Staff').fill('12:00');
    const saveShiftButton = page.getByRole('button', { name: 'Save shift' });
    await expect(saveShiftButton).toHaveAttribute('aria-describedby', 'shift-break-save-cost-shift-1');
    await saveShiftButton.click();
    await expect(page.getByRole('alert').filter({ hasText: 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED' })).toBeVisible();
    await expect(saveShiftButton).toBeFocused();

    const retainedShiftBreak = await page.evaluate((prefix) => {
      const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith(prefix));
      return key ? JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<string, any> : null;
    }, SHIFT_BREAK_UPDATE_RECOVERY_KEY_PREFIX);
    expect(retainedShiftBreak).toMatchObject({
      identity: {
        shiftId: 'shift-1',
        locationId: 'loc-downtown',
        tenantId: 'tenant-e2e',
        userId: 'user-admin',
        sessionId: 'session-admin',
      },
    });

    await saveShiftButton.click();
    await expect(saveShiftButton).toBeDisabled();
    expect(shiftBreakKeys).toHaveLength(2);
    expect(shiftBreakKeys[0]).toBeTruthy();
    expect(shiftBreakKeys[1]).toBe(shiftBreakKeys[0]);
    expect(shiftBreakBodies[1]).toEqual(shiftBreakBodies[0]);
    await expect.poll(() => page.evaluate((prefix) => (
      Object.keys(window.localStorage).some((key) => key.startsWith(prefix))
    ), SHIFT_BREAK_UPDATE_RECOVERY_KEY_PREFIX)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('retains A through B after A commits and loses its response, then replays A exactly once', async ({ page }) => {
    const setupCalls: Array<{ locationId: string; key: string }> = [];
    const committedKeys = new Set<string>();
    const committedWrites = new Map<string, number>();
    let abortFirstDowntownResponse = true;

    await installTwoLocationLunchScopes(page);
    await page.route('**/api/v1/lunch-breaks/setup-shifts', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { locationId: string };
      const key = request.headers()['idempotency-key'] ?? '';
      setupCalls.push({ locationId: body.locationId, key });

      const operation = `${body.locationId}:${key}`;
      if (!committedKeys.has(operation)) {
        committedKeys.add(operation);
        committedWrites.set(body.locationId, (committedWrites.get(body.locationId) ?? 0) + 1);
      }

      if (body.locationId === 'loc-downtown' && abortFirstDowntownResponse) {
        abortFirstDowntownResponse = false;
        await route.abort('failed');
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          shiftIds: [body.locationId === 'loc-uptown' ? 'shift-uptown' : 'shift-downtown'],
        }),
      });
    });

    const submitVisibleSetup = async (staffName: string) => {
      await page.getByRole('button', { name: 'Auto Break' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('button', { name: new RegExp(staffName) })).toBeVisible();
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Continue to planner' }).click();
    };

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await submitVisibleSetup('Scope A Staff');
    await expect(page.getByRole('alert').filter({ hasText: 'Setup shifts were not saved' })).toBeVisible();
    await expect.poll(() => setupCalls.filter((call) => call.locationId === 'loc-downtown').length).toBe(1);

    await page.getByLabel('Location').selectOption('loc-uptown');
    await expectScopeBPlannerReset(page);
    await submitVisibleSetup('Scope B Staff');
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    const retainedAfterB = await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) as Array<unknown> : [];
    }, SETUP_SHIFTS_RECOVERY_KEY);
    expect(retainedAfterB).toHaveLength(1);

    await page.getByLabel('Location').selectOption('loc-downtown');
    await expect(page.getByLabel('Location')).toHaveValue('loc-downtown');
    await expect(page.getByRole('button', { name: 'Auto Break' })).toBeVisible();
    await submitVisibleSetup('Scope A Staff');
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();

    const downtownCalls = setupCalls.filter((call) => call.locationId === 'loc-downtown');
    const uptownCalls = setupCalls.filter((call) => call.locationId === 'loc-uptown');
    expect(downtownCalls).toHaveLength(2);
    expect(downtownCalls[0].key).toBeTruthy();
    expect(downtownCalls[1].key).toBe(downtownCalls[0].key);
    expect(uptownCalls).toHaveLength(1);
    expect(uptownCalls[0].key).toBeTruthy();
    expect(uptownCalls[0].key).not.toBe(downtownCalls[0].key);
    expect(Object.fromEntries(committedWrites)).toEqual({
      'loc-downtown': 1,
      'loc-uptown': 1,
    });
    await expect(page.locator('button.schedule-row').filter({ hasText: 'Scope A Staff' })).toHaveCount(1);
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), SETUP_SHIFTS_RECOVERY_KEY)).toBeNull();
  });

  test('keeps B setup busy until its exactly-once mutation succeeds after stale A completes', async ({ page }) => {
    let releaseSetupA: (() => void) | undefined;
    let releaseSetupB: (() => void) | undefined;
    let releaseUptownRead: (() => void) | undefined;
    const setupGateA = new Promise<void>((resolve) => { releaseSetupA = resolve; });
    const setupGateB = new Promise<void>((resolve) => { releaseSetupB = resolve; });
    const uptownReadGate = new Promise<void>((resolve) => { releaseUptownRead = resolve; });
    const dayRequestLocations: string[] = [];
    const setupCalls: Array<{ locationId: string; key: string }> = [];
    const setupResponses = new Map<string, number>();
    const committedSetupOperations = new Set<string>();
    let uptownReadRequests = 0;

    await page.route(/\/api\/v1\/locations\?limit=200$/, async (route) => {
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
    await page.route(/\/api\/v1\/lunch-breaks\?.+/, async (route) => {
      const locationId = new URL(route.request().url()).searchParams.get('locationId') ?? '';
      dayRequestLocations.push(locationId);
      if (locationId === 'loc-uptown') {
        uptownReadRequests += 1;
        await uptownReadGate;
      }
      const isUptown = locationId === 'loc-uptown';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{
            shiftId: isUptown ? 'shift-uptown' : 'shift-downtown',
            userId: isUptown ? 'user-uptown' : 'user-mock-staff',
            employeeName: isUptown ? 'Scope B Staff' : 'Scope A Staff',
            startTime: '2026-07-16T13:00:00.000Z',
            endTime: '2026-07-16T21:00:00.000Z',
            breaks: [],
          }],
          pagination: { hasMore: false, nextCursor: null },
        }),
      });
    });
    await page.route('**/api/v1/lunch-breaks/setup-shifts', async (route) => {
      const body = route.request().postDataJSON() as { locationId: string };
      const key = route.request().headers()['idempotency-key'] ?? '';
      setupCalls.push({ locationId: body.locationId, key });
      await (body.locationId === 'loc-downtown' ? setupGateA : setupGateB);
      committedSetupOperations.add(`${body.locationId}:${key}`);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          shiftIds: [body.locationId === 'loc-uptown' ? 'shift-uptown' : 'shift-downtown'],
        }),
      });
      setupResponses.set(body.locationId, (setupResponses.get(body.locationId) ?? 0) + 1);
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await expect.poll(() => dayRequestLocations).toEqual(['loc-downtown']);
    await page.getByRole('button', { name: 'Auto Break' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: /Scope A Staff/ })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Continue to planner' }).click();
    await expect.poll(() => setupCalls.length).toBe(1);

    await page.getByLabel('Location').selectOption('loc-uptown');
    await expect.poll(() => uptownReadRequests).toBe(1);
    releaseUptownRead?.();
    await expectScopeBPlannerReset(page);
    await expectScopeBRowsInGuide(page);
    await page.getByRole('button', { name: 'Next' }).click();
    const continueB = page.getByRole('button', { name: 'Continue to planner' });
    await continueB.click();
    await expect.poll(() => setupCalls.filter((call) => call.locationId === 'loc-uptown').length).toBe(1);

    releaseSetupA?.();
    await expect.poll(() => setupResponses.get('loc-downtown') ?? 0).toBe(1);
    await expect(page.getByRole('button', { name: 'Saving setup shifts...' })).toBeDisabled();
    releaseSetupB?.();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();

    const downtownCall = setupCalls.filter((call) => call.locationId === 'loc-downtown');
    const uptownCall = setupCalls.filter((call) => call.locationId === 'loc-uptown');
    expect(downtownCall).toHaveLength(1);
    expect(uptownCall).toHaveLength(1);
    expect(uptownCall[0].key).toBeTruthy();
    expect(uptownCall[0].key).not.toBe(downtownCall[0].key);
    expect(setupResponses.get('loc-uptown')).toBe(1);
    expect([...committedSetupOperations].filter((operation) => operation.startsWith('loc-uptown:'))).toHaveLength(1);
    expect(dayRequestLocations).toEqual(['loc-downtown', 'loc-uptown', 'loc-uptown']);
    await expect(page.getByLabel('Location')).toHaveValue('loc-uptown');
  });

  test('keeps B scheduled generation busy until its exactly-once mutation succeeds after stale A completes', async ({ page }) => {
    let releaseGenerationA: (() => void) | undefined;
    let releaseGenerationB: (() => void) | undefined;
    const generationGateA = new Promise<void>((resolve) => { releaseGenerationA = resolve; });
    const generationGateB = new Promise<void>((resolve) => { releaseGenerationB = resolve; });
    const generationCalls: Array<{ locationId: string; key: string }> = [];
    const generationResponses = new Map<string, number>();
    const debits = new Map<string, number>();

    await installTwoLocationLunchScopes(page);
    await page.route('**/api/v1/lunch-breaks/setup-shifts', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ shiftIds: ['shift-downtown'] }),
      });
    });
    await page.route('**/api/v1/lunch-breaks/generate', async (route) => {
      const body = route.request().postDataJSON() as { locationId: string };
      const key = route.request().headers()['idempotency-key'] ?? '';
      generationCalls.push({ locationId: body.locationId, key });
      await (body.locationId === 'loc-downtown' ? generationGateA : generationGateB);
      if (!debits.has(key)) debits.set(key, 1);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          source: 'shared_schedule',
          persisted: true,
          policy: lunchBreakPolicy,
          creditConsumption: { consumedCredits: 1, newBalance: 98 },
          data: [{
            ...scopedLunchRow(body.locationId),
            breaks: [{
              type: 'lunch',
              startTime: '2026-07-16T17:00:00.000Z',
              endTime: '2026-07-16T17:30:00.000Z',
              durationMinutes: 30,
              paid: false,
            }],
          }],
        }),
      });
      generationResponses.set(body.locationId, (generationResponses.get(body.locationId) ?? 0) + 1);
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await page.getByRole('button', { name: 'Auto Break' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Continue to planner' }).click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    await page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click();
    await expect.poll(() => generationCalls.length).toBe(1);

    await page.getByLabel('Location').selectOption('loc-uptown');
    await expectScopeBPlannerReset(page);
    await expectScopeBRowsInGuide(page);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Continue to planner' }).click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    const generateB = page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first();
    await generateB.click();
    await expect.poll(() => generationCalls.filter((call) => call.locationId === 'loc-uptown').length).toBe(1);

    releaseGenerationA?.();
    await expect.poll(() => generationResponses.get('loc-downtown') ?? 0).toBe(1);
    await expect(page.getByRole('button', { name: 'Generating plan...' })).toBeDisabled();
    releaseGenerationB?.();
    await expect(page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first()).toBeEnabled();
    await expect(page.getByText(/Last run:/).first()).toBeVisible();

    const uptownCalls = generationCalls.filter((call) => call.locationId === 'loc-uptown');
    expect(uptownCalls).toHaveLength(1);
    expect(uptownCalls[0].key).toBeTruthy();
    expect(generationResponses.get('loc-uptown')).toBe(1);
    expect(debits.get(uptownCalls[0].key)).toBe(1);
  });

  test('keeps B manual generation busy until its exactly-once mutation succeeds after stale A completes', async ({ page }) => {
    let releaseGenerationA: (() => void) | undefined;
    let releaseGenerationB: (() => void) | undefined;
    const generationGateA = new Promise<void>((resolve) => { releaseGenerationA = resolve; });
    const generationGateB = new Promise<void>((resolve) => { releaseGenerationB = resolve; });
    const generationCalls: Array<{ ordinal: number; key: string }> = [];
    const generationResponses = new Map<number, number>();
    const debits = new Map<string, number>();

    await installTwoLocationLunchScopes(page);
    await page.route('**/api/v1/lunch-breaks/generate', async (route) => {
      const ordinal = generationCalls.length + 1;
      const key = route.request().headers()['idempotency-key'] ?? '';
      generationCalls.push({ ordinal, key });
      await (ordinal === 1 ? generationGateA : generationGateB);
      if (!debits.has(key)) debits.set(key, 1);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          source: 'standalone',
          persisted: false,
          policy: lunchBreakPolicy,
          creditConsumption: { consumedCredits: 1, newBalance: 98 },
          data: [{
            shiftId: null,
            userId: null,
            employeeName: ordinal === 1 ? 'Scope A Manual' : 'Scope B Manual',
            startTime: '2026-07-16T13:00:00.000Z',
            endTime: '2026-07-16T21:00:00.000Z',
            breaks: [{
              type: 'lunch',
              startTime: '2026-07-16T17:00:00.000Z',
              endTime: '2026-07-16T17:30:00.000Z',
              durationMinutes: 30,
              paid: false,
            }],
          }],
        }),
      });
      generationResponses.set(ordinal, (generationResponses.get(ordinal) ?? 0) + 1);
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await page.getByRole('button', { name: 'Manual fallback' }).first().click();
    await expect(page.getByText('Manual mode', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add shift' }).click();
    await page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first().click();
    await expect.poll(() => generationCalls.length).toBe(1);

    await page.getByLabel('Location').selectOption('loc-uptown');
    await expectScopeBPlannerReset(page);
    await page.getByRole('button', { name: 'Manual fallback' }).first().click();
    await expect(page.getByText('Manual mode', { exact: true })).toBeVisible();
    const generateB = page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first();
    await generateB.click();
    await expect.poll(() => generationCalls.length).toBe(2);

    releaseGenerationA?.();
    await expect.poll(() => generationResponses.get(1) ?? 0).toBe(1);
    await expect(page.getByRole('button', { name: 'Generating plan...' })).toBeDisabled();
    releaseGenerationB?.();
    await expect(page.getByRole('button', { name: 'Generate Lunch & Break Plan' }).first()).toBeEnabled();
    await expect(page.getByText('Scope B Manual', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Scope A Manual', { exact: true })).toHaveCount(0);

    const bCall = generationCalls[1];
    expect(bCall.key).toBeTruthy();
    expect(generationResponses.get(2)).toBe(1);
    expect(debits.get(bCall.key)).toBe(1);
  });

  test('reads each scope once, clears prior rows on a 503, and retries once with active location labels', async ({ page }) => {
    const dayRequestUrls: string[] = [];
    let uptownAttempts = 0;
    const downtownRows = [
      {
        shiftId: 'shift-downtown-1',
        userId: 'user-downtown-1',
        employeeName: 'Downtown One',
        startTime: '2026-07-16T13:00:00.000Z',
        endTime: '2026-07-16T21:00:00.000Z',
        breaks: [],
      },
      {
        shiftId: 'shift-downtown-2',
        userId: 'user-downtown-2',
        employeeName: 'Downtown Two',
        startTime: '2026-07-16T14:00:00.000Z',
        endTime: '2026-07-16T22:00:00.000Z',
        breaks: [],
      },
    ];

    await page.route(/\/api\/v1\/locations\?limit=200$/, async (route) => {
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
    await page.route(/\/api\/v1\/lunch-breaks\?.+/, async (route) => {
      const requestUrl = new URL(route.request().url());
      const locationId = requestUrl.searchParams.get('locationId');
      const cursor = requestUrl.searchParams.get('cursor');
      dayRequestUrls.push(`${locationId}:${cursor ?? 'first'}`);

      if (locationId === 'loc-uptown') {
        uptownAttempts += 1;
        if (uptownAttempts === 1) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Uptown day read unavailable.' }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [], pagination: { hasMore: false, nextCursor: null } }),
        });
        return;
      }

      const firstPage = cursor === null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [firstPage ? downtownRows[0] : downtownRows[1]],
          pagination: firstPage
            ? { hasMore: true, nextCursor: 'day-page-2' }
            : { hasMore: false, nextCursor: null },
        }),
      });
    });

    await loginAsSeedAdmin(page, '/dashboard/lunch-breaks');
    await expect.poll(() => dayRequestUrls).toEqual([
      'loc-downtown:first',
      'loc-downtown:day-page-2',
    ]);
    await page.waitForTimeout(100);
    expect(dayRequestUrls).toEqual([
      'loc-downtown:first',
      'loc-downtown:day-page-2',
    ]);

    await page.getByRole('button', { name: 'Auto Break' }).click();
    const dateGuide = page.getByRole('heading', { name: /Start with today/ }).locator('..');
    await expect(dateGuide.getByText('Harbor Grill', { exact: true })).toBeVisible();
    await expect(page.getByText('2 shifts available for this day')).toBeVisible();
    await expectAccessibleGuidedScreen(page);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Downtown One', { exact: true })).toBeVisible();
    await expect(page.getByText('Downtown Two', { exact: true })).toBeVisible();
    await expectAccessibleGuidedScreen(page);

    await page.getByLabel('Location').selectOption('loc-uptown');
    const unavailable = page.getByRole('alert').filter({ hasText: 'Lunch/break data unavailable for Uptown Kitchen' });
    await expect(unavailable).toBeVisible();
    await expect(page.getByText('Downtown One', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Downtown Two', { exact: true })).toHaveCount(0);
    await expect(page.getByText('2 shifts available for this day')).toHaveCount(0);
    expect(dayRequestUrls.filter((request) => request.startsWith('loc-uptown:'))).toEqual(['loc-uptown:first']);
    await expectAccessibleGuidedScreen(page);

    await expect(page.getByLabel('Location')).toHaveValue('loc-uptown');
    await expect(page.getByRole('heading', { name: /Choose how to start today/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import from Scheduling System/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toHaveCount(0);
    await expect(page.getByText(/Last run:/)).toHaveCount(0);
    await expect(page.getByText('Plan preview', { exact: true })).toHaveCount(0);
    await expectAccessibleGuidedScreen(page);
    await page.getByRole('button', { name: 'Retry selected day' }).click();
    await expect(unavailable).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Choose how to start today/ })).toBeVisible();
    await expect(page.getByText('Downtown One', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Downtown Two', { exact: true })).toHaveCount(0);
    await expect.poll(() => dayRequestUrls.filter((request) => request.startsWith('loc-uptown:'))).toHaveLength(2);
    await page.waitForTimeout(100);
    expect(dayRequestUrls.filter((request) => request.startsWith('loc-uptown:'))).toEqual([
      'loc-uptown:first',
      'loc-uptown:first',
    ]);
    await expectAccessibleGuidedScreen(page);
  });
});

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
