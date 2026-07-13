import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyOldReleaseCompatibility } from '../../scripts/verify-old-release-compatibility.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sha = 'a'.repeat(40);

function run(args, env = {}) {
  return spawnSync(process.execPath, ['scripts/release-bundle-registry.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ALLOW_LOCAL_RELEASE_REGISTRY: 'true', ...env },
  });
}

test('exact publication retries repair missing or corrupt mutable indexes without replacing immutable bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-'));
  try {
    const registry = join(scratch, 'registry');
    const statePath = join(scratch, 'state.json');
    const resolved = join(scratch, 'resolved.json');
    writeFileSync(statePath, JSON.stringify({ version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } }));
    const uri = pathToFileURL(registry).href;

    const publish = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(publish.status, 0, `${publish.stdout}\n${publish.stderr}`);
    const indexPath = join(registry, 'index.json');
    const immutablePath = join(registry, 'releases', `${sha}.json`);
    const immutableBytes = readFileSync(immutablePath);
    assert.equal(JSON.parse(readFileSync(indexPath)).currentSuccessfulSha, sha);
    assert.equal(JSON.parse(immutableBytes).sourceSha, sha);

    rmSync(indexPath);
    const missingIndexRetry = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(missingIndexRetry.status, 0, `exact retry should restore a missing mutable index: ${missingIndexRetry.stderr}`);
    assert.equal(JSON.parse(readFileSync(indexPath)).currentSuccessfulSha, sha);
    assert.deepEqual(readFileSync(immutablePath), immutableBytes);

    writeFileSync(indexPath, '{corrupt mutable index');
    const corruptIndexRetry = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(corruptIndexRetry.status, 0, `exact retry should replace a corrupt mutable index: ${corruptIndexRetry.stderr}`);
    assert.equal(JSON.parse(readFileSync(indexPath)).currentSuccessfulSha, sha);
    assert.deepEqual(readFileSync(immutablePath), immutableBytes);

    const resolveResult = run(['resolve', '--registry-uri', uri, '--output', resolved]);
    assert.equal(resolveResult.status, 0, `${resolveResult.stdout}\n${resolveResult.stderr}`);
    assert.equal(JSON.parse(readFileSync(resolved)).sourceSha, sha);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('publication rejects a same-SHA immutable object with different bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-registry-conflict-'));
  try {
    const registry = join(scratch, 'registry');
    const statePath = join(scratch, 'state.json');
    const conflictingStatePath = join(scratch, 'conflicting-state.json');
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(conflictingStatePath, `${JSON.stringify(state)}\n`);
    const uri = pathToFileURL(registry).href;

    const publish = run(['publish', '--registry-uri', uri, '--state-file', statePath]);
    assert.equal(publish.status, 0, `${publish.stdout}\n${publish.stderr}`);
    const immutablePath = join(registry, 'releases', `${sha}.json`);
    const immutableBytes = readFileSync(immutablePath);
    const indexBytes = readFileSync(join(registry, 'index.json'));

    const conflict = run(['publish', '--registry-uri', uri, '--state-file', conflictingStatePath]);
    assert.notEqual(conflict.status, 0, 'same source SHA must not make different immutable bytes idempotent');
    assert.match(conflict.stderr, /Existing immutable release object does not match this bundle/);
    assert.deepEqual(readFileSync(immutablePath), immutableBytes);
    assert.deepEqual(readFileSync(join(registry, 'index.json')), indexBytes);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('first registry bootstrap imports a retained current-live bundle only after exact live identity proof', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-bootstrap-'));
  try {
    const registry = join(scratch, 'registry');
    const retainedPath = join(scratch, 'independently-retained.json');
    const apiProof = join(scratch, 'api-proof.json');
    const webProof = join(scratch, 'web-proof.json');
    const state = { version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) } };
    const proof = (healthUrl) => ({ status: 'passed', sourceSha: sha, servedReleaseSha: sha, releaseIdentityHeader: 'X-LunchLineup-Release', healthUrl, httpStatus: 200, responseSha256: 'c'.repeat(64), responseBytes: 2, checkedAt: new Date().toISOString() });
    writeFileSync(retainedPath, JSON.stringify(state));
    writeFileSync(apiProof, JSON.stringify(proof('https://lunchlineup.example/api/health')));
    writeFileSync(webProof, JSON.stringify(proof('https://lunchlineup.example/')));
    const uri = pathToFileURL(registry).href;
    const args = (output, confirmation = `bootstrap-current-live-release:${sha}`) => [
      'bootstrap-retained', '--registry-uri', uri,
      '--retained-bundle-uri', pathToFileURL(retainedPath).href,
      '--state-file', output,
      '--verified-source-sha', sha,
      '--confirm', confirmation,
      '--max-live-proof-age-seconds', '300',
      '--live-identity-proof', apiProof,
      '--live-identity-proof', webProof,
    ];

    assert.notEqual(run(args(join(scratch, 'wrong-confirmation.json'), 'wrong')).status, 0);
    mkdirSync(join(registry, 'releases'), { recursive: true });
    writeFileSync(join(registry, 'releases', sha + '.json'), JSON.stringify(state));
    const result = run(args(join(scratch, 'verified-retained.json')));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(registry, 'index.json'))).currentSuccessfulSha, sha);
    assert.notEqual(run(args(join(scratch, 'second-bootstrap.json'))).status, 0);

    const staleProof = proof('https://lunchlineup.example/other');
    staleProof.checkedAt = new Date(Date.now() - 301_000).toISOString();
    writeFileSync(webProof, JSON.stringify(staleProof));
    const emptyRegistry = pathToFileURL(join(scratch, 'empty-registry')).href;
    const staleArgs = args(join(scratch, 'stale-proof.json'));
    staleArgs[staleArgs.indexOf(uri)] = emptyRegistry;
    assert.notEqual(run(staleArgs).status, 0, 'stale live proof must not establish a baseline');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('release registry and materializer reject persisted runtime secret bytes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-release-secret-bytes-'));
  try {
    const registry = pathToFileURL(join(scratch, 'registry')).href;
    const statePath = join(scratch, 'state.json');
    writeFileSync(statePath, JSON.stringify({ version: 2, sourceSha: sha, releaseManifest: { sourceSha: sha }, runtimeSecret: { version: 1, provider: 'aws-secretsmanager', reference: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:lunchlineup', secretVersion: 'a'.repeat(32), sha256: 'b'.repeat(64) }, runtimeEnvBase64: Buffer.from('SECRET=value').toString('base64') }));
    assert.notEqual(run(['publish', '--registry-uri', registry, '--state-file', statePath]).status, 0);
    const materialize = spawnSync(process.execPath, ['scripts/materialize-rollback-state.mjs', '--state-file', statePath, '--output-dir', join(scratch, 'materialized')], { cwd: root, encoding: 'utf8' });
    assert.notEqual(materialize.status, 0);
    assert.match(materialize.stderr, /forbidden runtime secret material/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('CI bootstraps and retains one validated baseline before centralized rollback can arm', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const bootstrap = ci.indexOf('name: Bootstrap registry from verified current-live retained bundle');
  const firstResolve = ci.indexOf('name: Resolve and materialize previous successful release bundle', bootstrap);
  const candidateMutation = ci.indexOf('name: "17. Blue/Green deploy"');
  assert.ok(bootstrap > 0 && firstResolve > bootstrap && candidateMutation > firstResolve);
  assert.equal((ci.match(/release-bundle-registry\.mjs resolve/g) ?? []).length, 1);
  assert.equal((ci.match(/REGISTRY_BASELINE_AVAILABLE=true/g) ?? []).length, 1);
  assert.equal((ci.match(/name: Verify previous rollback release inputs/g) ?? []).length, 1);
  assert.match(ci, /Retain validated secret-free rollback baseline/);
  assert.match(ci, /production-rollback:[\s\S]*Download retained validated rollback baseline/);
  assert.match(ci, /production_rollback_armed == 'true'/);
  assert.doesNotMatch(ci, /REGISTRY_BASELINE_AVAILABLE=false|bootstrap-first-production-release|release-bundle-registry\.mjs bootstrap --/);
  assert.match(ci, /bootstrap-current-live-release:\$BOOTSTRAP_LIVE_SOURCE_SHA/);
  assert.match(ci, /build-release-bundle\.mjs[\s\S]{0,180}--expected-source-sha "\$GITHUB_SHA"[\s\S]{0,180}release-bundle-registry\.mjs publish/);
});

test('old release compatibility proof requires isolated clone, exact SHAs, and passed smoke', () => {
  const proof = {
    version: 1,
    status: 'passed',
    previousReleaseSha: sha,
    candidateReleaseSha: 'b'.repeat(40),
    database: { isolatedClone: true, productionMutated: false },
    candidateSchema: { applied: true },
    oldReleaseSmoke: { status: 'passed' },
    completedAt: new Date().toISOString(),
    evidenceUri: 's3://proof/compatibility.json',
  };
  assert.doesNotThrow(() => verifyOldReleaseCompatibility(proof, { previousSha: sha, candidateSha: 'b'.repeat(40) }));
  assert.throws(() => verifyOldReleaseCompatibility({ ...proof, database: { isolatedClone: false, productionMutated: false } }, { previousSha: sha, candidateSha: 'b'.repeat(40) }), /isolated clone/);
});
test('bootstrap dispatch is isolated from push-only deployment', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const bootstrapStart = ci.indexOf('  bootstrap-release-registry:');
  const releaseGateStart = ci.indexOf('  validate-release-gates:');
  const deployStart = ci.indexOf('  deploy-production:');
  const rollbackStart = ci.indexOf('  production-rollback:');
  const bootstrapJob = ci.slice(bootstrapStart, releaseGateStart);
  const deployJob = ci.slice(deployStart, rollbackStart);

  assert.ok(bootstrapStart > 0 && releaseGateStart > bootstrapStart);
  assert.match(bootstrapJob, /if: github\.event_name == 'workflow_dispatch' && inputs\.bootstrap_release_registry == true/);
  assert.match(bootstrapJob, /environment: production/);
  assert.match(bootstrapJob, /bootstrap-current-live-release:\$BOOTSTRAP_LIVE_SOURCE_SHA/);
  assert.match(ci, /validate-release-gates:[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(ci, /deploy-staging:[\s\S]*?if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(deployJob, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(deployJob, /bootstrap-retained|bootstrap_release_registry/);
  const imagePushLines = ci.split('\n').filter((line) => line.includes('push: ${{ github.event_name'));
  assert.equal(imagePushLines.length, 7);
  for (const line of imagePushLines) {
    assert.match(line, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  }
});
