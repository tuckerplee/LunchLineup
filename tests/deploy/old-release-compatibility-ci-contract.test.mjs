import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harness = join(root, 'scripts', 'old-release-compatibility-harness.mjs');
const workflow = join(root, '.github', 'workflows', 'ci.yml');

// Planck's workflow wiring must supply every value from protected CI/provider
// state. Candidate and retained release checkouts may supply only clone roots,
// manifests, and their already-verified source SHAs.
const ciCloneProviderOptions = Object.freeze([
  '--clone-id',
  '--clone-network',
  '--clone-env',
  '--production-runtime-env',
  '--clone-provider-runtime',
  '--clone-provider-runtime-sha256',
  '--clone-provider-image',
]);

test('both CI compatibility call sites supply the complete v2 clone-provider contract', () => {
  assert.deepEqual(ciCloneProviderOptions, [
    '--clone-id',
    '--clone-network',
    '--clone-env',
    '--production-runtime-env',
    '--clone-provider-runtime',
    '--clone-provider-runtime-sha256',
    '--clone-provider-image',
  ]);

  const source = readFileSync(workflow, 'utf8').replaceAll('\r\n', '\n');
  const callSites = [...source.matchAll(/node scripts\/old-release-compatibility-harness\.mjs run \\\n([\s\S]*?)--evidence-dir "\$evidence_dir"/g)]
    .map((match) => match[0]);
  assert.equal(callSites.length, 2, 'CI must retain exactly emergency and production compatibility run call sites');
  const missing = callSites.flatMap((callSite, index) => ciCloneProviderOptions
    .filter((option) => !new RegExp(`(?:^|\\s)${option.replaceAll('-', '\\-')}(?:\\s|$)`, 'm').test(callSite))
    .map((option) => `${index === 0 ? 'emergency' : 'production'}:${option}`));
  assert.deepEqual(missing, [], 'both CI callers must pass every mandatory clone-provider option');
  for (const callSite of callSites) {
    assert.match(callSite, /--clone-network "\$clone_network"/);
    assert.match(callSite, /--clone-provider-runtime "\$clone_provider_runtime"/);
    assert.match(callSite, /--clone-provider-runtime-sha256 "\$clone_provider_runtime_sha256"/);
    assert.match(callSite, /--clone-provider-image "\$OLD_RELEASE_COMPATIBILITY_PROVIDER_IMAGE"/);
  }

  const executionSteps = [...source.matchAll(/clone_network="\$clone_id-network"([\s\S]*?)node scripts\/old-release-compatibility-harness\.mjs run/g)]
    .map((match) => match[0]);
  assert.equal(executionSteps.length, 2, 'both callers must derive their provider contract hermetically');
  for (const execution of executionSteps) {
    assert.match(execution, /clone_provider_runtime="\$\(readlink -f "\$\(command -v docker\)"\)"/);
    assert.match(execution, /test "\$\(stat -c '%u' "\$clone_provider_runtime"\)" = 0/);
    assert.match(execution, /clone_provider_runtime_sha256="\$\(sha256sum "\$clone_provider_runtime" \| awk '\{print \$1\}'\)"/);
    assert.doesNotMatch(execution, /\/opt\/lunchlineup-provider\/old-release-compatibility-harness\.mjs/);
    assert.doesNotMatch(execution, /(?:^|\s)npm (?:--prefix|ci)|python -m pip install/m);
  }
  assert.equal((source.match(/OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS/g) || []).length >= 2, true);
  assert.equal((source.match(/OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS/g) || []).length >= 2, true);
});

test('provider argv exposes clone inputs but never the production runtime path', () => {
  const source = readFileSync(harness, 'utf8');
  const providerArgs = source.slice(source.indexOf('const providerArgs = ['), source.indexOf('const providerExecution ='));
  assert.match(providerArgs, /providerMount\(cloneEnvPath, '\/run\/lunchlineup\/clone\.env'\)/);
  assert.match(providerArgs, /--network', cloneNetwork/);
  assert.match(providerArgs, /--read-only/);
  assert.match(providerArgs, /--security-opt=no-new-privileges:true/);
  assert.match(providerArgs, /'\/work:rw,nosuid,nodev,size=4096m'/);
  assert.match(providerArgs, /OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS/);
  assert.match(providerArgs, /OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS/);
  assert.doesNotMatch(providerArgs, /productionEnvPath|production-runtime-env|PRODUCTION_RUNTIME|OLD_RELEASE_COMPATIBILITY_CLONE_COMMAND/);
});

test('provider image owns trusted schema tools at fixed paths', () => {
  const source = readFileSync(harness, 'utf8');
  assert.match(source, /fixedProviderHarness = '\/opt\/lunchlineup-provider\/old-release-compatibility-harness\.mjs'/);
  assert.match(source, /fixedProviderPrismaCli = '\/opt\/lunchlineup-provider\/node_modules\/prisma\/build\/index\.js'/);
  assert.match(source, /fixedProviderNpmCache = '\/opt\/lunchlineup-provider\/npm-cache'/);
  assert.match(source, /fixedProviderPythonWheelhouse = '\/opt\/lunchlineup-provider\/python-wheelhouse'/);
  assert.match(source, /Provider old-release npm ci/);
  assert.match(source, /Provider candidate npm ci/);
  assert.match(source, /Provider old-release Python dependency install/);
  assert.match(source, /production-runtime-and-clone-command-absent-v1/);
  assert.match(source, /command: 'psql'/);
  assert.match(source, /Provider Prisma CLI must be immutable and root-owned/);
  assert.match(source, /Clone provider runtime must be root-owned/);
});
