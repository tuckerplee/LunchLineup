import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const validator = join(root, 'scripts/validate-production-launch.mjs');

const composeSecretSources = {
  control_plane_admin_token: 'CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE',
  metrics_token: 'METRICS_TOKEN_FILE',
  retention_purge_token: 'RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE',
  alertmanager_webhook_url: 'ALERTMANAGER_WEBHOOK_URL_FILE',
  backup_encryption_key: 'BACKUP_ENCRYPTION_KEY_SECRET_FILE',
};

function portablePath(path) {
  return path.replaceAll('\\', '/');
}

function writeFixtureFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function run(envText, extraArgs = []) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-launch-env-'));
  const envPath = join(scratch, 'runtime.env');
  writeFileSync(envPath, envText, 'utf8');
  const result = spawnSync(process.execPath, [validator, envPath, ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
  });
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

function createProductionSecretFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'll-production-secrets-'));
  const files = {};
  const overrides = {};

  for (const [composeName, envKey] of Object.entries(composeSecretSources)) {
    const path = join(scratch, 'secrets', 'compose', composeName);
    writeFixtureFile(path, `${envKey}-fixture-value\n`);
    files[envKey] = path;
    overrides[envKey] = portablePath(path);
  }

  for (const [role, envKey] of [
    ['wal', 'PITR_WAL_OBJECT_STORE_SECRETS_DIR'],
    ['base-backup', 'PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR'],
    ['restore', 'PITR_RESTORE_OBJECT_STORE_SECRETS_DIR'],
    ['lifecycle-audit', 'PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR'],
  ]) {
    const directory = join(scratch, 'secrets', 'pitr', role);
    const accessKey = join(directory, 'access_key');
    const secretKey = join(directory, 'secret_key');
    writeFixtureFile(accessKey, `${role}-access-key-fixture\n`);
    writeFixtureFile(secretKey, `${role}-secret-key-fixture\n`);
    overrides[envKey] = portablePath(directory);
    files[`${envKey}_ACCESS_KEY`] = accessKey;
    files[`${envKey}_SECRET_KEY`] = secretKey;
  }

  const lifecycleProof = join(scratch, 'proofs', 'pitr-lifecycle-policy.json');
  writeFixtureFile(lifecycleProof, '{"schemaVersion":1}\n');
  overrides.PITR_LIFECYCLE_POLICY_PROOF_FILE = portablePath(lifecycleProof);
  files.PITR_LIFECYCLE_POLICY_PROOF_FILE = lifecycleProof;
  const authorizationSimulator = join(scratch, 'bin', 'pitr-provider-authorization-simulator');
  writeFixtureFile(authorizationSimulator, '#!/bin/sh\nexit 0\n');
  chmodSync(authorizationSimulator, 0o700);
  overrides.PITR_AUTHORIZATION_SIMULATOR_FILE = portablePath(authorizationSimulator);
  files.PITR_AUTHORIZATION_SIMULATOR_FILE = authorizationSimulator;

  return {
    root: scratch,
    files,
    overrides,
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function renderCompose(envText) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-rendered-compose-'));
  const envPath = join(scratch, 'production.env');
  const childEnv = { ...process.env };
  for (const line of envText.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) delete childEnv[line.slice(0, separator)];
  }
  childEnv.COMPOSE_PROJECT_NAME = 'lunchlineup-production-fixture';
  writeFileSync(
    envPath,
    `${envText}COMPOSE_SERVICE_ENV_FILE=${portablePath(envPath)}\n`,
    'utf8',
  );

  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'docker.exe' : 'docker',
      ['compose', '--env-file', envPath, '--profile', '*', 'config', '--format', 'json'],
      {
        cwd: root,
        encoding: 'utf8',
        env: childEnv,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    assert.equal(
      result.status,
      0,
      `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
    return JSON.parse(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function validEnv(overrides = {}) {
  const values = {
    NODE_ENV: 'production',
    DATA_TARGET_ENV: 'production',
    MIGRATION_PRODUCTION_CONFIRM: 'apply-lunchlineup-production-migrations',
    DOMAIN: 'lunchlineup.com',
    PRODUCTION_API_HEALTH_URL: 'https://lunchlineup.com/api/health',
    ADMIN_EMAIL: 'ops@lunchlineup.com',
    CADDY_SITE_ADDRESSES: 'https://lunchlineup.com, https://www.lunchlineup.com',
    ALLOWED_HOSTS: 'lunchlineup.com,www.lunchlineup.com',
    ALLOWED_ORIGINS: 'https://lunchlineup.com,https://www.lunchlineup.com',
    COOKIE_SECURE: 'true',
    POSTGRES_USER: 'lunchlineup_admin',
    POSTGRES_PASSWORD: 'pg_abcdefghijklmnopqrstuvwxyz123456',
    POSTGRES_DB: 'lunchlineup',
    APP_DB_USER: 'lunchlineup_app',
    APP_DB_PASSWORD: 'app_pg_abcdefghijklmnopqrstuvwxyz123456',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'platform_admin_db_abcdefghijklmnopqrstuvwxyz123456',
    DATABASE_URL: 'postgresql://lunchlineup_app:app_pg_abcdefghijklmnopqrstuvwxyz123456@postgres:5432/lunchlineup',
    MIGRATION_DATABASE_URL: 'postgresql://lunchlineup_admin:pg_abcdefghijklmnopqrstuvwxyz123456@postgres:5432/lunchlineup',
    REDIS_URL: 'redis://redis:6379',
    RABBITMQ_USER: 'lunchlineup',
    RABBITMQ_PASSWORD: 'mq_abcdefghijklmnopqrstuvwxyz123456',
    RABBITMQ_URL: 'amqp://lunchlineup:mq_abcdefghijklmnopqrstuvwxyz123456@rabbitmq:5672',
    API_HOST_BIND: '127.0.0.1',
    JWT_SECRET: 'jwt_abcdefghijklmnopqrstuvwxyz1234567890',
    JWT_REFRESH_SECRET: 'refresh_abcdefghijklmnopqrstuvwxyz1234567890',
    SESSION_SECRET: 'session_abcdefghijklmnopqrstuvwxyz1234567890',
    MFA_SECRET_ENCRYPTION_KEY_CURRENT: '1111111111111111111111111111111111111111111111111111111111111111',
    MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: '',
    MFA_SECRET_ENCRYPTION_KEY: '',
    WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    AVAILABILITY_IMPORT_ENCRYPTION_KEY: '2222222222222222222222222222222222222222222222222222222222222222',
    STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY: '3333333333333333333333333333333333333333333333333333333333333333',
    PASSWORD_RESET_EMAIL_OUTBOX_ENABLED: 'true',
    STAFF_INVITATION_OUTBOX_ENABLED: 'true',
    CSRF_SECRET: 'csrf_abcdefghijklmnopqrstuvwxyz1234567890',
    RESEND_API_KEY: 're_abcdefghijklmnopqrstuvwxyz123456',
    RESEND_WEBHOOK_SECRET: 'whsec_abcdefghijklmnopqrstuvwxyz123456',
    EMAIL_FROM: 'LunchLineup <no-reply@lunchlineup.com>',
    STRIPE_SECRET_KEY: ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz123456'].join('_'),
    STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnopqrstuvwxyz123456',
    STRIPE_WEBHOOK_ENDPOINT_ID: 'we_1234567890abcdef',
    STRIPE_METER_ERROR_WEBHOOK_SECRET: 'whsec_metererrorabcdefghijklmnopqrstuvwxyz',
    STRIPE_METER_ERROR_EVENT_DESTINATION_ID: 'ed_live_1234567890abcdef',
    STRIPE_PRICE_STARTER: 'price_starter1234567890',
    STRIPE_PRICE_GROWTH: 'price_growth1234567890',
    STRIPE_PRICE_ENTERPRISE: 'price_enterprise1234567890',
    STRIPE_METER_ID: 'mtr_1234567890abcdef',
    STRIPE_METER_AGGREGATION: 'last',
    STRIPE_METERED_USAGE_ENABLED: 'true',
    STRIPE_METER_EVENT_NAME: 'll.active_staff',
    STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS: '300',
    METRICS_TOKEN_FILE: '/run/secrets/metrics_token',
    RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE: '/run/secrets/retention_purge_token',
    CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE: '/run/secrets/control_plane_admin_token.host',
    CONTROL_PLANE_ADMIN_TOKEN_FILE: '/run/secrets/control_plane_admin_token',
    BACKUP_ENCRYPTION_KEY_SECRET_FILE: '/run/secrets/backup_key',
    BACKUP_OFFSITE_URI: 's3://lunchlineup-prod/db-backups/',
    BACKUP_OFFSITE_RETENTION_DAYS: '35',
    BACKUP_OFFSITE_RETENTION_DRY_RUN: 'false',
    BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS: '90',
    BACKUP_METRICS_FILE: '/var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom',
    PITR_ENABLED: 'true',
    PITR_ARCHIVE_MODE: 'on',
    PITR_S3_ENDPOINT: 'https://s3.us-west-2.amazonaws.com',
    PITR_S3_BUCKET: 'lunchlineup-prod-pitr',
    PITR_S3_PREFIX: 'lunchlineup/production/cluster-01',
    PITR_WAL_OBJECT_STORE_SECRETS_DIR: '/run/secrets/pitr-wal-object-store',
    PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR: '/run/secrets/pitr-base-backup-object-store',
    PITR_RESTORE_OBJECT_STORE_SECRETS_DIR: '/run/secrets/pitr-restore-object-store',
    PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR: '/run/secrets/pitr-lifecycle-audit-object-store',
    PITR_OBJECT_LOCK_RETENTION_DAYS: '14',
    PITR_LIFECYCLE_MAX_RETENTION_DAYS: '35',
    PITR_LIFECYCLE_POLICY_PROOF_FILE: '/etc/lunchlineup/pitr-lifecycle-policy.json',
    PITR_LIFECYCLE_POLICY_PROOF_URI: 's3://lunchlineup-prod/pitr-policy/lifecycle-policy-20260714.json',
    PITR_LIFECYCLE_POLICY_SHA256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    PITR_AUTHORIZATION_SIMULATOR_FILE: '/usr/local/libexec/lunchlineup-pitr-authorization-simulator',
    PITR_AUTHORIZATION_SIMULATOR_SHA256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS: '60',
    ALERTMANAGER_WEBHOOK_URL_FILE: '/run/secrets/alertmanager_webhook_url',
    GRAFANA_USER: 'lunchlineup_admin',
    GRAFANA_PASSWORD: 'grafana_abcdefghijklmnopqrstuvwxyz123456',
    CONTROL_PLANE_PASSWORD: 'control_abcdefghijklmnopqrstuvwxyz123456',
    NEXT_PUBLIC_API_URL: '/api/v1',
    APP_ORIGIN: 'https://lunchlineup.com',
    NEXT_PUBLIC_APP_ORIGIN: 'https://lunchlineup.com',
    NEXT_PUBLIC_APP_URL: 'https://lunchlineup.com',
    NEXT_PUBLIC_APP_ENV: 'production',
    NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: 'privacy@lunchlineup.com',
    NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@lunchlineup.com',
    NEXT_PUBLIC_DPA_CONTACT_EMAIL: 'dpa@lunchlineup.com',
    PAID_GA_LEGAL_APPROVED: 'true',
    PAID_GA_CONTRACTING_ENTITY: 'LunchLineup Incorporated',
    PAID_GA_TERMS_VERSION: '2026-07-01',
    PAID_GA_DPA_VERSION: '2026-07-01',
    PAID_GA_COUNSEL_APPROVAL_OWNER: 'legal@lunchlineup.com',
    PAID_GA_COUNSEL_APPROVED_AT: '2026-07-01',
    PAID_GA_INCIDENT_NOTICE_HOURS: '72',
    PAID_GA_SIGNATURE_PROCESS: 'countersigned-dpa-workflow',
    PAID_GA_TRANSFER_TERMS: 'standard-contractual-clauses',
    PAID_GA_CONTACT_OWNER_EMAIL: 'legal-operations@lunchlineup.com',
    PAID_GA_APPROVAL_RECORD_URI: 's3://lunchlineup-prod/legal/paid-ga-approval-20260701.json',
    PUBLIC_SIGNUP_MODE: 'closed_beta',
    NEXT_PUBLIC_SIGNUP_MODE: 'closed_beta',
    PUBLIC_SIGNUP_INVITE_CODES: '',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
    LUNCHLINEUP_STATUS_HEALTH_URL: 'https://lunchlineup.com/health',
    LAUNCH_PROOF_MANIFEST_URI: 'https://artifacts.lunchlineup.com/launch-proof/launch-proof-20260709.json',
    LAUNCH_PROOF_DAST_URL: 'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/111',
    LAUNCH_PROOF_LOAD_TEST_URL: 'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/112',
    LAUNCH_PROOF_DR_DRILL_URI: 's3://lunchlineup-prod/launch-proof/dr-drill-20260709.json',
    LAUNCH_PROOF_ALERT_ROUTE_URL: 'https://pagerduty.com/incidents/ABC123',
    LAUNCH_PROOF_EXTERNAL_HEALTH_URL: 'https://status.lunchlineup.com/checks/api-health-20260709',
    OIDC_ENABLED: 'false',
    NEXT_PUBLIC_OIDC_ENABLED: 'false',
    ...overrides,
  };

  return `${Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

test('production launch validator accepts a real public launch profile', () => {
  const result = run(validEnv());

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.checked.includes('STRIPE_SECRET_KEY'));
  assert.ok(payload.checked.includes('STRIPE_METER_ID'));
  assert.ok(payload.checked.includes('STRIPE_METER_AGGREGATION'));
  assert.ok(payload.checked.includes('STRIPE_METERED_USAGE_ENABLED'));
  assert.ok(payload.checked.includes('STRIPE_METER_EVENT_NAME'));
  assert.ok(payload.checked.includes('DOMAIN'));
  assert.ok(payload.checked.includes('MFA_SECRET_ENCRYPTION_KEY_CURRENT'));
  assert.ok(payload.checked.includes('PLATFORM_ADMIN_DB_CONTEXT_SECRET'));
  assert.ok(payload.checked.includes('WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT'));
  assert.ok(payload.checked.includes('PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY'));
  assert.ok(payload.checked.includes('AVAILABILITY_IMPORT_ENCRYPTION_KEY'));
  assert.ok(payload.checked.includes('STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY'));
  assert.ok(payload.checked.includes('PASSWORD_RESET_EMAIL_OUTBOX_ENABLED'));
  assert.ok(payload.checked.includes('STAFF_INVITATION_OUTBOX_ENABLED'));
  assert.ok(payload.checked.includes('RESEND_WEBHOOK_SECRET'));
  assert.ok(payload.checked.includes('APP_ORIGIN'));
  assert.ok(payload.checked.includes('NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL'));
  assert.ok(payload.checked.includes('PAID_GA_LEGAL_APPROVED'));
  assert.ok(payload.checked.includes('PAID_GA_APPROVAL_RECORD_URI'));
  assert.ok(payload.checked.includes('NEXT_PUBLIC_APP_ENV'));
  assert.ok(payload.checked.includes('PUBLIC_SIGNUP_MODE'));
  assert.ok(payload.checked.includes('NEXT_PUBLIC_API_URL'));
  assert.ok(payload.checked.includes('NEXT_PUBLIC_OIDC_ENABLED'));
  assert.ok(payload.checked.includes('DATABASE_ROLE_ISOLATION'));
  assert.ok(payload.checked.includes('PITR_LIFECYCLE_MAX_RETENTION_DAYS'));
  assert.ok(payload.checked.includes('PITR_LIFECYCLE_POLICY_PROOF_URI'));
  assert.ok(payload.checked.includes('PITR_LIFECYCLE_POLICY_SHA256'));
  assert.ok(payload.checked.includes('PITR_ARCHIVE_MODE'));
  assert.ok(payload.checked.includes('PITR_AUTHORIZATION_SIMULATOR_FILE'));
  assert.ok(payload.checked.includes('PITR_AUTHORIZATION_SIMULATOR_SHA256'));
});

test('production launch validator verifies every rendered Compose and PITR secret file', () => {
  const fixture = createProductionSecretFixture();

  try {
    const envText = validEnv(fixture.overrides);
    const valid = run(envText, ['--verify-local-secret-files']);
    assert.equal(valid.status, 0, valid.stderr);
    const payload = JSON.parse(valid.stdout);
    for (const envKey of Object.values(composeSecretSources)) {
      assert.ok(payload.checked.includes(envKey), envKey);
    }

    const rendered = renderCompose(envText);
    assert.deepEqual(Object.keys(rendered.secrets).sort(), Object.keys(composeSecretSources).sort());
    for (const [composeName, envKey] of Object.entries(composeSecretSources)) {
      assert.equal(resolve(rendered.secrets[composeName].file), resolve(fixture.overrides[envKey]));
    }

    rmSync(fixture.files.METRICS_TOKEN_FILE);
    const missingComposeSecret = run(validEnv(fixture.overrides), ['--verify-local-secret-files']);
    assert.notEqual(missingComposeSecret.status, 0);
    assert.match(
      missingComposeSecret.stderr,
      /METRICS_TOKEN_FILE must exist and be a readable file on the deployment host/,
    );
    writeFixtureFile(fixture.files.METRICS_TOKEN_FILE, 'restored-metrics-token-fixture\n');

    rmSync(fixture.files.PITR_RESTORE_OBJECT_STORE_SECRETS_DIR_SECRET_KEY);
    const missingPitrCredential = run(validEnv(fixture.overrides), ['--verify-local-secret-files']);
    assert.notEqual(missingPitrCredential.status, 0);
    assert.match(
      missingPitrCredential.stderr,
      /PITR_RESTORE_OBJECT_STORE_SECRETS_DIR_SECRET_KEY must exist and be a readable file on the deployment host/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('rendered production Compose uses blank MFA overlap and a dedicated Caddy loopback health route', () => {
  const fixture = createProductionSecretFixture();

  try {
    const rendered = renderCompose(validEnv(fixture.overrides));
    assert.equal(rendered.services.api.environment.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS, '');
    assert.equal(rendered.services.api.environment.MFA_SECRET_ENCRYPTION_KEY, '');
    assert.equal(
      rendered.services.proxy.environment.CADDY_SITE_ADDRESSES,
      'https://lunchlineup.com, https://www.lunchlineup.com',
    );
    assert.deepEqual(rendered.services.proxy.healthcheck.test, [
      'CMD',
      'wget',
      '--no-verbose',
      '--tries=1',
      '--spider',
      'http://127.0.0.1:2015/health',
    ]);

    const caddy = readFileSync(join(root, 'infrastructure/caddy/Caddyfile'), 'utf8');
    assert.match(caddy, /http:\/\/127\.0\.0\.1:2015 \{\s*respond \/health 200\s*\}/);
    assert.match(caddy, /\{\$CADDY_SITE_ADDRESSES:/);
  } finally {
    fixture.cleanup();
  }
});

test('production launch validator requires last-value metering and password-reset delivery', () => {
  const aggregation = run(validEnv({
    STRIPE_METER_AGGREGATION: 'sum',
  }));
  assert.notEqual(aggregation.status, 0);
  assert.match(aggregation.stderr, /STRIPE_METER_AGGREGATION must be exactly last/);

  const missingResetDelivery = run(validEnv({
    PASSWORD_RESET_EMAIL_OUTBOX_ENABLED: undefined,
  }));
  assert.notEqual(missingResetDelivery.status, 0);
  assert.match(missingResetDelivery.stderr, /PASSWORD_RESET_EMAIL_OUTBOX_ENABLED is required/);

  const disabledResetDelivery = run(validEnv({
    PASSWORD_RESET_EMAIL_OUTBOX_ENABLED: 'false',
  }));
  assert.notEqual(disabledResetDelivery.status, 0);
  assert.match(disabledResetDelivery.stderr, /PASSWORD_RESET_EMAIL_OUTBOX_ENABLED must be exactly true/);
});

test('production launch validator requires staff invitation delivery', () => {
  const missing = run(validEnv({
    STAFF_INVITATION_OUTBOX_ENABLED: undefined,
  }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /STAFF_INVITATION_OUTBOX_ENABLED is required/);

  const disabled = run(validEnv({
    STAFF_INVITATION_OUTBOX_ENABLED: 'false',
  }));
  assert.notEqual(disabled.status, 0);
  assert.match(disabled.stderr, /STAFF_INVITATION_OUTBOX_ENABLED must be exactly true/);
});

test('production launch validator fails closed without approved paid-GA legal terms', () => {
  const result = run(validEnv({
    PAID_GA_LEGAL_APPROVED: 'false',
    PAID_GA_DPA_VERSION: 'TBD',
    PAID_GA_COUNSEL_APPROVED_AT: '2099-01-01',
    PAID_GA_INCIDENT_NOTICE_HOURS: '0',
    PAID_GA_APPROVAL_RECORD_URI: 's3://lunchlineup-prod/legal/latest.json',
  }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /PAID_GA_LEGAL_APPROVED must be exactly true/);
  assert.match(result.stderr, /PAID_GA_DPA_VERSION must be an approved, non-placeholder/);
  assert.match(result.stderr, /PAID_GA_COUNSEL_APPROVED_AT must be a valid, non-future/);
  assert.match(result.stderr, /PAID_GA_INCIDENT_NOTICE_HOURS must be an approved integer/);
  assert.match(result.stderr, /PAID_GA_APPROVAL_RECORD_URI must reference a specific retained proof artifact/);
});

test('production launch validator rejects weak immutable or unbounded PITR lifecycle policy', () => {
  const result = run(validEnv({
    PITR_ENABLED: 'false',
    PITR_ARCHIVE_MODE: 'off',
    PITR_S3_ENDPOINT: 'http://localhost:9000',
    PITR_S3_PREFIX: 'lunchlineup/production/replace-with-cluster-id',
    PITR_WAL_OBJECT_STORE_SECRETS_DIR: './secrets/pitr-object-store',
    PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR: '/run/secrets/shared-pitr',
    PITR_RESTORE_OBJECT_STORE_SECRETS_DIR: '/run/secrets/shared-pitr',
    PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR: '/run/secrets/shared-pitr',
    PITR_OBJECT_LOCK_RETENTION_DAYS: '8',
    PITR_LIFECYCLE_MAX_RETENTION_DAYS: '120',
    PITR_LIFECYCLE_POLICY_PROOF_FILE: './proofs/lifecycle.json',
    PITR_LIFECYCLE_POLICY_PROOF_URI: 's3://lunchlineup-prod/pitr-policy/latest.json',
    PITR_LIFECYCLE_POLICY_SHA256: 'not-a-sha',
    PITR_AUTHORIZATION_SIMULATOR_FILE: './scripts/fake-simulator',
    PITR_AUTHORIZATION_SIMULATOR_SHA256: 'not-a-sha',
    PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS: '0',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PITR_ENABLED must be exactly true/);
  assert.match(result.stderr, /PITR_ARCHIVE_MODE must be exactly on/);
  assert.match(result.stderr, /PITR_S3_ENDPOINT must use https/);
  assert.match(result.stderr, /PITR_S3_PREFIX must be a dedicated cluster-specific prefix/);
  assert.match(result.stderr, /PITR_WAL_OBJECT_STORE_SECRETS_DIR must be an absolute managed-secret directory/);
  assert.match(result.stderr, /PITR WAL, base-backup, restore, and lifecycle-audit identities must use distinct/);
  assert.match(result.stderr, /PITR_OBJECT_LOCK_RETENTION_DAYS must be an integer of at least 14/);
  assert.match(result.stderr, /PITR_LIFECYCLE_MAX_RETENTION_DAYS must be an integer/);
  assert.match(result.stderr, /PITR_LIFECYCLE_POLICY_PROOF_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /PITR_LIFECYCLE_POLICY_PROOF_URI must reference a specific retained proof artifact/);
  assert.match(result.stderr, /PITR_LIFECYCLE_POLICY_SHA256 must be 64 lowercase hex characters/);
  assert.match(result.stderr, /PITR_AUTHORIZATION_SIMULATOR_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /PITR_AUTHORIZATION_SIMULATOR_SHA256 must be 64 lowercase hex characters/);
  assert.match(result.stderr, /PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS must be an integer/);
});

test('production launch validator rejects mutable logical-backup providers and operator-owned expiry', () => {
  for (const [overrides, expected] of [
    [{ BACKUP_OFFSITE_URI: 'rclone:production/db-backups' }, /mutable rclone is forbidden in production/],
    [{ BACKUP_OFFSITE_RETENTION_DRY_RUN: 'true' }, /BACKUP_OFFSITE_RETENTION_DRY_RUN must be exactly false/],
    [{ BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS: '14' }, /must cover immutable logical-backup retention/],
  ]) {
    const result = run(validEnv(overrides));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});

test('production launch validator rejects shared database owner and runtime credentials', () => {
  const result = run(validEnv({
    APP_DB_USER: 'lunchlineup_admin',
    APP_DB_PASSWORD: 'pg_abcdefghijklmnopqrstuvwxyz123456',
    DATABASE_URL: 'postgresql://lunchlineup_admin:pg_abcdefghijklmnopqrstuvwxyz123456@postgres:5432/lunchlineup',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_DB_USER must be distinct from POSTGRES_USER/);
  assert.match(result.stderr, /APP_DB_PASSWORD must be distinct from POSTGRES_PASSWORD/);
});

test('production launch validator rejects database URLs using the wrong roles or targets', () => {
  const result = run(validEnv({
    DATABASE_URL: 'postgresql://lunchlineup_admin:pg_abcdefghijklmnopqrstuvwxyz123456@postgres:5432/lunchlineup',
    MIGRATION_DATABASE_URL: 'postgresql://lunchlineup_admin:pg_abcdefghijklmnopqrstuvwxyz123456@other-db:5432/lunchlineup',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL must authenticate with APP_DB_USER and APP_DB_PASSWORD/);
  assert.match(result.stderr, /must target the same PostgreSQL database/);
});

test('production launch validator rejects Prisma-only runtime database URL options', () => {
  const result = run(validEnv({
    DATABASE_URL: 'postgresql://lunchlineup_app:app_pg_abcdefghijklmnopqrstuvwxyz123456@postgres:5432/lunchlineup?schema=public',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL must not include query parameters or fragments/);
});

test('production launch validator rejects an external database not protected by Compose recovery', () => {
  const result = run(validEnv({
    DATABASE_URL: 'postgresql://lunchlineup_app:app_pg_abcdefghijklmnopqrstuvwxyz123456@db.prod.example:5432/lunchlineup',
    MIGRATION_DATABASE_URL: 'postgresql://lunchlineup_admin:pg_abcdefghijklmnopqrstuvwxyz123456@db.prod.example:5432/lunchlineup',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must target Compose service postgres:5432\/POSTGRES_DB/);
});

test('production launch validator accepts percent-encoded reserved-character credentials', () => {
  const ownerPassword = 'owner:@/?[]%abcdefghijklmnopqrstuvwxyz';
  const appPassword = 'app:@/?[]%abcdefghijklmnopqrstuvwxyz';
  const rabbitPassword = 'rabbit:@/?[]%abcdefghijklmnopqrst';
  const result = run(validEnv({
    POSTGRES_PASSWORD: ownerPassword,
    APP_DB_PASSWORD: appPassword,
    RABBITMQ_PASSWORD: rabbitPassword,
    DATABASE_URL: `postgresql://lunchlineup_app:${encodeURIComponent(appPassword)}@postgres:5432/lunchlineup`,
    MIGRATION_DATABASE_URL: `postgresql://lunchlineup_admin:${encodeURIComponent(ownerPassword)}@postgres:5432/lunchlineup`,
    RABBITMQ_URL: `amqp://lunchlineup:${encodeURIComponent(rabbitPassword)}@rabbitmq:5672`,
  }));

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.checked.includes('RABBITMQ_URL_CREDENTIALS'));
});

test('production launch validator rejects raw reserved-character URL credentials', () => {
  const result = run(validEnv({
    APP_DB_PASSWORD: 'app:raw-reserved-password-abcdefghijklmnopqrstuvwxyz',
    DATABASE_URL: 'postgresql://lunchlineup_app:app:raw-reserved-password-abcdefghijklmnopqrstuvwxyz@postgres:5432/lunchlineup',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL credentials must percent-encode reserved characters/);
});

test('production API health proof must be public HTTPS on DOMAIN and an API health route', () => {
  for (const value of [
    'http://lunchlineup.com/api/health',
    'https://127.0.0.1/api/health',
    'https://status.lunchlineup.com/api/health',
    'https://lunchlineup.com/admin',
  ]) {
    const result = run(validEnv({ PRODUCTION_API_HEALTH_URL: value }));
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /PRODUCTION_API_HEALTH_URL/);
  }
});

test('production launch validator rejects open signup even with Turnstile keys', () => {
  const result = run(validEnv({
    PUBLIC_SIGNUP_MODE: 'open',
    NEXT_PUBLIC_SIGNUP_MODE: 'open',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAABBBBBBBBBCCCC',
    TURNSTILE_SECRET_KEY: '0x4AAAAAAABBBBBBBBBCCCCDDDDDDDDDDDDDD',
  }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must both be closed_beta while the checked-in Terms are not counsel-approved and versioned/);
});

test('production launch validator rejects invite-only signup even with generated codes', () => {
  const result = run(validEnv({
    PUBLIC_SIGNUP_MODE: 'invite_only',
    NEXT_PUBLIC_SIGNUP_MODE: 'invite_only',
    PUBLIC_SIGNUP_INVITE_CODES: 'g7K4P9xQ2rV6mT8cY3nB5sHd',
  }));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must both be closed_beta while the checked-in Terms are not counsel-approved and versioned/);
});

test('production launch validator rejects the example environment', () => {
  const result = spawnSync(process.execPath, [validator, '.env.example'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATA_TARGET_ENV must be exactly production/);
  assert.match(result.stderr, /MIGRATION_PRODUCTION_CONFIRM is required/);
  assert.match(result.stderr, /DOMAIN must be a real public hostname/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY is required/);
  assert.match(result.stderr, /METRICS_TOKEN_FILE must be an absolute managed-secret path/);
});

test('production launch validator rejects placeholder public contacts and unsafe signup modes', () => {
  const result = run(validEnv({
    NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL: 'privacy@example.com',
    NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL: 'support@lunchlineup.example',
    NEXT_PUBLIC_DPA_CONTACT_EMAIL: 'LunchLineup DPA <dpa@lunchlineup.com>',
    PUBLIC_SIGNUP_MODE: 'public',
    NEXT_PUBLIC_SIGNUP_MODE: 'open',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL must use a real public mailbox domain/);
  assert.match(result.stderr, /NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL must use a real public mailbox domain/);
  assert.match(result.stderr, /NEXT_PUBLIC_DPA_CONTACT_EMAIL must be a bare email address/);
  assert.match(result.stderr, /PUBLIC_SIGNUP_MODE must be one of: closed_beta, invite_only, open/);
  assert.match(result.stderr, /PUBLIC_SIGNUP_MODE and NEXT_PUBLIC_SIGNUP_MODE must match/);
});

test('production launch validator keeps invite-only closed regardless of code quality', () => {
  const result = run(validEnv({
    PUBLIC_SIGNUP_MODE: 'invite_only',
    NEXT_PUBLIC_SIGNUP_MODE: 'invite_only',
    PUBLIC_SIGNUP_INVITE_CODES: 'invite_code,abcdefghijklmnopqrstuvwx',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must both be closed_beta while the checked-in Terms are not counsel-approved and versioned/);
});

test('production launch validator keeps open signup closed regardless of Turnstile configuration', () => {
  const result = run(validEnv({
    PUBLIC_SIGNUP_MODE: 'open',
    NEXT_PUBLIC_SIGNUP_MODE: 'open',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must both be closed_beta while the checked-in Terms are not counsel-approved and versioned/);
});

test('production launch validator rejects omitted and blank APP_ORIGIN', () => {
  for (const value of [undefined, '', '   ']) {
    const result = run(validEnv({ APP_ORIGIN: value }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_ORIGIN must be a valid https URL/);
  }
});

test('production launch validator rejects unsafe public app URLs', () => {
  const result = run(validEnv({
    NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
    NEXT_PUBLIC_APP_URL: 'https://example.com',
    NEXT_PUBLIC_APP_ENV: 'preview',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NEXT_PUBLIC_APP_ORIGIN must use https/);
  assert.match(result.stderr, /NEXT_PUBLIC_APP_URL must use a real public hostname/);
  assert.match(result.stderr, /NEXT_PUBLIC_APP_ENV must be production/);
});

test('production launch validator rejects non-same-origin public API URLs', () => {
  for (const value of [
    'https://api.lunchlineup.com/api/v1',
    'https://lunchlineup.com/api/v1',
    '/api/v2',
    '/v1',
  ]) {
    const result = run(validEnv({ NEXT_PUBLIC_API_URL: value }));

    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /NEXT_PUBLIC_API_URL must be exactly \/api\/v1/);
  }
});

test('production launch validator requires OIDC on both API and web before SSO-only launch', () => {
  const apiOnly = run(validEnv({
    OIDC_ENABLED: 'true',
    NEXT_PUBLIC_OIDC_ENABLED: 'false',
    OIDC_ISSUER_URL: 'https://accounts.lunchlineup.com',
    OIDC_CLIENT_ID: 'lunchlineup-prod',
    OIDC_CLIENT_SECRET: 'oidc_abcdefghijklmnopqrstuvwxyz1234567890',
    OIDC_REDIRECT_URI: 'https://lunchlineup.com/api/v1/auth/callback',
  }));
  assert.notEqual(apiOnly.status, 0);
  assert.match(apiOnly.stderr, /OIDC_ENABLED and NEXT_PUBLIC_OIDC_ENABLED must match/);

  const webOnly = run(validEnv({
    OIDC_ENABLED: 'false',
    NEXT_PUBLIC_OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://accounts.lunchlineup.com',
    OIDC_CLIENT_ID: 'lunchlineup-prod',
    OIDC_CLIENT_SECRET: 'oidc_abcdefghijklmnopqrstuvwxyz1234567890',
    OIDC_REDIRECT_URI: 'https://lunchlineup.com/api/v1/auth/callback',
  }));
  assert.notEqual(webOnly.status, 0);
  assert.match(webOnly.stderr, /OIDC_ENABLED and NEXT_PUBLIC_OIDC_ENABLED must match/);

  const missingSecret = run(validEnv({
    OIDC_ENABLED: 'true',
    NEXT_PUBLIC_OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://accounts.lunchlineup.com',
    OIDC_CLIENT_ID: 'lunchlineup-prod',
    OIDC_CLIENT_SECRET: '',
    OIDC_REDIRECT_URI: 'https://lunchlineup.com/api/v1/auth/callback',
  }));
  assert.notEqual(missingSecret.status, 0);
  assert.match(missingSecret.stderr, /OIDC_CLIENT_SECRET is required/);

  const externalCallback = run(validEnv({
    OIDC_ENABLED: 'true',
    NEXT_PUBLIC_OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://accounts.lunchlineup.com',
    OIDC_CLIENT_ID: 'lunchlineup-prod',
    OIDC_CLIENT_SECRET: 'oidc_abcdefghijklmnopqrstuvwxyz1234567890',
    OIDC_REDIRECT_URI: 'https://auth.lunchlineup.com/callback',
  }));
  assert.notEqual(externalCallback.status, 0);
  assert.match(externalCallback.stderr, /OIDC_REDIRECT_URI must use DOMAIN/);
});

test('production launch validator accepts OIDC when API and web login are both available', () => {
  const result = run(validEnv({
    OIDC_ENABLED: 'true',
    NEXT_PUBLIC_OIDC_ENABLED: 'true',
    OIDC_ISSUER_URL: 'https://accounts.lunchlineup.com',
    OIDC_CLIENT_ID: 'lunchlineup-prod',
    OIDC_CLIENT_SECRET: 'oidc_abcdefghijklmnopqrstuvwxyz1234567890',
    OIDC_REDIRECT_URI: 'https://lunchlineup.com/api/v1/auth/callback',
  }));

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.checked.includes('OIDC_ENABLED'));
  assert.ok(payload.checked.includes('NEXT_PUBLIC_OIDC_ENABLED'));
  assert.ok(payload.checked.includes('OIDC_REDIRECT_URI'));
});

test('production launch validator blocks smoke-only payment and local secret values', () => {
  const result = run(validEnv({
    DATA_TARGET_ENV: 'development',
    MIGRATION_PRODUCTION_CONFIRM: '',
    DOMAIN: 'app.example.com',
    ALLOWED_HOSTS: 'app.example.com,localhost',
    ALLOWED_ORIGINS: 'https://app.example.com,http://localhost',
    CADDY_SITE_ADDRESSES: 'http://app.example.com',
    STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnopqrstuvwxyz123456',
    STRIPE_WEBHOOK_ENDPOINT_ID: '',
    STRIPE_METER_ERROR_WEBHOOK_SECRET: '',
    STRIPE_METER_ERROR_EVENT_DESTINATION_ID: '',
    STRIPE_PRICE_STARTER: '',
    STRIPE_METER_ID: '',
    STRIPE_METERED_USAGE_ENABLED: 'false',
    STRIPE_METER_EVENT_NAME: '',
    STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS: '',
    METRICS_TOKEN_FILE: './secrets/metrics_token',
    RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE: './secrets/retention_purge_token',
    CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE: './secrets/control_plane_admin_token',
    API_HOST_BIND: '0.0.0.0',
    BACKUP_ENCRYPTION_KEY_SECRET_FILE: './secrets/backup_key',
    BACKUP_OFFSITE_URI: 'file:///backups',
    BACKUP_METRICS_FILE: './backup.prom',
    ALERTMANAGER_WEBHOOK_URL_FILE: './secrets/alertmanager_webhook_url',
    LUNCHLINEUP_STATUS_HEALTH_URL: 'http://localhost/health',
    LAUNCH_PROOF_MANIFEST_URI: 's3://lunchlineup-prod/launch-proof/latest.json',
    LAUNCH_PROOF_DAST_URL: '',
    LAUNCH_PROOF_LOAD_TEST_URL: 'https://example.com/load/latest',
    LAUNCH_PROOF_DR_DRILL_URI: 's3://lunchlineup-prod/launch-proof/latest.json',
    LAUNCH_PROOF_ALERT_ROUTE_URL: 'http://ops.example.com/alert',
    LAUNCH_PROOF_EXTERNAL_HEALTH_URL: 'https://localhost/checks/api-health',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DOMAIN must be a real public hostname/);
  assert.match(result.stderr, /STRIPE_SECRET_KEY must be a live Stripe secret key/);
  assert.match(result.stderr, /STRIPE_WEBHOOK_ENDPOINT_ID is required/);
  assert.match(result.stderr, /STRIPE_METER_ERROR_WEBHOOK_SECRET is required/);
  assert.match(result.stderr, /STRIPE_METER_ERROR_EVENT_DESTINATION_ID is required/);
  assert.match(result.stderr, /STRIPE_PRICE_STARTER is required/);
  assert.match(result.stderr, /STRIPE_METER_ID is required/);
  assert.match(result.stderr, /STRIPE_METERED_USAGE_ENABLED must be true/);
  assert.match(result.stderr, /STRIPE_METER_EVENT_NAME is required/);
  assert.match(result.stderr, /STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS is required/);
  assert.match(result.stderr, /METRICS_TOKEN_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /API_HOST_BIND must bind only to loopback/);
  assert.match(result.stderr, /BACKUP_ENCRYPTION_KEY_SECRET_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /BACKUP_OFFSITE_URI must point at off-host storage/);
  assert.match(result.stderr, /BACKUP_METRICS_FILE must be an absolute Prometheus textfile collector/);
  assert.match(result.stderr, /ALERTMANAGER_WEBHOOK_URL_FILE must be an absolute managed-secret path/);
  assert.match(result.stderr, /LUNCHLINEUP_STATUS_HEALTH_URL must use https/);
  assert.match(result.stderr, /LAUNCH_PROOF_MANIFEST_URI must reference a specific retained proof artifact/);
  assert.match(result.stderr, /LAUNCH_PROOF_DAST_URL is required/);
  assert.match(result.stderr, /LAUNCH_PROOF_LOAD_TEST_URL must use a real public hostname/);
  assert.match(result.stderr, /LAUNCH_PROOF_DR_DRILL_URI must reference a specific retained proof artifact/);
  assert.match(result.stderr, /LAUNCH_PROOF_ALERT_ROUTE_URL must use https/);
  assert.match(result.stderr, /LAUNCH_PROOF_EXTERNAL_HEALTH_URL must use a real public hostname/);
});

test('production launch validator rejects absolute paths inside the repo-local secrets tree', () => {
  const result = run(validEnv({
    METRICS_TOKEN_FILE: portablePath(join(root, 'secrets', 'metrics_token')),
    PITR_WAL_OBJECT_STORE_SECRETS_DIR: portablePath(join(root, 'secrets', 'pitr-wal')),
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /METRICS_TOKEN_FILE cannot point at the repo-local secrets directory/);
  assert.match(result.stderr, /PITR_WAL_OBJECT_STORE_SECRETS_DIR cannot point at the repo-local secrets directory/);
});

test('production launch validator rejects reused managed-secret paths across roles', () => {
  const result = run(validEnv({
    CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE: '/run/secrets/metrics_token',
  }));

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE must use a separate managed secret file from METRICS_TOKEN_FILE/,
  );
});

test('production launch validator rejects reused credential material without printing it', () => {
  const fixture = createProductionSecretFixture();

  try {
    const reusedComposeCredential = readFileSync(fixture.files.METRICS_TOKEN_FILE, 'utf8');
    const reusedPitrCredential = readFileSync(
      fixture.files.PITR_WAL_OBJECT_STORE_SECRETS_DIR_ACCESS_KEY,
      'utf8',
    );
    writeFixtureFile(fixture.files.RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE, reusedComposeCredential);
    writeFixtureFile(
      fixture.files.PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR_ACCESS_KEY,
      reusedPitrCredential,
    );

    const result = run(validEnv(fixture.overrides), ['--verify-local-secret-files']);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE must not reuse credential material from METRICS_TOKEN_FILE/,
    );
    assert.match(
      result.stderr,
      /PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR_ACCESS_KEY must not reuse credential material from PITR_WAL_OBJECT_STORE_SECRETS_DIR_ACCESS_KEY/,
    );
    assert.doesNotMatch(result.stderr, new RegExp(reusedComposeCredential.trim()));
    assert.doesNotMatch(result.stderr, new RegExp(reusedPitrCredential.trim()));
  } finally {
    fixture.cleanup();
  }
});

test('production launch validator rejects invalid managed MFA encryption keys', () => {
  const missing = run(validEnv({ MFA_SECRET_ENCRYPTION_KEY_CURRENT: '' }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MFA_SECRET_ENCRYPTION_KEY_CURRENT is required/);

  const malformed = run(validEnv({ MFA_SECRET_ENCRYPTION_KEY_CURRENT: 'short' }));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /MFA_SECRET_ENCRYPTION_KEY_CURRENT must decode to exactly 32 bytes/);

  const duplicate = run(validEnv({
    MFA_SECRET_ENCRYPTION_KEY_PREVIOUS: '1111111111111111111111111111111111111111111111111111111111111111',
  }));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /MFA_SECRET_ENCRYPTION_KEY_PREVIOUS must differ/);
});

test('production launch validator rejects missing or malformed webhook delivery encryption key', () => {
  const missing = run(validEnv({ WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: '' }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT is required/);

  const malformed = run(validEnv({ WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: 'short-webhook-key' }));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT must decode to exactly 32 bytes/);
});

test('production launch validator rejects a missing Resend feedback signing secret', () => {
  const missing = run(validEnv({ RESEND_WEBHOOK_SECRET: '' }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RESEND_WEBHOOK_SECRET is required/);
});

test('production launch validator rejects missing or malformed password reset outbox encryption key', () => {
  const missing = run(validEnv({ PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: '' }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY is required/);

  const malformed = run(validEnv({ PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY: 'short-reset-key' }));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY must decode to exactly 32 bytes/);
});

test('production launch validator requires an isolated staff invitation outbox encryption key', () => {
  const missing = run(validEnv({ STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY: '' }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY is required/);

  const malformed = run(validEnv({
    STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY: 'short-invitation-key',
  }));
  assert.notEqual(malformed.status, 0);
  assert.match(
    malformed.stderr,
    /STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY must decode to exactly 32 bytes/,
  );

  const reused = run(validEnv({
    STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY: '1111111111111111111111111111111111111111111111111111111111111111',
  }));
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /must not reuse encryption key material from MFA_SECRET_ENCRYPTION_KEY_CURRENT/);
});

test('production launch validator requires an isolated availability import encryption key', () => {
  const missing = run(validEnv({ AVAILABILITY_IMPORT_ENCRYPTION_KEY: '' }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /AVAILABILITY_IMPORT_ENCRYPTION_KEY is required/);

  const malformed = run(validEnv({ AVAILABILITY_IMPORT_ENCRYPTION_KEY: 'short-source-key' }));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /AVAILABILITY_IMPORT_ENCRYPTION_KEY must decode to exactly 32 bytes/);

  const reused = run(validEnv({
    AVAILABILITY_IMPORT_ENCRYPTION_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE=',
  }));
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /must not reuse encryption key material from MFA_SECRET_ENCRYPTION_KEY_CURRENT/);
});

test('production launch validator requires an HTTPS-only downloadable launch-proof manifest', () => {
  for (const value of [
    's3://lunchlineup-prod/launch-proof/launch-proof-20260709.json',
    'rclone:launch-proof/launch-proof-20260709.json',
  ]) {
    const result = run(validEnv({ LAUNCH_PROOF_MANIFEST_URI: value }));
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /LAUNCH_PROOF_MANIFEST_URI must use a retained HTTPS proof URI/);
  }

  const retainedDrEvidence = run(validEnv({
    LAUNCH_PROOF_DR_DRILL_URI: 'rclone:launch-proof/dr-drill-20260709.json',
  }));
  assert.equal(retainedDrEvidence.status, 0, retainedDrEvidence.stderr);
});

test('production launch validator rejects placeholder launch-proof references', () => {
  const result = run(validEnv({
    LAUNCH_PROOF_MANIFEST_URI: 'https://artifacts.lunchlineup.com/launch-proof/launch-proof-YYYYMMDDHHMMSS.json',
    LAUNCH_PROOF_DAST_URL: 'https://github.com/tuckerplee/lunchlineup/actions/runs/<run-id>/artifacts/<artifact-id>',
    LAUNCH_PROOF_LOAD_TEST_URL: 'https://github.com/tuckerplee/lunchlineup/actions/runs/123456789/artifacts/<artifact-id>',
    LAUNCH_PROOF_DR_DRILL_URI: 's3://lunchlineup-prod/launch-proof/dr-drill-YYYYMMDDHHMMSS.json',
    LAUNCH_PROOF_ALERT_ROUTE_URL: 'https://pagerduty.com/incidents/<incident-id>',
    LAUNCH_PROOF_EXTERNAL_HEALTH_URL: 'https://status.lunchlineup.com/checks/api-health-YYYYMMDDHHMMSS',
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LAUNCH_PROOF_MANIFEST_URI must not contain placeholder text/);
  assert.match(result.stderr, /LAUNCH_PROOF_DAST_URL must not contain placeholder text/);
  assert.match(result.stderr, /LAUNCH_PROOF_LOAD_TEST_URL must not contain placeholder text/);
  assert.match(result.stderr, /LAUNCH_PROOF_DR_DRILL_URI must not contain placeholder text/);
  assert.match(result.stderr, /LAUNCH_PROOF_ALERT_ROUTE_URL must not contain placeholder text/);
  assert.match(result.stderr, /LAUNCH_PROOF_EXTERNAL_HEALTH_URL must not contain placeholder text/);
});

test('production launch validator help is read-only', () => {
  const output = execFileSync(process.execPath, [validator, '--help'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.match(output, /Usage: node scripts\/validate-production-launch\.mjs/);
});
