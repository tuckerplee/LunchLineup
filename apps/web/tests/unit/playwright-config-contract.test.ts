import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const playwrightConfig = readFileSync(resolve(__dirname, '../../playwright.config.ts'), 'utf8');
const ciWorkflow = readFileSync(resolve(__dirname, '../../../../.github/workflows/ci.yml'), 'utf8');

describe('Playwright mock harness contract', () => {
  it('uses a development Next server for the shared mock API', () => {
    expect(playwrightConfig).toContain(
      "const useNextDevServer = useMockApi || process.env.E2E_USE_NEXT_DEV === '1';",
    );
    expect(playwrightConfig).toContain('? `npm run dev -- -H 127.0.0.1 -p ${e2ePort}`');
    expect(playwrightConfig).toContain("NODE_ENV: 'development'");
  });

  it('supports explicit closed-beta rendering without weakening the default open test harness', () => {
    expect(playwrightConfig).toContain("const mockSignupMode = process.env.E2E_SIGNUP_MODE?.trim().toLowerCase() || 'open';");
    expect(playwrightConfig).toContain("!['closed_beta', 'invite_only', 'open'].includes(mockSignupMode)");
    expect(playwrightConfig).toContain('NEXT_PUBLIC_SIGNUP_MODE: mockSignupMode');
  });
  it('serializes only mock-state runs and preserves external target detection', () => {
    expect(playwrightConfig).toContain(
      "const useMockApi = process.env.E2E_MOCK_API !== '0' && !runFullStack && !process.env.BASE_URL;",
    );
    expect(playwrightConfig).toContain('const serializeMockApiTests = useMockApi;');
    expect(playwrightConfig).toContain('fullyParallel: !serializeMockApiTests');
    expect(playwrightConfig).toContain('workers: serializeMockApiTests || process.env.CI ? 1 : undefined');
    expect(playwrightConfig).toContain('const webServer = process.env.BASE_URL');
    expect(playwrightConfig).toContain('baseURL: process.env.BASE_URL || localBaseUrl');
    expect(playwrightConfig).toContain('url: `${localBaseUrl}/auth/login`');
  });

  it('keeps automatic ports inside a browser-safe per-process range', () => {
    expect(playwrightConfig).toContain('const AUTOMATIC_PORT_BASE = 4300;');
    expect(playwrightConfig).toContain('const AUTOMATIC_PORT_PAIR_COUNT = 300;');
    expect(playwrightConfig).toContain('process.pid % AUTOMATIC_PORT_PAIR_COUNT');
    for (const blockedPort of [5060, 5061, 6000, 6566, 6665, 6669, 6697, 10080]) {
      expect(playwrightConfig).toContain(String(blockedPort));
    }
    expect(playwrightConfig).toContain('BLOCKED_BROWSER_PORTS.has(parsed)');
  });

  it('does not run a production web build before the default CI mock suite', () => {
    const e2eJobStart = ciWorkflow.indexOf('  e2e-tests:');
    const fullStackJobStart = ciWorkflow.indexOf('  fullstack-e2e:', e2eJobStart);
    const e2eJob = ciWorkflow.slice(e2eJobStart, fullStackJobStart);

    expect(e2eJobStart).toBeGreaterThanOrEqual(0);
    expect(fullStackJobStart).toBeGreaterThan(e2eJobStart);
    expect(e2eJob).toContain('run: npm run test:e2e --workspace @lunchlineup/web');
    expect(e2eJob).not.toContain('npm run build --workspace @lunchlineup/web');
  });
});
