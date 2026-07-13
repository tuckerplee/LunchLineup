-- Stable refresh selectors prevent logout from losing a race with validator
-- rotation. Existing sessions remain legacy-compatible until their next refresh.
ALTER TABLE "Session"
    ADD COLUMN IF NOT EXISTS "selectorHash" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Session_selectorHash_key"
    ON "Session"("selectorHash");

CREATE TABLE IF NOT EXISTS "MfaTotpClaim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeStep" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaTotpClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MfaTotpClaim_timeStep_check" CHECK ("timeStep" >= 0),
    CONSTRAINT "MfaTotpClaim_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MfaTotpClaim_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MfaTotpClaim_userId_timeStep_key"
    ON "MfaTotpClaim"("userId", "timeStep");

CREATE INDEX IF NOT EXISTS "MfaTotpClaim_tenantId_userId_createdAt_idx"
    ON "MfaTotpClaim"("tenantId", "userId", "createdAt");

ALTER TABLE "MfaTotpClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MfaTotpClaim" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_totp_claim_tenant_isolation_policy ON "MfaTotpClaim";
CREATE POLICY mfa_totp_claim_tenant_isolation_policy ON "MfaTotpClaim"
    USING (
        is_current_platform_admin()
        OR "tenantId" = (SELECT get_current_tenant())
    )
    WITH CHECK (
        is_current_platform_admin()
        OR (
            "tenantId" = (SELECT get_current_tenant())
            AND EXISTS (
                SELECT 1
                FROM "User" u
                WHERE u."id" = "MfaTotpClaim"."userId"
                  AND u."tenantId" = "MfaTotpClaim"."tenantId"
            )
        )
    );