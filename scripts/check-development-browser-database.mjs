import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateDatabaseObservation(mode, value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  if (mode === 'before') {
    assert.deepEqual(Object.keys(value).sort(), ['database','recovery','relations','role','system']);
    assert.equal(value.database, 'lunchlineup_ci');
    assert.equal(value.role, 'lunchlineup_ci_admin');
    assert.equal(value.recovery, false);
    assert.equal(value.relations, 0);
    assert.equal(typeof value.system, 'string');
    assert.match(value.system, /^[1-9][0-9]{0,19}$/);
  } else if (mode === 'role') {
    assert.deepEqual(value, { database:'lunchlineup_ci', role:'lunchlineup_ci_app',
      superuser:false, bypassrls:false, createrole:false, createdb:false, replication:false });
  } else throw new Error('Only fixed before/role observations are accepted.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4);
  const bytes = readFileSync(process.argv[3]);
  assert.ok(bytes.length > 0 && bytes.length <= 4096);
  validateDatabaseObservation(process.argv[2], JSON.parse(bytes));
}
