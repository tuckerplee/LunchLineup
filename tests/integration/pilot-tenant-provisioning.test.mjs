/**
 * Real-PostgreSQL proof for scripts/pilot/provision-pilot-tenant.mjs: dry-run
 * persists nothing, --apply creates the pilot tenant (paid plan, TRIAL), the
 * internal-beta grant that the real api-v2 entitlement gate accepts for
 * scheduling and lunch_breaks (and not for time_cards), locations, owner and
 * employees with temporary PINs that reach only a 0600 file; reruns are no-ops;
 * production-like targets are refused before any database client loads.
 *
 * The second test covers `--existing-tenant ... --issue-pins-for ...`: PINs for the
 * credential-less users of an existing ENTERPRISE ACTIVE tenant, nothing else created,
 * and an entitlement report that agrees with the real api-v2 gate in every scenario.
 *
 * Requires the same disposable services as the other integration tests:
 * MIGRATION_DATABASE_URL (owner), DATABASE_URL (restricted app role) and
 * PLATFORM_ADMIN_DB_CONTEXT_SECRET, after scripts/apply-db-migrations.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
const DEV_ORIGIN = 'https://dev.lunchlineup.com';
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api-v2/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');
const { assertFeatureEntitled } = require('../../apps/api-v2/src/platform/feature-entitlement.ts');
const { main } = await import(pathToFileURL(resolve(root, 'scripts/pilot/provision-pilot-tenant.mjs')).href);

function capture() {
  const chunks = { out: '', err: '' };
  return { chunks, io: { out: (s) => { chunks.out += s; }, err: (s) => { chunks.err += s; } } };
}

function verifiesPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  return scryptSync(pin, salt, 64).toString('hex') === hash;
}

test('pilot tenant provisioning is guarded, atomic, idempotent and entitles scheduling and lunch breaks', async () => {
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  assert.ok(['test', 'disposable'].includes(process.env.DATA_TARGET_ENV), 'DATA_TARGET_ENV must be test or disposable');
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const run = randomUUID().slice(0, 8);
  const slug = `pilot-it-${run}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-prov-'));
  const csv = path.join(dir, 'staff.csv');
  fs.writeFileSync(csv, [
    'name,email,phone,position,access_role',
    'Ada Lovelace,ada@example.test,555-0100,Cook,STAFF',
    '"Grace ""Amazing"" Hopper",,,Server,',
    'Dana Shift,dana@example.test,,Shift Lead,MANAGER',
  ].join('\r\n'));
  const pinOut = path.join(dir, 'pins.csv');
  const env = {
    ...process.env, DATA_TARGET_ENV: 'test', NODE_ENV: 'test', APP_ORIGIN: DEV_ORIGIN,
    INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
  };
  const base = [
    '--org-name', `Pilot ${run}`, '--org-slug', slug, '--manager-email', `owner-${run}@example.test`,
    '--location', 'Main Cafe|America/Chicago|1 Main St', '--location', 'Annex|America/New_York',
    '--employees-csv', csv, '--operator', 'integration-test',
  ];
  const tenantRow = () => owner.tenant.findUnique({ where: { slug } });

  try {
    // ---------------------------------------------------------------- guards
    for (const [label, patch, pattern] of [
      ['production target', { DATA_TARGET_ENV: 'production' }, /DATA_TARGET_ENV/],
      ['unset target', { DATA_TARGET_ENV: '' }, /DATA_TARGET_ENV/],
      ['NODE_ENV=production outside staging', { NODE_ENV: 'production' }, /staging/],
      ['production-looking database', { DATABASE_URL: 'postgresql://app:pw@db.internal:5432/lunchlineup_production' }, /production/],
      ['production origin', { APP_ORIGIN: 'https://lunchlineup.com' }, /APP_ORIGIN/],
      ['grant flag off', { INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'false' }, /INTERNAL_BETA_ENTITLEMENTS_ENABLED/],
    ]) {
      const { chunks, io } = capture();
      assert.equal(await main([...base, '--apply', '--pin-out', pinOut], { ...env, ...patch }, io), 2, label);
      assert.match(chunks.err, pattern, label);
    }
    assert.equal(await tenantRow(), null, 'guard refusals touch nothing');

    // --------------------------------------------------------------- dry run
    const dry = capture();
    assert.equal(await main(base, env, dry.io), 0, dry.chunks.err);
    assert.match(dry.chunks.out, /DRY_RUN/);
    assert.equal(await tenantRow(), null, 'dry run rolls everything back');
    assert.equal(fs.existsSync(pinOut), false);

    // A plan without lunch_breaks cannot carry the covered entitlement.
    const starter = capture();
    assert.equal(await main([...base, '--plan', 'STARTER'], env, starter.io), 2);
    assert.match(starter.chunks.err, /lunch_breaks/);

    // ----------------------------------------------------------------- apply
    const first = capture();
    assert.equal(await main([...base, '--apply', '--pin-out', pinOut], env, first.io), 0, first.chunks.err);
    assert.match(first.chunks.out, /APPLIED/);

    const tenant = await tenantRow();
    assert.equal(tenant.planTier, 'GROWTH');
    assert.equal(tenant.status, 'TRIAL');
    assert.equal(tenant.stripeSubscriptionId, null);
    assert.ok(tenant.trialEndsAt > new Date(Date.now() + 29 * 86_400_000));
    assert.equal(tenant.usageCredits, 100);
    assert.equal(await owner.location.count({ where: { tenantId: tenant.id } }), 2);
    const manager = await owner.user.findFirstOrThrow({ where: { tenantId: tenant.id, email: `owner-${run}@example.test` } });
    assert.equal(manager.role, 'ADMIN');
    assert.equal(manager.passwordHash, null);
    assert.equal(manager.pinHash, null);
    const roles = await owner.roleAssignment.findMany({ where: { tenantId: tenant.id }, include: { role: true } });
    assert.deepEqual(roles.map((r) => r.role.slug).sort(), ['admin', 'manager', 'staff', 'staff']);
    const employees = await owner.user.findMany({ where: { tenantId: tenant.id, username: { not: null } }, orderBy: { username: 'asc' } });
    assert.deepEqual(employees.map((e) => e.username), ['ada.lovelace', 'dana.shift', 'grace.amazing.hopper']);
    assert.ok(employees.every((e) => e.pinResetRequired && e.pinHash && e.pinSetAt));
    assert.equal(employees.find((e) => e.username === 'dana.shift').role, 'MANAGER');
    const skills = await owner.staffSkill.findMany({ where: { tenantId: tenant.id } });
    assert.deepEqual(skills.map((s) => s.skill).sort(), ['cook', 'server', 'shift lead']);

    // PINs reach the 0600 file only.
    if (process.platform !== 'win32') assert.equal(fs.statSync(pinOut).mode & 0o777, 0o600);
    const lines = fs.readFileSync(pinOut, 'utf8').trim().split('\n').slice(1);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'));
      const [, username, , pin, reset] = cells;
      assert.match(pin, /^\d{6}$/);
      assert.equal(reset, 'true');
      const row = employees.find((e) => e.username === username);
      assert.ok(verifiesPin(pin, row.pinHash), `${username} PIN matches stored hash`);
      assert.ok(!first.chunks.out.includes(pin) && !first.chunks.err.includes(pin), 'PIN never printed');
    }

    // The real api-v2 gate accepts the stored grant for exactly the covered features.
    Object.assign(process.env, { APP_ORIGIN: DEV_ORIGIN, INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true' });
    const database = new TenantDatabase(app);
    for (const feature of ['scheduling', 'lunch_breaks']) {
      const entitlement = await database.withTenant(tenant.id, (tx) => assertFeatureEntitled(tx, tenant.id, feature, true));
      assert.deepEqual(entitlement, { feature, creditCost: 1 });
    }
    await assert.rejects(
      database.withTenant(tenant.id, (tx) => assertFeatureEntitled(tx, tenant.id, 'time_cards', true)),
      (error) => error.status === 403 || error.statusCode === 403 || /not_entitled/.test(String(error.code ?? error.message)),
    );

    // ---------------------------------------------------------------- rerun
    const counts = async () => ({
      users: await owner.user.count({ where: { tenantId: tenant.id } }),
      credits: await owner.creditTransaction.count({ where: { tenantId: tenant.id } }),
      grantAudits: await owner.auditLog.count({ where: { tenantId: tenant.id, action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED' } }),
      locations: await owner.location.count({ where: { tenantId: tenant.id } }),
      wallet: (await tenantRow()).usageCredits,
    });
    const before = await counts();
    const pinOut2 = path.join(dir, 'pins-rerun.csv');
    const again = capture();
    assert.equal(await main([...base, '--apply', '--pin-out', pinOut2], env, again.io), 0, again.chunks.err);
    assert.deepEqual(await counts(), before);
    assert.equal(fs.existsSync(pinOut2), false, 'no new employees means no PIN file');
    assert.doesNotMatch(again.chunks.out, /"action": "create"/);

    // Atomicity: a new employee with an unusable PIN file path rolls everything back.
    fs.appendFileSync(csv, '\r\nNew Hire,,,Dishwasher,');
    const blocked = capture();
    assert.equal(await main([...base, '--apply', '--pin-out', pinOut], env, blocked.io), 2);
    assert.match(blocked.chunks.err, /PIN file/);
    assert.deepEqual(await counts(), before);
    assert.equal(await owner.user.count({ where: { tenantId: tenant.id, username: 'new.hire' } }), 0);

    // Re-run with a fresh path creates only the new hire.
    const incremental = capture();
    assert.equal(await main([...base, '--apply', '--pin-out', pinOut2], env, incremental.io), 0, incremental.chunks.err);
    assert.equal((await counts()).users, before.users + 1);
    assert.equal(fs.readFileSync(pinOut2, 'utf8').trim().split('\n').length, 2);
  } finally {
    const tenant = await owner.tenant.findUnique({ where: { slug } });
    if (tenant) {
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        const tables = await tx.$queryRawUnsafe(`
          SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name NOT IN ('Tenant', 'User')`);
        for (const { table_name: table } of tables) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, tenant.id);
        }
        await tx.$executeRawUnsafe('DELETE FROM "User" WHERE "tenantId" = $1', tenant.id);
        await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', tenant.id);
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    await app.$disconnect();
    await owner.$disconnect();
  }
});

async function purgeTenant(owner, slug) {
  const tenant = await owner.tenant.findUnique({ where: { slug } });
  if (!tenant) return;
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const tables = await tx.$queryRawUnsafe(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name NOT IN ('Tenant', 'User')`);
    for (const { table_name: table } of tables) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, tenant.id);
    }
    await tx.$executeRawUnsafe('DELETE FROM "User" WHERE "tenantId" = $1', tenant.id);
    await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', tenant.id);
  });
}

test('existing-tenant PIN issuance: credential-less users only, nothing else created, entitlement report agrees with the real gate', async () => {
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  assert.ok(['test', 'disposable'].includes(process.env.DATA_TARGET_ENV), 'DATA_TARGET_ENV must be test or disposable');
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const run = randomUUID().slice(0, 8);
  const slug = `substance-it-${run}`;
  const trialSlug = `substance-trial-${run}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-pins-'));
  const pinOut = path.join(dir, 'pins.csv');
  // NODE_ENV=production + staging is exactly the VM107 profile; the grant flag is deliberately NOT set
  // for the PIN runs because this mode must not need it.
  const env = {
    ...process.env, DATA_TARGET_ENV: 'staging', NODE_ENV: 'production', APP_ORIGIN: DEV_ORIGIN,
    INTERNAL_BETA_ENTITLEMENTS_ENABLED: '',
  };
  const args = (...extra) => ['--existing-tenant', slug, '--issue-pins-for', 'STAFF,ADMIN', '--operator', 'integration-test', ...extra];
  const database = new TenantDatabase(app);
  const gate = async (tenantId, feature) => {
    try {
      await database.withTenant(tenantId, (tx) => assertFeatureEntitled(tx, tenantId, feature, false));
      return true;
    } catch (error) {
      if (error.status === 403 || error.statusCode === 403 || /not_entitled/.test(String(error.code ?? error.message))) return false;
      throw error;
    }
  };
  const reported = async (tenantRef, patchEnv = {}) => {
    const { chunks, io } = capture();
    assert.equal(await main(['--existing-tenant', tenantRef, '--issue-pins-for', 'STAFF', '--operator', 'integration-test'], { ...env, ...patchEnv }, io), 0, chunks.err);
    return JSON.parse(chunks.out.slice(0, chunks.out.lastIndexOf('}') + 1));
  };
  const user = (tenant, fields) => owner.user.create({
    data: { tenantId: tenant.id, mfaEnabled: false, mfaBackupCodes: [], ...fields },
  });

  try {
    const tenant = await owner.tenant.create({
      data: { name: `Substance ${run}`, slug, planTier: 'ENTERPRISE', status: 'ACTIVE', usageCredits: 5 },
    });
    const someHash = 'abcd:' + 'f'.repeat(128);
    const staff1 = await user(tenant, { name: 'Sam Staff', username: 'sam.staff', role: 'STAFF' });
    const staff2 = await user(tenant, { name: 'Sue Staff', username: 'sue.staff', role: 'STAFF', email: `sue-${run}@example.test` });
    const admin1 = await user(tenant, { name: 'Ada Admin', username: 'ada.admin', role: 'ADMIN', email: `ada-${run}@example.test` });
    const manager = await user(tenant, { name: 'Max Manager', username: 'max.manager', role: 'MANAGER' });
    const withPassword = await user(tenant, { name: 'Pat Password', username: 'pat.password', role: 'STAFF', passwordHash: someHash });
    const withPin = await user(tenant, { name: 'Pip Pin', username: 'pip.pin', role: 'STAFF', pinHash: someHash, pinSetAt: new Date() });
    const noUsername = await user(tenant, { name: 'Nora Nousername', role: 'STAFF' });
    const suspended = await user(tenant, { name: 'Sid Suspended', username: 'sid.suspended', role: 'STAFF', suspendedAt: new Date() });
    const deleted = await user(tenant, { name: 'Dee Deleted', username: 'dee.deleted', role: 'STAFF', deletedAt: new Date() });
    const snapshot = async () => ({
      users: await owner.user.count({ where: { tenantId: tenant.id } }),
      locations: await owner.location.count({ where: { tenantId: tenant.id } }),
      settings: await owner.tenantSetting.count({ where: { tenantId: tenant.id } }),
      credits: await owner.creditTransaction.count({ where: { tenantId: tenant.id } }),
      roleAssignments: await owner.roleAssignment.count({ where: { tenantId: tenant.id } }),
      tenantRow: JSON.stringify(await owner.tenant.findUnique({ where: { id: tenant.id } })),
    });
    const pinState = async (id) => owner.user.findUniqueOrThrow({ where: { id }, select: { pinHash: true, passwordHash: true, pinResetRequired: true } });
    const before = await snapshot();

    // ---------------------------------------------------------------- guards
    for (const [label, argv, patch, pattern] of [
      ['production target', args('--apply', '--pin-out', pinOut), { DATA_TARGET_ENV: 'production' }, /DATA_TARGET_ENV/],
      ['production origin', args('--apply', '--pin-out', pinOut), { APP_ORIGIN: 'https://lunchlineup.com' }, /APP_ORIGIN/],
      ['unknown tenant', ['--existing-tenant', `no-such-${run}`, '--issue-pins-for', 'STAFF'], {}, /No existing tenant matches/],
      ['creation options', [...args(), '--org-slug', 'brand-new'], {}, /never creates anything/],
      ['bad role', ['--existing-tenant', slug, '--issue-pins-for', 'OWNER'], {}, /accepts only/],
    ]) {
      const { chunks, io } = capture();
      assert.equal(await main(argv, { ...env, ...patch }, io), 2, label);
      assert.match(chunks.err, pattern, label);
    }
    assert.deepEqual(await snapshot(), before, 'refusals change nothing');

    // ------------------------------------------- entitlement: report vs real gate
    process.env.APP_ORIGIN = DEV_ORIGIN;
    process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = 'true';
    // ENTERPRISE ACTIVE without Stripe ids: the gate refuses and the report says so (and why).
    let report = await reported(slug);
    for (const feature of ['scheduling', 'lunch_breaks']) {
      assert.equal(await gate(tenant.id, feature), false, `gate refuses ${feature} for ACTIVE without a subscription`);
      assert.equal(report.entitlement[feature].entitled, false, `report agrees for ${feature}`);
      assert.match(report.entitlement[feature].reason, /no Stripe subscription/);
    }
    assert.equal(report.entitlement.basis, 'none');
    assert.equal(report.tenant.planTier, 'ENTERPRISE');
    assert.equal(report.tenant.status, 'ACTIVE');
    assert.equal(report.tenant.stripeSubscriptionPresent, false);

    // ENTERPRISE ACTIVE with a paid-through subscription: both entitled, matching the gate.
    await owner.tenant.update({ where: { id: tenant.id }, data: { stripeSubscriptionId: `sub_${run}`, stripeSubscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    report = await reported(slug);
    for (const feature of ['scheduling', 'lunch_breaks']) {
      assert.equal(await gate(tenant.id, feature), true, `gate allows ${feature} with a subscription`);
      assert.equal(report.entitlement[feature].entitled, true, `report agrees for ${feature}`);
    }
    assert.equal(report.entitlement.basis, 'stripe_subscription');
    // An expired period end is refused by both.
    await owner.tenant.update({ where: { id: tenant.id }, data: { stripeSubscriptionCurrentPeriodEnd: new Date(Date.now() - 86_400_000) } });
    report = await reported(slug);
    assert.equal(await gate(tenant.id, 'scheduling'), false);
    assert.equal(report.entitlement.scheduling.entitled, false);
    // A feature_access override that disables lunch breaks is honoured by both.
    await owner.tenant.update({ where: { id: tenant.id }, data: { stripeSubscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    await owner.tenantSetting.create({ data: { tenantId: tenant.id, key: 'feature_access', value: { features: { lunch_breaks: { source: 'disabled', enabled: false, reason: 'test' } } } } });
    report = await reported(slug);
    assert.equal(await gate(tenant.id, 'lunch_breaks'), false);
    assert.equal(report.entitlement.lunch_breaks.entitled, false);
    assert.equal(await gate(tenant.id, 'scheduling'), true);
    assert.equal(report.entitlement.scheduling.entitled, true);
    // Back to the real Substance shape for the PIN runs.
    await owner.tenantSetting.deleteMany({ where: { tenantId: tenant.id, key: 'feature_access' } });
    await owner.tenant.update({ where: { id: tenant.id }, data: { stripeSubscriptionId: null, stripeSubscriptionCurrentPeriodEnd: null } });
    const settingsBefore = await snapshot();

    // The TRIAL + internal-beta-grant path (what the creation mode provisions) agrees too.
    const created = capture();
    const beta = { ...process.env, DATA_TARGET_ENV: 'staging', NODE_ENV: 'production', APP_ORIGIN: DEV_ORIGIN, INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true' };
    assert.equal(await main(['--org-name', `Trial ${run}`, '--org-slug', trialSlug, '--manager-email', `t-${run}@example.test`, '--operator', 'integration-test', '--apply'], beta, created.io), 0, created.chunks.err);
    const trial = await owner.tenant.findUniqueOrThrow({ where: { slug: trialSlug } });
    const trialReport = await reported(trialSlug, { INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true' });
    assert.equal(trialReport.entitlement.basis, 'internal_beta');
    for (const feature of ['scheduling', 'lunch_breaks']) {
      assert.equal(await gate(trial.id, feature), true);
      assert.equal(trialReport.entitlement[feature].entitled, true);
    }
    const flagOff = await reported(trialSlug, { INTERNAL_BETA_ENTITLEMENTS_ENABLED: '' });
    process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = '';
    assert.equal(await gate(trial.id, 'scheduling'), false, 'gate needs the runtime flag');
    assert.equal(flagOff.entitlement.scheduling.entitled, false, 'report agrees without the flag');
    process.env.INTERNAL_BETA_ENTITLEMENTS_ENABLED = 'true';

    // --------------------------------------------------------------- dry run
    const dry = capture();
    assert.equal(await main(args(), env, dry.io), 0, dry.chunks.err);
    assert.match(dry.chunks.out, /DRY_RUN/);
    const dryReport = JSON.parse(dry.chunks.out.slice(0, dry.chunks.out.lastIndexOf('}') + 1));
    assert.deepEqual(dryReport.pinIssue.issue.map((i) => i.username), ['ada.admin', 'sam.staff', 'sue.staff']);
    assert.equal(dryReport.pinIssue.skippedHasCredentials, 2);
    assert.equal(dryReport.pinIssue.skippedSuspended, 1);
    assert.deepEqual(dryReport.pinIssue.withoutUsableUsername, [{ name: 'Nora Nousername', role: 'STAFF', reason: 'no username' }]);
    assert.equal(dryReport.temporaryPinsGenerated, 3);
    assert.equal(dryReport.pinFile, null);
    assert.deepEqual(await snapshot(), settingsBefore, 'dry run rolls back, including PIN updates and the audit row');
    assert.equal(fs.existsSync(pinOut), false);

    // --apply without a --pin-out aborts the whole transaction.
    const noOut = capture();
    assert.equal(await main(args('--apply'), env, noOut.io), 2);
    assert.match(noOut.chunks.err, /--pin-out is required/);
    assert.equal((await pinState(staff1.id)).pinHash, null);

    // ----------------------------------------------------------------- apply
    const applied = capture();
    assert.equal(await main(args('--apply', '--pin-out', pinOut), env, applied.io), 0, applied.chunks.err);
    assert.match(applied.chunks.out, /APPLIED/);
    const after = await snapshot();
    assert.deepEqual({ ...after, tenantRow: undefined }, { ...settingsBefore, tenantRow: undefined }, 'no tenant, entitlement, location, user, setting or ledger row is created');
    assert.equal(after.tenantRow, settingsBefore.tenantRow, 'the tenant row is untouched');
    assert.equal(await owner.auditLog.count({ where: { tenantId: tenant.id, action: 'PILOT_PINS_ISSUED' } }), 1);

    if (process.platform !== 'win32') assert.equal(fs.statSync(pinOut).mode & 0o777, 0o600);
    const lines = fs.readFileSync(pinOut, 'utf8').trim().split('\n');
    assert.equal(lines[0], 'tenant_slug,username,name,temporary_pin,pin_reset_required');
    const rows = lines.slice(1).map((line) => line.split(','));
    assert.deepEqual(rows.map((r) => r[1]).sort(), ['ada.admin', 'sam.staff', 'sue.staff']);
    for (const [rowSlug, username, , pin, reset] of rows) {
      assert.equal(rowSlug, slug);
      assert.match(pin, /^\d{6}$/);
      assert.equal(reset, 'true');
      const row = await owner.user.findFirstOrThrow({ where: { tenantId: tenant.id, username } });
      assert.ok(verifiesPin(pin, row.pinHash), `${username} PIN matches the stored scrypt hash`);
      assert.equal(row.pinResetRequired, true);
      assert.equal(row.passwordHash, null);
      assert.ok(row.pinSetAt);
      assert.ok(!applied.chunks.out.includes(pin) && !applied.chunks.err.includes(pin), 'PIN never printed');
    }
    // Everyone else is untouched.
    assert.equal((await pinState(manager.id)).pinHash, null, 'MANAGER is outside --issue-pins-for');
    assert.equal((await pinState(withPassword.id)).pinHash, null, 'a password user is not given a PIN by default');
    assert.equal((await pinState(withPassword.id)).passwordHash, someHash);
    assert.equal((await pinState(withPin.id)).pinHash, someHash, 'an existing PIN is not replaced by default');
    assert.equal((await pinState(noUsername.id)).pinHash, null);
    assert.equal((await pinState(suspended.id)).pinHash, null);
    assert.equal((await pinState(deleted.id)).pinHash, null);

    // ----------------------------------------------------------------- rerun
    const pinOut2 = path.join(dir, 'pins-2.csv');
    const rerun = capture();
    assert.equal(await main(args('--apply', '--pin-out', pinOut2), env, rerun.io), 0, rerun.chunks.err);
    const rerunReport = JSON.parse(rerun.chunks.out.slice(0, rerun.chunks.out.lastIndexOf('}') + 1));
    assert.equal(rerunReport.temporaryPinsGenerated, 0);
    assert.equal(rerunReport.pinIssue.skippedHasCredentials, 5, 'issued users now have a pinHash and are skipped');
    assert.equal(fs.existsSync(pinOut2), false, 'nothing to issue means no PIN file');
    assert.equal(await owner.auditLog.count({ where: { tenantId: tenant.id, action: 'PILOT_PINS_ISSUED' } }), 1);

    // --------------------------------------------- an existing PIN file blocks atomically
    const hashBefore = (await pinState(staff2.id)).pinHash;
    const blocked = capture();
    assert.equal(await main(args('--all', '--apply', '--pin-out', pinOut), env, blocked.io), 2);
    assert.match(blocked.chunks.err, /PIN file/);
    assert.equal((await pinState(staff2.id)).pinHash, hashBefore, 'PINs are not replaced when the PIN file cannot be written');
    assert.equal((await pinState(withPassword.id)).pinHash, null);

    // ----------------------------------------------------------------- --all
    const pinOut3 = path.join(dir, 'pins-3.csv');
    const all = capture();
    assert.equal(await main(args('--all', '--apply', '--pin-out', pinOut3), env, all.io), 0, all.chunks.err);
    const allRows = fs.readFileSync(pinOut3, 'utf8').trim().split('\n').slice(1).map((l) => l.split(',')[1]).sort();
    assert.deepEqual(allRows, ['ada.admin', 'pat.password', 'pip.pin', 'sam.staff', 'sue.staff']);
    assert.notEqual((await pinState(staff2.id)).pinHash, hashBefore, '--all replaces existing PINs');
    assert.equal((await pinState(withPassword.id)).passwordHash, someHash, '--all never removes a password');
    assert.ok((await pinState(withPassword.id)).pinHash);
    assert.equal((await pinState(manager.id)).pinHash, null);
    assert.equal((await pinState(suspended.id)).pinHash, null);
    assert.equal((await pinState(noUsername.id)).pinHash, null);
    assert.equal((await pinState(admin1.id)).pinResetRequired, true);
  } finally {
    await purgeTenant(owner, slug);
    await purgeTenant(owner, trialSlug);
    fs.rmSync(dir, { recursive: true, force: true });
    await app.$disconnect();
    await owner.$disconnect();
  }
});

test('existing-tenant --grant-internal-beta converts an ACTIVE tenant without Stripe ids to the TRIAL + grant path the real gate accepts', async () => {
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  assert.ok(['test', 'disposable'].includes(process.env.DATA_TARGET_ENV), 'DATA_TARGET_ENV must be test or disposable');
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const run = randomUUID().slice(0, 8);
  const slugs = { main: `grant-main-${run}`, stripe: `grant-stripe-${run}`, sub: `grant-sub-${run}`, solo: `grant-solo-${run}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-grant-'));
  const env = {
    ...process.env, DATA_TARGET_ENV: 'staging', NODE_ENV: 'production', APP_ORIGIN: DEV_ORIGIN,
    INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true',
  };
  const database = new TenantDatabase(app);
  const gate = async (tenantId, feature) => {
    try {
      await database.withTenant(tenantId, (tx) => assertFeatureEntitled(tx, tenantId, feature, true));
      return true;
    } catch (error) {
      if (error.status === 403 || error.statusCode === 403 || /not_entitled/.test(String(error.code ?? error.message))) return false;
      throw error;
    }
  };
  const parse = (out) => JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
  const go = async (argv, patchEnv = {}) => {
    const { chunks, io } = capture();
    const code = await main(argv, { ...env, ...patchEnv }, io);
    return { code, out: chunks.out, err: chunks.err };
  };
  const mk = (slug, extra = {}) => owner.tenant.create({
    data: { name: `Grant ${slug}`, slug, planTier: 'ENTERPRISE', status: 'ACTIVE', usageCredits: 5, ...extra },
  });
  const rows = async (tenantId) => ({
    settings: await owner.tenantSetting.count({ where: { tenantId, key: 'internal_beta_entitlement' } }),
    credits: await owner.creditTransaction.count({ where: { tenantId } }),
    grantAudits: await owner.auditLog.count({ where: { tenantId, action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED' } }),
    conversions: await owner.auditLog.count({ where: { tenantId, action: 'PILOT_TENANT_CONVERTED_TO_TRIAL' } }),
    tenant: JSON.stringify(await owner.tenant.findUnique({ where: { id: tenantId } })),
  });
  const mkUser = (tenant, fields) => owner.user.create({ data: { tenantId: tenant.id, mfaEnabled: false, mfaBackupCodes: [], ...fields } });

  try {
    const main_ = await mk(slugs.main);
    const withCustomer = await mk(slugs.stripe, { stripeCustomerId: `cus_${run}` });
    const withSub = await mk(slugs.sub, { stripeSubscriptionId: `sub_${run}` });
    const solo = await mk(slugs.solo, { planTier: 'GROWTH' });
    await mkUser(main_, { name: 'Sam Staff', username: 'sam.staff', role: 'STAFF' });
    await mkUser(main_, { name: 'Ada Admin', username: 'ada.admin', role: 'ADMIN' });
    const pinOut = path.join(dir, 'pins.csv');
    const base = (slug, ...extra) => ['--existing-tenant', slug, '--grant-internal-beta', '--operator', 'integration-test', ...extra];
    Object.assign(process.env, { APP_ORIGIN: DEV_ORIGIN, INTERNAL_BETA_ENTITLEMENTS_ENABLED: 'true' });

    // Before: ACTIVE without Stripe ids is refused by the real gate.
    for (const feature of ['scheduling', 'lunch_breaks']) assert.equal(await gate(main_.id, feature), false);

    // ----------------------------------------------------------- refusals
    const before = await rows(main_.id);
    let r = await go(base(slugs.main, '--apply'), { INTERNAL_BETA_ENTITLEMENTS_ENABLED: '' });
    assert.equal(r.code, 2);
    assert.match(r.err, /INTERNAL_BETA_ENTITLEMENTS_ENABLED/);
    r = await go(base(slugs.main, '--apply', '--plan', 'STARTER'));
    assert.equal(r.code, 2);
    assert.match(r.err, /lunch_breaks/);
    r = await go(base(slugs.main, '--plan', 'FREE'));
    assert.equal(r.code, 2);
    r = await go(base(slugs.main, '--grant-days', '40', '--trial-days', '30'));
    assert.equal(r.code, 2);
    r = await go(['--existing-tenant', slugs.main, '--issue-pins-for', 'STAFF', '--trial-days', '10']);
    assert.equal(r.code, 2, 'grant options without --grant-internal-beta are refused');
    assert.match(r.err, /never creates anything/);
    for (const slug of [slugs.stripe, slugs.sub]) {
      const t = await owner.tenant.findUniqueOrThrow({ where: { slug } });
      const snapshot = await rows(t.id);
      r = await go(base(slug, '--apply'));
      assert.equal(r.code, 2, slug);
      assert.match(r.err, /Stripe customer or subscription id/);
      assert.deepEqual(await rows(t.id), snapshot, 'a tenant with Stripe ids is left untouched');
      assert.equal(await gate(t.id, 'scheduling'), false);
    }
    assert.deepEqual(await rows(main_.id), before, 'refusals change nothing');

    // ------------------------------------------------------------ dry run
    r = await go(base(slugs.main, '--issue-pins-for', 'STAFF,ADMIN'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /DRY_RUN/);
    let report = parse(r.out);
    assert.equal(report.conversion.action, 'convert');
    assert.equal(report.conversion.from.status, 'ACTIVE');
    assert.equal(report.grant.action, 'create');
    assert.equal(report.entitlement.basis, 'internal_beta');
    assert.equal(report.entitlement.scheduling.entitled, true);
    assert.equal(report.entitlement.lunch_breaks.entitled, true);
    assert.equal(report.temporaryPinsGenerated, 2);
    assert.deepEqual(await rows(main_.id), before, 'dry run rolls back the conversion, grant and PINs');
    for (const feature of ['scheduling', 'lunch_breaks']) assert.equal(await gate(main_.id, feature), false);

    // -------------------------------------------------------------- apply
    r = await go(base(slugs.main, '--issue-pins-for', 'STAFF,ADMIN', '--apply', '--pin-out', pinOut));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /APPLIED/);
    const converted = await owner.tenant.findUniqueOrThrow({ where: { id: main_.id } });
    assert.equal(converted.status, 'TRIAL');
    assert.equal(converted.planTier, 'ENTERPRISE', 'plan kept without --plan');
    assert.equal(converted.stripeSubscriptionId, null);
    assert.ok(converted.trialEndsAt > new Date(Date.now() + 29 * 86_400_000) && converted.trialEndsAt < new Date(Date.now() + 31 * 86_400_000));
    assert.equal(converted.usageCredits, 105);
    const after = await rows(main_.id);
    assert.equal(after.settings, 1);
    assert.equal(after.credits, before.credits + 1);
    assert.equal(after.grantAudits, 1);
    assert.equal(after.conversions, 1);
    const setting = await owner.tenantSetting.findUniqueOrThrow({ where: { tenantId_key: { tenantId: main_.id, key: 'internal_beta_entitlement' } } });
    assert.equal(setting.value.source, 'internal_beta');
    assert.deepEqual(setting.value.features, ['scheduling']);
    assert.ok(new Date(setting.value.expiresAt) <= converted.trialEndsAt);
    // The real gate now allows exactly the covered features.
    assert.equal(await gate(main_.id, 'scheduling'), true);
    assert.equal(await gate(main_.id, 'lunch_breaks'), true);
    assert.equal(await gate(main_.id, 'time_cards'), false);
    report = parse(r.out);
    assert.equal(report.entitlement.basis, 'internal_beta');
    assert.equal(report.entitlement.scheduling.entitled, true);
    assert.equal(report.entitlement.lunch_breaks.entitled, true);
    assert.equal(report.tenant.status, 'TRIAL');
    assert.equal(fs.readFileSync(pinOut, 'utf8').trim().split('\n').length, 3, 'PINs for both users issued in the same transaction');

    // -------------------------------------------------------------- rerun
    const pinOut2 = path.join(dir, 'pins-2.csv');
    r = await go(base(slugs.main, '--issue-pins-for', 'STAFF,ADMIN', '--apply', '--pin-out', pinOut2));
    assert.equal(r.code, 0, r.err);
    report = parse(r.out);
    assert.equal(report.grant.action, 'exists');
    assert.equal(report.conversion.action, 'none');
    assert.equal(report.temporaryPinsGenerated, 0);
    assert.deepEqual(await rows(main_.id), after, 'same label: nothing is written');
    assert.equal(fs.existsSync(pinOut2), false);
    assert.equal(await gate(main_.id, 'scheduling'), true);

    // A new label while a grant is active is reported and not applied.
    r = await go(base(slugs.main, '--grant-label', 'v2', '--apply'));
    assert.equal(r.code, 0, r.err);
    assert.match(parse(r.out).grant.note, /active grant from another label/);
    assert.deepEqual(await rows(main_.id), after);

    // ---------------------------------------- grant only, plan and sizes
    r = await go(base(slugs.solo, '--plan', 'ENTERPRISE', '--trial-days', '10', '--grant-credits', '50', '--apply'));
    assert.equal(r.code, 0, r.err);
    const soloAfter = await owner.tenant.findUniqueOrThrow({ where: { id: solo.id } });
    assert.equal(soloAfter.planTier, 'ENTERPRISE', '--plan changes the plan');
    assert.equal(soloAfter.status, 'TRIAL');
    assert.ok(soloAfter.trialEndsAt < new Date(Date.now() + 11 * 86_400_000));
    assert.equal(soloAfter.usageCredits, 55);
    assert.equal(parse(r.out).pinIssue.issue.length, 0);
    assert.equal(await gate(solo.id, 'lunch_breaks'), true);
  } finally {
    for (const slug of Object.values(slugs)) await purgeTenant(owner, slug);
    fs.rmSync(dir, { recursive: true, force: true });
    await app.$disconnect();
    await owner.$disconnect();
  }
});
