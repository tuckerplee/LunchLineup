#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_KEY_ENV,
  PREVIOUS_KEY_ENV,
  managedKeys,
} from './webhook-encryption-keyring.mjs';

const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const KEY_REF_PATTERN = /^[a-f0-9]{16}$/;

function fail(message) {
  throw new Error(`Webhook rollback key readiness failed closed: ${message}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseRuntimeEnvironment(path) {
  const values = {};
  for (const [index, rawLine] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail(`runtime environment line ${index + 1} is malformed.`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function keyReadinessFromRuntime(runtimeEnvironment, sourceSha) {
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) fail('source SHA must be a full lowercase Git SHA.');
  const keyring = managedKeys(
    runtimeEnvironment[CURRENT_KEY_ENV],
    runtimeEnvironment[PREVIOUS_KEY_ENV],
  );
  return {
    version: 1,
    sourceSha,
    currentKeyRef: keyring.current.ref,
    decryptableKeyRefs: keyring.keys.map(({ ref }) => ref).sort(),
  };
}

export function verifyRollbackKeyReadiness(state, candidate) {
  if (
    state?.version !== 1
    || !SOURCE_SHA_PATTERN.test(state?.sourceSha ?? '')
    || !KEY_REF_PATTERN.test(state?.currentKeyRef ?? '')
    || !Array.isArray(state?.decryptableKeyRefs)
    || state.decryptableKeyRefs.length < 1
    || state.decryptableKeyRefs.length > 2
    || new Set(state.decryptableKeyRefs).size !== state.decryptableKeyRefs.length
    || state.decryptableKeyRefs.some((ref) => !KEY_REF_PATTERN.test(ref))
    || !state.decryptableKeyRefs.includes(state.currentKeyRef)
  ) fail('active-release readiness state is malformed.');
  const activeSourceSha = state.sourceSha;
  if (!state.decryptableKeyRefs.includes(candidate.currentKeyRef)) {
    fail('candidate current key was not preloaded into the rollback release. Deploy it as the previous key before activation.');
  }
  if (!candidate.decryptableKeyRefs.includes(state.currentKeyRef)) {
    fail('candidate runtime cannot decrypt envelopes written by the active release.');
  }
  return {
    activeSourceSha,
    activeCurrentKeyRef: state.currentKeyRef,
    candidateCurrentKeyRef: candidate.currentKeyRef,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is missing or invalid.`);
  }
}

function readActiveSha(path) {
  const value = readFileSync(path, 'utf8').trim();
  if (!SOURCE_SHA_PATTERN.test(value)) fail('active release SHA file is invalid.');
  return value;
}

function writeState(path, state, exclusive) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(path) && exclusive) fail('readiness state already exists; bootstrap is single-use.');
  const temporary = `${path}.tmp.${process.pid}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function main() {
  const command = process.argv[2];
  const runtimeOption = option('--runtime-env');
  const stateOption = option('--state');
  if (!command || !runtimeOption || !stateOption) {
    fail('usage: webhook-key-rollback-readiness.mjs <verify|record|bootstrap> --runtime-env PATH --state PATH ...');
  }
  const runtimePath = resolve(runtimeOption);
  const statePath = resolve(stateOption);
  const runtime = parseRuntimeEnvironment(runtimePath);

  if (command === 'verify') {
    const candidateSourceSha = String(option('--candidate-source-sha') ?? '');
    const candidate = keyReadinessFromRuntime(runtime, candidateSourceSha);
    const result = verifyRollbackKeyReadiness(readJson(statePath, 'readiness state'), candidate);
    process.stdout.write(
      `webhook_rollback_key_readiness_ok active_sha=${result.activeSourceSha} active_key_ref=${result.activeCurrentKeyRef} candidate_key_ref=${result.candidateCurrentKeyRef}\n`,
    );
    return;
  }

  const sourceSha = String(option('--source-sha') ?? '');
  const state = keyReadinessFromRuntime(runtime, sourceSha);
  if (command === 'bootstrap') {
    if (option('--confirm') !== `bootstrap-webhook-key-readiness:${sourceSha}`) {
      fail('bootstrap confirmation does not match the active source SHA.');
    }
    const activeShaOption = option('--active-sha-file');
    if (!activeShaOption || readActiveSha(resolve(activeShaOption)) !== sourceSha) fail('bootstrap source SHA is not active.');
    writeState(statePath, state, true);
  } else if (command === 'record') {
    writeState(statePath, state, false);
  } else {
    fail('unsupported command.');
  }
  process.stdout.write(`webhook_rollback_key_readiness_recorded source_sha=${sourceSha} current_key_ref=${state.currentKeyRef}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
