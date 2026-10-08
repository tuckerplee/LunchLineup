import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { writeReleaseIndex } from '../../scripts/signed-release-authenticity.mjs';
import { buildDeploymentContractBundle } from '../../scripts/write-deployment-contract.mjs';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = 'a'.repeat(40);
const retainedProofUri = `https://proofs.lunchlineup.com/releases/${sourceSha}/launch-proof.json`;
const certificateIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const oidcIssuer = 'https://token.actions.githubusercontent.com';
const retainedDeploymentBundle = buildDeploymentContractBundle(root);
const { privateKey: fixturePrivateKey, publicKey: fixturePublicKey } = generateKeyPairSync('ed25519');
const fixturePublicKeyPem = fixturePublicKey.export({ type: 'spki', format: 'pem' }).toString();
const fakeCosignSource = [
  "import { createHash, createPublicKey, verify } from 'node:crypto';",
  "import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';",
  "const args = process.argv.slice(2);",
  "const option = (name) => args[args.indexOf(name) + 1];",
  "if (args[0] !== 'verify-blob' || !args[1]) process.exit(2);",
  "const artifact = readFileSync(args[1]);",
  "const bundle = JSON.parse(readFileSync(option('--bundle'), 'utf8'));",
  "const digest = createHash('sha256').update(artifact).digest('hex');",
  "const payload = { artifactSha256: bundle.artifactSha256, certificateIdentity: bundle.certificateIdentity, oidcIssuer: bundle.oidcIssuer };",
  "const valid = verify(null, Buffer.from(JSON.stringify(payload)), createPublicKey(process.env.TEST_COSIGN_PUBLIC_KEY_PEM), Buffer.from(bundle.signatureBase64 || '', 'base64'));",
  "if (bundle.artifactSha256 !== digest || bundle.certificateIdentity !== option('--certificate-identity') || bundle.oidcIssuer !== option('--certificate-oidc-issuer') || !valid) process.exit(1);",
  "if (process.env.TEST_MATERIALIZER_RACE_PLAN) {",
  "  const plan = JSON.parse(readFileSync(process.env.TEST_MATERIALIZER_RACE_PLAN, 'utf8'));",
  "  const count = Number(existsSync(plan.counter) ? readFileSync(plan.counter, 'utf8') : 0) + 1;",
  "  writeFileSync(plan.counter, String(count));",
  "  appendFileSync(plan.log, JSON.stringify({ artifact: args[1], signature: option('--bundle') }) + '\\n');",
  "  if (count === plan.at) { const temporary = plan.destination + '.replacement'; writeFileSync(temporary, readFileSync(plan.source)); renameSync(temporary, plan.destination); writeFileSync(plan.marker, 'applied'); }",
  "}",
].join(String.fromCharCode(10));

function writeSignature(artifactPath, signaturePath) {
  const payload = {
    artifactSha256: hash(readFileSync(artifactPath)),
    certificateIdentity,
    oidcIssuer,
  };
  writeFileSync(signaturePath, JSON.stringify({
    fixtureVersion: 1,
    ...payload,
    signatureBase64: sign(null, Buffer.from(JSON.stringify(payload)), fixturePrivateKey).toString('base64'),
  }));
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stateForSha(releaseSha, overrides = {}) {
  const proof = Buffer.from(`${JSON.stringify({ sourceSha: releaseSha, generatedAt: '2026-07-10T12:00:00.000Z', evidence: {} })}\n`);
  const value = {
    version: 2,
    sourceSha: releaseSha,
    releaseManifest: { version: 1, sourceSha: releaseSha, deploymentContract: structuredClone(retainedDeploymentBundle.contract) },
    deploymentContractBundleBase64: retainedDeploymentBundle.bytes.toString('base64'),
    runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) },
    launchProofBase64: proof.toString('base64'),
    launchProofSha256: hash(proof),
    launchProofMaxAgeSeconds: 86400,
    launchProofManifestUri: `https://proofs.lunchlineup.com/releases/${releaseSha}/launch-proof.json`,
  };
  return { ...value, ...overrides };
}

function state(overrides = {}) {
  return stateForSha(sourceSha, overrides);
}

function run(value, outputDir, githubEnv, env = {}) {
  const scratch = resolve(outputDir, '..');
  const stateFile = join(scratch, `${basename(outputDir)}-rollback-state.json`);
  const indexFile = stateFile + '.index.json';
  const bundleSignature = stateFile + '.sigstore.json';
  const indexSignature = stateFile + '.index.sigstore.json';
  const fakeCosign = join(scratch, 'fake-cosign.mjs');
  writeFileSync(stateFile, JSON.stringify(value));
  try {
    writeReleaseIndex(stateFile, indexFile, { certificateIdentity, oidcIssuer });
    writeSignature(stateFile, bundleSignature);
    writeSignature(indexFile, indexSignature);
    writeFileSync(fakeCosign, fakeCosignSource);
  } catch (error) {
    return { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  }
  return spawnSync(process.execPath, [
    'scripts/materialize-rollback-state.mjs',
    '--state-file', stateFile,
    '--index-file', indexFile,
    '--bundle-signature-bundle', bundleSignature,
    '--index-signature-bundle', indexSignature,
    '--expected-certificate-identity', certificateIdentity,
    '--expected-oidc-issuer', oidcIssuer,
    '--output-dir', outputDir,
    '--github-env', githubEnv,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      COSIGN_BINARY: process.execPath,
      COSIGN_ARGUMENT_PREFIX_JSON: JSON.stringify([fakeCosign]),
      TEST_COSIGN_PUBLIC_KEY_PEM: fixturePublicKeyPem,
      ...env,
    },
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
    assert.match(exported, new RegExp(`^PREVIOUS_LAUNCH_PROOF_MANIFEST_URI=${retainedProofUri}$`, 'm'));
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
      'PREVIOUS_ROLLBACK_TRANSPORT_PATH',
      'PREVIOUS_ROLLBACK_ACTIVATOR_PATH',
      'PREVIOUS_ROLLBACK_DEADLINES_PATH',
    ]) assert.match(exported, new RegExp(`^${name}=`, 'm'));
    assert.equal(JSON.parse(readFileSync(join(outputDir, 'runtime-secret.json'), 'utf8')).sha256, 'b'.repeat(64));
    assert.equal(existsSync(join(outputDir, 'runtime.env')), false);
    assert.equal(
      readFileSync(join(outputDir, 'app', 'docker-compose.yml'), 'utf8'),
      readFileSync(join(root, 'docker-compose.yml'), 'utf8'),
    );
    for (const unit of [
      'lunchlineup-backup.service',
      'lunchlineup-backup.timer',
      'lunchlineup-pitr-base-backup.service',
      'lunchlineup-pitr-base-backup.timer',
    ]) assert.equal(
      readFileSync(join(outputDir, 'app', 'infrastructure', 'systemd', unit), 'utf8'),
      readFileSync(join(root, 'infrastructure', 'systemd', unit), 'utf8'),
    );
    for (const executable of [
      'scripts/activate-retained-rollback.sh',
      'scripts/rollback-vm217-transport.sh',
      'scripts/vm217-transport-deadlines.sh',
    ]) assert.equal(
      readFileSync(join(outputDir, 'app', ...executable.split('/')), 'utf8'),
      readFileSync(join(root, ...executable.split('/')), 'utf8'),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('rollback materialization fails before output when the Cosign verifier is missing', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-missing-cosign-'));
  const outputDir = join(scratch, 'state');
  try {
    const result = run(state(), outputDir, join(scratch, 'github.env'), {
      COSIGN_BINARY: join(scratch, 'missing-cosign'),
      COSIGN_ARGUMENT_PREFIX_JSON: '',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cosign verifier is required/);
    assert.equal(existsSync(outputDir), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('rollback state materializer rejects non-HTTPS launch proof manifest URIs', () => {
  for (const launchProofManifestUri of [
    's3://lunchlineup-proof/releases/previous.json',
    'rclone:lunchlineup-proof:releases/previous.json',
  ]) {
    const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-proof-uri-'));
    const outputDir = join(scratch, 'state');
    try {
      const result = run(state({ launchProofManifestUri }), outputDir, join(scratch, 'github.env'));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /retained HTTPS URL/);
      assert.equal(existsSync(outputDir), false, 'URI validation must finish before creating the rollback tree');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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

test('rollback state materializer rejects non-executable rollback handoff bytes', () => {
  const value = state();
  const archive = JSON.parse(Buffer.from(value.deploymentContractBundleBase64, 'base64').toString('utf8'));
  const path = 'scripts/activate-retained-rollback.sh';
  const entry = archive.files.find((candidate) => candidate.path === path);
  assert.ok(entry);
  const hostileBytes = Buffer.from('rollback handoff removed\n');
  entry.contentsBase64 = hostileBytes.toString('base64');
  value.releaseManifest.deploymentContract.files[path] = hash(hostileBytes);
  const changed = Buffer.from(JSON.stringify(archive));
  value.deploymentContractBundleBase64 = changed.toString('base64');
  value.releaseManifest.deploymentContract.bundle.sha256 = hash(changed);
  value.releaseManifest.deploymentContract.bundle.bytes = changed.length;

  const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-handoff-bad-'));
  const outputDir = join(scratch, 'state');
  try {
    const result = run(value, outputDir, join(scratch, 'github.env'));
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /missing executable rollback handoff bytes: scripts\/activate-retained-rollback\.sh/);
    assert.equal(existsSync(outputDir), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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

test('real retained bundles materialize old and current roots for exact compatibility preflight', () => {
  const candidateSha = 'c'.repeat(40);
  const scratch = mkdtempSync(join(tmpdir(), 'll-two-release-preflight-'));
  try {
    const oldOutput = join(scratch, 'old');
    const candidateOutput = join(scratch, 'candidate');
    const oldResult = run(stateForSha(sourceSha), oldOutput, join(scratch, 'old.env'));
    const candidateResult = run(stateForSha(candidateSha), candidateOutput, join(scratch, 'candidate.env'));
    assert.equal(oldResult.status, 0, `${oldResult.stdout}\n${oldResult.stderr}`);
    assert.equal(candidateResult.status, 0, `${candidateResult.stdout}\n${candidateResult.stderr}`);

    const preflightArgs = [
      'scripts/old-release-compatibility-harness.mjs', 'preflight',
      '--old-root', join(oldOutput, 'app'),
      '--old-manifest', join(oldOutput, 'app', '.release', 'release-manifest.json'),
      '--old-sha', sourceSha,
      '--candidate-root', join(candidateOutput, 'app'),
      '--candidate-manifest', join(candidateOutput, 'app', '.release', 'release-manifest.json'),
      '--candidate-sha', candidateSha,
    ];
    const preflight = spawnSync(process.execPath, preflightArgs, { cwd: root, encoding: 'utf8' });
    assert.equal(preflight.status, 0, `${preflight.stdout}\n${preflight.stderr}`);
    assert.match(preflight.stdout, /old_release_compatibility_preflight_ok/);
    for (const path of ['package.json', 'package-lock.json', 'packages/db/prisma/schema.prisma']) {
      assert.equal(readFileSync(join(oldOutput, 'app', ...path.split('/'))).length > 0, true, `${path} must be retained`);
    }

    writeFileSync(join(oldOutput, 'app', 'unmanifested.txt'), 'not retained');
    const unmanifested = spawnSync(process.execPath, preflightArgs, { cwd: root, encoding: 'utf8' });
    assert.notEqual(unmanifested.status, 0);
    assert.match(unmanifested.stderr, /unmanifested=unmanifested\.txt/);
    rmSync(join(oldOutput, 'app', 'unmanifested.txt'));

    const packagePath = join(oldOutput, 'app', 'package.json');
    writeFileSync(packagePath, `${readFileSync(packagePath, 'utf8')} `);
    const drift = spawnSync(process.execPath, preflightArgs, { cwd: root, encoding: 'utf8' });
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /deployment file digest mismatch: package\.json/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('CI retains one validated baseline and routes every post-arm failure through the approved job', () => {
  const ci = readFileSync(join(root, 'docs/legacy/github-actions-ci.yml'), 'utf8');
  const automaticDeploy = ci.slice(
    ci.indexOf('  deploy-production:'),
    ci.indexOf('  production-image-inventory:'),
  );
  assert.equal((ci.match(/name: Resolve and materialize previous successful release bundle/g) ?? []).length, 1);
  assert.equal((automaticDeploy.match(/release-bundle-registry\.mjs resolve/g) ?? []).length, 3);
  assert.equal((ci.match(/name: Retain validated secret-free rollback baseline/g) ?? []).length, 1);
  assert.match(ci, /production_rollback_armed: \$\{\{ steps\.arm_production_rollback\.outputs\.armed \}\}/);
  assert.match(ci, /name: Arm production rollback[\s\S]*ROLLBACK_BASELINE_ARTIFACT_DIGEST[\s\S]*echo "armed=true"/);
  assert.doesNotMatch(ci, /production_deploy_mutation_started|Rollback failed production deploy|Auto-rollback if configured/);

  const retainBaseline = ci.indexOf('name: Retain validated secret-free rollback baseline');
  const deployMutation = ci.indexOf('name: "17. Guarded production deploy;');
  assert.ok(retainBaseline > 0 && retainBaseline < deployMutation);
  const rollbackArm = ci.indexOf('name: Arm production rollback');
  assert.ok(rollbackArm > retainBaseline && rollbackArm < deployMutation);
  const retainedStep = ci.slice(retainBaseline, ci.indexOf('      - name:', retainBaseline + 10));
  assert.match(retainedStep, /lunchlineup-rollback-baseline/);
  assert.match(retainedStep, /retention-days: 90/);
  assert.doesNotMatch(retainedStep, /runtime\.env|PRODUCTION_RUNTIME_ENV_B64|runtimeEnvBase64/);
  assert.match(ci, /name: Arm production rollback[\s\S]*rm -rf "\$RUNNER_TEMP\/lunchlineup-rollback-baseline"/);

  const rollbackStart = automaticDeploy.indexOf('name: Download durable automatic rollback handoff');
  const rollbackEnd = automaticDeploy.indexOf('name: Cleanup production runtime environment and rollback secrets');
  const rollback = automaticDeploy.slice(rollbackStart, rollbackEnd);
  assert.ok(rollbackStart > -1 && rollbackEnd > rollbackStart);
  assert.match(rollback, /always\(\)/);
  assert.match(rollback, /steps\.arm_production_rollback\.outcome == 'success'/);
  assert.match(rollback, /steps\.same_gate_release_outcome\.outcome != 'success'/);
  assert.match(rollback, /actions\/download-artifact@/);
  assert.match(rollback, /lunchlineup-rollback-handoff/);
  assert.match(rollback, /materialize-rollback-state\.mjs/);
  assert.match(rollback, /--launch-proof-mode rollback/);
  assert.match(rollback, /rehydrate-runtime-secret\.mjs/);
  assert.match(rollback, /bash scripts\/rollback-vm217-transport\.sh/);
  assert.doesNotMatch(rollback, /bash \/tmp\/lunchlineup-rollback-production\.sh/);
  assert.match(rollback, /registry_before="\$RUNNER_TEMP\/lunchlineup-centralized-rollback-current-before\.json"/);
  assert.match(rollback, /registry_current_sha="\$\(node -e/);
  assert.match(rollback, /"\$registry_current_sha" != "\$GITHUB_SHA"[\s\S]*"\$registry_current_sha" != "\$PREVIOUS_RELEASE_SOURCE_SHA"/);
  assert.match(rollback, /ROLLBACK_REGISTRY_CURRENT_SHA=\$registry_current_sha/);
  assert.match(rollback, /--expected-current-source-sha "\$ROLLBACK_REGISTRY_CURRENT_SHA"/);
  assert.doesNotMatch(rollback, /--expected-current-source-sha "\$GITHUB_SHA"/);
  assert.match(rollback, /rollback_mutation_remaining="\$\(\(rollback_mutation_not_after - \$\(date \+%s\)\)\)"/);
  assert.match(rollback, /Require completed automatic rollback after release failure[\s\S]*test "\$ROLLBACK_HANDOFF_DOWNLOAD_OUTCOME" = success[\s\S]*test "\$ROLLBACK_REGISTRY_PRECONDITION_OUTCOME" = success[\s\S]*test "\$ROLLBACK_PROOF_OUTCOME" = success/);
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

for (const at of [1, 2]) {
  test(`rollback materializer consumes authenticated original during verifier race ${at}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'll-materializer-snapshot-race-'));
    try {
      const output = join(scratch, 'materialized');
      const original = state();
      const alternate = stateForSha('b'.repeat(40), { runtimeSecret: { ...original.runtimeSecret, secretVersion: 'c'.repeat(32) } });
      const alternateArchive = JSON.parse(Buffer.from(alternate.deploymentContractBundleBase64, 'base64'));
      const changedPath = 'scripts/activate-retained-rollback.sh';
      const changedEntry = alternateArchive.files.find(entry => entry.path === changedPath);
      const changedBytes = Buffer.from('#!/bin/sh\n# alternate self-consistent retained release\nexit 0\n');
      changedEntry.contentsBase64 = changedBytes.toString('base64');
      alternate.releaseManifest.deploymentContract.files[changedPath] = hash(changedBytes);
      const changedArchive = Buffer.from(JSON.stringify(alternateArchive));
      alternate.deploymentContractBundleBase64 = changedArchive.toString('base64');
      alternate.releaseManifest.deploymentContract.bundle.sha256 = hash(changedArchive);
      alternate.releaseManifest.deploymentContract.bundle.bytes = changedArchive.length;
      const replacement = join(scratch, 'alternate.json');
      writeFileSync(replacement, JSON.stringify(alternate));
      const planPath = join(scratch, 'plan.json');
      const plan = { at, destination: join(scratch, 'materialized-rollback-state.json'), source: replacement,
        counter: join(scratch, 'counter'), log: join(scratch, 'log'), marker: join(scratch, 'replaced') };
      writeFileSync(planPath, JSON.stringify(plan));
      const result = run(original, output, join(scratch, 'github.env'), { TEST_MATERIALIZER_RACE_PLAN: planPath });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.ok(existsSync(plan.marker), 'race barrier was not exercised');
      assert.equal(JSON.parse(readFileSync(plan.destination)).sourceSha, alternate.sourceSha);
      const manifest = JSON.parse(readFileSync(join(output, 'app/.release/release-manifest.json')));
      assert.equal(manifest.sourceSha, original.sourceSha);
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'runtime-secret.json'))), original.runtimeSecret);
      for (const entry of JSON.parse(Buffer.from(original.deploymentContractBundleBase64, 'base64')).files) {
        assert.deepEqual(readFileSync(join(output, 'app', entry.path)), Buffer.from(entry.contentsBase64, 'base64'));
      }
      const calls = readFileSync(plan.log, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, 2);
      for (const call of calls) assert.equal(existsSync(call.artifact), false, 'verification scratch not cleaned');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}

test('rollback secret-field refusal examines authenticated original despite clean replacement', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-materializer-secret-race-'));
  try {
    const output = join(scratch, 'materialized');
    const replacement = join(scratch, 'clean.json');
    writeFileSync(replacement, JSON.stringify(state()));
    const plan = { at: 1, destination: join(scratch, 'materialized-rollback-state.json'), source: replacement,
      counter: join(scratch, 'counter'), log: join(scratch, 'log'), marker: join(scratch, 'replaced') };
    const planPath = join(scratch, 'plan.json'); writeFileSync(planPath, JSON.stringify(plan));
    const result = run(state({ runtimeEnvBase64: Buffer.from('SYNTHETIC=value').toString('base64') }),
      output, join(scratch, 'github.env'), { TEST_MATERIALIZER_RACE_PLAN: planPath });
    assert.notEqual(result.status, 0);
    assert.ok(existsSync(plan.marker));
    assert.match(result.stderr, /forbidden runtime secret material/);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(join(scratch, 'github.env')), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
