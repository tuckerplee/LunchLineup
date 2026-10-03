/**
 * SOURCE DRAFT ONLY: owner-admitted B7 API phase, not ordinary unit discovery.
 * Actual handler + TenantPrismaService + Prisma against the worker's admitted
 * disposable DB. SDK signature result and secure retrieval are synthetic.
 * No HTTP controller, provider authenticity/delivery or release proof.
 */
import "reflect-metadata";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  constants, openSync, fstatSync, readSync, closeSync, readFileSync,
  realpathSync, writeFileSync, fsyncSync, renameSync, existsSync, unlinkSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { expect, it, vi } from "vitest";
import { secureHttpRequest } from "../../src/common/secure-http-client";

vi.mock("../../src/common/secure-http-client", () => ({ secureHttpRequest: vi.fn() }));

const SERVICE_SHA = "848a138658063007b237c7c48514523deb9190fcb26d63e7d38f1e397ab907fe";
const TENANT_SHA = "0a4a9040cf2b32de30552d2725c949c00b44816b51d83e230670e6f409ec37d1";
const API_NOW = "2026-07-09T19:31:00.000Z";
const EVENT_TYPE = "v1.billing.meter.error_report_triggered";
const METER = "fixture_meter_B7";
const RETRIEVAL_BYTES = 4096;
const requestMock = vi.mocked(secureHttpRequest);

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function record(value: unknown, reason: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), reason);
  return value as Record<string, unknown>;
}

function privateDocument(path: string): { value: Record<string, unknown>; sha256: string } {
  check(typeof process.geteuid === "function", "Native fixture requires admitted Linux");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    check(info.isFile() && info.nlink === 1 && info.uid === process.geteuid() && (info.mode & 0o077) === 0,
          "Native phase file must be owner-private and regular");
    check(info.size > 0 && info.size <= 65536, "Native phase file exceeds bound");
    const buffer = Buffer.alloc(65537);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    check(used === info.size && used <= 65536
          && info.dev === after.dev && info.ino === after.ino
          && info.size === after.size && info.mtimeMs === after.mtimeMs
          && info.ctimeMs === after.ctimeMs, "Native phase changed during bounded read");
    const body = buffer.subarray(0, used);
    return {
      value: record(JSON.parse(body.toString("utf8")), "Invalid phase object"),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

function privateJson(path: string): Record<string, unknown> {
  return privateDocument(path).value;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshot(row: unknown): string {
  return JSON.stringify(row); // Prisma's actual date/metadata serialization; no secret fields.
}

function writePhaseOnce(path: string, result: Record<string, unknown>): void {
  check(!existsSync(path), "API result already exists; no overwrite/retry");
  const body = JSON.stringify(result, null, 2) + "\n";
  check(Buffer.byteLength(body) <= 65536, "API result exceeds bound");
  const temp = join(dirname(path), "." + basename(path) + "." + process.pid + ".tmp");
  let created = false;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Only this admitted job owns the directory. Recheck before publication;
    // this is not a general atomic no-clobber primitive or cross-owner lock.
    check(!existsSync(path), "API result appeared concurrently");
    renameSync(temp, path);
    created = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temp);
  }
}

it("B7 processes actual handler rotation once and leaves the same worker payload for resend", async () => {
  const started = performance.now(); // Date is fake later; monotonic observation is not.
  const receiptPath = process.env.BILLING_NATIVE_TARGET_RECEIPT;
  const handoffPath = process.env.BILLING_NATIVE_WORKER_HANDOFF;
  const resultPath = process.env.BILLING_NATIVE_API_RESULT;
  check(receiptPath && handoffPath && resultPath, "Explicit owner-issued B7 phase paths required");
  check(!existsSync(resultPath), "B7 API phase already recorded");
  const receipt = privateJson(receiptPath);
  const handoff = privateJson(handoffPath);
  const job = receipt.ownerJobId;
  check(receipt.kind === "lunchlineup-disposable-billing-target"
        && receipt.schemaVersion === 2 && receipt.runtimeCleared === true
        && receipt.cleanupOwnership === "exact-controller-job-fixture-rows",
        "Wrong owner-admitted target receipt");
  check(typeof job === "string" && /^[a-f0-9]{32}$/.test(job), "Invalid job identity");
  check(typeof receipt.expiresAtUtc === "string"
        && Number.isFinite(Date.parse(receipt.expiresAtUtc))
        && Date.parse(receipt.expiresAtUtc) > Date.now(), "Target receipt expired");
  check(handoff.kind === "billing-B7-worker-sent-A" && handoff.ownerJobId === job
        && handoff.intervalSeconds === 3600, "Wrong B7 worker handoff");
  const api = record(receipt.apiPhase, "Explicit owner-issued API phase receipt required");
  const controller = record(receipt.controllerBinding, "Existing-controller binding required");
  const controllerKeys = ["ciRunId", "ciSourceSha", "preflightPath", "preflightSha256"];
  check(Object.keys(controller).sort().join("|") === [...controllerKeys].sort().join("|"),
        "Unsupported controller binding fields");
  const ciRun = controller.ciRunId;
  const ciSha = controller.ciSourceSha;
  check(typeof ciRun === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(ciRun)
        && typeof ciSha === "string" && /^[a-f0-9]{40}$/.test(ciSha),
        "Invalid exact controller run/candidate");
  const workspace = "/var/lib/custom-ci/workspaces/" + ciRun;
  const runnerTemp = "/var/lib/custom-ci/runs/" + ciRun + "/tmp/job-tmp";
  const buildRoot = runnerTemp + "/lunchlineup-source-" + ciRun + "/build";
  const preflightPath = workspace + "/.release/internal-ci/" + ciSha + "/integration-target.json";
  check(controller.preflightPath === preflightPath && realpathSync(preflightPath) === preflightPath
        && typeof controller.preflightSha256 === "string"
        && /^[a-f0-9]{64}$/.test(controller.preflightSha256),
        "Controller preflight path/hash invalid");
  const document = privateDocument(preflightPath);
  check(document.sha256 === controller.preflightSha256, "Controller preflight bytes differ");
  const prefix = "lunchlineup-integration-" + ciRun.replace(/[^a-zA-Z0-9]/g, "");
  const expectedPreflight: Record<string, unknown> = {
    runId: ciRun, sourceSha: ciSha, workspace, temporaryRoot: runnerTemp,
    mutationRole: "lunchlineup_ci_app", dataTargetEnvironment: "disposable",
    database: "lunchlineup_test", store: runnerTemp + "/lunchlineup-integration-containers-" + ciRun,
    containers: ["postgres", "redis", "rabbitmq"].map((name) => prefix + "-" + name),
  };
  check(Object.keys(document.value).sort().join("|") === Object.keys(expectedPreflight).sort().join("|"),
        "Unexpected preflight shape");
  for (const [key, expected] of Object.entries(expectedPreflight)) {
    check(JSON.stringify(document.value[key]) === JSON.stringify(expected), "Preflight target binding differs");
  }
  const handoffController = record(handoff.controllerBinding, "Worker controller binding missing");
  check(Object.keys(handoffController).sort().join("|") === [...controllerKeys].sort().join("|"),
        "Worker controller shape differs");
  for (const key of controllerKeys) check(handoffController[key] === controller[key], "Worker controller differs");
  const expectedRole = "lunchlineup_ci_app";
  const expectedDatabase = "lunchlineup_test";
  check(receipt.database === expectedDatabase && receipt.role === expectedRole,
        "Only the approved existing-controller integration target is allowed");
  check(typeof receipt.platformCapability === "string"
        && receipt.platformCapability.length >= 32
        && receipt.platformCapability.length <= 4096, "Test-only capability missing");
  check(typeof api.databaseUrl === "string", "Explicit API database URL required");
  let targetUrl: URL;
  try { targetUrl = new URL(api.databaseUrl); }
  catch { throw new Error("Invalid admitted API database URL"); }
  check(["postgresql:", "postgres:"].includes(targetUrl.protocol)
        && targetUrl.hostname === "127.0.0.1"
        && decodeURIComponent(targetUrl.username) === expectedRole
        && targetUrl.password.length > 0
        && decodeURIComponent(targetUrl.pathname.slice(1)) === expectedDatabase
        && targetUrl.port === String(receipt.port)
        && !targetUrl.hash, "API target does not match admitted job");
  const workerIdentity = record(handoff.databaseIdentity, "Worker target identity missing");
  const apiHost = targetUrl.hostname.replace(/^\[|\]$/g, "");
  check(workerIdentity.database === expectedDatabase && workerIdentity.role === expectedRole
        && workerIdentity.host === apiHost && String(workerIdentity.port) === targetUrl.port,
        "API and worker target endpoints differ");
  check([...targetUrl.searchParams.keys()].every((key) => key === "sslmode"),
        "Owner URL contains unreviewed API connection options");
  targetUrl.searchParams.set("connection_limit", "1");
  targetUrl.searchParams.set("pool_timeout", "5");
  targetUrl.searchParams.set("connect_timeout", "5");
  targetUrl.searchParams.set("socket_timeout", "10");
  targetUrl.searchParams.set("schema", "public");

  const servicePath = fileURLToPath(new URL("../../src/billing/stripe-meter-error.service.ts", import.meta.url));
  const tenantPath = fileURLToPath(new URL("../../src/database/tenant-prisma.service.ts", import.meta.url));
  check(realpathSync(servicePath) === buildRoot + "/apps/api/src/billing/stripe-meter-error.service.ts"
        && realpathSync(tenantPath) === buildRoot + "/apps/api/src/database/tenant-prisma.service.ts"
        && api.serviceSourcePath === realpathSync(servicePath)
        && api.tenantSourcePath === realpathSync(tenantPath)
        && api.serviceSha256 === SERVICE_SHA && api.tenantSha256 === TENANT_SHA
        && hash(servicePath) === SERVICE_SHA && hash(tenantPath) === TENANT_SHA,
        "API loaded-source binding differs from reviewed owner code");
  const tenantId = handoff.tenantId;
  const eventId = handoff.usageEventId;
  check(typeof tenantId === "string" && tenantId.startsWith("fixture_" + job + "_B7")
        && typeof eventId === "string" && /^[A-Za-z0-9._:@+-]{1,128}$/.test(eventId),
        "Handoff ownership invalid");
  const initial = record(handoff.initialRow, "Worker's independent initial row required");
  check(initial.id === eventId && initial.tenantId === tenantId
        && initial.status === "SENT" && initial.attempts === 1
        && initial.quantity === 3 && initial.eventName === "fixture_staff_A"
        && initial.stripeCustomerId === "fixture_customer_A_" + tenantId
        && initial.periodStart === "2026-07-09T19:00:00.000Z"
        && initial.periodEnd === "2026-07-09T20:00:00.000Z"
        && initial.submittedAt === "2026-07-09T19:30:10.000Z",
        "Worker handoff does not establish literal A interval and payload");
  check(typeof initial.identifier === "string" && typeof initial.idempotencyKey === "string",
        "Initial transport identity missing");

  // No import or target connection is qualified by merely possessing this JSON.
  // The owner must admit the exact source/dependency lane separately.
  const { TenantPrismaService } = await import("../../src/database/tenant-prisma.service");
  const { StripeMeterErrorService } = await import("../../src/billing/stripe-meter-error.service");
  const priorCapability = process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;
  const priorAttempts = process.env.STRIPE_USAGE_MAX_ATTEMPTS;
  process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = receipt.platformCapability;
  process.env.STRIPE_USAGE_MAX_ATTEMPTS = "5";
  let result: Record<string, unknown> | undefined;
  let disconnect: (() => Promise<void>) | undefined;
  try {
    const client = new PrismaClient({
      datasources: { db: { url: targetUrl.toString() } },
      transactionOptions: { maxWait: 2000, timeout: 10000 },
    });
    disconnect = () => client.$disconnect();
    const db = new TenantPrismaService(client);
    disconnect = () => db.onModuleDestroy();
    check(vi.isMockFunction(secureHttpRequest), "Retrieval mock binding missing");
    await client.$connect();
    const identity = await client.$queryRawUnsafe<Array<{
      database: string; role: string; zone: string; statement: string; lock: string;
      superuser: boolean; bypass: boolean;
    }>>(
      "SELECT current_database() AS database,current_user AS role,"
      + "current_setting('TimeZone') AS zone,"
      + "current_setting('statement_timeout') AS statement,"
      + "current_setting('lock_timeout') AS lock,rolsuper AS superuser,"
      + "rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user",
    );
    expect(identity).toEqual([{
      database: expectedDatabase, role: expectedRole, zone: "UTC", statement: "10s",
      lock: "5s", superuser: false, bypass: false,
    }]);
    const flags = await client.$queryRawUnsafe<Array<{
      name: string; enabled: boolean; forced: boolean;
    }>>(
      "SELECT relname AS name,relrowsecurity AS enabled,relforcerowsecurity AS forced "
      + "FROM pg_class WHERE oid IN ('public.\"Tenant\"'::regclass,"
      + "'public.\"User\"'::regclass,'public.\"StripeUsageEvent\"'::regclass) ORDER BY relname",
    );
    expect(flags).toEqual(["StripeUsageEvent", "Tenant", "User"].map((name) => ({
      name, enabled: true, forced: true,
    })));
    const before = await db.withTenant(tenantId, (tx) =>
      tx.stripeUsageEvent.findUniqueOrThrow({ where: { id: eventId } }),
    );
    for (const key of ["id", "tenantId", "metric", "quantity", "eventName",
                       "stripeCustomerId", "identifier", "idempotencyKey", "status", "attempts"]) {
      expect((before as unknown as Record<string, unknown>)[key]).toEqual(initial[key]);
    }
    expect(before.periodStart.toISOString()).toBe(initial.periodStart);
    expect(before.periodEnd.toISOString()).toBe(initial.periodEnd);
    expect(before.submittedAt?.toISOString()).toBe(initial.submittedAt);

    const thinId = "evt_fixture_B7_" + job;
    const signed = { id: thinId, type: EVENT_TYPE };
    const full = {
      ...signed, livemode: true, related_object: { id: METER },
      data: {
        reason: {
          error_count: 1,
          error_types: [{
            code: "timestamp_in_future", error_count: 1,
            sample_errors: [{ request: {
              identifier: before.identifier, idempotency_key: before.idempotencyKey,
            } }],
          }],
        },
        validation_start: "2026-07-09T19:30:00.000Z",
        validation_end: "2026-07-09T19:31:00.000Z",
      },
    };
    const body = JSON.stringify(full);
    check(Buffer.byteLength(body) <= RETRIEVAL_BYTES, "Synthetic retrieval exceeded bound");
    let retrievals = 0;
    requestMock.mockImplementation(async (url, options) => {
      check(++retrievals <= 2, "Unexpected additional retrieval");
      expect(url).toBe("https://api.stripe.com/v2/core/events/" + thinId);
      expect(options?.timeoutMs).toBe(10000);
      expect(options?.maxResponseBytes).toBe(1048576);
      return new Response(body, { status: 200 });
    });
    const sdk = { webhooks: { constructEvent: vi.fn(() => signed) } };
    const service = new StripeMeterErrorService(
      new ConfigService({
        STRIPE_SECRET_KEY: "synthetic-api-secret",
        STRIPE_METER_ERROR_WEBHOOK_SECRET: "synthetic-webhook-secret",
        STRIPE_METER_ID: METER, STRIPE_METER_EVENT_NAME: "fixture_staff_A",
        STRIPE_METER_AGGREGATION: "last",
      }), db, sdk as unknown as Stripe,
    );
    vi.useFakeTimers({ toFake: ["Date"] }); // DB/network/runner timers remain real.
    vi.setSystemTime(new Date(API_NOW));
    const raw = Buffer.from(JSON.stringify(signed));
    expect(await service.handleWebhook(raw, "synthetic-signature")).toEqual({
      matched: 1, transitioned: 1,
    });
    const rotated = await db.withTenant(tenantId, (tx) =>
      tx.stripeUsageEvent.findUniqueOrThrow({ where: { id: eventId } }),
    );
    for (const key of ["id", "tenantId", "metric", "quantity", "eventName", "stripeCustomerId"]) {
      expect((rotated as unknown as Record<string, unknown>)[key])
        .toEqual((before as unknown as Record<string, unknown>)[key]);
    }
    expect(rotated.periodStart).toEqual(before.periodStart);
    expect(rotated.periodEnd).toEqual(before.periodEnd);
    expect(rotated.submittedAt).toEqual(before.submittedAt);
    expect(rotated.identifier).not.toBe(before.identifier);
    expect(rotated.idempotencyKey).not.toBe(before.idempotencyKey);
    expect(rotated.identifier).toMatch(/^ll_async_[a-f0-9]{64}$/);
    expect(rotated.idempotencyKey).toMatch(/^stripe_usage_async_[a-f0-9]{64}$/);
    expect(rotated.status).toBe("FAILED");
    expect(rotated.attempts).toBe(1);
    expect(rotated.nextAttemptAt.toISOString()).toBe("2026-07-09T19:36:00.000Z");
    expect(rotated.sentAt).toBeNull();
    expect(rotated.stripeObjectId).toBeNull();
    expect(rotated.stripeRequestId).toBeNull();
    const metadata = record(rotated.metadata, "Rotation provenance missing");
    expect(metadata.logicalUsageIdentity).toBe(before.identifier);
    expect(record(metadata.stripeAsyncError, "Async provenance missing")).toEqual({
      eventId: thinId, eventType: EVENT_TYPE, code: "timestamp_in_future",
      disposition: "explicit_bounded_retry",
      rejectedIdentifier: before.identifier, rejectedIdempotencyKey: before.idempotencyKey,
      retryIdentifier: rotated.identifier, retryIdempotencyKey: rotated.idempotencyKey,
      receivedAt: API_NOW,
    });
    expect(await service.handleWebhook(raw, "synthetic-signature")).toEqual({
      matched: 1, transitioned: 0,
    });
    const duplicate = await db.withTenant(tenantId, (tx) =>
      tx.stripeUsageEvent.findUniqueOrThrow({ where: { id: eventId } }),
    );
    expect(snapshot(duplicate)).toBe(snapshot(rotated));
    expect(sdk.webhooks.constructEvent).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenCalledTimes(2);
    result = {
      kind: "billing-B7-api-rotated-once", ownerJobId: job, tenantId,
      usageEventId: eventId, eventId: thinId, intervalSeconds: 3600,
      handlerSourceSha256: SERVICE_SHA, tenantSourceSha256: TENANT_SHA,
      first: { matched: 1, transitioned: 1 }, duplicate: { matched: 1, transitioned: 0 },
      apiNow: API_NOW, rotatedRow: JSON.parse(snapshot(rotated)),
      sdkCalls: 2, retrievalCalls: 2, actualProvider: false, controllerBinding: controller,
    };
  } finally {
    vi.useRealTimers();
    requestMock.mockReset();
    if (priorCapability === undefined) delete process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;
    else process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = priorCapability;
    if (priorAttempts === undefined) delete process.env.STRIPE_USAGE_MAX_ATTEMPTS;
    else process.env.STRIPE_USAGE_MAX_ATTEMPTS = priorAttempts;
    // If disconnect fails no success handoff is published. Owner terminal
    // readbacks are still required; this does not prove backend termination.
    await disconnect?.();
  }
  check(result, "No committed API result");
  check(hash(servicePath) === SERVICE_SHA && hash(tenantPath) === TENANT_SHA,
        "API source changed during phase");
  check(performance.now() - started < 25000,
        "API phase publication deadline exceeded; no success handoff");
  writePhaseOnce(resultPath, result);
}, 30000);
