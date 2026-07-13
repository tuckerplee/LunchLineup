import { defineConfig, devices } from '@playwright/test';

const perRunPortBase = 4300 + (process.pid % 2000) * 2;
const RESERVED_BROWSER_PORTS = new Set([5060, 5061]);

function firstUsablePort(port: number): number {
    let candidate = port;
    while (RESERVED_BROWSER_PORTS.has(candidate) || RESERVED_BROWSER_PORTS.has(candidate + 1)) {
        candidate += 2;
    }
    return candidate;
}

function configuredPort(name: 'PLAYWRIGHT_PORT' | 'PLAYWRIGHT_API_PORT', fallback: number): string {
    const configured = process.env[name];
    if (!configured) {
        const resolved = firstUsablePort(fallback);
        process.env[name] = String(resolved);
        return String(resolved);
    }

    if (!/^\d+$/.test(configured)) {
        throw new Error(`${name} must be a TCP port number, received ${JSON.stringify(configured)}.`);
    }
    const parsed = Number.parseInt(configured, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`${name} must be a TCP port number, received ${JSON.stringify(configured)}.`);
    }
    return String(parsed);
}

const e2ePort = configuredPort('PLAYWRIGHT_PORT', perRunPortBase);
const mockApiPort = configuredPort('PLAYWRIGHT_API_PORT', perRunPortBase + 1);
const localBaseUrl = `http://127.0.0.1:${e2ePort}`;
const mockApiBaseUrl = `http://127.0.0.1:${mockApiPort}`;
const runFullStack = process.env.E2E_FULL_STACK === '1';
const useMockApi = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;
if (useMockApi && e2ePort === mockApiPort) {
    throw new Error('PLAYWRIGHT_PORT and PLAYWRIGHT_API_PORT must be different when the mock API is enabled.');
}
const useNextDevServer = useMockApi || process.env.E2E_USE_NEXT_DEV === '1';
const serializeMockApiTests = useMockApi;
const webCommand = process.env.E2E_WEB_COMMAND
    ?? (useNextDevServer
        ? `npm run dev -- -H 127.0.0.1 -p ${e2ePort}`
        : `npm run build && npm run start -- -H 127.0.0.1 -p ${e2ePort}`);
const webServer = process.env.BASE_URL
    ? undefined
    : [
        ...(useMockApi
            ? [{
                command: `node tests/e2e/mock-api.mjs --port ${mockApiPort}`,
                url: `${mockApiBaseUrl}/__mock-api/ready`,
                reuseExistingServer: false,
                cwd: '.',
                timeout: 120000,
            }]
            : []),
        {
            command: webCommand,
            url: localBaseUrl,
            reuseExistingServer: false,
            cwd: '.',
            timeout: 240000,
            env: useMockApi
                ? {
                    NODE_ENV: 'development',
                    INTERNAL_API_URL: `${mockApiBaseUrl}/v1`,
                    NEXT_PUBLIC_API_URL: '/api/v1',
                    NEXT_PUBLIC_SIGNUP_MODE: 'open',
                    NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@lunchlineup.test',
                }
                : undefined,
        },
    ];

/**
 * Playwright configuration for LunchLineup E2E tests.
 * Targets BASE_URL when provided, otherwise starts the local web app.
 */
export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: !serializeMockApiTests,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: serializeMockApiTests || process.env.CI ? 1 : undefined,
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
    webServer,
});
