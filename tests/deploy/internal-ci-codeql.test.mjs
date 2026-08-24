import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = resolve('scripts/verify-internal-ci-codeql.mjs');
const sha = '1'.repeat(40), tree = '2'.repeat(40), baselineSha = '3'.repeat(40), pipeline = '4'.repeat(64), bundle = 'cb361567fa1bdb9d322da4240f621b36f245e4d7bb97db3c3a2ad7f743c8e8e7';
const querySuites = { 'javascript-typescript': 'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls', python: 'codeql/python-queries:codeql-suites/python-security-extended.qls' };

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'll-codeql-')), artifact = join(scratch, 'artifact'), runner = join(scratch, 'runner'), runRoot = join(runner, 'lunchlineup-source-run-1'), scan = join(runRoot, 'scan'), build = join(runRoot, 'build');
  for (const path of [join(artifact, 'source'), join(artifact, 'codeql'), join(artifact, 'details'), join(scan, 'security'), build]) mkdirSync(path, { recursive: true });
  const proof = { version: 1, kind: 'lunchlineup-internal-ci-source-proof', status: 'passed', repository: 'tuckerplee/LunchLineup', sourceRef: 'refs/heads/internal-beta-candidate', sourceSha: sha, remoteCandidateSha: sha, treeSha: tree, baselineRef: 'refs/heads/main', baselineSha, baselineTreeSha: baselineSha, pipelineSha256: pipeline, runId: 'run-1', originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true, verifiedAt: new Date().toISOString() };
  const proofPath = join(artifact, 'source/source-proof.json'); writeFileSync(proofPath, JSON.stringify(proof));
  const contextPath = join(runRoot, 'source-context.json'); writeFileSync(contextPath, JSON.stringify({ version: 1, kind: 'lunchlineup-internal-ci-source-context', repository: proof.repository, runId: proof.runId, runRoot, sourceRef: proof.sourceRef, sourceSha: sha, treeSha: tree, remoteCandidateSha: sha, baselineRef: proof.baselineRef, baselineSha, pipelineSha256: pipeline, sourceProofPath: proofPath, scanSourcePath: scan, buildSourcePath: build, artifactRoot: artifact, evidenceRoot: artifact }));
  const result = { ruleId: 'js/test-rule', partialFingerprints: { primaryLocationStartColumnFingerprint: '7', primaryLocationLineHash: 'abc:1' } };
  const sarifPath = join(artifact, 'codeql/result.sarif');
  const baselinePath = join(scan, 'security/codeql-baseline.json');
  const detailsPath = join(artifact, 'details/codeql.json');
  const baseline = { version: 2, kind: 'lunchlineup-codeql-baseline', fingerprintSchema: 'primary-location-v1', codeqlBundleSha256: bundle, querySuites, findings: [{ language: 'javascript-typescript', ruleId: result.ruleId, primaryLocationLineHash: 'abc:1', primaryLocationStartColumnFingerprint: '7', owner: 'security@lunchlineup', reason: 'Reviewed test fixture.', triagedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }] };
  return { scratch, artifact, runner, contextPath, sarifPath, baselinePath, detailsPath, result, baseline };
}

function run(f, { result = f.result, baseline = f.baseline, invocation = { executionSuccessful: true } } = {}) {
  writeFileSync(f.sarifPath, JSON.stringify({ version: '2.1.0', runs: [{ invocations: [invocation], results: [result] }] }));
  writeFileSync(f.baselinePath, JSON.stringify(baseline));
  return spawnSync(process.execPath, [script, '--source-context', f.contextPath, '--language', 'javascript-typescript', '--sarif', f.sarifPath, '--bundle-sha256', bundle, '--baseline', f.baselinePath, '--details', f.detailsPath], { env: { ...process.env, CI_COMMIT_SHA: sha, CI_RUN_ID: 'run-1', RUNNER_TEMP: f.runner }, encoding: 'utf8' });
}

test('CodeQL verifier accepts the exact two-field primary-location fingerprint', () => { const f = fixture(); try { const result = run(f); assert.equal(result.status, 0, result.stderr); const details = JSON.parse(readFileSync(f.detailsPath)); assert.equal(details.findings, 1); assert.equal(details.unapprovedFindings, 0); assert.equal(details.fingerprintSchema, 'primary-location-v1'); } finally { rmSync(f.scratch, { recursive: true, force: true }); } });

test('CodeQL verifier rejects missing, extra, changed, and duplicate fingerprints', () => {
  for (const mutate of [
    (f) => ({ ...f.result, partialFingerprints: { primaryLocationLineHash: 'abc:1' } }),
    (f) => ({ ...f.result, partialFingerprints: { ...f.result.partialFingerprints, unexpected: 'x' } }),
    (f) => ({ ...f.result, partialFingerprints: { ...f.result.partialFingerprints, primaryLocationLineHash: 'changed:1' } }),
  ]) { const f = fixture(); try { assert.notEqual(run(f, { result: mutate(f) }).status, 0); } finally { rmSync(f.scratch, { recursive: true, force: true }); } }
  const f = fixture(); try { f.baseline.findings.push({ ...f.baseline.findings[0] }); assert.notEqual(run(f).status, 0); } finally { rmSync(f.scratch, { recursive: true, force: true }); }
});

test('CodeQL verifier rejects expired, stale, tool-drifted, and failed evidence', () => {
  const cases = [
    (f) => { f.baseline.findings[0].expiresAt = new Date(Date.now() - 1).toISOString(); },
    (f) => { f.baseline.findings[0].ruleId = 'js/stale'; },
    (f) => { f.baseline.codeqlBundleSha256 = '9'.repeat(64); },
  ];
  for (const mutate of cases) { const f = fixture(); try { mutate(f); assert.notEqual(run(f).status, 0); } finally { rmSync(f.scratch, { recursive: true, force: true }); } }
  const f = fixture(); try { assert.notEqual(run(f, { invocation: { executionSuccessful: false } }).status, 0); } finally { rmSync(f.scratch, { recursive: true, force: true }); }
});
