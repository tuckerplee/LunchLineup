import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('notification outbox migration is tenant-isolated, leased, deduplicated, and terminally observable', () => {
  const enums = read('packages/db/prisma/migrations/20260714_notification_delivery_enums.sql');
  const sql = read('packages/db/prisma/migrations/20260714_notification_delivery_outbox.sql');
  const contract = `${enums}\n${sql}`;

  for (const required of [
    'CREATE TABLE IF NOT EXISTS "NotificationOutbox"',
    '"NotificationOutbox_tenantId_dedupeKey_key"',
    '"NotificationOutbox_status_nextAttemptAt_idx"',
    '"NotificationOutbox_status_leaseUntil_idx"',
    'CHECK ("attempts" >= 0)',
    'ENABLE ROW LEVEL SECURITY',
    'FORCE ROW LEVEL SECURITY',
    'is_current_platform_admin()',
    '"tenantId" = (SELECT get_current_tenant())',
    "'PENDING'",
    "'PROCESSING'",
    "'DELIVERED'",
    "'FAILED'",
    "'DEAD_LETTERED'",
  ]) {
    assert.ok(contract.includes(required), 'missing migration contract: ' + required);
  }
});

test('notification outbox migration is replay-safe after Prisma schema synchronization', () => {
  const enums = read('packages/db/prisma/migrations/20260714_notification_delivery_enums.sql');
  const sql = read('packages/db/prisma/migrations/20260714_notification_delivery_outbox.sql');

  assert.match(enums, /WHEN duplicate_object THEN NULL/);
  assert.match(enums, /ALTER TYPE "NotificationOutboxStatus" ADD VALUE IF NOT EXISTS 'DEAD_LETTERED'/);
  assert.doesNotMatch(sql, /ALTER TYPE "NotificationOutboxStatus" ADD VALUE/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "NotificationOutbox"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "NotificationOutbox_tenantId_dedupeKey_key"/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS "NotificationOutbox_attempts_check"/);
  assert.match(sql, /DROP POLICY IF EXISTS notification_outbox_isolation_policy/);
  assert.ok(
    '20260714_notification_delivery_enums.sql'.localeCompare('20260714_notification_delivery_outbox.sql') < 0,
    'enum values must commit in a ledger transaction before table defaults consume them',
  );
});

test('schedule publication commits one deduplicated intent per recipient before any delivery attempt', () => {
  const controller = read('apps/api/src/schedules/schedules.controller.ts');
  const enqueueAt = controller.indexOf('enqueueInTransaction(tx, assignedUserIds.map');
  const transactionEndAt = controller.indexOf(
    '\n        });\n        const notificationSummary = await this.notificationsService.deliverPendingNow(',
    enqueueAt,
  );
  const deliveryAt = controller.indexOf(
    'const notificationSummary = await this.notificationsService.deliverPendingNow(',
    enqueueAt,
  );

  assert.ok(enqueueAt > 0, 'transactional notification enqueue must exist');
  assert.ok(transactionEndAt > enqueueAt, 'enqueue must occur before the publish transaction returns');
  assert.ok(deliveryAt > transactionEndAt, 'delivery must not start before commit');
  assert.ok(controller.includes('revision-${lockedSchedule.revision}'));
  assert.ok(controller.includes('schedule-published:${id}:${publicationKey}:${userId}'));
  assert.ok(!controller.includes('Promise.allSettled(assignedUserIds.map'));
});

test('notification recovery uses skip-locked leases and deterministic notification identities', () => {
  const processor = read('apps/api/src/notifications/notification-outbox.processor.ts');

  for (const required of [
    'FOR UPDATE SKIP LOCKED',
    'outbox."leaseUntil" <=',
    'withPlatformAdmin(query)',
    'where: { id: intent.id }',
    "status: terminal ? 'DEAD_LETTERED' : 'FAILED'",
    'Notification outbox terminal failure attempts=',
    'runtimeErrorText(error)',
  ]) {
    assert.ok(processor.includes(required), 'missing processor contract: ' + required);
  }
  assert.ok(!processor.includes('intent_id='), 'terminal logs must not expose notification intent ids');
  assert.ok(!processor.includes('tenant_id='), 'terminal logs must not expose tenant ids');
  assert.ok(!processor.includes('error.stack'), 'runtime errors must not persist or log raw stacks');
});
