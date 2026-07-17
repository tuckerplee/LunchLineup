import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  boundedInteger,
  buildEntitlementEvidence,
  cookieAuthFromSetCookieHeaders,
  createDeterministicAvailabilityPdf,
  isTerminalAvailabilityStatus,
  runAvailabilityImportLoadSmoke,
  validateCreditSourceAttestation,
  validateLoadTarget,
  validateRequestOrigin,
} from '../../scripts/availability-import-load-smoke.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function thresholdMap(thresholds) {
  return Object.assign({}, ...thresholds);
}

function httpRequests(scenarios) {
  const methods = new Set(['delete', 'get', 'head', 'patch', 'post', 'put']);
  return scenarios.flatMap((scenario) => scenario.flow ?? []).flatMap((step) => (
    Object.entries(step)
      .filter(([method]) => methods.has(method))
      .map(([method, request]) => ({ method, request }))
  ));
}

test('load smoke fails closed on failed expectations, missing responses, and non-200 statuses', () => {
  const script = yaml.load(read('scripts/artillery-smoke.yml'));
  const expectPlugin = script.config?.plugins?.expect;
  const ensurePlugin = script.config?.plugins?.ensure;

  assert.equal(expectPlugin?.expectDefault200, true);
  assert.equal(expectPlugin?.reportFailuresAsErrors, true);
  assert.equal(expectPlugin?.outputFormat, 'prettyError');

  const thresholds = thresholdMap(ensurePlugin?.thresholds ?? []);
  assert.equal(thresholds['http.response_time.p99'], 1000);
  assert.equal(thresholds['vusers.failed'], 1, 'threshold is strict, so fewer than one failed VU is allowed');

  assert.deepEqual(ensurePlugin?.conditions, [{
    expression: 'http.responses == http.requests and http.codes.200 == http.requests and plugins.expect.ok == http.requests',
    strict: true,
  }]);
});

test('every launch-smoke request explicitly accepts only HTTP 200', () => {
  const script = yaml.load(read('scripts/artillery-smoke.yml'));
  const requests = httpRequests(script.scenarios ?? []);

  assert.ok(requests.length > 0);
  assert.equal(new Set(requests.map(({ request }) => request.name)).size, requests.length);
  for (const { method, request } of requests) {
    assert.match(request.name ?? '', /\S/, `${method} ${request.url} must have a stable name`);
    assert.deepEqual(
      (request.expect ?? []).filter((expectation) => Object.hasOwn(expectation, 'statusCode')),
      [{ statusCode: 200 }],
      `${method} ${request.url} must accept only HTTP 200`,
    );
    assert.equal(
      (request.expect ?? []).some((expectation) => Object.hasOwn(expectation, 'notStatusCode')),
      false,
      `${method} ${request.url} must not use a partial status-code denylist`,
    );
  }
});

test('load helper uses the immutable Artillery runner without runtime package resolution', () => {
  const launcher = read('scripts/load-test.sh');

  assert.match(
    launcher,
    /artilleryio\/artillery:2\.0\.33@sha256:ee382d480f5cb8473c52fe94cb8e1505a9564ce2accbc94114098e0be06dff56/,
  );
  assert.match(launcher, /docker run --rm/);
  assert.match(launcher, /--network host/);
  assert.match(launcher, /--volume "\$SOURCE_ROOT:\/workspace:ro"/);
  assert.match(launcher, /--volume "\$OUTPUT_DIR:\/output:rw"/);
  assert.match(launcher, /--workdir \/output/);
  assert.doesNotMatch(launcher, /\$SOURCE_ROOT:[^"\n]*:rw/);
  assert.match(launcher, /--env TARGET_URL/);
  assert.match(launcher, /export TARGET_URL/);
  assert.doesNotMatch(launcher, /\bnpx\b|npm exec|npm install/);
});
test('availability-import load smoke is mandatory, authenticated, and independently entitlement-gated', () => {
  const runner = read('scripts/availability-import-load-smoke.mjs');
  const launcher = read('scripts/load-test.sh');
  const seed = read('scripts/seed-e2e.mjs');

  assert.equal(boundedInteger('CONCURRENCY', '2', 2, 2, 4), 2);
  assert.throws(() => boundedInteger('CONCURRENCY', '1', 2, 2, 4), /2 through 4/);
  assert.throws(() => boundedInteger('REQUESTS', '13', 4, 2, 12), /2 through 12/);
  assert.equal(validateLoadTarget('http://127.0.0.1', true).origin, 'http://127.0.0.1');
  assert.throws(() => validateLoadTarget('http://app.example.test'), /must use HTTPS/);
  assert.equal(validateRequestOrigin('https://smoke.lunchlineup.test'), 'https://smoke.lunchlineup.test');
  assert.throws(() => validateRequestOrigin('https://smoke.lunchlineup.test/path'), /clean HTTPS origin/);
  assert.equal(isTerminalAvailabilityStatus('CANCELLED'), true);
  assert.equal(isTerminalAvailabilityStatus('RUNNING'), false);
  assert.equal(validateCreditSourceAttestation('admin-credit-grant'), 'admin-credit-grant');
  assert.throws(() => validateCreditSourceAttestation('wallet'), /exactly/);

  const cookieAuth = cookieAuthFromSetCookieHeaders([
    'access_token=access-value; Path=/; HttpOnly',
    'refresh_token=refresh-value; Path=/; HttpOnly',
    'csrf_token=csrf-value; Path=/; SameSite=Strict',
  ]);
  assert.match(cookieAuth.cookie, /access_token=access-value/);
  assert.equal(cookieAuth.csrfToken, 'csrf-value');

  const pdf = createDeterministicAvailabilityPdf('staff-1');
  assert.deepEqual(pdf, createDeterministicAvailabilityPdf('staff-1'));
  assert.ok(pdf.length < 2048);
  assert.match(pdf.toString('ascii'), /^%PDF-1\.4/);
  assert.match(pdf.toString('ascii'), /Employee ID: staff-1/);
  assert.match(pdf.toString('ascii'), /startxref\n\d+\n%%EOF\n$/);

  const matrix = {
    status: 'ACTIVE',
    stripeSubscriptionPresent: true,
    stripeSubscriptionActive: true,
    usageCredits: 4,
    features: { scheduling: { enabled: true, source: 'credits', creditCost: 1 } },
  };
  const entitlement = buildEntitlementEvidence(
    matrix,
    4,
    'admin-credit-grant',
    new Date('2026-07-15T00:00:00.000Z'),
  );
  assert.equal(entitlement.paidStripeSubscriptionVerified, true);
  assert.equal(entitlement.stripeSubscriptionPresent, true);
  assert.equal(entitlement.featureSource, 'credits');
  assert.equal(entitlement.requiredCredits, 4);
  assert.equal(entitlement.creditSourceAttestation, 'admin-credit-grant');
  assert.throws(() => buildEntitlementEvidence({ ...matrix, usageCredits: 3 }, 4, 'admin-credit-grant'), /requires 4/);
  assert.throws(() => buildEntitlementEvidence({ ...matrix, status: 'TRIAL' }, 4, 'admin-credit-grant'), /ACTIVE paid/);

  assert.match(runner, /\/auth\/pin\/verify/);
  assert.match(runner, /AVAILABILITY_IMPORT_ORIGIN/);
  assert.doesNotMatch(runner, /Origin: target\.origin/);
  assert.match(runner, /"X-CSRF-Token": auth\.csrfToken/);
  assert.match(runner, /AVAILABILITY_IMPORT_TARGET_USER_IDENTIFIER/);
  assert.match(runner, /\/billing\/features/);
  assert.match(runner, /entitlementEvidenceSha256/);
  assert.match(runner, /sourcePdfMode = "generated"/);
  assert.match(runner, /Array\.from\(\{ length: concurrency \}/);
  assert.match(runner, /await Promise\.all\(runners\)/);
  assert.match(runner, /"Idempotency-Key": idempotencyKey/);
  assert.doesNotMatch(runner, /requiredEnvironment\("AVAILABILITY_IMPORT_(?:BEARER_TOKEN|USER_ID|PDF_PATH)"\)/);
  assert.doesNotMatch(runner, /AVAILABILITY_IMPORT_ENTITLEMENT_ATTESTATION/);

  assert.match(launcher, /node scripts\/availability-import-load-smoke\.mjs/);
  assert.doesNotMatch(launcher, /RUN_AVAILABILITY_IMPORT_SMOKE/);
  assert.ok(
    launcher.indexOf('run --output') < launcher.indexOf('node scripts/availability-import-load-smoke.mjs'),
    'availability-import smoke must run after Artillery without an opt-out',
  );

  assert.match(seed, /stripeSubscriptionId/);
  assert.match(seed, /creditTransaction\.create/);
  assert.match(seed, /admin-credit-grant-/);
  assert.match(seed, /staffUsername = process\.env\.E2E_STAFF_USERNAME \?\? 'staff-1'/);
  assert.match(seed, /role: 'STAFF'/);
});

test('cookie runner uses configured origin and billing preflight before uploads', async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const names = [
    'TARGET_URL', 'ALLOW_LOCAL_LOAD_SMOKE', 'AVAILABILITY_IMPORT_TENANT_SLUG',
    'AVAILABILITY_IMPORT_LOGIN_IDENTIFIER', 'AVAILABILITY_IMPORT_LOGIN_PIN',
    'AVAILABILITY_IMPORT_ORIGIN', 'AVAILABILITY_IMPORT_TARGET_USER_IDENTIFIER',
    'AVAILABILITY_IMPORT_CREDIT_SOURCE_ATTESTATION', 'AVAILABILITY_IMPORT_REQUESTS',
    'AVAILABILITY_IMPORT_CONCURRENCY', 'AVAILABILITY_IMPORT_PDF_PATH',
    'AVAILABILITY_IMPORT_BEARER_TOKEN', 'AVAILABILITY_IMPORT_EVIDENCE_PATH',
    'AVAILABILITY_IMPORT_ENTITLEMENT_EVIDENCE_PATH',
  ];
  const originalEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const calls = [];
  let importSequence = 0;
  const json = (status, payload, cookies = []) => ({
    status,
    headers: { getSetCookie: () => cookies, get: () => null },
    text: async () => JSON.stringify(payload),
  });

  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, {
      TARGET_URL: 'http://localhost:8080',
      ALLOW_LOCAL_LOAD_SMOKE: 'true',
      AVAILABILITY_IMPORT_TENANT_SLUG: 'e2e-operations',
      AVAILABILITY_IMPORT_LOGIN_IDENTIFIER: 'e2e.admin',
      AVAILABILITY_IMPORT_LOGIN_PIN: '246810',
      AVAILABILITY_IMPORT_ORIGIN: 'https://smoke.lunchlineup.test',
      AVAILABILITY_IMPORT_TARGET_USER_IDENTIFIER: 'staff-1',
      AVAILABILITY_IMPORT_CREDIT_SOURCE_ATTESTATION: 'admin-credit-grant',
      AVAILABILITY_IMPORT_REQUESTS: '2',
      AVAILABILITY_IMPORT_CONCURRENCY: '2',
    });
    process.stdout.write = () => true;
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      calls.push({ href, options });
      if (href.endsWith('/auth/pin/verify')) {
        return json(200, { success: true, requiresMfa: false, pinResetRequired: false }, [
          'access_token=access-value; Path=/',
          'refresh_token=refresh-value; Path=/',
          'csrf_token=csrf-value; Path=/',
        ]);
      }
      if (href.includes('/users?limit=200')) {
        return json(200, { data: [{ id: 'staff-id', username: 'staff-1', role: 'STAFF' }] });
      }
      if (href.endsWith('/billing/features')) {
        return json(200, {
          status: 'ACTIVE', stripeSubscriptionPresent: true, stripeSubscriptionActive: true, usageCredits: 2,
          features: { scheduling: { enabled: true, source: 'credits', creditCost: 1 } },
        });
      }
      if (options.method === 'POST' && href.includes('/availability-imports/users/')) {
        importSequence += 1;
        return json(202, { id: 'import-' + importSequence });
      }
      if (href.includes('/availability-imports/import-')) return json(200, { status: 'SUCCEEDED' });
      throw new Error('Unexpected request: ' + href);
    };

    const evidence = await runAvailabilityImportLoadSmoke();
    const login = calls.find((call) => call.href.endsWith('/auth/pin/verify'));
    const billingIndex = calls.findIndex((call) => call.href.endsWith('/billing/features'));
    const uploadIndex = calls.findIndex((call) => call.options.method === 'POST'
      && call.href.includes('/availability-imports/users/'));
    const upload = calls[uploadIndex];
    assert.equal(evidence.sourcePdfMode, 'generated');
    assert.equal(evidence.succeeded, 2);
    assert.equal(login.options.headers.Origin, 'https://smoke.lunchlineup.test');
    assert.equal(upload.options.headers.Origin, 'https://smoke.lunchlineup.test');
    assert.equal(upload.options.headers['X-CSRF-Token'], 'csrf-value');
    assert.match(upload.options.headers.Cookie, /access_token=access-value/);
    assert.equal(Object.hasOwn(upload.options.headers, 'Authorization'), false);
    assert.ok(billingIndex >= 0 && billingIndex < uploadIndex);
    assert.ok(upload.options.body instanceof FormData);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    for (const name of names) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});
