import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const postgresImage = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const database = 'staff_invitation_migration_test';

function docker(args, { allowFailure = false, input, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Docker command failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function psql(container, sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'postgres', '--dbname', database,
  ], { allowFailure, input: sql });
}

function scalar(container, sql) {
  return docker([
    'exec', container,
    'psql', '--no-psqlrc', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--username', 'postgres', '--dbname', database,
    '--command', sql,
  ]).stdout.trim();
}

const oldSchema = `
CREATE TABLE public."Tenant" (
  "id" TEXT PRIMARY KEY,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE public."User" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "email" TEXT NOT NULL,
  "suspendedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);

INSERT INTO public."Tenant" ("id") VALUES ('tenant-a'), ('tenant-b');
INSERT INTO public."User" ("id", "tenantId", "email")
VALUES ('user-a', 'tenant-a', 'staff@example.test');

CREATE FUNCTION public.get_current_tenant() RETURNS TEXT
LANGUAGE sql STABLE AS $$ SELECT NULL::TEXT $$;

CREATE FUNCTION public.is_current_platform_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$ SELECT TRUE $$;
`;

const outboxValues = `
  repeat('a', 64),
  decode('01', 'hex'),
  decode(repeat('02', 12), 'hex'),
  decode(repeat('03', 16), 'hex'),
  repeat('b', 16)
`;

test('populated old schema gains tenant-first User identity and enforced composite invitation FK', {
  timeout: 120_000,
}, async (t) => {
  const available = docker(['version', '--format', '{{.Server.Version}}'], {
    allowFailure: true,
    timeout: 10_000,
  });
  if (available.status !== 0) {
    t.skip('Docker is required for the disposable PostgreSQL migration proof');
    return;
  }

  const container = `lunchlineup-staff-invitation-${process.pid}-${randomUUID()}`;
  let started = false;
  try {
    docker([
      'run', '--detach', '--rm', '--name', container,
      '--env', 'POSTGRES_PASSWORD=disposable-test-only',
      '--env', `POSTGRES_DB=${database}`,
      postgresImage,
    ], { timeout: 90_000 });
    started = true;

    let ready = false;
    let consecutiveReadyProbes = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = docker([
        'exec', container, 'pg_isready', '--username', 'postgres', '--dbname', database,
      ], { allowFailure: true, timeout: 5_000 });
      if (probe.status === 0) {
        consecutiveReadyProbes += 1;
        if (consecutiveReadyProbes >= 2) {
          ready = true;
          break;
        }
      } else {
        consecutiveReadyProbes = 0;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    assert.equal(ready, true, 'disposable PostgreSQL did not become ready');

    psql(container, oldSchema);
    assert.equal(
      scalar(container, `SELECT to_regclass('public."User_tenantId_id_key"') IS NULL;`),
      't',
      'fixture must represent the populated schema before tenant-first identity staging',
    );

    psql(container, read('packages/db/prisma/migrations/pre_20260715_staff_invitation_outbox.sql'));
    psql(container, read('packages/db/prisma/migrations/20260715_staff_invitation_outbox.sql'));

    assert.equal(scalar(container, `
      SELECT index_metadata.indisunique
        AND index_metadata.indisvalid
        AND pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = '"tenantId"'
        AND pg_get_indexdef(index_metadata.indexrelid, 2, TRUE) = 'id'
      FROM pg_index index_metadata
      WHERE index_metadata.indexrelid = to_regclass('public."User_tenantId_id_key"');
    `), 't');

    const foreignKeyDefinition = scalar(container, `
      SELECT pg_get_constraintdef(oid, TRUE)
      FROM pg_constraint
      WHERE conname = 'StaffInvitationOutbox_tenantId_userId_fkey';
    `);
    assert.match(
      foreignKeyDefinition,
      /FOREIGN KEY \("tenantId", "userId"\) REFERENCES "User"\("tenantId", id\)/,
    );

    psql(container, `
      INSERT INTO public."StaffInvitationOutbox" (
        "id", "tenantId", "userId", "recipientHash", "encryptedPayload",
        "encryptionNonce", "encryptionTag", "encryptionKeyRef"
      ) VALUES ('valid-invitation', 'tenant-a', 'user-a', ${outboxValues});
    `);
    assert.equal(
      scalar(container, `SELECT count(*) FROM public."StaffInvitationOutbox" WHERE "id" = 'valid-invitation';`),
      '1',
    );

    const invalidInsert = psql(container, `
      \\set VERBOSITY verbose
      INSERT INTO public."StaffInvitationOutbox" (
        "id", "tenantId", "userId", "recipientHash", "encryptedPayload",
        "encryptionNonce", "encryptionTag", "encryptionKeyRef"
      ) VALUES ('cross-tenant-invitation', 'tenant-b', 'user-a', ${outboxValues});
    `, { allowFailure: true });
    assert.notEqual(invalidInsert.status, 0, 'cross-tenant invitation insert must fail');
    assert.match(invalidInsert.stderr, /23503:.*StaffInvitationOutbox_tenantId_userId_fkey/s);
    assert.equal(
      scalar(container, `SELECT count(*) FROM public."StaffInvitationOutbox" WHERE "id" = 'cross-tenant-invitation';`),
      '0',
    );
  } finally {
    if (started) {
      const removed = docker(['rm', '--force', container], {
        allowFailure: true,
        timeout: 30_000,
      });
      assert.equal(removed.status, 0, `failed to remove disposable PostgreSQL: ${removed.stderr}`);
      const inspect = docker(['inspect', container], { allowFailure: true, timeout: 10_000 });
      assert.notEqual(inspect.status, 0, 'disposable PostgreSQL container survived cleanup');
    }
  }
});
