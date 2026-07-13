#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyFetchedEvidenceArtifact } from './launch-proof-evidence.mjs';

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

function readProof(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`Unable to read launch proof ${path}: ${error instanceof Error ? error.message : String(error)}`);
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

const proofBytes = readFileSync(proofPath);
const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
const proof = readProof(proofPath);
const releaseManifest = readProof(manifestPath);
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
    const bearerToken = String(process.env.LAUNCH_PROOF_HTTP_BEARER_TOKEN ?? '').trim();
    if (bearerToken) commandArgs.push('--header', `Authorization: Bearer ${bearerToken}`);
    commandArgs.push(uri);
  } else if (uri.startsWith('s3://')) {
    command = 'aws';
    commandArgs = ['s3', 'cp', uri, '-'];
  } else {
    fail(`${label}.uri must use directly retrievable https:// or s3:// evidence when --fetch-evidence is enabled.`);
  }

  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
    fail(`Unable to retrieve ${label}.uri: ${result.error?.message || stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
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
      verifyFetchedEvidenceArtifact(key, bytes, entry, releaseManifest);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

const verifier = spawnSync(
  process.execPath,
  [
    resolve(repoRoot, 'scripts/verify-release-artifacts.mjs'),
    manifestPath,
    '--launch-proof-file',
    proofPath,
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
