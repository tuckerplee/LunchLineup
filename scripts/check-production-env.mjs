#!/usr/bin/env node
// Operator preflight for a real PRODUCTION runtime env file.
//
//   node scripts/check-production-env.mjs <runtime-env-file> [--verify-local-secret-files]
//
// Runs fast, secret-safe structural checks (presence, formats, placeholders, no
// dev/beta hosts, COOKIE_SECURE, NODE_ENV, legal cross-checks) and then the full
// public-launch policy in scripts/validate-production-launch.mjs. It never makes
// a network call and never prints a secret value.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createErrorCollector,
  parseEnvFile,
} from './production-launch-policy-shared.mjs';
import { readLegalLaunchConfig } from './production-launch-policy-public-identity.mjs';

export const REQUIRED_KEYS = [
  'NODE_ENV', 'DATA_TARGET_ENV', 'DEPLOY_RELEASE_SHA', 'PUBLIC_BUILD_CONFIG_SHA256',
  'MIGRATION_PRODUCTION_CONFIRM', 'DOMAIN', 'PRODUCTION_API_HEALTH_URL',
  'LUNCHLINEUP_STATUS_HEALTH_URL', 'CADDY_SITE_ADDRESSES', 'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS', 'APP_ORIGIN', 'NEXT_PUBLIC_APP_ORIGIN', 'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_APP_ENV', 'NEXT_PUBLIC_API_URL', 'COOKIE_SECURE', 'ADMIN_EMAIL',
  'POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'APP_DB_USER', 'APP_DB_PASSWORD',
  'PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'DATABASE_URL', 'MIGRATION_DATABASE_URL',
  'REDIS_PASSWORD', 'REDIS_URL', 'RABBITMQ_USER', 'RABBITMQ_PASSWORD', 'RABBITMQ_URL',
  'JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_HMAC_SECRET', 'CSRF_SECRET',
  'MFA_SECRET_ENCRYPTION_KEY_CURRENT', 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
  'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY', 'AVAILABILITY_IMPORT_ENCRYPTION_KEY',
  'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY', 'PASSWORD_RESET_EMAIL_OUTBOX_ENABLED',
  'STAFF_INVITATION_OUTBOX_ENABLED', 'METRICS_TOKEN_FILE',
  'RETENTION_PURGE_SERVICE_TOKEN_SECRET_FILE', 'CONTROL_PLANE_ADMIN_TOKEN_SECRET_FILE',
  'CONTROL_PLANE_ADMIN_TOKEN_FILE',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'EMAIL_FROM', 'RESEND_PREFLIGHT_RECIPIENT',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_ENDPOINT_ID',
  'STRIPE_METER_ERROR_WEBHOOK_SECRET', 'STRIPE_METER_ERROR_EVENT_DESTINATION_ID',
  'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_GROWTH', 'STRIPE_PRICE_ENTERPRISE',
  'STRIPE_METER_ID', 'STRIPE_METER_EVENT_NAME',
  'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL', 'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL',
  'NEXT_PUBLIC_DPA_CONTACT_EMAIL', 'PAID_GA_LEGAL_APPROVED', 'PAID_GA_CONTRACTING_ENTITY',
  'PAID_GA_TERMS_VERSION', 'PAID_GA_DPA_VERSION', 'PAID_GA_COUNSEL_APPROVAL_OWNER',
  'PAID_GA_COUNSEL_APPROVED_AT', 'PAID_GA_INCIDENT_NOTICE_HOURS',
  'PAID_GA_SIGNATURE_PROCESS', 'PAID_GA_TRANSFER_TERMS', 'PAID_GA_CONTACT_OWNER_EMAIL',
  'PAID_GA_APPROVAL_RECORD_URI', 'PUBLIC_SIGNUP_MODE', 'NEXT_PUBLIC_SIGNUP_MODE',
  'CONTROL_PLANE_PASSWORD',
  'LAUNCH_PROOF_MANIFEST_URI', 'OIDC_ENABLED', 'NEXT_PUBLIC_OIDC_ENABLED',
];

// Keys whose values are public hostnames, URLs or mailboxes: dev/beta hosts are rejected here.
const PUBLIC_HOST_KEYS = [
  'DOMAIN', 'PRODUCTION_API_HEALTH_URL', 'LUNCHLINEUP_STATUS_HEALTH_URL',
  'CADDY_SITE_ADDRESSES', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'APP_ORIGIN',
  'NEXT_PUBLIC_APP_ORIGIN', 'NEXT_PUBLIC_APP_URL', 'OIDC_REDIRECT_URI', 'EMAIL_FROM',
  'ADMIN_EMAIL', 'RESEND_PREFLIGHT_RECIPIENT', 'NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL',
  'NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL', 'NEXT_PUBLIC_DPA_CONTACT_EMAIL',
  'PAID_GA_CONTACT_OWNER_EMAIL',
];

const PLACEHOLDER_VALUE_RE = new RegExp([
  String.raw`\bOWNER[:_ ]`,
  'GENERATE_ME',
  '(?:change|replace)[_-]?me',
  'generate_with',
  'your[_-]',
  'placeholder',
  '<[^>@]+>',
  String.raw`\b(?:todo|tbd|xxx+)\b`,
  String.raw`(?:^|[@./])example\.(?:com|net|org)\b`,
  String.raw`\.example(?:[\s:/,>]|$)`,
  String.raw`\b(?:sk|pk|rk)_test_`,
].join('|'), 'i');
// OWNER/GENERATE_ME markers are matched case-sensitively below; the case-insensitive
// regex above is for the generic tokens only.
const OWNER_MARKER_RE = /\bOWNER[:_ ]|GENERATE_ME/;

// Env keys that may legitimately be empty in production.
const MAY_BE_EMPTY = new Set([
  'MFA_SECRET_ENCRYPTION_KEY_PREVIOUS', 'MFA_SECRET_ENCRYPTION_KEY',
  'PUBLIC_SIGNUP_INVITE_CODES', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY',
  'STRIPE_PRICE_CREDIT_PACK_100', 'STRIPE_PRICE_CREDIT_PACK_500', 'STRIPE_PRICE_CREDIT_PACK_2000',
]);

const NON_PRODUCTION_HOST_RE =
  /(?:^|[^a-z0-9-])(?:beta|dev|develop|development|staging|stage|qa|test|sandbox|preview)\.[a-z0-9-]+\.[a-z]{2,}|localhost|127\.0\.0\.1|\[::1\]|\.local(?:[\s:/,>]|$)|\.internal(?:[\s:/,>]|$)|lunchlineup-dev|\bvm\d{3}\b|(?:^|[^\d.])(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+(?:\.\d+)?(?:[^\d]|$)/i;

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function bareEmail(value) {
  const match = String(value).match(/<([^<>]+)>\s*$/);
  return (match ? match[1] : String(value)).trim();
}

export function checkProductionEnv(env, { legalConfig = readLegalLaunchConfig() } = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const value = (key) => String(env[key] ?? '').trim();

  // 1. Presence
  for (const key of REQUIRED_KEYS) {
    if (!value(key) && !MAY_BE_EMPTY.has(key)) fail(`${key} is required and must not be empty.`);
  }

  // 2. Fixed production switches
  if (value('NODE_ENV') !== 'production') fail('NODE_ENV must be exactly production.');
  if (value('NEXT_PUBLIC_APP_ENV') !== 'production') fail('NEXT_PUBLIC_APP_ENV must be exactly production.');
  if (value('DATA_TARGET_ENV') !== 'production') fail('DATA_TARGET_ENV must be exactly production.');
  if (value('COOKIE_SECURE').toLowerCase() !== 'true') fail('COOKIE_SECURE must be exactly true.');
  if (value('NEXT_PUBLIC_API_URL') && value('NEXT_PUBLIC_API_URL') !== '/api/v2') {
    fail('NEXT_PUBLIC_API_URL must be exactly /api/v2.');
  }
  for (const key of ['BETA_DEMO_MFA_BYPASS_ENABLED', 'INTERNAL_BETA_ENTITLEMENTS_ENABLED', 'AUTH_DEBUG']) {
    if (['1', 'true', 'yes', 'on'].includes(value(key).toLowerCase())) fail(`${key} must not be enabled in production.`);
  }

  // 3. Placeholder markers (never echo the value)
  for (const [key, raw] of Object.entries(env)) {
    const text = String(raw ?? '');
    if (!text.trim()) continue;
    if (OWNER_MARKER_RE.test(text)) fail(`${key} still contains an OWNER/GENERATE_ME marker.`);
    else if (PLACEHOLDER_VALUE_RE.test(text)) fail(`${key} looks like a placeholder or non-production value.`);
  }

  // 4. No dev/beta/private hosts in public-facing values
  for (const key of PUBLIC_HOST_KEYS) {
    if (value(key) && NON_PRODUCTION_HOST_RE.test(value(key))) {
      fail(`${key} must not reference a dev, beta, staging, localhost or private host.`);
    }
  }
  for (const [key, raw] of Object.entries(env)) {
    if (/\b(?:beta|dev)\.lunchlineup\.com\b/i.test(String(raw ?? ''))) {
      fail(`${key} references a beta/dev LunchLineup host.`);
    }
  }

  // 5. Formats
  for (const key of PUBLIC_HOST_KEYS.filter((k) => /EMAIL|RECIPIENT/.test(k))) {
    if (value(key) && !EMAIL_RE.test(bareEmail(value(key)))) fail(`${key} must be an email address.`);
  }
  if (value('EMAIL_FROM') && !/^(?:[^<>@\r\n]+<)?[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>?$/.test(value('EMAIL_FROM'))) {
    fail('EMAIL_FROM must be an address or "Name <address>".');
  }
  if (value('RESEND_API_KEY') && (!/^re_[A-Za-z0-9_-]{24,}$/.test(value('RESEND_API_KEY')) || /^re_(?:dev|test)_/i.test(value('RESEND_API_KEY')))) {
    fail('RESEND_API_KEY must be a live Resend key (re_...).');
  }
  if (value('STRIPE_SECRET_KEY') && !/^sk_live_[A-Za-z0-9]{24,}$/.test(value('STRIPE_SECRET_KEY'))) {
    fail('STRIPE_SECRET_KEY must be a LIVE Stripe secret key (sk_live_...).');
  }
  if (value('DEPLOY_RELEASE_SHA') && !/^[a-f0-9]{40}$/.test(value('DEPLOY_RELEASE_SHA'))) {
    fail('DEPLOY_RELEASE_SHA must be a 40-character lowercase hex commit.');
  }
  if (value('PUBLIC_BUILD_CONFIG_SHA256') && !/^[a-f0-9]{64}$/.test(value('PUBLIC_BUILD_CONFIG_SHA256'))) {
    fail('PUBLIC_BUILD_CONFIG_SHA256 must be 64 lowercase hex characters.');
  }
  for (const key of ['MFA_SECRET_ENCRYPTION_KEY_CURRENT', 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
    'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY', 'AVAILABILITY_IMPORT_ENCRYPTION_KEY', 'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY']) {
    if (value(key) && !/^(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=|[A-Za-z0-9_-]{43})$/.test(value(key))) {
      fail(`${key} must be exactly 32 bytes (64 hex characters or 32-byte base64).`);
    }
  }
  const encryptionKeys = ['MFA_SECRET_ENCRYPTION_KEY_CURRENT', 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
    'PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY', 'AVAILABILITY_IMPORT_ENCRYPTION_KEY', 'STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY']
    .map((key) => [key, value(key)]).filter(([, v]) => v);
  if (new Set(encryptionKeys.map(([, v]) => v)).size !== encryptionKeys.length) {
    fail('Encryption keys must be distinct; do not reuse one key for several purposes.');
  }
  const sessionSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_HMAC_SECRET', 'CSRF_SECRET']
    .map((key) => [key, value(key)]).filter(([, v]) => v);
  for (const [key, v] of sessionSecrets) {
    if (v.length < 32) fail(`${key} must be at least 32 characters.`);
  }
  if (new Set(sessionSecrets.map(([, v]) => v)).size !== sessionSecrets.length) {
    fail('JWT_SECRET, JWT_REFRESH_SECRET, SESSION_SECRET, OTP_HMAC_SECRET and CSRF_SECRET must all differ.');
  }
  if (value('REDIS_PASSWORD') && value('REDIS_PASSWORD').length < 32) fail('REDIS_PASSWORD must be at least 32 characters.');
  if (value('REDIS_PASSWORD') && value('REDIS_URL')) {
    let redisPassword = '';
    try { redisPassword = decodeURIComponent(new URL(value('REDIS_URL')).password); } catch { /* mismatch reported below */ }
    if (redisPassword !== value('REDIS_PASSWORD')) fail('REDIS_URL must carry REDIS_PASSWORD (redis://default:<password>@redis:6379).');
  }
  if (value('POSTGRES_PASSWORD') && value('POSTGRES_PASSWORD') === value('APP_DB_PASSWORD')) {
    fail('APP_DB_PASSWORD must differ from POSTGRES_PASSWORD.');
  }

  // 6. Signup mode agreement and mode-specific prerequisites
  const mode = value('PUBLIC_SIGNUP_MODE');
  if (mode && mode !== value('NEXT_PUBLIC_SIGNUP_MODE')) {
    fail('PUBLIC_SIGNUP_MODE and NEXT_PUBLIC_SIGNUP_MODE must be identical.');
  }
  if (mode === 'open') {
    if (!value('TURNSTILE_SECRET_KEY')) fail('TURNSTILE_SECRET_KEY is required when PUBLIC_SIGNUP_MODE=open.');
    if (!value('NEXT_PUBLIC_TURNSTILE_SITE_KEY')) fail('NEXT_PUBLIC_TURNSTILE_SITE_KEY is required when PUBLIC_SIGNUP_MODE=open.');
  }
  if (mode === 'invite_only' && !value('PUBLIC_SIGNUP_INVITE_CODES')) {
    fail('PUBLIC_SIGNUP_INVITE_CODES is required when PUBLIC_SIGNUP_MODE=invite_only.');
  }

  // 7. Legal: env must agree with the single legal config (packages/config/legal-launch.json)
  const business = legalConfig.business ?? {};
  const approval = legalConfig.approval ?? {};
  const ownerPending = (text) => !String(text ?? '').trim() || /^\s*(?:OWNER\b|TODO\b|TBD\b|CHANGE_ME)/i.test(String(text));
  const legalApproved = value('PAID_GA_LEGAL_APPROVED') === 'true';
  if (!legalApproved) fail('PAID_GA_LEGAL_APPROVED must be exactly true for production launch (counsel approval).');
  for (const [field, label] of [['legalEntityName', 'legal entity name'], ['mailingAddress', 'mailing address'],
    ['governingLaw', 'governing law'], ['effectiveDate', 'effective date']]) {
    if (ownerPending(business[field])) fail(`packages/config/legal-launch.json business.${field} (${label}) is still an OWNER placeholder.`);
  }
  if (!ownerPending(business.effectiveDate) && !/^\d{4}-\d{2}-\d{2}$/.test(String(business.effectiveDate).trim())) {
    fail('legal-launch.json business.effectiveDate must be YYYY-MM-DD.');
  }
  if (legalApproved) {
    const docs = legalConfig.documents ?? {};
    if (approval.approved !== true) {
      fail('PAID_GA_LEGAL_APPROVED=true but legal-launch.json approval.approved is not true.');
    } else if (approval.termsVersion !== docs.terms?.version || approval.privacyVersion !== docs.privacy?.version) {
      fail('legal-launch.json approval versions do not match the current Terms/Privacy document versions.');
    }
    if (value('PAID_GA_TERMS_VERSION') && value('PAID_GA_TERMS_VERSION') !== docs.terms?.version) {
      fail('PAID_GA_TERMS_VERSION must equal legal-launch.json documents.terms.version.');
    }
    if (value('PAID_GA_CONTRACTING_ENTITY') && value('PAID_GA_CONTRACTING_ENTITY') !== String(business.legalEntityName ?? '').trim()) {
      fail('PAID_GA_CONTRACTING_ENTITY must equal legal-launch.json business.legalEntityName.');
    }
  }
  if (mode && mode !== 'closed_beta' && approval.approved !== true) {
    fail(`PUBLIC_SIGNUP_MODE=${mode} requires approval.approved=true in legal-launch.json.`);
  }

  return errors;
}

function runLaunchPolicy(envPath, extraArgs) {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'validate-production-launch.mjs'), envPath, ...extraArgs],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.status === 0) return [];
  const lines = String(result.stderr).split(/\r?\n/).filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
  return lines.length > 0 ? lines : [`validate-production-launch.mjs exited ${result.status}.`];
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/check-production-env.mjs <runtime-env-file> [--verify-local-secret-files] [--legal-config <legal-launch.json>]');
    console.log('Validates a real production env file. No network access; never prints secret values.');
    return;
  }
  const legalIndex = args.indexOf('--legal-config');
  const legalConfigPath = legalIndex >= 0 ? args[legalIndex + 1] : undefined;
  const envPath = args.find((argument, index) => !argument.startsWith('--') && index !== (legalIndex >= 0 ? legalIndex + 1 : -1));
  if (!envPath) {
    console.error('Usage: node scripts/check-production-env.mjs <runtime-env-file> [--verify-local-secret-files]');
    process.exitCode = 2;
    return;
  }
  const collector = createErrorCollector();
  const env = parseEnvFile(envPath, collector);
  const errors = [
    ...collector.errors,
    ...checkProductionEnv(env, legalConfigPath ? { legalConfig: readLegalLaunchConfig(resolve(legalConfigPath)) } : {}),
    ...runLaunchPolicy(envPath, args.filter((argument) => argument === '--verify-local-secret-files')),
  ];
  const unique = [...new Set(errors)];
  if (unique.length > 0) {
    console.error(`Production env check FAILED (${unique.length} issue${unique.length === 1 ? '' : 's'}):`);
    for (const error of unique) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, source: resolve(envPath), keys: Object.keys(env).length }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
