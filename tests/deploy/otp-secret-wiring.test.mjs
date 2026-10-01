import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createManagedSecretPolicy } from '../../scripts/production-launch-policy-managed-secrets.mjs';
import { createErrorCollector, createPolicyContext } from '../../scripts/production-launch-policy-shared.mjs';

function validateOtp(value) {
  const env = Object.fromEntries([
    'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
    'RABBITMQ_PASSWORD', 'GRAFANA_PASSWORD', 'CONTROL_PLANE_PASSWORD',
    'JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'CSRF_SECRET',
  ].map(key => [key, 'a'.repeat(48)]));
  for (const [index, key] of [
    'MFA_SECRET_ENCRYPTION_KEY_CURRENT', 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
    'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY', 'AVAILABILITY_IMPORT_ENCRYPTION_KEY',
    'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY',
  ].entries()) env[key] = String(index + 1).repeat(64);
  if (value !== undefined) env.OTP_HMAC_SECRET = value;
  const collector = createErrorCollector();
  createManagedSecretPolicy(createPolicyContext(env, collector), {
    repoLocalSecretsRoot: '/unused-repository-secrets', verifyLocalSecretFiles: false,
  }).validateSecretValues();
  return collector;
}

test('API Compose requires an explicit OTP HMAC secret without a fallback', () => {
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
  const api = compose.split('\n  api:\n')[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.ok(api?.includes('- OTP_HMAC_SECRET=${OTP_HMAC_SECRET:?Set OTP_HMAC_SECRET in .env}'));
});

for (const [label, value] of [
  ['missing', undefined], ['empty', ''], ['whitespace', ' '.repeat(40)],
  ['short', 'a'.repeat(31)], ['trimmed short', ` ${'a'.repeat(31)} `],
  ['placeholder', 'replace_me_' + 'a'.repeat(40)],
]) test(`launch secret validation rejects ${label} OTP HMAC configuration`, () => {
  const { errors } = validateOtp(value);
  assert.ok(errors.some(message => message.startsWith('OTP_HMAC_SECRET ')));
  assert.ok(errors.every(message => message.startsWith('OTP_HMAC_SECRET ')));
});

test('launch secret validation accepts the production minimum OTP HMAC length', () => {
  const collector = validateOtp('a'.repeat(32));
  assert.equal(collector.errors.length, 0);
  assert.ok(collector.checked.includes('OTP_HMAC_SECRET'));
});
