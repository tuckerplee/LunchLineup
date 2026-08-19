import { defineConfig, devices } from '@playwright/test';

import baseConfig from './playwright.config';

const candidateSha = process.env.E2E_CANDIDATE_SHA ?? 'local-source';
if (process.env.CI && !/^[a-f0-9]{40}$/.test(candidateSha)) {
  throw new Error('E2E_CANDIDATE_SHA must be the exact lowercase 40-character candidate SHA in CI.');
}

const proofRoot = `test-results/internal-beta-interaction-proof-${candidateSha}`;

export default defineConfig({
  ...baseConfig,
  metadata: { ...baseConfig.metadata, candidateSha },
  testDir: './tests/e2e',
  testMatch: '**/internal-beta-interaction-*.proof.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir: `${proofRoot}/artifacts`,
  reporter: [
    ['html', { outputFolder: `${proofRoot}/html`, open: 'never' }],
    ['junit', { outputFile: `${proofRoot}/junit.xml` }],
    ['json', { outputFile: `${proofRoot}/results.json` }],
  ],
  use: {
    ...baseConfig.use,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  projects: [
    {
      name: 'interaction-desktop',
      testMatch: '**/internal-beta-interaction-desktop.proof.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'interaction-touch',
      testMatch: '**/internal-beta-interaction-touch.proof.ts',
      use: { ...devices['Pixel 5'], hasTouch: true, isMobile: true },
    },
  ],
});
