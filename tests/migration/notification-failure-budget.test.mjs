import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRawMigrationInventory } from '../../scripts/raw-migration-inventory.mjs';
import { runMigrationSequence } from '../../scripts/apply-db-migrations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const prePath = 'packages/db/prisma/migrations/pre_20261004_notification_outbox_failure_budget.sql';
const postPath = 'packages/db/prisma/migrations/20261004_notification_outbox_failure_budget.sql';
const read = path => readFileSync(join(root, path), 'utf8');
const strip = sql => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

// Closed static transition interpreter for the admitted SQL subset, never SQL
// execution/Postgres semantics. It derives the selected rows/arithmetic/default
// from actual source and rejects other DML/DDL rather than fabricating success.
function preTransition(source, database) {
  const sql = strip(source);
  assert.match(sql, /^DO \$\$ BEGIN IF to_regclass\('public\."NotificationOutbox"'\) IS NULL THEN RETURN; END IF;/);
  if (!database.table) return;
  const add = sql.match(/ADD COLUMN IF NOT EXISTS "failureCount" INTEGER;/);
  assert.ok(add, 'upgrade column must stage nullable without a premature default');
  const update = sql.match(/UPDATE public\."NotificationOutbox" SET "failureCount" = CASE WHEN "status"::text = '([A-Z_]+)' THEN GREATEST\("attempts" - (\d+), (\d+)\) ELSE "attempts" END WHERE "failureCount" IS NULL;/);
  assert.ok(update, 'backfill must select only unknown counters with reviewed unfinished-claim arithmetic');
  const [, unfinished, subtract, floor] = update;
  assert.equal(unfinished, 'PROCESSING'); assert.equal(Number(subtract), 1); assert.equal(Number(floor), 0);
  const remainder = sql.replace(add[0], '').replace(update[0], '');
  assert.doesNotMatch(remainder, /\b(?:UPDATE|DELETE|INSERT|TRUNCATE|DROP)\b/);
  assert.match(sql, /ALTER COLUMN "failureCount" SET DEFAULT 0, ALTER COLUMN "failureCount" SET NOT NULL;/);
  for (const row of database.rows) {
    if (!Object.hasOwn(row, 'failureCount')) row.failureCount = null;
    if (row.failureCount === null) row.failureCount = row.status === unfinished
      ? Math.max(row.attempts - Number(subtract), Number(floor)) : row.attempts;
  }
  database.defaultFailureCount = 0; database.required = true;
}
function schemaSync(database) {
  if (!database.table) { database.table = true; database.rows = []; }
  database.defaultFailureCount = 0; database.required = true;
  // Existing values survive schema sync; this controlled adapter is not Prisma.
}
function postTransition(source, database) {
  const sql = strip(source);
  assert.ok(database.table && database.required, 'schema sync must precede the forward check');
  assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|TRUNCATE)\b|ADD COLUMN|ALTER COLUMN/);
  assert.equal(sql, 'ALTER TABLE public."NotificationOutbox" DROP CONSTRAINT IF EXISTS "NotificationOutbox_failure_count_check"; ALTER TABLE public."NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_failure_count_check" CHECK ("failureCount" >= 0 AND "failureCount" <= "attempts");');
  for (const row of database.rows) assert.ok(Number.isInteger(row.failureCount) && row.failureCount >= 0 && row.failureCount <= row.attempts, 'bounded invariant validates all existing values');
  database.boundedCheck = true;
}
async function sequence(database, events = []) {
  await runMigrationSequence({
    verifyWebhookEndpointSecrets: async () => events.push('verify'),
    applyPreMigrations: async () => { events.push('pre'); preTransition(read(prePath), database); },
    pushSchema: async () => { events.push('sync'); schemaSync(database); },
    applyRawMigrations: async () => { events.push('post'); postTransition(read(postPath), database); },
    provisionAppRole: async () => events.push('role'),
    bootstrapProductionAdmin: async () => events.push('bootstrap'),
    rotateWebhookEndpointSecrets: async () => events.push('rotate'),
  });
}

test('actual raw inventory selects notification budget pre before schema sync and forward after sync', async () => {
  const inventory = buildRawMigrationInventory(root, join(root, 'packages/db/prisma/migrations'));
  assert.equal(inventory.pre.filter(entry => entry.relativePath === prePath).length, 1);
  assert.equal(inventory.post.filter(entry => entry.relativePath === postPath).length, 1);
  assert.equal(inventory.post.some(entry => entry.relativePath === prePath), false);
  assert.equal(inventory.pre.some(entry => entry.relativePath === postPath), false);
  const events = []; await sequence({ table: false }, events);
  assert.deepEqual(events, ['verify', 'pre', 'sync', 'post', 'role', 'bootstrap', 'rotate']);
});

test('fresh missing outbox pre no-ops then actual sequence creates default zero and bounded check', async () => {
  const database = { table: false, retained: { tenant: 'unchanged', secret: 'synthetic' } };
  const before = structuredClone(database); preTransition(read(prePath), database);
  assert.deepEqual(database, before);
  await sequence(database);
  assert.deepEqual(database.rows, []); assert.equal(database.defaultFailureCount, 0);
  assert.equal(database.required, true); assert.equal(database.boundedCheck, true);
  assert.deepEqual(database.retained, before.retained);
});

test('existing unknown budgets exclude only unfinished claim and preserve terminal privacy and generation', async () => {
  const database = { table: true, rows: [
    { status: 'PENDING', attempts: 0, failureCount: null },
    { status: 'FAILED', attempts: 3, failureCount: null },
    { status: 'PROCESSING', attempts: 3, failureCount: null },
    { status: 'PROCESSING', attempts: 0, failureCount: null },
    { status: 'DELIVERED', attempts: 4, failureCount: null, title: '', body: '', lastError: null },
    { status: 'DEAD_LETTERED', attempts: 8, failureCount: null, title: '', body: '', lastError: null },
    { status: 'FAILED', attempts: 12, failureCount: 1 },
  ] };
  const original = structuredClone(database.rows); await sequence(database);
  assert.deepEqual(database.rows.map(row => row.failureCount), [0, 3, 2, 0, 4, 8, 1]);
  for (let i = 0; i < original.length; i++) {
    const { failureCount: _before, ...before } = original[i];
    const { failureCount: _after, ...after } = database.rows[i]; assert.deepEqual(after, before);
  }
});

test('replayed pre and forward preserve a current nonnull edited retry budget without resetting rows', async () => {
  const database = { table: true, rows: [{ status: 'FAILED', attempts: 20, failureCount: 2, title: 'Edited feed', lastError: 'safe category' }] };
  await sequence(database); database.rows[0].failureCount = 3;
  const before = structuredClone(database); await sequence(database); assert.deepEqual(database, before);
});

test('source contract refuses blanket backfill or schema-created duplicate column rather than overwriting ledger budget', () => {
  const database = { table: true, rows: [{ status: 'FAILED', attempts: 5, failureCount: 1 }] };
  assert.throws(() => preTransition(read(prePath).replace('WHERE "failureCount" IS NULL;', ';'), structuredClone(database)), /backfill must select only unknown/);
  assert.throws(() => preTransition(read(prePath).replace('"attempts" - 1', '"attempts" - 0'), structuredClone(database)));
  const synced = structuredClone(database); schemaSync(synced);
  assert.throws(() => postTransition('ALTER TABLE public."NotificationOutbox" ADD COLUMN "failureCount" INTEGER;', synced));
});

test('forward bounded check rejects impossible budgets without counter repair or domain effects', () => {
  for (const failureCount of [-1, 4]) {
    const database = { table: true, required: true, rows: [{ status: 'FAILED', attempts: 3, failureCount }] };
    const before = structuredClone(database); assert.throws(() => postTransition(read(postPath), database), /bounded invariant/);
    assert.deepEqual(database, before);
  }
});
