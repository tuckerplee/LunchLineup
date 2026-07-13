-- Persist the request identity on a created location so lost create responses can be replayed.

ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "creationRequestKeyHash" TEXT,
  ADD COLUMN IF NOT EXISTS "creationRequestHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Location_tenantId_creationRequestKeyHash_key"
  ON "Location"("tenantId", "creationRequestKeyHash");

ALTER TABLE "Location"
  DROP CONSTRAINT IF EXISTS "Location_creation_request_pair_check";

ALTER TABLE "Location"
  ADD CONSTRAINT "Location_creation_request_pair_check"
  CHECK (("creationRequestKeyHash" IS NULL) = ("creationRequestHash" IS NULL));
