import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const schema = read('packages/db/prisma/schema.prisma');
const preMigration = read('packages/db/prisma/migrations/pre_20260716_payroll_controls.sql');
const migration = read('packages/db/prisma/migrations/20260716_payroll_controls.sql');

const payrollModels = [
  'PayrollPolicyVersion',
  'PayrollPeriod',
  'PayrollTimeCardApproval',
  'PayrollLockedEntry',
  'PayrollAmendment',
  'PayrollAmendmentDecision',
  'PayrollOperation',
  'PayrollExportBatch',
  'PayrollExportLine',
  'PayrollReconciliationReceipt',
  'PayrollReconciliationLineEvent',
  'PayrollReconciliationLineState',
];

const payrollEnums = new Map([
  ['PayrollCadence', ['WEEKLY', 'BIWEEKLY']],
  ['PayrollPeriodStatus', ['OPEN', 'REVIEW', 'LOCKED']],
  ['PayrollOperationKind', [
    'POLICY_CREATE',
    'PERIOD_CREATE',
    'ADOPT',
    'REVIEW',
    'APPROVAL',
    'LOCK',
    'AMENDMENT_CREATE',
    'AMENDMENT_DECISION',
    'EXPORT',
    'RECONCILE',
  ]],
  ['PayrollExportStatus', ['GENERATED', 'DOWNLOADED', 'RECONCILING', 'RECONCILED']],
  ['PayrollApprovalDecision', ['APPROVED', 'REJECTED']],
  ['PayrollSourceType', ['TIME_CARD', 'AMENDMENT']],
  ['PayrollReconciliationLineStatus', ['PENDING', 'ACCEPTED', 'REJECTED']],
]);

const payrollPermissions = new Map([
  ['time_cards:approve', 'TIME_CARDS'],
  ['payroll:read', 'PAYROLL'],
  ['payroll:policy_write', 'PAYROLL'],
  ['payroll:lock', 'PAYROLL'],
  ['payroll:export', 'PAYROLL'],
  ['payroll:reconcile', 'PAYROLL'],
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prismaBlock(kind, name) {
  const match = schema.match(new RegExp(`^${kind} ${escapeRegex(name)} \\{([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(match, `${kind} ${name} must exist in the generated Prisma schema`);
  return match[1];
}

function sqlFunction(name) {
  const match = migration.match(new RegExp(
    `CREATE OR REPLACE FUNCTION (?:public\\.)?${escapeRegex(name)}\\([\\s\\S]*?\\n\\$\\$;`,
  ));
  assert.ok(match, `SQL function ${name} must exist`);
  return match[0];
}

test('generated Prisma schema has the complete payroll model catalog and time-card snapshots', () => {
  assert.deepEqual(
    [...schema.matchAll(/^model (Payroll\w+) \{/gm)].map((match) => match[1]),
    payrollModels,
  );

  for (const model of payrollModels) {
    assert.match(prismaBlock('model', model), /\btenantId\s+String\b/);
  }

  const timeCard = prismaBlock('model', 'TimeCard');
  assert.match(timeCard, /^\s+payrollPeriodId\s+String\?/m);
  assert.match(timeCard, /^\s+workTimeZone\s+String\s+@default\("UTC"\)/m);
  assert.match(timeCard, /^\s+revision\s+Int\s+@default\(1\)/m);
  assert.match(timeCard, /@@unique\(\[id, tenantId\]\)/);
  assert.match(timeCard, /@@index\(\[tenantId, payrollPeriodId, status, deletedAt, id\]\)/);
});

test('generated Prisma schema has exact payroll enum values and PAYROLL permission category', () => {
  assert.deepEqual([...schema.matchAll(/^enum (Payroll\w+) \{/gm)].map((match) => match[1]), [...payrollEnums.keys()]);
  for (const [name, expectedValues] of payrollEnums) {
    const values = prismaBlock('enum', name)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepEqual(values, expectedValues, `${name} values drifted`);
  }
  assert.ok(
    prismaBlock('enum', 'PermissionCategory').split(/\s+/).includes('PAYROLL'),
    'PermissionCategory must include PAYROLL',
  );
});

test('pre-migration is fresh-safe, stages additive columns, and backfills location and UTC snapshots', () => {
  assert.match(preMigration, /IF to_regclass\('public\."TimeCard"'\) IS NULL THEN\s+RETURN;/);
  assert.match(preMigration, /ALTER TYPE "PermissionCategory" ADD VALUE 'PAYROLL'/);
  assert.match(preMigration, /ADD COLUMN IF NOT EXISTS "payrollPeriodId" TEXT/);
  assert.match(preMigration, /ADD COLUMN IF NOT EXISTS "workTimeZone" TEXT/);
  assert.match(preMigration, /ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1/);
  assert.match(
    preMigration,
    /SET "workTimeZone" = COALESCE\(location\."timezone", 'UTC'\)[\s\S]*card\."locationId" = location\."id"[\s\S]*card\."tenantId" = location\."tenantId"/,
  );
  assert.match(preMigration, /SET "workTimeZone" = 'UTC'\s+WHERE "workTimeZone" IS NULL/);
  assert.match(preMigration, /ALTER COLUMN "workTimeZone" SET NOT NULL/);
  assert.match(preMigration, /ADD COLUMN IF NOT EXISTS "creditTransactionId" TEXT/);
  assert.match(preMigration, /'feature-usage-payroll-export:' \|\| "operationId"/);
  assert.match(preMigration, /LEFT JOIN "CreditTransaction" ledger/);
  assert.match(preMigration, /ALTER COLUMN "creditTransactionId" SET NOT NULL/);
  assert.match(prismaBlock('model', 'PayrollExportBatch'), /^\s+creditTransactionId\s+String\s+@unique/m);
});

test('every payroll relationship has a tenant-consistent composite foreign key', () => {
  const expected = [
    ['PayrollPeriod_policy_tenant_fkey', '"policyVersionId", "tenantId"', 'PayrollPolicyVersion'],
    ['TimeCard_payroll_period_tenant_fkey', '"payrollPeriodId", "tenantId"', 'PayrollPeriod'],
    ['PayrollTimeCardApproval_period_tenant_fkey', '"periodId", "tenantId"', 'PayrollPeriod'],
    ['PayrollTimeCardApproval_card_tenant_fkey', '"timeCardId", "tenantId"', 'TimeCard'],
    ['PayrollLockedEntry_period_tenant_fkey', '"periodId", "tenantId"', 'PayrollPeriod'],
    ['PayrollAmendment_locked_entry_tenant_fkey', '"lockedEntryId", "tenantId"', 'PayrollLockedEntry'],
    ['PayrollAmendment_period_tenant_fkey', '"adjustmentPeriodId", "tenantId"', 'PayrollPeriod'],
    ['PayrollAmendmentDecision_amendment_tenant_fkey', '"amendmentId", "tenantId"', 'PayrollAmendment'],
    ['PayrollOperation_period_tenant_fkey', '"periodId", "tenantId"', 'PayrollPeriod'],
    ['PayrollExportBatch_period_tenant_fkey', '"periodId", "tenantId"', 'PayrollPeriod'],
    ['PayrollExportLine_batch_tenant_fkey', '"batchId", "tenantId"', 'PayrollExportBatch'],
    ['PayrollExportLine_entry_tenant_fkey', '"lockedEntryId", "tenantId"', 'PayrollLockedEntry'],
    ['PayrollReconciliationReceipt_batch_tenant_fkey', '"batchId", "tenantId"', 'PayrollExportBatch'],
    ['PayrollReconciliationLineEvent_receipt_tenant_fkey', '"receiptId", "tenantId"', 'PayrollReconciliationReceipt'],
    ['PayrollReconciliationLineEvent_batch_tenant_fkey', '"batchId", "tenantId"', 'PayrollExportBatch'],
    ['PayrollReconciliationLineEvent_line_tenant_fkey', '"lineId", "tenantId"', 'PayrollExportLine'],
    ['PayrollReconciliationLineState_batch_tenant_fkey', '"batchId", "tenantId"', 'PayrollExportBatch'],
    ['PayrollReconciliationLineState_line_tenant_fkey', '"lineId", "tenantId"', 'PayrollExportLine'],
    ['PayrollReconciliationLineState_receipt_tenant_fkey', '"latestReceiptId", "tenantId"', 'PayrollReconciliationReceipt'],
  ];

  for (const [constraint, columns, target] of expected) {
    assert.match(migration, new RegExp(
      `'${escapeRegex(constraint)}'[\\s\\S]*?FOREIGN KEY \\(${escapeRegex(columns)}\\) REFERENCES "${target}"\\("id", "tenantId"\\)`,
    ), `${constraint} is missing or is not tenant-consistent`);
    assert.match(
      schema,
      new RegExp(`map: "${escapeRegex(constraint)}"`),
      `${constraint} must remain Prisma-owned after raw migration replay`,
    );
  }

  for (const model of payrollModels) {
    assert.match(
      prismaBlock('model', model),
      /tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\]\)/,
      `${model} must keep its direct tenant foreign key across schema synchronization`,
    );
  }

  assert.match(
    prismaBlock('model', 'PayrollAmendmentDecision'),
    /@@unique\(\[amendmentId, tenantId\]\)/,
  );
  assert.match(
    prismaBlock('model', 'PayrollExportBatch'),
    /@@unique\(\[periodId, tenantId\]\)/,
  );
});

test('period exclusion, value checks, and tenant-leading database indexes are explicit', () => {
  assert.match(
    migration,
    /CONSTRAINT "PayrollPeriod_tenant_no_overlap"[\s\S]*EXCLUDE USING gist[\s\S]*"tenantId" WITH =[\s\S]*daterange\("localStartDate", "localEndDateExclusive", '\[\)'\) WITH &&[\s\S]*DEFERRABLE INITIALLY IMMEDIATE/,
  );
  for (const constraint of [
    'PayrollPolicyVersion_values_valid',
    'PayrollPeriod_windows_valid',
    'PayrollPeriod_snapshot_valid',
    'PayrollPeriod_review_state_valid',
    'PayrollPeriod_lock_state_valid',
    'TimeCard_payroll_snapshot_valid',
    'PayrollTimeCardApproval_values_valid',
    'PayrollLockedEntry_values_valid',
    'PayrollAmendment_values_valid',
    'PayrollAmendmentDecision_values_valid',
    'PayrollOperation_values_valid',
    'PayrollExportBatch_values_valid',
    'PayrollExportBatch_state_valid',
    'PayrollExportLine_values_valid',
    'PayrollReconciliationReceipt_values_valid',
    'PayrollReconciliationLineEvent_reason_valid',
    'PayrollReconciliationLineState_reason_valid',
  ]) {
    assert.match(migration, new RegExp(`'${constraint}'`), `${constraint} must be installed`);
  }
  for (const index of [
    'PayrollTimeCardApproval_tenant_period_decision_idx',
    'PayrollLockedEntry_tenant_period_employee_idx',
    'PayrollExportLine_tenant_batch_line_idx',
    'PayrollReconciliationLineState_tenant_batch_status_idx',
  ]) {
    assert.match(migration, new RegExp(`CREATE INDEX IF NOT EXISTS "${index}"`));
  }
});

test('all payroll tables use forced tenant RLS with the platform capability escape hatch', () => {
  const rlsLoop = migration.match(/FOREACH table_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP([\s\S]*?)END LOOP;/);
  assert.ok(rlsLoop, 'payroll RLS catalog loop is missing');
  const tables = [...rlsLoop[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(tables, payrollModels);
  assert.match(rlsLoop[2], /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
  assert.match(rlsLoop[2], /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(
    rlsLoop[2],
    /USING \(is_current_platform_admin\(\) OR "tenantId" = \(SELECT get_current_tenant\(\)\)\) WITH CHECK \(is_current_platform_admin\(\) OR "tenantId" = \(SELECT get_current_tenant\(\)\)\)/,
  );
});

test('immutable evidence and validated mutable projections have exact trigger ownership', () => {
  const expectedTriggers = new Map([
    ['PayrollPolicyVersion', ['payroll_policy_version_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollPeriod', ['payroll_period_transition_guard', 'UPDATE OR DELETE', 'enforce_payroll_period_transition']],
    ['TimeCard', ['time_card_payroll_state_guard', 'INSERT OR UPDATE OR DELETE', 'enforce_time_card_payroll_state']],
    ['TimeCardBreak', ['time_card_break_payroll_state_guard', 'INSERT OR UPDATE OR DELETE', 'enforce_time_card_break_payroll_state']],
    ['PayrollTimeCardApproval', ['payroll_time_card_approval_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollLockedEntry', ['payroll_locked_entry_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollAmendment', ['payroll_amendment_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollAmendmentDecision', ['payroll_amendment_decision_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollOperation', ['payroll_operation_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollExportBatch', ['payroll_export_batch_transition_guard', 'UPDATE OR DELETE', 'enforce_payroll_export_batch_transition']],
    ['PayrollExportLine', ['payroll_export_line_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollReconciliationReceipt', ['payroll_reconciliation_receipt_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
    ['PayrollReconciliationLineEvent', ['payroll_reconciliation_line_event_immutable_guard', 'UPDATE OR DELETE', 'block_payroll_immutable_record']],
  ]);
  for (const [table, [trigger, events, fn]] of expectedTriggers) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER ${trigger} BEFORE ${events} ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${fn}\\(\\)`),
    );
  }
  assert.match(
    migration,
    /CREATE TRIGGER payroll_reconciliation_line_state_validate_guard BEFORE INSERT OR UPDATE OR DELETE ON "PayrollReconciliationLineState" FOR EACH ROW EXECUTE FUNCTION validate_payroll_reconciliation_line_state\(\)/,
  );
});

test('policy versions allow a historical version 1 and require sequential aligned successors', () => {
  const policy = sqlFunction('validate_payroll_policy_version');
  assert.match(policy, /IF NOT FOUND THEN\s+IF NEW\."version" <> 1/);
  assert.match(policy, /NEW\."version" <> previous_version \+ 1/);
  assert.match(policy, /NEW\."effectiveFrom" <= previous_effective_from/);
  assert.match(policy, /NEW\."timeZone" <> previous_time_zone/);
  assert.match(policy, /MOD\(\(NEW\."effectiveFrom" - previous_anchor_date\), CASE WHEN previous_cadence = 'WEEKLY' THEN 7 ELSE 14 END\) <> 0/);
  assert.doesNotMatch(policy, /CURRENT_(?:DATE|TIMESTAMP)/);
  assert.match(
    migration,
    /MOD\(\("effectiveFrom" - "anchorDate"\), CASE WHEN "cadence" = ''WEEKLY'' THEN 7 ELSE 14 END\) = 0/,
  );
});

test('period, time-card, approval, lock, and export functions enforce forward-only exact snapshots', () => {
  const approval = sqlFunction('validate_payroll_approval');
  assert.match(approval, /card_revision <> NEW\."timeCardRevision"/);
  assert.match(approval, /card_status <> 'CLOSED'/);
  assert.match(approval, /period\."status" = 'REVIEW'/);
  assert.match(approval, /card_user_id = NEW\."decidedByUserId"/);

  const period = sqlFunction('enforce_payroll_period_transition');
  assert.match(period, /OLD\."status" = 'OPEN' AND NEW\."status" = 'REVIEW'/);
  assert.match(period, /OLD\."status" = 'REVIEW' AND NEW\."status" = 'LOCKED'/);
  assert.doesNotMatch(period, /OLD\."status" = 'REVIEW' AND NEW\."status" = 'OPEN'/);
  assert.match(period, /entry_count <> NEW\."lockedEntryCount" OR payable_total <> NEW\."totalPayableMinutes"/);

  const card = sqlFunction('enforce_time_card_payroll_state');
  assert.match(card, /TimeCard_payroll_review_membership/);
  assert.match(card, /NEW\."clockInAt" >= period\."startsAt"/);
  assert.match(card, /NEW\."clockInAt" < period\."endsAt"/);
  assert.match(card, /business_changed AND NEW\."revision" <> OLD\."revision" \+ 1/);

  const lockedEntry = sqlFunction('validate_payroll_locked_entry');
  assert.match(lockedEntry, /approval\."timeCardRevision" = card\."revision"/);
  assert.match(lockedEntry, /approval\."decision" = 'APPROVED'/);
  assert.match(lockedEntry, /PayrollLockedEntry_source_snapshot/);

  const exportBatch = sqlFunction('enforce_payroll_export_batch_transition');
  assert.match(exportBatch, /PayrollExportBatch_snapshot_immutable/);
  assert.match(exportBatch, /NEW\."creditTransactionId"/);
  assert.match(exportBatch, /OLD\."status" = 'GENERATED' AND NEW\."status" = 'DOWNLOADED'/);
  assert.match(exportBatch, /OLD\."status" = 'RECONCILING' AND NEW\."status" IN \('RECONCILING', 'RECONCILED'\)/);

  const exportLine = sqlFunction('validate_payroll_export_line');
  assert.match(exportLine, /NEW\."lineNumber" <> entry\."sequence" \+ 1/);
  assert.match(exportLine, /PayrollExportLine_locked_snapshot/);
  const completeExport = sqlFunction('validate_payroll_export_batch_complete');
  assert.match(completeExport, /actual_count <> NEW\."rowCount" OR actual_minutes <> NEW\."totalPayableMinutes"/);
  assert.match(completeExport, /ledger_row\."id" = NEW\."creditTransactionId"/);
  assert.match(completeExport, /ledger\."amount" <> -NEW\."consumedCredits"/);
  assert.match(completeExport, /PayrollExportBatch_credit_provenance/);
});

test('amendments carry signed deltas only into later open periods with independent decisions', () => {
  const amendment = sqlFunction('validate_payroll_amendment');
  assert.match(amendment, /source_type <> 'TIME_CARD'/);
  assert.match(amendment, /source_period_status <> 'LOCKED'/);
  assert.match(amendment, /adjustment_period_status <> 'OPEN'/);
  assert.match(amendment, /adjustment_period_starts_at < source_period_ends_at/);
  assert.match(amendment, /NEW\."replacementPayableMinutes" <> computed_payable_minutes/);
  assert.match(amendment, /NEW\."minuteDelta" <> computed_payable_minutes - source_payable_minutes/);

  const decision = sqlFunction('validate_payroll_amendment_decision');
  assert.match(decision, /NEW\."decidedByUserId" IN \(requester_id, employee_id\)/);
  assert.match(decision, /period\."status" = 'REVIEW'/);
  assert.match(decision, /other_decision\."decision" = 'APPROVED'/);

  const lockedEntry = sqlFunction('validate_payroll_locked_entry');
  assert.match(lockedEntry, /amendment\."minuteDelta"/);
  assert.match(lockedEntry, /amendment\."adjustmentPeriodId" = NEW\."periodId"/);
});

test('reconciliation state is the exact latest immutable event and can be deleted only by final purge', () => {
  const state = sqlFunction('validate_payroll_reconciliation_line_state');
  assert.match(state, /PayrollReconciliationLineState_identity/);
  assert.match(state, /event\."receiptId" = NEW\."latestReceiptId"/);
  assert.match(state, /event\."status" = NEW\."status"/);
  assert.match(state, /event\."reason" IS NOT DISTINCT FROM NEW\."reason"/);
  assert.match(state, /ROW\(later_receipt\."receivedAt", later_receipt\."id"\) > ROW\(receipt\."receivedAt", receipt\."id"\)/);
  assert.match(state, /TG_OP = 'DELETE'[\s\S]*payroll_final_purge_allowed\(\)/);
  assert.match(state, /PayrollReconciliationLineState_retained/);
  assert.match(sqlFunction('validate_payroll_reconciliation_receipt_complete'), /PayrollReconciliationReceipt_lines_complete/);
});

test('legal holds require complete all-null or all-populated state', () => {
  assert.match(
    migration,
    /'Tenant_retention_legal_hold_valid'[\s\S]*"retentionLegalHoldAt" IS NULL AND "retentionLegalHoldReason" IS NULL AND "retentionLegalHoldByUserId" IS NULL[\s\S]*"retentionLegalHoldAt" IS NOT NULL AND "retentionLegalHoldReason" IS NOT NULL[\s\S]*"retentionLegalHoldByUserId" IS NOT NULL/,
  );
});

test('legal-hold mutation is null-safe platform-only and blocks tenant deletion plus both purge stages', () => {
  const hold = sqlFunction('enforce_tenant_retention_legal_hold');
  assert.match(hold, /TG_OP = 'DELETE' AND OLD\."retentionLegalHoldAt" IS NOT NULL/);
  assert.match(
    hold,
    /public\.is_current_platform_admin\(\) IS NOT TRUE|NOT COALESCE\(public\.is_current_platform_admin\(\), FALSE\)/,
  );
  assert.match(hold, /Retention legal hold changes require platform admin capability/);
  assert.match(
    migration,
    /CREATE TRIGGER tenant_retention_legal_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON "Tenant" FOR EACH ROW EXECUTE FUNCTION enforce_tenant_retention_legal_hold\(\)/,
  );
  assert.match(sqlFunction('purge_payroll_operational_time_cards'), /"retentionLegalHoldAt" IS NULL/);
  assert.match(sqlFunction('purge_expired_payroll_records'), /"retentionLegalHoldAt" IS NULL/);
});

test('30-day operational purge is capability-gated and refuses incomplete payroll evidence', () => {
  const fn = sqlFunction('purge_payroll_operational_time_cards');
  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /SET search_path = pg_catalog, public/);
  assert.match(fn, /public\.is_current_platform_admin\(\) IS NOT TRUE|NOT COALESCE\(public\.is_current_platform_admin\(\), FALSE\)/);
  assert.match(fn, /"status" = 'PURGED'.*"deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'/s);
  assert.match(fn, /"retentionLegalHoldAt" IS NULL/);
  assert.match(fn, /"status" <> 'LOCKED'/);
  assert.match(fn, /card\."status" = 'OPEN'/);
  assert.match(fn, /entry\."sourceRevision" = card\."revision"/);
  assert.doesNotMatch(fn, /card\."deletedAt" IS NULL/);
  assert.deepEqual(
    [...fn.matchAll(/DELETE FROM public\."([^"]+)"/g)].map((match) => match[1]),
    ['TimeCardBreak', 'PayrollTimeCardApproval', 'TimeCard'],
  );
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.purge_payroll_operational_time_cards\(text\) FROM PUBLIC/);
});

test('time-card work timezone is validated once and remains an immutable work snapshot', () => {
  const fn = sqlFunction('enforce_time_card_payroll_state');
  assert.match(fn, /TG_OP = 'INSERT'.*NEW\."locationId" IS DISTINCT FROM OLD\."locationId"/s);
  assert.match(fn, /NEW\."workTimeZone" <> location_zone/);
  assert.match(fn, /NEW\."workTimeZone" IS DISTINCT FROM OLD\."workTimeZone"/);
  assert.match(fn, /TimeCard_work_timezone_immutable/);
});

test('seven-year retained purge is capability-gated and deletes dependents in foreign-key order', () => {
  const fn = sqlFunction('purge_expired_payroll_records');
  assert.match(fn, /SECURITY DEFINER/);
  assert.match(fn, /SET search_path = pg_catalog, public/);
  assert.match(fn, /public\.is_current_platform_admin\(\) IS NOT TRUE|NOT COALESCE\(public\.is_current_platform_admin\(\), FALSE\)/);
  assert.match(fn, /"deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '7 years'/);
  assert.match(fn, /"applicationDataPurgedAt" IS NOT NULL/);
  assert.match(fn, /"retentionLegalHoldAt" IS NULL/);
  assert.deepEqual(
    [...fn.matchAll(/DELETE FROM public\."([^"]+)"/g)].map((match) => match[1]),
    [
      'PayrollReconciliationLineState',
      'PayrollReconciliationLineEvent',
      'PayrollReconciliationReceipt',
      'PayrollExportLine',
      'PayrollExportBatch',
      'PayrollAmendmentDecision',
      'PayrollAmendment',
      'PayrollLockedEntry',
      'PayrollOperation',
      'PayrollTimeCardApproval',
      'PayrollPeriod',
      'PayrollPolicyVersion',
    ],
  );
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.purge_expired_payroll_records\(text\) FROM PUBLIC/);
});

test('permission catalog and system-role defaults are exact and custom roles are untouched', () => {
  const actualPermissions = new Map(
    [...migration.matchAll(/\('permission-[^']+', '([^']+)', '[^']+', '[^']+', '([^']+)'/g)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(actualPermissions, payrollPermissions);

  const fullRoleSeed = migration.match(/JOIN "Permission" permission ON permission\."key" IN \(([\s\S]*?)\)\s+WHERE role\."isSystem" = TRUE[\s\S]*?role\."legacyRole" IN \('SUPER_ADMIN', 'ADMIN'\)/);
  assert.ok(fullRoleSeed, 'Admin payroll permission defaults are missing');
  assert.deepEqual(
    [...fullRoleSeed[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    [...payrollPermissions.keys()],
  );

  const managerSeed = migration.match(/JOIN "Permission" permission ON permission\."key" IN \('time_cards:approve', 'payroll:read'\)[\s\S]*?role\."legacyRole" = 'MANAGER'/);
  assert.ok(managerSeed, 'Manager payroll permission defaults are missing');
  assert.doesNotMatch(migration, /role\."legacyRole" = 'STAFF'/);
  assert.match(migration, /role\."isSystem" = TRUE AND role\."deletedAt" IS NULL/);
});
