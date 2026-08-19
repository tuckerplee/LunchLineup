import { expect, test } from '@playwright/test';

import { changeSetRequests, createProofShift, moveHandle, resetAndOpenCalendar, shiftBlock } from './internal-beta-interaction-support';

test('real touch scroll never moves a shift and the dedicated handle opens the Move fallback', async ({ page }, testInfo) => {
  expect(testInfo.project.use.hasTouch).toBe(true);
  expect(testInfo.project.use.isMobile).toBe(true);
  await resetAndOpenCalendar(page);
  await createProofShift(page, 'Staff One', '10:00', '14:00');
  const mutations = changeSetRequests(page);
  const timeline = page.getByRole('region', { name: /staff schedule timeline/ });
  const block = shiftBlock(page, '10:00-14:00');
  const details = block.getByRole('button', { name: /Edit Staff One shift/ });
  const detailsBox = await details.boundingBox();
  expect(detailsBox).toBeTruthy();
  const session = await page.context().newCDPSession(page);
  const y = detailsBox!.y + detailsBox!.height / 2;
  const startX = detailsBox!.x + Math.min(detailsBox!.width - 8, 80);
  const endX = Math.max(20, startX - 140);
  const beforeScroll = await timeline.evaluate((node) => node.scrollLeft);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
  for (let step = 1; step <= 4; step += 1) {
    const x = startX + ((endX - startX) * step) / 4;
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect.poll(() => timeline.evaluate((node) => node.scrollLeft)).toBeGreaterThan(beforeScroll);
  expect(mutations).toEqual([]);

  const handle = moveHandle(block);
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  expect(handleBox).toBeTruthy();
  await page.touchscreen.tap(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await expect(page.getByRole('dialog', { name: /Move or copy shift/ })).toBeVisible();
  expect(mutations).toEqual([]);
});
