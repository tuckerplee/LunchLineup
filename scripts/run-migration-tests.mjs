import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { runBoundedProcess } from './bounded-child-process.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FILE_TIMEOUT_MS = 120_000;
const MIN_FILE_TIMEOUT_MS = 10_000;
const MAX_FILE_TIMEOUT_MS = 600_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 3_600_000;
const MIN_TOTAL_TIMEOUT_MS = 60_000;
const MAX_TOTAL_TIMEOUT_MS = 7_200_000;
const FILE_TIMEOUT_OVERRIDES_MS = new Map([
  // This deploy file runs multiple signed-evidence and cross-process recovery
  // simulations serially. It is intentionally comprehensive and exceeds the
  // ordinary contract-test budget on Windows without being nondeterministic.
  ['tests/deploy/backup-restore-dr.test.mjs', 600_000],
  // The VM217 transport fixture invokes the actual bounded command owner for
  // each SSH/SCP operation. Its timeout probes independently require a
  // 45-second child to be stopped within 20 seconds on Windows, while the
  // full cross-platform contract suite takes about 156 seconds there.
  ['tests/deploy/deploy-vm217-transport.test.mjs', 240_000],
  // The one-time cutover fixture exercises fourteen complete external adapter
  // and exact-state recovery paths. On Windows its bounded, real-process run
  // measures about 200 seconds; retain a fixed 240-second ceiling.
  ['tests/deploy/initial-vm217-cutover.test.mjs', 240_000],
  // Retained rollback transport exercises fifteen complete state-recovery
  // paths. Its measured Windows run is about 254 seconds, so leave a fixed
  // five-minute ceiling rather than treating the generic two-minute cap as a
  // product failure.
  ['tests/deploy/rollback-vm217-transport.test.mjs', 300_000],
  // Durable runtime activation deliberately exercises both failed deployment
  // restoration and each pointer-commit recovery path. Its measured Windows
  // run is about 205 seconds, so use the same fixed four-minute ceiling as
  // the initial cutover fixture.
  ['tests/deploy/runtime-env-durability.test.mjs', 240_000],
]);
const WINDOWS_ATTACHED_TESTS = new Set([
  // These fixtures invoke Git Bash-backed transport owners that must retain
  // normal Windows parent/child console ownership. The shared timeout owner
  // still uses taskkill /T /F to bound each inherited tree.
  'tests/deploy/deploy-vm217-transport.test.mjs',
  'tests/deploy/initial-vm217-cutover.test.mjs',
]);

const groups = [
  ['deploy', 'tests/deploy'],
  ['hygiene', 'tests/hygiene'],
  ['migration', 'tests/migration'],
  ['terraform', 'infrastructure/terraform/production'],
];

function positiveInteger(value, fallback, name, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function requestedGroups(value) {
  if (!value) return groups;
  const names = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('LUNCHLINEUP_MIGRATION_TEST_GROUPS must name at least one group.');
  const selected = groups.filter(([name]) => names.includes(name));
  if (selected.length !== names.length || new Set(names).size !== names.length) {
    throw new Error(`LUNCHLINEUP_MIGRATION_TEST_GROUPS must use only: ${groups.map(([name]) => name).join(', ')}.`);
  }
  return selected;
}

function filesFor(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => join(directory, entry.name).replaceAll('\\', '/'))
    .sort((left, right) => left.localeCompare(right));
}

function elapsed(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const dryRun = arguments_.length === 1 && arguments_[0] === '--dry-run';
  if (arguments_.length > 1 || (arguments_.length === 1 && !dryRun)) {
    throw new Error('Usage: node scripts/run-migration-tests.mjs [--dry-run]');
  }
  const configuredTimeoutMs = positiveInteger(
    process.env.LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS,
    DEFAULT_FILE_TIMEOUT_MS,
    'LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS',
    MIN_FILE_TIMEOUT_MS,
    MAX_FILE_TIMEOUT_MS,
  );
  const totalTimeoutMs = positiveInteger(
    process.env.LUNCHLINEUP_MIGRATION_TEST_TOTAL_TIMEOUT_MS,
    DEFAULT_TOTAL_TIMEOUT_MS,
    'LUNCHLINEUP_MIGRATION_TEST_TOTAL_TIMEOUT_MS',
    MIN_TOTAL_TIMEOUT_MS,
    MAX_TOTAL_TIMEOUT_MS,
  );
  const selectedGroups = requestedGroups(process.env.LUNCHLINEUP_MIGRATION_TEST_GROUPS);
  const plan = selectedGroups.flatMap(([group, directory]) => (
    filesFor(directory).map((file) => ({
      group,
      file,
      timeoutMs: process.env.LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS
        ? configuredTimeoutMs
        : (FILE_TIMEOUT_OVERRIDES_MS.get(file) ?? configuredTimeoutMs),
    }))
  ));
  if (plan.length === 0) throw new Error('Migration test plan is empty.');

  const overriddenFiles = plan.filter((entry) => entry.timeoutMs !== configuredTimeoutMs);
  console.log(`migration-test-runner plan=${plan.length} file_timeout_ms=${configuredTimeoutMs} total_timeout_ms=${totalTimeoutMs} overridden_files=${overriddenFiles.length} mode=${dryRun ? 'dry-run' : 'run'}`);
  for (const [group] of selectedGroups) {
    console.log(`migration-test-runner group=${group} files=${plan.filter((entry) => entry.group === group).length}`);
  }
  if (dryRun) return;

  const runStartedAt = Date.now();
  const deadline = runStartedAt + totalTimeoutMs;
  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    const startedAt = Date.now();
    const remainingMs = deadline - startedAt;
    if (remainingMs < MIN_FILE_TIMEOUT_MS) {
      console.error(`migration-test-runner failed=${index + 1}/${plan.length} group=${entry.group} file=${entry.file} elapsed=${elapsed(runStartedAt)} reason=aggregate deadline exhausted before file start`);
      process.exitCode = 1;
      return;
    }
    const effectiveTimeoutMs = Math.min(entry.timeoutMs, remainingMs);
    console.log(`migration-test-runner start=${index + 1}/${plan.length} group=${entry.group} file=${entry.file} timeout_ms=${entry.timeoutMs} effective_timeout_ms=${effectiveTimeoutMs}`);
    try {
      await runBoundedProcess(process.execPath, ['--test', '--test-concurrency=1', entry.file], {
        cwd: root,
        env: process.env,
        timeoutMs: effectiveTimeoutMs,
        label: `Migration test ${entry.file}`,
        // Most tests retain detached ownership so POSIX cleanup can target a
        // process group. The one Git Bash transport fixture needs an inherited
        // Windows console tree; taskkill /T /F still bounds that tree.
        detached: process.platform !== 'win32' || !WINDOWS_ATTACHED_TESTS.has(entry.file),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown failure';
      console.error(`migration-test-runner failed=${index + 1}/${plan.length} group=${entry.group} file=${entry.file} elapsed=${elapsed(startedAt)} reason=${message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`migration-test-runner passed=${index + 1}/${plan.length} group=${entry.group} file=${entry.file} elapsed=${elapsed(startedAt)}`);
  }
  console.log(`migration-test-runner passed=all files=${plan.length} elapsed=${elapsed(runStartedAt)}`);
}

await main().catch((error) => {
  console.error(`migration-test-runner configuration_error=${error instanceof Error ? error.message : 'unknown failure'}`);
  process.exitCode = 1;
});
