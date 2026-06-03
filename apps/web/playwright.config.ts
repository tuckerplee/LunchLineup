import { defineConfig, devices } from '@playwright/test';

const e2ePort = process.env.PLAYWRIGHT_PORT ?? '3100';
const localBaseUrl = `http://localhost:${e2ePort}`;

/**
 * Playwright configuration for LunchLineup E2E tests.
 * Targets BASE_URL when provided, otherwise starts the local web app.
 */
export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [
        ['html', { outputFolder: 'playwright-report' }],
        ['junit', { outputFile: 'test-results/junit.xml' }],
    ],
    use: {
        baseURL: process.env.BASE_URL || localBaseUrl,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        // Smoke tests on Chromium only
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        // Cross-browser on CI
        {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
        },
        // Mobile viewport sanity check
        {
            name: 'Mobile Chrome',
            use: { ...devices['Pixel 5'] },
        },
    ],
    webServer: process.env.BASE_URL
        ? undefined
        : {
            command: process.env.CI ? `npm run start -- -p ${e2ePort}` : `npm run dev -- -p ${e2ePort}`,
            url: localBaseUrl,
            reuseExistingServer: false,
            cwd: '.',
            timeout: 120000,
        },
});
