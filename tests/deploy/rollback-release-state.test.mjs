import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = 'a'.repeat(40);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deploymentBundle(files) {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  const bytes = Buffer.from(JSON.stringify({
    version: 1,
    files: entries.map(([path, contents]) => ({ path, contentsBase64: Buffer.from(contents).toString('base64') })),
  }));
  return {
    bytes,
    contract: {
      algorithm: 'sha256',
      bundle: {
        format: 'lunchlineup-deployment-contract-json-v1',
        sha256: hash(bytes),
        bytes: bytes.length,
      },
      files: Object.fromEntries(entries.map(([path, contents]) => [path, hash(Buffer.from(contents))])),
      rawMigrations: {
        version: 1,
        files: Object.fromEntries(entries
          .filter(([path]) => path.startsWith('packages/db/prisma/migrations/') && path.endsWith('.sql'))
          .map(([path, contents]) => [path, hash(Buffer.from(contents))])),
      },
    },
  };
}

function state(overrides = {}) {
  const proof = Buffer.from(`${JSON.stringify({ sourceSha, generatedAt: '2026-07-10T12:00:00.000Z', evidence: {} })}\n`);
  const bundle = deploymentBundle({
    'docker-compose.yml': 'services:\n  api:\n    image: previous-release\n',
    'scripts/rollback-contract-probe.mjs': "import { readFileSync } from 'node:fs';\nprocess.stdout.write(`previous:${readFileSync('docker-compose.yml', 'utf8')}`);\n",
  });
  return {
    version: 2,
    sourceSha,
    releaseManifest: { version: 1, sourceSha, deploymentContract: bundle.contract },
    deploymentContractBundleBase64: bundle.bytes.toString('base64'),
    runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) },
    launchProofBase64: proof.toString('base64'),
    launchProofSha256: hash(proof),
    launchProofMaxAgeSeconds: 86400,
    launchProofManifestUri: 's3://lunchlineup-proof/releases/previous.json',
    ...overrides,
  };
}

function run(value, outputDir, githubEnv) {
  const stateFile = join(resolve(outputDir, '..'), 'rollback-state.json');
  writeFileSync(stateFile, JSON.stringify(value));
  return spawnSync(process.execPath, [
    'scripts/materialize-rollback-state.mjs',
    '--state-file', stateFile,
    '--output-dir', outputDir,
    '--github-env', githubEnv,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}

test('rollback state materializer preserves every verified previous release input', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-state-'));
  try {
    const outputDir = join(scratch, 'state');
    const githubEnv = join(scratch, 'github.env');
    const result = run(state(), outputDir, githubEnv);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /rollback_state_ok/);

    const exported = readFileSync(githubEnv, 'utf8');
    for (const name of [
      'PREVIOUS_RELEASE_MANIFEST_PATH',
      'PREVIOUS_RELEASE_SOURCE_SHA',
      'PREVIOUS_DEPLOYMENT_APP_DIR',
      'PREVIOUS_DEPLOYMENT_CONTRACT_BUNDLE_SHA256',
      'PREVIOUS_RUNTIME_SECRET_DESCRIPTOR',
      'PREVIOUS_PRODUCTION_RUNTIME_ENV_SHA256',
      'PREVIOUS_LAUNCH_PROOF_PATH',
      'PREVIOUS_LAUNCH_PROOF_ARTIFACT_SHA256',
      'PREVIOUS_LAUNCH_PROOF_MAX_AGE_SECONDS',
      'PREVIOUS_LAUNCH_PROOF_MANIFEST_URI',
    ]) assert.match(exported, new RegExp(`^${name}=`, 'm'));
    assert.equal(JSON.parse(readFileSync(join(outputDir, 'runtime-secret.json'), 'utf8')).sha256, 'b'.repeat(64));
    assert.equal(existsSync(join(outputDir, 'runtime.env')), false);
    assert.match(readFileSync(join(outputDir, 'app', 'docker-compose.yml'), 'utf8'), /previous-release/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('rollback state materializer rejects state and deployment bundle hash drift', () => {
  const badBundleState = state();
  badBundleState.deploymentContractBundleBase64 = Buffer.from('not the bound bundle').toString('base64');
  for (const overrides of [
    { runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'x', secretVersion: 'bad', sha256: 'b'.repeat(64) } },
    { launchProofSha256: 'b'.repeat(64) },
    { sourceSha: 'b'.repeat(40) },
    badBundleState,
  ]) {
    const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-state-bad-'));
    try {
      const result = run(overrides.releaseManifest ? overrides : state(overrides), join(scratch, 'state'), join(scratch, 'github.env'));
      assert.notEqual(result.status, 0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('rollback state materializer rejects unsafe, duplicate, unmanifested, missing, and hash-drift bundle entries', () => {
  const cases = [];
  for (const mutate of [
    (archive) => { archive.files[0].path = '../docker-compose.yml'; },
    (archive) => { archive.files.push({ ...archive.files[0] }); },
    (archive) => { archive.files.push({ path: 'unmanifested.txt', contentsBase64: Buffer.from('x').toString('base64') }); },
    (archive) => { archive.files.pop(); },
    (archive) => { archive.files[0].contentsBase64 = Buffer.from('hash drift').toString('base64'); },
  ]) {
    const value = state();
    const bytes = Buffer.from(value.deploymentContractBundleBase64, 'base64');
    const archive = JSON.parse(bytes.toString('utf8'));
    mutate(archive);
    const changed = Buffer.from(JSON.stringify(archive));
    value.deploymentContractBundleBase64 = changed.toString('base64');
    value.releaseManifest.deploymentContract.bundle.sha256 = hash(changed);
    value.releaseManifest.deploymentContract.bundle.bytes = changed.length;
    cases.push(value);
  }

  for (const value of cases) {
    const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-archive-bad-'));
    const outputDir = join(scratch, 'state');
    try {
      const result = run(value, outputDir, join(scratch, 'github.env'));
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(outputDir), false, 'validation must finish before creating the rollback tree');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('two releases with differing deployment contracts execute only the retained previous helper and config', () => {
  const previous = state();
  const current = deploymentBundle({
    'docker-compose.yml': 'services:\n  api:\n    image: current-release\n',
    'scripts/rollback-contract-probe.mjs': "process.stdout.write('current');\n",
  });
  assert.notEqual(previous.releaseManifest.deploymentContract.bundle.sha256, current.contract.bundle.sha256);

  const scratch = mkdtempSync(join(tmpdir(), 'll-two-release-rollback-'));
  try {
    const outputDir = join(scratch, 'state');
    const result = run(previous, outputDir, join(scratch, 'github.env'));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const appDir = join(outputDir, 'app');
    const probe = spawnSync(process.execPath, ['scripts/rollback-contract-probe.mjs'], { cwd: appDir, encoding: 'utf8' });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout, /^previous:services:/);
    assert.doesNotMatch(probe.stdout, /current-release|current$/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('CI retains one validated baseline and routes every post-mutation failure to one rollback job', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.equal((ci.match(/name: Resolve and materialize previous successful release bundle/g) ?? []).length, 1);
  assert.equal((ci.match(/release-bundle-registry\.mjs resolve/g) ?? []).length, 1);
  assert.equal((ci.match(/name: Retain validated secret-free rollback baseline/g) ?? []).length, 1);
  assert.match(ci, /production_rollback_armed: \$\{\{ steps\.arm_production_rollback\.outputs\.armed \}\}/);
  assert.match(ci, /name: Arm production rollback[\s\S]*echo "armed=true" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(ci, /production_deploy_mutation_started|Rollback failed production deploy|Auto-rollback if configured/);

  const retainBaseline = ci.indexOf('name: Retain validated secret-free rollback baseline');
  const deployMutation = ci.indexOf('name: "17. Blue/Green deploy"');
  assert.ok(retainBaseline > 0 && retainBaseline < deployMutation);
  const rollbackArm = ci.indexOf('name: Arm production rollback');
  assert.ok(rollbackArm > retainBaseline && rollbackArm < deployMutation);
  const retainedStep = ci.slice(retainBaseline, ci.indexOf('      - name:', retainBaseline + 10));
  assert.match(retainedStep, /lunchlineup-previous-release\.json/);
  assert.doesNotMatch(retainedStep, /runtime\.env|PRODUCTION_RUNTIME_ENV_B64|runtimeEnvBase64/);

  const rollbackStart = ci.indexOf('  production-rollback:');
  const rollbackEnd = ci.indexOf('\n  #', rollbackStart);
  const rollback = ci.slice(rollbackStart, rollbackEnd);
  assert.match(rollback, /needs: \[deploy-production, production-smoke\]/);
  assert.match(rollback, /always\(\)/);
  assert.match(rollback, /needs\.deploy-production\.outputs\.production_rollback_armed == 'true'/);
  assert.match(rollback, /needs\.deploy-production\.result != 'success'/);
  assert.match(rollback, /needs\.production-smoke\.result != 'success'/);
  assert.match(rollback, /Download retained validated rollback baseline/);
  assert.match(rollback, /materialize-rollback-state\.mjs/);
  assert.match(rollback, /--launch-proof-mode rollback/);
  assert.match(rollback, /rehydrate-runtime-secret\.mjs/);
  assert.match(rollback, /cd "\$PREVIOUS_DEPLOYMENT_APP_DIR"/);
  assert.match(rollback, /bash \/tmp\/lunchlineup-rollback-production\.sh/);
});

test('post-arm failure injection matrix always triggers centralized rollback', () => {
  const shouldRollback = ({ rollbackArmed, deployResult, smokeResult }) => (
    rollbackArmed
    && (deployResult !== 'success' || smokeResult !== 'success')
  );
  const failures = [
    ['transport loss at mutation start', 'failure', 'skipped'],
    ['production deploy command', 'failure', 'skipped'],
    ['post-deploy input verification', 'failure', 'skipped'],
    ['deployed-input artifact upload', 'failure', 'skipped'],
    ['deploy-job cleanup', 'failure', 'skipped'],
    ['smoke artifact download', 'success', 'failure'],
    ['production smoke proof', 'success', 'failure'],
    ['release publication', 'success', 'failure'],
    ['smoke job cancelled', 'success', 'cancelled'],
    ['smoke job skipped', 'success', 'skipped'],
  ];
  for (const [stage, deployResult, smokeResult] of failures) {
    assert.equal(
      shouldRollback({ rollbackArmed: true, deployResult, smokeResult }),
      true,
      stage,
    );
  }
  assert.equal(shouldRollback({ rollbackArmed: false, deployResult: 'failure', smokeResult: 'skipped' }), false);
  assert.equal(shouldRollback({ rollbackArmed: true, deployResult: 'success', smokeResult: 'success' }), false);
});