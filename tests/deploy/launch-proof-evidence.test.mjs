import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyFetchedEvidenceArtifact } from '../../scripts/launch-proof-evidence.mjs';
import { verifyExternalHealthResponse } from '../../scripts/verify-external-health-release.mjs';

const sourceSha = 'a'.repeat(40);
const checkedAt = '2026-07-10T12:00:00.000Z';
const releaseManifest = {
  productionHealthProof: { url: 'https://lunchlineup.example/health' },
};

function bytes(value) {
  return Buffer.from(JSON.stringify(value));
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

test('retained DR evidence must prove the claimed successful restore', () => {
  const entry = releaseEntry({
    backupSha256: 'b'.repeat(64),
    restoredTableCount: 12,
    sourceUri: 's3://launch-proof/backup.sql.zst.gpg',
  });
  const artifact = {
    status: 'ok',
    source_sha: sourceSha,
    completed_at: checkedAt,
    backup_sha256: entry.backupSha256,
    restored_table_count: entry.restoredTableCount,
    source_uri: entry.sourceUri,
  };

  assert.doesNotThrow(() => verifyFetchedEvidenceArtifact('drDrill', bytes(artifact), entry, releaseManifest));
  assert.throws(
    () => verifyFetchedEvidenceArtifact('drDrill', bytes({ ...artifact, status: 'failed' }), entry, releaseManifest),
    /status must be ok or passed/,
  );
  assert.throws(
    () => verifyFetchedEvidenceArtifact('drDrill', bytes({ ...artifact, restored_table_count: 0 }), entry, releaseManifest),
    /does not match/,
  );
  assert.throws(
    () => verifyFetchedEvidenceArtifact('drDrill', bytes({ ...artifact, completed_at: '2026-07-10T11:59:59.000Z' }), entry, releaseManifest),
    /completedAt does not match/,
  );
  assert.throws(
    () => verifyFetchedEvidenceArtifact('drDrill', bytes({ ...artifact, source_sha: 'c'.repeat(40) }), entry, releaseManifest),
    /sourceSha does not match/,
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
    restoreSucceeded: true,
    recoveryTargetReached: true,
    recoveryPaused: true,
    invariantChecks: [
      { name: 'core-relations-readable', status: 'passed', checkedAt },
      { name: 'constraints-validated', status: 'passed', checkedAt },
    ],
  };

  assert.doesNotThrow(() => verifyFetchedEvidenceArtifact('pitrDrill', bytes(artifact), entry, releaseManifest));
  assert.throws(
    () => verifyFetchedEvidenceArtifact('pitrDrill', bytes({ ...artifact, baseBackupStatus: 'INCOMPLETE' }), entry, releaseManifest),
    /baseBackupStatus/,
  );
  assert.throws(
    () => verifyFetchedEvidenceArtifact('pitrDrill', bytes({ ...artifact, recoveryTargetReached: false }), entry, releaseManifest),
    /recoveryTargetReached must be true/,
  );
  assert.throws(
    () => verifyFetchedEvidenceArtifact('pitrDrill', bytes({ ...artifact, invariantChecks: [] }), entry, releaseManifest),
    /invariantChecks must be non-empty/,
  );
});

test('retained load evidence must be release-bound and contain no failed requests', () => {
  const entry = releaseEntry();
  const artifact = { status: 'passed', sourceSha, checkedAt, command: entry.command, exitCode: 0, failedRequests: 0 };

  assert.doesNotThrow(() => verifyFetchedEvidenceArtifact('load', bytes(artifact), entry, releaseManifest));
  assert.throws(
    () => verifyFetchedEvidenceArtifact('load', bytes({ ...artifact, failedRequests: 1 }), entry, releaseManifest),
    /failedRequests must be 0/,
  );
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
