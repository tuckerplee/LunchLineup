import { expect, test } from './qa-isolation-fixture';
import { loginAsSeedAdmin, loginAsSeedManager, seedTenant } from './support';

test.describe.serial('Settings recovery acceptance', { tag: '@full-stack' }, () => {
    test.beforeEach(() => seedTenant());

    test('keeps saves disabled after initial read failure and recovers through an actual fresh read', async ({ page }) => {
        await page.route('**/api/v2/settings', route => route.abort('connectionfailed'));
        await loginAsSeedAdmin(page, '/dashboard/settings');
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeDisabled();
        await expect(page.getByText(/Settings changes are disabled until the current values load/)).toBeVisible();
        await page.unroute('**/api/v2/settings');
        await page.getByRole('button', { name: 'Retry settings load' }).click();
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeEnabled();
    });

    for (const section of ['general', 'team', 'security'] as const) {
        test(`confirms ${section} changes independently before withholding their response, then persists across reload`, async ({ page }) => {
            await loginAsSeedAdmin(page, '/dashboard/settings');
            await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeEnabled();
            let expected: Record<string, unknown>;
            if (section === 'general') {
                await page.getByLabel('Organization Name').fill('Recovered settings workspace');
                expected = { name: 'Recovered settings workspace' };
            } else if (section === 'team') {
                await page.getByRole('tab', { name: 'Team', exact: true }).click();
                await page.getByLabel('Default role for new invites').selectOption('MANAGER');
                expected = { defaultInviteRole: 'MANAGER' };
            } else {
                await page.getByRole('tab', { name: 'Security', exact: true }).click();
                await page.getByLabel('Session timeout').selectOption('120');
                expected = { sessionTimeoutMinutes: 120 };
            }
            let writes = 0;
            await page.route(`**/api/v2/settings/${section}`, async route => {
                if (route.request().method() !== 'PUT') return route.continue();
                writes++;
                const response = await route.fetch({ maxRetries: 0 });
                expect(response.ok()).toBeTruthy();
                const independent = await page.request.get('/api/v2/settings');
                expect(independent.ok()).toBeTruthy();
                expect((await independent.json())[section]).toMatchObject(expected);
                await route.abort('connectionfailed');
            });
            await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
            await expect(page.getByText('Saved settings match your submitted changes. Confirmed by a fresh read.', { exact: true })).toBeVisible();
            expect(writes).toBe(1);
            await page.reload();
            if (section !== 'general') await page.getByRole('tab', { name: section === 'team' ? 'Team' : 'Security', exact: true }).click();
            const read = await page.request.get('/api/v2/settings');
            expect(read.ok()).toBeTruthy();
            expect((await read.json())[section]).toMatchObject(expected);
            if (section === 'general') await expect(page.getByLabel('Organization Name')).toHaveValue(String(expected.name));
            if (section === 'team') await expect(page.getByLabel('Default role for new invites')).toHaveValue('MANAGER');
            if (section === 'security') await expect(page.getByLabel('Session timeout')).toHaveValue('120');
        });
    }

    test('retains the submitted draft and prevents a second write while readback is unavailable', async ({ page }, testInfo) => {
        await loginAsSeedAdmin(page, '/dashboard/settings');
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeEnabled();
        await page.getByLabel('Organization Name').fill('Readback retry workspace');
        let writes = 0;
        await page.route('**/api/v2/settings/general', async route => {
            writes++;
            const committed = await route.fetch({ maxRetries: 0 });
            expect(committed.ok()).toBeTruthy();
            const independent = await page.request.get('/api/v2/settings');
            expect((await independent.json()).general.name).toBe('Readback retry workspace');
            await page.route('**/api/v2/settings', read => read.abort('connectionfailed'));
            await route.abort('connectionfailed');
        });
        await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Check saved settings' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeDisabled();
        await expect(page.getByLabel('Organization Name')).toHaveValue('Readback retry workspace');
        await page.screenshot({ path: testInfo.outputPath('settings-unknown-retained.png'), fullPage: true });
        await page.unroute('**/api/v2/settings');
        await page.getByRole('button', { name: 'Check saved settings' }).click();
        await expect(page.getByText('Saved settings match your submitted changes. Confirmed by a fresh read.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeEnabled();
        expect(writes).toBe(1);
        await page.screenshot({ path: testInfo.outputPath('settings-readback-confirmed.png'), fullPage: true });
    });

    test('lets a user resolve an uncommitted save by explicitly discarding the retained draft', async ({ page }) => {
        await loginAsSeedAdmin(page, '/dashboard/settings');
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeEnabled();
        const before = await page.getByLabel('Organization Name').inputValue();
        await page.getByLabel('Organization Name').fill('Never committed draft');
        let writes = 0;
        await page.route('**/api/v2/settings/general', async route => {
            writes++;
            await route.abort('connectionfailed');
        });
        await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Check saved settings' })).toBeVisible();
        await expect(page.getByLabel('Organization Name')).toHaveValue('Never committed draft');
        await page.getByRole('button', { name: 'Check saved settings' }).click();
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeDisabled();
        page.once('dialog', dialog => dialog.dismiss());
        await page.getByRole('button', { name: 'Discard draft and load saved settings' }).click();
        await expect(page.getByLabel('Organization Name')).toHaveValue('Never committed draft');
        await page.route('**/api/v2/settings', route => route.abort('connectionfailed'));
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Discard draft and load saved settings' }).click();
        await expect(page.getByRole('button', { name: 'Discard draft and load saved settings' })).toBeEnabled();
        await expect(page.getByLabel('Organization Name')).toHaveValue('Never committed draft');
        await page.unroute('**/api/v2/settings');
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Discard draft and load saved settings' }).click();
        await expect(page.getByLabel('Organization Name')).toHaveValue(before);
        await expect(page.getByRole('button', { name: 'Save Changes', exact: true })).toBeEnabled();
        expect(writes).toBe(1);
    });

    test('denies a real settings mutation from a manager without write permission', async ({ page }) => {
        await loginAsSeedManager(page);
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'csrf_token')?.value;
        const response = await page.request.put('/api/v2/settings/general', {
            headers: { 'x-csrf-token': decodeURIComponent(csrf ?? ''), Origin: new URL(page.url()).origin },
            data: { name: 'Unauthorized settings change' },
        });
        expect(response.status()).toBe(403);
    });
});
