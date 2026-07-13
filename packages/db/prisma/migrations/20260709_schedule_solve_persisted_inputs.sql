-- Persist schedule solver inputs and immutable solve-job input snapshots.

CREATE TABLE IF NOT EXISTS "StaffAvailability" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "locationId" TEXT,
  "dayOfWeek" INTEGER NOT NULL,
  "startTimeMinutes" INTEGER NOT NULL,
  "endTimeMinutes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StaffSkill" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "skill" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffSkill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScheduleDemandWindow" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "scheduleId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL,
  "endTime" TIMESTAMP(3) NOT NULL,
  "requiredStaff" INTEGER NOT NULL DEFAULT 1,
  "skill" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduleDemandWindow_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ScheduleSolveJob"
  ADD COLUMN IF NOT EXISTS "staffSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "demandSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "StaffAvailability_tenantId_idx"
  ON "StaffAvailability"("tenantId");
CREATE INDEX IF NOT EXISTS "StaffAvailability_userId_idx"
  ON "StaffAvailability"("userId");
CREATE INDEX IF NOT EXISTS "StaffAvailability_locationId_idx"
  ON "StaffAvailability"("locationId");
CREATE INDEX IF NOT EXISTS "StaffAvailability_tenant_user_day_start_idx"
  ON "StaffAvailability"("tenantId", "userId", "dayOfWeek", "startTimeMinutes");
CREATE INDEX IF NOT EXISTS "StaffAvailability_tenant_location_day_start_idx"
  ON "StaffAvailability"("tenantId", "locationId", "dayOfWeek", "startTimeMinutes");

CREATE UNIQUE INDEX IF NOT EXISTS "StaffSkill_tenantId_userId_skill_key"
  ON "StaffSkill"("tenantId", "userId", "skill");
CREATE INDEX IF NOT EXISTS "StaffSkill_tenantId_idx"
  ON "StaffSkill"("tenantId");
CREATE INDEX IF NOT EXISTS "StaffSkill_userId_idx"
  ON "StaffSkill"("userId");
CREATE INDEX IF NOT EXISTS "StaffSkill_tenant_skill_idx"
  ON "StaffSkill"("tenantId", "skill");

CREATE INDEX IF NOT EXISTS "ScheduleDemandWindow_tenantId_idx"
  ON "ScheduleDemandWindow"("tenantId");
CREATE INDEX IF NOT EXISTS "ScheduleDemandWindow_scheduleId_idx"
  ON "ScheduleDemandWindow"("scheduleId");
CREATE INDEX IF NOT EXISTS "ScheduleDemandWindow_locationId_idx"
  ON "ScheduleDemandWindow"("locationId");
CREATE INDEX IF NOT EXISTS "ScheduleDemandWindow_tenant_schedule_start_idx"
  ON "ScheduleDemandWindow"("tenantId", "scheduleId", "startTime");
CREATE INDEX IF NOT EXISTS "ScheduleDemandWindow_tenant_location_start_idx"
  ON "ScheduleDemandWindow"("tenantId", "locationId", "startTime");

DO $$
DECLARE
  invalid_availability RECORD;
  invalid_skill RECORD;
  invalid_demand RECORD;
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
    RAISE EXCEPTION 'Cannot add StaffAvailability constraints: row % has an invalid day or time window',
      invalid_availability."id";
  END IF;

  SELECT "id"
  INTO invalid_skill
  FROM "StaffSkill"
  WHERE length(btrim("skill")) = 0
     OR length("skill") > 64
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add StaffSkill constraints: row % has an invalid skill',
      invalid_skill."id";
  END IF;

  SELECT d."id"
  INTO invalid_demand
  FROM "ScheduleDemandWindow" d
  LEFT JOIN "Schedule" s
    ON s."id" = d."scheduleId"
   AND s."tenantId" = d."tenantId"
   AND s."locationId" = d."locationId"
  WHERE d."requiredStaff" <= 0
     OR d."endTime" <= d."startTime"
     OR s."id" IS NULL
     OR d."startTime" < s."startDate"
     OR d."endTime" > s."endDate"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add ScheduleDemandWindow constraints: row % is invalid or outside its schedule window',
      invalid_demand."id";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffAvailability_tenantId_fkey'
      AND conrelid = '"StaffAvailability"'::regclass
  ) THEN
    ALTER TABLE "StaffAvailability"
      ADD CONSTRAINT "StaffAvailability_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffAvailability_userId_tenantId_fkey'
      AND conrelid = '"StaffAvailability"'::regclass
  ) THEN
    ALTER TABLE "StaffAvailability"
      ADD CONSTRAINT "StaffAvailability_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffAvailability_locationId_tenantId_fkey'
      AND conrelid = '"StaffAvailability"'::regclass
  ) THEN
    ALTER TABLE "StaffAvailability"
      ADD CONSTRAINT "StaffAvailability_locationId_tenantId_fkey"
      FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffAvailability_dayOfWeek_valid'
      AND conrelid = '"StaffAvailability"'::regclass
  ) THEN
    ALTER TABLE "StaffAvailability"
      ADD CONSTRAINT "StaffAvailability_dayOfWeek_valid"
      CHECK ("dayOfWeek" BETWEEN 0 AND 6) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffAvailability_time_window_valid'
      AND conrelid = '"StaffAvailability"'::regclass
  ) THEN
    ALTER TABLE "StaffAvailability"
      ADD CONSTRAINT "StaffAvailability_time_window_valid"
      CHECK (
        "startTimeMinutes" BETWEEN 0 AND 1439
        AND "endTimeMinutes" BETWEEN 0 AND 1439
        AND "startTimeMinutes" <> "endTimeMinutes"
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffSkill_tenantId_fkey'
      AND conrelid = '"StaffSkill"'::regclass
  ) THEN
    ALTER TABLE "StaffSkill"
      ADD CONSTRAINT "StaffSkill_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffSkill_userId_tenantId_fkey'
      AND conrelid = '"StaffSkill"'::regclass
  ) THEN
    ALTER TABLE "StaffSkill"
      ADD CONSTRAINT "StaffSkill_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StaffSkill_skill_nonempty'
      AND conrelid = '"StaffSkill"'::regclass
  ) THEN
    ALTER TABLE "StaffSkill"
      ADD CONSTRAINT "StaffSkill_skill_nonempty"
      CHECK (length(btrim("skill")) > 0 AND length("skill") <= 64) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ScheduleDemandWindow_tenantId_fkey'
      AND conrelid = '"ScheduleDemandWindow"'::regclass
  ) THEN
    ALTER TABLE "ScheduleDemandWindow"
      ADD CONSTRAINT "ScheduleDemandWindow_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ScheduleDemandWindow_scheduleId_tenantId_locationId_fkey'
      AND conrelid = '"ScheduleDemandWindow"'::regclass
  ) THEN
    ALTER TABLE "ScheduleDemandWindow"
      ADD CONSTRAINT "ScheduleDemandWindow_scheduleId_tenantId_locationId_fkey"
      FOREIGN KEY ("scheduleId", "tenantId", "locationId") REFERENCES "Schedule"("id", "tenantId", "locationId")
      ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ScheduleDemandWindow_locationId_tenantId_fkey'
      AND conrelid = '"ScheduleDemandWindow"'::regclass
  ) THEN
    ALTER TABLE "ScheduleDemandWindow"
      ADD CONSTRAINT "ScheduleDemandWindow_locationId_tenantId_fkey"
      FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ScheduleDemandWindow_requiredStaff_positive'
      AND conrelid = '"ScheduleDemandWindow"'::regclass
  ) THEN
    ALTER TABLE "ScheduleDemandWindow"
      ADD CONSTRAINT "ScheduleDemandWindow_requiredStaff_positive"
      CHECK ("requiredStaff" > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ScheduleDemandWindow_window_valid'
      AND conrelid = '"ScheduleDemandWindow"'::regclass
  ) THEN
    ALTER TABLE "ScheduleDemandWindow"
      ADD CONSTRAINT "ScheduleDemandWindow_window_valid"
      CHECK ("endTime" > "startTime") NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_schedule_demand_window() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Schedule" s
    WHERE s."id" = NEW."scheduleId"
      AND s."tenantId" = NEW."tenantId"
      AND s."locationId" = NEW."locationId"
      AND NEW."startTime" >= s."startDate"
      AND NEW."endTime" <= s."endDate"
  ) THEN
    RAISE EXCEPTION 'ScheduleDemandWindow % must stay inside its schedule window', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ScheduleDemandWindow_within_schedule" ON "ScheduleDemandWindow";
CREATE CONSTRAINT TRIGGER "ScheduleDemandWindow_within_schedule"
AFTER INSERT OR UPDATE OF "scheduleId", "tenantId", "locationId", "startTime", "endTime" ON "ScheduleDemandWindow"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_schedule_demand_window();

ALTER TABLE "StaffAvailability" VALIDATE CONSTRAINT "StaffAvailability_tenantId_fkey";
ALTER TABLE "StaffAvailability" VALIDATE CONSTRAINT "StaffAvailability_userId_tenantId_fkey";
ALTER TABLE "StaffAvailability" VALIDATE CONSTRAINT "StaffAvailability_locationId_tenantId_fkey";
ALTER TABLE "StaffAvailability" VALIDATE CONSTRAINT "StaffAvailability_dayOfWeek_valid";
ALTER TABLE "StaffAvailability" VALIDATE CONSTRAINT "StaffAvailability_time_window_valid";
ALTER TABLE "StaffSkill" VALIDATE CONSTRAINT "StaffSkill_tenantId_fkey";
ALTER TABLE "StaffSkill" VALIDATE CONSTRAINT "StaffSkill_userId_tenantId_fkey";
ALTER TABLE "StaffSkill" VALIDATE CONSTRAINT "StaffSkill_skill_nonempty";
ALTER TABLE "ScheduleDemandWindow" VALIDATE CONSTRAINT "ScheduleDemandWindow_tenantId_fkey";
ALTER TABLE "ScheduleDemandWindow" VALIDATE CONSTRAINT "ScheduleDemandWindow_scheduleId_tenantId_locationId_fkey";
ALTER TABLE "ScheduleDemandWindow" VALIDATE CONSTRAINT "ScheduleDemandWindow_locationId_tenantId_fkey";
ALTER TABLE "ScheduleDemandWindow" VALIDATE CONSTRAINT "ScheduleDemandWindow_requiredStaff_positive";
ALTER TABLE "ScheduleDemandWindow" VALIDATE CONSTRAINT "ScheduleDemandWindow_window_valid";

ALTER TABLE "StaffAvailability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffAvailability" FORCE ROW LEVEL SECURITY;
ALTER TABLE "StaffSkill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffSkill" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleDemandWindow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduleDemandWindow" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_availability_isolation_policy ON "StaffAvailability";
CREATE POLICY staff_availability_isolation_policy ON "StaffAvailability"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS staff_skill_isolation_policy ON "StaffSkill";
CREATE POLICY staff_skill_isolation_policy ON "StaffSkill"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));

DROP POLICY IF EXISTS schedule_demand_window_isolation_policy ON "ScheduleDemandWindow";
CREATE POLICY schedule_demand_window_isolation_policy ON "ScheduleDemandWindow"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
