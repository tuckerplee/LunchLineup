import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationName = '20260716_location_timezone_drop_default.sql';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('Location timezone has no silent Prisma default', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const locationModel = schema.match(/model Location \{([\s\S]*?)\n\}/)?.[1];

  assert.ok(locationModel, 'Location model must exist');
  assert.match(locationModel, /^\s*timezone\s+String\s*$/m);
  assert.doesNotMatch(locationModel, /timezone\s+String[^\n]*@default/);
});

test('location timezone forward migration is replay-safe and never rewrites rows', () => {
  const migration = read(`packages/db/prisma/migrations/${migrationName}`);

  assert.match(migration, /ALTER TABLE IF EXISTS "Location"\s+ALTER COLUMN "timezone" DROP DEFAULT;/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(migration, /ALTER COLUMN "timezone"\s+(?:SET|TYPE)/i);
});

test('location timezone migration is listed in both migration inventories', () => {
  assert.match(read('packages/db/prisma/migrations/README.md'), new RegExp(migrationName.replace('.', '\\.')));
  assert.match(read('tests/migration/README.md'), /location-timezone-default\.test\.mjs/);
});
