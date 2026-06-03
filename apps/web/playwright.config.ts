import { defineConfig, devices } from '@playwright/test';

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
        baseURL: process.env.BASE_URL || 'http://localhost:3000',
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
            command: process.env.CI ? 'npm run start' : 'npm run dev',
            url: 'http://localhost:3000',
            reuseExistingServer: !process.env.CI,
            cwd: '.',
            timeout: 120000,
        },
});
