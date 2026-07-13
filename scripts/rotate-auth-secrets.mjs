#!/usr/bin/env node
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CURRENT_KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY_CURRENT';
export const PREVIOUS_KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS';
export const LEGACY_KEY_ENV = 'MFA_SECRET_ENCRYPTION_KEY';
const HASHED_REFRESH_TOKEN_PREFIX = 'sha256:';
const LEGACY_MFA_SECRET_PREFIX = 'enc:v1:';
const CURRENT_MFA_SECRET_PREFIX = 'enc:v2:';
const EXECUTE_CONFIRMATION = 'rotate-auth-secrets';

export function decodeManagedKey(value, envName = CURRENT_KEY_ENV) {
  const configured = String(value ?? '').trim();
  const normalized = configured.replace(/-/g, '+').replace(/_/g, '/');
  const key = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(normalized, 'base64');
  if (!configured || key.length !== 32) throw new Error(`${envName} must decode to 32 bytes.`);
  return key;
}

export function encryptionKeyRef(key) {
  return crypto.createHash('sha256').update(key.toString('base64')).digest('hex').slice(0, 16);
}

function legacyKey(value) {
  const configured = String(value ?? '').trim();
  if (!configured) return null;
  const key = crypto.createHash('sha256').update(configured).digest();
  return { key, ref: encryptionKeyRef(key), source: 'legacy' };
}

export function managedKeys(currentValue, previousValue, legacyValue) {
  const currentKey = decodeManagedKey(currentValue, CURRENT_KEY_ENV);
  const current = { key: currentKey, ref: encryptionKeyRef(currentKey), source: 'current' };
  const keys = [current];
  if (String(previousValue ?? '').trim()) {
    const key = decodeManagedKey(previousValue, PREVIOUS_KEY_ENV);
    const previous = { key, ref: encryptionKeyRef(key), source: 'previous' };
    if (previous.ref === current.ref) throw new Error('MFA current and previous encryption keys must differ.');
    keys.push(previous);
  }
  const legacy = legacyKey(legacyValue);
  if (legacy && !keys.some(({ ref }) => ref === legacy.ref)) keys.push(legacy);
  return { current, keys };
}

export function encryptMfaSecret(secret, managedKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', managedKey.key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [
    CURRENT_MFA_SECRET_PREFIX.replace(/:$/, ''),
    managedKey.ref,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

function parseMfaSecret(value) {
  const stored = String(value).trim();
  if (!stored.startsWith('enc:')) return { version: 0, plaintext: stored };
  const parts = stored.split(':');
  if (stored.startsWith(LEGACY_MFA_SECRET_PREFIX) && parts.length === 5) {
    return { version: 1, iv: parts[2], tag: parts[3], ciphertext: parts[4] };
  }
  if (stored.startsWith(CURRENT_MFA_SECRET_PREFIX) && parts.length === 6 && /^[a-f0-9]{16}$/i.test(parts[2])) {
    return { version: 2, keyRef: parts[2], iv: parts[3], tag: parts[4], ciphertext: parts[5] };
  }
  throw new Error('Unsupported MFA encryption envelope.');
}

function decryptEnvelope(envelope, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptMfaSecret(value, keys) {
  const envelope = parseMfaSecret(value);
  if (envelope.version === 0) return { plaintext: envelope.plaintext, keyRef: 'plaintext' };
  const candidates = envelope.version === 2
    ? keys.filter(({ ref }) => ref === envelope.keyRef)
    : keys;
  for (const candidate of candidates) {
    try {
      return { plaintext: decryptEnvelope(envelope, candidate.key), keyRef: candidate.ref };
    } catch {
      // Version 1 has no key reference, so bounded overlap reads must try each configured key.
    }
  }
  throw new Error('MFA encryption envelope could not be decrypted with a managed key.');
}

function hashRefreshToken(refreshToken) {
  return `${HASHED_REFRESH_TOKEN_PREFIX}${crypto.createHash('sha256').update(refreshToken).digest('hex')}`;
}

async function enablePlatformAdmin(tx) {
  const capability = String(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET ?? '').trim();
  if (!capability) throw new Error('PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
}

async function loadRows(tx) {
  const [sessions, users] = await Promise.all([
    tx.session.findMany({
      where: { NOT: { refreshToken: { startsWith: HASHED_REFRESH_TOKEN_PREFIX } } },
      select: { id: true, refreshToken: true, revokedAt: true },
    }),
    tx.user.findMany({
      where: { mfaSecret: { not: null } },
      select: { id: true, mfaSecret: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  return { sessions, users };
}

export async function rotateAuthSecrets(prisma, options) {
  const { execute, revokeSessions, currentValue, previousValue, legacyValue } = options;
  const keyring = managedKeys(currentValue, previousValue, legacyValue);
  return prisma.$transaction(async (tx) => {
    await enablePlatformAdmin(tx);
    await tx.$executeRawUnsafe(`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`);
    if (execute) await tx.$executeRawUnsafe(`LOCK TABLE "Session" IN SHARE ROW EXCLUSIVE MODE`);
    const { sessions, users } = await loadRows(tx);
    const decryptedUsers = users.map((user) => ({
      id: user.id,
      ...decryptMfaSecret(user.mfaSecret, keyring.keys),
    }));
    const overlapRows = decryptedUsers.filter(({ keyRef }) => keyRef !== keyring.current.ref).length;
    const result = {
      ok: true,
      mode: execute ? 'execute' : 'dry_run',
      revokeSessions,
      currentKeyRef: keyring.current.ref,
      sessionCandidates: sessions.length,
      mfaSecretCandidates: users.length,
      overlapRows,
      sessionsUpdated: 0,
      sessionsRevoked: 0,
      mfaSecretsUpdated: 0,
      previousDependencyRows: overlapRows,
    };
    if (!execute) return result;

    for (const session of sessions) {
      await tx.session.update({
        where: { id: session.id },
        data: {
          refreshToken: hashRefreshToken(session.refreshToken),
          revokedAt: revokeSessions && !session.revokedAt ? new Date() : session.revokedAt,
        },
      });
      result.sessionsUpdated += 1;
      if (revokeSessions && !session.revokedAt) result.sessionsRevoked += 1;
    }
    for (const user of decryptedUsers) {
      await tx.user.update({
        where: { id: user.id },
        data: { mfaSecret: encryptMfaSecret(user.plaintext, keyring.current) },
      });
      result.mfaSecretsUpdated += 1;
    }

    const verificationRows = await tx.user.findMany({
      where: { mfaSecret: { not: null } },
      select: { id: true, mfaSecret: true },
    });
    for (const row of verificationRows) {
      const envelope = parseMfaSecret(row.mfaSecret);
      if (envelope.version !== 2 || envelope.keyRef !== keyring.current.ref) {
        throw new Error('MFA rotation removal verification found a non-current envelope.');
      }
      decryptMfaSecret(row.mfaSecret, [keyring.current]);
    }
    result.previousDependencyRows = 0;
    return result;
  }, { isolationLevel: 'Serializable', timeout: 120_000, maxWait: 10_000 });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/rotate-auth-secrets.mjs [--execute] [--revoke-sessions]');
    console.log('Dry-runs by default. Writes require AUTH_SECRET_ROTATION_EXECUTE_CONFIRM=rotate-auth-secrets.');
    console.log('Set current and optional previous managed MFA keys; keep the legacy key only until overlap is zero.');
    return;
  }
  const execute = process.argv.includes('--execute') || process.env.AUTH_SECRET_ROTATION_DRY_RUN === 'false';
  const revokeSessions = process.argv.includes('--revoke-sessions') || process.env.AUTH_SECRET_ROTATION_REVOKE_SESSIONS === 'true';
  if (execute && process.env.AUTH_SECRET_ROTATION_EXECUTE_CONFIRM !== EXECUTE_CONFIRMATION) {
    throw new Error(`Set AUTH_SECRET_ROTATION_EXECUTE_CONFIRM=${EXECUTE_CONFIRMATION} before executing auth secret rotation.`);
  }
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required.');
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } } });
  try {
    const result = await rotateAuthSecrets(prisma, {
      execute,
      revokeSessions,
      currentValue: process.env[CURRENT_KEY_ENV],
      previousValue: process.env[PREVIOUS_KEY_ENV],
      legacyValue: process.env[LEGACY_KEY_ENV],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Auth secret rotation failed closed; no row changes were committed.');
    process.exit(1);
  });
}
