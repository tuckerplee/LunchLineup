CREATE UNIQUE INDEX IF NOT EXISTS "TimeCard_id_tenantId_key"
  ON "TimeCard"("id", "tenantId");

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS "TimeCardBreak" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "timeCardId" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TimeCardBreak_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCardBreak_tenantId_fkey'
      AND conrelid = '"TimeCardBreak"'::regclass
  ) THEN
    ALTER TABLE "TimeCardBreak"
      ADD CONSTRAINT "TimeCardBreak_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCardBreak_timeCardId_fkey'
      AND conrelid = '"TimeCardBreak"'::regclass
  ) THEN
    ALTER TABLE "TimeCardBreak"
      ADD CONSTRAINT "TimeCardBreak_timeCardId_fkey"
      FOREIGN KEY ("timeCardId") REFERENCES "TimeCard"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCardBreak_timeCardId_tenantId_fkey'
      AND conrelid = '"TimeCardBreak"'::regclass
  ) THEN
    ALTER TABLE "TimeCardBreak"
      ADD CONSTRAINT "TimeCardBreak_timeCardId_tenantId_fkey"
      FOREIGN KEY ("timeCardId", "tenantId") REFERENCES "TimeCard"("id", "tenantId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCardBreak_window_valid'
      AND conrelid = '"TimeCardBreak"'::regclass
  ) THEN
    ALTER TABLE "TimeCardBreak"
      ADD CONSTRAINT "TimeCardBreak_window_valid"
      CHECK ("endAt" > "startAt") NOT VALID;
  END IF;
END $$;

ALTER TABLE "TimeCardBreak" VALIDATE CONSTRAINT "TimeCardBreak_window_valid";
DO $$
DECLARE
  overlapping_cards RECORD;
BEGIN
  SELECT
    first_card."id" AS first_id,
    second_card."id" AS second_id,
    first_card."tenantId" AS tenant_id,
    first_card."userId" AS user_id
  INTO overlapping_cards
  FROM "TimeCard" first_card
  JOIN "TimeCard" second_card
    ON first_card."tenantId" = second_card."tenantId"
   AND first_card."userId" = second_card."userId"
   AND first_card."id" < second_card."id"
  WHERE first_card."deletedAt" IS NULL
    AND second_card."deletedAt" IS NULL
    AND first_card."status" <> 'VOID'::"TimeCardStatus"
    AND second_card."status" <> 'VOID'::"TimeCardStatus"
    AND tsrange(first_card."clockInAt", first_card."clockOutAt", '[)')
        && tsrange(second_card."clockInAt", second_card."clockOutAt", '[)')
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot add TimeCard_employee_no_overlap: time cards % and % overlap for tenant % user %',
      overlapping_cards.first_id,
      overlapping_cards.second_id,
      overlapping_cards.tenant_id,
      overlapping_cards.user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCard_employee_no_overlap'
      AND conrelid = '"TimeCard"'::regclass
  ) THEN
    ALTER TABLE "TimeCard"
      ADD CONSTRAINT "TimeCard_employee_no_overlap"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        "userId" WITH =,
        tsrange("clockInAt", "clockOutAt", '[)') WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "status" <> 'VOID'::"TimeCardStatus")
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'TimeCardBreak_no_overlap'
      AND conrelid = '"TimeCardBreak"'::regclass
  ) THEN
    ALTER TABLE "TimeCardBreak"
      ADD CONSTRAINT "TimeCardBreak_no_overlap"
      EXCLUDE USING gist (
        "timeCardId" WITH =,
        tsrange("startAt", "endAt", '[)') WITH &&
      )
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_time_card_break_window()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  card_start TIMESTAMP(3);
  card_end TIMESTAMP(3);
BEGIN
  SELECT
    card."clockInAt",
    COALESCE(card."clockOutAt", CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  INTO card_start, card_end
  FROM "TimeCard" card
  WHERE card."id" = NEW."timeCardId"
    AND card."tenantId" = NEW."tenantId"
    AND card."deletedAt" IS NULL
    AND card."status" <> 'VOID'::"TimeCardStatus";

  IF NOT FOUND OR NEW."startAt" < card_start OR NEW."endAt" > card_end THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'TimeCardBreak_parent_window_valid',
      MESSAGE = 'Time-card breaks must remain inside the active parent time card';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_card_break_window_guard ON "TimeCardBreak";
CREATE TRIGGER time_card_break_window_guard
  BEFORE INSERT OR UPDATE OF "tenantId", "timeCardId", "startAt", "endAt"
  ON "TimeCardBreak"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_time_card_break_window();

CREATE OR REPLACE FUNCTION enforce_time_card_parent_window()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TimeCardBreak" interval
    WHERE interval."tenantId" = NEW."tenantId"
      AND interval."timeCardId" = NEW."id"
      AND (
        interval."startAt" < NEW."clockInAt"
        OR interval."endAt" > COALESCE(NEW."clockOutAt", CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'TimeCard_breaks_inside_parent',
      MESSAGE = 'Corrected time-card timestamps cannot exclude retained break intervals';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_card_parent_window_guard ON "TimeCard";
CREATE TRIGGER time_card_parent_window_guard
  BEFORE UPDATE OF "clockInAt", "clockOutAt"
  ON "TimeCard"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_time_card_parent_window();

CREATE INDEX IF NOT EXISTS "TimeCardBreak_tenantId_idx"
  ON "TimeCardBreak"("tenantId");
CREATE INDEX IF NOT EXISTS "TimeCardBreak_timeCardId_startAt_idx"
  ON "TimeCardBreak"("timeCardId", "startAt");
CREATE INDEX IF NOT EXISTS "TimeCardBreak_tenantId_timeCardId_idx"
  ON "TimeCardBreak"("tenantId", "timeCardId");

ALTER TABLE "TimeCardBreak" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimeCardBreak" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS time_card_break_isolation_policy ON "TimeCardBreak";
CREATE POLICY time_card_break_isolation_policy ON "TimeCardBreak"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
