import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const policy = readFileSync(join(root, 'scripts/restore-managed-permissions.sql'), 'utf8');
const normalize = (value) => {
  let signature = value.trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')');
  if (!signature.split('(')[0].includes('.')) signature = `public.${signature}`;
  return signature;
};

test('recovery permission catalog covers every migration-defined PUBLIC function restriction', () => {
  const expected = new Set();
  const migrations = join(root, 'packages/db/prisma/migrations');
  for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(join(migrations, name), 'utf8');
    for (const match of sql.matchAll(/REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+([\w.]+\([^;]*?\))\s+FROM\s+PUBLIC/gi)) {
      expected.add(normalize(match[1]));
    }
    for (const match of sql.matchAll(/REVOKE\s+ALL\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+(\w+)\s+FROM\s+PUBLIC/gi)) {
      assert.ok(policy.includes(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${match[1]} FROM PUBLIC;`), `missing schema restriction: ${match[1]}`);
    }
  }
  const actual = new Set([...policy.matchAll(/^    '([^']+)'/gm)].map((match) => normalize(match[1])));
  assert.ok(expected.size > 0, 'migration restriction discovery must not be empty');
  assert.deepEqual([...actual].sort(), [...expected].sort());
});
