-- Add local-date staff availability overrides and time-off windows.
-- Prisma schema synchronization creates the additive table and enum before
-- this post-schema migration installs database validation and tenant RLS.

ALTER TABLE "StaffAvailabilityException"
  DROP CONSTRAINT IF EXISTS "StaffAvailabilityException_local_date_valid";
ALTER TABLE "StaffAvailabilityException"
  ADD CONSTRAINT "StaffAvailabilityException_local_date_valid"
  CHECK ("localDate" BETWEEN DATE '1970-01-01' AND DATE '2100-12-31') NOT VALID;

ALTER TABLE "StaffAvailabilityException"
  DROP CONSTRAINT IF EXISTS "StaffAvailabilityException_time_window_valid";
ALTER TABLE "StaffAvailabilityException"
  ADD CONSTRAINT "StaffAvailabilityException_time_window_valid"
  CHECK (
    "startTimeMinutes" BETWEEN 0 AND 1439
    AND "endTimeMinutes" BETWEEN 1 AND 1440
    AND "startTimeMinutes" < "endTimeMinutes"
  ) NOT VALID;

ALTER TABLE "StaffAvailabilityException"
  VALIDATE CONSTRAINT "StaffAvailabilityException_local_date_valid";
ALTER TABLE "StaffAvailabilityException"
  VALIDATE CONSTRAINT "StaffAvailabilityException_time_window_valid";

CREATE UNIQUE INDEX IF NOT EXISTS "StaffAvailabilityException_scope_window_key"
  ON "StaffAvailabilityException" (
    "tenantId",
    "userId",
    COALESCE("locationId", ''),
    "localDate",
    "kind",
    "startTimeMinutes",
    "endTimeMinutes"
  );

ALTER TABLE "StaffAvailabilityException" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StaffAvailabilityException" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS staff_availability_exception_isolation_policy
  ON "StaffAvailabilityException";
CREATE POLICY staff_availability_exception_isolation_policy
  ON "StaffAvailabilityException"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
