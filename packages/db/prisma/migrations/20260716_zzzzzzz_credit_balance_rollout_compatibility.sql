-- Restore old-writer compatibility if an earlier prelaunch candidate installed
-- the required-balance check before the two-release rollout boundary was fixed.
ALTER TABLE public."CreditTransaction"
  DROP CONSTRAINT IF EXISTS "CreditTransaction_balanceAfter_required_check";

COMMENT ON COLUMN public."CreditTransaction"."balanceAfter" IS
  'Immutable settlement result; nullable until retained old writers are retired';
