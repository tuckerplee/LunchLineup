import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

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
  const migration = read('packages/db/prisma/migrations/20260709_zzzzzz_schedule_solve_credit_refunds.sql');

  for (const source of [worker, migration]) {
    assert.match(source, /schedule-credit-refund-/);
    assert.match(source, /INSERT INTO "CreditTransaction"/);
    assert.match(source, /ON CONFLICT \("id"\) DO NOTHING/);
    assert.match(source, /UPDATE "Tenant"/);
    assert.match(source, /"creditConsumption"->>'source' = 'credits'/);
  }
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
  assert.match(publisher, /WITH terminalized_job AS/);
  assert.match(publisher, /"status" = 'FAILED'/);
  assert.match(publisher, /"status" NOT IN \('SUCCEEDED', 'FAILED', 'DEAD_LETTERED'\)/);
  assert.match(publisher, /schedule-credit-refund-/);
  assert.match(publisher, /ON CONFLICT \("id"\) DO NOTHING/);
  assert.match(publisher, /FROM inserted_refund/);
});
