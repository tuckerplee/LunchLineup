#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const limits = Object.freeze({
  PRODUCTION_RELEASE_TRANSACTION_TIMEOUT_SECONDS: [1, 10_800],
  PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS: [1, 7_200],
  PRODUCTION_AUTOMATIC_ROLLBACK_POST_MUTATION_RESERVE_SECONDS: [1, 1_800],
  PRODUCTION_DEPLOY_CLONE_PROVISION_TIMEOUT_SECONDS: [1, 600],
  PRODUCTION_DEPLOY_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS: [1, 600],
  PRODUCTION_DEPLOY_COMPATIBILITY_PROVIDER_TIMEOUT_SECONDS: [1, 1_800],
  VM217_MUTATION_BUDGET_SECONDS: [1, 1_800],
  VM217_SSH_COMMAND_TIMEOUT_SECONDS: [1, 1_800],
  PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS: [1, 600],
  PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS: [1, 600],
  PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS: [1, 600],
  PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS: [1, 60],
  PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS: [1, 600],
});

const phaseDeadlineNames = Object.freeze({
  compatibility: 'PRODUCTION_DEPLOY_COMPATIBILITY_NOT_AFTER_EPOCH_SECONDS',
  'compatibility-cleanup': 'PRODUCTION_DEPLOY_MUTATION_NOT_AFTER_EPOCH_SECONDS',
  mutation: 'PRODUCTION_DEPLOY_MUTATION_NOT_AFTER_EPOCH_SECONDS',
  reconciliation: 'PRODUCTION_DEPLOY_RECONCILIATION_NOT_AFTER_EPOCH_SECONDS',
  cleanup: 'PRODUCTION_DEPLOY_AGGREGATE_NOT_AFTER_EPOCH_SECONDS',
  'runner-cleanup': 'PRODUCTION_DEPLOY_RUNNER_CLEANUP_NOT_AFTER_EPOCH_SECONDS',
});

function positiveBoundedInteger(env, name, [minimum, maximum]) {
  const value = String(env[name] ?? '');
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const normalized = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function validateProductionDeployDeadlines(env = process.env) {
  const values = Object.fromEntries(
    Object.entries(limits).map(([name, range]) => [name, positiveBoundedInteger(env, name, range)]),
  );
  if (values.VM217_MUTATION_BUDGET_SECONDS !== values.VM217_SSH_COMMAND_TIMEOUT_SECONDS) {
    throw new Error('VM217_MUTATION_BUDGET_SECONDS must equal VM217_SSH_COMMAND_TIMEOUT_SECONDS.');
  }

  const postMutationReserveSeconds = values.PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS
    + values.PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS;
  const reservedSeconds = postMutationReserveSeconds + values.PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS;
  const totalReservedSeconds = reservedSeconds
    + values.PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS;
  if (totalReservedSeconds >= values.PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS) {
    throw new Error(
      `Production deploy reserves ${totalReservedSeconds}s must be less than deploy phase deadline ${values.PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS}s.`,
    );
  }
  if (values.PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS
    >= values.PRODUCTION_RELEASE_TRANSACTION_TIMEOUT_SECONDS
      - values.PRODUCTION_AUTOMATIC_ROLLBACK_POST_MUTATION_RESERVE_SECONDS) {
    throw new Error('Production deploy phase must end before the automatic rollback mutation cutoff.');
  }
  if (values.PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS >= values.PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS
    || values.PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS >= values.PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS
    || values.PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS >= values.PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS
    || values.PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS >= values.PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS) {
    throw new Error('Production deploy TERM-to-KILL reserve must fit inside compatibility cleanup, reconciliation, cleanup, and runner reserves.');
  }

  const ownedSeconds = values.PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS
    - values.PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS;
  return {
    values,
    transactionSeconds: values.PRODUCTION_RELEASE_TRANSACTION_TIMEOUT_SECONDS,
    phaseSeconds: values.PRODUCTION_DEPLOY_PHASE_TIMEOUT_SECONDS,
    ownedSeconds,
    postMutationReserveSeconds,
    runnerReserveSeconds: values.PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS,
    aggregateSeconds: ownedSeconds + values.PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS,
    automaticRollbackPostMutationReserveSeconds:
      values.PRODUCTION_AUTOMATIC_ROLLBACK_POST_MUTATION_RESERVE_SECONDS,
  };
}

export function createProductionDeployDeadline(env = process.env, startedAtEpochSeconds = Math.floor(Date.now() / 1_000)) {
  const result = validateProductionDeployDeadlines(env);
  const startedAt = positiveInteger(startedAtEpochSeconds, 'production deploy start epoch');
  const aggregateNotAfter = startedAt + result.ownedSeconds;
  const transactionNotAfter = startedAt + result.transactionSeconds;
  const runnerCleanupNotAfter = startedAt + result.phaseSeconds;
  const reconciliationNotAfter = aggregateNotAfter
    - result.values.PRODUCTION_DEPLOY_CLEANUP_RESERVE_SECONDS;
  const mutationNotAfter = reconciliationNotAfter
    - result.values.PRODUCTION_DEPLOY_RECONCILIATION_RESERVE_SECONDS;
  const compatibilityNotAfter = mutationNotAfter
    - result.values.PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS;
  return {
    ...result,
    startedAtEpochSeconds: startedAt,
    transactionNotAfterEpochSeconds: transactionNotAfter,
    aggregateNotAfterEpochSeconds: aggregateNotAfter,
    runnerCleanupNotAfterEpochSeconds: runnerCleanupNotAfter,
    reconciliationNotAfterEpochSeconds: reconciliationNotAfter,
    mutationNotAfterEpochSeconds: mutationNotAfter,
    compatibilityNotAfterEpochSeconds: compatibilityNotAfter,
  };
}

function readDeadlineState(env) {
  const deadline = createProductionDeployDeadline(
    env,
    positiveInteger(env.PRODUCTION_DEPLOY_STARTED_AT_EPOCH_SECONDS, 'PRODUCTION_DEPLOY_STARTED_AT_EPOCH_SECONDS'),
  );
  const expected = {
    PRODUCTION_DEPLOY_AGGREGATE_NOT_AFTER_EPOCH_SECONDS: deadline.aggregateNotAfterEpochSeconds,
    PRODUCTION_DEPLOY_RUNNER_CLEANUP_NOT_AFTER_EPOCH_SECONDS: deadline.runnerCleanupNotAfterEpochSeconds,
    PRODUCTION_DEPLOY_RECONCILIATION_NOT_AFTER_EPOCH_SECONDS: deadline.reconciliationNotAfterEpochSeconds,
    PRODUCTION_DEPLOY_MUTATION_NOT_AFTER_EPOCH_SECONDS: deadline.mutationNotAfterEpochSeconds,
    PRODUCTION_DEPLOY_COMPATIBILITY_NOT_AFTER_EPOCH_SECONDS: deadline.compatibilityNotAfterEpochSeconds,
    PRODUCTION_RELEASE_TRANSACTION_NOT_AFTER_EPOCH_SECONDS: deadline.transactionNotAfterEpochSeconds,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (positiveInteger(env[name], name) !== value) {
      throw new Error(`${name} does not match the deadline owner's absolute schedule.`);
    }
  }
  return deadline;
}

export function automaticRollbackMutationNotAfterEpochSeconds(
  env = process.env,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
) {
  const deadline = readDeadlineState(env);
  const now = positiveInteger(nowEpochSeconds, 'current epoch');
  const mutationNotAfter = deadline.transactionNotAfterEpochSeconds
    - deadline.automaticRollbackPostMutationReserveSeconds;
  if (now + deadline.values.PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS >= mutationNotAfter) {
    throw new Error(
      'Production automatic rollback mutation deadline is exhausted; refusing to start another mutation.',
    );
  }
  return mutationNotAfter;
}

export function remainingProductionDeployPhaseSeconds(
  env = process.env,
  phase,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
  maximumSeconds = Number.MAX_SAFE_INTEGER,
) {
  const deadline = readDeadlineState(env);
  const deadlineName = phaseDeadlineNames[phase];
  if (!deadlineName) {
    throw new Error(`Unknown production deploy phase: ${phase}.`);
  }
  const now = positiveInteger(nowEpochSeconds, 'current epoch');
  const maximum = positiveInteger(maximumSeconds, 'phase maximum seconds');
  const killReserve = deadline.values.PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS;
  const remaining = Number(env[deadlineName]) - now - killReserve;
  if (remaining < 1) {
    throw new Error(`Production deploy ${phase} deadline is exhausted; refusing to start another command.`);
  }
  return Math.min(remaining, maximum);
}

function parseCli(argv) {
  const command = argv[0] ?? 'validate';
  const options = { githubEnv: process.env.GITHUB_ENV, phase: undefined, maximumSeconds: Number.MAX_SAFE_INTEGER };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--github-env') options.githubEnv = argv[++index];
    else if (arg === '--phase') options.phase = argv[++index];
    else if (arg === '--maximum-seconds') options.maximumSeconds = argv[++index];
    else throw new Error(`Unknown option: ${arg}.`);
  }
  return { command, options };
}

function startDeadlineOwner(options) {
  if (!options.githubEnv) throw new Error('start requires --github-env or GITHUB_ENV.');
  const deadline = createProductionDeployDeadline(
    process.env,
    process.env.PRODUCTION_DEPLOY_STARTED_AT_EPOCH_SECONDS ?? Math.floor(Date.now() / 1_000),
  );
  appendFileSync(options.githubEnv, [
    `PRODUCTION_DEPLOY_STARTED_AT_EPOCH_SECONDS=${deadline.startedAtEpochSeconds}`,
    `PRODUCTION_DEPLOY_AGGREGATE_NOT_AFTER_EPOCH_SECONDS=${deadline.aggregateNotAfterEpochSeconds}`,
    `PRODUCTION_DEPLOY_RUNNER_CLEANUP_NOT_AFTER_EPOCH_SECONDS=${deadline.runnerCleanupNotAfterEpochSeconds}`,
    `PRODUCTION_DEPLOY_RECONCILIATION_NOT_AFTER_EPOCH_SECONDS=${deadline.reconciliationNotAfterEpochSeconds}`,
    `PRODUCTION_DEPLOY_MUTATION_NOT_AFTER_EPOCH_SECONDS=${deadline.mutationNotAfterEpochSeconds}`,
    `PRODUCTION_DEPLOY_COMPATIBILITY_NOT_AFTER_EPOCH_SECONDS=${deadline.compatibilityNotAfterEpochSeconds}`,
    `PRODUCTION_RELEASE_TRANSACTION_NOT_AFTER_EPOCH_SECONDS=${deadline.transactionNotAfterEpochSeconds}`,
    `VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS=${deadline.mutationNotAfterEpochSeconds}`,
    '',
  ].join('\n'), { encoding: 'utf8' });
  console.log(
    `production_deploy_deadline_started aggregate_not_after=${deadline.aggregateNotAfterEpochSeconds} compatibility_not_after=${deadline.compatibilityNotAfterEpochSeconds} mutation_not_after=${deadline.mutationNotAfterEpochSeconds} reconciliation_not_after=${deadline.reconciliationNotAfterEpochSeconds}`,
  );
}

function main() {
  try {
    const { command, options } = parseCli(process.argv.slice(2));
    if (command === 'start') {
      startDeadlineOwner(options);
      return;
    }
    if (command === 'remaining') {
      console.log(remainingProductionDeployPhaseSeconds(
        process.env,
        options.phase,
        Math.floor(Date.now() / 1_000),
        options.maximumSeconds,
      ));
      return;
    }
    if (command === 'automatic-rollback-cutoff') {
      console.log(automaticRollbackMutationNotAfterEpochSeconds(process.env));
      return;
    }
    if (command !== 'validate') throw new Error(`Unknown command: ${command}.`);
    const result = validateProductionDeployDeadlines();
    console.log(
      `production_deploy_deadline_ok transaction_seconds=${result.transactionSeconds} phase_seconds=${result.phaseSeconds} owned_seconds=${result.ownedSeconds} post_mutation_reserve_seconds=${result.postMutationReserveSeconds} runner_reserve_seconds=${result.runnerReserveSeconds}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
