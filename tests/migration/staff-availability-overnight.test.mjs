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
