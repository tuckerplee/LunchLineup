import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { buildLegacyFixture, FIXTURE_STORE_TIMEZONES, FIXTURE_TIMEZONE } from '../fixtures/legacy-mysql-fixture.mjs';
import { buildLegacyImportPlan } from '../../scripts/legacy-import-plan.mjs';
import { executeLegacyImport, readLegacyImportReport } from '../../scripts/legacy-import-executor.mjs';
import { legacyImportReportCsv } from '../../scripts/legacy-import-report.mjs';
import { deterministicId } from '../../scripts/legacy-import-v2.mjs';
import { main as exportMain, openSnapshot } from '../../scripts/export-legacy-mysql.mjs';

// Full rehearsal of the production cutover path on throwaway containers:
//   synthetic legacy MariaDB  ->  scripts/export-legacy-mysql.mjs  ->  legacy-combined-v2 JSON
//   ->  fresh migrated PostgreSQL (scripts/apply-db-migrations.mjs)  ->  executeLegacyImport.
// Needs Docker and the exporter dependency (cd scripts/legacy-export && npm ci).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MARIADB_IMAGE = 'mariadb@sha256:1292844148b311e4ed4300022a996d39083f415a963e970cf47cad1b3b18e3a6'; // 11.4
// LEGACY_ROUNDTRIP_MYSQL_IMAGE=mysql:8.4 repeats the rehearsal against MySQL instead of the pinned MariaDB.
const LEGACY_IMAGE = process.env.LEGACY_ROUNDTRIP_MYSQL_IMAGE || MARIADB_IMAGE;
const FLAVOR = LEGACY_IMAGE.replace(/^docker\.io\/library\//, '').startsWith('mysql') ? 'mysql' : 'mariadb';
const POSTGRES_IMAGE = 'postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function docker(args, { input, allowFailure = false, timeout = 120_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result;
}
function skipReason() {
  if (docker(['version', '--format', '{{.Server.Version}}'], { allowFailure: true, timeout: 20_000 }).status !== 0) return 'Docker is not available';
  try { createRequire(path.join(root, 'scripts/legacy-export/package.json'))('mysql2/promise'); } catch { return 'exporter dependency missing: run (cd scripts/legacy-export && npm ci)'; }
  return false;
}
async function waitFor(label, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (probe()) return; await new Promise((resolve) => setTimeout(resolve, 750)); }
  throw new Error(`${label} did not become ready`);
}
const hostPort = (container, port) => Number(docker(['port', container, `${port}/tcp`]).stdout.trim().split('\n')[0].split(':').pop());

test('legacy MariaDB -> exporter -> fresh PostgreSQL import preserves data, semantics and idempotency', { skip: skipReason(), timeout: 900_000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const mariaName = `ll-legacy-mariadb-${suffix}`;
  const pgName = `ll-legacy-pg-${suffix}`;
  const mariaRoot = randomBytes(12).toString('hex');
  const exportPassword = randomBytes(12).toString('hex');
  const pgPassword = randomBytes(12).toString('hex');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'll-legacy-roundtrip-'));
  const appKey = randomBytes(32);
  const { sql: fixtureSql, golden } = buildLegacyFixture({ appKey });
  let prisma;
  t.after(async () => {
    try { await prisma?.$disconnect(); } catch { /* best effort */ }
    docker(['rm', '-f', '-v', mariaName, pgName], { allowFailure: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
  const maria = (sqlText, { user = 'root', password = mariaRoot, database = 'legacy' } = {}) => docker(['exec', '-i', mariaName, FLAVOR, `-u${user}`, `-p${password}`, '-h127.0.0.1', '-N', database], { input: sqlText });
  const mysqlScalar = (sqlText) => Number(maria(sqlText).stdout.trim());
  const pg = (sqlText) => docker(['exec', '-i', pgName, 'psql', '-U', 'postgres', '-d', 'lunchlineup', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'], { input: sqlText }).stdout.trim();
  const pgNumber = (sqlText) => Number(pg(sqlText));

  await t.test('start throwaway MariaDB and PostgreSQL', async () => {
    const prefix = FLAVOR === 'mysql' ? 'MYSQL' : 'MARIADB';
    docker(['run', '-d', '--name', mariaName, '-e', `${prefix}_ROOT_PASSWORD=${mariaRoot}`, '-e', `${prefix}_DATABASE=legacy`, '-p', '127.0.0.1::3306', LEGACY_IMAGE], { timeout: 300_000 });
    docker(['run', '-d', '--name', pgName, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=lunchlineup', '-p', '127.0.0.1::5432', POSTGRES_IMAGE], { timeout: 300_000 });
    await waitFor('MariaDB', () => docker(['exec', mariaName, FLAVOR, '-uroot', `-p${mariaRoot}`, '-h127.0.0.1', '-e', 'SELECT 1'], { allowFailure: true }).status === 0);
    await waitFor('PostgreSQL', () => docker(['exec', pgName, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-d', 'lunchlineup', '-c', 'SELECT 1'], { allowFailure: true }).status === 0);
  });

  await t.test('legacy schema + synthetic fixture load into MariaDB', () => {
    maria(fs.readFileSync(path.join(root, 'old/scripts/schema.sql'), 'utf8'));
    maria(fixtureSql);
    maria(`CREATE USER 'll_export'@'%' IDENTIFIED BY '${exportPassword}'; GRANT SELECT ON legacy.* TO 'll_export'@'%';`);
    for (const [table, expected] of [['companies', golden.counts.companies], ['stores', golden.counts.stores], ['users', golden.counts.users], ['staff', golden.counts.staff], ['shifts', golden.counts.shifts], ['audit_logs', golden.counts.auditLogs], ['mail_queue', golden.counts.mailQueue]]) {
      assert.equal(mysqlScalar(`SELECT COUNT(*) FROM ${table}`), expected, table);
    }
    assert.ok(golden.counts.shifts > 900, 'several weeks of shifts');
  });

  const mariaPort = hostPort(mariaName, 3306);
  const exportEnv = { LEGACY_MYSQL_PASSWORD: exportPassword, LEGACY_APP_KEY: appKey.toString('base64') };
  const connection = { host: '127.0.0.1', port: mariaPort, user: 'll_export', database: 'legacy' };

  await t.test('exporter reads one REPEATABLE READ / READ ONLY consistent snapshot and issues only SELECT', async () => {
    assert.throws(() => maria('INSERT INTO companies (name) VALUES (\'x\')', { user: 'll_export', password: exportPassword }), /denied|failed/i); // the export account cannot write
    const snapshot = await openSnapshot(connection, exportEnv);
    try {
      const before = await snapshot.select('SELECT COUNT(*) AS n FROM shifts');
      const flags = await snapshot.select(FLAVOR === 'mysql' ? 'SELECT @@session.transaction_read_only AS ro, @@session.transaction_isolation AS iso' : 'SELECT @@session.tx_read_only AS ro, @@session.tx_isolation AS iso');
      assert.equal(Number(flags[0].ro), 1);
      assert.equal(flags[0].iso, 'REPEATABLE-READ');
      maria('INSERT INTO shifts (staff_id, store_id, date, shift_hours) VALUES (NULL, 1, \'2026-04-01\', \'9:00 AM-5:00 PM\')'); // concurrent writer
      const after = await snapshot.select('SELECT COUNT(*) AS n FROM shifts');
      assert.equal(Number(after[0].n), Number(before[0].n), 'snapshot must not see rows committed after it started');
      await assert.rejects(snapshot.select('DELETE FROM shifts'), /non-SELECT/);
      await assert.rejects(snapshot.select('SELECT 1; DELETE FROM shifts'), /non-SELECT/);
    } finally { await snapshot.close(); }
    maria('DELETE FROM shifts WHERE date = \'2026-04-01\' AND staff_id IS NULL AND shift_hours = \'9:00 AM-5:00 PM\' AND store_id = 1 ORDER BY id DESC LIMIT 1'); // remove the probe row again
    assert.equal(mysqlScalar('SELECT COUNT(*) FROM shifts'), golden.counts.shifts);
  });

  const pgPort = hostPort(pgName, 5432);
  const ownerUrl = `postgresql://postgres:${pgPassword}@127.0.0.1:${pgPort}/lunchlineup`;
  await t.test('apply every migration to a fresh PostgreSQL (scripts/apply-db-migrations.mjs)', () => {
    const appPassword = randomBytes(10).toString('hex');
    const result = spawnSync(process.execPath, ['scripts/apply-db-migrations.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 300_000, windowsHide: true,
      env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: `postgresql://ll_app_roundtrip:${appPassword}@127.0.0.1:${pgPort}/lunchlineup`, APP_DB_USER: 'll_app_roundtrip', APP_DB_PASSWORD: appPassword, POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: pgPassword, PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'legacy-roundtrip-capability-secret-0001', WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', DATA_TARGET_ENV: 'test', NODE_ENV: 'test' },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-2000));
    assert.equal(pgNumber('SELECT count(*) FROM legacy_import.target_generation'), 1);
    assert.equal(pgNumber('SELECT count(*) FROM "Tenant"'), 0);
  });

  const generation = () => pg('SELECT generation_uuid FROM legacy_import.target_generation');
  const exportPath = path.join(work, 'export.json');
  const descriptorPath = path.join(work, 'descriptor.json');
  let summary; let plan; let report;
  await t.test('export legacy-combined-v2 JSON and a reviewable descriptor without printing personal data', async () => {
    summary = await exportMain(['--host', '127.0.0.1', '--port', String(mariaPort), '--user', 'll_export', '--database', 'legacy', '--out', exportPath, '--descriptor-out', descriptorPath, '--namespace', 'roundtrip-cutover-v1', '--target-generation', generation(), '--timezone', FIXTURE_TIMEZONE, '--store-timezone', `5=${FIXTURE_STORE_TIMEZONES[5]}`], exportEnv);
    assert.equal(summary.counts.shifts, golden.counts.shifts);
    assert.equal(summary.counts.users, golden.counts.users);
    assert.deepEqual(summary.integrity, { usernameHashChecked: 30, usernameHashMismatched: 0, staffNamesLookingEncrypted: 0, staffWithoutCompany: 0 });
    assert.deepEqual(summary.skippedTables, { audit_logs: 3, mail_queue: 2, password_resets: 1, login_attempts: 1, roles: 6, role_permissions: 0 });
    const printed = JSON.stringify(summary);
    for (const person of ['Whitfield', '@alder.example', 'Pat Lee', 'Coincidence']) assert.equal(printed.includes(person), false);
    assert.equal(sha(fs.readFileSync(exportPath)), summary.sourceSha256);
    if (process.platform !== 'win32') assert.equal(fs.statSync(exportPath).mode & 0o777, 0o600);
    await assert.rejects(exportMain(['--host', '127.0.0.1', '--port', String(mariaPort), '--user', 'll_export', '--database', 'legacy', '--out', exportPath], exportEnv), /EEXIST|exists/); // never overwrites
    await assert.rejects(exportMain(['--host', '127.0.0.1', '--port', String(mariaPort), '--user', 'll_export', '--database', 'legacy', '--out', path.join(work, 'wrong-key.json')], { ...exportEnv, LEGACY_APP_KEY: randomBytes(32).toString('base64') }), /Username integrity check failed/);
    assert.equal(fs.existsSync(path.join(work, 'wrong-key.json')), false);
  });

  const exportBytes = () => fs.readFileSync(exportPath);
  const descriptorBytes = () => fs.readFileSync(descriptorPath);
  const buildPlan = () => buildLegacyImportPlan(exportBytes(), descriptorBytes(), { expectedDescriptorSha256: sha(descriptorBytes()), expectedSourceSha256: sha(exportBytes()) });
  const namespace = 'roundtrip-cutover-v1';
  const counts = () => pg(`SELECT (SELECT count(*) FROM "Tenant"), (SELECT count(*) FROM "Location"), (SELECT count(*) FROM "User"), (SELECT count(*) FROM "RoleAssignment"), (SELECT count(*) FROM "Schedule"), (SELECT count(*) FROM "Shift"), (SELECT count(*) FROM "Break"), (SELECT count(*) FROM "StaffSkill"), (SELECT count(*) FROM "TenantSetting")`);

  await t.test('import into the fresh PostgreSQL', async () => {
    plan = buildPlan();
    assert.deepEqual(plan.counts, { company: 3, location: 5, user: 30, staff: 13 });
    prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    report = await executeLegacyImport(plan, { db: prisma });
    assert.deepEqual(report.counts, plan.counts);
    assert.equal(pg('SELECT status FROM legacy_import.run'), 'COMPLETE');
    for (const company of report.data.companies) assert.deepEqual(company.present, company.planned);
    assert.match(legacyImportReportCsv(report).split('\n')[0], /^sourceType,legacyId,companyId/);
  });

  const tenantOf = (legacyCompany) => report.companies.find((entry) => entry.companyId === String(legacyCompany)).tenantId;
  const entity = (type, legacyId, companyId) => pg(`SELECT target_id FROM legacy_import.entity WHERE namespace = '${namespace}' AND company_id = ${companyId} AND source_type = '${type}' AND legacy_id = ${legacyId}`);
  const shiftIdOf = (label) => deterministicId(namespace, tenantOf(1), 'shift', golden.shiftsByLabel[label]);
  const shiftIdIn = (label, companyId) => deterministicId(namespace, tenantOf(companyId), 'shift', golden.shiftsByLabel[label]);
  const shiftRow = (id) => pg(`SELECT to_char("startTime", 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'), to_char("endTime", 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'), coalesce("userId", ''), coalesce(role, ''), replace(coalesce(notes, ''), chr(10), ' / ') FROM "Shift" WHERE id = '${id}'`).split('|');
  const breaksOf = (id) => pg(`SELECT type, paid, to_char("startTime", 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), to_char("endTime", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM "Break" WHERE "shiftId" = '${id}' ORDER BY "startTime"`).split('\n').filter(Boolean).map((line) => line.split('|'));

  await t.test('row counts reconcile MariaDB -> export -> PostgreSQL', () => {
    const droppedShifts = 2; // unparseable hours + exact duplicate; the overlapping shift is kept unassigned
    const mysqlBreakEntries = mysqlScalar(`SELECT SUM(CASE WHEN breaks IS NOT NULL AND JSON_LENGTH(breaks) > 0 THEN JSON_LENGTH(breaks) ELSE (COALESCE(break1,'') <> '') + (COALESCE(lunch,'') <> '') + (COALESCE(break2,'') <> '') END) FROM shifts WHERE shift_hours <> 'OFF'`);
    const [tenants, locations, users, roleAssignments, schedules, shifts, breaks, skills, settings] = counts().split('|').map(Number);
    assert.equal(tenants, mysqlScalar('SELECT COUNT(*) FROM companies'));
    assert.equal(locations, mysqlScalar('SELECT COUNT(*) FROM stores'));
    assert.equal(users, mysqlScalar('SELECT COUNT(*) FROM users') + 13); // 13 staff rows are not login users and are not linked to one
    assert.equal(users, golden.counts.users + golden.staffOnly);
    assert.equal(roleAssignments, users);
    assert.equal(shifts, mysqlScalar('SELECT COUNT(*) FROM shifts') - droppedShifts);
    assert.equal(breaks, mysqlBreakEntries - 1); // exactly one break (11 PM on a 9-5 shift) lies outside its shift
    assert.equal(schedules, 25); // 5 stores x 5 weeks
    assert.equal(skills, plan.data.summary.skills);
    assert.equal(settings, plan.data.companies.reduce((sum, company) => sum + company.documents.length + 1, 0));
    assert.equal(pgNumber('SELECT count(*) FROM "Shift" WHERE "userId" IS NULL'), 2); // open shift + overlap leftover
    assert.deepEqual(plan.data.summary.shiftsSkipped, { shift_hours_unparseable: 1, shift_overlap_unassigned: 1, shift_exact_duplicate_dropped: 1 });
    assert.deepEqual(plan.data.summary.breaksSkipped, { break_outside_shift: 1 });
    assert.equal(pgNumber('SELECT count(*) FROM "Location" WHERE timezone = \'America/Los_Angeles\''), 1);
    assert.equal(pgNumber(`SELECT count(*) FROM "Location" WHERE timezone = '${FIXTURE_TIMEZONE}'`), 4);
    assert.equal(pgNumber('SELECT count(*) FROM "Shift" s JOIN "Schedule" sc ON sc.id = s."scheduleId" WHERE s."startTime" < sc."startDate" OR s."startTime" >= sc."endDate"'), 0);
    assert.equal(pgNumber('SELECT count(*) FROM "Break" b JOIN "Shift" s ON s.id = b."shiftId" WHERE b."startTime" < s."startTime" OR b."endTime" > s."endTime"'), 0);
  });

  await t.test('roles, names, linkage and credentials', async () => {
    assert.equal(pg('SELECT role, count(*) FROM "User" GROUP BY role ORDER BY role'), 'ADMIN|4\nMANAGER|4\nSTAFF|35');
    // login hash preserved bit-for-bit and still verifies with the original password
    const legacyHash = maria('SELECT password_hash FROM users WHERE id = 9').stdout.trim();
    const imported = pg(`SELECT "passwordHash", "pinResetRequired", email, name FROM "User" WHERE id = '${entity('user', 9, 1)}'`).split('|');
    assert.equal(imported[0], legacyHash);
    assert.equal(imported[1], 'f');
    assert.equal(imported[2], `${golden.userNames[9].replace(' ', '.')}@alder.example`.toLowerCase());
    assert.equal(imported[3], golden.userNames[9]); // the linked staff row supplies the display name
    assert.equal(await bcrypt.compare(golden.passwords[9], imported[0].replace(/^\$2y\$/, '$2a$')), true); // same normalisation the login verifier applies
    assert.equal(await bcrypt.compare('wrong-password', imported[0].replace(/^\$2y\$/, '$2a$')), false);
    // unsupported formats: no hash, forced PIN reset, counted by reason only
    for (const legacyId of [27, 28, 29, 30]) {
      const row = pg(`SELECT "passwordHash" IS NULL, "pinResetRequired" FROM "User" WHERE id = '${entity('user', legacyId, plan.accounts.find((a) => a.sourceType === 'user' && a.id === String(legacyId)).companyId)}'`);
      assert.equal(row, 't|t', `user ${legacyId}`);
    }
    assert.equal(pgNumber('SELECT count(*) FROM "User" WHERE "pinResetRequired"'), 4);
    assert.deepEqual(plan.data.summary.credentials, { preserved: 26, pinResetRequired: 4, reasons: { argon2: 1, unsalted_hex_digest: 1, bcrypt_cost_out_of_range: 1, unrecognized_format: 1 } });
    // legacy roles: super_admin/company_admin -> ADMIN, 'schedule' -> MANAGER, store-only viewers -> STAFF
    assert.equal(pg(`SELECT role FROM "User" WHERE id = '${entity('user', 1, 1)}'`), 'ADMIN');
    assert.equal(pg(`SELECT role FROM "User" WHERE id = '${entity('user', 6, 1)}'`), 'MANAGER');
    assert.equal(pg(`SELECT role FROM "User" WHERE id = '${entity('user', 25, 1)}'`), 'STAFF');
    // staff-only people and the coincidental staff id stay separate accounts
    assert.equal(pg(`SELECT name FROM "User" WHERE id = '${entity('staff', 6, 1)}'`), 'Coincidence Casey');
    assert.notEqual(entity('staff', 6, 1), entity('user', 6, 1));
    assert.equal(pgNumber(`SELECT count(*) FROM "User" WHERE name = 'Pat Lee' AND "tenantId" = '${tenantOf(1)}'`), 2);
    assert.equal(pg(`SELECT string_agg(username, ',' ORDER BY username) FROM "User" WHERE name = 'Pat Lee'`), 'pat.lee,pat.lee.2');
    assert.equal(pgNumber(`SELECT count(*) FROM "User" WHERE name = '${golden.userNames[9]}' AND "tenantId" = '${tenantOf(1)}'`), 1); // user 9 + staff 9 are one person
    assert.equal(pg(`SELECT r.slug FROM "RoleAssignment" ra JOIN "Role" r ON r.id = ra."roleId" WHERE ra."userId" = '${entity('user', 6, 1)}'`), 'manager');
  });

  await t.test('shift times, timezone and break placement', () => {
    const user9 = entity('user', 9, 1);
    // Chicago: CST (UTC-6) before 2026-03-08, CDT (UTC-5) after
    assert.deepEqual(shiftRow(shiftIdOf('springForwardBefore')), ['2026-03-06T14:00:00.000Z', '2026-03-06T22:00:00.000Z', user9, 'Cashier', '']);
    assert.deepEqual(shiftRow(shiftIdOf('springForwardAfter')), ['2026-03-09T13:00:00.000Z', '2026-03-09T21:00:00.000Z', user9, 'Cashier', 'Tasks: Open register, 7 / Sign-off: Avery']);
    assert.deepEqual(breaksOf(shiftIdOf('springForwardAfter')), [['BREAK1', 't', '2026-03-09T15:00:00Z', '2026-03-09T15:10:00Z'], ['LUNCH', 'f', '2026-03-09T17:00:00Z', '2026-03-09T17:30:00Z'], ['BREAK2', 't', '2026-03-09T19:00:00Z', '2026-03-09T19:10:00Z']]);
    // 10 PM Sat CST -> 6 AM Sun CDT across the transition; breaks after midnight land on the next calendar day
    assert.deepEqual(shiftRow(shiftIdOf('overnightAcrossDst')).slice(0, 2), ['2026-03-08T04:00:00.000Z', '2026-03-08T11:00:00.000Z']);
    assert.deepEqual(breaksOf(shiftIdOf('overnightAcrossDst')), [['BREAK1', 't', '2026-03-08T06:15:00Z', '2026-03-08T06:25:00Z'], ['LUNCH', 'f', '2026-03-08T07:30:00Z', '2026-03-08T08:00:00Z'], ['BREAK2', 't', '2026-03-08T09:00:00Z', '2026-03-08T09:10:00Z']]);
    // store 5 uses the descriptor's America/Los_Angeles override (PDT, UTC-7), legacy columns instead of JSON
    assert.deepEqual(shiftRow(shiftIdIn('pacificStore', 3)).slice(0, 2), ['2026-03-10T16:00:00.000Z', '2026-03-11T00:00:00.000Z']);
    assert.deepEqual(breaksOf(shiftIdIn('pacificStore', 3)).map((row) => row[0]), ['BREAK1', 'LUNCH', 'BREAK2']);
    // a lone lunch column stays a LUNCH and stays unpaid
    assert.deepEqual(breaksOf(shiftIdOf('lunchColumnOnly')), [['LUNCH', 'f', '2026-03-13T17:30:00Z', '2026-03-13T18:15:00Z']]);
    // a break outside its shift is dropped, the valid one is kept
    assert.deepEqual(breaksOf(shiftIdOf('breakOutsideShift')).map((row) => row[0]), ['BREAK1']);
    // overlap -> unassigned with an explanation; duplicate and unparseable rows absent; open shift unassigned
    assert.equal(shiftRow(shiftIdOf('overlapKept'))[2], entity('user', 11, 1));
    const overlap = shiftRow(shiftIdOf('overlapUnassigned'));
    assert.equal(overlap[2], '');
    assert.match(overlap[4], /Imported unassigned: overlapped another shift/);
    assert.equal(pgNumber(`SELECT count(*) FROM "Shift" WHERE id IN ('${shiftIdOf('duplicateDropped')}', '${shiftIdOf('unparseableHours')}')`), 0);
    assert.equal(pgNumber(`SELECT count(*) FROM "Shift" WHERE id = '${shiftIdOf('duplicateKept')}'`), 1);
    assert.equal(shiftRow(shiftIdOf('openShift'))[2], '');
    // linked admin shift lands on the admin's user; the coincidental staff id keeps its own account
    assert.equal(shiftRow(shiftIdOf('linkedAdminShift'))[2], entity('user', 2, 1));
    assert.equal(shiftRow(shiftIdOf('coincidenceStaffShift'))[2], entity('staff', 6, 1));
    // every schedule is a Monday-to-Monday window at local midnight in its location's zone
    assert.equal(pg(`SELECT DISTINCT to_char(("startDate" AT TIME ZONE 'UTC') AT TIME ZONE l.timezone, 'Dy HH24:MI') || ' ' || to_char(("endDate" AT TIME ZONE 'UTC') AT TIME ZONE l.timezone, 'Dy HH24:MI') FROM "Schedule" s JOIN "Location" l ON l.id = s."locationId"`), 'Mon 00:00 Mon 00:00');
    assert.equal(pgNumber(`SELECT count(*) FROM "Schedule" WHERE status = 'PUBLISHED'`), 25);
  });

  await t.test('settings, templates, chores and skills are preserved as documented', () => {
    const doc = (companyId, key) => JSON.parse(pg(`SELECT value::text FROM "TenantSetting" WHERE "tenantId" = '${tenantOf(companyId)}' AND key = '${key}'`));
    const settings1 = doc(1, 'legacy.settings.v1');
    assert.equal(settings1.global.lunch_window_start, '11:00');
    assert.equal(settings1.company.automation_templates.includes('Close'), true);
    assert.deepEqual(settings1.stores, [{ location: entity('location', 1, 1), legacyStoreId: '1', values: { break_max_concurrent: '2', lunch_window_end: '14:00' } }]);
    const templates = doc(1, 'legacy.break_templates.v1');
    assert.equal(templates.default.name, 'Default');
    assert.deepEqual(templates.company.map((row) => [row.name, row.lunchDurationMinutes]), [['Closing Crew', 45]]);
    const chores = doc(1, 'legacy.chores.v1').chores;
    assert.equal(chores.length, 1);
    assert.equal(chores[0].assignedTo, entity('user', 9, 1));
    assert.equal(chores[0].createdBy, entity('user', 2, 1));
    assert.equal(chores[0].location, entity('location', 1, 1));
    assert.equal(chores[0].fields.frequency, 'daily');
    assert.equal(pgNumber(`SELECT count(*) FROM "TenantSetting" WHERE key = 'legacy.schedule_templates.v1'`), 0); // global templates are not copied to every tenant by default
    assert.equal(pgNumber(`SELECT count(*) FROM "TenantSetting" WHERE key = 'legacy-import.data-provenance.v2'`), 3);
    assert.equal(pg(`SELECT string_agg(skill, ',' ORDER BY skill) FROM "StaffSkill" WHERE "userId" = '${entity('user', 12, 1)}'`), 'Cashier,Grill');
  });

  const before = () => counts();
  await t.test('exact replay is idempotent, read-only recovery matches, later edits survive', async () => {
    const baseline = before();
    const again = await executeLegacyImport(buildPlan(), { db: prisma });
    assert.equal(before(), baseline);
    assert.deepEqual(again.rows, report.rows);
    assert.deepEqual(await readLegacyImportReport(buildPlan(), { db: prisma }).then((r) => r.rows), report.rows);
    // application edits and deletions made after cutover are neither reverted nor resurrected
    pg(`UPDATE "Shift" SET role = 'EDITED AFTER CUTOVER' WHERE id = '${shiftIdOf('springForwardAfter')}'; DELETE FROM "Break" WHERE "shiftId" = '${shiftIdOf('springForwardAfter')}' AND type = 'LUNCH'; DELETE FROM "Shift" WHERE id = '${shiftIdOf('duplicateKept')}'`);
    const edited = before();
    const replay = await executeLegacyImport(buildPlan(), { db: prisma });
    assert.equal(before(), edited);
    assert.equal(shiftRow(shiftIdOf('springForwardAfter'))[3], 'EDITED AFTER CUTOVER');
    assert.equal(breaksOf(shiftIdOf('springForwardAfter')).length, 2);
    const company1 = replay.data.companies.find((entry) => entry.companyId === '1');
    assert.equal(company1.present.shifts, company1.planned.shifts - 1);
  });

  await t.test('a different export cannot be imported over the same namespace', async () => {
    const other = JSON.parse(exportBytes().toString('utf8'));
    other.companies[0].name = 'Changed After Approval';
    const otherPath = path.join(work, 'changed.json');
    fs.writeFileSync(otherPath, JSON.stringify(other));
    const descriptor = JSON.parse(descriptorBytes().toString('utf8'));
    descriptor.sourceSha256 = sha(fs.readFileSync(otherPath));
    const changedDescriptor = Buffer.from(JSON.stringify(descriptor));
    const changedPlan = buildLegacyImportPlan(fs.readFileSync(otherPath), changedDescriptor, { expectedDescriptorSha256: sha(changedDescriptor), expectedSourceSha256: sha(fs.readFileSync(otherPath)) });
    const baseline = before();
    await assert.rejects(executeLegacyImport(changedPlan, { db: prisma }), /namespace is already bound to a different admitted plan/);
    assert.equal(before(), baseline);
  });
});
