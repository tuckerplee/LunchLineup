import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runFixedC08, validateC08Events, validateC08Selection } from '../../scripts/fixed-c08-container-cases.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fresh = () => JSON.parse(readFileSync(join(root, '.ci/development-c08-cases.json'), 'utf8'));
const success = (entry) => ({ type: 'test:pass', data: { name: entry.title, file: join(root, entry.file), details: {} } });

test('C08 selection requires exact three identities, budgets and finite image roster', () => {
  assert.equal(validateC08Selection(fresh()).cases.length, 3);
  for (const change of [
    (value) => value.cases.pop(),
    (value) => value.cases[0].title += ' changed',
    (value) => value.cases[1].file = value.cases[0].file,
    (value) => value.cases[0].outerTimeoutMs = 3600000,
    (value) => value.images.foreign = value.images.postgres,
    (value) => value.images.postgres = 'postgres:latest',
    (value) => value.retry = true,
  ]) {
    const value = fresh(); change(value);
    assert.throws(() => validateC08Selection(value));
  }
});

test('C08 refuses empty, skipped, todo, failed, duplicate, foreign or unexpected selected results', () => {
  const entry = fresh().cases[0];
  assert.equal(validateC08Events([success(entry)], entry).pass, 1);
  for (const events of [[], [success(entry), success(entry)],
    [{ ...success(entry), data: { ...success(entry).data, skip: 'Docker unavailable' } }],
    [{ ...success(entry), data: { ...success(entry).data, todo: true } }],
    [{ ...success(entry), data: { ...success(entry).data, file: join(root, 'foreign.test.mjs') } }],
    [{ ...success(entry), data: { ...success(entry).data, name: 'unexpected case' } }],
    [success(entry), { type: 'test:fail', data: { name: 'failed process' } }],
  ]) assert.throws(() => validateC08Events(events, entry));
  assert.equal(validateC08Events([{ type: 'test:pass', data: { name: 'excluded definition', skip: 'test name does not match pattern' } }, success(entry)], entry).pass, 1);
});

test('C08 rejects arbitrary selection arguments and missing authenticated source rather than generic fallback', async () => {
  await assert.rejects(runFixedC08(['--fixed-container-selection', '/tmp/arbitrary.json']));
  const previous = process.env.CI_RUN_ID;
  try {
    delete process.env.CI_RUN_ID;
    await assert.rejects(runFixedC08(['--fixed-container-selection', '.ci/development-c08-cases.json']), /authenticated source profile/);
  } finally {
    if (previous === undefined) delete process.env.CI_RUN_ID;
    else process.env.CI_RUN_ID = previous;
  }
});
