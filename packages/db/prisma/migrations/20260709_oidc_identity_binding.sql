ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "oidcIssuer" TEXT,
  ADD COLUMN IF NOT EXISTS "oidcSubject" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_oidcIssuer_oidcSubject_key"
  ON "User"("oidcIssuer", "oidcSubject");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'User_oidc_identity_pair_check'
      AND conrelid = '"User"'::regclass
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_oidc_identity_pair_check"
      CHECK (("oidcIssuer" IS NULL) = ("oidcSubject" IS NULL));
  END IF;
END $$;
