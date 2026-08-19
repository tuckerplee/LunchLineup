import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('API v2 public identifier expansion is safe for fresh and populated databases', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/pre_20260718_api_v2_public_ids.sql');
  const demandWindowSql = read(
    'packages/db/prisma/migrations/pre_20260718_api_v2_demand_window_public_ids.sql',
  );

  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  assert.match(sql, /to_regclass\(format\('%I\.%I', 'public', target_table\)\) IS NULL/);
  assert.match(sql, /CONTINUE/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "publicId" UUID/);
  assert.match(sql, /SET "publicId" = gen_random_uuid\(\) WHERE "publicId" IS NULL/);
  assert.match(sql, /ALTER COLUMN "publicId" SET NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS %I/);

  for (const model of ['User', 'Location', 'Schedule', 'Shift', 'ScheduleSolveJob']) {
    assert.match(sql, new RegExp(`'${model}'`));
    assert.match(
      schema,
      new RegExp(`model ${model} \\{[\\s\\S]*?publicId\\s+String\\s+@unique\\s+@default\\(dbgenerated\\(\"gen_random_uuid\\(\\)\"\\)\\)\\s+@db\\.Uuid`),
    );
  }

  for (const expected of [
    'to_regclass(\'public."ScheduleDemandWindow"\') IS NULL',
    'ADD COLUMN IF NOT EXISTS "publicId" UUID',
    'SET "publicId" = gen_random_uuid()',
    'ALTER COLUMN "publicId" SET DEFAULT gen_random_uuid()',
    'ALTER COLUMN "publicId" SET NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleDemandWindow_publicId_key"',
  ]) {
    assert.ok(demandWindowSql.includes(expected), `missing demand-window public identifier fragment: ${expected}`);
  }
  assert.match(
    schema,
    /model ScheduleDemandWindow \{[\s\S]*?publicId\s+String\s+@unique\s+@default\(dbgenerated\("gen_random_uuid\(\)"\)\)\s+@db\.Uuid/,
  );
});

test('shift schedule-window migration blocks writes from either side of the relation', () => {
  const sql = read('packages/db/prisma/migrations/20260709_shift_schedule_window_enforcement.sql');

  for (const expected of [
    'Cannot enforce Shift schedule windows',
    'CREATE CONSTRAINT TRIGGER "Shift_within_schedule_window"',
    'CREATE CONSTRAINT TRIGGER "Schedule_shift_windows"',
    'EXECUTE FUNCTION enforce_shift_within_schedule_window()',
    'EXECUTE FUNCTION enforce_schedule_shift_windows()',
    'NEW."startTime" >= schedule."startDate"',
    'NEW."endTime" <= schedule."endDate"',
    'DEFERRABLE INITIALLY DEFERRED',
  ]) {
    assert.ok(sql.includes(expected), `missing shift schedule-window fragment: ${expected}`);
  }
});

test('auto-schedule idempotency has schema and database uniqueness', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260709_schedule_solve_request_idempotency.sql');

  assert.match(schema, /model ScheduleSolveJob \{[\s\S]*?requestKeyHash\s+String/);
  assert.match(schema, /model ScheduleSolveJob \{[\s\S]*?requestHash\s+String/);
  assert.match(schema, /@@unique\(\[tenantId, scheduleId, requestKeyHash\]\)/);
  assert.match(sql, /ALTER COLUMN "requestKeyHash" SET NOT NULL/);
  assert.match(sql, /ALTER COLUMN "requestHash" SET NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleSolveJob_tenantId_scheduleId_requestKeyHash_key"/);
  assert.match(sql, /ON "ScheduleSolveJob"\("tenantId", "scheduleId", "requestKeyHash"\)/);

  const migrations = readdirSync(join(root, 'packages/db/prisma/migrations')).sort();
  assert.ok(
    migrations.indexOf('20260709_schedule_solve_jobs.sql')
      < migrations.indexOf('20260709_schedule_solve_request_idempotency.sql'),
    'request idempotency migration must run after ScheduleSolveJob creation',
  );
});

test('auto-schedule publication has a durable payload, bounded lease state, and due indexes', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260709_schedule_solve_publication_outbox.sql');
  const controller = read('apps/api/src/schedules/schedules.controller.ts');

  for (const field of ['queuePayload', 'publicationStatus', 'publishAttempts', 'nextPublishAt', 'publishLeaseUntil', 'publishedAt']) {
    assert.match(schema, new RegExp(`model ScheduleSolveJob \\{[\\s\\S]*?${field}\\s+`));
    assert.match(sql, new RegExp(`"${field}"`));
  }
  assert.match(sql, /CHECK \("publicationStatus" IN \('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED'\)\)/);
  assert.match(sql, /WHERE "publicationStatus" IN \('PENDING', 'FAILED'\)/);
  assert.match(sql, /WHERE "publicationStatus" = 'PUBLISHING'/);
  assert.ok(controller.indexOf('createScheduleSolveJob') < controller.indexOf('reserveAutoScheduleCredit'));
  assert.ok(controller.indexOf('reserveAutoScheduleCredit') < controller.indexOf('recordScheduleSolveJobCreditConsumptionInTransaction'));
});

test('confirmed incomplete schedule publications are age-leased for broker-loss recovery', () => {
  const migration = read('packages/db/prisma/migrations/20260709_zz_broker_loss_outbox_recovery.sql');
  const publisher = read('apps/api/src/schedules/schedule-solve-outbox.publisher.ts');

  assert.match(migration, /"ScheduleSolveJob_confirmed_incomplete_idx"/);
  assert.match(migration, /"publicationStatus" = 'PUBLISHED'/);
  assert.match(migration, /"status" IN \('QUEUED', 'RUNNING', 'RETRYING'\)/);
  assert.match(publisher, /SCHEDULE_OUTBOX_CONFIRMED_RECOVERY_AGE_MS/);
  assert.match(publisher, /"publishedAt" <= \$\{confirmedBefore\}/);
  assert.match(publisher, /"updatedAt" <= \$\{confirmedBefore\}/);
  assert.match(publisher, /jsonb_set\(job\."queuePayload", '\{retry_count\}'/);
});

test('terminal schedule solve failures refund consumed wallet credits exactly once', () => {
  const worker = read('apps/worker/main.py');
  const migration = read('packages/db/prisma/migrations/20260709_yyyyyy_schedule_solve_credit_refund_provenance_guard.sql');

  for (const source of [worker, migration]) {
    assert.match(source, /schedule-credit-refund-/);
    assert.match(source, /schedule-credit-/);
    assert.match(source, /"creditConsumption"->>'source' = 'credits'/);
    assert.match(source, /debit\."amount"/);
  }
  assert.match(migration, /INSERT INTO "CreditTransaction"/);
  assert.match(migration, /UPDATE "Tenant"/);
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.match(worker, /public\.settle_positive_credit_value/);
  assert.match(worker, /debit\."debtAmount" = 0/);
  assert.match(worker, /FOR UPDATE/);
  assert.match(worker, /\(SELECT COUNT\(\*\) FROM refund_rows\) = 0/);
  assert.match(worker, /job\."status" NOT IN \('SUCCEEDED', 'FAILED', 'DEAD_LETTERED'\)/);
  assert.match(worker, /FROM settled_refund/);
  assert.match(worker, /status in \{"FAILED", "DEAD_LETTERED"\}/);
});

test('permanent schedule publication failure terminalizes and refunds atomically', () => {
  const publisher = read('apps/api/src/schedules/schedule-solve-outbox.publisher.ts');
  const envExample = read('.env.example');
  const compose = read('docker-compose.yml');

  for (const setting of ['SCHEDULE_OUTBOX_MAX_PUBLISH_ATTEMPTS', 'SCHEDULE_OUTBOX_MAX_PUBLICATION_AGE_MS']) {
    assert.match(envExample, new RegExp(`^${setting}=`, 'm'));
    assert.match(compose, new RegExp(setting));
    assert.match(publisher, new RegExp(setting));
  }
  assert.match(publisher, /WITH locked_job AS MATERIALIZED/);
  assert.match(publisher, /debit\."amount" = -job\."configuredAmount"/);
  assert.match(publisher, /-provenance\."debitAmount"/);
  assert.match(publisher, /"status" = 'FAILED'/);
  assert.match(publisher, /"status" NOT IN \('SUCCEEDED', 'FAILED', 'DEAD_LETTERED'\)/);
  assert.match(publisher, /schedule-credit-refund-/);
  assert.match(publisher, /public\.settle_positive_credit_value/);
  assert.match(publisher, /debit\."debtAmount" = 0/);
  assert.match(publisher, /FROM settled_refund/);
  assert.doesNotMatch(publisher, /FROM inserted_refund/);
});

test('malformed schedule paths remain nonterminal until exact authoritative settlement succeeds', () => {
  const publisher = read('apps/api/src/schedules/schedule-solve-outbox.publisher.ts');
  const worker = read('apps/worker/main.py');

  const invalidPublisherStart = publisher.indexOf('for (const candidate of invalidCandidates)');
  const invalidPublisherEnd = publisher.indexOf('if (validCandidates.length === 0)', invalidPublisherStart);
  assert.ok(invalidPublisherStart >= 0 && invalidPublisherEnd > invalidPublisherStart);
  const invalidPublisherBlock = publisher.slice(invalidPublisherStart, invalidPublisherEnd);
  assert.match(invalidPublisherBlock, /"publicationStatus" = 'FAILED'/);
  assert.match(invalidPublisherBlock, /"nextPublishAt" =/);
  assert.doesNotMatch(invalidPublisherBlock, /"status" = 'DEAD_LETTERED'/);
  assert.doesNotMatch(invalidPublisherBlock, /"executionToken" = NULL/);
  assert.doesNotMatch(invalidPublisherBlock, /"executionLeaseUntil" = NULL/);

  const claimStart = worker.indexOf('def _claim_schedule_solve_job_sync(');
  const claimEnd = worker.indexOf('async def try_mark_schedule_solve_job_status(', claimStart);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  const claimBlock = worker.slice(claimStart, claimEnd);
  assert.match(claimBlock, /error_type=ScheduleCreditProvenanceError/);
  assert.doesNotMatch(claimBlock, /"status" = 'DEAD_LETTERED'/);
  assert.doesNotMatch(claimBlock, /"executionToken" = NULL/);

  const authoritativeStart = worker.indexOf('def _terminalize_schedule_solve_job_by_id_sync(');
  const authoritativeEnd = worker.indexOf('def _update_schedule_solve_job_status_sync(', authoritativeStart);
  assert.ok(authoritativeStart >= 0 && authoritativeEnd > authoritativeStart);
  const authoritativeBlock = worker.slice(authoritativeStart, authoritativeEnd);
  assert.match(authoritativeBlock, /set_current_platform_admin/);
  assert.match(authoritativeBlock, /SELECT "tenantId", "scheduleId", "locationId"/);
  assert.match(authoritativeBlock, /lock_tenant_status/);
  assert.match(authoritativeBlock, /_terminalize_schedule_solve_job_with_refund/);
  assert.ok(authoritativeBlock.indexOf('lock_tenant_status') < authoritativeBlock.indexOf('_terminalize_schedule_solve_job_with_refund'));
  assert.match(worker, /read_malformed_schedule_job_id\(message\.body\)[\s\S]*terminalize_schedule_solve_job_by_id/);
});

test('schedule solve execution uses a durable single-owner lease', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const migration = read('packages/db/prisma/migrations/20260713_schedule_solve_execution_lease.sql');
  const worker = read('apps/worker/main.py');

  assert.match(schema, /executionToken\s+String\?/);
  assert.match(schema, /executionLeaseUntil\s+DateTime\?/);
  assert.match(migration, /ScheduleSolveJob_execution_owner_pair_check/);
  assert.match(migration, /ScheduleSolveJob_executionLeaseUntil_idx/);
  assert.match(worker, /"executionLeaseUntil" > CURRENT_TIMESTAMP/);
  assert.match(worker, /"executionToken" = %s/);
  assert.match(worker, /ScheduleJobBusyError/);
  assert.match(worker, /ScheduleJobOwnershipLostError/);
});

test('terminal schedule solve rows erase queue payloads and execution claims', () => {
  const migration = read('packages/db/prisma/migrations/20260713_schedule_solve_execution_lease.sql');

  assert.match(migration, /scrub_terminal_schedule_solve_payload/);
  assert.match(migration, /ScheduleSolveJob_terminal_payload_erasure/);
  assert.match(migration, /ScheduleSolveJob_terminal_payload_erased_check/);
  assert.match(migration, /"status" IN \('SUCCEEDED', 'FAILED', 'DEAD_LETTERED'\)/);
  for (const field of [
    'queuePayload',
    'publishLeaseUntil',
    'publishLastError',
    'executionToken',
    'executionLeaseUntil',
  ]) {
    assert.match(migration, new RegExp(`NEW\\."${field}" := NULL`));
    assert.match(migration, new RegExp(`"${field}" IS NULL`));
  }
});
