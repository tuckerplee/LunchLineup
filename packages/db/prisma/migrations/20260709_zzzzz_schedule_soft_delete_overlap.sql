DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Schedule_no_overlap'
      AND conrelid = '"Schedule"'::regclass
  ) THEN
    ALTER TABLE "Schedule" DROP CONSTRAINT "Schedule_no_overlap";
  END IF;

  ALTER TABLE "Schedule"
    ADD CONSTRAINT "Schedule_no_overlap"
    EXCLUDE USING gist (
      "tenantId" WITH =,
      "locationId" WITH =,
      tsrange("startDate", "endDate", '[)') WITH &&
    )
    WHERE ("deletedAt" IS NULL)
    DEFERRABLE INITIALLY DEFERRED;
END $$;
