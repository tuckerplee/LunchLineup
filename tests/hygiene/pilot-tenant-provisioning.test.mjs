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
