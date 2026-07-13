import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderMigrationFileNames } from '../../scripts/apply-db-migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsRoot = join(root, 'packages/db/prisma/migrations');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('fresh migration ordering installs the platform-admin helper before dependent policies', () => {
  const files = readdirSync(migrationsRoot)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => !file.startsWith('pre_'));
  const ordered = orderMigrationFileNames(files);
  const helperIndex = ordered.indexOf('20260709_platform_admin_rls.sql');

  assert.notEqual(helperIndex, -1);
  for (const file of files) {
    if (file === '20260709_platform_admin_rls.sql') continue;
    const sql = readFileSync(join(migrationsRoot, file), 'utf8');
    if (sql.includes('is_current_platform_admin()')) {
      assert.ok(
        helperIndex < ordered.indexOf(file),
        `${file} must run after 20260709_platform_admin_rls.sql`,
      );
    }
  }
});

test('dead-lettered webhook rows have a nullable next attempt in schema and forward SQL', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const migration = read('packages/db/prisma/migrations/20260709_webhook_delivery_terminal_state.sql');

  assert.match(schema, /nextAttemptAt\s+DateTime\?\s+@default\(now\(\)\)/);
  assert.match(migration, /ALTER TABLE "WebhookDelivery"/);
  assert.match(migration, /ALTER COLUMN "nextAttemptAt" DROP NOT NULL/);
});

test('webhook first-attempt crashes have a forward recovery index and durable-before-network implementation', () => {
  const migration = read('packages/db/prisma/migrations/20260709_webhook_first_delivery_outbox.sql');
  const service = read('apps/api/src/webhooks/webhooks.service.ts');
  const store = read('apps/api/src/webhooks/webhook-delivery.store.ts');

  assert.match(migration, /WHERE "status" = 'SENDING'/);
  assert.match(migration, /"updatedAt"/);
  assert.ok(service.indexOf('persistEvent') < service.indexOf('sendSignedWebhook'));
  assert.ok(service.indexOf('claimInitialDelivery') < service.indexOf('sendSignedWebhook'));
  assert.match(store, /"status" = 'SENDING'::"WebhookDeliveryStatus"/);
  assert.match(store, /WHEN candidates\."status" = 'SENDING'/);
  assert.match(store, /FOR UPDATE OF delivery SKIP LOCKED/);
});

test('RabbitMQ-only loss can reclaim aged confirmed webhook rows without touching terminal deliveries', () => {
  const migration = read('packages/db/prisma/migrations/20260709_zz_broker_loss_outbox_recovery.sql');
  const store = read('apps/api/src/webhooks/webhook-delivery.store.ts');

  assert.match(migration, /"WebhookDelivery_confirmed_queued_idx"/);
  assert.match(migration, /"status" = 'QUEUED'/);
  assert.match(migration, /"nextAttemptAt" IS NULL/);
  assert.match(store, /WEBHOOK_CONFIRMED_QUEUE_RECOVERY_AGE_MS/);
  assert.match(store, /"queuedAt" <= \$\{confirmedQueuedBefore\}/);
  assert.doesNotMatch(store, /"status"\s+IN\s+\([^)]*'DELIVERED'/);
});

test('tenant webhook lifecycle delivers for ACTIVE and TRIAL, pauses recoverable states, and terminalizes only PURGED', () => {
  const migration = read('packages/db/prisma/migrations/20260710_tenant_webhook_lifecycle.sql');
  const store = read('apps/api/src/webhooks/webhook-delivery.store.ts');

  assert.match(store, /WEBHOOK_DELIVERY_ELIGIBLE_TENANT_STATUSES = \['ACTIVE', 'TRIAL'\]/);
  assert.match(store, /tenant\."status" = 'ACTIVE'::"TenantStatus"[\s\S]*tenant\."status" = 'TRIAL'::"TenantStatus"[\s\S]*tenant\."trialEndsAt" > /);
  assert.match(store, /status: 'FAILED' satisfies WebhookDeliveryStatus,[\s\S]*Tenant webhook delivery is paused/);
  assert.doesNotMatch(store, /WEBHOOK_DELIVERY_ELIGIBLE_TENANT_STATUSES = [^\n]*PAST_DUE/);

  assert.match(migration, /IF NEW\."status" = 'PURGED'::"TenantStatus" THEN/);
  assert.match(migration, /WHEN \(NEW\."status" = 'PURGED'::"TenantStatus"\)/);
  assert.match(migration, /tenant\."status" = 'PURGED'::"TenantStatus"/);
  assert.doesNotMatch(migration, /NEW\."status" <> 'ACTIVE'/);
  assert.doesNotMatch(migration, /tenant\."status" <> 'ACTIVE'/);
  assert.doesNotMatch(migration, /PAST_DUE[\s\S]*DEAD_LETTERED|DEAD_LETTERED[\s\S]*PAST_DUE/);
});
