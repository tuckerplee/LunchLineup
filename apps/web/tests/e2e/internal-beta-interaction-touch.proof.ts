import { expect, test } from './qa-isolation-fixture';

import { assertInputHit, visibleInputBounds, changeSetRequests, createProofShift, moveHandle, resetAndOpenCalendar, shiftBlock } from './internal-beta-interaction-support';

test('real touch scroll never moves a shift and the dedicated handle opens the Move fallback', async ({ page }, testInfo) => {
  expect(testInfo.project.use.hasTouch).toBe(true);
  expect(testInfo.project.use.isMobile).toBe(true);
  await resetAndOpenCalendar(page);
  await createProofShift(page, 'Staff One', '10:00', '14:00');
  const mutations = changeSetRequests(page);
  const timeline = page.getByRole('region', { name: /staff schedule timeline/ });
  const block = shiftBlock(page, '10:00-14:00');
  const details = block.getByRole('button', { name: /^Edit STAFF shift,/ });
  await details.scrollIntoViewIfNeeded();
  const detailsBox = await visibleInputBounds(details);
  const timelineBox = await visibleInputBounds(timeline);
  const y = detailsBox.y + detailsBox.height / 2;
  const startX = detailsBox.x + detailsBox.width * 0.75;
  const endX = Math.max(timelineBox.x + 8, startX - 140);
  expect(startX - endX, 'visible swipe has enough travel to scroll').toBeGreaterThan(30);
  await assertInputHit(details, startX, y);
  await assertInputHit(timeline, endX, y);
  const beforeScroll = await timeline.evaluate((node) => node.scrollLeft);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
    for (let step = 1; step <= 4; step += 1) {
      const x = startX + ((endX - startX) * step) / 4;
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
  await expect.poll(() => timeline.evaluate((node) => node.scrollLeft)).toBeGreaterThan(beforeScroll);
  expect(mutations).toEqual([]);

  const handle = moveHandle(block);
  await expect(handle).toBeVisible();
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await visibleInputBounds(handle);
  const tapX = handleBox.x + handleBox.width / 2;
  const tapY = handleBox.y + handleBox.height / 2;
  await assertInputHit(handle, tapX, tapY);
  await page.touchscreen.tap(tapX, tapY);
  await expect(page.getByRole('dialog', { name: /Move or copy shift/ })).toBeVisible();
  expect(mutations).toEqual([]);
});
