-- Permit same-day and overnight availability using only minute-of-day endpoints.
DO $$
DECLARE
  invalid_availability RECORD;
BEGIN
  SELECT "id"
  INTO invalid_availability
  FROM "StaffAvailability"
  WHERE "dayOfWeek" NOT BETWEEN 0 AND 6
     OR "startTimeMinutes" NOT BETWEEN 0 AND 1439
     OR "endTimeMinutes" NOT BETWEEN 0 AND 1439
     OR "startTimeMinutes" = "endTimeMinutes"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot permit overnight StaffAvailability: row % has an invalid day or time endpoint',
      invalid_availability."id";
  END IF;

  ALTER TABLE "StaffAvailability"
    DROP CONSTRAINT IF EXISTS "StaffAvailability_time_window_valid";

  ALTER TABLE "StaffAvailability"
    ADD CONSTRAINT "StaffAvailability_time_window_valid"
    CHECK (
      "startTimeMinutes" BETWEEN 0 AND 1439
      AND "endTimeMinutes" BETWEEN 0 AND 1439
      AND "startTimeMinutes" <> "endTimeMinutes"
    ) NOT VALID;
END $$;

ALTER TABLE "StaffAvailability"
  VALIDATE CONSTRAINT "StaffAvailability_time_window_valid";
