-- Settle terminal schedule refunds only after proving the deterministic debit
-- against the job's configured charge. This runs before the retained historical
-- backfill, which then observes the deterministic refund IDs and is a no-op.

LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "ScheduleSolveJob" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "CreditTransaction" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ScheduleSolveJob" job
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN job."creditConsumption"->>'source' = 'credits'
         AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
         AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
        THEN CASE
          WHEN (job."creditConsumption"->>'consumedCredits')::numeric <= 2147483647
          THEN (job."creditConsumption"->>'consumedCredits')::integer
          ELSE NULL
        END
        ELSE NULL
      END AS "amount"
    ) configured
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::integer AS "rowCount",
        MIN(debit."tenantId") AS "tenantId",
        MIN(debit."amount") AS "amount",
        MIN(debit."reason") AS "reason"
      FROM "CreditTransaction" debit
      WHERE debit."id" = 'schedule-credit-' || job."id"
    ) debit ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::integer AS "rowCount",
        MIN(refund."tenantId") AS "tenantId",
        MIN(refund."amount") AS "amount",
        MIN(refund."reason") AS "reason"
      FROM "CreditTransaction" refund
      WHERE refund."id" = 'schedule-credit-refund-' || job."id"
    ) refund ON TRUE
    WHERE job."status" IN ('FAILED', 'DEAD_LETTERED')
      AND (
        job."creditConsumption"->>'source' = 'credits'
        OR debit."rowCount" > 0
        OR refund."rowCount" > 0
      )
      AND (
        configured."amount" IS NULL
        OR debit."rowCount" <> 1
        OR debit."tenantId" IS DISTINCT FROM job."tenantId"
        OR debit."amount" IS DISTINCT FROM -configured."amount"
        OR debit."reason" IS DISTINCT FROM 'Schedule generation (' || job."id" || ')'
        OR refund."rowCount" NOT IN (0, 1)
        OR (
          refund."rowCount" = 1
          AND (
            refund."tenantId" IS DISTINCT FROM job."tenantId"
            OR refund."amount" IS DISTINCT FROM -debit."amount"
            OR refund."reason" IS DISTINCT FROM 'Schedule generation refund (' || job."id" || ')'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Schedule solve credit refund provenance is missing, mismatched, or duplicated';
  END IF;
END
$$;

WITH refund_candidates AS MATERIALIZED (
  SELECT
    job."id" AS "jobId",
    job."tenantId",
    debit."amount" AS "debitAmount"
  FROM "ScheduleSolveJob" job
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN job."creditConsumption"->>'source' = 'credits'
       AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
       AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
      THEN CASE
        WHEN (job."creditConsumption"->>'consumedCredits')::numeric <= 2147483647
        THEN (job."creditConsumption"->>'consumedCredits')::integer
        ELSE NULL
      END
      ELSE NULL
    END AS "amount"
  ) configured
  JOIN "CreditTransaction" debit
    ON debit."id" = 'schedule-credit-' || job."id"
   AND debit."tenantId" = job."tenantId"
  WHERE job."status" IN ('FAILED', 'DEAD_LETTERED')
    AND configured."amount" IS NOT NULL
    AND debit."amount" = -configured."amount"
    AND debit."reason" = 'Schedule generation (' || job."id" || ')'
), inserted_refunds AS (
  INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "createdAt")
  SELECT
    'schedule-credit-refund-' || candidate."jobId",
    candidate."tenantId",
    -candidate."debitAmount",
    'Schedule generation refund (' || candidate."jobId" || ')',
    CURRENT_TIMESTAMP
  FROM refund_candidates candidate
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
