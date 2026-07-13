import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schema = readFileSync(resolve(root, 'packages/db/prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(root, 'packages/db/prisma/migrations/20260712_stripe_usage_logical_identity.sql'),
  'utf8',
);

test('Stripe usage snapshots have one immutable tenant metric period identity', () => {
  assert.match(schema, /@@unique\(\[tenantId, metric, periodStart, periodEnd\]\)/);
  assert.match(migration, /LOCK TABLE "StripeUsageEvent" IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(migration, /PARTITION BY "tenantId", "metric", "periodStart", "periodEnd"/);
  assert.match(migration, /CASE "status"[\s\S]*WHEN 'SENT' THEN 0[\s\S]*WHEN 'FAILED' THEN 2/);
  assert.match(migration, /COALESCE\("submittedAt", "sentAt", "updatedAt", "createdAt"\) DESC/);
  assert.match(migration, /ROW_NUMBER\(\) OVER logical_rows AS logical_rank/);
  assert.match(migration, /DELETE FROM "StripeUsageEvent" usage[\s\S]*dedupe\.logical_rank > 1/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "StripeUsageEvent_tenantId_metric_periodStart_periodEnd_key"[\s\S]*ON "StripeUsageEvent"\("tenantId", "metric", "periodStart", "periodEnd"\)/,
  );
});
