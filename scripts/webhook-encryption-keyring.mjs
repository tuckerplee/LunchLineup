import crypto from 'node:crypto';

export const CURRENT_KEY_ENV = 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT';
export const PREVIOUS_KEY_ENV = 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS';

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

export function managedKeys(currentValue, previousValue) {
  const currentKey = decodeEncryptionKey(currentValue, CURRENT_KEY_ENV);
  const current = { key: currentKey, ref: encryptionKeyRef(currentKey) };
  const configuredPrevious = String(previousValue ?? '').trim();
  if (!configuredPrevious) return { current, keys: [current] };
  const previousKey = decodeEncryptionKey(configuredPrevious, PREVIOUS_KEY_ENV);
  const previous = { key: previousKey, ref: encryptionKeyRef(previousKey) };
  if (previous.ref === current.ref) throw new Error('Webhook current and previous encryption keys must differ.');
  return { current, keys: [current, previous] };
}
