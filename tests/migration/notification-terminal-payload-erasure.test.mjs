import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('terminal notification outbox rows irreversibly erase duplicate recipient content', () => {
  const sql = read('packages/db/prisma/migrations/20260714_notification_terminal_payload_erasure.sql');
  const processor = read('apps/api/src/notifications/notification-outbox.processor.ts');

  for (const required of [
    'scrub_terminal_notification_outbox_payload',
    '"NotificationOutbox_terminal_payload_erasure"',
    '"NotificationOutbox_terminal_payload_erased_check"',
    '"title" = \'\'',
    '"body" = \'\'',
    '"lastError" IS NULL',
    "'DELIVERED', 'DEAD_LETTERED'",
  ]) {
    assert.ok(sql.includes(required), 'missing notification erasure contract: ' + required);
  }

  assert.match(processor, /terminal \? \{ title: '', body: '' \} : \{\}/);
  assert.ok((processor.match(/title: '',\s*body: ''/g) ?? []).length >= 3);
});
