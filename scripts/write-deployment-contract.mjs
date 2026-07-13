#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractRoots = [
  '.github/workflows/ci.yml',
  'docker-compose.yml',
  'infrastructure/alertmanager',
  'infrastructure/caddy',
  'infrastructure/control',
  'infrastructure/grafana',
  'infrastructure/loki',
  'infrastructure/otel-collector',
  'infrastructure/postgres',
  'infrastructure/prometheus',
  'infrastructure/promtail',
  'infrastructure/redis',
  'infrastructure/tempo',
  'packages/db/prisma/migrations',
  'scripts',
];

const rawMigrationPrefix = 'packages/db/prisma/migrations/';

function filesUnder(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Deployment contract refuses symbolic links: ${path}`);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`Deployment contract supports only regular files and directories: ${path}`);
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== '__pycache__' && !entry.name.endsWith('.pyc'))
    .flatMap((entry) => filesUnder(join(path, entry.name)))
    .filter((file) => !/README\.md$/i.test(file));
}

function deploymentFiles(root) {
  return contractRoots
    .flatMap((entry) => filesUnder(resolve(root, entry)))
    .map((file) => ({
      path: relative(root, file).split(sep).join('/'),
      bytes: readFileSync(file),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function buildDeploymentContractBundle(root = defaultRoot) {
  const files = deploymentFiles(root);
  const bytes = Buffer.from(JSON.stringify({
    version: 1,
    files: files.map((file) => ({ path: file.path, contentsBase64: file.bytes.toString('base64') })),
  }));
  const contract = {
    algorithm: 'sha256',
    bundle: {
      format: 'lunchlineup-deployment-contract-json-v1',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
    files: Object.fromEntries(files.map((file) => [
      file.path,
      createHash('sha256').update(file.bytes).digest('hex'),
    ])),
    rawMigrations: {
      version: 1,
      files: Object.fromEntries(files
        .filter((file) => file.path.startsWith(rawMigrationPrefix) && file.path.endsWith('.sql'))
        .map((file) => [file.path, createHash('sha256').update(file.bytes).digest('hex')])),
    },
  };
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
