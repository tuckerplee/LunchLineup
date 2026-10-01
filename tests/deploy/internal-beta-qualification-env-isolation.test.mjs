import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
function generate(development, inheritedOtp = '') {
  const root = mkdtempSync(join(tmpdir(), 'll-qa-env-isolation-'));
  const runner = join(root, 'runner'), runRoot = join(runner, 'lunchlineup-source-env-test');
  const artifact = join(root, 'artifact'), scan = join(runRoot, 'scan'), build = join(runRoot, 'build');
  for (const directory of [artifact, scan, build]) mkdirSync(directory, { recursive: true });
  copyFileSync(join(repositoryRoot, 'docker-compose.yml'), join(build, 'docker-compose.yml'));
  const sha = '1'.repeat(40), tree = '2'.repeat(40), baseline = '3'.repeat(40), pipeline = '4'.repeat(64);
  const proof = { version: 1, kind: 'lunchlineup-internal-ci-source-proof', status: 'passed', repository: 'tuckerplee/LunchLineup', sourceRef: 'refs/heads/internal-beta-candidate', sourceSha: sha, remoteCandidateSha: sha, treeSha: tree, baselineRef: 'refs/heads/main', baselineSha: baseline, baselineTreeSha: baseline, pipelineSha256: pipeline, runId: 'env-test', originalCheckoutClean: true, scanCloneVerified: true, buildCloneVerified: true, gitAlternatesRejected: true, verifiedAt: new Date().toISOString() };
  const proofPath = join(artifact, 'source-proof.json'), contextPath = join(runRoot, 'context.json');
  writeFileSync(proofPath, JSON.stringify(proof));
  writeFileSync(contextPath, JSON.stringify({ version: 1, kind: 'lunchlineup-internal-ci-source-context', repository: proof.repository, runId: proof.runId, runRoot, sourceRef: proof.sourceRef, sourceSha: sha, treeSha: tree, remoteCandidateSha: sha, baselineRef: proof.baselineRef, baselineSha: baseline, pipelineSha256: pipeline, sourceProofPath: proofPath, scanSourcePath: scan, buildSourcePath: build, artifactRoot: artifact, evidenceRoot: artifact }));
  const output = join(root, 'runtime.env'), publicConfig = join(artifact, 'public-config.json');
  try {
    const child = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/write-internal-beta-qualification-env.mjs'), '--source-context', contextPath, '--output', output, '--public-build-config', publicConfig, '--secrets-dir', join(root, 'secrets')], { env: { ...process.env, OTP_HMAC_SECRET: inheritedOtp, CI_COMMIT_SHA: sha, CI_RUN_ID: 'env-test', RUNNER_TEMP: runner, LUNCHLINEUP_DEVELOPMENT_QA: development ? '1' : '' }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const env = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
    assert.equal(statSync(output).mode & 0o777, 0o600, 'generated runtime environment must remain private');
    return { env, publicConfig: JSON.parse(readFileSync(publicConfig, 'utf8')) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('disposable development uses loopback identities and unavailable email delivery', () => {
  const { env, publicConfig } = generate(true);
  assertPrivateOtp({ env, publicConfig });
  for (const key of ['APP_ORIGIN', 'NEXT_PUBLIC_APP_ORIGIN', 'NEXT_PUBLIC_APP_URL']) assert.equal(env[key], 'http://127.0.0.1:8080');
  for (const key of ['NEXT_PUBLIC_APP_ORIGIN', 'NEXT_PUBLIC_APP_URL']) assert.equal(publicConfig.values[key], 'http://127.0.0.1:8080');
  for (const key of ['PASSWORD_RESET_EMAIL_OUTBOX_ENABLED', 'STAFF_INVITATION_OUTBOX_ENABLED', 'SCHEDULE_PUBLISHED_EMAIL_ENABLED']) assert.equal(env[key], 'false');
  assert.equal(env.COOKIE_SECURE, 'false');
  assert.equal(env.DATA_TARGET_ENV, 'disposable');
  assert.equal(env.PROXY_HTTP_BIND, '127.0.0.1');
  assert.equal(env.NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL, 'support@example.invalid');
  // Nonempty fixture keys satisfy Compose interpolation; they are not an egress control.
  assert.match(env.RESEND_API_KEY, /^re_test_/);
  assert.match(env.STRIPE_SECRET_KEY, /^sk_test_/);
});

test('release-qualified internal beta configuration remains unchanged', () => {
  const { env, publicConfig } = generate(false);
  assertPrivateOtp({ env, publicConfig });
  for (const key of ['APP_ORIGIN', 'NEXT_PUBLIC_APP_ORIGIN', 'NEXT_PUBLIC_APP_URL']) assert.equal(env[key], 'https://beta.lunchlineup.com');
  assert.equal(publicConfig.values.NEXT_PUBLIC_APP_ORIGIN, 'https://beta.lunchlineup.com');
  assert.equal(env.PASSWORD_RESET_EMAIL_OUTBOX_ENABLED, 'true');
  assert.equal(env.STAFF_INVITATION_OUTBOX_ENABLED, 'true');
  assert.equal(env.COOKIE_SECURE, 'true');
  assert.equal(env.NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL, 'support@lunchlineup.com');
});

function assertPrivateOtp({ env, publicConfig }) {
  const value = env.OTP_HMAC_SECRET;
  assert.ok(typeof value === 'string' && /^otp_[A-Za-z0-9_-]{43}$/.test(value), 'OTP secret must encode fresh 32-byte material');
  assert.ok(Buffer.from(value.slice(4), 'base64url').length === 32, 'OTP material must be 32 bytes');
  for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'CSRF_SECRET']) {
    assert.ok(value !== env[key], `OTP must be independent from ${key}`);
  }
  assert.ok(!JSON.stringify(publicConfig).includes(value), 'OTP secret must remain outside public build configuration');
  assert.ok(!Object.hasOwn(publicConfig.values, 'OTP_HMAC_SECRET'));
}

test('separate qualification generations receive independent private OTP material', () => {
  const first = generate(true), second = generate(true);
  assertPrivateOtp(first);
  assertPrivateOtp(second);
  assert.ok(first.env.OTP_HMAC_SECRET !== second.env.OTP_HMAC_SECRET, 'separate runs must not share OTP material');
});

test('qualification generates OTP material independently of inherited environment', () => {
  const inherited = 'b'.repeat(48);
  for (const development of [true, false]) {
    const generated = generate(development, inherited);
    assertPrivateOtp(generated);
    assert.ok(generated.env.OTP_HMAC_SECRET !== inherited, 'OTP must not inherit an ambient credential');
  }
});
