const successfulStatuses = new Set(['ok', 'passed']);

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

export function verifyFetchedEvidenceArtifact(key, bytes, entry, releaseManifest) {
  if (!['drDrill', 'pitrDrill', 'load', 'alertRoute'].includes(key)) return;

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
    return;
  }

  verifyReleaseBoundArtifact(artifact, entry, label);

  if (key === 'load') {
    const failedRequests = Number(
      requiredValue(artifact, ['failedRequests', 'failed_requests'], `${label}.failedRequests`),
    );
    if (!Number.isInteger(failedRequests) || failedRequests !== 0) {
      throw new Error(`${label}.failedRequests must be 0.`);
    }
    return;
  }

  if (key === 'alertRoute') {
    if (requiredValue(artifact, ['delivered'], `${label}.delivered`) !== true) {
      throw new Error(`${label}.delivered must be true.`);
    }
    return;
  }

}
