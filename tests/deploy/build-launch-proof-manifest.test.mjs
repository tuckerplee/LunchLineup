import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_EVIDENCE_KINDS,
  buildLaunchProofManifest as buildStrictLaunchProofManifest,
  serializeLaunchProofManifest,
} from '../../scripts/build-launch-proof-manifest.mjs';

const builderScript = fileURLToPath(new URL('../../scripts/build-launch-proof-manifest.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-launch-proof-builder-'));
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const generatedAt = '2026-07-13T12:00:00.000Z';
const capturedAt = '2026-07-13T11:30:00.000Z';
const originalCwd = process.cwd();
const originalCosignBinary = process.env.RECOVERY_EXECUTION_COSIGN_BINARY;
const cosignStub = join(scratch, 'verify-blob');

writeFileSync(cosignStub, 'process.exit(0);\n');
process.chdir(scratch);
process.env.RECOVERY_EXECUTION_COSIGN_BINARY = process.execPath;

const buildLaunchProofManifest = (input) => buildStrictLaunchProofManifest(input, {
  verifyRecoveryExecutionSignature: () => {},
});

after(() => {
  process.chdir(originalCwd);
  if (originalCosignBinary === undefined) delete process.env.RECOVERY_EXECUTION_COSIGN_BINARY;
  else process.env.RECOVERY_EXECUTION_COSIGN_BINARY = originalCosignBinary;
  rmSync(scratch, { recursive: true, force: true });
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function signedExecution(binding, suffix, issuedAt) {
  const signatureBytes = Buffer.from(`fixture-signature-${suffix}`);
  const attestationBytes = Buffer.from(JSON.stringify({
    version: 1,
    kind: 'lunchlineup-signed-recovery-execution-proof',
    certificateIdentity: 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main',
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    bindingSha256: createHash('sha256').update(canonicalJson(binding)).digest('hex'),
    binding,
    issuedAt,
    expiresAt: '2026-08-12T11:30:00.000Z',
  }));
  return {
    executionAttestationUri: `https://evidence.example/recovery/execution-attestation-${suffix}-20260713.json`,
    executionAttestationSha256: createHash('sha256').update(attestationBytes).digest('hex'),
    executionAttestationBase64: attestationBytes.toString('base64'),
    executionSignatureBundleUri: `https://evidence.example/recovery/execution-attestation-${suffix}-20260713.sigstore.json`,
    executionSignatureBundleSha256: createHash('sha256').update(signatureBytes).digest('hex'),
    executionSignatureBundleBase64: signatureBytes.toString('base64'),
  };
}

function artifact(kind, overrides = {}) {
  const common = {
    kind,
    status: 'passed',
    sourceSha,
    checkedAt: capturedAt,
    summary: `${kind} completed successfully against the release candidate.`,
    command: `node scripts/produce-${kind}-evidence.mjs --release ${sourceSha}`,
    exitCode: 0,
  };
  if (kind === 'dast') Object.assign(common, {
    expectedSourceSha: sourceSha,
    servedReleaseSha: sourceSha,
    targetUrl: 'https://lunchlineup.example/health',
    tool: { image: 'registry.example/zap@sha256:' + 'd'.repeat(64), digest: 'd'.repeat(64) },
    commandExitCode: 0,
    raw: {
      report: { sha256: 'e'.repeat(64), bytes: 64 },
      htmlReport: { sha256: 'a'.repeat(64), bytes: 128 },
    },
    dast: {
      findingCounts: { informational: 0, low: 0, medium: 0, high: 0, critical: 0 },
      severityThreshold: { high: 0, critical: 0 },
    },
  });
  if (kind === 'load') Object.assign(common, {
    expectedSourceSha: sourceSha,
    servedReleaseSha: sourceSha,
    targetUrl: 'https://lunchlineup.example/health',
    tool: { image: 'registry.example/artillery@sha256:' + 'f'.repeat(64), digest: 'f'.repeat(64) },
    commandExitCode: 0,
    raw: { artilleryResult: { sha256: '1'.repeat(64), bytes: 64 }, availabilityImportResult: { sha256: '2'.repeat(64), bytes: 64 } },
    load: {
      p99Ms: 999,
      failedRequests: 0,
      failedVUs: 0,
      thresholds: { p99MsExclusive: 1000, failedRequests: 0, failedVUs: 0 },
    },
  });
  if (kind === 'alertRoute') common.delivered = true;
  if (kind === 'drDrill') {
    const backupSha256 = 'b'.repeat(64);
    const sourceUri = 's3://lunchlineup-prod/db-backups/lunchlineup-20260713T110000Z.sql.zst.gpg';
    const sourceVersion = 'provider-version-20260713';
    const sourceBytes = 4096;
    const readbackCommandSha256 = 'c'.repeat(64);
    const principal = 'arn:aws:iam::123456789012:role/dr-readback';
    const requestId = 'provider-request-987654321';
    const observedAt = '2026-07-13T11:25:00.000Z';
    const startedAt = '2026-07-13T11:20:00.000Z';
    const runId = 'dr-run-20260713-112000';
    const targetIdentity = 'postgres://isolated-recovery/dr-run-20260713-112000';
    const targetSystemIdentifier = '7493980246813579246';
    const cleanupContainer = 'lunchlineup-dr-drill-20260713-112000';
    const readbackBytes = Buffer.from(JSON.stringify({
      version: 2,
      kind: 'lunchlineup-provider-authenticated-object-readback',
      sourceKind: 's3',
      sourceUri,
      requestedVersion: sourceVersion,
      resolvedVersion: sourceVersion,
      objectChecksum: { algorithm: 'sha256', value: backupSha256 },
      bytes: sourceBytes,
      readbackCommandSha256,
      authentication: { status: 'verified', mechanism: 'provider-api', principal, requestId },
      observedAt,
    }));
    const binding = {
      run: { id: runId, releaseSha: sourceSha, startedAt, completedAt: capturedAt },
      source: {
        kind: 's3',
        uri: sourceUri,
        version: sourceVersion,
        checksum: { algorithm: 'sha256', value: backupSha256 },
        bytes: sourceBytes,
      },
      providerReadback: {
        principal,
        requestId,
        observedAt,
        sha256: createHash('sha256').update(readbackBytes).digest('hex'),
      },
      target: { environment: 'isolated-recovery', identity: targetIdentity, systemIdentifier: targetSystemIdentifier },
      outcome: {
        status: 'succeeded',
        restoredTableCount: 12,
        appRoleVerified: true,
        cleanup: {
          status: 'succeeded',
          container: cleanupContainer,
          containerAbsent: true,
          checkedAt: '2026-07-13T11:29:00.000Z',
          evidence: 'docker-ps-exact-name-v1',
        },
      },
    };
    Object.assign(common, {
      backupSha256,
      restoredTableCount: 12,
      sourceUri,
      sourceKind: 's3',
      startedAt,
      completedAt: capturedAt,
      runId,
      targetIdentity,
      targetSystemIdentifier,
      targetEnvironment: 'isolated-recovery',
      appRoleVerified: true,
      container: cleanupContainer,
      cleanupStatus: 'succeeded',
      cleanupContainer,
      cleanupContainerAbsent: true,
      cleanupCheckedAt: '2026-07-13T11:29:00.000Z',
      cleanupEvidence: 'docker-ps-exact-name-v1',
      sourceVersion,
      sourceProviderVersion: sourceVersion,
      sourceExpectedSha256: backupSha256,
      sourceRetrievedBytes: sourceBytes,
      sourceReadbackSha256: createHash('sha256').update(readbackBytes).digest('hex'),
      sourceReadbackBase64: readbackBytes.toString('base64'),
      sourceReadbackVerified: true,
      sourceReadbackPrincipal: principal,
      sourceReadbackRequestId: requestId,
      sourceReadbackObservedAt: observedAt,
      sourceReadbackCommandSha256: readbackCommandSha256,
      sourceFetchCommandSha256: 'd'.repeat(64),
      sourceAdapterAttestationUri: 'https://evidence.example/recovery/adapter-attestation-20260713.json',
      sourceAdapterAttestationSha256: 'e'.repeat(64),
      sourceAdapterSignatureBundleUri: 'https://evidence.example/recovery/adapter-attestation-20260713.sigstore.json',
      sourceAdapterSignatureBundleSha256: 'f'.repeat(64),
      sourceAdapterCertificateIdentity: 'https://github.com/example/lunchlineup/.github/workflows/ci.yml@refs/heads/main',
      sourceAdapterOidcIssuer: 'https://token.actions.githubusercontent.com',
      ...signedExecution(binding, 'dr', capturedAt),
    });
  }
  if (kind === 'pitrDrill') {
    const baseBackupId = '20260713T100000Z-1234';
    const baseBackupUri = `s3://lunchlineup-prod/postgres/basebackups/${baseBackupId}/COMPLETE`;
    const archivedWalSegment = '00000001000000000000002A';
    const archivedWalUri = `s3://lunchlineup-prod/postgres/wal/${archivedWalSegment}`;
    const versions = {
      complete: 'complete-version-20260713',
      archive: 'archive-version-20260713',
      manifest: 'manifest-version-20260713',
      wal: 'wal-version-20260713-2a',
    };
    const objects = {
      complete: { uri: baseBackupUri, versionId: versions.complete, sha256: '3'.repeat(64), bytes: 128 },
      archive: { uri: `s3://lunchlineup-prod/postgres/basebackups/${baseBackupId}/base.tar.gz`, versionId: versions.archive, sha256: '4'.repeat(64), bytes: 4096 },
      manifest: { uri: `s3://lunchlineup-prod/postgres/basebackups/${baseBackupId}/backup_manifest`, versionId: versions.manifest, sha256: '5'.repeat(64), bytes: 512 },
      wal: { uri: archivedWalUri, versionId: versions.wal, sha256: '6'.repeat(64), bytes: 2048 },
    };
    const invariantChecks = [{ name: 'core-relations-readable', status: 'passed', checkedAt: capturedAt }];
    const runId = 'pitr-run-20260713-105500';
    const startedAt = '2026-07-13T10:55:00.000Z';
    const restoredAt = '2026-07-13T11:15:00.000Z';
    const targetIdentity = 'postgres://isolated-recovery/pitr-run-20260713-105500';
    const targetSystemIdentifier = '7493980246813579247';
    const principal = 'arn:aws:iam::123456789012:role/pitr-readback';
    const requestId = 'pitr-readback-request-20260713';
    const observedAt = '2026-07-13T11:25:00.000Z';
    const boundObjects = Object.fromEntries(Object.entries(objects).map(([key, value]) => [key, {
      uri: value.uri,
      versionId: value.versionId,
      checksum: { algorithm: 'sha256', value: value.sha256 },
      bytes: value.bytes,
    }]));
    const binding = {
      run: { id: runId, releaseSha: sourceSha, startedAt, completedAt: restoredAt },
      source: { baseBackupId, objects: boundObjects },
      providerReadback: { principal, requestId, observedAt },
      target: {
        environment: 'isolated-recovery',
        identity: targetIdentity,
        systemIdentifier: targetSystemIdentifier,
        recoveryTargetTime: '2026-07-13T11:00:00.000Z',
      },
      outcome: {
        status: 'succeeded',
        restoreSucceeded: true,
        recoveryTargetReached: true,
        recoveryPaused: true,
        invariantChecksSha256: createHash('sha256').update(canonicalJson(invariantChecks)).digest('hex'),
      },
    };
    Object.assign(common, {
      baseBackupId,
      baseBackupStatus: 'COMPLETE',
      baseBackupUri,
      archivedWalSegment,
      archivedWalUri,
      sourceTimestamp: '2026-07-13T10:00:00.000Z',
      recoveryTargetTime: '2026-07-13T11:00:00.000Z',
      restoreCompletedAt: restoredAt,
      startedAt,
      runId,
      targetIdentity,
      targetSystemIdentifier,
      targetEnvironment: 'isolated-recovery',
      baseBackupCompleteVersionId: versions.complete,
      baseBackupArchiveVersionId: versions.archive,
      baseBackupManifestVersionId: versions.manifest,
      archivedWalVersionId: versions.wal,
      providerReadback: {
        status: 'verified',
        mechanism: 'provider-api',
        principal,
        requestId,
        observedAt,
        versions,
        objects,
      },
      restoreSucceeded: true,
      recoveryTargetReached: true,
      recoveryPaused: true,
      invariantChecks,
      ...signedExecution(binding, 'pitr', restoredAt),
    });
  }
  return { ...common, ...overrides };
}

function fixture(overrides = {}) {
  const dir = mkdtempSync(join(scratch, 'case-'));
  const descriptors = REQUIRED_EVIDENCE_KINDS.map((kind, index) => {
    const path = join(dir, `${kind}.json`);
    const value = artifact(kind, overrides.artifacts?.[kind]);
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    return {
      kind,
      path,
      uri: `https://evidence.lunchlineup.com/actions/runs/987654321/artifacts/${1000 + index}/${kind}-${sourceSha}.json`,
      capturedAt,
      producer: { system: 'github-actions', runId: '987654321', runAttempt: 2, job: kind },
      retentionClass: 'launch-proof-365d',
      ...overrides.descriptors?.[kind],
    };
  });
  return {
    dir,
    descriptors,
    input: {
      sourceSha,
      generatedAt,
      maxAgeSeconds: 3600,
      evidence: descriptors,
      supplementalEvidence: overrides.supplementalEvidence,
    },
  };
}

test('builds a deterministic version-1 manifest bound to exact evidence bytes', () => {
  const { input, descriptors } = fixture({
    supplementalEvidence: {
      stripeMeter: { status: 'passed', sourceSha, meterId: 'mtr_123456789', eventName: 'll.active_staff' },
    },
  });
  const first = buildLaunchProofManifest({ ...input, evidence: [...descriptors].reverse() });
  const second = buildLaunchProofManifest(input);

  assert.equal(serializeLaunchProofManifest(first), serializeLaunchProofManifest(second));
  assert.equal(first.version, 1);
  assert.equal(first.sourceSha, sourceSha);
  assert.equal(first.generatedAt, generatedAt);
  assert.equal(first.evidence.stripeMeter.meterId, 'mtr_123456789');
  for (const descriptor of descriptors) {
    const entry = first.evidence[descriptor.kind];
    const bytes = readFileSync(descriptor.path);
    assert.equal(entry.kind, descriptor.kind);
    assert.equal(entry.sourceSha, sourceSha);
    assert.equal(entry.uri, descriptor.uri);
    assert.equal(entry.checkedAt, capturedAt);
    assert.equal(entry.capturedAt, capturedAt);
    assert.deepEqual(entry.producer, descriptor.producer);
    assert.equal(entry.retentionClass, 'launch-proof-365d');
    assert.equal(entry.artifactBytes, bytes.byteLength);
    assert.equal(entry.artifactSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.stringify(entry).includes(descriptor.path), false);
  }
});

test('CLI resolves evidence paths relative to its input and writes reproducible JSON', () => {
  const { dir, descriptors, input } = fixture();
  const configPath = join(dir, 'builder-input.json');
  const outputOne = join(dir, 'launch-proof-one.json');
  const outputTwo = join(dir, 'launch-proof-two.json');
  const relativeEvidence = descriptors.map(({ path: _path, ...descriptor }, index) => (
    index === 0
      ? { ...descriptor, file: `${descriptor.kind}.json` }
      : { ...descriptor, path: `${descriptor.kind}.json` }
  ));
  writeFileSync(configPath, `${JSON.stringify({ version: 1, ...input, evidence: relativeEvidence })}\n`);

  for (const output of [outputOne, outputTwo]) {
    const result = spawnSync(process.execPath, [builderScript, '--input', configPath, '--output', output], {
      cwd: scratch,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /launch_proof_manifest_built/);
  }
  assert.equal(readFileSync(outputOne, 'utf8'), readFileSync(outputTwo, 'utf8'));
});

test('rejects missing, empty, duplicate-kind, and duplicate-file evidence', () => {
  const missingKind = fixture();
  assert.throws(
    () => buildLaunchProofManifest({ ...missingKind.input, evidence: missingKind.descriptors.slice(1) }),
    /Missing required evidence kinds: runtimeEnv/,
  );

  const empty = fixture();
  writeFileSync(empty.descriptors[0].path, '');
  assert.throws(() => buildLaunchProofManifest(empty.input), /must not be empty/);

  const whitespace = fixture();
  writeFileSync(whitespace.descriptors[0].path, '   \n');
  assert.throws(() => buildLaunchProofManifest(whitespace.input), /must not be empty/);

  const duplicateKind = fixture();
  assert.throws(
    () => buildLaunchProofManifest({ ...duplicateKind.input, evidence: [...duplicateKind.descriptors, duplicateKind.descriptors[0]] }),
    /Duplicate evidence kind: runtimeEnv/,
  );

  const duplicateFile = fixture();
  duplicateFile.descriptors[1].path = duplicateFile.descriptors[0].path;
  assert.throws(() => buildLaunchProofManifest(duplicateFile.input), /reuses another evidence file/);
});

test('rejects stale, future, and detached evidence', () => {
  const stale = fixture({ descriptors: { load: { capturedAt: '2026-07-13T10:59:59.000Z' } } });
  assert.throws(() => buildLaunchProofManifest(stale.input), /capturedAt is stale/);

  const future = fixture({ descriptors: { load: { capturedAt: '2026-07-13T12:00:00.001Z' } } });
  assert.throws(() => buildLaunchProofManifest(future.input), /must not be in the future/);

  const wrongSource = fixture({ artifacts: { dast: { sourceSha: 'a'.repeat(40) } } });
  assert.throws(() => buildLaunchProofManifest(wrongSource.input), /detached: its sourceSha/);

  const wrongTimestamp = fixture({ artifacts: { dast: { checkedAt: '2026-07-13T11:29:59.000Z' } } });
  assert.throws(() => buildLaunchProofManifest(wrongTimestamp.input), /detached: its captured timestamp/);

  const wrongKind = fixture({ artifacts: { dast: { kind: 'load' } } });
  assert.throws(() => buildLaunchProofManifest(wrongKind.input), /artifact kind load does not match dast/);
});

test('rejects non-HTTPS, non-public, mutable, and identifier-free evidence URIs', () => {
  for (const [uri, pattern] of [
    ['http://evidence.lunchlineup.com/runs/987654321/runtimeEnv.json', /must use HTTPS/],
    ['https://evidence.invalid/runs/987654321/runtimeEnv.json', /public hostname/],
    ['https://evidence.lunchlineup.com/launch-proof/latest.json', /mutable\/latest\/current/],
    ['https://evidence.lunchlineup.com/launch-proof/current.json', /mutable\/latest\/current/],
    ['https://evidence.lunchlineup.com/launch-proof/mutable.json', /mutable\/latest\/current/],
    ['https://evidence.lunchlineup.com/launch-proof/runtime-env.json', /immutable run, object, timestamp, UUID, or SHA/],
  ]) {
    const candidate = fixture({ descriptors: { runtimeEnv: { uri } } });
    assert.throws(() => buildLaunchProofManifest(candidate.input), pattern, uri);
  }
});

test('rejects secrets-like JSON keys and content before emitting a manifest', () => {
  const secretKey = fixture({ artifacts: { runtimeEnv: { clientSecret: 'redacted' } } });
  assert.throws(() => buildLaunchProofManifest(secretKey.input), /clientSecret is a secrets-like key/);

  const token = fixture({ artifacts: { runtimeEnv: { detail: `unexpected ghp_${'a'.repeat(36)}` } } });
  assert.throws(() => buildLaunchProofManifest(token.input), /contains secrets-like content/);

  const authorization = fixture({ artifacts: { runtimeEnv: { detail: `Authorization: Bearer ${'a'.repeat(24)}` } } });
  assert.throws(() => buildLaunchProofManifest(authorization.input), /contains secrets-like content/);

  const signedUri = fixture({
    descriptors: {
      runtimeEnv: {
        uri: `https://evidence.lunchlineup.com/runs/987654321/runtimeEnv-${sourceSha}.json?X-Amz-Signature=${'a'.repeat(64)}`,
      },
    },
  });
  assert.throws(() => buildLaunchProofManifest(signedUri.input), /authentication query parameters/);
});
