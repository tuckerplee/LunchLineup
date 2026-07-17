import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyReleaseAuthenticity, writeReleaseIndex } from '../../scripts/signed-release-authenticity.mjs';

const signer = {
  certificateIdentity: 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main',
  oidcIssuer: 'https://token.actions.githubusercontent.com',
};

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('signed release verification hashes, parses, and Cosign-verifies one private snapshot despite atomic source swaps', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-signed-release-swap-'));
  const sourceSha = 'a'.repeat(40);
  const statePath = join(scratch, 'state.json');
  const indexPath = join(scratch, 'index.json');
  const bundleSignaturePath = join(scratch, 'state.sigstore.json');
  const indexSignaturePath = join(scratch, 'index.sigstore.json');
  const fakeCosign = join(scratch, 'fake-cosign.mjs');
  const logPath = join(scratch, 'cosign.log');
  const markerPath = join(scratch, 'swapped');
  const replacements = [];
  const priorBinary = process.env.COSIGN_BINARY;
  const priorPrefix = process.env.COSIGN_ARGUMENT_PREFIX_JSON;
  const priorSwap = process.env.SIGNED_RELEASE_SWAP_JSON;
  const priorLog = process.env.SIGNED_RELEASE_COSIGN_LOG;
  const priorMarker = process.env.SIGNED_RELEASE_SWAP_MARKER;

  try {
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      sourceSha,
      releaseManifest: { sourceSha },
    }), { mode: 0o600 });
    writeReleaseIndex(statePath, indexPath, signer);
    writeFileSync(bundleSignaturePath, '{"bundle":"state-original"}\n', { mode: 0o600 });
    writeFileSync(indexSignaturePath, '{"bundle":"index-original"}\n', { mode: 0o600 });

    const expected = {
      index: digest(indexPath),
      state: digest(statePath),
      indexSignature: digest(indexSignaturePath),
      bundleSignature: digest(bundleSignaturePath),
    };
    for (const [original, contents] of [
      [statePath, '{"corrupt":"replacement-state"}\n'],
      [indexPath, '{"corrupt":"replacement-index"}\n'],
      [bundleSignaturePath, '{"bundle":"replacement-state-signature"}\n'],
      [indexSignaturePath, '{"bundle":"replacement-index-signature"}\n'],
    ]) {
      const replacement = `${original}.replacement`;
      writeFileSync(replacement, contents, { mode: 0o600 });
      replacements.push([original, replacement]);
    }

    writeFileSync(fakeCosign, `
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const artifact = args[1];
const bundle = args[args.indexOf('--bundle') + 1];
const mode = (path) => statSync(path).mode & 0o777;
if (args[0] !== 'verify-blob' || !artifact || !bundle) process.exit(2);
if (process.platform !== 'win32' && (mode(artifact) !== 0o600 || mode(bundle) !== 0o600)) process.exit(3);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
appendFileSync(process.env.SIGNED_RELEASE_COSIGN_LOG, JSON.stringify({ artifact, bundle, artifactSha256: sha256(artifact), bundleSha256: sha256(bundle) }) + '\\n');
if (!existsSync(process.env.SIGNED_RELEASE_SWAP_MARKER)) {
  for (const [original, replacement] of JSON.parse(process.env.SIGNED_RELEASE_SWAP_JSON)) renameSync(replacement, original);
  writeFileSync(process.env.SIGNED_RELEASE_SWAP_MARKER, 'swapped');
}
`, { mode: 0o700 });
    chmodSync(fakeCosign, 0o700);

    process.env.COSIGN_BINARY = process.execPath;
    process.env.COSIGN_ARGUMENT_PREFIX_JSON = JSON.stringify([fakeCosign]);
    process.env.SIGNED_RELEASE_SWAP_JSON = JSON.stringify(replacements);
    process.env.SIGNED_RELEASE_COSIGN_LOG = logPath;
    process.env.SIGNED_RELEASE_SWAP_MARKER = markerPath;

    const verified = verifyReleaseAuthenticity({
      statePath,
      indexPath,
      bundleSignaturePath,
      indexSignaturePath,
      ...signer,
    });
    assert.equal(verified.sourceSha, sourceSha);
    const calls = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(
      new Set(calls.map((call) => call.artifactSha256)),
      new Set([expected.index, expected.state]),
    );
    assert.deepEqual(
      new Set(calls.map((call) => call.bundleSha256)),
      new Set([expected.indexSignature, expected.bundleSignature]),
    );
    for (const call of calls) {
      assert.match(call.artifact, /lunchlineup-signed-release-/);
      assert.match(call.bundle, /lunchlineup-signed-release-/);
      assert.notEqual(call.artifact, statePath);
      assert.notEqual(call.artifact, indexPath);
    }
    assert.match(readFileSync(statePath, 'utf8'), /replacement-state/);
  } finally {
    if (priorBinary === undefined) delete process.env.COSIGN_BINARY; else process.env.COSIGN_BINARY = priorBinary;
    if (priorPrefix === undefined) delete process.env.COSIGN_ARGUMENT_PREFIX_JSON; else process.env.COSIGN_ARGUMENT_PREFIX_JSON = priorPrefix;
    if (priorSwap === undefined) delete process.env.SIGNED_RELEASE_SWAP_JSON; else process.env.SIGNED_RELEASE_SWAP_JSON = priorSwap;
    if (priorLog === undefined) delete process.env.SIGNED_RELEASE_COSIGN_LOG; else process.env.SIGNED_RELEASE_COSIGN_LOG = priorLog;
    if (priorMarker === undefined) delete process.env.SIGNED_RELEASE_SWAP_MARKER; else process.env.SIGNED_RELEASE_SWAP_MARKER = priorMarker;
    rmSync(scratch, { recursive: true, force: true });
  }
});
