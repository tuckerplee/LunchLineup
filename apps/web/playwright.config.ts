import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for LunchLineup E2E tests.
 * Targets a locally running instance of the web app.
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
    webServer: process.env.CI
        ? undefined
        : {
            command: 'npm run dev',
            url: 'http://localhost:3000',
            reuseExistingServer: true,
            cwd: '.',
        },
});
