import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyResendReadiness } from '../../scripts/verify-resend-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceSha = '0123456789abcdef0123456789abcdef01234567';
const apiKey = `re_${'a'.repeat(32)}`;
const webhookSecret = `whsec_${'b'.repeat(32)}`;
const probeId = '12345678-1234-4123-8123-123456789abc';

test('Resend readiness sends one release-bound idempotent acceptance probe', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return response(200, JSON.stringify({ id: 'provider-message-1' }));
  };

  const result = await verifyResendReadiness({ env: validEnv(), fetchImpl, probeId });

  assert.deepEqual(result, {
    ok: true,
    endpoint: 'https://api.resend.com/emails',
    senderDomain: 'beta.lunchlineup.com',
    releaseSha: sourceSha,
    providerAccepted: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(requests[0].init.headers['Idempotency-Key'], `email-readiness/${sourceSha}/${probeId}`);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    from: 'LunchLineup Beta <no-reply@beta.lunchlineup.com>',
    to: ['launch-owner@lunchlineup.com'],
    subject: 'LunchLineup email readiness check',
    html: `<p>Transactional email readiness passed for release <code>${sourceSha}</code>.</p>`,
    text: `Transactional email readiness passed for release ${sourceSha}.`,
  });
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('Resend readiness rejects placeholders and malformed launch inputs before network access', async () => {
  for (const override of [
    { RESEND_API_KEY: `re_dev_${'a'.repeat(32)}` },
    { RESEND_WEBHOOK_SECRET: 'whsec_placeholder' },
    { RESEND_WEBHOOK_SECRET: `whsec_dev_${'b'.repeat(32)}` },
    { EMAIL_FROM: 'not-an-address' },
    { EMAIL_FROM: 'LunchLineup <no-reply@example.test>' },
    { RESEND_PREFLIGHT_RECIPIENT: 'not-an-address' },
    { RESEND_PREFLIGHT_RECIPIENT: 'operator@example.test' },
    { DEPLOY_RELEASE_SHA: 'not-a-sha' },
  ]) {
    let called = false;
    await assert.rejects(
      verifyResendReadiness({
        env: { ...validEnv(), ...override },
        fetchImpl: async () => {
          called = true;
          return response(200, JSON.stringify({ id: 'unexpected' }));
        },
      }),
      /(?:not_live|invalid)/,
    );
    assert.equal(called, false);
  }
  await assert.rejects(
    verifyResendReadiness({ env: validEnv(), fetchImpl: async () => response(200, '{}'), probeId: 'not-a-uuid' }),
    /preflight_probe_id_invalid/,
  );
});

test('separate readiness invocations use distinct release-bound provider identities', async () => {
  const keys = [];
  const fetchImpl = async (_url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    return response(200, JSON.stringify({ id: `provider-message-${keys.length}` }));
  };

  await verifyResendReadiness({ env: validEnv(), fetchImpl });
  await verifyResendReadiness({ env: validEnv(), fetchImpl });

  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys.every((key) => key.startsWith(`email-readiness/${sourceSha}/`)));
});

test('browser-visible beta and production deployment fail closed on the provider probe before startup mutation', () => {
  const bootstrap = readFileSync(join(root, 'scripts/bootstrap-vm107-dev.sh'), 'utf8');
  const deploy = readFileSync(join(root, 'scripts/deploy-vm217-remote.sh'), 'utf8');
  const apiImage = readFileSync(join(root, 'infrastructure/docker/Dockerfile.api'), 'utf8');

  assert.match(
    bootstrap,
    /PUBLIC_APP_ORIGIN" == "https:\/\/beta\.lunchlineup\.com"[\s\S]*public_email_delivery=true/,
  );
  assert.match(
    bootstrap,
    /if \[\[ -n "\$\{RESEND_API_KEY:-\}" \]\]; then\s+upsert_env RESEND_API_KEY "\$RESEND_API_KEY"/,
  );
  assert.match(
    bootstrap,
    /docker compose --env-file "\$SECRET_ENV_PATH" build api\s+candidate_api_built=true\s+docker compose --env-file "\$SECRET_ENV_PATH" run --rm --no-deps --pull never \\\s+--env-from-file "\$SECRET_ENV_PATH" \\\s+api node scripts\/verify-resend-readiness\.mjs/,
  );
  const probeCall = bootstrap.lastIndexOf('  verify_public_email_readiness');
  const databaseMutation = bootstrap.lastIndexOf('  reconcile_disposable_database_credentials');
  const stackMutation = bootstrap.lastIndexOf('  start_stack');
  assert.ok(probeCall > 0);
  assert.ok(probeCall < databaseMutation);
  assert.ok(databaseMutation < stackMutation);
  assert.doesNotMatch(bootstrap, /apt-get install[^\n]*\bnodejs\b/);
  assert.match(
    apiImage,
    /COPY --from=builder \/app\/scripts\/verify-resend-readiness\.mjs \/app\/scripts\/verify-resend-readiness\.mjs/,
  );
  assert.match(
    apiImage,
    /COPY --from=builder \/app\/scripts\/production-launch-policy-shared\.mjs \/app\/scripts\/production-launch-policy-shared\.mjs/,
  );
  assert.match(
    deploy,
    /validate-production-launch\.mjs "\$COMPOSE_SERVICE_ENV_FILE" --verify-local-secret-files\s+node scripts\/verify-resend-readiness\.mjs "\$COMPOSE_SERVICE_ENV_FILE"\s+preflight_webhook_rollback_keys/,
  );
});

test('Resend readiness exposes only bounded status diagnostics on provider rejection', async () => {
  await assert.rejects(
    verifyResendReadiness({
      env: validEnv(),
      fetchImpl: async () => response(
        403,
        'launch-owner@lunchlineup.com Authorization: Bearer secret-key provider detail',
      ),
    }),
    (error) => {
      assert.equal(error.message, 'provider_rejected_status_403');
      assert.doesNotMatch(error.message, /launch-owner|Authorization|secret-key|provider detail/);
      return true;
    },
  );
});

test('Resend readiness rejects oversized or malformed success responses', async () => {
  await assert.rejects(
    verifyResendReadiness({
      env: validEnv(),
      fetchImpl: async () => response(200, JSON.stringify({ id: 'x'.repeat(256) })),
    }),
    /provider_response_invalid/,
  );
  await assert.rejects(
    verifyResendReadiness({
      env: validEnv(),
      fetchImpl: async () => response(200, 'x'.repeat(65 * 1024)),
    }),
    /provider_response_oversized/,
  );
});

test('Resend readiness keeps the response body inside the provider deadline', async () => {
  await assert.rejects(
    verifyResendReadiness({
      env: { ...validEnv(), RESEND_PREFLIGHT_TIMEOUT_MS: '1000' },
      fetchImpl: async (_url, init) => ({
        status: 200,
        headers: { get: () => null },
        text: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
      }),
    }),
    /provider_timeout/,
  );
});

function validEnv() {
  return {
    RESEND_API_KEY: apiKey,
    RESEND_WEBHOOK_SECRET: webhookSecret,
    EMAIL_FROM: 'LunchLineup Beta <no-reply@beta.lunchlineup.com>',
    RESEND_PREFLIGHT_RECIPIENT: 'launch-owner@lunchlineup.com',
    RESEND_PREFLIGHT_TIMEOUT_MS: '10000',
    DEPLOY_RELEASE_SHA: sourceSha,
  };
}

function response(status, body) {
  return {
    status,
    headers: { get: () => String(Buffer.byteLength(body, 'utf8')) },
    text: async () => body,
  };
}
