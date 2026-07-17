import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('terminal password-reset and webhook envelopes are irreversibly erased', () => {
  const migration = read('packages/db/prisma/migrations/20260713_terminal_encrypted_payload_erasure.sql');
  const resetWorker = read('apps/worker/src/password_reset_email.py');
  const webhookStore = read('apps/api/src/webhooks/webhook-delivery.store.ts');

  assert.match(migration, /PasswordResetEmailOutbox_terminal_payload_erasure/);
  assert.match(migration, /WebhookDelivery_terminal_payload_erasure/);
  assert.match(migration, /PasswordResetEmailOutbox_terminal_payload_erased_check/);
  assert.match(migration, /WebhookDelivery_terminal_payload_erased_check/);
  assert.match(migration, /WHERE "status"::text IN \('DELIVERED', 'DEAD_LETTERED'\)/);
  assert.match(migration, /NEW\."encryptedPayload" := ''/);
  assert.match(migration, /NEW\."encryptedUrl" := ''/);
  assert.match(migration, /NEW\."encryptionKeyRef" := 'erased-v1'/);
  assert.match(migration, /NEW\."tokenHash" := 'erased-v1:' \|\| encode/);
  assert.ok((migration.match(/NEW\."lastError" := NULL/g) ?? []).length >= 2);
  assert.match(migration, /"tokenHash" LIKE 'erased-v1:%'/);

  assert.match(resetWorker, /ERASED_ENCRYPTED_PAYLOAD = ""/);
  assert.match(resetWorker, /ERASED_ENCRYPTION_KEY_REF = "erased-v1"/);
  assert.match(webhookStore, /TERMINAL_DELIVERY_ERASURE/);
  assert.match(webhookStore, /encryptionKeyRef: 'erased-v1'/);
});
