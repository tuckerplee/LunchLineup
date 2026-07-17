import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedDependencyEnvironment } from '../../scripts/old-release-compatibility-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harness = join(root, 'scripts', 'old-release-compatibility-harness.mjs');
const verifier = join(root, 'scripts', 'verify-old-release-compatibility.mjs');
const oldSha = 'a'.repeat(40);
const candidateSha = 'b'.repeat(40);
const runId = '123456';
const runAttempt = '2';
const cloneId = `llc-${runId}-${runAttempt}-0123456789ab`;
const cloneNetwork = `${cloneId}-network`;
const cloneDatabase = cloneId.replaceAll('-', '_');
const providerImage = `registry.example.test/lunchlineup/compatibility-provider@sha256:${'c'.repeat(64)}`;
const fixedSmokeScript = 'node --test --test-concurrency=1 tests/integration/*.test.mjs';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageLock(name) {
  return `${JSON.stringify({
    name,
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version: '1.0.0' } },
  })}\n`;
}

function writeMode(path, contents, mode = 0o644) {
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function createClone(parent, name, sourceSha, files) {
  const clone = join(parent, name);
  const releaseDir = join(clone, '.release');
  mkdirSync(releaseDir, { recursive: true });
  const contractFiles = {};
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = join(clone, ...relativePath.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeMode(file, contents, relativePath.endsWith('.mjs') ? 0o755 : 0o644);
    contractFiles[relativePath] = digest(contents);
  }
  const manifest = join(releaseDir, 'release-manifest.json');
  writeMode(manifest, `${JSON.stringify({
    sourceSha,
    deploymentContract: {
      algorithm: 'sha256',
      bundle: { format: 'lunchlineup-deployment-contract-json-v1', sha256: digest(`bundle:${sourceSha}`), bytes: 1 },
      files: contractFiles,
      rawMigrations: { version: 1, files: {} },
    },
  })}\n`);
  return { clone, manifest, contractFiles };
}

function cloneEnvironment(overrides = {}) {
  const values = {
    APP_DB_PASSWORD: 'clone-app-password',
    APP_DB_USER: 'llc_app',
    DATABASE_URL: `postgresql://llc_app:clone-app-password@127.0.0.1:5432/${cloneDatabase}`,
    DATA_TARGET_ENV: 'disposable',
    ENGINE_GRPC_URL: '127.0.0.1:50051',
    MIGRATION_DATABASE_URL: `postgresql://llc_owner:clone-owner-password@127.0.0.1:5432/${cloneDatabase}`,
    PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'clone-platform-capability',
    POSTGRES_PASSWORD: 'clone-owner-password',
    POSTGRES_USER: 'llc_owner',
    RABBITMQ_URL: 'amqp://llc_queue:clone-rabbit-password@127.0.0.1:5672/%2f',
    REDIS_URL: 'redis://127.0.0.1:6379',
    WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: '1'.repeat(64),
    ...overrides,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function fakeRuntimeProgram(operation) {
  const common = `
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.env.FAKE_PROVIDER_MODE ?? 'success';
appendFileSync(process.env.FAKE_PROVIDER_LOG, ${JSON.stringify(operation)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
`;
  if (operation === 'network') return `${common}
process.stdout.write(JSON.stringify({
  Name: process.env.FAKE_CLONE_NETWORK,
  Internal: true,
  Labels: { 'com.lunchlineup.compatibility.clone-id': process.env.FAKE_CLONE_ID },
}));
`;
  if (operation === 'run') return `${common}
if (mode === 'timeout') {
  setTimeout(() => process.stdout.write('{}'), 10000);
} else {
  if (mode === 'mutate-production') appendFileSync(process.env.FAKE_PRODUCTION_PATH, '# mutation\\n');
  if (mode === 'arbitrary-text') {
    process.stdout.write('candidate-fixed-schema-applied\\n');
  } else {
    const result = JSON.parse(readFileSync(process.env.FAKE_PROVIDER_RESULT, 'utf8'));
    if (mode === 'unverified-schema') result.schemaVerification.status = 'candidate-said-it-worked';
    if (mode === 'detached-schema') result.candidateSchemaExecution.executableSha256 = 'd'.repeat(64);
    if (mode === 'detached-catalog') result.outputs.schemaCatalog = Buffer.from('detached\\n').toString('base64');
    process.stdout.write(JSON.stringify(result));
  }
}
`;
  if (operation === 'container') return `${common}
process.exit(mode === 'surviving-container' ? 0 : 1);
`;
  if (operation === 'ps') return `${common}
if (mode === 'background-survivor') process.stdout.write('container-survivor-id\\n');
`;
  return `${common}process.exit(0);\n`;
}

function providerResult(fixture) {
  const schemaCatalog = Buffer.from('[{"kind":"table","identity":"public.fixture"}]\n');
  const migrationInputs = Object.entries(fixture.candidate.contractFiles)
    .filter(([path]) => path === 'packages/db/prisma/schema.prisma' || (path.startsWith('packages/db/prisma/migrations/') && path.endsWith('.sql')))
    .sort(([left], [right]) => left.localeCompare(right));
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const completedAt = new Date().toISOString();
  const requirementsSha256 = digest(Buffer.from(JSON.stringify([
    ['apps/engine/requirements.txt', fixture.old.contractFiles['apps/engine/requirements.txt']],
    ['apps/worker/requirements.txt', fixture.old.contractFiles['apps/worker/requirements.txt']],
  ])));
  return {
    version: 1,
    kind: 'lunchlineup-isolated-clone-provider-v1',
    executionPolicy: 'ci-owned-isolated-schema-fingerprint-v2',
    previousReleaseSha: oldSha,
    candidateReleaseSha: candidateSha,
    cloneId,
    dependencyPreparation: {
      isolation: 'provider-local-contract-copies-v1',
      environment: 'production-runtime-and-clone-command-absent-v1',
      network: 'clone-internal-offline-caches-only-v1',
      oldNpm: {
        command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'],
        packageLockSha256: fixture.old.contractFiles['package-lock.json'], exitCode: 0, startedAt, completedAt,
      },
      candidateNpm: {
        command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'],
        packageLockSha256: fixture.candidate.contractFiles['package-lock.json'], exitCode: 0, startedAt, completedAt,
      },
      oldPython: {
        command: ['python3', '-m', 'pip', 'install', '--no-index', '--target', '<provider-python-site>', '-r', 'apps/engine/requirements.txt', '-r', 'apps/worker/requirements.txt'],
        requirementsSha256, exitCode: 0, startedAt, completedAt,
      },
    },
    candidateSchemaExecution: {
      command: ['node', 'scripts/apply-db-migrations.mjs'],
      executableSha256: fixture.candidate.contractFiles['scripts/apply-db-migrations.mjs'],
      exitCode: 0,
      startedAt,
      completedAt,
    },
    schemaVerification: {
      status: 'exact-candidate-schema',
      command: ['prisma', 'migrate', 'diff', '--from-url', '<isolated-clone>', '--to-schema-datamodel', 'packages/db/prisma/schema.prisma', '--exit-code'],
      prismaDiffExitCode: 0,
      catalogCommand: ['psql', 'fixed-public-schema-catalog-v1'],
      catalogSha256: digest(schemaCatalog),
      catalogBytes: schemaCatalog.length,
      migrationInputSha256: digest(Buffer.from(JSON.stringify(migrationInputs))),
    },
    oldReleaseSmokeExecution: {
      command: ['npm', 'run', 'test:integration'],
      packageSha256: fixture.old.contractFiles['package.json'],
      packageScript: fixedSmokeScript,
      exitCode: 0,
      startedAt,
      completedAt,
    },
    outputs: {
      candidateSchema: Buffer.from('stdout:\ncandidate-fixed-schema-applied\nstderr:\n').toString('base64'),
      schemaCatalog: schemaCatalog.toString('base64'),
      oldReleaseSmoke: Buffer.from('stdout:\nold-release-fixed-smoke-passed\nstderr:\n').toString('base64'),
    },
    completedAt,
  };
}

function createFixture({ cloneEnvOverrides } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'll-old-release-compatibility-'));
  const old = createClone(scratch, 'old', oldSha, {
    'package.json': `${JSON.stringify({
      name: 'old-release-fixture',
      private: true,
      scripts: { 'test:integration': fixedSmokeScript },
    })}\n`,
    'package-lock.json': packageLock('old-release-fixture'),
    'apps/engine/requirements.txt': '# hostile-fixture-ready\n',
    'apps/worker/requirements.txt': '# hostile-fixture-ready\n',
    'tests/integration/compatibility.test.mjs': "console.log('old smoke fixture');\n",
  });
  const candidate = createClone(scratch, 'candidate', candidateSha, {
    'package.json': `${JSON.stringify({ name: 'candidate-release-fixture', version: '1.0.0', private: true })}\n`,
    'package-lock.json': packageLock('candidate-release-fixture'),
    'scripts/apply-db-migrations.mjs': "console.log('candidate schema fixture');\n",
    'packages/db/prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\nmodel Fixture { id String @id }\n',
    'packages/db/prisma/migrations/20260716000000_fixture/migration.sql': 'CREATE TABLE "Fixture" ("id" text PRIMARY KEY);\n',
  });
  const cloneEnv = join(scratch, 'clone.env');
  const productionEnv = join(scratch, 'production.env');
  const evidenceDir = join(scratch, 'evidence');
  const proof = join(scratch, 'proof.json');
  const providerResultPath = join(scratch, 'provider-result.json');
  const providerLog = join(scratch, 'provider-runtime.log');
  writeMode(cloneEnv, cloneEnvironment(cloneEnvOverrides), 0o600);
  writeMode(productionEnv, [
    'DATABASE_URL=postgresql://prod_app:production-app-password@production-db.lunchlineup.internal:5432/lunchlineup',
    'MIGRATION_DATABASE_URL=postgresql://prod_owner:production-owner-password@production-db.lunchlineup.internal:5432/lunchlineup',
    'APP_DB_USER=prod_app',
    'APP_DB_PASSWORD=production-app-password',
    'POSTGRES_USER=prod_owner',
    'POSTGRES_PASSWORD=production-owner-password',
    'PLATFORM_ADMIN_DB_CONTEXT_SECRET=production-platform-capability',
    `WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT=${'f'.repeat(64)}`,
    'REDIS_URL=rediss://production-redis.lunchlineup.internal:6379',
    'RABBITMQ_URL=amqps://prod_queue:production-rabbit-password@production-rabbit.lunchlineup.internal:5671/%2f',
    'PRODUCTION_SENTINEL=must-not-reach-child-processes',
    '',
  ].join('\n'), 0o600);
  writeMode(providerLog, '', 0o600);
  for (const operation of ['network', 'run', 'container', 'ps', 'rm']) {
    writeMode(join(scratch, operation), fakeRuntimeProgram(operation), 0o700);
  }
  const fixture = {
    scratch, old, candidate, cloneEnv, productionEnv, evidenceDir, proof,
    providerLog, providerResultPath,
    providerRuntime: process.execPath,
    providerRuntimeSha256: digest(readFileSync(process.execPath)),
  };
  writeMode(providerResultPath, `${JSON.stringify(providerResult(fixture))}\n`, 0o600);
  return fixture;
}

function runHarness(fixture, { timeoutMs = '30000', dependencyTimeoutMs = '300000', mode = 'success', extraArgs = [] } = {}) {
  return spawnSync(process.execPath, [
    harness,
    'run',
    '--old-root', fixture.old.clone,
    '--old-manifest', fixture.old.manifest,
    '--old-sha', oldSha,
    '--candidate-root', fixture.candidate.clone,
    '--candidate-manifest', fixture.candidate.manifest,
    '--candidate-sha', candidateSha,
    '--clone-env', fixture.cloneEnv,
    '--production-runtime-env', fixture.productionEnv,
    '--clone-id', cloneId,
    '--clone-network', cloneNetwork,
    '--clone-provider-image', providerImage,
    '--clone-provider-runtime', fixture.providerRuntime,
    '--clone-provider-runtime-sha256', fixture.providerRuntimeSha256,
    '--evidence-dir', fixture.evidenceDir,
    ...extraArgs,
  ], {
    cwd: fixture.scratch,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'tuckerplee/LunchLineup',
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: runAttempt,
      OLD_RELEASE_COMPATIBILITY_TIMEOUT_MS: timeoutMs,
      OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS: dependencyTimeoutMs,
      OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS: dependencyTimeoutMs,
      FAKE_CLONE_ID: cloneId,
      FAKE_CLONE_NETWORK: cloneNetwork,
      FAKE_PRODUCTION_PATH: fixture.productionEnv,
      FAKE_PROVIDER_LOG: fixture.providerLog,
      FAKE_PROVIDER_MODE: mode,
      FAKE_PROVIDER_RESULT: fixture.providerResultPath,
    },
  });
}

function finalizeHarness(fixture, evidenceUri = 'https://github.com/tuckerplee/LunchLineup/actions/runs/123456/artifacts/789012') {
  return spawnSync(process.execPath, [
    harness,
    'finalize',
    '--attestation', join(fixture.evidenceDir, 'compatibility-execution.json'),
    '--evidence-uri', evidenceUri,
    '--output', fixture.proof,
  ], { cwd: root, encoding: 'utf8' });
}

test('CI harness accepts only machine-bound isolated schema and smoke evidence', () => {
  const fixture = createFixture();
  try {
    const executed = runHarness(fixture);
    assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
    assert.match(executed.stdout, /old_release_compatibility_execution_ok/);
    assert.match(readFileSync(join(fixture.evidenceDir, 'candidate-schema-output.txt'), 'utf8'), /candidate-fixed-schema-applied/);
    assert.match(readFileSync(join(fixture.evidenceDir, 'old-release-smoke-output.txt'), 'utf8'), /old-release-fixed-smoke-passed/);

    const runtimeLog = readFileSync(fixture.providerLog, 'utf8');
    assert.match(runtimeLog, /--network llc-123456-2-0123456789ab-network/);
    assert.match(runtimeLog, /--read-only/);
    assert.match(runtimeLog, /--security-opt=no-new-privileges:true/);
    assert.match(runtimeLog, /\/opt\/lunchlineup-provider\/old-release-compatibility-harness\.mjs provider/);
    assert.doesNotMatch(runtimeLog, /\/trusted\//);
    assert.doesNotMatch(runtimeLog, new RegExp(fixture.productionEnv.replaceAll('\\', '\\\\')));
    assert.doesNotMatch(runtimeLog, /production-app-password|must-not-reach-child-processes/);

    const finalized = finalizeHarness(fixture);
    assert.equal(finalized.status, 0, `${finalized.stdout}\n${finalized.stderr}`);
    const proof = JSON.parse(readFileSync(fixture.proof, 'utf8'));
    assert.equal(proof.previousReleaseSha, oldSha);
    assert.equal(proof.candidateReleaseSha, candidateSha);
    assert.equal(proof.database.productionMutated, false);
    assert.equal(proof.database.productionRuntimeMetadataUnchanged, true);
    assert.equal(proof.database.provider.image, providerImage);
    assert.equal(proof.candidateSchema.verification.status, 'exact-candidate-schema');
    assert.equal(proof.execution.policy, 'ci-owned-isolated-schema-fingerprint-v2');

    const verified = spawnSync(process.execPath, [verifier, fixture.proof, oldSha, candidateSha], { cwd: root, encoding: 'utf8' });
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('harness rejects arbitrary child text and detached schema evidence', () => {
  for (const [mode, pattern] of [
    ['arbitrary-text', /arbitrary text instead of its machine contract/],
    ['unverified-schema', /did not prove the exact candidate schema/],
    ['detached-schema', /detached from the immutable release contracts/],
    ['detached-catalog', /catalog output is detached/],
  ]) {
    const fixture = createFixture();
    try {
      const result = runHarness(fixture, { mode });
      assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
      assert.match(result.stderr, pattern);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('harness rejects production mutation and provider survivors', () => {
  for (const [mode, pattern] of [
    ['mutate-production', /digest or metadata changed/],
    ['surviving-container', /container survived/],
    ['background-survivor', /background containers or child survivors/],
  ]) {
    const fixture = createFixture();
    try {
      const result = runHarness(fixture, { mode });
      assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
      assert.match(result.stderr, pattern);
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true });
    }
  }
});

test('harness rejects unsupported adapters and production credential reuse', () => {
  const adapter = createFixture();
  const productionCredential = createFixture({
    cloneEnvOverrides: {
      APP_DB_PASSWORD: 'production-app-password',
      DATABASE_URL: `postgresql://llc_app:production-app-password@127.0.0.1:5432/${cloneDatabase}`,
    },
  });
  try {
    const adapterResult = runHarness(adapter, { extraArgs: ['--adapter', join(adapter.scratch, 'adapter')] });
    assert.notEqual(adapterResult.status, 0);
    assert.match(adapterResult.stderr, /Unknown option: --adapter/);

    const productionResult = runHarness(productionCredential);
    assert.notEqual(productionResult.status, 0);
    assert.match(productionResult.stderr, /reuses a production credential/);
  } finally {
    rmSync(adapter.scratch, { recursive: true, force: true });
    rmSync(productionCredential.scratch, { recursive: true, force: true });
  }
});

test('production runtime path cannot be exposed through a mounted release clone', () => {
  const fixture = createFixture();
  try {
    const nestedProduction = join(fixture.candidate.clone, 'production-runtime.env');
    writeMode(nestedProduction, readFileSync(fixture.productionEnv), 0o600);
    fixture.productionEnv = nestedProduction;
    const result = runHarness(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Production runtime environment must remain outside immutable release clones/);
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('isolated provider timeout is bounded by the contract and cannot attest success', () => {
  const fixture = createFixture();
  try {
    const result = runHarness(fixture, { timeoutMs: '1000', dependencyTimeoutMs: '1000', mode: 'timeout' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Isolated clone provider execution timed out/);
    assert.throws(() => readFileSync(join(fixture.evidenceDir, 'compatibility-execution.json')));
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
  }
});

test('finalization rejects changed evidence and mutable evidence URLs', () => {
  const tampered = createFixture();
  const mutable = createFixture();
  try {
    assert.equal(runHarness(tampered).status, 0);
    writeFileSync(join(tampered.evidenceDir, 'old-release-smoke-output.txt'), 'changed\n');
    const tamperedResult = finalizeHarness(tampered);
    assert.notEqual(tamperedResult.status, 0);
    assert.match(tamperedResult.stderr, /changed after executable evidence collection/);

    assert.equal(runHarness(mutable).status, 0);
    const mutableResult = finalizeHarness(mutable, 'https://example.com/latest/compatibility.json');
    assert.notEqual(mutableResult.status, 0);
    assert.match(mutableResult.stderr, /immutable URL emitted by actions\/upload-artifact/);
  } finally {
    rmSync(tampered.scratch, { recursive: true, force: true });
    rmSync(mutable.scratch, { recursive: true, force: true });
  }
});

test('provider implementation owns schema fingerprint and Linux child-survivor checks', () => {
  const source = readFileSync(harness, 'utf8');
  assert.match(source, /fixedProviderPrismaCli = '\/opt\/lunchlineup-provider\/node_modules\/prisma\/build\/index\.js'/);
  assert.match(source, /Provider harness must execute from its fixed immutable root-owned image path/);
  assert.match(source, /catalogCommand: \['psql', 'fixed-public-schema-catalog-v1'\]/);
  assert.match(source, /process\.pid !== 1/);
  assert.match(source, /left background child processes in the isolated provider/);
  assert.doesNotMatch(source, /candidateClone\.root, 'node_modules\/prisma/);
});

test('hostile npm postinstall and Python build backend cannot observe production runtime or clone-command inputs', { timeout: 60_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-hostile-dependency-fixtures-'));
  const npmRoot = join(scratch, 'npm');
  const pythonRoot = join(scratch, 'python');
  const pythonTarget = join(scratch, 'python-target');
  const home = join(scratch, 'home');
  const forbiddenNames = [
    'OLD_RELEASE_COMPATIBILITY_CLONE_COMMAND',
    'OLD_RELEASE_COMPATIBILITY_PRODUCTION_RUNTIME_ENV_PATH',
    'CURRENT_RUNTIME_ENV_PATH',
    'ROLLBACK_RUNTIME_ENV_PATH',
    'PRODUCTION_RUNTIME_ENV_PATH',
  ];
  const original = new Map(forbiddenNames.map((name) => [name, process.env[name]]));
  try {
    mkdirSync(npmRoot, { recursive: true });
    mkdirSync(pythonRoot, { recursive: true });
    mkdirSync(home, { recursive: true });
    for (const name of forbiddenNames) process.env[name] = `hostile-secret-${name.toLowerCase()}`;
    const dependencyEnv = isolatedDependencyEnvironment({ home, tmpdir: scratch });
    for (const name of forbiddenNames) assert.equal(dependencyEnv[name], undefined, `${name} leaked into dependency environment`);

    const hostileRuntimePaths = [
      '/run/lunchlineup/production-runtime.env',
      '/run/lunchlineup/current-runtime.env',
      '/run/lunchlineup/rollback-runtime.env',
    ];
    writeMode(join(npmRoot, 'package.json'), `${JSON.stringify({
      name: 'hostile-npm-probe', version: '1.0.0', private: true,
      scripts: { postinstall: 'node hostile-postinstall.mjs' },
    })}\n`);
    writeMode(join(npmRoot, 'package-lock.json'), packageLock('hostile-npm-probe'));
    writeMode(join(npmRoot, 'hostile-postinstall.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
const forbiddenNames = ${JSON.stringify(forbiddenNames)};
const forbiddenPaths = ${JSON.stringify(hostileRuntimePaths)};
for (const name of forbiddenNames) {
  if (Object.hasOwn(process.env, name)) throw new Error('forbidden environment exposed: ' + name);
}
for (const value of Object.values(process.env)) {
  if (String(value).includes('hostile-secret-')) throw new Error('forbidden environment value exposed');
}
for (const path of forbiddenPaths) {
  if (existsSync(path)) throw new Error('production runtime file exposed: ' + path);
}
writeFileSync('postinstall-ran.json', JSON.stringify({ isolated: true }));
`);
    const npmCli = [
      process.env.npm_execpath,
      resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ].find((candidate) => candidate && existsSync(candidate));
    assert.ok(npmCli, 'npm CLI must be installed with Node for the hostile postinstall fixture');
    const npmResult = spawnSync(process.execPath, [npmCli, 'ci', '--offline', '--no-audit', '--no-fund'], {
      cwd: npmRoot, env: dependencyEnv, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(npmResult.status, 0, `${npmResult.stdout}\n${npmResult.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(npmRoot, 'postinstall-ran.json'), 'utf8')), { isolated: true });

    writeMode(join(pythonRoot, 'pyproject.toml'), `
[build-system]
requires = []
build-backend = "backend"
backend-path = ["."]
`);
    writeMode(join(pythonRoot, 'backend.py'), `
import json
import os
import zipfile

FORBIDDEN_NAMES = ${JSON.stringify(forbiddenNames)}
FORBIDDEN_PATHS = ${JSON.stringify(hostileRuntimePaths)}

def _assert_isolated():
    for name in FORBIDDEN_NAMES:
        if name in os.environ:
            raise RuntimeError("forbidden environment exposed: " + name)
    for value in os.environ.values():
        if "hostile-secret-" in value:
            raise RuntimeError("forbidden environment value exposed")
    for path in FORBIDDEN_PATHS:
        if os.path.exists(path):
            raise RuntimeError("production runtime file exposed: " + path)

def get_requires_for_build_wheel(config_settings=None):
    _assert_isolated()
    return []

def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    _assert_isolated()
    filename = "hostile_probe-1.0-py3-none-any.whl"
    path = os.path.join(wheel_directory, filename)
    with zipfile.ZipFile(path, "w") as wheel:
        wheel.writestr("hostile_probe/__init__.py", "ISOLATED = True\\n")
        wheel.writestr("hostile_probe/isolation-proof.json", json.dumps({"isolated": True}))
        wheel.writestr("hostile_probe-1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: hostile-probe\\nVersion: 1.0\\n")
        wheel.writestr("hostile_probe-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: hostile-probe\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
        wheel.writestr("hostile_probe-1.0.dist-info/RECORD", "")
    return filename
`);
    const pythonProbe = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(pythonProbe.status, 0, pythonProbe.stderr);
    const pythonCommand = pythonProbe.stdout.trim();
    const pythonResult = spawnSync(pythonCommand, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-index', '--no-build-isolation',
      '--target', pythonTarget, pythonRoot,
    ], { cwd: scratch, env: dependencyEnv, encoding: 'utf8', timeout: 30_000 });
    assert.equal(pythonResult.status, 0, `${pythonResult.stdout}\n${pythonResult.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(pythonTarget, 'hostile_probe', 'isolation-proof.json'), 'utf8')), { isolated: true });
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
