import { expect, type Locator, type Page } from '@playwright/test';

import { dayWindow, loginAsSeedAdmin, seedTenant } from './support';

export type ShiftReadback = {
  id: string;
  userId?: string | null;
  user?: { id?: string; name?: string } | null;
  startTime: string;
  endTime: string;
};

export async function resetAndOpenCalendar(page: Page) {
  seedTenant();
  await loginAsSeedAdmin(page, '/dashboard/scheduling');
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await expect(page.getByRole('region', { name: /staff schedule timeline/ })).toBeVisible();
}

export async function readShifts(page: Page): Promise<ShiftReadback[]> {
  const { startDate, endDate } = dayWindow(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), 7);
  const response = await page.request.get(`/api/v1/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = await response.json() as { data?: ShiftReadback[] };
  return payload.data ?? [];
}

export async function createProofShift(page: Page, staff: string, start: string, end: string) {
  await page.getByRole('button', { name: /Add shift/ }).click();
  const form = page.locator('form.shift-form');
  await expect(form).toBeVisible();
  await form.getByLabel('Staff').selectOption({ label: staff });
  await form.getByLabel('Start').fill(start);
  await form.getByLabel('End').fill(end);
  await form.getByRole('button', { name: 'Create shift' }).click();
  await expect(page.locator('.shift-block').filter({ hasText: `${start}-${end}` }).first()).toBeVisible();
  await expect.poll(async () => (await readShifts(page)).find((item) => item.user?.name === staff)).toBeTruthy();
  return (await readShifts(page)).find((item) => item.user?.name === staff)!;
}

export function shiftBlock(page: Page, time: string): Locator {
  return page.locator('.shift-block').filter({ hasText: time }).first();
}

export function moveHandle(block: Locator): Locator {
  return block.getByRole('button', { name: /Move or copy/ });
}

export async function pointerGeometry(page: Page, source: Locator, targetStaff: string) {
  const sourceBox = await source.boundingBox();
  const row = page.locator(`.timeline-row[data-resource-title="${targetStaff}"]`);
  const rowBox = await row.boundingBox();
  const targetUserId = await row.getAttribute('data-resource-id');
  expect(sourceBox, 'shift move-handle geometry').toBeTruthy();
  expect(rowBox, 'target row geometry').toBeTruthy();
  expect(targetUserId, 'target row user id').toBeTruthy();
  const grid = row.locator('.timeline-grid');
  const hourWidth = await grid.evaluate((node) => Number.parseFloat(getComputedStyle(node).backgroundSize));
  expect(hourWidth).toBeGreaterThan(0);
  return {
    sourceBox: sourceBox!,
    rowBox: rowBox!,
    hourWidth,
    targetUserId: targetUserId!,
    sourceX: sourceBox!.x + sourceBox!.width / 2,
    sourceY: sourceBox!.y + sourceBox!.height / 2,
    targetY: rowBox!.y + rowBox!.height / 2,
  };
}

export function changeSetRequests(page: Page) {
  const requests: Array<{ url: string; body: any }> = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !/\/api\/v2\/schedules\/[^/]+\/change-sets$/.test(new URL(request.url()).pathname)) return;
    requests.push({ url: request.url(), body: request.postDataJSON() });
  });
  return requests;
}

export async function closeShiftDialogIfOpen(page: Page) {
  const dialog = page.getByRole('dialog', { name: /Edit shift|Move or copy shift/ });
  if (await dialog.count()) await dialog.getByRole('button', { name: /Cancel|Close shift editor/ }).last().click();
}

export function addHours(iso: string, hours: number) {
  return new Date(new Date(iso).getTime() + hours * 60 * 60 * 1000).toISOString();
}
