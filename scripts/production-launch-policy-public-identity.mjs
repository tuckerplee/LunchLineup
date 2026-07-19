import { PLACEHOLDER_RE } from './production-launch-policy-shared.mjs';

const ALLOWED_SIGNUP_MODES = new Set(['closed_beta', 'invite_only', 'open']);
const SELF_SERVICE_TERMS_COUNSEL_APPROVED = false;
const SELF_SERVICE_TERMS_VERSION = null;

function assertPaidGaLegalApproval(context) {
  const {
    collector,
    assertExactValue,
    assertProofArtifactUri,
    assertPublicContactEmail,
    assertRequired,
  } = context;

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
    if (value && (PLACEHOLDER_RE.test(value) || /\b(?:todo|tbd|pending|unknown)\b/i.test(value))) {
      collector.fail(`${key} must be an approved, non-placeholder paid-GA value.`);
    }
  }

  const approvedAt = assertRequired('PAID_GA_COUNSEL_APPROVED_AT');
  if (approvedAt) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(approvedAt)
      ? Date.parse(`${approvedAt}T00:00:00.000Z`)
      : Number.NaN;
    if (!Number.isFinite(parsed) || parsed > Date.now()) {
      collector.fail('PAID_GA_COUNSEL_APPROVED_AT must be a valid, non-future YYYY-MM-DD date.');
    }
  }

  const incidentHours = Number.parseInt(assertRequired('PAID_GA_INCIDENT_NOTICE_HOURS'), 10);
  if (!Number.isInteger(incidentHours) || incidentHours < 1 || incidentHours > 168) {
    collector.fail('PAID_GA_INCIDENT_NOTICE_HOURS must be an approved integer from 1 through 168.');
  }

  assertPublicContactEmail('PAID_GA_CONTACT_OWNER_EMAIL');
  assertProofArtifactUri('PAID_GA_APPROVAL_RECORD_URI', { requireJson: true });
}

function assertProductionApiHealthUrl(context, domain) {
  const { collector, assertHttpsUrl, assertRequired } = context;
  const value = assertRequired('PRODUCTION_API_HEALTH_URL');
  if (!value) return;
  const url = assertHttpsUrl('PRODUCTION_API_HEALTH_URL', value);
  if (!url) return;

  if (url.username || url.password || url.search || url.hash) {
    collector.fail('PRODUCTION_API_HEALTH_URL must not contain credentials, a query, or a fragment.');
  }
  if (domain && url.hostname.toLowerCase().replace(/\.$/, '') !== domain) {
    collector.fail('PRODUCTION_API_HEALTH_URL must use the same hostname as DOMAIN.');
  }
  if (!['/health', '/api/health'].includes(url.pathname)) {
    collector.fail('PRODUCTION_API_HEALTH_URL must target /health or /api/health.');
  }
  if (url.port && url.port !== '443') {
    collector.fail('PRODUCTION_API_HEALTH_URL must use the default HTTPS port.');
  }
  collector.pass('PRODUCTION_API_HEALTH_URL');
}

function assertSignupMode(context) {
  const { collector, assertRequired } = context;
  const publicMode = assertRequired('PUBLIC_SIGNUP_MODE');
  const nextPublicMode = assertRequired('NEXT_PUBLIC_SIGNUP_MODE');
  if (!publicMode || !nextPublicMode) return;

  if (!ALLOWED_SIGNUP_MODES.has(publicMode)) {
    collector.fail('PUBLIC_SIGNUP_MODE must be one of: closed_beta, invite_only, open.');
  }
  if (!ALLOWED_SIGNUP_MODES.has(nextPublicMode)) {
    collector.fail('NEXT_PUBLIC_SIGNUP_MODE must be one of: closed_beta, invite_only, open.');
  }
  if (publicMode !== nextPublicMode) {
    collector.fail('PUBLIC_SIGNUP_MODE and NEXT_PUBLIC_SIGNUP_MODE must match before public launch.');
    return;
  }
  if (!ALLOWED_SIGNUP_MODES.has(publicMode)) return;

  if ((!SELF_SERVICE_TERMS_COUNSEL_APPROVED || !SELF_SERVICE_TERMS_VERSION) && publicMode !== 'closed_beta') {
    collector.fail(
      'PUBLIC_SIGNUP_MODE and NEXT_PUBLIC_SIGNUP_MODE must both be closed_beta while the checked-in Terms are not counsel-approved and versioned. Enabling invite_only or open requires counsel-approved, versioned Terms and a future code change.',
    );
  }
}

export function validatePublicIdentityLegalPolicy(context) {
  const {
    env,
    collector,
    assertHttpsUrl,
    assertPublicContactEmail,
    assertPublicHost,
    assertRequired,
    isPublicLaunchHostname,
    normalizeHost,
    readCsv,
    stripPort,
  } = context;

  if (env.NODE_ENV !== 'production') {
    collector.fail('NODE_ENV must be production for public launch validation.');
  } else {
    collector.pass('NODE_ENV');
  }

  const domain = assertPublicHost('DOMAIN');
  assertProductionApiHealthUrl(context, domain);
  const adminEmail = assertRequired('ADMIN_EMAIL');
  if (adminEmail) {
    const emailHost = adminEmail.replace(/^.*@/, '').replace(/[>\s].*$/, '').toLowerCase();
    if (!isPublicLaunchHostname(emailHost)) {
      collector.fail('ADMIN_EMAIL must use a real operational mailbox domain.');
    }
  }

  assertPublicContactEmail('NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL');
  assertPublicContactEmail('NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL');
  assertPublicContactEmail('NEXT_PUBLIC_DPA_CONTACT_EMAIL');
  assertPaidGaLegalApproval(context);
  assertSignupMode(context);

  const allowedOrigins = readCsv(assertRequired('ALLOWED_ORIGINS'));
  let hasDomainOrigin = false;
  for (const origin of allowedOrigins) {
    const url = assertHttpsUrl('ALLOWED_ORIGINS', origin);
    if (url && domain && url.hostname.toLowerCase() === domain) {
      hasDomainOrigin = true;
    }
  }
  if (domain && !hasDomainOrigin) {
    collector.fail(`ALLOWED_ORIGINS must include https://${domain}.`);
  }

  const allowedHosts = readCsv(assertRequired('ALLOWED_HOSTS'));
  if (domain && !allowedHosts.map((host) => stripPort(host)).includes(domain)) {
    collector.fail(`ALLOWED_HOSTS must include ${domain}.`);
  }
  for (const host of allowedHosts) {
    const normalized = normalizeHost(host, 'ALLOWED_HOSTS');
    if (normalized && !isPublicLaunchHostname(normalized)) {
      collector.fail(`ALLOWED_HOSTS contains a non-public launch host: ${host}`);
    }
  }

  const siteAddresses = readCsv(assertRequired('CADDY_SITE_ADDRESSES'));
  let hasDomainTls = false;
  for (const address of siteAddresses) {
    let url;
    try {
      url = new URL(address);
    } catch {
      collector.fail(`CADDY_SITE_ADDRESSES contains an invalid URL: ${address}`);
      continue;
    }

    if (domain && url.hostname.toLowerCase() === domain && url.protocol === 'https:') {
      hasDomainTls = true;
    }

    const publicHost = isPublicLaunchHostname(url.hostname);
    if (publicHost && url.protocol !== 'https:') {
      collector.fail(`CADDY_SITE_ADDRESSES public hosts must use https: ${address}`);
    }
  }
  if (domain && !hasDomainTls) {
    collector.fail(`CADDY_SITE_ADDRESSES must include https://${domain}.`);
  }

  return { domain };
}

export function validatePublicTransportPolicy(context) {
  const { env, collector, assertExactValue } = context;

  if (String(env.COOKIE_SECURE ?? '').toLowerCase() !== 'true') {
    collector.fail('COOKIE_SECURE must be true for public launch.');
  } else {
    collector.pass('COOKIE_SECURE');
  }
  assertExactValue('PASSWORD_RESET_EMAIL_OUTBOX_ENABLED', 'true');
  assertExactValue('STAFF_INVITATION_OUTBOX_ENABLED', 'true');
}

export function validateApiBindPolicy(context) {
  const { env, collector } = context;
  const key = 'API_HOST_BIND';
  const value = String(env[key] ?? '127.0.0.1').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) {
    collector.fail(`${key} must be set to a loopback bind address.`);
    return;
  }

  if (!['127.0.0.1', '::1', 'localhost'].includes(value)) {
    collector.fail(`${key} must bind only to loopback for public launch, not ${value}.`);
    return;
  }

  collector.pass(key);
}

function assertSameOriginPublicApiUrl(context) {
  const { collector, assertRequired } = context;
  const value = assertRequired('NEXT_PUBLIC_API_URL');
  if (!value) return;

  if (value !== '/api/v2') {
    collector.fail('NEXT_PUBLIC_API_URL must be exactly /api/v2 for same-origin public launch.');
    return;
  }

  collector.pass('NEXT_PUBLIC_API_URL');
}

function assertOidcRedirectUri(context, key, domain) {
  const { collector, assertHttpsUrl, assertRequired } = context;
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  if (domain && url.hostname.toLowerCase() !== domain) {
    collector.fail(`${key} must use DOMAIN so OIDC callbacks return through the same-origin public API.`);
    return;
  }

  if (url.pathname !== '/api/v1/auth/callback') {
    collector.fail(`${key} must end at /api/v1/auth/callback for the public API callback route.`);
    return;
  }

  collector.pass(key);
}

export function validatePublicRuntimePolicy(context, domain) {
  const {
    env,
    collector,
    assertHttpsOrigin,
    assertHttpsUrl,
    assertRequired,
    assertSecret,
    isPublicLaunchHostname,
    readBooleanFlag,
  } = context;

  assertSameOriginPublicApiUrl(context);

  assertHttpsOrigin('APP_ORIGIN', env.APP_ORIGIN);
  assertHttpsOrigin('NEXT_PUBLIC_APP_ORIGIN', env.NEXT_PUBLIC_APP_ORIGIN);
  assertHttpsUrl('NEXT_PUBLIC_APP_URL', env.NEXT_PUBLIC_APP_URL);
  const publicAppEnv = assertRequired('NEXT_PUBLIC_APP_ENV');
  if (publicAppEnv && publicAppEnv !== 'production') {
    collector.fail('NEXT_PUBLIC_APP_ENV must be production for public launch.');
  }

  const oidcEnabled = readBooleanFlag('OIDC_ENABLED');
  const nextPublicOidcEnabled = readBooleanFlag('NEXT_PUBLIC_OIDC_ENABLED');
  if (oidcEnabled !== null && nextPublicOidcEnabled !== null && oidcEnabled !== nextPublicOidcEnabled) {
    collector.fail('OIDC_ENABLED and NEXT_PUBLIC_OIDC_ENABLED must match so SSO-only tenants have both API and web login available.');
  }

  if (oidcEnabled === true || nextPublicOidcEnabled === true) {
    assertHttpsUrl('OIDC_ISSUER_URL', env.OIDC_ISSUER_URL);
    assertOidcRedirectUri(context, 'OIDC_REDIRECT_URI', domain);
    assertSecret('OIDC_CLIENT_SECRET');
    assertRequired('OIDC_CLIENT_ID');
  }
}
