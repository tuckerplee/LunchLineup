-- Durable encrypted password-reset delivery with bounded worker retries.

DO $$ BEGIN
  CREATE TYPE "PasswordResetEmailStatus" AS ENUM ('PENDING', 'SENDING', 'FAILED', 'DELIVERED', 'DEAD_LETTERED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PasswordResetEmailOutbox" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "encryptedPayload" TEXT NOT NULL,
  "encryptionKeyRef" TEXT NOT NULL,
  "status" "PasswordResetEmailStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deliveredAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetEmailOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PasswordResetEmailOutbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PasswordResetEmailOutbox_attempts_nonnegative" CHECK ("attempts" >= 0),
  CONSTRAINT "PasswordResetEmailOutbox_expires_after_created" CHECK ("expiresAt" > "createdAt")
);

CREATE INDEX IF NOT EXISTS "PasswordResetEmailOutbox_status_nextAttemptAt_idx" ON "PasswordResetEmailOutbox"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "PasswordResetEmailOutbox_leaseUntil_idx" ON "PasswordResetEmailOutbox"("leaseUntil");
CREATE INDEX IF NOT EXISTS "PasswordResetEmailOutbox_tenantId_userId_idx" ON "PasswordResetEmailOutbox"("tenantId", "userId");
CREATE INDEX IF NOT EXISTS "PasswordResetEmailOutbox_expiresAt_idx" ON "PasswordResetEmailOutbox"("expiresAt");

ALTER TABLE "PasswordResetEmailOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordResetEmailOutbox" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS password_reset_email_outbox_isolation_policy ON "PasswordResetEmailOutbox";
CREATE POLICY password_reset_email_outbox_isolation_policy ON "PasswordResetEmailOutbox"
  USING (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()))
  WITH CHECK (is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant()));
