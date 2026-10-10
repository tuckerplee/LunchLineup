// Fixed eight-case runner adaptation. No caller-selected tests, URL or command.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFixedBrowserSourceProfile } from './fixed-browser-source-profile.mjs';

export const MOCK_PIPELINE = '.ci/development-mock-ux.pipeline.json';
export const MOCK_SERVERS = [
  { command: 'node tests/e2e/mock-api.mjs --port 8081', url: 'http://127.0.0.1:8081/__mock-api/ready', reuseExistingServer: false, timeout: 120000 },
  { command: 'npm run dev -- -H 127.0.0.1 -p 8080', url: 'http://127.0.0.1:8080/auth/login', reuseExistingServer: false, timeout: 240000 },
];
const files = ['authenticated-mobile-layout.spec.ts', 'frontend-accessibility.spec.ts', 'tenant-mobile-long-content.spec.ts'];
const forbidden = ['BASE_URL', 'E2E_WEB_COMMAND', 'LUNCHLINEUP_BROWSER_COHORT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'CONTAINER_HOST'];
function contextPath() {
  return `${process.env.RUNNER_TEMP}/lunchlineup-source-${process.env.CI_RUN_ID}/source-context.json`;
}
function selectedProfile() {
  const profile = readFixedBrowserSourceProfile({ contextPath: contextPath() });
  if (profile?.pipelinePath !== MOCK_PIPELINE) return null;
  return profile;
}
export function mockUxConfiguration() {
  const profile = selectedProfile();
  if (!profile) return null;
  if (forbidden.some(name => process.env[name] !== undefined) ||
      process.env.E2E_FULL_STACK !== '0' || process.env.E2E_MOCK_API !== '1' ||
      process.env.E2E_SIGNUP_MODE !== 'open' || process.env.PLAYWRIGHT_PORT !== '8080' ||
      process.env.PLAYWRIGHT_API_PORT !== '8081' || process.env.CI !== '1' ||
      process.env.NEXT_TELEMETRY_DISABLED !== '1') throw new Error('Fixed mock UX environment mismatch.');
  const phase = JSON.parse(execFileSync('/usr/bin/python3', [resolve(import.meta.dirname, 'read-fixed-browser-phase.py'), '--mock-ux-json'], { encoding: 'utf8' }));
  if (phase.sourceSha !== profile.sourceSha || phase.pipelineSha256 !== profile.pipelineSha256 ||
      phase.kind !== 'fixed-mock-ux-runtime' || phase.phase !== 'runtime') throw new Error('Fixed mock UX phase mismatch.');
  return { kind: 'fixed-eight-mock-ux', sourceSha: profile.sourceSha, runId: process.env.CI_RUN_ID,
    selectionSha256: phase.selectionSha256, servers: MOCK_SERVERS, traces: 'on',
    chromiumSandbox: true, expectedWorkers: 2 };
}
function run() {
  const contract = mockUxConfiguration();
  if (!contract) throw new Error('Fixed mock UX profile required.');
  const build = resolve(import.meta.dirname, '..');
  const workspace = process.env.CI_WORKSPACE;
  const artifacts = resolve(workspace, '.release/internal-ci', contract.sourceSha);
  const output = resolve(artifacts, 'mock-ux');
  mkdirSync(output, { mode: 0o700 }); // exclusive; no reused result directory
  const environment = { ...process.env, E2E_ARTIFACT_ROOT: output };
  // No additional test invocation: preserve previous isolation credit. The
  // root pre-entry sandbox covers both plain and guarded fixture workers.
  const args = ['test', '--project=chromium', '--workers=1', '--retries=0', '--repeat-each=1',
    '--forbid-only', '--reporter=json', ...files.map(file => 'tests/e2e/' + file)];
  const manifest = resolve(build, '.ci/development-mock-ux-cases.json');
  const verifier = resolve(build, 'scripts/verify-development-browser-report.mjs');
  function invoke(list) {
    const name = list ? 'selection' : 'results';
    const log = openSync(resolve(output, name + '.log'), 'wx', 0o600);
    try {
      const result = spawnSync(resolve(build, 'node_modules/.bin/playwright'), [...args, ...(list ? ['--list'] : [])],
        { cwd: resolve(build, 'apps/web'), env: { ...environment, PLAYWRIGHT_JSON_OUTPUT_NAME: resolve(output, name + '.json') },
          stdio: ['ignore', log, log], timeout: 1500000 });
      if (result.status !== 0) throw new Error('Mock UX ' + name + ' failed; original evidence retained.');
    } finally { closeSync(log); }
  }
  invoke(true);
  const selection = resolve(output, 'selection.json');
  const selectionProof = execFileSync(process.execPath, [verifier, '--selection', manifest, 'mock-ux', selection], { encoding: 'utf8' });
  writeFileSync(resolve(output, 'selection-proof.json'), selectionProof, { flag: 'wx', mode: 0o600 });
  invoke(false);
  const proof = execFileSync(process.execPath, [verifier, '--complete', manifest, 'mock-ux', selection,
    resolve(output, 'results.json'), contract.sourceSha, contract.runId], { encoding: 'utf8' });
  writeFileSync(resolve(output, 'acceptance-proof.json'), proof, { flag: 'wx', mode: 0o600 });
  // Root finalizer, not this process, owns exact Next-generated restoration even afterSIGKILL.
  writeFileSync(resolve(output, 'runner-complete.json'), JSON.stringify({ ...contract,
    acceptanceSha256: createHash('sha256').update(proof).digest('hex'), releaseQualified: false }) + '\n',
    { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).join(',') === '--selected') process.exit(selectedProfile() ? 0 : 77);
  if (process.argv.slice(2).join(',') !== '--run') throw new Error('Fixed mock UX command required.');
  run();
}
