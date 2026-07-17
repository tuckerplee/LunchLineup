import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createDeployedReleaseBinding,
  verifyDeployedReleaseBinding,
} from '../../scripts/deployed-release-inputs.mjs';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = 'a'.repeat(40);
const retainedProofUri = `https://proofs.lunchlineup.com/releases/${sourceSha}/launch-proof.json`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const deploymentContractBundle = Buffer.from('{"version":1,"files":[]}');
  const releaseManifest = Buffer.from(JSON.stringify({
    sourceSha,
    deploymentContract: {
      bundle: { sha256: hash(deploymentContractBundle), bytes: deploymentContractBundle.length },
    },
  }));
  const files = {
    releaseManifest,
    deploymentContractBundle,
    runtimeSecret: Buffer.from(JSON.stringify({ version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) })),
    launchProof: Buffer.from(JSON.stringify({ sourceSha, status: 'passed' })),
  };
  const binding = createDeployedReleaseBinding({
    files,
    launchProofManifestUri: retainedProofUri,
    maxAgeSeconds: 86400,
  });
  return { binding, files };
}

test('deployed release input binding rejects byte drift in every bound file', () => {
  const { binding, files } = fixture();
  verifyDeployedReleaseBinding(binding, files);
  for (const key of Object.keys(files)) {
    assert.throws(() => verifyDeployedReleaseBinding(binding, {
      ...files,
      [key]: Buffer.concat([files[key], Buffer.from('drift')]),
    }), /does not match its deploy-job digest/);
  }
});

test('deployed release input binding requires a specific retained HTTPS launch proof manifest', () => {
  const { binding, files } = fixture();
  assert.equal(binding.launchProofManifestUri, retainedProofUri);
  verifyDeployedReleaseBinding(binding, files);

  for (const launchProofManifestUri of [
    's3://proof/releases/deployed.json',
    'rclone:proof:releases/deployed.json',
  ]) {
    assert.throws(() => createDeployedReleaseBinding({
      files,
      launchProofManifestUri,
      maxAgeSeconds: 86400,
    }), /retained HTTPS URL/);
    assert.throws(() => verifyDeployedReleaseBinding({
      ...binding,
      launchProofManifestUri,
    }, files), /retained HTTPS URL/);
  }

  for (const [launchProofManifestUri, message] of [
    ['https://proofs.lunchlineup.com/releases/current/launch-proof.json', /specific retained proof/],
    ['https://proofs.lunchlineup.com/releases/<run-id>/launch-proof.json', /placeholder text/],
  ]) {
    assert.throws(() => createDeployedReleaseBinding({
      files,
      launchProofManifestUri,
      maxAgeSeconds: 86400,
    }), message);
  }
});

test('release bundle persists only immutable runtime secret metadata', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-deployed-inputs-'));
  try {
    const { binding, files } = fixture();
    const names = {
      releaseManifest: 'release-manifest.json',
      deploymentContractBundle: 'deployment-contract.bundle.json',
      runtimeSecret: 'runtime-secret.json',
      launchProof: 'launch-proof.json',
    };
    for (const [key, name] of Object.entries(names)) writeFileSync(join(scratch, name), files[key]);
    const bindingPath = join(scratch, 'binding.json');
    const output = join(scratch, 'release.json');
    writeFileSync(bindingPath, JSON.stringify(binding));

    const result = spawnSync(process.execPath, [
      'scripts/build-release-bundle.mjs',
      '--deployed-input-binding', bindingPath,
      '--expected-source-sha', sourceSha,
      '--output', output,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PRODUCTION_RUNTIME_ENV_B64: Buffer.from('TOKEN=rotated-after-deploy\n').toString('base64'),
        PRODUCTION_LAUNCH_PROOF_B64: Buffer.from('{"sourceSha":"changed"}').toString('base64'),
        LAUNCH_PROOF_MANIFEST_URI: `https://proofs.lunchlineup.com/releases/${'b'.repeat(40)}/launch-proof.json`,
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const bundle = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(bundle.runtimeSecret, binding.runtimeSecret);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /deployed-value|VE9LRU49ZGVwbG95ZWQtdmFsdWU=/);
    assert.equal(bundle.launchProofManifestUri, retainedProofUri);

    const mismatch = spawnSync(process.execPath, [
      'scripts/build-release-bundle.mjs',
      '--deployed-input-binding', bindingPath,
      '--expected-source-sha', 'b'.repeat(40),
      '--output', join(scratch, 'mismatch.json'),
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Expected source SHA does not match/);

  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('workflow publishes only from run-attempt-scoped deployed input artifacts', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const productionTransaction = workflow.slice(
    workflow.indexOf('  deploy-production:'),
    workflow.indexOf('  production-image-inventory:'),
  );
  const sameGateSmoke = productionTransaction.slice(
    productionTransaction.indexOf('Verify exact deployed release inputs for same-gate smoke'),
    productionTransaction.indexOf('Determine same-gate release outcome'),
  );
  assert.match(workflow, /production-deployed-inputs-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /deployed_inputs_artifact_digest: \$\{\{ steps\.upload_deployed_inputs\.outputs\.artifact-digest \}\}/);
  assert.match(productionTransaction, /deployed-release-inputs\.mjs verify/);
  assert.match(productionTransaction, /--expected-launch-proof-sha256 "\$LAUNCH_PROOF_ARTIFACT_SHA256"/);
  assert.match(productionTransaction, /--deployed-input-binding "\$DEPLOYED_RELEASE_INPUT_BINDING"/);
  assert.doesNotMatch(workflow, /PRODUCTION_RUNTIME_ENV_B64/);
  assert.match(workflow, /--runtime-secret "\$release_inputs\/runtime-secret\.json"/);
  const deployedUpload = workflow.slice(
    workflow.indexOf('Upload exact deployed release inputs'),
    workflow.indexOf('Verify exact deployed release inputs for same-gate smoke'),
  );
  assert.doesNotMatch(deployedUpload, /runtime\.env/);
  assert.doesNotMatch(sameGateSmoke, /printf '%s' "\$PRODUCTION_(?:RUNTIME_ENV|LAUNCH_PROOF)_B64"/);
});

test('create consumes the retained proof URI only through an owner-protected file', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-deployed-input-uri-'));
  try {
    const { files } = fixture();
    const paths = {
      releaseManifest: join(scratch, 'release-manifest.json'),
      deploymentContractBundle: join(scratch, 'deployment-contract.bundle.json'),
      runtimeSecret: join(scratch, 'runtime-secret.json'),
      launchProof: join(scratch, 'launch-proof.json'),
    };
    for (const [key, path] of Object.entries(paths)) writeFileSync(path, files[key]);
    const uriFile = join(scratch, 'launch-proof-uri');
    writeFileSync(uriFile, retainedProofUri, { mode: 0o600 });
    chmodSync(uriFile, 0o600);
    const common = [
      'scripts/deployed-release-inputs.mjs', 'create',
      '--manifest', paths.releaseManifest,
      '--deployment-bundle', paths.deploymentContractBundle,
      '--runtime-secret', paths.runtimeSecret,
      '--launch-proof', paths.launchProof,
      '--max-proof-age-seconds', '86400',
    ];
    const created = spawnSync(process.execPath, [
      ...common, '--launch-proof-uri-file', uriFile, '--output', join(scratch, 'binding.json'),
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(scratch, 'binding.json'), 'utf8')).launchProofManifestUri, retainedProofUri);

    for (const [flag, value] of [
      ['--launch-proof-uri', retainedProofUri],
      ['--launch-proof-uri-base64', Buffer.from(retainedProofUri).toString('base64')],
    ]) {
      const rejected = spawnSync(process.execPath, [
        ...common, flag, value, '--output', join(scratch, `rejected-${flag.slice(2)}.json`),
      ], { cwd: root, encoding: 'utf8' });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Raw or base64 launch proof URI arguments are forbidden/);
    }

    if (process.platform !== 'win32') {
      chmodSync(uriFile, 0o644);
      const loose = spawnSync(process.execPath, [
        ...common, '--launch-proof-uri-file', uriFile, '--output', join(scratch, 'loose.json'),
      ], { cwd: root, encoding: 'utf8' });
      assert.notEqual(loose.status, 0);
      assert.match(loose.stderr, /mode 0600/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('production binding argv spy rejects raw and base64 proof URI exposure', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-deployed-input-argv-spy-'));
  try {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replaceAll('\r\n', '\n');
    const bindingStep = workflow.slice(
      workflow.indexOf('      - name: Bind exact production deployment inputs'),
      workflow.indexOf('      - name: Verify production deployment inputs'),
    );
    assert.match(bindingStep, /install -m 600 \/dev\/null "\$launch_proof_uri_file"/);
    assert.match(bindingStep, /printf '%s' "\$LAUNCH_PROOF_MANIFEST_URI" > "\$launch_proof_uri_file"/);
    assert.match(bindingStep, /--launch-proof-uri-file "\$launch_proof_uri_file"/);
    assert.doesNotMatch(bindingStep, /--launch-proof-uri(?:\s|$)|--launch-proof-uri-base64/);

    const invocationStart = bindingStep.indexOf('node scripts/deployed-release-inputs.mjs create');
    const invocation = bindingStep.slice(
      invocationStart,
      bindingStep.indexOf('\n          cleanup_launch_proof_uri\n', invocationStart),
    );
    const options = [...invocation.matchAll(/^\s+(--[a-z0-9-]+) "([^"]+)"/gm)]
      .flatMap((match) => [match[1], match[2]
        .replace('$release_inputs', join(scratch, 'inputs'))
        .replace('$launch_proof_uri_file', join(scratch, 'proof-uri'))
        .replace('$LAUNCH_PROOF_MAX_AGE_SECONDS', '86400')]);
    assert.equal(options.length, 14);
    const spy = join(scratch, 'argv-spy.mjs');
    const spyOutput = join(scratch, 'argv.json');
    writeFileSync(spy, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.ARGV_SPY_OUTPUT, JSON.stringify(process.argv.slice(2)));\n");
    const spied = spawnSync(process.execPath, [spy, 'scripts/deployed-release-inputs.mjs', 'create', ...options], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARGV_SPY_OUTPUT: spyOutput },
    });
    assert.equal(spied.status, 0, `${spied.stdout}\n${spied.stderr}`);
    const argv = readFileSync(spyOutput, 'utf8');
    assert.doesNotMatch(argv, new RegExp(retainedProofUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(argv, new RegExp(Buffer.from(retainedProofUri).toString('base64')));
    assert.match(argv, /--launch-proof-uri-file/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
