import { expect, test, type Page } from '@playwright/test';

import { apiJson, loginAsSeedAdmin, runFullStack, seedTenant } from './support';

const monthStart = '2026-07-01T00:00:00.000Z';
const monthEnd = '2026-08-01T00:00:00.000Z';
const secondPassDate = '2026-08-03';
const secondPassStart = '2026-08-03T00:00:00.000Z';
const secondPassEnd = '2026-08-04T00:00:00.000Z';

type ApiList<T> = { data?: T[] };
type UserRecord = { id: string; name: string; role: 'MANAGER' | 'STAFF' };
type LocationRecord = { id: string; name: string };
type ScheduleRecord = { id: string; startDate: string; endDate: string };
type ShiftRecord = { id: string; userId: string | null; startTime: string; endTime: string; breaks?: unknown[] };
type LunchBreakRow = { shiftId: string | null; userId: string | null; breaks: unknown[] };
type LunchBreakResponse = { source: string; persisted: boolean; data: LunchBreakRow[]; reused?: boolean };

test.describe.serial('Month-volume schedule and lunch/break workflows', () => {
  test.skip(!runFullStack, 'Set E2E_FULL_STACK=1 and E2E_SEED_COMMAND to run DB-backed workflow volume tests.');
  test.setTimeout(300_000);

  test.beforeEach(() => {
    seedTenant();
  });

  test('builds a 10-person month, persists breaks/lunches, deletes schedules, then builds break-only setup rows', async ({ page }) => {
    await loginAsSeedAdmin(page);
    const users = await createMonthUsers(page);
    expect(users).toHaveLength(10);

    const locations = await apiJson<ApiList<LocationRecord>>(page, 'GET', '/api/v1/locations');
    const location = locations.data?.[0];
    expect(location, 'seeded location').toBeTruthy();
    if (!location) return;

    const createdShiftIds: string[] = [];
    for (let day = 1; day <= 31; day += 1) {
      for (let userIndex = 0; userIndex < users.length; userIndex += 1) {
        const user = users[userIndex];
        const window = shiftWindow(2026, 6, day, userIndex);
        const shift = await apiJson<ShiftRecord>(page, 'POST', '/api/v1/shifts', {
          locationId: location.id,
          userId: user.id,
          role: user.role,
          startTime: window.startTime,
          endTime: window.endTime,
        }, undefined, { 'Idempotency-Key': `month-shift--` });
        createdShiftIds.push(shift.id);
      }
    }
    expect(createdShiftIds).toHaveLength(310);

    const monthShifts = await apiJson<ApiList<ShiftRecord>>(
      page,
      'GET',
      `/api/v1/shifts?startDate=${encodeURIComponent(monthStart)}&endDate=${encodeURIComponent(monthEnd)}`,
    );
    expect(monthShifts.data).toHaveLength(310);

    const schedulePayload = await apiJson<ApiList<ScheduleRecord>>(page, 'GET', '/api/v1/schedules');
    const julySchedules = (schedulePayload.data ?? []).filter(
      (schedule) => schedule.startDate >= monthStart && schedule.startDate < monthEnd,
    );
    expect(julySchedules).toHaveLength(31);

    const missingKey = await apiJson<{ message: string }>(page, 'POST', '/api/v1/lunch-breaks/generate', {
      shiftIds: createdShiftIds,
      persist: true,
    }, 400);
    expect(missingKey.message).toContain('Idempotency-Key header is required');

    const firstPlanBody = {
      shiftIds: createdShiftIds,
      persist: true,
    };
    const firstPlan = await apiJson<LunchBreakResponse>(
      page,
      'POST',
      '/api/v1/lunch-breaks/generate',
      firstPlanBody,
      201,
      { 'Idempotency-Key': 'month-break-plan-1' },
    );
    expect(firstPlan.source).toBe('shared_schedule');
    expect(firstPlan.persisted).toBe(true);
    expect(firstPlan.data).toHaveLength(310);
    expect(totalBreaks(firstPlan.data)).toBe(930);

    const replayedPlan = await apiJson<LunchBreakResponse>(
      page,
      'POST',
      '/api/v1/lunch-breaks/generate',
      firstPlanBody,
      201,
      { 'Idempotency-Key': 'month-break-plan-1' },
    );
    expect(replayedPlan.reused).toBe(true);
    expect(replayedPlan.data).toEqual(firstPlan.data);

    const persistedMonthBreaks = await apiJson<ApiList<LunchBreakRow>>(
      page,
      'GET',
      `/api/v1/lunch-breaks?startDate=${encodeURIComponent(monthStart)}&endDate=${encodeURIComponent(monthEnd)}`,
    );
    expect(persistedMonthBreaks.data).toHaveLength(310);
    expect(totalBreaks(persistedMonthBreaks.data ?? [])).toBe(930);

    for (const schedule of julySchedules) {
      await apiJson<void>(page, 'DELETE', `/api/v1/schedules/${schedule.id}`, undefined, 204);
    }

    const schedulesAfterDelete = await apiJson<ApiList<ScheduleRecord>>(page, 'GET', '/api/v1/schedules');
    expect(schedulesAfterDelete.data ?? []).toHaveLength(0);
    const monthShiftsAfterDelete = await apiJson<ApiList<ShiftRecord>>(
      page,
      'GET',
      `/api/v1/shifts?startDate=${encodeURIComponent(monthStart)}&endDate=${encodeURIComponent(monthEnd)}`,
    );
    expect(monthShiftsAfterDelete.data ?? []).toHaveLength(0);

    const setupRows = users.map((user, index) => ({
      userId: user.id,
      employeeName: user.name,
      ...shiftWindow(2026, 7, 3, index),
    }));
    const setupResult = await apiJson<{ shiftIds: string[] }>(page, 'POST', '/api/v1/lunch-breaks/setup-shifts', {
      locationId: location.id,
      rows: setupRows,
    }, undefined, { 'Idempotency-Key': 'month-setup-shifts-1' });
    expect(setupResult.shiftIds).toHaveLength(10);

    const secondPlan = await apiJson<LunchBreakResponse>(page, 'POST', '/api/v1/lunch-breaks/generate', {
      shiftIds: setupResult.shiftIds,
      persist: true,
    }, 201, { 'Idempotency-Key': 'month-break-plan-2' });
    expect(secondPlan.source).toBe('shared_schedule');
    expect(secondPlan.persisted).toBe(true);
    expect(secondPlan.data).toHaveLength(10);
    expect(totalBreaks(secondPlan.data)).toBe(30);

    const secondPassRows = await apiJson<ApiList<LunchBreakRow>>(
      page,
      'GET',
      `/api/v1/lunch-breaks?startDate=${encodeURIComponent(secondPassStart)}&endDate=${encodeURIComponent(secondPassEnd)}`,
    );
    expect(secondPassRows.data).toHaveLength(10);
    expect(totalBreaks(secondPassRows.data ?? [])).toBe(30);

    await page.goto(`/dashboard/scheduling?date=${secondPassDate}`);
    await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    await expect(page.locator('.shift-block')).toHaveCount(10, { timeout: 30_000 });
    await expect(page.locator('.shift-marker-lunch')).toHaveCount(10);
    await expect(page.locator('.shift-marker-break')).toHaveCount(20);
    await expect(page.getByText('Month Tester 01')).toBeVisible();
    await expect(page.getByText('Month Tester 10')).toBeVisible();
  });
});

async function createMonthUsers(page: Page): Promise<UserRecord[]> {
  const users: UserRecord[] = [];
  for (let index = 0; index < 10; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const role = index < 2 ? 'MANAGER' : 'STAFF';
    const user = await apiJson<UserRecord>(page, 'POST', '/api/v1/users/invite', {
      name: `Month Tester ${ordinal}`,
      username: `month.tester.${ordinal}`,
      pin: '135790',
      role,
    });
    users.push(user);
  }
  return users;
}

function shiftWindow(year: number, monthIndex: number, day: number, userIndex: number): { startTime: string; endTime: string } {
  const staggerMinutes = Math.floor(userIndex / 4) * 60 + (userIndex % 4) * 15;
  const startMs = Date.UTC(year, monthIndex, day, 16, staggerMinutes, 0, 0);
  const endMs = startMs + 8 * 60 * 60 * 1000;
  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

function totalBreaks(rows: LunchBreakRow[]): number {
  return rows.reduce((count, row) => count + (Array.isArray(row.breaks) ? row.breaks.length : 0), 0);
}
