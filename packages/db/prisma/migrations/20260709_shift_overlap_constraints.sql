-- Enforce assigned-shift time integrity at the database layer.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  invalid_shift RECORD;
  overlapping_shift_pair RECORD;
BEGIN
  SELECT
    s."id",
    s."tenantId",
    s."userId",
    s."startTime",
    s."endTime"
  INTO invalid_shift
  FROM "Shift" s
  WHERE s."deletedAt" IS NULL
    AND s."endTime" <= s."startTime"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Shift_window_valid: shift % has endTime <= startTime', invalid_shift."id";
  END IF;

  SELECT
    s1."id" AS first_shift_id,
    s2."id" AS second_shift_id,
    s1."tenantId" AS tenant_id,
    s1."userId" AS user_id
  INTO overlapping_shift_pair
  FROM "Shift" s1
  JOIN "Shift" s2
    ON s1."tenantId" = s2."tenantId"
   AND s1."userId" = s2."userId"
   AND s1."id" < s2."id"
  WHERE s1."deletedAt" IS NULL
    AND s2."deletedAt" IS NULL
    AND s1."userId" IS NOT NULL
    AND s2."userId" IS NOT NULL
    AND s1."startTime" < s2."endTime"
    AND s1."endTime" > s2."startTime"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Shift_assigned_no_overlap: shifts % and % overlap for tenant % user %',
      overlapping_shift_pair.first_shift_id,
      overlapping_shift_pair.second_shift_id,
      overlapping_shift_pair.tenant_id,
      overlapping_shift_pair.user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Shift_window_valid'
      AND conrelid = '"Shift"'::regclass
  ) THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_window_valid"
      CHECK ("endTime" > "startTime") NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Shift_assigned_no_overlap'
      AND conrelid = '"Shift"'::regclass
  ) THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_assigned_no_overlap"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        "userId" WITH =,
        tsrange("startTime", "endTime", '[)') WITH &&
      )
      WHERE ("userId" IS NOT NULL AND "deletedAt" IS NULL)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_window_valid";
