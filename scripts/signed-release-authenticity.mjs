import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const RELEASE_INDEX_VERSION = 3;
export const RELEASE_INDEX_KIND = 'lunchlineup-release-registry-index';
export const RELEASE_SIGNATURE_SCHEME = 'sigstore-keyless-cosign-v1';

function requireSingleLine(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string.`);
  }
  return value;
}

function requireSha(value, label, length) {
  const normalized = requireSingleLine(value, label).toLowerCase();
  const pattern = length === 40 ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (!pattern.test(normalized)) throw new Error(`${label} must be a ${length}-character lowercase hexadecimal value.`);
  return normalized;
}

// This location is selected by installed code, never by an artifact or CLI path.
const PRODUCTION_TRUST_POLICY = '/etc/lunchlineup/production-release-trust.json';

function protectedPath(path, label) {
  if (process.platform !== 'linux' || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} requires a canonical absolute Linux path.`);
  }
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022)
      || (current === path ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new Error(`${label} and all ancestors must be root-owned, nonsymlink and not group/world writable.`);
    }
    if (current === '/') break;
  }
}

function protectedExecutableDigest(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) || !(before.mode & 0o111)
      || before.nlink !== 1 || before.size < 1 || before.size > 512 * 1024 * 1024) {
      throw new Error('Production verifier must be a protected executable file at most 512 MiB.');
    }
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    const after = fstatSync(descriptor);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== after[key])) {
      throw new Error('Production verifier changed during measurement.');
    }
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}

function productionPolicy() {
  protectedPath(PRODUCTION_TRUST_POLICY, 'Production trust policy');
  const policy = parseJsonObject(PRODUCTION_TRUST_POLICY, 'Production trust policy');
  if (policy.version !== 1 || policy.kind !== 'lunchlineup-production-release-trust'
    || policy.releaseTarget !== 'production' || policy.scheme !== RELEASE_SIGNATURE_SCHEME
    || !Number.isSafeInteger(policy.maxIndexAgeSeconds) || policy.maxIndexAgeSeconds < 1
    || !Array.isArray(policy.sourceShas) || policy.sourceShas.length < 1
    || policy.sourceShas.length > 128 || new Set(policy.sourceShas).size !== policy.sourceShas.length
    || policy.sourceShas.some((sha) => typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha))) {
    throw new Error('Production trust policy has an invalid target, scheme or exact source allowlist.');
  }
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const start = Date.parse(policy.notBefore), end = Date.parse(policy.expiresAt), now = Date.now();
  if (!timestamp.test(policy.notBefore) || !timestamp.test(policy.expiresAt)
    || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
    || new Date(start).toISOString() !== policy.notBefore || new Date(end).toISOString() !== policy.expiresAt
    || now < start || now >= end) throw new Error('Production trust policy is not currently valid.');
  protectedPath(policy.cosignPath, 'Production Cosign verifier');
  if (!/^[a-f0-9]{64}$/.test(policy.cosignSha256)
    || protectedExecutableDigest(policy.cosignPath) !== policy.cosignSha256) {
    throw new Error('Production Cosign verifier does not match external policy.');
  }
  return policy;
}

function requireProductionMode(value, productionTrust) {
  if (!productionTrust && (value?.releaseTarget === 'production'
    || value?.releaseManifest?.releaseTarget === 'production')) {
    throw new Error('Production-declared artifacts require external production trust mode.');
  }
}

function assertProductionArtifact(value, policy) {
  const index = value.kind === RELEASE_INDEX_KIND && value.version === RELEASE_INDEX_VERSION;
  const sourceSha = index ? value.currentSuccessfulSha : stateIdentity(value);
  const target = index ? value.releaseTarget : value.releaseManifest?.releaseTarget;
  if (index) {
    const issued = Date.parse(value.issuedAt), now = Date.now();
    if (!Number.isFinite(issued) || new Date(issued).toISOString() !== value.issuedAt
      || issued > now
      || now - issued > policy.maxIndexAgeSeconds * 1000) {
      throw new Error('Production signed index is stale or has an invalid issue time.');
    }
  }
  if (target !== 'production' || !policy.sourceShas.includes(sourceSha)) {
    throw new Error('Artifact target/source is not approved by external production policy.');
  }
}

function requireExpectedSigner(certificateIdentity, oidcIssuer, productionTrust = false) {
  const identity = requireSingleLine(certificateIdentity, 'expected certificate identity');
  const issuer = requireSingleLine(oidcIssuer, 'expected OIDC issuer');
  let policy;
  if (productionTrust) {
    policy = productionPolicy();
    if (identity !== policy.certificateIdentity || issuer !== policy.oidcIssuer) {
      throw new Error('Expected signer does not match external production trust policy.');
    }
    const identityUrl = new URL(identity);
    if (identityUrl.protocol !== 'https:' || identityUrl.username || identityUrl.password
      || identityUrl.search || identityUrl.hash) throw new Error('Production certificate identity must be an exact HTTPS identity.');
  } else if (!identity.startsWith('https://github.com/') || !identity.includes('/.github/workflows/')) {
    throw new Error('Expected certificate identity must name a GitHub Actions workflow URL.');
  }
  const issuerUrl = new URL(issuer);
  if (issuerUrl.protocol !== 'https:' || (productionTrust && (issuerUrl.username || issuerUrl.password
    || issuerUrl.search || issuerUrl.hash))) throw new Error('Expected OIDC issuer must use HTTPS.');
  return { identity, issuer, policy };
}

function readPathOnce(path, label) {
  let descriptor;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    descriptor = openSync(resolve(path), constants.O_RDONLY | noFollow);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 64 * 1024 * 1024) {
      throw new Error('must be a non-empty regular file no larger than 67108864 bytes');
    }
    return readFileSync(descriptor);
  } catch (error) {
    throw new Error(`${label} could not be opened as one stable regular file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJsonObjectBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a JSON object.`);
  return value;
}

function parseJsonObject(path, label) {
  return parseJsonObjectBytes(readPathOnce(path, label), label);
}

function withPrivateSnapshots(entries, callback) {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-signed-release-'));
  chmodSync(scratch, 0o700);
  const snapshots = {};
  try {
    for (const [name, path, label] of entries) {
      const snapshot = join(scratch, `${name}.snapshot`);
      writeFileSync(snapshot, readPathOnce(path, label), { mode: 0o600, flag: 'wx' });
      snapshots[name] = snapshot;
    }
    return callback(snapshots);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stateIdentity(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 2) {
    throw new Error('Release bundle state must use the secret-free version 2 contract.');
  }
  const sourceSha = requireSha(state.sourceSha, 'release bundle sourceSha', 40);
  if (state.releaseManifest?.sourceSha !== sourceSha) {
    throw new Error('Release bundle manifest sourceSha must match release bundle sourceSha.');
  }
  return sourceSha;
}

export function createReleaseIndex(statePath, { certificateIdentity, oidcIssuer, productionTrust = false }) {
  const stateBytes = readPathOnce(statePath, 'Release bundle state');
  const state = JSON.parse(stateBytes.toString('utf8'));
  requireProductionMode(state, productionTrust);
  const sourceSha = stateIdentity(state);
  const { identity, issuer, policy } = requireExpectedSigner(certificateIdentity, oidcIssuer, productionTrust);
  if (policy) assertProductionArtifact(state, policy);
  return {
    version: RELEASE_INDEX_VERSION,
    kind: RELEASE_INDEX_KIND,
    currentSuccessfulSha: sourceSha,
    ...(productionTrust ? { releaseTarget: 'production', issuedAt: new Date().toISOString() } : {}),
    authenticity: {
      scheme: RELEASE_SIGNATURE_SCHEME,
      certificateIdentity: identity,
      oidcIssuer: issuer,
      bundle: {
        object: `releases/${sourceSha}.json`,
        signatureBundleObject: `releases/${sourceSha}.sigstore.json`,
        sha256: sha256Bytes(stateBytes),
        bytes: stateBytes.length,
      },
      index: {
        object: `indexes/${sourceSha}.json`,
        signatureBundleObject: `indexes/${sourceSha}.sigstore.json`,
      },
    },
  };
}

export function writeReleaseIndex(statePath, indexPath, signer) {
  const index = createReleaseIndex(statePath, signer);
  writeFileSync(resolve(indexPath), `${JSON.stringify(index)}\n`, { mode: 0o600, flag: 'wx' });
  return index;
}

export function validateReleaseIndex(indexPath, statePath, { certificateIdentity, oidcIssuer, productionTrust = false }) {
  const indexBytes = readPathOnce(indexPath, 'Release registry index');
  const stateBytes = readPathOnce(statePath, 'Release bundle state');
  const index = parseJsonObjectBytes(indexBytes, 'Release registry index');
  const state = parseJsonObjectBytes(stateBytes, 'Release bundle state');
  requireProductionMode(index, productionTrust);
  requireProductionMode(state, productionTrust);
  const sourceSha = stateIdentity(state);
  const { identity, issuer, policy } = requireExpectedSigner(certificateIdentity, oidcIssuer, productionTrust);
  if (policy) { assertProductionArtifact(state, policy); assertProductionArtifact(index, policy); }
  if (index.version !== RELEASE_INDEX_VERSION || index.kind !== RELEASE_INDEX_KIND) {
    throw new Error('Release registry index uses an unsupported authenticity contract.');
  }
  if (index.currentSuccessfulSha !== sourceSha) throw new Error('Signed release index source SHA does not match the release bundle.');
  const authenticity = index.authenticity;
  if (!authenticity || authenticity.scheme !== RELEASE_SIGNATURE_SCHEME) throw new Error('Release registry index is missing Sigstore authenticity evidence.');
  if (authenticity.certificateIdentity !== identity) throw new Error('Release registry index certificate identity does not match the trusted workflow identity.');
  if (authenticity.oidcIssuer !== issuer) throw new Error('Release registry index OIDC issuer does not match the trusted issuer.');
  const expectedBundle = {
    object: `releases/${sourceSha}.json`,
    signatureBundleObject: `releases/${sourceSha}.sigstore.json`,
    sha256: sha256Bytes(stateBytes),
    bytes: stateBytes.length,
  };
  for (const [key, value] of Object.entries(expectedBundle)) {
    if (authenticity.bundle?.[key] !== value) throw new Error(`Release registry index bundle ${key} does not match the retained release.`);
  }
  if (
    authenticity.index?.object !== `indexes/${sourceSha}.json`
    || authenticity.index?.signatureBundleObject !== `indexes/${sourceSha}.sigstore.json`
  ) throw new Error('Release registry index immutable object paths do not match sourceSha.');
  return { index, state, sourceSha, bundleSha256: expectedBundle.sha256 };
}

function cosignInvocation() {
  const command = process.env.COSIGN_BINARY || 'cosign';
  let prefix = [];
  if (process.env.COSIGN_ARGUMENT_PREFIX_JSON) {
    try {
      prefix = JSON.parse(process.env.COSIGN_ARGUMENT_PREFIX_JSON);
    } catch {
      throw new Error('COSIGN_ARGUMENT_PREFIX_JSON must be a JSON array.');
    }
    if (!Array.isArray(prefix) || prefix.some((value) => typeof value !== 'string' || /[\r\n]/.test(value))) {
      throw new Error('COSIGN_ARGUMENT_PREFIX_JSON must contain only single-line strings.');
    }
  }
  return { command, prefix };
}

function verifyCosignSnapshot(artifactPath, signatureBundlePath, { certificateIdentity, oidcIssuer, productionTrust = false }) {
  const artifact = resolve(artifactPath);
  const signatureBundle = resolve(signatureBundlePath);
  if (statSync(artifact).size < 1) throw new Error('Signed release artifact must not be empty.');
  parseJsonObject(signatureBundle, 'Sigstore verification bundle');
  // Legacy blob callers may verify non-JSON bytes. Only an explicit production
  // declaration adds this mode requirement; complete production parsing follows.
  let declaredArtifact;
  try { declaredArtifact = JSON.parse(readPathOnce(artifact, 'Signed artifact').toString('utf8')); } catch { /* legacy opaque blob */ }
  requireProductionMode(declaredArtifact, productionTrust);
  const { identity, issuer, policy } = requireExpectedSigner(certificateIdentity, oidcIssuer, productionTrust);
  if (policy) assertProductionArtifact(parseJsonObject(artifact, 'Production signed artifact'), policy);
  const { command, prefix } = policy ? { command: policy.cosignPath, prefix: [] } : cosignInvocation();
  const args = [
    ...prefix,
    'verify-blob', artifact,
    '--bundle', signatureBundle,
    '--certificate-identity', identity,
    '--certificate-oidc-issuer', issuer,
  ];
  // Production verifier receives no candidate-supplied executable/config environment.
  const env = policy ? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dirname(artifact) } : process.env;
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true,
    ...(policy ? { env, timeout: 60_000, maxBuffer: 1024 * 1024 } : {}) });
  if (result.error) throw new Error(`Cosign verifier is required and could not be executed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 600);
    throw new Error(`Cosign rejected release authenticity${detail ? `: ${detail}` : '.'}`);
  }
}

export function verifyCosignBlob(artifactPath, signatureBundlePath, signer) {
  return withPrivateSnapshots([
    ['artifact', artifactPath, 'Signed release artifact'],
    ['signature', signatureBundlePath, 'Sigstore verification bundle'],
  ], ({ artifact, signature }) => {
    verifyCosignSnapshot(artifact, signature, signer);
    return { artifactBytes: readFileSync(artifact), signatureBytes: readFileSync(signature) };
  });
}

export function withVerifiedReleaseAuthenticity({
  statePath,
  indexPath,
  bundleSignaturePath,
  indexSignaturePath,
  certificateIdentity,
  oidcIssuer,
  productionTrust = false,
}, consume) {
  if (typeof consume !== 'function' || consume.constructor?.name === 'AsyncFunction') {
    throw new Error('Verified release consumer must be synchronous.');
  }
  const signer = { certificateIdentity, oidcIssuer, productionTrust };
  return withPrivateSnapshots([
    ['state', statePath, 'Release bundle state'],
    ['index', indexPath, 'Release registry index'],
    ['bundle-signature', bundleSignaturePath, 'Release bundle Sigstore verification bundle'],
    ['index-signature', indexSignaturePath, 'Release index Sigstore verification bundle'],
  ], (snapshots) => {
    const validated = validateReleaseIndex(snapshots.index, snapshots.state, signer);
    verifyCosignSnapshot(snapshots.index, snapshots['index-signature'], signer);
    verifyCosignSnapshot(snapshots.state, snapshots['bundle-signature'], signer);
    // Consumers run synchronously while all four authenticated, private paths
    // remain owned by this invocation. Never reopen candidate input paths.
    const result = consume(validated, Object.freeze({
      statePath: snapshots.state,
      indexPath: snapshots.index,
      bundleSignaturePath: snapshots['bundle-signature'],
      indexSignaturePath: snapshots['index-signature'],
    }));
    if (result && typeof result.then === 'function') {
      throw new Error('Verified release consumer must not return a Promise or thenable.');
    }
    return result;
  });
}

export function verifyReleaseAuthenticity(options) {
  return withVerifiedReleaseAuthenticity(options, (validated, paths) => ({
    ...validated,
    artifactBytes: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readFileSync(path)])),
  }));
}
