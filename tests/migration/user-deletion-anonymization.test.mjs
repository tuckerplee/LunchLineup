import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('deleted-user migration scrubs every direct identity and credential field', () => {
  const sql = read('packages/db/prisma/migrations/20260713_user_deletion_anonymization.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(migrationsReadme, /20260713_user_deletion_anonymization\.sql/);
  assert.match(sql, /CREATE TRIGGER tr_scrub_deleted_user_row/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\."User"/);
  for (const field of [
    'email',
    'username',
    'emailEncrypted',
    'emailHash',
    'nameEncrypted',
    'phone',
    'phoneEncrypted',
    'phoneHash',
    'oidcIssuer',
    'oidcSubject',
    'passwordHash',
    'pinHash',
    'mfaSecret',
  ]) {
    assert.match(sql, new RegExp(`NEW\."${field}" := NULL`));
  }
  assert.match(sql, /NEW\."name" := 'Deleted user'/);
  assert.match(sql, /NEW\."mfaBackupCodes" := ARRAY\[\]::TEXT\[\]/);
  assert.match(sql, /NEW\."mfaEnabled" := FALSE/);
  assert.match(sql, /WHERE "deletedAt" IS NOT NULL/);
});

test('deleted-user migration revokes and tombstones sessions and destroys recovery authorization material', () => {
  const sql = read('packages/db/prisma/migrations/20260713_user_deletion_anonymization.sql');

  assert.match(sql, /CREATE TRIGGER tr_invalidate_deleted_user_auth_artifacts/);
  assert.match(sql, /DELETE FROM public\."RefreshTokenReplay"/);
  assert.match(sql, /CREATE TRIGGER tr_block_deleted_user_session_auth/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\."Session"/);
  assert.match(sql, /Sessions for deleted users must remain revoked and anonymized\./);
  assert.match(sql, /"refreshToken" = encode\(public\.digest\('deleted-session:' \|\| "id", 'sha256'\), 'hex'\)/);
  assert.match(sql, /"selectorHash" = NULL/);
  assert.match(sql, /"ipAddress" = '\[deleted\]'/);
  assert.match(sql, /"userAgent" = '\[deleted\]'/);
  assert.match(sql, /"revokedAt" = NEW\."deletedAt"/);
  for (const table of ['PasswordResetEmailOutbox', 'PasswordResetToken', 'MfaTotpClaim', 'RoleAssignment']) {
    assert.match(sql, new RegExp(`DELETE FROM public\."${table}"`));
  }
  assert.match(sql, /DELETE FROM public\."OnboardingSignupAttempt"[\s\S]*?WHERE "tenantId" = NEW\."tenantId"[\s\S]*?AND "userId" = NEW\."id"/);
  assert.match(sql, /DELETE FROM public\."Notification"[\s\S]*?WHERE "tenantId" = NEW\."tenantId"[\s\S]*?AND "userId" = NEW\."id"/);
  assert.match(sql, /redact_deleted_user_audit_records\(NEW\."tenantId", NEW\."id"\)/);
});
