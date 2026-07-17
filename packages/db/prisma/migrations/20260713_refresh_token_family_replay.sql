-- Retain only hashes of consumed validators so a selector-matched replay can
-- terminalize its session without letting an arbitrary validator cause logout.
CREATE TABLE IF NOT EXISTS "RefreshTokenReplay" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "sessionId" TEXT NOT NULL,
    "validatorHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshTokenReplay_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RefreshTokenReplay_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshTokenReplay_validatorHash_key"
    ON "RefreshTokenReplay"("validatorHash");

CREATE INDEX IF NOT EXISTS "RefreshTokenReplay_sessionId_createdAt_idx"
    ON "RefreshTokenReplay"("sessionId", "createdAt");

ALTER TABLE "RefreshTokenReplay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshTokenReplay" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS refresh_token_replay_tenant_isolation_policy ON "RefreshTokenReplay";
CREATE POLICY refresh_token_replay_tenant_isolation_policy ON "RefreshTokenReplay"
    USING (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "Session" s
            JOIN "User" u ON u."id" = s."userId"
            WHERE s."id" = "sessionId"
              AND u."tenantId" = (SELECT get_current_tenant())
        )
    )
    WITH CHECK (
        is_current_platform_admin()
        OR EXISTS (
            SELECT 1
            FROM "Session" s
            JOIN "User" u ON u."id" = s."userId"
            WHERE s."id" = "sessionId"
              AND u."tenantId" = (SELECT get_current_tenant())
        )
    );
