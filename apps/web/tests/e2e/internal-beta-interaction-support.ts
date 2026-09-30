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
  const response = await page.request.get(`/api/v2/shifts?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = await response.json() as { data?: ShiftReadback[] };
  return payload.data ?? [];
}

export async function createProofShift(page: Page, staff: string, start: string, end: string) {
  await page.getByRole('button', { name: /Add shift/ }).click();
  const form = page.locator('form.shift-form');
  await expect(form).toBeVisible();
  // The role field also contains a Staff option; bind to the staff field's
  // label prefix so fixture setup cannot select the role control.
  await form.getByLabel(/^Staff(?:$|\s|Select staff)/).selectOption({ label: staff });
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

/** Fresh bounds clipped by the viewport and every scrolling/clipping ancestor. */
export async function visibleInputBounds(locator: Locator) {
  const bounds = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, clip.left + parent.clientLeft);
        right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, clip.top + parent.clientTop);
        bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
      }
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
  expect(bounds.width, 'input target has visible horizontal intersection').toBeGreaterThan(0);
  expect(bounds.height, 'input target has visible vertical intersection').toBeGreaterThan(0);
  return bounds;
}

export async function assertInputHit(locator: Locator, x: number, y: number) {
  expect(await locator.evaluate((node, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit !== null && (hit === node || node.contains(hit));
  }, { x, y }), 'raw input coordinate hits the intended element').toBe(true);
}

export async function pointerGeometry(page: Page, source: Locator, targetStaff: string) {
  const row = page.locator(`.timeline-row[data-resource-title="${targetStaff}"]`);
  await source.scrollIntoViewIfNeeded();
  await row.scrollIntoViewIfNeeded();
  // Positioning either element may move a shared scroll container. Measure both
  // only after the final scroll; fail if they cannot be visible together.
  await source.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const rowBox = await row.boundingBox();
  const sourceVisible = await visibleInputBounds(source);
  const rowVisible = await visibleInputBounds(row);
  const targetUserId = await row.getAttribute('data-resource-id');
  expect(sourceBox, 'shift move-handle geometry').toBeTruthy();
  expect(rowBox, 'target row geometry').toBeTruthy();
  expect(targetUserId, 'target row user id').toBeTruthy();
  const grid = row.locator('.timeline-grid');
  const hourWidth = await grid.evaluate((node) => Number.parseFloat(getComputedStyle(node).backgroundSize));
  expect(hourWidth).toBeGreaterThan(0);
  const sourceX = sourceVisible.x + sourceVisible.width / 2;
  const sourceY = sourceVisible.y + sourceVisible.height / 2;
  const targetY = rowVisible.y + rowVisible.height / 2;
  await assertInputHit(source, sourceX, sourceY);
  // Desktop proofs use either same-time movement or a one-hour move.
  await assertInputHit(row, sourceX, targetY);
  await assertInputHit(row, sourceX + hourWidth, targetY);
  return { sourceBox: sourceBox!, rowBox: rowBox!, hourWidth, targetUserId: targetUserId!, sourceX, sourceY, targetY };
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
