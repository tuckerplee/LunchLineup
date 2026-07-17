import { PLACEHOLDER_RE } from './production-launch-policy-shared.mjs';

function assertNoLocalUrl(context, key) {
  const { collector, assertRequired, isPrivateIp } = context;
  const value = assertRequired(key);
  if (!value) return;

  try {
    const url = new URL(value);
    if (url.hostname === 'localhost' || isPrivateIp(url.hostname)) {
      collector.fail(`${key} cannot point at localhost or a private IP for public launch.`);
    }
    if (PLACEHOLDER_RE.test(url.username) || PLACEHOLDER_RE.test(url.password) || PLACEHOLDER_RE.test(value)) {
      collector.fail(`${key} contains a placeholder credential.`);
    }
  } catch {
    collector.fail(`${key} must be a valid URL.`);
  }
}

function parsePostgresUrl(context, key) {
  const { env, collector } = context;
  const value = String(env[key] ?? '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.hostname || !url.pathname.slice(1)) {
      collector.fail(`${key} must include a PostgreSQL user, host, and database.`);
      return null;
    }
    return url;
  } catch {
    collector.fail(`${key} must be a valid PostgreSQL URL.`);
    return null;
  }
}

function rawUrlCredentials(context, value, key) {
  const { collector } = context;
  const schemeEnd = value.indexOf('://');
  const authorityStart = schemeEnd + 3;
  const pathStart = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = pathStart === -1 ? value.length : authorityStart + pathStart;
  const authority = value.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  const separator = authority.slice(0, at).indexOf(':');
  if (schemeEnd <= 0 || at <= 0 || separator <= 0) {
    collector.fail(`${key} must include URL-encoded username and password credentials.`);
    return null;
  }

  const username = authority.slice(0, separator);
  const password = authority.slice(separator + 1, at);
  const encodedComponent = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/;
  if (!encodedComponent.test(username) || !encodedComponent.test(password)) {
    collector.fail(`${key} credentials must percent-encode reserved characters.`);
    return null;
  }
  return { username, password };
}

function decodeUrlCredential(context, value, key) {
  try {
    return decodeURIComponent(value);
  } catch {
    context.collector.fail(`${key} contains invalid URL-encoded credentials.`);
    return null;
  }
}

function assertEncodedUrlCredentials(context, key, expectedUser, expectedPassword) {
  const { env, collector } = context;
  const value = String(env[key] ?? '').trim();
  const raw = rawUrlCredentials(context, value, key);
  if (!raw) return null;

  const username = decodeUrlCredential(context, raw.username, key);
  const password = decodeUrlCredential(context, raw.password, key);
  if (username === null || password === null) return null;
  if (username !== expectedUser || password !== expectedPassword) {
    collector.fail(`${key} must authenticate with ${key === 'MIGRATION_DATABASE_URL' ? 'POSTGRES_USER and POSTGRES_PASSWORD' : key === 'RABBITMQ_URL' ? 'RABBITMQ_USER and RABBITMQ_PASSWORD' : 'APP_DB_USER and APP_DB_PASSWORD'}.`);
  }
  return { username, password };
}

function assertDatabaseRoleIsolation(context) {
  const { env, collector, assertRequired } = context;
  const ownerUser = assertRequired('POSTGRES_USER');
  const ownerPassword = String(env.POSTGRES_PASSWORD ?? '');
  const databaseName = assertRequired('POSTGRES_DB');
  const appUser = assertRequired('APP_DB_USER');
  const appPassword = String(env.APP_DB_PASSWORD ?? '');
  const runtimeUrl = parsePostgresUrl(context, 'DATABASE_URL');
  const migrationUrl = parsePostgresUrl(context, 'MIGRATION_DATABASE_URL');

  if (!ownerUser || !appUser || !runtimeUrl || !migrationUrl) return;
  if (runtimeUrl.search || runtimeUrl.hash) {
    collector.fail('DATABASE_URL must not include query parameters or fragments because the shared runtime URL must be compatible with both Prisma and Python libpq.');
  }
  if (ownerUser === appUser) collector.fail('APP_DB_USER must be distinct from POSTGRES_USER.');
  if (ownerPassword && appPassword && ownerPassword === appPassword) {
    collector.fail('APP_DB_PASSWORD must be distinct from POSTGRES_PASSWORD.');
  }

  const runtimeCredentials = assertEncodedUrlCredentials(context, 'DATABASE_URL', appUser, appPassword);
  const migrationCredentials = assertEncodedUrlCredentials(context, 'MIGRATION_DATABASE_URL', ownerUser, ownerPassword);
  if (!runtimeCredentials || !migrationCredentials) return;
  if (
    runtimeUrl.hostname !== migrationUrl.hostname
    || (runtimeUrl.port || '5432') !== (migrationUrl.port || '5432')
    || runtimeUrl.pathname !== migrationUrl.pathname
  ) {
    collector.fail('DATABASE_URL and MIGRATION_DATABASE_URL must target the same PostgreSQL database.');
  }
  const runtimeDatabaseName = decodeUrlCredential(context, runtimeUrl.pathname.slice(1), 'DATABASE_URL');
  const migrationDatabaseName = decodeUrlCredential(context, migrationUrl.pathname.slice(1), 'MIGRATION_DATABASE_URL');
  if (
    runtimeUrl.hostname !== 'postgres'
    || migrationUrl.hostname !== 'postgres'
    || (runtimeUrl.port || '5432') !== '5432'
    || (migrationUrl.port || '5432') !== '5432'
    || runtimeDatabaseName !== databaseName
    || migrationDatabaseName !== databaseName
  ) {
    collector.fail('DATABASE_URL and MIGRATION_DATABASE_URL must target Compose service postgres:5432/POSTGRES_DB so logical backup and PITR protect the authoritative database.');
  }

  if (!collector.errors.some((message) => /APP_DB_|DATABASE_URL|MIGRATION_DATABASE_URL/.test(message))) {
    collector.pass('DATABASE_ROLE_ISOLATION');
  }
}

function assertRabbitmqCredentials(context) {
  const { env, collector, assertRequired } = context;
  const user = assertRequired('RABBITMQ_USER');
  const password = String(env.RABBITMQ_PASSWORD ?? '');
  const value = String(env.RABBITMQ_URL ?? '').trim();
  if (!user || !password || !value) return;

  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!['amqp:', 'amqps:'].includes(url.protocol)) {
    collector.fail('RABBITMQ_URL must use amqp or amqps.');
    return;
  }
  if (assertEncodedUrlCredentials(context, 'RABBITMQ_URL', user, password)) {
    collector.pass('RABBITMQ_URL_CREDENTIALS');
  }
}

export function validateProductionTargetPolicy(context) {
  context.assertExactValue('NODE_ENV', 'production');
  context.assertExactValue('DATA_TARGET_ENV', 'production');
  context.assertExactValue('MIGRATION_PRODUCTION_CONFIRM', 'apply-lunchlineup-production-migrations');
}

export function validateProviderConnectionPolicy(context) {
  assertNoLocalUrl(context, 'DATABASE_URL');
  assertNoLocalUrl(context, 'MIGRATION_DATABASE_URL');
  assertDatabaseRoleIsolation(context);
  assertNoLocalUrl(context, 'REDIS_URL');
  assertNoLocalUrl(context, 'RABBITMQ_URL');
  assertRabbitmqCredentials(context);
}

export function validateProviderBillingPolicy(context) {
  const {
    env,
    collector,
    assertExactValue,
    assertPattern,
    assertRequired,
    isPublicLaunchHostname,
  } = context;

  assertPattern('RESEND_API_KEY', /^re_[A-Za-z0-9_-]{24,}$/, 'be a live Resend API key-shaped value');
  assertPattern('RESEND_WEBHOOK_SECRET', /^whsec_[A-Za-z0-9_-]{24,}$/, 'be a Resend webhook signing secret');
  const emailFrom = assertRequired('EMAIL_FROM');
  if (emailFrom) {
    const match = emailFrom.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/);
    const address = match?.[1] ?? match?.[2] ?? '';
    const host = address.split('@')[1]?.toLowerCase();
    if (!host || !isPublicLaunchHostname(host)) {
      collector.fail('EMAIL_FROM must use a real sender domain.');
    }
  }

  assertPattern('STRIPE_SECRET_KEY', /^sk_live_[A-Za-z0-9]{24,}$/, 'be a live Stripe secret key');
  assertPattern('STRIPE_WEBHOOK_SECRET', /^whsec_[A-Za-z0-9]{24,}$/, 'be a Stripe webhook secret');
  assertPattern('STRIPE_WEBHOOK_ENDPOINT_ID', /^we_[A-Za-z0-9]{8,}$/, 'be a configured Stripe webhook endpoint ID');
  assertPattern('STRIPE_METER_ERROR_WEBHOOK_SECRET', /^whsec_[A-Za-z0-9]{24,}$/, 'be a Stripe meter error webhook secret');
  assertPattern('STRIPE_METER_ERROR_EVENT_DESTINATION_ID', /^ed_(?:live_)?[A-Za-z0-9_]{8,}$/, 'be a configured Stripe meter error event destination ID');
  for (const key of ['STRIPE_PRICE_STARTER', 'STRIPE_PRICE_GROWTH', 'STRIPE_PRICE_ENTERPRISE']) {
    assertPattern(key, /^price_[A-Za-z0-9]{12,}$/, 'be a configured Stripe price ID');
  }
  assertPattern('STRIPE_METER_ID', /^mtr_[A-Za-z0-9]{8,}$/, 'be a configured Stripe billing meter ID');
  assertExactValue('STRIPE_METER_AGGREGATION', 'last');
  const meteredUsageEnabled = assertRequired('STRIPE_METERED_USAGE_ENABLED');
  if (meteredUsageEnabled && meteredUsageEnabled.toLowerCase() !== 'true') {
    collector.fail('STRIPE_METERED_USAGE_ENABLED must be true for public launch.');
  }
  assertPattern('STRIPE_METER_EVENT_NAME', /^[A-Za-z0-9_.:-]{1,100}$/, 'be a configured Stripe meter event name');
  const stripeUsageSnapshotInterval = Number(assertRequired('STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS'));
  if (!Number.isInteger(stripeUsageSnapshotInterval)
      || stripeUsageSnapshotInterval < 60
      || stripeUsageSnapshotInterval > 300) {
    collector.fail('STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS must be an integer from 60 through 300 for public launch.');
  }
}
