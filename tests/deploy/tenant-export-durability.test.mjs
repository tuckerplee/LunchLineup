import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("production API replicas share an explicitly configured export artifact volume", () => {
  const compose = read("docker-compose.yml");
  assert.match(
    compose,
    /TENANT_EXPORT_ARTIFACT_DIRECTORY=\/var\/lib\/lunchlineup\/tenant-exports/,
  );
  assert.match(compose, /TENANT_EXPORT_SHARED_STORAGE=true/);
  assert.match(compose, /API_REPLICA_COUNT=\$\{API_REPLICA_COUNT:-1\}/);
  assert.match(
    compose,
    /tenant_export_artifacts:\/var\/lib\/lunchlineup\/tenant-exports/,
  );
  assert.match(compose, /^  tenant_export_artifacts:\s*$/m);
});

test("durable export migration persists authorization, leases, progress, expiry, and forced RLS", () => {
  const migration = read(
    "packages/db/prisma/migrations/20260712_tenant_export_jobs.sql",
  );
  for (const field of [
    "requestedByUserId",
    "claimToken",
    "claimExpiresAt",
    "progressCollection",
    "progressRows",
    "artifactKey",
    "expiresAt",
  ]) {
    assert.match(migration, new RegExp(`"${field}"`));
  }
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /WHERE "state" IN \('QUEUED', 'RUNNING'\)/);
  assert.match(
    read("packages/db/prisma/migrations/README.md"),
    /`20260712_tenant_export_jobs\.sql`/,
  );
});

test("export runtime derives opaque paths and enforces secure shared storage plus scheduled expiry", () => {
  const service = read("apps/api/src/admin/tenant-export.service.ts");
  const runbook = read("docs/runbooks/data-retention-delete-export.md");
  assert.match(service, /FOR UPDATE SKIP LOCKED/);
  assert.match(service, /mode: 0o700/);
  assert.match(service, /mode: 0o600/);
  assert.match(service, /setInterval\([\s\S]{0,80}\(\) => void this\.maintenance\(\)/);
  assert.match(
    service,
    /Shared durable tenant export artifact storage is required/,
  );
  assert.doesNotMatch(service, /job\.path|body\.path|query\.path/);
  assert.match(runbook, /`tenant_export_artifacts`/);
  assert.match(runbook, /independently of requests/);
});
