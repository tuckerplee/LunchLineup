-- Forward-only reconciliation for intended deltas formerly made in tracked history.
CREATE UNIQUE INDEX IF NOT EXISTS "User_tenantId_username_key" ON "User"("tenantId", "username");

UPDATE "PlanDefinition"
SET
  "metadata" = jsonb_set(
    jsonb_set(COALESCE("metadata", '{}'::jsonb), '{features}',
      COALESCE("metadata"->'features', '[]'::jsonb) || '["time_cards"]'::jsonb, true),
    '{features}',
    (SELECT jsonb_agg(value) FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements(COALESCE("metadata"->'features', '[]'::jsonb) || '["time_cards","webhooks"]'::jsonb)
    ) features),
    true
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" IN ('GROWTH', 'ENTERPRISE');
