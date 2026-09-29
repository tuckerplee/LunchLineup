import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../../scripts/run-development-browser-qa.sh', import.meta.url), 'utf8');
const start = source.indexOf('cleanup(){\n');
const end = source.indexOf('\n}\ntrap cleanup EXIT', start);
assert.ok(start >= 0 && end > start, 'extract the actual cleanup function');
const cleanupFunction = source.slice(start, end + 2);
const project = 'lunchlineup-beta-cleanupfixture';

function fixture(options, verify) {
  const root = mkdtempSync(join(tmpdir(), 'lunchlineup-cleanup-test-'));
  const runtime = join(root, 'runtime');
  const bin = join(root, 'bin');
  const modules = join(root, 'python');
  const artifact = join(root, 'artifacts');
  for (const path of [runtime, bin, modules, artifact]) mkdirSync(path);
  try {
    writeFileSync(join(runtime, 'owner'), options.owner ?? 'cleanup-fixture');
    writeFileSync(join(runtime, 'state'), 'retain until absence proven');
    writeFileSync(join(artifact, 'fullstack-target.json'), '{}');
    writeFileSync(join(root, 'development-compose.json'), JSON.stringify({ services: { api: {}, worker: {}, migrate: {} } }));
    for (const resource of ['containers', 'volumes', 'networks']) writeFileSync(join(root, `${resource}.json`), options[resource] ?? '[]');
    // These stubs receive every Docker/Compose invocation. No daemon, SSH,
    // application, external socket or real listener is involved.
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FIXTURE_ROOT/commands"
case "$1" in
  compose)
    for argument in "$@"; do
      [[ "$argument" != logs ]] || exit 0
      [[ "$argument" != down ]] || exit "$FIXTURE_DOWN_STATUS"
    done
    exit 90;;
  ps) resource=containers;;
  volume) [[ "$2" == ls ]] || exit 91; resource=volumes;;
  network) [[ "$2" == ls ]] || exit 92; resource=networks;;
  *) exit 93;;
esac
[[ "$FIXTURE_READ_FAILURE" != "$resource" ]] || exit 7
cat "$FIXTURE_ROOT/$resource.json"
`, { mode: 0o700 });
    writeFileSync(join(bin, 'rm'), `#!/usr/bin/env bash
[[ "$FIXTURE_REMOVE_FAILURE" != 1 ]] || exit 13
exec /usr/bin/rm "$@"
`, { mode: 0o700 });
    writeFileSync(join(modules, 'socket.py'), `import errno, os
class socket:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def settimeout(self, timeout): pass
    def connect_ex(self, address):
        assert address[0] == '127.0.0.1' and address[1] in (4000, 8080, 18443)
        return 0 if str(address[1]) == os.environ.get('FIXTURE_OPEN_PORT') else errno.ECONNREFUSED
`);
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
artifact_root="$FIXTURE_ROOT/artifacts"
runtime_root="$FIXTURE_ROOT/runtime"
qualification_root="$FIXTURE_ROOT"
project='${project}'
CI_RUN_ID=cleanup-fixture
CI_COMMIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
compose=(docker compose --project-name "$project" --env-file fixture.env -f fixture-compose.json)
${cleanupFunction}
trap cleanup EXIT
exit "$FIXTURE_PRIMARY_STATUS"
`], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PYTHONPATH: modules,
        FIXTURE_ROOT: root, FIXTURE_DOWN_STATUS: String(options.downStatus ?? 0),
        FIXTURE_PRIMARY_STATUS: String(options.primaryStatus ?? 0),
        FIXTURE_READ_FAILURE: options.readFailure ?? '', FIXTURE_REMOVE_FAILURE: options.removeFailure ? '1' : '0',
        FIXTURE_OPEN_PORT: options.openPort ?? '' },
    });
    assert.ifError(result.error);
    const receipt = JSON.parse(readFileSync(join(artifact, 'development-cleanup-receipt.json'), 'utf8'));
    const commands = readFileSync(join(root, 'commands'), 'utf8');
    assert.match(commands, /compose --project-name lunchlineup-beta-cleanupfixture .* down -v --remove-orphans/);
    for (const command of ['ps -a --format json', 'volume ls --format json', 'network ls --format json']) assert.ok(commands.includes(command));
    assert.equal(receipt.runId, 'cleanup-fixture');
    assert.equal(receipt.sourceSha, 'a'.repeat(40));
    assert.equal(receipt.primaryExitCode, options.primaryStatus ?? 0);
    verify({ result, receipt, runtime, commands, artifact });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('exact absence and closed ports remove owned runtime, ignoring other projects', () => {
  fixture({ containers: JSON.stringify([{ Names: [`${project}shadow_api`], Labels: {} }]),
    volumes: JSON.stringify([{ Name: 'other_postgres_data', Labels: { 'com.docker.compose.project': 'other' } }]),
    networks: JSON.stringify([{ name: 'other_default', labels: {} }]) }, ({ result, receipt, runtime }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(runtime), false);
    assert.equal(receipt.cleanupVerified, true);
    assert.equal(receipt.runtimeDirectoryRemoved, true);
    assert.deepEqual(receipt.ownedResourceAbsence, { containers: true, volumes: true, networks: true });
    assert.deepEqual(receipt.loopbackPortsClosed, { 4000: true, 8080: true, 18443: true });
  });
});

test('failed Compose cleanup preserves runtime and original application failure', () => {
  fixture({ downStatus: 19, primaryStatus: 31 }, ({ result, receipt, runtime }) => {
    assert.equal(result.status, 31);
    assert.equal(existsSync(runtime), true);
    assert.equal(receipt.cleanupExitCode, 19);
    assert.equal(receipt.cleanupVerified, false);
    assert.equal(receipt.runtimePreservationRequired, true);
  });
});

for (const [resource, rows] of [
  ['containers', [{ Names: ['renamed-survivor'], Labels: { 'io.podman.compose.project': project } }]],
  ['networks', [{ name: `${project}_outbound-egress`, labels: {} }]],
  ['volumes', [{ Name: `${project}_postgres_data`, Labels: {} }]],
]) test(`owned ${resource} survivor fails otherwise-successful cleanup`, () => {
  fixture({ [resource]: JSON.stringify(rows) }, ({ result, receipt, runtime }) => {
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(runtime), true);
    assert.equal(receipt.ownedResourceAbsence[resource], false);
    assert.equal(receipt.cleanupVerified, false);
  });
});

for (const options of [{ readFailure: 'containers' }, { networks: '{}' }, { volumes: '[{"opaque":"unknown"}]' }]) {
  test(`inventory uncertainty fails closed: ${JSON.stringify(options)}`, () => {
    fixture(options, ({ result, receipt, runtime }) => {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(runtime), true);
      assert.equal(receipt.cleanupVerified, false);
      assert.ok(receipt.errors.length > 0);
    });
  });
}

test('an occupied loopback port blocks successful cleanup', () => {
  fixture({ openPort: '8080' }, ({ result, receipt, runtime }) => {
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(runtime), true);
    assert.equal(receipt.loopbackPortsClosed['8080'], false);
    assert.equal(receipt.cleanupVerified, false);
  });
});

for (const options of [{ removeFailure: true }, { owner: 'another-run' }]) {
  test(`final receipt rejects runtime uncertainty: ${JSON.stringify(options)}`, () => {
    fixture(options, ({ result, receipt, runtime }) => {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(runtime), true);
      assert.equal(receipt.resourceAbsenceVerified, true);
      assert.equal(receipt.cleanupVerified, false);
      assert.equal(receipt.runtimeDirectoryRemoved, false);
      assert.equal(receipt.runtimePreservationRequired, true);
      assert.ok(receipt.errors.includes(options.removeFailure ? 'runtime_removal_failed' : 'runtime_ownership_unverified'));
    });
  });
}

test('pre-down logs select only existing declared project services and exclude absent or completed migrate', () => {
  const labels = service => ({ 'com.docker.compose.project': project, 'com.docker.compose.service': service });
  fixture({ primaryStatus: 31, containers: JSON.stringify([{ Names: [`${project}_api_1`], Labels: labels('api') }, { Names: [`${project}_migrate_1`], Labels: labels('migrate') }, { Names: ['foreign_worker_1'], Labels: { ...labels('worker'), 'com.docker.compose.project': 'foreign' } }]) }, ({ result, commands, artifact }) => {
    assert.equal(result.status, 31);
    const log = commands.split('\n').find(command => command.includes(' logs '));
    assert.ok(log.endsWith('logs --tail 120 api'), log);
    assert.equal(readFileSync(join(artifact, 'development-final-log-services.txt'), 'utf8'), 'api\n');
    assert.ok(commands.indexOf(' logs ') < commands.indexOf(' down '));
  });
});
