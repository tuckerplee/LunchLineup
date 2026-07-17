#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuntimeSecretDescriptor } from './rehydrate-runtime-secret.mjs';

const FILE_NAMES = {
  releaseManifest: 'release-manifest.json',
  deploymentContractBundle: 'deployment-contract.bundle.json',
  runtimeSecret: 'runtime-secret.json',
  launchProof: 'launch-proof.json',
};
const PLACEHOLDER_PROOF_PATTERN =
  /<[^>]+>|YYYY|MMDD|HHMMSS|change_me|generate_with|replace_me|example|secret|password|guest|placeholder|todo|tbd|not_applicable|n\/a|dummy|fake|artifact-id|run-id/i;
const VAGUE_PROOF_REFERENCE_PATTERN = /(^|[\/:_-])(latest|current)([\/:_.-]|$)/i;

function fail(message) { throw new Error(message); }
function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) fail(`${name} is required.`);
  return process.argv[index + 1];
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fileClaim(bytes) { return { sha256: sha256(bytes), bytes: bytes.length }; }

export function validateLaunchProofManifestUri(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\r\n]/.test(value)) {
    fail('Launch proof manifest URI must be a non-empty single-line string.');
  }
  if (PLACEHOLDER_PROOF_PATTERN.test(value)) {
    fail('Launch proof manifest URI must not contain placeholder text.');
  }
  if (VAGUE_PROOF_REFERENCE_PATTERN.test(value)) {
    fail('Launch proof manifest URI must reference a specific retained proof, not latest/current.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Launch proof manifest URI must be a valid retained HTTPS URL.');
  }
  if (!value.startsWith('https://') || url.protocol !== 'https:') fail('Launch proof manifest URI must be a retained HTTPS URL.');
  return value;
}

export function readProtectedLaunchProofManifestUri(path) {
  const requested = resolve(path);
  const stat = lstatSync(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Launch proof manifest URI input must be a regular file and not a symlink.');
  if (stat.size < 1 || stat.size > 8192) fail('Launch proof manifest URI input must contain 1 through 8192 bytes.');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    fail('Launch proof manifest URI input must have mode 0600.');
  }
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    fail('Launch proof manifest URI input must be owned by the current user.');
  }
  const absolute = realpathSync(requested);
  if (absolute !== requested) fail('Launch proof manifest URI input must not traverse aliases.');
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) fail('Launch proof manifest URI input must not contain NUL bytes.');
  return validateLaunchProofManifestUri(bytes.toString('utf8'));
}

export function createDeployedReleaseBinding({ files, launchProofManifestUri, maxAgeSeconds }) {
  const releaseManifest = JSON.parse(files.releaseManifest.toString('utf8'));
  const launchProof = JSON.parse(files.launchProof.toString('utf8'));
  const sourceSha = String(releaseManifest.sourceSha ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('Release manifest sourceSha is invalid.');
  if (launchProof.sourceSha !== sourceSha) fail('Launch proof sourceSha does not match the release manifest.');
  const boundBundle = releaseManifest.deploymentContract?.bundle;
  const bundleClaim = fileClaim(files.deploymentContractBundle);
  if (boundBundle?.sha256 !== bundleClaim.sha256 || boundBundle?.bytes !== bundleClaim.bytes) {
    fail('Deployment contract bundle does not match the release manifest.');
  }
  const maxAge = Number(maxAgeSeconds);
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) fail('Launch proof max age must be a positive integer.');
  const retainedLaunchProofManifestUri = validateLaunchProofManifestUri(launchProofManifestUri);
  const runtimeSecret = validateRuntimeSecretDescriptor(JSON.parse(files.runtimeSecret.toString('utf8')));
  return {
    version: 2,
    sourceSha,
    launchProofManifestUri: retainedLaunchProofManifestUri,
    launchProofMaxAgeSeconds: maxAge,
    runtimeSecret,
    files: Object.fromEntries(Object.keys(FILE_NAMES).map((key) => [key, fileClaim(files[key])])),
  };
}

export function verifyDeployedReleaseBinding(binding, files) {
  if (binding?.version !== 2 || !/^[a-f0-9]{40}$/.test(binding?.sourceSha ?? '')) {
    fail('Deployed release input binding is invalid.');
  }
  for (const key of Object.keys(FILE_NAMES)) {
    const expected = binding.files?.[key];
    const actual = fileClaim(files[key]);
    if (expected?.sha256 !== actual.sha256 || expected?.bytes !== actual.bytes) {
      fail(`Deployed release input ${FILE_NAMES[key]} does not match its deploy-job digest.`);
    }
  }
  const rebuilt = createDeployedReleaseBinding({
    files,
    launchProofManifestUri: binding.launchProofManifestUri,
    maxAgeSeconds: binding.launchProofMaxAgeSeconds,
  });
  if (rebuilt.sourceSha !== binding.sourceSha) fail('Deployed release source SHA does not match its binding.');
  return binding;
}

export function readDeployedReleaseInputs(bindingPath) {
  const absoluteBinding = resolve(bindingPath);
  const directory = dirname(absoluteBinding);
  const files = Object.fromEntries(Object.entries(FILE_NAMES).map(([key, name]) => [key, readFileSync(resolve(directory, name))]));
  const binding = JSON.parse(readFileSync(absoluteBinding, 'utf8'));
  verifyDeployedReleaseBinding(binding, files);
  return { binding, files };
}

function main() {
  const [command] = process.argv.slice(2);
  if (command === 'create') {
    if (process.argv.includes('--launch-proof-uri') || process.argv.includes('--launch-proof-uri-base64')) {
      fail('Raw or base64 launch proof URI arguments are forbidden; use --launch-proof-uri-file.');
    }
    const output = resolve(option('--output'));
    const files = {
      releaseManifest: readFileSync(resolve(option('--manifest'))),
      deploymentContractBundle: readFileSync(resolve(option('--deployment-bundle'))),
      runtimeSecret: readFileSync(resolve(option('--runtime-secret'))),
      launchProof: readFileSync(resolve(option('--launch-proof'))),
    };
    const binding = createDeployedReleaseBinding({
      files,
      launchProofManifestUri: readProtectedLaunchProofManifestUri(option('--launch-proof-uri-file')),
      maxAgeSeconds: option('--max-proof-age-seconds'),
    });
    writeFileSync(output, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`deployed_release_inputs_bound source_sha=${binding.sourceSha}\n`);
    return;
  }
  if (command === 'verify') {
    const bindingPath = resolve(option('--binding'));
    const { binding } = readDeployedReleaseInputs(bindingPath);
    const expectedProofIndex = process.argv.indexOf('--expected-launch-proof-sha256');
    if (expectedProofIndex !== -1) {
      const expectedProofSha256 = String(process.argv[expectedProofIndex + 1] ?? '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedProofSha256)) fail('--expected-launch-proof-sha256 must be a SHA-256 digest.');
      if (binding.files.launchProof.sha256 !== expectedProofSha256) {
        fail('Deployed launch proof does not match the deploy-job output digest.');
      }
    }
    const githubEnvIndex = process.argv.indexOf('--github-env');
    if (githubEnvIndex !== -1) {
      const githubEnv = process.argv[githubEnvIndex + 1];
      if (!githubEnv) fail('--github-env requires a path.');
      const directory = dirname(bindingPath);
      appendFileSync(resolve(githubEnv), [
        `DEPLOYED_RELEASE_INPUT_BINDING=${bindingPath}`,
        `DEPLOYED_RELEASE_MANIFEST=${resolve(directory, FILE_NAMES.releaseManifest)}`,
        `DEPLOYED_DEPLOYMENT_CONTRACT_BUNDLE=${resolve(directory, FILE_NAMES.deploymentContractBundle)}`,
        `DEPLOYED_RUNTIME_SECRET_DESCRIPTOR=${resolve(directory, FILE_NAMES.runtimeSecret)}`,
        `DEPLOYED_LAUNCH_PROOF=${resolve(directory, FILE_NAMES.launchProof)}`,
        `DEPLOYED_RUNTIME_ENV_SHA256=${binding.runtimeSecret.sha256}`,
        `DEPLOYED_LAUNCH_PROOF_SHA256=${binding.files.launchProof.sha256}`,
        `DEPLOYED_LAUNCH_PROOF_MANIFEST_URI=${binding.launchProofManifestUri}`,
        `DEPLOYED_LAUNCH_PROOF_MAX_AGE_SECONDS=${binding.launchProofMaxAgeSeconds}`,
        '',
      ].join('\n'));
    }
    process.stdout.write(`deployed_release_inputs_verified source_sha=${binding.sourceSha}\n`);
    return;
  }
  fail('Usage: deployed-release-inputs.mjs <create|verify> ...');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
