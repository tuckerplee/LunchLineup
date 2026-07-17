#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const retainedContractProfile = 'lunchlineup-release-rollback-compatibility-v2';
export const retainedExactFiles = [
  '.github/workflows/ci.yml',
  'docker-compose.yml',
  'package-lock.json',
  'package.json',
  'turbo.json',
  'apps/api/package.json',
  'apps/api/tsconfig.build.json',
  'apps/api/tsconfig.json',
  'apps/api/vitest.config.ts',
  'apps/control-plane/package.json',
  'apps/web/package.json',
  'packages/config/package.json',
  'packages/db/package.json',
  'packages/rbac/package.json',
  'packages/testing/package.json',
];
export const retainedDirectoryRoots = [
  'apps/api/src',
  'apps/engine',
  'apps/worker',
  'infrastructure',
  'packages/config',
  'packages/db',
  'packages/rbac',
  'packages/shared-types',
  'packages/testing',
  'scripts',
  'tests/integration',
];
export const requiredRetainedPaths = [
  '.github/workflows/ci.yml',
  'apps/api/package.json',
  'apps/api/tsconfig.json',
  'apps/control-plane/package.json',
  'apps/engine/requirements.txt',
  'apps/web/package.json',
  'apps/worker/requirements.txt',
  'docker-compose.yml',
  'infrastructure/systemd/lunchlineup-backup.service',
  'infrastructure/systemd/lunchlineup-backup.timer',
  'infrastructure/systemd/lunchlineup-pitr-base-backup.service',
  'infrastructure/systemd/lunchlineup-pitr-base-backup.timer',
  'package-lock.json',
  'package.json',
  'packages/config/package.json',
  'packages/db/package.json',
  'packages/db/prisma/schema.prisma',
  'packages/rbac/package.json',
  'packages/testing/package.json',
  'scripts/apply-db-migrations.mjs',
  'scripts/deploy-vm217-remote.sh',
  'scripts/old-release-compatibility-harness.mjs',
  'scripts/rollback-vm217-transport.sh',
  'scripts/verify-backup-readiness.sh',
  'scripts/verify-old-release-compatibility.mjs',
  'scripts/verify-release-artifacts.mjs',
  'scripts/vm217-transport-deadlines.sh',
  'scripts/write-deployment-contract.mjs',
  'tests/integration/ephemeral-stack.test.mjs',
];
const rawMigrationPrefix = 'packages/db/prisma/migrations/';
const forbiddenSegments = new Set([
  '.git', '.next', '.pytest_cache', '.release', '.terraform', '.turbo', '.venv', '__pycache__', 'coverage', 'dist', 'node_modules', 'venv',
]);
const forbiddenBasenames = new Set(['.env', '.env.production', 'runtime.env']);
const maxRetainedFileBytes = 8 * 1024 * 1024;
const maxRetainedBundleInputBytes = 64 * 1024 * 1024;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathInventorySha256(paths) {
  return sha256(Buffer.from(`${paths.join('\n')}\n`));
}

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function pathIsSelected(path) {
  return retainedExactFiles.includes(path)
    || retainedDirectoryRoots.some((directory) => path.startsWith(`${directory}/`));
}

function assertRetainablePath(path) {
  const segments = path.split('/');
  const basename = segments.at(-1);
  if (
    !pathIsSelected(path)
    || segments.some((segment) => forbiddenSegments.has(segment))
    || forbiddenBasenames.has(basename)
    || /README\.md$/i.test(path)
    || /\.(?:key|log|p12|pem|pyc|sigstore\.json|tar|tgz|tmp|zip)$/i.test(basename)
    || /(?:^|\/)terraform\.tfstate(?:\.backup)?$/i.test(path)
    || /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(path)
  ) throw new Error(`Deployment contract refuses generated, secret-bearing, or unselected path: ${path}`);
}

function filesUnder(root, path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Deployment contract refuses symbolic links: ${path}`);
  if (stat.isFile()) {
    const relativePath = normalizedRelativePath(root, path);
    assertRetainablePath(relativePath);
    if (stat.size > maxRetainedFileBytes) throw new Error(`Deployment contract input exceeds the per-file byte limit: ${relativePath}`);
    return [path];
  }
  if (!stat.isDirectory()) throw new Error(`Deployment contract supports only regular files and directories: ${path}`);
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => !forbiddenSegments.has(entry.name) && !/README\.md$/i.test(entry.name) && !entry.name.endsWith('.pyc'))
    .flatMap((entry) => filesUnder(root, join(path, entry.name)));
}

function deploymentFiles(root) {
  const inputs = [...retainedExactFiles, ...retainedDirectoryRoots];
  const paths = [...new Set(inputs.flatMap((entry) => filesUnder(root, resolve(root, entry))))];
  const files = paths
    .map((file) => ({
      path: normalizedRelativePath(root, file),
      bytes: readFileSync(file),
    }))
    .sort((left, right) => comparePaths(left.path, right.path));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > maxRetainedBundleInputBytes) {
    throw new Error(`Deployment contract inputs exceed the ${maxRetainedBundleInputBytes}-byte aggregate limit.`);
  }
  if (process.env.RELEASE_REQUIRE_TRACKED_INPUTS === 'true') {
    const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('Deployment contract could not read the tracked Git inventory.');
    const tracked = new Set(result.stdout.toString('utf8').split('\0').filter(Boolean));
    const untracked = files.find((file) => !tracked.has(file.path));
    if (untracked) throw new Error(`Deployment contract refuses an untracked retained input: ${untracked.path}`);
  }
  return files;
}

function inventoryGroups(paths) {
  return {
    integrationSupport: paths.filter((path) => path.startsWith('tests/integration/') && path.endsWith('.mjs')),
    integrationTests: paths.filter((path) => path.startsWith('tests/integration/') && path.endsWith('.test.mjs')),
    systemdUnits: paths.filter((path) => path.startsWith('infrastructure/systemd/') && /\.(?:service|timer)$/.test(path)),
    workspaceManifests: paths.filter((path) => path !== 'package.json' && /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)),
  };
}

export function validateRetainedDeploymentContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || contract.algorithm !== 'sha256') {
    throw new Error('Retained deployment contract must use SHA-256.');
  }
  if (contract.bundle?.format !== 'lunchlineup-deployment-contract-json-v2') {
    throw new Error('Retained deployment contract bundle format is unsupported.');
  }
  const files = contract.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Retained deployment contract file inventory is required.');
  const paths = Object.keys(files);
  const sortedPaths = [...paths].sort(comparePaths);
  if (paths.length === 0 || paths.some((path, index) => path !== sortedPaths[index])) {
    throw new Error('Retained deployment contract file inventory must be nonempty and canonically ordered.');
  }
  for (const path of paths) {
    assertRetainablePath(path);
    if (!/^[a-f0-9]{64}$/.test(files[path])) throw new Error(`Retained deployment contract digest is invalid: ${path}`);
  }
  for (const path of requiredRetainedPaths) {
    if (!Object.hasOwn(files, path)) throw new Error(`Retained deployment contract is missing required rollback input: ${path}`);
  }
  const retention = contract.retention;
  if (
    retention?.version !== 2
    || retention.profile !== retainedContractProfile
    || retention.pathCount !== paths.length
    || retention.pathsSha256 !== pathInventorySha256(paths)
    || JSON.stringify(retention.selection) !== JSON.stringify({ exactFiles: retainedExactFiles, directoryRoots: retainedDirectoryRoots })
    || JSON.stringify(retention.groups) !== JSON.stringify(inventoryGroups(paths))
  ) throw new Error('Retained deployment contract selection or generated path inventory is invalid.');
  if (retention.groups.integrationTests.length === 0 || retention.groups.systemdUnits.length === 0 || retention.groups.workspaceManifests.length === 0) {
    throw new Error('Retained deployment contract generated groups must not be empty.');
  }
  return { paths, retention };
}

export function buildDeploymentContractBundle(root = defaultRoot) {
  const files = deploymentFiles(root);
  const paths = files.map((file) => file.path);
  const bytes = Buffer.from(JSON.stringify({
    version: 2,
    files: files.map((file) => ({ path: file.path, contentsBase64: file.bytes.toString('base64') })),
  }));
  const contract = {
    algorithm: 'sha256',
    bundle: {
      format: 'lunchlineup-deployment-contract-json-v2',
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
    retention: {
      version: 2,
      profile: retainedContractProfile,
      pathCount: paths.length,
      pathsSha256: pathInventorySha256(paths),
      selection: { exactFiles: retainedExactFiles, directoryRoots: retainedDirectoryRoots },
      groups: inventoryGroups(paths),
    },
    files: Object.fromEntries(files.map((file) => [
      file.path,
      sha256(file.bytes),
    ])),
    rawMigrations: {
      version: 1,
      files: Object.fromEntries(files
        .filter((file) => file.path.startsWith(rawMigrationPrefix) && file.path.endsWith('.sql'))
        .map((file) => [file.path, sha256(file.bytes)])),
    },
  };
  validateRetainedDeploymentContract(contract);
  return { bytes, contract };
}

export function buildDeploymentContract(root = defaultRoot) {
  return buildDeploymentContractBundle(root).contract;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundleOutputIndex = process.argv.indexOf('--bundle-output');
  const unsupported = process.argv.slice(2).filter((arg, index, args) => arg !== '--bundle-output' && args[index - 1] !== '--bundle-output');
  if (unsupported.length > 0 || (bundleOutputIndex !== -1 && !process.argv[bundleOutputIndex + 1])) {
    console.error('Usage: node scripts/write-deployment-contract.mjs [--bundle-output PATH]');
    process.exit(64);
  }
  const { bytes, contract } = buildDeploymentContractBundle();
  if (bundleOutputIndex !== -1) {
    const output = resolve(process.argv[bundleOutputIndex + 1]);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, bytes, { mode: 0o600 });
    chmodSync(output, 0o600);
  }
  process.stdout.write(JSON.stringify(contract));
}
