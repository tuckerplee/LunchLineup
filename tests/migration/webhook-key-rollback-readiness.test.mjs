import assert from 'node:assert/strict';
import test from 'node:test';
import { runMigrationSequence } from '../../scripts/apply-db-migrations.mjs';
import { managedKeys } from '../../scripts/webhook-encryption-keyring.mjs';
import {
  keyReadinessFromRuntime,
  verifyRollbackKeyReadiness,
} from '../../scripts/webhook-key-rollback-readiness.mjs';
import {
  decryptSecret,
  encryptSecret,
} from '../../scripts/rotate-webhook-endpoint-secrets.mjs';

const activeSha = '1'.repeat(40);
const candidateSha = '2'.repeat(40);
const oldKey = '11'.repeat(32);
const newKey = '22'.repeat(32);

function runtime(current, previous) {
  return {
    WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: current,
    ...(previous ? { WEBHOOK_DELIVERY_ENCRYPTION_KEY_PREVIOUS: previous } : {}),
  };
}

test('failed candidate envelopes remain decryptable by the retained old release', () => {
  const retainedRuntime = runtime(oldKey, newKey);
  const candidateRuntime = runtime(newKey, oldKey);
  const activeReadiness = keyReadinessFromRuntime(retainedRuntime, activeSha);
  const candidateReadiness = keyReadinessFromRuntime(candidateRuntime, candidateSha);

  assert.doesNotThrow(() => verifyRollbackKeyReadiness(activeReadiness, candidateReadiness, activeSha));

  const candidateKeys = managedKeys(newKey, oldKey);
  const persistedCandidateEnvelope = encryptSecret('candidate-written-secret', candidateKeys.current.key);
  const retainedKeys = managedKeys(oldKey, newKey);
  assert.equal(decryptSecret(persistedCandidateEnvelope, retainedKeys.keys).plaintext, 'candidate-written-secret');
});

test('candidate activation fails when the retained release has not preloaded the new key', () => {
  const activeReadiness = keyReadinessFromRuntime(runtime(oldKey), activeSha);
  const candidateReadiness = keyReadinessFromRuntime(runtime(newKey, oldKey), candidateSha);

  assert.throws(
    () => verifyRollbackKeyReadiness(activeReadiness, candidateReadiness, activeSha),
    /candidate current key was not preloaded into the rollback release/,
  );
});

test('schema failure occurs before any webhook envelope rotation', async () => {
  const calls = [];
  await assert.rejects(runMigrationSequence({
    verifyWebhookEndpointSecrets: () => calls.push('verify'),
    applyPreMigrations: () => calls.push('pre'),
    pushSchema: () => {
      calls.push('schema');
      throw new Error('candidate schema failed');
    },
    applyRawMigrations: () => calls.push('raw'),
    provisionAppRole: () => calls.push('role'),
    bootstrapProductionAdmin: () => calls.push('admin'),
    rotateWebhookEndpointSecrets: () => calls.push('rotate'),
  }), /candidate schema failed/);
  assert.deepEqual(calls, ['verify', 'pre', 'schema']);
});

test('successful migration rotates only after every schema and bootstrap operation', async () => {
  const calls = [];
  await runMigrationSequence({
    verifyWebhookEndpointSecrets: () => calls.push('verify'),
    applyPreMigrations: () => calls.push('pre'),
    pushSchema: () => calls.push('schema'),
    applyRawMigrations: () => calls.push('raw'),
    provisionAppRole: () => calls.push('role'),
    bootstrapProductionAdmin: () => calls.push('admin'),
    rotateWebhookEndpointSecrets: () => calls.push('rotate'),
  });
  assert.deepEqual(calls, ['verify', 'pre', 'schema', 'raw', 'role', 'admin', 'rotate']);
});
