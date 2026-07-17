import { Prisma } from "@prisma/client";
import {
  lockTenantSchedulingMutations,
  unassignEditableShiftsForIneligibleUser,
} from "../common/schedulable-user";
import type { TenantPrismaTransaction } from "../database/tenant-prisma.service";

export const DELETED_USER_NAME = "Deleted user";

type LockedAvailabilityImport = {
  id: string;
  status: string;
  storageKey: string | null;
  creditConsumption: Prisma.JsonValue | null;
  debitCount: number | bigint;
  debitTenantId: string | null;
  debitAmount: number | bigint | null;
  debitReason: string | null;
  debitBalanceAfter: number | bigint | null;
  refundCount: number | bigint;
  refundTenantId: string | null;
  refundAmount: number | bigint | null;
  refundReason: string | null;
  refundBalanceAfter: number | bigint | null;
};

export type DeletedUserCleanup = {
  availabilityImportStorageKeys: string[];
  refundedAvailabilityImportCredits: number;
};

async function cancelAvailabilityImports(
  tx: TenantPrismaTransaction,
  tenantId: string,
  userId: string,
  deletedAt: Date,
): Promise<DeletedUserCleanup> {
  await lockTenantSchedulingMutations(tx, tenantId);
  await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${userId}
          AND "tenantId" = ${tenantId}
          AND "deletedAt" IS NULL
        FOR UPDATE
    `);
  const imports = await tx.$queryRaw<LockedAvailabilityImport[]>(Prisma.sql`
        SELECT
            job."id",
            job."status"::text AS "status",
            job."storageKey",
            job."creditConsumption",
            debit."count" AS "debitCount",
            debit."tenantId" AS "debitTenantId",
            debit."amount" AS "debitAmount",
            debit."reason" AS "debitReason",
            debit."balanceAfter" AS "debitBalanceAfter",
            refund."count" AS "refundCount",
            refund."tenantId" AS "refundTenantId",
            refund."amount" AS "refundAmount",
            refund."reason" AS "refundReason",
            refund."balanceAfter" AS "refundBalanceAfter"
        FROM "AvailabilityImportJob" job
        CROSS JOIN LATERAL (
                SELECT COUNT(*)::integer AS "count",
                       MIN(debit."tenantId") AS "tenantId",
                       MIN(debit."amount") AS "amount",
                       MIN(debit."reason") AS "reason",
                       MIN(debit."balanceAfter") AS "balanceAfter"
                FROM "CreditTransaction" debit
                WHERE debit."id" = 'feature-usage-availability-import:' || job."id"
        ) debit
        CROSS JOIN LATERAL (
                SELECT COUNT(*)::integer AS "count",
                       MIN(refund."tenantId") AS "tenantId",
                       MIN(refund."amount") AS "amount",
                       MIN(refund."reason") AS "reason",
                       MIN(refund."balanceAfter") AS "balanceAfter"
                FROM "CreditTransaction" refund
                WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
        ) refund
        WHERE job."tenantId" = ${tenantId}
          AND job."userId" = ${userId}
        ORDER BY job."id"
        FOR UPDATE OF job
    `);

  let refundedAvailabilityImportCredits = 0;
  for (const job of imports) {
    if (job.status === "SUCCEEDED") continue;
    const settlement = parseAvailabilityImportCreditConsumption(
      job.creditConsumption,
    );
    const consumedCredits = settlement.consumedCredits;
    const debitIsExact = nonnegativeCount(job.debitCount) === 1
      && job.debitTenantId === tenantId
      && integer(job.debitAmount) === -consumedCredits
      && job.debitReason === `Availability PDF import (${job.id})`
      && nonnegativeInteger(job.debitBalanceAfter) === settlement.newBalance;
    if (!debitIsExact) {
      throw new Error("Availability import debit provenance is invalid during user deletion.");
    }
    const refundId = `feature-refund-availability-import:${job.id}`;
    const refundReason = `Availability PDF import refund (${job.id})`;
    const refundCount = nonnegativeCount(job.refundCount);
    if (refundCount === 1) {
      if (job.refundTenantId !== tenantId
        || integer(job.refundAmount) !== consumedCredits
        || job.refundReason !== refundReason
        || nonnegativeInteger(job.refundBalanceAfter) === null) {
        throw new Error("Availability import refund provenance is invalid during user deletion.");
      }
      refundedAvailabilityImportCredits += consumedCredits;
      continue;
    }
    if (refundCount !== 0) {
      throw new Error("Availability import refund provenance is invalid during user deletion.");
    }
    const wallet = await tx.$queryRaw<Array<{ usageCredits: number | bigint }>>(Prisma.sql`
            UPDATE "Tenant"
            SET "usageCredits" = "usageCredits" + ${consumedCredits},
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${tenantId}
            RETURNING "usageCredits"
        `);
    const balanceAfter = nonnegativeInteger(wallet[0]?.usageCredits ?? null);
    if (balanceAfter === null) {
      throw new Error("Availability import refund wallet settlement failed during user deletion.");
    }
    const inserted = await tx.$queryRaw<Array<{ amount: number | bigint; balanceAfter: number | bigint }>>(Prisma.sql`
            INSERT INTO "CreditTransaction" (
                "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
            ) VALUES (
                ${refundId},
                ${tenantId},
                ${consumedCredits},
                ${refundReason},
                ${balanceAfter},
                CURRENT_TIMESTAMP
            )
            ON CONFLICT ("id") DO NOTHING
            RETURNING "amount", "balanceAfter"
        `);
    if (inserted.length !== 1
      || integer(inserted[0].amount) !== consumedCredits
      || nonnegativeInteger(inserted[0].balanceAfter) !== balanceAfter) {
      throw new Error("Availability import refund settlement failed during user deletion.");
    }
    refundedAvailabilityImportCredits += consumedCredits;
  }

  await tx.availabilityImportJob.updateMany({
    where: { tenantId, userId, status: { not: "SUCCEEDED" } },
    data: {
      status: "CANCELLED",
      publicationStatus: "FAILED",
      publishToken: null,
      publishLeaseUntil: null,
      publicationAmbiguous: false,
      publishLastError: null,
      storageKey: null,
      encryptedSourcePayload: null,
      parsedAvailability: Prisma.DbNull,
      resultErasedAt: deletedAt,
      failureCode: "USER_DELETED",
      executionToken: null,
      executionLeaseUntil: null,
      completedAt: deletedAt,
    },
  });
  await tx.availabilityImportJob.updateMany({
    where: { tenantId, userId, status: "SUCCEEDED" },
    data: {
      publishToken: null,
      publishLeaseUntil: null,
      publicationAmbiguous: false,
      publishLastError: null,
      storageKey: null,
      encryptedSourcePayload: null,
      parsedAvailability: Prisma.DbNull,
      resultErasedAt: deletedAt,
      executionToken: null,
      executionLeaseUntil: null,
    },
  });

  return {
    availabilityImportStorageKeys: imports
      .map((job) => job.storageKey)
      .filter(
        (storageKey): storageKey is string => typeof storageKey === "string",
      ),
    refundedAvailabilityImportCredits,
  };
}

function parseAvailabilityImportCreditConsumption(
  value: Prisma.JsonValue | null,
): { consumedCredits: number; newBalance: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Availability import credit metadata is invalid during user deletion.");
  }
  const keys = Object.keys(value).sort();
  const consumedCredits = value.consumedCredits;
  const newBalance = value.newBalance;
  if (keys.join(",") !== "consumedCredits,newBalance,source"
    || value.source !== "credits"
    || typeof consumedCredits !== "number"
    || !Number.isSafeInteger(consumedCredits)
    || consumedCredits <= 0
    || typeof newBalance !== "number"
    || !Number.isSafeInteger(newBalance)
    || newBalance < 0
    || consumedCredits > 2_147_483_647 - newBalance) {
    throw new Error("Availability import credit metadata is invalid during user deletion.");
  }
  return { consumedCredits, newBalance };
}

function nonnegativeCount(value: number | bigint): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function integer(value: number | bigint | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nonnegativeInteger(value: number | bigint | null): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

export async function unassignEditableShiftsForDeletedUser(
  tx: TenantPrismaTransaction,
  tenantId: string,
  userId: string,
): Promise<number> {
  await lockTenantSchedulingMutations(tx, tenantId);
  return unassignEditableShiftsForIneligibleUser(tx, tenantId, userId);
}

export async function anonymizeDeletedUser(
  tx: TenantPrismaTransaction,
  tenantId: string,
  userId: string,
  deletedAt: Date,
): Promise<DeletedUserCleanup> {
  const cleanup = await cancelAvailabilityImports(
    tx,
    tenantId,
    userId,
    deletedAt,
  );
  await unassignEditableShiftsForIneligibleUser(tx, tenantId, userId);
  const invitationDiagnosticsEraseAfter = new Date(
    deletedAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
  );
  await tx.staffInvitationOutbox.updateMany({
    where: {
      tenantId,
      userId,
      status: { in: ["PENDING", "SENDING", "FAILED"] },
    },
    data: {
      status: "CANCELLED",
      retryAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      encryptedPayload: null,
      encryptionNonce: null,
      encryptionTag: null,
      encryptionKeyRef: null,
      payloadErasedAt: deletedAt,
      diagnosticsEraseAfter: invitationDiagnosticsEraseAfter,
      cancelledAt: deletedAt,
      lastErrorCode: "USER_DELETED",
    },
  });

  const anonymized = await tx.user.updateMany({
    where: { id: userId, tenantId, deletedAt: null },
    data: {
      name: DELETED_USER_NAME,
      email: null,
      username: null,
      emailEncrypted: null,
      emailHash: null,
      nameEncrypted: null,
      phone: null,
      phoneEncrypted: null,
      phoneHash: null,
      oidcIssuer: null,
      oidcSubject: null,
      passwordHash: null,
      pinHash: null,
      pinSetAt: null,
      pinResetRequired: false,
      pinLoginAttempts: 0,
      pinLockedUntil: null,
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: [],
      loginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: null,
      emailDeliverySuppressedAt: null,
      emailDeliverySuppressionReason: null,
      emailDeliveryLastEventAt: null,
      deletedAt,
    },
  });
  if (anonymized.count !== 1) {
    throw new Error("Cannot delete user because the locked account changed during cleanup.");
  }

  await tx.availabilityImportJob.updateMany({
    where: { tenantId, requestedByUserId: userId },
    data: { requestedByUserId: null },
  });
  await tx.refreshTokenReplay.deleteMany({ where: { session: { userId } } });
  await tx.$executeRaw(Prisma.sql`
        UPDATE "Session"
        SET "selectorHash" = NULL,
            "refreshToken" = encode(public.digest('deleted-session:' || "id", 'sha256'), 'hex'),
            "ipAddress" = '[deleted]',
            "userAgent" = '[deleted]',
            "revokedAt" = ${deletedAt}
        WHERE "userId" = ${userId}
    `);
  await tx.passwordResetEmailOutbox.deleteMany({ where: { tenantId, userId } });
  await tx.passwordResetToken.deleteMany({ where: { tenantId, userId } });
  await tx.mfaTotpClaim.deleteMany({ where: { tenantId, userId } });
  await tx.roleAssignment.deleteMany({ where: { tenantId, userId } });
  await tx.onboardingSignupAttempt.deleteMany({ where: { tenantId, userId } });
  await tx.notificationOutbox.deleteMany({ where: { tenantId, userId } });
  await tx.notification.deleteMany({ where: { tenantId, userId } });
  return cleanup;
}
