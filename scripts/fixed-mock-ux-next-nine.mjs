// Fixed nine-case runner adaptation. No caller-selected tests, URL or command.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, openSync, closeSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { NEXT_NINE_CASES } from './fixed-mock-ux-next-nine-cases.mjs';
import { readFixedBrowserSourceProfile } from './fixed-browser-source-profile.mjs';

export const MOCK_PIPELINE = '.ci/development-mock-ux-next-nine.pipeline.json';
// Only build/server children use production mode; dependency acquisition keeps dev dependencies.
export const MOCK_WEB_ENV = Object.freeze({
  NODE_ENV: 'production',
  INTERNAL_API_V2_URL: 'http://127.0.0.1:8081/v2',
  LUNCHLINEUP_STATUS_HEALTH_URL: 'http://127.0.0.1:8081/health',
  LUNCHLINEUP_E2E_LEGACY_API_URL: 'http://127.0.0.1:8081/v1',
  NEXT_PUBLIC_API_URL: '/api/v2',
  NEXT_PUBLIC_SIGNUP_MODE: 'open',
  NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@lunchlineup.test',
  STAFF_INVITATION_OUTBOX_ENABLED: 'true',
});
export const MOCK_SERVERS = [
  { command: 'node tests/e2e/mock-api.mjs --port 8081', url: 'http://127.0.0.1:8081/__mock-api/ready', reuseExistingServer: false, timeout: 120000 },
  { command: 'npm run start -- -H 127.0.0.1 -p 8080', url: 'http://127.0.0.1:8080/auth/login', reuseExistingServer: false, timeout: 240000 },
];
const files = [...new Set(NEXT_NINE_CASES.map(row => row.file))];
const escapedTitle = value => [...value].map(char => "\\^$.*+?()[]{}|".includes(char) ? "\\" + char : char).join('');
const exactTitles = '(?:' + NEXT_NINE_CASES.map(row => escapedTitle(row.titlePath.at(-1))).join('|') + ')$';
const forbidden = ['BASE_URL', 'E2E_WEB_COMMAND', 'LUNCHLINEUP_BROWSER_COHORT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'CONTAINER_HOST'];
function contextPath() {
  return `${process.env.RUNNER_TEMP}/lunchlineup-source-${process.env.CI_RUN_ID}/source-context.json`;
}
function selectedProfile() {
  const profile = readFixedBrowserSourceProfile({ contextPath: contextPath() });
  if (profile?.pipelinePath !== MOCK_PIPELINE) return null;
  return profile;
}
export function mockNextNineConfiguration() {
  const profile = selectedProfile();
  if (!profile) return null;
  if (forbidden.some(name => process.env[name] !== undefined) ||
      process.env.E2E_FULL_STACK !== '0' || process.env.E2E_MOCK_API !== '1' ||
      process.env.E2E_SIGNUP_MODE !== 'open' || process.env.PLAYWRIGHT_PORT !== '8080' ||
      process.env.PLAYWRIGHT_API_PORT !== '8081' || process.env.CI !== '1' ||
      process.env.DATA_TARGET_ENV !== 'disposable' || process.env.APP_ENV !== 'test' ||
      process.env.DEPLOY_ENV !== 'test' || process.env.NEXT_PUBLIC_APP_ORIGIN !== 'http://127.0.0.1:8080' ||
      process.env.NEXT_TELEMETRY_DISABLED !== '1') throw new Error('Fixed mock UX environment mismatch.');
  const phase = JSON.parse(execFileSync('/usr/bin/python3', [resolve(import.meta.dirname, 'read-fixed-browser-phase.py'), '--mock-ux-next-nine-json'], { encoding: 'utf8' }));
  if (phase.sourceSha !== profile.sourceSha || phase.pipelineSha256 !== profile.pipelineSha256 ||
      phase.kind !== 'fixed-mock-ux-next-nine-runtime' || phase.phase !== 'runtime') throw new Error('Fixed mock UX phase mismatch.');
  return { kind: 'fixed-nine-mock-ux', sourceSha: profile.sourceSha, runId: process.env.CI_RUN_ID,
    selectionSha256: phase.selectionSha256, servers: MOCK_SERVERS, traces: 'on',
    chromiumSandbox: true, servingMode: 'production', concurrency: 1, expectedWorkerLifetimes: 2 };
}
function run() {
  const contract = mockNextNineConfiguration();
  if (!contract) throw new Error('Fixed mock UX profile required.');
  const build = resolve(import.meta.dirname, '..');
  const workspace = process.env.CI_WORKSPACE;
  const artifacts = resolve(workspace, '.release/internal-ci', contract.sourceSha);
  const output = resolve(artifacts, 'mock-ux-next-nine');
  mkdirSync(output, { mode: 0o700 }); // exclusive; no reused result directory
  const environment = { ...process.env, E2E_ARTIFACT_ROOT: output };
  // One local budget includes discovery, all offline compilation and the sole execution.
  // The independently armed owner deadline remains authoritative and may expire earlier.
  const deadline = performance.now() + 1500000;
  function remaining(maximum = 1500000) {
    const left = Math.floor(Math.min(maximum, deadline - performance.now()));
    if (left <= 0) throw new Error('Fixed mock UX deadline exhausted.');
    return left;
  }
  let integrityIndex = 0;
  function verifySource() {
    const log = openSync(resolve(output, 'source-integrity-' + integrityIndex++ + '.log'), 'wx', 0o600);
    try {
      execFileSync(process.execPath, [resolve(build, 'scripts/verify-internal-ci-source-clone.mjs'),
        '--proof', resolve(artifacts, 'source/source-proof.json'), '--clone', build,
        '--purpose', 'build', '--require-clean'], { env: environment, timeout: remaining(), stdio: ['ignore', log, log] });
    } finally { closeSync(log); }
  }
  // No additional test invocation: preserve previous isolation credit. The
  // root pre-entry sandbox covers both plain and guarded fixture workers.
  const args = ['test', '--project=chromium', '--workers=1', '--retries=0', '--repeat-each=1',
    '--forbid-only', '--reporter=json', '--grep', exactTitles, ...files.map(file => 'tests/e2e/' + file)];
  const manifest = resolve(build, '.ci/development-mock-ux-next-nine-cases.json');
  const verifier = resolve(build, 'scripts/verify-development-browser-report.mjs');
  function invoke(list) {
    const name = list ? 'selection' : 'results';
    const log = openSync(resolve(output, name + '.log'), 'wx', 0o600);
    try {
      const result = spawnSync(resolve(build, 'node_modules/.bin/playwright'), [...args, ...(list ? ['--list'] : [])],
        { cwd: resolve(build, 'apps/web'), env: { ...environment, PLAYWRIGHT_JSON_OUTPUT_NAME: resolve(output, name + '.json') },
          stdio: ['ignore', log, log], timeout: remaining() });
      if (result.status !== 0) throw new Error('Mock UX ' + name + ' failed; original evidence retained.');
    } finally { closeSync(log); }
  }
  invoke(true);
  const selection = resolve(output, 'selection.json');
  const selectionProof = execFileSync(process.execPath, [verifier, '--selection', manifest, 'mock-ux-next-nine', selection], { encoding: 'utf8', timeout: remaining() });
  writeFileSync(resolve(output, 'selection-proof.json'), selectionProof, { flag: 'wx', mode: 0o600 });
  verifySource();
  try {
    lstatSync(resolve(build, 'apps/web/.next'));
    throw new Error('Mock UX refuses a reused Next output.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // All writable outputs/caches are already confined to the hard-limited job filesystem.
  // No server or dependency acquisition runs during this offline compilation.
  for (const [name, cwd, command, arguments_] of [
    ['api-contract-build', build, 'npm', ['run', 'build', '--workspace', '@lunchlineup/api-contract']],
    ['config-build', build, 'npm', ['run', 'build', '--workspace', '@lunchlineup/config']],
    ['web-build', resolve(build, 'apps/web'), 'npm', ['run', 'build']],
  ]) {
    const log = openSync(resolve(output, name + '.log'), 'wx', 0o600);
    try {
      const result = spawnSync(command, arguments_, { cwd, env: { ...environment, ...MOCK_WEB_ENV },
        stdio: ['ignore', log, log], timeout: remaining(600000) });
      if (result.error || result.signal || result.status !== 0) throw new Error('Mock UX ' + name + ' failed; original evidence retained.');
    } finally { closeSync(log); }
    verifySource();
  }
  const buildId = readFileSync(resolve(build, 'apps/web/.next/BUILD_ID'), 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(buildId)) throw new Error('Missing/invalid compiled mock build identity.');
  writeFileSync(resolve(output, 'build-proof.json'), JSON.stringify({ sourceSha: contract.sourceSha,
    runId: contract.runId, buildId, servingMode: 'production', network: 'owner-admitted-loopback-only',
    sourceIntegrityChecked: true, releaseQualified: false }) + '\n', { flag: 'wx', mode: 0o600 });
  invoke(false);
  verifySource();
  const proof = execFileSync(process.execPath, [verifier, '--complete-next-nine', manifest, 'mock-ux-next-nine', selection,
    resolve(output, 'results.json'), contract.sourceSha, contract.runId, resolve(output, 'results/artifacts')], { encoding: 'utf8', timeout: remaining() });
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
