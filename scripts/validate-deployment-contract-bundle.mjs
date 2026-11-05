// Pure validation of existing retained v2 bundle bytes; no materialization or acceptance.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { validateRetainedDeploymentContract } from './write-deployment-contract.mjs';
const fail = message => { throw new Error(message); };

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) fail(`${label} must be a non-empty single-line string.`);
  return value;
}

function decode(value, label) {
  requireString(value, label);
  let bytes;
  try { bytes = Buffer.from(value, 'base64'); }
  catch { fail(`${label} is not valid base64.`); }
  if (bytes.length === 0 || bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) fail(`${label} is not canonical base64.`);
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireSha(value, label, length) {
  const normalized = requireString(value, label).toLowerCase();
  const pattern = length === 40 ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!pattern.test(normalized)) fail(`${label} must be a ${length}-character lowercase hexadecimal value.`);
  return normalized;
}

function requireSafeBundlePath(value, label) {
  const path = requireString(value, label);
  if (
    path.length > 512
    || path.includes('\\')
    || path.includes('\0')
    || /^[a-zA-Z]:/.test(path)
    || path.startsWith('/')
    || posix.normalize(path) !== path
    || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) fail(`${label} is not a safe normalized relative path.`);
  return path;
}

export function validateDeploymentContractBundle(deploymentContract, bundleBytes) {
  try { validateRetainedDeploymentContract(deploymentContract); } catch (error) {
    fail(`Retained deployment contract is insufficient: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Buffer.isBuffer(bundleBytes)) fail('Deployment contract bundle bytes must be a Buffer.');
  const bundleSha = requireSha(deploymentContract.bundle.sha256, 'releaseManifest.deploymentContract.bundle.sha256', 64);
  if (sha256(bundleBytes) !== bundleSha) fail('Deployment contract bundle does not match the SHA-256 bound into releaseManifest.');
  if (!Number.isSafeInteger(deploymentContract.bundle.bytes) || deploymentContract.bundle.bytes !== bundleBytes.length) {
    fail('Deployment contract bundle byte count does not match releaseManifest.');
  }
  let bundle;
  try {
    bundle = JSON.parse(bundleBytes.toString('utf8'));
  } catch {
    fail('deploymentContractBundleBase64 must decode to JSON.');
  }
  if (!bundle || typeof bundle !== 'object' || bundle.version !== 2 || !Array.isArray(bundle.files)) {
    fail('Deployment contract bundle must be a version 2 file archive.');
  }
  const contractFiles = deploymentContract.files;
  if (!contractFiles || typeof contractFiles !== 'object' || Array.isArray(contractFiles) || Object.keys(contractFiles).length === 0) {
    fail('releaseManifest.deploymentContract.files is required.');
  }
  const rawMigrations = deploymentContract.rawMigrations;
  if (!rawMigrations || rawMigrations.version !== 1 || !rawMigrations.files || typeof rawMigrations.files !== 'object' || Array.isArray(rawMigrations.files)) {
    fail('releaseManifest.deploymentContract.rawMigrations version 1 inventory is required.');
  }
  for (const [path, digest] of Object.entries(rawMigrations.files)) {
    requireSafeBundlePath(path, `releaseManifest.deploymentContract.rawMigrations.files path ${path}`);
    if (!path.startsWith('packages/db/prisma/migrations/') || !path.endsWith('.sql')) {
      fail(`Raw migration inventory contains a non-migration path: ${path}`);
    }
    if (contractFiles[path] !== digest) fail(`Raw migration inventory digest does not match deploymentContract.files: ${path}`);
  }
  for (const path of Object.keys(contractFiles).filter((path) => path.startsWith('packages/db/prisma/migrations/') && path.endsWith('.sql'))) {
    if (rawMigrations.files[path] !== contractFiles[path]) fail(`Raw migration inventory is missing deployment contract SQL: ${path}`);
  }
  const materializedFiles = new Map();
  for (const [index, entry] of bundle.files.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`bundle.files[${index}] must be an object.`);
    const path = requireSafeBundlePath(entry.path, `bundle.files[${index}].path`);
    if (materializedFiles.has(path)) fail(`Deployment contract bundle contains duplicate path: ${path}`);
    if (!Object.hasOwn(contractFiles, path)) fail(`Deployment contract bundle contains unmanifested path: ${path}`);
    const bytes = decode(entry.contentsBase64, `bundle.files[${index}].contentsBase64`);
    const expectedSha = requireSha(contractFiles[path], `releaseManifest.deploymentContract.files[${path}]`, 64);
    if (sha256(bytes) !== expectedSha) fail(`Deployment contract bundle file hash mismatch: ${path}`);
    materializedFiles.set(path, bytes);
  }
  for (const rawPath of Object.keys(contractFiles)) {
    const path = requireSafeBundlePath(rawPath, `releaseManifest.deploymentContract.files path ${rawPath}`);
    if (!materializedFiles.has(path)) fail(`Deployment contract bundle is missing manifest path: ${path}`);
  }
  return { materializedFiles, bundleSha };
}
