import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const ciText = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const workflow = yaml.load(ciText);
const emergency = workflow.jobs['emergency-production-rollback'];
const deploy = workflow.jobs['deploy-production'];
const step = (job, name) => job.steps.find((value) => value.name === name);

test('production compatibility clones use pinned runtimes and the clone-driver secret', () => {
  const setupNode = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
  const setupPython = 'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065';
  for (const job of [emergency, deploy]) {
    assert.equal(job.steps.find((value) => value.uses === setupNode)?.with?.['node-version'], '22');
    assert.equal(job.steps.find((value) => value.uses === setupPython)?.with?.['python-version'], '3.12');
  }

  for (const preflight of [
    step(emergency, 'Validate protected emergency rollback intent'),
    step(deploy, 'Require production release configuration and contract'),
  ]) {
    assert.equal(
      preflight.env.OLD_RELEASE_COMPATIBILITY_CLONE_COMMAND,
      '${{ secrets.OLD_RELEASE_COMPATIBILITY_CLONE_COMMAND }}',
    );
    assert.match(preflight.run, /test -n "\$OLD_RELEASE_COMPATIBILITY_CLONE_COMMAND"/);
  }
  const deployCompatibility = step(deploy, 'Execute previous release against candidate schema clone');
  assert.equal(deployCompatibility.env.OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS, '300000');
  assert.equal(deployCompatibility.env.OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS, '300000');
  assert.equal(deployCompatibility.env.OLD_RELEASE_COMPATIBILITY_TIMEOUT_MS, '900000');
  assert.doesNotMatch(ciText, /OLD_RELEASE_COMPATIBILITY_COMMAND|compatibility-adapter\.sh|--adapter/);
});

test('production compatibility provision and destroy use bounded exact clone contracts', () => {
  const cases = [
    {
      run: step(emergency, 'Execute target release against current production schema clone').run,
      cleanup: step(emergency, 'Cleanup emergency rollback material').run,
      oldRoot: '\\$PREVIOUS_DEPLOYMENT_APP_DIR',
      candidateRoot: '\\$CURRENT_DEPLOYMENT_APP_DIR',
      candidateManifest: '\\$CURRENT_RELEASE_MANIFEST_PATH',
      candidateSha: '\\$CURRENT_RELEASE_SOURCE_SHA',
      productionRuntime: '\\$CURRENT_RUNTIME_ENV_PATH',
      emergency: true,
    },
    {
      run: step(deploy, 'Execute previous release against candidate schema clone').run,
      cleanup: step(deploy, 'Cleanup production runtime environment and rollback secrets').run,
      oldRoot: '\\$PREVIOUS_DEPLOYMENT_APP_DIR',
      candidateRoot: '\\$GITHUB_WORKSPACE',
      candidateManifest: '\\.release/release-manifest\\.json',
      candidateSha: '\\$GITHUB_SHA',
      productionRuntime: '\\$PRODUCTION_RUNTIME_ENV_PATH',
      emergency: false,
    },
  ];

  const cloneKeys = [
    'APP_DB_PASSWORD',
    'APP_DB_USER',
    'DATABASE_URL',
    'DATA_TARGET_ENV',
    'ENGINE_GRPC_URL',
    'MIGRATION_DATABASE_URL',
    'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
    'POSTGRES_PASSWORD',
    'POSTGRES_USER',
    'RABBITMQ_URL',
    'REDIS_URL',
    'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
  ];

  for (const item of cases) {
    assert.match(item.run, /clone_id="llc-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-\$clone_suffix"/);
    assert.match(item.run, /install -m 700 \/dev\/null "\$clone_driver"/);
    assert.match(item.run, /OLD_RELEASE_COMPATIBILITY_CLONE_OPERATION=provision/);
    assert.match(item.run, /OLD_RELEASE_COMPATIBILITY_CLONE_ENV_PATH="\$clone_env"/);
    assert.match(item.run, new RegExp(`OLD_RELEASE_COMPATIBILITY_PRODUCTION_RUNTIME_ENV_PATH="${item.productionRuntime}"`));
    if (item.emergency) {
      assert.match(item.run, /run_pre_mutation "isolated clone provisioning" "\$EMERGENCY_ROLLBACK_CLONE_TIMEOUT_SECONDS"/);
    } else {
      const provisionStart = item.run.indexOf('provision_seconds=');
      const provisionEnd = item.run.indexOf('test ! -e "$evidence_dir"', provisionStart);
      const provision = item.run.slice(provisionStart, provisionEnd);
      assert.match(
        provision,
        /provision_seconds="\$\(phase_seconds compatibility "\$PRODUCTION_DEPLOY_CLONE_PROVISION_TIMEOUT_SECONDS"\)"[\s\S]*timeout \\\n\s+--signal=TERM \\\n\s+--kill-after="\$\{PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS\}s" \\\n\s+"\$\{provision_seconds\}s" \\\n\s+"\$clone_driver"/,
      );
      assert.doesNotMatch(provision, /--foreground/, 'production provision must time out the clone-driver process group');

      const destroyStart = item.run.indexOf('cleanup_compatibility_clone()');
      const destroyEnd = item.run.indexOf('trap cleanup_compatibility_clone EXIT', destroyStart);
      const destroy = item.run.slice(destroyStart, destroyEnd);
      assert.match(
        destroy,
        /cleanup_seconds="\$\(phase_seconds compatibility-cleanup "\$PRODUCTION_DEPLOY_COMPATIBILITY_CLEANUP_RESERVE_SECONDS"\)"[\s\S]*timeout \\\n\s+--signal=TERM \\\n\s+--kill-after="\$\{PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS\}s" \\\n\s+"\$\{cleanup_seconds\}s" \\\n\s+bash scripts\/destroy-old-release-compatibility-clone\.sh \\\n\s+--driver "\$clone_driver" \\\n\s+--clone-env "\$clone_env" \\\n\s+--clone-id "\$clone_id" \\\n\s+--production-runtime-env "\$PRODUCTION_RUNTIME_ENV_PATH" \\\n\s+--timeout-seconds "\$cleanup_seconds"/,
      );
      assert.doesNotMatch(destroy, /--foreground/, 'production destroy must time out the clone-driver process group');
    }
    assert.match(item.run, /test ! -e "\$evidence_dir"[\s\S]*test -s "\$clone_env"[\s\S]*chmod 600 "\$clone_env"/);
    assert.match(item.run, /clone env keys do not exactly match the protected contract/);
    for (const key of cloneKeys) assert.match(item.run, new RegExp(`"${key}"`));
    assert.match(item.run, new RegExp(`--old-root "${item.oldRoot}"`));
    assert.match(item.run, new RegExp(`--candidate-root "${item.candidateRoot}"`));
    assert.match(item.run, new RegExp(`--candidate-manifest "?${item.candidateManifest}"?`));
    assert.match(item.run, new RegExp(`--candidate-sha "${item.candidateSha}"`));
    assert.match(item.run, /--clone-env "\$clone_env"/);
    assert.match(item.run, new RegExp(`--production-runtime-env "${item.productionRuntime}"`));
    assert.match(item.run, /--clone-id "\$clone_id"/);
    assert.doesNotMatch(item.run, /(?:^|\s)npm (?:--prefix|ci)|python -m pip install/m);
    assert.match(item.run, /old-release-compatibility-harness\.mjs run/);
    assert.doesNotMatch(item.run, /--adapter|--runtime-env/);
    assert.match(item.run, /scripts\/destroy-old-release-compatibility-clone\.sh/);
    assert.match(item.cleanup, /scripts\/destroy-old-release-compatibility-clone\.sh/);
    if (item.emergency) {
      assert.match(item.cleanup, /--timeout-seconds "\$EMERGENCY_ROLLBACK_CLEANUP_TIMEOUT_SECONDS"/);
    } else {
      assert.match(
        item.cleanup,
        /cleanup_seconds="\$\(node scripts\/validate-production-deploy-deadlines\.mjs remaining \\\n\s+--phase runner-cleanup \\\n\s+--maximum-seconds "\$PRODUCTION_DEPLOY_RUNNER_RESERVE_SECONDS"\)"[\s\S]*timeout \\\n\s+--signal=TERM \\\n\s+--kill-after="\$\{PRODUCTION_DEPLOY_TIMEOUT_KILL_RESERVE_SECONDS\}s" \\\n\s+"\$\{cleanup_seconds\}s" \\\n\s+bash scripts\/destroy-old-release-compatibility-clone\.sh \\\n\s+--driver "\$clone_driver" \\\n\s+--clone-env "\$clone_env" \\\n\s+--clone-id "\$clone_id" \\\n\s+--production-runtime-env "\$\{PRODUCTION_RUNTIME_ENV_PATH:-\}" \\\n\s+--timeout-seconds "\$cleanup_seconds"/,
      );
      assert.doesNotMatch(item.cleanup, /--foreground/, 'final cleanup must time out the clone-driver process group');
    }
    assert.doesNotMatch(item.cleanup, /rm -f "\$clone_env" "\$clone_driver"/);
  }
});
