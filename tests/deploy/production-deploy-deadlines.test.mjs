import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  automaticRollbackMutationNotAfterEpochSeconds,
  createProductionDeployDeadline,
  remainingProductionDeployPhaseSeconds,
  validateProductionDeployDeadlines,
} from '../../scripts/validate-production-deploy-deadlines.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
const deploy = workflow.jobs['deploy-production'];
const step = (name) => deploy.steps.find((candidate) => candidate.name === name);
const aggregateStep = step('17. Guarded production deploy; Reconcile exact VM217 active release, services, and legacy traffic state; cleanup');

const bashCandidates = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash']
  : ['bash'];
const bashPath = bashCandidates.find((candidate) => spawnSync(
  candidate,
  ['-c', 'command -v timeout >/dev/null 2>&1'],
  { encoding: 'utf8' },
).status === 0);
const bashPathFor = (path) => path.replaceAll('\\', '/');

test('normal production deploy aggregate fits its exact outer job deadline', () => {
  const result = validateProductionDeployDeadlines(deploy.env);
  assert.equal(result.transactionSeconds, deploy['timeout-minutes'] * 60);
  assert.equal(result.phaseSeconds, 5_400);
  assert.equal(result.ownedSeconds, 4_800);
  assert.equal(result.postMutationReserveSeconds, 720);
  assert.equal(result.runnerReserveSeconds, 600);
  assert.equal(result.aggregateSeconds, result.phaseSeconds);
  assert.equal(result.automaticRollbackPostMutationReserveSeconds, 900);
  assert.equal(deploy.env.PRODUCTION_DEPLOY_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS, '120');

  const compatibility = step('Execute previous release against candidate schema clone').run;
  assert.match(compatibility, /provision_seconds="\$\(phase_seconds compatibility "\$PRODUCTION_DEPLOY_CLONE_PROVISION_TIMEOUT_SECONDS"\)"/);
  assert.match(compatibility, /"\$\{provision_seconds\}s" \\\n+\s+"\$clone_driver"/);
  assert.match(compatibility, /preflight_seconds="\$\(phase_seconds compatibility "\$PRODUCTION_DEPLOY_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS"\)"/);
  assert.match(compatibility, /"\$\{preflight_seconds\}s" \\\n+\s+node scripts\/old-release-compatibility-harness\.mjs preflight/);
  assert.match(compatibility, /provider_seconds="\$\(phase_seconds compatibility "\$PRODUCTION_DEPLOY_COMPATIBILITY_PROVIDER_TIMEOUT_SECONDS"\)"/);
  assert.match(compatibility, /"\$\{provider_seconds\}s" \\\n+\s+node scripts\/old-release-compatibility-harness\.mjs run/);
  assert.match(compatibility, /cleanup_compatibility_clone\(\)[\s\S]*phase_seconds compatibility-cleanup[\s\S]*trap cleanup_compatibility_clone EXIT/);
  assert.match(compatibility, /destroy-old-release-compatibility-clone\.sh[\s\S]*--timeout-seconds "\$cleanup_seconds"/);
  const cleanupTrapIndex = compatibility.indexOf('trap cleanup_compatibility_clone EXIT');
  const preflightIndex = compatibility.indexOf('node scripts/old-release-compatibility-harness.mjs preflight');
  const providerIndex = compatibility.indexOf('node scripts/old-release-compatibility-harness.mjs run');
  assert.ok(cleanupTrapIndex >= 0 && cleanupTrapIndex < preflightIndex);
  assert.ok(preflightIndex < providerIndex);
  assert.equal((compatibility.match(/old-release-compatibility-harness\.mjs preflight/g) ?? []).length, 1);
  assert.equal((compatibility.match(/old-release-compatibility-harness\.mjs run/g) ?? []).length, 1);
  assert.doesNotMatch(compatibility, /--foreground/);
  const captureIndex = deploy.steps.findIndex(({ name }) => name === 'Capture production deploy runner deadline origin');
  const checkoutIndex = deploy.steps.findIndex(({ uses }) => uses?.startsWith('actions/checkout@'));
  const startIndex = deploy.steps.findIndex(({ name }) => name === 'Start production deploy aggregate deadline');
  const setupIndex = deploy.steps.findIndex(({ uses }) => uses?.startsWith('actions/setup-node@'));
  assert.ok(captureIndex >= 0 && captureIndex < checkoutIndex);
  assert.ok(checkoutIndex < startIndex && startIndex < setupIndex);
  assert.match(step('Start production deploy aggregate deadline').run, /validate-production-deploy-deadlines\.mjs start --github-env/);
  for (const [phase, maximum] of [
    ['mutation', 'VM217_MUTATION_BUDGET_SECONDS'],
    ['reconciliation', 'PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS'],
    ['cleanup', 'PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS'],
  ]) {
    assert.match(
      aggregateStep.run,
      new RegExp(`validate-production-deploy-deadlines\\.mjs remaining[\\s\\S]*--phase ${phase}[\\s\\S]*--maximum-seconds "\\$${maximum}"`),
    );
  }
  assert.doesNotMatch(aggregateStep.run, /\bphase_seconds\s*\(\)|\bfunction\s+[A-Za-z_]/);
  assert.match(aggregateStep.run, /timeout[\s\S]*--signal=TERM[\s\S]*--kill-after="\$\{PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS\}s"/);
  assert.doesNotMatch(aggregateStep.run, /timeout[\s\S]*--foreground/);
  assert.doesNotMatch(aggregateStep.run, /PRODUCTION_DEPLOY_COMMAND|lunchlineup-deploy-production\.sh/);
  assert.equal((aggregateStep.run.match(/bash scripts\/deploy-vm217-transport\.sh/g) ?? []).length, 2);
  for (const fixedInput of [
    '--host "$VM217_HOST"',
    '--user "$VM217_USER"',
    '--private-key "$private_key"',
    '--known-hosts "$known_hosts"',
    '--release-manifest "$RELEASE_MANIFEST_PATH"',
    '--runtime-env "$PRODUCTION_RUNTIME_ENV_PATH"',
    '--launch-proof "$launch_proof"',
    '--source-sha "$RELEASE_SOURCE_SHA"',
  ]) {
    assert.equal(aggregateStep.run.split(fixedInput).length - 1, 2, fixedInput);
  }
  assert.ok(aggregateStep.run.indexOf('bash scripts/deploy-vm217-transport.sh') < aggregateStep.run.indexOf('VM217_RECONCILE_ONLY=true'));
  assert.ok(aggregateStep.run.indexOf('VM217_RECONCILE_ONLY=true') < aggregateStep.run.indexOf('destroy-old-release-compatibility-clone.sh'));
  const fallbackCleanup = step('Cleanup production runtime environment and rollback secrets').run;
  assert.match(fallbackCleanup, /--phase runner-cleanup/);
  assert.match(fallbackCleanup, /destroy-old-release-compatibility-clone\.sh/);
  assert.match(fallbackCleanup, /--kill-after="\$\{PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS\}s"/);
});

test('normal production deploy deadline contract rejects every declared maximum overrun', () => {
  for (const [name, value] of [
    ['PRODUCTION_RELEASE_TRANSACTION_TIMEOUT_SECONDS', '10801'],
    ['PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS', '7201'],
    ['PRODUCTION_AUTOMATIC_ROLLBACK_POST_MUTATION_RESERVE_SECONDS', '1801'],
    ['PRODUCTION_DEPLOY_CLONE_PROVISION_TIMEOUT_SECONDS', '601'],
    ['PRODUCTION_DEPLOY_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS', '601'],
    ['PRODUCTION_DEPLOY_COMPATIBILITY_PROVIDER_TIMEOUT_SECONDS', '1801'],
    ['VM217_MUTATION_BUDGET_SECONDS', '1801'],
    ['VM217_SSH_COMMAND_TIMEOUT_SECONDS', '1801'],
    ['PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS', '601'],
    ['PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS', '601'],
    ['PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS', '601'],
    ['PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS', '61'],
    ['PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS', '601'],
  ]) {
    assert.throws(
      () => validateProductionDeployDeadlines({ ...deploy.env, [name]: value }),
      new RegExp(`${name} must be an integer`),
      name,
    );
  }
});

test('normal production deploy deadline contract rejects invalid reserves and split mutation owners', () => {
  assert.throws(
    () => validateProductionDeployDeadlines({
      ...deploy.env,
      PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS: '1300',
    }),
    /reserves 1440s must be less than deploy phase deadline 1300s/,
  );
  assert.throws(
    () => validateProductionDeployDeadlines({ ...deploy.env, VM217_SSH_COMMAND_TIMEOUT_SECONDS: '1799' }),
    /VM217_MUTATION_BUDGET_SECONDS must equal VM217_SSH_COMMAND_TIMEOUT_SECONDS/,
  );
});

test('absolute phase deadlines debit delayed setup and preserve reconciliation and cleanup reserves', () => {
  const startedAt = 2_000_000_000;
  const deadline = createProductionDeployDeadline(deploy.env, startedAt);
  const deadlineEnv = {
    ...deploy.env,
    PRODUCTION_DEPLOY_STARTED_AT_EPOCH_SECONDS: String(startedAt),
    PRODUCTION_DEPLOY_AGGREGATE_NOT_AFTER_EPOCH_SECONDS: String(deadline.aggregateNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_RUNNER_CLEANUP_NOT_AFTER_EPOCH_SECONDS: String(deadline.runnerCleanupNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_RECONCILIATION_NOT_AFTER_EPOCH_SECONDS: String(deadline.reconciliationNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_MUTATION_NOT_AFTER_EPOCH_SECONDS: String(deadline.mutationNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_COMPATIBILITY_NOT_AFTER_EPOCH_SECONDS: String(deadline.compatibilityNotAfterEpochSeconds),
    PRODUCTION_RELEASE_TRANSACTION_NOT_AFTER_EPOCH_SECONDS: String(deadline.transactionNotAfterEpochSeconds),
  };

  assert.equal(deadline.aggregateNotAfterEpochSeconds, startedAt + 4_800);
  assert.equal(deadline.runnerCleanupNotAfterEpochSeconds, startedAt + 5_400);
  assert.equal(deadline.transactionNotAfterEpochSeconds, startedAt + 10_800);
  assert.equal(deadline.reconciliationNotAfterEpochSeconds, startedAt + 4_200);
  assert.equal(deadline.mutationNotAfterEpochSeconds, startedAt + 4_080);
  assert.equal(deadline.compatibilityNotAfterEpochSeconds, startedAt + 3_960);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'compatibility', startedAt + 3_900, 1_800), 55);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'compatibility-cleanup', startedAt + 3_960, 600), 115);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'mutation', startedAt + 1_000, 1_800), 1_800);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'mutation', startedAt + 3_000, 1_800), 1_075);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'reconciliation', startedAt + 4_080, 600), 115);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'cleanup', startedAt + 4_200, 600), 595);
  assert.equal(remainingProductionDeployPhaseSeconds(deadlineEnv, 'runner-cleanup', startedAt + 4_800, 600), 595);
  assert.throws(
    () => remainingProductionDeployPhaseSeconds(deadlineEnv, 'mutation', startedAt + 4_075, 1_800),
    /mutation deadline is exhausted/,
  );
  assert.equal(
    automaticRollbackMutationNotAfterEpochSeconds(deadlineEnv, startedAt + 5_400),
    startedAt + 9_900,
  );
  assert.throws(
    () => automaticRollbackMutationNotAfterEpochSeconds(deadlineEnv, startedAt + 9_895),
    /automatic rollback mutation deadline is exhausted/,
  );
});

test('nearly exhausted absolute owner hard-kills a TERM-ignoring provider and still destroys its clone', { skip: !bashPath }, () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'lunchlineup-deadline-owner-'));
  const provider = join(fixtureDir, 'provider.sh');
  const destroy = join(fixtureDir, 'destroy.sh');
  const log = join(fixtureDir, 'owner.log');
  writeFileSync(provider, '#!/usr/bin/env bash\ntrap \'\' TERM\nwhile :; do sleep 1; done\n', { mode: 0o700 });
  writeFileSync(destroy, '#!/usr/bin/env bash\nprintf \'clone_destroyed\\n\' >> "$OWNER_FIXTURE_LOG"\n', { mode: 0o700 });
  chmodSync(provider, 0o700);
  chmodSync(destroy, 0o700);

  const shortEnv = {
    ...deploy.env,
    PRODUCTION_RELEASE_TRANSACTION_TIMEOUT_SECONDS: '60',
    PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS: '30',
    PRODUCTION_AUTOMATIC_ROLLBACK_POST_MUTATION_RESERVE_SECONDS: '10',
    PRODUCTION_DEPLOY_CLONE_PROVISION_TIMEOUT_SECONDS: '10',
    PRODUCTION_DEPLOY_COMPATIBILITY_PROVIDER_TIMEOUT_SECONDS: '10',
    VM217_MUTATION_BUDGET_SECONDS: '5',
    VM217_SSH_COMMAND_TIMEOUT_SECONDS: '5',
    PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS: '6',
    PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS: '3',
    PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS: '3',
    PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS: '1',
    PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS: '3',
  };
  const startedAt = Math.floor(Date.now() / 1_000) - 11;
  const deadline = createProductionDeployDeadline(shortEnv, startedAt);
  const deadlineEnv = {
    ...shortEnv,
    PRODUCTION_DEPLOY_STARTED_AT_EPOCH_SECONDS: String(startedAt),
    PRODUCTION_DEPLOY_AGGREGATE_NOT_AFTER_EPOCH_SECONDS: String(deadline.aggregateNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_RUNNER_CLEANUP_NOT_AFTER_EPOCH_SECONDS: String(deadline.runnerCleanupNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_RECONCILIATION_NOT_AFTER_EPOCH_SECONDS: String(deadline.reconciliationNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_MUTATION_NOT_AFTER_EPOCH_SECONDS: String(deadline.mutationNotAfterEpochSeconds),
    PRODUCTION_DEPLOY_COMPATIBILITY_NOT_AFTER_EPOCH_SECONDS: String(deadline.compatibilityNotAfterEpochSeconds),
    PRODUCTION_RELEASE_TRANSACTION_NOT_AFTER_EPOCH_SECONDS: String(deadline.transactionNotAfterEpochSeconds),
  };

  try {
    const result = spawnSync(bashPath, ['-c', `
set -euo pipefail
cleanup_clone() {
  operation_status=$?
  trap - EXIT
  cleanup_seconds="$("$NODE_BINARY" "$DEADLINE_OWNER" remaining --phase compatibility-cleanup --maximum-seconds "$PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS")"
  timeout --signal=TERM --kill-after="\${PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS}s" "\${cleanup_seconds}s" "$DESTROY_FIXTURE"
  exit "$operation_status"
}
trap cleanup_clone EXIT
provider_seconds="$("$NODE_BINARY" "$DEADLINE_OWNER" remaining --phase compatibility --maximum-seconds "$PRODUCTION_DEPLOY_COMPATIBILITY_PROVIDER_TIMEOUT_SECONDS")"
printf 'provider_started:%s\\n' "$provider_seconds" >> "$OWNER_FIXTURE_LOG"
timeout --signal=TERM --kill-after="\${PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS}s" "\${provider_seconds}s" "$PROVIDER_FIXTURE"
`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        ...deadlineEnv,
        DEADLINE_OWNER: bashPathFor(join(root, 'scripts/validate-production-deploy-deadlines.mjs')),
        DESTROY_FIXTURE: bashPathFor(destroy),
        NODE_BINARY: bashPathFor(process.execPath),
        OWNER_FIXTURE_LOG: bashPathFor(log),
        PROVIDER_FIXTURE: bashPathFor(provider),
      },
    });

    assert.ok([124, 137].includes(result.status), `${result.stdout}\n${result.stderr}`);
    const ownerLog = readFileSync(log, 'utf8');
    assert.match(ownerLog, /provider_started:[1-3]/);
    assert.match(ownerLog, /clone_destroyed/);
    assert.equal(result.signal, null);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
