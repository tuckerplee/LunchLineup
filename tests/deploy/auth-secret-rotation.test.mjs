import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  CURRENT_KEY_ENV,
  PREVIOUS_KEY_ENV,
  decodeManagedKey,
  decryptMfaSecret,
  encryptMfaSecret,
  encryptionKeyRef,
  managedKeys,
  rotateAuthSecrets,
} from '../../scripts/rotate-auth-secrets.mjs';

const root = resolve(import.meta.dirname, '../..');
const currentValue = Buffer.alloc(32, 0x11).toString('base64');
const previousValue = Buffer.alloc(32, 0x22).toString('base64');

function v1Envelope(secret, configuredLegacyKey) {
  const key = crypto.createHash('sha256').update(configuredLegacyKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['enc:v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

function prismaMock(users, sessions = []) {
  const updatedUsers = new Map(users.map((user) => [user.id, { ...user }]));
  const tx = {
    $executeRaw: async () => 1,
    $executeRawUnsafe: async () => 1,
    session: {
      findMany: async () => sessions,
      update: async ({ where, data }) => ({ ...sessions.find(({ id }) => id === where.id), ...data }),
    },
    user: {
      findMany: async () => [...updatedUsers.values()],
      update: async ({ where, data }) => {
        const next = { ...updatedUsers.get(where.id), ...data };
        updatedUsers.set(where.id, next);
        return next;
      },
    },
  };
  return {
    updatedUsers,
    $transaction: async (operation, options) => {
      assert.equal(options.isolationLevel, 'Serializable');
      return operation(tx);
    },
  };
}

test('managed MFA envelopes carry the current key reference and decrypt during bounded overlap', () => {
  const previousRing = managedKeys(previousValue);
  const stored = encryptMfaSecret('JBSWY3DPEHPK3PXP', previousRing.current);
  const overlapRing = managedKeys(currentValue, previousValue);

  assert.match(stored, new RegExp(`^enc:v2:${previousRing.current.ref}:`));
  assert.deepEqual(decryptMfaSecret(stored, overlapRing.keys), {
    plaintext: 'JBSWY3DPEHPK3PXP',
    keyRef: previousRing.current.ref,
  });
  assert.throws(() => decryptMfaSecret(stored, [overlapRing.current]), /could not be decrypted/);
});

test('legacy v1 and plaintext MFA secrets remain readable during migration', () => {
  const legacyValue = 'old-deployment-mfa-key';
  const ring = managedKeys(currentValue, '', legacyValue);

  assert.equal(decryptMfaSecret(v1Envelope('JBSWY3DPEHPK3PXP', legacyValue), ring.keys).plaintext, 'JBSWY3DPEHPK3PXP');
  assert.equal(decryptMfaSecret('JBSWY3DPEHPK3PXP', ring.keys).keyRef, 'plaintext');
});

test('managed keys must be distinct exact 32-byte values', () => {
  assert.equal(decodeManagedKey(currentValue, CURRENT_KEY_ENV).length, 32);
  assert.throws(() => decodeManagedKey('short', CURRENT_KEY_ENV), /must decode to 32 bytes/);
  assert.throws(() => managedKeys(currentValue, currentValue), /must differ/);
  assert.equal(PREVIOUS_KEY_ENV, 'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS');
  assert.equal(encryptionKeyRef(Buffer.alloc(32, 0x11)).length, 16);
});

test('execute mode transactionally re-encrypts every MFA secret and verifies previous-key removal', async () => {
  const oldRing = managedKeys(previousValue);
  const prisma = prismaMock([
    { id: 'u-current', mfaSecret: encryptMfaSecret('CURRENTSECRET234', managedKeys(currentValue).current) },
    { id: 'u-previous', mfaSecret: encryptMfaSecret('PREVIOUSSECRET2', oldRing.current) },
    { id: 'u-plain', mfaSecret: 'PLAINTEXTSECRET2' },
  ]);
  process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = 'test-capability';

  const result = await rotateAuthSecrets(prisma, {
    execute: true,
    revokeSessions: false,
    currentValue,
    previousValue,
    legacyValue: '',
  });

  assert.equal(result.mfaSecretCandidates, 3);
  assert.equal(result.mfaSecretsUpdated, 3);
  assert.equal(result.overlapRows, 2);
  assert.equal(result.previousDependencyRows, 0);
  for (const user of prisma.updatedUsers.values()) {
    assert.match(user.mfaSecret, new RegExp(`^enc:v2:${result.currentKeyRef}:`));
    assert.doesNotThrow(() => decryptMfaSecret(user.mfaSecret, [managedKeys(currentValue).current]));
  }
});

test('rotation fails before updates when any enrolled MFA secret is undecryptable', async () => {
  const prisma = prismaMock([
    { id: 'u-valid', mfaSecret: 'PLAINTEXTSECRET2' },
    { id: 'u-invalid', mfaSecret: 'enc:v2:0000000000000000:AA:AA:AA' },
  ]);
  process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = 'test-capability';

  await assert.rejects(() => rotateAuthSecrets(prisma, {
    execute: true,
    revokeSessions: false,
    currentValue,
    previousValue: '',
    legacyValue: '',
  }), /could not be decrypted/);
  assert.equal(prisma.updatedUsers.get('u-valid').mfaSecret, 'PLAINTEXTSECRET2');
});

test('auth secret rotation help is read-only', () => {
  const output = execFileSync(process.execPath, ['scripts/rotate-auth-secrets.mjs', '--help'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.match(output, /Usage: node scripts\/rotate-auth-secrets\.mjs/);
  assert.match(output, /Dry-runs by default/);
});
