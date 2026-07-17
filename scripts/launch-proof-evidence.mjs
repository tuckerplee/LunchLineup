import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProviderCommand } from './rehydrate-runtime-secret.mjs';

const successfulStatuses = new Set(['ok', 'passed']);
const recoveryExecutionCertificateIdentity = 'https://github.com/tuckerplee/LunchLineup/.github/workflows/ci.yml@refs/heads/main';
const recoveryExecutionOidcIssuer = 'https://token.actions.githubusercontent.com';

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function requiredValue(object, keys, label) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  throw new Error(`${label} is required.`);
}

function requireSuccessfulStatus(artifact, label) {
  const status = String(requiredValue(artifact, ['status'], `${label}.status`)).toLowerCase();
  if (!successfulStatuses.has(status)) {
    throw new Error(`${label}.status must be ok or passed, got ${status}.`);
  }
}

function requireExact(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} does not match the launch-proof manifest claim.`);
  }
}

function requireIntegerClaim(artifact, keys, expected, label) {
  const value = Number(requiredValue(artifact, keys, label));
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  requireExact(value, Number(expected), label);
  return value;
}

function requireTimestamp(value, label) {
  const text = String(value);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO-8601 timestamp.`);
  return { text, timestamp };
}

function requireExplicitIdentifier(value, label) {
  const text = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(text) || /(^|[._-])(latest|current)([._-]|$)/i.test(text)) {
    throw new Error(`${label} must name one explicit retained object.`);
  }
  return text;
}

function verifyReleaseBoundArtifact(artifact, entry, label) {
  requireSuccessfulStatus(artifact, label);
  requireExact(
    requiredValue(artifact, ['sourceSha', 'source_sha'], `${label}.sourceSha`),
    entry.sourceSha,
    `${label}.sourceSha`,
  );
  requireExact(requiredValue(artifact, ['checkedAt', 'checked_at'], `${label}.checkedAt`), entry.checkedAt, `${label}.checkedAt`);
  requireExact(requiredValue(artifact, ['command'], `${label}.command`), entry.command, `${label}.command`);
  const exitCode = Number(requiredValue(artifact, ['exitCode', 'exit_code'], `${label}.exitCode`));
  if (!Number.isInteger(exitCode) || exitCode !== 0) {
    throw new Error(`${label}.exitCode must be 0.`);
  }
  requireExact(exitCode, Number(entry.exitCode), `${label}.exitCode`);
}

function parseArtifact(bytes, label) {
  let artifact;
  try {
    artifact = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return requireObject(artifact, label);
}

function requireSha256(value, label) {
  const digest = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest.`);
  return digest;
}

function requireProviderIdentifier(value, label, minimum, maximum) {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a bounded printable provider identifier without whitespace.`);
  }
  const text = value;
  if (text.length < minimum || text.length > maximum || !/^[\x21-\x7e]+$/.test(text)) {
    throw new Error(`${label} must be a bounded printable provider identifier without whitespace.`);
  }
  return text;
}

function requireImmutableProviderVersion(value, label) {
  const version = requireProviderIdentifier(value, label, 1, 1024);
  if (/^(latest|null)$/i.test(version)) throw new Error(`${label} must name one exact immutable provider version.`);
  return version;
}

function requireImmutableRetainedUri(value, label) {
  if (typeof value !== 'string' || /\s|(^|[/:_.-])(latest|current)([/:_.-]|$)/i.test(value)) {
    throw new Error(`${label} must name one immutable retained artifact.`);
  }
  let uri;
  try { uri = new URL(value); } catch { throw new Error(`${label} must be a valid retained-artifact URI.`); }
  if (!['https:', 's3:'].includes(uri.protocol) || uri.username || uri.password || uri.hash) {
    throw new Error(`${label} must use authenticated https:// or s3:// retrieval.`);
  }
  return value;
}

function verifyRecoveryAdapterProvenanceClaims(artifact, label) {
  const attestationUri = requireImmutableRetainedUri(
    requiredValue(artifact, ['source_adapter_attestation_uri', 'sourceAdapterAttestationUri'], `${label}.sourceAdapterAttestationUri`),
    `${label}.sourceAdapterAttestationUri`,
  );
  const signatureBundleUri = requireImmutableRetainedUri(
    requiredValue(artifact, ['source_adapter_signature_bundle_uri', 'sourceAdapterSignatureBundleUri'], `${label}.sourceAdapterSignatureBundleUri`),
    `${label}.sourceAdapterSignatureBundleUri`,
  );
  if (attestationUri === signatureBundleUri) {
    throw new Error(`${label} recovery adapter attestation and signature bundle must be distinct retained artifacts.`);
  }
  return {
    attestationUri,
    attestationSha256: requireSha256(
      requiredValue(artifact, ['source_adapter_attestation_sha256', 'sourceAdapterAttestationSha256'], `${label}.sourceAdapterAttestationSha256`),
      `${label}.sourceAdapterAttestationSha256`,
    ),
    signatureBundleUri,
    signatureBundleSha256: requireSha256(
      requiredValue(artifact, ['source_adapter_signature_bundle_sha256', 'sourceAdapterSignatureBundleSha256'], `${label}.sourceAdapterSignatureBundleSha256`),
      `${label}.sourceAdapterSignatureBundleSha256`,
    ),
    certificateIdentity: requireProviderIdentifier(
      requiredValue(artifact, ['source_adapter_certificate_identity', 'sourceAdapterCertificateIdentity'], `${label}.sourceAdapterCertificateIdentity`),
      `${label}.sourceAdapterCertificateIdentity`, 8, 1024,
    ),
    oidcIssuer: requireProviderIdentifier(
      requiredValue(artifact, ['source_adapter_oidc_issuer', 'sourceAdapterOidcIssuer'], `${label}.sourceAdapterOidcIssuer`),
      `${label}.sourceAdapterOidcIssuer`, 8, 1024,
    ),
    fetchAdapterSha256: requireSha256(
      requiredValue(artifact, ['source_fetch_command_sha256', 'sourceFetchCommandSha256'], `${label}.sourceFetchCommandSha256`),
      `${label}.sourceFetchCommandSha256`,
    ),
    readbackAdapterSha256: requireSha256(
      requiredValue(artifact, ['source_readback_command_sha256', 'sourceReadbackCommandSha256'], `${label}.sourceReadbackCommandSha256`),
      `${label}.sourceReadbackCommandSha256`,
    ),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundedBase64(value, label, maximumBytes = 1024 * 1024) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be canonical base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength < 1 || decoded.byteLength > maximumBytes || decoded.toString('base64') !== value) {
    throw new Error(`${label} must contain bounded canonical bytes.`);
  }
  return decoded;
}

function verifyRecoveryExecutionSignature(attestationBytes, signatureBytes) {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-recovery-execution-'));
  const attestationPath = join(scratch, 'execution-attestation.json');
  const signaturePath = join(scratch, 'execution-attestation.sigstore.json');
  try {
    writeFileSync(attestationPath, attestationBytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(signaturePath, signatureBytes, { mode: 0o600, flag: 'wx' });
    runBoundedProviderCommand(
      process.env.RECOVERY_EXECUTION_COSIGN_BINARY || 'cosign',
      [
        'verify-blob', attestationPath,
        '--bundle', signaturePath,
        '--certificate-identity', recoveryExecutionCertificateIdentity,
        '--certificate-oidc-issuer', recoveryExecutionOidcIssuer,
      ],
      {
        operation: 'read',
        timeoutMs: process.env.RECOVERY_EXECUTION_VERIFY_TIMEOUT_MS ?? 60_000,
        killAfterMs: process.env.RECOVERY_EXECUTION_VERIFY_KILL_AFTER_MS ?? 5_000,
        maxOutputBytes: 1024 * 1024,
        encoding: 'utf8',
        label: 'Recovery execution signature verification',
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function verifySignedRecoveryExecution(artifact, label, binding, timing, options) {
  const attestationUri = requireImmutableRetainedUri(
    requiredValue(artifact, ['execution_attestation_uri', 'executionAttestationUri'], `${label}.executionAttestationUri`),
    `${label}.executionAttestationUri`,
  );
  const signatureUri = requireImmutableRetainedUri(
    requiredValue(artifact, ['execution_signature_bundle_uri', 'executionSignatureBundleUri'], `${label}.executionSignatureBundleUri`),
    `${label}.executionSignatureBundleUri`,
  );
  if (attestationUri === signatureUri) throw new Error(`${label} execution attestation and signature bundle must be distinct retained artifacts.`);
  const attestationSha256 = requireSha256(
    requiredValue(artifact, ['execution_attestation_sha256', 'executionAttestationSha256'], `${label}.executionAttestationSha256`),
    `${label}.executionAttestationSha256`,
  );
  const signatureSha256 = requireSha256(
    requiredValue(artifact, ['execution_signature_bundle_sha256', 'executionSignatureBundleSha256'], `${label}.executionSignatureBundleSha256`),
    `${label}.executionSignatureBundleSha256`,
  );
  const attestationBytes = boundedBase64(
    requiredValue(artifact, ['execution_attestation_base64', 'executionAttestationBase64'], `${label}.executionAttestationBase64`),
    `${label}.executionAttestationBase64`,
  );
  const signatureBytes = boundedBase64(
    requiredValue(artifact, ['execution_signature_bundle_base64', 'executionSignatureBundleBase64'], `${label}.executionSignatureBundleBase64`),
    `${label}.executionSignatureBundleBase64`,
  );
  requireExact(createHash('sha256').update(attestationBytes).digest('hex'), attestationSha256, `${label}.executionAttestationSha256`);
  requireExact(createHash('sha256').update(signatureBytes).digest('hex'), signatureSha256, `${label}.executionSignatureBundleSha256`);

  const attestation = parseArtifact(attestationBytes, `${label}.executionAttestation`);
  const issued = requireTimestamp(attestation.issuedAt, `${label}.executionAttestation.issuedAt`);
  const expires = requireTimestamp(attestation.expiresAt, `${label}.executionAttestation.expiresAt`);
  const bindingSha256 = createHash('sha256').update(canonicalJson(binding)).digest('hex');
  if (
    attestation.version !== 1
    || attestation.kind !== 'lunchlineup-signed-recovery-execution-proof'
    || attestation.certificateIdentity !== recoveryExecutionCertificateIdentity
    || attestation.oidcIssuer !== recoveryExecutionOidcIssuer
    || requireSha256(attestation.bindingSha256, `${label}.executionAttestation.bindingSha256`) !== bindingSha256
    || canonicalJson(attestation.binding) !== canonicalJson(binding)
    || issued.timestamp < timing.completed.timestamp - 30_000
    || issued.timestamp > timing.checked.timestamp + 30_000
    || expires.timestamp <= issued.timestamp
    || expires.timestamp - issued.timestamp > 90 * 86_400_000
  ) {
    throw new Error(`${label}.executionAttestation must be an independently signed exact execution and provider-readback proof.`);
  }
  (options.verifyRecoveryExecutionSignature ?? verifyRecoveryExecutionSignature)(attestationBytes, signatureBytes);
}

export function recoveryAdapterProvenanceFromEvidence(bytes) {
  const label = 'launchProof.evidence.drDrill.artifact';
  const artifact = parseArtifact(bytes, label);
  return verifyRecoveryAdapterProvenanceClaims(artifact, label);
}

function verifyDrProviderProvenance(artifact, label) {
  if (requiredValue(artifact, ['source_readback_verified', 'sourceReadbackVerified'], `${label}.sourceReadbackVerified`) !== true) {
    throw new Error(`${label}.sourceReadbackVerified must be true.`);
  }
  const sourceUri = String(requiredValue(artifact, ['source_uri', 'sourceUri'], `${label}.sourceUri`));
  const sourceKind = String(requiredValue(artifact, ['source_kind', 'sourceKind'], `${label}.sourceKind`));
  if (!['s3', 'rclone', 'rsync', 'scp', 'ssh', 'https', 'restic', 'b2'].includes(sourceKind)) {
    throw new Error(`${label}.sourceKind must identify an off-host provider.`);
  }
  const requestedVersion = requireProviderIdentifier(
    requiredValue(artifact, ['source_version', 'sourceVersion'], `${label}.sourceVersion`),
    `${label}.sourceVersion`,
    1,
    1024,
  );
  if (/^(latest|null)$/i.test(requestedVersion)) throw new Error(`${label}.sourceVersion must be one exact provider version.`);
  const providerVersion = requireProviderIdentifier(
    requiredValue(artifact, ['source_provider_version', 'sourceProviderVersion'], `${label}.sourceProviderVersion`),
    `${label}.sourceProviderVersion`,
    1,
    1024,
  );
  requireExact(providerVersion, requestedVersion, `${label}.sourceProviderVersion`);
  const backupSha256 = requireSha256(
    requiredValue(artifact, ['backup_sha256', 'backupSha256'], `${label}.backupSha256`),
    `${label}.backupSha256`,
  );
  requireExact(
    requireSha256(
      requiredValue(artifact, ['source_expected_sha256', 'sourceExpectedSha256'], `${label}.sourceExpectedSha256`),
      `${label}.sourceExpectedSha256`,
    ),
    backupSha256,
    `${label}.sourceExpectedSha256`,
  );
  const retrievedBytes = Number(requiredValue(
    artifact,
    ['source_retrieved_bytes', 'sourceRetrievedBytes'],
    `${label}.sourceRetrievedBytes`,
  ));
  if (!Number.isSafeInteger(retrievedBytes) || retrievedBytes <= 0) {
    throw new Error(`${label}.sourceRetrievedBytes must be a positive integer.`);
  }
  const readbackSha256 = requireSha256(
    requiredValue(artifact, ['source_readback_sha256', 'sourceReadbackSha256'], `${label}.sourceReadbackSha256`),
    `${label}.sourceReadbackSha256`,
  );
  const readbackBase64 = String(requiredValue(
    artifact,
    ['source_readback_base64', 'sourceReadbackBase64'],
    `${label}.sourceReadbackBase64`,
  ));
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(readbackBase64)) {
    throw new Error(`${label}.sourceReadbackBase64 must be canonical base64.`);
  }
  const readbackBytes = Buffer.from(readbackBase64, 'base64');
  if (readbackBytes.byteLength < 1 || readbackBytes.byteLength > 64 * 1024 || readbackBytes.toString('base64') !== readbackBase64) {
    throw new Error(`${label}.sourceReadbackBase64 must be canonical bounded provider metadata.`);
  }
  requireExact(createHash('sha256').update(readbackBytes).digest('hex'), readbackSha256, `${label}.sourceReadbackSha256`);
  const readback = parseArtifact(readbackBytes, `${label}.sourceReadback`);
  const principal = requireProviderIdentifier(
    requiredValue(artifact, ['source_readback_principal', 'sourceReadbackPrincipal'], `${label}.sourceReadbackPrincipal`),
    `${label}.sourceReadbackPrincipal`,
    3,
    512,
  );
  const requestId = requireProviderIdentifier(
    requiredValue(artifact, ['source_readback_request_id', 'sourceReadbackRequestId'], `${label}.sourceReadbackRequestId`),
    `${label}.sourceReadbackRequestId`,
    8,
    256,
  );
  const observed = requireTimestamp(
    requiredValue(artifact, ['source_readback_observed_at', 'sourceReadbackObservedAt'], `${label}.sourceReadbackObservedAt`),
    `${label}.sourceReadbackObservedAt`,
  );
  const started = requireTimestamp(requiredValue(artifact, ['started_at', 'startedAt'], `${label}.startedAt`), `${label}.startedAt`);
  const completed = requireTimestamp(
    requiredValue(artifact, ['completed_at', 'completedAt'], `${label}.completedAt`),
    `${label}.completedAt`,
  );
  if (observed.timestamp < started.timestamp - 30_000 || observed.timestamp > completed.timestamp + 30_000) {
    throw new Error(`${label}.sourceReadbackObservedAt must be a fresh provider observation captured during the DR drill.`);
  }
  const readbackCommandSha256 = requireSha256(
    requiredValue(artifact, ['source_readback_command_sha256', 'sourceReadbackCommandSha256'], `${label}.sourceReadbackCommandSha256`),
    `${label}.sourceReadbackCommandSha256`,
  );
  verifyRecoveryAdapterProvenanceClaims(artifact, label);
  if (
    readback.version !== 2
    || readback.kind !== 'lunchlineup-provider-authenticated-object-readback'
    || readback.sourceKind !== sourceKind
    || readback.sourceUri !== sourceUri
    || readback.requestedVersion !== requestedVersion
    || readback.resolvedVersion !== providerVersion
    || readback.objectChecksum?.algorithm !== 'sha256'
    || readback.objectChecksum?.value !== backupSha256
    || readback.bytes !== retrievedBytes
    || readback.readbackCommandSha256 !== readbackCommandSha256
    || readback.authentication?.status !== 'verified'
    || readback.authentication?.mechanism !== 'provider-api'
    || readback.authentication?.principal !== principal
    || readback.authentication?.requestId !== requestId
    || readback.observedAt !== observed.text
  ) {
    throw new Error(`${label}.sourceReadback must exactly bind provider version, bytes, digest, principal, request ID, and observation time.`);
  }
  return {
    sourceKind,
    sourceUri,
    sourceVersion: requestedVersion,
    backupSha256,
    retrievedBytes,
    readbackSha256,
    principal,
    requestId,
    observed,
    started,
    completed,
  };
}

export function verifyFetchedEvidenceArtifact(key, bytes, entry, releaseManifest, options = {}) {
  if (!['drDrill', 'pitrDrill', 'dast', 'load', 'alertRoute'].includes(key)) return;

  const label = `launchProof.evidence.${key}.artifact`;
  const artifact = parseArtifact(bytes, label);

  if (key === 'drDrill') {
    requireSuccessfulStatus(artifact, label);
    requireExact(
      requiredValue(artifact, ['checkedAt', 'checked_at', 'completedAt', 'completed_at'], `${label}.completedAt`),
      entry.checkedAt,
      `${label}.completedAt`,
    );
    requireExact(
      requiredValue(artifact, ['sourceSha', 'source_sha'], `${label}.sourceSha`),
      entry.sourceSha,
      `${label}.sourceSha`,
    );
    requireExact(
      requiredValue(artifact, ['backup_sha256', 'backupSha256'], `${label}.backupSha256`),
      entry.backupSha256,
      `${label}.backupSha256`,
    );
    const restoredTableCount = requireIntegerClaim(
      artifact,
      ['restored_table_count', 'restoredTableCount'],
      entry.restoredTableCount,
      `${label}.restoredTableCount`,
    );
    if (restoredTableCount <= 0) throw new Error(`${label}.restoredTableCount must be positive.`);
    requireExact(
      requiredValue(artifact, ['source_uri', 'sourceUri'], `${label}.sourceUri`),
      entry.sourceUri,
      `${label}.sourceUri`,
    );
    const provenance = verifyDrProviderProvenance(artifact, label);
    const runId = requireProviderIdentifier(
      requiredValue(artifact, ['run_id', 'runId'], `${label}.runId`),
      `${label}.runId`, 8, 256,
    );
    const targetIdentity = requireProviderIdentifier(
      requiredValue(artifact, ['target_identity', 'targetIdentity'], `${label}.targetIdentity`),
      `${label}.targetIdentity`, 8, 512,
    );
    const targetSystemIdentifier = String(requiredValue(
      artifact,
      ['target_system_identifier', 'targetSystemIdentifier'],
      `${label}.targetSystemIdentifier`,
    ));
    if (!/^[0-9]{10,32}$/.test(targetSystemIdentifier)) {
      throw new Error(`${label}.targetSystemIdentifier must be a queried PostgreSQL system identifier.`);
    }
    const targetEnvironment = String(requiredValue(
      artifact,
      ['target_environment', 'targetEnvironment'],
      `${label}.targetEnvironment`,
    ));
    if (!['disposable', 'isolated-recovery'].includes(targetEnvironment)) {
      throw new Error(`${label}.targetEnvironment must identify an isolated recovery target.`);
    }
    if (requiredValue(artifact, ['app_role_verified', 'appRoleVerified'], `${label}.appRoleVerified`) !== true) {
      throw new Error(`${label}.appRoleVerified must be true.`);
    }
    const cleanupStatus = String(requiredValue(
      artifact,
      ['cleanup_status', 'cleanupStatus'],
      `${label}.cleanupStatus`,
    ));
    if (cleanupStatus !== 'succeeded') throw new Error(`${label}.cleanupStatus must be succeeded.`);
    const cleanupContainer = requireProviderIdentifier(
      requiredValue(artifact, ['cleanup_container', 'cleanupContainer'], `${label}.cleanupContainer`),
      `${label}.cleanupContainer`, 8, 256,
    );
    if (!cleanupContainer.startsWith('lunchlineup-dr-drill-')) {
      throw new Error(`${label}.cleanupContainer must identify the disposable DR container.`);
    }
    requireExact(
      cleanupContainer,
      requiredValue(artifact, ['container'], `${label}.container`),
      `${label}.cleanupContainer`,
    );
    if (requiredValue(
      artifact,
      ['cleanup_container_absent', 'cleanupContainerAbsent'],
      `${label}.cleanupContainerAbsent`,
    ) !== true) {
      throw new Error(`${label}.cleanupContainerAbsent must be true.`);
    }
    const cleanupChecked = requireTimestamp(
      requiredValue(artifact, ['cleanup_checked_at', 'cleanupCheckedAt'], `${label}.cleanupCheckedAt`),
      `${label}.cleanupCheckedAt`,
    );
    if (cleanupChecked.timestamp < provenance.started.timestamp || cleanupChecked.timestamp > provenance.completed.timestamp) {
      throw new Error(`${label}.cleanupCheckedAt must be captured after drill start and before successful completion.`);
    }
    const cleanupEvidence = String(requiredValue(
      artifact,
      ['cleanup_evidence', 'cleanupEvidence'],
      `${label}.cleanupEvidence`,
    ));
    if (cleanupEvidence !== 'docker-ps-exact-name-v1') {
      throw new Error(`${label}.cleanupEvidence must be docker-ps-exact-name-v1.`);
    }
    verifySignedRecoveryExecution(artifact, label, {
      run: {
        id: runId,
        releaseSha: entry.sourceSha,
        startedAt: provenance.started.text,
        completedAt: provenance.completed.text,
      },
      source: {
        kind: provenance.sourceKind,
        uri: provenance.sourceUri,
        version: provenance.sourceVersion,
        checksum: { algorithm: 'sha256', value: provenance.backupSha256 },
        bytes: provenance.retrievedBytes,
      },
      providerReadback: {
        principal: provenance.principal,
        requestId: provenance.requestId,
        observedAt: provenance.observed.text,
        sha256: provenance.readbackSha256,
      },
      target: {
        environment: targetEnvironment,
        identity: targetIdentity,
        systemIdentifier: targetSystemIdentifier,
      },
      outcome: {
        status: 'succeeded',
        restoredTableCount,
        appRoleVerified: true,
        cleanup: {
          status: cleanupStatus,
          container: cleanupContainer,
          containerAbsent: true,
          checkedAt: cleanupChecked.text,
          evidence: cleanupEvidence,
        },
      },
    }, { completed: provenance.completed, checked: provenance.completed }, options);
    return;
  }

  if (key === 'pitrDrill') {
    verifyReleaseBoundArtifact(artifact, entry, label);
    const backupId = requireExplicitIdentifier(
      requiredValue(artifact, ['baseBackupId', 'base_backup_id'], `${label}.baseBackupId`),
      `${label}.baseBackupId`,
    );
    requireExact(backupId, entry.baseBackupId, `${label}.baseBackupId`);
    requireExact(
      String(requiredValue(artifact, ['baseBackupStatus', 'base_backup_status'], `${label}.baseBackupStatus`)).toUpperCase(),
      'COMPLETE',
      `${label}.baseBackupStatus`,
    );
    requireExact(
      requiredValue(artifact, ['baseBackupUri', 'base_backup_uri'], `${label}.baseBackupUri`),
      entry.baseBackupUri,
      `${label}.baseBackupUri`,
    );
    if (!String(entry.baseBackupUri).endsWith(`/basebackups/${backupId}/COMPLETE`)) {
      throw new Error(`${label}.baseBackupUri must identify the named backup COMPLETE marker.`);
    }

    const walSegment = String(requiredValue(artifact, ['archivedWalSegment', 'archived_wal_segment'], `${label}.archivedWalSegment`));
    if (!/^[A-F0-9]{24}$/i.test(walSegment)) throw new Error(`${label}.archivedWalSegment must be a WAL segment name.`);
    requireExact(walSegment, entry.archivedWalSegment, `${label}.archivedWalSegment`);
    requireExact(
      requiredValue(artifact, ['archivedWalUri', 'archived_wal_uri'], `${label}.archivedWalUri`),
      entry.archivedWalUri,
      `${label}.archivedWalUri`,
    );
    if (!String(entry.archivedWalUri).endsWith(`/wal/${walSegment}`)) {
      throw new Error(`${label}.archivedWalUri must identify the claimed WAL segment.`);
    }

    const source = requireTimestamp(
      requiredValue(artifact, ['sourceTimestamp', 'source_timestamp'], `${label}.sourceTimestamp`),
      `${label}.sourceTimestamp`,
    );
    requireExact(source.text, entry.sourceTimestamp, `${label}.sourceTimestamp`);
    const checked = requireTimestamp(requiredValue(artifact, ['checkedAt', 'checked_at'], `${label}.checkedAt`), `${label}.checkedAt`);
    const target = requireTimestamp(
      requiredValue(artifact, ['recoveryTargetTime', 'recovery_target_time'], `${label}.recoveryTargetTime`),
      `${label}.recoveryTargetTime`,
    );
    requireExact(target.text, entry.recoveryTargetTime, `${label}.recoveryTargetTime`);
    const restored = requireTimestamp(
      requiredValue(artifact, ['restoreCompletedAt', 'restore_completed_at'], `${label}.restoreCompletedAt`),
      `${label}.restoreCompletedAt`,
    );
    if (source.timestamp > target.timestamp || target.timestamp > restored.timestamp || restored.timestamp > checked.timestamp) {
      throw new Error(`${label} timestamps must order source <= target <= restore <= check.`);
    }
    const versions = {
      complete: requireImmutableProviderVersion(
        requiredValue(artifact, ['baseBackupCompleteVersionId', 'base_backup_complete_version_id'], `${label}.baseBackupCompleteVersionId`),
        `${label}.baseBackupCompleteVersionId`,
      ),
      archive: requireImmutableProviderVersion(
        requiredValue(artifact, ['baseBackupArchiveVersionId', 'base_backup_archive_version_id'], `${label}.baseBackupArchiveVersionId`),
        `${label}.baseBackupArchiveVersionId`,
      ),
      manifest: requireImmutableProviderVersion(
        requiredValue(artifact, ['baseBackupManifestVersionId', 'base_backup_manifest_version_id'], `${label}.baseBackupManifestVersionId`),
        `${label}.baseBackupManifestVersionId`,
      ),
      wal: requireImmutableProviderVersion(
        requiredValue(artifact, ['archivedWalVersionId', 'archived_wal_version_id'], `${label}.archivedWalVersionId`),
        `${label}.archivedWalVersionId`,
      ),
    };
    const readback = requireObject(
      requiredValue(artifact, ['providerReadback', 'provider_readback'], `${label}.providerReadback`),
      `${label}.providerReadback`,
    );
    if (readback.status !== 'verified' || readback.mechanism !== 'provider-api') {
      throw new Error(`${label}.providerReadback must be verified through the provider API.`);
    }
    const providerPrincipal = requireProviderIdentifier(readback.principal, `${label}.providerReadback.principal`, 3, 512);
    const providerRequestId = requireProviderIdentifier(readback.requestId, `${label}.providerReadback.requestId`, 8, 256);
    const readbackObserved = requireTimestamp(readback.observedAt, `${label}.providerReadback.observedAt`);
    if (
      readbackObserved.timestamp < restored.timestamp - 30_000
      || readbackObserved.timestamp > checked.timestamp
      || checked.timestamp - readbackObserved.timestamp > 300_000
    ) {
      throw new Error(`${label}.providerReadback.observedAt must be a fresh authenticated observation from the completed restore.`);
    }
    const readbackVersions = requireObject(readback.versions, `${label}.providerReadback.versions`);
    for (const [keyName, expectedVersion] of Object.entries(versions)) {
      requireExact(
        requireImmutableProviderVersion(readbackVersions[keyName], `${label}.providerReadback.versions.${keyName}`),
        expectedVersion,
        `${label}.providerReadback.versions.${keyName}`,
      );
    }
    const baseBackupPrefix = String(entry.baseBackupUri).slice(0, -'COMPLETE'.length);
    const expectedObjectUris = {
      complete: entry.baseBackupUri,
      archive: `${baseBackupPrefix}base.tar.gz`,
      manifest: `${baseBackupPrefix}backup_manifest`,
      wal: entry.archivedWalUri,
    };
    const readbackObjects = requireObject(readback.objects, `${label}.providerReadback.objects`);
    const boundObjects = {};
    for (const [keyName, expectedVersion] of Object.entries(versions)) {
      const object = requireObject(readbackObjects[keyName], `${label}.providerReadback.objects.${keyName}`);
      requireExact(object.uri, expectedObjectUris[keyName], `${label}.providerReadback.objects.${keyName}.uri`);
      requireExact(
        requireImmutableProviderVersion(object.versionId, `${label}.providerReadback.objects.${keyName}.versionId`),
        expectedVersion,
        `${label}.providerReadback.objects.${keyName}.versionId`,
      );
      const objectBytes = Number(object.bytes);
      if (!Number.isSafeInteger(objectBytes) || objectBytes <= 0) {
        throw new Error(`${label}.providerReadback.objects.${keyName}.bytes must be a positive integer.`);
      }
      boundObjects[keyName] = {
        uri: object.uri,
        versionId: expectedVersion,
        checksum: { algorithm: 'sha256', value: requireSha256(object.sha256, `${label}.providerReadback.objects.${keyName}.sha256`) },
        bytes: objectBytes,
      };
    }
    for (const [field, artifactKeys] of [
      ['restoreSucceeded', ['restoreSucceeded', 'restore_succeeded']],
      ['recoveryTargetReached', ['recoveryTargetReached', 'recovery_target_reached']],
      ['recoveryPaused', ['recoveryPaused', 'recovery_paused']],
    ]) {
      if (requiredValue(artifact, artifactKeys, `${label}.${field}`) !== true) {
        throw new Error(`${label}.${field} must be true.`);
      }
    }
    const checks = requiredValue(artifact, ['invariantChecks', 'invariant_checks'], `${label}.invariantChecks`);
    if (!Array.isArray(checks) || checks.length === 0) throw new Error(`${label}.invariantChecks must be non-empty.`);
    const names = new Set();
    for (const [index, check] of checks.entries()) {
      const item = requireObject(check, `${label}.invariantChecks[${index}]`);
      const name = String(requiredValue(item, ['name'], `${label}.invariantChecks[${index}].name`)).trim();
      if (!name || names.has(name)) throw new Error(`${label}.invariantChecks names must be non-empty and unique.`);
      names.add(name);
      requireSuccessfulStatus(item, `${label}.invariantChecks[${index}]`);
      const invariantChecked = requireTimestamp(
        requiredValue(item, ['checkedAt', 'checked_at'], `${label}.invariantChecks[${index}].checkedAt`),
        `${label}.invariantChecks[${index}].checkedAt`,
      );
      if (invariantChecked.timestamp > checked.timestamp) {
        throw new Error(`${label}.invariantChecks[${index}].checkedAt must not be later than the artifact check.`);
      }
    }
    const started = requireTimestamp(
      requiredValue(artifact, ['startedAt', 'started_at'], `${label}.startedAt`),
      `${label}.startedAt`,
    );
    if (started.timestamp > restored.timestamp) throw new Error(`${label}.startedAt must not be later than restoreCompletedAt.`);
    const runId = requireProviderIdentifier(
      requiredValue(artifact, ['runId', 'run_id'], `${label}.runId`),
      `${label}.runId`, 8, 256,
    );
    const targetIdentity = requireProviderIdentifier(
      requiredValue(artifact, ['targetIdentity', 'target_identity'], `${label}.targetIdentity`),
      `${label}.targetIdentity`, 8, 512,
    );
    const targetSystemIdentifier = String(requiredValue(
      artifact,
      ['targetSystemIdentifier', 'target_system_identifier'],
      `${label}.targetSystemIdentifier`,
    ));
    if (!/^[0-9]{10,32}$/.test(targetSystemIdentifier)) {
      throw new Error(`${label}.targetSystemIdentifier must be a queried PostgreSQL system identifier.`);
    }
    const targetEnvironment = String(requiredValue(
      artifact,
      ['targetEnvironment', 'target_environment'],
      `${label}.targetEnvironment`,
    ));
    if (!['disposable', 'isolated-recovery'].includes(targetEnvironment)) {
      throw new Error(`${label}.targetEnvironment must identify an isolated recovery target.`);
    }
    verifySignedRecoveryExecution(artifact, label, {
      run: { id: runId, releaseSha: entry.sourceSha, startedAt: started.text, completedAt: restored.text },
      source: { baseBackupId: backupId, objects: boundObjects },
      providerReadback: {
        principal: providerPrincipal,
        requestId: providerRequestId,
        observedAt: readbackObserved.text,
      },
      target: {
        environment: targetEnvironment,
        identity: targetIdentity,
        systemIdentifier: targetSystemIdentifier,
        recoveryTargetTime: target.text,
      },
      outcome: {
        status: 'succeeded',
        restoreSucceeded: true,
        recoveryTargetReached: true,
        recoveryPaused: true,
        invariantChecksSha256: createHash('sha256').update(canonicalJson(checks)).digest('hex'),
      },
    }, { completed: restored, checked }, options);
    return;
  }

  verifyReleaseBoundArtifact(artifact, entry, label);

  if (key === 'dast') {
    requireCommandOutcome(artifact, label);
    verifyCandidateDast(artifact, entry, label);
    return;
  }

  if (key === 'load') {
    requireCommandOutcome(artifact, label);
    verifyCandidateLoad(artifact, entry, label);
    return;
  }

  if (key === 'alertRoute') {
    if (requiredValue(artifact, ['delivered'], `${label}.delivered`) !== true) {
      throw new Error(`${label}.delivered must be true.`);
    }
    return;
  }

}

function requireStringValue(value, label) {
  const text = String(value).trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function candidateSourceSha(value, label) {
  const sourceSha = requireStringValue(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error(`${label} must be a 40-character Git SHA.`);
  return sourceSha;
}

function candidateDigest(value, label) {
  const digest = requireStringValue(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest.`);
  return digest;
}

function requireCommandOutcome(artifact, label) {
  const exitCode = Number(requiredValue(artifact, ['exitCode', 'exit_code'], `${label}.exitCode`));
  const commandExitCode = Number(requiredValue(artifact, ['commandExitCode'], `${label}.commandExitCode`));
  if (!Number.isInteger(exitCode) || exitCode !== 0) throw new Error(`${label}.exitCode must be 0.`);
  if (!Number.isInteger(commandExitCode) || commandExitCode !== 0) throw new Error(`${label}.commandExitCode must be 0.`);
}
function candidateBinding(artifact, entry, label) {
  const sourceSha = candidateSourceSha(entry.sourceSha, `${label}.entry.sourceSha`);
  for (const key of ['sourceSha', 'expectedSourceSha', 'servedReleaseSha']) {
    if (candidateSourceSha(requiredValue(artifact, [key], `${label}.${key}`), `${label}.${key}`) !== sourceSha) {
      throw new Error(`${label}.${key} must match the launch-proof sourceSha.`);
    }
  }
  const targetUrl = requireStringValue(requiredValue(artifact, ['targetUrl'], `${label}.targetUrl`), `${label}.targetUrl`);
  try {
    const url = new URL(targetUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error(`${label}.targetUrl must be an absolute HTTP(S) URL.`);
  }
  const tool = requireObject(requiredValue(artifact, ['tool'], `${label}.tool`), `${label}.tool`);
  const image = requireStringValue(requiredValue(tool, ['image'], `${label}.tool.image`), `${label}.tool.image`);
  if (!/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(`${label}.tool.image must be a name@sha256:<64hex> immutable image reference.`);
  }
  if (candidateDigest(requiredValue(tool, ['digest'], `${label}.tool.digest`), `${label}.tool.digest`) !== image.slice(-64)) {
    throw new Error(`${label}.tool.digest must match the immutable tool image digest.`);
  }
  const raw = requireObject(requiredValue(artifact, ['raw'], `${label}.raw`), `${label}.raw`);
  return { sourceSha, raw };
}

function candidateRaw(raw, key, label) {
  const value = requireObject(requiredValue(raw, [key], `${label}.${key}`), `${label}.${key}`);
  candidateDigest(requiredValue(value, ['sha256'], `${label}.${key}.sha256`), `${label}.${key}.sha256`);
  const bytes = Number(requiredValue(value, ['bytes'], `${label}.${key}.bytes`));
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${label}.${key}.bytes must be a positive integer.`);
}

function verifyCandidateDast(artifact, entry, label) {
  const { raw } = candidateBinding(artifact, entry, label);
  candidateRaw(raw, 'report', `${label}.raw`);
  candidateRaw(raw, 'htmlReport', `${label}.raw`);
  if (entry.rawReportSha256 !== undefined && raw.report.sha256 !== entry.rawReportSha256) throw new Error(`${label}.raw.report.sha256 does not match the launch-proof claim.`);
  const dast = requireObject(requiredValue(artifact, ['dast'], `${label}.dast`), `${label}.dast`);
  const counts = requireObject(requiredValue(dast, ['findingCounts'], `${label}.dast.findingCounts`), `${label}.dast.findingCounts`);
  for (const severity of ['informational', 'low', 'medium', 'high', 'critical']) {
    const count = Number(requiredValue(counts, [severity], `${label}.dast.findingCounts.${severity}`));
    if (!Number.isInteger(count) || count < 0) throw new Error(`${label}.dast.findingCounts.${severity} must be a non-negative integer.`);
  }
  if (counts.high !== 0 || counts.critical !== 0) throw new Error(`${label}.dast must contain zero high and critical findings.`);
  const thresholds = requireObject(requiredValue(dast, ['severityThreshold'], `${label}.dast.severityThreshold`), `${label}.dast.severityThreshold`);
  if (Number(thresholds.high) !== 0 || Number(thresholds.critical) !== 0) {
    throw new Error(`${label}.dast.severityThreshold must require zero high and critical findings.`);
  }
}

function verifyCandidateLoad(artifact, entry, label) {
  const { raw } = candidateBinding(artifact, entry, label);
  candidateRaw(raw, 'artilleryResult', `${label}.raw`);
  candidateRaw(raw, 'availabilityImportResult', `${label}.raw`);
  if (entry.artilleryResultSha256 !== undefined && raw.artilleryResult.sha256 !== entry.artilleryResultSha256) throw new Error(`${label}.raw.artilleryResult.sha256 does not match the launch-proof claim.`);
  if (entry.availabilityImportResultSha256 !== undefined && raw.availabilityImportResult.sha256 !== entry.availabilityImportResultSha256) throw new Error(`${label}.raw.availabilityImportResult.sha256 does not match the launch-proof claim.`);
  const load = requireObject(requiredValue(artifact, ['load'], `${label}.load`), `${label}.load`);
  const p99Ms = Number(requiredValue(load, ['p99Ms'], `${label}.load.p99Ms`));
  const failedRequests = Number(requiredValue(load, ['failedRequests'], `${label}.load.failedRequests`));
  const failedVUs = Number(requiredValue(load, ['failedVUs'], `${label}.load.failedVUs`));
  if (!Number.isFinite(p99Ms) || p99Ms < 0 || p99Ms >= 1000) throw new Error(`${label}.load.p99Ms must be below 1000.`);
  if (!Number.isInteger(failedRequests) || failedRequests !== 0) throw new Error(`${label}.load.failedRequests must be 0.`);
  if (!Number.isInteger(failedVUs) || failedVUs !== 0) throw new Error(`${label}.load.failedVUs must be 0.`);
  const thresholds = requireObject(requiredValue(load, ['thresholds'], `${label}.load.thresholds`), `${label}.load.thresholds`);
  if (Number(thresholds.p99MsExclusive) !== 1000 || Number(thresholds.failedRequests) !== 0 || Number(thresholds.failedVUs) !== 0) {
    throw new Error(`${label}.load.thresholds must require p99 below 1000ms with zero failed requests and VUs.`);
  }
}

function rawFile(path) {
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0) throw new Error(`Raw result must not be empty: ${path}`);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function verifyRawClaim(path, claim, label) {
  candidateRaw({ value: claim }, 'value', label);
  const actual = rawFile(path);
  if (actual.sha256 !== claim.sha256) throw new Error(`${label}.sha256 does not match the downloaded raw file.`);
  if (actual.bytes.byteLength !== claim.bytes) throw new Error(`${label}.bytes does not match the downloaded raw file.`);
}

export function verifyCandidateEvidenceBundle(kind, options) {
  if (!['dast', 'load'].includes(kind)) throw new Error(`Unsupported candidate evidence kind: ${kind}`);
  const expectedSourceSha = candidateSourceSha(options['expected-source-sha'], 'expectedSourceSha');
  const evidence = requireObject(readJson(options.evidence, `${kind} canonical evidence`), `${kind} canonical evidence`);
  if (evidence.kind !== kind) throw new Error(`${kind} canonical evidence.kind must be ${kind}.`);
  requireSuccessfulStatus(evidence, `${kind} canonical evidence`);
  requireCommandOutcome(evidence, `${kind} canonical evidence`);
  const checked = requireTimestamp(evidence.checkedAt, `${kind} canonical evidence.checkedAt`);
  const captured = requireTimestamp(evidence.capturedAt, `${kind} canonical evidence.capturedAt`);
  if (captured.text !== checked.text) throw new Error(`${kind} canonical evidence.capturedAt must equal checkedAt.`);
  const maxAgeSeconds = Number(options['max-age-seconds']);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('maxAgeSeconds must be a positive integer.');
  const now = options.now === undefined ? Date.now() : Number(options.now);
  if (!Number.isFinite(now) || checked.timestamp > now + 300_000) throw new Error(`${kind} canonical evidence.checkedAt is in the future.`);
  if (now - checked.timestamp > maxAgeSeconds * 1000) throw new Error(`${kind} canonical evidence is stale.`);
  const entry = {
    sourceSha: expectedSourceSha,
    checkedAt: evidence.checkedAt,
    command: evidence.command,
    exitCode: 0,
  };
  if (kind === 'dast') verifyCandidateDast(evidence, entry, `${kind} canonical evidence`);
  else verifyCandidateLoad(evidence, entry, `${kind} canonical evidence`);

  const expectedToolImage = requireStringValue(options['expected-tool-image'], 'expectedToolImage');
  if (evidence.tool.image !== expectedToolImage) throw new Error(`${kind} canonical evidence.tool.image does not match the expected immutable image.`);
  if (kind === 'dast') {
    verifyRawClaim(options['raw-report'], evidence.raw.report, 'dast canonical evidence.raw.report');
    verifyRawClaim(options['raw-html'], evidence.raw.htmlReport, 'dast canonical evidence.raw.htmlReport');
  } else {
    verifyRawClaim(options['raw-result'], evidence.raw.artilleryResult, 'load canonical evidence.raw.artilleryResult');
    verifyRawClaim(options['availability-result'], evidence.raw.availabilityImportResult, 'load canonical evidence.raw.availabilityImportResult');
  }
  return evidence;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionMap(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Evidence emitter requires --key value arguments.');
    options[key.slice(2)] = value;
  }
  return options;
}

function zapCounts(report) {
  const counts = { informational: 0, low: 0, medium: 0, high: 0, critical: 0 };
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (Array.isArray(value.alerts)) {
      for (const alert of value.alerts) {
        const risk = String(alert.riskdesc ?? alert.risk ?? alert.riskcode ?? '').toLowerCase();
        const severity = risk.includes('critical') || risk === '4' ? 'critical' : risk.includes('high') || risk === '3' ? 'high' : risk.includes('medium') || risk === '2' ? 'medium' : risk.includes('low') || risk === '1' ? 'low' : 'informational';
        counts[severity] += Array.isArray(alert.instances) && alert.instances.length ? alert.instances.length : 1;
      }
    }
    if (Array.isArray(value.site)) value.site.forEach(visit);
  };
  visit(report);
  return counts;
}

export function emitCandidateEvidence(kind, options) {
  const sourceSha = candidateSourceSha(options['source-sha'], 'sourceSha');
  const targetUrl = requireStringValue(options['target-url'], 'targetUrl');
  const servedReleaseSha = String(options['served-release-sha'] ?? '').trim().toLowerCase();
  const image = requireStringValue(options['tool-image'], 'toolImage');
  if (!/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('toolImage must be a name@sha256:<64hex> immutable image reference.');
  const commandExitCode = Number(options['command-exit-code']);
  if (!Number.isInteger(commandExitCode) || commandExitCode < 0) throw new Error('commandExitCode must be a non-negative integer.');
  const checkedAt = new Date().toISOString();
  const evidence = {
    version: 1,
    kind,
    status: 'failed',
    sourceSha,
    expectedSourceSha: sourceSha,
    targetUrl,
    servedReleaseSha,
    tool: { image, digest: image.slice(-64) },
    checkedAt,
    capturedAt: checkedAt,
    command: requireStringValue(options.command, 'command'),
    commandExitCode,
    exitCode: 1,
    summary: `${kind} candidate evidence for ${sourceSha}.`,
  };
  if (kind === 'dast') {
    const report = rawFile(options['raw-report']);
    const htmlReport = rawFile(options['raw-html']);
    const counts = zapCounts(readJson(options['raw-report'], 'ZAP report'));
    evidence.raw = {
      report: { sha256: report.sha256, bytes: report.bytes.byteLength },
      htmlReport: { sha256: htmlReport.sha256, bytes: htmlReport.bytes.byteLength },
    };
    evidence.dast = { findingCounts: counts, severityThreshold: { high: 0, critical: 0 } };
    if (commandExitCode === 0 && servedReleaseSha === sourceSha && counts.high === 0 && counts.critical === 0) evidence.status = 'passed';
  } else if (kind === 'load') {
    const artillery = rawFile(options['raw-result']);
    const availability = rawFile(options['availability-result']);
    const aggregate = requireObject(readJson(options['raw-result'], 'Artillery result').aggregate, 'Artillery result.aggregate');
    const counters = requireObject(aggregate.counters, 'Artillery result.aggregate.counters');
    const responseTime = requireObject(aggregate.summaries?.['http.response_time'], 'Artillery result.aggregate.summaries.http.response_time');
    const p99Ms = Number(responseTime.p99);
    const failedRequests = Math.max(0, Number(counters['http.requests'] ?? 0) - Number(counters['http.codes.200'] ?? 0));
    const failedVUs = Number(counters['vusers.failed'] ?? 0);
    evidence.raw = { artilleryResult: { sha256: artillery.sha256, bytes: artillery.bytes.byteLength }, availabilityImportResult: { sha256: availability.sha256, bytes: availability.bytes.byteLength } };
    evidence.load = { p99Ms, failedRequests, failedVUs, thresholds: { p99MsExclusive: 1000, failedRequests: 0, failedVUs: 0 } };
    if (commandExitCode === 0 && servedReleaseSha === sourceSha && p99Ms < 1000 && failedRequests === 0 && failedVUs === 0) evidence.status = 'passed';
  } else {
    throw new Error(`Unsupported candidate evidence kind: ${kind}`);
  }
  evidence.exitCode = evidence.status === 'passed' ? 0 : 1;
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, kind, ...args] = process.argv.slice(2);
    const options = optionMap(args);
    if (command === 'emit') {
      const evidence = emitCandidateEvidence(kind, options);
      const output = resolve(requireStringValue(options.output, 'output'));
      writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
      process.exitCode = evidence.exitCode;
    } else if (command === 'verify-bundle') {
      verifyCandidateEvidenceBundle(kind, options);
      process.stdout.write(`candidate_evidence_ok kind=${kind} source_sha=${options['expected-source-sha']}\n`);
    } else {
      throw new Error('Usage: launch-proof-evidence.mjs <emit|verify-bundle> <dast|load> --key value ...');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
