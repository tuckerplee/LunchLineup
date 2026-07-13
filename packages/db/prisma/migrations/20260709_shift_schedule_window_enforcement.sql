-- Keep every attached shift inside the authoritative schedule interval.

DO $$
DECLARE
  invalid_shift RECORD;
BEGIN
  SELECT shift."id", shift."scheduleId"
  INTO invalid_shift
  FROM "Shift" shift
  JOIN "Schedule" schedule
    ON schedule."id" = shift."scheduleId"
   AND schedule."tenantId" = shift."tenantId"
   AND schedule."locationId" = shift."locationId"
  WHERE shift."scheduleId" IS NOT NULL
    AND (
      shift."endTime" <= shift."startTime"
      OR shift."startTime" < schedule."startDate"
      OR shift."endTime" > schedule."endDate"
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot enforce Shift schedule windows: shift % is outside schedule %',
      invalid_shift."id",
      invalid_shift."scheduleId";
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_shift_within_schedule_window() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."scheduleId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Schedule" schedule
    WHERE schedule."id" = NEW."scheduleId"
      AND schedule."tenantId" = NEW."tenantId"
      AND schedule."locationId" = NEW."locationId"
      AND NEW."endTime" > NEW."startTime"
      AND NEW."startTime" >= schedule."startDate"
      AND NEW."endTime" <= schedule."endDate"
  ) THEN
    RAISE EXCEPTION 'Shift % must stay within schedule % window', NEW."id", NEW."scheduleId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_schedule_shift_windows() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Shift" shift
    WHERE shift."scheduleId" = NEW."id"
      AND shift."tenantId" = NEW."tenantId"
      AND (
        shift."locationId" <> NEW."locationId"
        OR shift."startTime" < NEW."startDate"
        OR shift."endTime" > NEW."endDate"
      )
  ) THEN
    RAISE EXCEPTION 'Schedule % cannot move outside one of its shift windows', NEW."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Shift_within_schedule_window" ON "Shift";
CREATE CONSTRAINT TRIGGER "Shift_within_schedule_window"
AFTER INSERT OR UPDATE OF "scheduleId", "tenantId", "locationId", "startTime", "endTime" ON "Shift"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_shift_within_schedule_window();

DROP TRIGGER IF EXISTS "Schedule_shift_windows" ON "Schedule";
CREATE CONSTRAINT TRIGGER "Schedule_shift_windows"
AFTER UPDATE OF "tenantId", "locationId", "startDate", "endDate" ON "Schedule"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_schedule_shift_windows();
