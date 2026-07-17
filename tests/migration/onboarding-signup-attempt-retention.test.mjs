import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const migrationPath = 'packages/db/prisma/migrations/20260714_onboarding_signup_attempt_retention.sql';
const migration = read(migrationPath);
const helper = read('apps/api/src/auth/onboarding-signup-retention.ts');
const controller = read('apps/api/src/admin/admin.controller.ts');
const authReadme = read('apps/api/src/auth/README.md');
const migrationsReadme = read('packages/db/prisma/migrations/README.md');

test('signup-attempt identifiers have a fixed database retention boundary', () => {
  assert.match(migration, /INTERVAL '24 hours'/);
  assert.match(migration, /GREATEST\([\s\S]*"updatedAt"[\s\S]*"otpExpiresAt"[\s\S]*"recoveryExpiresAt"/);
  assert.match(migration, /OnboardingSignupAttempt_retentionDeadline_idx/);
  assert.doesNotMatch(migration, /identityHash"\s*=/);
  assert.doesNotMatch(migration, /organizationHash"\s*=/);
});

test('signup-attempt cleanup is capability-gated and not publicly executable', () => {
  assert.match(migration, /IF NOT public\.is_current_platform_admin\(\) THEN/);
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.purge_expired_onboarding_signup_attempts\(TIMESTAMP WITHOUT TIME ZONE\)[\s\S]*FROM PUBLIC/,
  );
});

test('the scheduled retention endpoint reports dry-runs and executes the database owner function', () => {
  assert.match(helper, /ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS = 24/);
  assert.match(helper, /SELECT COUNT\(\*\)::BIGINT AS "eligibleCount"/);
  assert.match(helper, /public\.purge_expired_onboarding_signup_attempts/);
  assert.match(controller, /applyOnboardingSignupAttemptRetention\(tx, asOf, dryRun\)/);
  assert.match(controller, /signupAttemptRetention,/);
});

test('retention files and scheduler behavior are documented', () => {
  assert.match(authReadme, /24-hour onboarding signup-attempt retention/);
  assert.match(migrationsReadme, /20260714_onboarding_signup_attempt_retention\.sql/);
});
