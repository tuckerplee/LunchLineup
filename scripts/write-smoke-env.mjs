import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetArg = process.argv[2];
const metricsTokenArg = process.argv[3];

if (targetArg === '--help' || targetArg === '-h') {
  console.log('Usage: node scripts/write-smoke-env.mjs [output-env-path] [metrics-token-path]');
  console.log('Default output-env-path: .env.smoke');
  console.log('Default metrics-token-path: secrets/metrics_token');
  console.log('Writes an ephemeral smoke-test env file and its required Compose secret files.');
  process.exit(0);
}

if (targetArg?.startsWith('-') || metricsTokenArg?.startsWith('-')) {
  console.error(`Unsupported option: ${targetArg?.startsWith('-') ? targetArg : metricsTokenArg}`);
  console.error('Usage: node scripts/write-smoke-env.mjs [output-env-path] [metrics-token-path]');
  process.exit(64);
}

const envPath = resolve(root, targetArg ?? '.env.smoke');
const composeServiceEnvFile = targetArg ?? '.env.smoke';
const metricsTokenConfigPath = metricsTokenArg ?? './secrets/metrics_token';
const composeSecretPaths = {
  metricsToken: metricsTokenConfigPath,
  controlPlaneAdminToken: join(dirname(metricsTokenConfigPath), 'control_plane_admin_token'),
  retentionPurgeToken: join(dirname(metricsTokenConfigPath), 'retention_purge_token'),
  alertmanagerWebhookUrl: join(dirname(metricsTokenConfigPath), 'alertmanager_webhook_url'),
  backupEncryptionKey: join(dirname(metricsTokenConfigPath), 'backup_key'),
};
const secretPaths = Object.fromEntries(
  Object.entries(composeSecretPaths).map(([key, path]) => [key, resolve(root, path)]),
);

function secret(prefix, bytes = 32) {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function connectionUrl(protocol, username, password, host, path = '') {
  const credentials = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `${protocol}://${credentials}@${host}${path}`;
}

const reservedCredentialSuffix = ':@/?[]%';
const postgresPassword = `${secret('pg_')}${reservedCredentialSuffix}`;
const appDatabasePassword = `${secret('app_pg_')}${reservedCredentialSuffix}`;
const rabbitmqPassword = `${secret('mq_')}${reservedCredentialSuffix}`;
const metricsToken = secret('metrics_');
const controlPlaneAdminToken = secret('control_');
const retentionPurgeToken = secret('retention_');
const backupEncryptionKey = secret('backup_');

const env = {
  NODE_ENV: 'test',
  DATA_TARGET_ENV: 'test',
  COMPOSE_SERVICE_ENV_FILE: composeServiceEnvFile,
  DOMAIN: 'smoke.lunchlineup.test',
  ADMIN_EMAIL: 'ci@example.com',
  CADDY_SITE_ADDRESSES: ':80',
  PROXY_HTTP_BIND: '127.0.0.1',
  PROXY_HTTP_PORT: process.env.PROXY_HTTP_PORT ?? '8080',
  PROXY_HTTPS_BIND: '127.0.0.1',
  PROXY_HTTPS_PORT: process.env.PROXY_HTTPS_PORT ?? '8443',
  API_HOST_BIND: '127.0.0.1',
  API_HOST_PORT: process.env.API_HOST_PORT ?? '4000',
  ALLOWED_HOSTS: [
    'localhost',
    `localhost:${process.env.PROXY_HTTP_PORT ?? '8080'}`,
    `localhost:${process.env.API_HOST_PORT ?? '4000'}`,
    '127.0.0.1',
    `127.0.0.1:${process.env.PROXY_HTTP_PORT ?? '8080'}`,
    `127.0.0.1:${process.env.API_HOST_PORT ?? '4000'}`,
    'proxy',
    'proxy:80',
  ].join(','),
  ALLOWED_ORIGINS: [
    'http://localhost',
    `http://localhost:${process.env.PROXY_HTTP_PORT ?? '8080'}`,
    'http://127.0.0.1',
    `http://127.0.0.1:${process.env.PROXY_HTTP_PORT ?? '8080'}`,
  ].join(','),
  POSTGRES_USER: 'lunchlineup_ci_admin',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_DB: 'lunchlineup_ci',
  APP_DB_USER: 'lunchlineup_ci_app',
  APP_DB_PASSWORD: appDatabasePassword,
  PLATFORM_ADMIN_DB_CONTEXT_SECRET: secret('platform_admin_db_'),
  DATABASE_URL: connectionUrl('postgresql', 'lunchlineup_ci_app', appDatabasePassword, 'postgres:5432', '/lunchlineup_ci'),
  MIGRATION_DATABASE_URL: connectionUrl('postgresql', 'lunchlineup_ci_admin', postgresPassword, 'postgres:5432', '/lunchlineup_ci'),
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_USER: 'lunchlineup_ci',
  RABBITMQ_PASSWORD: rabbitmqPassword,
  RABBITMQ_URL: connectionUrl('amqp', 'lunchlineup_ci', rabbitmqPassword, 'rabbitmq:5672'),
  GRAFANA_USER: 'lunchlineup_ci',
  GRAFANA_PASSWORD: secret('grafana_'),
  JWT_SECRET: secret('jwt_'),
  JWT_REFRESH_SECRET: secret('refresh_'),
  SESSION_SECRET: secret('session_'),
  MFA_SECRET_ENCRYPTION_KEY_CURRENT: randomBytes(32).toString('base64'),
  MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: '',
  MFA_SECRET_ENCRYPTION_KEY: '',
  WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: randomBytes(32).toString('base64'),
  WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS: '',
  PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  AVAILABILITY_IMPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  CSRF_SECRET: secret('csrf_'),
  RESEND_API_KEY: secret('re_'),
  RESEND_WEBHOOK_SECRET: secret('whsec_'),
  EMAIL_FROM: 'LunchLineup Smoke <no-reply@smoke.lunchlineup.test>',
  STRIPE_SECRET_KEY: secret('sk_test_'),
  STRIPE_WEBHOOK_SECRET: secret('whsec_'),
  STRIPE_METER_ERROR_WEBHOOK_SECRET: secret('whsec_'),
  STRIPE_METER_ERROR_EVENT_DESTINATION_ID: 'ed_live_smoke1234567890',
  STRIPE_METER_ID: 'mtr_smoke1234567890',
  STRIPE_METER_AGGREGATION: 'last',
  PASSWORD_RESET_EMAIL_OUTBOX_ENABLED: 'true',
  METRICS_TOKEN_FILE: composeSecretPaths.metricsToken,
  RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE: composeSecretPaths.retentionPurgeToken,
  CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE: composeSecretPaths.controlPlaneAdminToken,
  BACKUP_ENCRYPTION_KEY_SECRET_FILE: composeSecretPaths.backupEncryptionKey,
  ALERTMANAGER_WEBHOOK_URL_FILE: composeSecretPaths.alertmanagerWebhookUrl,
  COOKIE_SECURE: 'true',
  NEXT_PUBLIC_API_URL: '/api/v1',
  INTERNAL_API_URL: 'http://api:3000/v1',
  INTERNAL_API_V2_URL: 'http://api-v2:3002/v2',
  LUNCHLINEUP_STATUS_HEALTH_URL: 'http://api:3000/health',
  NEXT_PUBLIC_OIDC_ENABLED: 'false',
  OIDC_ENABLED: 'false',
  PUBLIC_SIGNUP_MODE: 'closed_beta',
  NEXT_PUBLIC_SIGNUP_MODE: 'closed_beta',
  PUBLIC_SIGNUP_INVITE_CODES: '',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
  NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: 'privacy@smoke.lunchlineup.test',
  NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@smoke.lunchlineup.test',
  NEXT_PUBLIC_DPA_CONTACT_EMAIL: 'dpa@smoke.lunchlineup.test',
  APP_ORIGIN: 'https://smoke.lunchlineup.test',
  NEXT_PUBLIC_APP_ORIGIN: 'https://smoke.lunchlineup.test',
  NEXT_PUBLIC_APP_URL: 'https://smoke.lunchlineup.test',
  NEXT_PUBLIC_APP_ENV: 'smoke',
};

mkdirSync(dirname(envPath), { recursive: true });
for (const path of Object.values(secretPaths)) {
  mkdirSync(dirname(path), { recursive: true });
}
mkdirSync(resolve(root, 'secrets/pitr-object-store'), { recursive: true });
writeFileSync(envPath, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {
  mode: 0o600,
});

const secretFileContents = {
  [secretPaths.metricsToken]: `${metricsToken}\n`,
  [secretPaths.controlPlaneAdminToken]: `${controlPlaneAdminToken}\n`,
  [secretPaths.retentionPurgeToken]: `${retentionPurgeToken}\n`,
  [secretPaths.alertmanagerWebhookUrl]: 'https://alerts.invalid/lunchlineup-smoke\n',
  [secretPaths.backupEncryptionKey]: `${backupEncryptionKey}\n`,
};
for (const [path, contents] of Object.entries(secretFileContents)) {
  writeFileSync(path, contents, { mode: 0o600 });
}
