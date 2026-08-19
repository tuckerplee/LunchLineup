import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../packages/db/prisma/migrations/20260711_staff_availability_overnight.sql',
  import.meta.url,
);
const persistedInputsMigrationUrl = new URL(
  '../../packages/db/prisma/migrations/20260709_schedule_solve_persisted_inputs.sql',
  import.meta.url,
);
const availabilityExceptionsMigrationUrl = new URL(
  '../../packages/db/prisma/migrations/20260818_staff_availability_exceptions.sql',
  import.meta.url,
);
const prismaSchemaUrl = new URL('../../packages/db/prisma/schema.prisma', import.meta.url);
const migrationReadmeUrl = new URL('../../packages/db/prisma/migrations/README.md', import.meta.url);

test('historical raw replay accepts supported overnight availability', async () => {
  const sql = await readFile(persistedInputsMigrationUrl, 'utf8');

  assert.equal((sql.match(/"startTimeMinutes" (?:NOT )?BETWEEN 0 AND 1439/g) ?? []).length, 2);
  assert.equal((sql.match(/"endTimeMinutes" (?:NOT )?BETWEEN 0 AND 1439/g) ?? []).length, 2);
  assert.match(sql, /"startTimeMinutes" = "endTimeMinutes"/);
  assert.match(sql, /"startTimeMinutes" <> "endTimeMinutes"/);
  assert.doesNotMatch(sql, /"endTimeMinutes"s*<=s*"startTimeMinutes"/);
  assert.doesNotMatch(sql, /"endTimeMinutes"s*>=s*1440/);
});
test('forward migration permits overnight availability with minute-of-day endpoints', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /DROP CONSTRAINT IF EXISTS "StaffAvailability_time_window_valid"/);
  assert.match(sql, /"startTimeMinutes" BETWEEN 0 AND 1439/);
  assert.match(sql, /"endTimeMinutes" BETWEEN 0 AND 1439/);
  assert.match(sql, /"startTimeMinutes" <> "endTimeMinutes"/);
  assert.doesNotMatch(sql, /"endTimeMinutes"\s*>\s*"startTimeMinutes"/);
  assert.doesNotMatch(sql, /1440/);
  assert.match(sql, /VALIDATE CONSTRAINT "StaffAvailability_time_window_valid"/);
});

test('staff scheduling inputs remain tenant-isolated and relation-bound', async () => {
  const sql = await readFile(persistedInputsMigrationUrl, 'utf8');

  for (const table of ['StaffAvailability', 'StaffSkill']) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /CREATE POLICY staff_availability_isolation_policy[\s\S]*"tenantId" = \(SELECT get_current_tenant\(\)\)[\s\S]*WITH CHECK/);
  assert.match(sql, /CREATE POLICY staff_skill_isolation_policy[\s\S]*"tenantId" = \(SELECT get_current_tenant\(\)\)[\s\S]*WITH CHECK/);
  assert.match(sql, /StaffAvailability_userId_tenantId_fkey/);
  assert.match(sql, /StaffAvailability_locationId_tenantId_fkey/);
  assert.match(sql, /StaffSkill_userId_tenantId_fkey/);
});

test('dated availability exceptions are date-bound, tenant-isolated, and indexed by scope', async () => {
  const [sql, schema, readme] = await Promise.all([
    readFile(availabilityExceptionsMigrationUrl, 'utf8'),
    readFile(prismaSchemaUrl, 'utf8'),
    readFile(migrationReadmeUrl, 'utf8'),
  ]);

  assert.match(schema, /enum StaffAvailabilityExceptionKind\s*{\s*AVAILABLE\s*UNAVAILABLE\s*}/);
  assert.match(schema, /model StaffAvailabilityException\s*{[\s\S]*localDate\s+DateTime\s+@db\.Date/);
  assert.match(schema, /model StaffAvailabilityException\s*{[\s\S]*@@index\(\[tenantId, userId, localDate, startTimeMinutes\]\)/);
  assert.match(schema, /model StaffAvailabilityException\s*{[\s\S]*@@index\(\[tenantId, locationId, localDate, startTimeMinutes\]\)/);

  assert.match(sql, /"localDate" BETWEEN DATE '1970-01-01' AND DATE '2100-12-31'/);
  assert.match(sql, /"startTimeMinutes" BETWEEN 0 AND 1439/);
  assert.match(sql, /"endTimeMinutes" BETWEEN 1 AND 1440/);
  assert.match(sql, /"startTimeMinutes" < "endTimeMinutes"/);
  assert.match(sql, /COALESCE\("locationId", ''\)/);
  assert.match(sql, /ALTER TABLE "StaffAvailabilityException" ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE "StaffAvailabilityException" FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY staff_availability_exception_isolation_policy[\s\S]*"tenantId" = \(SELECT get_current_tenant\(\)\)[\s\S]*WITH CHECK/);
  assert.match(readme, /20260818_staff_availability_exceptions\.sql/);
});
