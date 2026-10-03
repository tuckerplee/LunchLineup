import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { provisionAppDatabaseRole } from '../../scripts/provision-app-db-role.mjs';

// Inert synthetic credentials are passed only to mocked child-process boundaries.
const env = {
  POSTGRES_USER: 'fixture_owner', POSTGRES_PASSWORD: 'synthetic-owner',
  APP_DB_USER: 'fixture_app', APP_DB_PASSWORD: 'synthetic-app',
  PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'synthetic-capability',
  MIGRATION_DATABASE_URL: 'postgresql://fixture_owner:synthetic-owner@127.0.0.1:5432/fixture',
  DATABASE_URL: 'postgresql://fixture_app:synthetic-app@127.0.0.1:5432/fixture',
};

function mockSpawn(t, statuses) {
  const calls = [];
  const mocked = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const call = { command, args, options, input: undefined };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = undefined; // No real child or process group can be signalled.
    child.stdin = new EventEmitter();
    child.stdin.end = (input) => { call.input = input; };
    const status = statuses[calls.length - 1];
    if (status !== undefined) queueMicrotask(() => child.emit('close', status, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

test('credential preflight timeout stops before any provisioning SQL child', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = mockSpawn(t, []);
  const rejection = assert.rejects(provisionAppDatabaseRole(env), (error) => {
    assert.equal(error.code, 'BOUNDED_PROCESS_TIMEOUT');
    assert.equal(error.childCloseObserved, false);
    assert.equal(error.processGroupSettlementVerified, false);
    assert.match(error.message, /application database credential preflight timed out/);
    return true;
  });
  t.mock.timers.tick(90_000);
  t.mock.timers.tick(2_000);
  t.mock.timers.tick(2_000);
  await rejection;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'SELECT 1;\n');
  assert.equal(calls[0].options.env.DATABASE_URL, env.DATABASE_URL);
});

for (const [status, expected] of [[1, 'false'], [0, 'true']]) {
  test(`ordinary credential preflight exit ${status} preserves provisioning verified=${expected}`, async (t) => {
    const calls = mockSpawn(t, [status, 0]);
    await provisionAppDatabaseRole(env);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].input, 'SELECT 1;\n');
    assert.match(calls[1].input, new RegExp(`set_config\\('app\\.provision\\.runtime_credential_verified', '${expected}', true\\)`));
    assert.equal(calls[1].options.env.DATABASE_URL, env.MIGRATION_DATABASE_URL);
  });
}
