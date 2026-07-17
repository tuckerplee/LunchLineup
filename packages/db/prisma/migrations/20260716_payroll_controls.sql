-- Payroll is an append-only control plane over operational time cards. Prisma
-- creates the additive tables; this migration adds cross-tenant integrity,
-- state machines, immutability, retention boundaries, RLS, and role defaults.

CREATE OR REPLACE FUNCTION pg_temp.payroll_add_constraint(
  target_table regclass,
  constraint_name text,
  definition text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = target_table AND conname = constraint_name
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', target_table, constraint_name, definition);
  END IF;
END;
$$;

SELECT pg_temp.payroll_add_constraint('"Tenant"', 'Tenant_retention_legal_hold_valid',
  'CHECK (("retentionLegalHoldAt" IS NULL AND "retentionLegalHoldReason" IS NULL AND "retentionLegalHoldByUserId" IS NULL) OR ("retentionLegalHoldAt" IS NOT NULL AND "retentionLegalHoldReason" IS NOT NULL AND char_length(btrim("retentionLegalHoldReason")) BETWEEN 5 AND 500 AND "retentionLegalHoldByUserId" IS NOT NULL AND char_length(btrim("retentionLegalHoldByUserId")) > 0))');

SELECT pg_temp.payroll_add_constraint('"PayrollPolicyVersion"', 'PayrollPolicyVersion_tenantId_fkey',
  'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollPolicyVersion"', 'PayrollPolicyVersion_values_valid',
  'CHECK ("version" > 0 AND char_length(btrim("timeZone")) BETWEEN 1 AND 100 AND "requestHash" ~ ''^[a-f0-9]{64}$'' AND MOD(("effectiveFrom" - "anchorDate"), CASE WHEN "cadence" = ''WEEKLY'' THEN 7 ELSE 14 END) = 0)');

SELECT pg_temp.payroll_add_constraint('"PayrollPeriod"', 'PayrollPeriod_tenantId_fkey',
  'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollPeriod"', 'PayrollPeriod_policy_tenant_fkey',
  'FOREIGN KEY ("policyVersionId", "tenantId") REFERENCES "PayrollPolicyVersion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollPeriod"', 'PayrollPeriod_windows_valid',
  'CHECK ("localEndDateExclusive" > "localStartDate" AND "endsAt" > "startsAt" AND "revision" >= 0)');
SELECT pg_temp.payroll_add_constraint('"PayrollPeriod"', 'PayrollPeriod_snapshot_valid',
  'CHECK (char_length(btrim("timeZone")) BETWEEN 1 AND 100)');
SELECT pg_temp.payroll_add_constraint('"PayrollPeriod"', 'PayrollPeriod_review_state_valid',
  'CHECK (("status" = ''OPEN'' AND "reviewStartedAt" IS NULL AND "reviewStartedByUserId" IS NULL) OR ("status" <> ''OPEN'' AND "reviewStartedAt" IS NOT NULL AND "reviewStartedByUserId" IS NOT NULL))');
SELECT pg_temp.payroll_add_constraint('"PayrollPeriod"', 'PayrollPeriod_lock_state_valid',
  'CHECK (("status" <> ''LOCKED'' AND "lockedAt" IS NULL AND "lockedByUserId" IS NULL AND "lockOperationId" IS NULL AND "lockRequestHash" IS NULL AND "lockedEntrySha256" IS NULL AND "lockedEntryCount" IS NULL AND "totalPayableMinutes" IS NULL) OR ("status" = ''LOCKED'' AND "lockedAt" IS NOT NULL AND "lockedByUserId" IS NOT NULL AND "lockOperationId" IS NOT NULL AND "lockRequestHash" ~ ''^[a-f0-9]{64}$'' AND "lockedEntrySha256" ~ ''^[a-f0-9]{64}$'' AND "lockedEntryCount" >= 0 AND "totalPayableMinutes" IS NOT NULL))');

CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PayrollPeriod_tenant_no_overlap'
      AND conrelid = '"PayrollPeriod"'::regclass
  ) THEN
    ALTER TABLE "PayrollPeriod"
      ADD CONSTRAINT "PayrollPeriod_tenant_no_overlap"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        daterange("localStartDate", "localEndDateExclusive", '[)') WITH &&
      ) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

SELECT pg_temp.payroll_add_constraint('"TimeCard"', 'TimeCard_payroll_period_tenant_fkey',
  'FOREIGN KEY ("payrollPeriodId", "tenantId") REFERENCES "PayrollPeriod"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"TimeCard"', 'TimeCard_payroll_snapshot_valid',
  'CHECK ("revision" > 0 AND char_length(btrim("workTimeZone")) BETWEEN 1 AND 100)');

SELECT pg_temp.payroll_add_constraint('"PayrollTimeCardApproval"', 'PayrollTimeCardApproval_period_tenant_fkey',
  'FOREIGN KEY ("periodId", "tenantId") REFERENCES "PayrollPeriod"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollTimeCardApproval"', 'PayrollTimeCardApproval_card_tenant_fkey',
  'FOREIGN KEY ("timeCardId", "tenantId") REFERENCES "TimeCard"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollTimeCardApproval"', 'PayrollTimeCardApproval_values_valid',
  'CHECK ("timeCardRevision" > 0 AND "requestHash" ~ ''^[a-f0-9]{64}$'' AND ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 5 AND 500))');

SELECT pg_temp.payroll_add_constraint('"PayrollLockedEntry"', 'PayrollLockedEntry_period_tenant_fkey',
  'FOREIGN KEY ("periodId", "tenantId") REFERENCES "PayrollPeriod"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollLockedEntry"', 'PayrollLockedEntry_values_valid',
  'CHECK ("sequence" >= 0 AND "sourceRevision" > 0 AND char_length(btrim("workTimeZone")) BETWEEN 1 AND 100 AND "clockOutAt" > "clockInAt" AND "breakMinutes" >= 0 AND "breakMinutes" < floor(EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt")) / 60)::integer AND "canonicalSha256" ~ ''^[a-f0-9]{64}$'')');

SELECT pg_temp.payroll_add_constraint('"PayrollAmendment"', 'PayrollAmendment_locked_entry_tenant_fkey',
  'FOREIGN KEY ("lockedEntryId", "tenantId") REFERENCES "PayrollLockedEntry"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollAmendment"', 'PayrollAmendment_period_tenant_fkey',
  'FOREIGN KEY ("adjustmentPeriodId", "tenantId") REFERENCES "PayrollPeriod"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollAmendment"', 'PayrollAmendment_values_valid',
  'CHECK ("requestHash" ~ ''^[a-f0-9]{64}$'' AND char_length(btrim("reason")) BETWEEN 5 AND 500 AND "replacementClockOutAt" > "replacementClockInAt" AND "replacementBreakMinutes" >= 0 AND "replacementPayableMinutes" >= 0)');

SELECT pg_temp.payroll_add_constraint('"PayrollAmendmentDecision"', 'PayrollAmendmentDecision_amendment_tenant_fkey',
  'FOREIGN KEY ("amendmentId", "tenantId") REFERENCES "PayrollAmendment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollAmendmentDecision"', 'PayrollAmendmentDecision_values_valid',
  'CHECK ("requestHash" ~ ''^[a-f0-9]{64}$'' AND ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 5 AND 500))');

SELECT pg_temp.payroll_add_constraint('"PayrollOperation"', 'PayrollOperation_period_tenant_fkey',
  'FOREIGN KEY ("periodId", "tenantId") REFERENCES "PayrollPeriod"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollOperation"', 'PayrollOperation_values_valid',
  'CHECK ("requestHash" ~ ''^[a-f0-9]{64}$'' AND jsonb_typeof("response") = ''object'')');

SELECT pg_temp.payroll_add_constraint('"PayrollExportBatch"', 'PayrollExportBatch_period_tenant_fkey',
  'FOREIGN KEY ("periodId", "tenantId") REFERENCES "PayrollPeriod"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollExportBatch"', 'PayrollExportBatch_values_valid',
  'CHECK ("requestHash" ~ ''^[a-f0-9]{64}$'' AND "contentSha256" ~ ''^[a-f0-9]{64}$'' AND "creditTransactionId" = ''feature-usage-payroll-export:'' || "operationId" AND "formatVersion" = 1 AND "rowCount" > 0 AND "consumedCredits" > 0 AND "newBalance" >= 0)');
SELECT pg_temp.payroll_add_constraint('"PayrollExportBatch"', 'PayrollExportBatch_state_valid',
  'CHECK (("status" = ''GENERATED'' AND "downloadedAt" IS NULL AND "reconciledAt" IS NULL) OR ("status" IN (''DOWNLOADED'', ''RECONCILING'') AND "downloadedAt" IS NOT NULL AND "reconciledAt" IS NULL) OR ("status" = ''RECONCILED'' AND "downloadedAt" IS NOT NULL AND "reconciledAt" IS NOT NULL))');

SELECT pg_temp.payroll_add_constraint('"PayrollExportLine"', 'PayrollExportLine_batch_tenant_fkey',
  'FOREIGN KEY ("batchId", "tenantId") REFERENCES "PayrollExportBatch"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollExportLine"', 'PayrollExportLine_entry_tenant_fkey',
  'FOREIGN KEY ("lockedEntryId", "tenantId") REFERENCES "PayrollLockedEntry"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollExportLine"', 'PayrollExportLine_values_valid',
  'CHECK ("lineNumber" > 0 AND char_length(btrim("workTimeZone")) BETWEEN 1 AND 100 AND "clockOutAt" > "clockInAt" AND "breakMinutes" >= 0 AND "canonicalSha256" ~ ''^[a-f0-9]{64}$'')');

SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationReceipt"', 'PayrollReconciliationReceipt_batch_tenant_fkey',
  'FOREIGN KEY ("batchId", "tenantId") REFERENCES "PayrollExportBatch"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationReceipt"', 'PayrollReconciliationReceipt_values_valid',
  'CHECK (char_length(btrim("provider")) BETWEEN 1 AND 100 AND char_length(btrim("providerEventId")) BETWEEN 1 AND 200 AND "payloadSha256" ~ ''^[a-f0-9]{64}$'' AND "acceptedCount" >= 0 AND "rejectedCount" >= 0 AND "pendingCount" >= 0)');

SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineEvent"', 'PayrollReconciliationLineEvent_receipt_tenant_fkey',
  'FOREIGN KEY ("receiptId", "tenantId") REFERENCES "PayrollReconciliationReceipt"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineEvent"', 'PayrollReconciliationLineEvent_batch_tenant_fkey',
  'FOREIGN KEY ("batchId", "tenantId") REFERENCES "PayrollExportBatch"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineEvent"', 'PayrollReconciliationLineEvent_line_tenant_fkey',
  'FOREIGN KEY ("lineId", "tenantId") REFERENCES "PayrollExportLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineEvent"', 'PayrollReconciliationLineEvent_reason_valid',
  'CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 500)');

SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineState"', 'PayrollReconciliationLineState_batch_tenant_fkey',
  'FOREIGN KEY ("batchId", "tenantId") REFERENCES "PayrollExportBatch"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineState"', 'PayrollReconciliationLineState_line_tenant_fkey',
  'FOREIGN KEY ("lineId", "tenantId") REFERENCES "PayrollExportLine"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineState"', 'PayrollReconciliationLineState_receipt_tenant_fkey',
  'FOREIGN KEY ("latestReceiptId", "tenantId") REFERENCES "PayrollReconciliationReceipt"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE');
SELECT pg_temp.payroll_add_constraint('"PayrollReconciliationLineState"', 'PayrollReconciliationLineState_reason_valid',
  'CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 1 AND 500)');

CREATE INDEX IF NOT EXISTS "PayrollTimeCardApproval_tenant_period_decision_idx"
  ON "PayrollTimeCardApproval"("tenantId", "periodId", "decision", "timeCardId");
CREATE INDEX IF NOT EXISTS "PayrollLockedEntry_tenant_period_employee_idx"
  ON "PayrollLockedEntry"("tenantId", "periodId", "employeeId", "sequence");
CREATE INDEX IF NOT EXISTS "PayrollExportLine_tenant_batch_line_idx"
  ON "PayrollExportLine"("tenantId", "batchId", "lineNumber");
CREATE INDEX IF NOT EXISTS "PayrollReconciliationLineState_tenant_batch_status_idx"
  ON "PayrollReconciliationLineState"("tenantId", "batchId", "status", "lineId");

CREATE OR REPLACE FUNCTION payroll_final_purge_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.is_current_platform_admin()
    AND current_setting('app.payroll_final_purge_txid', TRUE) = pg_catalog.txid_current()::text
    AND CURRENT_USER = (
      SELECT pg_catalog.pg_get_userbyid(proowner)
      FROM pg_catalog.pg_proc
      WHERE pronamespace = 'public'::pg_catalog.regnamespace
        AND proname = 'purge_expired_payroll_records'
        AND pronargs = 1
      LIMIT 1
    );
$$;

CREATE OR REPLACE FUNCTION payroll_operational_purge_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.is_current_platform_admin()
    AND current_setting('app.payroll_operational_purge_txid', TRUE) = pg_catalog.txid_current()::text
    AND CURRENT_USER = (
      SELECT pg_catalog.pg_get_userbyid(proowner)
      FROM pg_catalog.pg_proc
      WHERE pronamespace = 'public'::pg_catalog.regnamespace
        AND proname = 'purge_payroll_operational_time_cards'
        AND pronargs = 1
      LIMIT 1
    );
$$;

CREATE OR REPLACE FUNCTION block_payroll_immutable_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND payroll_final_purge_allowed() THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'PayrollTimeCardApproval' AND payroll_operational_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_TABLE_NAME || '_immutable',
    MESSAGE = 'Retained payroll evidence is immutable';
END;
$$;

CREATE OR REPLACE FUNCTION enforce_tenant_retention_legal_hold()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."retentionLegalHoldAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'Tenant_retention_legal_hold_delete', MESSAGE = 'Tenant records cannot be deleted while a retention legal hold is active';
  END IF;
  IF ((TG_OP = 'INSERT' AND NEW."retentionLegalHoldAt" IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND ROW(NEW."retentionLegalHoldAt", NEW."retentionLegalHoldReason", NEW."retentionLegalHoldByUserId")
      IS DISTINCT FROM ROW(OLD."retentionLegalHoldAt", OLD."retentionLegalHoldReason", OLD."retentionLegalHoldByUserId")))
    AND public.is_current_platform_admin() IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Retention legal hold changes require platform admin capability';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_policy_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_version integer;
  previous_time_zone text;
  previous_anchor_date date;
  previous_effective_from date;
  previous_cadence "PayrollCadence";
BEGIN
  SELECT policy."version", policy."timeZone", policy."anchorDate", policy."effectiveFrom", policy."cadence"
  INTO previous_version, previous_time_zone, previous_anchor_date, previous_effective_from, previous_cadence
  FROM "PayrollPolicyVersion" policy
  WHERE policy."tenantId" = NEW."tenantId"
  ORDER BY policy."version" DESC, policy."id" DESC
  LIMIT 1;
  IF NOT FOUND THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPolicyVersion_sequence', MESSAGE = 'The first payroll policy version must be version 1';
    END IF;
  ELSIF NEW."version" <> previous_version + 1 OR NEW."effectiveFrom" <= previous_effective_from
    OR NEW."timeZone" <> previous_time_zone
    OR MOD((NEW."effectiveFrom" - previous_anchor_date), CASE WHEN previous_cadence = 'WEEKLY' THEN 7 ELSE 14 END) <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPolicyVersion_boundary', MESSAGE = 'Payroll policy versions must be sequential and preserve an aligned timezone boundary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_payroll_period_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_count integer;
  payable_total integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_final_purge_allowed() THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPeriod_immutable', MESSAGE = 'Payroll periods are retained records';
  END IF;
  IF ROW(NEW."tenantId", NEW."policyVersionId", NEW."localStartDate", NEW."localEndDateExclusive", NEW."startsAt", NEW."endsAt", NEW."timeZone", NEW."cadence")
    IS DISTINCT FROM ROW(OLD."tenantId", OLD."policyVersionId", OLD."localStartDate", OLD."localEndDateExclusive", OLD."startsAt", OLD."endsAt", OLD."timeZone", OLD."cadence") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPeriod_snapshot_immutable', MESSAGE = 'Payroll period boundaries and policy snapshot are immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPeriod_revision_transition', MESSAGE = 'Payroll period transition must advance one revision';
  END IF;
  IF NOT (
    (OLD."status" = 'OPEN' AND NEW."status" = 'REVIEW')
    OR (OLD."status" = 'REVIEW' AND NEW."status" = 'LOCKED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPeriod_status_transition', MESSAGE = 'Invalid payroll period status transition';
  END IF;
  IF NEW."status" = 'LOCKED' THEN
    IF ROW(NEW."reviewStartedAt", NEW."reviewStartedByUserId")
      IS DISTINCT FROM ROW(OLD."reviewStartedAt", OLD."reviewStartedByUserId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPeriod_review_snapshot_immutable', MESSAGE = 'Payroll review metadata is immutable';
    END IF;
    SELECT count(*), COALESCE(sum(entry."payableMinutes"), 0)
    INTO entry_count, payable_total
    FROM "PayrollLockedEntry" entry
    WHERE entry."tenantId" = NEW."tenantId" AND entry."periodId" = NEW."id";
    IF entry_count <> NEW."lockedEntryCount" OR payable_total <> NEW."totalPayableMinutes" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollPeriod_locked_totals_match', MESSAGE = 'Locked payroll totals do not match immutable entries';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_time_card_payroll_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  location_zone text;
  business_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_operational_purge_allowed() THEN RETURN OLD; END IF;
    IF OLD."payrollPeriodId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "PayrollPeriod" period
      WHERE period."id" = OLD."payrollPeriodId" AND period."tenantId" = OLD."tenantId" AND period."status" = 'LOCKED'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_payroll_period_locked', MESSAGE = 'Locked payroll time cards require the controlled retention purge';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' OR NEW."locationId" IS DISTINCT FROM OLD."locationId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    IF NEW."locationId" IS NOT NULL THEN
      SELECT location."timezone" INTO location_zone
      FROM "Location" location
      WHERE location."id" = NEW."locationId" AND location."tenantId" = NEW."tenantId";
      IF location_zone IS NULL OR NEW."workTimeZone" <> location_zone THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_work_timezone_snapshot', MESSAGE = 'Time-card work timezone must match its location snapshot';
      END IF;
    ELSIF NEW."workTimeZone" <> 'UTC' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_locationless_timezone', MESSAGE = 'Locationless time cards use UTC';
    END IF;
  ELSIF NEW."workTimeZone" IS DISTINCT FROM OLD."workTimeZone" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_work_timezone_immutable', MESSAGE = 'Time-card work timezone snapshots are immutable';
  END IF;

  IF (TG_OP = 'INSERT' AND NEW."payrollPeriodId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "PayrollPeriod" period
    WHERE period."id" = NEW."payrollPeriodId" AND period."tenantId" = NEW."tenantId" AND period."status" <> 'OPEN'
  )) OR (TG_OP = 'UPDATE' AND NEW."payrollPeriodId" IS DISTINCT FROM OLD."payrollPeriodId" AND (
    EXISTS (
      SELECT 1 FROM "PayrollPeriod" period
      WHERE period."id" = OLD."payrollPeriodId" AND period."tenantId" = OLD."tenantId" AND period."status" <> 'OPEN'
    ) OR EXISTS (
      SELECT 1 FROM "PayrollPeriod" period
      WHERE period."id" = NEW."payrollPeriodId" AND period."tenantId" = NEW."tenantId" AND period."status" <> 'OPEN'
    )
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_payroll_review_membership', MESSAGE = 'Time-card period membership is immutable once payroll review starts';
  END IF;

  IF NEW."payrollPeriodId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PayrollPeriod" period
    WHERE period."id" = NEW."payrollPeriodId"
      AND period."tenantId" = NEW."tenantId"
      AND period."status" <> 'LOCKED'
      AND NEW."clockInAt" >= period."startsAt"
      AND NEW."clockInAt" < period."endsAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_payroll_period_assignment', MESSAGE = 'Time card must belong to its open payroll period';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (
      SELECT 1 FROM "PayrollPeriod" period
      WHERE period."tenantId" = OLD."tenantId" AND period."status" = 'LOCKED'
        AND (period."id" = OLD."payrollPeriodId" OR (OLD."clockInAt" >= period."startsAt" AND OLD."clockInAt" < period."endsAt"))
    ) OR EXISTS (
      SELECT 1 FROM "PayrollPeriod" period
      WHERE period."tenantId" = NEW."tenantId" AND period."status" = 'LOCKED'
        AND (period."id" = NEW."payrollPeriodId" OR (NEW."clockInAt" >= period."startsAt" AND NEW."clockInAt" < period."endsAt"))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_payroll_period_locked', MESSAGE = 'Time card belongs to an immutable payroll period';
    END IF;
    business_changed := ROW(NEW."tenantId", NEW."userId", NEW."locationId", NEW."shiftId", NEW."clockInAt", NEW."clockOutAt", NEW."breakMinutes", NEW."status", NEW."notes", NEW."deletedAt", NEW."payrollPeriodId", NEW."workTimeZone")
      IS DISTINCT FROM ROW(OLD."tenantId", OLD."userId", OLD."locationId", OLD."shiftId", OLD."clockInAt", OLD."clockOutAt", OLD."breakMinutes", OLD."status", OLD."notes", OLD."deletedAt", OLD."payrollPeriodId", OLD."workTimeZone");
    IF (business_changed AND NEW."revision" <> OLD."revision" + 1)
      OR (NOT business_changed AND NEW."revision" <> OLD."revision") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCard_revision_transition', MESSAGE = 'Time-card business changes must advance one revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_time_card_break_payroll_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_card_id text := COALESCE(NEW."timeCardId", OLD."timeCardId");
  target_tenant_id text := COALESCE(NEW."tenantId", OLD."tenantId");
BEGIN
  IF TG_OP = 'DELETE' AND payroll_operational_purge_allowed() THEN RETURN OLD; END IF;
  IF EXISTS (
    SELECT 1 FROM "TimeCard" card
    JOIN "PayrollPeriod" period ON period."id" = card."payrollPeriodId" AND period."tenantId" = card."tenantId"
    WHERE card."id" = target_card_id AND card."tenantId" = target_tenant_id AND period."status" = 'LOCKED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCardBreak_payroll_period_locked', MESSAGE = 'Time-card breaks belong to an immutable payroll period';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "TimeCard" card
    JOIN "PayrollTimeCardApproval" approval
      ON approval."tenantId" = card."tenantId" AND approval."timeCardId" = card."id"
      AND approval."timeCardRevision" = card."revision"
    JOIN "PayrollPeriod" period
      ON period."id" = approval."periodId" AND period."tenantId" = approval."tenantId"
    WHERE card."id" = target_card_id AND card."tenantId" = target_tenant_id AND period."status" = 'REVIEW'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'TimeCardBreak_approved_revision', MESSAGE = 'Approved time-card break evidence requires a new parent revision';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  card_user_id text;
  card_revision integer;
  card_status "TimeCardStatus";
BEGIN
  SELECT card."userId", card."revision", card."status"
  INTO card_user_id, card_revision, card_status
  FROM "TimeCard" card
  JOIN "PayrollPeriod" period ON period."id" = NEW."periodId" AND period."tenantId" = NEW."tenantId"
  WHERE card."id" = NEW."timeCardId" AND card."tenantId" = NEW."tenantId"
    AND card."payrollPeriodId" = period."id" AND period."status" = 'REVIEW';
  IF NOT FOUND OR card_status <> 'CLOSED' OR card_revision <> NEW."timeCardRevision" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollTimeCardApproval_current_revision', MESSAGE = 'Approval requires the current closed card revision in review';
  END IF;
  IF card_user_id = NEW."decidedByUserId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollTimeCardApproval_separation', MESSAGE = 'Employees cannot approve their own time cards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_locked_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_employee_id text;
  expected_location_id text;
  expected_work_time_zone text;
  expected_clock_in_at timestamptz;
  expected_clock_out_at timestamptz;
  expected_break_minutes integer;
  expected_payable_minutes integer;
  expected_approved_at timestamptz;
  expected_approved_by_user_id text;
  expected_source_revision integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PayrollPeriod" period
    WHERE period."id" = NEW."periodId" AND period."tenantId" = NEW."tenantId" AND period."status" = 'REVIEW'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollLockedEntry_review_period', MESSAGE = 'Locked entries can be materialized only during review';
  END IF;
  IF NEW."sourceType" = 'TIME_CARD' THEN
    SELECT card."userId", card."locationId", card."workTimeZone", card."clockInAt", card."clockOutAt",
      card."breakMinutes", floor(EXTRACT(EPOCH FROM (card."clockOutAt" - card."clockInAt")) / 60)::integer - card."breakMinutes",
      approval."decidedAt", approval."decidedByUserId", card."revision"
    INTO expected_employee_id, expected_location_id, expected_work_time_zone, expected_clock_in_at,
      expected_clock_out_at, expected_break_minutes, expected_payable_minutes, expected_approved_at,
      expected_approved_by_user_id, expected_source_revision
    FROM "TimeCard" card
    JOIN "PayrollTimeCardApproval" approval
      ON approval."tenantId" = card."tenantId" AND approval."periodId" = NEW."periodId"
      AND approval."timeCardId" = card."id" AND approval."timeCardRevision" = card."revision"
      AND approval."decision" = 'APPROVED'
    WHERE card."id" = NEW."sourceId" AND card."tenantId" = NEW."tenantId"
      AND card."payrollPeriodId" = NEW."periodId" AND card."status" = 'CLOSED' AND card."deletedAt" IS NULL;
  ELSIF NEW."sourceType" = 'AMENDMENT' THEN
    SELECT entry."employeeId", entry."locationId", entry."workTimeZone", amendment."replacementClockInAt",
      amendment."replacementClockOutAt", amendment."replacementBreakMinutes", amendment."minuteDelta",
      decision."decidedAt", decision."decidedByUserId", 1
    INTO expected_employee_id, expected_location_id, expected_work_time_zone, expected_clock_in_at,
      expected_clock_out_at, expected_break_minutes, expected_payable_minutes, expected_approved_at,
      expected_approved_by_user_id, expected_source_revision
    FROM "PayrollAmendment" amendment
    JOIN "PayrollAmendmentDecision" decision
      ON decision."tenantId" = amendment."tenantId" AND decision."amendmentId" = amendment."id"
      AND decision."decision" = 'APPROVED'
    JOIN "PayrollLockedEntry" entry
      ON entry."tenantId" = amendment."tenantId" AND entry."id" = amendment."lockedEntryId"
    WHERE amendment."id" = NEW."sourceId" AND amendment."tenantId" = NEW."tenantId"
      AND amendment."adjustmentPeriodId" = NEW."periodId";
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollLockedEntry_source_valid', MESSAGE = 'Payroll locked-entry source is invalid';
  END IF;
  IF NOT FOUND OR ROW(
    NEW."employeeId", NEW."locationId", NEW."workTimeZone", NEW."clockInAt", NEW."clockOutAt",
    NEW."breakMinutes", NEW."payableMinutes", NEW."approvedAt", NEW."approvedByUserId", NEW."sourceRevision"
  ) IS DISTINCT FROM ROW(
    expected_employee_id, expected_location_id, expected_work_time_zone, expected_clock_in_at, expected_clock_out_at,
    expected_break_minutes, expected_payable_minutes, expected_approved_at, expected_approved_by_user_id, expected_source_revision
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollLockedEntry_source_snapshot', MESSAGE = 'Payroll locked entry must exactly snapshot an approved source revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_amendment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_employee_id text;
  source_payable_minutes integer;
  source_type "PayrollSourceType";
  source_period_status "PayrollPeriodStatus";
  source_period_ends_at timestamptz;
  adjustment_period_status "PayrollPeriodStatus";
  adjustment_period_starts_at timestamptz;
  computed_payable_minutes integer;
BEGIN
  SELECT entry."employeeId", entry."payableMinutes", entry."sourceType", source_period."status",
    source_period."endsAt", adjustment_period."status", adjustment_period."startsAt"
  INTO source_employee_id, source_payable_minutes, source_type, source_period_status,
    source_period_ends_at, adjustment_period_status, adjustment_period_starts_at
  FROM "PayrollLockedEntry" entry
  JOIN "PayrollPeriod" source_period
    ON source_period."id" = entry."periodId" AND source_period."tenantId" = entry."tenantId"
  JOIN "PayrollPeriod" adjustment_period
    ON adjustment_period."id" = NEW."adjustmentPeriodId" AND adjustment_period."tenantId" = NEW."tenantId"
  WHERE entry."id" = NEW."lockedEntryId" AND entry."tenantId" = NEW."tenantId";
  computed_payable_minutes := floor(EXTRACT(EPOCH FROM (NEW."replacementClockOutAt" - NEW."replacementClockInAt")) / 60)::integer
    - NEW."replacementBreakMinutes";
  IF NOT FOUND OR source_type <> 'TIME_CARD' OR source_period_status <> 'LOCKED' OR adjustment_period_status <> 'OPEN'
    OR adjustment_period_starts_at < source_period_ends_at
    OR source_employee_id = NEW."requestedByUserId" OR computed_payable_minutes < 0
    OR NEW."replacementPayableMinutes" <> computed_payable_minutes
    OR NEW."minuteDelta" <> computed_payable_minutes - source_payable_minutes THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollAmendment_source_snapshot', MESSAGE = 'Payroll amendment must be a valid correction of a locked original entry into an open adjustment period';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_amendment_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requester_id text;
  employee_id text;
BEGIN
  SELECT amendment."requestedByUserId", entry."employeeId"
  INTO requester_id, employee_id
  FROM "PayrollAmendment" amendment
  JOIN "PayrollLockedEntry" entry ON entry."id" = amendment."lockedEntryId" AND entry."tenantId" = amendment."tenantId"
  WHERE amendment."id" = NEW."amendmentId" AND amendment."tenantId" = NEW."tenantId";
  IF NOT FOUND OR NEW."decidedByUserId" IN (requester_id, employee_id) OR NOT EXISTS (
    SELECT 1 FROM "PayrollAmendment" amendment
    JOIN "PayrollPeriod" period
      ON period."id" = amendment."adjustmentPeriodId" AND period."tenantId" = amendment."tenantId"
    WHERE amendment."id" = NEW."amendmentId" AND amendment."tenantId" = NEW."tenantId" AND period."status" = 'REVIEW'
  ) OR (NEW."decision" = 'APPROVED' AND EXISTS (
    SELECT 1 FROM "PayrollAmendment" current_amendment
    JOIN "PayrollAmendment" other_amendment
      ON other_amendment."tenantId" = current_amendment."tenantId"
      AND other_amendment."lockedEntryId" = current_amendment."lockedEntryId"
      AND other_amendment."id" <> current_amendment."id"
    JOIN "PayrollAmendmentDecision" other_decision
      ON other_decision."tenantId" = other_amendment."tenantId"
      AND other_decision."amendmentId" = other_amendment."id" AND other_decision."decision" = 'APPROVED'
    WHERE current_amendment."id" = NEW."amendmentId" AND current_amendment."tenantId" = NEW."tenantId"
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollAmendmentDecision_separation', MESSAGE = 'Amendment decisions require an independent approver';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_export_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry "PayrollLockedEntry"%ROWTYPE;
BEGIN
  SELECT locked_entry.* INTO entry
  FROM "PayrollExportBatch" batch
  JOIN "PayrollPeriod" period
    ON period."id" = batch."periodId" AND period."tenantId" = batch."tenantId" AND period."status" = 'LOCKED'
  JOIN "PayrollLockedEntry" locked_entry
    ON locked_entry."periodId" = batch."periodId" AND locked_entry."tenantId" = batch."tenantId"
  WHERE batch."id" = NEW."batchId" AND batch."tenantId" = NEW."tenantId"
    AND locked_entry."id" = NEW."lockedEntryId";
  IF NOT FOUND OR NEW."lineNumber" <> entry."sequence" + 1 OR ROW(
    NEW."sourceType", NEW."sourceId", NEW."employeeId", NEW."locationId", NEW."workTimeZone",
    NEW."clockInAt", NEW."clockOutAt", NEW."breakMinutes", NEW."payableMinutes"
  ) IS DISTINCT FROM ROW(
    entry."sourceType", entry."sourceId", entry."employeeId", entry."locationId", entry."workTimeZone",
    entry."clockInAt", entry."clockOutAt", entry."breakMinutes", entry."payableMinutes"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportLine_locked_snapshot', MESSAGE = 'Payroll export line must exactly snapshot a locked entry from its batch period';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_export_batch_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_count integer;
  actual_minutes integer;
  ledger "CreditTransaction"%ROWTYPE;
BEGIN
  SELECT count(*)::integer, COALESCE(sum(line."payableMinutes"), 0)::integer
  INTO actual_count, actual_minutes
  FROM "PayrollExportLine" line
  WHERE line."tenantId" = NEW."tenantId" AND line."batchId" = NEW."id";
  IF actual_count <> NEW."rowCount" OR actual_minutes <> NEW."totalPayableMinutes" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportBatch_lines_complete', MESSAGE = 'Payroll export batch totals must match its immutable lines';
  END IF;
  SELECT ledger_row.* INTO ledger
  FROM "CreditTransaction" ledger_row
  WHERE ledger_row."id" = NEW."creditTransactionId"
    AND ledger_row."tenantId" = NEW."tenantId";
  IF NOT FOUND
    OR ledger."amount" <> -NEW."consumedCredits"
    OR ledger."reason" <> 'Payroll export (' || NEW."periodId" || ')'
    OR ledger."balanceAfter" IS DISTINCT FROM NEW."newBalance" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportBatch_credit_provenance', MESSAGE = 'Payroll export batch must reference its exact immutable credit debit';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_reconciliation_line_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PayrollReconciliationReceipt" receipt
    JOIN "PayrollExportLine" line
      ON line."tenantId" = receipt."tenantId" AND line."batchId" = receipt."batchId"
    WHERE receipt."id" = NEW."receiptId" AND receipt."tenantId" = NEW."tenantId"
      AND receipt."batchId" = NEW."batchId" AND line."id" = NEW."lineId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollReconciliationLineEvent_batch_match', MESSAGE = 'Payroll reconciliation event receipt and line must belong to the same batch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_reconciliation_line_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_final_purge_allowed() THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollReconciliationLineState_retained', MESSAGE = 'Payroll reconciliation state requires the controlled retained-record purge';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW."id", NEW."tenantId", NEW."batchId", NEW."lineId")
    IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."batchId", OLD."lineId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollReconciliationLineState_identity', MESSAGE = 'Payroll reconciliation state identity is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "PayrollReconciliationLineEvent" event
    JOIN "PayrollReconciliationReceipt" receipt
      ON receipt."id" = event."receiptId" AND receipt."tenantId" = event."tenantId"
    WHERE event."tenantId" = NEW."tenantId" AND event."batchId" = NEW."batchId"
      AND event."lineId" = NEW."lineId" AND event."receiptId" = NEW."latestReceiptId"
      AND event."status" = NEW."status" AND event."reason" IS NOT DISTINCT FROM NEW."reason"
      AND NOT EXISTS (
        SELECT 1
        FROM "PayrollReconciliationLineEvent" later_event
        JOIN "PayrollReconciliationReceipt" later_receipt
          ON later_receipt."id" = later_event."receiptId" AND later_receipt."tenantId" = later_event."tenantId"
        WHERE later_event."tenantId" = event."tenantId" AND later_event."batchId" = event."batchId"
          AND later_event."lineId" = event."lineId"
          AND ROW(later_receipt."receivedAt", later_receipt."id") > ROW(receipt."receivedAt", receipt."id")
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollReconciliationLineState_latest_event', MESSAGE = 'Payroll reconciliation state must project its exact latest immutable event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_payroll_reconciliation_receipt_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  accepted_count integer;
  rejected_count integer;
  pending_count integer;
BEGIN
  SELECT count(*) FILTER (WHERE event."status" = 'ACCEPTED')::integer,
    count(*) FILTER (WHERE event."status" = 'REJECTED')::integer,
    count(*) FILTER (WHERE event."status" = 'PENDING')::integer
  INTO accepted_count, rejected_count, pending_count
  FROM "PayrollReconciliationLineEvent" event
  WHERE event."tenantId" = NEW."tenantId" AND event."receiptId" = NEW."id" AND event."batchId" = NEW."batchId";
  IF accepted_count <> NEW."acceptedCount" OR rejected_count <> NEW."rejectedCount" OR pending_count <> NEW."pendingCount"
    OR accepted_count + rejected_count + pending_count < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollReconciliationReceipt_lines_complete', MESSAGE = 'Payroll reconciliation receipt counts must match its immutable line events';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_payroll_export_batch_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF payroll_final_purge_allowed() THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportBatch_immutable', MESSAGE = 'Payroll export batches are retained records';
  END IF;
  IF ROW(NEW."id", NEW."tenantId", NEW."periodId", NEW."operationId", NEW."requestHash", NEW."creditTransactionId", NEW."formatVersion", NEW."contentSha256", NEW."rowCount", NEW."totalPayableMinutes", NEW."consumedCredits", NEW."newBalance", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."tenantId", OLD."periodId", OLD."operationId", OLD."requestHash", OLD."creditTransactionId", OLD."formatVersion", OLD."contentSha256", OLD."rowCount", OLD."totalPayableMinutes", OLD."consumedCredits", OLD."newBalance", OLD."createdAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportBatch_snapshot_immutable', MESSAGE = 'Payroll export batch content is immutable';
  END IF;
  IF (OLD."downloadedAt" IS NOT NULL AND NEW."downloadedAt" IS DISTINCT FROM OLD."downloadedAt")
    OR (OLD."reconciledAt" IS NOT NULL AND NEW."reconciledAt" IS DISTINCT FROM OLD."reconciledAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportBatch_state_time_immutable', MESSAGE = 'Payroll export transition timestamps are immutable once recorded';
  END IF;
  IF NOT (
    (OLD."status" = 'GENERATED' AND NEW."status" = 'DOWNLOADED')
    OR (OLD."status" = 'DOWNLOADED' AND NEW."status" = 'RECONCILING')
    OR (OLD."status" = 'RECONCILING' AND NEW."status" IN ('RECONCILING', 'RECONCILED'))
    OR (OLD."status" = NEW."status")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'PayrollExportBatch_status_transition', MESSAGE = 'Invalid payroll export status transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_policy_version_validate_guard ON "PayrollPolicyVersion";
DROP TRIGGER IF EXISTS tenant_retention_legal_hold_guard ON "Tenant";
CREATE TRIGGER tenant_retention_legal_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON "Tenant" FOR EACH ROW EXECUTE FUNCTION enforce_tenant_retention_legal_hold();
CREATE TRIGGER payroll_policy_version_validate_guard BEFORE INSERT ON "PayrollPolicyVersion" FOR EACH ROW EXECUTE FUNCTION validate_payroll_policy_version();
DROP TRIGGER IF EXISTS payroll_policy_version_immutable_guard ON "PayrollPolicyVersion";
CREATE TRIGGER payroll_policy_version_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollPolicyVersion" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_period_transition_guard ON "PayrollPeriod";
CREATE TRIGGER payroll_period_transition_guard BEFORE UPDATE OR DELETE ON "PayrollPeriod" FOR EACH ROW EXECUTE FUNCTION enforce_payroll_period_transition();
DROP TRIGGER IF EXISTS time_card_payroll_state_guard ON "TimeCard";
CREATE TRIGGER time_card_payroll_state_guard BEFORE INSERT OR UPDATE OR DELETE ON "TimeCard" FOR EACH ROW EXECUTE FUNCTION enforce_time_card_payroll_state();
DROP TRIGGER IF EXISTS time_card_break_payroll_state_guard ON "TimeCardBreak";
CREATE TRIGGER time_card_break_payroll_state_guard BEFORE INSERT OR UPDATE OR DELETE ON "TimeCardBreak" FOR EACH ROW EXECUTE FUNCTION enforce_time_card_break_payroll_state();
DROP TRIGGER IF EXISTS payroll_time_card_approval_validate_guard ON "PayrollTimeCardApproval";
CREATE TRIGGER payroll_time_card_approval_validate_guard BEFORE INSERT ON "PayrollTimeCardApproval" FOR EACH ROW EXECUTE FUNCTION validate_payroll_approval();
DROP TRIGGER IF EXISTS payroll_time_card_approval_immutable_guard ON "PayrollTimeCardApproval";
CREATE TRIGGER payroll_time_card_approval_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollTimeCardApproval" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_locked_entry_validate_guard ON "PayrollLockedEntry";
CREATE TRIGGER payroll_locked_entry_validate_guard BEFORE INSERT ON "PayrollLockedEntry" FOR EACH ROW EXECUTE FUNCTION validate_payroll_locked_entry();
DROP TRIGGER IF EXISTS payroll_locked_entry_immutable_guard ON "PayrollLockedEntry";
CREATE TRIGGER payroll_locked_entry_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollLockedEntry" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_amendment_immutable_guard ON "PayrollAmendment";
DROP TRIGGER IF EXISTS payroll_amendment_validate_guard ON "PayrollAmendment";
CREATE TRIGGER payroll_amendment_validate_guard BEFORE INSERT ON "PayrollAmendment" FOR EACH ROW EXECUTE FUNCTION validate_payroll_amendment();
CREATE TRIGGER payroll_amendment_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollAmendment" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_amendment_decision_validate_guard ON "PayrollAmendmentDecision";
CREATE TRIGGER payroll_amendment_decision_validate_guard BEFORE INSERT ON "PayrollAmendmentDecision" FOR EACH ROW EXECUTE FUNCTION validate_payroll_amendment_decision();
DROP TRIGGER IF EXISTS payroll_amendment_decision_immutable_guard ON "PayrollAmendmentDecision";
CREATE TRIGGER payroll_amendment_decision_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollAmendmentDecision" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_operation_immutable_guard ON "PayrollOperation";
CREATE TRIGGER payroll_operation_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollOperation" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_export_batch_transition_guard ON "PayrollExportBatch";
CREATE TRIGGER payroll_export_batch_transition_guard BEFORE UPDATE OR DELETE ON "PayrollExportBatch" FOR EACH ROW EXECUTE FUNCTION enforce_payroll_export_batch_transition();
DROP TRIGGER IF EXISTS payroll_export_batch_complete_guard ON "PayrollExportBatch";
CREATE CONSTRAINT TRIGGER payroll_export_batch_complete_guard AFTER INSERT OR UPDATE ON "PayrollExportBatch" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payroll_export_batch_complete();
DROP TRIGGER IF EXISTS payroll_export_line_immutable_guard ON "PayrollExportLine";
DROP TRIGGER IF EXISTS payroll_export_line_validate_guard ON "PayrollExportLine";
CREATE TRIGGER payroll_export_line_validate_guard BEFORE INSERT ON "PayrollExportLine" FOR EACH ROW EXECUTE FUNCTION validate_payroll_export_line();
CREATE TRIGGER payroll_export_line_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollExportLine" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_reconciliation_receipt_immutable_guard ON "PayrollReconciliationReceipt";
CREATE TRIGGER payroll_reconciliation_receipt_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollReconciliationReceipt" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_reconciliation_receipt_complete_guard ON "PayrollReconciliationReceipt";
CREATE CONSTRAINT TRIGGER payroll_reconciliation_receipt_complete_guard AFTER INSERT ON "PayrollReconciliationReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payroll_reconciliation_receipt_complete();
DROP TRIGGER IF EXISTS payroll_reconciliation_line_event_immutable_guard ON "PayrollReconciliationLineEvent";
DROP TRIGGER IF EXISTS payroll_reconciliation_line_event_validate_guard ON "PayrollReconciliationLineEvent";
CREATE TRIGGER payroll_reconciliation_line_event_validate_guard BEFORE INSERT ON "PayrollReconciliationLineEvent" FOR EACH ROW EXECUTE FUNCTION validate_payroll_reconciliation_line_event();
CREATE TRIGGER payroll_reconciliation_line_event_immutable_guard BEFORE UPDATE OR DELETE ON "PayrollReconciliationLineEvent" FOR EACH ROW EXECUTE FUNCTION block_payroll_immutable_record();
DROP TRIGGER IF EXISTS payroll_reconciliation_line_state_validate_guard ON "PayrollReconciliationLineState";
CREATE TRIGGER payroll_reconciliation_line_state_validate_guard BEFORE INSERT OR UPDATE OR DELETE ON "PayrollReconciliationLineState" FOR EACH ROW EXECUTE FUNCTION validate_payroll_reconciliation_line_state();

CREATE OR REPLACE FUNCTION public.purge_payroll_operational_time_cards(target_tenant_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  IF public.is_current_platform_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'payroll operational purge requires platform admin capability' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."Tenant"
    WHERE "id" = target_tenant_id AND "status" = 'PURGED'::public."TenantStatus"
      AND "deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days' AND "applicationDataPurgedAt" IS NULL
      AND "retentionLegalHoldAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant is not eligible for payroll operational purge' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public."PayrollPeriod" WHERE "tenantId" = target_tenant_id AND "status" <> 'LOCKED') THEN
    RAISE EXCEPTION 'all payroll periods must be locked before application-data purge' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."TimeCard" card
    WHERE card."tenantId" = target_tenant_id
      AND (
        card."status" = 'OPEN'::public."TimeCardStatus"
        OR NOT EXISTS (
          SELECT 1 FROM public."PayrollLockedEntry" entry
          WHERE entry."tenantId" = card."tenantId" AND entry."sourceType" = 'TIME_CARD'::public."PayrollSourceType"
            AND entry."sourceId" = card."id" AND entry."sourceRevision" = card."revision"
        )
      )
  ) THEN
    RAISE EXCEPTION 'time cards require current immutable payroll snapshots before purge' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.set_config('app.payroll_operational_purge_txid', pg_catalog.txid_current()::text, TRUE);
  DELETE FROM public."TimeCardBreak" WHERE "tenantId" = target_tenant_id;
  DELETE FROM public."PayrollTimeCardApproval" WHERE "tenantId" = target_tenant_id;
  DELETE FROM public."TimeCard" WHERE "tenantId" = target_tenant_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  PERFORM pg_catalog.set_config('app.payroll_operational_purge_txid', '', TRUE);
  RETURN deleted_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.payroll_operational_purge_txid', '', TRUE);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_payroll_operational_time_cards(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.purge_expired_payroll_records(target_tenant_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count bigint := 0;
  current_count bigint;
BEGIN
  IF public.is_current_platform_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'payroll retained-record purge requires platform admin capability' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."Tenant"
    WHERE "id" = target_tenant_id AND "status" = 'PURGED'::public."TenantStatus"
      AND "deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '7 years' AND "applicationDataPurgedAt" IS NOT NULL
      AND "retentionLegalHoldAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'tenant retained payroll records are not eligible for purge' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('app.payroll_final_purge_txid', pg_catalog.txid_current()::text, TRUE);
  DELETE FROM public."PayrollReconciliationLineState" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollReconciliationLineEvent" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollReconciliationReceipt" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollExportLine" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollExportBatch" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollAmendmentDecision" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollAmendment" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollLockedEntry" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollOperation" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollTimeCardApproval" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollPeriod" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  DELETE FROM public."PayrollPolicyVersion" WHERE "tenantId" = target_tenant_id; GET DIAGNOSTICS current_count = ROW_COUNT; deleted_count := deleted_count + current_count;
  PERFORM pg_catalog.set_config('app.payroll_final_purge_txid', '', TRUE);
  RETURN deleted_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.payroll_final_purge_txid', '', TRUE);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_payroll_records(text) FROM PUBLIC;

INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt") VALUES
  ('permission-time-cards-approve', 'time_cards:approve', 'Approve time cards', 'Approve or reject immutable time-card revisions for payroll.', 'TIME_CARDS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('permission-payroll-read', 'payroll:read', 'View payroll controls', 'Read payroll policies, periods, locked evidence, exports, and reconciliation.', 'PAYROLL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('permission-payroll-policy-write', 'payroll:policy_write', 'Manage payroll policy', 'Create future-effective immutable payroll policy versions.', 'PAYROLL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('permission-payroll-lock', 'payroll:lock', 'Lock payroll periods', 'Start review and irreversibly lock approved payroll periods.', 'PAYROLL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('permission-payroll-export', 'payroll:export', 'Export payroll', 'Create paid deterministic payroll export batches.', 'PAYROLL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('permission-payroll-reconcile', 'payroll:reconcile', 'Reconcile payroll', 'Create amendments and record provider reconciliation outcomes.', 'PAYROLL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET
  "label" = EXCLUDED."label", "description" = EXCLUDED."description", "category" = EXCLUDED."category", "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT role."id", permission."id", CURRENT_TIMESTAMP
FROM "Role" role
JOIN "Permission" permission ON permission."key" IN (
  'time_cards:approve', 'payroll:read', 'payroll:policy_write', 'payroll:lock', 'payroll:export', 'payroll:reconcile'
)
WHERE role."isSystem" = TRUE AND role."deletedAt" IS NULL AND role."legacyRole" IN ('SUPER_ADMIN', 'ADMIN')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT role."id", permission."id", CURRENT_TIMESTAMP
FROM "Role" role
JOIN "Permission" permission ON permission."key" IN ('time_cards:approve', 'payroll:read')
WHERE role."isSystem" = TRUE AND role."deletedAt" IS NULL AND role."legacyRole" = 'MANAGER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'PayrollPolicyVersion', 'PayrollPeriod', 'PayrollTimeCardApproval', 'PayrollLockedEntry',
    'PayrollAmendment', 'PayrollAmendmentDecision', 'PayrollOperation', 'PayrollExportBatch',
    'PayrollExportLine', 'PayrollReconciliationReceipt', 'PayrollReconciliationLineEvent',
    'PayrollReconciliationLineState'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', lower(table_name) || '_isolation_policy', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant())) WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))',
      lower(table_name) || '_isolation_policy', table_name
    );
  END LOOP;
END $$;
