/**
 * Real-PostgreSQL proof for scripts/pilot/provision-pilot-tenant.mjs: dry-run
 * persists nothing, --apply creates the pilot tenant (paid plan, TRIAL), the
 * internal-beta grant that the real api-v2 entitlement gate accepts for
 * scheduling and lunch_breaks (and not for time_cards), locations, owner and
 * employees with temporary PINs that reach only a 0600 file; reruns are no-ops;
 * production-like targets are refused before any database client loads.
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
