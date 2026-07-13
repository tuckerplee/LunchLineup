#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOldReleaseCompatibility } from './verify-old-release-compatibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`raw migration rollback compatibility failed closed: ${message}`);
  process.exit(1);
}

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`unable to read ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function inventory(manifest, label) {
  const value = manifest?.deploymentContract?.rawMigrations;
  if (value?.version !== 1 || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    fail(`${label} must contain deploymentContract.rawMigrations version 1.`);
  }
  for (const [path, digest] of Object.entries(value.files)) {
    if (path.includes('\\') || path.split('/').includes('..') || !path.startsWith('packages/db/prisma/migrations/') || !path.endsWith('.sql') || !/^[a-f0-9]{64}$/.test(digest)) {
      fail(`${label} contains an invalid raw migration inventory entry: ${path}.`);
    }
    if (manifest.deploymentContract.files?.[path] !== digest) {
      fail(`${label} raw migration digest is not bound to deploymentContract.files: ${path}.`);
    }
  }
  return value.files;
}

const rollbackManifestPath = option('--rollback-manifest');
const candidateManifestPath = option('--candidate-manifest');
const candidateRoot = resolve(option('--candidate-root', root));
const policyPath = resolve(option('--policy', join(candidateRoot, 'scripts/raw-migration-rollback-policy.json')));
const classifierPath = resolve(option('--classifier', join(candidateRoot, 'scripts/verify-rollback-schema-compatibility.py')));
const compatibilityProofPath = option('--old-release-compatibility-proof');
if (!rollbackManifestPath || !candidateManifestPath) {
  fail('usage: verify-raw-migration-rollback.mjs --rollback-manifest PATH --candidate-manifest PATH [--candidate-root DIR] [--policy PATH].');
}

const rollbackFiles = inventory(readJson(rollbackManifestPath, 'rollback manifest'), 'rollback manifest');
const candidateFiles = inventory(readJson(candidateManifestPath, 'candidate manifest'), 'candidate manifest');
const policy = readJson(policyPath, 'raw migration rollback policy');
if (policy.version !== 1 || policy.compatibilityClass !== 'backward-compatible-additive-v1' || !policy.migrations || typeof policy.migrations !== 'object') {
  fail('policy must be version 1 with compatibilityClass backward-compatible-additive-v1 and a migrations object.');
}

const changed = Object.entries(candidateFiles).filter(([path, digest]) => rollbackFiles[path] !== digest);
for (const path of Object.keys(rollbackFiles)) {
  if (!Object.hasOwn(candidateFiles, path)) fail(`candidate inventory removed a historical raw migration: ${path}.`);
}
const scratch = mkdtempSync(join(tmpdir(), 'll-raw-rollback-'));
try {
  const sql = [];
  let expandContractCount = 0;
  for (const [path, digest] of changed) {
    if (Object.hasOwn(rollbackFiles, path)) fail(`immutable migration changed digest: ${path}.`);
    const approval = policy.migrations[path];
    const bytes = readFileSync(resolve(candidateRoot, path));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) fail(`candidate migration bytes do not match the release contract: ${path}.`);
    if (approval?.sha256 === digest && approval?.compatibility === policy.compatibilityClass) {
      sql.push(`\n-- ${path}\n${bytes.toString('utf8')}\n`);
      continue;
    }
    const design = policy.expandContract?.[path];
    if (
      design?.sha256 !== digest
      || !['expand', 'expand-contract'].includes(design?.phase)
      || design?.rollbackSchema !== 'retain'
      || !['after-rollback-window', 'compatibility-proven-inline'].includes(design?.contractPhase)
      || design?.requiresOldReleaseProof !== true
      || typeof design?.rationale !== 'string'
      || design.rationale.length < 20
    ) fail(`candidate-only migration lacks an exact additive approval or expand/contract design: ${path}.`);
    if (!compatibilityProofPath) fail(`expand/contract migration requires old-release compatibility proof: ${path}.`);
    const proof = readJson(compatibilityProofPath, 'old-release compatibility proof');
    try {
      verifyOldReleaseCompatibility(proof, {
        previousSha: readJson(rollbackManifestPath, 'rollback manifest').sourceSha,
        candidateSha: readJson(candidateManifestPath, 'candidate manifest').sourceSha,
      });
    } catch (error) {
      fail(`old-release compatibility proof rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    expandContractCount += 1;
  }

  if (sql.length > 0) {
    const sqlPath = join(scratch, 'candidate-only.sql');
    writeFileSync(sqlPath, sql.join(''));
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const classifier = spawnSync(python, [classifierPath, sqlPath], { encoding: 'utf8' });
    if (classifier.error || classifier.status !== 0) {
      fail(`candidate-only SQL is destructive, trigger/RLS-bearing, or unknown. ${classifier.stderr || classifier.stdout || classifier.error?.message}`.trim());
    }
  }
  console.log(`raw_migration_rollback_ok candidate_only=${changed.length} additive=${sql.length} expand_contract=${expandContractCount} policy=${policy.compatibilityClass}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
