#!/usr/bin/env node
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CURRENT_KEY_ENV = 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT';
export const PREVIOUS_KEY_ENV = 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS';
const BATCH_SIZE = 250;
const NONTERMINAL_STATUSES = ['PENDING', 'QUEUED', 'SENDING', 'FAILED'];

export function decodeEncryptionKey(value, envName = CURRENT_KEY_ENV) {
  const configured = String(value ?? '').trim();
  const normalized = configured.replace(/-/g, '+').replace(/_/g, '/');
  const key = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(normalized, 'base64');
  if (!configured || key.length !== 32) {
    throw new Error(`${envName} must decode to 32 bytes.`);
  }
  return key;
}

export function encryptionKeyRef(key) {
  return crypto.createHash('sha256').update(key.toString('base64')).digest('hex').slice(0, 16);
}

export function encryptSecret(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 2,
    alg: 'aes-256-gcm',
    keyRef: encryptionKeyRef(key),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function parseEnvelope(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const hasEncryptionShape = parsed && typeof parsed === 'object'
    && ['v', 'alg', 'iv', 'tag', 'ciphertext', 'keyRef'].some((key) => key in parsed);
  if (!hasEncryptionShape) return null;
  const validVersion = parsed.v === 1
    || (parsed.v === 2 && typeof parsed.keyRef === 'string' && parsed.keyRef.length === 16);
  if (!validVersion || parsed.alg !== 'aes-256-gcm'
    || typeof parsed.iv !== 'string' || typeof parsed.tag !== 'string' || typeof parsed.ciphertext !== 'string') {
    throw new Error('Unsupported webhook encryption envelope.');
  }
  return parsed;
}

function decryptWithKey(envelope, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptSecret(value, keys, { allowPlaintext = false } = {}) {
  const envelope = parseEnvelope(String(value));
  if (!envelope) {
    if (allowPlaintext) return { plaintext: String(value), keyRef: 'plaintext' };
    throw new Error('Expected an encrypted webhook delivery envelope.');
  }
  const candidates = envelope.v === 2
    ? keys.filter(({ ref }) => ref === envelope.keyRef)
    : keys;
  for (const candidate of candidates) {
    try {
      return { plaintext: decryptWithKey(envelope, candidate.key), keyRef: candidate.ref };
    } catch {
      // Legacy v1 envelopes do not identify their key.
    }
  }
  throw new Error('Webhook encryption envelope could not be decrypted with a managed key.');
}

function managedKeys(currentValue, previousValue) {
  const currentKey = decodeEncryptionKey(currentValue, CURRENT_KEY_ENV);
  const current = { key: currentKey, ref: encryptionKeyRef(currentKey) };
  const configuredPrevious = String(previousValue ?? '').trim();
  if (!configuredPrevious) return { current, keys: [current] };
  const previousKey = decodeEncryptionKey(configuredPrevious, PREVIOUS_KEY_ENV);
  const previous = { key: previousKey, ref: encryptionKeyRef(previousKey) };
  if (previous.ref === current.ref) throw new Error('Webhook current and previous encryption keys must differ.');
  return { current, keys: [current, previous] };
}

async function existingTables(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT to_regclass('"WebhookEndpoint"')::text AS endpoint,
           to_regclass('"WebhookDelivery"')::text AS delivery
  `);
  return { endpoint: Boolean(rows[0]?.endpoint), delivery: Boolean(rows[0]?.delivery) };
}

async function rotateEndpointRows(tx, keyring) {
  let cursor = '';
  let count = 0;
  let overlap = 0;
  while (true) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id", "secret" FROM "WebhookEndpoint"
       WHERE "secret" IS NOT NULL AND "id" > $1
       ORDER BY "id" LIMIT $2 FOR UPDATE`,
      cursor,
      BATCH_SIZE,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const decrypted = decryptSecret(row.secret, keyring.keys, { allowPlaintext: true });
      if (decrypted.keyRef !== keyring.current.ref) overlap += 1;
      const encrypted = encryptSecret(decrypted.plaintext, keyring.current.key);
      await tx.$executeRawUnsafe(
        `UPDATE "WebhookEndpoint" SET "secret" = $1, "updatedAt" = NOW() WHERE "id" = $2`,
        encrypted,
        row.id,
      );
      count += 1;
    }
    cursor = rows.at(-1).id;
  }
  return { count, overlap };
}

async function rotateDeliveryRows(tx, keyring) {
  let cursor = '';
  let count = 0;
  let overlap = 0;
  while (true) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT "id", "encryptedUrl", "encryptedPayload", "encryptionKeyRef"
       FROM "WebhookDelivery"
       WHERE "status"::text = ANY($1::text[]) AND "id" > $2
       ORDER BY "id" LIMIT $3 FOR UPDATE`,
      NONTERMINAL_STATUSES,
      cursor,
      BATCH_SIZE,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const url = decryptSecret(row.encryptedUrl, keyring.keys);
      const payload = decryptSecret(row.encryptedPayload, keyring.keys);
      if (url.keyRef !== keyring.current.ref || payload.keyRef !== keyring.current.ref
        || row.encryptionKeyRef !== keyring.current.ref) overlap += 1;
      await tx.$executeRawUnsafe(
        `UPDATE "WebhookDelivery"
         SET "encryptedUrl" = $1, "encryptedPayload" = $2, "encryptionKeyRef" = $3, "updatedAt" = NOW()
         WHERE "id" = $4`,
        encryptSecret(url.plaintext, keyring.current.key),
        encryptSecret(payload.plaintext, keyring.current.key),
        keyring.current.ref,
        row.id,
      );
      count += 1;
    }
    cursor = rows.at(-1).id;
  }
  return { count, overlap };
}

export async function rotateWebhookEncryption(prisma, currentValue, previousValue) {
  const tables = await existingTables(prisma);
  const keyring = managedKeys(currentValue, previousValue);
  if (!tables.endpoint && !tables.delivery) {
    return { endpointRows: 0, deliveryRows: 0, overlapRows: 0, currentKeyRef: keyring.current.ref };
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('lunchlineup:webhook-encryption-rotation'))`);
    if (tables.endpoint) await tx.$executeRawUnsafe(`LOCK TABLE "WebhookEndpoint" IN SHARE ROW EXCLUSIVE MODE`);
    if (tables.delivery) await tx.$executeRawUnsafe(`LOCK TABLE "WebhookDelivery" IN SHARE ROW EXCLUSIVE MODE`);
    const endpoints = tables.endpoint ? await rotateEndpointRows(tx, keyring) : { count: 0, overlap: 0 };
    const deliveries = tables.delivery ? await rotateDeliveryRows(tx, keyring) : { count: 0, overlap: 0 };
    return {
      endpointRows: endpoints.count,
      deliveryRows: deliveries.count,
      overlapRows: endpoints.overlap + deliveries.overlap,
      currentKeyRef: keyring.current.ref,
    };
  }, { isolationLevel: 'Serializable', timeout: 120_000, maxWait: 10_000 });
}

async function main() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required.');
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } } });
  try {
    const result = await rotateWebhookEncryption(
      prisma,
      process.env[CURRENT_KEY_ENV],
      process.env[PREVIOUS_KEY_ENV],
    );
    process.stdout.write(
      `webhook_encryption_rotation_ok current_key_ref=${result.currentKeyRef} endpoint_rows=${result.endpointRows} delivery_rows=${result.deliveryRows} overlap_rows=${result.overlapRows} previous_dependency_rows=0\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Webhook encryption rotation failed closed; no row changes or DDL were committed.');
    process.exit(1);
  });
}
