ALTER TABLE "ScheduleSolveJob"
    ADD COLUMN IF NOT EXISTS "executionToken" TEXT,
    ADD COLUMN IF NOT EXISTS "executionLeaseUntil" TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ScheduleSolveJob_execution_owner_pair_check'
          AND conrelid = '"ScheduleSolveJob"'::regclass
    ) THEN
        ALTER TABLE "ScheduleSolveJob"
            ADD CONSTRAINT "ScheduleSolveJob_execution_owner_pair_check"
            CHECK (
                ("executionToken" IS NULL) = ("executionLeaseUntil" IS NULL)
                AND ("executionToken" IS NULL OR char_length("executionToken") BETWEEN 32 AND 64)
            );
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_executionLeaseUntil_idx"
    ON "ScheduleSolveJob" ("executionLeaseUntil")
    WHERE "executionToken" IS NOT NULL;
CREATE OR REPLACE FUNCTION public.scrub_terminal_schedule_solve_payload()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."status" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED') THEN
        NEW."queuePayload" := NULL;
        NEW."publishLeaseUntil" := NULL;
        NEW."publishLastError" := NULL;
        NEW."executionToken" := NULL;
        NEW."executionLeaseUntil" := NULL;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS "ScheduleSolveJob_terminal_payload_erasure"
    ON public."ScheduleSolveJob";
CREATE TRIGGER "ScheduleSolveJob_terminal_payload_erasure"
BEFORE INSERT OR UPDATE OF
    "status", "queuePayload", "publishLeaseUntil", "publishLastError",
    "executionToken", "executionLeaseUntil"
ON public."ScheduleSolveJob"
FOR EACH ROW
EXECUTE FUNCTION public.scrub_terminal_schedule_solve_payload();

UPDATE public."ScheduleSolveJob"
SET
    "queuePayload" = NULL,
    "publishLeaseUntil" = NULL,
    "publishLastError" = NULL,
    "executionToken" = NULL,
    "executionLeaseUntil" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
  AND (
      "queuePayload" IS NOT NULL
      OR "publishLeaseUntil" IS NOT NULL
      OR "publishLastError" IS NOT NULL
      OR "executionToken" IS NOT NULL
      OR "executionLeaseUntil" IS NOT NULL
  );

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ScheduleSolveJob_terminal_payload_erased_check'
          AND conrelid = 'public."ScheduleSolveJob"'::regclass
    ) THEN
        ALTER TABLE public."ScheduleSolveJob"
            ADD CONSTRAINT "ScheduleSolveJob_terminal_payload_erased_check"
            CHECK (
                "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                OR (
                    "queuePayload" IS NULL
                    AND "publishLeaseUntil" IS NULL
                    AND "publishLastError" IS NULL
                    AND "executionToken" IS NULL
                    AND "executionLeaseUntil" IS NULL
                )
            );
    END IF;
END
$$;
