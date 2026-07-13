CREATE TABLE IF NOT EXISTS "OnboardingSignupAttempt" (
  "id" TEXT NOT NULL,
  "identityOrganizationHash" TEXT NOT NULL,
  "identityHash" TEXT NOT NULL,
  "organizationHash" TEXT NOT NULL,
  "challengeHash" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "otpSentAt" TIMESTAMP(3) NOT NULL,
  "otpExpiresAt" TIMESTAMP(3) NOT NULL,
  "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
  "verifiedAt" TIMESTAMP(3),
  "recoveryExpiresAt" TIMESTAMP(3),
  "tenantId" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OnboardingSignupAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OnboardingSignupAttempt_otpFailedAttempts_nonnegative" CHECK ("otpFailedAttempts" >= 0),
  CONSTRAINT "OnboardingSignupAttempt_otp_window_valid" CHECK ("otpExpiresAt" > "otpSentAt"),
  CONSTRAINT "OnboardingSignupAttempt_recovery_state_valid" CHECK (
    ("verifiedAt" IS NULL AND "recoveryExpiresAt" IS NULL)
    OR ("verifiedAt" IS NOT NULL AND "recoveryExpiresAt" IS NOT NULL AND "recoveryExpiresAt" > "verifiedAt")
  ),
  CONSTRAINT "OnboardingSignupAttempt_claim_pair_valid" CHECK (
    ("tenantId" IS NULL AND "userId" IS NULL)
    OR ("tenantId" IS NOT NULL AND "userId" IS NOT NULL)
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_otpFailedAttempts_nonnegative'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_otpFailedAttempts_nonnegative"
      CHECK ("otpFailedAttempts" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_otp_window_valid'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_otp_window_valid"
      CHECK ("otpExpiresAt" > "otpSentAt");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_recovery_state_valid'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_recovery_state_valid"
      CHECK (
        ("verifiedAt" IS NULL AND "recoveryExpiresAt" IS NULL)
        OR ("verifiedAt" IS NOT NULL AND "recoveryExpiresAt" IS NOT NULL AND "recoveryExpiresAt" > "verifiedAt")
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_claim_pair_valid'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_claim_pair_valid"
      CHECK (
        ("tenantId" IS NULL AND "userId" IS NULL)
        OR ("tenantId" IS NOT NULL AND "userId" IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingSignupAttempt_identityOrganizationHash_key"
  ON "OnboardingSignupAttempt"("identityOrganizationHash");
CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingSignupAttempt_challengeHash_key"
  ON "OnboardingSignupAttempt"("challengeHash");
CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingSignupAttempt_tenantId_key"
  ON "OnboardingSignupAttempt"("tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "OnboardingSignupAttempt_userId_key"
  ON "OnboardingSignupAttempt"("userId");
CREATE INDEX IF NOT EXISTS "OnboardingSignupAttempt_identityHash_idx"
  ON "OnboardingSignupAttempt"("identityHash");
CREATE INDEX IF NOT EXISTS "OnboardingSignupAttempt_organizationHash_idx"
  ON "OnboardingSignupAttempt"("organizationHash");
CREATE INDEX IF NOT EXISTS "OnboardingSignupAttempt_otpExpiresAt_idx"
  ON "OnboardingSignupAttempt"("otpExpiresAt");
CREATE INDEX IF NOT EXISTS "OnboardingSignupAttempt_recoveryExpiresAt_idx"
  ON "OnboardingSignupAttempt"("recoveryExpiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_tenantId_fkey'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_userId_fkey'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingSignupAttempt_userId_tenantId_fkey'
  ) THEN
    ALTER TABLE "OnboardingSignupAttempt"
      ADD CONSTRAINT "OnboardingSignupAttempt_userId_tenantId_fkey"
      FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

END $$;

ALTER TABLE "OnboardingSignupAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingSignupAttempt" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS onboarding_signup_attempt_platform_policy ON "OnboardingSignupAttempt";
CREATE POLICY onboarding_signup_attempt_platform_policy ON "OnboardingSignupAttempt"
  USING (is_current_platform_admin())
  WITH CHECK (is_current_platform_admin());
