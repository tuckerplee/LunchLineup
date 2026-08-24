import { defineConfig, devices } from '@playwright/test';

import baseConfig from './playwright.config';

const candidateSha = process.env.E2E_CANDIDATE_SHA ?? 'local-source';
const candidateTreeSha = process.env.E2E_CANDIDATE_TREE_SHA ?? 'local-tree';
const releaseManifestSha256 = process.env.E2E_RELEASE_MANIFEST_SHA256 ?? 'local-manifest';
const webImageId = process.env.E2E_WEB_IMAGE_ID ?? 'local-image';
const publicBuildConfigSha256 = process.env.E2E_PUBLIC_BUILD_CONFIG_SHA256 ?? 'local-public-build';
if (process.env.CI && !/^[a-f0-9]{40}$/.test(candidateSha)) {
  throw new Error('E2E_CANDIDATE_SHA must be the exact lowercase 40-character candidate SHA in CI.');
}

const proofRoot = process.env.E2E_INTERACTION_PROOF_ROOT ?? `test-results/internal-beta-interaction-proof-${candidateSha}`;

export default defineConfig({
  ...baseConfig,
  metadata: { ...baseConfig.metadata, candidateSha, candidateTreeSha, releaseManifestSha256, webImageId, publicBuildConfigSha256 },
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
