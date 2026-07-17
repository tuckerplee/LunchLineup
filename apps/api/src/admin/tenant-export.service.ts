import {
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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
type ExportArtifactCleanupState = "NONE" | "PENDING" | "COMPLETE";

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
  artifactCleanupState: ExportArtifactCleanupState;
  artifactCleanupOwner: string | null;
  artifactCleanupLeaseExpiresAt: Date | null;
  artifactCleanupAttempts: number;
};

type ExportQuotaUsage = {
  globalBytes: bigint | number | string;
  tenantBytes: bigint | number | string;
};

type ActiveExportArtifact = Pick<
  ExportJob,
  "id" | "state" | "artifactKey" | "claimToken" | "bytes" | "artifactCleanupState"
>;

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
  maxArtifactBytes?: number;
  globalQuotaBytes?: number;
  perTenantQuotaBytes?: number;
  expiresMs?: number;
  transactionTimeoutMs?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  minStartIntervalMs?: number;
  startWorker?: boolean;
  cleanupLeaseMs?: number;
  deleteArtifact?: (path: string) => Promise<void>;
  durability?: Partial<TenantExportDurabilityOperations>;
};

export type TenantExportDurabilityOperations = {
  closeWriter: (writer: WriteStream) => Promise<void>;
  syncFile: (path: string) => Promise<void>;
  atomicRename: (source: string, destination: string) => Promise<void>;
  syncDirectory: (path: string) => Promise<void>;
};

const DEFAULT_EXPORT_DURABILITY: TenantExportDurabilityOperations = {
  closeWriter: async (writer) => {
    writer.end();
    await once(writer, "close");
  },
  syncFile: async (path) => {
    const file = await open(path, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  },
  atomicRename: rename,
  syncDirectory: async (path) => {
    if (process.platform === "win32") return;
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
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
  "stripeUsageEvent.idempotencyKey",
  "stripeUsageEvent.lastError",
  "stripeUsageEvent.metadata",
  "scheduleSolveJob.queuePayload",
  "scheduleSolveJob.publishLeaseUntil",
  "scheduleSolveJob.publishLastError",
  "scheduleSolveJob.executionToken",
  "scheduleSolveJob.executionLeaseUntil",
  "notificationOutbox.leaseUntil",
  "notificationOutbox.lastError",
  "staffInvitationOutbox.recipientHash",
  "staffInvitationOutbox.encryptedPayload",
  "staffInvitationOutbox.encryptionNonce",
  "staffInvitationOutbox.encryptionTag",
  "staffInvitationOutbox.encryptionKeyRef",
  "staffInvitationOutbox.leaseOwner",
  "staffInvitationOutbox.leaseExpiresAt",
  "staffInvitationOutbox.providerMessageId",
  "staffInvitationOutbox.lastErrorCode",
  "timeCard.clockInOperationId",
  "timeCard.clockInRequestHash",
  "payrollPolicyVersion.operationId",
  "payrollPolicyVersion.requestHash",
  "payrollPeriod.lockOperationId",
  "payrollPeriod.lockRequestHash",
  "payrollTimeCardApproval.operationId",
  "payrollTimeCardApproval.requestHash",
  "payrollAmendment.operationId",
  "payrollAmendment.requestHash",
  "payrollAmendmentDecision.operationId",
  "payrollAmendmentDecision.requestHash",
  "payrollOperation.operationId",
  "payrollOperation.requestHash",
  "payrollOperation.response",
  "payrollExportBatch.operationId",
  "payrollExportBatch.requestHash",
  "auditLog.oldValue",
  "auditLog.newValue",
  "auditLog.actorUserId",
  "auditLog.actorTenantId",
  "auditLog.ipAddress",
  "auditLog.userAgent",
  "tenantSetting.internal:tenant-lifecycle-intent:*",
  "tenantDeletionBillingReconciliation.operationId",
  "tenantDeletionBillingReconciliation.nextAttemptAt",
  "tenantDeletionBillingReconciliation.lastAttemptAt",
  "tenantDeletionBillingReconciliation.lastFailureAt",
  "tenantDeletionBillingReconciliation.lastErrorCode",
  "tenantDeletionBillingReconciliation.leaseOwner",
  "tenantDeletionBillingReconciliation.leaseToken",
  "tenantDeletionBillingReconciliation.leaseExpiresAt",
] as const;

const PUBLIC_EXPORT_FAILURE_MESSAGE =
  "Account export could not be generated. Please retry or contact support.";

export const TENANT_EXPORT_COLLECTIONS: readonly ExportCollection[] = [
  {
    model: "TenantSetting",
    name: "settings",
    delegate: "tenantSetting",
    where: (tenantId) => ({
      tenantId,
      key: { not: { startsWith: "internal:tenant-lifecycle-intent:" } },
    }),
    select: { id: true, key: true, value: true, updatedAt: true },
  },
  {
    model: "TenantDeletionBillingReconciliation",
    name: "deletionBillingReconciliation",
    delegate: "tenantDeletionBillingReconciliation",
    where: (tenantId) => ({ tenantId }),
    select: {
      tenantId: true,
      barrierCreatedAt: true,
      state: true,
      attemptCount: true,
      finalizedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ tenantId: "asc" }],
    cursor: (row) => ({ tenantId: row.tenantId }),
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
      oidcIssuer: true,
      oidcSubject: true,
      role: true,
      mfaEnabled: true,
      pinSetAt: true,
      pinResetRequired: true,
      lastLoginAt: true,
      lockedUntil: true,
      pinLockedUntil: true,
      emailDeliverySuppressedAt: true,
      emailDeliverySuppressionReason: true,
      emailDeliveryLastEventAt: true,
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
      revision: true,
      deletedAt: true,
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
      payrollPeriodId: true,
      workTimeZone: true,
      revision: true,
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
    model: "TimeCardBreak",
    name: "timeCardBreaks",
    delegate: "timeCardBreak",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      timeCardId: true,
      startAt: true,
      endAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "PayrollPolicyVersion",
    name: "payrollPolicyVersions",
    delegate: "payrollPolicyVersion",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      version: true,
      timeZone: true,
      cadence: true,
      anchorDate: true,
      effectiveFrom: true,
      createdByUserId: true,
      createdAt: true,
    },
    orderBy: [{ version: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollPeriod",
    name: "payrollPeriods",
    delegate: "payrollPeriod",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      policyVersionId: true,
      localStartDate: true,
      localEndDateExclusive: true,
      startsAt: true,
      endsAt: true,
      timeZone: true,
      cadence: true,
      status: true,
      revision: true,
      reviewStartedAt: true,
      reviewStartedByUserId: true,
      lockedAt: true,
      lockedByUserId: true,
      lockedEntrySha256: true,
      lockedEntryCount: true,
      totalPayableMinutes: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ localStartDate: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollTimeCardApproval",
    name: "payrollTimeCardApprovals",
    delegate: "payrollTimeCardApproval",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      periodId: true,
      timeCardId: true,
      timeCardRevision: true,
      decision: true,
      reason: true,
      decidedAt: true,
      decidedByUserId: true,
    },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollLockedEntry",
    name: "payrollLockedEntries",
    delegate: "payrollLockedEntry",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      periodId: true,
      sequence: true,
      sourceType: true,
      sourceId: true,
      sourceRevision: true,
      employeeId: true,
      locationId: true,
      workTimeZone: true,
      clockInAt: true,
      clockOutAt: true,
      breakMinutes: true,
      payableMinutes: true,
      approvedAt: true,
      approvedByUserId: true,
      canonicalSha256: true,
      createdAt: true,
    },
    orderBy: [{ periodId: "asc" }, { sequence: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollAmendment",
    name: "payrollAmendments",
    delegate: "payrollAmendment",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      lockedEntryId: true,
      adjustmentPeriodId: true,
      requestedByUserId: true,
      reason: true,
      replacementClockInAt: true,
      replacementClockOutAt: true,
      replacementBreakMinutes: true,
      replacementPayableMinutes: true,
      minuteDelta: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollAmendmentDecision",
    name: "payrollAmendmentDecisions",
    delegate: "payrollAmendmentDecision",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      amendmentId: true,
      decision: true,
      reason: true,
      decidedByUserId: true,
      decidedAt: true,
    },
    orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollOperation",
    name: "payrollOperations",
    delegate: "payrollOperation",
    where: (tenantId) => ({ tenantId }),
    select: {
      operationId: true,
      periodId: true,
      kind: true,
      createdAt: true,
    },
    serialize: (row) => ({
      periodId: row.periodId,
      kind: row.kind,
      createdAt: row.createdAt,
    }),
    orderBy: [{ createdAt: "asc" }, { operationId: "asc" }],
    cursor: (row) => ({ operationId: row.operationId }),
  },
  {
    model: "PayrollExportBatch",
    name: "payrollExportBatches",
    delegate: "payrollExportBatch",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      periodId: true,
      formatVersion: true,
      status: true,
      contentSha256: true,
      rowCount: true,
      totalPayableMinutes: true,
      consumedCredits: true,
      newBalance: true,
      createdAt: true,
      downloadedAt: true,
      reconciledAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollExportLine",
    name: "payrollExportLines",
    delegate: "payrollExportLine",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      batchId: true,
      lineNumber: true,
      lockedEntryId: true,
      sourceType: true,
      sourceId: true,
      employeeId: true,
      locationId: true,
      workTimeZone: true,
      clockInAt: true,
      clockOutAt: true,
      breakMinutes: true,
      payableMinutes: true,
      canonicalSha256: true,
      createdAt: true,
    },
    orderBy: [{ batchId: "asc" }, { lineNumber: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollReconciliationReceipt",
    name: "payrollReconciliationReceipts",
    delegate: "payrollReconciliationReceipt",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      batchId: true,
      provider: true,
      providerEventId: true,
      payloadSha256: true,
      providerTotalMinutes: true,
      acceptedCount: true,
      rejectedCount: true,
      pendingCount: true,
      receivedByUserId: true,
      receivedAt: true,
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollReconciliationLineEvent",
    name: "payrollReconciliationLineEvents",
    delegate: "payrollReconciliationLineEvent",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      receiptId: true,
      batchId: true,
      lineId: true,
      status: true,
      reason: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
  {
    model: "PayrollReconciliationLineState",
    name: "payrollReconciliationLineStates",
    delegate: "payrollReconciliationLineState",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      batchId: true,
      lineId: true,
      status: true,
      latestReceiptId: true,
      reason: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
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
      staffSnapshot: true,
      demandSnapshot: true,
      creditConsumption: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "AvailabilityImportJob",
    name: "availabilityImports",
    delegate: "availabilityImportJob",
    where: (tenantId) => ({ tenantId }),
    select: {
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
      queuedAt: true,
      publishedAt: true,
      startedAt: true,
      completedAt: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  {
    model: "StaffInvitationOutbox",
    name: "staffInvitationDeliveries",
    delegate: "staffInvitationOutbox",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      purpose: true,
      status: true,
      attempts: true,
      manualRetryCount: true,
      retryAt: true,
      deliveredAt: true,
      deadLetteredAt: true,
      cancelledAt: true,
      payloadErasedAt: true,
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
    model: "NotificationOutbox",
    name: "notificationOutbox",
    delegate: "notificationOutbox",
    where: (tenantId) => ({ tenantId }),
    select: {
      id: true,
      userId: true,
      dedupeKey: true,
      notificationType: true,
      title: true,
      body: true,
      status: true,
      attempts: true,
      nextAttemptAt: true,
      deliveredAt: true,
      createdAt: true,
      updatedAt: true,
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

export class TenantExportService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantExportService.name);
  private readonly options: Required<Omit<TenantExportServiceOptions, "durability">>;
  private readonly durability: TenantExportDurabilityOperations;
  private readonly timer?: NodeJS.Timeout;
  private workerActive = false;
  private stopping = false;
  private lastExpirySweep = 0;
  private readonly artifactBytes = new WeakMap<WriteStream, number>();

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
      maxArtifactBytes:
        options.maxArtifactBytes ??
        (process.env.TENANT_EXPORT_MAX_ARTIFACT_BYTES === undefined
          ? 256 * 1024 * 1024
          : Number(process.env.TENANT_EXPORT_MAX_ARTIFACT_BYTES)),
      globalQuotaBytes:
        options.globalQuotaBytes ??
        (process.env.TENANT_EXPORT_GLOBAL_QUOTA_BYTES === undefined
          ? 2 * 1024 * 1024 * 1024
          : Number(process.env.TENANT_EXPORT_GLOBAL_QUOTA_BYTES)),
      perTenantQuotaBytes:
        options.perTenantQuotaBytes ??
        (process.env.TENANT_EXPORT_PER_TENANT_QUOTA_BYTES === undefined
          ? 512 * 1024 * 1024
          : Number(process.env.TENANT_EXPORT_PER_TENANT_QUOTA_BYTES)),
      expiresMs: options.expiresMs ?? 15 * 60 * 1000,
      transactionTimeoutMs: options.transactionTimeoutMs ?? 10 * 60 * 1000,
      leaseMs: options.leaseMs ?? 15 * 60 * 1000,
      pollIntervalMs: options.pollIntervalMs ?? 5_000,
      minStartIntervalMs: options.minStartIntervalMs ?? 60 * 1000,
      startWorker: options.startWorker ?? true,
      cleanupLeaseMs: options.cleanupLeaseMs ?? 60_000,
      deleteArtifact: options.deleteArtifact ?? ((path) => rm(path, { force: true })),
    };
    this.durability = {
      closeWriter: options.durability?.closeWriter ?? DEFAULT_EXPORT_DURABILITY.closeWriter,
      syncFile: options.durability?.syncFile ?? DEFAULT_EXPORT_DURABILITY.syncFile,
      atomicRename: options.durability?.atomicRename ?? DEFAULT_EXPORT_DURABILITY.atomicRename,
      syncDirectory: options.durability?.syncDirectory ?? DEFAULT_EXPORT_DURABILITY.syncDirectory,
    };
    if (!Number.isInteger(this.options.pageRows) || this.options.pageRows < 1) {
      throw new ServiceUnavailableException("Tenant export pageRows must be a positive integer.");
    }
    if (!Number.isInteger(this.options.cleanupLeaseMs) || this.options.cleanupLeaseMs < 1_000) {
      throw new ServiceUnavailableException("Tenant export cleanupLeaseMs must be at least one second.");
    }
    if (!Number.isInteger(this.options.maxPageBytes) || this.options.maxPageBytes < 64) {
      throw new ServiceUnavailableException("Tenant export maxPageBytes must be an integer of at least 64 bytes.");
    }
    if (
      !Number.isSafeInteger(this.options.maxArtifactBytes)
      || this.options.maxArtifactBytes < 64
      || this.options.maxArtifactBytes > 2_147_483_647
    ) {
      throw new ServiceUnavailableException(
        "Tenant export maxArtifactBytes must fit the database integer byte counter and be at least 64 bytes.",
      );
    }
    for (const quota of ["globalQuotaBytes", "perTenantQuotaBytes"] as const) {
      if (
        !Number.isSafeInteger(this.options[quota])
        || this.options[quota] < this.options.maxArtifactBytes
      ) {
        throw new ServiceUnavailableException(
          `Tenant export ${quota} must be a safe integer at least as large as maxArtifactBytes.`,
        );
      }
    }
    this.assertStorageContract(Boolean(configuredDirectory));
    if (this.options.startWorker) {
      this.timer = setInterval(
        () => void this.maintenance(),
        this.options.pollIntervalMs,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
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

  async openDownload(actor: TenantLifecycleActor, jobId: string) {
    const job = await this.authorizedJob(actor, jobId);
    if (job.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException("Tenant export has expired.");
    }
    if (job.state !== "READY")
      throw new ConflictException("Tenant export is not ready for download.");
    const path = this.artifactPath(job.artifactKey);
    const file = await stat(path).catch(() => null);
    if (!file?.isFile() || file.size !== job.bytes) {
      throw new ServiceUnavailableException(
        "Tenant export artifact is unavailable.",
      );
    }
    await this.tenantDb.withTenant(actor.tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: this.requireUserId(actor.userId),
          action: "TENANT_EXPORT_DOWNLOADED",
          resource: "TenantExportJob",
          resourceId: job.id,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        },
      }),
    );
    return {
      filename: `${job.tenantSlug}-account-export-${job.watermark.toISOString().slice(0, 10)}.ndjson`,
      bytes: job.bytes,
      stream: createReadStream(path),
    };
  }

  async runWorkerOnce(): Promise<boolean> {
    const job = await this.claimJob();
    if (!job) return false;
    if (job.state === "FAILED") {
      this.metrics?.tenantExportsTotal?.inc({ outcome: "failed" });
      return true;
    }
    await this.generate(job);
    return true;
  }

  async cleanupExpired(): Promise<number> {
    const expired = await this.claimArtifactCleanupJobs();
    let completed = 0;
    let failed = false;
    for (const job of expired) {
      try {
        if (await this.completeArtifactCleanup(job)) completed += 1;
      } catch {
        failed = true;
        await this.releaseArtifactCleanupClaim(job).catch(() => undefined);
      }
    }
    if (failed) {
      throw new Error("Tenant export artifact cleanup remains pending.");
    }
    await this.cleanupOrphanPartials();
    return completed;
  }

  private async maintenance(): Promise<void> {
    if (this.stopping || this.workerActive) return;
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
    if (this.stopping) return;
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
      while (!this.stopping && await this.runWorkerOnce()) {
        // Drain one durable claim at a time per replica.
      }
    } finally {
      this.workerActive = false;
    }
  }

  private async claimJob(): Promise<ExportJob | null> {
    const claimToken = randomUUID();
    const leaseUntil = new Date(Date.now() + this.options.leaseMs);
    return this.tenantDb.withPlatformAdmin(async (tx) => {
      await this.lockArtifactQuota(tx);
      const candidates = await tx.$queryRaw<ExportJob[]>(Prisma.sql`
                SELECT *
                FROM "TenantExportJob"
                WHERE "expiresAt" > CURRENT_TIMESTAMP
                  AND "artifactCleanupState" = 'NONE'
                  AND ("state" = 'QUEUED' OR ("state" = 'RUNNING' AND "claimExpiresAt" < CURRENT_TIMESTAMP))
                ORDER BY "createdAt" ASC, "id" ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
        `);
      const candidate = candidates[0];
      if (!candidate) return null;

      const usageRows = await tx.$queryRaw<ExportQuotaUsage[]>(Prisma.sql`
            SELECT
                COALESCE(SUM(job."bytes"), 0)::BIGINT AS "globalBytes",
                COALESCE(SUM(job."bytes") FILTER (
                    WHERE job."tenantId" = ${candidate.tenantId}
                ), 0)::BIGINT AS "tenantBytes"
            FROM "TenantExportJob" job
            WHERE job."id" <> ${candidate.id}
              AND job."bytes" > 0
              AND job."artifactCleanupState" <> 'COMPLETE'
        `);
      const usage = usageRows[0] ?? { globalBytes: 0n, tenantBytes: 0n };
      const reservationBytes = BigInt(this.options.maxArtifactBytes);
      const quotaAvailable =
        BigInt(usage.globalBytes) + reservationBytes <= BigInt(this.options.globalQuotaBytes)
        && BigInt(usage.tenantBytes) + reservationBytes <= BigInt(this.options.perTenantQuotaBytes);

      if (!quotaAvailable) {
        const failed = await tx.$queryRaw<ExportJob[]>(Prisma.sql`
              UPDATE "TenantExportJob"
              SET "state" = 'FAILED', "bytes" = 0, "claimToken" = NULL, "claimExpiresAt" = NULL,
                  "attempts" = "attempts" + 1, "error" = 'Tenant export generation failed.',
                  "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
             WHERE "id" = ${candidate.id}
               AND "artifactCleanupState" = 'NONE'
             RETURNING *
          `);
        return failed[0] ?? null;
      }

      const claimed = await tx.$queryRaw<ExportJob[]>(Prisma.sql`
            UPDATE "TenantExportJob"
            SET "state" = 'RUNNING', "bytes" = ${this.options.maxArtifactBytes},
                "claimToken" = ${claimToken}, "claimExpiresAt" = ${leaseUntil},
                "attempts" = "attempts" + 1, "error" = NULL, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${candidate.id}
              AND "artifactCleanupState" = 'NONE'
            RETURNING *
        `);
      return claimed[0] ?? null;
    });
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
    let artifactFinalized = false;
    let snapshotWatermark: Date | undefined;
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
      const rowCounts: Record<string, number> = {};
      const fileSize = await this.tenantDb.withTenant(
        job.tenantId,
        async (tx) => {
          const watermarkRows = await tx.$queryRaw<Array<{ watermark: Date }>>(Prisma.sql`
            SELECT CURRENT_TIMESTAMP AS "watermark"
          `);
          const transactionWatermark = watermarkRows[0]?.watermark;
          if (!(transactionWatermark instanceof Date)) {
            throw new Error("Tenant export snapshot watermark is unavailable.");
          }
          snapshotWatermark = transactionWatermark;
          await this.lockArtifactJob(tx, job.id);
          await this.assertArtifactWriterOwnsJob(tx, job.id, claimToken);
          writer = createWriteStream(partialPath, {
            flags: "wx",
            encoding: "utf8",
            mode: 0o600,
          });
          this.artifactBytes.set(writer, 0);
          await this.writeLine(writer!, {
            type: "manifest",
            format: "lunchlineup-tenant-export-ndjson",
            version: 3,
            exportedAt: transactionWatermark.toISOString(),
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
          await this.durability.closeWriter(writer!);
          await this.durability.syncFile(partialPath);
          const file = await stat(partialPath);
          if (
            file.size !== this.artifactBytes.get(writer!) ||
            file.size > this.options.maxArtifactBytes
          ) {
            throw new Error("Tenant export artifact byte accounting failed.");
          }
          return file.size;
        },
        {
          maxWait: 5_000,
          timeout: this.options.transactionTimeoutMs,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      );
      await stopHeartbeat();
      if (leaseLost) throw new Error("Tenant export lease was lost.");
      if (!(await this.renewLease(job.id, claimToken)))
        throw new Error("Tenant export lease was lost.");
      if (!snapshotWatermark) {
        throw new Error("Tenant export snapshot watermark is unavailable.");
      }
      await this.durability.atomicRename(partialPath, finalPath);
      await this.syncArtifactDirectory();
      const finalized = await this.finalizeClaimedArtifact(job.id, claimToken, {
        state: "READY",
        watermark: snapshotWatermark,
        artifactKey,
        bytes: fileSize,
        rowCounts,
        progressCollection: null,
        claimToken: null,
        claimExpiresAt: null,
        completedAt: new Date(),
        error: null,
      });
      if (!finalized) {
        throw new Error("Tenant export lease was lost before finalization.");
      }
      artifactFinalized = true;
      this.metrics?.tenantExportsTotal?.inc({ outcome: "ready" });
    } catch {
      await this.destroyWriter(writer);
      if (artifactFinalized) return;
      const message = "Tenant export generation failed.";
      const pendingCleanup = await this.markClaimedJobForCleanup(
        job.id,
        claimToken,
        message,
      ).catch(() => false);
      if (pendingCleanup) {
        await this.cleanupArtifactJob(job.id).catch(() => undefined);
      }
      this.metrics?.tenantExportsTotal?.inc({ outcome: "failed" });
    } finally {
      await stopHeartbeat();
      if (writer) this.artifactBytes.delete(writer);
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
    while (true) {
      const cursorRows = await delegate.findMany({
        where: collection.where(tenantId),
        orderBy: collection.orderBy ?? { id: "asc" },
        take: this.options.pageRows,
        ...(cursor ? { cursor, skip: 1 } : {}),
        select: this.cursorProjection(collection),
      });
      for (const cursorRow of cursorRows) {
        const rowCursor = collection.cursor
          ? collection.cursor(cursorRow)
          : { id: cursorRow.id };
        const rows = await delegate.findMany({
          where: collection.where(tenantId),
          orderBy: collection.orderBy ?? { id: "asc" },
          take: 1,
          cursor: rowCursor,
          select: collection.select,
        });
        const row = rows[0];
        if (!row) {
          throw new Error(
            `${collection.name} changed during its repeatable-read export snapshot.`,
          );
        }
        await this.writeLine(writer, {
          collection: collection.name,
          data: collection.serialize ? collection.serialize(row) : row,
        });
        cursor = rowCursor;
        count += 1;
      }
      if (cursorRows.length < this.options.pageRows) return count;
    }
  }

  private cursorProjection(collection: ExportCollection): Record<string, true> {
    const fields = collection.orderBy?.flatMap((order) => Object.keys(order)) ?? ["id"];
    return Object.fromEntries(fields.map((field) => [field, true]));
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

  private async finalizeClaimedArtifact(
    id: string,
    claimToken: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    return this.tenantDb.withPlatformAdmin(async (tx) => {
      await this.lockArtifactQuota(tx);
      const result = await (tx as any).tenantExportJob.updateMany({
        where: { id, state: "RUNNING", claimToken },
        data,
      });
      return result.count === 1;
    });
  }

  private async markClaimedJobForCleanup(
    id: string,
    claimToken: string,
    error: string,
  ): Promise<boolean> {
    return this.tenantDb.withPlatformAdmin(async (tx) => {
      await this.lockArtifactQuota(tx);
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "TenantExportJob"
          SET "state" = 'FAILED',
              "artifactCleanupState" = 'PENDING',
              "artifactCleanupOwner" = NULL,
              "artifactCleanupLeaseExpiresAt" = NULL,
              "error" = ${error},
              "completedAt" = CURRENT_TIMESTAMP,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${id}
            AND "state" = 'RUNNING'
            AND "claimToken" = ${claimToken}
            AND "artifactCleanupState" = 'NONE'
          RETURNING "id"
      `);
      return rows.length === 1;
    });
  }

  private async claimArtifactCleanupJobs(
    onlyJobId?: string,
  ): Promise<ExportJob[]> {
    const cleanupOwner = randomUUID();
    const cleanupLeaseExpiresAt = new Date(
      Date.now() + this.options.cleanupLeaseMs,
    );
    return this.tenantDb.withPlatformAdmin(async (tx) => {
      await this.lockArtifactQuota(tx);
      const candidates = await tx.$queryRaw<ExportJob[]>(Prisma.sql`
          SELECT *
          FROM "TenantExportJob"
          WHERE (${onlyJobId ?? null}::TEXT IS NULL OR "id" = ${onlyJobId ?? null})
            AND (
              (
                "artifactCleanupState" = 'PENDING'
                AND (
                  "artifactCleanupOwner" IS NULL
                  OR "artifactCleanupLeaseExpiresAt" <= CURRENT_TIMESTAMP
                )
              )
              OR (
                "expiresAt" <= CURRENT_TIMESTAMP
                AND "state" <> 'EXPIRED'
                AND "artifactCleanupState" = 'NONE'
              )
            )
          ORDER BY "updatedAt" ASC, "id" ASC
          LIMIT 100
      `);
      const claimed: ExportJob[] = [];
      for (const candidate of candidates) {
        if (!(await this.tryLockArtifactJob(tx, candidate.id))) continue;
        const rows = await tx.$queryRaw<ExportJob[]>(Prisma.sql`
            UPDATE "TenantExportJob"
            SET "state" = CASE
                    WHEN "expiresAt" <= CURRENT_TIMESTAMP THEN 'EXPIRED'
                    ELSE "state"
                END,
                "artifactCleanupState" = CASE
                    WHEN "bytes" = 0 AND "artifactKey" IS NULL AND "claimToken" IS NULL
                        THEN 'COMPLETE'
                    ELSE 'PENDING'
                END,
                "artifactCleanupOwner" = CASE
                    WHEN "bytes" = 0 AND "artifactKey" IS NULL AND "claimToken" IS NULL
                        THEN NULL
                    ELSE ${cleanupOwner}
                END,
                "artifactCleanupLeaseExpiresAt" = CASE
                    WHEN "bytes" = 0 AND "artifactKey" IS NULL AND "claimToken" IS NULL
                        THEN NULL
                    ELSE ${cleanupLeaseExpiresAt}
                END,
                "artifactCleanupAttempts" = "artifactCleanupAttempts" + 1,
                "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${candidate.id}
              AND (
                (
                  "artifactCleanupState" = 'PENDING'
                  AND (
                    "artifactCleanupOwner" IS NULL
                    OR "artifactCleanupLeaseExpiresAt" <= CURRENT_TIMESTAMP
                  )
                )
                OR (
                  "expiresAt" <= CURRENT_TIMESTAMP
                  AND "state" <> 'EXPIRED'
                  AND "artifactCleanupState" = 'NONE'
                )
              )
            RETURNING *
        `);
        if (rows[0]) claimed.push(rows[0]);
      }
      return claimed;
    });
  }

  private async cleanupArtifactJob(id: string): Promise<boolean> {
    const jobs = await this.claimArtifactCleanupJobs(id);
    if (!jobs[0]) return false;
    try {
      return await this.completeArtifactCleanup(jobs[0]);
    } catch (error) {
      await this.releaseArtifactCleanupClaim(jobs[0]).catch(() => undefined);
      throw error;
    }
  }

  private async completeArtifactCleanup(job: ExportJob): Promise<boolean> {
    if (job.artifactCleanupState === "COMPLETE") return true;
    return this.tenantDb.withPlatformAdmin(async (tx) => {
      await this.lockArtifactQuota(tx);
      await this.lockArtifactJob(tx, job.id);
      const rows = await tx.$queryRaw<ExportJob[]>(Prisma.sql`
          SELECT *
          FROM "TenantExportJob"
          WHERE "id" = ${job.id}
            AND "artifactCleanupState" = 'PENDING'
            AND "artifactCleanupOwner" = ${job.artifactCleanupOwner}
          FOR UPDATE
      `);
      const owned = rows[0];
      if (!owned) return false;
      const paths = new Set<string>();
      if (owned.artifactKey) paths.add(this.artifactPath(owned.artifactKey));
      if (owned.claimToken) {
        const activeKey = `${owned.id}-${owned.claimToken}.ndjson`;
        paths.add(this.artifactPath(activeKey));
        paths.add(join(
          this.options.artifactDirectory,
          `${activeKey}.${owned.claimToken}.part`,
        ));
      }
      for (const path of paths) await this.removeArtifactDurably(path);
      await this.syncArtifactDirectory();
      const completed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "TenantExportJob"
          SET "artifactCleanupState" = 'COMPLETE',
              "artifactCleanupOwner" = NULL,
              "artifactCleanupLeaseExpiresAt" = NULL,
              "artifactKey" = NULL,
              "bytes" = 0,
              "claimToken" = NULL,
              "claimExpiresAt" = NULL,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${owned.id}
            AND "artifactCleanupState" = 'PENDING'
            AND "artifactCleanupOwner" = ${owned.artifactCleanupOwner}
          RETURNING "id"
      `);
      return completed.length === 1;
    });
  }

  private async releaseArtifactCleanupClaim(job: ExportJob): Promise<void> {
    if (!job.artifactCleanupOwner) return;
    await this.tenantDb.withPlatformAdmin(async (tx) => {
      await this.lockArtifactQuota(tx);
      await this.lockArtifactJob(tx, job.id);
      await tx.$executeRaw(Prisma.sql`
          UPDATE "TenantExportJob"
          SET "artifactCleanupOwner" = NULL,
              "artifactCleanupLeaseExpiresAt" = NULL,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${job.id}
            AND "artifactCleanupState" = 'PENDING'
            AND "artifactCleanupOwner" = ${job.artifactCleanupOwner}
      `);
    });
  }

  private async assertArtifactWriterOwnsJob(
    tx: TenantPrismaTransaction,
    id: string,
    claimToken: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ owned: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM "TenantExportJob"
          WHERE "id" = ${id}
            AND "state" = 'RUNNING'
            AND "claimToken" = ${claimToken}
            AND "expiresAt" > CURRENT_TIMESTAMP
            AND "artifactCleanupState" = 'NONE'
        ) AS "owned"
    `);
    if (rows[0]?.owned !== true) {
      throw new Error("Tenant export artifact writer is fenced.");
    }
  }

  private async lockArtifactJob(
    tx: TenantPrismaTransaction,
    id: string,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${id}, 2026071601))
    `);
  }

  private async tryLockArtifactJob(
    tx: TenantPrismaTransaction,
    id: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ claimed: boolean }>>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${id}, 2026071601)
        ) AS "claimed"
    `);
    return rows[0]?.claimed === true;
  }

  private async removeArtifactDurably(path: string): Promise<void> {
    await this.options.deleteArtifact(path);
    const remaining = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (remaining) throw new Error("Tenant export artifact deletion was not durable.");
  }

  private async syncArtifactDirectory(): Promise<void> {
    await this.durability.syncDirectory(this.options.artifactDirectory);
  }

  private async lockArtifactQuota(tx: TenantPrismaTransaction): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
              hashtextextended(${"tenant-export-artifact-quota"}, 20260716)
          )
      `);
  }

  private recordBackgroundFailure(context: string, _error: unknown): void {
    try {
      this.metrics?.tenantExportsTotal?.inc({ outcome: "worker_error" });
    } catch {
      // Telemetry must never turn a contained worker failure into a process failure.
    }
    try {
      this.logger.error(`${context}: background operation failed`);
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
    const state =
      job.expiresAt.getTime() <= Date.now()
        ? "expired"
        : job.state.toLowerCase();
    return {
      id: job.id,
      state,
      createdAt: job.createdAt.toISOString(),
      expiresAt: job.expiresAt.toISOString(),
      watermark: job.watermark.toISOString(),
      bytes: job.state === "READY" ? job.bytes : 0,
      rowCounts: this.rowCounts(job.rowCounts),
      progress: {
        collection: job.progressCollection,
        rows: job.progressRows,
        attempts: job.attempts,
      },
      error: state === "failed" ? PUBLIC_EXPORT_FAILURE_MESSAGE : undefined,
      statusPath: `/admin/account/exports/${job.id}`,
      downloadPath:
        state === "ready"
          ? `/admin/account/exports/${job.id}/download`
          : null,
    };
  }

  private async writeLine(writer: WriteStream, value: unknown): Promise<void> {
    await this.writeJsonValue(writer, value);
    await this.writeEncoded(writer, "\n");
  }

  private async writeJsonValue(writer: WriteStream, value: unknown): Promise<void> {
    if (value === null || value === undefined) {
      await this.writeEncoded(writer, "null");
      return;
    }
    if (typeof value === "string") {
      await this.writeJsonString(writer, value);
      return;
    }
    if (typeof value === "boolean") {
      await this.writeEncoded(writer, value ? "true" : "false");
      return;
    }
    if (typeof value === "number") {
      await this.writeEncoded(writer, Number.isFinite(value) ? String(value) : "null");
      return;
    }
    if (typeof value === "bigint") {
      throw new TypeError("BigInt values are not valid tenant export JSON.");
    }
    if (typeof value !== "object") {
      await this.writeEncoded(writer, "null");
      return;
    }

    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") {
      await this.writeJsonValue(writer, toJSON.call(value));
      return;
    }
    if (Array.isArray(value)) {
      await this.writeEncoded(writer, "[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) await this.writeEncoded(writer, ",");
        await this.writeJsonValue(writer, value[index]);
      }
      await this.writeEncoded(writer, "]");
      return;
    }

    await this.writeEncoded(writer, "{");
    let written = 0;
    for (const [key, child] of Object.entries(value)) {
      if (["undefined", "function", "symbol"].includes(typeof child)) continue;
      if (written > 0) await this.writeEncoded(writer, ",");
      await this.writeJsonString(writer, key);
      await this.writeEncoded(writer, ":");
      await this.writeJsonValue(writer, child);
      written += 1;
    }
    await this.writeEncoded(writer, "}");
  }

  private async writeJsonString(writer: WriteStream, value: string): Promise<void> {
    await this.writeEncoded(writer, '"');
    const maxCodeUnits = Math.max(1, Math.floor(this.options.maxPageBytes / 6));
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + maxCodeUnits);
      const lastCodeUnit = value.charCodeAt(end - 1);
      const nextCodeUnit = value.charCodeAt(end);
      if (
        end < value.length
        && lastCodeUnit >= 0xd800
        && lastCodeUnit <= 0xdbff
        && nextCodeUnit >= 0xdc00
        && nextCodeUnit <= 0xdfff
      ) {
        end = end === offset + 1 ? Math.min(value.length, end + 1) : end - 1;
      }
      const encoded = JSON.stringify(value.slice(offset, end));
      await this.writeEncoded(writer, encoded.slice(1, -1));
      offset = end;
    }
    await this.writeEncoded(writer, '"');
  }

  private async writeEncoded(
    writer: WriteStream,
    value: string,
  ): Promise<void> {
    const written = this.artifactBytes.get(writer);
    if (written === undefined) {
      throw new Error("Tenant export artifact byte accounting is unavailable.");
    }
    const nextBytes = written + Buffer.byteLength(value);
    if (nextBytes > this.options.maxArtifactBytes) {
      throw new Error("Tenant export artifact byte quota exceeded.");
    }
    this.artifactBytes.set(writer, nextBytes);
    if (!writer.write(value)) await once(writer, "drain");
  }

  private async destroyWriter(writer: WriteStream | undefined): Promise<void> {
    if (!writer || writer.closed) return;
    writer.destroy();
    if (!writer.closed) await once(writer, "close").catch(() => undefined);
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
    const activeArtifacts = await this.tenantDb.withPlatformAdmin((tx) =>
      tx.$queryRaw<ActiveExportArtifact[]>(Prisma.sql`
            SELECT "id", "state", "artifactKey", "claimToken", "bytes", "artifactCleanupState"
            FROM "TenantExportJob"
            WHERE "bytes" > 0
               OR "artifactKey" IS NOT NULL
               OR "claimToken" IS NOT NULL
               OR "artifactCleanupState" = 'PENDING'
        `),
    );
    const protectedEntries = new Set<string>();
    for (const job of activeArtifacts) {
      if (job.artifactKey) {
        protectedEntries.add(job.artifactKey);
      }
      if (job.claimToken) {
        const activeKey = `${job.id}-${job.claimToken}.ndjson`;
        protectedEntries.add(activeKey);
        protectedEntries.add(`${activeKey}.${job.claimToken}.part`);
      }
    }
    const entries = await readdir(this.options.artifactDirectory).catch(
      () => [] as string[],
    );
    const cutoff =
      Date.now() - Math.max(this.options.leaseMs, this.options.expiresMs);
    await Promise.all(
      entries.map(async (entry) => {
        if (!/^[0-9a-f-]+\.ndjson(?:\.[0-9a-f-]+\.part)?$/i.test(entry)) return;
        if (protectedEntries.has(entry)) return;
        const path = join(this.options.artifactDirectory, entry);
        const file = await stat(path).catch(() => null);
        if (file && file.mtimeMs <= cutoff) await rm(path, { force: true });
      }),
    );
  }
}
