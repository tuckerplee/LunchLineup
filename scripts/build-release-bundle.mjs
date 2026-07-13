#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDeployedReleaseInputs } from './deployed-release-inputs.mjs';
import { validateRuntimeSecretDescriptor } from './rehydrate-runtime-secret.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return process.argv[index + 1];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function buildReleaseBundle({ manifestBytes, contractBundleBytes, runtimeSecret, proofBytes, launchProofManifestUri, maxAgeSeconds }) {
  const releaseManifest = JSON.parse(manifestBytes.toString('utf8'));
  const sourceSha = String(releaseManifest.sourceSha ?? '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Release manifest sourceSha is invalid.');
  const boundBundle = releaseManifest.deploymentContract?.bundle;
  if (boundBundle?.sha256 !== sha256(contractBundleBytes) || boundBundle?.bytes !== contractBundleBytes.length) {
    throw new Error('Deployment contract bundle does not match the release manifest.');
  }
  const proof = JSON.parse(proofBytes.toString('utf8'));
  if (proof.sourceSha !== sourceSha) throw new Error('Launch proof sourceSha does not match the release manifest.');
  const maxAge = Number(maxAgeSeconds);
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) throw new Error('Launch proof max age must be a positive integer.');
  if (!/^(https:\/\/|s3:\/\/|rclone:)/.test(launchProofManifestUri)) throw new Error('Launch proof URI is invalid.');
  const retainedRuntimeSecret = validateRuntimeSecretDescriptor(runtimeSecret);
  return {
    version: 2,
    sourceSha,
    releaseManifest,
    deploymentContractBundleBase64: contractBundleBytes.toString('base64'),
    runtimeSecret: retainedRuntimeSecret,
    launchProofBase64: proofBytes.toString('base64'),
    launchProofSha256: sha256(proofBytes),
    launchProofMaxAgeSeconds: maxAge,
    launchProofManifestUri,
  };
}

function main() {
  const bindingPath = option('--deployed-input-binding');
  const { binding, files } = readDeployedReleaseInputs(bindingPath);
  const result = buildReleaseBundle({
    manifestBytes: files.releaseManifest,
    contractBundleBytes: files.deploymentContractBundle,
    runtimeSecret: binding.runtimeSecret,
    proofBytes: files.launchProof,
    launchProofManifestUri: binding.launchProofManifestUri,
    maxAgeSeconds: binding.launchProofMaxAgeSeconds,
  });
  const expectedSourceIndex = process.argv.indexOf('--expected-source-sha');
  if (expectedSourceIndex !== -1 && process.argv[expectedSourceIndex + 1] !== result.sourceSha) {
    throw new Error('Expected source SHA does not match the built release bundle.');
  }
  const output = resolve(option('--output'));
  writeFileSync(output, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`release_bundle_built source_sha=${result.sourceSha} output=${output}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
