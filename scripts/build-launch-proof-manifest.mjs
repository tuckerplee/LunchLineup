#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyFetchedEvidenceArtifact } from './launch-proof-evidence.mjs';

export const REQUIRED_EVIDENCE_KINDS = Object.freeze([
  'runtimeEnv',
  'dast',
  'load',
  'drDrill',
  'pitrDrill',
  'alertRoute',
]);

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 86_400;
const vagueUriPattern = /(^|[/:_.?&=-])(latest|current|mutable)(?=$|[/:_.?&=-])/i;
const secretValuePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bwhsec_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{12,}\b/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:password|passwd|passphrase|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\b\s*[:=]\s*["']?(?!\$|\$\{|<|redacted\b|none\b|null\b|\*{3})[^\s"',;}{]{8,}/i,
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required.`);
  return value.trim();
}

function normalizeSourceSha(value, label = 'sourceSha') {
  const sourceSha = requireString(value, label);
  if (!/^[a-f0-9]{40}$/i.test(sourceSha)) throw new Error(`${label} must be a 40-character Git SHA.`);
  return sourceSha.toLowerCase();
}

function parseTimestamp(value, label) {
  const timestamp = requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
    throw new Error(`${label} must be an ISO-8601 timestamp with a timezone.`);
  }
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  return { timestamp, time };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function looksLikeSecretKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    /password$/,
    /passwd$/,
    /passphrase$/,
    /secret$/,
    /secretkey$/,
    /clientsecret$/,
    /webhooksecret$/,
    /(?:access|refresh|auth|bearer)token$/,
    /^token$/,
    /apikey$/,
    /privatekey$/,
    /signingkey$/,
    /encryptionkey$/,
    /credential(?:s)?$/,
    /^authorization$/,
    /(?:^|http)cookie$/,
    /^setcookie$/,
    /connectionstring$/,
    /databaseurl$/,
    /^dsn$/,
    /awsaccesskeyid$/,
    /xamzsignature$/,
  ].some((pattern) => pattern.test(normalized));
}

function assertSecretFreeText(text, label) {
  for (const pattern of secretValuePatterns) {
    if (pattern.test(text)) throw new Error(`${label} contains secrets-like content.`);
  }
}

function assertSecretFree(value, label, seen = new WeakSet()) {
  if (typeof value === 'string') {
    assertSecretFreeText(value, label);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers.`);
    return;
  }
  if (!Array.isArray(value) && !isObject(value)) throw new Error(`${label} must contain only JSON values.`);
  if (seen.has(value)) throw new Error(`${label} must not contain circular references.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFree(entry, `${label}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (looksLikeSecretKey(key)) throw new Error(`${label}.${key} is a secrets-like key.`);
      assertSecretFree(entry, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function parseSecretFreeJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON.`);
  }
  if (text.trim() === '') throw new Error(`${label} must not be empty.`);
  assertSecretFreeText(text, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSecretFree(value, label);
  return requireObject(value, label);
}

function decodedUriText(url, label) {
  try {
    return decodeURIComponent(`${url.pathname}${url.search}`);
  } catch {
    throw new Error(`${label} contains invalid percent encoding.`);
  }
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.endsWith('.invalid') || host.endsWith('.test') || host.endsWith('.example')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function hasImmutableIdentifier(url) {
  const text = decodedUriText(url, 'Evidence URI');
  if (/[a-f0-9]{40,64}/i.test(text) || /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(text)) {
    return true;
  }
  if (/\/actions\/runs\/\d+\/artifacts\/\d+(?:\/|$)/i.test(url.pathname)) return true;
  const identifiers = [
    ...url.pathname.split('/'),
    ...[...url.searchParams.values()].flatMap((value) => value.split(/[./_-]/)),
  ].flatMap((value) => value.split('.'));
  return identifiers.some((value) => value.length >= 6 && /\d/.test(value) && /^[A-Za-z0-9_-]+$/.test(value));
}

function verifyImmutableHttpsUri(value, label) {
  const uri = requireString(value, label);
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(`${label} must be a valid immutable HTTPS URI.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  if (url.hash) throw new Error(`${label} must not contain a fragment.`);
  if (!url.hostname.includes('.') || isLocalHostname(url.hostname)) throw new Error(`${label} must use a public hostname.`);
  const decoded = decodedUriText(url, label);
  if (vagueUriPattern.test(decoded)) throw new Error(`${label} must not use mutable/latest/current references.`);
  for (const [key, queryValue] of url.searchParams) {
    if (looksLikeSecretKey(key)) throw new Error(`${label} must not contain authentication query parameters.`);
    assertSecretFreeText(queryValue, label);
  }
  if (!hasImmutableIdentifier(url)) throw new Error(`${label} must contain an immutable run, object, timestamp, UUID, or SHA identifier.`);
  return uri;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalizeProducer(value, label) {
  assertSecretFree(value, label);
  if (typeof value === 'string') {
    const producer = requireString(value, label);
    if (producer.length > 512) throw new Error(`${label} is too long.`);
    return producer;
  }
  const producer = requireObject(value, label);
  if (Object.keys(producer).length === 0) throw new Error(`${label} must identify the evidence producer.`);
  if (!['id', 'name', 'system'].some((key) => typeof producer[key] === 'string' && producer[key].trim())) {
    throw new Error(`${label} must include id, name, or system.`);
  }
  return stableValue(producer);
}

function normalizeRetentionClass(value, label) {
  const retentionClass = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(retentionClass)) {
    throw new Error(`${label} must be an explicit retention policy class.`);
  }
  if (/(^|[._-])(latest|current|temporary|ephemeral|none)([._-]|$)/i.test(retentionClass)) {
    throw new Error(`${label} must name a durable retention policy class.`);
  }
  return retentionClass;
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function requireAttachedEvidence(artifact, descriptor, sourceSha, capturedAt, label) {
  const artifactSourceSha = firstValue(artifact, ['sourceSha', 'source_sha']);
  if (typeof artifactSourceSha !== 'string' || artifactSourceSha !== sourceSha) {
    throw new Error(`${label} is detached: its sourceSha must equal ${sourceSha}.`);
  }
  const artifactTimestamp = firstValue(artifact, [
    'capturedAt',
    'captured_at',
    'checkedAt',
    'checked_at',
    'completedAt',
    'completed_at',
  ]);
  if (typeof artifactTimestamp !== 'string' || artifactTimestamp !== capturedAt.timestamp) {
    throw new Error(`${label} is detached: its captured timestamp must equal ${capturedAt.timestamp}.`);
  }
  if (artifact.kind !== undefined && artifact.kind !== descriptor.kind) {
    throw new Error(`${label} is detached: artifact kind ${artifact.kind} does not match ${descriptor.kind}.`);
  }
  if (artifact.uri !== undefined && artifact.uri !== descriptor.uri) {
    throw new Error(`${label} is detached: artifact URI does not match its descriptor.`);
  }
  if (artifact.producer !== undefined && !stableEqual(artifact.producer, descriptor.producer)) {
    throw new Error(`${label} is detached: artifact producer does not match its descriptor.`);
  }
  if (artifact.retentionClass !== undefined && artifact.retentionClass !== descriptor.retentionClass) {
    throw new Error(`${label} is detached: artifact retentionClass does not match its descriptor.`);
  }
}

function requireSuccessfulCommonClaims(artifact, label) {
  const status = requireString(artifact.status, `${label}.status`).toLowerCase();
  if (!['ok', 'passed'].includes(status)) throw new Error(`${label}.status must be ok or passed.`);
  const summary = requireString(artifact.summary, `${label}.summary`);
  if (summary.length < 20) throw new Error(`${label}.summary must describe the proof.`);
  const command = requireString(artifact.command, `${label}.command`);
  if (command.length < 12) throw new Error(`${label}.command must identify the producer command.`);
  const exitCode = Number(firstValue(artifact, ['exitCode', 'exit_code']));
  if (!Number.isInteger(exitCode) || exitCode !== 0) throw new Error(`${label}.exitCode must be 0.`);
  return { status, summary, command, exitCode };
}

function copyKindClaims(kind, artifact, entry) {
  const claims = {
    drDrill: {
      backupSha256: ['backupSha256', 'backup_sha256'],
      restoredTableCount: ['restoredTableCount', 'restored_table_count'],
      sourceUri: ['sourceUri', 'source_uri'],
    },
    pitrDrill: {
      baseBackupId: ['baseBackupId', 'base_backup_id'],
      baseBackupUri: ['baseBackupUri', 'base_backup_uri'],
      archivedWalSegment: ['archivedWalSegment', 'archived_wal_segment'],
      archivedWalUri: ['archivedWalUri', 'archived_wal_uri'],
      recoveryTargetTime: ['recoveryTargetTime', 'recovery_target_time'],
      sourceTimestamp: ['sourceTimestamp', 'source_timestamp'],
    },
  }[kind];
  if (claims) {
    for (const [outputKey, aliases] of Object.entries(claims)) entry[outputKey] = firstValue(artifact, aliases);
  }
  if (kind === 'dast' && artifact.raw?.report) entry.rawReportSha256 = firstValue(artifact.raw.report, ['sha256']);
  if (kind === 'load' && artifact.raw?.artilleryResult && artifact.raw?.availabilityImportResult) {
    entry.artilleryResultSha256 = firstValue(artifact.raw.artilleryResult, ['sha256']);
    entry.availabilityImportResultSha256 = firstValue(artifact.raw.availabilityImportResult, ['sha256']);
  }
}

function normalizeEvidencePath(descriptor, label) {
  const pathValue = descriptor.path ?? descriptor.file;
  const path = resolve(requireString(pathValue, `${label}.path`));
  if (descriptor.path && descriptor.file && resolve(descriptor.path) !== resolve(descriptor.file)) {
    throw new Error(`${label}.path and ${label}.file must identify the same evidence file.`);
  }
  return path;
}

function buildEvidenceEntry(descriptorValue, sourceSha, generatedAt, maxAgeSeconds, state, verificationOptions) {
  const descriptor = requireObject(descriptorValue, 'evidence descriptor');
  const kind = requireString(descriptor.kind, 'evidence descriptor.kind');
  const label = `evidence.${kind}`;
  if (!REQUIRED_EVIDENCE_KINDS.includes(kind)) throw new Error(`${label} is not a required launch-proof evidence kind.`);
  if (state.kinds.has(kind)) throw new Error(`Duplicate evidence kind: ${kind}.`);
  state.kinds.add(kind);

  const path = normalizeEvidencePath(descriptor, label);
  const pathIdentity = process.platform === 'win32' ? path.toLowerCase() : path;
  if (state.paths.has(pathIdentity)) throw new Error(`${label}.path reuses another evidence file.`);
  state.paths.add(pathIdentity);

  const uri = verifyImmutableHttpsUri(descriptor.uri, `${label}.uri`);
  if (state.uris.has(uri)) throw new Error(`${label}.uri reuses another evidence URI.`);
  state.uris.add(uri);

  const capturedAt = parseTimestamp(descriptor.capturedAt, `${label}.capturedAt`);
  if (capturedAt.time > generatedAt.time) throw new Error(`${label}.capturedAt must not be in the future.`);
  if (generatedAt.time - capturedAt.time > maxAgeSeconds * 1_000) {
    throw new Error(`${label}.capturedAt is stale; maximum age is ${maxAgeSeconds} seconds.`);
  }
  const producer = normalizeProducer(descriptor.producer, `${label}.producer`);
  const retentionClass = normalizeRetentionClass(descriptor.retentionClass, `${label}.retentionClass`);
  const normalizedDescriptor = { ...descriptor, kind, uri, producer, retentionClass };
  assertSecretFree(normalizedDescriptor, label);

  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label}.path is missing: ${path}.`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label}.path must be a regular evidence file.`);
  if (stats.size === 0) throw new Error(`${label}.path must not be empty.`);
  if (stats.size > MAX_EVIDENCE_BYTES) throw new Error(`${label}.path exceeds ${MAX_EVIDENCE_BYTES} bytes.`);
  const bytes = readFileSync(path);
  if (bytes.byteLength === 0) throw new Error(`${label}.path must not be empty.`);
  const artifact = parseSecretFreeJson(bytes, `${label}.artifact`);
  requireAttachedEvidence(artifact, normalizedDescriptor, sourceSha, capturedAt, label);
  const common = requireSuccessfulCommonClaims(artifact, label);
  const artifactSha256 = sha256(bytes);
  if (state.hashes.has(artifactSha256)) throw new Error(`${label}.path duplicates another evidence artifact.`);
  state.hashes.add(artifactSha256);

  const entry = {
    kind,
    status: common.status,
    sourceSha,
    uri,
    checkedAt: capturedAt.timestamp,
    capturedAt: capturedAt.timestamp,
    summary: common.summary,
    command: common.command,
    exitCode: common.exitCode,
    producer,
    retentionClass,
    artifactSha256,
    artifactBytes: bytes.byteLength,
  };
  copyKindClaims(kind, artifact, entry);
  verifyFetchedEvidenceArtifact(kind, bytes, entry, {}, verificationOptions);
  return entry;
}

function normalizeSupplementalEvidence(value, sourceSha) {
  if (value === undefined) return {};
  const supplemental = requireObject(value, 'supplementalEvidence');
  assertSecretFree(supplemental, 'supplementalEvidence');
  const keys = Object.keys(supplemental);
  if (keys.some((key) => key !== 'stripeMeter')) {
    throw new Error('supplementalEvidence may contain only stripeMeter claims.');
  }
  if (!supplemental.stripeMeter) return {};
  const stripeMeter = requireObject(supplemental.stripeMeter, 'supplementalEvidence.stripeMeter');
  if (stripeMeter.status !== 'passed') throw new Error('supplementalEvidence.stripeMeter.status must be passed.');
  if (stripeMeter.sourceSha !== sourceSha) {
    throw new Error('supplementalEvidence.stripeMeter.sourceSha must match the launch-proof sourceSha.');
  }
  return { stripeMeter: stableValue(stripeMeter) };
}

export function buildLaunchProofManifest({
  sourceSha: sourceShaValue,
  generatedAt: generatedAtValue,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  evidence,
  supplementalEvidence,
}, verificationOptions = {}) {
  const sourceSha = normalizeSourceSha(sourceShaValue);
  const generatedAt = parseTimestamp(generatedAtValue, 'generatedAt');
  const maxAge = Number(maxAgeSeconds);
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) throw new Error('maxAgeSeconds must be a positive integer.');
  if (!Array.isArray(evidence)) throw new Error('evidence must be an array of evidence descriptors.');
  const state = { kinds: new Set(), paths: new Set(), uris: new Set(), hashes: new Set() };
  const entries = new Map();
  for (const descriptor of evidence) {
    const entry = buildEvidenceEntry(descriptor, sourceSha, generatedAt, maxAge, state, verificationOptions);
    entries.set(entry.kind, entry);
  }
  const missing = REQUIRED_EVIDENCE_KINDS.filter((kind) => !entries.has(kind));
  if (missing.length > 0) throw new Error(`Missing required evidence kinds: ${missing.join(', ')}.`);

  const supplemental = normalizeSupplementalEvidence(supplementalEvidence, sourceSha);
  const manifestEvidence = {};
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    manifestEvidence[kind] = entries.get(kind);
    if (kind === 'runtimeEnv' && supplemental.stripeMeter) manifestEvidence.stripeMeter = supplemental.stripeMeter;
  }
  const manifest = {
    version: 1,
    sourceSha,
    generatedAt: generatedAt.timestamp,
    evidence: manifestEvidence,
  };
  assertSecretFree(manifest, 'launchProof');
  return manifest;
}

export function serializeLaunchProofManifest(manifest) {
  assertSecretFree(manifest, 'launchProof');
  return `${JSON.stringify(stableValue(manifest), null, 2)}\n`;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required.`);
  return argv[index + 1];
}

function usage() {
  console.log('Usage: node scripts/build-launch-proof-manifest.mjs --input <builder-input.json> --output <launch-proof.json>');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  const inputPath = resolve(option(argv, '--input'));
  const outputPath = resolve(option(argv, '--output'));
  const input = parseSecretFreeJson(readFileSync(inputPath), 'builder input');
  if (input.version !== 1) throw new Error('builder input version must be 1.');
  const baseDir = dirname(inputPath);
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map((descriptor) => {
        const item = requireObject(descriptor, 'evidence descriptor');
        const relativePath = item.path ?? item.file;
        const { file: _file, ...metadata } = item;
        return { ...metadata, path: resolve(baseDir, requireString(relativePath, 'evidence descriptor.path')) };
      })
    : input.evidence;
  if (Array.isArray(evidence) && evidence.some((descriptor) => resolve(descriptor.path) === outputPath)) {
    throw new Error('Output path must not overwrite an evidence file.');
  }
  const manifest = buildLaunchProofManifest({ ...input, evidence });
  const serialized = serializeLaunchProofManifest(manifest);
  writeFileSync(outputPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log(`launch_proof_manifest_built source_sha=${manifest.sourceSha} sha256=${sha256(serialized)} output=${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
