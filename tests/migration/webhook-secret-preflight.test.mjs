import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  encryptionKeyRef,
  rotateWebhookEncryption,
} from '../../scripts/rotate-webhook-endpoint-secrets.mjs';

const root = resolve(import.meta.dirname, '../..');
const migrationPath = join(
  root,
  'packages/db/prisma/migrations/20260709_zzzz_webhook_endpoint_secret_encryption.sql',
);
const preflightSql = readFileSync(migrationPath, 'utf8');
const rotationScript = readFileSync(join(root, 'scripts/rotate-webhook-endpoint-secrets.mjs'), 'utf8');
const migrationRunner = readFileSync(join(root, 'scripts/apply-db-migrations.mjs'), 'utf8');

test('webhook preflight bounds database lock waits and its migration child process', () => {
  assert.match(rotationScript, /SET LOCAL lock_timeout = '10s'/);
  assert.match(rotationScript, /SET LOCAL statement_timeout = '110s'/);
  assert.match(migrationRunner, /WEBHOOK_ROTATION_TIMEOUT_MS = 150_000/);
  assert.match(migrationRunner, /timeoutMs: WEBHOOK_ROTATION_TIMEOUT_MS/);
  assert.match(migrationRunner, /runBoundedProcess/);
  assert.match(rotationScript, /error_class=\$\{errorClass\} error_code=\$\{errorCode\}/);
  assert.doesNotMatch(rotationScript, /console\.error\(error(?:\?\.message|\.message)?\)/);
});

test('every migration subprocess class has a fail-closed execution deadline', () => {
  assert.match(migrationRunner, /PRISMA_COMMAND_TIMEOUT_MS = 600_000/);
  assert.match(migrationRunner, /BOOTSTRAP_COMMAND_TIMEOUT_MS = 120_000/);
  assert.match(migrationRunner, /APP_ROLE_PROVISION_TIMEOUT_MS = 120_000/);
  assert.match(migrationRunner, /timeoutMs: PRISMA_COMMAND_TIMEOUT_MS/);
  assert.match(migrationRunner, /timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS/);
  assert.match(migrationRunner, /timeoutMs: APP_ROLE_PROVISION_TIMEOUT_MS/);
  assert.equal((migrationRunner.match(/runBoundedProcess\(/g) ?? []).length, 5);
});

test('webhook secret preflight preserves credential material in an application-key envelope', () => {
  const plaintext = 'recoverable-signing-credential';
  const key = decodeEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  const envelope = JSON.parse(encryptSecret(plaintext, key));
  assert.equal(envelope.v, 2);
  assert.equal(envelope.alg, 'aes-256-gcm');
  assert.equal(envelope.keyRef, encryptionKeyRef(key));
  assert.notEqual(envelope.ciphertext, plaintext);
  assert.doesNotMatch(JSON.stringify(envelope), new RegExp(plaintext));
});

test('webhook SQL accepts the managed v2 output shape and legacy v1 envelope shape', () => {
  const key = decodeEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  const currentEnvelope = JSON.parse(encryptSecret('v2-shape-regression', key));
  assert.deepEqual(Object.keys(currentEnvelope).sort(), [
    'alg',
    'ciphertext',
    'iv',
    'keyRef',
    'tag',
    'v',
  ]);

  for (const field of Object.keys(currentEnvelope)) {
    assert.match(preflightSql, new RegExp(`envelope\\s*->>?\\s*'${field}'`));
  }
  assert.match(preflightSql, /envelope -> 'v' IS DISTINCT FROM '1'::JSONB/);
  assert.match(preflightSql, /envelope -> 'v' IS DISTINCT FROM '2'::JSONB/);
  assert.match(preflightSql, /envelope ->> 'keyRef' !~ '\^\[0-9a-f\]\{16\}\$'/);
});

test('webhook SQL rejects plaintext and malformed envelope structures', () => {
  assert.match(preflightSql, /endpoint\."secret"::JSONB/);
  assert.match(preflightSql, /WHEN invalid_text_representation/);
  assert.match(preflightSql, /jsonb_typeof\(envelope\) IS DISTINCT FROM 'object'/);
  for (const field of ['iv', 'tag', 'ciphertext']) {
    assert.match(
      preflightSql,
      new RegExp(`jsonb_typeof\\(envelope -> '${field}'\\) IS DISTINCT FROM 'string'`),
    );
  }
});

test('managed-key overlap decrypts previous envelopes and rejects missing keys', () => {
  const current = decodeEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  const previous = decodeEncryptionKey(Buffer.alloc(32, 8).toString('base64'));
  const encrypted = encryptSecret('rotating-secret', previous);
  assert.equal(decryptSecret(encrypted, [
    { key: current, ref: encryptionKeyRef(current) },
    { key: previous, ref: encryptionKeyRef(previous) },
  ]).plaintext, 'rotating-secret');
  assert.throws(() => decryptSecret(encrypted, [{ key: current, ref: encryptionKeyRef(current) }]));
});

test('rotation rewrites endpoints and nonterminal delivery envelopes to current key in one transaction', async () => {
  const current = Buffer.alloc(32, 7).toString('base64');
  const previousKey = decodeEncryptionKey(Buffer.alloc(32, 8).toString('base64'));
  const endpointRows = [{ id: 'endpoint-1', secret: encryptSecret('endpoint-secret', previousKey) }];
  const deliveryRows = [{
    id: 'delivery-1',
    encryptedUrl: encryptSecret('https://hooks.example.com', previousKey),
    encryptedPayload: encryptSecret('{"ok":true}', previousKey),
    encryptionKeyRef: encryptionKeyRef(previousKey),
  }];
  const updates = [];
  const tx = {
    $executeRawUnsafe: async (sql, ...values) => {
      if (/UPDATE "WebhookEndpoint"/.test(sql)) updates.push({ type: 'endpoint', values });
      if (/UPDATE "WebhookDelivery"/.test(sql)) updates.push({ type: 'delivery', values });
      return 1;
    },
    $queryRawUnsafe: async (sql, ...values) => {
      if (/FROM "WebhookEndpoint"/.test(sql)) return values[0] ? [] : endpointRows;
      if (/FROM "WebhookDelivery"/.test(sql)) return values[1] ? [] : deliveryRows;
      return [];
    },
  };
  const prisma = {
    $queryRawUnsafe: async () => [{ endpoint: 'WebhookEndpoint', delivery: 'WebhookDelivery' }],
    $transaction: async (operation) => operation(tx),
  };
  const result = await rotateWebhookEncryption(prisma, current, previousKey.toString('base64'));
  assert.deepEqual(result, {
    endpointRows: 1,
    deliveryRows: 1,
    overlapRows: 2,
    currentKeyRef: encryptionKeyRef(decodeEncryptionKey(current)),
  });
  assert.equal(updates.length, 2);
  const currentManaged = [{ key: decodeEncryptionKey(current), ref: result.currentKeyRef }];
  assert.equal(decryptSecret(updates[0].values[0], currentManaged).plaintext, 'endpoint-secret');
  assert.equal(decryptSecret(updates[1].values[0], currentManaged).plaintext, 'https://hooks.example.com');
  assert.equal(decryptSecret(updates[1].values[1], currentManaged).plaintext, '{"ok":true}');
});

test('rotation fails closed before transaction commit when any queued envelope is undecryptable', async () => {
  const current = Buffer.alloc(32, 7).toString('base64');
  const unknown = decodeEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
  let rolledBack = false;
  const tx = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql, ...values) => {
      if (/WebhookEndpoint/.test(sql)) return [];
      if (/WebhookDelivery/.test(sql) && !values[1]) return [{
        id: 'delivery-bad',
        encryptedUrl: encryptSecret('https://hooks.example.com', unknown),
        encryptedPayload: encryptSecret('{}', unknown),
        encryptionKeyRef: encryptionKeyRef(unknown),
      }];
      return [];
    },
  };
  const prisma = {
    $queryRawUnsafe: async () => [{ endpoint: 'WebhookEndpoint', delivery: 'WebhookDelivery' }],
    $transaction: async (operation) => {
      try { return await operation(tx); } catch (error) { rolledBack = true; throw error; }
    },
  };
  await assert.rejects(() => rotateWebhookEncryption(prisma, current, undefined), /managed key/);
  assert.equal(rolledBack, true);
});

test('webhook SQL fails closed without destroying or disabling plaintext rows', () => {
  assert.match(preflightSql, /RAISE EXCEPTION 'Webhook endpoint secret preflight was not completed'/);
  assert.doesNotMatch(preflightSql, /UPDATE\s+"WebhookEndpoint"/i);
  assert.doesNotMatch(preflightSql, /SET\s+"active"\s*=\s*FALSE/i);
  assert.doesNotMatch(preflightSql, /legacy-secret-destroyed/i);
});
