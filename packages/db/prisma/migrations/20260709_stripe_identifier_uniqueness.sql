-- Enforce one tenant mapping for each non-null Stripe identifier.
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_stripeCustomerId_unique_nonnull_idx"
  ON "Tenant"("stripeCustomerId")
  WHERE "stripeCustomerId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_stripeSubscriptionId_unique_nonnull_idx"
  ON "Tenant"("stripeSubscriptionId")
  WHERE "stripeSubscriptionId" IS NOT NULL;
