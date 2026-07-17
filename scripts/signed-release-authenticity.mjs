import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

function requireExpectedSigner(certificateIdentity, oidcIssuer) {
  const identity = requireSingleLine(certificateIdentity, 'expected certificate identity');
  const issuer = requireSingleLine(oidcIssuer, 'expected OIDC issuer');
  if (!identity.startsWith('https://github.com/') || !identity.includes('/.github/workflows/')) {
    throw new Error('Expected certificate identity must name a GitHub Actions workflow URL.');
  }
  if (new URL(issuer).protocol !== 'https:') throw new Error('Expected OIDC issuer must use HTTPS.');
  return { identity, issuer };
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

export function createReleaseIndex(statePath, { certificateIdentity, oidcIssuer }) {
  const stateBytes = readPathOnce(statePath, 'Release bundle state');
  const state = JSON.parse(stateBytes.toString('utf8'));
  const sourceSha = stateIdentity(state);
  const { identity, issuer } = requireExpectedSigner(certificateIdentity, oidcIssuer);
  return {
    version: RELEASE_INDEX_VERSION,
    kind: RELEASE_INDEX_KIND,
    currentSuccessfulSha: sourceSha,
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

export function validateReleaseIndex(indexPath, statePath, { certificateIdentity, oidcIssuer }) {
  const indexBytes = readPathOnce(indexPath, 'Release registry index');
  const stateBytes = readPathOnce(statePath, 'Release bundle state');
  const index = parseJsonObjectBytes(indexBytes, 'Release registry index');
  const state = parseJsonObjectBytes(stateBytes, 'Release bundle state');
  const sourceSha = stateIdentity(state);
  const { identity, issuer } = requireExpectedSigner(certificateIdentity, oidcIssuer);
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

function verifyCosignSnapshot(artifactPath, signatureBundlePath, { certificateIdentity, oidcIssuer }) {
  const artifact = resolve(artifactPath);
  const signatureBundle = resolve(signatureBundlePath);
  if (statSync(artifact).size < 1) throw new Error('Signed release artifact must not be empty.');
  parseJsonObject(signatureBundle, 'Sigstore verification bundle');
  const { identity, issuer } = requireExpectedSigner(certificateIdentity, oidcIssuer);
  const { command, prefix } = cosignInvocation();
  const args = [
    ...prefix,
    'verify-blob', artifact,
    '--bundle', signatureBundle,
    '--certificate-identity', identity,
    '--certificate-oidc-issuer', issuer,
  ];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
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
  ], ({ artifact, signature }) => verifyCosignSnapshot(artifact, signature, signer));
}

export function verifyReleaseAuthenticity({
  statePath,
  indexPath,
  bundleSignaturePath,
  indexSignaturePath,
  certificateIdentity,
  oidcIssuer,
}) {
  const signer = { certificateIdentity, oidcIssuer };
  return withPrivateSnapshots([
    ['state', statePath, 'Release bundle state'],
    ['index', indexPath, 'Release registry index'],
    ['bundle-signature', bundleSignaturePath, 'Release bundle Sigstore verification bundle'],
    ['index-signature', indexSignaturePath, 'Release index Sigstore verification bundle'],
  ], (snapshots) => {
    const validated = validateReleaseIndex(snapshots.index, snapshots.state, signer);
    verifyCosignSnapshot(snapshots.index, snapshots['index-signature'], signer);
    verifyCosignSnapshot(snapshots.state, snapshots['bundle-signature'], signer);
    return validated;
  });
}
