import { unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '../platform/database';

type LockedAssignedShift = {
    id: string;
    scheduleId: string | null;
    scheduleTenantId: string | null;
    scheduleStatus: string | null;
    scheduleDeletedAt: Date | null;
};

const SCHEDULE_STATUSES = new Set(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export async function lockTenantSchedulingMutations(
    tx: TenantTransaction,
    tenantId: string,
    tenantAlreadyLocked = false,
): Promise<void> {
    if (!tenantAlreadyLocked) {
        await tx.$queryRaw(Prisma.sql`
            SELECT "id"
            FROM "Tenant"
            WHERE "id" = ${tenantId}
            FOR UPDATE
        `);
    }
    await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
            hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0)
        )
    `);
}
export async function unassignEditableShiftsForIneligibleUser(
    tx: TenantTransaction,
    tenantId: string,
    userId: string,
): Promise<number> {
    await tx.$queryRaw(Prisma.sql`
        SELECT schedule_row."id"
        FROM "Schedule" schedule_row
        WHERE EXISTS (
            SELECT 1
            FROM "Shift" shift_row
            WHERE shift_row."scheduleId" = schedule_row."id"
              AND shift_row."tenantId" = ${tenantId}
              AND shift_row."userId" = ${userId}
              AND shift_row."deletedAt" IS NULL
        )
        ORDER BY schedule_row."id"
        FOR UPDATE OF schedule_row
    `);
    const assignedShifts = await tx.$queryRaw<LockedAssignedShift[]>(Prisma.sql`
        SELECT
            shift_row."id",
            shift_row."scheduleId",
            schedule_row."tenantId" AS "scheduleTenantId",
            schedule_row."status"::text AS "scheduleStatus",
            schedule_row."deletedAt" AS "scheduleDeletedAt"
        FROM "Shift" shift_row
        LEFT JOIN "Schedule" schedule_row
          ON schedule_row."id" = shift_row."scheduleId"
        WHERE shift_row."tenantId" = ${tenantId}
          AND shift_row."userId" = ${userId}
          AND shift_row."deletedAt" IS NULL
        ORDER BY shift_row."id"
        FOR UPDATE OF shift_row
    `);

    const inconsistentShift = assignedShifts.find(
        (shift) =>
            shift.scheduleId !== null &&
            (shift.scheduleTenantId !== tenantId ||
                shift.scheduleStatus === null ||
                !SCHEDULE_STATUSES.has(shift.scheduleStatus)),
    );
    if (inconsistentShift) {
        throw new Error(
            `Cannot make user ineligible while shift ${inconsistentShift.id} has an inconsistent schedule reference.`,
        );
    }

    const editableShiftIds = assignedShifts
        .filter(
            (shift) =>
                shift.scheduleId === null ||
                (shift.scheduleStatus === 'DRAFT' && shift.scheduleDeletedAt === null),
        )
        .map((shift) => shift.id);
    if (editableShiftIds.length === 0) return 0;
    const affectedDraftScheduleIds = Array.from(
        new Set(
            assignedShifts
                .filter(
                    (shift) =>
                        shift.scheduleId !== null &&
                        shift.scheduleStatus === 'DRAFT' &&
                        shift.scheduleDeletedAt === null,
                )
                .map((shift) => shift.scheduleId as string),
        ),
    ).sort();

    const unassigned = await tx.shift.updateMany({
        where: {
            id: { in: editableShiftIds },
            tenantId,
            userId,
            deletedAt: null,
        },
        data: { userId: null },
    });
    if (unassigned.count !== editableShiftIds.length) {
        throw new Error(
            'Cannot make user ineligible because editable shift assignments changed during cleanup.',
        );
    }
    if (affectedDraftScheduleIds.length > 0) {
        const revised = await tx.schedule.updateMany({
            where: {
                id: { in: affectedDraftScheduleIds },
                tenantId,
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
        if (revised.count !== affectedDraftScheduleIds.length) {
            throw new Error(
                'Cannot make user ineligible because an affected draft schedule changed during cleanup.',
            );
        }
    }
    return unassigned.count;
}



export const DELETED_USER_NAME = "Deleted user";

type LockedAvailabilityImport = {
  id: string;
  status: string;
  storageKey: string | null;
  creditConsumption: Prisma.JsonValue | null;
  debitCount: number | bigint;
  debitTenantId: string | null;
  debitAmount: number | bigint | null;
  debitDebtAmount: number | bigint | null;
  debitReason: string | null;
  debitBalanceAfter: number | bigint | null;
  debitDebtAfter: number | bigint | null;
  refundCount: number | bigint;
  refundTenantId: string | null;
  refundAmount: number | bigint | null;
  refundDebtAmount: number | bigint | null;
  refundReason: string | null;
  refundBalanceAfter: number | bigint | null;
  refundDebtAfter: number | bigint | null;
};

export type DeletedUserCleanup = {
  availabilityImportStorageKeys: string[];
  refundedAvailabilityImportCredits: number;
};

async function cancelAvailabilityImports(
  tx: TenantTransaction,
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
            debit."debtAmount" AS "debitDebtAmount",
            debit."reason" AS "debitReason",
            debit."balanceAfter" AS "debitBalanceAfter",
            debit."debtAfter" AS "debitDebtAfter",
            refund."count" AS "refundCount",
            refund."tenantId" AS "refundTenantId",
            refund."amount" AS "refundAmount",
            refund."debtAmount" AS "refundDebtAmount",
            refund."reason" AS "refundReason",
            refund."balanceAfter" AS "refundBalanceAfter",
            refund."debtAfter" AS "refundDebtAfter"
        FROM "AvailabilityImportJob" job
        CROSS JOIN LATERAL (
                SELECT COUNT(*)::integer AS "count",
                       MIN(debit."tenantId") AS "tenantId",
                       MIN(debit."amount") AS "amount",
                       MIN(debit."debtAmount") AS "debtAmount",
                       MIN(debit."reason") AS "reason",
                       MIN(debit."balanceAfter") AS "balanceAfter",
                       MIN(debit."debtAfter") AS "debtAfter"
                FROM "CreditTransaction" debit
                WHERE debit."id" = 'feature-usage-availability-import:' || job."id"
        ) debit
        CROSS JOIN LATERAL (
                SELECT COUNT(*)::integer AS "count",
                       MIN(refund."tenantId") AS "tenantId",
                       MIN(refund."amount") AS "amount",
                       MIN(refund."debtAmount") AS "debtAmount",
                       MIN(refund."reason") AS "reason",
                       MIN(refund."balanceAfter") AS "balanceAfter",
                       MIN(refund."debtAfter") AS "debtAfter"
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
      && integer(job.debitDebtAmount) === 0
      && job.debitReason === `Availability PDF import (${job.id})`
      && nonnegativeInteger(job.debitBalanceAfter) === settlement.newBalance
      && nonnegativeInteger(job.debitDebtAfter) === 0;
    if (!debitIsExact) {
      throw new Error("Availability import debit provenance is invalid during user deletion.");
    }
    const refundId = `feature-refund-availability-import:${job.id}`;
    const refundReason = `Availability PDF import refund (${job.id})`;
    const refundCount = nonnegativeCount(job.refundCount);
    if (refundCount === 1) {
      const refundAmount = nonnegativeInteger(job.refundAmount);
      const refundDebtAmount = integer(job.refundDebtAmount);
      if (job.refundTenantId !== tenantId
        || refundAmount === null
        || refundDebtAmount === null
        || refundDebtAmount > 0
        || refundAmount - refundDebtAmount !== consumedCredits
        || job.refundReason !== refundReason
        || nonnegativeInteger(job.refundBalanceAfter) === null
        || nonnegativeInteger(job.refundDebtAfter) === null) {
        throw new Error("Availability import refund provenance is invalid during user deletion.");
      }
      refundedAvailabilityImportCredits += consumedCredits;
      continue;
    }
    if (refundCount !== 0) {
      throw new Error("Availability import refund provenance is invalid during user deletion.");
    }
    const settled = await tx.$queryRaw<Array<{
      transactionId: string;
      creditedValue: number | bigint;
      spendableAmount: number | bigint;
      repaidDebt: number | bigint;
      newBalance: number | bigint;
      debtAfter: number | bigint;
      replayed: boolean;
    }>>(Prisma.sql`
            SELECT *
            FROM public.settle_positive_credit_value(
                ${tenantId},
                ${consumedCredits},
                ${refundReason},
                ${refundId}
            )
        `);
    const result = settled[0];
    const creditedValue = integer(result?.creditedValue ?? null);
    const spendableAmount = nonnegativeInteger(result?.spendableAmount ?? null);
    const repaidDebt = nonnegativeInteger(result?.repaidDebt ?? null);
    if (settled.length !== 1
      || result?.transactionId !== refundId
      || creditedValue !== consumedCredits
      || spendableAmount === null
      || repaidDebt === null
      || spendableAmount + repaidDebt !== consumedCredits
      || nonnegativeInteger(result?.newBalance ?? null) === null
      || nonnegativeInteger(result?.debtAfter ?? null) === null
      || result?.replayed !== false) {
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
  tx: TenantTransaction,
  tenantId: string,
  userId: string,
): Promise<number> {
  await lockTenantSchedulingMutations(tx, tenantId);
  return unassignEditableShiftsForIneligibleUser(tx, tenantId, userId);
}

export async function anonymizeDeletedUser(
  tx: TenantTransaction,
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



/**
 * Deletes only validated local availability-import files after the database
 * transaction commits. The durable cleanup leaves orphan recovery to the
 * bounded worker sweep when a filesystem operation cannot complete.
 */
export async function deleteAvailabilityImportStorageKeys(
  storageKeys: readonly string[],
  uploadRoot = process.env.AVAILABILITY_UPLOAD_ROOT || '/app/uploads',
): Promise<void> {
  const root = resolve(uploadRoot);
  await Promise.all(storageKeys.map(async (storageKey) => {
    if (!/^[a-f0-9-]{36}\.pdf$/i.test(storageKey)) return;
    const filePath = resolve(join(root, storageKey));
    if (filePath === root || !filePath.startsWith(`${root}${sep}`)) return;
    try {
      await unlink(filePath);
    } catch {
      // A bounded orphan sweep recovers a file that cannot be removed here.
    }
  }));
}
