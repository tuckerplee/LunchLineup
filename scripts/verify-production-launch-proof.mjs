#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recoveryAdapterProvenanceFromEvidence, verifyFetchedEvidenceArtifact } from './launch-proof-evidence.mjs';
import { runBoundedProviderCommand } from './rehydrate-runtime-secret.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invocationCwd = process.cwd();
const args = process.argv.slice(2);
const fetchEvidence = args.includes('--fetch-evidence');

function usage() {
  console.log(
    'Usage: node scripts/verify-production-launch-proof.mjs <release-manifest.json> <launch-proof.json> [verify-release-artifacts options]',
  );
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const positionalArgs = args.filter((arg) => arg !== '--fetch-evidence');
const [manifestArg, proofArg, ...verifierArgs] = positionalArgs;
if (!manifestArg || !proofArg) {
  usage();
  process.exit(64);
}

const manifestPath = resolve(invocationCwd, manifestArg);
const proofPath = resolve(invocationCwd, proofArg);

if (!existsSync(proofPath)) {
  fail(`Launch proof file is required and must exist: ${proofArg}`);
}

const inputScratch = mkdtempSync(join(tmpdir(), 'lunchlineup-launch-proof-inputs-'));
chmodSync(inputScratch, 0o700);
process.on('exit', () => rmSync(inputScratch, { recursive: true, force: true }));

function snapshotInput(path, label, name) {
  let descriptor;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 64 * 1024 * 1024) {
      fail(`${label} must be a non-empty regular file no larger than 67108864 bytes.`);
    }
    const bytes = readFileSync(descriptor);
    const snapshotPath = join(inputScratch, name);
    writeFileSync(snapshotPath, bytes, { mode: 0o600, flag: 'wx' });
    return { bytes, path: snapshotPath };
  } catch (error) {
    fail(`Unable to snapshot ${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readProof(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const placeholderPattern =
  /<[^>]+>|YYYY|MMDD|HHMMSS|change_me|generate_with|replace_me|placeholder|todo|tbd|not_applicable|n\/a|dummy|fake/i;
const vagueReferencePattern = /(^|[/:_-])(latest|current)([/:_.-]|$)/i;

function jsonPath(parent, segment) {
  if (typeof segment === 'number') {
    return `${parent}[${segment}]`;
  }
  return `${parent}.${segment}`;
}

function findPlaceholderStrings(value, path = 'launchProof', findings = []) {
  if (typeof value === 'string') {
    if (placeholderPattern.test(value) || vagueReferencePattern.test(value)) {
      findings.push(`${path}: ${value}`);
    }
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => findPlaceholderStrings(entry, jsonPath(path, index), findings));
    return findings;
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      findPlaceholderStrings(entry, jsonPath(path, key), findings);
    }
  }

  return findings;
}

const manifestSnapshot = snapshotInput(manifestPath, 'release manifest', 'release-manifest.json');
const proofSnapshot = snapshotInput(proofPath, 'launch proof', 'launch-proof.json');
const proofBytes = proofSnapshot.bytes;
const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
const proof = readProof(proofBytes, 'launch proof');
const releaseManifest = readProof(manifestSnapshot.bytes, 'release manifest');
const placeholderFindings = findPlaceholderStrings(proof);
if (placeholderFindings.length > 0) {
  fail(`Launch proof contains placeholder or vague retained-artifact text:\n${placeholderFindings.map((item) => `- ${item}`).join('\n')}`);
}

function fetchEvidenceBytes(uri, label) {
  let command;
  let commandArgs;
  if (uri.startsWith('https://')) {
    command = 'curl';
    commandArgs = ['--fail', '--silent', '--show-error', '--location', '--max-time', '120'];
    const rawBearerToken = String(process.env.LAUNCH_PROOF_HTTP_BEARER_TOKEN ?? '');
    const bearerToken = rawBearerToken.trim();
    if (bearerToken) {
      if (bearerToken !== rawBearerToken || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(bearerToken)) {
        fail('LAUNCH_PROOF_HTTP_BEARER_TOKEN must be a non-empty supported single-line bearer token when provided.');
      }
      const curlConfigPath = join(inputScratch, 'curl-auth.conf');
      if (!existsSync(curlConfigPath)) {
        writeFileSync(curlConfigPath, `header = "Authorization: Bearer ${bearerToken}"\n`, { mode: 0o600, flag: 'wx' });
      }
      commandArgs.push('--config', curlConfigPath);
    }
    commandArgs.push(uri);
  } else if (uri.startsWith('s3://')) {
    command = 'aws';
    commandArgs = ['s3', 'cp', uri, '-'];
  } else {
    fail(`${label}.uri must use directly retrievable https:// or s3:// evidence when --fetch-evidence is enabled.`);
  }

  const maxBytes = Number(process.env.LAUNCH_PROOF_FETCH_MAX_BYTES ?? 16 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) {
    fail('LAUNCH_PROOF_FETCH_MAX_BYTES must be an integer from 1024 through 67108864.');
  }
  let result;
  const providerEnv = { ...process.env };
  delete providerEnv.LAUNCH_PROOF_HTTP_BEARER_TOKEN;
  try {
    result = runBoundedProviderCommand(command, commandArgs, {
      operation: 'read',
      timeoutMs: process.env.LAUNCH_PROOF_PROVIDER_TIMEOUT_MS ?? 120_000,
      maxOutputBytes: maxBytes,
      cwd: repoRoot,
      env: providerEnv,
      encoding: null,
      label: `Retrieve ${label}`,
    });
  } catch (error) {
    fail(`Unable to retrieve ${label}.uri: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result.stdout;
}

function verifyDrCleanupIdentity(evidenceBytes) {
  let artifact;
  try { artifact = JSON.parse(evidenceBytes.toString('utf8')); } catch { fail('DR drill evidence is not valid JSON.'); }
  const containerId = String(artifact?.container_id ?? '');
  if (
    !/^[a-f0-9]{64}$/.test(containerId)
    || artifact?.cleanup_container_id !== containerId
    || artifact?.cleanup_container_id_absent !== true
    || artifact?.cleanup_container_name_absent !== true
    || artifact?.cleanup_id_evidence !== 'docker-ps-exact-id-v1'
  ) fail('DR drill cleanup proof must bind exact immutable container-ID absence and reject name replacement.');
}

function verifyRecoveryAdapterSignature(evidenceBytes) {
  const material = recoveryAdapterProvenanceFromEvidence(evidenceBytes);
  const expectedIdentity = String(process.env.RECOVERY_ADAPTER_CERTIFICATE_IDENTITY ?? '').trim();
  const expectedIssuer = String(process.env.RECOVERY_ADAPTER_OIDC_ISSUER ?? '').trim();
  if (!expectedIdentity || !expectedIssuer) {
    fail('Protected launch verification requires RECOVERY_ADAPTER_CERTIFICATE_IDENTITY and RECOVERY_ADAPTER_OIDC_ISSUER.');
  }
  if (material.certificateIdentity !== expectedIdentity || material.oidcIssuer !== expectedIssuer) {
    fail('DR recovery adapter provenance is not pinned to the protected workflow signer.');
  }
  const attestationBytes = fetchEvidenceBytes(material.attestationUri, 'launchProof.evidence.drDrill.adapterAttestation');
  const signatureBytes = fetchEvidenceBytes(material.signatureBundleUri, 'launchProof.evidence.drDrill.adapterSignatureBundle');
  if (createHash('sha256').update(attestationBytes).digest('hex') !== material.attestationSha256) {
    fail('DR recovery adapter attestation digest does not match the independently retrieved artifact.');
  }
  if (createHash('sha256').update(signatureBytes).digest('hex') !== material.signatureBundleSha256) {
    fail('DR recovery adapter signature bundle digest does not match the independently retrieved artifact.');
  }
  let attestation;
  try { attestation = JSON.parse(attestationBytes.toString('utf8')); } catch { fail('DR recovery adapter attestation is not valid JSON.'); }
  const issuedAt = Date.parse(attestation?.issuedAt);
  const expiresAt = Date.parse(attestation?.expiresAt);
  if (
    attestation?.version !== 1
    || attestation?.kind !== 'lunchlineup-signed-recovery-adapter-provenance'
    || attestation?.fetchAdapterSha256 !== material.fetchAdapterSha256
    || attestation?.readbackAdapterSha256 !== material.readbackAdapterSha256
    || attestation?.certificateIdentity !== expectedIdentity
    || attestation?.oidcIssuer !== expectedIssuer
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt > Date.now() + 30_000
    || expiresAt <= Date.now()
    || expiresAt - issuedAt > 90 * 86_400_000
  ) fail('Signed recovery adapter attestation does not pin the exact DR adapter provenance.');

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-recovery-adapter-'));
  const attestationPath = join(scratch, 'attestation.json');
  const signaturePath = join(scratch, 'attestation.sigstore.json');
  let verificationError;
  try {
    writeFileSync(attestationPath, attestationBytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(signaturePath, signatureBytes, { mode: 0o600, flag: 'wx' });
    runBoundedProviderCommand(
      process.env.RECOVERY_ADAPTER_COSIGN_BINARY || 'cosign',
      [
        'verify-blob', attestationPath,
        '--bundle', signaturePath,
        '--certificate-identity', expectedIdentity,
        '--certificate-oidc-issuer', expectedIssuer,
      ],
      {
        operation: 'read',
        timeoutMs: process.env.RECOVERY_ADAPTER_VERIFY_TIMEOUT_MS ?? 60_000,
        maxOutputBytes: 1024 * 1024,
        encoding: 'utf8',
        label: 'Recovery adapter signature verification',
      },
    );
  } catch (error) {
    verificationError = error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (verificationError) {
    fail(`DR recovery adapter signature verification failed: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`);
  }
}

if (fetchEvidence) {
  for (const [key, entry] of Object.entries(proof.evidence ?? {})) {
    const label = `launchProof.evidence.${key}`;
    const declaresRetainedArtifact = Boolean(entry?.uri || entry?.artifactSha256 || entry?.artifactBytes);
    if (!declaresRetainedArtifact) continue;
    if (!entry?.uri || !entry?.artifactSha256 || !Number.isInteger(Number(entry?.artifactBytes))) {
      fail(`${label} must declare uri, artifactSha256, and artifactBytes together.`);
    }
    const bytes = fetchEvidenceBytes(String(entry?.uri ?? ''), label);
    const actualSha = createHash('sha256').update(bytes).digest('hex');
    if (actualSha !== entry.artifactSha256) {
      fail(`${label}.artifactSha256 does not match the retrieved evidence bytes.`);
    }
    if (bytes.byteLength !== Number(entry.artifactBytes)) {
      fail(`${label}.artifactBytes does not match the retrieved evidence size.`);
    }
    try {
      if (key === 'drDrill') verifyDrCleanupIdentity(bytes);
      verifyFetchedEvidenceArtifact(key, bytes, entry, releaseManifest);
      if (key === 'drDrill') verifyRecoveryAdapterSignature(bytes);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

const verifier = spawnSync(
  process.execPath,
  [
    resolve(repoRoot, 'scripts/verify-release-artifacts.mjs'),
    manifestSnapshot.path,
    '--launch-proof-file',
    proofSnapshot.path,
    ...verifierArgs,
  ],
  {
    cwd: repoRoot,
    encoding: 'utf8',
  },
);

if (verifier.stdout) {
  process.stdout.write(verifier.stdout);
}
if (verifier.stderr) {
  process.stderr.write(verifier.stderr);
}
if (verifier.error) {
  fail(`Unable to run release artifact verifier: ${verifier.error.message}`);
}
if (verifier.status !== 0) {
  process.exit(verifier.status ?? 1);
}

console.log(
  `production_launch_proof_ok file=${proofPath} source_sha=${proof.sourceSha} sha256=${proofSha256} bytes=${proofBytes.byteLength}`,
);
