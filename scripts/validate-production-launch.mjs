#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const envPath = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const verifyLocalSecretFiles = process.argv.includes('--verify-local-secret-files');

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/validate-production-launch.mjs [runtime-env-file] [--verify-local-secret-files]');
  console.log('Validates the public SaaS launch environment, not disposable CI smoke values.');
  process.exit(0);
}

const env = envPath ? parseEnvFile(envPath) : process.env;
const errors = [];
const checked = [];

function parseEnvFile(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Environment file does not exist: ${path}`);
  }

  const parsed = {};
  const contents = readFileSync(absolute, 'utf8');

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator === -1) {
      fail(`Invalid env line ${index + 1}: expected KEY=value.`);
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      fail(`Invalid env key on line ${index + 1}: ${key}`);
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function fail(message) {
  errors.push(message);
}

function pass(name) {
  checked.push(name);
}

function readCsv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function stripPort(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (normalized.startsWith('[')) {
    return normalized.slice(1, normalized.indexOf(']'));
  }
  return normalized.split(':')[0];
}

function normalizeHost(value, key) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.includes('://') || raw.includes('/') || raw.includes('\\') || raw.includes('@') || raw.includes('*')) {
    fail(`${key} must be a hostname, not a URL, wildcard, or path.`);
    return null;
  }

  try {
    return new URL(`http://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    fail(`${key} must be a valid hostname.`);
    return null;
  }
}

function isReservedHostname(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'example' ||
    normalized.endsWith('.example') ||
    normalized === 'example.com' ||
    normalized === 'example.net' ||
    normalized === 'example.org' ||
    normalized.endsWith('.example.com') ||
    normalized.endsWith('.example.net') ||
    normalized.endsWith('.example.org') ||
    normalized === 'test' ||
    normalized.endsWith('.test') ||
    normalized === 'invalid' ||
    normalized.endsWith('.invalid')
  );
}

function isPrivateIp(host) {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPublicLaunchHostname(host) {
  return Boolean(host && host.includes('.') && !isReservedHostname(host) && !isPrivateIp(host));
}

function assertPublicHost(key) {
  const host = normalizeHost(env[key], key);
  if (!host) return null;

  if (!isPublicLaunchHostname(host)) {
    fail(`${key} must be a real public hostname, not localhost, private IP, .test, or example domain.`);
    return null;
  }

  pass(key);
  return host;
}

function assertHttpsUrl(key, value, { requirePublicHost = true } = {}) {
  const raw = String(value ?? '').trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') {
      fail(`${key} must use https: ${raw}`);
      return null;
    }
    if (requirePublicHost && !isPublicLaunchHostname(url.hostname)) {
      fail(`${key} must use a real public hostname: ${raw}`);
      return null;
    }
    return url;
  } catch {
    fail(`${key} must be a valid https URL: ${raw}`);
    return null;
  }
}

function assertHttpsOrigin(key, value) {
  const url = assertHttpsUrl(key, value);
  if (!url) return null;
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail(`${key} must contain only a public HTTPS origin.`);
    return null;
  }
  pass(key);
  return url.origin;
}

function readBooleanFlag(key, defaultValue = 'false') {
  const value = String(env[key] ?? defaultValue).trim().toLowerCase();
  if (!['true', 'false'].includes(value)) {
    fail(`${key} must be true or false for public launch.`);
    return null;
  }
  pass(key);
  return value === 'true';
}

function assertRequired(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) {
    fail(`${key} is required for public launch.`);
    return '';
  }
  pass(key);
  return value;
}

function assertPaidGaLegalApproval() {
  assertExactValue('PAID_GA_LEGAL_APPROVED', 'true');

  for (const key of [
    'PAID_GA_CONTRACTING_ENTITY',
    'PAID_GA_TERMS_VERSION',
    'PAID_GA_DPA_VERSION',
    'PAID_GA_COUNSEL_APPROVAL_OWNER',
    'PAID_GA_SIGNATURE_PROCESS',
    'PAID_GA_TRANSFER_TERMS',
  ]) {
    const value = assertRequired(key);
    if (value && (placeholderRe.test(value) || /\b(?:todo|tbd|pending|unknown)\b/i.test(value))) {
      fail(`${key} must be an approved, non-placeholder paid-GA value.`);
    }
  }

  const approvedAt = assertRequired('PAID_GA_COUNSEL_APPROVED_AT');
  if (approvedAt) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(approvedAt)
      ? Date.parse(`${approvedAt}T00:00:00.000Z`)
      : Number.NaN;
    if (!Number.isFinite(parsed) || parsed > Date.now()) {
      fail('PAID_GA_COUNSEL_APPROVED_AT must be a valid, non-future YYYY-MM-DD date.');
    }
  }

  const incidentHours = Number.parseInt(assertRequired('PAID_GA_INCIDENT_NOTICE_HOURS'), 10);
  if (!Number.isInteger(incidentHours) || incidentHours < 1 || incidentHours > 168) {
    fail('PAID_GA_INCIDENT_NOTICE_HOURS must be an approved integer from 1 through 168.');
  }

  assertPublicContactEmail('PAID_GA_CONTACT_OWNER_EMAIL');
  assertProofArtifactUri('PAID_GA_APPROVAL_RECORD_URI', { requireJson: true });
}

function assertExactValue(key, expected) {
  const value = assertRequired(key);
  if (!value) return null;
  if (value !== expected) {
    fail(`${key} must be exactly ${expected}.`);
    return null;
  }
  pass(key);
  return value;
}

function assertPitrConfig() {
  assertExactValue('PITR_ENABLED', 'true');
  const endpoint = assertRequired('PITR_S3_ENDPOINT');
  if (endpoint) assertHttpsUrl('PITR_S3_ENDPOINT', endpoint);

  const bucket = assertRequired('PITR_S3_BUCKET');
  if (bucket && !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    fail('PITR_S3_BUCKET must be an explicit valid bucket name.');
  }

  const prefix = assertRequired('PITR_S3_PREFIX');
  if (prefix && (
    prefix.startsWith('/')
    || prefix.endsWith('/')
    || prefix.includes('..')
    || /replace|example|latest|current/i.test(prefix)
  )) {
    fail('PITR_S3_PREFIX must be a dedicated cluster-specific prefix without placeholders.');
  }

  const credentialDirectoryKeys = [
    'PITR_WAL_OBJECT_STORE_SECRETS_DIR',
    'PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR',
    'PITR_RESTORE_OBJECT_STORE_SECRETS_DIR',
  ];
  for (const key of credentialDirectoryKeys) assertAbsoluteSecretDirectory(key);
  const credentialDirectories = credentialDirectoryKeys.map((key) => String(env[key] ?? '').trim()).filter(Boolean);
  if (new Set(credentialDirectories).size !== credentialDirectories.length) {
    fail('PITR WAL, base-backup, and restore identities must use distinct managed-secret directories.');
  }

  const objectLockDays = Number(assertRequired('PITR_OBJECT_LOCK_RETENTION_DAYS'));
  if (!Number.isInteger(objectLockDays) || objectLockDays < 14) {
    fail('PITR_OBJECT_LOCK_RETENTION_DAYS must be an integer of at least 14.');
  }
}

const placeholderRe = /(change_me|generate_with|replace_me|example|secret|password|guest)/i;
const launchProofPlaceholderRe =
  /<[^>]+>|YYYY|MMDD|HHMMSS|placeholder|todo|tbd|not_applicable|n\/a|dummy|fake|artifact-id|run-id/i;

function hasPlaceholderProofReference(value) {
  return placeholderRe.test(value) || launchProofPlaceholderRe.test(value);
}
const allowedSignupModes = new Set(['closed_beta', 'invite_only', 'open']);
const selfServiceTermsCounselApproved = false;
const selfServiceTermsVersion = null;

function assertSecret(key, minLength = 32) {
  const value = assertRequired(key);
  if (!value) return;
  if (value.length < minLength || placeholderRe.test(value)) {
    fail(`${key} must be a non-placeholder value with at least ${minLength} characters.`);
  }
}

function assertEncoded32ByteSecret(key) {
  const value = assertRequired(key);
  if (!value) return;
  if (placeholderRe.test(value)) {
    fail(`${key} must be a non-placeholder 32-byte hex or base64 secret.`);
    return;
  }
  if (/^[a-f0-9]{64}$/i.test(value)) {
    pass(key);
    return;
  }
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) {
    fail(`${key} must be a 32-byte hex or base64 secret.`);
    return;
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length !== 32) {
      fail(`${key} must decode to exactly 32 bytes.`);
      return;
    }
    pass(key);
  } catch {
    fail(`${key} must be a valid 32-byte hex or base64 secret.`);
  }
}

function assertPattern(key, pattern, description) {
  const value = assertRequired(key);
  if (!value) return;
  if (!pattern.test(value)) {
    fail(`${key} must ${description}.`);
  }
}

function assertPublicContactEmail(key) {
  const value = assertRequired(key);
  if (!value) return;

  const match = value.match(/^[^\s@<>]+@([^\s@<>]+\.[^\s@<>]+)$/);
  const host = match?.[1]?.toLowerCase();
  if (!host) {
    fail(`${key} must be a bare email address for a monitored public mailbox.`);
    return;
  }

  if (!isPublicLaunchHostname(host)) {
    fail(`${key} must use a real public mailbox domain, not localhost, private IP, .test, .invalid, .example, or example domains.`);
  }
}

function assertNoLocalUrl(key) {
  const value = assertRequired(key);
  if (!value) return;

  try {
    const url = new URL(value);
    if (url.hostname === 'localhost' || isPrivateIp(url.hostname)) {
      fail(`${key} cannot point at localhost or a private IP for public launch.`);
    }
    if (placeholderRe.test(url.username) || placeholderRe.test(url.password) || placeholderRe.test(value)) {
      fail(`${key} contains a placeholder credential.`);
    }
  } catch {
    fail(`${key} must be a valid URL.`);
  }
}

function parsePostgresUrl(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.hostname || !url.pathname.slice(1)) {
      fail(`${key} must include a PostgreSQL user, host, and database.`);
      return null;
    }
    return url;
  } catch {
    fail(`${key} must be a valid PostgreSQL URL.`);
    return null;
  }
}

function rawUrlCredentials(value, key) {
  const schemeEnd = value.indexOf('://');
  const authorityStart = schemeEnd + 3;
  const pathStart = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = pathStart === -1 ? value.length : authorityStart + pathStart;
  const authority = value.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  const separator = authority.slice(0, at).indexOf(':');
  if (schemeEnd <= 0 || at <= 0 || separator <= 0) {
    fail(`${key} must include URL-encoded username and password credentials.`);
    return null;
  }

  const username = authority.slice(0, separator);
  const password = authority.slice(separator + 1, at);
  const encodedComponent = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/;
  if (!encodedComponent.test(username) || !encodedComponent.test(password)) {
    fail(`${key} credentials must percent-encode reserved characters.`);
    return null;
  }
  return { username, password };
}

function decodeUrlCredential(value, key) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${key} contains invalid URL-encoded credentials.`);
    return null;
  }
}

function assertEncodedUrlCredentials(key, expectedUser, expectedPassword) {
  const value = String(env[key] ?? '').trim();
  const raw = rawUrlCredentials(value, key);
  if (!raw) return null;

  const username = decodeUrlCredential(raw.username, key);
  const password = decodeUrlCredential(raw.password, key);
  if (username === null || password === null) return null;
  if (username !== expectedUser || password !== expectedPassword) {
    fail(`${key} must authenticate with ${key === 'MIGRATION_DATABASE_URL' ? 'POSTGRES_USER and POSTGRES_PASSWORD' : key === 'RABBITMQ_URL' ? 'RABBITMQ_USER and RABBITMQ_PASSWORD' : 'APP_DB_USER and APP_DB_PASSWORD'}.`);
  }
  return { username, password };
}

function assertDatabaseRoleIsolation() {
  const ownerUser = assertRequired('POSTGRES_USER');
  const ownerPassword = String(env.POSTGRES_PASSWORD ?? '');
  const databaseName = assertRequired('POSTGRES_DB');
  const appUser = assertRequired('APP_DB_USER');
  const appPassword = String(env.APP_DB_PASSWORD ?? '');
  const runtimeUrl = parsePostgresUrl('DATABASE_URL');
  const migrationUrl = parsePostgresUrl('MIGRATION_DATABASE_URL');

  if (!ownerUser || !appUser || !runtimeUrl || !migrationUrl) return;
  if (ownerUser === appUser) fail('APP_DB_USER must be distinct from POSTGRES_USER.');
  if (ownerPassword && appPassword && ownerPassword === appPassword) {
    fail('APP_DB_PASSWORD must be distinct from POSTGRES_PASSWORD.');
  }

  const runtimeCredentials = assertEncodedUrlCredentials('DATABASE_URL', appUser, appPassword);
  const migrationCredentials = assertEncodedUrlCredentials('MIGRATION_DATABASE_URL', ownerUser, ownerPassword);
  if (!runtimeCredentials || !migrationCredentials) return;
  if (
    runtimeUrl.hostname !== migrationUrl.hostname ||
    (runtimeUrl.port || '5432') !== (migrationUrl.port || '5432') ||
    runtimeUrl.pathname !== migrationUrl.pathname
  ) {
    fail('DATABASE_URL and MIGRATION_DATABASE_URL must target the same PostgreSQL database.');
  }
  const runtimeDatabaseName = decodeUrlCredential(runtimeUrl.pathname.slice(1), 'DATABASE_URL');
  const migrationDatabaseName = decodeUrlCredential(migrationUrl.pathname.slice(1), 'MIGRATION_DATABASE_URL');
  if (
    runtimeUrl.hostname !== 'postgres' ||
    migrationUrl.hostname !== 'postgres' ||
    (runtimeUrl.port || '5432') !== '5432' ||
    (migrationUrl.port || '5432') !== '5432' ||
    runtimeDatabaseName !== databaseName ||
    migrationDatabaseName !== databaseName
  ) {
    fail('DATABASE_URL and MIGRATION_DATABASE_URL must target Compose service postgres:5432/POSTGRES_DB so logical backup and PITR protect the authoritative database.');
  }

  if (!errors.some((message) => /APP_DB_|DATABASE_URL|MIGRATION_DATABASE_URL/.test(message))) {
    pass('DATABASE_ROLE_ISOLATION');
  }
}

function assertRabbitmqCredentials() {
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
    fail('RABBITMQ_URL must use amqp or amqps.');
    return;
  }
  if (assertEncodedUrlCredentials('RABBITMQ_URL', user, password)) {
    pass('RABBITMQ_URL_CREDENTIALS');
  }
}

function assertProductionApiHealthUrl(domain) {
  const value = assertRequired('PRODUCTION_API_HEALTH_URL');
  if (!value) return;
  const url = assertHttpsUrl('PRODUCTION_API_HEALTH_URL', value);
  if (!url) return;

  if (url.username || url.password || url.search || url.hash) {
    fail('PRODUCTION_API_HEALTH_URL must not contain credentials, a query, or a fragment.');
  }
  if (domain && url.hostname.toLowerCase().replace(/\.$/, '') !== domain) {
    fail('PRODUCTION_API_HEALTH_URL must use the same hostname as DOMAIN.');
  }
  if (!['/health', '/api/health'].includes(url.pathname)) {
    fail('PRODUCTION_API_HEALTH_URL must target /health or /api/health.');
  }
  if (url.port && url.port !== '443') {
    fail('PRODUCTION_API_HEALTH_URL must use the default HTTPS port.');
  }
  pass('PRODUCTION_API_HEALTH_URL');
}

function assertAbsoluteSecretFile(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) {
    fail(`${key} is required and must point at a managed secret file.`);
    return;
  }
  if (!isAbsolute(value)) {
    fail(`${key} must be an absolute managed-secret path, not a repo-relative path.`);
  }
  if (/^\.?\/?secrets\//.test(value) || value.includes('\\secrets\\')) {
    fail(`${key} cannot point at the repo-local secrets directory for public launch.`);
  }
  pass(key);
}

function assertLocallyReadableSecretFile(key) {
  if (!verifyLocalSecretFiles) return;
  const value = String(env[key] ?? '').trim();
  if (!value || !isAbsolute(value)) return;
  try {
    accessSync(value, constants.R_OK);
  } catch {
    fail(key + ' must exist and be readable on the deployment host.');
  }
}
function assertAbsoluteSecretDirectory(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) {
    fail(`${key} is required and must point at a managed secret directory.`);
    return;
  }
  if (!isAbsolute(value)) {
    fail(`${key} must be an absolute managed-secret directory, not a repo-relative path.`);
  }
  if (/^\.?\/?secrets\//.test(value) || value.includes('\\secrets\\')) {
    fail(`${key} cannot point at the repo-local secrets directory for public launch.`);
  }
  pass(key);
}

function assertDistinctSecretFiles(leftKey, rightKey) {
  const left = String(env[leftKey] ?? '').trim();
  const right = String(env[rightKey] ?? '').trim();
  if (left && right && left === right) {
    fail(`${leftKey} must use a separate secret file from ${rightKey}.`);
  }
}

function assertLoopbackBind(key, defaultValue) {
  const value = String(env[key] ?? defaultValue).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) {
    fail(`${key} must be set to a loopback bind address.`);
    return;
  }

  if (!['127.0.0.1', '::1', 'localhost'].includes(value)) {
    fail(`${key} must bind only to loopback for public launch, not ${value}.`);
    return;
  }

  pass(key);
}

function assertOffHostBackupUri(key) {
  const value = assertRequired(key);
  if (!value) return;

  if (placeholderRe.test(value)) {
    fail(`${key} must not contain placeholder text.`);
  }

  if (/^(file:\/\/|\/|\.\/|\.\.\/|https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.))/i.test(value)) {
    fail(`${key} must point at off-host storage, not a local path or private localhost URL.`);
    return;
  }

  if (!/^(s3:\/\/[^ ]+|rclone:[^ ]+)$/i.test(value)) {
    fail(`${key} must use a backup.sh-supported off-host URI: s3://... or rclone:<remote:path>.`);
  }
}

function assertPrometheusTextfile(key) {
  const value = String(env[key] ?? '').trim();
  if (!value) {
    fail(`${key} is required so operational freshness is observable.`);
    return;
  }
  if (!isAbsolute(value) || !value.endsWith('.prom')) {
    fail(`${key} must be an absolute Prometheus textfile collector .prom path.`);
    return;
  }
  if (/^\.?\/?secrets\//.test(value) || value.includes('\\secrets\\')) {
    fail(`${key} cannot point at the repo-local secrets directory.`);
    return;
  }
  pass(key);
}


function assertSignupMode() {
  const publicMode = assertRequired('PUBLIC_SIGNUP_MODE');
  const nextPublicMode = assertRequired('NEXT_PUBLIC_SIGNUP_MODE');
  if (!publicMode || !nextPublicMode) return;

  if (!allowedSignupModes.has(publicMode)) {
    fail('PUBLIC_SIGNUP_MODE must be one of: closed_beta, invite_only, open.');
  }
  if (!allowedSignupModes.has(nextPublicMode)) {
    fail('NEXT_PUBLIC_SIGNUP_MODE must be one of: closed_beta, invite_only, open.');
  }
  if (publicMode !== nextPublicMode) {
    fail('PUBLIC_SIGNUP_MODE and NEXT_PUBLIC_SIGNUP_MODE must match before public launch.');
    return;
  }
  if (!allowedSignupModes.has(publicMode)) return;

  if ((!selfServiceTermsCounselApproved || !selfServiceTermsVersion) && publicMode !== 'closed_beta') {
    fail(
      'PUBLIC_SIGNUP_MODE and NEXT_PUBLIC_SIGNUP_MODE must both be closed_beta while the checked-in Terms are not counsel-approved and versioned. Enabling invite_only or open requires counsel-approved, versioned Terms and a future code change.',
    );
  }
}

function isVagueProofReference(value) {
  return /(^|[/:_-])(latest|current)([/:_.-]|$)/i.test(value);
}

function assertPublicStatusHealthUrl(key, domain) {
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  const hostname = url.hostname.toLowerCase();
  if (domain && hostname !== domain && !hostname.endsWith(`.${domain}`)) {
    fail(`${key} must use DOMAIN or a subdomain of DOMAIN so the public status page checks this launch surface.`);
    return;
  }

  if (!/\/health\/?$/i.test(url.pathname)) {
    fail(`${key} must point at an HTTPS health endpoint ending in /health.`);
    return;
  }

  pass(key);
}

function assertSameOriginPublicApiUrl() {
  const value = assertRequired('NEXT_PUBLIC_API_URL');
  if (!value) return;

  if (value !== '/api/v1') {
    fail('NEXT_PUBLIC_API_URL must be exactly /api/v1 for same-origin public launch.');
    return;
  }

  pass('NEXT_PUBLIC_API_URL');
}

function assertOidcRedirectUri(key, domain) {
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  if (domain && url.hostname.toLowerCase() !== domain) {
    fail(`${key} must use DOMAIN so OIDC callbacks return through the same-origin public API.`);
    return;
  }

  if (url.pathname !== '/api/v1/auth/callback') {
    fail(`${key} must end at /api/v1/auth/callback for the public API callback route.`);
    return;
  }

  pass(key);
}

function assertHttpsProofUrl(key) {
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  if (hasPlaceholderProofReference(value)) {
    fail(`${key} must not contain placeholder text.`);
    return;
  }

  if (isVagueProofReference(value)) {
    fail(`${key} must reference a specific retained proof artifact, ticket, or run, not latest/current.`);
    return;
  }

  pass(key);
}

function assertProofArtifactUri(key, { requireJson = false } = {}) {
  const value = assertRequired(key);
  if (!value) return;

  if (hasPlaceholderProofReference(value)) {
    fail(`${key} must not contain placeholder text.`);
    return;
  }

  if (isVagueProofReference(value)) {
    fail(`${key} must reference a specific retained proof artifact, not latest/current.`);
    return;
  }

  if (requireJson && !/\.json(?:[?#].*)?$/i.test(value)) {
    fail(`${key} must reference the retained JSON proof file.`);
    return;
  }

  if (/^https:\/\//i.test(value)) {
    if (assertHttpsUrl(key, value)) {
      pass(key);
    }
    return;
  }

  if (/^(s3:\/\/[^ ]+|rclone:[^ ]+)$/i.test(value)) {
    pass(key);
    return;
  }

  fail(`${key} must use a retained proof URI: https://..., s3://..., or rclone:<remote:path>.`);
}

if (env.NODE_ENV !== 'production') {
  fail('NODE_ENV must be production for public launch validation.');
} else {
  pass('NODE_ENV');
}

const domain = assertPublicHost('DOMAIN');
assertProductionApiHealthUrl(domain);
const adminEmail = assertRequired('ADMIN_EMAIL');
if (adminEmail) {
  const emailHost = adminEmail.replace(/^.*@/, '').replace(/[>\s].*$/, '').toLowerCase();
  if (!isPublicLaunchHostname(emailHost)) {
    fail('ADMIN_EMAIL must use a real operational mailbox domain.');
  }
}

assertPublicContactEmail('NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL');
assertPublicContactEmail('NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL');
assertPublicContactEmail('NEXT_PUBLIC_DPA_CONTACT_EMAIL');
assertPaidGaLegalApproval();
assertSignupMode();

const allowedOrigins = readCsv(assertRequired('ALLOWED_ORIGINS'));
let hasDomainOrigin = false;
for (const origin of allowedOrigins) {
  const url = assertHttpsUrl('ALLOWED_ORIGINS', origin);
  if (url && domain && url.hostname.toLowerCase() === domain) {
    hasDomainOrigin = true;
  }
}
if (domain && !hasDomainOrigin) {
  fail(`ALLOWED_ORIGINS must include https://${domain}.`);
}

const allowedHosts = readCsv(assertRequired('ALLOWED_HOSTS'));
if (domain && !allowedHosts.map((host) => stripPort(host)).includes(domain)) {
  fail(`ALLOWED_HOSTS must include ${domain}.`);
}
for (const host of allowedHosts) {
  const normalized = normalizeHost(host, 'ALLOWED_HOSTS');
  if (normalized && !isPublicLaunchHostname(normalized)) {
    fail(`ALLOWED_HOSTS contains a non-public launch host: ${host}`);
  }
}

const siteAddresses = readCsv(assertRequired('CADDY_SITE_ADDRESSES'));
let hasDomainTls = false;
for (const address of siteAddresses) {
  let url;
  try {
    url = new URL(address);
  } catch {
    fail(`CADDY_SITE_ADDRESSES contains an invalid URL: ${address}`);
    continue;
  }

  if (domain && url.hostname.toLowerCase() === domain && url.protocol === 'https:') {
    hasDomainTls = true;
  }

  const publicHost = isPublicLaunchHostname(url.hostname);
  if (publicHost && url.protocol !== 'https:') {
    fail(`CADDY_SITE_ADDRESSES public hosts must use https: ${address}`);
  }
}
if (domain && !hasDomainTls) {
  fail(`CADDY_SITE_ADDRESSES must include https://${domain}.`);
}

assertExactValue('NODE_ENV', 'production');
assertExactValue('DATA_TARGET_ENV', 'production');
assertExactValue('MIGRATION_PRODUCTION_CONFIRM', 'apply-lunchlineup-production-migrations');

if (String(env.COOKIE_SECURE ?? '').toLowerCase() !== 'true') {
  fail('COOKIE_SECURE must be true for public launch.');
} else {
  pass('COOKIE_SECURE');
}
assertExactValue('PASSWORD_RESET_EMAIL_OUTBOX_ENABLED', 'true');

for (const key of [
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
  'RABBITMQ_PASSWORD',
  'GRAFANA_PASSWORD',
  'CONTROL_PLANE_PASSWORD',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'SESSION_SECRET',
  'CSRF_SECRET',
  'MFA_SECRET_ENCRYPTION_KEY_CURRENT',
]) {
  assertSecret(key);
}
assertEncoded32ByteSecret('MFA_SECRET_ENCRYPTION_KEY_CURRENT');
if (String(env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS ?? '').trim()) {
  assertEncoded32ByteSecret('MFA_SECRET_ENCRYPTION_KEY_PREVIOUS');
  if (env.MFA_SECRET_ENCRYPTION_KEY_PREVIOUS === env.MFA_SECRET_ENCRYPTION_KEY_CURRENT) {
    fail('MFA_SECRET_ENCRYPTION_KEY_PREVIOUS must differ from MFA_SECRET_ENCRYPTION_KEY_CURRENT.');
  }
}
assertEncoded32ByteSecret('WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT');
if (String(env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? '').trim()) {
  assertEncoded32ByteSecret('WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS');
  if (env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS === env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT) {
    fail('WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS must differ from WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT.');
  }
}
assertEncoded32ByteSecret('PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY');

assertNoLocalUrl('DATABASE_URL');
assertNoLocalUrl('MIGRATION_DATABASE_URL');
assertDatabaseRoleIsolation();
assertNoLocalUrl('REDIS_URL');
assertNoLocalUrl('RABBITMQ_URL');
assertRabbitmqCredentials();
assertAbsoluteSecretFile('METRICS_TOKEN_FILE');
assertAbsoluteSecretFile('RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE');
assertAbsoluteSecretFile('CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE');
assertAbsoluteSecretFile('CONTROL_PLANE_ADMIN_TOKEN_FILE');
assertDistinctSecretFiles('CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE', 'METRICS_TOKEN_FILE');
assertDistinctSecretFiles('CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE', 'RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE');
assertLoopbackBind('API_HOST_BIND', '127.0.0.1');
assertAbsoluteSecretFile('BACKUP_ENCRYPTION_KEY_SECRET_FILE');
assertLocallyReadableSecretFile('BACKUP_ENCRYPTION_KEY_SECRET_FILE');
assertOffHostBackupUri('BACKUP_OFFSITE_URI');
assertPrometheusTextfile('BACKUP_METRICS_FILE');
assertPitrConfig();
assertAbsoluteSecretFile('ALERTMANAGER_WEBHOOK_URL_FILE');
assertPublicStatusHealthUrl('LUNCHLINEUP_STATUS_HEALTH_URL', domain);
assertProofArtifactUri('LAUNCH_PROOF_MANIFEST_URI', { requireJson: true });
assertHttpsProofUrl('LAUNCH_PROOF_DAST_URL');
assertHttpsProofUrl('LAUNCH_PROOF_LOAD_TEST_URL');
assertHttpsProofUrl('LAUNCH_PROOF_ALERT_ROUTE_URL');
assertHttpsProofUrl('LAUNCH_PROOF_EXTERNAL_HEALTH_URL');
assertProofArtifactUri('LAUNCH_PROOF_DR_DRILL_URI', { requireJson: true });

assertPattern('RESEND_API_KEY', /^re_[A-Za-z0-9_-]{24,}$/, 'be a live Resend API key-shaped value');
const emailFrom = assertRequired('EMAIL_FROM');
if (emailFrom) {
  const match = emailFrom.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/);
  const address = match?.[1] ?? match?.[2] ?? '';
  const host = address.split('@')[1]?.toLowerCase();
  if (!host || !isPublicLaunchHostname(host)) {
    fail('EMAIL_FROM must use a real sender domain.');
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
  fail('STRIPE_METERED_USAGE_ENABLED must be true for public launch.');
}
assertPattern('STRIPE_METER_EVENT_NAME', /^[A-Za-z0-9_.:-]{1,100}$/, 'be a configured Stripe meter event name');
const stripeUsageSnapshotInterval = Number(assertRequired('STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS'));
if (!Number.isInteger(stripeUsageSnapshotInterval)
    || stripeUsageSnapshotInterval < 60
    || stripeUsageSnapshotInterval > 300) {
  fail('STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS must be an integer from 60 through 300 for public launch.');
}

assertSameOriginPublicApiUrl();

const publicWsUrl = String(env.NEXT_PUBLIC_WS_URL ?? '').trim();
if (publicWsUrl) {
  try {
    const url = new URL(publicWsUrl);
    if (url.protocol !== 'wss:' || !isPublicLaunchHostname(url.hostname)) {
      fail('NEXT_PUBLIC_WS_URL must use wss and a real public hostname for public launch.');
    }
  } catch {
    fail('NEXT_PUBLIC_WS_URL must be a valid wss URL when configured.');
  }
}

assertHttpsOrigin('APP_ORIGIN', env.APP_ORIGIN);
assertHttpsOrigin('NEXT_PUBLIC_APP_ORIGIN', env.NEXT_PUBLIC_APP_ORIGIN);
assertHttpsUrl('NEXT_PUBLIC_APP_URL', env.NEXT_PUBLIC_APP_URL);
const publicAppEnv = assertRequired('NEXT_PUBLIC_APP_ENV');
if (publicAppEnv && publicAppEnv !== 'production') {
  fail('NEXT_PUBLIC_APP_ENV must be production for public launch.');
}

const oidcEnabled = readBooleanFlag('OIDC_ENABLED');
const nextPublicOidcEnabled = readBooleanFlag('NEXT_PUBLIC_OIDC_ENABLED');
if (oidcEnabled !== null && nextPublicOidcEnabled !== null && oidcEnabled !== nextPublicOidcEnabled) {
  fail('OIDC_ENABLED and NEXT_PUBLIC_OIDC_ENABLED must match so SSO-only tenants have both API and web login available.');
}

if (oidcEnabled === true || nextPublicOidcEnabled === true) {
  assertHttpsUrl('OIDC_ISSUER_URL', env.OIDC_ISSUER_URL);
  assertOidcRedirectUri('OIDC_REDIRECT_URI', domain);
  assertSecret('OIDC_CLIENT_SECRET');
  assertRequired('OIDC_CLIENT_ID');
}

if (errors.length > 0) {
  console.error(`Production launch validation failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  source: envPath ? resolve(envPath) : 'process.env',
  checked: [...new Set(checked)].sort(),
}, null, 2));
