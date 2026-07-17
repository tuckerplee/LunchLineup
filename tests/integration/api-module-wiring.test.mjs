import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const harness = resolve(import.meta.dirname, 'api-module-wiring-harness.mjs');
const HARNESS_TIMEOUT_MS = 15_000;
const CLEAN_ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'OTP_HMAC_SECRET',
  'REDIS_URL',
];

function runHarness({ jwtSecrets }) {
  const cleanCwd = mkdtempSync(join(tmpdir(), 'lunchlineup-api-module-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    RESEND_API_KEY: 're_api_module_wiring_test',
    EMAIL_FROM: 'LunchLineup Test <no-reply@example.test>',
    STRIPE_SECRET_KEY: 'sk_test_api_module_wiring',
  };
  for (const key of CLEAN_ENV_KEYS) delete env[key];
  if (jwtSecrets) {
    env.JWT_SECRET = 'a'.repeat(48);
    env.JWT_REFRESH_SECRET = 'b'.repeat(48);
  }

  try {
    return spawnSync(process.execPath, [harness], {
      cwd: cleanCwd,
      env,
      encoding: 'utf8',
      timeout: HARNESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
  } finally {
    rmSync(cleanCwd, { recursive: true, force: true });
  }
}

function assertBounded(result) {
  assert.notEqual(
    result.error?.code,
    'ETIMEDOUT',
    `AppModule harness exceeded ${HARNESS_TIMEOUT_MS}ms. stdout=${result.stdout} stderr=${result.stderr}`,
  );
}

test('production AppModule resolves, closes, and exits with the actual JWT secret names', () => {
  const result = runHarness({ jwtSecrets: true });

  assertBounded(result);
  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /app-module-compile-close:ok/);
});

test('clean-env AppModule compilation fails nonzero without leaking a connecting handle', () => {
  const result = runHarness({ jwtSecrets: false });

  assertBounded(result);
  assert.equal(result.status, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stderr, /app-module-compile-failed:JWT_(?:REFRESH_)?SECRET/);
});
