-- Ledger-owned pre-schema transaction. Fresh databases have no outbox yet.
-- Stage historical unknown counters before Prisma db push can create default0.
DO $$
BEGIN
    IF to_regclass('public."NotificationOutbox"') IS NULL THEN
        RETURN;
    END IF;

    ALTER TABLE public."NotificationOutbox"
        ADD COLUMN IF NOT EXISTS "failureCount" INTEGER;

    -- Preserve every already-known nonNULL counter on rerun. Prior historical
    -- claims conservatively consume budget; this is not provider-failure proof.
    -- PROCESSING includes one currently unfinished claim, not a second failure.
    UPDATE public."NotificationOutbox"
    SET "failureCount" = CASE
        WHEN "status"::text = 'PROCESSING' THEN GREATEST("attempts" - 1, 0)
        ELSE "attempts"
    END
    WHERE "failureCount" IS NULL;

    ALTER TABLE public."NotificationOutbox"
        ALTER COLUMN "failureCount" SET DEFAULT 0,
        ALTER COLUMN "failureCount" SET NOT NULL;
END
$$;

-- No counter/status/payload reset; ledger runner owns atomic BEGIN/COMMIT.
