import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const payrollMigrations = [
  'packages/db/prisma/migrations/20260716_payroll_controls.sql',
  'packages/db/prisma/migrations/pre_20260716_payroll_controls.sql',
];
const governanceMigration = 'packages/db/prisma/migrations/20260716_zzzz_tenant_data_governance_p1.sql';
const legacyCleanupMigration = 'packages/db/prisma/migrations/20260716_legacy_unbacked_credit_cleanup.sql';
const legacyCleanupDigest = 'ec1da9b03ff9e32f3a1b11803909a07fbf5d558f7186bdb7bb2dfadf91690157';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function gitBytes(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function createPolicyFixture(sql, approval = null) {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-raw-policy-fixture-'));
  const scriptsDir = join(scratch, 'scripts');
  const migrationsDir = join(scratch, 'packages/db/prisma/migrations');
  const candidateName = '20260102_candidate.sql';
  const candidatePath = `packages/db/prisma/migrations/${candidateName}`;
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(migrationsDir, { recursive: true });
  copyFileSync(join(root, 'scripts/generate-raw-migration-policy.mjs'), join(scriptsDir, 'generate-raw-migration-policy.mjs'));
  copyFileSync(join(root, 'scripts/verify-rollback-schema-compatibility.py'), join(scriptsDir, 'verify-rollback-schema-compatibility.py'));
  writeFileSync(join(migrationsDir, '20260101_historical.sql'), 'CREATE TABLE "Historical" ("id" TEXT PRIMARY KEY);\n');
  git(scratch, 'init');
  git(scratch, 'config', 'user.email', 'policy-test@lunchlineup.invalid');
  git(scratch, 'config', 'user.name', 'LunchLineup policy test');
  git(scratch, 'add', 'packages/db/prisma/migrations/20260101_historical.sql');
  git(scratch, 'commit', '-m', 'historical migration fixture');
  const baseline = git(scratch, 'rev-parse', 'HEAD');
  writeFileSync(join(migrationsDir, candidateName), sql);
  writeFileSync(join(scriptsDir, 'raw-migration-rollback-policy.json'), `${JSON.stringify({
    version: 1,
    historicalBaselineSourceSha: baseline,
    compatibilityClass: 'backward-compatible-additive-v1',
    migrations: {},
    expandContract: approval ? { [candidatePath]: approval } : {},
  })}\n`);
  return { scratch, candidatePath };
}

function runGenerator(cwd, env = process.env) {
  return spawnSync(process.execPath, ['scripts/generate-raw-migration-policy.mjs'], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function manualApproval(sql, overrides = {}) {
  return {
    sha256: createHash('sha256').update(sql).digest('hex'),
    phase: 'expand-contract',
    rollbackSchema: 'retain',
    contractPhase: 'compatibility-proven-inline',
    requiresOldReleaseProof: true,
    rationale: 'The exact destructive transition remains during rollback; isolated old-release proof is required before production mutation.',
    ...overrides,
  };
}

test('every non-payroll candidate-only raw and pre migration has exact policy coverage', () => {
  const actual = JSON.parse(readFileSync(join(root, 'scripts/raw-migration-rollback-policy.json'), 'utf8'));
  assert.equal(actual.version, 2);
  assert.match(actual.historicalBaselineSourceSha, /^[a-f0-9]{40}$/);
  assert.equal(actual.compatibilityClass, 'backward-compatible-additive-v1');
  const historical = new Set(git(
    root,
    'ls-tree',
    '-r',
    '--name-only',
    actual.historicalBaselineSourceSha,
    'packages/db/prisma/migrations',
  ).split(/\r?\n/).filter((path) => path.endsWith('.sql')));
  assert.deepEqual(Object.keys(actual.historicalMigrations).sort(), [...historical].sort());
  for (const path of historical) {
    const baselineBytes = gitBytes(root, 'show', `${actual.historicalBaselineSourceSha}:${path}`);
    assert.equal(
      actual.historicalMigrations[path],
      createHash('sha256').update(baselineBytes).digest('hex'),
      `${path} must bind exact baseline bytes`,
    );
  }
  const candidates = readdirSync(join(root, 'packages/db/prisma/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => `packages/db/prisma/migrations/${name}`)
    .filter((path) => !historical.has(path) && !payrollMigrations.includes(path))
    .sort();
  const covered = new Set([
    ...Object.keys(actual.migrations).filter((path) => !payrollMigrations.includes(path)),
    ...Object.keys(actual.expandContract).filter((path) => !payrollMigrations.includes(path)),
  ]);
  assert.deepEqual([...covered].sort(), candidates);
  for (const path of candidates) {
    const digest = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
    const approval = actual.migrations[path] ?? actual.expandContract[path];
    assert.equal(approval?.sha256, digest, `${path} must have the exact current digest`);
  }
  assert.ok([...covered].some((path) => path.includes('/pre_')), 'candidate pre-migrations require exact policy coverage');
  assert.equal(
    covered.size,
    Object.keys(actual.migrations).filter((path) => !payrollMigrations.includes(path)).length
      + Object.keys(actual.expandContract).filter((path) => !payrollMigrations.includes(path)).length,
  );
});

test('governance trigger and legacy cleanup migrations have exact expand-contract approvals', () => {
  const policy = JSON.parse(readFileSync(join(root, 'scripts/raw-migration-rollback-policy.json'), 'utf8'));
  const governanceDigest = createHash('sha256').update(readFileSync(join(root, governanceMigration))).digest('hex');
  assert.deepEqual(policy.expandContract[governanceMigration], {
    sha256: governanceDigest,
    phase: 'expand-contract',
    rollbackSchema: 'retain',
    contractPhase: 'compatibility-proven-inline',
    requiresOldReleaseProof: true,
    rationale: 'canonical tenant lifecycle locks, trigger enforcement, and durable export cleanup ownership remain during rollback; isolated old-release proof is required before production mutation.',
  });
  assert.equal(policy.expandContract[legacyCleanupMigration]?.sha256, legacyCleanupDigest);
  assert.equal(
    createHash('sha256').update(readFileSync(join(root, legacyCleanupMigration))).digest('hex'),
    legacyCleanupDigest,
  );
});

test('rollback verifier requires and accepts old-release proof for the exact governance migration digest', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-governance-rollback-'));
  const rollbackManifest = join(scratch, 'rollback.json');
  const candidateManifest = join(scratch, 'candidate.json');
  const compatibilityProof = join(scratch, 'old-release-compatibility.json');
  const previousSha = 'a'.repeat(40);
  const candidateSha = 'b'.repeat(40);
  const digest = createHash('sha256').update(readFileSync(join(root, governanceMigration))).digest('hex');
  const contract = (files) => ({ files, rawMigrations: { version: 1, files } });
  try {
    writeFileSync(rollbackManifest, JSON.stringify({ sourceSha: previousSha, deploymentContract: contract({}) }));
    writeFileSync(candidateManifest, JSON.stringify({
      sourceSha: candidateSha,
      deploymentContract: contract({ [governanceMigration]: digest }),
    }));
    writeFileSync(compatibilityProof, JSON.stringify({
      version: 1,
      status: 'passed',
      previousReleaseSha: previousSha,
      candidateReleaseSha: candidateSha,
      database: { isolatedClone: true, productionMutated: false },
      candidateSchema: { applied: true },
      oldReleaseSmoke: { status: 'passed' },
      completedAt: new Date().toISOString(),
      evidenceUri: 'https://example.invalid/immutable/governance-old-release-proof.json',
    }));
    const args = [
      'scripts/verify-raw-migration-rollback.mjs',
      '--rollback-manifest', rollbackManifest,
      '--candidate-manifest', candidateManifest,
      '--candidate-root', root,
      '--old-release-compatibility-proof', compatibilityProof,
    ];
    const missingProof = spawnSync(process.execPath, args.slice(0, -2), {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(missingProof.status, 0);
    assert.match(missingProof.stderr, /requires old-release compatibility proof/);
    const verified = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.match(verified.stdout, /candidate_only=1 additive=0 expand_contract=1/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('raw migration policy generation fails closed on immutable historical drift', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-raw-policy-drift-'));
  const scriptsDir = join(scratch, 'scripts');
  const migrationsDir = join(scratch, 'packages/db/prisma/migrations');
  const migrationPath = join(migrationsDir, '20260101_historical.sql');
  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(migrationsDir, { recursive: true });
    copyFileSync(join(root, 'scripts/generate-raw-migration-policy.mjs'), join(scriptsDir, 'generate-raw-migration-policy.mjs'));
    writeFileSync(migrationPath, 'CREATE TABLE "Historical" ("id" TEXT PRIMARY KEY);\n');
    git(scratch, 'init');
    git(scratch, 'config', 'user.email', 'policy-test@lunchlineup.invalid');
    git(scratch, 'config', 'user.name', 'LunchLineup policy test');
    git(scratch, 'add', 'packages/db/prisma/migrations/20260101_historical.sql');
    git(scratch, 'commit', '-m', 'historical migration fixture');
    const baseline = git(scratch, 'rev-parse', 'HEAD');
    writeFileSync(join(scriptsDir, 'raw-migration-rollback-policy.json'), `${JSON.stringify({
      version: 1,
      historicalBaselineSourceSha: baseline,
      compatibilityClass: 'backward-compatible-additive-v1',
      migrations: {},
      expandContract: {},
    })}\n`);
    writeFileSync(migrationPath, 'CREATE TABLE "Historical" ("id" TEXT PRIMARY KEY, "drift" TEXT);\n');

    const result = spawnSync(process.execPath, [join(scriptsDir, 'generate-raw-migration-policy.mjs')], {
      cwd: scratch,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Historical migration is not immutable/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('raw migration policy generation rejects CRLF-only and mixed-EOL historical drift', () => {
  for (const driftedSql of [
    'CREATE TABLE "Historical" ("id" TEXT PRIMARY KEY);\r\n',
    'CREATE TABLE "Historical" (\r\n  "id" TEXT PRIMARY KEY\n);\r\n',
  ]) {
    const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-raw-policy-eol-drift-'));
    const scriptsDir = join(scratch, 'scripts');
    const migrationsDir = join(scratch, 'packages/db/prisma/migrations');
    const migrationPath = join(migrationsDir, '20260101_historical.sql');
    try {
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(migrationsDir, { recursive: true });
      copyFileSync(join(root, 'scripts/generate-raw-migration-policy.mjs'), join(scriptsDir, 'generate-raw-migration-policy.mjs'));
      writeFileSync(migrationPath, 'CREATE TABLE "Historical" ("id" TEXT PRIMARY KEY);\n');
      git(scratch, 'init');
      git(scratch, 'config', 'user.email', 'policy-test@lunchlineup.invalid');
      git(scratch, 'config', 'user.name', 'LunchLineup policy test');
      git(scratch, 'config', 'core.autocrlf', 'true');
      git(scratch, 'add', 'packages/db/prisma/migrations/20260101_historical.sql');
      git(scratch, 'commit', '-m', 'historical migration fixture');
      const baseline = git(scratch, 'rev-parse', 'HEAD');
      writeFileSync(join(scriptsDir, 'raw-migration-rollback-policy.json'), `${JSON.stringify({
        version: 1,
        historicalBaselineSourceSha: baseline,
        compatibilityClass: 'backward-compatible-additive-v1',
        migrations: {},
        expandContract: {},
      })}\n`);
      writeFileSync(migrationPath, driftedSql);

      const result = runGenerator(scratch);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Historical migration is not immutable/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('raw migration policy generation emits only classifier-proven additive approval', () => {
  const sql = 'CREATE TABLE "Candidate" ("id" TEXT PRIMARY KEY);\n';
  const fixture = createPolicyFixture(sql);
  try {
    const result = runGenerator(fixture.scratch);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const policy = JSON.parse(result.stdout);
    assert.deepEqual(policy.migrations[fixture.candidatePath], {
      sha256: createHash('sha256').update(sql).digest('hex'),
      compatibility: 'backward-compatible-additive-v1',
    });
    assert.deepEqual(policy.expandContract, {});
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('raw migration policy generation fails closed when Python cannot start', () => {
  const fixture = createPolicyFixture('CREATE TABLE "Candidate" ("id" TEXT PRIMARY KEY);\n');
  try {
    const result = runGenerator(fixture.scratch, {
      ...process.env,
      RAW_MIGRATION_CLASSIFIER_PYTHON: join(fixture.scratch, 'missing-python-runtime'),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Rollback classifier could not start/);
    assert.match(result.stderr, /exact pre-existing manually authored expand-contract approval is required/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('raw migration policy generation rejects malformed, destructive, and unknown SQL without manual approval', () => {
  for (const sql of [
    'CREATE TABLE "Broken" (\n',
    'DROP TABLE "Historical";\n',
    'VACUUM "Historical";\n',
  ]) {
    const fixture = createPolicyFixture(sql);
    try {
      const result = runGenerator(fixture.scratch);
      assert.notEqual(result.status, 0, sql);
      assert.match(result.stderr, /Rollback classifier rejected SQL/);
      assert.match(result.stderr, /exact pre-existing manually authored expand-contract approval is required/);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('raw migration policy generation preserves only an exact pre-existing manual approval', () => {
  const sql = 'DROP TABLE "RetiredCandidateTable";\n';
  const approval = manualApproval(sql);
  const fixture = createPolicyFixture(sql, approval);
  try {
    const result = runGenerator(fixture.scratch);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).expandContract[fixture.candidatePath], approval);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('raw migration policy generation rejects approval after SQL semantics change', () => {
  const approvedSql = 'DROP TABLE "RetiredCandidateTable";\n';
  const modifiedSql = 'DROP TABLE "DifferentCandidateTable";\n';
  const fixture = createPolicyFixture(modifiedSql, manualApproval(approvedSql));
  try {
    const result = runGenerator(fixture.scratch);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approval does not match current migration semantics/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('raw migration policy generation independently validates every approval field and rationale', () => {
  const sql = 'DROP TABLE "RetiredCandidateTable";\n';
  const invalidApprovals = [
    manualApproval(sql, { phase: 'contract' }),
    manualApproval(sql, { rollbackSchema: 'restore' }),
    manualApproval(sql, { contractPhase: 'after-rollback-window' }),
    manualApproval(sql, { requiresOldReleaseProof: false }),
    manualApproval(sql, { rationale: 'TBD rollback old-release proof' }),
    { ...manualApproval(sql), unreviewedSemantics: true },
  ];
  for (const approval of invalidApprovals) {
    const fixture = createPolicyFixture(sql, approval);
    try {
      const result = runGenerator(fixture.scratch);
      assert.notEqual(result.status, 0, JSON.stringify(approval));
      assert.match(result.stderr, /Expand-contract approval/);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});
