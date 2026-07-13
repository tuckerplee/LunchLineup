-- Backfill exactly-once wallet refunds for terminal schedule solves that
-- consumed tenant credits before failing.

WITH inserted_refunds AS (
  INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "createdAt")
  SELECT
    'schedule-credit-refund-' || job."id",
    job."tenantId",
    (job."creditConsumption"->>'consumedCredits')::integer,
    'Schedule generation refund (' || job."id" || ')',
    CURRENT_TIMESTAMP
  FROM "ScheduleSolveJob" job
  WHERE job."status" IN ('FAILED', 'DEAD_LETTERED')
    AND job."creditConsumption"->>'source' = 'credits'
    AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
    AND (job."creditConsumption"->>'consumedCredits')::integer > 0
  ON CONFLICT ("id") DO NOTHING
  RETURNING "tenantId", "amount"
)
UPDATE "Tenant" tenant
SET
  "usageCredits" = tenant."usageCredits" + refunds."amount",
  "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT "tenantId", SUM("amount")::integer AS "amount"
  FROM inserted_refunds
  GROUP BY "tenantId"
) refunds
WHERE tenant."id" = refunds."tenantId";
