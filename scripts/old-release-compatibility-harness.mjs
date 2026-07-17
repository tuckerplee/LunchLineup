#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixedSchemaPath = 'scripts/apply-db-migrations.mjs';
const fixedSchemaModelPath = 'packages/db/prisma/schema.prisma';
const fixedSmokePackagePath = 'package.json';
const fixedSmokeScript = 'node --test --test-concurrency=1 tests/integration/*.test.mjs';
const fixedProviderHarness = '/opt/lunchlineup-provider/old-release-compatibility-harness.mjs';
const fixedProviderPrismaCli = '/opt/lunchlineup-provider/node_modules/prisma/build/index.js';
const fixedProviderNpmCache = '/opt/lunchlineup-provider/npm-cache';
const fixedProviderPythonWheelhouse = '/opt/lunchlineup-provider/python-wheelhouse';
const executionPolicy = 'ci-owned-isolated-schema-fingerprint-v2';
const providerKind = 'lunchlineup-isolated-clone-provider-v1';
const retainedContractProfile = 'lunchlineup-release-rollback-compatibility-v2';
const fixedPreflightPaths = [
  'apps/engine/requirements.txt',
  'apps/worker/requirements.txt',
  'infrastructure/systemd/lunchlineup-backup.service',
  'infrastructure/systemd/lunchlineup-backup.timer',
  'infrastructure/systemd/lunchlineup-pitr-base-backup.service',
  'infrastructure/systemd/lunchlineup-pitr-base-backup.timer',
  'package-lock.json',
  'package.json',
  'scripts/apply-db-migrations.mjs',
  'scripts/old-release-compatibility-harness.mjs',
  'scripts/verify-backup-readiness.sh',
  'scripts/verify-release-artifacts.mjs',
];
const cloneEnvKeys = new Set([
  'APP_DB_PASSWORD',
  'APP_DB_USER',
  'DATABASE_URL',
  'DATA_TARGET_ENV',
  'ENGINE_GRPC_URL',
  'MIGRATION_DATABASE_URL',
  'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'RABBITMQ_URL',
  'REDIS_URL',
  'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
]);
const cloneSecretKeys = [
  'APP_DB_PASSWORD',
  'PLATFORM_ADMIN_DB_CONTEXT_SECRET',
  'POSTGRES_PASSWORD',
  'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT',
];
const endpointKeys = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'REDIS_URL', 'RABBITMQ_URL'];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseOptions(allowed) {
  const result = {};
  const args = process.argv.slice(3);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name)) fail(`Unknown option: ${name ?? '<missing>'}`);
    if (!value || value.startsWith('--')) fail(`${name} is required.`);
    if (Object.hasOwn(result, name)) fail(`${name} must be supplied exactly once.`);
    result[name] = value;
  }
  for (const name of allowed) {
    if (!result[name]) fail(`${name} is required.`);
  }
  return result;
}

function requireSha(value, label, length = 40) {
  const normalized = String(value ?? '').toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(normalized)) fail(`${label} must be ${length} lowercase hexadecimal characters.`);
  return normalized;
}

function requireRegularFile(path, label, { executable = false, maxBytes } = {}) {
  if (!existsSync(path)) fail(`${label} does not exist.`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) fail(`${label} must be a non-empty regular file and not a symlink.`);
  if (maxBytes !== undefined && stat.size > maxBytes) fail(`${label} exceeds the ${maxBytes}-byte limit.`);
  if (process.platform !== 'win32' && executable && (stat.mode & 0o100) === 0) fail(`${label} must be owner-executable.`);
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) fail(`${label} must not be group- or world-writable.`);
  return stat;
}

function requireImmutableDirectory(path, label) {
  const absolute = realpathSync(path);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a non-symlink directory.`);
  if (process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
    fail(`${label} must be immutable and root-owned.`);
  }
  return absolute;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeRelativePath(rawPath, label) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\\')) fail(`${label} is not a safe repository-relative path.`);
  const parts = rawPath.split('/');
  if (rawPath.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label} is not a safe repository-relative path.`);
  }
  return parts;
}

function requireInside(root, path, label) {
  const value = relative(root, path);
  if (value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))) return;
  fail(`${label} must remain inside its immutable release clone.`);
}

function validateClone(rootPath, manifestPath, expectedSha, label) {
  const root = realpathSync(rootPath);
  const manifestFile = realpathSync(manifestPath);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`${label} root must be a non-symlink directory.`);
  requireInside(root, manifestFile, `${label} manifest`);
  requireRegularFile(manifestFile, `${label} manifest`);
  const manifestBytes = readFileSync(manifestFile);
  const manifest = readJson(manifestFile, `${label} manifest`);
  if (manifest?.sourceSha !== expectedSha) fail(`${label} manifest sourceSha does not match its expected immutable SHA.`);
  const contract = manifest.deploymentContract;
  if (!contract || contract.algorithm !== 'sha256' || !contract.files || typeof contract.files !== 'object' || Array.isArray(contract.files)) {
    fail(`${label} manifest must contain a SHA-256 deployment contract.`);
  }
  const entries = Object.entries(contract.files);
  if (entries.length === 0) fail(`${label} deployment contract must not be empty.`);
  const files = new Map();
  for (const [rawPath, expectedDigest] of entries) {
    const parts = safeRelativePath(rawPath, `${label} deployment file`);
    const file = resolve(root, ...parts);
    requireInside(root, file, `${label} deployment file`);
    requireRegularFile(file, `${label} deployment file ${rawPath}`);
    const digest = sha256(readFileSync(file));
    if (digest !== requireSha(expectedDigest, `${label} deployment digest`, 64)) {
      fail(`${label} deployment file digest mismatch: ${rawPath}`);
    }
    files.set(rawPath, { path: file, sha256: digest });
  }
  const bundleSha256 = requireSha(contract.bundle?.sha256, `${label} deployment bundle digest`, 64);
  const identity = {
    sourceSha: expectedSha,
    manifestSha256: sha256(manifestBytes),
    deploymentBundleSha256: bundleSha256,
  };
  return {
    root,
    manifestFile,
    contract,
    files,
    ...identity,
    identitySha256: sha256(Buffer.from(JSON.stringify(identity))),
  };
}

function materializeProviderClone(clone, parent, name, label) {
  const root = resolve(parent, name);
  mkdirSync(root, { recursive: false, mode: 0o700 });
  for (const [relativePath, claim] of clone.files) {
    const target = resolve(root, ...safeRelativePath(relativePath, `${label} deployment file`));
    requireInside(root, target, `${label} deployment file`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(claim.path, target);
    chmodSync(target, lstatSync(claim.path).mode & 0o777);
  }
  const manifestRelative = relative(clone.root, clone.manifestFile).split(sep).join('/');
  const manifest = resolve(root, ...safeRelativePath(manifestRelative, `${label} manifest`));
  requireInside(root, manifest, `${label} manifest`);
  mkdirSync(dirname(manifest), { recursive: true, mode: 0o700 });
  copyFileSync(clone.manifestFile, manifest);
  chmodSync(manifest, 0o600);
  return validateClone(root, manifest, clone.sourceSha, label);
}

function materializedCloneFiles(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`Materialized compatibility root contains a symbolic link: ${relative(root, path)}`);
    if (stat.isDirectory()) result.push(...materializedCloneFiles(root, path));
    else if (stat.isFile()) result.push(relative(root, path).split(sep).join('/'));
    else fail(`Materialized compatibility root contains an unsupported filesystem entry: ${relative(root, path)}`);
  }
  return result;
}

function requireExactMaterializedClone(clone, label) {
  if (clone.contract.retention?.profile !== retainedContractProfile || clone.contract.retention?.version !== 2) {
    fail(`${label} does not use the complete retained compatibility contract.`);
  }
  for (const path of fixedPreflightPaths) requireContractFile(clone, path, `${label} retained input`);
  const integrationTests = [...clone.files.keys()].filter((path) => path.startsWith('tests/integration/') && path.endsWith('.test.mjs'));
  if (integrationTests.length === 0) fail(`${label} does not retain its integration test owners.`);
  const expected = [...clone.files.keys(), relative(clone.root, clone.manifestFile).split(sep).join('/')].sort();
  const actual = materializedCloneFiles(clone.root).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.find((path) => !actual.includes(path));
    const unmanifested = actual.find((path) => !expected.includes(path));
    fail(`${label} materialized root is not exact (missing=${missing ?? '-'} unmanifested=${unmanifested ?? '-'}).`);
  }
  return integrationTests.length;
}

function preflight() {
  const options = parseOptions(new Set([
    '--candidate-manifest', '--candidate-root', '--candidate-sha',
    '--old-manifest', '--old-root', '--old-sha',
  ]));
  const oldSha = requireSha(options['--old-sha'], '--old-sha');
  const candidateSha = requireSha(options['--candidate-sha'], '--candidate-sha');
  if (oldSha === candidateSha) fail('Old and candidate release SHAs must differ.');
  const oldClone = validateClone(options['--old-root'], options['--old-manifest'], oldSha, 'Old release clone');
  const candidateClone = validateClone(options['--candidate-root'], options['--candidate-manifest'], candidateSha, 'Candidate release clone');
  if (oldClone.root === candidateClone.root || oldClone.identitySha256 === candidateClone.identitySha256) {
    fail('Old and candidate release clones must have distinct immutable identities.');
  }
  const oldTests = requireExactMaterializedClone(oldClone, 'Old release clone');
  const candidateTests = requireExactMaterializedClone(candidateClone, 'Candidate release clone');
  const packageJson = readJson(requireContractFile(oldClone, fixedSmokePackagePath, 'Old-release smoke package').path, 'Old-release package.json');
  if (packageJson?.scripts?.['test:integration'] !== fixedSmokeScript) {
    fail(`Old release package.json must own the fixed test:integration command: ${fixedSmokeScript}`);
  }
  requireContractFile(candidateClone, fixedSchemaPath, 'Candidate schema executable');
  requireContractFile(candidateClone, fixedSchemaModelPath, 'Candidate Prisma schema');
  migrationInputIdentity(candidateClone);
  process.stdout.write(`old_release_compatibility_preflight_ok old_sha=${oldSha} candidate_sha=${candidateSha} old_files=${oldClone.files.size} candidate_files=${candidateClone.files.size} old_tests=${oldTests} candidate_tests=${candidateTests}\n`);
}

function requireContractFile(clone, relativePath, label) {
  const claim = clone.files.get(relativePath);
  if (!claim) fail(`${label} must be bound by the immutable deployment contract at ${relativePath}.`);
  return claim;
}

function parseEnvFile(path, label, { allowedKeys } = {}) {
  requireRegularFile(path, label, { maxBytes: 1024 * 1024 });
  const values = {};
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (line === '' || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) fail(`${label} line ${index + 1} is not a literal KEY=value assignment.`);
    const [, key, rawValue] = match;
    if (allowedKeys && !allowedKeys.has(key)) fail(`${label} contains unsupported key ${key}.`);
    if (Object.hasOwn(values, key)) fail(`${label} contains duplicate key ${key}.`);
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length === 0 || value.includes('\0') || /\$\{|\$\(/.test(value)) {
      fail(`${label} key ${key} must contain one non-interpolated literal value.`);
    }
    values[key] = value;
  }
  return values;
}

function parseUrl(value, protocols, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be a valid URL.`);
  }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname) fail(`${label} uses an unsupported endpoint.`);
  return parsed;
}

function decoded(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(`${label} contains invalid percent encoding.`);
  }
}

function normalizedIdentityPart(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ciCloneIdentity(cloneId, cloneEnvBytes) {
  const repository = String(process.env.GITHUB_REPOSITORY ?? '');
  const runId = String(process.env.GITHUB_RUN_ID ?? '');
  const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '');
  if (process.env.GITHUB_ACTIONS !== 'true' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('Compatibility execution requires a GitHub Actions-owned clone identity.');
  }
  if (!/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(runAttempt)) {
    fail('GitHub Actions run identity is incomplete.');
  }
  const expected = new RegExp(`^llc-${runId}-${runAttempt}-[a-f0-9]{12}$`);
  if (!expected.test(cloneId)) fail(`--clone-id must be a CI-owned llc-${runId}-${runAttempt}-<12hex> identity.`);
  return {
    owner: 'github-actions',
    repository,
    runId,
    runAttempt,
    cloneId,
    credentialSha256: sha256(cloneEnvBytes),
  };
}

function requireCloneEnvironment(cloneEnvPath, productionEnvPath, cloneId) {
  const cloneEnvBytes = readFileSync(cloneEnvPath);
  const clone = parseEnvFile(cloneEnvPath, 'Compatibility clone environment', { allowedKeys: cloneEnvKeys });
  const production = productionEnvPath ? parseEnvFile(productionEnvPath, 'Production runtime environment') : {};
  for (const key of cloneEnvKeys) {
    if (!clone[key]) fail(`Compatibility clone environment is missing ${key}.`);
  }
  if (!['test', 'disposable'].includes(clone.DATA_TARGET_ENV)) {
    fail('Compatibility clone DATA_TARGET_ENV must be test or disposable.');
  }

  const app = parseUrl(clone.DATABASE_URL, ['postgres:', 'postgresql:'], 'Compatibility clone DATABASE_URL');
  const owner = parseUrl(clone.MIGRATION_DATABASE_URL, ['postgres:', 'postgresql:'], 'Compatibility clone MIGRATION_DATABASE_URL');
  const appDatabase = decoded(app.pathname.slice(1), 'Compatibility clone database name');
  const ownerDatabase = decoded(owner.pathname.slice(1), 'Compatibility clone database name');
  const appUser = decoded(app.username, 'Compatibility clone application user');
  const ownerUser = decoded(owner.username, 'Compatibility clone owner user');
  const appPassword = decoded(app.password, 'Compatibility clone application password');
  const ownerPassword = decoded(owner.password, 'Compatibility clone owner password');
  if (!appDatabase || appDatabase !== ownerDatabase || app.hostname !== owner.hostname || app.port !== owner.port) {
    fail('Compatibility clone database URLs must address the same isolated database endpoint.');
  }
  if (appUser !== clone.APP_DB_USER || ownerUser !== clone.POSTGRES_USER || appPassword !== clone.APP_DB_PASSWORD || ownerPassword !== clone.POSTGRES_PASSWORD) {
    fail('Compatibility clone URL credentials must match their dedicated clone role values.');
  }
  if (appUser === ownerUser || appPassword === ownerPassword) {
    fail('Compatibility clone application and owner credentials must be distinct.');
  }
  const normalizedCloneId = normalizedIdentityPart(cloneId);
  const databaseIdentity = normalizedIdentityPart(`${app.hostname}/${appDatabase}`);
  if (!databaseIdentity.includes(normalizedCloneId)) {
    fail('Compatibility database endpoint or database name must contain the exact CI-owned clone identity.');
  }

  const productionCredentials = new Set();
  for (const key of cloneSecretKeys) {
    if (production[key]) productionCredentials.add(production[key]);
  }
  const productionHosts = new Set();
  for (const key of endpointKeys) {
    if (!production[key]) continue;
    const protocols = key === 'REDIS_URL' ? ['redis:', 'rediss:']
      : key === 'RABBITMQ_URL' ? ['amqp:', 'amqps:']
        : ['postgres:', 'postgresql:'];
    const endpoint = parseUrl(production[key], protocols, `Production ${key}`);
    productionHosts.add(endpoint.hostname.toLowerCase());
    if (endpoint.password) productionCredentials.add(decoded(endpoint.password, `Production ${key} password`));
  }
  for (const [label, value] of [
    ['application password', appPassword],
    ['owner password', ownerPassword],
    ...cloneSecretKeys.map((key) => [key, clone[key]]),
  ]) {
    if (productionCredentials.has(value)) fail(`Compatibility clone ${label} reuses a production credential.`);
  }
  if (productionHosts.has(app.hostname.toLowerCase())) {
    fail('Compatibility clone database reuses a production endpoint.');
  }

  for (const [key, protocols] of [
    ['REDIS_URL', ['redis:', 'rediss:']],
    ['RABBITMQ_URL', ['amqp:', 'amqps:']],
  ]) {
    const endpoint = parseUrl(clone[key], protocols, `Compatibility clone ${key}`);
    const host = endpoint.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (productionHosts.has(host)) fail(`Compatibility clone ${key} reuses a production endpoint.`);
    if (!loopback && !normalizedIdentityPart(`${host}/${endpoint.pathname}`).includes(normalizedCloneId)) {
      fail(`Compatibility clone ${key} must be loopback or bound to the CI-owned clone identity.`);
    }
  }
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/.test(clone.ENGINE_GRPC_URL)) {
    fail('Compatibility clone ENGINE_GRPC_URL must be a bounded loopback endpoint.');
  }

  return { clone, cloneEnvBytes };
}

export function isolatedDependencyEnvironment({ home, tmpdir, pythonPath } = {}) {
  const safeSystemKeys = process.platform === 'win32'
    ? ['APPDATA', 'ComSpec', 'HOME', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
    : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMPDIR'];
  const env = { CI: 'true', GITHUB_ACTIONS: 'true' };
  for (const key of safeSystemKeys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (home) env.HOME = home;
  if (tmpdir) {
    env.TMPDIR = tmpdir;
    if (process.platform === 'win32') {
      env.TEMP = tmpdir;
      env.TMP = tmpdir;
    }
  }
  if (pythonPath) env.PYTHONPATH = pythonPath;
  return env;
}

function childEnvironment(clone, options) {
  const env = isolatedDependencyEnvironment(options);
  for (const key of cloneEnvKeys) env[key] = clone[key];
  return env;
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate) && lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink()) return candidate;
  }
  fail('Fixed old-release integration smoke requires the npm CLI installed with Node.');
}

function resolveProviderPython() {
  for (const candidate of ['/usr/local/bin/python3', '/usr/bin/python3']) {
    if (!existsSync(candidate)) continue;
    const absolute = realpathSync(candidate);
    const stat = requireRegularFile(absolute, 'Provider Python runtime', { executable: true });
    if (stat.uid === 0 && (stat.mode & 0o022) === 0) return absolute;
  }
  fail('Provider Python runtime must be immutable and root-owned at /usr/local/bin/python3 or /usr/bin/python3.');
}

function boundedTimeout(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maximum) {
    fail(`${name} must be an integer from 1000 through ${maximum}.`);
  }
  return value;
}

function remainingTimeout(deadline, label) {
  const remaining = deadline - Date.now();
  if (remaining < 1) fail(`${label} exceeded the aggregate compatibility execution deadline.`);
  return remaining;
}

function dependencyInputs(oldClone, candidateClone) {
  const oldPackage = requireContractFile(oldClone, 'package.json', 'Old-release package manifest');
  const oldLock = requireContractFile(oldClone, 'package-lock.json', 'Old-release package lock');
  const candidatePackage = requireContractFile(candidateClone, 'package.json', 'Candidate package manifest');
  const candidateLock = requireContractFile(candidateClone, 'package-lock.json', 'Candidate package lock');
  const engineRequirements = requireContractFile(oldClone, 'apps/engine/requirements.txt', 'Old-release engine requirements');
  const workerRequirements = requireContractFile(oldClone, 'apps/worker/requirements.txt', 'Old-release worker requirements');
  return {
    oldPackage,
    oldLock,
    candidatePackage,
    candidateLock,
    requirementsSha256: sha256(Buffer.from(JSON.stringify([
      ['apps/engine/requirements.txt', engineRequirements.sha256],
      ['apps/worker/requirements.txt', workerRequirements.sha256],
    ]))),
  };
}

function fileEvidence(path, label) {
  const stat = requireRegularFile(path, label, { maxBytes: 10 * 1024 * 1024 });
  const bytes = readFileSync(path);
  return { sha256: sha256(bytes), bytes: stat.size };
}

function executeFixed({ label, command, args, cwd, env, output, timeoutMs }) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
  });
  const outputBytes = Buffer.from(`stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`);
  writeFileSync(output, outputBytes, { mode: 0o600, flag: 'wx' });
  chmodSync(output, 0o600);
  if (result.error?.code === 'ETIMEDOUT') fail(`${label} timed out.`);
  if (result.error) fail(`${label} could not execute: ${result.error.message}`);
  if (result.status !== 0 || result.signal) fail(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
  if ((result.stdout?.length ?? 0) + (result.stderr?.length ?? 0) === 0) fail(`${label} produced no executable result output.`);
  return {
    exitCode: result.status,
    startedAt,
    completedAt: new Date().toISOString(),
    output: fileEvidence(output, `${label} output`),
    stdout: result.stdout ?? '',
  };
}

function productionSnapshot(path) {
  const stat = requireRegularFile(path, 'Production runtime environment', { maxBytes: 1024 * 1024 });
  return {
    sha256: sha256(readFileSync(path)),
    bytes: stat.size,
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function requireProviderRuntime(path, expectedDigest) {
  if (!isAbsolute(path)) fail('--clone-provider-runtime must be an absolute path.');
  const runtime = realpathSync(path);
  const stat = requireRegularFile(runtime, 'Clone provider runtime', { executable: true });
  if (process.platform !== 'win32' && stat.uid !== 0) fail('Clone provider runtime must be root-owned.');
  const actual = sha256(readFileSync(runtime));
  if (actual !== requireSha(expectedDigest, '--clone-provider-runtime-sha256', 64)) {
    fail('Clone provider runtime does not match --clone-provider-runtime-sha256.');
  }
  return runtime;
}

function requireOutside(root, path, label) {
  const value = relative(root, path);
  if (value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))) {
    fail(`${label} must remain outside immutable release clones.`);
  }
}

function providerMount(path, destination) {
  if (path.includes(',') || destination.includes(',')) fail('Clone provider mount paths must not contain commas.');
  return `type=bind,src=${path},dst=${destination},readonly`;
}

function runRuntime(runtime, args, { timeoutMs, env = process.env } = {}) {
  return spawnSync(runtime, args, {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 12 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requireRuntimeSuccess(result, label) {
  if (result.error?.code === 'ETIMEDOUT') fail(`${label} timed out.`);
  if (result.error) fail(`${label} could not execute: ${result.error.message}`);
  if (result.status !== 0 || result.signal) fail(`${label} failed with exit code ${result.status ?? 'unknown'}: ${String(result.stderr ?? '').trim()}`);
  return String(result.stdout ?? '');
}

function decodeProviderOutput(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail(`${label} is not bounded canonical base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) fail(`${label} is not canonical base64.`);
  return bytes;
}

function migrationInputIdentity(candidateClone) {
  const inputs = [...candidateClone.files.entries()]
    .filter(([path]) => path === fixedSchemaModelPath || (path.startsWith('packages/db/prisma/migrations/') && path.endsWith('.sql')))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, claim]) => [path, claim.sha256]);
  if (inputs.length === 0) fail('Candidate schema fingerprint has no contract-bound migration inputs.');
  return { inputs, sha256: sha256(Buffer.from(JSON.stringify(inputs))) };
}

function validateProviderResult(result, {
  oldSha, candidateSha, cloneId, schemaExecutableSha256, smokePackageSha256, migrationInputSha256, dependencyIdentity,
}) {
  if (
    result?.version !== 1
    || result.kind !== providerKind
    || result.executionPolicy !== executionPolicy
    || result.previousReleaseSha !== oldSha
    || result.candidateReleaseSha !== candidateSha
    || result.cloneId !== cloneId
  ) fail('Isolated clone provider result identity is invalid.');
  if (result.schemaVerification?.status !== 'exact-candidate-schema' || result.schemaVerification?.prismaDiffExitCode !== 0) {
    fail('Isolated clone provider did not prove the exact candidate schema.');
  }
  if (
    result.dependencyPreparation?.isolation !== 'provider-local-contract-copies-v1'
    || result.dependencyPreparation?.environment !== 'production-runtime-and-clone-command-absent-v1'
    || result.dependencyPreparation?.network !== 'clone-internal-offline-caches-only-v1'
  ) fail('Isolated clone provider dependency preparation contract is invalid.');
  validateExecutionClaim(result.dependencyPreparation.oldNpm, {
    label: 'Old-release npm preparation',
    command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'],
    digestKey: 'packageLockSha256',
  });
  validateExecutionClaim(result.dependencyPreparation.candidateNpm, {
    label: 'Candidate npm preparation',
    command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'],
    digestKey: 'packageLockSha256',
  });
  validateExecutionClaim(result.dependencyPreparation.oldPython, {
    label: 'Old-release Python preparation',
    command: ['python3', '-m', 'pip', 'install', '--no-index', '--target', '<provider-python-site>', '-r', 'apps/engine/requirements.txt', '-r', 'apps/worker/requirements.txt'],
    digestKey: 'requirementsSha256',
  });
  if (
    result.dependencyPreparation.oldNpm.packageLockSha256 !== dependencyIdentity.oldLock.sha256
    || result.dependencyPreparation.candidateNpm.packageLockSha256 !== dependencyIdentity.candidateLock.sha256
    || result.dependencyPreparation.oldPython.requirementsSha256 !== dependencyIdentity.requirementsSha256
  ) fail('Isolated dependency preparation evidence is detached from the immutable release contracts.');
  requireSha(result.schemaVerification.catalogSha256, 'schemaVerification.catalogSha256', 64);
  requireSha(result.schemaVerification.migrationInputSha256, 'schemaVerification.migrationInputSha256', 64);
  if (!Number.isSafeInteger(result.schemaVerification.catalogBytes) || result.schemaVerification.catalogBytes < 2) {
    fail('Isolated clone provider schema catalog evidence is empty.');
  }
  validateExecutionClaim(result.candidateSchemaExecution, {
    label: 'Candidate schema', command: ['node', fixedSchemaPath], digestKey: 'executableSha256',
  });
  validateExecutionClaim(result.oldReleaseSmokeExecution, {
    label: 'Old-release smoke', command: ['npm', 'run', 'test:integration'], digestKey: 'packageSha256', packageScript: fixedSmokeScript,
  });
  if (result.candidateSchemaExecution.executableSha256 !== schemaExecutableSha256
    || result.oldReleaseSmokeExecution.packageSha256 !== smokePackageSha256
    || result.schemaVerification.migrationInputSha256 !== migrationInputSha256) {
    fail('Isolated clone provider evidence is detached from the immutable release contracts.');
  }
  const completedAt = Date.parse(result.completedAt ?? '');
  if (!Number.isFinite(completedAt) || completedAt > Date.now() + 300_000 || Date.now() - completedAt > 3_600_000) {
    fail('Isolated clone provider result is stale or future-dated.');
  }
  const outputs = {
    schema: decodeProviderOutput(result.outputs?.candidateSchema, 'Provider candidate schema output'),
    smoke: decodeProviderOutput(result.outputs?.oldReleaseSmoke, 'Provider old-release smoke output'),
    catalog: decodeProviderOutput(result.outputs?.schemaCatalog, 'Provider schema catalog output'),
  };
  if (sha256(outputs.catalog) !== result.schemaVerification.catalogSha256 || outputs.catalog.length !== result.schemaVerification.catalogBytes) {
    fail('Isolated clone provider schema catalog output is detached from its fingerprint claim.');
  }
  return outputs;
}

function run() {
  const options = parseOptions(new Set([
    '--candidate-manifest', '--candidate-root', '--candidate-sha', '--clone-env', '--clone-id', '--clone-network',
    '--clone-provider-image', '--clone-provider-runtime', '--clone-provider-runtime-sha256', '--evidence-dir',
    '--old-manifest', '--old-root', '--old-sha', '--production-runtime-env',
  ]));
  const oldSha = requireSha(options['--old-sha'], '--old-sha');
  const candidateSha = requireSha(options['--candidate-sha'], '--candidate-sha');
  if (oldSha === candidateSha) fail('Old and candidate release SHAs must differ.');
  const cloneId = options['--clone-id'];
  const cloneNetwork = options['--clone-network'];
  if (cloneNetwork !== `${cloneId}-network`) fail(`--clone-network must equal ${cloneId}-network.`);
  const providerImage = options['--clone-provider-image'];
  if (!/^[A-Za-z0-9._/:=-]+@sha256:[a-f0-9]{64}$/.test(providerImage)) {
    fail('--clone-provider-image must be an immutable image@sha256 digest reference.');
  }
  const cloneEnvPath = realpathSync(options['--clone-env']);
  const productionEnvPath = realpathSync(options['--production-runtime-env']);
  const evidenceDir = resolve(options['--evidence-dir']);
  requireRegularFile(cloneEnvPath, 'Compatibility clone environment');
  requireRegularFile(productionEnvPath, 'Production runtime environment');
  if (cloneEnvPath === productionEnvPath) fail('Compatibility clone and production runtime environments must be distinct files.');
  if (existsSync(evidenceDir)) fail('--evidence-dir must not already exist.');

  const oldClone = validateClone(options['--old-root'], options['--old-manifest'], oldSha, 'Old release clone');
  const candidateClone = validateClone(options['--candidate-root'], options['--candidate-manifest'], candidateSha, 'Candidate release clone');
  if (oldClone.root === candidateClone.root || oldClone.identitySha256 === candidateClone.identitySha256) fail('Old and candidate release clones must have distinct immutable identities.');
  requireOutside(oldClone.root, productionEnvPath, 'Production runtime environment');
  requireOutside(candidateClone.root, productionEnvPath, 'Production runtime environment');
  requireOutside(oldClone.root, evidenceDir, 'Compatibility evidence directory');
  requireOutside(candidateClone.root, evidenceDir, 'Compatibility evidence directory');
  const schemaExecutable = requireContractFile(candidateClone, fixedSchemaPath, 'Candidate schema executable');
  requireContractFile(candidateClone, fixedSchemaModelPath, 'Candidate Prisma schema');
  const migrationInputs = migrationInputIdentity(candidateClone);
  const smokePackage = requireContractFile(oldClone, fixedSmokePackagePath, 'Old-release smoke package');
  const packageJson = readJson(smokePackage.path, 'Old-release package.json');
  if (packageJson?.scripts?.['test:integration'] !== fixedSmokeScript) fail(`Old release package.json must own the fixed test:integration command: ${fixedSmokeScript}`);
  const dependencyIdentity = dependencyInputs(oldClone, candidateClone);

  const { clone, cloneEnvBytes } = requireCloneEnvironment(cloneEnvPath, productionEnvPath, cloneId);
  const cloneIdentity = ciCloneIdentity(cloneId, cloneEnvBytes);
  const timeoutMs = boundedTimeout('OLD_RELEASE_COMPATIBILITY_TIMEOUT_MS', 900_000, 1_800_000);
  const npmCiTimeoutMs = boundedTimeout('OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS', 300_000, 600_000);
  const pipInstallTimeoutMs = boundedTimeout('OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS', 300_000, 600_000);
  const providerTimeoutMs = timeoutMs + (2 * npmCiTimeoutMs) + pipInstallTimeoutMs;
  if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs > 3_600_000) fail('Aggregate isolated provider timeout exceeds 3600000 milliseconds.');
  const runtime = requireProviderRuntime(options['--clone-provider-runtime'], options['--clone-provider-runtime-sha256']);
  requireOutside(oldClone.root, runtime, 'Clone provider runtime');
  requireOutside(candidateClone.root, runtime, 'Clone provider runtime');
  const productionBefore = productionSnapshot(productionEnvPath);

  const networkOutput = requireRuntimeSuccess(runRuntime(runtime, ['network', 'inspect', '--format', '{{json .}}', cloneNetwork], { timeoutMs: 30_000 }), 'Clone provider network inspection');
  let network;
  try { network = JSON.parse(networkOutput); } catch { fail('Clone provider network inspection did not return JSON.'); }
  if (network?.Name !== cloneNetwork || network?.Internal !== true || network?.Labels?.['com.lunchlineup.compatibility.clone-id'] !== cloneId) {
    fail('Clone provider network must be internal and exactly owned by the CI clone identity.');
  }

  const containerName = `${cloneId}-compatibility`;
  const oldManifestInProvider = `/old/${relative(oldClone.root, oldClone.manifestFile).split(sep).join('/')}`;
  const candidateManifestInProvider = `/candidate/${relative(candidateClone.root, candidateClone.manifestFile).split(sep).join('/')}`;
  const providerArgs = [
    'run', '--rm', '--name', containerName,
    '--label', `com.lunchlineup.compatibility.clone-id=${cloneId}`,
    '--network', cloneNetwork, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=256',
    '--user', '0:0', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m', '--tmpfs', '/work:rw,nosuid,nodev,size=4096m',
    '--mount', providerMount(oldClone.root, '/old'),
    '--mount', providerMount(candidateClone.root, '/candidate'),
    '--mount', providerMount(cloneEnvPath, '/run/lunchlineup/clone.env'),
    '--env', 'GITHUB_ACTIONS=true', '--env', `GITHUB_REPOSITORY=${cloneIdentity.repository}`,
    '--env', `GITHUB_RUN_ID=${cloneIdentity.runId}`, '--env', `GITHUB_RUN_ATTEMPT=${cloneIdentity.runAttempt}`,
    '--env', `OLD_RELEASE_COMPATIBILITY_TIMEOUT_MS=${timeoutMs}`,
    '--env', `OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS=${npmCiTimeoutMs}`,
    '--env', `OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS=${pipInstallTimeoutMs}`,
    '--env', 'TMPDIR=/work',
    providerImage, 'node', fixedProviderHarness, 'provider',
    '--old-root', '/old', '--old-manifest', oldManifestInProvider, '--old-sha', oldSha,
    '--candidate-root', '/candidate', '--candidate-manifest', candidateManifestInProvider, '--candidate-sha', candidateSha,
    '--clone-env', '/run/lunchlineup/clone.env', '--clone-id', cloneId,
  ];
  const providerExecution = runRuntime(runtime, providerArgs, { timeoutMs: providerTimeoutMs });
  const productionAfter = productionSnapshot(productionEnvPath);
  if (JSON.stringify(productionAfter) !== JSON.stringify(productionBefore)) fail('Production runtime environment digest or metadata changed during isolated compatibility execution.');

  const inspection = runRuntime(runtime, ['container', 'inspect', containerName], { timeoutMs: 30_000 });
  if (inspection.status === 0) {
    runRuntime(runtime, ['rm', '--force', containerName], { timeoutMs: 30_000 });
    fail('Isolated clone provider container survived its bounded execution.');
  }
  const survivors = requireRuntimeSuccess(runRuntime(runtime, ['ps', '--all', '--quiet', '--filter', `label=com.lunchlineup.compatibility.clone-id=${cloneId}`], { timeoutMs: 30_000 }), 'Clone provider survivor inspection');
  if (survivors.trim()) fail('Isolated clone provider left background containers or child survivors.');
  const providerText = requireRuntimeSuccess(providerExecution, 'Isolated clone provider execution').trim();
  let providerResult;
  try { providerResult = JSON.parse(providerText); } catch { fail('Isolated clone provider returned arbitrary text instead of its machine contract.'); }
  const outputs = validateProviderResult(providerResult, {
    oldSha, candidateSha, cloneId,
    schemaExecutableSha256: schemaExecutable.sha256,
    smokePackageSha256: smokePackage.sha256,
    migrationInputSha256: migrationInputs.sha256,
    dependencyIdentity,
  });

  const oldCloneAfter = validateClone(oldClone.root, oldClone.manifestFile, oldSha, 'Old release clone');
  const candidateCloneAfter = validateClone(candidateClone.root, candidateClone.manifestFile, candidateSha, 'Candidate release clone');
  if (oldCloneAfter.identitySha256 !== oldClone.identitySha256 || candidateCloneAfter.identitySha256 !== candidateClone.identitySha256) fail('A release clone identity changed while compatibility evidence was executing.');

  mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });
  chmodSync(evidenceDir, 0o700);
  const schemaOutput = resolve(evidenceDir, 'candidate-schema-output.txt');
  const smokeOutput = resolve(evidenceDir, 'old-release-smoke-output.txt');
  const catalogOutput = resolve(evidenceDir, 'candidate-schema-catalog.txt');
  for (const [path, bytes] of [[schemaOutput, outputs.schema], [smokeOutput, outputs.smoke], [catalogOutput, outputs.catalog]]) {
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  }
  const attestation = {
    version: 3,
    kind: 'lunchlineup-old-release-compatibility-execution', executionPolicy,
    previousReleaseSha: oldSha, candidateReleaseSha: candidateSha,
    previousReleaseClone: oldClone, candidateReleaseClone: candidateClone,
    databaseCloneIdentity: cloneIdentity,
    productionRuntime: { before: productionBefore, after: productionAfter, unchanged: true },
    provider: { image: providerImage, runtimeSha256: requireSha(options['--clone-provider-runtime-sha256'], '--clone-provider-runtime-sha256', 64), network: cloneNetwork, isolation: 'docker-internal-no-production-mount-v1' },
    dependencyPreparation: providerResult.dependencyPreparation,
    candidateSchemaOutput: { path: 'candidate-schema-output.txt', ...fileEvidence(schemaOutput, 'Candidate schema output') },
    oldReleaseSmokeOutput: { path: 'old-release-smoke-output.txt', ...fileEvidence(smokeOutput, 'Old-release smoke output') },
    candidateSchemaCatalog: { path: 'candidate-schema-catalog.txt', ...fileEvidence(catalogOutput, 'Candidate schema catalog') },
    candidateSchemaExecution: providerResult.candidateSchemaExecution,
    schemaVerification: providerResult.schemaVerification,
    oldReleaseSmokeExecution: providerResult.oldReleaseSmokeExecution,
    completedAt: providerResult.completedAt,
  };
  for (const release of [attestation.previousReleaseClone, attestation.candidateReleaseClone]) {
    delete release.root; delete release.manifestFile; delete release.files;
  }
  const attestationPath = resolve(evidenceDir, 'compatibility-execution.json');
  writeFileSync(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(attestationPath, 0o600);
  process.stdout.write(`old_release_compatibility_execution_ok old_sha=${oldSha} candidate_sha=${candidateSha} clone_id=${cloneIdentity.cloneId} evidence_dir=${evidenceDir}\n`);
}

const schemaCatalogSql = `
SELECT COALESCE(json_agg(row_to_json(catalog) ORDER BY kind, identity)::text, '[]')
FROM (
  SELECT 'column'::text AS kind,
         table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '') AS identity
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT 'constraint', n.nspname || '.' || c.relname || '.' || con.conname || ':' || pg_get_constraintdef(con.oid, true)
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index', schemaname || '.' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || '.' || policyname || ':' || permissive || ':' || roles::text || ':' || cmd || ':' || COALESCE(qual, '') || ':' || COALESCE(with_check, '')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'trigger', event_object_schema || '.' || event_object_table || '.' || trigger_name || ':' || action_timing || ':' || event_manipulation || ':' || action_statement
    FROM information_schema.triggers WHERE trigger_schema = 'public'
  UNION ALL
  SELECT 'routine', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
) AS catalog;
`;

function assertNoProviderSurvivors(label) {
  if (process.platform !== 'linux' || process.pid !== 1 || !existsSync('/proc')) return;
  const survivors = readdirSync('/proc')
    .filter((name) => /^[1-9][0-9]*$/.test(name) && Number(name) !== process.pid)
    .filter((name) => {
      try { return readFileSync(`/proc/${name}/stat`, 'utf8').length > 0; } catch { return false; }
    });
  if (survivors.length > 0) fail(`${label} left background child processes in the isolated provider: ${survivors.join(',')}`);
}

function executionClaim(execution, extras) {
  return {
    ...extras,
    exitCode: execution.exitCode,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
  };
}

function provider() {
  const options = parseOptions(new Set([
    '--candidate-manifest', '--candidate-root', '--candidate-sha', '--clone-env', '--clone-id',
    '--old-manifest', '--old-root', '--old-sha',
  ]));
  const oldSha = requireSha(options['--old-sha'], '--old-sha');
  const candidateSha = requireSha(options['--candidate-sha'], '--candidate-sha');
  if (oldSha === candidateSha) fail('Old and candidate release SHAs must differ.');
  const providerHarnessPath = realpathSync(fileURLToPath(import.meta.url));
  const providerHarnessStat = requireRegularFile(providerHarnessPath, 'Provider harness');
  if (providerHarnessPath !== fixedProviderHarness || providerHarnessStat.uid !== 0 || (providerHarnessStat.mode & 0o022) !== 0) {
    fail('Provider harness must execute from its fixed immutable root-owned image path.');
  }
  const oldClone = validateClone(options['--old-root'], options['--old-manifest'], oldSha, 'Old release clone');
  const candidateClone = validateClone(options['--candidate-root'], options['--candidate-manifest'], candidateSha, 'Candidate release clone');
  const sourceDependencyIdentity = dependencyInputs(oldClone, candidateClone);
  const cloneEnvPath = realpathSync(options['--clone-env']);
  const { clone, cloneEnvBytes } = requireCloneEnvironment(cloneEnvPath, null, options['--clone-id']);
  ciCloneIdentity(options['--clone-id'], cloneEnvBytes);
  const timeoutMs = boundedTimeout('OLD_RELEASE_COMPATIBILITY_TIMEOUT_MS', 900_000, 1_800_000);
  const npmCiTimeoutMs = boundedTimeout('OLD_RELEASE_COMPATIBILITY_NPM_CI_TIMEOUT_MS', 300_000, 600_000);
  const pipInstallTimeoutMs = boundedTimeout('OLD_RELEASE_COMPATIBILITY_PIP_INSTALL_TIMEOUT_MS', 300_000, 600_000);

  const scratch = mkdtempSync(resolve(tmpdir(), 'lunchlineup-compatibility-provider-'));
  chmodSync(scratch, 0o700);
  try {
    const oldWorkClone = materializeProviderClone(oldClone, scratch, 'old', 'Provider old-release work clone');
    const candidateWorkClone = materializeProviderClone(candidateClone, scratch, 'candidate', 'Provider candidate work clone');
    const dependencyIdentity = dependencyInputs(oldWorkClone, candidateWorkClone);
    if (
      dependencyIdentity.oldLock.sha256 !== sourceDependencyIdentity.oldLock.sha256
      || dependencyIdentity.candidateLock.sha256 !== sourceDependencyIdentity.candidateLock.sha256
      || dependencyIdentity.requirementsSha256 !== sourceDependencyIdentity.requirementsSha256
    ) fail('Provider dependency work copies are detached from the read-only release contracts.');

    const npmCache = requireImmutableDirectory(fixedProviderNpmCache, 'Provider npm cache');
    const pythonWheelhouse = requireImmutableDirectory(fixedProviderPythonWheelhouse, 'Provider Python wheelhouse');
    const pythonRuntime = resolveProviderPython();
    const pythonSite = resolve(scratch, 'python-site');
    const dependencyEnv = isolatedDependencyEnvironment({ home: scratch, tmpdir: scratch });
    const npmCli = resolveNpmCli();
    const npmArgs = [npmCli, 'ci', '--offline', '--no-audit', '--no-fund', '--cache', npmCache, '--logs-dir', scratch];
    const oldNpmExecution = executeFixed({
      label: 'Provider old-release npm ci', command: process.execPath, args: npmArgs,
      cwd: oldWorkClone.root, env: dependencyEnv, output: resolve(scratch, 'old-npm-ci-output.txt'), timeoutMs: npmCiTimeoutMs,
    });
    assertNoProviderSurvivors('Old-release npm dependency preparation');
    const candidateNpmExecution = executeFixed({
      label: 'Provider candidate npm ci', command: process.execPath, args: npmArgs,
      cwd: candidateWorkClone.root, env: dependencyEnv, output: resolve(scratch, 'candidate-npm-ci-output.txt'), timeoutMs: npmCiTimeoutMs,
    });
    assertNoProviderSurvivors('Candidate npm dependency preparation');
    const pythonExecution = executeFixed({
      label: 'Provider old-release Python dependency install', command: pythonRuntime,
      args: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-index', '--find-links', pythonWheelhouse,
        '--target', pythonSite, '-r', 'apps/engine/requirements.txt', '-r', 'apps/worker/requirements.txt'],
      cwd: oldWorkClone.root, env: dependencyEnv, output: resolve(scratch, 'old-python-install-output.txt'), timeoutMs: pipInstallTimeoutMs,
    });
    assertNoProviderSurvivors('Old-release Python dependency preparation');

    const preparedOldClone = validateClone(oldWorkClone.root, oldWorkClone.manifestFile, oldSha, 'Prepared provider old-release work clone');
    const preparedCandidateClone = validateClone(candidateWorkClone.root, candidateWorkClone.manifestFile, candidateSha, 'Prepared provider candidate work clone');
    if (
      preparedOldClone.identitySha256 !== oldWorkClone.identitySha256
      || preparedCandidateClone.identitySha256 !== candidateWorkClone.identitySha256
    ) fail('Dependency preparation changed a contract-bound release byte inside the isolated provider.');
    const schemaExecutable = requireContractFile(preparedCandidateClone, fixedSchemaPath, 'Candidate schema executable');
    const schemaModel = requireContractFile(preparedCandidateClone, fixedSchemaModelPath, 'Candidate Prisma schema');
    const smokePackage = requireContractFile(preparedOldClone, fixedSmokePackagePath, 'Old-release smoke package');
    const packageJson = readJson(smokePackage.path, 'Old-release package.json');
    if (packageJson?.scripts?.['test:integration'] !== fixedSmokeScript) fail(`Old release package.json must own the fixed test:integration command: ${fixedSmokeScript}`);
    const env = childEnvironment(clone, { home: scratch, tmpdir: scratch, pythonPath: pythonSite });
    const compatibilityDeadline = Date.now() + timeoutMs;
    const schemaOutput = resolve(scratch, 'candidate-schema-output.txt');
    const diffOutput = resolve(scratch, 'candidate-schema-diff-output.txt');
    const catalogOutput = resolve(scratch, 'candidate-schema-catalog.txt');
    const smokeOutput = resolve(scratch, 'old-release-smoke-output.txt');
    const schemaExecution = executeFixed({
      label: 'Fixed candidate schema execution', command: process.execPath, args: [schemaExecutable.path],
      cwd: preparedCandidateClone.root, env, output: schemaOutput,
      timeoutMs: remainingTimeout(compatibilityDeadline, 'Candidate schema execution'),
    });
    assertNoProviderSurvivors('Candidate schema execution');

    const prismaCli = fixedProviderPrismaCli;
    const prismaStat = requireRegularFile(prismaCli, 'Provider Prisma CLI');
    if (prismaStat.uid !== 0 || (prismaStat.mode & 0o022) !== 0) fail('Provider Prisma CLI must be immutable and root-owned.');
    const schemaDiff = executeFixed({
      label: 'Fixed candidate schema fingerprint diff', command: process.execPath,
      args: [prismaCli, 'migrate', 'diff', '--from-url', clone.MIGRATION_DATABASE_URL, '--to-schema-datamodel', schemaModel.path, '--exit-code'],
      cwd: preparedCandidateClone.root, env, output: diffOutput,
      timeoutMs: remainingTimeout(compatibilityDeadline, 'Candidate schema fingerprint diff'),
    });
    assertNoProviderSurvivors('Candidate schema fingerprint diff');
    const catalogExecution = executeFixed({
      label: 'Fixed candidate schema catalog fingerprint', command: 'psql',
      args: ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--tuples-only', '--no-align', '--quiet', '--dbname', clone.MIGRATION_DATABASE_URL, '--command', schemaCatalogSql],
      cwd: scratch, env, output: catalogOutput,
      timeoutMs: remainingTimeout(compatibilityDeadline, 'Candidate schema catalog fingerprint'),
    });
    assertNoProviderSurvivors('Candidate schema catalog fingerprint');
    const catalogEvidence = fileEvidence(catalogOutput, 'Candidate schema catalog fingerprint');
    const migrationInputs = migrationInputIdentity(preparedCandidateClone);

    const smokeExecution = executeFixed({
      label: 'Fixed old-release integration smoke', command: process.execPath, args: [npmCli, 'run', 'test:integration'],
      cwd: preparedOldClone.root, env, output: smokeOutput,
      timeoutMs: remainingTimeout(compatibilityDeadline, 'Old-release integration smoke'),
    });
    assertNoProviderSurvivors('Old-release integration smoke');
    const oldCloneAfter = validateClone(oldClone.root, oldClone.manifestFile, oldSha, 'Old release clone');
    const candidateCloneAfter = validateClone(candidateClone.root, candidateClone.manifestFile, candidateSha, 'Candidate release clone');
    if (oldCloneAfter.identitySha256 !== oldClone.identitySha256 || candidateCloneAfter.identitySha256 !== candidateClone.identitySha256) fail('A release clone identity changed inside the isolated provider.');

    const result = {
      version: 1, kind: providerKind, executionPolicy,
      previousReleaseSha: oldSha, candidateReleaseSha: candidateSha, cloneId: options['--clone-id'],
      dependencyPreparation: {
        isolation: 'provider-local-contract-copies-v1',
        environment: 'production-runtime-and-clone-command-absent-v1',
        network: 'clone-internal-offline-caches-only-v1',
        oldNpm: executionClaim(oldNpmExecution, {
          command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'], packageLockSha256: dependencyIdentity.oldLock.sha256,
        }),
        candidateNpm: executionClaim(candidateNpmExecution, {
          command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'], packageLockSha256: dependencyIdentity.candidateLock.sha256,
        }),
        oldPython: executionClaim(pythonExecution, {
          command: ['python3', '-m', 'pip', 'install', '--no-index', '--target', '<provider-python-site>', '-r', 'apps/engine/requirements.txt', '-r', 'apps/worker/requirements.txt'],
          requirementsSha256: dependencyIdentity.requirementsSha256,
        }),
      },
      candidateSchemaExecution: executionClaim(schemaExecution, { command: ['node', fixedSchemaPath], executableSha256: schemaExecutable.sha256 }),
      schemaVerification: {
        status: 'exact-candidate-schema',
        command: ['prisma', 'migrate', 'diff', '--from-url', '<isolated-clone>', '--to-schema-datamodel', fixedSchemaModelPath, '--exit-code'],
        prismaDiffExitCode: schemaDiff.exitCode,
        catalogCommand: ['psql', 'fixed-public-schema-catalog-v1'],
        catalogSha256: catalogEvidence.sha256,
        catalogBytes: catalogEvidence.bytes,
        migrationInputSha256: migrationInputs.sha256,
      },
      oldReleaseSmokeExecution: executionClaim(smokeExecution, {
        command: ['npm', 'run', 'test:integration'], packageSha256: smokePackage.sha256, packageScript: fixedSmokeScript,
      }),
      outputs: {
        candidateSchema: readFileSync(schemaOutput).toString('base64'),
        schemaCatalog: readFileSync(catalogOutput).toString('base64'),
        oldReleaseSmoke: readFileSync(smokeOutput).toString('base64'),
      },
      completedAt: smokeExecution.completedAt,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function validateCloneIdentity(identity) {
  if (
    identity?.owner !== 'github-actions'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository ?? '')
    || !/^[1-9][0-9]*$/.test(identity.runId ?? '')
    || !/^[1-9][0-9]*$/.test(identity.runAttempt ?? '')
    || !new RegExp(`^llc-${identity.runId}-${identity.runAttempt}-[a-f0-9]{12}$`).test(identity.cloneId ?? '')
  ) fail('Database clone identity is not owned by the attested GitHub Actions run.');
  requireSha(identity.credentialSha256, 'databaseCloneIdentity.credentialSha256', 64);
  return identity;
}

function validateExecutionClaim(claim, expected) {
  if (JSON.stringify(claim?.command) !== JSON.stringify(expected.command)) fail(`${expected.label} command is not repository-fixed.`);
  if (claim.exitCode !== 0 || !Number.isFinite(Date.parse(claim.startedAt ?? '')) || !Number.isFinite(Date.parse(claim.completedAt ?? ''))) {
    fail(`${expected.label} execution claim is invalid.`);
  }
  requireSha(claim[expected.digestKey], `${expected.label} executable digest`, 64);
  if (expected.packageScript && claim.packageScript !== expected.packageScript) fail(`${expected.label} package script changed.`);
}

function finalize() {
  const options = parseOptions(new Set(['--attestation', '--evidence-uri', '--output']));
  const attestationPath = realpathSync(options['--attestation']);
  const evidenceUri = options['--evidence-uri'];
  const output = resolve(options['--output']);
  if (existsSync(output)) fail('--output must not already exist.');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*\/artifacts\/[1-9][0-9]*$/.test(evidenceUri)) {
    fail('--evidence-uri must be the immutable URL emitted by actions/upload-artifact.');
  }
  requireRegularFile(attestationPath, 'Compatibility execution attestation');
  const attestation = readJson(attestationPath, 'Compatibility execution attestation');
  if (attestation?.version !== 3 || attestation.kind !== 'lunchlineup-old-release-compatibility-execution' || attestation.executionPolicy !== executionPolicy) {
    fail('Compatibility execution attestation kind, version, or execution policy is invalid.');
  }
  const evidenceDir = dirname(attestationPath);
  for (const [claim, label] of [
    [attestation.candidateSchemaOutput, 'Candidate schema executable output'],
    [attestation.candidateSchemaCatalog, 'Candidate schema catalog output'],
    [attestation.oldReleaseSmokeOutput, 'Old-release smoke executable output'],
  ]) {
    const parts = safeRelativePath(claim?.path, `${label} path`);
    const path = resolve(evidenceDir, ...parts);
    requireInside(evidenceDir, path, label);
    const actual = fileEvidence(path, label);
    if (actual.sha256 !== requireSha(claim.sha256, `${label} digest`, 64) || actual.bytes !== claim.bytes) {
      fail(`${label} changed after executable evidence collection.`);
    }
  }
  const previousSha = requireSha(attestation.previousReleaseSha, 'previousReleaseSha');
  const candidateSha = requireSha(attestation.candidateReleaseSha, 'candidateReleaseSha');
  if (previousSha === candidateSha) fail('Compatibility execution release SHAs must differ.');
  for (const [clone, sha, label] of [
    [attestation.previousReleaseClone, previousSha, 'previousReleaseClone'],
    [attestation.candidateReleaseClone, candidateSha, 'candidateReleaseClone'],
  ]) {
    if (clone?.sourceSha !== sha) fail(`${label} source SHA is detached.`);
    requireSha(clone.manifestSha256, `${label}.manifestSha256`, 64);
    requireSha(clone.deploymentBundleSha256, `${label}.deploymentBundleSha256`, 64);
    const identitySha256 = requireSha(clone.identitySha256, `${label}.identitySha256`, 64);
    const expectedIdentitySha256 = sha256(Buffer.from(JSON.stringify({
      sourceSha: sha,
      manifestSha256: clone.manifestSha256,
      deploymentBundleSha256: clone.deploymentBundleSha256,
    })));
    if (identitySha256 !== expectedIdentitySha256) fail(`${label} immutable identity digest is detached.`);
  }
  const cloneIdentity = validateCloneIdentity(attestation.databaseCloneIdentity);
  const productionRuntime = attestation.productionRuntime;
  if (productionRuntime?.unchanged !== true || JSON.stringify(productionRuntime.before) !== JSON.stringify(productionRuntime.after)) {
    fail('Production runtime environment digest and metadata were not proven unchanged.');
  }
  const productionRuntimeSha256 = requireSha(productionRuntime.before?.sha256, 'productionRuntime.before.sha256', 64);
  if (attestation.provider?.isolation !== 'docker-internal-no-production-mount-v1'
    || !/^[A-Za-z0-9._/:=-]+@sha256:[a-f0-9]{64}$/.test(attestation.provider.image ?? '')
    || !/^[a-f0-9]{64}$/.test(attestation.provider.runtimeSha256 ?? '')
    || attestation.provider.network !== `${cloneIdentity.cloneId}-network`) {
    fail('Compatibility provider isolation claim is invalid.');
  }
  validateExecutionClaim(attestation.candidateSchemaExecution, {
    label: 'Candidate schema',
    command: ['node', fixedSchemaPath],
    digestKey: 'executableSha256',
  });
  validateExecutionClaim(attestation.oldReleaseSmokeExecution, {
    label: 'Old-release smoke',
    command: ['npm', 'run', 'test:integration'],
    digestKey: 'packageSha256',
    packageScript: fixedSmokeScript,
  });
  if (
    attestation.schemaVerification?.status !== 'exact-candidate-schema'
    || attestation.schemaVerification?.prismaDiffExitCode !== 0
    || JSON.stringify(attestation.schemaVerification.command) !== JSON.stringify([
      'prisma', 'migrate', 'diff', '--from-url', '<isolated-clone>', '--to-schema-datamodel', fixedSchemaModelPath, '--exit-code',
    ])
    || JSON.stringify(attestation.schemaVerification.catalogCommand) !== JSON.stringify(['psql', 'fixed-public-schema-catalog-v1'])
    || requireSha(attestation.schemaVerification.catalogSha256, 'schemaVerification.catalogSha256', 64) !== attestation.candidateSchemaCatalog.sha256
    || attestation.schemaVerification.catalogBytes !== attestation.candidateSchemaCatalog.bytes
  ) fail('Candidate schema fingerprint evidence is invalid or detached.');
  requireSha(attestation.schemaVerification.migrationInputSha256, 'schemaVerification.migrationInputSha256', 64);
  const completedAt = Date.parse(attestation.completedAt ?? '');
  if (!Number.isFinite(completedAt) || Date.now() - completedAt > 3_600_000 || completedAt > Date.now() + 300_000) {
    fail('Compatibility executable evidence is stale or future-dated.');
  }

  const proof = {
    version: 1,
    status: 'passed',
    previousReleaseSha: previousSha,
    candidateReleaseSha: candidateSha,
    previousReleaseClone: attestation.previousReleaseClone,
    candidateReleaseClone: attestation.candidateReleaseClone,
    database: {
      isolatedClone: true,
      productionMutated: false,
      cloneIdentity,
      productionRuntimeSha256,
      productionRuntimeMetadataUnchanged: true,
      provider: attestation.provider,
    },
    candidateSchema: {
      applied: attestation.schemaVerification.status === 'exact-candidate-schema'
        && attestation.schemaVerification.prismaDiffExitCode === 0,
      command: attestation.candidateSchemaExecution.command,
      executableSha256: attestation.candidateSchemaExecution.executableSha256,
      outputSha256: attestation.candidateSchemaOutput.sha256,
      outputBytes: attestation.candidateSchemaOutput.bytes,
      verification: {
        status: attestation.schemaVerification.status,
        catalogSha256: attestation.schemaVerification.catalogSha256,
        catalogBytes: attestation.schemaVerification.catalogBytes,
        migrationInputSha256: attestation.schemaVerification.migrationInputSha256,
        prismaDiffExitCode: attestation.schemaVerification.prismaDiffExitCode,
      },
    },
    oldReleaseSmoke: {
      status: 'passed',
      command: attestation.oldReleaseSmokeExecution.command,
      packageSha256: attestation.oldReleaseSmokeExecution.packageSha256,
      outputSha256: attestation.oldReleaseSmokeOutput.sha256,
      outputBytes: attestation.oldReleaseSmokeOutput.bytes,
    },
    execution: { policy: executionPolicy },
    completedAt: attestation.completedAt,
    evidenceUri,
  };
  writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(output, 0o600);
  process.stdout.write(`old_release_compatibility_proof_ok old_sha=${previousSha} candidate_sha=${candidateSha} evidence_uri=${evidenceUri}\n`);
}

function main() {
  const mode = process.argv[2];
  if (mode === 'preflight') return preflight();
  if (mode === 'run') return run();
  if (mode === 'provider') return provider();
  if (mode === 'finalize') return finalize();
  fail('Usage: old-release-compatibility-harness.mjs preflight|run|provider|finalize [options]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
