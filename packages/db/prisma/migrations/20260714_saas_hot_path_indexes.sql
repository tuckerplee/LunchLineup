-- Match high-growth tenant list and timeline queries with tenant-leading indexes.
-- These are forward-only additions so an upgrade can apply them without rewriting data.

CREATE INDEX IF NOT EXISTS "User_tenantId_deletedAt_createdAt_id_idx"
  ON "User"("tenantId", "deletedAt", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "Location_tenantId_deletedAt_name_id_idx"
  ON "Location"("tenantId", "deletedAt", "name", "id");

CREATE INDEX IF NOT EXISTS "Schedule_tenantId_deletedAt_startDate_id_idx"
  ON "Schedule"("tenantId", "deletedAt", "startDate" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "Shift_tenantId_deletedAt_startTime_id_idx"
  ON "Shift"("tenantId", "deletedAt", "startTime", "id");

CREATE INDEX IF NOT EXISTS "TimeCard_tenantId_deletedAt_clockInAt_id_idx"
  ON "TimeCard"("tenantId", "deletedAt", "clockInAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "TimeCard_tenantId_userId_deletedAt_clockInAt_id_idx"
  ON "TimeCard"("tenantId", "userId", "deletedAt", "clockInAt" DESC, "id" DESC);