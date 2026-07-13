import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('VM217 production deploy gates success on public and required internal health', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const ci = read('.github/workflows/ci.yml');
  const requiredServices = ['worker', 'engine', 'webhook-replay', 'prometheus', 'alertmanager'];

  assert.match(script, /HEALTH_URL="\$\{HEALTH_URL:-\}"/);
  assert.match(script, /PRODUCTION_WEB_URL="\$\{PRODUCTION_WEB_URL:-\}"/);
  assert.match(script, /wait_for_health "\$\{HEALTH_URL:-\$PRODUCTION_API_HEALTH_URL\}"/);
  assert.match(script, /wait_for_release_health "\$PRODUCTION_API_HEALTH_URL" "\$SOURCE_SHA"/);
  assert.match(script, /wait_for_web_surface "\$PRODUCTION_WEB_URL" "Public Next\.js web surface" "\$SOURCE_SHA"/);
  for (const service of requiredServices) {
    assert.match(script, new RegExp(`\\b${service}\\b`));
  }
  assert.match(script, /docker inspect --format .*\.State\.Health/);
  assert.match(script, /if \[\[ -n "\$health_status" && "\$health_status" != "healthy" \]\]/);
  assert.match(script, /elif \[\[ -z "\$health_status" && "\$state_status" != "running" \]\]/);

  const apiHealthIndex = script.lastIndexOf('wait_for_health "${HEALTH_URL:-$PRODUCTION_API_HEALTH_URL}"');
  const releaseHealthIndex = script.lastIndexOf('wait_for_release_health "$PRODUCTION_API_HEALTH_URL" "$SOURCE_SHA"');
  const publicWebIndex = script.lastIndexOf('wait_for_web_surface "$PRODUCTION_WEB_URL"');
  const internalHealthIndex = script.lastIndexOf('! wait_for_required_services');
  const retainedProofIndex = script.lastIndexOf('write_post_deploy_proof');
  const deployedShaIndex = script.lastIndexOf('commit_release_pointers');
  const successIndex = script.indexOf('deploy_remote_ok scope=production');
  assert.ok(releaseHealthIndex !== -1 && releaseHealthIndex < apiHealthIndex);
  assert.ok(apiHealthIndex !== -1 && apiHealthIndex < publicWebIndex);
  assert.ok(publicWebIndex < internalHealthIndex);
  assert.ok(internalHealthIndex !== -1 && internalHealthIndex < retainedProofIndex);
  assert.ok(retainedProofIndex < deployedShaIndex);
  assert.ok(deployedShaIndex < successIndex);
  assert.match(script, /Production post-deploy verification failed; the CI failure path must run the configured verified rollback command/);
  assert.match(ci, /production-rollback:[\s\S]*production_rollback_armed == 'true'[\s\S]*PRODUCTION_ROLLBACK_COMMAND/);
});

test('production releases for the same workflow and ref serialize without cancellation', () => {
  const ci = read('.github/workflows/ci.yml');
  const concurrencyStart = ci.indexOf('concurrency:');
  const jobsStart = ci.indexOf('\njobs:', concurrencyStart);
  const concurrency = ci.slice(concurrencyStart, jobsStart);

  assert.ok(concurrencyStart !== -1 && jobsStart > concurrencyStart);
  assert.match(concurrency, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  assert.match(concurrency, /cancel-in-progress: false/);
  assert.doesNotMatch(concurrency, /github\.(?:sha|run_id|run_number|run_attempt)/);
});

test('production rollback is durably armed in a completed step before remote mutation', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const ci = read('.github/workflows/ci.yml');
  const productionStart = script.indexOf('run_production_release_deploy()');
  const productionEnd = script.indexOf('run_development_source_deploy()', productionStart);
  const productionDeploy = script.slice(productionStart, productionEnd);
  const lockIndex = script.lastIndexOf('if ! flock -n 9');
  const productionCallIndex = script.lastIndexOf('run_production_release_deploy');
  const preflightIndex = productionDeploy.indexOf('preflight_rollback_schema_compatibility');
  const mutationIndex = productionDeploy.indexOf('compose_release up -d --no-build --pull never');
  const verifyInputsIndex = ci.indexOf('name: Verify production deployment inputs');
  const armStepIndex = ci.indexOf('name: Arm production rollback');
  const deployStepStart = ci.indexOf('id: production_deploy');
  const deployStepEnd = ci.indexOf('      - name: Verify deployed release inputs remain exact', deployStepStart);
  const deployStep = ci.slice(deployStepStart, deployStepEnd);

  assert.ok(productionStart !== -1 && productionEnd > productionStart);
  assert.ok(lockIndex !== -1 && lockIndex < productionCallIndex);
  assert.ok(preflightIndex !== -1 && preflightIndex < mutationIndex);
  assert.ok(verifyInputsIndex !== -1 && verifyInputsIndex < armStepIndex);
  assert.ok(armStepIndex < deployStepStart, 'arming must complete before the remote deploy command starts');
  assert.match(ci, /id: arm_production_rollback[\s\S]*echo "armed=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(ci, /production_rollback_armed: \$\{\{ steps\.arm_production_rollback\.outputs\.armed \}\}/);
  assert.match(ci, /needs\.deploy-production\.outputs\.production_rollback_armed == 'true'/);
  assert.match(ci, /needs\.deploy-production\.result != 'success'[\s\S]*needs\.production-smoke\.result != 'success'/);
  assert.doesNotMatch(script, /production_deploy_mutation_started/);
  assert.doesNotMatch(deployStep, /GITHUB_OUTPUT|PIPESTATUS|while IFS= read/);
});
test('VM217 public web gate rejects API health and generic edge responses', () => {
  const script = read('scripts/deploy-vm217-remote.sh');

  assert.match(script, /PRODUCTION_WEB_URL must target the public Next\.js root route \(\/\), not an API or health path/);
  assert.match(script, /\[\[ "\$code" != "200" \]\]/);
  assert.match(script, /\[\[ "\$content_type" != text\/html\* \]\]/);
  assert.match(script, /response_bytes < 1024/);
  assert.match(script, /served_release" != "\$expected_release/);
  assert.match(script, /X-LunchLineup-Release/i);
  assert.match(script, /grep -Fq '<h1>LunchLineup<\/h1>'/);
  assert.match(script, /grep -Fq '\/_next\/static\/'/);
  assert.match(script, /Cache-Control: no-cache/);
  assert.match(script, /lunchlineup_deploy_probe=/);
});

test('VM217 binds downloaded launch proof to CI checksum, source SHA, and freshness', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const validator = read('scripts/verify-downloaded-launch-proof.py');

  assert.match(script, /require_sha256 "\$LAUNCH_PROOF_ARTIFACT_SHA256"/);
  assert.match(script, /python3 scripts\/verify-downloaded-launch-proof\.py "\$proof_body"/);
  assert.match(validator, /proof\.get\("sourceSha"\) != args\.source_sha/);
  assert.match(validator, /LAUNCH_PROOF_MAX_AGE_SECONDS must be a positive integer/);
  assert.match(validator, /exceeds LAUNCH_PROOF_MAX_AGE_SECONDS/);
  assert.match(script, /--mode "\$launch_proof_mode"/);

  const checksumIndex = script.indexOf('python3 scripts/verify-downloaded-launch-proof.py');
  const proofRecordIndex = script.indexOf('cat > "$proof_tmp"');
  const retainedProofIndex = script.indexOf('mv "$proof_tmp" "$proof_path"');
  const successIndex = script.indexOf('post_deploy_proof_ok');
  assert.ok(checksumIndex !== -1 && checksumIndex < proofRecordIndex);
  assert.ok(proofRecordIndex < retainedProofIndex);
  assert.ok(retainedProofIndex < successIndex);
});

test('VM217 proof validator accepts exact fresh bytes and rejects checksum drift', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-vm217-proof-'));
  const proofPath = join(scratch, 'launch-proof.json');
  const sourceSha = '0123456789abcdef0123456789abcdef01234567';
  const checkedAt = '2026-07-09T12:00:00.000Z';
  const proof = {
    sourceSha,
    generatedAt: checkedAt,
    evidence: {
      runtimeEnv: { checkedAt },
    },
  };
  const proofBytes = `${JSON.stringify(proof)}\n`;
  const sha256 = createHash('sha256').update(proofBytes).digest('hex');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const args = [
    'scripts/verify-downloaded-launch-proof.py',
    proofPath,
    '--source-sha',
    sourceSha,
    '--sha256',
    sha256,
    '--max-age-seconds',
    '86400',
    '--verification-time',
    checkedAt,
  ];

  try {
    writeFileSync(proofPath, proofBytes);
    const valid = spawnSync(python, args, { cwd: root, encoding: 'utf8' });
    assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
    assert.match(valid.stdout, /downloaded_launch_proof_ok/);

    const multiDayRollback = spawnSync(python, [
      ...args,
      '--verification-time',
      '2026-08-09T12:00:00.000Z',
      '--mode',
      'rollback',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(multiDayRollback.status, 0, `${multiDayRollback.stdout}\n${multiDayRollback.stderr}`);
    assert.match(multiDayRollback.stdout, /mode=rollback/);

    writeFileSync(proofPath, `${proofBytes} `);
    const drifted = spawnSync(python, args, { cwd: root, encoding: 'utf8' });
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /does not match the CI-verified/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('rollback performs compatibility preflight and skips old schema application', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const compose = read('docker-compose.yml');

  assert.match(script, /VM217_DEPLOY_OPERATION:-deploy/);
  assert.match(script, /rollback\)[\s\S]*DEPLOY_MIGRATION_MODE="\$\{DEPLOY_MIGRATION_MODE:-skip\}"/);
  assert.match(script, /Rollback refuses to apply an older release schema/);
  assert.match(script, /npx prisma migrate diff/);
  assert.match(script, /--from-schema-datamodel=\/app\/packages\/db\/prisma\/schema\.prisma/);
  assert.match(script, /--to-url="\$MIGRATION_DATABASE_URL"/);
  assert.match(script, /python3 scripts\/verify-rollback-schema-compatibility\.py "\$diff_path"/);
  assert.match(script, /verify-raw-migration-rollback\.mjs/);
  assert.ok(script.indexOf('preflight_rollback_raw_migrations') < script.indexOf('compose_release up -d --no-build --pull never'));
  assert.match(script, /failed closed/);
  assert.match(script, /ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM/);
  assert.match(script, /ROLLBACK_SCHEMA_COMPATIBILITY_VERIFIED=true/);
  assert.match(compose, /DEPLOY_MIGRATION_MODE=\$\{DEPLOY_MIGRATION_MODE:-apply\}/);
  assert.match(compose, /skip\)[\s\S]*ROLLBACK_SCHEMA_COMPATIBILITY_VERIFIED/);
  assert.match(compose, /apply\)[\s\S]*exec node scripts\/apply-db-migrations\.mjs/);
  assert.doesNotMatch(script, /prisma db push/);
});

test('deploy delegates owner DDL exclusively to the migration service', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const compose = read('docker-compose.yml');
  const productionDeploy = script.slice(
    script.indexOf('run_production_release_deploy()'),
    script.indexOf('run_development_source_deploy()'),
  );
  const developmentDeploy = script.slice(
    script.indexOf('run_development_source_deploy()'),
    script.indexOf('case "$DEPLOY_SCOPE" in'),
  );

  assert.match(productionDeploy, /compose_release up -d --no-build --pull never/);
  assert.match(developmentDeploy, /migrate pgbouncer postgres/);
  assert.match(compose, /apply\)[\s\S]*exec node scripts\/apply-db-migrations\.mjs/);
  assert.doesNotMatch(script, /compose_release exec -T api/);
  assert.doesNotMatch(script, /docker compose[^\n]*exec -T api/);
  assert.doesNotMatch(script, /prisma db execute/);
  assert.doesNotMatch(script, /20260321_plan_definitions\.sql/);
});

test('rollback schema preflight allows compatible additive DDL and rejects write-breaking or unknown drift', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-rollback-schema-'));
  const diffPath = join(scratch, 'schema-diff.sql');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const run = (sql) => {
    writeFileSync(diffPath, sql);
    return spawnSync(python, ['scripts/verify-rollback-schema-compatibility.py', diffPath], {
      cwd: root,
      encoding: 'utf8',
    });
  };

  try {
    const exact = run('-- This is an empty migration.\n');
    assert.equal(exact.status, 0, `${exact.stdout}\n${exact.stderr}`);
    assert.match(exact.stdout, /policy=backward-compatible-additive/);

    const additive = run(`
      CREATE TYPE "AuditKind" AS ENUM ('created', 'updated');
      CREATE TABLE "AuditEvent" (
        "id" TEXT NOT NULL,
        "kind" "AuditKind" NOT NULL,
        CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX "AuditEvent_id_key" ON "AuditEvent"("id");
      ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_user_fkey" FOREIGN KEY ("id") REFERENCES "User"("id");
      ALTER TABLE "User"
        ADD COLUMN "nickname" TEXT,
        ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN "label" TEXT NOT NULL DEFAULT 'semi;colon';
      CREATE INDEX "User_nickname_idx" ON "User"("nickname");
    `);
    assert.equal(additive.status, 0, `${additive.stdout}\n${additive.stderr}`);
    assert.match(additive.stdout, /create_table=1/);
    assert.match(additive.stdout, /add_column_nullable=1/);
    assert.match(additive.stdout, /add_column_defaulted=2/);
    assert.match(additive.stdout, /create_index=1/);

    for (const sql of [
      'ALTER TABLE "User" ADD COLUMN "required" TEXT NOT NULL;\n',
      'ALTER TABLE "Shift" ADD CONSTRAINT "Shift_window_check" CHECK ("end" > "start");\n',
      'CREATE UNIQUE INDEX "User_email_key" ON "User"("email");\n',
      'ALTER TABLE "User" ALTER COLUMN "email" TYPE VARCHAR(64);\n',
      'DROP TABLE "User";\n',
      'VACUUM "User";\n',
    ]) {
      const rejected = run(sql);
      assert.notEqual(rejected.status, 0);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /failed closed/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('raw migration rollback policy requires exact approval and rejects trigger and RLS policy deltas', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-raw-migration-rollback-'));
  const migrationPath = 'packages/db/prisma/migrations/20990101_candidate.sql';
  const absoluteMigration = join(scratch, ...migrationPath.split('/'));
  const rollbackManifestPath = join(scratch, 'rollback.json');
  const candidateManifestPath = join(scratch, 'candidate.json');
  const policyPath = join(scratch, 'policy.json');
  const classifierPath = join(root, 'scripts/verify-rollback-schema-compatibility.py');
  const run = (sql, approved = true) => {
    mkdirSync(dirname(absoluteMigration), { recursive: true });
    writeFileSync(absoluteMigration, sql);
    const digest = createHash('sha256').update(sql).digest('hex');
    const contract = (files, rawMigrations) => ({ algorithm: 'sha256', files, rawMigrations: { version: 1, files: rawMigrations } });
    writeFileSync(rollbackManifestPath, JSON.stringify({ deploymentContract: contract({}, {}) }));
    writeFileSync(candidateManifestPath, JSON.stringify({ deploymentContract: contract({ [migrationPath]: digest }, { [migrationPath]: digest }) }));
    writeFileSync(policyPath, JSON.stringify({
      version: 1,
      compatibilityClass: 'backward-compatible-additive-v1',
      migrations: approved ? { [migrationPath]: { sha256: digest, compatibility: 'backward-compatible-additive-v1' } } : {},
    }));
    return spawnSync(process.execPath, [
      'scripts/verify-raw-migration-rollback.mjs',
      '--rollback-manifest', rollbackManifestPath,
      '--candidate-manifest', candidateManifestPath,
      '--candidate-root', scratch,
      '--policy', policyPath,
      '--classifier', classifierPath,
    ], { cwd: root, encoding: 'utf8' });
  };

  try {
    const safe = run('CREATE TABLE "NewAudit" ("id" TEXT NOT NULL, CONSTRAINT "NewAudit_pkey" PRIMARY KEY ("id"));\n');
    assert.equal(safe.status, 0, `${safe.stdout}\n${safe.stderr}`);
    assert.match(safe.stdout, /candidate_only=1/);

    const unapproved = run('CREATE TABLE "NewAudit" ("id" TEXT);\n', false);
    assert.notEqual(unapproved.status, 0);
    assert.match(unapproved.stderr, /lacks an exact additive approval or expand\/contract design/);

    for (const sql of [
      'CREATE TRIGGER "User_touch" BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION touch_user();\n',
      'CREATE POLICY "User_tenant" ON "User" USING (true);\n',
    ]) {
      const rejected = run(sql);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /destructive, trigger\/RLS-bearing, or unknown/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('release pointers advance only after retained proof and use staged atomic writes', () => {
  const script = read('scripts/deploy-vm217-remote.sh');
  const productionDeploy = script.slice(
    script.indexOf('run_production_release_deploy()'),
    script.indexOf('run_development_source_deploy()'),
  );

  assert.ok(productionDeploy.indexOf('write_post_deploy_proof') < productionDeploy.indexOf('stage_backup_release_pointer'));
  assert.ok(productionDeploy.indexOf('stage_backup_release_pointer') < productionDeploy.indexOf('verify-backup-readiness.sh'));
  assert.ok(productionDeploy.indexOf('verify-backup-readiness.sh') < productionDeploy.indexOf('commit_release_pointers'));
  assert.match(script, /mktemp "\$APP_DIR\/DEPLOYED_GIT_SHA\.tmp\.XXXXXX"/);
  assert.match(script, /mktemp "\$POST_DEPLOY_PROOF_DIR\/deploy-proof\.tmp\.XXXXXX"/);
  assert.match(script, /mv "\$proof_tmp" "\$proof_path"/);
  assert.match(script, /the staged backup release pointer will be restored/);
  assert.match(script, /trap cleanup_staged_backup_release_pointer EXIT/);
  assert.doesNotMatch(productionDeploy, /> DEPLOYED_GIT_SHA/);
});

test('fresh-runner DAST and load jobs pull every started third-party image before pull-never startup', () => {
  const ci = read('.github/workflows/ci.yml');
  const requiredPull = 'docker compose --env-file .env.smoke pull proxy pgbouncer postgres redis rabbitmq';
  const startup = 'docker compose --env-file .env.smoke up -d --no-build --pull never migrate proxy web api engine worker pgbouncer postgres redis rabbitmq';

  for (const [job, nextJob] of [['dast', 'e2e-tests'], ['load-test', 'validate-release-gates']]) {
    const block = ci.slice(ci.indexOf(`  ${job}:`), ci.indexOf(`  ${nextJob}:`));
    assert.ok(block.indexOf(requiredPull) !== -1, `${job} must pull third-party images`);
    assert.ok(block.indexOf(requiredPull) < block.indexOf(startup), `${job} must pull before startup`);
  }
});

test('production workflow carries the verified proof digest into deploy and smoke', () => {
  const ci = read('.github/workflows/ci.yml');

  assert.match(ci, /id: launch_proof/);
  assert.match(ci, /launch_proof_sha256="\$\(sha256sum "\$launch_proof"/);
  assert.match(ci, /LAUNCH_PROOF_ARTIFACT_SHA256=\$launch_proof_sha256/);
  assert.match(ci, /launch_proof_sha256: \$\{\{ steps\.launch_proof\.outputs\.sha256 \}\}/);
  assert.match(ci, /LAUNCH_PROOF_ARTIFACT_SHA256: \$\{\{ needs\.deploy-production\.outputs\.launch_proof_sha256 \}\}/);
  assert.match(ci, /--expected-launch-proof-sha256 "\$LAUNCH_PROOF_ARTIFACT_SHA256"/);
  assert.match(ci, /--max-proof-age-seconds "\$LAUNCH_PROOF_MAX_AGE_SECONDS"/);
  assert.match(ci, /PRODUCTION_API_HEALTH_URL: \$\{\{ vars\.PRODUCTION_API_HEALTH_URL \}\}/);
  assert.match(ci, /PRODUCTION_WEB_URL: \$\{\{ vars\.PRODUCTION_WEB_URL \}\}/);
  assert.match(ci, /LAUNCH_PROOF_MANIFEST_URI: \$\{\{ secrets\.LAUNCH_PROOF_MANIFEST_URI \}\}/);
  assert.match(ci, /test -n "\$PRODUCTION_API_HEALTH_URL"/);
  assert.match(ci, /test -n "\$PRODUCTION_WEB_URL"/);
  assert.match(ci, /test -n "\$LAUNCH_PROOF_MANIFEST_URI"/);
  assert.match(ci, /env \\\n\s+PRODUCTION_API_HEALTH_URL="\$PRODUCTION_API_HEALTH_URL" \\\n\s+PRODUCTION_WEB_URL="\$PRODUCTION_WEB_URL" \\\n\s+LAUNCH_PROOF_MANIFEST_URI="\$LAUNCH_PROOF_MANIFEST_URI" \\\n\s+bash \/tmp\/lunchlineup-deploy-production\.sh/);
  assert.doesNotMatch(ci, /run:.*\$\{\{ (?:vars\.PRODUCTION_(?:API_HEALTH|WEB)_URL|secrets\.LAUNCH_PROOF_MANIFEST_URI) \}\}/);
});
