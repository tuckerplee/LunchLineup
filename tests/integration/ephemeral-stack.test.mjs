import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { orderMigrationFileNames, shouldApplyMigrationFile } from '../../scripts/apply-db-migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = 'packages/db/prisma/schema.prisma';
const migrationsRoot = join(root, 'packages/db/prisma/migrations');
const prismaCli = join(root, 'node_modules/prisma/build/index.js');

function requireServiceUrl(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for integration tests`);
  return new URL(value);
}

function requireMigrationDatabaseUrl() {
  return requireServiceUrl('MIGRATION_DATABASE_URL').toString();
}

function connect(url, defaultPort) {
  const port = Number(url.port || defaultPort);

  return new Promise((resolveConnect, reject) => {
    const socket = net.createConnection({ host: url.hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${url.hostname}:${port}`));
    }, 5000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolveConnect();
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function applyDatabaseMigrations(databaseUrl) {
  assert.equal(existsSync(join(root, schemaPath)), true, `${schemaPath} must exist`);
  for (const migrationFile of preMigrationFiles()) {
    runPrisma(['db', 'execute', '--schema', schemaPath, '--file', migrationFile], databaseUrl);
  }
  runPrisma(['db', 'push', '--schema', schemaPath, '--skip-generate'], databaseUrl);

  for (const migrationFile of migrationFiles()) {
    runPrisma(['db', 'execute', '--schema', schemaPath, '--file', migrationFile], databaseUrl);
  }
}

function runPrisma(args, databaseUrl) {
  execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

function preMigrationFiles() {
  return orderMigrationFileNames(
    readdirSync(migrationsRoot).filter((file) => file.startsWith('pre_') && file.endsWith('.sql')),
  ).map((file) => join(migrationsRoot, file));
}

function migrationFiles() {
  return orderMigrationFileNames(readdirSync(migrationsRoot).filter(shouldApplyMigrationFile))
    .map((file) => join(migrationsRoot, file));
}

function createPrisma(databaseUrl) {
  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });
}

let initialMigrationReplayCompleted = false;
before(() => {
  applyDatabaseMigrations(requireMigrationDatabaseUrl());
  initialMigrationReplayCompleted = true;
});

test('ephemeral postgres and redis services accept TCP connections', async () => {
  await connect(requireServiceUrl('DATABASE_URL'), 5432);
  await connect(requireServiceUrl('REDIS_URL'), 6379);
});

test('prisma schema syncs and SQL migrations apply against ephemeral postgres', () => {
  assert.equal(initialMigrationReplayCompleted, true);
});

test('RBAC seed replay preserves restricted assignments and revokes Staff break writes', async () => {
  const migrationDatabaseUrl = requireMigrationDatabaseUrl();
  const prisma = createPrisma(migrationDatabaseUrl);
  const tenantId = `tenant-${randomUUID()}`;
  const unassignedStaffId = `staff-unassigned-${randomUUID()}`;
  const restrictedStaffId = `staff-restricted-${randomUUID()}`;
  const restrictedRoleId = `role-restricted-${randomUUID()}`;
  const restrictedRoleSlug = `restricted-${randomUUID()}`;
  const seedFile = join(migrationsRoot, '20260712_rbac_seed_forward_reconciliation.sql');
  const readFixtureAssignments = () => prisma.$queryRaw`
    SELECT u."name" AS "userName", ra."tenantId", r."slug" AS "roleSlug"
    FROM "RoleAssignment" ra
    JOIN "User" u ON u."id" = ra."userId"
    JOIN "Role" r ON r."id" = ra."roleId"
    WHERE ra."tenantId" = ${tenantId}
      AND ra."userId" IN (${unassignedStaffId}, ${restrictedStaffId})
    ORDER BY u."name", r."slug"
  `;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      await tx.$executeRaw`
        INSERT INTO "Tenant" ("id", "name", "slug", "status", "createdAt", "updatedAt")
        VALUES (${tenantId}, 'RBAC Replay', ${`rbac-replay-${randomUUID()}`}, 'ACTIVE'::"TenantStatus", now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "User" ("id", "tenantId", "name", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES
          (${unassignedStaffId}, ${tenantId}, 'Legacy Unassigned', 'STAFF'::"UserRole", false, ARRAY[]::TEXT[], now(), now()),
          (${restrictedStaffId}, ${tenantId}, 'Restricted Existing', 'MANAGER'::"UserRole", false, ARRAY[]::TEXT[], now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "Role"
          ("id", "tenantId", "name", "slug", "description", "isSystem", "isDefault", "legacyRole", "createdAt", "updatedAt")
        VALUES
          (${restrictedRoleId}, ${tenantId}, 'Restricted Custom', ${restrictedRoleSlug}, 'Restricted replay fixture.', false, false, NULL, now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "RoleAssignment" ("tenantId", "userId", "roleId", "createdAt")
        VALUES (${tenantId}, ${restrictedStaffId}, ${restrictedRoleId}, now())
      `;
    });

    runPrisma(['db', 'execute', '--schema', schemaPath, '--file', seedFile], migrationDatabaseUrl);

    const assignmentsAfterFirstSeed = await readFixtureAssignments();
    assert.deepEqual(assignmentsAfterFirstSeed, [
      { userName: 'Legacy Unassigned', tenantId, roleSlug: 'staff' },
      { userName: 'Restricted Existing', tenantId, roleSlug: restrictedRoleSlug },
    ]);

    await prisma.$executeRaw`
      INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
      SELECT r."id", p."id", now()
      FROM "Role" r
      JOIN "Permission" p ON p."key" = 'lunch_breaks:write'
      WHERE r."tenantId" = ${tenantId}
        AND r."slug" = 'staff'
      ON CONFLICT ("roleId", "permissionId") DO NOTHING
    `;

    runPrisma(['db', 'execute', '--schema', schemaPath, '--file', seedFile], migrationDatabaseUrl);

    const assignmentsAfterReplay = await readFixtureAssignments();
    assert.deepEqual(assignmentsAfterReplay, assignmentsAfterFirstSeed);

    const staffBreakPermissions = await prisma.$queryRaw`
      SELECT p."key"
      FROM "Role" r
      JOIN "RolePermission" rp ON rp."roleId" = r."id"
      JOIN "Permission" p ON p."id" = rp."permissionId"
      WHERE r."tenantId" = ${tenantId}
        AND r."slug" = 'staff'
        AND p."key" IN ('lunch_breaks:read', 'lunch_breaks:write')
      ORDER BY p."key"
    `;
    assert.deepEqual(staffBreakPermissions, [{ key: 'lunch_breaks:read' }]);
  } finally {
    await prisma.$disconnect();
  }
});

test('full raw migration replay accepts existing overnight staff availability', async () => {
  const databaseUrl = requireServiceUrl('DATABASE_URL').toString();

  const prisma = createPrisma(databaseUrl);
  const tenantId = `tenant-${randomUUID()}`;
  const staffId = `staff-${randomUUID()}`;
  const availabilityId = `availability-${randomUUID()}`;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      await tx.$executeRaw`
        INSERT INTO "Tenant" ("id", "name", "slug", "status", "createdAt", "updatedAt")
        VALUES (${tenantId}, 'Overnight Replay', ${`overnight-${randomUUID()}`}, 'ACTIVE'::"TenantStatus", now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "User" ("id", "tenantId", "name", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES (${staffId}, ${tenantId}, 'Overnight Staff', 'STAFF'::"UserRole", false, ARRAY[]::TEXT[], now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "StaffAvailability"
          ("id", "tenantId", "userId", "dayOfWeek", "startTimeMinutes", "endTimeMinutes", "createdAt", "updatedAt")
        VALUES (${availabilityId}, ${tenantId}, ${staffId}, 1, 1320, 360, now(), now())
      `;
    });
  } finally {
    await prisma.$disconnect();
  }

  applyDatabaseMigrations(requireMigrationDatabaseUrl());

  const verificationClient = createPrisma(databaseUrl);
  try {
    const rows = await verificationClient.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      return tx.$queryRaw`
        SELECT "startTimeMinutes", "endTimeMinutes"
        FROM "StaffAvailability"
        WHERE "id" = ${availabilityId}
      `;
    });
    assert.deepEqual(rows, [{ startTimeMinutes: 1320, endTimeMinutes: 360 }]);
  } finally {
    await verificationClient.$disconnect();
  }
});

test('migrated schema accepts the worker solved-schedule persistence path', async () => {
  const databaseUrl = requireServiceUrl('DATABASE_URL').toString();

  const workerSource = readFileSync(resolve(root, 'apps/worker/main.py'), 'utf8');
  assert.match(workerSource, /SELECT set_current_tenant\(%s\)/);
  assert.match(workerSource, /INSERT INTO "Shift"/);
  assert.match(workerSource, /INSERT INTO "Break"/);

  const prisma = createPrisma(databaseUrl);
  const tenantId = `tenant-${randomUUID()}`;
  const locationId = `loc-${randomUUID()}`;
  const staffId = `staff-${randomUUID()}`;
  const scheduleId = `schedule-${randomUUID()}`;
  const shiftId = `shift-${randomUUID()}`;
  const breakId = `break-${randomUUID()}`;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      await tx.$executeRaw`
        INSERT INTO "Tenant" ("id", "name", "slug", "status", "createdAt", "updatedAt")
        VALUES (${tenantId}, 'Worker Persistence Smoke', ${`worker-${randomUUID()}`}, 'ACTIVE'::"TenantStatus", now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "Location" ("id", "tenantId", "name", "timezone", "createdAt", "updatedAt")
        VALUES (${locationId}, ${tenantId}, 'Smoke Location', 'America/Los_Angeles', now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "User" ("id", "tenantId", "name", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES (${staffId}, ${tenantId}, 'Smoke Staff', 'STAFF'::"UserRole", false, ARRAY[]::TEXT[], now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "Schedule" ("id", "tenantId", "locationId", "startDate", "endDate", "status", "createdAt", "updatedAt")
        VALUES (${scheduleId}, ${tenantId}, ${locationId}, '2026-07-13T00:00:00Z'::timestamptz, '2026-07-13T23:59:59Z'::timestamptz, 'DRAFT'::"ScheduleStatus", now(), now())
      `;

      const scheduleRows = await tx.$queryRaw`
        SELECT id, status
        FROM "Schedule"
        WHERE id = ${scheduleId} AND "tenantId" = ${tenantId} AND "locationId" = ${locationId}
      `;
      assert.deepEqual(scheduleRows, [{ id: scheduleId, status: 'DRAFT' }]);

      const staffRows = await tx.$queryRaw`
        SELECT id FROM "User" WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL AND id = ANY(${[staffId]})
      `;
      assert.deepEqual(staffRows, [{ id: staffId }]);

      await tx.$executeRaw`
        INSERT INTO "Shift"
          ("id", "tenantId", "locationId", "scheduleId", "userId", "startTime", "endTime", "role", "createdAt", "updatedAt")
        VALUES
          (${shiftId}, ${tenantId}, ${locationId}, ${scheduleId}, ${staffId}, '2026-07-13T09:00:00Z'::timestamptz, '2026-07-13T17:00:00Z'::timestamptz, 'STAFF', now(), now())
      `;
      await tx.$executeRaw`
        INSERT INTO "Break" ("id", "shiftId", "type", "startTime", "endTime", "paid", "createdAt")
        VALUES (${breakId}, ${shiftId}, NULL, '2026-07-13T12:00:00Z'::timestamptz, '2026-07-13T12:30:00Z'::timestamptz, false, now())
      `;

      const persisted = await tx.$queryRaw`
        SELECT s.id AS "shiftId", b.id AS "breakId", b.type
        FROM "Shift" s
        JOIN "Break" b ON b."shiftId" = s.id
        WHERE s."tenantId" = ${tenantId} AND s."scheduleId" = ${scheduleId} AND s."userId" = ${staffId}
      `;
      assert.deepEqual(persisted, [{ shiftId, breakId, type: null }]);
    });
  } finally {
    await prisma.$disconnect();
  }
});
