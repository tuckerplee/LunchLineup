import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const sha = (name) => createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex');
const driver = read('apps/worker/tests/native/_billing_B7_owned_driver.py');
const target = read('apps/worker/tests/native/_billing_native_target.py');
const session = read('apps/worker/tests/native/_billing_B7_worker_session.py');
const constant = (body, name) => {
  const match = body.match(new RegExp(`^${name} = "([a-f0-9]{64})"$`, 'm'));
  assert.ok(match, `${name} must remain an explicit immutable pin`);
  return match[1];
};

test('all declared native runtime and base source pins match this coherent checkout', () => {
  for (const name of ['RUNTIME_PINS', 'BASE_PINS']) {
    const match = driver.match(new RegExp(`^${name} = (\\{[\\s\\S]*?^\\})`, 'm'));
    assert.ok(match, `${name} must remain an explicit map`);
    // Parse data only, never execute/import a native fixture or Python module.
    const pins = JSON.parse(match[1].replace(/,\s*}/g, '}'));
    assert.ok(Object.keys(pins).length > 0);
    for (const [path, expected] of Object.entries(pins)) assert.equal(sha(path), expected, path);
  }
});

test('target schema/worker and session helper pins remain transitively coherent', () => {
  assert.equal(constant(target, 'SCHEMA_SHA256'), sha('packages/db/prisma/schema.prisma'));
  assert.equal(constant(target, 'WORKER_SHA256'), sha('apps/worker/src/billing_usage.py'));
  assert.equal(constant(session, 'TARGET_HELPER_SHA256'), sha('apps/worker/tests/native/_billing_native_target.py'));
});
