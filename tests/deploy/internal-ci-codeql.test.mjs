import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Reduced structural fixture, not a captured scanner result. Keep optional
// invocation metadata independent from the required CodeQL results array.
function report(results, invocation = { executionSuccessful: true }) {
  return { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', version: '2.26.2' } },
    invocations: [invocation], results }] };
}

function run(f, { result = f.result, baseline = f.baseline, invocation = { executionSuccessful: true }, sarif = report([result], invocation) } = {}) {
  writeFileSync(f.sarifPath, JSON.stringify(sarif));
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


test('CodeQL verifier accepts explicit zero findings with optional metadata and benign notifications', () => {
  const reports = [report([]), { version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL command-line toolchain' } }, results: [] }] },
    report([], { executionSuccessful: true, toolExecutionNotifications: [
      { level: 'warning', message: { text: 'Nonfatal diagnostic' } }, { message: { text: 'Default warning level' } }],
      toolConfigurationNotifications: [{ level: 'note', message: { text: 'Configuration note' } }] })];
  for (const sarif of reports) {
    const f = fixture();
    try {
      const result = run(f, { sarif, baseline: { ...f.baseline, findings: [] } });
      assert.equal(result.status, 0, result.stderr);
      const details = JSON.parse(readFileSync(f.detailsPath));
      assert.equal(details.findings, 0); assert.equal(details.unapprovedFindings, 0);
    } finally { rmSync(f.scratch, { recursive: true, force: true }); }
  }
});

test('CodeQL verifier rejects incomplete report envelopes even with an empty baseline', () => {
  const changedRun = (changes) => ({ ...report([]), runs: [{ ...report([]).runs[0], ...changes }] });
  const reports = [null, [], {}, { runs: [{}] }, { version: '2.1.0', runs: [{}] },
    { ...report([]), version: '2.0.0' }, { ...report([]), runs: [] }, { ...report([]), runs: {} },
    { ...report([]), runs: [null] }, { ...report([]), runs: [[]] },
    changedRun({ results: undefined }), changedRun({ results: null }), changedRun({ results: {} }), changedRun({ results: '' }),
    changedRun({ tool: undefined }), changedRun({ tool: null }), changedRun({ tool: [] }),
    changedRun({ tool: { driver: null } }), changedRun({ tool: { driver: {} } }),
    changedRun({ tool: { driver: { name: ' ' } } }), changedRun({ tool: { driver: { name: 1 } } }),
    changedRun({ invocations: null }), changedRun({ invocations: {} }), changedRun({ invocations: [null] }),
    changedRun({ invocations: [{}] }), changedRun({ invocations: [{ executionSuccessful: 'true' }] }),
    { ...report([]), runs: [report([]).runs[0], {}] }];
  for (const sarif of reports) {
    const f = fixture();
    try {
      const result = run(f, { sarif, baseline: { ...f.baseline, findings: [] } });
      assert.notEqual(result.status, 0, JSON.stringify(sarif));
      assert.match(result.stderr, /Invalid CodeQL evidence/);
      assert.equal(existsSync(f.detailsPath), false, 'Rejected report must not produce passing details');
    } finally { rmSync(f.scratch, { recursive: true, force: true }); }
  }
});

test('CodeQL verifier rejects failed invocations and error or malformed notification arrays', () => {
  const invocations = [{ executionSuccessful: false }];
  for (const key of ['toolExecutionNotifications', 'toolConfigurationNotifications']) {
    for (const notifications of [null, {}, [null], [{ level: 'error', message: { text: 'Analysis incomplete' } }], [{ level: 'invalid' }]]) {
      invocations.push({ executionSuccessful: true, [key]: notifications });
    }
  }
  for (const invocation of invocations) {
    const f = fixture();
    try {
      const result = run(f, { sarif: report([], invocation), baseline: { ...f.baseline, findings: [] } });
      assert.notEqual(result.status, 0, JSON.stringify(invocation)); assert.match(result.stderr, /Invalid CodeQL evidence/);
      assert.equal(existsSync(f.detailsPath), false);
    } finally { rmSync(f.scratch, { recursive: true, force: true }); }
  }
});
