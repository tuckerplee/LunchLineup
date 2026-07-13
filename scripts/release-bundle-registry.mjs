#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRuntimeSecretDescriptor } from './rehydrate-runtime-secret.mjs';

function fail(message) { throw new Error(message); }
function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) fail(`${name} is required.`);
  return process.argv[index + 1];
}
function runResult(command, args) { return spawnSync(command, args, { encoding: 'utf8' }); }
function options(name) {
  return process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
}
function run(command, args) {
  const result = runResult(command, args);
  if (result.error || result.status !== 0) fail(`${command} failed while accessing the release registry.`);
  return result.stdout;
}
function base(uri) { return uri.replace(/\/+$/, ''); }
function localPath(uri, suffix) {
  if (!uri.startsWith('file://') || process.env.ALLOW_LOCAL_RELEASE_REGISTRY !== 'true') return null;
  return join(resolve(fileURLToPath(uri)), ...suffix.split('/'));
}
function s3Location(uri, suffix) {
  const parsed = new URL(uri);
  return { bucket: parsed.hostname, key: `${parsed.pathname.replace(/^\/+|\/+$/g, '')}/${suffix}`.replace(/^\//, '') };
}
function objectExists(uri, suffix) {
  const local = localPath(uri, suffix);
  if (local) return existsSync(local);
  if (uri.startsWith('s3://')) {
    const { bucket, key } = s3Location(uri, suffix);
    const result = runResult('aws', ['s3api', 'head-object', '--bucket', bucket, '--key', key]);
    if (!result.error && result.status === 0) return true;
    if (result.status === 254 || /Not Found|404|NoSuchKey/i.test(result.stderr ?? '')) return false;
    fail('Unable to determine whether the release registry object exists.');
  }
  fail('Registry bootstrap requires s3://, or file:// in explicit local tests.');
}
function download(uri, suffix, output) {
  const local = localPath(uri, suffix);
  if (local) return copyFileSync(local, output);
  if (uri.startsWith('s3://')) return run('aws', ['s3', 'cp', `${base(uri)}/${suffix}`, output]);
  if (uri.startsWith('rclone:')) return run('rclone', ['copyto', `${base(uri)}/${suffix}`, output]);
  fail('Release registry URI must use s3:// or rclone:.');
}
async function downloadRetained(uri, output) {
  if (uri.startsWith('file://') && process.env.ALLOW_LOCAL_RELEASE_REGISTRY === 'true') {
    return copyFileSync(resolve(fileURLToPath(uri)), output);
  }
  if (uri.startsWith('s3://')) return run('aws', ['s3', 'cp', uri, output]);
  if (uri.startsWith('https://')) {
    const response = await fetch(uri, { cache: 'no-store', redirect: 'error', headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) fail(`Retained release bundle download returned HTTP ${response.status}.`);
    return writeFileSync(output, Buffer.from(await response.arrayBuffer()), { mode: 0o600, flag: 'wx' });
  }
  fail('Retained release bundle URI must use https:// or s3://. file:// is allowed only in explicit local tests.');
}
function upload(uri, suffix, input, immutable = false) {
  const local = localPath(uri, suffix);
  if (local) {
    mkdirSync(dirname(local), { recursive: true });
    if (immutable) writeFileSync(local, readFileSync(input), { flag: 'wx', mode: 0o600 });
    else copyFileSync(input, local);
    return;
  }
  if (immutable && uri.startsWith('s3://')) {
    const { bucket, key } = s3Location(uri, suffix);
    run('aws', ['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', input, '--if-none-match', '*']);
    return;
  }
  if (uri.startsWith('s3://')) return run('aws', ['s3', 'cp', input, `${base(uri)}/${suffix}`]);
  if (!immutable && uri.startsWith('rclone:')) return run('rclone', ['copyto', input, `${base(uri)}/${suffix}`]);
  fail('Immutable release publication requires s3:// in production.');
}
function validateState(path) {
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const state = JSON.parse(text);
  if (state.version !== 2 || !/^[a-f0-9]{40}$/.test(state.sourceSha ?? '') || state.releaseManifest?.sourceSha !== state.sourceSha) {
    fail('Release bundle state must use the secret-free version 2 contract.');
  }
  validateRuntimeSecretDescriptor(state.runtimeSecret);
  for (const forbidden of ['runtimeEnvBase64', 'runtimeBytes', 'productionRuntimeEnv', 'PRODUCTION_RUNTIME_ENV_B64']) {
    if (Object.hasOwn(state, forbidden) || text.includes(`"${forbidden}"`)) fail('Release bundle contains forbidden runtime secret material.');
  }
  return state;
}
function validateLiveIdentityProof(path, expectedSha, maxAgeSeconds) {
  const proof = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (
    proof.status !== 'passed'
    || proof.sourceSha !== expectedSha
    || proof.servedReleaseSha !== expectedSha
    || proof.releaseIdentityHeader !== 'X-LunchLineup-Release'
    || !Number.isInteger(proof.httpStatus)
    || proof.httpStatus < 200
    || proof.httpStatus >= 300
    || !/^[a-f0-9]{64}$/.test(proof.responseSha256 ?? '')
    || !Number.isSafeInteger(proof.responseBytes)
    || proof.responseBytes < 1
  ) fail('Live identity proof does not establish the exact retained release source SHA.');
  const url = new URL(proof.healthUrl);
  if (url.protocol !== 'https:') fail('Live identity proof healthUrl must use HTTPS.');
  const checkedAt = Date.parse(proof.checkedAt);
  const ageMs = Date.now() - checkedAt;
  if (!Number.isFinite(checkedAt) || ageMs < -30_000 || ageMs > maxAgeSeconds * 1000) {
    fail('Live identity proof is stale or has an invalid checkedAt timestamp.');
  }
  return url.href;
}
function assertEmpty(uri) {
  if (objectExists(uri, 'index.json')) fail('Release registry already has an index; bootstrap is forbidden.');
  process.stdout.write('release_registry_empty_verified\n');
}
function indexBytes(state) {
  return Buffer.from(`${JSON.stringify({ version: 2, currentSuccessfulSha: state.sourceSha, publishedAt: new Date().toISOString() })}\n`);
}
function resolvePrevious(uri, output) {
  const indexPath = `${output}.index`;
  download(uri, 'index.json', indexPath);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (index.version !== 2 || !/^[a-f0-9]{40}$/.test(index.currentSuccessfulSha ?? '')) fail('Release registry index is invalid or uses the retired secret-bearing contract.');
  download(uri, `releases/${index.currentSuccessfulSha}.json`, output);
  const state = validateState(output);
  if (state.sourceSha !== index.currentSuccessfulSha) fail('Release registry index does not match immutable bundle.');
  process.stdout.write(`release_bundle_resolved source_sha=${state.sourceSha}\n`);
}
function publish(uri, statePath) {
  const state = validateState(statePath);
  const releaseObject = `releases/${state.sourceSha}.json`;
  if (objectExists(uri, releaseObject)) {
    const existingPath = `${statePath}.existing`;
    download(uri, releaseObject, existingPath);
    if (!readFileSync(existingPath).equals(readFileSync(statePath))) fail('Existing immutable release object does not match this bundle.');
    unlinkSync(existingPath);
  } else {
    upload(uri, releaseObject, statePath, true);
  }
  const indexPath = `${statePath}.index`;
  writeFileSync(indexPath, indexBytes(state), { mode: 0o600 });
  upload(uri, 'index.json', indexPath, false);
  process.stdout.write(`release_bundle_published source_sha=${state.sourceSha}\n`);
}
async function bootstrapRetained(uri, retainedUri, statePath) {
  assertEmpty(uri);
  await downloadRetained(retainedUri, statePath);
  const state = validateState(statePath);
  const expected = `bootstrap-current-live-release:${state.sourceSha}`;
  if (option('--confirm') !== expected) fail(`Bootstrap confirmation must exactly equal ${expected}.`);
  if (option('--verified-source-sha') !== state.sourceSha) fail('Verified bootstrap source SHA does not match the release bundle.');
  const maxAgeSeconds = Number(option('--max-live-proof-age-seconds'));
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 900) {
    fail('Live identity proof max age must be an integer from 1 through 900 seconds.');
  }
  const proofPaths = options('--live-identity-proof');
  if (proofPaths.length !== 2) fail('Bootstrap requires exactly two independently fetched live identity proofs.');
  const proofUrls = proofPaths.map((path) => validateLiveIdentityProof(path, state.sourceSha, maxAgeSeconds));
  if (new Set(proofUrls).size !== 2) fail('Bootstrap live identity proofs must cover two distinct HTTPS endpoints.');
  const releaseObject = `releases/${state.sourceSha}.json`;
  if (objectExists(uri, releaseObject)) {
    const existingPath = `${statePath}.existing`;
    download(uri, releaseObject, existingPath);
    if (!readFileSync(existingPath).equals(readFileSync(statePath))) {
      fail('Existing orphan release object does not exactly match the retained live bundle.');
    }
    unlinkSync(existingPath);
  } else {
    upload(uri, releaseObject, statePath, true);
  }
  const indexPath = `${statePath}.index`;
  writeFileSync(indexPath, indexBytes(state), { mode: 0o600 });
  upload(uri, 'index.json', indexPath, true);
  process.stdout.write(`release_registry_bootstrapped_from_retained_live source_sha=${state.sourceSha}\n`);
}
async function main() {
  const [command] = process.argv.slice(2);
  const uri = option('--registry-uri');
  if (command === 'resolve') return resolvePrevious(uri, resolve(option('--output')));
  if (command === 'publish') return publish(uri, resolve(option('--state-file')));
  if (command === 'assert-empty') return assertEmpty(uri);
  if (command === 'bootstrap-retained') {
    return bootstrapRetained(uri, option('--retained-bundle-uri'), resolve(option('--state-file')));
  }
  fail('Usage: release-bundle-registry.mjs <resolve|publish|assert-empty|bootstrap-retained> --registry-uri URI ...');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
