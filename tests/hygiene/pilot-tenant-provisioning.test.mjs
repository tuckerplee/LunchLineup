import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const read = (path) => readFileSync(resolve(path), 'utf8');
const script = await import(pathToFileURL(resolve('scripts/pilot/provision-pilot-tenant.mjs')).href);

const SAFE_ENV = Object.freeze({
  DATA_TARGET_ENV: 'staging', NODE_ENV: 'production', APP_ORIGIN: 'https://dev.lunchlineup.com',
  INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true', PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'x',
  DATABASE_URL: 'postgresql://lunchlineup_app:pw@postgres:5432/lunchlineup',
});

test('target guard accepts the VM107 staging profile and refuses everything production-like', () => {
  assert.doesNotThrow(() => script.assertSafeTarget(SAFE_ENV));
  const refuse = (patch, pattern) => assert.throws(() => script.assertSafeTarget({ ...SAFE_ENV, ...patch }), pattern);
  refuse({ DATA_TARGET_ENV: 'production' }, /DATA_TARGET_ENV/);
  refuse({ DATA_TARGET_ENV: 'production-cutover' }, /DATA_TARGET_ENV/);
  refuse({ DATA_TARGET_ENV: undefined }, /DATA_TARGET_ENV/);
  refuse({ DATA_TARGET_ENV: 'test' }, /NODE_ENV=production is only accepted/);
  refuse({ APP_ENV: 'production' }, /APP_ENV/);
  refuse({ DATABASE_URL: 'postgresql://app:pw@postgres:5432/lunchlineup_prod' }, /production database/);
  refuse({ DATABASE_URL: 'postgresql://app:pw@prod-db.internal:5432/lunchlineup' }, /production database/);
  refuse({ DATABASE_URL: undefined }, /DATABASE_URL/);
  refuse({ PLATFORM_ADMIN_DB_CONTEXT_SECRET: '' }, /PLATFORM_ADMIN_DB_CONTEXT_SECRET/);
  refuse({ APP_ORIGIN: 'https://lunchlineup.com' }, /APP_ORIGIN/);
  refuse({ APP_ORIGIN: 'https://www.lunchlineup.com' }, /APP_ORIGIN/);
  refuse({ APP_ORIGIN: 'https://dev.lunchlineup.com/path' }, /APP_ORIGIN/);
  refuse({ INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'false' }, /INTERNAL_BETA_ENTITLEMENTS_ENABLED/);
});

test('CLI defaults to dry run and validates inputs', () => {
  const required = ['--org-name', 'Pilot', '--org-slug', 'pilot-one', '--manager-email', 'Owner@Example.com'];
  const defaults = script.parseCli(required);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.plan, 'GROWTH');
  assert.equal(defaults.managerEmail, 'owner@example.com');
  assert.equal(defaults.grantDays, defaults.trialDays);
  assert.equal(script.parseCli([...required, '--apply']).apply, true);
  const bad = (extra, pattern) => assert.throws(() => script.parseCli([...required, ...extra]), pattern);
  bad(['--apply', '--dry-run'], /either/);
  bad(['--plan', 'FREE'], /paid plan/);
  bad(['--trial-days', '10', '--grant-days', '11'], /outlive/);
  bad(['--grant-credits', '1001'], /between/);
  bad(['--location', 'No timezone'], /--location/);
  bad(['--location', 'Bad|Mars/Olympus'], /timezone/);
  bad(['--apply', '--employees-csv', 'x.csv'], /--pin-out is required/);
  assert.throws(() => script.parseCli(['--org-name', 'P', '--org-slug', 'Bad Slug', '--manager-email', 'a@b.co']), /org-slug/);
  assert.throws(() => script.parseCli(['--org-name', 'P', '--org-slug', 'ok-slug', '--manager-email', 'nope']), /manager-email/);
});

test('employee CSV parsing is strict, handles quoting, and derives deterministic usernames', () => {
  const rows = script.parseEmployees('﻿Name,Email,Phone,Role,access_role\r\n"Doe, Jane",JANE@Example.com,555-0101,Line Cook,staff\r\n"O""Neil",,,,\r\n');
  assert.deepEqual(rows.map((r) => r.username), ['doe.jane', 'o.neil']);
  assert.equal(rows[0].email, 'jane@example.com');
  assert.equal(rows[0].position, 'line cook');
  assert.equal(rows[1].access, 'STAFF');
  assert.equal(script.deriveUsername('José Núñez'), 'jose.nunez');
  const reject = (csv, pattern) => assert.throws(() => script.parseEmployees(csv), pattern);
  reject('name\n', /at least one/);
  reject('email\na@b.co\n', /"name" column/);
  reject('name,ssn\nA B,1\n', /Unknown CSV column/);
  reject('name\nAnn Lee\nAnn Lee\n', /duplicates line/);
  reject('name\nAB\n', /username/);
  reject('name,access_role\nAnn Lee,ADMIN\n', /access_role/);
  reject('name,email\nAnn Lee,not-an-email\n', /invalid email/);
  reject('name\n"unterminated\n', /unterminated/);
});

test('temporary PINs are six digits, hashed with the api-v2 scrypt scheme, and written 0600 exclusively', async () => {
  const { scryptSync } = await import('node:crypto');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const pin = script.temporaryPin();
  assert.match(pin, /^\d{6}$/);
  const [salt, hash, extra] = script.hashPin(pin).split(':');
  assert.equal(extra, undefined);
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.equal(hash.length, 128);
  assert.equal(scryptSync(pin, salt, 64).toString('hex') === script.hashPin(pin).split(':')[1], false, 'fresh salt per hash');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-file-'));
  try {
    const file = path.join(dir, 'pins.csv');
    script.writePinFile(file, 'pilot', [{ username: 'a.b', name: '=HYPERLINK("x")', pin: '123456' }]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^tenant_slug,username,name,temporary_pin,pin_reset_required\n/);
    assert.match(text, /'=HYPERLINK/, 'spreadsheet formula neutralized');
    assert.throws(() => script.writePinFile(file, 'pilot', []), /must not already exist/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('script constants match the source of truth they mirror', () => {
  const origins = read('packages/config/internal-beta-origins.ts');
  const listed = (name) => [...origins.match(new RegExp(`${name}[^=]*=\\s*Object\\.freeze\\(\\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...script.INTERNAL_BETA_ORIGINS], listed('INTERNAL_BETA_ORIGINS'));
  assert.deepEqual([...script.INTERNAL_BETA_COVERED_FEATURES], listed('INTERNAL_BETA_COVERED_FEATURES'));

  const plans = read('apps/api/src/billing/plan-definitions.ts');
  assert.match(plans, new RegExp(`INTERNAL_BETA_ENTITLEMENT_KEY = '${script.INTERNAL_BETA_ENTITLEMENT_KEY}'`));
  assert.match(plans, new RegExp(`INTERNAL_BETA_MAX_CREDITS = ${script.INTERNAL_BETA_MAX_CREDITS.toLocaleString('en-US').replace(',', '_')}`));
  assert.match(plans, new RegExp(`INTERNAL_BETA_MAX_DAYS = ${script.INTERNAL_BETA_MAX_DAYS}`));
  assert.match(read('apps/api/src/admin/internal-beta-entitlement.service.ts'), /INTERNAL_BETA_LEDGER_PREFIX = 'Internal beta scheduling entitlement: '/);
  assert.match(read('apps/api/src/billing/metering.service.ts'), /`admin-credit-grant-\$\{createHash\('sha256'\)\s*\.update\(`\$\{tenantId\}:\$\{idempotencyKey\}`/);

  const rbac = read('apps/api/src/auth/rbac.service.ts');
  const defaults = rbac.slice(rbac.indexOf('export const DEFAULT_ROLE_DEFINITIONS'), rbac.indexOf('export const MAX_CUSTOM_ROLES_PER_TENANT'));
  for (const [slug, definition] of Object.entries(script.SYSTEM_ROLES)) {
    const block = defaults.slice(defaults.indexOf(`slug: '${slug}'`)).split(/\n    \},\n/)[0];
    const permissions = [...block.slice(block.indexOf('permissions: [')).matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(definition.permissions, permissions, `${slug} permissions drifted from rbac.service.ts`);
    assert.match(block, new RegExp(`name: '${definition.name}'`));
    assert.match(block, new RegExp(`legacyRole: UserRole\\.${definition.legacyRole}`));
  }
});

test('stored grant shape is exactly what api-v2 feature-entitlement verifies', () => {
  const gate = read('apps/api-v2/src/platform/feature-entitlement.ts');
  for (const fragment of [
    "grant.version !== 1", "grant.source !== 'internal_beta'", "grant.status !== 'ACTIVE'",
    "grant.features[0] !== 'scheduling'", '`${grant.grantId}-internal-beta-audit`',
    "audit.action === 'INTERNAL_BETA_ENTITLEMENT_GRANTED'", "audit.resource === 'TenantSetting'",
  ]) assert.ok(gate.includes(fragment), `feature-entitlement.ts no longer contains ${fragment}`);
  const source = read('scripts/pilot/provision-pilot-tenant.mjs');
  for (const fragment of [
    "version: 1, source: 'internal_beta', status: 'ACTIVE'", "features: ['scheduling']",
    'auditId = `${grantId}-internal-beta-audit`', "action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED'", "resource: 'TenantSetting'",
  ]) assert.ok(source.includes(fragment), `provision-pilot-tenant.mjs no longer contains ${fragment}`);
});

test('the script never prints PINs and is self-contained for the api-v2 image', () => {
  const source = read('scripts/pilot/provision-pilot-tenant.mjs');
  assert.doesNotMatch(source, /console\.(log|error)/);
  assert.doesNotMatch(source, /\b(pin|passwordHash|password)\b[^\n]*io\.(out|err)/);
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(imports.every((name) => name.startsWith('node:')), `non-builtin static import: ${imports.join(', ')}`);
  const dockerfile = read('infrastructure/docker/Dockerfile.api-v2');
  assert.match(dockerfile, /COPY --from=builder \/app\/apps\/api-v2\/dist \/app\/dist/);
  assert.doesNotMatch(dockerfile, /COPY[^\n]*scripts/, 'scripts/ is not in the image; the runbook must mount it');
  assert.match(read('docs/runbooks/pilot-tenant-provisioning.md'), /docker compose run --rm --no-deps/);
});

test('existing-tenant PIN mode: CLI parsing, defaults and refusals', () => {
  const parsed = script.parseCli(['--existing-tenant', 'substance', '--issue-pins-for', 'staff, admin,STAFF']);
  assert.equal(parsed.mode, 'issue-pins');
  assert.equal(parsed.apply, false, 'dry run is the default');
  assert.equal(parsed.all, false, 'only users without credentials is the default');
  assert.deepEqual(parsed.roles, ['STAFF', 'ADMIN']);
  assert.equal(parsed.tenantRef, 'substance');
  assert.equal(script.parseCli(['--existing-tenant', 'Substance Co', '--issue-pins-for', 'MANAGER', '--only-without-credentials', '--apply']).apply, true);
  assert.equal(script.parseCli(['--existing-tenant', 'substance', '--issue-pins-for', 'STAFF', '--all']).all, true);
  const bad = (args, pattern) => assert.throws(() => script.parseCli(args), pattern);
  bad(['--existing-tenant', 'substance'], /--issue-pins-for and/);
  bad(['--issue-pins-for', 'STAFF'], /--existing-tenant is required/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', 'SUPER_ADMIN'], /accepts only STAFF, MANAGER, ADMIN/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', ' , '], /at least one role/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', 'STAFF', '--all', '--only-without-credentials'], /either/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', 'STAFF', '--apply', '--dry-run'], /either/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', 'STAFF', '--org-slug', 'x-y-z'], /never creates anything; remove --org-slug/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', 'STAFF', '--employees-csv', 'a.csv', '--plan', 'GROWTH'], /--employees-csv, --plan|--plan, --employees-csv/);
  bad(['--existing-tenant', 'substance', '--issue-pins-for', 'STAFF', '--location', 'A|UTC'], /--location/);
  bad(['--all'], /--existing-tenant is required/);
});

test('existing-tenant PIN mode keeps the staging-only guards but does not need the grant flag', () => {
  const { INTERNAL_BETA_ENTITLEMENTS_ENABLED: _flag, ...withoutFlag } = SAFE_ENV;
  assert.doesNotThrow(() => script.assertSafeTarget(withoutFlag, { requireInternalBetaFlag: false }));
  assert.throws(() => script.assertSafeTarget(withoutFlag), /INTERNAL_BETA_ENTITLEMENTS_ENABLED/);
  const refuse = (patch, pattern) => assert.throws(() => script.assertSafeTarget({ ...withoutFlag, ...patch }, { requireInternalBetaFlag: false }), pattern);
  refuse({ DATA_TARGET_ENV: 'production' }, /DATA_TARGET_ENV/);
  refuse({ DATA_TARGET_ENV: undefined }, /DATA_TARGET_ENV/);
  refuse({ APP_ENV: 'production' }, /APP_ENV/);
  refuse({ APP_ORIGIN: 'https://lunchlineup.com' }, /APP_ORIGIN/);
  refuse({ DATABASE_URL: 'postgresql://app:pw@postgres:5432/lunchlineup_prod' }, /production database/);
  refuse({ PLATFORM_ADMIN_DB_CONTEXT_SECRET: '' }, /PLATFORM_ADMIN_DB_CONTEXT_SECRET/);
});

test('existing-tenant PIN mode writes only PIN credentials: no tenant, entitlement, location or user is created', () => {
  const source = read('scripts/pilot/provision-pilot-tenant.mjs');
  const start = source.indexOf('export async function issuePins');
  const end = source.indexOf('/** Runs reconcile in one platform-admin transaction');
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /\.(createMany|upsert|delete|deleteMany)\(/, 'no bulk create, upsert or delete');
  assert.deepEqual([...body.matchAll(/tx\.(\w+)\.(create|updateMany|update)\(/g)].map((m) => `${m[1]}.${m[2]}`).sort(), ['auditLog.create', 'user.updateMany']);
  assert.match(body, /pinResetRequired: true/);
  assert.match(body, /hashPin\(pin\)/);
  assert.match(body, /passwordHash: null, pinHash: null/, 'the default filter is re-applied in the UPDATE itself (race-safe)');
  assert.doesNotMatch(body, /io\.(out|err)|console\./);
  // The entitlement report mirrors the gate's decision inputs.
  const gate = read('apps/api-v2/src/platform/feature-entitlement.ts');
  for (const fragment of ["tenant.status === 'ACTIVE'", 'stripeSubscriptionCurrentPeriodEnd > now', "tenant.status !== 'TRIAL'", "key: 'feature_access'"]) {
    assert.ok(gate.includes(fragment) || gate.includes(fragment.replace('tenant.', 'tenant.')), `gate no longer contains ${fragment}`);
  }
  assert.match(read('docs/runbooks/pilot-tenant-provisioning.md'), /--existing-tenant/);
});

test('existing-tenant --grant-internal-beta: CLI parsing and scoping', () => {
  const g = script.parseCli(['--existing-tenant', 'substance', '--grant-internal-beta']);
  assert.equal(g.grantInternalBeta, true);
  assert.deepEqual(g.roles, []);
  assert.equal(g.trialDays, 30);
  assert.equal(g.grantDays, 30);
  assert.equal(g.credits, 100);
  assert.equal(g.grantLabel, 'v1');
  assert.equal(g.plan, null, 'plan is kept unless --plan is given');
  const full = script.parseCli(['--existing-tenant', 'substance', '--grant-internal-beta', '--issue-pins-for', 'STAFF', '--plan', 'growth', '--trial-days', '10', '--grant-label', 'v2', '--grant-credits', '5']);
  assert.equal(full.plan, 'GROWTH');
  assert.equal(full.grantDays, 10);
  assert.deepEqual(full.roles, ['STAFF']);
  const bad = (args, pattern) => assert.throws(() => script.parseCli(['--existing-tenant', 'substance', ...args]), pattern);
  bad(['--trial-days', '10', '--issue-pins-for', 'STAFF'], /never creates anything; remove --trial-days/);
  bad(['--grant-internal-beta', '--plan', 'FREE'], /paid plan/);
  bad(['--grant-internal-beta', '--trial-days', '91'], /between/);
  bad(['--grant-internal-beta', '--trial-days', '10', '--grant-days', '11'], /outlive/);
  bad(['--grant-internal-beta', '--grant-credits', '1001'], /between/);
  bad(['--grant-internal-beta', '--org-slug', 'x-y-z'], /never creates anything; remove --org-slug/);
  bad(['--grant-internal-beta', '--all'], /need --issue-pins-for/);
  bad([], /--issue-pins-for and\/or --grant-internal-beta is required/);
});

test('--grant-internal-beta reuses the creation-mode grant writer and refuses Stripe-linked tenants', () => {
  const source = read('scripts/pilot/provision-pilot-tenant.mjs');
  const start = source.indexOf('async function grantInternalBetaToExisting');
  const end = source.indexOf('/** Issues temporary PINs');
  const body = source.slice(start, end);
  assert.match(body, /reconcileGrant\(tx, current,/);
  assert.match(body, /stripeCustomerId/);
  assert.match(body, /stripeSubscriptionId/);
  assert.match(body, /internalBetaRuntimeEnabled\(options\.env\)/);
  assert.deepEqual([...body.matchAll(/tx\.(\w+)\.(create|update|updateMany|upsert)\(/g)].map((m) => `${m[1]}.${m[2]}`).sort(), ['auditLog.create', 'tenant.update']);
});
