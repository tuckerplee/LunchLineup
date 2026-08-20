import { expect, test } from '@playwright/test';
import type {
  ProblemDetails,
  ScheduleBoardResponse,
  ScheduleChangeSetResponse,
  ScheduleCreateResponse,
  SchedulePublicationResponse,
  SchedulePublishPlanResponse,
} from '@lunchlineup/api-contract';

import { apiJson, dayWindow, loginAsSeedAdmin, runFullStack, seedTenant } from './support';

async function inviteStaff(page: import('@playwright/test').Page, name: string, username: string, role: 'Manager' | 'Staff') {
  const form = page.getByRole('form', { name: 'Add team member' });
  await form.getByLabel('Full name').fill(name);
  await form.getByLabel('Username', { exact: true }).fill(username);
  await form.getByLabel('Temporary PIN', { exact: true }).fill('135790');
  await form.getByLabel('Role').selectOption({ label: role });
  await form.getByRole('button', { name: 'Create team member' }).click();
  const credentials = page.getByRole('dialog', { name: 'Save temporary credentials' });
  await credentials.getByLabel('I have copied and stored these credentials securely.').check();
  await credentials.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function shiftOwner(page: import('@playwright/test').Page): Promise<string | null> {
  const { startDate, endDate } = dayWindow();
  const response = await page.request.get(`/api/v2/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { data?: Array<{ user?: { name?: string } | null }> };
  return payload.data?.[0]?.user?.name ?? null;
}

test.describe.serial('Full-stack operations workflows', () => {
  test.skip(!runFullStack, 'Set E2E_FULL_STACK=1 and E2E_SEED_COMMAND to run DB-backed workflow E2E.');

  test.beforeEach(() => {
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

    const sourceBox = await shiftBlock.locator('.shift-drag-handle').boundingBox();
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
    const breaksResponse = await page.request.get(`/api/v2/lunch-breaks?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
    expect(breaksResponse.ok()).toBeTruthy();
    const breaksPayload = await breaksResponse.json() as { data?: Array<{ breaks?: unknown[] }> };
    expect(breaksPayload.data?.[0]?.breaks?.length).toBeGreaterThanOrEqual(3);

    await page.getByRole('link', { name: /Lunch & Breaks/ }).click();
    await page.getByRole('button', { name: /Auto Break/ }).click();
    await page.getByRole('button', { name: 'Select staff' }).click();
    await expect(page.getByText('Casey Manager')).toBeVisible();
    await page.getByRole('button', { name: /Review \d+ shifts?/ }).click();
    page.once('dialog', async (dialog) => dialog.accept());
    await page.getByRole('button', { name: /Save \d+ setup shift records? · exactly \d+ usage credits?/ }).click();
    await expect(page.getByRole('heading', { name: /Lunch & break canvas/ })).toBeVisible();
    await expect(page.locator('.meal-event').filter({ hasText: 'Lunch' })).toBeVisible();
    await expect(page.locator('.break-event').filter({ hasText: 'Break' }).first()).toBeVisible();

    await page.goto('/dashboard/time-cards');
    await expect(page.getByRole('heading', { name: 'Time Cards' })).toBeVisible();
    await page.getByRole('button', { name: 'Team Time' }).click();
    await page.getByLabel('Team member').selectOption({ label: 'Casey Manager' });
    await page.getByLabel('Team location').selectOption({ index: 1 });
    await page.getByRole('button', { name: /Clock in Casey Manager/ }).click();
    await expect(page.getByText(/Casey Manager was clocked in at/)).toBeVisible();
    await expect(page.getByText(/Clocked in at/)).toBeVisible();
    await page.getByLabel('Break minutes').fill('0');
    await page.getByRole('button', { name: /Clock out Casey Manager/ }).click();
    await expect(page.getByText(/Casey Manager was clocked out from/)).toBeVisible();
    await expect(page.getByText('CLOSED').first()).toBeVisible();
  });

  test('creates, edits, replays, publishes, and reads back an internal-beta schedule through API v2', async ({ page }) => {
    const scheduleDate = '2030-01-15';
    const scheduleStart = '2030-01-15T08:00:00.000Z';
    const scheduleEnd = '2030-01-16T08:00:00.000Z';
    const createdStart = '2030-01-15T17:00:00.000Z';
    const createdEnd = '2030-01-15T21:00:00.000Z';
    const editedStart = '2030-01-15T17:30:00.000Z';
    const editedEnd = '2030-01-15T21:30:00.000Z';
    const clientId = '5d02c4c7-90f2-4a3f-93b4-acde0465c3be';

    await loginAsSeedAdmin(page, `/dashboard/scheduling?date=${scheduleDate}`);
    const origin = new URL(page.url()).origin;
    const boardUrl = `/api/v2/schedule-board?date=${scheduleDate}&view=day`;
    const initialBoard = await apiJson<ScheduleBoardResponse>(page, 'GET', boardUrl);
    const location = initialBoard.data.locations[0];
    expect(location, 'seeded scheduling location').toBeTruthy();
    if (!location) return;

    const createdSchedule = await apiJson<ScheduleCreateResponse>(
      page,
      'POST',
      `/api/v2/locations/${location.id}/schedules`,
      { startDate: scheduleStart, endDate: scheduleEnd },
      200,
      {
        origin,
        'Idempotency-Key': 'internal-beta-schedule-create-v1',
      },
    );
    expect(createdSchedule.data).toMatchObject({
      locationId: location.id,
      status: 'DRAFT',
      revision: 0,
    });

    const createBody = {
      operations: [{
        op: 'shift.create' as const,
        clientId,
        userId: null,
        role: 'Counter',
        startTime: createdStart,
        endTime: createdEnd,
      }],
    };
    const createdShift = await apiJson<ScheduleChangeSetResponse>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/change-sets`,
      createBody,
      200,
      {
        origin,
        'Idempotency-Key': 'internal-beta-shift-create-v1',
        'If-Match': createdSchedule.data.etag,
      },
    );
    const shiftId = createdShift.data.created[0]?.shiftId;
    expect(shiftId, 'created public shift id').toBeTruthy();
    if (!shiftId) return;

    const staleEdit = await apiJson<ProblemDetails>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/change-sets`,
      {
        operations: [{
          op: 'shift.update',
          shiftId,
          startTime: editedStart,
          endTime: editedEnd,
        }],
      },
      412,
      {
        origin,
        'Idempotency-Key': 'internal-beta-stale-edit-v1',
        'If-Match': createdSchedule.data.etag,
      },
    );
    expect(staleEdit).toMatchObject({
      status: 412,
      code: 'stale_schedule_revision',
      currentEtag: createdShift.data.etag,
    });

    const editBody = {
      operations: [{
        op: 'shift.update' as const,
        shiftId,
        startTime: editedStart,
        endTime: editedEnd,
      }],
    };
    const editedShift = await apiJson<ScheduleChangeSetResponse>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/change-sets`,
      editBody,
      200,
      {
        origin,
        'Idempotency-Key': 'internal-beta-shift-edit-v1',
        'If-Match': createdShift.data.etag,
      },
    );
    expect(editedShift.data.shifts).toContainEqual(expect.objectContaining({
      id: shiftId,
      startTime: editedStart,
      endTime: editedEnd,
    }));

    const replayedEdit = await apiJson<ScheduleChangeSetResponse>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/change-sets`,
      editBody,
      200,
      {
        origin,
        'Idempotency-Key': 'internal-beta-shift-edit-v1',
        'If-Match': editedShift.data.etag,
      },
    );
    expect(replayedEdit).toEqual(editedShift);

    const publishPlan = await apiJson<SchedulePublishPlanResponse>(
      page,
      'GET',
      `/api/v2/schedules/${createdSchedule.data.id}/publish-plan`,
    );
    expect(publishPlan).toMatchObject({
      scheduleId: createdSchedule.data.id,
      sufficientCredits: true,
    });

    const published = await apiJson<SchedulePublicationResponse>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/publications`,
      { acceptedContract: publishPlan.acceptedContract },
      200,
      {
        origin,
        'Idempotency-Key': 'internal-beta-schedule-publish-v1',
      },
    );
    expect(published).toMatchObject({
      id: createdSchedule.data.id,
      status: 'PUBLISHED',
      settlement: {
        creditsConsumed: publishPlan.totalConfiguredCost,
      },
    });

    const replayedPublish = await apiJson<SchedulePublicationResponse>(
      page,
      'POST',
      `/api/v2/schedules/${createdSchedule.data.id}/publications`,
      { acceptedContract: publishPlan.acceptedContract },
      200,
      {
        origin,
        'Idempotency-Key': 'internal-beta-schedule-publish-v1',
      },
    );
    expect(replayedPublish.publishedAt).toBe(published.publishedAt);
    expect(replayedPublish.settlement).toEqual(published.settlement);

    const readback = await apiJson<ScheduleBoardResponse>(
      page,
      'GET',
      `${boardUrl}&locationId=${location.id}`,
    );
    expect(readback.data.schedules).toContainEqual(expect.objectContaining({
      id: createdSchedule.data.id,
      status: 'PUBLISHED',
      publishedAt: published.publishedAt,
    }));
    expect(readback.data.shifts).toContainEqual(expect.objectContaining({
      id: shiftId,
      scheduleId: createdSchedule.data.id,
      startTime: editedStart,
      endTime: editedEnd,
    }));
  });
});
