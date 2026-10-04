-- Forward ledger-owned transaction runs after pre migration + Prisma db push.
-- Fresh rows already have default0/nonNULL; upgraded unknown counters were
-- backfilled by pre_20261004_notification_outbox_failure_budget.sql. Never add
-- or reset the counter here; preserve retry budgets and immutable generations.
ALTER TABLE public."NotificationOutbox"
    DROP CONSTRAINT IF EXISTS "NotificationOutbox_failure_count_check";
ALTER TABLE public."NotificationOutbox"
    ADD CONSTRAINT "NotificationOutbox_failure_count_check"
        CHECK ("failureCount" >= 0 AND "failureCount" <= "attempts");

-- Reapplying validates the same bounded invariant without counter/domain writes.
-- Status/privacy, attempts, RLS, grants, FKs and triggers remain unchanged.
-- Admitted private rollout requires drained legacy workers and matching client;
-- local static tests never apply or qualify these migrations on PostgreSQL.
