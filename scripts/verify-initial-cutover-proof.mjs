#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const REQUIRED_OPTIONS = new Set([
  '--proof-file',
  '--expected-host',
  '--expected-source-sha',
  '--expected-proof-uri',
  '--expected-snapshot-command-sha256',
  '--expected-proof-fetch-command-sha256',
  '--expected-rollback-command-sha256',
]);
const OPTIONAL_OPTIONS = new Set(['--max-age-seconds', '--verification-time']);

function fail(message) {
  console.error(`Initial cutover rollback proof failed closed: ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    'Usage: node scripts/verify-initial-cutover-proof.mjs ' +
      '--proof-file FILE --expected-host HOST --expected-source-sha SHA ' +
      '--expected-proof-uri URI --expected-snapshot-command-sha256 SHA256 ' +
      '--expected-proof-fetch-command-sha256 SHA256 ' +
      '--expected-rollback-command-sha256 SHA256 ' +
      '[--max-age-seconds N] [--verification-time ISO8601]',
  );
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_OPTIONS.has(name) && !OPTIONAL_OPTIONS.has(name)) {
      fail(`unknown option ${name ?? '<missing>'}.`);
    }
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      fail(`${name} requires a value.`);
    }
    if (values.has(name)) fail(`${name} may be provided only once.`);
    values.set(name, value);
  }
  for (const name of REQUIRED_OPTIONS) {
    if (!values.has(name)) fail(`missing required option ${name}.`);
  }
  return values;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} fields must be exactly: ${wanted.join(', ')}.`);
  }
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}

function parseTimestamp(value, label) {
  requireString(value, label, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} is not a valid UTC timestamp.`);
  return timestamp;
}

function verifyDurableUri(rawUri) {
  let uri;
  try {
    uri = new URL(rawUri);
  } catch {
    fail('snapshot.durableProofUri must be an absolute URI.');
  }
  if (!['https:', 's3:'].includes(uri.protocol)) {
    fail('snapshot.durableProofUri must use https:// or s3:// durable storage.');
  }
  if (!uri.hostname || uri.username || uri.password || uri.search || uri.hash) {
    fail('snapshot.durableProofUri must not contain credentials, a query, or a fragment.');
  }
  if (uri.pathname === '/' || uri.pathname.length < 2) {
    fail('snapshot.durableProofUri must identify a specific retained object.');
  }
  if (uri.protocol === 'https:' && uri.port && uri.port !== '443') {
    fail('HTTPS durable proof storage must use the default TLS port.');
  }
}

const options = parseOptions(process.argv.slice(2));
const sourceSha = requireString(
  options.get('--expected-source-sha').toLowerCase(),
  '--expected-source-sha',
  /^[a-f0-9]{40}$/,
);
const snapshotCommandSha256 = requireString(
  options.get('--expected-snapshot-command-sha256').toLowerCase(),
  '--expected-snapshot-command-sha256',
  /^[a-f0-9]{64}$/,
);
const proofFetchCommandSha256 = requireString(
  options.get('--expected-proof-fetch-command-sha256').toLowerCase(),
  '--expected-proof-fetch-command-sha256',
  /^[a-f0-9]{64}$/,
);
const rollbackCommandSha256 = requireString(
  options.get('--expected-rollback-command-sha256').toLowerCase(),
  '--expected-rollback-command-sha256',
  /^[a-f0-9]{64}$/,
);
const maxAgeSeconds = Number(options.get('--max-age-seconds') ?? '900');
if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 86400) {
  fail('--max-age-seconds must be an integer from 1 through 86400.');
}

const verificationTime = options.has('--verification-time')
  ? parseTimestamp(options.get('--verification-time'), '--verification-time')
  : Date.now();

let proofBytes;
let proof;
try {
  proofBytes = readFileSync(options.get('--proof-file'));
  if (proofBytes.length === 0 || proofBytes.length > 65536) {
    fail('proof file must be non-empty and no larger than 64 KiB.');
  }
  proof = JSON.parse(proofBytes.toString('utf8'));
} catch (error) {
  if (error instanceof SyntaxError) fail('proof file is not valid JSON.');
  throw error;
}

assertExactKeys(
  proof,
  ['version', 'kind', 'status', 'vmId', 'legacySystem', 'host', 'targetSourceSha', 'snapshot'],
  'proof',
);
assertExactKeys(
  proof.snapshot,
  [
    'reference',
    'createdAt',
    'durableProofUri',
    'snapshotCommandSha256',
    'proofFetchCommandSha256',
    'rollbackCommandSha256',
  ],
  'proof.snapshot',
);

if (proof.version !== 1) fail('proof.version must equal 1.');
if (proof.kind !== 'lunchlineup-initial-vm217-cutover-rollback') fail('proof.kind is invalid.');
if (proof.status !== 'ready') fail('proof.status must equal ready.');
if (proof.vmId !== 217) fail('proof.vmId must equal 217.');
if (proof.legacySystem !== 'php') fail('proof.legacySystem must equal php.');
if (proof.host !== options.get('--expected-host')) fail('proof.host does not match the requested VM217 host.');
if (proof.targetSourceSha !== sourceSha) fail('proof.targetSourceSha does not match the candidate SHA.');

requireString(proof.snapshot.reference, 'proof.snapshot.reference', /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{2,255}$/);
if (proof.snapshot.durableProofUri !== options.get('--expected-proof-uri')) {
  fail('proof.snapshot.durableProofUri does not match the requested retained object.');
}
verifyDurableUri(proof.snapshot.durableProofUri);
if (proof.snapshot.snapshotCommandSha256 !== snapshotCommandSha256) {
  fail('proof snapshot command digest does not match the armed command.');
}
if (proof.snapshot.proofFetchCommandSha256 !== proofFetchCommandSha256) {
  fail('proof fetch command digest does not match the armed command.');
}
if (proof.snapshot.rollbackCommandSha256 !== rollbackCommandSha256) {
  fail('proof rollback command digest does not match the armed command.');
}

const createdAt = parseTimestamp(proof.snapshot.createdAt, 'proof.snapshot.createdAt');
const ageMilliseconds = verificationTime - createdAt;
if (ageMilliseconds < -30_000) fail('proof snapshot timestamp is too far in the future.');
if (ageMilliseconds > maxAgeSeconds * 1000) fail('proof snapshot is stale.');

const proofSha256 = createHash('sha256').update(proofBytes).digest('hex');
console.log(`initial_cutover_rollback_proof_ok source_sha=${sourceSha} proof_sha256=${proofSha256}`);
