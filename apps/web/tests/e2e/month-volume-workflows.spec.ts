import { expect, test } from '@playwright/test';
import type {
  ScheduleBoardResponse,
  ScheduleChangeSetResponse,
  ScheduleCreateResponse,
} from '@lunchlineup/api-contract';

import { apiJson, loginAsSeedAdmin, runFullStack, seedTenant } from './support';

test.describe.serial('API-v2 schedule and lunch/break volume workflows', () => {
  test.skip(!runFullStack, 'Set E2E_FULL_STACK=1 and E2E_SEED_COMMAND to run DB-backed workflow volume tests.');
  test.setTimeout(300_000);

  test.beforeEach(() => {
    seedTenant();
  });

  test('builds a bounded multi-user schedule, persists lunch/breaks, and reads the result back', async ({ page }) => {
    const scheduleDate = '2030-07-01';
    const scheduleStart = '2030-07-01T00:00:00.000Z';
    const scheduleEnd = '2030-08-01T00:00:00.000Z';
    const monthStart = scheduleStart;
    const monthEnd = scheduleEnd;

    await loginAsSeedAdmin(page, `/dashboard/scheduling?date=${scheduleDate}`);
    const origin = new URL(page.url()).origin;
    const board = await apiJson<ScheduleBoardResponse>(
      page,
      'GET',
      `/api/v2/schedule-board?date=${scheduleDate}&view=week`,
    );
    const location = board.data.locations[0];
    expect(location, 'seeded scheduling location').toBeTruthy();
    expect(board.data.staff.length, 'seeded scheduling roster').toBeGreaterThanOrEqual(10);
    if (!location) return;

    const createdSchedule = await apiJson<ScheduleCreateResponse>(
      page,
      'POST',
      `/api/v2/locations/${location.id}/schedules`,
      { startDate: scheduleStart, endDate: scheduleEnd },
      200,
      { origin, 'Idempotency-Key': 'e2e-month-schedule-create-v1' },
    );

    const staff = board.data.staff.slice(0, 10);
    const operations = staff.flatMap((member, userIndex) => Array.from({ length: 5 }, (_, dayIndex) => {
      const start = new Date(Date.UTC(2030, 6, 1 + dayIndex, 16 + userIndex, 0, 0));
      const end = new Date(start.getTime() + 8 * 60 * 60 * 1000);
      return {
        op: 'shift.create' as const,
        clientId: `20000000-0000-4000-8000-${String(userIndex * 5 + dayIndex + 1).padStart(12, '0')}`,
        userId: member.id,
        role: member.role,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      };
    }));
    expect(operations).toHaveLength(50);

    const created = await apiJson<ScheduleChangeSetResponse>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/change-sets`,
      { operations },
      200,
      {
        origin,
        'Idempotency-Key': 'e2e-month-schedule-shifts-v1',
        'If-Match': createdSchedule.data.etag,
      },
    );
    const shiftIds = created.data.created.map((entry) => entry.shiftId);
    expect(shiftIds).toHaveLength(50);

    const generated = await apiJson<{
      source: string;
      persisted: boolean;
      data: Array<{ breaks: unknown[] }>;
      creditConsumption: { consumedCredits: number };
    }>(
      page,
      'POST',
      '/api/v2/lunch-breaks/generate',
      { shiftIds, persist: true },
      200,
      { origin, 'Idempotency-Key': 'e2e-month-break-plan-v1' },
    );
    expect(generated.source).toBe('shared_schedule');
    expect(generated.persisted).toBe(true);
    expect(generated.data).toHaveLength(50);
    expect(generated.data.every((row) => row.breaks.length === 3)).toBe(true);
    expect(generated.creditConsumption.consumedCredits).toBeGreaterThan(0);

    const replayed = await apiJson<typeof generated>(
      page,
      'POST',
      '/api/v2/lunch-breaks/generate',
      { shiftIds, persist: true },
      200,
      { origin, 'Idempotency-Key': 'e2e-month-break-plan-v1' },
    );
    expect(replayed).toMatchObject({ ...generated, reused: true });

    const persisted = await apiJson<{
      data: Array<{ shiftId: string | null; breaks: unknown[] }>;
      pagination: { returned: number; hasMore: boolean };
    }>(
      page,
      'GET',
      `/api/v2/lunch-breaks?startDate=${encodeURIComponent(monthStart)}&endDate=${encodeURIComponent(monthEnd)}&limit=100`,
    );
    expect(persisted.data).toHaveLength(50);
    expect(persisted.pagination.returned).toBe(50);
    expect(persisted.pagination.hasMore).toBe(false);
    expect(persisted.data.every((row) => row.shiftId && row.breaks.length === 3)).toBe(true);
  });
});
