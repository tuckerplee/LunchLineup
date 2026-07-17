import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('email feedback state follows active recipient email and deletion lifecycle', () => {
  const sql = readFileSync(
    'packages/db/prisma/migrations/20260714_email_delivery_feedback.sql',
    'utf8',
  );

  for (const required of [
    'ADD COLUMN IF NOT EXISTS "emailDeliverySuppressedAt"',
    '"User_emailDeliverySuppressedAt_idx"',
    '"User_active_email_delivery_lookup_idx"',
    'lower("email")',
    'scrub_user_email_delivery_state',
    'NEW."email" IS DISTINCT FROM OLD."email"',
    '"User_deleted_email_delivery_state_erasure"',
    'NEW."emailDeliverySuppressionReason" := NULL',
    'WHERE "deletedAt" IS NOT NULL',
  ]) {
    assert.ok(sql.includes(required), 'missing email feedback lifecycle contract: ' + required);
  }
});
