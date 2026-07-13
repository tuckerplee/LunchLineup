-- Preserve the target-tenant userId relation while recording the immutable
-- identity of a platform actor who may belong to a different tenant.

ALTER TABLE "AuditLog"
    ADD COLUMN IF NOT EXISTS "actorUserId" TEXT,
    ADD COLUMN IF NOT EXISTS "actorTenantId" TEXT;

CREATE INDEX IF NOT EXISTS "AuditLog_actorTenantId_actorUserId_idx"
    ON "AuditLog"("actorTenantId", "actorUserId");

CREATE OR REPLACE FUNCTION block_audit_actor_identity_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit actor identity is immutable.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_block_audit_actor_identity_update ON "AuditLog";
CREATE TRIGGER tr_block_audit_actor_identity_update
BEFORE UPDATE OF "actorUserId", "actorTenantId" ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION block_audit_actor_identity_modification();

COMMENT ON COLUMN "AuditLog"."actorUserId" IS
    'Immutable request actor identity; intentionally not a foreign key so retained audit evidence survives actor deletion.';
COMMENT ON COLUMN "AuditLog"."actorTenantId" IS
    'Immutable request actor tenant identity; independent of the target tenantId used for RLS and retention.';
