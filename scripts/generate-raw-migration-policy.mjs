#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'packages/db/prisma/migrations');
const policyPath = join(root, 'scripts/raw-migration-rollback-policy.json');
const compatibility = 'backward-compatible-additive-v1';
const approvalFields = [
  'sha256',
  'phase',
  'rollbackSchema',
  'contractPhase',
  'requiresOldReleaseProof',
  'rationale',
];

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8' }); }
function gitBytes(args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function validateApproval(path, approval, expectedDigest = null) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    throw new Error(`Expand-contract approval must be an object: ${path}`);
  }
  const fields = Object.keys(approval).sort();
  if (JSON.stringify(fields) !== JSON.stringify([...approvalFields].sort())) {
    throw new Error(`Expand-contract approval has missing or unknown fields: ${path}`);
  }
  if (!/^[a-f0-9]{64}$/.test(approval.sha256)) {
    throw new Error(`Expand-contract approval sha256 is invalid: ${path}`);
  }
  if (expectedDigest !== null && approval.sha256 !== expectedDigest) {
    throw new Error(`Expand-contract approval does not match current migration semantics: ${path}`);
  }
  if (!['expand', 'expand-contract'].includes(approval.phase)) {
    throw new Error(`Expand-contract approval phase is invalid: ${path}`);
  }
  if (approval.rollbackSchema !== 'retain') {
    throw new Error(`Expand-contract approval rollbackSchema must be retain: ${path}`);
  }
  const expectedContractPhase = approval.phase === 'expand'
    ? 'after-rollback-window'
    : 'compatibility-proven-inline';
  if (approval.contractPhase !== expectedContractPhase) {
    throw new Error(`Expand-contract approval contractPhase does not match phase: ${path}`);
  }
  if (approval.requiresOldReleaseProof !== true) {
    throw new Error(`Expand-contract approval requiresOldReleaseProof must be true: ${path}`);
  }
  if (
    typeof approval.rationale !== 'string'
    || approval.rationale !== approval.rationale.trim()
    || approval.rationale.length < 40
    || !/\brollback\b/i.test(approval.rationale)
    || !/\bold-release\b/i.test(approval.rationale)
    || /\b(?:todo|tbd|placeholder)\b/i.test(approval.rationale)
  ) {
    throw new Error(`Expand-contract approval rationale must explain rollback and old-release proof: ${path}`);
  }
  return { ...approval };
}

function classifierFailure(classifier) {
  if (classifier.error) return `could not start: ${classifier.error.message}`;
  if (classifier.signal) return `terminated by signal ${classifier.signal}`;
  if (classifier.status === null) return 'ended without an exit status';
  const detail = String(classifier.stderr || classifier.stdout || '').trim();
  return `rejected SQL with exit ${classifier.status}${detail ? `: ${detail}` : ''}`;
}

function main() {
  const existingPolicy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, 'utf8')) : {};
  const existingApprovals = existingPolicy.expandContract ?? {};
  if (!existingApprovals || typeof existingApprovals !== 'object' || Array.isArray(existingApprovals)) {
    throw new Error('Raw migration policy expandContract must be an object.');
  }
  for (const [path, approval] of Object.entries(existingApprovals)) validateApproval(path, approval);
  const baseline = existingPolicy.historicalBaselineSourceSha || git(['rev-parse', 'HEAD']).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(baseline)) throw new Error('Raw migration policy requires a full historicalBaselineSourceSha.');
  if (git(['merge-base', '--is-ancestor', baseline, 'HEAD']).status !== 0) {
    throw new Error(`Raw migration policy baseline is not an ancestor of HEAD: ${baseline}`);
  }
  const historicalResult = git(['ls-tree', '-r', '--name-only', baseline, 'packages/db/prisma/migrations']);
  if (historicalResult.status !== 0) throw new Error(`Unable to read raw migration baseline ${baseline}.`);
  const historical = new Set(historicalResult.stdout.trim().split(/\r?\n/).filter((path) => path.endsWith('.sql')));
  const historicalMigrations = {};
  for (const path of [...historical].sort()) {
    const blob = gitBytes(['show', `${baseline}:${path}`]);
    if (blob.status !== 0 || blob.error || blob.signal) {
      throw new Error(`Unable to read historical migration bytes from ${baseline}: ${path}`);
    }
    historicalMigrations[path] = sha256(blob.stdout);
  }
  const names = readdirSync(migrationsDir).filter((value) => value.endsWith('.sql')).sort();
  const current = new Set(names.map((name) => `packages/db/prisma/migrations/${name}`));
  for (const path of historical) {
    if (!current.has(path)) throw new Error(`Historical migration was removed: ${path}`);
  }
  const policy = {
    version: 2,
    historicalBaselineSourceSha: baseline,
    historicalMigrations,
    compatibilityClass: compatibility,
    migrations: {},
    expandContract: {},
  };
  const retainedApprovals = new Set();
  for (const name of names) {
    const path = `packages/db/prisma/migrations/${name}`;
    const bytes = readFileSync(join(migrationsDir, name));
    if (historical.has(path)) {
      if (sha256(bytes) !== historicalMigrations[path]) {
        throw new Error(`Historical migration is not immutable: ${path}`);
      }
      continue;
    }
    const classifierRuntime = process.env.RAW_MIGRATION_CLASSIFIER_PYTHON
      || (process.platform === 'win32' ? 'python' : 'python3');
    const classifier = spawnSync(classifierRuntime, [join(root, 'scripts/verify-rollback-schema-compatibility.py'), join(migrationsDir, name)], { encoding: 'utf8' });
    const digest = sha256(bytes);
    if (
      !classifier.error
      && !classifier.signal
      && classifier.status === 0
      && /^rollback_schema_diff_ok policy=backward-compatible-additive\b/.test(classifier.stdout.trim())
    ) {
      policy.migrations[path] = { sha256: digest, compatibility };
      continue;
    }
    const approval = existingApprovals[path];
    if (!approval) {
      throw new Error(`Rollback classifier ${classifierFailure(classifier)} for ${path}; an exact pre-existing manually authored expand-contract approval is required.`);
    }
    policy.expandContract[path] = validateApproval(path, approval, digest);
    retainedApprovals.add(path);
  }
  for (const path of Object.keys(existingApprovals)) {
    if (!retainedApprovals.has(path)) {
      throw new Error(`Expand-contract approval is stale or no longer required by classifier output: ${path}`);
    }
  }
  const output = `${JSON.stringify(policy, null, 2)}\n`;
  if (process.argv.includes('--write')) writeFileSync(policyPath, output);
  else process.stdout.write(output);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
