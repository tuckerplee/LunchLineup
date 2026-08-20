import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInternalBetaCandidateProof,
  requiredInternalBetaGates,
} from '../../scripts/build-internal-beta-candidate-proof.mjs';

const sourceSha = 'a'.repeat(40);
const repository = 'tuckerplee/LunchLineup';
const runId = '123456';
const workflowRun = `https://github.com/${repository}/actions/runs/${runId}`;
const services = [
  'api', 'api-v2', 'web', 'engine', 'worker', 'migrate', 'control', 'backup',
  'proxy', 'pgbouncer', 'postgres', 'node-exporter', 'loki', 'tempo', 'grafana',
  'alertmanager', 'otel-collector',
];

function manifest(overrides = {}) {
  const digest = `sha256:${'b'.repeat(64)}`;
  const imagePrefix = 'ghcr.io/tuckerplee/lunchlineup';
  return Buffer.from(JSON.stringify({
    version: 1,
    releaseTarget: 'internal-beta',
    sourceSha,
    workflowRun,
    imagePrefix,
    productionHealthProof: {
      domain: 'beta.lunchlineup.com',
      url: 'https://beta.lunchlineup.com/health',
    },
    publicBuildConfig: {
      values: {
        NEXT_PUBLIC_API_URL: '/api/v2',
        NEXT_PUBLIC_APP_ORIGIN: 'https://beta.lunchlineup.com',
        NEXT_PUBLIC_APP_URL: 'https://beta.lunchlineup.com',
        NEXT_PUBLIC_APP_ENV: 'production',
        NEXT_PUBLIC_SIGNUP_MODE: 'closed_beta',
      },
    },
    images: Object.fromEntries(services.map((service) => [service, {
      digest,
      ref: `${imagePrefix}/${service}:${sourceSha}@${digest}`,
    }])),
    ...overrides,
  }));
}

function gateResults() {
  return Object.fromEntries(requiredInternalBetaGates.map((name) => [name, 'success']));
}

function context(overrides = {}) {
  return {
    gateResults: gateResults(),
    manifestBytes: manifest(),
    repository,
    runAttempt: '2',
    runId,
    sourceEvent: 'push',
    sourceRef: 'refs/heads/internal-beta-candidate',
    sourceSha,
    remoteSourceSha: sourceSha,
    workflowRun,
    generatedAt: '2026-08-19T02:00:00.000Z',
    ...overrides,
  };
}

test('internal beta proof binds every required gate, release image, remote ref, and workflow run', () => {
  const proof = buildInternalBetaCandidateProof(context());

  assert.equal(proof.kind, 'lunchlineup-internal-beta-candidate-proof');
  assert.equal(proof.releaseTarget, 'internal-beta');
  assert.deepEqual(Object.keys(proof.gates), requiredInternalBetaGates);
  assert.equal(proof.gates['fullstack-e2e'], 'success');
  assert.equal(proof.gates['dependency-audit'], 'success');
  assert.equal(proof.gates.sast, 'success');
  assert.equal(proof.gates['trivy-scan'], 'success');
  assert.equal(proof.source.sha, sourceSha);
  assert.equal(proof.source.remoteSha, sourceSha);
  assert.match(proof.releaseManifest.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(proof.releaseManifest.images), services);
});

test('manual internal beta proof accepts an exact remote-backed branch and rejects tags', () => {
  const proof = buildInternalBetaCandidateProof(context({
    sourceEvent: 'workflow_dispatch',
    sourceRef: 'refs/heads/codex/internal-beta-launch',
  }));
  assert.equal(proof.source.ref, 'refs/heads/codex/internal-beta-launch');

  assert.throws(
    () => buildInternalBetaCandidateProof(context({
      sourceEvent: 'workflow_dispatch',
      sourceRef: 'refs/tags/internal-beta',
    })),
    /must select a concrete branch ref/,
  );
});

test('internal beta proof fails closed for a skipped, missing, or unexpected gate', () => {
  for (const [name, mutate] of [
    ['skipped full stack', (gates) => { gates['fullstack-e2e'] = 'skipped'; }],
    ['missing dependency audit', (gates) => { delete gates['dependency-audit']; }],
    ['unexpected bypass', (gates) => { gates.bypass = 'success'; }],
  ]) {
    const gates = gateResults();
    mutate(gates);
    assert.throws(
      () => buildInternalBetaCandidateProof(context({ gateResults: gates })),
      /Internal beta candidate proof rejected/,
      name,
    );
  }
});

test('internal beta proof rejects detached source, production manifests, and any non-closed signup mode', () => {
  assert.throws(
    () => buildInternalBetaCandidateProof(context({ remoteSourceSha: 'c'.repeat(40) })),
    /remote branch head must exactly match/,
  );
  assert.throws(
    () => buildInternalBetaCandidateProof(context({
      manifestBytes: manifest({ releaseTarget: 'production' }),
    })),
    /releaseTarget=internal-beta/,
  );

  for (const signupMode of ['invite_only', 'open']) {
    const unsafeSignupManifest = JSON.parse(manifest().toString('utf8'));
    unsafeSignupManifest.publicBuildConfig.values.NEXT_PUBLIC_SIGNUP_MODE = signupMode;
    assert.throws(
      () => buildInternalBetaCandidateProof(context({
        manifestBytes: Buffer.from(JSON.stringify(unsafeSignupManifest)),
      })),
      /exact closed_beta mode/,
    );
  }
});
