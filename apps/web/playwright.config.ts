import { defineConfig, devices } from '@playwright/test';

const AUTOMATIC_PORT_BASE = 4300;
const AUTOMATIC_PORT_PAIR_COUNT = 300;
const perRunPortBase = AUTOMATIC_PORT_BASE + (process.pid % AUTOMATIC_PORT_PAIR_COUNT) * 2;
const BLOCKED_BROWSER_PORTS = new Set([
    2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function configuredPort(name: 'PLAYWRIGHT_PORT' | 'PLAYWRIGHT_API_PORT', fallback: number): string {
    const configured = process.env[name];
    if (!configured) {
        process.env[name] = String(fallback);
        return String(fallback);
    }

    if (!/^\d+$/.test(configured)) {
        throw new Error(`${name} must be a TCP port number, received ${JSON.stringify(configured)}.`);
    }
    const parsed = Number.parseInt(configured, 10);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
        throw new Error(`${name} must be an unprivileged TCP port number, received ${JSON.stringify(configured)}.`);
    }
    if (BLOCKED_BROWSER_PORTS.has(parsed)) {
        throw new Error(`${name} uses a browser-blocked TCP port: ${parsed}.`);
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
const mockSignupMode = process.env.E2E_SIGNUP_MODE?.trim().toLowerCase() || 'open';
if (!['closed_beta', 'invite_only', 'open'].includes(mockSignupMode)) {
    throw new Error(`E2E_SIGNUP_MODE must be closed_beta, invite_only, or open; received ${JSON.stringify(mockSignupMode)}.`);
}
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
            // Precompile the first authenticated-flow entrypoint before tests
            // begin; a root-only readiness probe can leave the dev server
            // compiling this client route inside the first 30-second test.
            url: `${localBaseUrl}/auth/login`,
            reuseExistingServer: false,
            cwd: '.',
            timeout: 240000,
            env: useMockApi
                ? {
                    NODE_ENV: 'development',
                    INTERNAL_API_V2_URL: `${mockApiBaseUrl}/v2`,
                    LUNCHLINEUP_STATUS_HEALTH_URL: `${mockApiBaseUrl}/health`,
                    LUNCHLINEUP_E2E_LEGACY_API_URL: `${mockApiBaseUrl}/v1`,
                    NEXT_PUBLIC_API_URL: '/api/v2',
                    NEXT_PUBLIC_SIGNUP_MODE: mockSignupMode,
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
