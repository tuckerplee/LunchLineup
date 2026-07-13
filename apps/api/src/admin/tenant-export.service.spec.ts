import { Logger } from "@nestjs/common";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TENANT_EXPORT_COLLECTIONS,
  TENANT_EXPORT_EXCLUDED_MODELS,
  TenantExportService,
} from "./tenant-export.service";

const emptyDelegates = Array.from(
  new Set(TENANT_EXPORT_COLLECTIONS.map((collection) => collection.delegate)),
);

function createSharedDatabase(users: Array<Record<string, unknown>> = []) {
  const jobs = new Map<string, any>();
  const tenant = {
    id: "tenant-1",
    name: "Acme",
    slug: "acme",
    planTier: "FREE",
    status: "ACTIVE",
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    usageCredits: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  };
  const tx: any = {
    tenant: { findUniqueOrThrow: vi.fn().mockResolvedValue(tenant) },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn(async (query: any) => {
        const after = query.cursor?.id;
        const start = after
          ? users.findIndex((user) => user.id === after) + 1
          : 0;
        return users.slice(start, start + query.take);
      }),
    },
    tenantExportJob: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          Array.from(jobs.values()).find((job) =>
            Object.entries(where).every(([key, value]: [string, any]) => {
              if (key === "createdAt") return job.createdAt > value.gt;
              return job[key] === value;
            }),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where, take }: any) =>
        Array.from(jobs.values())
          .filter(
            (job) =>
              job.tenantId === where.tenantId &&
              job.requestedByUserId === where.requestedByUserId &&
              job.expiresAt > where.expiresAt.gt,
          )
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              right.id.localeCompare(left.id),
          )
          .slice(0, take),
      ),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date();
        const job = {
          ...data,
          bytes: 0,
          rowCounts: null,
          progressCollection: null,
          progressRows: 0,
          claimToken: null,
          claimExpiresAt: null,
          attempts: 0,
          error: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        jobs.set(job.id, job);
        return job;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const job = jobs.get(where.id);
        if (
          !job ||
          Object.entries(where).some(([key, value]: [string, any]) =>
            value?.gt instanceof Date
              ? job[key] <= value.gt
              : job[key] !== value,
          )
        )
          return { count: 0 };
        Object.assign(job, data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
  };
  for (const delegate of emptyDelegates) {
    if (!tx[delegate])
      tx[delegate] = { findMany: vi.fn().mockResolvedValue([]) };
  }
  tx.$queryRaw = vi.fn(async (query: any) => {
    const sql = query.sql as string;
    if (sql.includes("WITH candidate")) {
      const job = Array.from(jobs.values())
        .filter(
          (entry) =>
            entry.expiresAt > new Date() &&
            (entry.state === "QUEUED" ||
              (entry.state === "RUNNING" && entry.claimExpiresAt < new Date())),
        )
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )[0];
      if (!job) return [];
      job.state = "RUNNING";
      job.claimToken = query.values[0];
      job.claimExpiresAt = query.values[1];
      job.attempts += 1;
      return [job];
    }
    if (sql.includes("SET \"state\" = 'EXPIRED'")) {
      const expired = Array.from(jobs.values()).filter(
        (job) => job.expiresAt <= new Date() && job.state !== "EXPIRED",
      );
      for (const job of expired) job.state = "EXPIRED";
      return expired.map((job) => ({ artifactKey: job.artifactKey }));
    }
    return [];
  });
  return {
    jobs,
    tx,
    db: {
      withTenant: vi.fn(
        async (
          _tenantId: string,
          operation: (client: any) => Promise<unknown>,
        ) => operation(tx),
      ),
      withPlatformAdmin: vi.fn(
        async (operation: (client: any) => Promise<unknown>) => operation(tx),
      ),
    } as any,
  };
}

describe("TenantExportService durable jobs", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lunchlineup-export-test-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("survives an API restart and completes on another replica with bounded cursor pages", async () => {
    const users = Array.from({ length: 1_000 }, (_, index) => ({
      id: `user-${String(index).padStart(5, "0")}`,
      name: `User ${index}`,
      email: `user-${index}@example.test`,
    }));
    const shared = createSharedDatabase(users);
    const options = {
      artifactDirectory: directory,
      sharedArtifactStorage: true,
      replicaCount: 2,
      pageRows: 37,
      maxPageBytes: 256 * 1024,
      minStartIntervalMs: 0,
      startWorker: false,
    };
    const firstReplica = new TenantExportService(shared.db, undefined, options);
    const queued = await firstReplica.start({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    });
    expect(queued.state).toBe("queued");

    const restartedReplica = new TenantExportService(
      shared.db,
      undefined,
      options,
    );
    await expect(restartedReplica.runWorkerOnce()).resolves.toBe(true);
    const ready = await restartedReplica.status(
      { tenantId: "tenant-1", userId: "user-1" },
      queued.id,
    );

    expect(ready).toMatchObject({
      state: "ready",
      error: undefined,
      progress: { rows: 1_001, attempts: 1 },
    });
    expect(ready.rowCounts.users).toBe(1_000);
    expect(shared.tx.user.findMany.mock.calls.length).toBeGreaterThan(25);
    const artifact = await restartedReplica.openDownload(
      { tenantId: "tenant-1", userId: "user-1" },
      queued.id,
    );
    const artifactPath = (artifact.stream as any).path;
    expect(shared.jobs.get(queued.id).artifactKey).toMatch(
      /^[0-9a-f-]{36}-[0-9a-f-]{36}\.ndjson$/i,
    );
    const lines = (await readFile(artifactPath, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({
      type: "manifest",
      version: 2,
      snapshot: "repeatable-read",
    });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      type: "complete",
      rowCounts: { users: 1_000 },
    });
    if (process.platform !== "win32")
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    await expect(
      restartedReplica.status(
        { tenantId: "tenant-1", userId: "user-2" },
        queued.id,
      ),
    ).rejects.toThrow(/not found/i);
  }, 20_000);

  it("fails closed in production or multiple replicas without explicitly shared durable storage", () => {
    const shared = createSharedDatabase();
    expect(
      () =>
        new TenantExportService(shared.db, undefined, {
          artifactDirectory: directory,
          production: true,
          sharedArtifactStorage: false,
          startWorker: false,
        }),
    ).toThrow(/shared durable/i);
    expect(
      () =>
        new TenantExportService(shared.db, undefined, {
          artifactDirectory: directory,
          replicaCount: 2,
          sharedArtifactStorage: false,
          startWorker: false,
        }),
    ).toThrow(/shared durable/i);
  });

  it("recovers only the requesting user's unexpired jobs in newest-first order", async () => {
    const shared = createSharedDatabase();
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      startWorker: false,
    });
    const actor = {
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    };
    const olderReady = await service.start(actor);
    const otherRequester = await service.start({ ...actor, userId: "user-2" });
    const active = await service.start(actor);
    const expired = await service.start(actor);
    Object.assign(shared.jobs.get(olderReady.id), {
      state: "READY",
      createdAt: new Date("2026-07-13T10:00:00.000Z"),
    });
    Object.assign(shared.jobs.get(otherRequester.id), {
      state: "READY",
      createdAt: new Date("2026-07-13T10:01:00.000Z"),
    });
    Object.assign(shared.jobs.get(active.id), {
      state: "RUNNING",
      createdAt: new Date("2026-07-13T10:02:00.000Z"),
    });
    Object.assign(shared.jobs.get(expired.id), {
      state: "READY",
      createdAt: new Date("2026-07-13T10:03:00.000Z"),
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    });

    const result = await service.listRecent(actor);

    expect(result.jobs.map((job: { id: string }) => job.id)).toEqual([
      active.id,
      olderReady.id,
    ]);
    expect(shared.tx.tenantExportJob.findMany).toHaveBeenLastCalledWith({
      where: {
        tenantId: "tenant-1",
        requestedByUserId: "user-1",
        expiresAt: { gt: expect.any(Date) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 5,
    });
  });
  it("expires artifacts on a scheduled maintenance path independent of status requests", async () => {
    const shared = createSharedDatabase();
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      expiresMs: 1,
      startWorker: false,
    });
    const queued = await service.start({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await expect(service.cleanupExpired()).resolves.toBe(1);
    expect(shared.jobs.get(queued.id).state).toBe("EXPIRED");
  });

  it("contains a fire-and-forget queue claim rejection and leaves the job queued for retry", async () => {
    const shared = createSharedDatabase();
    const metrics = { tenantExportsTotal: { inc: vi.fn() } } as any;
    shared.db.withPlatformAdmin = vi
      .fn()
      .mockRejectedValue(new Error("platform admin claim unavailable"));
    const loggerError = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const service = new TenantExportService(shared.db, metrics, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      pollIntervalMs: 60_000,
      startWorker: true,
    });

    try {
      const queued = await service.start({
        tenantId: "tenant-1",
        userId: "user-1",
        ipAddress: null,
        userAgent: "vitest",
      });
      await vi.waitFor(() =>
        expect(metrics.tenantExportsTotal.inc).toHaveBeenCalledWith({
          outcome: "worker_error",
        }),
      );
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

      expect(unhandled).toEqual([]);
      expect(shared.jobs.get(queued.id)).toMatchObject({
        state: "QUEUED",
        claimToken: null,
        attempts: 0,
      });
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringMatching(/queue drain failed.*available for retry/i),
      );
    } finally {
      clearInterval((service as any).timer);
      process.off("unhandledRejection", onUnhandled);
      loggerError.mockRestore();
    }
  });

  it("contains a heartbeat renewal rejection and completes after a later lease check", async () => {
    const shared = createSharedDatabase();
    const metrics = { tenantExportsTotal: { inc: vi.fn() } } as any;
    const service = new TenantExportService(shared.db, metrics, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      leaseMs: 3_000,
      startWorker: false,
    });
    const queued = await service.start({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    });
    let releaseTenant!: () => void;
    const tenantBlocked = new Promise<void>((resolveTenant) => {
      releaseTenant = resolveTenant;
    });
    shared.tx.tenant.findUniqueOrThrow.mockImplementationOnce(async () => {
      await tenantBlocked;
      return {
        id: "tenant-1",
        name: "Acme",
        slug: "acme",
        planTier: "FREE",
        status: "ACTIVE",
        trialEndsAt: null,
        gracePeriodEndsAt: null,
        usageCredits: 0,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        deletedAt: null,
      };
    });
    const runPlatformAdmin =
      shared.db.withPlatformAdmin.getMockImplementation()!;
    shared.db.withPlatformAdmin = vi
      .fn()
      .mockImplementationOnce(runPlatformAdmin)
      .mockRejectedValueOnce(new Error("lease renewal unavailable"))
      .mockImplementation(runPlatformAdmin);
    const loggerError = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const worker = service.runWorkerOnce();
      await vi.waitFor(() =>
        expect(shared.tx.tenant.findUniqueOrThrow).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(
        () =>
          expect(metrics.tenantExportsTotal.inc).toHaveBeenCalledWith({
            outcome: "worker_error",
          }),
        { timeout: 2_000 },
      );
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

      expect(unhandled).toEqual([]);
      expect(shared.jobs.get(queued.id)).toMatchObject({
        state: "RUNNING",
        attempts: 1,
      });
      expect(loggerError).toHaveBeenCalledWith(
        expect.stringMatching(/lease renewal failed.*remains retryable/i),
      );

      releaseTenant();
      await expect(worker).resolves.toBe(true);
      expect(shared.jobs.get(queued.id).state).toBe("READY");
    } finally {
      releaseTenant();
      process.off("unhandledRejection", onUnhandled);
      loggerError.mockRestore();
    }
  });
});

describe("tenant export model coverage contract", () => {
  it("accounts for every direct tenant-owned Prisma model and relationship-owned join", async () => {
    const schema = await readFile(
      resolve(__dirname, "../../../../packages/db/prisma/schema.prisma"),
      "utf8",
    );
    const directTenantModels = Array.from(
      schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g),
    )
      .filter((match) => /^\s*tenantId\s+String\b/m.test(match[2]))
      .map((match) => match[1]);
    const accountedFor = new Set([
      ...TENANT_EXPORT_COLLECTIONS.map((collection) => collection.model),
      ...Object.keys(TENANT_EXPORT_EXCLUDED_MODELS),
    ]);
    expect(
      directTenantModels.filter((model) => !accountedFor.has(model)),
    ).toEqual([]);
    expect(Array.from(accountedFor)).toEqual(
      expect.arrayContaining([
        "Break",
        "MfaTotpClaim",
        "OnboardingSignupAttempt",
        "RolePermission",
        "Session",
      ]),
    );
  });

  it("uses explicit redacted projections for lunch-break requests and webhook deliveries", () => {
    const lunchBreak = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "LunchBreakGenerationRequest",
    )!;
    const webhook = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "WebhookDelivery",
    )!;
    expect(lunchBreak.select).toMatchObject({
      id: true,
      response: true,
      calculationSnapshot: true,
    });
    expect(lunchBreak.select).not.toHaveProperty("claimToken");
    expect(lunchBreak.select).not.toHaveProperty("failureMessage");
    expect(webhook.select).toMatchObject({
      id: true,
      payloadDigest: true,
      payloadBytes: true,
    });
    expect(webhook.select).not.toHaveProperty("encryptedUrl");
    expect(webhook.select).not.toHaveProperty("encryptedPayload");
    expect(webhook.select).not.toHaveProperty("encryptionKeyRef");
  });
});
