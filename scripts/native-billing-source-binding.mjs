// Definition-only metadata checks. The caller must independently authenticate
// expected/runtime and hold exclusive source/receipt custody for the entire job.
// These checks confer no native admission, clone, quota or endpoint authority.
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync } from 'node:fs';
import { posix } from 'node:path';
import { TextDecoder } from 'node:util';
import { selectInternalCiSourceProfile, verifyInternalCiSourceContextIdentity, verifyInternalCiSourceProof } from './internal-ci-source-context.mjs';
import { verifyIntegrationDatabaseTarget } from './read-internal-ci-migrations.mjs';

const CONTEXT_KEYS = ['version', 'kind', 'repository', 'runId', 'runRoot', 'sourceRef', 'sourceSha', 'treeSha', 'remoteCandidateSha', 'baselineRef', 'baselineSha', 'pipelineSha256', 'sourceProofPath', 'scanSourcePath', 'buildSourcePath', 'artifactRoot', 'evidenceRoot'];
const PROOF_KEYS = ['version', 'kind', 'status', 'repository', 'sourceRef', 'sourceSha', 'remoteCandidateSha', 'treeSha', 'baselineRef', 'baselineSha', 'baselineTreeSha', 'pipelineSha256', 'runId', 'originalCheckoutClean', 'scanCloneVerified', 'buildCloneVerified', 'gitAlternatesRejected', 'verifiedAt'];
const DISPOSABLE_CONTEXT_KEYS = ['version', 'kind', 'repository', 'sourcePurpose', 'runId', 'runRoot', 'sourceRef', 'sourceSha', 'treeSha', 'remoteSourceSha', 'baselineRef', 'baselineSha', 'pipelinePath', 'pipelineSha256', 'sourceProofPath', 'scanSourcePath', 'buildSourcePath', 'artifactRoot', 'evidenceRoot'];
const DISPOSABLE_PROOF_KEYS = ['version', 'kind', 'status', 'repository', 'sourcePurpose', 'sourceRef', 'sourceSha', 'remoteSourceSha', 'treeSha', 'baselineRef', 'baselineSha', 'baselineTreeSha', 'pipelinePath', 'pipelineSha256', 'runId', 'originalCheckoutClean', 'scanCloneVerified', 'buildCloneVerified', 'gitAlternatesRejected', 'verifiedAt'];
const PREFLIGHT_KEYS = ['runId', 'sourceSha', 'workspace', 'temporaryRoot', 'mutationRole', 'dataTargetEnvironment', 'database', 'store', 'containers'];
const fail = () => { throw new Error('Native billing source binding refused.'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const canonicalPath = path => typeof path === 'string' && path.startsWith('/') && !path.includes('\0') && posix.normalize(path) === path && (path === '/' || !path.endsWith('/'));
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
const same = (a, b) => fields.every(k => a[k] === b[k]);
function ancestors(path, uid) {
  const parts = path.split('/').slice(1, -1);
  const paths = ['/'];
  for (const part of parts) paths.push(posix.join(paths.at(-1), part));
  return paths.map(path => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || ![0n, BigInt(uid)].includes(stat.uid) || (stat.mode & 0o022n) !== 0n) fail();
    return { path, stat };
  });
}

// This is bounded observation under externally held custody, not atomic openat
// traversal. Same-UID or swap-and-restore attackers require owner isolation.
export function readPrivateStableSnapshot(path, { expectedUid, maxBytes = 65536 } = {}) {
  let fd;
  try {
    if (!canonicalPath(path) || path === '/' || !Number.isSafeInteger(expectedUid) || expectedUid < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail();
    const parents = ancestors(path, expectedUid);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(expectedUid) || (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > BigInt(maxBytes)) fail();
    const chunks = []; let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(16384, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count)); total += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const final = lstatSync(path, { bigint: true });
    const finalParents = ancestors(path, expectedUid);
    if (total > maxBytes || BigInt(total) !== before.size || !same(before, after) || !same(before, final) || parents.length !== finalParents.length || parents.some((x, i) => x.path !== finalParents[i].path || !same(x.stat, finalParents[i].stat))) fail();
    const bytes = Buffer.concat(chunks);
    return Object.freeze({ path, bytes, sha256: digest(bytes), size: bytes.length });
  } catch { fail(); }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { fail(); } } }
}

function receipt(input, keys, expectedHash) {
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > 65536 || !hex(expectedHash, 64)) fail();
  const bytes = Buffer.from(input);
  if (digest(bytes) !== expectedHash) fail();
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
  const rebuilt = Object.fromEntries(keys.map(k => [k, value[k]]));
  if (!Buffer.from(JSON.stringify(rebuilt, null, 2) + '\n').equals(bytes)) fail();
  return value;
}

export function verifyNativeBillingSourceBinding({ contextBytes, proofBytes, preflightBytes, expected, env, runtime }) {
  try {
    if (!expected || !env || !runtime || typeof expected.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(expected.runId)) fail();
    for (const key of ['sourceSha', 'treeSha', 'baselineSha', 'baselineTreeSha']) if (!hex(expected[key], 40)) fail();
    if (!hex(expected.pipelineSha256, 64) || expected.sourceSha === expected.baselineSha) fail();
    const expectedSource = expected.sourceProfile;
    const profile = selectInternalCiSourceProfile(expectedSource);
    if (profile.version === 2) for (const key of ['sourceSha', 'treeSha', 'baselineSha', 'baselineTreeSha', 'pipelineSha256']) if (profile[key] !== expected[key]) fail();
    const contextKeys = profile.version === 1 ? CONTEXT_KEYS : DISPOSABLE_CONTEXT_KEYS;
    const proofKeys = profile.version === 1 ? PROOF_KEYS : DISPOSABLE_PROOF_KEYS;
    const runId = expected.runId, sourceSha = expected.sourceSha;
    const workspace = `/var/lib/custom-ci/workspaces/${runId}`;
    const temporaryRoot = `/var/lib/custom-ci/runs/${runId}/tmp/job-tmp`;
    const runRoot = `${temporaryRoot}/lunchlineup-source-${runId}`;
    const artifactRoot = `${workspace}/.release/internal-ci/${sourceSha}`;
    const context = receipt(contextBytes, contextKeys, expected.contextSha256);
    const proof = receipt(proofBytes, proofKeys, expected.proofSha256);
    const preflight = receipt(preflightBytes, PREFLIGHT_KEYS, expected.preflightSha256);
    for (const [keys, value] of [[contextKeys, context], [proofKeys, proof]]) {
      for (const key of keys) {
        const type = key === 'version' ? 'number' : ['originalCheckoutClean', 'scanCloneVerified', 'buildCloneVerified', 'gitAlternatesRejected'].includes(key) ? 'boolean' : 'string';
        if (typeof value[key] !== type) fail();
      }
    }
    const consumedEnv = {};
    for (const key of ['CI_RUN_ID', 'CI_COMMIT_SHA', 'CI_REPOSITORY', 'CI_REF', 'CI_RUN_ATTEMPT', 'RUNNER_TEMP', 'DATA_TARGET_ENV', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'APP_DB_USER', 'POSTGRES_USER', 'APP_DB_PASSWORD', 'POSTGRES_PASSWORD', 'NODE_ENV', 'APP_ENV', 'DEPLOY_ENV', 'NEXT_PUBLIC_APP_ENV']) {
      if (env[key] !== undefined && typeof env[key] !== 'string') fail();
      consumedEnv[key] = env[key];
    }
    if (consumedEnv.CI_RUN_ID !== runId || consumedEnv.CI_COMMIT_SHA !== sourceSha || consumedEnv.CI_REPOSITORY !== 'lunchlineup' || consumedEnv.CI_REF !== profile.sourceRef || consumedEnv.CI_RUN_ATTEMPT !== '1' || consumedEnv.RUNNER_TEMP !== temporaryRoot) fail();
    verifyInternalCiSourceContextIdentity(context, { commitSha: sourceSha, runId }, { expectedSource });
    verifyInternalCiSourceProof(context, proof, { expectedSource });
    for (const key of ['treeSha', 'baselineSha', 'pipelineSha256']) if (context[key] !== expected[key]) fail();
    if (proof.baselineTreeSha !== expected.baselineTreeSha || new Date(proof.verifiedAt).toISOString() !== proof.verifiedAt) fail();
    const paths = { runRoot, scanSourcePath: `${runRoot}/scan`, buildSourcePath: `${runRoot}/build`, artifactRoot, evidenceRoot: artifactRoot, sourceProofPath: `${artifactRoot}/source/source-proof.json` };
    for (const [key, path] of Object.entries(paths)) if (context[key] !== path) fail();
    if (typeof consumedEnv.DATABASE_URL !== 'string' || typeof consumedEnv.MIGRATION_DATABASE_URL !== 'string') fail();
    verifyIntegrationDatabaseTarget(consumedEnv, context, preflight);
    const app = new URL(consumedEnv.DATABASE_URL), owner = new URL(consumedEnv.MIGRATION_DATABASE_URL);
    if (!Number.isSafeInteger(runtime.postgresPort) || runtime.postgresPort < 1024 || runtime.postgresPort > 65535 || app.port !== String(runtime.postgresPort) || owner.port !== String(runtime.postgresPort)) fail();
    if (consumedEnv.APP_DB_USER !== 'lunchlineup_ci_app' || consumedEnv.POSTGRES_USER !== 'root') fail();
    for (const [url, envKey, runtimeKey] of [[app, 'APP_DB_PASSWORD', 'appPassword'], [owner, 'POSTGRES_PASSWORD', 'ownerPassword']]) {
      if (typeof runtime[runtimeKey] !== 'string' || runtime[runtimeKey].length < 1 || consumedEnv[envKey] !== runtime[runtimeKey] || decodeURIComponent(url.password) !== runtime[runtimeKey]) fail();
    }
    if (runtime.appPassword === runtime.ownerPassword) fail();
    return freeze({ context, proof, preflight, controllerBinding: { ciRunId: runId, ciSourceSha: sourceSha, preflightPath: `${artifactRoot}/integration-target.json`, preflightSha256: expected.preflightSha256 }, contextPath: `${runRoot}/source-context.json`, nativeQualified: false, releaseQualified: false });
  } catch { fail(); }
}
