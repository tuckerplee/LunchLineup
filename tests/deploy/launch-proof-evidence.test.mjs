import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  emitCandidateEvidence,
  verifyCandidateEvidenceBundle,
  verifyFetchedEvidenceArtifact,
} from '../../scripts/launch-proof-evidence.mjs';
import { verifyExternalHealthResponse } from '../../scripts/verify-external-health-release.mjs';

const sourceSha = 'a'.repeat(40);
const checkedAt = '2026-07-10T12:00:00.000Z';
const recoveryExecutionIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const recoveryExecutionIssuer = 'https://token.actions.githubusercontent.com';
const releaseManifest = {
  productionHealthProof: { url: 'https://lunchlineup.example/health' },
};

function bytes(value) {
  return Buffer.from(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function signedExecutionProof(binding, issuedAt) {
  const attestation = {
    version: 1,
    kind: 'lunchlineup-signed-recovery-execution-proof',
    certificateIdentity: recoveryExecutionIdentity,
    oidcIssuer: recoveryExecutionIssuer,
    bindingSha256: createHash('sha256').update(canonicalJson(binding)).digest('hex'),
    binding,
    issuedAt,
    expiresAt: '2026-08-01T00:00:00.000Z',
  };
  const attestationBytes = bytes(attestation);
  const signatureBytes = Buffer.from('fixture-sigstore-bundle');
  const expectedAttestationSha256 = createHash('sha256').update(attestationBytes).digest('hex');
  const expectedSignatureSha256 = createHash('sha256').update(signatureBytes).digest('hex');
  return {
    fields: {
      execution_attestation_uri: `https://evidence.example/recovery/execution-${binding.run.id}.json`,
      execution_signature_bundle_uri: `https://evidence.example/recovery/execution-${binding.run.id}.sigstore.json`,
      execution_attestation_sha256: expectedAttestationSha256,
      execution_signature_bundle_sha256: expectedSignatureSha256,
      execution_attestation_base64: attestationBytes.toString('base64'),
      execution_signature_bundle_base64: signatureBytes.toString('base64'),
    },
    options: {
      verifyRecoveryExecutionSignature(actualAttestation, actualSignature) {
        if (
          createHash('sha256').update(actualAttestation).digest('hex') !== expectedAttestationSha256
          || createHash('sha256').update(actualSignature).digest('hex') !== expectedSignatureSha256
        ) {
          throw new Error('fixture signature verification rejected forged self-consistent evidence');
        }
      },
    },
  };
}

function releaseEntry(overrides = {}) {
  return {
    sourceSha,
    checkedAt,
    command: 'verified-command',
    exitCode: 0,
    ...overrides,
  };
}

function drProvenance({ sourceUri, backupSha256, observedAt = '2026-07-10T11:59:00.000Z' }) {
  const sourceVersion = 'provider-version-20260710';
  const sourceBytes = 4096;
  const readbackCommandSha256 = 'c'.repeat(64);
  const principal = 'arn:aws:iam::123456789012:role/dr-readback';
  const requestId = 'provider-request-123456';
  const readback = {
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
  };
  const readbackBytes = bytes(readback);
  return {
    source_kind: 's3',
    source_version: sourceVersion,
    source_provider_version: sourceVersion,
    source_expected_sha256: backupSha256,
    source_retrieved_bytes: sourceBytes,
    source_readback_sha256: createHash('sha256').update(readbackBytes).digest('hex'),
    source_readback_base64: readbackBytes.toString('base64'),
    source_readback_verified: true,
    source_readback_principal: principal,
    source_readback_request_id: requestId,
    source_readback_observed_at: observedAt,
    source_readback_command_sha256: readbackCommandSha256,
    source_fetch_command_sha256: 'd'.repeat(64),
    source_adapter_attestation_uri: 'https://evidence.example/recovery/adapter-attestation-20260710.json',
    source_adapter_attestation_sha256: 'e'.repeat(64),
    source_adapter_signature_bundle_uri: 'https://evidence.example/recovery/adapter-attestation-20260710.sigstore.json',
    source_adapter_signature_bundle_sha256: 'f'.repeat(64),
    source_adapter_certificate_identity: 'https://github.com/example/lunchlineup/.github/workflows/ci.yml@refs/heads/main',
    source_adapter_oidc_issuer: 'https://token.actions.githubusercontent.com',
  };
}

test('retained DR evidence must prove the claimed successful restore', () => {
  const entry = releaseEntry({
    backupSha256: 'b'.repeat(64),
    restoredTableCount: 12,
    sourceUri: 's3://launch-proof/backup.sql.zst.gpg',
  });
  const provenance = drProvenance({ sourceUri: entry.sourceUri, backupSha256: entry.backupSha256 });
  const artifact = {
    status: 'ok',
    source_sha: sourceSha,
    completed_at: checkedAt,
    backup_sha256: entry.backupSha256,
    restored_table_count: entry.restoredTableCount,
    source_uri: entry.sourceUri,
    started_at: '2026-07-10T11:58:00.000Z',
    run_id: 'dr-run-20260710',
    target_identity: 'isolated-postgres-dr-20260710',
    target_system_identifier: '7123456789012345678',
    target_environment: 'isolated-recovery',
    app_role_verified: true,
    container: 'lunchlineup-dr-drill-20260710',
    cleanup_status: 'succeeded',
    cleanup_container: 'lunchlineup-dr-drill-20260710',
    cleanup_container_absent: true,
    cleanup_checked_at: '2026-07-10T11:59:30.000Z',
    cleanup_evidence: 'docker-ps-exact-name-v1',
    ...provenance,
  };
  const executionBinding = {
    run: { id: artifact.run_id, releaseSha: sourceSha, startedAt: artifact.started_at, completedAt: checkedAt },
    source: {
      kind: provenance.source_kind,
      uri: entry.sourceUri,
      version: provenance.source_version,
      checksum: { algorithm: 'sha256', value: entry.backupSha256 },
      bytes: provenance.source_retrieved_bytes,
    },
    providerReadback: {
      principal: provenance.source_readback_principal,
      requestId: provenance.source_readback_request_id,
      observedAt: provenance.source_readback_observed_at,
      sha256: provenance.source_readback_sha256,
    },
    target: {
      environment: artifact.target_environment,
      identity: artifact.target_identity,
      systemIdentifier: artifact.target_system_identifier,
    },
    outcome: {
      status: 'succeeded',
      restoredTableCount: entry.restoredTableCount,
      appRoleVerified: true,
      cleanup: {
        status: artifact.cleanup_status,
        container: artifact.cleanup_container,
        containerAbsent: true,
        checkedAt: artifact.cleanup_checked_at,
        evidence: artifact.cleanup_evidence,
      },
    },
  };
  const signed = signedExecutionProof(executionBinding, checkedAt);
  Object.assign(artifact, signed.fields);
  const verifyDr = (candidate, options = signed.options) => (
    verifyFetchedEvidenceArtifact('drDrill', bytes(candidate), entry, releaseManifest, options)
  );

  assert.doesNotThrow(() => verifyDr(artifact));
  assert.throws(
    () => verifyDr({ ...artifact, status: 'failed' }),
    /status must be ok or passed/,
  );
  assert.throws(
    () => verifyDr({ ...artifact, restored_table_count: 0 }),
    /does not match/,
  );
  assert.throws(
    () => verifyDr({ ...artifact, completed_at: '2026-07-10T11:59:59.000Z' }),
    /completedAt does not match/,
  );
  assert.throws(
    () => verifyDr({ ...artifact, source_sha: 'c'.repeat(40) }),
    /sourceSha does not match/,
  );
  for (const [override, expected] of [
    [{ source_provider_version: 'wrong-provider-version' }, /sourceProviderVersion/],
    [{ source_retrieved_bytes: 4095 }, /sourceReadback must exactly bind/],
    [{ source_readback_sha256: 'd'.repeat(64) }, /sourceReadbackSha256/],
    [{ source_readback_principal: 'arn:aws:iam::123456789012:role/other' }, /sourceReadback must exactly bind/],
    [{ source_readback_request_id: '' }, /sourceReadbackRequestId/],
    [{ cleanup_status: 'failed' }, /cleanupStatus must be succeeded/],
    [{ cleanup_container_absent: false }, /cleanupContainerAbsent must be true/],
    [{ cleanup_container: 'lunchlineup-dr-drill-other' }, /cleanupContainer does not match/],
    [{ cleanup_checked_at: '2026-07-10T12:00:01.000Z' }, /cleanupCheckedAt must be captured/],
    [{ cleanup_evidence: 'caller-assertion' }, /cleanupEvidence must be docker-ps-exact-name-v1/],
  ]) {
    assert.throws(() => verifyDr({ ...artifact, ...override }), expected);
  }
  const staleProvenance = drProvenance({
    sourceUri: entry.sourceUri,
    backupSha256: entry.backupSha256,
    observedAt: '2026-07-10T11:00:00.000Z',
  });
  assert.throws(
    () => verifyDr({ ...artifact, ...staleProvenance }),
    /fresh provider observation/,
  );

  const forgedBinding = {
    ...executionBinding,
    outcome: { ...executionBinding.outcome, restoredTableCount: 99 },
  };
  const forged = {
    ...artifact,
    restored_table_count: 99,
    ...signedExecutionProof(forgedBinding, checkedAt).fields,
  };
  assert.throws(
    () => verifyFetchedEvidenceArtifact(
      'drDrill',
      bytes(forged),
      { ...entry, restoredTableCount: 99 },
      releaseManifest,
      signed.options,
    ),
    /signature verification rejected forged self-consistent evidence/,
  );

  const forgedCleanupCheckedAt = '2026-07-10T11:59:45.000Z';
  const forgedCleanupBinding = {
    ...executionBinding,
    outcome: {
      ...executionBinding.outcome,
      cleanup: { ...executionBinding.outcome.cleanup, checkedAt: forgedCleanupCheckedAt },
    },
  };
  const forgedCleanup = {
    ...artifact,
    cleanup_checked_at: forgedCleanupCheckedAt,
    ...signedExecutionProof(forgedCleanupBinding, checkedAt).fields,
  };
  assert.throws(
    () => verifyDr(forgedCleanup),
    /signature verification rejected forged self-consistent evidence/,
  );
});

test('retained PITR evidence proves a named COMPLETE backup, WAL target, restore, and invariants', () => {
  const sourceTimestamp = '2026-07-10T10:00:00.000Z';
  const recoveryTargetTime = '2026-07-10T11:00:00.000Z';
  const entry = releaseEntry({
    baseBackupId: '20260710T100000Z-1234',
    baseBackupUri: 's3://lunchlineup-prod/postgres/basebackups/20260710T100000Z-1234/COMPLETE',
    archivedWalSegment: '00000001000000000000002A',
    archivedWalUri: 's3://lunchlineup-prod/postgres/wal/00000001000000000000002A',
    recoveryTargetTime,
    sourceTimestamp,
  });
  const invariantChecks = [
    { name: 'core-relations-readable', status: 'passed', checkedAt },
    { name: 'constraints-validated', status: 'passed', checkedAt },
  ];
  const readbackObjects = {
    complete: { uri: entry.baseBackupUri, versionId: 'complete-version-20260710', sha256: '1'.repeat(64), bytes: 128 },
    archive: { uri: entry.baseBackupUri.replace(/COMPLETE$/, 'base.tar.gz'), versionId: 'archive-version-20260710', sha256: '2'.repeat(64), bytes: 4096 },
    manifest: { uri: entry.baseBackupUri.replace(/COMPLETE$/, 'backup_manifest'), versionId: 'manifest-version-20260710', sha256: '3'.repeat(64), bytes: 512 },
    wal: { uri: entry.archivedWalUri, versionId: 'wal-version-20260710-2a', sha256: '4'.repeat(64), bytes: 8192 },
  };
  const artifact = {
    status: 'passed',
    sourceSha,
    checkedAt,
    command: entry.command,
    exitCode: 0,
    baseBackupId: entry.baseBackupId,
    baseBackupStatus: 'COMPLETE',
    baseBackupUri: entry.baseBackupUri,
    archivedWalSegment: entry.archivedWalSegment,
    archivedWalUri: entry.archivedWalUri,
    recoveryTargetTime,
    sourceTimestamp,
    restoreCompletedAt: '2026-07-10T11:30:00.000Z',
    baseBackupCompleteVersionId: 'complete-version-20260710',
    baseBackupArchiveVersionId: 'archive-version-20260710',
    baseBackupManifestVersionId: 'manifest-version-20260710',
    archivedWalVersionId: 'wal-version-20260710-2a',
    providerReadback: {
      status: 'verified',
      mechanism: 'provider-api',
      principal: 'arn:aws:iam::123456789012:role/pitr-readback',
      requestId: 'pitr-readback-request-1234',
      observedAt: '2026-07-10T11:59:00.000Z',
      versions: {
        complete: 'complete-version-20260710',
        archive: 'archive-version-20260710',
        manifest: 'manifest-version-20260710',
        wal: 'wal-version-20260710-2a',
      },
      objects: readbackObjects,
    },
    startedAt: '2026-07-10T10:30:00.000Z',
    runId: 'pitr-run-20260710',
    targetIdentity: 'isolated-postgres-pitr-20260710',
    targetSystemIdentifier: '8123456789012345678',
    targetEnvironment: 'isolated-recovery',
    restoreSucceeded: true,
    recoveryTargetReached: true,
    recoveryPaused: true,
    invariantChecks,
  };
  const boundObjects = Object.fromEntries(Object.entries(readbackObjects).map(([key, object]) => [key, {
    uri: object.uri,
    versionId: object.versionId,
    checksum: { algorithm: 'sha256', value: object.sha256 },
    bytes: object.bytes,
  }]));
  const executionBinding = {
    run: { id: artifact.runId, releaseSha: sourceSha, startedAt: artifact.startedAt, completedAt: artifact.restoreCompletedAt },
    source: { baseBackupId: entry.baseBackupId, objects: boundObjects },
    providerReadback: {
      principal: artifact.providerReadback.principal,
      requestId: artifact.providerReadback.requestId,
      observedAt: artifact.providerReadback.observedAt,
    },
    target: {
      environment: artifact.targetEnvironment,
      identity: artifact.targetIdentity,
      systemIdentifier: artifact.targetSystemIdentifier,
      recoveryTargetTime,
    },
    outcome: {
      status: 'succeeded',
      restoreSucceeded: true,
      recoveryTargetReached: true,
      recoveryPaused: true,
      invariantChecksSha256: createHash('sha256').update(canonicalJson(invariantChecks)).digest('hex'),
    },
  };
  const signed = signedExecutionProof(executionBinding, artifact.restoreCompletedAt);
  Object.assign(artifact, signed.fields);
  const verifyPitr = (candidate, options = signed.options) => (
    verifyFetchedEvidenceArtifact('pitrDrill', bytes(candidate), entry, releaseManifest, options)
  );

  assert.doesNotThrow(() => verifyPitr(artifact));
  assert.throws(
    () => verifyPitr({ ...artifact, baseBackupStatus: 'INCOMPLETE' }),
    /baseBackupStatus/,
  );
  assert.throws(
    () => verifyPitr({ ...artifact, recoveryTargetReached: false }),
    /recoveryTargetReached must be true/,
  );
  assert.throws(
    () => verifyPitr({ ...artifact, invariantChecks: [] }),
    /invariantChecks must be non-empty/,
  );
  assert.throws(
    () => verifyPitr({ ...artifact, archivedWalVersionId: 'null' }),
    /exact immutable provider version/,
  );
  assert.throws(
    () => verifyPitr({
      ...artifact,
      providerReadback: { ...artifact.providerReadback, versions: { ...artifact.providerReadback.versions, wal: 'old-version' } },
    }),
    /providerReadback\.versions\.wal/,
  );

  const forgedObjects = {
    ...readbackObjects,
    wal: { ...readbackObjects.wal, bytes: readbackObjects.wal.bytes + 1 },
  };
  const forgedBinding = {
    ...executionBinding,
    source: {
      ...executionBinding.source,
      objects: {
        ...executionBinding.source.objects,
        wal: { ...executionBinding.source.objects.wal, bytes: forgedObjects.wal.bytes },
      },
    },
  };
  const forged = {
    ...artifact,
    providerReadback: { ...artifact.providerReadback, objects: forgedObjects },
    ...signedExecutionProof(forgedBinding, artifact.restoreCompletedAt).fields,
  };
  assert.throws(() => verifyPitr(forged), /signature verification rejected forged self-consistent evidence/);
});

test('candidate DAST and load evidence bind served release, immutable images, raw result digests, and thresholds', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-candidate-evidence-'));
  try {
    const zapReport = join(scratch, 'zap.json');
    const zapHtml = join(scratch, 'zap.html');
    const artilleryResult = join(scratch, 'artillery.json');
    const availabilityResult = join(scratch, 'availability.json');
    writeFileSync(zapReport, JSON.stringify({ site: [{ alerts: [] }] }));
    writeFileSync(zapHtml, '<!doctype html><title>ZAP report</title>');
    writeFileSync(artilleryResult, JSON.stringify({ aggregate: { counters: { 'http.requests': 8, 'http.codes.200': 8, 'vusers.failed': 0 }, summaries: { 'http.response_time': { p99: 999 } } } }));
    writeFileSync(availabilityResult, JSON.stringify({ status: 'passed', requestCount: 2 }));
    const image = `registry.example/zap@sha256:${'d'.repeat(64)}`;
    const base = {
      'source-sha': sourceSha,
      'target-url': 'https://lunchlineup.example/health',
      'served-release-sha': sourceSha,
      'tool-image': image,
      'command-exit-code': '0',
      command: 'scripts/candidate-proof.sh https://lunchlineup.example/health',
    };
    const dast = emitCandidateEvidence('dast', { ...base, 'raw-report': zapReport, 'raw-html': zapHtml });
    const load = emitCandidateEvidence('load', { ...base, 'raw-result': artilleryResult, 'availability-result': availabilityResult });
    const dastEntry = releaseEntry({ command: dast.command, checkedAt: dast.checkedAt, rawReportSha256: dast.raw.report.sha256 });
    const loadEntry = releaseEntry({ command: load.command, checkedAt: load.checkedAt, artilleryResultSha256: load.raw.artilleryResult.sha256, availabilityImportResultSha256: load.raw.availabilityImportResult.sha256 });
    assert.doesNotThrow(() => verifyFetchedEvidenceArtifact('dast', bytes(dast), dastEntry, releaseManifest));
    assert.doesNotThrow(() => verifyFetchedEvidenceArtifact('load', bytes(load), loadEntry, releaseManifest));
    const dastEvidence = join(scratch, 'dast-evidence.json');
    const loadEvidence = join(scratch, 'load-evidence.json');
    writeFileSync(dastEvidence, bytes(dast));
    writeFileSync(loadEvidence, bytes(load));
    assert.doesNotThrow(() => verifyCandidateEvidenceBundle('dast', {
      evidence: dastEvidence,
      'raw-report': zapReport,
      'raw-html': zapHtml,
      'expected-source-sha': sourceSha,
      'expected-tool-image': image,
      'max-age-seconds': 300,
    }));
    assert.doesNotThrow(() => verifyCandidateEvidenceBundle('load', {
      evidence: loadEvidence,
      'raw-result': artilleryResult,
      'availability-result': availabilityResult,
      'expected-source-sha': sourceSha,
      'expected-tool-image': image,
      'max-age-seconds': 300,
    }));
    assert.throws(() => verifyFetchedEvidenceArtifact('dast', bytes({ ...dast, servedReleaseSha: 'b'.repeat(40) }), dastEntry, releaseManifest), /servedReleaseSha/);
    assert.throws(() => verifyFetchedEvidenceArtifact('dast', bytes({ ...dast, tool: { ...dast.tool, image: 'zaproxy/zaproxy:stable' } }), dastEntry, releaseManifest), /immutable image reference/);
    assert.throws(() => verifyFetchedEvidenceArtifact('dast', bytes({ ...dast, raw: {} }), dastEntry, releaseManifest), /raw\.report/);
    assert.throws(() => verifyFetchedEvidenceArtifact('dast', bytes({ ...dast, dast: { ...dast.dast, findingCounts: { ...dast.dast.findingCounts, high: 1 } } }), dastEntry, releaseManifest), /zero high and critical/);
    assert.throws(() => verifyFetchedEvidenceArtifact('load', bytes({ ...load, load: { ...load.load, p99Ms: 1000 } }), loadEntry, releaseManifest), /p99Ms must be below/);
    assert.throws(() => verifyFetchedEvidenceArtifact('load', bytes({ ...load, raw: { ...load.raw, artilleryResult: { ...load.raw.artilleryResult, sha256: '0'.repeat(64) } } }), loadEntry, releaseManifest), /artilleryResult\.sha256 does not match/);
    writeFileSync(zapHtml, '<!doctype html><title>Tampered report</title>');
    assert.throws(() => verifyCandidateEvidenceBundle('dast', {
      evidence: dastEvidence,
      'raw-report': zapReport,
      'raw-html': zapHtml,
      'expected-source-sha': sourceSha,
      'expected-tool-image': image,
      'max-age-seconds': 300,
    }), /downloaded raw file/);
    const stale = { ...dast, checkedAt: '2026-01-01T00:00:00.000Z', capturedAt: '2026-01-01T00:00:00.000Z' };
    writeFileSync(dastEvidence, bytes(stale));
    assert.throws(() => verifyCandidateEvidenceBundle('dast', {
      evidence: dastEvidence,
      'raw-report': zapReport,
      'raw-html': zapHtml,
      'expected-source-sha': sourceSha,
      'expected-tool-image': image,
      'max-age-seconds': 300,
      now: Date.parse('2026-01-01T01:00:00.000Z'),
    }), /is stale/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('retained alert evidence must prove delivery', () => {
  const entry = releaseEntry();
  const artifact = { status: 'passed', sourceSha, checkedAt, command: entry.command, exitCode: 0, delivered: true };

  assert.doesNotThrow(() => verifyFetchedEvidenceArtifact('alertRoute', bytes(artifact), entry, releaseManifest));
  assert.throws(
    () => verifyFetchedEvidenceArtifact('alertRoute', bytes({ ...artifact, delivered: false }), entry, releaseManifest),
    /delivered must be true/,
  );
});

test('post-deploy external health rejects a spoofed candidate release identity', () => {
  const bodyBytes = Buffer.from('{"status":"ok"}');
  assert.doesNotThrow(() => verifyExternalHealthResponse({
    status: 200,
    servedReleaseSha: sourceSha,
    expectedReleaseSha: sourceSha,
    bodyBytes,
  }));
  assert.throws(
    () => verifyExternalHealthResponse({
      status: 200,
      servedReleaseSha: 'b'.repeat(40),
      expectedReleaseSha: sourceSha,
      bodyBytes,
    }),
    /served release .* expected/,
  );
});

test('candidate evidence helpers reject mutable ZAP images and emit the canonical evidence inputs', () => {
  const dast = readFileSync(new URL('../../scripts/run-dast.sh', import.meta.url), 'utf8');
  const load = readFileSync(new URL('../../scripts/load-test.sh', import.meta.url), 'utf8');
  assert.match(dast, /ZAP_IMAGE must be an immutable name@sha256:<64hex> reference/);
  assert.match(dast, /--served-release-sha/);
  assert.match(dast, /--raw-report/);
  assert.match(dast, /--raw-html/);
  assert.match(dast, /--volume "\$SOURCE_ROOT:\/workspace:ro"/);
  assert.match(dast, /--volume "\$OUTPUT_DIR:\/zap\/wrk:rw"/);
  assert.doesNotMatch(dast, /\$SOURCE_ROOT:[^"\n]*:rw/);
  assert.match(load, /--availability-result/);
  assert.match(load, /--raw-result/);
  assert.match(load, /X-LunchLineup-Release/);
  assert.match(load, /--volume "\$SOURCE_ROOT:\/workspace:ro"/);
  assert.match(load, /--volume "\$OUTPUT_DIR:\/output:rw"/);
  assert.doesNotMatch(load, /\$SOURCE_ROOT:[^"\n]*:rw/);
});
