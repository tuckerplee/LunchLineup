import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    launchProofManifestUri: 's3://proof/releases/deployed.json',
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
        LAUNCH_PROOF_MANIFEST_URI: 's3://proof/releases/changed.json',
      },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const bundle = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(bundle.runtimeSecret, binding.runtimeSecret);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /deployed-value|VE9LRU49ZGVwbG95ZWQtdmFsdWU=/);
    assert.equal(bundle.launchProofManifestUri, 's3://proof/releases/deployed.json');

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
  const smoke = workflow.slice(workflow.indexOf('  production-smoke:'), workflow.indexOf('  rollback-drill:'));
  assert.match(workflow, /production-deployed-inputs-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /deployed_inputs_artifact_digest: \$\{\{ steps\.upload_deployed_inputs\.outputs\.artifact-digest \}\}/);
  assert.match(smoke, /deployed-release-inputs\.mjs verify/);
  assert.match(smoke, /--expected-launch-proof-sha256 "\$LAUNCH_PROOF_ARTIFACT_SHA256"/);
  assert.match(smoke, /--deployed-input-binding "\$DEPLOYED_RELEASE_INPUT_BINDING"/);
  assert.doesNotMatch(workflow, /PRODUCTION_RUNTIME_ENV_B64/);
  assert.match(workflow, /--runtime-secret "\$release_inputs\/runtime-secret\.json"/);
  const deployedUpload = workflow.slice(
    workflow.indexOf('Upload exact deployed release inputs'),
    workflow.indexOf('Cleanup production runtime environment and rollback secrets'),
  );
  assert.doesNotMatch(deployedUpload, /runtime\.env/);
  assert.doesNotMatch(smoke, /printf '%s' "\$PRODUCTION_(?:RUNTIME_ENV|LAUNCH_PROOF)_B64"/);
});
