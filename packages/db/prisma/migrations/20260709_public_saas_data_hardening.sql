-- Harden tenant-owned data for public SaaS operation.

-- Keep existing plan rows aligned with the application feature catalog without
-- clobbering unrelated plan metadata keys.
UPDATE "PlanDefinition"
SET
  "metadata" = jsonb_set(
    COALESCE("metadata", '{}'::jsonb),
    '{features}',
    '["scheduling","lunch_breaks","time_cards"]'::jsonb,
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" IN ('GROWTH', 'ENTERPRISE')
  AND NOT (COALESCE("metadata"->'features', '[]'::jsonb) ? 'time_cards');

INSERT INTO "Permission" ("id", "key", "label", "description", "category", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'time_cards:read', 'View time cards', 'Read clock-in and clock-out history.', 'TIME_CARDS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'time_cards:write', 'Manage time cards', 'Clock in, clock out, and update time cards.', 'TIME_CARDS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE
SET
  "label" = EXCLUDED."label",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "RolePermission" ("roleId", "permissionId", "createdAt")
SELECT
  r."id",
  p."id",
  CURRENT_TIMESTAMP
FROM "Role" r
JOIN "Permission" p
  ON (
    r."slug" = 'super-admin'
    AND p."key" IN ('time_cards:read', 'time_cards:write')
  )
  OR (
    r."slug" IN ('admin', 'manager', 'staff')
    AND p."key" IN ('time_cards:read', 'time_cards:write')
  )
WHERE r."deletedAt" IS NULL
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

DELETE FROM "RolePermission" rp
USING "Role" r, "Permission" p
WHERE rp."roleId" = r."id"
  AND rp."permissionId" = p."id"
  AND r."slug" = 'staff'
  AND p."key" = 'lunch_breaks:write';

-- Referenced composite keys let the database reject cross-tenant foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "User_id_tenantId_key" ON "User"("id", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "Location_id_tenantId_key" ON "Location"("id", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "Schedule_id_tenantId_key" ON "Schedule"("id", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_id_tenantId_key" ON "Shift"("id", "tenantId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Schedule_locationId_tenantId_fkey'
      AND conrelid = '"Schedule"'::regclass
  ) THEN
    ALTER TABLE "Schedule"
      ADD CONSTRAINT "Schedule_locationId_tenantId_fkey"
      FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Shift_locationId_tenantId_fkey'
      AND conrelid = '"Shift"'::regclass
  ) THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_locationId_tenantId_fkey"
      FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Shift_scheduleId_tenantId_fkey'
      AND conrelid = '"Shift"'::regclass
  ) THEN
    ALTER TABLE "Shift"
      ADD CONSTRAINT "Shift_scheduleId_tenantId_fkey"
      FOREIGN KEY ("scheduleId", "tenantId") REFERENCES "Schedule"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_userId_tenantId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_locationId_tenantId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_locationId_tenantId_fkey"
      FOREIGN KEY ("locationId", "tenantId") REFERENCES "Location"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_shiftId_tenantId_fkey'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_shiftId_tenantId_fkey"
      FOREIGN KEY ("shiftId", "tenantId") REFERENCES "Shift"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Notification_userId_tenantId_fkey'
      AND conrelid = '"Notification"'::regclass
  ) THEN
    ALTER TABLE "Notification"
      ADD CONSTRAINT "Notification_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AuditLog_tenantId_fkey'
      AND conrelid = '"AuditLog"'::regclass
  ) THEN
    ALTER TABLE "AuditLog"
      ADD CONSTRAINT "AuditLog_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'AuditLog_userId_tenantId_fkey'
      AND conrelid = '"AuditLog"'::regclass
  ) THEN
    ALTER TABLE "AuditLog"
      ADD CONSTRAINT "AuditLog_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_breakMinutes_nonnegative'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_breakMinutes_nonnegative"
      CHECK ("breakMinutes" >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_clock_window_valid'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_clock_window_valid"
      CHECK ("clockOutAt" IS NULL OR "clockOutAt" > "clockInAt") NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_status_clock_consistent'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_status_clock_consistent"
      CHECK (
        ("status" = 'OPEN'::"TimeCardStatus" AND "clockOutAt" IS NULL)
        OR ("status" = 'CLOSED'::"TimeCardStatus" AND "clockOutAt" IS NOT NULL)
        OR ("status" = 'VOID'::"TimeCardStatus")
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "Schedule" VALIDATE CONSTRAINT "Schedule_locationId_tenantId_fkey";
ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_locationId_tenantId_fkey";
ALTER TABLE "Shift" VALIDATE CONSTRAINT "Shift_scheduleId_tenantId_fkey";
ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_userId_tenantId_fkey";
ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_locationId_tenantId_fkey";
ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_shiftId_tenantId_fkey";
ALTER TABLE "Notification" VALIDATE CONSTRAINT "Notification_userId_tenantId_fkey";
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_tenantId_fkey";
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_userId_tenantId_fkey";
ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_breakMinutes_nonnegative";
ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_clock_window_valid";
ALTER TABLE "TimeCard" VALIDATE CONSTRAINT "TimeCard_status_clock_consistent";

CREATE UNIQUE INDEX IF NOT EXISTS "TimeCard_one_open_per_user_idx"
  ON "TimeCard"("tenantId", "userId")
  WHERE "status" = 'OPEN'::"TimeCardStatus" AND "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "TimeCard_tenant_user_status_deleted_clock_idx"
  ON "TimeCard"("tenantId", "userId", "status", "deletedAt", "clockInAt" DESC);

CREATE INDEX IF NOT EXISTS "TimeCard_tenant_location_deleted_clock_idx"
  ON "TimeCard"("tenantId", "locationId", "deletedAt", "clockInAt" DESC);

CREATE INDEX IF NOT EXISTS "Shift_tenant_location_deleted_start_idx"
  ON "Shift"("tenantId", "locationId", "deletedAt", "startTime");

CREATE INDEX IF NOT EXISTS "Shift_tenant_schedule_deleted_start_idx"
  ON "Shift"("tenantId", "scheduleId", "deletedAt", "startTime");

CREATE INDEX IF NOT EXISTS "Shift_tenant_user_deleted_start_idx"
  ON "Shift"("tenantId", "userId", "deletedAt", "startTime");

CREATE INDEX IF NOT EXISTS "Schedule_tenant_location_window_idx"
  ON "Schedule"("tenantId", "locationId", "startDate", "endDate");

CREATE INDEX IF NOT EXISTS "AuditLog_tenant_createdAt_idx"
  ON "AuditLog"("tenantId", "createdAt");
