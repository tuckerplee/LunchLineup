import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  anonymizeDeletedUser,
  DELETED_USER_NAME,
  unassignEditableShiftsForDeletedUser,
} from "./user-deletion";

function shiftCleanupTransaction(
  assignedShifts: Array<{
    id: string;
    scheduleId: string | null;
    scheduleTenantId: string | null;
    scheduleStatus: string | null;
    scheduleDeletedAt: Date | null;
  }>,
  updatedCount = assignedShifts.filter(
    (shift) =>
      shift.scheduleId === null ||
      (shift.scheduleStatus === "DRAFT" && shift.scheduleDeletedAt === null),
  ).length,
  revisedCount = new Set(
    assignedShifts
      .filter(
        (shift) =>
          shift.scheduleId !== null &&
          shift.scheduleStatus === "DRAFT" &&
          shift.scheduleDeletedAt === null,
      )
      .map((shift) => shift.scheduleId),
  ).size,
) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: "tenant-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(assignedShifts),
    shift: { updateMany: vi.fn().mockResolvedValue({ count: updatedCount }) },
    schedule: {
      updateMany: vi.fn().mockResolvedValue({ count: revisedCount }),
    },
    timeCard: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe("unassignEditableShiftsForDeletedUser", () => {
  it("unassigns editable shifts and increments each distinct affected draft once", async () => {
    const tx = shiftCleanupTransaction([
      {
        id: "shift-draft",
        scheduleId: "schedule-draft",
        scheduleTenantId: "tenant-1",
        scheduleStatus: "DRAFT",
        scheduleDeletedAt: null,
      },
      {
        id: "shift-draft-second",
        scheduleId: "schedule-draft",
        scheduleTenantId: "tenant-1",
        scheduleStatus: "DRAFT",
        scheduleDeletedAt: null,
      },
      {
        id: "shift-reopened",
        scheduleId: "schedule-reopened",
        scheduleTenantId: "tenant-1",
        scheduleStatus: "DRAFT",
        scheduleDeletedAt: null,
      },
      {
        id: "shift-schedule-less",
        scheduleId: null,
        scheduleTenantId: null,
        scheduleStatus: null,
        scheduleDeletedAt: null,
      },
    ]);

    await expect(
      unassignEditableShiftsForDeletedUser(tx as never, "tenant-1", "user-1"),
    ).resolves.toBe(4);

    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            "shift-draft",
            "shift-draft-second",
            "shift-reopened",
            "shift-schedule-less",
          ],
        },
        tenantId: "tenant-1",
        userId: "user-1",
        deletedAt: null,
      },
      data: { userId: null },
    });
    expect(tx.schedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["schedule-draft", "schedule-reopened"] },
        tenantId: "tenant-1",
        status: "DRAFT",
        deletedAt: null,
      },
      data: { revision: { increment: 1 } },
    });
    expect(tx.shift.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.schedule.updateMany.mock.invocationCallOrder[0],
    );
    const schedulingLock = tx.$executeRaw.mock.calls[0][0];
    expect(schedulingLock.strings.join(" ")).toContain("pg_advisory_xact_lock");
    expect(schedulingLock.values).toEqual(["lunchlineup:scheduling:tenant-1"]);
    const tenantRowsLock = tx.$queryRaw.mock.calls[0][0];
    expect(tenantRowsLock.strings.join(" ")).toContain('FROM "Tenant"');
    expect(tenantRowsLock.strings.join(" ")).toContain("FOR UPDATE");
    const scheduleRowsLock = tx.$queryRaw.mock.calls[1][0];
    expect(scheduleRowsLock.strings.join(" ")).toContain(
      'ORDER BY schedule_row."id"',
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[1],
    );
  });

  it("leaves already unassigned shifts untouched", async () => {
    const tx = shiftCleanupTransaction([]);

    await expect(
      unassignEditableShiftsForDeletedUser(tx as never, "tenant-1", "user-1"),
    ).resolves.toBe(0);

    expect(tx.shift.updateMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    const assignedShiftLock = tx.$queryRaw.mock.calls[2][0];
    expect(assignedShiftLock.strings.join(" ")).toContain(
      'shift_row."userId" =',
    );
    expect(assignedShiftLock.values).toEqual(["tenant-1", "user-1"]);
  });

  it("preserves published and archived assignments and all time-card references", async () => {
    const tx = shiftCleanupTransaction([
      {
        id: "shift-published",
        scheduleId: "schedule-published",
        scheduleTenantId: "tenant-1",
        scheduleStatus: "PUBLISHED",
        scheduleDeletedAt: null,
      },
      {
        id: "shift-archived",
        scheduleId: "schedule-archived",
        scheduleTenantId: "tenant-1",
        scheduleStatus: "ARCHIVED",
        scheduleDeletedAt: null,
      },
    ]);

    await expect(
      unassignEditableShiftsForDeletedUser(tx as never, "tenant-1", "user-1"),
    ).resolves.toBe(0);

    expect(tx.shift.updateMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    expect(tx.timeCard.updateMany).not.toHaveBeenCalled();
    expect(tx.timeCard.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when an assigned shift has an inconsistent schedule reference", async () => {
    const tx = shiftCleanupTransaction([
      {
        id: "shift-cross-tenant",
        scheduleId: "schedule-foreign",
        scheduleTenantId: "tenant-2",
        scheduleStatus: "DRAFT",
        scheduleDeletedAt: null,
      },
    ]);

    await expect(
      unassignEditableShiftsForDeletedUser(tx as never, "tenant-1", "user-1"),
    ).rejects.toThrow("inconsistent schedule reference");
    expect(tx.shift.updateMany).not.toHaveBeenCalled();
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when every locked editable assignment cannot be cleared", async () => {
    const tx = shiftCleanupTransaction(
      [
        {
          id: "shift-draft",
          scheduleId: "schedule-draft",
          scheduleTenantId: "tenant-1",
          scheduleStatus: "DRAFT",
          scheduleDeletedAt: null,
        },
      ],
      0,
    );

    await expect(
      unassignEditableShiftsForDeletedUser(tx as never, "tenant-1", "user-1"),
    ).rejects.toThrow("assignments changed during cleanup");
    expect(tx.schedule.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when every affected draft revision cannot be incremented", async () => {
    const tx = shiftCleanupTransaction(
      [
        {
          id: "shift-draft-a",
          scheduleId: "schedule-a",
          scheduleTenantId: "tenant-1",
          scheduleStatus: "DRAFT",
          scheduleDeletedAt: null,
        },
        {
          id: "shift-draft-b",
          scheduleId: "schedule-b",
          scheduleTenantId: "tenant-1",
          scheduleStatus: "DRAFT",
          scheduleDeletedAt: null,
        },
      ],
      2,
      1,
    );

    await expect(
      unassignEditableShiftsForDeletedUser(tx as never, "tenant-1", "user-1"),
    ).rejects.toThrow("affected draft schedule changed during cleanup");
  });
});

describe("anonymizeDeletedUser", () => {
  it("atomically tombstones direct PII, credentials, sessions, and recovery material", async () => {
    const tx = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      availabilityImportJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "tenant-1" }])
        .mockResolvedValueOnce([{ id: "user-1" }])
        .mockResolvedValueOnce([
          {
            id: "import-1",
            status: "PENDING",
            storageKey: "11111111-1111-1111-1111-111111111111.pdf",
            creditConsumption: { source: "credits", consumedCredits: 1, newBalance: 5 },
            debitCount: 1,
            debitTenantId: "tenant-1",
            debitAmount: -1,
            debitReason: "Availability PDF import (import-1)",
            debitBalanceAfter: 5,
            refundCount: 0,
            refundTenantId: null,
            refundAmount: null,
            refundReason: null,
            refundBalanceAfter: null,
          },
          {
            id: "import-2",
            status: "SUCCEEDED",
            storageKey: "22222222-2222-2222-2222-222222222222.pdf",
            creditConsumption: { source: "credits", consumedCredits: 1, newBalance: 4 },
            debitCount: 1,
            debitTenantId: "tenant-1",
            debitAmount: -1,
            debitReason: "Availability PDF import (import-2)",
            debitBalanceAfter: 4,
            refundCount: 0,
            refundTenantId: null,
            refundAmount: null,
            refundReason: null,
            refundBalanceAfter: null,
          },
          {
            id: "import-3",
            status: "FAILED",
            storageKey: null,
            creditConsumption: { source: "credits", consumedCredits: 1, newBalance: 3 },
            debitCount: 1,
            debitTenantId: "tenant-1",
            debitAmount: -1,
            debitReason: "Availability PDF import (import-3)",
            debitBalanceAfter: 3,
            refundCount: 1,
            refundTenantId: "tenant-1",
            refundAmount: 1,
            refundReason: "Availability PDF import refund (import-3)",
            refundBalanceAfter: 4,
          },
        ])
        .mockResolvedValueOnce([{ usageCredits: 6 }])
        .mockResolvedValueOnce([{ amount: 1, balanceAfter: 6 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      $executeRaw: vi.fn().mockResolvedValue(2),
      shift: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      schedule: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      passwordResetEmailOutbox: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      staffInvitationOutbox: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      passwordResetToken: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      mfaTotpClaim: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      roleAssignment: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      onboardingSignupAttempt: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      notificationOutbox: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      notification: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      refreshTokenReplay: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const deletedAt = new Date("2026-07-13T12:00:00.000Z");

    const cleanup = await anonymizeDeletedUser(
      tx as never,
      "tenant-1",
      "user-1",
      deletedAt,
    );

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", tenantId: "tenant-1", deletedAt: null },
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

    expect(tx.availabilityImportJob.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        tenantId: "tenant-1",
        userId: "user-1",
        status: { not: "SUCCEEDED" },
      },
      data: {
        status: "CANCELLED",
        publicationStatus: "FAILED",
        publishToken: null,
        publishLeaseUntil: null,
        publicationAmbiguous: false,
        publishLastError: null,
        storageKey: null,
        parsedAvailability: Prisma.DbNull,
        encryptedSourcePayload: null,
        resultErasedAt: deletedAt,
        failureCode: "USER_DELETED",
        executionToken: null,
        executionLeaseUntil: null,
        completedAt: deletedAt,
      },
    });
    expect(tx.availabilityImportJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: "tenant-1",
        userId: "user-1",
        status: "SUCCEEDED",
      },
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
    expect(tx.staffInvitationOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        userId: "user-1",
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
        diagnosticsEraseAfter: new Date("2026-08-12T12:00:00.000Z"),
        cancelledAt: deletedAt,
        lastErrorCode: "USER_DELETED",
      },
    });
    expect(cleanup).toEqual({
      availabilityImportStorageKeys: [
        "11111111-1111-1111-1111-111111111111.pdf",
        "22222222-2222-2222-2222-222222222222.pdf",
      ],
      refundedAvailabilityImportCredits: 2,
    });
    const walletQuery = tx.$queryRaw.mock.calls[3][0];
    expect(walletQuery.strings.join(" ")).toContain('UPDATE "Tenant"');
    expect(walletQuery.strings.join(" ")).toContain('RETURNING "usageCredits"');
    const refundQuery = tx.$queryRaw.mock.calls[4][0];

    expect(refundQuery.values).toContain(
      "feature-refund-availability-import:import-1",
    );
    expect(refundQuery.values).not.toContain(
      "feature-refund-availability-import:import-2",
    );
    expect(refundQuery.values).not.toContain(
      "feature-refund-availability-import:import-3",
    );
    expect(refundQuery.strings.join(" ")).toContain('"balanceAfter"');
    expect(refundQuery.values).toContain(6);
    expect(tx.availabilityImportJob.updateMany).toHaveBeenNthCalledWith(3, {
      where: { tenantId: "tenant-1", requestedByUserId: "user-1" },
      data: { requestedByUserId: null },
    });
    expect(tx.refreshTokenReplay.deleteMany).toHaveBeenCalledWith({
      where: { session: { userId: "user-1" } },
    });

    const sessionQuery = tx.$executeRaw.mock.calls
      .map(([query]) => query)
      .find((query) => query.strings.join(" ").includes('UPDATE "Session"'));
    expect(sessionQuery).toBeDefined();
    expect(sessionQuery.strings.join(" ")).toContain('UPDATE "Session"');
    expect(sessionQuery.strings.join(" ")).toContain('"selectorHash" = NULL');
    expect(sessionQuery.strings.join(" ")).toContain(
      "'deleted-session:' || \"id\"",
    );
    expect(sessionQuery.strings.join(" ")).toContain(
      "\"ipAddress\" = '[deleted]'",
    );
    expect(sessionQuery.strings.join(" ")).toContain('\"revokedAt\" =');
    expect(sessionQuery.values).toEqual([deletedAt, "user-1"]);

    for (const delegate of [
      tx.passwordResetEmailOutbox,
      tx.passwordResetToken,
      tx.mfaTotpClaim,
      tx.roleAssignment,
      tx.onboardingSignupAttempt,
      tx.notificationOutbox,
      tx.notification,
    ]) {
      expect(delegate.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", userId: "user-1" },
      });
    }
  });

  it.each([
    ["malformed metadata", {
      creditConsumption: { consumedCredits: 1 },
      debitBalanceAfter: 5,
      refundCount: 0,
      refundBalanceAfter: null,
    }],
    ["missing debit balance", {
      creditConsumption: { source: "credits", consumedCredits: 1, newBalance: 5 },
      debitBalanceAfter: null,
      refundCount: 0,
      refundBalanceAfter: null,
    }],
    ["missing replay balance", {
      creditConsumption: { source: "credits", consumedCredits: 1, newBalance: 5 },
      debitBalanceAfter: 5,
      refundCount: 1,
      refundBalanceAfter: null,
    }],
  ])("fails closed for %s before deleting user state", async (_label, overrides) => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "tenant-1" }])
        .mockResolvedValueOnce([{ id: "user-1" }])
        .mockResolvedValueOnce([{
          id: "import-1",
          status: "FAILED",
          storageKey: null,
          debitCount: 1,
          debitTenantId: "tenant-1",
          debitAmount: -1,
          debitReason: "Availability PDF import (import-1)",
          refundTenantId: "tenant-1",
          refundAmount: 1,
          refundReason: "Availability PDF import refund (import-1)",
          ...overrides,
        }]),
      availabilityImportJob: { updateMany: vi.fn() },
      user: { updateMany: vi.fn() },
    };

    await expect(anonymizeDeletedUser(
      tx as never,
      "tenant-1",
      "user-1",
      new Date("2026-07-13T12:00:00.000Z"),
    )).rejects.toThrow(/credit metadata|provenance/i);

    expect(tx.availabilityImportJob.updateMany).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
  });
});
