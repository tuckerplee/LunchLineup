import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('Shift schema has the fields needed for database overlap enforcement', () => {
  const schema = read('packages/db/prisma/schema.prisma');

  assert.match(schema, /\bmodel Shift \{[\s\S]*?\btenantId\s+String/);
  assert.match(schema, /\bmodel Shift \{[\s\S]*?\buserId\s+String\?/);
  assert.match(schema, /\bmodel Shift \{[\s\S]*?\bstartTime\s+DateTime/);
  assert.match(schema, /\bmodel Shift \{[\s\S]*?\bendTime\s+DateTime/);
  assert.match(schema, /\bmodel Shift \{[\s\S]*?\bdeletedAt\s+DateTime\?/);
  assert.match(schema, /@@index\(\[tenantId, userId, deletedAt, startTime\]\)/);
});

test('shift overlap migration enforces active assigned shifts with a deferrable exclusion constraint', () => {
  const sql = read('packages/db/prisma/migrations/20260709_shift_overlap_constraints.sql');
  const legacyReconciliation = read(
    'packages/db/prisma/migrations/pre_20260717_legacy_shift_overlap_unassign.sql',
  );
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  for (const expected of [
    'CREATE EXTENSION IF NOT EXISTS btree_gist',
    'Cannot add Shift_window_valid',
    'Cannot add Shift_assigned_no_overlap',
    'CONSTRAINT "Shift_window_valid"',
    'CHECK ("endTime" > "startTime")',
    'CONSTRAINT "Shift_assigned_no_overlap"',
    'EXCLUDE USING gist',
    '"tenantId" WITH =',
    '"userId" WITH =',
    'tsrange("startTime", "endTime", \'[)\') WITH &&',
    'WHERE ("userId" IS NOT NULL AND "deletedAt" IS NULL)',
    'DEFERRABLE INITIALLY DEFERRED',
    'ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_window_valid"',
  ]) {
    assert.ok(sql.includes(expected), `missing shift overlap migration fragment: ${expected}`);
  }

  assert.match(sql, /s1\."startTime"\s+<\s+s2\."endTime"/);
  assert.match(sql, /s1\."endTime"\s+>\s+s2\."startTime"/);
  assert.match(sql, /s1\."deletedAt" IS NULL/);
  assert.match(sql, /s2\."deletedAt" IS NULL/);
  assert.match(migrationsReadme, /pre_20260717_legacy_shift_overlap_unassign\.sql/);

  for (const expected of [
    `to_regclass('public."Shift"') IS NULL`,
    'LOCK TABLE public."Shift" IN SHARE ROW EXCLUSIVE MODE',
    'LOCK TABLE public."TimeCard" IN SHARE MODE',
    'array_agg(DISTINCT conflict.shift_id ORDER BY conflict.shift_id)',
    `candidate."scheduleId" IS NOT NULL`,
    `candidate."locationId" NOT LIKE 'legacy-%'`,
    `candidate.role IS DISTINCT FROM 'STAFF'`,
    `candidate."endTime" - candidate."startTime" <> INTERVAL '8 hours'`,
    `candidate."createdAt" >= TIMESTAMP '2026-07-17 00:00:00'`,
    'a conflict has time-card history',
    '"userId" = NULL',
    'GET DIAGNOSTICS updated_count = ROW_COUNT',
    'left an assigned overlap',
    'did not clear every ambiguous assignment',
  ]) {
    assert.ok(
      legacyReconciliation.includes(expected),
      `missing legacy shift overlap reconciliation fragment: ${expected}`,
    );
  }

  assert.doesNotMatch(legacyReconciliation, /\b(?:DELETE|DROP|TRUNCATE)\b/i);
});

test('schedule integrity migration enforces windows, tenant FKs, and breaks at the database layer', () => {
  const sql = read('packages/db/prisma/migrations/20260709_schedule_integrity_constraints.sql');
  const legacyBreakReanchor = read(
    'packages/db/prisma/migrations/pre_20260717_legacy_break_window_reanchor.sql',
  );
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(migrationsReadme, /20260709_schedule_integrity_constraints\.sql/);
  assert.match(migrationsReadme, /pre_20260717_legacy_break_window_reanchor\.sql/);

  for (const expected of [
    'CREATE EXTENSION IF NOT EXISTS btree_gist',
    'CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_id_tenantId_locationId_key"',
    'Cannot add Schedule_window_valid',
    'Cannot add Schedule_no_overlap',
    'Cannot add Shift_userId_tenantId_fkey',
    'Cannot add Shift_scheduleId_tenantId_locationId_fkey',
    'Cannot add Break_window constraints',
    'Cannot add Break_no_overlap',
    'CONSTRAINT "Schedule_window_valid"',
    'CHECK ("endDate" > "startDate")',
    'CONSTRAINT "Schedule_no_overlap"',
    '"tenantId" WITH =',
    '"locationId" WITH =',
    'tsrange("startDate", "endDate", \'[)\') WITH &&',
    'WHERE ("deletedAt" IS NULL)',
    'DEFERRABLE INITIALLY DEFERRED',
    'CONSTRAINT "Shift_userId_tenantId_fkey"',
    'FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")',
    'CONSTRAINT "Shift_scheduleId_tenantId_locationId_fkey"',
    'FOREIGN KEY ("scheduleId", "tenantId", "locationId") REFERENCES "Schedule"("id", "tenantId", "locationId")',
    'CONSTRAINT "Break_window_valid"',
    'CHECK ("endTime" > "startTime")',
    'CONSTRAINT "Break_no_overlap"',
    '"shiftId" WITH =',
    'tsrange("startTime", "endTime", \'[)\') WITH &&',
    'CREATE CONSTRAINT TRIGGER "Break_within_shift_window"',
    'CREATE CONSTRAINT TRIGGER "Shift_break_windows"',
    'EXECUTE FUNCTION enforce_break_within_shift_window()',
    'EXECUTE FUNCTION enforce_shift_break_windows()',
    'ALTER TABLE "Schedule" VALIDATE CONSTRAINT "Schedule_window_valid"',
    'ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_userId_tenantId_fkey"',
    'ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_scheduleId_tenantId_locationId_fkey"',
    'ALTER TABLE "Break" VALIDATE CONSTRAINT "Break_window_valid"',
  ]) {
    assert.ok(sql.includes(expected), `missing schedule integrity migration fragment: ${expected}`);
  }

  assert.match(sql, /s1\."startDate"\s+<\s+s2\."endDate"/);
  assert.match(sql, /s1\."endDate"\s+>\s+s2\."startDate"/);
  assert.match(sql, /s1\."deletedAt" IS NULL/);
  assert.match(sql, /s2\."deletedAt" IS NULL/);
  assert.match(sql, /NEW\."startTime"\s+>=\s+s\."startTime"/);
  assert.match(sql, /NEW\."endTime"\s+<=\s+s\."endTime"/);
  assert.match(sql, /b\."startTime"\s+<\s+NEW\."startTime"/);
  assert.match(sql, /b\."endTime"\s+>\s+NEW\."endTime"/);

  for (const expected of [
    `to_regclass('public."Shift"') IS NULL`,
    `to_regclass('public."Break"') IS NULL`,
    'LOCK TABLE public."Shift" IN SHARE MODE',
    'LOCK TABLE public."Break" IN SHARE ROW EXCLUSIVE MODE',
    'paid_pattern = ARRAY[TRUE, FALSE, TRUE]',
    'duration_minutes = ARRAY[10, 30, 10]',
    'relative_start_minutes = ARRAY[0, 120, 270]',
    `shift_start + INTERVAL '120 minutes'`,
    'invalid break set does not match the supported historical pattern',
    'updated an unexpected number of rows',
    'left an invalid break window',
    'produced overlapping breaks',
  ]) {
    assert.ok(
      legacyBreakReanchor.includes(expected),
      `missing legacy break-window reconciliation fragment: ${expected}`,
    );
  }
  assert.match(
    legacyBreakReanchor,
    /SET\s+"startTime" = b\."startTime" \+ candidate\.reanchor_delta,\s+"endTime" = b\."endTime" \+ candidate\.reanchor_delta/,
  );

  const softDeleteSql = read('packages/db/prisma/migrations/20260709_zzzzz_schedule_soft_delete_overlap.sql');
  assert.match(migrationsReadme, /20260709_zzzzz_schedule_soft_delete_overlap\.sql/);
  assert.match(softDeleteSql, /DROP CONSTRAINT "Schedule_no_overlap"/);
  assert.match(softDeleteSql, /WHERE \("deletedAt" IS NULL\)/);
});
