import { isAbsolute, join } from 'node:path';
import { PLACEHOLDER_RE } from './production-launch-policy-shared.mjs';

function assertOffHostBackupUri(context, key) {
  const { collector, assertRequired } = context;
  const value = assertRequired(key);
  if (!value) return;

  if (PLACEHOLDER_RE.test(value)) {
    collector.fail(`${key} must not contain placeholder text.`);
  }

  if (/^(file:\/\/|\/|\.\/|\.\.\/|https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.))/i.test(value)) {
    collector.fail(`${key} must point at off-host storage, not a local path or private localhost URL.`);
    return;
  }

  if (!/^s3:\/\/[^ /]+\/[^ ]+$/i.test(value)) {
    collector.fail(`${key} must use a versioned Object-Locked s3://bucket/non-root-prefix repository; mutable rclone is forbidden in production.`);
  }
}

function assertPrometheusTextfile(context, key) {
  const { env, collector } = context;
  const value = String(env[key] ?? '').trim();
  if (!value) {
    collector.fail(`${key} is required so operational freshness is observable.`);
    return;
  }
  if (!isAbsolute(value) || !value.endsWith('.prom')) {
    collector.fail(`${key} must be an absolute Prometheus textfile collector .prom path.`);
    return;
  }
  if (/^\.?\/?secrets\//.test(value) || value.includes('\\secrets\\')) {
    collector.fail(`${key} cannot point at the repo-local secrets directory.`);
    return;
  }
  collector.pass(key);
}

function assertPitrConfig(context, managedSecrets) {
  const {
    env,
    collector,
    assertExactValue,
    assertHttpsUrl,
    assertRequired,
  } = context;
  assertExactValue('PITR_ENABLED', 'true');
  assertExactValue('PITR_ARCHIVE_MODE', 'on');
  const endpoint = assertRequired('PITR_S3_ENDPOINT');
  if (endpoint) assertHttpsUrl('PITR_S3_ENDPOINT', endpoint);

  const bucket = assertRequired('PITR_S3_BUCKET');
  if (bucket && !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) {
    collector.fail('PITR_S3_BUCKET must be an explicit valid bucket name.');
  }

  const prefix = assertRequired('PITR_S3_PREFIX');
  if (prefix && (
    prefix.startsWith('/')
    || prefix.endsWith('/')
    || prefix.includes('..')
    || /replace|example|latest|current/i.test(prefix)
  )) {
    collector.fail('PITR_S3_PREFIX must be a dedicated cluster-specific prefix without placeholders.');
  }

  const credentialDirectoryKeys = [
    'PITR_WAL_OBJECT_STORE_SECRETS_DIR',
    'PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR',
    'PITR_RESTORE_OBJECT_STORE_SECRETS_DIR',
    'PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR',
  ];
  const credentialDirectories = credentialDirectoryKeys
    .map((key) => ({ key, path: managedSecrets.assertAbsoluteSecretDirectory(key) }))
    .filter(({ path }) => path);
  const canonicalDirectories = credentialDirectories
    .map(({ path }) => managedSecrets.canonicalManagedSecretPath(path));
  if (new Set(canonicalDirectories).size !== canonicalDirectories.length) {
    collector.fail(
      'PITR WAL, base-backup, restore, and lifecycle-audit identities '
      + 'must use distinct managed-secret directories.',
    );
  }

  const objectLockDays = Number(assertRequired('PITR_OBJECT_LOCK_RETENTION_DAYS'));
  if (!Number.isInteger(objectLockDays) || objectLockDays < 14) {
    collector.fail('PITR_OBJECT_LOCK_RETENTION_DAYS must be an integer of at least 14.');
  }

  const lifecycleMaximumDays = Number(assertRequired('PITR_LIFECYCLE_MAX_RETENTION_DAYS'));
  if (
    !Number.isInteger(lifecycleMaximumDays)
    || lifecycleMaximumDays <= objectLockDays
    || lifecycleMaximumDays > 90
  ) {
    collector.fail(
      'PITR_LIFECYCLE_MAX_RETENTION_DAYS must be an integer greater than immutable retention '
      + 'and no more than 90.',
    );
  }

  const proofPath = managedSecrets.assertAbsoluteManagedSecretPath(
    'PITR_LIFECYCLE_POLICY_PROOF_FILE',
    String(env.PITR_LIFECYCLE_POLICY_PROOF_FILE ?? '').trim(),
    'file',
  );
  context.assertProofArtifactUri('PITR_LIFECYCLE_POLICY_PROOF_URI', { requireJson: true });

  const policySha256 = assertRequired('PITR_LIFECYCLE_POLICY_SHA256');
  if (policySha256 && !/^[a-f0-9]{64}$/.test(policySha256)) {
    collector.fail('PITR_LIFECYCLE_POLICY_SHA256 must be 64 lowercase hex characters.');
  }

  const authorizationSimulatorPath = managedSecrets.assertAbsoluteManagedSecretPath(
    'PITR_AUTHORIZATION_SIMULATOR_FILE',
    String(env.PITR_AUTHORIZATION_SIMULATOR_FILE ?? '').trim(),
    'file',
  );
  const authorizationSimulatorSha256 = assertRequired('PITR_AUTHORIZATION_SIMULATOR_SHA256');
  if (authorizationSimulatorSha256 && !/^[a-f0-9]{64}$/.test(authorizationSimulatorSha256)) {
    collector.fail('PITR_AUTHORIZATION_SIMULATOR_SHA256 must be 64 lowercase hex characters.');
  }
  const authorizationSimulatorTimeout = Number(assertRequired('PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS'));
  if (!Number.isInteger(authorizationSimulatorTimeout) || authorizationSimulatorTimeout < 1 || authorizationSimulatorTimeout > 300) {
    collector.fail('PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS must be an integer from 1 through 300.');
  }

  const files = credentialDirectories.flatMap(({ key, path }) => (
    [
      [key + '_ACCESS_KEY', join(path, 'access_key')],
      [key + '_SECRET_KEY', join(path, 'secret_key')],
    ]
      .map(([role, credentialPath]) => ({
        role,
        path: managedSecrets.assertAbsoluteManagedSecretPath(role, credentialPath, 'file'),
      }))
      .filter(({ path: credentialPath }) => credentialPath)
  ));
  if (proofPath) {
    files.push({ role: 'PITR_LIFECYCLE_POLICY_PROOF_FILE', path: proofPath });
  }
  if (authorizationSimulatorPath) {
    files.push({ role: 'PITR_AUTHORIZATION_SIMULATOR_FILE', path: authorizationSimulatorPath });
  }
  return files;
}

export function validateBackupPitrPolicy(context, managedSecrets) {
  const { collector, assertExactValue, assertRequired } = context;
  assertOffHostBackupUri(context, 'BACKUP_OFFSITE_URI');
  assertExactValue('BACKUP_OFFSITE_RETENTION_DRY_RUN', 'false');
  const backupRetentionDays = Number(assertRequired('BACKUP_OFFSITE_RETENTION_DAYS'));
  if (!Number.isInteger(backupRetentionDays) || backupRetentionDays < 14 || backupRetentionDays > 90) {
    collector.fail('BACKUP_OFFSITE_RETENTION_DAYS must be an integer from 14 through 90 for immutable logical backups.');
  }
  const backupLifecycleMaximumDays = Number(assertRequired('BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS'));
  if (
    !Number.isInteger(backupLifecycleMaximumDays)
    || backupLifecycleMaximumDays < backupRetentionDays
    || backupLifecycleMaximumDays > 365
  ) {
    collector.fail('BACKUP_OFFSITE_LIFECYCLE_MAX_DAYS must cover immutable logical-backup retention and be no more than 365.');
  }
  assertPrometheusTextfile(context, 'BACKUP_METRICS_FILE');
  return assertPitrConfig(context, managedSecrets);
}

function assertPublicStatusHealthUrl(context, key, domain) {
  const { collector, assertHttpsUrl, assertRequired } = context;
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  const hostname = url.hostname.toLowerCase();
  if (domain && hostname !== domain && !hostname.endsWith(`.${domain}`)) {
    collector.fail(`${key} must use DOMAIN or a subdomain of DOMAIN so the public status page checks this launch surface.`);
    return;
  }

  if (!/\/health\/?$/i.test(url.pathname)) {
    collector.fail(`${key} must point at an HTTPS health endpoint ending in /health.`);
    return;
  }

  collector.pass(key);
}

function assertHttpsProofUrl(context, key) {
  const {
    collector,
    assertHttpsUrl,
    assertRequired,
    hasPlaceholderProofReference,
    isVagueProofReference,
  } = context;
  const value = assertRequired(key);
  if (!value) return;

  const url = assertHttpsUrl(key, value);
  if (!url) return;

  if (hasPlaceholderProofReference(value)) {
    collector.fail(`${key} must not contain placeholder text.`);
    return;
  }

  if (isVagueProofReference(value)) {
    collector.fail(`${key} must reference a specific retained proof artifact, ticket, or run, not latest/current.`);
    return;
  }

  collector.pass(key);
}

export function validateRecoveryEvidencePolicy(context, domain) {
  assertPublicStatusHealthUrl(context, 'LUNCHLINEUP_STATUS_HEALTH_URL', domain);
  context.assertProofArtifactUri('LAUNCH_PROOF_MANIFEST_URI', { requireJson: true, httpsOnly: true });
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_DAST_URL');
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_LOAD_TEST_URL');
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_ALERT_ROUTE_URL');
  assertHttpsProofUrl(context, 'LAUNCH_PROOF_EXTERNAL_HEALTH_URL');
  context.assertProofArtifactUri('LAUNCH_PROOF_DR_DRILL_URI', { requireJson: true });
}
