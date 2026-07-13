-- Monotonic draft revision used to reject stale asynchronous schedule writes.

ALTER TABLE "Schedule"
  ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;
