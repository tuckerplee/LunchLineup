-- Persist the exact schedule solve message and lease its RabbitMQ publication.

ALTER TABLE "ScheduleSolveJob"
  ADD COLUMN IF NOT EXISTS "queuePayload" JSONB,
  ADD COLUMN IF NOT EXISTS "publicationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "publishAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextPublishAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "publishLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publishLastError" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScheduleSolveJob_publicationStatus_check'
  ) THEN
    ALTER TABLE "ScheduleSolveJob"
      ADD CONSTRAINT "ScheduleSolveJob_publicationStatus_check"
      CHECK ("publicationStatus" IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ScheduleSolveJob_publishAttempts_nonnegative'
  ) THEN
    ALTER TABLE "ScheduleSolveJob"
      ADD CONSTRAINT "ScheduleSolveJob_publishAttempts_nonnegative"
      CHECK ("publishAttempts" >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_publication_due_idx"
  ON "ScheduleSolveJob"("publicationStatus", "nextPublishAt", "createdAt")
  WHERE "publicationStatus" IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS "ScheduleSolveJob_publication_lease_idx"
  ON "ScheduleSolveJob"("publishLeaseUntil")
  WHERE "publicationStatus" = 'PUBLISHING';
