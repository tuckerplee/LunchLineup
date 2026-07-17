import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflow = yaml.load(read('.github/workflows/ci.yml'));
const jobs = workflow.jobs;
const emergency = jobs['emergency-production-rollback'];
const step = (name) => emergency.steps.find((value) => value.name === name);

test('every CI job has a finite execution limit', () => {
  for (const [name, job] of Object.entries(jobs)) {
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0, `${name} must have timeout-minutes`);
  }
});

test('emergency rollback outer deadline covers every bounded stage and post-mutation reserve', () => {
  const budget = emergency.env;
  const integer = (name) => {
    assert.match(budget[name], /^[1-9][0-9]*$/, `${name} must be a positive integer string`);
    return Number(budget[name]);
  };
  const outerSeconds = emergency['timeout-minutes'] * 60;
  const declaredOuterSeconds = integer('EMERGENCY_ROLLBACK_JOB_TIMEOUT_SECONDS');
  const compatibilityTimeoutMs = integer('OLD_RELEASE_COMPATIBILITY_TIMEOUT_MS');
  assert.equal(compatibilityTimeoutMs % 1000, 0);
  const mutationSeconds = integer('VM217_MUTATION_BUDGET_SECONDS');
  assert.equal(mutationSeconds, integer('VM217_SSH_COMMAND_TIMEOUT_SECONDS'));

  const preMutationSequentialSeconds =
    integer('EMERGENCY_ROLLBACK_CLONE_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_CLONE_ENV_INSPECTION_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_COMPATIBILITY_PREFLIGHT_TIMEOUT_SECONDS')
    + 2 * integer('EMERGENCY_ROLLBACK_NPM_CI_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_PIP_INSTALL_TIMEOUT_SECONDS')
    + compatibilityTimeoutMs / 1000
    + integer('EMERGENCY_ROLLBACK_HARNESS_INSPECTION_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_CLONE_TEARDOWN_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_COMPATIBILITY_FINALIZE_TIMEOUT_SECONDS');
  const preMutationSeconds = integer('EMERGENCY_ROLLBACK_PRE_MUTATION_PHASE_SECONDS');
  assert.equal(
    preMutationSeconds,
    preMutationSequentialSeconds + integer('EMERGENCY_ROLLBACK_PRE_MUTATION_RESERVE_SECONDS'),
  );
  const postMutationSeconds =
    integer('VM217_SSH_RECONCILE_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_HEALTH_PROOF_RESERVE_SECONDS')
    + integer('EMERGENCY_ROLLBACK_REGISTRY_REPOINT_RESERVE_SECONDS')
    + integer('VM217_SSH_CLEANUP_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_CLEANUP_TIMEOUT_SECONDS')
    + integer('EMERGENCY_ROLLBACK_TIMEOUT_KILL_RESERVE_SECONDS');
  const aggregateSeconds = preMutationSeconds + mutationSeconds + postMutationSeconds;
  const runnerReserveSeconds = integer('EMERGENCY_ROLLBACK_RUNNER_RESERVE_SECONDS');

  assert.equal(declaredOuterSeconds, outerSeconds);
  assert.ok(aggregateSeconds < outerSeconds, 'internal aggregate must be strictly below the outer job deadline');
  assert.equal(aggregateSeconds + runnerReserveSeconds, outerSeconds);
  assert.ok(
    outerSeconds - preMutationSeconds - mutationSeconds >= postMutationSeconds + runnerReserveSeconds,
    'mutation timeout must return before authenticated reconciliation, health, repoint, cleanup, and runner reserve',
  );

  const deadlineStep = step('Validate emergency rollback aggregate deadline');
  assert.ok(deadlineStep);
  for (const name of Object.keys(budget)) assert.match(deadlineStep.run, new RegExp(`\\$${name}\\b|\\b${name}\\b`));

  const deadlines = read('scripts/vm217-transport-deadlines.sh');
  const transport = read('scripts/rollback-vm217-transport.sh');
  assert.match(deadlines, /VM217_MUTATION_BUDGET_SECONDS="\$\{VM217_MUTATION_BUDGET_SECONDS:-\$VM217_SSH_COMMAND_TIMEOUT_SECONDS\}"/);
  assert.match(deadlines, /VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS/);
  assert.match(deadlines, /pre-mutation cutoff passed before remote mutation began/);
  assert.match(deadlines, /vm217_run_with_mutation_budget/);
  assert.ok(
    transport.indexOf('vm217_begin_mutation_budget') < transport.indexOf('remote rollback staging allocation'),
    'the aggregate VM217 mutation budget must start before the first remote operation',
  );

  const compatibility = step('Execute target release against current production schema clone').run;
  assert.match(compatibility, /old-release-compatibility-harness\.mjs preflight/);
  assert.doesNotMatch(compatibility, /npm --prefix|python -m pip install/);
  assert.match(compatibility, /provider_dependency_seconds="\$\(\(2 \* EMERGENCY_ROLLBACK_NPM_CI_TIMEOUT_SECONDS \+ EMERGENCY_ROLLBACK_PIP_INSTALL_TIMEOUT_SECONDS\)\)"/);
  assert.match(compatibility, /OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS="\$\(\(EMERGENCY_ROLLBACK_NPM_CI_TIMEOUT_SECONDS \* 1000\)\)"/);
  assert.match(compatibility, /OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS="\$\(\(EMERGENCY_ROLLBACK_PIP_INSTALL_TIMEOUT_SECONDS \* 1000\)\)"/);
  assert.match(compatibility, /provider dependency preparation, execution, and harness inspection/);
  assert.match(compatibility, /destroy_clone[\s\S]*EMERGENCY_ROLLBACK_PRE_MUTATION_COMPATIBILITY_COMPLETE=true/);
  assert.equal((compatibility.match(/old-release-compatibility-harness\.mjs run/g) || []).length, 1);

  const mutation = step('Execute checked-in emergency rollback transport and verify release identity').run;
  assert.match(mutation, /EMERGENCY_ROLLBACK_PRE_MUTATION_COMPATIBILITY_COMPLETE/);
  assert.match(mutation, /EMERGENCY_ROLLBACK_PRE_MUTATION_PROOF_COMPLETE/);
  assert.match(mutation, /now_epoch_seconds <= VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS/);
  assert.match(mutation, /scripts\/rollback-vm217-transport\.sh/);
  assert.doesNotMatch(mutation, /PRODUCTION_ROLLBACK_COMMAND|bash \/tmp\/lunchlineup-emergency-rollback/);
});

test('manual production operations are mutually exclusive and main-only', () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.emergency_production_rollback.type, 'boolean');
  assert.equal(inputs.emergency_production_rollback.default, false);
  assert.equal(inputs.emergency_rollback_source_sha.required, false);
  assert.equal(inputs.emergency_rollback_confirmation.required, false);

  const policy = jobs['manual-production-operation-policy'];
  assert.equal(policy.if, "github.event_name == 'workflow_dispatch'");
  assert.deepEqual(policy.permissions, { contents: 'read' });
  const policyRun = policy.steps[0].run;
  assert.match(policyRun, /BOOTSTRAP_RELEASE_REGISTRY/);
  assert.match(policyRun, /EMERGENCY_PRODUCTION_ROLLBACK/);
  assert.match(policyRun, /mutually exclusive/);

  const bootstrap = jobs['bootstrap-release-registry'];
  assert.equal(bootstrap.needs, 'manual-production-operation-policy');
  assert.match(bootstrap.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(bootstrap.if, /inputs\.emergency_production_rollback != true/);

  assert.equal(emergency.needs, 'manual-production-operation-policy');
  assert.equal(emergency.environment, 'production');
  assert.deepEqual(emergency.permissions, { contents: 'read', 'id-token': 'write' });
  assert.equal(
    emergency.if,
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.emergency_production_rollback == true && inputs.bootstrap_release_registry != true",
  );
});

test('workflow-level concurrency serializes emergency rollback with main production runs', () => {
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /github\.workflow/);
  assert.match(workflow.concurrency.group, /github\.ref/);
  assert.doesNotMatch(workflow.concurrency.group, /github\.(?:sha|run_id|run_number|run_attempt)/);
});

test('emergency rollback authenticates exact target and current releases before secrets or mutation', () => {
  const names = emergency.steps.map((value) => value.name).filter(Boolean);
  const resolveIndex = names.indexOf('Resolve and authenticate target and current retained releases');
  const verifyIndex = names.indexOf('Verify retained target, current release, and rollback command');
  const secretsIndex = names.indexOf('Rehydrate current and target runtime secrets');
  const compatibilityIndex = names.indexOf('Execute target release against current production schema clone');
  const mutationIndex = names.indexOf('Execute checked-in emergency rollback transport and verify release identity');
  assert.ok(resolveIndex >= 0 && resolveIndex < verifyIndex);
  assert.ok(verifyIndex < secretsIndex && secretsIndex < compatibilityIndex && compatibilityIndex < mutationIndex);

  const intent = step('Validate protected emergency rollback intent').run;
  assert.match(intent, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(intent, /rollback-production-to:\$EMERGENCY_ROLLBACK_SOURCE_SHA/);

  const resolveRun = step('Resolve and authenticate target and current retained releases').run;
  assert.equal((resolveRun.match(/release-bundle-registry\.mjs resolve/g) || []).length, 2);
  assert.equal((resolveRun.match(/materialize-rollback-state\.mjs/g) || []).length, 2);
  assert.match(resolveRun, /--source-sha "\$EMERGENCY_ROLLBACK_SOURCE_SHA"/);
  assert.match(resolveRun, /--expected-certificate-identity "\$RELEASE_BUNDLE_CERTIFICATE_IDENTITY"/);
  assert.match(resolveRun, /--expected-oidc-issuer "\$RELEASE_BUNDLE_OIDC_ISSUER"/);
  assert.match(resolveRun, /test "\$current_sha" != "\$EMERGENCY_ROLLBACK_SOURCE_SHA"/);

  const verifyRun = step('Verify retained target, current release, and rollback command').run;
  assert.match(verifyRun, /--rollback-command-env PRODUCTION_ROLLBACK_COMMAND/);
  assert.match(verifyRun, /--post-deploy-proof-command-env PRODUCTION_POST_DEPLOY_PROOF_COMMAND/);
  assert.match(verifyRun, /--launch-proof-mode rollback/);
  assert.match(verifyRun, /\$CURRENT_RELEASE_MANIFEST_PATH/);

  const allRuns = emergency.steps.map((value) => value.run || '').join('\n');
  assert.match(allRuns, /cosign sign-blob --yes --bundle "\$signature" "\$proof"/);
  assert.doesNotMatch(allRuns, /release-bundle-registry\.mjs (?:publish|bootstrap-retained)/);
});

test('emergency rollback proves schema compatibility and post-mutation release identity', () => {
  const compatibility = step('Bind, verify, and sign emergency compatibility proof').run;
  assert.match(compatibility, /old-release-compatibility-harness\.mjs finalize/);
  assert.match(compatibility, /verify-old-release-compatibility\.mjs/);
  assert.match(compatibility, /verify-raw-migration-rollback\.mjs/);
  assert.match(compatibility, /--candidate-root "\$CURRENT_DEPLOYMENT_APP_DIR"/);
  assert.match(compatibility, /OLD_RELEASE_COMPATIBILITY_PROOF_SHA256/);

  const execute = step('Execute checked-in emergency rollback transport and verify release identity').run;
  assert.match(execute, /scripts\/rollback-vm217-transport\.sh/);
  assert.match(execute, /--compatibility-candidate-source-sha "\$ROLLBACK_CANDIDATE_SOURCE_SHA"/);
  assert.match(execute, /--runtime-secret-descriptor "\$PREVIOUS_RUNTIME_SECRET_DESCRIPTOR"/);
  assert.doesNotMatch(execute, /bash \/tmp\/lunchlineup-emergency-(?:rollback|post-deploy-proof)\.sh/);
  assert.equal((execute.match(/verify-external-health-release\.mjs/g) || []).length, 2);
  assert.match(execute, /--expect-public-html/);

  const repoint = step('Repoint and authenticate emergency rollback registry current pointer').run;
  assert.match(repoint, /release-bundle-registry\.mjs repoint/);
  assert.match(repoint, /repoint-current-to:\$PREVIOUS_RELEASE_SOURCE_SHA/);
  assert.match(repoint, /release-bundle-registry\.mjs resolve/);

  const cleanup = step('Cleanup emergency rollback material');
  assert.equal(cleanup.if, 'always()');
  assert.match(cleanup.run, /lunchlineup-current-runtime\.env/);
  assert.match(cleanup.run, /lunchlineup-emergency-rollback/);
});

test('both automatic and emergency rollback paths use the deadline-owning transport', () => {
  const centralized = jobs['deploy-production'];
  const centralizedStep = centralized.steps.find(
    (value) => value.name === 'Roll back to retained validated baseline in the approved job',
  );
  const centralizedMutation = centralizedStep.run;
  const emergencyMutation = step('Execute checked-in emergency rollback transport and verify release identity').run;

  for (const [job, mutation] of [[emergency, emergencyMutation], [centralized, centralizedMutation]]) {
    assert.equal(job.env.VM217_MUTATION_BUDGET_SECONDS, '1800');
    assert.equal(job.env.VM217_SSH_COMMAND_TIMEOUT_SECONDS, '1800');
    assert.match(mutation, /scripts\/rollback-vm217-transport\.sh/);
    assert.match(mutation, /--private-key "\$private_key"/);
    assert.match(mutation, /--known-hosts "\$known_hosts"/);
    assert.doesNotMatch(mutation, /PRODUCTION_ROLLBACK_COMMAND|bash \/tmp\/lunchlineup-(?:emergency-)?rollback/);
  }
  assert.match(centralizedMutation, /automatic-rollback-cutoff/);
  assert.match(
    centralizedMutation,
    /export VM217_MUTATION_NOT_AFTER_EPOCH_SECONDS="\$rollback_mutation_not_after"/,
  );
  assert.equal(centralizedStep.env.PRODUCTION_POST_DEPLOY_PROOF_COMMAND, undefined);
  assert.doesNotMatch(centralizedMutation, /PRODUCTION_POST_DEPLOY_PROOF_COMMAND/);
  assert.doesNotMatch(centralizedMutation, /bash \/tmp\/lunchlineup-post-deploy-proof\.sh/);
});

test('runbooks require protected dispatch and forbid operator-side production mutation', () => {
  const rollback = read('docs/runbooks/deployment-rollback.md');
  const readiness = read('docs/runbooks/production-readiness.md');
  assert.match(rollback, /emergency_production_rollback=true/);
  assert.match(rollback, /required reviewers/i);
  assert.match(rollback, /prevent self-review/i);
  assert.match(rollback, /wait timer/i);
  assert.match(rollback, /protected .*production.* environment/i);
  assert.doesNotMatch(rollback, /export RELEASE_BUNDLE_CERTIFICATE_IDENTITY|cd "\/opt\/lunchlineup-rollback/);
  assert.match(readiness, /required reviewers/i);
  assert.match(readiness, /wait timer/i);
  assert.match(readiness, /deployment branch policy.*main/i);
});
