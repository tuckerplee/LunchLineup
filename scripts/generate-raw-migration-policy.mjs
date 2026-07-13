#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'packages/db/prisma/migrations');
const policyPath = join(root, 'scripts/raw-migration-rollback-policy.json');
const compatibility = 'backward-compatible-additive-v1';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(args) { return spawnSync('git', args, { cwd: root, encoding: 'utf8' }); }

function designFor(sql) {
  const hasDrop = /\bDROP\s+(?:INDEX|CONSTRAINT|POLICY|TRIGGER|COLUMN|TABLE|TYPE)\b/i.test(sql);
  const categories = [];
  if (/\bUPDATE\b|\bINSERT\b|\bDELETE\b|\bWITH\b/i.test(sql)) categories.push('data backfill');
  if (/\bUNIQUE\b|\bCHECK\b|\bFOREIGN KEY\b|\bEXCLUDE\b/i.test(sql)) categories.push('constraint transition');
  if (/\bPOLICY\b|ROW LEVEL SECURITY|\bTRIGGER\b|CREATE OR REPLACE FUNCTION/i.test(sql)) categories.push('database enforcement');
  if (/CREATE TYPE|CREATE TABLE|ADD COLUMN|ALTER TYPE/i.test(sql)) categories.push('schema expansion');
  if (categories.length === 0) categories.push('operational schema transition');
  return {
    phase: hasDrop ? 'expand-contract' : 'expand',
    rollbackSchema: 'retain',
    contractPhase: hasDrop ? 'compatibility-proven-inline' : 'after-rollback-window',
    requiresOldReleaseProof: true,
    rationale: `${categories.join(', ')} remains in the candidate schema during rollback; isolated old-release smoke proof is mandatory before production mutation.`,
  };
}

function main() {
  const historical = new Set(git(['ls-tree', '-r', '--name-only', 'HEAD', 'packages/db/prisma/migrations']).stdout.trim().split(/\r?\n/));
  const policy = { version: 1, compatibilityClass: compatibility, migrations: {}, expandContract: {} };
  for (const name of readdirSync(migrationsDir).filter((value) => value.endsWith('.sql')).sort()) {
    const path = `packages/db/prisma/migrations/${name}`;
    const bytes = readFileSync(join(migrationsDir, name));
    if (historical.has(path)) {
      const diff = git(['diff', '--quiet', '--', path]);
      if (diff.status !== 0) {
        throw new Error(`Historical migration is not immutable: ${path}`);
      }
      continue;
    }
    const classifier = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [join(root, 'scripts/verify-rollback-schema-compatibility.py'), join(migrationsDir, name)], { encoding: 'utf8' });
    const digest = sha256(bytes);
    if (classifier.status === 0) policy.migrations[path] = { sha256: digest, compatibility };
    else policy.expandContract[path] = { sha256: digest, ...designFor(bytes.toString('utf8')) };
  }
  const output = `${JSON.stringify(policy, null, 2)}\n`;
  if (process.argv.includes('--write')) writeFileSync(policyPath, output);
  else process.stdout.write(output);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
