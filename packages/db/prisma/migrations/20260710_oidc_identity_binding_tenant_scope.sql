-- Allow one provider identity to bind to invited accounts in multiple workspaces
-- while preserving uniqueness inside each tenant.
DROP INDEX IF EXISTS "User_oidcIssuer_oidcSubject_key";

CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_oidcIssuer_oidcSubject_key"
  ON "User"("tenantId", "oidcIssuer", "oidcSubject");
