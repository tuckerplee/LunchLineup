#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) { throw new Error(message); }
function option(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (required) fail(`${name} is required.`);
    return undefined;
  }
  return process.argv[index + 1];
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function singleLine(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || /[\r\n\0]/.test(value)) fail(`${label} must be a non-empty single-line string.`);
  return value;
}

export function validateRuntimeSecretDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) fail('Runtime secret descriptor must be a version 1 object.');
  if (value.provider !== 'aws-secretsmanager') fail('Runtime secret provider must be aws-secretsmanager.');
  const reference = singleLine(value.reference, 'Runtime secret reference');
  const version = singleLine(value.secretVersion, 'Runtime secret version');
  if (!/^[A-Za-z0-9-]{32,64}$/.test(version)) fail('Runtime secret version must be an immutable AWS Secrets Manager VersionId.');
  const digest = String(value.sha256 ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('Runtime secret sha256 is invalid.');
  return { version: 1, provider: 'aws-secretsmanager', reference, secretVersion: version, sha256: digest };
}

function fetchAwsSecret(reference, version) {
  const result = spawnSync('aws', ['secretsmanager', 'get-secret-value', '--secret-id', reference, '--version-id', version, '--output', 'json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('AWS Secrets Manager fetch failed.');
  let response;
  try { response = JSON.parse(result.stdout); } catch { fail('AWS Secrets Manager returned invalid JSON.'); }
  if (response.VersionId !== version) fail('AWS Secrets Manager returned a different secret version.');
  if (typeof response.SecretString === 'string' && response.SecretBinary == null) return Buffer.from(response.SecretString, 'utf8');
  if (typeof response.SecretBinary === 'string' && response.SecretString == null) return Buffer.from(response.SecretBinary, 'base64');
  fail('AWS Secrets Manager response must contain exactly one secret value.');
}

function fetchLocalFixture(reference, version) {
  if (process.env.ALLOW_LOCAL_MANAGED_SECRET !== 'true' || !reference.startsWith('file://')) return null;
  const bytes = readFileSync(fileURLToPath(reference));
  if (sha256(bytes).slice(0, 32) !== version) fail('Local managed-secret fixture version does not match its bytes.');
  return bytes;
}

function main() {
  const descriptorPath = option('--descriptor', false);
  let descriptor;
  if (descriptorPath) descriptor = validateRuntimeSecretDescriptor(JSON.parse(readFileSync(resolve(descriptorPath), 'utf8')));
  else {
    descriptor = { version: 1, provider: option('--provider'), reference: option('--reference'), secretVersion: option('--secret-version'), sha256: option('--expected-sha256', false) ?? '0'.repeat(64) };
    if (descriptor.sha256 !== '0'.repeat(64)) descriptor = validateRuntimeSecretDescriptor(descriptor);
    else if (descriptor.provider !== 'aws-secretsmanager' || !/^[A-Za-z0-9-]{32,64}$/.test(descriptor.secretVersion)) fail('Runtime secret provider/reference/version is invalid.');
  }
  const bytes = fetchLocalFixture(descriptor.reference, descriptor.secretVersion) ?? fetchAwsSecret(descriptor.reference, descriptor.secretVersion);
  const digest = sha256(bytes);
  if (descriptor.sha256 !== '0'.repeat(64) && digest !== descriptor.sha256) fail('Runtime secret bytes do not match the release-bound SHA-256.');
  descriptor = validateRuntimeSecretDescriptor({ ...descriptor, sha256: digest });
  const output = resolve(option('--output'));
  writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
  const descriptorOutput = option('--descriptor-output', false);
  if (descriptorOutput) writeFileSync(resolve(descriptorOutput), `${JSON.stringify(descriptor)}\n`, { mode: 0o600, flag: 'wx' });
  const githubEnv = option('--github-env', false);
  if (githubEnv) appendFileSync(resolve(githubEnv), [`PRODUCTION_RUNTIME_ENV_PATH=${output}`, `COMPOSE_SERVICE_ENV_FILE=${output}`, `PRODUCTION_RUNTIME_ENV_SHA256=${digest}`, ''].join('\n'));
  process.stdout.write(`runtime_secret_rehydrated provider=${descriptor.provider} version=${descriptor.secretVersion} sha256=${digest}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
