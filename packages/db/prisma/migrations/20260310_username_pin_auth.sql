-- Add username/PIN login support while keeping email OTP for admins.
ALTER TABLE "User"
  ALTER COLUMN "email" DROP NOT NULL;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "username" TEXT,
  ADD COLUMN IF NOT EXISTS "pinHash" TEXT,
  ADD COLUMN IF NOT EXISTS "pinSetAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pinResetRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pinLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pinLockedUntil" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_tenantId_username_key'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_tenantId_username_key" UNIQUE ("tenantId", "username");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "User_username_idx" ON "User"("username");
