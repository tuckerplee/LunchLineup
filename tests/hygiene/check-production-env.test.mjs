import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkProductionEnv, REQUIRED_KEYS, verifyPgbackrestFiles } from '../../scripts/check-production-env.mjs';
import { BASE } from '../fixtures/production-env-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/check-production-env.mjs');
const example = join(root, 'infrastructure/production/runtime.env.example');

const APPROVED_LEGAL = {
  business: {
    legalEntityName: 'LunchLineup Incorporated',
    mailingAddress: '1 Main Street, Springfield',
    governingLaw: 'State of Delaware',
    effectiveDate: '2026-07-01',
  },
  documents: { terms: { version: '2026-07-01' }, privacy: { version: '2026-07-01' } },
  approval: { approved: true, termsVersion: '2026-07-01', privacyVersion: '2026-07-01' },
};

const env = (overrides = {}) => ({ ...BASE, ...overrides });
const check = (overrides = {}, legalConfig = APPROVED_LEGAL) => checkProductionEnv(env(overrides), { legalConfig });
const asFile = (values) => `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;

function runCli(values, extraArgs = []) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-check-env-'));
  try {
    const envPath = join(scratch, 'runtime.env');
    writeFileSync(envPath, asFile(values));
    return spawnSync(process.execPath, [script, envPath, ...extraArgs], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('accepts a complete real-looking production profile with approved legal config', () => {
  assert.deepEqual(check(), []);
});

test('flags every missing required key by name', () => {
  for (const key of ['DOMAIN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'METRICS_TOKEN_FILE', 'PUBLIC_SIGNUP_MODE']) {
    const values = env();
    delete values[key];
    assert.ok(checkProductionEnv(values, { legalConfig: APPROVED_LEGAL }).some((e) => e.startsWith(`${key} is required`)), key);
  }
  assert.ok(REQUIRED_KEYS.every((key) => key in BASE), 'fixture covers every required key');
  for (const dead of ['BACKUP_OFFSITE_URI', 'BACKUP_ENCRYPTION_KEY_SECRET_FILE', 'PITR_S3_ENDPOINT', 'PITR_S3_BUCKET', 'PITR_LIFECYCLE_POLICY_PROOF_URI', 'ALERTMANAGER_WEBHOOK_URL_FILE', 'GRAFANA_USER', 'GRAFANA_PASSWORD']) {
    assert.ok(!REQUIRED_KEYS.includes(dead), `${dead} belongs to a removed component and must not be required`);
    assert.ok(!(dead in BASE), `${dead} must not be in the production fixture`);
  }
});

test('requires pgBackRest PITR settings in production and validates their shape', () => {
  for (const key of ['PGBACKREST_ENABLED', 'PGBACKREST_STANZA', 'PGBACKREST_SFTP_HOST', 'PGBACKREST_SFTP_USER',
    'PGBACKREST_REPO_PATH', 'PGBACKREST_SFTP_KEY_FILE', 'PGBACKREST_SFTP_KNOWN_HOSTS_FILE', 'PGBACKREST_CIPHER_PASS_FILE']) {
    const values = env();
    delete values[key];
    assert.ok(checkProductionEnv(values, { legalConfig: APPROVED_LEGAL }).some((e) => e.startsWith(`${key} is required`)), key);
  }
  assert.ok(check({ PGBACKREST_ENABLED: 'false' }).some((e) => /PGBACKREST_ENABLED must be exactly true/.test(e)));
  assert.ok(check({ PGBACKREST_STANZA: 'Bad Stanza' }).some((e) => /PGBACKREST_STANZA/.test(e)));
  assert.ok(check({ PGBACKREST_REPO_PATH: 'repo' }).some((e) => /PGBACKREST_REPO_PATH/.test(e)));
  assert.ok(check({ PGBACKREST_SFTP_KEY_FILE: 'relative/key' }).some((e) => /PGBACKREST_SFTP_KEY_FILE must be an absolute/.test(e)));
  assert.ok(check({ PGBACKREST_CIPHER_PASS_FILE: BASE.PGBACKREST_SFTP_KEY_FILE }).some((e) => /three different files/.test(e)));
  assert.ok(check({ PGBACKREST_SFTP_PORT: 'ssh' }).some((e) => /PGBACKREST_SFTP_PORT/.test(e)));
  assert.deepEqual(check({ PGBACKREST_SFTP_PORT: '22' }), []);
});

test('verifyPgbackrestFiles fails closed on missing or empty host files', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-pgbr-files-'));
  try {
    const good = (name, body = 'x') => { const p = join(scratch, name); writeFileSync(p, body, { mode: 0o600 }); return p; };
    const files = {
      PGBACKREST_SFTP_KEY_FILE: good('key'),
      PGBACKREST_SFTP_KNOWN_HOSTS_FILE: good('known_hosts'),
      PGBACKREST_CIPHER_PASS_FILE: good('cipher'),
    };
    assert.deepEqual(verifyPgbackrestFiles(files), []);
    assert.ok(verifyPgbackrestFiles({ ...files, PGBACKREST_SFTP_KEY_FILE: join(scratch, 'absent') }).some((e) => /does not exist/.test(e)));
    assert.ok(verifyPgbackrestFiles({ ...files, PGBACKREST_CIPHER_PASS_FILE: good('empty', '') }).some((e) => /non-empty regular file/.test(e)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('enforces NODE_ENV, app env and COOKIE_SECURE', () => {
  assert.ok(check({ NODE_ENV: 'development' }).some((e) => /NODE_ENV must be exactly production/.test(e)));
  assert.ok(check({ NEXT_PUBLIC_APP_ENV: 'staging' }).some((e) => /NEXT_PUBLIC_APP_ENV/.test(e)));
  assert.ok(check({ COOKIE_SECURE: 'false' }).some((e) => /COOKIE_SECURE must be exactly true/.test(e)));
  assert.ok(check({ AUTH_DEBUG: 'true' }).some((e) => /AUTH_DEBUG/.test(e)));
  assert.ok(check({ BETA_DEMO_MFA_BYPASS_ENABLED: 'true' }).some((e) => /BETA_DEMO_MFA_BYPASS_ENABLED/.test(e)));
});

test('rejects OWNER and GENERATE_ME markers and other placeholders without echoing values', () => {
  const errors = check({
    STRIPE_PRICE_STARTER: 'OWNER:price_starter',
    JWT_SECRET: 'GENERATE_ME',
    STRIPE_WEBHOOK_SECRET: 'CHANGE_ME_webhook',
    SUPPORT_NOTE: '<fill in>',
  });
  for (const key of ['STRIPE_PRICE_STARTER', 'JWT_SECRET', 'STRIPE_WEBHOOK_SECRET', 'SUPPORT_NOTE']) {
    assert.ok(errors.some((e) => e.startsWith(key)), key);
  }
  assert.ok(errors.every((e) => !e.includes('fill in') && !e.includes('OWNER:price')));
});

test('rejects dev, beta, localhost and private hosts in public values', () => {
  for (const [key, value] of [
    ['DOMAIN', 'beta.lunchlineup.com'],
    ['APP_ORIGIN', 'https://dev.lunchlineup.com'],
    ['NEXT_PUBLIC_APP_URL', 'http://localhost:3000'],
    ['ALLOWED_ORIGINS', 'https://lunchlineup.com,https://staging.lunchlineup.com'],
    ['PRODUCTION_API_HEALTH_URL', 'https://10.231.10.254/api/health'],
    ['EMAIL_FROM', 'LunchLineup <no-reply@beta.lunchlineup.com>'],
  ]) {
    assert.ok(check({ [key]: value }).some((e) => e.startsWith(key)), `${key}=${value}`);
  }
  assert.ok(check({ SOMETHING_ELSE: 'https://beta.lunchlineup.com/x' }).some((e) => /SOMETHING_ELSE references a beta\/dev/.test(e)));
});

test('requires live-mode provider credentials and distinct secrets', () => {
  assert.ok(check({ STRIPE_SECRET_KEY: ['sk', 'test', 'abcdefghijklmnopqrstuvwxyz123456'].join('_') }).some((e) => /STRIPE_SECRET_KEY/.test(e)));
  assert.ok(check({ RESEND_API_KEY: 're_dev_abcdefghijklmnopqrstuvwxyz123456' }).some((e) => /RESEND_API_KEY/.test(e)));
  assert.ok(check({ DEPLOY_RELEASE_SHA: 'main' }).some((e) => /DEPLOY_RELEASE_SHA/.test(e)));
  assert.ok(check({ SESSION_SECRET: BASE.JWT_SECRET }).some((e) => /must all differ/.test(e)));
  assert.ok(check({ AVAILABILITY_IMPORT_ENCRYPTION_KEY: BASE.MFA_SECRET_ENCRYPTION_KEY_CURRENT }).some((e) => /distinct/.test(e)));
  assert.ok(check({ MFA_SECRET_ENCRYPTION_KEY_CURRENT: 'short' }).some((e) => /32 bytes/.test(e)));
  assert.ok(check({ APP_DB_PASSWORD: BASE.POSTGRES_PASSWORD }).some((e) => /APP_DB_PASSWORD must differ/.test(e)));
});

test('signup mode must agree and carry its prerequisites', () => {
  assert.ok(check({ NEXT_PUBLIC_SIGNUP_MODE: 'open' }).some((e) => /must be identical/.test(e)));
  const open = check({ PUBLIC_SIGNUP_MODE: 'open', NEXT_PUBLIC_SIGNUP_MODE: 'open' });
  assert.ok(open.some((e) => /TURNSTILE_SECRET_KEY/.test(e)));
  assert.ok(open.some((e) => /NEXT_PUBLIC_TURNSTILE_SITE_KEY/.test(e)));
  assert.ok(check({ PUBLIC_SIGNUP_MODE: 'invite_only', NEXT_PUBLIC_SIGNUP_MODE: 'invite_only' }).some((e) => /INVITE_CODES/.test(e)));
  assert.deepEqual(check({
    PUBLIC_SIGNUP_MODE: 'open',
    NEXT_PUBLIC_SIGNUP_MODE: 'open',
    TURNSTILE_SECRET_KEY: 'turnstile-live-key',
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAAsitekey',
  }), []);
});

test('legal cross-checks use the single legal-launch config', () => {
  const unapproved = { ...APPROVED_LEGAL, approval: { approved: false } };
  assert.ok(check({}, unapproved).some((e) => /approval\.approved is not true/.test(e)));
  const pending = { ...APPROVED_LEGAL, business: { ...APPROVED_LEGAL.business, legalEntityName: 'OWNER: registered legal entity name' } };
  assert.ok(check({}, pending).some((e) => /legalEntityName/.test(e)));
  assert.ok(check({ PAID_GA_CONTRACTING_ENTITY: 'Other Corp' }).some((e) => /PAID_GA_CONTRACTING_ENTITY must equal/.test(e)));
  assert.ok(check({ PAID_GA_TERMS_VERSION: '1999-01-01' }).some((e) => /PAID_GA_TERMS_VERSION must equal/.test(e)));
  assert.ok(check({ PAID_GA_LEGAL_APPROVED: 'false' }).some((e) => /PAID_GA_LEGAL_APPROVED must be exactly true/.test(e)));
  const stale = { ...APPROVED_LEGAL, approval: { ...APPROVED_LEGAL.approval, termsVersion: '2025-01-01' } };
  assert.ok(check({}, stale).some((e) => /do not match the current/.test(e)));
  assert.ok(check({
    PUBLIC_SIGNUP_MODE: 'invite_only',
    NEXT_PUBLIC_SIGNUP_MODE: 'invite_only',
    PUBLIC_SIGNUP_INVITE_CODES: 'abc',
  }, unapproved).some((e) => /requires approval\.approved=true/.test(e)));
});

test('CLI exits non-zero on the committed unapproved legal config and on the raw template', () => {
  const committed = runCli(BASE);
  assert.equal(committed.status, 1);
  assert.match(committed.stderr, /Production env check FAILED/);
  assert.match(committed.stderr, /legal-launch\.json/);

  const template = spawnSync(process.execPath, [script, example], { cwd: root, encoding: 'utf8' });
  assert.equal(template.status, 1);
  assert.match(template.stderr, /OWNER\/GENERATE_ME marker/);
});

test('CLI passes end to end with an approved legal config and runs the full launch policy', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-check-legal-'));
  try {
    const legalPath = join(scratch, 'legal-launch.json');
    writeFileSync(legalPath, JSON.stringify(APPROVED_LEGAL));
    const ok = runCli(BASE, ['--legal-config', legalPath]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).ok, true);

    const bad = runCli({ ...BASE, STRIPE_PRICE_STARTER: 'not-a-price' }, ['--legal-config', legalPath]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /STRIPE_PRICE_STARTER must be a configured Stripe price ID/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the checked-in template lists every required key and contains no real secrets', () => {
  const text = readFileSync(example, 'utf8');
  for (const key of REQUIRED_KEYS) {
    assert.match(text, new RegExp(`^${key}=`, 'm'), `${key} missing from runtime.env.example`);
  }
  assert.doesNotMatch(text, /sk_live_[A-Za-z0-9]{10}|re_[A-Za-z0-9]{20}|whsec_[A-Za-z0-9]{20}/);
});
