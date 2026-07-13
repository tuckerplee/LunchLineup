-- Enforce schedule, shift, and break integrity at the database layer.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_id_tenantId_locationId_key"
  ON "Schedule"("id", "tenantId", "locationId");

DO $$
DECLARE
  invalid_schedule RECORD;
  overlapping_schedule_pair RECORD;
  invalid_shift_user RECORD;
  invalid_shift_schedule RECORD;
  invalid_break RECORD;
  overlapping_break_pair RECORD;
BEGIN
  SELECT "id", "tenantId", "locationId", "startDate", "endDate"
  INTO invalid_schedule
  FROM "Schedule"
  WHERE "endDate" <= "startDate"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Schedule_window_valid: schedule % has endDate <= startDate', invalid_schedule."id";
  END IF;

  SELECT
    s1."id" AS first_schedule_id,
    s2."id" AS second_schedule_id,
    s1."tenantId" AS tenant_id,
    s1."locationId" AS location_id
  INTO overlapping_schedule_pair
  FROM "Schedule" s1
  JOIN "Schedule" s2
    ON s1."tenantId" = s2."tenantId"
   AND s1."locationId" = s2."locationId"
   AND s1."id" < s2."id"
  WHERE s1."startDate" < s2."endDate"
    AND s1."endDate" > s2."startDate"
    AND s1."deletedAt" IS NULL
    AND s2."deletedAt" IS NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Schedule_no_overlap: schedules % and % overlap for tenant % location %',
      overlapping_schedule_pair.first_schedule_id,
      overlapping_schedule_pair.second_schedule_id,
      overlapping_schedule_pair.tenant_id,
      overlapping_schedule_pair.location_id;
  END IF;

  SELECT s."id", s."tenantId", s."userId"
  INTO invalid_shift_user
  FROM "Shift" s
  LEFT JOIN "User" u
    ON u."id" = s."userId"
   AND u."tenantId" = s."tenantId"
  WHERE s."userId" IS NOT NULL
    AND u."id" IS NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Shift_userId_tenantId_fkey: shift % references a user outside tenant %',
      invalid_shift_user."id",
      invalid_shift_user."tenantId";
  END IF;

  SELECT s."id", s."tenantId", s."scheduleId", s."locationId"
  INTO invalid_shift_schedule
  FROM "Shift" s
  LEFT JOIN "Schedule" sch
    ON sch."id" = s."scheduleId"
   AND sch."tenantId" = s."tenantId"
   AND sch."locationId" = s."locationId"
  WHERE s."scheduleId" IS NOT NULL
    AND sch."id" IS NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Shift_scheduleId_tenantId_locationId_fkey: shift % schedule/location mismatch',
      invalid_shift_schedule."id";
  END IF;

  SELECT b."id", b."shiftId", b."startTime", b."endTime"
  INTO invalid_break
  FROM "Break" b
  JOIN "Shift" s ON s."id" = b."shiftId"
  WHERE b."endTime" <= b."startTime"
     OR b."startTime" < s."startTime"
     OR b."endTime" > s."endTime"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Break_window constraints: break % has an invalid window for shift %',
      invalid_break."id",
      invalid_break."shiftId";
  END IF;

  SELECT
    b1."id" AS first_break_id,
    b2."id" AS second_break_id,
    b1."shiftId" AS shift_id
  INTO overlapping_break_pair
  FROM "Break" b1
  JOIN "Break" b2
    ON b1."shiftId" = b2."shiftId"
   AND b1."id" < b2."id"
  WHERE b1."startTime" < b2."endTime"
    AND b1."endTime" > b2."startTime"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add Break_no_overlap: breaks % and % overlap for shift %',
      overlapping_break_pair.first_break_id,
      overlapping_break_pair.second_break_id,
      overlapping_break_pair.shift_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Schedule_window_valid'
      AND conrelid = '"Schedule"'::regclass
  ) THEN
    ALTER TABLE "Schedule"
      ADD CONSTRAINT "Schedule_window_valid"
      CHECK ("endDate" > "startDate") NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Schedule_no_overlap'
      AND conrelid = '"Schedule"'::regclass
  ) THEN
    ALTER TABLE "Schedule"
      ADD CONSTRAINT "Schedule_no_overlap"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        "locationId" WITH =,
        tsrange("startDate", "endDate", '[)') WITH &&
      )
      WHERE ("deletedAt" IS NULL)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Shift_userId_tenantId_fkey'
      AND conrelid = '"Shift"'::regclass
  ) THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Shift_scheduleId_tenantId_locationId_fkey'
      AND conrelid = '"Shift"'::regclass
  ) THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_scheduleId_tenantId_locationId_fkey"
      FOREIGN KEY ("scheduleId", "tenantId", "locationId") REFERENCES "Schedule"("id", "tenantId", "locationId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Break_window_valid'
      AND conrelid = '"Break"'::regclass
  ) THEN
    ALTER TABLE "Break"
      ADD CONSTRAINT "Break_window_valid"
      CHECK ("endTime" > "startTime") NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Break_no_overlap'
      AND conrelid = '"Break"'::regclass
  ) THEN
    ALTER TABLE "Break"
      ADD CONSTRAINT "Break_no_overlap"
      EXCLUDE USING gist (
        "shiftId" WITH =,
        tsrange("startTime", "endTime", '[)') WITH &&
      )
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_break_within_shift_window() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Shift" s
    WHERE s."id" = NEW."shiftId"
      AND NEW."startTime" >= s."startTime"
      AND NEW."endTime" <= s."endTime"
  ) THEN
    RAISE EXCEPTION 'Break % must stay within its shift window', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_shift_break_windows() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Break" b
    WHERE b."shiftId" = NEW."id"
      AND (b."startTime" < NEW."startTime" OR b."endTime" > NEW."endTime")
  ) THEN
    RAISE EXCEPTION 'Shift % cannot move outside one of its break windows', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Break_within_shift_window" ON "Break";
CREATE CONSTRAINT TRIGGER "Break_within_shift_window"
AFTER INSERT OR UPDATE OF "shiftId", "startTime", "endTime" ON "Break"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_break_within_shift_window();

DROP TRIGGER IF EXISTS "Shift_break_windows" ON "Shift";
CREATE CONSTRAINT TRIGGER "Shift_break_windows"
AFTER UPDATE OF "startTime", "endTime" ON "Shift"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_shift_break_windows();

ALTER TABLE "Schedule" VALIDATE CONSTRAINT "Schedule_window_valid";
ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_userId_tenantId_fkey";
ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_scheduleId_tenantId_locationId_fkey";
ALTER TABLE "Break" VALIDATE CONSTRAINT "Break_window_valid";
