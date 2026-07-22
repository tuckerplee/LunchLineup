import { expect, test } from '@playwright/test';

const HOME_HEADING = 'The schedule, already thinking ahead.';

test.describe('modern public homepage', () => {
  test('presents the product story and keeps every primary path actionable', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: HOME_HEADING })).toBeVisible();
    await expect(page.getByText('Availability in view', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See how it works' })).toHaveAttribute('href', '#workflow');
    await expect(page.getByRole('link', { name: 'Sign in', exact: true }).first()).toHaveAttribute('href', '/auth/login');

    const createWorkspace = page.getByRole('link', { name: 'Create your workspace' });
    const openWorkspace = page.getByRole('link', { name: 'Open beta workspace' });
    if (await createWorkspace.count()) {
      await expect(createWorkspace.first()).toHaveAttribute('href', '/onboarding');
      await expect(openWorkspace).toHaveCount(0);
    } else {
      await expect(openWorkspace.first()).toHaveAttribute('href', '/auth/login');
      await expect(createWorkspace).toHaveCount(0);
    }

    await expect(page.getByRole('heading', { level: 2, name: 'One schedule. Three perspectives.' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'A clear flow from plan to review.' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Built for the responsibility behind every shift.' })).toBeVisible();
  });

  test('switches product perspectives with an accessible tab model', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    const managerTab = page.getByRole('tab', { name: /Manager/ });
    const operatorTab = page.getByRole('tab', { name: /Operator/ });
    const teamTab = page.getByRole('tab', { name: /Team/ });

    await expect(managerTab).toHaveAttribute('aria-selected', 'true');
    await managerTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(operatorTab).toBeFocused();
    await expect(operatorTab).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText('See how locations fit together.');

    const panelId = await panel.getAttribute('id');
    expect(panelId).toBeTruthy();
    for (const tab of [managerTab, operatorTab, teamTab]) {
      await expect(tab).toHaveAttribute('aria-controls', panelId!);
    }

    await page.keyboard.press('End');
    await expect(teamTab).toBeFocused();
    await expect(teamTab).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toContainText('Give every shift a clear next step.');
    await expect(panel).toHaveCSS('transform', 'none');

    await page.keyboard.press('Home');
    await expect(managerTab).toBeFocused();
    await expect(managerTab).toHaveAttribute('aria-selected', 'true');
  });

  test('contains the document at desktop and mobile widths', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: HOME_HEADING })).toBeVisible();

      const overflow = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);

      if (viewport.width === 390) {
        for (const locator of [
          page.getByRole('link', { name: 'Review schedule' }),
          page.getByText('All times shown in local time', { exact: true }),
        ]) {
          await expect(locator).toBeVisible();
          const box = await locator.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
        }
      }
    }
  });
});
