import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantPrismaService } from "../database/tenant-prisma.service";
import {
  TENANT_EXPORT_COLLECTIONS,
  TENANT_EXPORT_EXCLUDED_MODELS,
  TenantExportService,
} from "./tenant-export.service";

const emptyDelegates = Array.from(
  new Set(TENANT_EXPORT_COLLECTIONS.map((collection) => collection.delegate)),
);
const postgresIntegrationUrl = process.env.DATABASE_URL;
const postgresOwnerUrl = process.env.MIGRATION_DATABASE_URL;
const postgresIntegrationCapability = process.env.TENANT_DATA_GOVERNANCE_TEST_CAPABILITY
  ?? process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;

function createSharedDatabase(users: Array<Record<string, unknown>> = []) {
  const jobs = new Map<string, any>();
  let platformQueue = Promise.resolve();
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
          ? users.findIndex((user) => user.id === after) + (query.skip ?? 0)
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
          artifactCleanupState: "NONE",
          artifactCleanupOwner: null,
          artifactCleanupLeaseExpiresAt: null,
          artifactCleanupAttempts: 0,
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
  tx.$executeRaw = vi.fn(async (query: any) => {
    const sql = query?.sql as string | undefined;
    if (sql?.includes('SET "artifactCleanupOwner" = NULL')) {
      const job = jobs.get(query.values[0]);
      if (job && job.artifactCleanupOwner === query.values[1]) {
        job.artifactCleanupOwner = null;
        job.artifactCleanupLeaseExpiresAt = null;
      }
    }
    return 1;
  });
  tx.$queryRaw = vi.fn(async (query: any) => {
    const sql = query.sql as string;
    if (sql.includes('CURRENT_TIMESTAMP AS "watermark"')) {
      return [{ watermark: new Date() }];
    }
    if (sql.includes("FOR UPDATE SKIP LOCKED") && sql.includes('FROM "TenantExportJob"')) {
      const job = Array.from(jobs.values())
        .filter(
          (entry) =>
            entry.expiresAt > new Date() &&
            entry.artifactCleanupState === "NONE" &&
            (entry.state === "QUEUED" ||
              (entry.state === "RUNNING" && entry.claimExpiresAt < new Date())),
        )
        .sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )[0];
      return job ? [job] : [];
    }
    if (sql.includes('AS "globalBytes"')) {
      const [tenantId, excludedJobId] = query.values;
      const current = Array.from(jobs.values()).filter(
        (job) => job.id !== excludedJobId
          && job.bytes > 0
          && job.artifactCleanupState !== "COMPLETE",
      );
      return [{
        globalBytes: BigInt(current.reduce((sum, job) => sum + job.bytes, 0)),
        tenantBytes: BigInt(current
          .filter((job) => job.tenantId === tenantId)
          .reduce((sum, job) => sum + job.bytes, 0)),
      }];
    }
    if (sql.includes('SET "state" = \'FAILED\'') && sql.includes('"artifactCleanupState" = \'PENDING\'')) {
      const job = jobs.get(query.values[1]);
      if (!job) return [];
      Object.assign(job, {
        state: "FAILED",
        artifactCleanupState: "PENDING",
        artifactCleanupOwner: null,
        artifactCleanupLeaseExpiresAt: null,
        error: query.values[0],
        completedAt: new Date(),
        updatedAt: new Date(),
      });
      return [{ id: job.id }];
    }
    if (sql.includes('SET "state" = \'FAILED\'')) {
      const job = jobs.get(query.values[0]);
      if (!job) return [];
      Object.assign(job, {
        state: "FAILED",
        bytes: 0,
        claimToken: null,
        claimExpiresAt: null,
        attempts: job.attempts + 1,
        error: "Tenant export generation failed.",
        completedAt: new Date(),
        updatedAt: new Date(),
      });
      return [job];
    }
    if (sql.includes('SET "state" = \'RUNNING\'')) {
      const job = jobs.get(query.values[3]);
      if (!job) return [];
      Object.assign(job, {
        state: "RUNNING",
        bytes: Number(query.values[0]),
        claimToken: query.values[1],
        claimExpiresAt: query.values[2],
        attempts: job.attempts + 1,
        error: null,
        updatedAt: new Date(),
      });
      return [job];
    }
    if (sql.includes('AS "owned"')) {
      const [id, claimToken] = query.values;
      const job = jobs.get(id);
      return [{
        owned: Boolean(job
          && job.state === "RUNNING"
          && job.claimToken === claimToken
          && job.expiresAt > new Date()
          && job.artifactCleanupState === "NONE"),
      }];
    }
    if (sql.includes("pg_try_advisory_xact_lock")) return [{ claimed: true }];
    if (sql.includes('ORDER BY "updatedAt" ASC') && sql.includes('FROM "TenantExportJob"')) {
      const onlyJobId = query.values[0];
      return Array.from(jobs.values())
        .filter((job) => (!onlyJobId || job.id === onlyJobId)
          && ((job.artifactCleanupState === "PENDING"
            && (!job.artifactCleanupOwner || job.artifactCleanupLeaseExpiresAt <= new Date()))
            || (job.expiresAt <= new Date()
              && job.state !== "EXPIRED"
              && job.artifactCleanupState === "NONE")))
        .slice(0, 100);
    }
    if (sql.includes('"artifactCleanupAttempts" = "artifactCleanupAttempts" + 1')) {
      const [cleanupOwner, cleanupLeaseExpiresAt, id] = query.values;
      const job = jobs.get(id);
      if (!job) return [];
      const noOwnership = job.bytes === 0 && !job.artifactKey && !job.claimToken;
      Object.assign(job, {
        state: job.expiresAt <= new Date() ? "EXPIRED" : job.state,
        artifactCleanupState: noOwnership ? "COMPLETE" : "PENDING",
        artifactCleanupOwner: noOwnership ? null : cleanupOwner,
        artifactCleanupLeaseExpiresAt: noOwnership ? null : cleanupLeaseExpiresAt,
        artifactCleanupAttempts: job.artifactCleanupAttempts + 1,
        completedAt: job.completedAt ?? new Date(),
        updatedAt: new Date(),
      });
      return [job];
    }
    if (sql.includes('"artifactCleanupState" = \'PENDING\'') && sql.includes("FOR UPDATE")) {
      const [id, owner] = query.values;
      const job = jobs.get(id);
      return job?.artifactCleanupState === "PENDING" && job.artifactCleanupOwner === owner
        ? [job]
        : [];
    }
    if (sql.includes('SET "artifactCleanupState" = \'COMPLETE\'')) {
      const [id, owner] = query.values;
      const job = jobs.get(id);
      if (!job || job.artifactCleanupOwner !== owner) return [];
      Object.assign(job, {
        artifactCleanupState: "COMPLETE",
        artifactCleanupOwner: null,
        artifactCleanupLeaseExpiresAt: null,
        artifactKey: null,
        bytes: 0,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      });
      return [{ id }];
    }
    if (sql.includes('OR "artifactCleanupState" = \'PENDING\'')) {
      return Array.from(jobs.values())
        .filter((job) => job.bytes > 0 || job.artifactKey || job.claimToken || job.artifactCleanupState === "PENDING")
        .map(({ id, state, artifactKey, claimToken, bytes, artifactCleanupState }) => ({
          id, state, artifactKey, claimToken, bytes, artifactCleanupState,
        }));
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
      withPlatformAdmin: vi.fn(async (operation: (client: any) => Promise<unknown>) => {
        const previous = platformQueue;
        let release!: () => void;
        platformQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await operation(tx);
        } finally {
          release();
        }
      }),
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
      {
        tenantId: "tenant-1",
        userId: "user-1",
        ipAddress: "203.0.113.10",
        userAgent: "vitest",
      },
      queued.id,
    );
    const artifactPath = (artifact.stream as any).path;
    expect(shared.jobs.get(queued.id).artifactKey).toMatch(
      /^[0-9a-f-]{36}-[0-9a-f-]{36}\.ndjson$/i,
    );
    const lines = (await readFile(artifactPath, "utf8")).trim().split("\n");
    const manifest = JSON.parse(lines[0]);
    expect(manifest).toMatchObject({
      type: "manifest",
      version: 3,
      snapshot: "repeatable-read",
    });
    expect(manifest.exportedAt).toBe(shared.jobs.get(queued.id).watermark.toISOString());
    expect(manifest.omitted).toEqual(expect.arrayContaining([
      "timeCard.clockInOperationId",
      "timeCard.clockInRequestHash",
      "payrollPolicyVersion.requestHash",
      "payrollOperation.operationId",
      "payrollOperation.requestHash",
      "payrollOperation.response",
      "payrollExportBatch.requestHash",
    ]));
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      type: "complete",
      rowCounts: { users: 1_000 },
    });
    if (process.platform !== "win32")
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    expect(shared.tx.auditLog.create).toHaveBeenLastCalledWith({
      data: {
        tenantId: "tenant-1",
        userId: "user-1",
        action: "TENANT_EXPORT_DOWNLOADED",
        resource: "TenantExportJob",
        resourceId: queued.id,
        ipAddress: "203.0.113.10",
        userAgent: "vitest",
      },
    });
    for (const collection of TENANT_EXPORT_COLLECTIONS.filter(({ model }) => model.startsWith("Payroll"))) {
      expect(ready.rowCounts[collection.name]).toBe(0);
      expect(shared.tx[collection.delegate].findMany).toHaveBeenCalledOnce();
      expect(shared.tx[collection.delegate].findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId: "tenant-1" },
        orderBy: collection.orderBy,
        take: 37,
      }));
      const query = shared.tx[collection.delegate].findMany.mock.calls[0][0];
      const cursorFields = collection.orderBy?.flatMap((order) => Object.keys(order)) ?? ["id"];
      expect(query.select).toEqual(Object.fromEntries(cursorFields.map((field) => [field, true])));
    }
    await expect(
      restartedReplica.status(
        { tenantId: "tenant-1", userId: "user-2" },
        queued.id,
      ),
    ).rejects.toThrow(/not found/i);
  }, 20_000);

  it("publishes READY only after close, file fsync, atomic rename, and directory fsync", async () => {
    const shared = createSharedDatabase();
    const events: string[] = [];
    const updateMany = shared.tx.tenantExportJob.updateMany.getMockImplementation()!;
    shared.tx.tenantExportJob.updateMany.mockImplementation(async (input: any) => {
      if (input.data.state === "READY") events.push("ready");
      return updateMany(input);
    });
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      startWorker: false,
      durability: {
        closeWriter: async (writer) => {
          writer.end();
          await once(writer, "close");
          events.push("write-closed");
        },
        syncFile: async (path) => {
          const file = await open(path, "r+");
          try {
            await file.sync();
          } finally {
            await file.close();
          }
          events.push("file-synced");
        },
        atomicRename: async (source, destination) => {
          await rename(source, destination);
          events.push("renamed");
        },
        syncDirectory: async (path) => {
          if (process.platform !== "win32") {
            const handle = await open(path, "r");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          events.push("directory-synced");
        },
      },
    });
    const job = await service.start({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    });

    await expect(service.runWorkerOnce()).resolves.toBe(true);

    expect(events).toEqual([
      "write-closed",
      "file-synced",
      "renamed",
      "directory-synced",
      "ready",
    ]);
    expect(shared.jobs.get(job.id).state).toBe("READY");
  });

  it("retains failed cleanup ownership when directory fsync fails before READY", async () => {
    const shared = createSharedDatabase();
    const syncDirectory = vi.fn().mockRejectedValue(new Error("injected directory fsync failure"));
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      startWorker: false,
      durability: { syncDirectory },
    });
    const job = await service.start({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    });

    await expect(service.runWorkerOnce()).resolves.toBe(true);

    expect(syncDirectory).toHaveBeenCalled();
    expect(shared.jobs.get(job.id)).toMatchObject({
      state: "FAILED",
      artifactCleanupState: "PENDING",
    });
    expect(shared.jobs.get(job.id).bytes).toBeGreaterThan(0);
  });

  it("bounds full-row materialization and streams 100 near-limit rows plus one record larger than 4 MiB", async () => {
    const maxPageBytes = 32 * 1024;
    const users = [
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `user-near-${String(index).padStart(3, "0")}`,
        name: "N".repeat(maxPageBytes - 512),
        email: `near-${index}@example.test`,
      })),
      {
        id: "user-oversized",
        name: "O".repeat(4 * 1024 * 1024 + 1),
        email: "oversized@example.test",
      },
    ];
    const shared = createSharedDatabase(users);
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      pageRows: 100,
      maxPageBytes,
      minStartIntervalMs: 0,
      startWorker: false,
    });
    const writeSizes: number[] = [];
    const originalWriteEncoded = (service as any).writeEncoded.bind(service);
    vi.spyOn(service as any, "writeEncoded").mockImplementation(async (...args: unknown[]) => {
      const [writer, value] = args as [any, string];
      writeSizes.push(Buffer.byteLength(value));
      return originalWriteEncoded(writer, value);
    });
    const queued = await service.start({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    });

    await expect(service.runWorkerOnce()).resolves.toBe(true);
    const ready = await service.status(
      { tenantId: "tenant-1", userId: "user-1" },
      queued.id,
    );

    expect(ready).toMatchObject({ state: "ready", rowCounts: { users: 101 } });
    expect(Math.max(...writeSizes)).toBeLessThanOrEqual(maxPageBytes);
    const cursorQueries = shared.tx.user.findMany.mock.calls
      .map(([query]: [any]) => query)
      .filter((query: any) => query.take === 100);
    expect(cursorQueries).toHaveLength(2);
    expect(cursorQueries.every((query: any) => (
      JSON.stringify(query.select) === JSON.stringify({ id: true })
    ))).toBe(true);
    const detailQueries = shared.tx.user.findMany.mock.calls
      .map(([query]: [any]) => query)
      .filter((query: any) => query.take === 1);
    expect(detailQueries).toHaveLength(101);
    expect(detailQueries.every((query: any) => query.select === (
      TENANT_EXPORT_COLLECTIONS.find(({ model }) => model === "User")!.select
    ))).toBe(true);
    const artifact = await service.openDownload({
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    }, queued.id);
    const lines = (await readFile((artifact.stream as any).path, "utf8")).trim().split("\n");
    const oversized = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.collection === "users" && line.data.id === "user-oversized");
    expect(oversized.data.name).toHaveLength(4 * 1024 * 1024 + 1);
  }, 30_000);

  it("enforces the total artifact quota, cleans partial files, and processes the next export", async () => {
    const maxArtifactBytes = 64 * 1024;
    const users = [{
      id: "user-too-large",
      name: "X".repeat(maxArtifactBytes * 4),
      email: "too-large@example.test",
    }];
    const shared = createSharedDatabase(users);
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      pageRows: 10,
      maxPageBytes: 1024,
      maxArtifactBytes,
      minStartIntervalMs: 0,
      startWorker: false,
    });
    const actor = {
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: null,
      userAgent: "vitest",
    };
    const oversized = await service.start(actor);

    await expect(service.runWorkerOnce()).resolves.toBe(true);
    await expect(service.status(actor, oversized.id)).resolves.toMatchObject({
      state: "failed",
      bytes: 0,
      downloadPath: null,
    });
    expect(shared.jobs.get(oversized.id).bytes).toBe(0);
    expect(await readdir(directory)).toEqual([]);

    users.splice(0, users.length, {
      id: "user-small",
      name: "Small export",
      email: "small@example.test",
    });
    const recovery = await service.start(actor);
    await expect(service.runWorkerOnce()).resolves.toBe(true);
    const ready = await service.status(actor, recovery.id);
    expect(ready).toMatchObject({ state: "ready", rowCounts: { users: 1 } });
    expect(ready.bytes).toBeGreaterThan(0);
    expect(ready.bytes).toBeLessThanOrEqual(maxArtifactBytes);
    expect(shared.jobs.get(recovery.id).bytes).toBe(ready.bytes);
    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/\.ndjson$/);
    expect(entries[0]).not.toMatch(/\.part$/);
  });

  it("rejects an invalid total artifact-byte quota at startup", () => {
    const shared = createSharedDatabase();
    expect(() => new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      maxArtifactBytes: 63,
      startWorker: false,
    })).toThrow(/maxArtifactBytes/i);
    expect(() => new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      maxArtifactBytes: 2_147_483_648,
      startWorker: false,
    })).toThrow(/maxArtifactBytes/i);
    expect(() => new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      maxArtifactBytes: 128,
      globalQuotaBytes: 127,
      startWorker: false,
    })).toThrow(/globalQuotaBytes/i);
    expect(() => new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      maxArtifactBytes: 128,
      perTenantQuotaBytes: 127,
      startWorker: false,
    })).toThrow(/perTenantQuotaBytes/i);
  });

  it("atomically admits only one concurrent global reservation and settles it to actual bytes", async () => {
    const maxArtifactBytes = 16 * 1024;
    const shared = createSharedDatabase();
    const options = {
      artifactDirectory: directory,
      maxArtifactBytes,
      globalQuotaBytes: maxArtifactBytes,
      perTenantQuotaBytes: maxArtifactBytes,
      minStartIntervalMs: 0,
      startWorker: false,
    };
    const first = new TenantExportService(shared.db, undefined, options);
    const second = new TenantExportService(shared.db, undefined, options);
    const firstActor = {
      tenantId: "tenant-1", userId: "user-1", ipAddress: null, userAgent: "vitest",
    };
    const secondActor = {
      tenantId: "tenant-2", userId: "user-2", ipAddress: null, userAgent: "vitest",
    };
    const [firstJob, secondJob] = await Promise.all([
      first.start(firstActor),
      second.start(secondActor),
    ]);

    await Promise.all([first.runWorkerOnce(), second.runWorkerOnce()]);

    const states = [
      shared.jobs.get(firstJob.id).state,
      shared.jobs.get(secondJob.id).state,
    ].sort();
    expect(states).toEqual(["FAILED", "READY"]);
    const failed = Array.from(shared.jobs.values()).find((job) => job.state === "FAILED");
    const ready = Array.from(shared.jobs.values()).find((job) => job.state === "READY");
    expect(failed.bytes).toBe(0);
    expect(ready.bytes).toBeGreaterThan(0);
    expect(ready.bytes).toBeLessThan(maxArtifactBytes);
  });

  it("rejects a new per-tenant reservation while that tenant's ready artifact owns quota", async () => {
    const maxArtifactBytes = 16 * 1024;
    const shared = createSharedDatabase();
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      maxArtifactBytes,
      globalQuotaBytes: maxArtifactBytes * 4,
      perTenantQuotaBytes: maxArtifactBytes,
      minStartIntervalMs: 0,
      startWorker: false,
    });
    const actor = {
      tenantId: "tenant-1", userId: "user-1", ipAddress: null, userAgent: "vitest",
    };
    const firstJob = await service.start(actor);
    await service.runWorkerOnce();
    expect(shared.jobs.get(firstJob.id).state).toBe("READY");

    const secondJob = await service.start(actor);
    await service.runWorkerOnce();

    expect(shared.jobs.get(secondJob.id).state).toBe("FAILED");
    expect(shared.jobs.get(secondJob.id).bytes).toBe(0);
  });

  it("retains cleanup ownership and quota after deletion failure until a durable retry", async () => {
    const maxArtifactBytes = 16 * 1024;
    const shared = createSharedDatabase();
    let failDeletion = false;
    const deleteArtifact = vi.fn(async (path: string) => {
      if (failDeletion) throw new Error("private filesystem mount failure");
      await rm(path, { force: true });
    });
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      maxArtifactBytes,
      globalQuotaBytes: maxArtifactBytes,
      perTenantQuotaBytes: maxArtifactBytes,
      minStartIntervalMs: 0,
      deleteArtifact,
      startWorker: false,
    });
    const first = await service.start({
      tenantId: "tenant-1", userId: "user-1", ipAddress: null, userAgent: "vitest",
    });
    await service.runWorkerOnce();
    const firstJob = shared.jobs.get(first.id);
    expect(firstJob.state).toBe("READY");
    const ownedBytes = firstJob.bytes;
    const artifactPath = join(directory, firstJob.artifactKey);
    firstJob.expiresAt = new Date(0);
    failDeletion = true;

    await expect(service.cleanupExpired()).rejects.toThrow(/cleanup remains pending/i);
    expect(firstJob).toMatchObject({
      state: "EXPIRED",
      artifactCleanupState: "PENDING",
      artifactCleanupOwner: null,
      bytes: ownedBytes,
    });
    await expect(stat(artifactPath)).resolves.toBeTruthy();

    const second = await service.start({
      tenantId: "tenant-2", userId: "user-2", ipAddress: null, userAgent: "vitest",
    });
    await service.runWorkerOnce();
    expect(shared.jobs.get(second.id)).toMatchObject({ state: "FAILED", bytes: 0 });

    failDeletion = false;
    await expect(service.cleanupExpired()).resolves.toBe(1);
    expect(firstJob).toMatchObject({
      artifactCleanupState: "COMPLETE",
      artifactKey: null,
      bytes: 0,
      claimToken: null,
    });
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

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
    shared.jobs.get(queued.id).bytes = 256;
    await expect(service.cleanupExpired()).resolves.toBe(1);
    expect(shared.jobs.get(queued.id).state).toBe("EXPIRED");
    expect(shared.jobs.get(queued.id).bytes).toBe(0);
  });

  it("stops scheduled maintenance when its Nest lifecycle owner closes", async () => {
    const shared = createSharedDatabase();
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      pollIntervalMs: 10,
      startWorker: true,
    });
    const maintenance = vi.spyOn(service as any, "maintenance");

    try {
      await vi.waitFor(() => expect(maintenance).toHaveBeenCalled());
      service.onModuleDestroy();
      const callsAtShutdown = maintenance.mock.calls.length;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      expect(maintenance).toHaveBeenCalledTimes(callsAtShutdown);
    } finally {
      service.onModuleDestroy();
    }
  });

  it("preserves active artifacts and partials while deleting stale unowned partials", async () => {
    const shared = createSharedDatabase();
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      leaseMs: 1,
      expiresMs: 1,
      startWorker: false,
    });
    const jobId = "00000000-0000-4000-8000-000000000001";
    const claimToken = "00000000-0000-4000-8000-000000000002";
    const activeKey = `${jobId}-${claimToken}.ndjson`;
    const activePartial = `${activeKey}.${claimToken}.part`;
    const orphan = "00000000-0000-4000-8000-000000000003-00000000-0000-4000-8000-000000000004.ndjson.00000000-0000-4000-8000-000000000004.part";
    shared.jobs.set(jobId, {
      id: jobId,
      state: "RUNNING",
      artifactKey: null,
      claimToken,
      bytes: 100,
      artifactCleanupState: "NONE",
      artifactCleanupOwner: null,
      artifactCleanupLeaseExpiresAt: null,
      artifactCleanupAttempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    });
    for (const entry of [activeKey, activePartial, orphan]) {
      const path = join(directory, entry);
      await writeFile(path, "proof");
      await utimes(path, new Date(0), new Date(0));
    }

    await expect(service.cleanupExpired()).resolves.toBe(0);

    expect((await readdir(directory)).sort()).toEqual([activeKey, activePartial].sort());
  });

  it("enforces expiry synchronously and redacts internal worker failures", async () => {
    const shared = createSharedDatabase();
    const service = new TenantExportService(shared.db, undefined, {
      artifactDirectory: directory,
      minStartIntervalMs: 0,
      startWorker: false,
    });
    const actor = {
      tenantId: "tenant-1",
      userId: "user-1",
      ipAddress: "203.0.113.10",
      userAgent: "vitest",
    };
    const queued = await service.start(actor);
    Object.assign(shared.jobs.get(queued.id), {
      state: "READY",
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
      artifactKey: "00000000-0000-4000-8000-000000000000-00000000-0000-4000-8000-000000000001.ndjson",
      error: "database host db.internal.example leaked a filesystem path",
    });

    await expect(service.status(actor, queued.id)).resolves.toMatchObject({
      state: "expired",
      downloadPath: null,
      error: undefined,
    });
    await expect(service.openDownload(actor, queued.id)).rejects.toThrow(
      /expired/i,
    );

    Object.assign(shared.jobs.get(queued.id), {
      state: "FAILED",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const failed = await service.status(actor, queued.id);
    expect(failed).toMatchObject({
      state: "failed",
      error:
        "Account export could not be generated. Please retry or contact support.",
      downloadPath: null,
    });
    expect(failed.error).not.toContain("db.internal.example");
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
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
        "platform admin claim unavailable",
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
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
        "lease renewal unavailable",
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

if (postgresIntegrationUrl && postgresOwnerUrl && postgresIntegrationCapability) {
  describe("TenantExportService Postgres quota reservations", () => {
    it("serializes concurrent global reservations and releases job bytes on failure and expiry", async () => {
      const directory = await mkdtemp(join(tmpdir(), "lunchlineup-export-postgres-"));
      const prisma = new PrismaClient({
        datasources: { db: { url: postgresIntegrationUrl } },
      });
      const owner = new PrismaClient({
        datasources: { db: { url: postgresOwnerUrl } },
      });
      const suffix = randomUUID();
      const firstTenantId = `tenant-export-quota-a-${suffix}`;
      const secondTenantId = `tenant-export-quota-b-${suffix}`;
      const firstJobId = randomUUID();
      const secondJobId = randomUUID();
      const maxArtifactBytes = 1024;
      const options = {
        artifactDirectory: directory,
        maxArtifactBytes,
        globalQuotaBytes: maxArtifactBytes,
        perTenantQuotaBytes: maxArtifactBytes,
        startWorker: false,
      };

      try {
        await owner.$executeRaw`
          INSERT INTO "Tenant" ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
          VALUES
            (${firstTenantId}, 'Quota Tenant A', ${`quota-a-${suffix}`}, 'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (${secondTenantId}, 'Quota Tenant B', ${`quota-b-${suffix}`}, 'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        await owner.$executeRaw`
          INSERT INTO "TenantExportJob"
            ("id", "tenantId", "requestedByUserId", "tenantSlug", "state", "watermark", "expiresAt",
             "createdAt", "updatedAt")
          VALUES
            (${firstJobId}, ${firstTenantId}, 'quota-user-a', ${`quota-a-${suffix}`}, 'QUEUED', CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP - INTERVAL '1 second', CURRENT_TIMESTAMP),
            (${secondJobId}, ${secondTenantId}, 'quota-user-b', ${`quota-b-${suffix}`}, 'QUEUED', CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        const tenantDb = {
          withPlatformAdmin: (operation: (tx: any) => Promise<unknown>, transactionOptions?: any) =>
            prisma.$transaction(async (tx) => {
              await tx.$executeRaw`
                SELECT set_current_platform_admin(true, ${postgresIntegrationCapability})
              `;
              return operation(tx);
            }, transactionOptions),
        } as TenantPrismaService;
        const first = new TenantExportService(tenantDb, undefined, options);
        const second = new TenantExportService(tenantDb, undefined, options);

        const claims = await Promise.all([
          (first as any).claimJob(),
          (second as any).claimJob(),
        ]);
        expect(claims.map((job: any) => job.state).sort()).toEqual(["FAILED", "RUNNING"]);
        const running = claims.find((job: any) => job.state === "RUNNING");
        await expect(owner.$queryRaw`
          SELECT "id", "state", "bytes"
          FROM "TenantExportJob"
          WHERE "id" IN (${firstJobId}, ${secondJobId})
          ORDER BY "state", "id"
        `).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({ state: "FAILED", bytes: 0 }),
          expect.objectContaining({ id: running.id, state: "RUNNING", bytes: maxArtifactBytes }),
        ]));

        await expect((first as any).markClaimedJobForCleanup(
          running.id,
          running.claimToken,
          "Tenant export generation failed.",
        )).resolves.toBe(true);
        await expect((first as any).cleanupArtifactJob(running.id)).resolves.toBe(true);
        await expect(owner.$queryRaw`
          SELECT "bytes" FROM "TenantExportJob" WHERE "id" = ${running.id}
        `).resolves.toEqual([{ bytes: 0 }]);

        const failed = claims.find((job: any) => job.state === "FAILED");
        await owner.tenantExportJob.update({
          where: { id: failed.id },
          data: { state: "QUEUED", completedAt: null, error: null },
        });
        const reclaimed = await (second as any).claimJob();
        expect(reclaimed).toMatchObject({
          id: failed.id,
          state: "RUNNING",
          bytes: maxArtifactBytes,
        });
        await owner.tenantExportJob.update({
          where: { id: failed.id },
          data: { expiresAt: new Date(0) },
        });
        await expect(second.cleanupExpired()).resolves.toBeGreaterThanOrEqual(1);
        await expect(owner.$queryRaw`
          SELECT "state", "bytes" FROM "TenantExportJob" WHERE "id" = ${failed.id}
        `).resolves.toEqual([{ state: "EXPIRED", bytes: 0 }]);
      } finally {
        await owner.$executeRaw`
          DELETE FROM "Tenant" WHERE "id" IN (${firstTenantId}, ${secondTenantId})
        `.catch(() => undefined);
        await prisma.$disconnect();
        await owner.$disconnect();
        await rm(directory, { recursive: true, force: true });
      }
    }, 20_000);

    it("fences a blocked restricted writer and retains failed-deletion quota against a new claim", async () => {
      const directory = await mkdtemp(join(tmpdir(), "lunchlineup-export-cleanup-postgres-"));
      const restricted = new PrismaClient({
        datasources: { db: { url: postgresIntegrationUrl } },
      });
      const owner = new PrismaClient({
        datasources: { db: { url: postgresOwnerUrl } },
      });
      const suffix = randomUUID();
      const firstTenantId = `tenant-export-cleanup-a-${suffix}`;
      const secondTenantId = `tenant-export-cleanup-b-${suffix}`;
      const blockedJobId = randomUUID();
      const blockedClaimToken = randomUUID();
      const failedDeleteJobId = randomUUID();
      const failedDeleteToken = randomUUID();
      const newJobId = randomUUID();
      const maxArtifactBytes = 128;
      const failedDeleteKey = `${failedDeleteJobId}-${failedDeleteToken}.ndjson`;
      let failDeletion = true;
      let releaseWriter!: () => void;
      const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
      let signalWriter!: () => void;
      const writerLocked = new Promise<void>((resolve) => { signalWriter = resolve; });
      const tenantDb = {
        withPlatformAdmin: (operation: (tx: any) => Promise<unknown>, transactionOptions?: any) =>
          restricted.$transaction(async (tx) => {
            await tx.$executeRaw`
              SELECT set_current_platform_admin(true, ${postgresIntegrationCapability})
            `;
            return operation(tx);
          }, transactionOptions),
      } as TenantPrismaService;
      const service = new TenantExportService(tenantDb, undefined, {
        artifactDirectory: directory,
        maxArtifactBytes,
        globalQuotaBytes: maxArtifactBytes,
        perTenantQuotaBytes: maxArtifactBytes,
        deleteArtifact: async (path) => {
          if (failDeletion && path.endsWith(failedDeleteKey)) {
            throw new Error("private shared-volume delete failure");
          }
          await rm(path, { force: true });
        },
        startWorker: false,
      });

      try {
        await owner.$executeRaw`
          INSERT INTO "Tenant" ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
          VALUES
            (${firstTenantId}, 'Cleanup Tenant A', ${`cleanup-a-${suffix}`}, 'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (${secondTenantId}, 'Cleanup Tenant B', ${`cleanup-b-${suffix}`}, 'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        await owner.$executeRaw`
          INSERT INTO "TenantExportJob"
            ("id", "tenantId", "requestedByUserId", "tenantSlug", "state", "watermark", "expiresAt",
             "bytes", "claimToken", "claimExpiresAt", "attempts", "createdAt", "updatedAt")
          VALUES
            (${blockedJobId}, ${firstTenantId}, 'cleanup-user-a', ${`cleanup-a-${suffix}`}, 'RUNNING',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second', ${maxArtifactBytes},
             ${blockedClaimToken}, CURRENT_TIMESTAMP - INTERVAL '1 second', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        const blockedWriter = restricted.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_current_tenant(${firstTenantId})`;
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${blockedJobId}, 2026071601))
          `;
          signalWriter();
          await writerRelease;
        }, { maxWait: 2_000, timeout: 5_000 });
        await writerLocked;

        await expect(service.cleanupExpired()).resolves.toBe(0);
        await expect(owner.$queryRaw`
          SELECT "state", "bytes", "artifactCleanupState"
          FROM "TenantExportJob" WHERE "id" = ${blockedJobId}
        `).resolves.toEqual([{
          state: "RUNNING",
          bytes: maxArtifactBytes,
          artifactCleanupState: "NONE",
        }]);
        releaseWriter();
        await blockedWriter;
        await expect(service.cleanupExpired()).resolves.toBe(1);

        await writeFile(join(directory, failedDeleteKey), Buffer.alloc(maxArtifactBytes, 65));
        await owner.$executeRaw`
          INSERT INTO "TenantExportJob"
            ("id", "tenantId", "requestedByUserId", "tenantSlug", "state", "watermark", "expiresAt",
             "artifactKey", "bytes", "completedAt", "createdAt", "updatedAt")
          VALUES
            (${failedDeleteJobId}, ${firstTenantId}, 'cleanup-user-a', ${`cleanup-a-${suffix}`}, 'READY',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 second', ${failedDeleteKey},
             ${maxArtifactBytes}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (${newJobId}, ${secondTenantId}, 'cleanup-user-b', ${`cleanup-b-${suffix}`}, 'QUEUED',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 hour', NULL,
             0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        await expect(service.cleanupExpired()).rejects.toThrow(/cleanup remains pending/i);
        await expect(owner.$queryRaw`
          SELECT "state", "bytes", "artifactCleanupState", "artifactCleanupOwner"
          FROM "TenantExportJob" WHERE "id" = ${failedDeleteJobId}
        `).resolves.toEqual([{
          state: "EXPIRED",
          bytes: maxArtifactBytes,
          artifactCleanupState: "PENDING",
          artifactCleanupOwner: null,
        }]);
        await expect(owner.$executeRaw`
          DELETE FROM "TenantExportJob" WHERE "id" = ${failedDeleteJobId}
        `).rejects.toThrow(/cleanup is not complete/i);
        await expect((service as any).claimJob()).resolves.toMatchObject({
          id: newJobId,
          state: "FAILED",
          bytes: 0,
        });

        failDeletion = false;
        await expect(service.cleanupExpired()).resolves.toBe(1);
        await expect(owner.$queryRaw`
          SELECT "bytes", "artifactKey", "artifactCleanupState"
          FROM "TenantExportJob" WHERE "id" = ${failedDeleteJobId}
        `).resolves.toEqual([{
          bytes: 0,
          artifactKey: null,
          artifactCleanupState: "COMPLETE",
        }]);
      } finally {
        failDeletion = false;
        releaseWriter?.();
        await service.cleanupExpired().catch(() => undefined);
        await owner.$executeRaw`
          DELETE FROM "Tenant" WHERE "id" IN (${firstTenantId}, ${secondTenantId})
        `.catch(() => undefined);
        await restricted.$disconnect();
        await owner.$disconnect();
        await rm(directory, { recursive: true, force: true });
      }
    }, 20_000);
  });
}

describe("time-card correction export contract", () => {
  it("uses a customer-safe audit allowlist without platform operator telemetry", () => {
    const audit = TENANT_EXPORT_COLLECTIONS.find(
      (candidate) => candidate.model === "AuditLog",
    )!;

    expect(audit.select).toEqual({
      id: true,
      userId: true,
      action: true,
      resource: true,
      resourceId: true,
      createdAt: true,
    });
    for (const field of [
      "actorUserId",
      "actorTenantId",
      "ipAddress",
      "userAgent",
      "oldValue",
      "newValue",
    ]) {
      expect(audit.select).not.toHaveProperty(field);
    }
  });

  it("exports payroll linkage and revision while excluding clock request identity", () => {
    const collection = TENANT_EXPORT_COLLECTIONS.find(
      (candidate) => candidate.model === "TimeCard",
    )!;

    expect(collection.select).toMatchObject({
      payrollPeriodId: true,
      workTimeZone: true,
      revision: true,
    });
    expect(collection.select).not.toHaveProperty("clockInOperationId");
    expect(collection.select).not.toHaveProperty("clockInRequestHash");
  });

  it("exports tenant-owned break intervals without internal relation data", () => {
    const collection = TENANT_EXPORT_COLLECTIONS.find(
      (candidate) => candidate.model === "TimeCardBreak",
    )!;

    expect(collection.name).toBe("timeCardBreaks");
    expect(collection.delegate).toBe("timeCardBreak");
    expect(collection.where("tenant-1")).toEqual({ tenantId: "tenant-1" });
    expect(collection.select).toEqual({
      id: true,
      timeCardId: true,
      startAt: true,
      endAt: true,
      createdAt: true,
      updatedAt: true,
    });
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

  it("exports every payroll model with tenant-scoped delegates and stable cursors", () => {
    const expected = {
      PayrollPolicyVersion: ["payrollPolicyVersions", "payrollPolicyVersion"],
      PayrollPeriod: ["payrollPeriods", "payrollPeriod"],
      PayrollTimeCardApproval: ["payrollTimeCardApprovals", "payrollTimeCardApproval"],
      PayrollLockedEntry: ["payrollLockedEntries", "payrollLockedEntry"],
      PayrollAmendment: ["payrollAmendments", "payrollAmendment"],
      PayrollAmendmentDecision: ["payrollAmendmentDecisions", "payrollAmendmentDecision"],
      PayrollOperation: ["payrollOperations", "payrollOperation"],
      PayrollExportBatch: ["payrollExportBatches", "payrollExportBatch"],
      PayrollExportLine: ["payrollExportLines", "payrollExportLine"],
      PayrollReconciliationReceipt: ["payrollReconciliationReceipts", "payrollReconciliationReceipt"],
      PayrollReconciliationLineEvent: ["payrollReconciliationLineEvents", "payrollReconciliationLineEvent"],
      PayrollReconciliationLineState: ["payrollReconciliationLineStates", "payrollReconciliationLineState"],
    } as const;

    for (const [model, [name, delegate]] of Object.entries(expected)) {
      const collection = TENANT_EXPORT_COLLECTIONS.find((candidate) => candidate.model === model)!;
      expect(collection).toBeDefined();
      expect(collection.name).toBe(name);
      expect(collection.delegate).toBe(delegate);
      expect(collection.where("tenant-1")).toEqual({ tenantId: "tenant-1" });
      expect(collection.orderBy?.at(-1)).toEqual(
        model === "PayrollOperation" ? { operationId: "asc" } : { id: "asc" },
      );
    }
  });

  it("keeps payroll audit evidence while excluding request hashes and idempotency payloads", () => {
    const payrollCollections = TENANT_EXPORT_COLLECTIONS.filter(({ model }) => model.startsWith("Payroll"));
    for (const collection of payrollCollections) {
      expect(collection.select).not.toHaveProperty("requestHash");
      expect(collection.select).not.toHaveProperty("response");
      if (collection.model !== "PayrollOperation") {
        expect(collection.select).not.toHaveProperty("operationId");
      }
    }

    const operation = payrollCollections.find(({ model }) => model === "PayrollOperation")!;
    expect(operation.cursor?.({ operationId: "internal-operation-id" })).toEqual({
      operationId: "internal-operation-id",
    });
    expect(operation.serialize?.({
      operationId: "internal-operation-id",
      periodId: "period-1",
      kind: "LOCK_PERIOD",
      requestHash: "internal-request-hash",
      response: { internal: true },
      createdAt: new Date("2026-07-16T12:00:00.000Z"),
    })).toEqual({
      periodId: "period-1",
      kind: "LOCK_PERIOD",
      createdAt: new Date("2026-07-16T12:00:00.000Z"),
    });

    expect(payrollCollections.find(({ model }) => model === "PayrollPeriod")?.select).toMatchObject({
      status: true,
      lockedAt: true,
      lockedByUserId: true,
      lockedEntrySha256: true,
      lockedEntryCount: true,
      totalPayableMinutes: true,
    });
    expect(payrollCollections.find(({ model }) => model === "PayrollReconciliationReceipt")?.select)
      .toMatchObject({
        provider: true,
        providerEventId: true,
        payloadSha256: true,
        receivedByUserId: true,
        receivedAt: true,
      });
  });

  it("keeps privacy and lifecycle fields in explicit export projections", () => {
    const settings = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "TenantSetting",
    )!;
    const user = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "User",
    )!;
    const schedule = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "Schedule",
    )!;
    const solveJob = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "ScheduleSolveJob",
    )!;
    const changeSet = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "ScheduleChangeSet",
    )!;

    expect(user.select).toMatchObject({
      oidcIssuer: true,
      oidcSubject: true,
      emailDeliverySuppressedAt: true,
      emailDeliverySuppressionReason: true,
      emailDeliveryLastEventAt: true,
    });
    expect(schedule.select).toMatchObject({
      revision: true,
      deletedAt: true,
    });
    expect(changeSet.select).toEqual({
      id: true,
      scheduleId: true,
      actorUserId: true,
      baseRevision: true,
      resultRevision: true,
      createdAt: true,
    });
    expect(changeSet.select).not.toHaveProperty("idempotencyKeyHash");
    expect(changeSet.select).not.toHaveProperty("requestHash");
    expect(changeSet.select).not.toHaveProperty("request");
    expect(changeSet.select).not.toHaveProperty("response");
    expect(solveJob.select).toMatchObject({
      requestedConstraints: true,
      staffSnapshot: true,
      demandSnapshot: true,
    });
    expect(settings.where("tenant-1")).toEqual({
      tenantId: "tenant-1",
      key: { not: { startsWith: "internal:tenant-lifecycle-intent:" } },
    });
    for (const internal of [
      "queuePayload",
      "publishLeaseUntil",
      "publishLastError",
      "executionToken",
      "executionLeaseUntil",
    ]) {
      expect(solveJob.select).not.toHaveProperty(internal);
    }
  });

  it("omits internal provider diagnostics and delivery leases from customer exports", () => {
    const stripeUsage = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "StripeUsageEvent",
    )!;
    const notificationOutbox = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "NotificationOutbox",
    )!;
    const staffInvitationOutbox = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "StaffInvitationOutbox",
    )!;
    const deletionBilling = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "TenantDeletionBillingReconciliation",
    )!;

    expect(stripeUsage.select).not.toHaveProperty("idempotencyKey");
    expect(stripeUsage.select).not.toHaveProperty("lastError");
    expect(stripeUsage.select).not.toHaveProperty("metadata");
    expect(notificationOutbox.select).not.toHaveProperty("leaseUntil");
    expect(notificationOutbox.select).not.toHaveProperty("lastError");
    expect(deletionBilling.select).toEqual({
      tenantId: true,
      barrierCreatedAt: true,
      state: true,
      attemptCount: true,
      finalizedAt: true,
      createdAt: true,
      updatedAt: true,
    });
    expect(deletionBilling.where("tenant-1")).toEqual({ tenantId: "tenant-1" });
    expect(deletionBilling.cursor?.({ tenantId: "tenant-1" })).toEqual({ tenantId: "tenant-1" });
    for (const internal of [
      "operationId",
      "nextAttemptAt",
      "lastAttemptAt",
      "lastFailureAt",
      "lastErrorCode",
      "leaseOwner",
      "leaseToken",
      "leaseExpiresAt",
    ]) {
      expect(deletionBilling.select).not.toHaveProperty(internal);
    }
    expect(staffInvitationOutbox.name).toBe("staffInvitationDeliveries");
    expect(staffInvitationOutbox.select).toMatchObject({
      userId: true,
      purpose: true,
      status: true,
      attempts: true,
      deliveredAt: true,
      cancelledAt: true,
    });
    for (const internal of [
      "recipientHash",
      "encryptedPayload",
      "encryptionNonce",
      "encryptionTag",
      "encryptionKeyRef",
      "leaseOwner",
      "leaseExpiresAt",
      "providerMessageId",
      "lastErrorCode",
    ]) {
      expect(staffInvitationOutbox.select).not.toHaveProperty(internal);
    }
  });

  it("exports normalized availability-import data without source or ownership secrets", () => {
    const availabilityImport = TENANT_EXPORT_COLLECTIONS.find(
      (collection) => collection.model === "AvailabilityImportJob",
    )!;

    expect(availabilityImport.name).toBe("availabilityImports");
    expect(availabilityImport.delegate).toBe("availabilityImportJob");
    expect(availabilityImport.where("tenant-1")).toEqual({ tenantId: "tenant-1" });
    expect(availabilityImport.select).toMatchObject({
      id: true,
      userId: true,
      requestedByUserId: true,
      status: true,
      publicationStatus: true,
      parsedAvailability: true,
      failureCode: true,
      creditConsumption: true,
      attempts: true,
      publishAttempts: true,
      expiresAt: true,
    });
    for (const internal of [
      "requestKeyHash",
      "requestHash",
      "storageKey",
      "fileSha256",
      "publishToken",
      "publishLeaseUntil",
      "publicationAmbiguous",
      "publishLastError",
      "executionToken",
      "executionLeaseUntil",
    ]) {
      expect(availabilityImport.select).not.toHaveProperty(internal);
    }
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
