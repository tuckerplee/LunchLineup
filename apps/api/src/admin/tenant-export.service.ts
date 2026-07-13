import {
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { MetricsService } from "../common/metrics.service";
import {
  TenantPrismaService,
  type TenantPrismaTransaction,
} from "../database/tenant-prisma.service";
import { serializeBillingEventForExport } from "./tenant-account-lifecycle";
import type { TenantLifecycleActor } from "./tenant-account-lifecycle.service";

type ExportJobState = "QUEUED" | "RUNNING" | "READY" | "FAILED" | "EXPIRED";

type ExportJob = {
  id: string;
  tenantId: string;
  requestedByUserId: string;
  tenantSlug: string;
  state: ExportJobState;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  watermark: Date;
  artifactKey: string | null;
  bytes: number;
  rowCounts: unknown;
  progressCollection: string | null;
  progressRows: number;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  attempts: number;
  error: string | null;
  completedAt: Date | null;
};

type ExportCollection = {
  model: string;
  name: string;
  delegate: string;
  where: (tenantId: string) => Record<string, unknown>;
  select: Record<string, unknown>;
  serialize?: (row: any) => unknown;
  orderBy?: Record<string, "asc">[];
  cursor?: (row: any) => Record<string, unknown>;
};

export type TenantExportServiceOptions = {
  artifactDirectory?: string;
  sharedArtifactStorage?: boolean;
  production?: boolean;
  replicaCount?: number;
  pageRows?: number;
  maxPageBytes?: number;
  expiresMs?: number;
  transactionTimeoutMs?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  minStartIntervalMs?: number;
  startWorker?: boolean;
};

const OMITTED_FIELDS = [
  "passwordHash",
  "pinHash",
  "mfaSecret",
  "mfaBackupCodes",
  "refreshToken",
  "sessionIds",
  "lunchBreakGenerationRequest.claimToken",
  "webhookEndpoint.secret",
  "webhookDelivery.encryptedUrl",
  "webhookDelivery.encryptedPayload",
  "webhookDelivery.encryptionKeyRef",
  "encryptedPiiCiphertexts",
  "billingEvent.rawStripePayload",
  "auditLog.oldValue",
  "auditLog.newValue",
] as const;

export const TENANT_EXPORT_COLLECTIONS: readonly ExportCollection[] = [
  {
    model: "TenantSetting",
    name: "settings",
    delegate: "tenantSetting",
    where: (tenantId) => ({ tenantId }),
    select: { id: true, key: true, value: true, updatedAt: true },
  },
  {
    model: "Location",
    name: "locations",
    delegate: "location",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      name: true,
      address: true,
      timezone: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
    },
  },
  {
    model: "User",
    name: "users",
    delegate: "user",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      name: true,
      email: true,
      username: true,
      phone: true,
      role: true,
      mfaEnabled: true,
      pinSetAt: true,
      pinResetRequired: true,
      lastLoginAt: true,
      lockedUntil: true,
      pinLockedUntil: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
    },
  },
  {
    model: "Role",
    name: "roles",
    delegate: "role",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      name: true,
      slug: true,
      legacyRole: true,
      isSystem: true,
      isDefault: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "RoleAssignment",
    name: "roleAssignments",
    delegate: "roleAssignment",
    where: (tenantId) => ({ tenantId }),
    select: { userId: true, roleId: true, createdAt: true },
    orderBy: [{ userId: "asc" }, { roleId: "asc" }],
    cursor: (row) => ({
      userId_roleId: { userId: row.userId, roleId: row.roleId },
    }),
  },
  {
    model: "RolePermission",
    name: "rolePermissions",
    delegate: "rolePermission",
    where: (tenantId) => ({ role: { tenantId } }),
    select: { roleId: true, permissionId: true, createdAt: true },
    orderBy: [{ roleId: "asc" }, { permissionId: "asc" }],
    cursor: (row) => ({
      roleId_permissionId: {
        roleId: row.roleId,
        permissionId: row.permissionId,
      },
    }),
  },
  {
    model: "StaffAvailability",
    name: "staffAvailabilities",
    delegate: "staffAvailability",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      locationId: true,
      dayOfWeek: true,
      startTimeMinutes: true,
      endTimeMinutes: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "StaffSkill",
    name: "staffSkills",
    delegate: "staffSkill",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      skill: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "Schedule",
    name: "schedules",
    delegate: "schedule",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      locationId: true,
      startDate: true,
      endDate: true,
      status: true,
      publishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "ScheduleDemandWindow",
    name: "scheduleDemandWindows",
    delegate: "scheduleDemandWindow",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      scheduleId: true,
      locationId: true,
      startTime: true,
      endTime: true,
      requiredStaff: true,
      skill: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "Shift",
    name: "shifts",
    delegate: "shift",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      locationId: true,
      scheduleId: true,
      userId: true,
      startTime: true,
      endTime: true,
      role: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
    },
  },
  {
    model: "Break",
    name: "breaks",
    delegate: "break",
    where: (tenantId) => ({ shift: { tenantId } }),
    select: {
      id: true,
      shiftId: true,
      type: true,
      startTime: true,
      endTime: true,
      paid: true,
      createdAt: true,
    },
  },
  {
    model: "TimeCard",
    name: "timeCards",
    delegate: "timeCard",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      locationId: true,
      shiftId: true,
      clockInAt: true,
      clockOutAt: true,
      breakMinutes: true,
      notes: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
    },
  },
  {
    model: "ScheduleSolveJob",
    name: "scheduleSolveJobs",
    delegate: "scheduleSolveJob",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      scheduleId: true,
      locationId: true,
      status: true,
      statusReason: true,
      retryCount: true,
      resultShiftCount: true,
      requestedConstraints: true,
      creditConsumption: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "LunchBreakGenerationRequest",
    name: "lunchBreakGenerationRequests",
    delegate: "lunchBreakGenerationRequest",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      status: true,
      attempts: true,
      creditConsumption: true,
      response: true,
      failureStatus: true,
      creditTransactionId: true,
      calculationSnapshot: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "BillingEvent",
    name: "billingEvents",
    delegate: "billingEvent",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      type: true,
      stripeEventId: true,
      amount: true,
      currency: true,
      metadata: true,
      createdAt: true,
    },
    serialize: serializeBillingEventForExport,
  },
  {
    model: "StripeUsageEvent",
    name: "stripeUsageEvents",
    delegate: "stripeUsageEvent",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      metric: true,
      periodStart: true,
      periodEnd: true,
      quantity: true,
      eventName: true,
      identifier: true,
      status: true,
      attempts: true,
      sentAt: true,
      stripeObjectId: true,
      stripeRequestId: true,
      lastError: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "CreditTransaction",
    name: "creditTransactions",
    delegate: "creditTransaction",
    where: (tenantId) => ({ tenantId }),
    select: { id: true, amount: true, reason: true, createdAt: true },
  },
  {
    model: "WebhookEndpoint",
    name: "webhookEndpoints",
    delegate: "webhookEndpoint",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      url: true,
      events: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "WebhookDelivery",
    name: "webhookDeliveries",
    delegate: "webhookDelivery",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      endpointId: true,
      status: true,
      eventType: true,
      endpointRef: true,
      payloadDigest: true,
      payloadBytes: true,
      attempts: true,
      nextAttemptAt: true,
      queuedAt: true,
      deliveredAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "Notification",
    name: "notifications",
    delegate: "notification",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      type: true,
      title: true,
      body: true,
      readAt: true,
      createdAt: true,
    },
  },
  {
    model: "AuditLog",
    name: "auditLogs",
    delegate: "auditLog",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      action: true,
      resource: true,
      resourceId: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
    },
  },
];

export const TENANT_EXPORT_EXCLUDED_MODELS = {
  MfaTotpClaim: "Authentication replay-prevention claims are never exported.",
  OnboardingSignupAttempt:
    "Authentication signup recovery and idempotency records are never exported.",
  PasswordResetToken: "Authentication reset secrets are never exported.",
  PasswordResetEmailOutbox:
    "Encrypted password-reset delivery payloads are never exported.",
  Session: "Authentication sessions are never exported.",
  TenantExportJob:
    "Internal export queue and artifact metadata are not tenant business data.",
} as const;

export class TenantExportService {
  private readonly logger = new Logger(TenantExportService.name);
  private readonly options: Required<TenantExportServiceOptions>;
  private readonly timer?: NodeJS.Timeout;
  private workerActive = false;
  private lastExpirySweep = 0;

  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly metrics?: Pick<MetricsService, "tenantExportsTotal">,
    options: TenantExportServiceOptions = {},
  ) {
    const configuredDirectory =
      options.artifactDirectory ?? process.env.TENANT_EXPORT_ARTIFACT_DIRECTORY;
    this.options = {
      artifactDirectory:
        configuredDirectory ?? join(tmpdir(), "lunchlineup-tenant-exports"),
      sharedArtifactStorage:
        options.sharedArtifactStorage ??
        process.env.TENANT_EXPORT_SHARED_STORAGE === "true",
      production: options.production ?? process.env.NODE_ENV === "production",
      replicaCount:
        options.replicaCount ??
        Number.parseInt(process.env.API_REPLICA_COUNT ?? "1", 10),
      pageRows: options.pageRows ?? 100,
      maxPageBytes: options.maxPageBytes ?? 4 * 1024 * 1024,
      expiresMs: options.expiresMs ?? 15 * 60 * 1000,
      transactionTimeoutMs: options.transactionTimeoutMs ?? 10 * 60 * 1000,
      leaseMs: options.leaseMs ?? 15 * 60 * 1000,
      pollIntervalMs: options.pollIntervalMs ?? 5_000,
      minStartIntervalMs: options.minStartIntervalMs ?? 60 * 1000,
      startWorker: options.startWorker ?? true,
    };
    this.assertStorageContract(Boolean(configuredDirectory));
    if (this.options.startWorker) {
      this.timer = setInterval(
        () => void this.maintenance(),
        this.options.pollIntervalMs,
      );
      this.timer.unref();
    }
  }

  async start(actor: TenantLifecycleActor) {
    const requestedByUserId = this.requireUserId(actor.userId);
    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.options.expiresMs);
    try {
      const job = await this.tenantDb.withTenant(
        actor.tenantId,
        async (tx) => {
          const delegate = (tx as any).tenantExportJob;
          const recent = await delegate.findFirst({
            where: {
              tenantId: actor.tenantId,
              createdAt: {
                gt: new Date(
                  createdAt.getTime() - this.options.minStartIntervalMs,
                ),
              },
            },
            select: { id: true },
          });
          if (recent)
            throw new HttpException(
              "Tenant exports may be started once per minute.",
              HttpStatus.TOO_MANY_REQUESTS,
            );
          const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: actor.tenantId },
            select: { id: true, slug: true },
          });
          await tx.auditLog.create({
            data: {
              tenantId: actor.tenantId,
              userId: requestedByUserId,
              action: "TENANT_EXPORT_REQUESTED",
              resource: "Tenant",
              resourceId: actor.tenantId,
              ipAddress: actor.ipAddress,
              userAgent: actor.userAgent,
            },
          });
          return delegate.create({
            data: {
              id,
              tenantId: actor.tenantId,
              requestedByUserId,
              tenantSlug: tenant.slug,
              state: "QUEUED",
              watermark: createdAt,
              expiresAt,
              artifactKey: null,
            },
          });
        },
        { maxWait: 2_000, timeout: 5_000 },
      );
      if (this.options.startWorker) this.kickQueueDrain();
      return this.serialize(job);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          "A tenant export is already being generated.",
        );
      }
      throw error;
    }
  }

  async listRecent(
    actor: Pick<TenantLifecycleActor, "tenantId" | "userId">,
  ) {
    const requestedByUserId = this.requireUserId(actor.userId);
    const jobs = await this.tenantDb.withTenant(actor.tenantId, async (tx) =>
      (tx as any).tenantExportJob.findMany({
        where: {
          tenantId: actor.tenantId,
          requestedByUserId,
          expiresAt: { gt: new Date() },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5,
      }),
    );
    return { jobs: jobs.map((job: ExportJob) => this.serialize(job)) };
  }

  async status(
    actor: Pick<TenantLifecycleActor, "tenantId" | "userId">,
    jobId: string,
  ) {
    return this.serialize(await this.authorizedJob(actor, jobId));
  }

  async openDownload(
    actor: Pick<TenantLifecycleActor, "tenantId" | "userId">,
    jobId: string,
  ) {
    const job = await this.authorizedJob(actor, jobId);
    if (job.state !== "READY")
      throw new ConflictException("Tenant export is not ready for download.");
    const path = this.artifactPath(job.artifactKey);
    const file = await stat(path).catch(() => null);
    if (!file?.isFile() || file.size !== job.bytes) {
      throw new ServiceUnavailableException(
        "Tenant export artifact is unavailable.",
      );
    }
    return {
      filename: `${job.tenantSlug}-account-export-${job.watermark.toISOString().slice(0, 10)}.ndjson`,
      bytes: job.bytes,
      stream: createReadStream(path),
    };
  }

  async runWorkerOnce(): Promise<boolean> {
    const job = await this.claimJob();
    if (!job) return false;
    await this.generate(job);
    return true;
  }

  async cleanupExpired(): Promise<number> {
    const expired = await this.tenantDb.withPlatformAdmin(async (tx) =>
      tx.$queryRaw<Array<{ artifactKey: string | null }>>(Prisma.sql`
            UPDATE "TenantExportJob"
            SET "state" = 'EXPIRED', "claimToken" = NULL, "claimExpiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "expiresAt" <= CURRENT_TIMESTAMP AND "state" <> 'EXPIRED'
            RETURNING "artifactKey"
        `),
    );
    await Promise.all(
      expired.map(({ artifactKey }) =>
        artifactKey
          ? rm(this.artifactPath(artifactKey), { force: true })
          : undefined,
      ),
    );
    await this.cleanupOrphanPartials();
    return expired.length;
  }

  private async maintenance(): Promise<void> {
    if (this.workerActive) return;
    this.workerActive = true;
    try {
      if (
        Date.now() - this.lastExpirySweep >=
        Math.min(this.options.expiresMs, 60_000)
      ) {
        await this.cleanupExpired();
        this.lastExpirySweep = Date.now();
      }
      await this.runWorkerOnce();
    } catch (error) {
      this.recordBackgroundFailure("Tenant export maintenance failed", error);
    } finally {
      this.workerActive = false;
    }
  }

  private kickQueueDrain(): void {
    void this.drainQueue().catch((error) => {
      this.recordBackgroundFailure(
        "Tenant export queue drain failed; queued jobs remain available for retry",
        error,
      );
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.workerActive) return;
    this.workerActive = true;
    try {
      while (await this.runWorkerOnce()) {
        // Drain one durable claim at a time per replica.
      }
    } finally {
      this.workerActive = false;
    }
  }

  private async claimJob(): Promise<ExportJob | null> {
    const claimToken = randomUUID();
    const leaseUntil = new Date(Date.now() + this.options.leaseMs);
    const rows = await this.tenantDb.withPlatformAdmin(async (tx) =>
      tx.$queryRaw<ExportJob[]>(Prisma.sql`
            WITH candidate AS (
                SELECT "id"
                FROM "TenantExportJob"
                WHERE "expiresAt" > CURRENT_TIMESTAMP
                  AND ("state" = 'QUEUED' OR ("state" = 'RUNNING' AND "claimExpiresAt" < CURRENT_TIMESTAMP))
                ORDER BY "createdAt" ASC, "id" ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE "TenantExportJob" AS job
            SET "state" = 'RUNNING', "claimToken" = ${claimToken}, "claimExpiresAt" = ${leaseUntil},
                "attempts" = job."attempts" + 1, "error" = NULL, "updatedAt" = CURRENT_TIMESTAMP
            FROM candidate
            WHERE job."id" = candidate."id"
            RETURNING job.*
        `),
    );
    return rows[0] ?? null;
  }

  private async generate(job: ExportJob): Promise<void> {
    const claimToken = job.claimToken!;
    const artifactKey = `${job.id}-${claimToken}.ndjson`;
    const finalPath = this.artifactPath(artifactKey);
    const partialPath = `${finalPath}.${claimToken}.part`;
    let writer: WriteStream | undefined;
    let heartbeatRenewal: Promise<void> | undefined;
    let heartbeatStopped = false;
    let leaseLost = false;
    const renewLeaseInBackground = () => {
      if (heartbeatStopped || heartbeatRenewal) return;
      heartbeatRenewal = this.renewLease(job.id, claimToken)
        .then((renewed) => {
          if (renewed) return;
          leaseLost = true;
          this.recordBackgroundFailure(
            `Tenant export lease was lost for job ${job.id}`,
            new Error("The durable lease no longer belongs to this worker."),
          );
        })
        .catch((error) => {
          this.recordBackgroundFailure(
            `Tenant export lease renewal failed for job ${job.id}; the durable lease remains retryable`,
            error,
          );
        })
        .finally(() => {
          heartbeatRenewal = undefined;
        });
    };
    const heartbeat = setInterval(
      renewLeaseInBackground,
      Math.max(1_000, Math.floor(this.options.leaseMs / 3)),
    );
    heartbeat.unref();
    const stopHeartbeat = async () => {
      heartbeatStopped = true;
      clearInterval(heartbeat);
      await heartbeatRenewal;
    };
    try {
      await mkdir(this.options.artifactDirectory, {
        recursive: true,
        mode: 0o700,
      });
      await chmod(this.options.artifactDirectory, 0o700);
      writer = createWriteStream(partialPath, {
        flags: "wx",
        encoding: "utf8",
        mode: 0o600,
      });
      const rowCounts: Record<string, number> = {};
      await this.tenantDb.withTenant(
        job.tenantId,
        async (tx) => {
          await this.writeLine(writer!, {
            type: "manifest",
            format: "lunchlineup-tenant-export-ndjson",
            version: 2,
            exportedAt: job.watermark.toISOString(),
            snapshot: "repeatable-read",
            omitted: OMITTED_FIELDS,
          });
          const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: job.tenantId },
            select: {
              id: true,
              name: true,
              slug: true,
              planTier: true,
              status: true,
              trialEndsAt: true,
              gracePeriodEndsAt: true,
              usageCredits: true,
              createdAt: true,
              updatedAt: true,
              deletedAt: true,
            },
          });
          await this.writeLine(writer!, { collection: "tenant", data: tenant });
          rowCounts.tenant = 1;
          let progressRows = 1;
          for (const collection of TENANT_EXPORT_COLLECTIONS) {
            rowCounts[collection.name] = await this.writeCollection(
              tx,
              writer!,
              job.tenantId,
              collection,
            );
            progressRows += rowCounts[collection.name];
            await this.updateProgress(
              job.id,
              claimToken,
              collection.name,
              progressRows,
              rowCounts,
            );
          }
          await this.writeLine(writer!, { type: "complete", rowCounts });
        },
        {
          maxWait: 5_000,
          timeout: this.options.transactionTimeoutMs,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      );
      await stopHeartbeat();
      if (leaseLost) throw new Error("Tenant export lease was lost.");
      writer.end();
      await once(writer, "close");
      const file = await stat(partialPath);
      if (!(await this.renewLease(job.id, claimToken)))
        throw new Error("Tenant export lease was lost.");
      await rename(partialPath, finalPath);
      await chmod(finalPath, 0o600);
      const finalized = await this.updateClaimedJob(job.id, claimToken, {
        state: "READY",
        artifactKey,
        bytes: file.size,
        rowCounts,
        progressCollection: null,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: new Date(),
        error: null,
      });
      if (!finalized) {
        await rm(finalPath, { force: true });
        throw new Error("Tenant export lease was lost before finalization.");
      }
      this.metrics?.tenantExportsTotal?.inc({ outcome: "ready" });
    } catch (error) {
      writer?.destroy();
      await rm(partialPath, { force: true }).catch(() => undefined);
      const message =
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : "Unknown export generation failure.";
      await this.updateClaimedJob(job.id, claimToken, {
        state: "FAILED",
        error: message,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: new Date(),
      }).catch(() => undefined);
      this.metrics?.tenantExportsTotal?.inc({ outcome: "failed" });
    } finally {
      await stopHeartbeat();
    }
  }

  private async writeCollection(
    tx: TenantPrismaTransaction,
    writer: WriteStream,
    tenantId: string,
    collection: ExportCollection,
  ): Promise<number> {
    const delegate = (tx as any)[collection.delegate];
    let cursor: Record<string, unknown> | undefined;
    let count = 0;
    let pageRows = this.options.pageRows;
    while (true) {
      const rows = await delegate.findMany({
        where: collection.where(tenantId),
        orderBy: collection.orderBy ?? { id: "asc" },
        take: pageRows,
        ...(cursor ? { cursor, skip: 1 } : {}),
        select: collection.select,
      });
      const encodedRows = rows.map((row: any) =>
        this.encodeLine({
          collection: collection.name,
          data: collection.serialize ? collection.serialize(row) : row,
        }),
      );
      const pageBytes = encodedRows.reduce(
        (sum: number, line: string) => sum + Buffer.byteLength(line),
        0,
      );
      if (pageBytes > this.options.maxPageBytes && pageRows > 1) {
        pageRows = Math.max(1, Math.floor(pageRows / 2));
        continue;
      }
      if (pageBytes > this.options.maxPageBytes)
        throw new Error(
          `${collection.name} contains a row larger than the export page bound.`,
        );
      for (let index = 0; index < rows.length; index += 1) {
        await this.writeEncoded(writer, encodedRows[index]);
        cursor = collection.cursor
          ? collection.cursor(rows[index])
          : { id: rows[index].id };
        count += 1;
      }
      if (rows.length < pageRows) return count;
    }
  }

  private async authorizedJob(
    actor: Pick<TenantLifecycleActor, "tenantId" | "userId">,
    jobId: string,
  ): Promise<ExportJob> {
    const requestedByUserId = this.requireUserId(actor.userId);
    const job = await this.tenantDb.withTenant(actor.tenantId, async (tx) =>
      (tx as any).tenantExportJob.findFirst({
        where: { id: jobId, tenantId: actor.tenantId, requestedByUserId },
      }),
    );
    if (!job) throw new NotFoundException("Tenant export not found.");
    return job;
  }

  private async renewLease(id: string, claimToken: string): Promise<boolean> {
    const result = await this.tenantDb.withPlatformAdmin(async (tx) =>
      (tx as any).tenantExportJob.updateMany({
        where: {
          id,
          state: "RUNNING",
          claimToken,
          expiresAt: { gt: new Date() },
        },
        data: { claimExpiresAt: new Date(Date.now() + this.options.leaseMs) },
      }),
    );
    return result.count === 1;
  }

  private async updateProgress(
    id: string,
    claimToken: string,
    collection: string,
    progressRows: number,
    rowCounts: Record<string, number>,
  ): Promise<void> {
    const updated = await this.updateClaimedJob(id, claimToken, {
      progressCollection: collection,
      progressRows,
      rowCounts,
    });
    if (!updated) throw new Error("Tenant export lease was lost.");
  }

  private async updateClaimedJob(
    id: string,
    claimToken: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.tenantDb.withPlatformAdmin(async (tx) =>
      (tx as any).tenantExportJob.updateMany({
        where: { id, state: "RUNNING", claimToken },
        data,
      }),
    );
    return result.count === 1;
  }

  private recordBackgroundFailure(context: string, error: unknown): void {
    try {
      this.metrics?.tenantExportsTotal?.inc({ outcome: "worker_error" });
    } catch {
      // Telemetry must never turn a contained worker failure into a process failure.
    }
    try {
      const message =
        error instanceof Error ? error.message : "Unknown background failure.";
      this.logger.error(`${context}: ${message}`);
    } catch {
      // Logging must preserve the same process-safety guarantee.
    }
  }

  private artifactPath(artifactKey: string | null): string {
    const uuid =
      "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    if (
      !artifactKey ||
      !new RegExp(`^${uuid}-${uuid}\\.ndjson$`, "i").test(artifactKey)
    ) {
      throw new ServiceUnavailableException(
        "Tenant export artifact identity is invalid.",
      );
    }
    return join(this.options.artifactDirectory, artifactKey);
  }

  private serialize(job: ExportJob) {
    const state = job.state.toLowerCase();
    return {
      id: job.id,
      state,
      createdAt: job.createdAt.toISOString(),
      expiresAt: job.expiresAt.toISOString(),
      watermark: job.watermark.toISOString(),
      bytes: job.bytes,
      rowCounts: this.rowCounts(job.rowCounts),
      progress: {
        collection: job.progressCollection,
        rows: job.progressRows,
        attempts: job.attempts,
      },
      error: job.error ?? undefined,
      statusPath: `/admin/account/exports/${job.id}`,
      downloadPath:
        job.state === "READY"
          ? `/admin/account/exports/${job.id}/download`
          : null,
    };
  }

  private encodeLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
  }

  private async writeLine(writer: WriteStream, value: unknown): Promise<void> {
    await this.writeEncoded(writer, this.encodeLine(value));
  }

  private async writeEncoded(
    writer: WriteStream,
    value: string,
  ): Promise<void> {
    if (!writer.write(value)) await once(writer, "drain");
  }

  private requireUserId(userId: string | undefined): string {
    if (!userId?.trim())
      throw new NotFoundException("Tenant export not found.");
    return userId.trim();
  }

  private rowCounts(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" &&
          Number.isInteger(entry[1]) &&
          entry[1] >= 0,
      ),
    );
  }

  private assertStorageContract(explicitDirectory: boolean): void {
    const requiresShared =
      this.options.production || this.options.replicaCount > 1;
    if (!isAbsolute(this.options.artifactDirectory)) {
      throw new ServiceUnavailableException(
        "TENANT_EXPORT_ARTIFACT_DIRECTORY must be absolute.",
      );
    }
    if (
      requiresShared &&
      (!explicitDirectory || !this.options.sharedArtifactStorage)
    ) {
      throw new ServiceUnavailableException(
        "Shared durable tenant export artifact storage is required.",
      );
    }
  }

  private async cleanupOrphanPartials(): Promise<void> {
    const entries = await readdir(this.options.artifactDirectory).catch(
      () => [] as string[],
    );
    const cutoff =
      Date.now() - Math.max(this.options.leaseMs, this.options.expiresMs);
    await Promise.all(
      entries.map(async (entry) => {
        if (!/^[0-9a-f-]+\.ndjson(?:\.[0-9a-f-]+\.part)?$/i.test(entry)) return;
        const path = join(this.options.artifactDirectory, entry);
        const file = await stat(path).catch(() => null);
        if (file && file.mtimeMs <= cutoff) await rm(path, { force: true });
      }),
    );
  }
}
