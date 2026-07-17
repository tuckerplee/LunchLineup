#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProviderCommand, validateRuntimeSecretDescriptor } from './rehydrate-runtime-secret.mjs';
import { verifyCosignBlob, verifyReleaseAuthenticity, writeReleaseIndex } from './signed-release-authenticity.mjs';

const retentionTagKey = 'lunchlineup-release-retention';
const activeRetentionTag = 'active';
const obsoleteRetentionTag = 'obsolete';

function fail(message) { throw new Error(message); }
function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) fail(`${name} is required.`);
  return process.argv[index + 1];
}
function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
function registryCommandTimeoutMs() {
  return boundedInteger('RELEASE_REGISTRY_COMMAND_TIMEOUT_MS', 120_000, 1_000, 600_000);
}
function registryFetchMaxBytes() {
  return boundedInteger('RELEASE_REGISTRY_FETCH_MAX_BYTES', 10 * 1024 * 1024, 1_024, 100 * 1024 * 1024);
}
function registryImmutableRetentionDays() {
  return boundedInteger('RELEASE_REGISTRY_IMMUTABLE_RETENTION_DAYS', 35, 1, 90);
}
function registryLifecycleMaximumDays() {
  const maximum = boundedInteger('RELEASE_REGISTRY_LIFECYCLE_MAX_RETENTION_DAYS', 90, 1, 365);
  if (maximum < registryImmutableRetentionDays()) {
    fail('RELEASE_REGISTRY_LIFECYCLE_MAX_RETENTION_DAYS must not be less than RELEASE_REGISTRY_IMMUTABLE_RETENTION_DAYS.');
  }
  return maximum;
}
function runResult(command, args, operation = 'read', extra = {}) {
  return runBoundedProviderCommand(command, args, {
    operation,
    timeoutMs: registryCommandTimeoutMs(),
    maxOutputBytes: 4 * 1024 * 1024,
    encoding: 'utf8',
    allowFailure: true,
    label: 'Release registry provider command',
    ...extra,
  });
}
function options(name) {
  return process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
}
function run(command, args, operation = 'read', extra = {}) {
  const result = runResult(command, args, operation, extra);
  const stderr = String(result.stderr ?? '');
  if (result.status === 70 || /mutation state is unknown/i.test(stderr)) {
    fail(`${command} did not prove mutation completion; remote state is unknown and requires authenticated readback reconciliation.`);
  }
  if (result.error || result.status !== 0) fail(`${command} failed while accessing the release registry.`);
  return result.stdout;
}
function awsInvocation(args) {
  const command = process.env.RELEASE_REGISTRY_AWS_BINARY || 'aws';
  let prefix = [];
  if (process.env.RELEASE_REGISTRY_AWS_ARGUMENT_PREFIX_JSON) {
    try {
      prefix = JSON.parse(process.env.RELEASE_REGISTRY_AWS_ARGUMENT_PREFIX_JSON);
    } catch {
      fail('RELEASE_REGISTRY_AWS_ARGUMENT_PREFIX_JSON must be valid JSON.');
    }
    if (!Array.isArray(prefix) || prefix.some((value) => typeof value !== 'string')) {
      fail('RELEASE_REGISTRY_AWS_ARGUMENT_PREFIX_JSON must be an array of strings.');
    }
  }
  return { command, args: [...prefix, ...args] };
}
function runAwsResult(args, operation = 'read', extra = {}) {
  const invocation = awsInvocation(args);
  return runResult(invocation.command, invocation.args, operation, extra);
}
function runAws(args, operation = 'read', extra = {}) {
  const invocation = awsInvocation(args);
  return run(invocation.command, invocation.args, operation, extra);
}
function runAwsJson(args, label) {
  const text = runAws(args);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} metadata must be a JSON object.`);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} metadata was not valid provider JSON.`);
    throw error;
  }
}
function base(uri) { return uri.replace(/\/+$/, ''); }
function localPath(uri, suffix) {
  if (!uri.startsWith('file://') || process.env.ALLOW_LOCAL_RELEASE_REGISTRY !== 'true') return null;
  return join(resolve(fileURLToPath(uri)), ...suffix.split('/'));
}
function s3Location(uri, suffix) {
  const parsed = new URL(uri);
  return { bucket: parsed.hostname, key: `${parsed.pathname.replace(/^\/+|\/+$/g, '')}/${suffix}`.replace(/^\//, '') };
}
function s3RegistryPrefix(uri) {
  return new URL(uri).pathname.replace(/^\/+|\/+$/g, '');
}
function lifecycleTag(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.Key !== 'string'
    || typeof value.Value !== 'string'
  ) return null;
  return [value.Key, value.Value];
}
function lifecycleRuleScope(rule) {
  if (typeof rule.Prefix === 'string' && rule.Filter === undefined) {
    return { prefix: rule.Prefix.replace(/^\/+|\/+$/g, ''), tags: new Map() };
  }
  if (rule.Prefix !== undefined) return null;
  if (rule.Filter === undefined) return { prefix: '', tags: new Map() };
  if (!rule.Filter || typeof rule.Filter !== 'object' || Array.isArray(rule.Filter)) return null;
  const keys = Object.keys(rule.Filter);
  if (keys.length === 1 && typeof rule.Filter.Prefix === 'string') {
    return { prefix: rule.Filter.Prefix.replace(/^\/+|\/+$/g, ''), tags: new Map() };
  }
  if (keys.length === 1 && rule.Filter.Tag !== undefined) {
    const tag = lifecycleTag(rule.Filter.Tag);
    return tag ? { prefix: '', tags: new Map([tag]) } : null;
  }
  if (keys.length !== 1 || !rule.Filter.And || typeof rule.Filter.And !== 'object' || Array.isArray(rule.Filter.And)) {
    return null;
  }
  const and = rule.Filter.And;
  if (Object.keys(and).some((key) => !['Prefix', 'Tags'].includes(key))) return null;
  if (and.Prefix !== undefined && typeof and.Prefix !== 'string') return null;
  if (!Array.isArray(and.Tags) || and.Tags.length === 0) return null;
  const tags = new Map();
  for (const value of and.Tags) {
    const tag = lifecycleTag(value);
    if (!tag || tags.has(tag[0])) return null;
    tags.set(...tag);
  }
  return { prefix: (and.Prefix ?? '').replace(/^\/+|\/+$/g, ''), tags };
}
function listValue(value) {
  return Array.isArray(value) ? value : [value];
}
function wildcardPrincipal(principal) {
  return principal === '*' || principal?.AWS === '*' || (Array.isArray(principal?.AWS) && principal.AWS.includes('*'));
}
function deletionResourceCovers(resource, bucket, registryPrefix) {
  if (typeof resource !== 'string') return false;
  const bucketObjects = `arn:aws:s3:::${bucket}/*`;
  const prefixObjects = registryPrefix ? `arn:aws:s3:::${bucket}/${registryPrefix}/*` : bucketObjects;
  return resource === bucketObjects || resource === prefixObjects;
}
function validateDeletionProtection(policyEnvelope, bucket, registryPrefix) {
  if (typeof policyEnvelope.Policy !== 'string' || !policyEnvelope.Policy) {
    fail('Release registry bucket policy metadata is missing deletion protection.');
  }
  let policy;
  try {
    policy = JSON.parse(policyEnvelope.Policy);
  } catch {
    fail('Release registry bucket policy metadata is not valid JSON.');
  }
  const denied = new Set();
  for (const statement of listValue(policy.Statement ?? [])) {
    if (
      statement?.Effect !== 'Deny'
      || statement.Condition !== undefined
      || !wildcardPrincipal(statement.Principal)
      || !listValue(statement.Resource).some((resource) => deletionResourceCovers(resource, bucket, registryPrefix))
    ) continue;
    for (const rawAction of listValue(statement.Action)) {
      const action = typeof rawAction === 'string' ? rawAction.toLowerCase() : '';
      if (action === 's3:delete*' || action === 's3:deleteobject*' || action === 's3:*') {
        denied.add('s3:DeleteObject');
        denied.add('s3:DeleteObjectVersion');
      } else if (action === 's3:deleteobject') {
        denied.add('s3:DeleteObject');
      } else if (action === 's3:deleteobjectversion') {
        denied.add('s3:DeleteObjectVersion');
      }
    }
  }
  if (!denied.has('s3:DeleteObject') || !denied.has('s3:DeleteObjectVersion')) {
    fail('Release registry bucket policy must unconditionally deny object and version deletion for the registry prefix.');
  }
}
function retentionDays(value, label) {
  if (Number.isSafeInteger(value?.Days) && value.Days > 0) return value.Days;
  if (Number.isSafeInteger(value?.Years) && value.Years > 0) return value.Years * 365;
  fail(`${label} must declare a positive provider retention duration.`);
}
function validateLifecyclePolicy(policy, registryPrefix, minimumDays, maximumDays) {
  if (!Array.isArray(policy.Rules) || policy.Rules.length === 0) {
    fail('Release registry lifecycle metadata is missing enabled retention rules.');
  }
  let boundedObsoleteCurrent = false;
  let boundedNoncurrent = false;
  for (const [index, rule] of policy.Rules.entries()) {
    if (rule?.Status !== 'Enabled') continue;
    const scope = lifecycleRuleScope(rule);
    if (scope === null) {
      fail(`Release registry lifecycle rule ${index} uses a filter whose applicability cannot be proven.`);
    }
    const { prefix } = scope;
    if (prefix && registryPrefix !== prefix && !registryPrefix.startsWith(`${prefix.replace(/\/$/, '')}/`)) continue;
    if (rule.Expiration?.Date !== undefined) {
      fail(`Release registry lifecycle rule ${index} uses an absolute expiration date.`);
    }
    if (rule.Expiration?.Days !== undefined) {
      if (scope.tags.get(retentionTagKey) !== obsoleteRetentionTag) {
        fail(`Release registry lifecycle rule ${index} can expire active recovery objects.`);
      }
      const days = Number(rule.Expiration.Days);
      if (!Number.isSafeInteger(days) || days < minimumDays) {
        fail(`Release registry lifecycle rule ${index} expires current objects before the immutable retention minimum.`);
      }
      if (days > maximumDays) {
        fail(`Release registry lifecycle rule ${index} retains current objects beyond the configured lifecycle maximum.`);
      }
      boundedObsoleteCurrent = true;
    }
    if (rule.NoncurrentVersionExpiration !== undefined) {
      const days = Number(rule.NoncurrentVersionExpiration?.NoncurrentDays);
      if (!Number.isSafeInteger(days) || days < minimumDays) {
        fail(`Release registry lifecycle rule ${index} expires noncurrent versions before the immutable retention minimum.`);
      }
      if (days > maximumDays) {
        fail(`Release registry lifecycle rule ${index} retains noncurrent versions beyond the configured lifecycle maximum.`);
      }
      boundedNoncurrent = true;
    }
  }
  if (!boundedObsoleteCurrent || !boundedNoncurrent) {
    fail('Release registry lifecycle metadata must bound obsolete current objects and noncurrent versions without expiring active recovery objects.');
  }
}
function verifyS3RegistryProtection(uri) {
  if (!uri.startsWith('s3://')) return;
  const { bucket } = s3Location(uri, 'policy-probe');
  const minimumDays = registryImmutableRetentionDays();
  const maximumDays = registryLifecycleMaximumDays();
  const versioning = runAwsJson(['s3api', 'get-bucket-versioning', '--bucket', bucket], 'Release registry versioning');
  if (versioning.Status !== 'Enabled') fail('Release registry bucket versioning must be Enabled.');
  const objectLock = runAwsJson(['s3api', 'get-object-lock-configuration', '--bucket', bucket], 'Release registry Object Lock');
  if (objectLock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
    fail('Release registry bucket Object Lock must be Enabled.');
  }
  const defaultRetention = objectLock.ObjectLockConfiguration?.Rule?.DefaultRetention;
  const defaultDays = retentionDays(defaultRetention, 'Release registry default Object Lock');
  if (defaultRetention.Mode !== 'COMPLIANCE') fail('Release registry default Object Lock mode must be COMPLIANCE.');
  if (defaultDays < minimumDays) fail('Release registry default Object Lock retention is premature.');
  if (defaultDays > maximumDays) fail('Release registry default Object Lock retention exceeds the lifecycle maximum.');
  const lifecycle = runAwsJson(
    ['s3api', 'get-bucket-lifecycle-configuration', '--bucket', bucket],
    'Release registry lifecycle',
  );
  validateLifecyclePolicy(lifecycle, s3RegistryPrefix(uri), minimumDays, maximumDays);
  const bucketPolicy = runAwsJson(['s3api', 'get-bucket-policy', '--bucket', bucket], 'Release registry bucket policy');
  validateDeletionProtection(bucketPolicy, bucket, s3RegistryPrefix(uri));
}
function sha256Base64(path) {
  return createHash('sha256').update(readFileSync(path)).digest('base64');
}
function verifyS3ImmutableReadback(uri, suffix, input, label) {
  if (!uri.startsWith('s3://')) return;
  const { bucket, key } = s3Location(uri, suffix);
  const metadata = runAwsJson(
    ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--checksum-mode', 'ENABLED'],
    `Immutable ${label} provider readback`,
  );
  const expectedBytes = readFileSync(input).byteLength;
  if (typeof metadata.VersionId !== 'string' || !metadata.VersionId || metadata.VersionId === 'null') {
    fail(`Immutable ${label} provider readback is missing an exact version ID.`);
  }
  if (metadata.ContentLength !== expectedBytes) fail(`Immutable ${label} provider readback byte count does not match publication.`);
  if (metadata.ChecksumSHA256 !== sha256Base64(input)) fail(`Immutable ${label} provider readback digest does not match publication.`);
  if (metadata.DeleteMarker === true) fail(`Immutable ${label} provider readback resolved to a delete marker.`);
  if (metadata.ObjectLockMode !== 'COMPLIANCE') fail(`Immutable ${label} is not protected by COMPLIANCE Object Lock.`);
  const lastModified = Date.parse(metadata.LastModified);
  const retainUntil = Date.parse(metadata.ObjectLockRetainUntilDate);
  const minimumMs = registryImmutableRetentionDays() * 86_400_000;
  const maximumMs = registryLifecycleMaximumDays() * 86_400_000;
  const clockAllowanceMs = 300_000;
  if (!Number.isFinite(lastModified) || !Number.isFinite(retainUntil)) {
    fail(`Immutable ${label} provider readback is missing retention timestamps.`);
  }
  if (retainUntil <= Date.now() || retainUntil - lastModified < minimumMs - clockAllowanceMs) {
    fail(`Immutable ${label} provider retention metadata is premature.`);
  }
  if (retainUntil - lastModified > maximumMs + clockAllowanceMs) {
    fail(`Immutable ${label} provider retention metadata exceeds the lifecycle maximum.`);
  }
  return metadata;
}
function s3ObjectMetadata(uri, suffix, allowMissing = false) {
  if (!uri.startsWith('s3://')) return null;
  const { bucket, key } = s3Location(uri, suffix);
  const result = runAwsResult(['s3api', 'head-object', '--bucket', bucket, '--key', key, '--checksum-mode', 'ENABLED']);
  if (result.error || result.status !== 0) {
    if (allowMissing && (result.status === 254 || /Not Found|404|NoSuchKey/i.test(result.stderr ?? ''))) return null;
    fail(`Unable to authenticate release registry object metadata for ${suffix}.`);
  }
  try {
    const metadata = JSON.parse(result.stdout);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid');
    return metadata;
  } catch {
    fail(`Release registry object metadata for ${suffix} was not valid provider JSON.`);
  }
}
function requireProviderObjectIdentity(uri, suffix) {
  const metadata = s3ObjectMetadata(uri, suffix);
  if (typeof metadata.ETag !== 'string' || !metadata.ETag) {
    fail(`Release registry object metadata for ${suffix} is missing an ETag.`);
  }
  if (typeof metadata.VersionId !== 'string' || !metadata.VersionId || metadata.VersionId === 'null') {
    fail(`Release registry object metadata for ${suffix} is missing a version ID.`);
  }
  return metadata;
}
function readS3RetentionTags(uri, suffix, metadata) {
  if (!uri.startsWith('s3://')) return;
  const { bucket, key } = s3Location(uri, suffix);
  const identity = metadata ?? requireProviderObjectIdentity(uri, suffix);
  return runAwsJson([
    's3api', 'get-object-tagging', '--bucket', bucket, '--key', key, '--version-id', identity.VersionId,
  ], `Release registry retention tag for ${suffix}`);
}
function verifyS3RetentionTag(uri, suffix, expected, metadata) {
  if (!uri.startsWith('s3://')) return;
  const response = readS3RetentionTags(uri, suffix, metadata);
  const matches = Array.isArray(response.TagSet)
    && response.TagSet.some((tag) => tag?.Key === retentionTagKey && tag?.Value === expected);
  if (!matches) fail(`Release registry object ${suffix} is not tagged ${retentionTagKey}=${expected}.`);
}
function setS3RetentionTag(uri, suffix, value) {
  if (!uri.startsWith('s3://')) return;
  const { bucket, key } = s3Location(uri, suffix);
  const metadata = requireProviderObjectIdentity(uri, suffix);
  const currentTags = readS3RetentionTags(uri, suffix, metadata);
  if (Array.isArray(currentTags.TagSet)
    && currentTags.TagSet.some((tag) => tag?.Key === retentionTagKey && tag?.Value === value)) return;
  if (value === obsoleteRetentionTag) {
    const currentRetainUntil = Date.parse(metadata.ObjectLockRetainUntilDate);
    const minimumRetainUntil = Date.now() + registryImmutableRetentionDays() * 86_400_000;
    const retainUntil = new Date(Math.max(Number.isFinite(currentRetainUntil) ? currentRetainUntil : 0, minimumRetainUntil)).toISOString();
    runAws([
      's3api', 'put-object-retention', '--bucket', bucket, '--key', key, '--version-id', metadata.VersionId,
      '--retention', JSON.stringify({ Mode: 'COMPLIANCE', RetainUntilDate: retainUntil }),
    ], 'mutation');
  }
  runAws([
    's3api', 'put-object-tagging', '--bucket', bucket, '--key', key, '--version-id', metadata.VersionId,
    '--tagging', JSON.stringify({ TagSet: [{ Key: retentionTagKey, Value: value }] }),
  ], 'mutation');
  verifyS3RetentionTag(uri, suffix, value, metadata);
}
function releaseRecoveryObjects(sourceSha) {
  return [
    `releases/${sourceSha}.json`,
    `releases/${sourceSha}.sigstore.json`,
    `indexes/${sourceSha}.json`,
    `indexes/${sourceSha}.sigstore.json`,
  ];
}
function setReleaseRetentionState(uri, sourceSha, state) {
  if (!uri.startsWith('s3://')) return;
  for (const suffix of releaseRecoveryObjects(sourceSha)) setS3RetentionTag(uri, suffix, state);
}
function objectExists(uri, suffix) {
  const local = localPath(uri, suffix);
  if (local) return existsSync(local);
  if (uri.startsWith('s3://')) {
    return s3ObjectMetadata(uri, suffix, true) !== null;
  }
  fail('Registry bootstrap requires s3://, or file:// in explicit local tests.');
}
function download(uri, suffix, output) {
  const local = localPath(uri, suffix);
  if (local) return copyFileSync(local, output);
  const bounds = { downloadPath: output, maxDownloadBytes: registryFetchMaxBytes() };
  if (uri.startsWith('s3://')) return runAws(['s3', 'cp', `${base(uri)}/${suffix}`, output], 'read', bounds);
  if (uri.startsWith('rclone:')) return run('rclone', ['copyto', `${base(uri)}/${suffix}`, output], 'read', bounds);
  fail('Release registry URI must use s3:// or rclone:.');
}
async function downloadRetained(uri, output) {
  if (uri.startsWith('file://') && process.env.ALLOW_LOCAL_RELEASE_REGISTRY === 'true') {
    return copyFileSync(resolve(fileURLToPath(uri)), output);
  }
  if (uri.startsWith('s3://')) {
    return runAws(
      ['s3', 'cp', uri, output],
      'read',
      { downloadPath: output, maxDownloadBytes: registryFetchMaxBytes() },
    );
  }
  if (uri.startsWith('https://')) {
    const timeoutMs = registryCommandTimeoutMs();
    const maxBytes = registryFetchMaxBytes();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(uri, {
        cache: 'no-store',
        redirect: 'error',
        headers: { 'cache-control': 'no-cache' },
        signal: controller.signal,
      });
      if (!response.ok) fail(`Retained release bundle download returned HTTP ${response.status}.`);
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        fail(`Retained release bundle exceeds RELEASE_REGISTRY_FETCH_MAX_BYTES (${maxBytes}).`);
      }
      if (!response.body) fail('Retained release bundle response did not include a body.');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) fail(`Retained release bundle exceeds RELEASE_REGISTRY_FETCH_MAX_BYTES (${maxBytes}).`);
        chunks.push(Buffer.from(chunk));
      }
      return writeFileSync(output, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (controller.signal.aborted) fail(`Retained release bundle fetch timed out after ${timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  fail('Retained release bundle URI must use https:// or s3://. file:// is allowed only in explicit local tests.');
}
function upload(uri, suffix, input, immutable = false) {
  const local = localPath(uri, suffix);
  if (local) {
    mkdirSync(dirname(local), { recursive: true });
    if (immutable) writeFileSync(local, readFileSync(input), { flag: 'wx', mode: 0o600 });
    else copyFileSync(input, local);
    return;
  }
  if (immutable && uri.startsWith('s3://')) {
    const { bucket, key } = s3Location(uri, suffix);
    const retainUntil = new Date(Date.now() + registryImmutableRetentionDays() * 86_400_000).toISOString();
    runAws([
      's3api', 'put-object',
      '--bucket', bucket,
      '--key', key,
      '--body', input,
      '--if-none-match', '*',
      '--checksum-algorithm', 'SHA256',
      '--checksum-sha256', sha256Base64(input),
      '--object-lock-mode', 'COMPLIANCE',
      '--object-lock-retain-until-date', retainUntil,
      '--tagging', `${retentionTagKey}=${obsoleteRetentionTag}`,
    ], 'mutation');
    return;
  }
  if (uri.startsWith('s3://')) return runAws(['s3', 'cp', input, `${base(uri)}/${suffix}`], 'mutation');
  if (!immutable && uri.startsWith('rclone:')) return run('rclone', ['copyto', input, `${base(uri)}/${suffix}`], 'mutation');
  fail('Immutable release publication requires s3:// in production.');
}
function validateState(path) {
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const state = JSON.parse(text);
  if (state.version !== 2 || !/^[a-f0-9]{40}$/.test(state.sourceSha ?? '') || state.releaseManifest?.sourceSha !== state.sourceSha) {
    fail('Release bundle state must use the secret-free version 2 contract.');
  }
  validateRuntimeSecretDescriptor(state.runtimeSecret);
  for (const forbidden of ['runtimeEnvBase64', 'runtimeBytes', 'productionRuntimeEnv', 'PRODUCTION_RUNTIME_ENV_B64']) {
    if (Object.hasOwn(state, forbidden) || text.includes(`"${forbidden}"`)) fail('Release bundle contains forbidden runtime secret material.');
  }
  return state;
}
function validateLiveIdentityProof(path, expectedSha, maxAgeSeconds) {
  const proof = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (
    proof.status !== 'passed'
    || proof.sourceSha !== expectedSha
    || proof.servedReleaseSha !== expectedSha
    || proof.releaseIdentityHeader !== 'X-LunchLineup-Release'
    || !Number.isInteger(proof.httpStatus)
    || proof.httpStatus < 200
    || proof.httpStatus >= 300
    || !/^[a-f0-9]{64}$/.test(proof.responseSha256 ?? '')
    || !Number.isSafeInteger(proof.responseBytes)
    || proof.responseBytes < 1
  ) fail('Live identity proof does not establish the exact retained release source SHA.');
  const url = new URL(proof.healthUrl);
  if (url.protocol !== 'https:') fail('Live identity proof healthUrl must use HTTPS.');
  const checkedAt = Date.parse(proof.checkedAt);
  const ageMs = Date.now() - checkedAt;
  if (!Number.isFinite(checkedAt) || ageMs < -30_000 || ageMs > maxAgeSeconds * 1000) {
    fail('Live identity proof is stale or has an invalid checkedAt timestamp.');
  }
  return { url: url.href, surface: proof.surface };
}
function assertEmpty(uri) {
  if (objectExists(uri, 'index.json')) fail('Release registry already has an index; bootstrap is forbidden.');
  process.stdout.write('release_registry_empty_verified\n');
}
function signerOptions() {
  return {
    certificateIdentity: option('--expected-certificate-identity'),
    oidcIssuer: option('--expected-oidc-issuer'),
  };
}
function signedInputPaths() {
  return {
    indexPath: resolve(option('--index-file')),
    bundleSignaturePath: resolve(option('--bundle-signature-bundle')),
    indexSignaturePath: resolve(option('--index-signature-bundle')),
  };
}
function createIndex(statePath, outputPath) {
  const index = writeReleaseIndex(statePath, outputPath, signerOptions());
  process.stdout.write(`release_registry_index_created source_sha=${index.currentSuccessfulSha}\n`);
}
function ensureImmutableObject(uri, suffix, input, label) {
  if (!objectExists(uri, suffix)) {
    try {
      upload(uri, suffix, input, true);
      verifyS3ImmutableReadback(uri, suffix, input, label);
      return;
    } catch (error) {
      if (!objectExists(uri, suffix)) throw error;
      // Conditional create conflicts and timed-out writes are unknown until the
      // exact immutable object is downloaded and authenticated below.
    }
  }
  const existingPath = `${input}.existing-${label}`;
  download(uri, suffix, existingPath);
  try {
    if (!readFileSync(existingPath).equals(readFileSync(input))) {
      fail(`Existing immutable ${label} object does not match this publication.`);
    }
    verifyS3ImmutableReadback(uri, suffix, input, label);
  } finally {
    if (existsSync(existingPath)) unlinkSync(existingPath);
  }
}
function ensureImmutableSignature(uri, suffix, artifactPath, suppliedSignaturePath, signer, label) {
  if (!objectExists(uri, suffix)) {
    try {
      upload(uri, suffix, suppliedSignaturePath, true);
      verifyS3ImmutableReadback(uri, suffix, suppliedSignaturePath, label);
      return { path: suppliedSignaturePath, cleanup: false };
    } catch (error) {
      if (!objectExists(uri, suffix)) throw error;
      // Reconcile a conditional conflict or unknown mutation through the
      // authenticated retained signature readback below.
    }
  }
  const existingPath = `${suppliedSignaturePath}.existing-${label}`;
  download(uri, suffix, existingPath);
  try {
    verifyCosignBlob(artifactPath, existingPath, signer);
    verifyS3ImmutableReadback(uri, suffix, existingPath, label);
    return { path: existingPath, cleanup: true };
  } catch (error) {
    if (existsSync(existingPath)) unlinkSync(existingPath);
    throw error;
  }
}
function verifyPointerArtifact(indexPath, signaturePath, expectedSha, signer) {
  verifyCosignBlob(indexPath, signaturePath, signer);
  const pointer = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (
    pointer.version !== 3
    || pointer.kind !== 'lunchlineup-release-registry-index'
    || pointer.currentSuccessfulSha !== expectedSha
    || pointer.authenticity?.certificateIdentity !== signer.certificateIdentity
    || pointer.authenticity?.oidcIssuer !== signer.oidcIssuer
  ) fail('Authenticated release registry pointer does not name the expected release source SHA.');
}
function pointerSourceSha(indexPath, signer) {
  const pointer = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (
    pointer.version !== 3
    || pointer.kind !== 'lunchlineup-release-registry-index'
    || !/^[a-f0-9]{40}$/.test(pointer.currentSuccessfulSha ?? '')
    || pointer.authenticity?.certificateIdentity !== signer.certificateIdentity
    || pointer.authenticity?.oidcIssuer !== signer.oidcIssuer
  ) fail('Release registry pointer is invalid or names an untrusted signer.');
  return pointer.currentSuccessfulSha;
}
function readbackMutablePointer(uri, targetIndexPath, targetSignaturePath, expectedSha, signer, scratchRoot) {
  const readbackIndex = join(scratchRoot, 'index.readback.json');
  const readbackSignature = join(scratchRoot, 'index.readback.sigstore.json');
  for (const path of [readbackIndex, readbackSignature]) if (existsSync(path)) unlinkSync(path);
  download(uri, 'index.sigstore.json', readbackSignature);
  download(uri, 'index.json', readbackIndex);
  verifyPointerArtifact(readbackIndex, readbackSignature, expectedSha, signer);
  if (
    !readFileSync(readbackIndex).equals(readFileSync(targetIndexPath))
    || !readFileSync(readbackSignature).equals(readFileSync(targetSignaturePath))
  ) fail('Authenticated mutable release registry pointer readback does not exactly match the intended signed pointer bytes.');
}
function conditionalMutableUpload(uri, suffix, input, expectedEtag) {
  const local = localPath(uri, suffix);
  if (local) {
    const exists = existsSync(local);
    const currentEtag = exists ? createHash('sha256').update(readFileSync(local)).digest('hex') : null;
    if ((expectedEtag === null && exists) || (expectedEtag !== null && currentEtag !== expectedEtag)) return false;
    mkdirSync(dirname(local), { recursive: true });
    const temporary = `${local}.conditional-${process.pid}`;
    writeFileSync(temporary, readFileSync(input), { mode: 0o600 });
    renameSync(temporary, local);
    return true;
  }
  if (!uri.startsWith('s3://')) fail('Race-safe mutable release pointer publication requires s3:// in production.');
  const { bucket, key } = s3Location(uri, suffix);
  const retainUntil = new Date(Date.now() + registryImmutableRetentionDays() * 86_400_000).toISOString();
  const condition = expectedEtag === null ? ['--if-none-match', '*'] : ['--if-match', expectedEtag];
  const result = runAwsResult([
    's3api', 'put-object', '--bucket', bucket, '--key', key, '--body', input,
    '--checksum-algorithm', 'SHA256', '--checksum-sha256', sha256Base64(input),
    '--object-lock-mode', 'COMPLIANCE', '--object-lock-retain-until-date', retainUntil,
    '--tagging', `${retentionTagKey}=${activeRetentionTag}`,
    ...condition,
  ], 'mutation');
  if (!result.error && result.status === 0) return true;
  if (result.status === 70 || /mutation state is unknown|PreconditionFailed|412|condition/i.test(result.stderr ?? '')) return false;
  fail(`Conditional provider publication failed for mutable release registry object ${suffix}.`);
}
function mutableObjectEtag(uri, suffix) {
  const local = localPath(uri, suffix);
  if (local) return existsSync(local) ? createHash('sha256').update(readFileSync(local)).digest('hex') : null;
  const metadata = s3ObjectMetadata(uri, suffix, true);
  if (metadata === null) return null;
  if (typeof metadata.ETag !== 'string' || !metadata.ETag) fail(`Mutable release registry object ${suffix} is missing an ETag.`);
  return metadata.ETag;
}
function loadAuthenticatedMutablePointer(uri, signer, scratchRoot) {
  const pointerEtag = mutableObjectEtag(uri, 'index.json');
  const signatureEtag = mutableObjectEtag(uri, 'index.sigstore.json');
  if (pointerEtag === null) return { exists: false, pointerEtag: null, signatureEtag };

  const mutableIndex = join(scratchRoot, 'mutable-index.json');
  const mutableSignature = join(scratchRoot, 'mutable-index.sigstore.json');
  const immutableIndex = join(scratchRoot, 'immutable-index.json');
  const immutableSignature = join(scratchRoot, 'immutable-index.sigstore.json');
  for (const path of [mutableIndex, mutableSignature, immutableIndex, immutableSignature]) {
    if (existsSync(path)) unlinkSync(path);
  }
  download(uri, 'index.json', mutableIndex);
  const sourceSha = pointerSourceSha(mutableIndex, signer);
  download(uri, `indexes/${sourceSha}.json`, immutableIndex);
  download(uri, `indexes/${sourceSha}.sigstore.json`, immutableSignature);
  verifyPointerArtifact(immutableIndex, immutableSignature, sourceSha, signer);
  if (!readFileSync(mutableIndex).equals(readFileSync(immutableIndex))) {
    fail('Mutable release registry pointer does not match authenticated immutable pointer material.');
  }

  let signatureMatches = false;
  if (signatureEtag !== null) {
    download(uri, 'index.sigstore.json', mutableSignature);
    try {
      verifyPointerArtifact(mutableIndex, mutableSignature, sourceSha, signer);
      signatureMatches = readFileSync(mutableSignature).equals(readFileSync(immutableSignature));
    } catch {
      signatureMatches = false;
    }
  }
  if (!signatureMatches) {
    if (!conditionalMutableUpload(uri, 'index.sigstore.json', immutableSignature, signatureEtag)) {
      throw new Error('Mutable release registry signature changed during authenticated split-pair repair.');
    }
    if (mutableObjectEtag(uri, 'index.json') !== pointerEtag) {
      throw new Error('Mutable release registry pointer changed during authenticated split-pair repair.');
    }
    if (existsSync(mutableSignature)) unlinkSync(mutableSignature);
    download(uri, 'index.sigstore.json', mutableSignature);
    verifyPointerArtifact(mutableIndex, mutableSignature, sourceSha, signer);
    if (!readFileSync(mutableSignature).equals(readFileSync(immutableSignature))) {
      fail('Authenticated split-pair repair did not restore the immutable pointer signature.');
    }
  }
  return {
    exists: true,
    sourceSha,
    pointerEtag,
    signatureEtag: mutableObjectEtag(uri, 'index.sigstore.json'),
    indexPath: mutableIndex,
    signaturePath: mutableSignature,
  };
}
function updateLocalMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, expectedCurrentSha) {
  const localIndex = localPath(uri, 'index.json');
  if (localIndex && existsSync(localIndex)) {
    try {
      const currentSha = pointerSourceSha(localIndex, signer);
      if (currentSha === expectedSha) {
        upload(uri, 'index.sigstore.json', signaturePath, false);
        upload(uri, 'index.json', indexPath, false);
        return { previousSourceSha: expectedCurrentSha ?? expectedSha, idempotent: true };
      }
      if (expectedCurrentSha !== undefined && currentSha !== expectedCurrentSha) {
        fail('Authenticated release registry current pointer changed to a competing release; refusing mutation.');
      }
    } catch (error) {
      if (expectedCurrentSha !== undefined) throw error;
    }
  }
  upload(uri, 'index.sigstore.json', signaturePath, false);
  upload(uri, 'index.json', indexPath, false);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-registry-local-pointer-'));
  try {
    readbackMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, scratchRoot);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
  return { previousSourceSha: expectedCurrentSha, idempotent: false };
}
function updateMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, expectedCurrentSha) {
  if (!uri.startsWith('s3://')) {
    return updateLocalMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, expectedCurrentSha);
  }
  const scratchRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-registry-pointer-'));
  let previousSourceSha = expectedCurrentSha;
  let pinnedCurrentKnown = expectedCurrentSha !== undefined;
  let pinnedCurrentSha = expectedCurrentSha ?? null;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let current;
      try {
        current = loadAuthenticatedMutablePointer(uri, signer, scratchRoot);
      } catch (error) {
        if (attempt === 0) continue;
        throw error;
      }
      if (current.exists && current.sourceSha === expectedSha) {
        readbackMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, scratchRoot);
        if (attempt > 0) process.stdout.write(`release_registry_pointer_reconciled source_sha=${expectedSha}\n`);
        return { previousSourceSha: previousSourceSha ?? expectedSha, idempotent: true };
      }
      if (!pinnedCurrentKnown) {
        pinnedCurrentKnown = true;
        pinnedCurrentSha = current.exists ? current.sourceSha : null;
      } else if (
        (pinnedCurrentSha === null && current.exists)
        || (pinnedCurrentSha !== null && (!current.exists || current.sourceSha !== pinnedCurrentSha))
      ) {
        fail('Authenticated release registry current pointer changed to a competing release; refusing mutation.');
      }
      if (previousSourceSha === undefined && current.exists) previousSourceSha = current.sourceSha;
      if (!conditionalMutableUpload(uri, 'index.sigstore.json', signaturePath, current.signatureEtag)) continue;
      if (!conditionalMutableUpload(uri, 'index.json', indexPath, current.pointerEtag)) continue;
      readbackMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, scratchRoot);
      if (attempt > 0) process.stdout.write(`release_registry_pointer_reconciled source_sha=${expectedSha}\n`);
      return { previousSourceSha, idempotent: false };
    }
    const current = loadAuthenticatedMutablePointer(uri, signer, scratchRoot);
    if (current.exists && current.sourceSha === expectedSha) {
      readbackMutablePointer(uri, indexPath, signaturePath, expectedSha, signer, scratchRoot);
      process.stdout.write(`release_registry_pointer_reconciled source_sha=${expectedSha}\n`);
      return { previousSourceSha: previousSourceSha ?? expectedSha, idempotent: true };
    }
    if (
      (pinnedCurrentSha === null && current.exists)
      || (pinnedCurrentSha !== null && (!current.exists || current.sourceSha !== pinnedCurrentSha))
    ) {
      fail('Authenticated release registry current pointer changed to a competing release; refusing mutation.');
    }
    fail('Release registry pointer write state is unknown after one authenticated reconciliation attempt.');
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}
function publishSignedRelease(uri, statePath, bootstrap = false) {
  verifyS3RegistryProtection(uri);
  if (bootstrap) assertEmpty(uri);
  const state = validateState(statePath);
  const signer = signerOptions();
  const paths = signedInputPaths();
  const verified = verifyReleaseAuthenticity({ statePath, ...paths, ...signer });
  if (verified.sourceSha !== state.sourceSha) fail('Verified release authenticity source SHA does not match release state.');
  const releaseObject = `releases/${state.sourceSha}.json`;
  const releaseSignatureObject = `releases/${state.sourceSha}.sigstore.json`;
  const indexObject = `indexes/${state.sourceSha}.json`;
  const indexSignatureObject = `indexes/${state.sourceSha}.sigstore.json`;
  ensureImmutableObject(uri, releaseObject, statePath, 'release bundle');
  ensureImmutableObject(uri, indexObject, paths.indexPath, 'release index');
  const retainedBundleSignature = ensureImmutableSignature(
    uri, releaseSignatureObject, statePath, paths.bundleSignaturePath, signer, 'release-bundle-signature',
  );
  const retainedIndexSignature = ensureImmutableSignature(
    uri, indexSignatureObject, paths.indexPath, paths.indexSignaturePath, signer, 'release-index-signature',
  );
  try {
    verifyS3RegistryProtection(uri);
    setReleaseRetentionState(uri, state.sourceSha, activeRetentionTag);
    const pointer = updateMutablePointer(uri, paths.indexPath, retainedIndexSignature.path, state.sourceSha, signer);
    if (pointer.previousSourceSha && pointer.previousSourceSha !== state.sourceSha) {
      setReleaseRetentionState(uri, pointer.previousSourceSha, obsoleteRetentionTag);
    }
  } finally {
    if (retainedBundleSignature.cleanup && existsSync(retainedBundleSignature.path)) unlinkSync(retainedBundleSignature.path);
    if (retainedIndexSignature.cleanup && existsSync(retainedIndexSignature.path)) unlinkSync(retainedIndexSignature.path);
  }
  process.stdout.write(`${bootstrap ? 'release_registry_bootstrapped' : 'release_bundle_published'} source_sha=${state.sourceSha} bundle_sha256=${verified.bundleSha256}\n`);
}
function validateBootstrapInputs(statePath) {
  const state = validateState(statePath);
  const expected = `bootstrap-current-live-release:${state.sourceSha}`;
  if (option('--confirm') !== expected) fail(`Bootstrap confirmation must exactly equal ${expected}.`);
  if (option('--verified-source-sha') !== state.sourceSha) fail('Verified bootstrap source SHA does not match the release bundle.');
  const maxAgeSeconds = Number(option('--max-live-proof-age-seconds'));
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 900) {
    fail('Live identity proof max age must be an integer from 1 through 900 seconds.');
  }
  const proofPaths = options('--live-identity-proof');
  if (proofPaths.length !== 2) fail('Bootstrap requires exactly two independently fetched live identity proofs.');
  const expectedApiUrl = new URL(option('--expected-api-health-url'));
  const expectedWebUrl = new URL(option('--expected-public-web-url'));
  if (expectedApiUrl.protocol !== 'https:' || expectedApiUrl.username || expectedApiUrl.password || expectedApiUrl.hash) {
    fail('Bootstrap API health evidence must name the exact configured HTTPS health endpoint.');
  }
  if (
    expectedWebUrl.protocol !== 'https:'
    || expectedWebUrl.username
    || expectedWebUrl.password
    || expectedWebUrl.search
    || expectedWebUrl.hash
    || expectedWebUrl.pathname !== '/'
  ) fail('Bootstrap public HTML evidence must name the canonical HTTPS root URL.');
  const proofs = proofPaths.map((path) => validateLiveIdentityProof(path, state.sourceSha, maxAgeSeconds));
  const apiProofs = proofs.filter((proof) => proof.surface === 'health' && proof.url === expectedApiUrl.href);
  const webProofs = proofs.filter((proof) => proof.surface === 'public-html' && proof.url === expectedWebUrl.href);
  if (apiProofs.length !== 1 || webProofs.length !== 1) {
    fail('Bootstrap requires exact API-health evidence and strict canonical-root public-HTML evidence for the live SHA.');
  }
  return state;
}
async function prepareBootstrapRetained(uri, retainedUri, statePath) {
  assertEmpty(uri);
  if (existsSync(statePath)) fail('Bootstrap state output must not already exist.');
  await downloadRetained(retainedUri, statePath);
  try {
    const state = validateBootstrapInputs(statePath);
    process.stdout.write(`release_registry_bootstrap_prepared source_sha=${state.sourceSha}\n`);
  } catch (error) {
    if (existsSync(statePath)) unlinkSync(statePath);
    throw error;
  }
}
function resolvePrevious(uri, output, selection = { mode: 'cli' }) {
  const signer = signerOptions();
  const requestedSourceSha = selection.mode === 'current'
    ? undefined
    : selection.mode === 'explicit'
      ? selection.sourceSha
      : process.argv.includes('--source-sha') ? option('--source-sha') : undefined;
  const registryIndexPath = output + '.registry-index.json';
  const registryIndexSignaturePath = output + '.registry-index.sigstore.json';
  const indexPath = output + '.index.json';
  const indexSignaturePath = output + '.index.sigstore.json';
  const bundleSignaturePath = output + '.sigstore.json';
  const outputs = [output, registryIndexPath, registryIndexSignaturePath, indexPath, indexSignaturePath, bundleSignaturePath];
  try {
    let sourceSha = requestedSourceSha;
    if (sourceSha !== undefined && !/^[a-f0-9]{40}$/.test(sourceSha)) {
      fail('Explicit release source SHA must be exactly 40 lowercase hexadecimal characters.');
    }
    if (sourceSha === undefined) {
      download(uri, 'index.json', registryIndexPath);
      download(uri, 'index.sigstore.json', registryIndexSignaturePath);
      const pointer = JSON.parse(readFileSync(registryIndexPath, 'utf8'));
      if (
        pointer.version !== 3
        || pointer.kind !== 'lunchlineup-release-registry-index'
        || !/^[a-f0-9]{40}$/.test(pointer.currentSuccessfulSha ?? '')
        || pointer.authenticity?.certificateIdentity !== signer.certificateIdentity
        || pointer.authenticity?.oidcIssuer !== signer.oidcIssuer
      ) fail('Signed release registry pointer is invalid or names an untrusted signer.');
      sourceSha = pointer.currentSuccessfulSha;
      verifyPointerArtifact(registryIndexPath, registryIndexSignaturePath, sourceSha, signer);
    }

    download(uri, 'indexes/' + sourceSha + '.json', indexPath);
    download(uri, 'indexes/' + sourceSha + '.sigstore.json', indexSignaturePath);
    if (requestedSourceSha === undefined && !readFileSync(indexPath).equals(readFileSync(registryIndexPath))) {
      fail('Signed mutable release pointer does not match its immutable index.');
    }
    verifyCosignBlob(indexPath, indexSignaturePath, signer);
    download(uri, 'releases/' + sourceSha + '.json', output);
    download(uri, 'releases/' + sourceSha + '.sigstore.json', bundleSignaturePath);
    const verified = verifyReleaseAuthenticity({
      statePath: output,
      indexPath,
      bundleSignaturePath,
      indexSignaturePath,
      ...signer,
    });
    const state = validateState(output);
    if (state.sourceSha !== sourceSha || verified.sourceSha !== sourceSha) {
      fail('Signed release registry index does not match the immutable bundle source SHA.');
    }
    if (existsSync(registryIndexPath)) unlinkSync(registryIndexPath);
    if (existsSync(registryIndexSignaturePath)) unlinkSync(registryIndexSignaturePath);
    const selection = requestedSourceSha === undefined ? 'current' : 'explicit';
    process.stdout.write(
      'release_bundle_resolved source_sha=' + sourceSha
      + ' selection=' + selection
      + ' bundle_sha256=' + verified.bundleSha256 + '\n',
    );
    return { sourceSha, bundleSha256: verified.bundleSha256 };
  } catch (error) {
    for (const path of outputs) if (existsSync(path)) unlinkSync(path);
    throw error;
  }
}
function repointCurrent(uri) {
  const sourceSha = option('--source-sha');
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('Repoint source SHA must be exactly 40 lowercase hexadecimal characters.');
  const expectedCurrentSha = option('--expected-current-source-sha');
  if (!/^[a-f0-9]{40}$/.test(expectedCurrentSha)) {
    fail('Repoint expected current source SHA must be exactly 40 lowercase hexadecimal characters.');
  }
  const expectedConfirmation = `repoint-current-to:${sourceSha}`;
  if (option('--confirm') !== expectedConfirmation) fail(`Repoint confirmation must exactly equal ${expectedConfirmation}.`);
  const scratchRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-registry-repoint-'));
  const currentBeforePath = join(scratchRoot, 'current-before.json');
  const statePath = join(scratchRoot, 'release.json');
  const currentAfterPath = join(scratchRoot, 'current-after.json');
  try {
    verifyS3RegistryProtection(uri);
    const signer = signerOptions();
    if (uri.startsWith('s3://')) loadAuthenticatedMutablePointer(uri, signer, scratchRoot);
    const currentBefore = resolvePrevious(uri, currentBeforePath, { mode: 'current' });
    if (currentBefore.sourceSha !== expectedCurrentSha) {
      fail('Authenticated release registry current pointer does not match --expected-current-source-sha; refusing repoint.');
    }
    const resolved = resolvePrevious(uri, statePath, { mode: 'explicit', sourceSha });
    if (resolved.sourceSha !== sourceSha) fail('Authenticated retained release does not match the requested repoint source SHA.');
    setReleaseRetentionState(uri, sourceSha, activeRetentionTag);
    const pointer = updateMutablePointer(
      uri,
      statePath + '.index.json',
      statePath + '.index.sigstore.json',
      sourceSha,
      signer,
      expectedCurrentSha,
    );
    if (pointer.previousSourceSha && pointer.previousSourceSha !== sourceSha) {
      setReleaseRetentionState(uri, pointer.previousSourceSha, obsoleteRetentionTag);
    }
    verifyS3RegistryProtection(uri);
    const currentAfter = resolvePrevious(uri, currentAfterPath, { mode: 'current' });
    if (currentAfter.sourceSha !== sourceSha) {
      fail('Authenticated release registry current pointer readback does not match the repoint target.');
    }
    process.stdout.write(
      `release_registry_current_repointed source_sha=${sourceSha} previous_source_sha=${expectedCurrentSha} protection=preflight-and-readback\n`,
    );
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}
function bootstrapRetained(uri, statePath) {
  validateBootstrapInputs(statePath);
  publishSignedRelease(uri, statePath, true);
}
async function main() {
  const [command] = process.argv.slice(2);
  if (command === 'create-index') {
    return createIndex(resolve(option('--state-file')), resolve(option('--index-file')));
  }
  const uri = option('--registry-uri');
  if (command === 'resolve') return resolvePrevious(uri, resolve(option('--output')));
  if (command === 'repoint') return repointCurrent(uri);
  if (command === 'publish') return publishSignedRelease(uri, resolve(option('--state-file')));
  if (command === 'assert-empty') return assertEmpty(uri);
  if (command === 'prepare-bootstrap-retained') {
    return prepareBootstrapRetained(uri, option('--retained-bundle-uri'), resolve(option('--state-file')));
  }
  if (command === 'bootstrap-retained') return bootstrapRetained(uri, resolve(option('--state-file')));
  fail('Usage: release-bundle-registry.mjs <create-index|resolve|repoint|publish|assert-empty|prepare-bootstrap-retained|bootstrap-retained> ... (resolve accepts optional --source-sha SHA; repoint requires --source-sha SHA --expected-current-source-sha SHA --confirm repoint-current-to:SHA).');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
