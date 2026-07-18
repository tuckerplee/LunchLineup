import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { orderMigrationFileNames, shouldApplyMigrationFile } from '../../scripts/apply-db-migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsRoot = join(root, 'packages/db/prisma/migrations');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function migrationSqlFiles() {
  return readdirSync(migrationsRoot)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => join(migrationsRoot, file));
}

function filesUnder(relativeDirectory) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  walk(join(root, relativeDirectory));
  return files;
}

test('PostgreSQL void advisory locks execute without Prisma row deserialization', () => {
  const rawReadPattern = /\$queryRaw(?:<[^>]+>)?\s*\x60\s*SELECT\s+pg_advisory_xact_lock\b/;
  const unsafeRawReadPattern = /\$queryRawUnsafe\s*\(\s*['"\x60]\s*SELECT\s+pg_advisory_xact_lock\b/;
  const offenders = filesUnder('apps/api/src')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
    .filter((path) => {
      const source = readFileSync(path, 'utf8');
      return rawReadPattern.test(source) || unsafeRawReadPattern.test(source);
    })
    .map((path) => relative(root, path).replaceAll('\\', '/'));

  assert.deepEqual(
    offenders,
    [],
    'pg_advisory_xact_lock returns void and must use parameterized $executeRaw',
  );
});

function parseSqlStatements(sql) {
  const statements = [];
  let statementStart = 0;
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const commentEnd = sql.indexOf('*/', index + 2);
      assert.notEqual(commentEnd, -1, 'SQL contains an unterminated block comment');
      index = commentEnd + 2;
      continue;
    }

    const dollarQuote = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
    if (dollarQuote) {
      const quoteEnd = sql.indexOf(dollarQuote, index + dollarQuote.length);
      assert.notEqual(quoteEnd, -1, `SQL contains an unterminated ${dollarQuote} body`);
      index = quoteEnd + dollarQuote.length;
      continue;
    }

    const char = sql[index];
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      assert.ok(index <= sql.length && sql[index - 1] === quote, `SQL contains an unterminated ${quote} quote`);
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      assert.ok(depth >= 0, 'SQL closes a parenthesis before opening it');
    }
    if (char === ';' && depth === 0) {
      statements.push(sql.slice(statementStart, index + 1).trim());
      statementStart = index + 1;
    }
    index += 1;
  }

  assert.equal(depth, 0, 'SQL contains unbalanced parentheses');
  assert.equal(sql.slice(statementStart).trim(), '', 'SQL ends with an unterminated statement');
  return statements.filter(Boolean);
}

test('first-location retries have a paired tenant-scoped durable request identity', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260710_first_location_idempotency.sql');

  assert.match(schema, /creationRequestKeyHash\s+String\?/);
  assert.match(schema, /creationRequestHash\s+String\?/);
  assert.match(schema, /@@unique\(\[tenantId, creationRequestKeyHash\]\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "creationRequestKeyHash" TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "creationRequestHash" TEXT/);
  assert.match(sql, /ON "Location"\("tenantId", "creationRequestKeyHash"\)/);
  assert.match(sql, /CHECK \(\("creationRequestKeyHash" IS NULL\) = \("creationRequestHash" IS NULL\)\)/);
});

test('nullable unique identities are staged safely before Prisma schema synchronization', () => {
  const migrationScript = read('scripts/apply-db-migrations.mjs');
  const preMigration = read(
    'packages/db/prisma/migrations/pre_20260717_prisma_nullable_unique_indexes.sql',
  );
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.ok(
    migrationScript.indexOf('await operations.applyPreMigrations()')
      < migrationScript.indexOf('await operations.pushSchema()'),
    'pre-migrations must run before Prisma schema synchronization',
  );
  assert.match(migrationsReadme, /pre_20260717_prisma_nullable_unique_indexes\.sql/);

  for (const table of ['Location', 'Session', 'User']) {
    assert.match(preMigration, new RegExp(`to_regclass\\('public\\."${table}"'\\) IS NULL`));
    assert.match(preMigration, new RegExp(`LOCK TABLE public\\."${table}" IN SHARE ROW EXCLUSIVE MODE`));
  }

  for (const column of [
    'creationRequestKeyHash',
    'creationRequestHash',
    'selectorHash',
    'oidcIssuer',
    'oidcSubject',
  ]) {
    assert.match(preMigration, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}" TEXT`));
  }

  for (const index of [
    'Location_tenantId_creationRequestKeyHash_key',
    'Session_selectorHash_key',
    'User_tenantId_oidcIssuer_oidcSubject_key',
  ]) {
    assert.match(preMigration, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS "${index}"`));
    assert.match(preMigration, new RegExp(`index_relation\\.relname = '${index}'`));
  }

  assert.match(preMigration, /GROUP BY "tenantId", "creationRequestKeyHash"[\s\S]*HAVING COUNT\(\*\) > 1/);
  assert.match(preMigration, /GROUP BY "selectorHash"[\s\S]*HAVING COUNT\(\*\) > 1/);
  assert.match(preMigration, /GROUP BY "tenantId", "oidcIssuer", "oidcSubject"[\s\S]*HAVING COUNT\(\*\) > 1/);
  assert.match(preMigration, /\("oidcIssuer" IS NULL\) <> \("oidcSubject" IS NULL\)/);
  assert.doesNotMatch(preMigration, /--accept-data-loss/);
});

test('Prisma owns every composite parent identity required by raw tenant foreign keys', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const preMigration = read(
    'packages/db/prisma/migrations/pre_20260717_prisma_composite_parent_keys.sql',
  );
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  for (const model of ['User', 'Role', 'Location', 'Schedule', 'Shift']) {
    const modelBody = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    assert.match(modelBody, /@@unique\(\[id, tenantId\]\)/, `${model} must own its composite identity`);
  }

  const scheduleBody = schema.match(/model Schedule \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(scheduleBody, /@@unique\(\[id, tenantId, locationId\]\)/);
  assert.match(migrationsReadme, /pre_20260717_prisma_composite_parent_keys\.sql/);

  for (const [table, index, columns] of [
    ['User', 'User_id_tenantId_key', "'id', 'tenantId'"],
    ['Role', 'Role_id_tenantId_key', "'id', 'tenantId'"],
    ['Location', 'Location_id_tenantId_key', "'id', 'tenantId'"],
    ['Schedule', 'Schedule_id_tenantId_key', "'id', 'tenantId'"],
    ['Schedule', 'Schedule_id_tenantId_locationId_key', "'id', 'tenantId', 'locationId'"],
    ['Shift', 'Shift_id_tenantId_key', "'id', 'tenantId'"],
    [
      'PayrollAmendmentDecision',
      'PayrollAmendmentDecision_amendmentId_tenantId_key',
      "'amendmentId', 'tenantId'",
    ],
    [
      'PayrollExportBatch',
      'PayrollExportBatch_periodId_tenantId_key',
      "'periodId', 'tenantId'",
    ],
  ]) {
    assert.match(
      preMigration,
      new RegExp(`'${table}'\\s*,\\s*'${index}'\\s*,\\s*ARRAY\\[${columns}\\]`),
    );
  }

  assert.match(preMigration, /LOCK TABLE public\.%I IN SHARE MODE/);
  assert.match(preMigration, /CREATE UNIQUE INDEX IF NOT EXISTS %I ON public\.%I/);
  assert.match(preMigration, /index_metadata\.indpred IS NULL/);
  assert.match(preMigration, /actual_columns IS DISTINCT FROM target\.column_names/);
  assert.doesNotMatch(preMigration, /--accept-data-loss/);
});

test('Prisma owns raw composite tenant foreign keys across repeated schema synchronization', () => {
  const schema = read('packages/db/prisma/schema.prisma');

  for (const [model, relations] of [
    ['RoleAssignment', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId], onDelete: Cascade)',
      '@relation(fields: [roleId, tenantId], references: [id, tenantId], onDelete: Cascade)',
    ]],
    ['Schedule', [
      '@relation(fields: [locationId, tenantId], references: [id, tenantId])',
    ]],
    ['ScheduleSolveJob', [
      '@relation(fields: [scheduleId, tenantId], references: [id, tenantId])',
      '@relation(fields: [locationId, tenantId], references: [id, tenantId])',
    ]],
    ['StaffAvailability', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId])',
      '@relation(fields: [locationId, tenantId], references: [id, tenantId], onDelete: Restrict)',
    ]],
    ['StaffSkill', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId])',
    ]],
    ['ScheduleDemandWindow', [
      '@relation(fields: [scheduleId, tenantId, locationId], references: [id, tenantId, locationId], onDelete: Cascade)',
      '@relation(fields: [locationId, tenantId], references: [id, tenantId])',
    ]],
    ['Shift', [
      '@relation(fields: [locationId, tenantId], references: [id, tenantId])',
      '@relation(fields: [scheduleId, tenantId, locationId], references: [id, tenantId, locationId], onDelete: Restrict)',
      '@relation(fields: [userId, tenantId], references: [id, tenantId], onDelete: Restrict)',
    ]],
    ['TimeCard', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId])',
      '@relation(fields: [locationId, tenantId], references: [id, tenantId], onDelete: Restrict)',
      '@relation(fields: [shiftId, tenantId], references: [id, tenantId], onDelete: Restrict)',
    ]],
    ['TimeCardBreak', [
      '@relation(fields: [timeCardId, tenantId], references: [id, tenantId], onDelete: Cascade)',
    ]],
    ['AuditLog', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId], onDelete: Restrict)',
    ]],
    ['Notification', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId])',
    ]],
    ['OnboardingSignupAttempt', [
      '@relation(fields: [userId, tenantId], references: [id, tenantId], onDelete: SetNull)',
    ]],
  ]) {
    const modelBody = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    for (const relation of relations) {
      assert.ok(modelBody.includes(relation), `${model} must own composite relation: ${relation}`);
    }
  }
});

test('RLS and audit migrations use Prisma quoted identifiers', () => {
  const checkedFiles = [
    'packages/db/prisma/migrations/20260712_core_rls_audit_forward_reconciliation.sql',
  ];
  const legacyIdentifierReferences = [
    /\bALTER\s+TABLE\s+(?:tenants|users|locations|shifts|audit_logs)\b/i,
    /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:tenants|users|locations|shifts|audit_logs)\b/i,
    /\b(?:ON|FROM|JOIN|REFERENCES)\s+(?:tenants|users|locations|shifts|audit_logs)\b/i,
  ];

  for (const file of checkedFiles) {
    const sql = read(file);

    for (const pattern of legacyIdentifierReferences) {
      assert.doesNotMatch(sql, pattern, `${file} must not target snake_case table identifiers`);
    }
  }

  const sql = read(checkedFiles[0]);
  assert.match(sql, /\('TimeCard', 'time_card_isolation_policy'\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "AuditLog"/);
  assert.match(sql, /USING \(is_current_platform_admin\(\) OR "tenantId" = \(SELECT get_current_tenant\(\)\)\)/);
  assert.match(sql, /WITH CHECK \(is_current_platform_admin\(\) OR "tenantId" = \(SELECT get_current_tenant\(\)\)\)/);
});

test('RLS covers direct tenant-owned tables and checks writes', () => {
  const sql = read('packages/db/prisma/migrations/20260712_core_rls_audit_forward_reconciliation.sql');
  const tenantContextSql = read('packages/db/prisma/migrations/20260712_tenant_context_helpers.sql');
  for (const table of [
    'Tenant',
    'User',
    'Location',
    'Schedule',
    'Shift',
    'TimeCard',
    'TenantSetting',
    'Role',
    'BillingEvent',
    'StripeUsageEvent',
    'Notification',
    'WebhookEndpoint',
    'CreditTransaction',
  ]) {
    assert.match(sql, new RegExp(`\\('${table}',`), `${table} must enable RLS`);
  }

  for (const policy of [
    'tenant_isolation_policy',
    'user_isolation_policy',
    'location_isolation_policy',
    'schedule_isolation_policy',
    'shift_isolation_policy',
    'time_card_isolation_policy',
    'tenant_setting_isolation_policy',
    'role_isolation_policy',
    'billing_event_isolation_policy',
    'stripe_usage_event_isolation_policy',
    'notification_isolation_policy',
    'webhook_endpoint_isolation_policy',
    'credit_transaction_isolation_policy',
  ]) {
    assert.match(sql, new RegExp(`'${policy}'`), `${policy} must exist`);
  }

  assert.match(sql, /WITH CHECK \(is_current_platform_admin\(\) OR "tenantId" = \(SELECT get_current_tenant\(\)\)\)/);
  assert.match(tenantContextSql, /set_config\('app\.current_tenant', tenant_id, true\)/);
  assert.match(tenantContextSql, /LANGUAGE plpgsql STABLE/);
});

test('RLS hardening forces owner enforcement and covers relation tables', () => {
  const sql = read('packages/db/prisma/migrations/rls_relation_hardening.sql');

  for (const table of [
    'Tenant',
    'User',
    'Location',
    'Schedule',
    'Shift',
    'TimeCard',
    'TenantSetting',
    'Role',
    'BillingEvent',
    'StripeUsageEvent',
    'Notification',
    'WebhookEndpoint',
    'CreditTransaction',
    'AuditLog',
    'Session',
    'RolePermission',
    'RoleAssignment',
    'Break',
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`), `${table} must force RLS`);
  }

  for (const table of ['Session', 'RolePermission', 'RoleAssignment', 'Break']) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`), `${table} must enable RLS`);
  }

  for (const policy of [
    'session_tenant_isolation_policy',
    'role_permission_tenant_isolation_policy',
    'role_assignment_tenant_isolation_policy',
    'break_tenant_isolation_policy',
  ]) {
    assert.match(sql, new RegExp(`CREATE POLICY ${policy}`), `${policy} must exist`);
  }

  assert.match(sql, /FROM "User" u[\s\S]*u\."tenantId" = \(SELECT get_current_tenant\(\)\)/);
  assert.match(sql, /FROM "Role" r[\s\S]*r\."tenantId" = \(SELECT get_current_tenant\(\)\)/);
  assert.match(sql, /FROM "Shift" s[\s\S]*s\."tenantId" = \(SELECT get_current_tenant\(\)\)/);
  assert.match(sql, /CREATE POLICY role_assignment_tenant_isolation_policy[\s\S]*"tenantId" = \(SELECT get_current_tenant\(\)\)[\s\S]*FROM "User" u[\s\S]*FROM "Role" r/);
});

test('TimeCard schema changes have forward SQL migration coverage', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  assert.match(schema, /\bmodel TimeCard\b/);
  assert.match(schema, /\benum TimeCardStatus\b/);

  const timeCardMigration = migrationSqlFiles()
    .map((file) => ({ file, sql: readFileSync(file, 'utf8') }))
    .find(({ sql }) => /CREATE TABLE IF NOT EXISTS "TimeCard"/.test(sql));

  assert.ok(timeCardMigration, 'TimeCard requires an explicit SQL migration');
  assert.equal(basename(timeCardMigration.file), '20260708_time_card.sql');

  for (const expected of [
    'CREATE TYPE "TimeCardStatus"',
    '"tenantId" TEXT NOT NULL',
    '"userId" TEXT NOT NULL',
    '"clockInAt" TIMESTAMP(3) NOT NULL',
    '"breakMinutes" INTEGER NOT NULL DEFAULT 0',
    '"status" "TimeCardStatus" NOT NULL DEFAULT \'OPEN\'',
    'CONSTRAINT "TimeCard_tenantId_fkey"',
    'CONSTRAINT "TimeCard_userId_fkey"',
    'CONSTRAINT "TimeCard_locationId_fkey"',
    'CONSTRAINT "TimeCard_shiftId_fkey"',
    'CREATE INDEX IF NOT EXISTS "TimeCard_tenantId_idx"',
    'CREATE INDEX IF NOT EXISTS "TimeCard_deletedAt_idx"',
  ]) {
    assert.ok(timeCardMigration.sql.includes(expected), `missing TimeCard migration fragment: ${expected}`);
  }
});

test('schedule solver persisted inputs have schema and SQL migration coverage', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260709_schedule_solve_persisted_inputs.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  for (const expected of [
    'model StaffAvailability',
    'model StaffSkill',
    'model ScheduleDemandWindow',
    'staffSnapshot        Json?',
    'demandSnapshot       Json?',
    'scheduleDemandWindows ScheduleDemandWindow[]',
    '@@index([tenantId, userId, dayOfWeek, startTimeMinutes])',
    '@@unique([tenantId, userId, skill])',
    '@@index([tenantId, scheduleId, startTime])',
  ]) {
    assert.ok(schema.includes(expected), `missing scheduler persisted-input schema fragment: ${expected}`);
  }
  assert.match(schema, /staffSkills\s+StaffSkill\[\]/);
  assert.match(schema, /staffAvailabilities\s+StaffAvailability\[\]/);

  assert.match(migrationsReadme, /20260709_schedule_solve_persisted_inputs\.sql/);

  for (const expected of [
    'CREATE TABLE IF NOT EXISTS "StaffAvailability"',
    'CREATE TABLE IF NOT EXISTS "StaffSkill"',
    'CREATE TABLE IF NOT EXISTS "ScheduleDemandWindow"',
    'ALTER TABLE "ScheduleSolveJob"',
    'ADD COLUMN IF NOT EXISTS "staffSnapshot" JSONB',
    'ADD COLUMN IF NOT EXISTS "demandSnapshot" JSONB',
    'CONSTRAINT "StaffAvailability_userId_tenantId_fkey"',
    'CONSTRAINT "StaffAvailability_time_window_valid"',
    'CONSTRAINT "StaffSkill_userId_tenantId_fkey"',
    'CONSTRAINT "StaffSkill_skill_nonempty"',
    'CONSTRAINT "ScheduleDemandWindow_scheduleId_tenantId_locationId_fkey"',
    'CONSTRAINT "ScheduleDemandWindow_requiredStaff_positive"',
    'CREATE CONSTRAINT TRIGGER "ScheduleDemandWindow_within_schedule"',
    'ALTER TABLE "StaffAvailability" ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE "StaffSkill" FORCE ROW LEVEL SECURITY',
    'ALTER TABLE "ScheduleDemandWindow" ENABLE ROW LEVEL SECURITY',
    'CREATE POLICY staff_availability_isolation_policy',
    'CREATE POLICY staff_skill_isolation_policy',
    'CREATE POLICY schedule_demand_window_isolation_policy',
    'is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant())',
  ]) {
    assert.ok(sql.includes(expected), `missing schedule persisted-input migration fragment: ${expected}`);
  }
});

test('public SaaS data hardening migration enforces tenant integrity and time-card invariants', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260709_public_saas_data_hardening.sql');

  for (const expected of [
    '@@index([tenantId, locationId, startDate, endDate])',
    '@@index([tenantId, locationId, deletedAt, startTime])',
    '@@index([tenantId, scheduleId, deletedAt, startTime])',
    '@@index([tenantId, userId, deletedAt, startTime])',
    '@@index([tenantId, userId, status, deletedAt, clockInAt])',
    '@@index([tenantId, locationId, deletedAt, clockInAt])',
    '@@index([tenantId, createdAt])',
  ]) {
    assert.ok(schema.includes(expected), `missing Prisma index: ${expected}`);
  }

  for (const expected of [
    'CREATE UNIQUE INDEX IF NOT EXISTS "User_id_tenantId_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "Location_id_tenantId_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_id_tenantId_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "Shift_id_tenantId_key"',
    'CONSTRAINT "Schedule_locationId_tenantId_fkey"',
    'CONSTRAINT "Shift_locationId_tenantId_fkey"',
    'CONSTRAINT "Shift_scheduleId_tenantId_fkey"',
    'CONSTRAINT "TimeCard_userId_tenantId_fkey"',
    'CONSTRAINT "TimeCard_locationId_tenantId_fkey"',
    'CONSTRAINT "TimeCard_shiftId_tenantId_fkey"',
    'CONSTRAINT "Notification_userId_tenantId_fkey"',
    'CONSTRAINT "AuditLog_tenantId_fkey"',
    'CONSTRAINT "AuditLog_userId_tenantId_fkey"',
    'CONSTRAINT "TimeCard_breakMinutes_nonnegative"',
    'CONSTRAINT "TimeCard_clock_window_valid"',
    'CONSTRAINT "TimeCard_status_clock_consistent"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "TimeCard_one_open_per_user_idx"',
  ]) {
    assert.ok(sql.includes(expected), `missing public SaaS hardening fragment: ${expected}`);
  }
});

test('audit log retention purge is restricted to the platform-admin owner function', () => {
  const sql = read('packages/db/prisma/migrations/20260713_audit_log_retention_authorization.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(migrationsReadme, /20260713_audit_log_retention_authorization\.sql/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.purge_expired_audit_logs\(target_tenant_id TEXT\)/);
  assert.match(sql, /IF NOT public\.is_current_platform_admin\(\)/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(sql, /CURRENT_USER = \(/);
  assert.match(sql, /app\.audit_log_retention_txid/);
  assert.doesNotMatch(sql, /app\.allow_audit_log_delete/);
});
test('Stripe tenant identifiers are unique when present without rejecting null tenants', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260709_stripe_identifier_uniqueness.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(schema, /\bstripeCustomerId\s+String\?/);
  assert.match(schema, /\bstripeSubscriptionId\s+String\?/);
  assert.match(schema, /Non-null Stripe identifier uniqueness is enforced by a partial SQL migration\./);
  assert.match(migrationsReadme, /20260709_stripe_identifier_uniqueness\.sql/);

  for (const expected of [
    'CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_stripeCustomerId_unique_nonnull_idx"',
    'ON "Tenant"("stripeCustomerId")',
    'WHERE "stripeCustomerId" IS NOT NULL',
    'CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_stripeSubscriptionId_unique_nonnull_idx"',
    'ON "Tenant"("stripeSubscriptionId")',
    'WHERE "stripeSubscriptionId" IS NOT NULL',
  ]) {
    assert.ok(sql.includes(expected), `missing Stripe identifier uniqueness fragment: ${expected}`);
  }

  assert.doesNotMatch(sql, /ADD CONSTRAINT[\s\S]*stripe/i);
  assert.doesNotMatch(sql, /"stripeCustomerId"\s+TEXT\s+NOT\s+NULL/i);
  assert.doesNotMatch(sql, /"stripeSubscriptionId"\s+TEXT\s+NOT\s+NULL/i);
});

test('Stripe usage events are durable, tenant-scoped, and idempotent', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260709_stripe_usage_events.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  for (const expected of [
    'model StripeUsageEvent',
    'enum StripeUsageMetric',
    'enum StripeUsageEventStatus',
    'identifier       String                 @unique',
    'idempotencyKey   String                 @unique',
    '@@index([status, nextAttemptAt])',
    '@@unique([tenantId, metric, periodStart, periodEnd])',
  ]) {
    assert.ok(schema.includes(expected), `missing Stripe usage schema fragment: ${expected}`);
  }

  assert.match(schema, /stripeUsageEvents\s+StripeUsageEvent\[\]/);

  assert.match(migrationsReadme, /20260709_stripe_usage_events\.sql/);
  assert.match(migrationsReadme, /20260712_stripe_usage_logical_identity\.sql/);

  for (const expected of [
    'CREATE TABLE IF NOT EXISTS "StripeUsageEvent"',
    'CREATE TYPE "StripeUsageMetric"',
    'CREATE TYPE "StripeUsageEventStatus"',
    'CONSTRAINT "StripeUsageEvent_tenantId_fkey"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_identifier_key"',
    'CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_idempotencyKey_key"',
    'CREATE INDEX IF NOT EXISTS "StripeUsageEvent_status_nextAttemptAt_idx"',
    'CONSTRAINT "StripeUsageEvent_quantity_nonnegative"',
    'CONSTRAINT "StripeUsageEvent_attempts_nonnegative"',
    'CONSTRAINT "StripeUsageEvent_period_valid"',
    'CONSTRAINT "StripeUsageEvent_required_text_nonempty"',
    'ALTER TABLE "StripeUsageEvent" ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE "StripeUsageEvent" FORCE ROW LEVEL SECURITY',
    'CREATE POLICY stripe_usage_event_isolation_policy',
    'is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant())',
  ]) {
    assert.ok(sql.includes(expected), `missing Stripe usage migration fragment: ${expected}`);
  }
});

test('RoleAssignment stores tenant id and database rejects cross-tenant role pairs', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const preSql = read('packages/db/prisma/migrations/pre_20260709_role_assignment_tenant_integrity.sql');
  const sql = read('packages/db/prisma/migrations/20260709_role_assignment_tenant_integrity.sql');
  const initialRbacMigration = read('packages/db/prisma/migrations/20260325_rbac_roles_permissions.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  for (const expected of [
    'tenantId    String',
    '@@index([tenantId])',
    '@@index([tenantId, userId])',
    '@@index([tenantId, roleId])',
  ]) {
    assert.ok(schema.includes(expected), `missing RoleAssignment schema fragment: ${expected}`);
  }
  assert.match(schema, /roleAssignments\s+RoleAssignment\[\]/);
  assert.match(schema, /model RoleAssignment \{[\s\S]*tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);

  assert.match(migrationsReadme, /pre_20260709_role_assignment_tenant_integrity\.sql/);
  assert.match(migrationsReadme, /20260709_role_assignment_tenant_integrity\.sql/);

  for (const migration of [preSql, sql]) {
    for (const expected of [
      'ALTER TABLE "RoleAssignment" ADD COLUMN IF NOT EXISTS "tenantId" TEXT',
      'RoleAssignment contains cross-tenant user-role pairs',
      'UPDATE "RoleAssignment" ra',
      'ALTER TABLE "RoleAssignment" ALTER COLUMN "tenantId" SET NOT NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS "Role_id_tenantId_key"',
      'CREATE INDEX IF NOT EXISTS "RoleAssignment_tenantId_userId_idx"',
      'CONSTRAINT "RoleAssignment_tenantId_fkey"',
      'CONSTRAINT "RoleAssignment_userId_tenantId_fkey"',
      'CONSTRAINT "RoleAssignment_roleId_tenantId_fkey"',
      'VALIDATE CONSTRAINT "RoleAssignment_roleId_tenantId_fkey"',
    ]) {
      assert.ok(migration.includes(expected), `missing RoleAssignment migration fragment: ${expected}`);
    }
  }

  assert.doesNotMatch(initialRbacMigration, /CREATE TABLE IF NOT EXISTS "RoleAssignment" \(\s+"tenantId" TEXT NOT NULL/);
  assert.match(initialRbacMigration, /INSERT INTO "RoleAssignment" \("userId", "roleId", "createdAt"\)/);
});

test('RBAC and plan migrations converge fresh and upgraded databases to time-card support', () => {
  const planMigration = read('packages/db/prisma/migrations/20260321_plan_definitions.sql');
  const initialRbacMigration = read('packages/db/prisma/migrations/20260325_rbac_roles_permissions.sql');
  const categoryMigration = read('packages/db/prisma/migrations/20260709_permission_category_time_cards.sql');
  const hardeningMigration = read('packages/db/prisma/migrations/20260709_public_saas_data_hardening.sql');
  const reconciliationMigration = read('packages/db/prisma/migrations/20260712_historical_forward_reconciliation.sql');

  assert.doesNotMatch(planMigration, /"time_cards"/);
  assert.match(reconciliationMigration, /'\["time_cards","webhooks"\]'/);
  assert.doesNotMatch(initialRbacMigration, /'TIME_CARDS'/);
  assert.match(categoryMigration, /ALTER TYPE "PermissionCategory" ADD VALUE IF NOT EXISTS 'TIME_CARDS'/);
  assert.match(hardeningMigration, /'time_cards:read'/);
  assert.match(hardeningMigration, /'time_cards:write'/);
  assert.match(hardeningMigration, /DELETE FROM "RolePermission"[\s\S]*'lunch_breaks:write'/);
});

test('schedule integrity constraints run after public SaaS data hardening prerequisites', () => {
  const migrationInventory = read('scripts/raw-migration-inventory.mjs');
  const hardeningFile = '20260709_public_saas_data_hardening.sql';
  const scheduleIntegrityFile = '20260709_schedule_integrity_constraints.sql';
  const hardeningMigration = read(`packages/db/prisma/migrations/${hardeningFile}`);
  const scheduleIntegrityMigration = read(`packages/db/prisma/migrations/${scheduleIntegrityFile}`);

  assert.match(migrationInventory, /left\.localeCompare\(right\)/);
  assert.ok(
    hardeningFile.localeCompare(scheduleIntegrityFile) < 0,
    'schedule integrity FKs depend on hardening indexes and must sort after hardening',
  );
  assert.match(hardeningMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "User_id_tenantId_key"/);
  assert.match(scheduleIntegrityMigration, /FOREIGN KEY \("userId", "tenantId"\) REFERENCES "User"\("id", "tenantId"\)/);
  assert.match(hardeningMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_id_tenantId_key"/);
  assert.match(scheduleIntegrityMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_id_tenantId_locationId_key"/);
});

test('development seed refuses accidental production execution', () => {
  const seed = read('packages/db/prisma/seed.ts');
  assert.match(seed, /data-target-guard\.mjs/);
  assert.match(seed, /execFileSync\(process\.execPath, \[guardPath, 'development-seed'\]/);
  assert.doesNotMatch(seed, /ALLOW_PRODUCTION_SEED/);
  assert.match(seed, /auth:login_password/);
  assert.match(seed, /rolePermission\.createMany/);
  assert.match(seed, /roleAssignment\.createMany/);
  assert.match(seed, /super-admin/);
});

test('deployment applies raw SQL migrations after Postgres starts', () => {
  const compose = read('docker-compose.yml');
  const migrationDockerfile = read('infrastructure/docker/Dockerfile.migrations');
  const ci = read('.github/workflows/ci.yml');
  const migrationScript = read('scripts/apply-db-migrations.mjs');
  const adminBootstrap = read('scripts/bootstrap-production-admin.mjs');

  assert.doesNotMatch(compose, /docker-entrypoint-initdb\.d\/.*(?:init_rls|audit_log)/);
  assert.match(compose, /dockerfile:\s*infrastructure\/docker\/Dockerfile\.migrations/);
  assert.match(compose, /service_completed_successfully/);
  assert.match(migrationDockerfile, /scripts\/apply-db-migrations\.mjs/);
  assert.match(ci, /node scripts\/apply-db-migrations\.mjs/);
  assert.doesNotMatch(ci, /prisma migrate deploy/);
  assert.match(migrationScript, /buildRawMigrationInventory/);
  assert.match(migrationScript, /RawMigrationLedgerSession/);
  assert.match(migrationScript, /const prismaCli = join\(root, 'node_modules\/prisma\/build\/index\.js'\)/);
  assert.match(migrationScript, /runBoundedProcess\(node, \[prismaCli, \.\.\.args\]/);
  assert.match(migrationScript, /timeoutMs: PRISMA_COMMAND_TIMEOUT_MS/);
  assert.doesNotMatch(migrationScript, /npx(?:\.cmd)?/);
  assert.match(migrationScript, /applyPreMigrations: \(\) => ledger\.applyAll\(inventory\.pre\)/);
  assert.match(migrationScript, /applyRawMigrations: \(\) => ledger\.applyAll\(inventory\.post\)/);
  assert.doesNotMatch(migrationScript, /db', 'execute'/);
  assert.match(migrationScript, /\['db', 'push', '--schema', schemaPath, '--skip-generate'\]/);
  assert.doesNotMatch(migrationScript, /--accept-data-loss|--force-reset|migrate\s+reset/);
  assert.match(migrationScript, /bootstrap-production-admin\.mjs/);
  assert.match(migrationScript, /assertMigrationDeploymentTarget\(process\.env\)/);
  assert.match(migrationScript, /deploymentTarget === 'production'/);
  assert.match(adminBootstrap, /ADMIN_EMAIL/);
  assert.match(adminBootstrap, /super-admin/);
  assert.match(adminBootstrap, /roleAssignment\.createMany/);
  assert.match(adminBootstrap, /account:data_export/);
  assert.match(adminBootstrap, /--preflight-only/);
  assert.match(adminBootstrap, /active non-designated account has legacy SUPER_ADMIN or a super-admin RBAC assignment/);
  assert.match(adminBootstrap, /const adminCreated = !user;[\s\S]*if \(!user\)[\s\S]*tx\.user\.create[\s\S]*else[\s\S]*data: \{ role: 'SUPER_ADMIN' \}[\s\S]*roleAssignment\.createMany/);
  assert.doesNotMatch(adminBootstrap, /tx\.user\.upsert/);
  assert.match(adminBootstrap, /tenant\.deletedAt \|\| tenant\.status !== 'ACTIVE'/);
  assert.match(adminBootstrap, /set_current_platform_admin\(true, \$\{capability\}\)/);
  assert.match(migrationScript, /productionAdminBootstrapPath, '--preflight-only'/);
  assert.match(migrationScript, /preflightProductionAdmin[\s\S]*verifyWebhookEndpointSecrets/);
});

test('existing solve jobs receive request hashes before Prisma enforces required columns', () => {
  const migrationScript = read('scripts/apply-db-migrations.mjs');
  const preMigration = read(
    'packages/db/prisma/migrations/pre_20260709_schedule_solve_request_idempotency.sql',
  );
  const finalMigration = read(
    'packages/db/prisma/migrations/20260709_schedule_solve_request_idempotency.sql',
  );
  const schema = read('packages/db/prisma/schema.prisma');

  const preApply = migrationScript.indexOf('await operations.applyPreMigrations()');
  const schemaPush = migrationScript.indexOf('await operations.pushSchema()');
  const finalApply = migrationScript.indexOf('await operations.applyRawMigrations()');

  assert.ok(preApply >= 0 && preApply < schemaPush, 'pre-migrations must run before Prisma schema push');
  assert.ok(schemaPush < finalApply, 'forward migrations must run after Prisma schema push');
  assert.match(migrationScript, /applyPreMigrations: \(\) => ledger\.applyAll\(inventory\.pre\)/);
  assert.match(migrationScript, /applyRawMigrations: \(\) => ledger\.applyAll\(inventory\.post\)/);

  assert.match(preMigration, /to_regclass\('"ScheduleSolveJob"'\) IS NULL/);
  const addNullableColumns = preMigration.indexOf('ADD COLUMN IF NOT EXISTS "requestKeyHash" TEXT');
  const backfillRows = preMigration.indexOf('UPDATE "ScheduleSolveJob"');
  const rejectNullRows = preMigration.indexOf("RAISE EXCEPTION 'ScheduleSolveJob request identity backfill failed");
  const requireColumns = preMigration.indexOf('ALTER COLUMN "requestKeyHash" SET NOT NULL');
  assert.ok(addNullableColumns >= 0 && addNullableColumns < backfillRows);
  assert.ok(backfillRows < rejectNullRows);
  assert.ok(rejectNullRows < requireColumns);
  assert.match(preMigration, /md5\('legacy-request-key:' \|\| "id"\)/);
  assert.match(preMigration, /md5\('legacy-request:' \|\| "id"\)/);

  assert.match(schema, /model ScheduleSolveJob \{[\s\S]*requestKeyHash\s+String/);
  assert.match(schema, /model ScheduleSolveJob \{[\s\S]*requestHash\s+String/);
  assert.match(finalMigration, /ALTER COLUMN "requestKeyHash" SET NOT NULL/);
  assert.match(finalMigration, /ALTER COLUMN "requestHash" SET NOT NULL/);
  assert.match(finalMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "ScheduleSolveJob_tenantId_scheduleId_requestKeyHash_key"/);
});

test('migration runner installs RLS helper functions before dependent policy migrations', () => {
  const migrationScript = read('scripts/apply-db-migrations.mjs');
  const tenantContextSql = read('packages/db/prisma/migrations/20260712_tenant_context_helpers.sql');
  const rbacSeedSql = read('packages/db/prisma/migrations/20260716_rbac_seed_super_admin_forward_reconciliation.sql');
  const platformAdminSql = read('packages/db/prisma/migrations/20260709_platform_admin_rls.sql');
  const coreReconciliationSql = read('packages/db/prisma/migrations/20260712_core_rls_audit_forward_reconciliation.sql');
  const relationHardeningSql = read('packages/db/prisma/migrations/rls_relation_hardening.sql');
  const retentionSql = read('packages/db/prisma/migrations/20260713_audit_log_retention_authorization.sql');
  const ordered = orderMigrationFileNames([
    '20260712_core_rls_audit_forward_reconciliation.sql',
    '20260709_platform_admin_rls.sql',
    '20260716_rbac_seed_super_admin_forward_reconciliation.sql',
    '20260712_tenant_context_helpers.sql',
  ]);

  assert.equal(shouldApplyMigrationFile('init_rls.sql'), false);
  assert.equal(shouldApplyMigrationFile('audit_log.sql'), false);
  assert.deepEqual(ordered, [
    '20260712_tenant_context_helpers.sql',
    '20260709_platform_admin_rls.sql',
    '20260716_rbac_seed_super_admin_forward_reconciliation.sql',
    '20260712_core_rls_audit_forward_reconciliation.sql',
  ]);
  assert.match(tenantContextSql, /CREATE OR REPLACE FUNCTION set_current_tenant/);
  assert.match(tenantContextSql, /set_config\('app\.current_tenant', tenant_id, true\)/);
  assert.match(tenantContextSql, /CREATE OR REPLACE FUNCTION get_current_tenant/);
  assert.match(platformAdminSql, /get_current_tenant\(\)/);
  assert.match(rbacSeedSql, /INSERT INTO "RoleAssignment" \("tenantId", "userId", "roleId", "createdAt"\)/);
  assert.doesNotMatch(coreReconciliationSql, /CREATE OR REPLACE FUNCTION (?:set|get)_current_tenant/);
  assert.match(relationHardeningSql, /is_current_platform_admin\(\)/);
  assert.match(retentionSql, /purge_expired_audit_logs/);
  assert.doesNotMatch(retentionSql, /app\.allow_audit_log_delete/);
});
test('runner excludes the schema-superseded username migration from raw replay', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const reconciliationMigration = read('packages/db/prisma/migrations/20260712_historical_forward_reconciliation.sql');

  assert.equal(shouldApplyMigrationFile('20260310_username_pin_auth.sql'), false);
  assert.equal(shouldApplyMigrationFile('20260712_historical_forward_reconciliation.sql'), true);
  assert.match(schema, /username\s+String\?/);
  assert.match(schema, /pinHash\s+String\?/);
  assert.match(schema, /@@unique\(\[tenantId, username\]\)/);
  assert.match(schema, /@@index\(\[username\]\)/);
  assert.match(reconciliationMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_username_key"/);
});

test('runner replaces historical RBAC replay with assignment-safe, least-privilege seed data', () => {
  const seed = read('packages/db/prisma/migrations/20260716_rbac_seed_super_admin_forward_reconciliation.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.equal(shouldApplyMigrationFile('20260325_rbac_roles_permissions.sql'), false);
  assert.equal(shouldApplyMigrationFile('20260712_rbac_seed_forward_reconciliation.sql'), false);
  assert.equal(shouldApplyMigrationFile('20260716_rbac_seed_super_admin_forward_reconciliation.sql'), true);
  assert.match(seed, /INSERT INTO "Permission"/);
  assert.match(seed, /INSERT INTO "Role"/);
  assert.match(seed, /INSERT INTO "RolePermission"/);
  assert.match(seed, /INSERT INTO "RoleAssignment" \("tenantId", "userId", "roleId", "createdAt"\)/);
  assert.match(seed, /SELECT\s+u\."tenantId",\s+u\."id",\s+r\."id"/);
  assert.match(seed, /r\."tenantId" = u\."tenantId"/);
  assert.match(seed, /u\."role" <> 'SUPER_ADMIN'::"UserRole"/);

  const staffPermissionBranch = seed.match(
    /OR \(r\."slug" = 'staff' AND p\."key" IN \(([\s\S]*?)\n  \)\)/,
  );
  assert.ok(staffPermissionBranch, 'Staff permission seed branch must exist');
  assert.match(staffPermissionBranch[1], /'lunch_breaks:read'/);
  assert.doesNotMatch(staffPermissionBranch[1], /'lunch_breaks:write'/);
  assert.match(
    seed,
    /DELETE FROM "RolePermission" rp[\s\S]*r\."slug" = 'staff'[\s\S]*r\."isSystem" = true[\s\S]*p\."key" = 'lunch_breaks:write'/,
  );

  const assignmentSeed = seed.slice(seed.indexOf('INSERT INTO "RoleAssignment"'));
  assert.ok(assignmentSeed.length > 0, 'legacy role-assignment seed must exist');
  assert.doesNotMatch(assignmentSeed, /LEFT JOIN "RoleAssignment"/);
  const noAssignmentsClause = assignmentSeed.match(/AND NOT EXISTS \(([\s\S]*?)\n  \);/);
  assert.ok(noAssignmentsClause, 'legacy assignment seed must require zero existing assignments');
  assert.match(noAssignmentsClause[1], /FROM "RoleAssignment" existing_ra/);
  assert.match(noAssignmentsClause[1], /existing_ra\."userId" = u\."id"/);
  assert.doesNotMatch(noAssignmentsClause[1], /existing_ra\."(?:tenantId|roleId)"/);

  assert.match(migrationsReadme, /20260716_rbac_seed_super_admin_forward_reconciliation\.sql/);
  assert.match(migrationsReadme, /excludes legacy `SUPER_ADMIN`/);
  assert.match(migrationsReadme, /zero role assignments/);
  assert.match(migrationsReadme, /Staff never retains `lunch_breaks:write`/);
});

test('RBAC hardening grants tenant export only to system admins and enables staff email login', () => {
  const sql = read('packages/db/prisma/migrations/20260709_auth_rbac_p1_hardening.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(sql, /'account:data_export'/);
  assert.match(sql, /r\."legacyRole" IN \('SUPER_ADMIN', 'ADMIN'\)/);
  assert.match(sql, /p\."key" = 'auth:login_email'[\s\S]*r\."legacyRole" = 'STAFF'/);
  assert.doesNotMatch(sql, /r\."legacyRole" IN \('SUPER_ADMIN', 'ADMIN', 'MANAGER'/);
  assert.match(migrationsReadme, /20260709_auth_rbac_p1_hardening\.sql/);
});

test('password reset email delivery is encrypted, retryable, terminal, and tenant scoped', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260712_password_reset_email_outbox.sql');

  assert.match(schema, /model PasswordResetEmailOutbox/);
  assert.match(schema, /encryptedPayload\s+String/);
  assert.match(schema, /status\s+PasswordResetEmailStatus\s+@default\(PENDING\)/);
  assert.match(schema, /deadLetteredAt\s+DateTime\?/);
  assert.match(sql, /"encryptedPayload" TEXT NOT NULL/);
  assert.match(sql, /'PENDING', 'SENDING', 'FAILED', 'DELIVERED', 'DEAD_LETTERED'/);
  assert.match(sql, /PasswordResetEmailOutbox_attempts_nonnegative/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /"tenantId" = \(SELECT get_current_tenant\(\)\)/);
});
test('auth session selectors and TOTP replay claims have a forward migration contract', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260712_auth_session_selector_totp_replay.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(schema, /selectorHash\s+String\?\s+@unique/);
  assert.match(schema, /model MfaTotpClaim[\s\S]*timeStep\s+BigInt/);
  assert.match(schema, /@@unique\(\[userId, timeStep\]\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "selectorHash" TEXT/);
  assert.doesNotMatch(sql, /ADD COLUMN IF NOT EXISTS "selectorHash" TEXT NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "Session_selectorHash_key"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "MfaTotpClaim"/);
  assert.match(sql, /"timeStep" BIGINT NOT NULL/);
  assert.match(sql, /"MfaTotpClaim_userId_timeStep_key"/);
  assert.match(sql, /ALTER TABLE "MfaTotpClaim" FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY mfa_totp_claim_tenant_isolation_policy/);
  assert.match(migrationsReadme, /20260712_auth_session_selector_totp_replay\.sql/);
});
test('onboarding signup attempts are durable, platform-only, and tenant-owner idempotent', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260712_onboarding_signup_attempt_recovery.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  for (const expected of [
    'model OnboardingSignupAttempt',
    'identityOrganizationHash String    @unique',
    'challengeHash            String    @unique',
    'tenantId                 String?   @unique',
    'userId                   String?   @unique',
    'onboardingSignupAttempts',
  ]) {
    assert.ok(schema.includes(expected), `missing onboarding attempt schema fragment: ${expected}`);
  }

  assert.match(migrationsReadme, /20260712_onboarding_signup_attempt_recovery\.sql/);
  for (const expected of [
    'CREATE TABLE IF NOT EXISTS "OnboardingSignupAttempt"',
    'OnboardingSignupAttempt_otpFailedAttempts_nonnegative',
    'OnboardingSignupAttempt_otp_window_valid',
    'OnboardingSignupAttempt_recovery_state_valid',
    'OnboardingSignupAttempt_claim_pair_valid',
    'OnboardingSignupAttempt_identityOrganizationHash_key',
    'OnboardingSignupAttempt_challengeHash_key',
    'OnboardingSignupAttempt_userId_tenantId_fkey',
    'ALTER TABLE "OnboardingSignupAttempt" FORCE ROW LEVEL SECURITY',
    'CREATE POLICY onboarding_signup_attempt_platform_policy',
    'USING (is_current_platform_admin())',
    'WITH CHECK (is_current_platform_admin())',
  ]) {
    assert.ok(sql.includes(expected), `missing onboarding attempt migration fragment: ${expected}`);
  }
  assert.doesNotMatch(sql, /get_current_tenant\(\)/);

  const statements = parseSqlStatements(sql);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS "OnboardingSignupAttempt"/);
  assert.match(statements[0], /\)\s*;$/);
  assert.doesNotMatch(statements[0], /\bDO\s+\$\$/);
  assert.match(statements[1], /^DO\s+\$\$/);
});
test('deduplicates Stripe usage before Prisma enforces logical identity', () => {
  const migrationScript = read('scripts/apply-db-migrations.mjs');
  const preMigration = read(
    'packages/db/prisma/migrations/pre_20260712_stripe_usage_logical_identity.sql',
  );
  const finalMigration = read(
    'packages/db/prisma/migrations/20260712_stripe_usage_logical_identity.sql',
  );
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(migrationScript, /applyPreMigrations: \(\) => ledger\.applyAll\(inventory\.pre\)[\s\S]*\['db', 'push'/);
  assert.match(preMigration, /to_regclass\('"StripeUsageEvent"'\) IS NULL/);
  assert.match(preMigration, /ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP\(3\)/);
  assert.match(preMigration, /ROW_NUMBER\(\) OVER logical_rows/);
  assert.match(preMigration, /DELETE FROM "StripeUsageEvent"/);
  assert.match(preMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_tenantId_metric_periodStart_periodEnd_key"/);
  assert.match(finalMigration, /CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_tenantId_metric_periodStart_periodEnd_key"/);
  assert.match(migrationsReadme, /pre_20260712_stripe_usage_logical_identity\.sql/);
});
test('integration replay uses the owner migration URL', () => {
  const ci = read('.github/workflows/ci.yml');
  const workflow = yaml.load(ci);
  const integration = read('tests/integration/ephemeral-stack.test.mjs');
  const migrationStep = workflow.jobs['integration-tests'].steps.find(
    (step) => step.name === '9. Run Migrations',
  );

  assert.ok(migrationStep, 'CI must define the Stage 9 migration step');
  assert.match(ci, /"10\. Integration Tests"[\s\S]*MIGRATION_DATABASE_URL: postgresql:\/\/root:testpass@localhost:5432\/lunchlineup_test/);
  assert.equal(migrationStep.env.DATA_TARGET_ENV, 'test');
  assert.match(migrationStep.env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT, /^[a-f0-9]{64}$/);
  assert.match(integration, /requireServiceUrl\('MIGRATION_DATABASE_URL'\)/);
  assert.doesNotMatch(integration, /^\s{2}applyDatabaseMigrations\(databaseUrl\);/m);
});
