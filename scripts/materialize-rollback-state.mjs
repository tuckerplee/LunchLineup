#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validateLaunchProofManifestUri } from './deployed-release-inputs.mjs';
import { validateRuntimeSecretDescriptor } from './rehydrate-runtime-secret.mjs';
import { verifyReleaseAuthenticity } from './signed-release-authenticity.mjs';
import { validateDeploymentContractBundle } from './validate-deployment-contract-bundle.mjs';
import { validateRetainedDeploymentContract } from './write-deployment-contract.mjs';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) fail(`${label} must be a non-empty single-line string.`);
  return value;
}

function decode(value, label) {
  try {
    const bytes = Buffer.from(requireString(value, label), 'base64');
    if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) fail(`${label} is not canonical base64.`);
    return bytes;
  } catch {
    fail(`${label} is not valid base64.`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireSha(value, label, length) {
  const normalized = requireString(value, label).toLowerCase();
  const pattern = length === 40 ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!pattern.test(normalized)) fail(`${label} must be a ${length}-character lowercase hexadecimal value.`);
  return normalized;
}

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) fail(`${name} is required.`);
  return process.argv[index + 1];
}

const outputIndex = process.argv.indexOf('--output-dir');
const githubEnvIndex = process.argv.indexOf('--github-env');
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
  fail('Usage: materialize-rollback-state.mjs --output-dir DIR --state-file PATH --index-file PATH --bundle-signature-bundle PATH --index-signature-bundle PATH --expected-certificate-identity ID --expected-oidc-issuer URL [--github-env PATH]');
}
const statePath = resolve(requiredOption('--state-file'));
let verified;
try {
  verified = verifyReleaseAuthenticity({
    statePath,
    indexPath: resolve(requiredOption('--index-file')),
    bundleSignaturePath: resolve(requiredOption('--bundle-signature-bundle')),
    indexSignaturePath: resolve(requiredOption('--index-signature-bundle')),
    certificateIdentity: requiredOption('--expected-certificate-identity'),
    oidcIssuer: requiredOption('--expected-oidc-issuer'),
    productionTrust: process.argv.includes('--production-trust'),
  });
} catch (error) {
  fail(`Rollback state authenticity verification failed: ${error instanceof Error ? error.message : String(error)}`);
}

let state;
try {
  const stateText = verified.artifactBytes.statePath.toString('utf8');
  for (const forbidden of ['runtimeEnvBase64', 'runtimeBytes', 'productionRuntimeEnv', 'PRODUCTION_RUNTIME_ENV_B64']) {
    if (stateText.includes(`"${forbidden}"`)) fail('Rollback state contains forbidden runtime secret material.');
  }
  state = verified.state;
} catch (error) {
  fail(`Rollback state file must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (state.version !== 2) fail('Rollback state must use the secret-free version 2 contract.');
const sourceSha = requireSha(state.sourceSha, 'sourceSha', 40);
const proofBytes = decode(state.launchProofBase64, 'launchProofBase64');
const proofSha = requireSha(state.launchProofSha256, 'launchProofSha256', 64);
if (sha256(proofBytes) !== proofSha) fail('launchProofSha256 does not match launchProofBase64.');
let runtimeSecret;
try { runtimeSecret = validateRuntimeSecretDescriptor(state.runtimeSecret); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }

const manifest = state.releaseManifest;
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('releaseManifest must be a JSON object.');
if (manifest.sourceSha !== sourceSha) fail('releaseManifest.sourceSha must match sourceSha.');
const deploymentContract = manifest.deploymentContract;
if (!deploymentContract || typeof deploymentContract !== 'object' || deploymentContract.algorithm !== 'sha256') {
  fail('releaseManifest.deploymentContract with sha256 algorithm is required.');
}
try { validateRetainedDeploymentContract(deploymentContract); } catch (error) {
  fail(`Retained deployment contract is insufficient: ${error instanceof Error ? error.message : String(error)}`);
}
const bundleBytes = decode(state.deploymentContractBundleBase64, 'deploymentContractBundleBase64');
let materializedFiles, bundleSha;
try { ({ materializedFiles, bundleSha } = validateDeploymentContractBundle(deploymentContract, bundleBytes)); } catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
let proof;
try {
  proof = JSON.parse(proofBytes.toString('utf8'));
} catch {
  fail('launchProofBase64 must decode to JSON.');
}
if (proof.sourceSha !== sourceSha) fail('launch proof sourceSha must match sourceSha.');

const maxAge = Number(state.launchProofMaxAgeSeconds);
if (!Number.isSafeInteger(maxAge) || maxAge < 1) fail('launchProofMaxAgeSeconds must be a positive integer.');
let manifestUri;
try {
  manifestUri = validateLaunchProofManifestUri(state.launchProofManifestUri);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const requiredRollbackExecutables = [
  'scripts/activate-retained-rollback.sh',
  'scripts/rollback-vm217-transport.sh',
  'scripts/vm217-transport-deadlines.sh',
];
for (const path of requiredRollbackExecutables) {
  const bytes = materializedFiles.get(path);
  if (!bytes || bytes.length === 0 || bytes.subarray(0, 2).toString() !== '#!') {
    fail(`Retained deployment bundle is missing executable rollback handoff bytes: ${path}`);
  }
}

const outputDir = resolve(process.argv[outputIndex + 1]);
if (existsSync(outputDir)) fail(`Output directory must not already exist: ${outputDir}`);
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
chmodSync(outputDir, 0o700);
const appDir = join(outputDir, 'app');
mkdirSync(appDir, { mode: 0o700 });
for (const [path, bytes] of materializedFiles) {
  const filePath = join(appDir, ...path.split('/'));
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, bytes, { mode: bytes.subarray(0, 2).toString() === '#!' ? 0o700 : 0o600 });
}
const manifestPath = join(appDir, '.release', 'release-manifest.json');
const runtimeSecretPath = join(outputDir, 'runtime-secret.json');
const proofPath = join(outputDir, 'launch-proof.json');
mkdirSync(dirname(manifestPath), { mode: 0o700 });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
writeFileSync(runtimeSecretPath, `${JSON.stringify(runtimeSecret)}\n`, { mode: 0o600 });
writeFileSync(proofPath, proofBytes, { mode: 0o600 });

const exports = {
  PREVIOUS_RELEASE_MANIFEST_PATH: manifestPath,
  PREVIOUS_RELEASE_SOURCE_SHA: sourceSha,
  PREVIOUS_DEPLOYMENT_APP_DIR: appDir,
  PREVIOUS_DEPLOYMENT_CONTRACT_BUNDLE_SHA256: bundleSha,
  PREVIOUS_RUNTIME_SECRET_DESCRIPTOR: runtimeSecretPath,
  PREVIOUS_PRODUCTION_RUNTIME_ENV_SHA256: runtimeSecret.sha256,
  PREVIOUS_LAUNCH_PROOF_PATH: proofPath,
  PREVIOUS_LAUNCH_PROOF_ARTIFACT_SHA256: proofSha,
  PREVIOUS_LAUNCH_PROOF_MAX_AGE_SECONDS: String(maxAge),
  PREVIOUS_LAUNCH_PROOF_MANIFEST_URI: manifestUri,
  PREVIOUS_ROLLBACK_TRANSPORT_PATH: join(appDir, 'scripts', 'rollback-vm217-transport.sh'),
  PREVIOUS_ROLLBACK_ACTIVATOR_PATH: join(appDir, 'scripts', 'activate-retained-rollback.sh'),
  PREVIOUS_ROLLBACK_DEADLINES_PATH: join(appDir, 'scripts', 'vm217-transport-deadlines.sh'),
};

if (githubEnvIndex !== -1) {
  const githubEnvPath = process.argv[githubEnvIndex + 1];
  if (!githubEnvPath) fail('--github-env requires a path.');
  writeFileSync(githubEnvPath, Object.entries(exports).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'a' });
}

console.log(`rollback_state_ok source_sha=${sourceSha} manifest=${manifestPath} deployment_root=${appDir} bundle_sha256=${bundleSha} runtime_sha256=${runtimeSecret.sha256} proof_sha256=${proofSha}`);
