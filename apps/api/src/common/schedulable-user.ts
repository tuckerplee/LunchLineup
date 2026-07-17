import { Prisma, UserRole } from '@prisma/client';
import { TenantPrismaTransaction } from '../database/tenant-prisma.service';

export const SCHEDULABLE_USER_ROLES: UserRole[] = [UserRole.MANAGER, UserRole.STAFF];

export const ACTIVE_SCHEDULABLE_USER_FILTER = {
    role: { in: SCHEDULABLE_USER_ROLES },
    deletedAt: null,
    suspendedAt: null,
};

type LockedSchedulableUser = {
    id: string;
};

type LockedAssignedShift = {
    id: string;
    scheduleId: string | null;
    scheduleTenantId: string | null;
    scheduleStatus: string | null;
    scheduleDeletedAt: Date | null;
};

const SCHEDULE_STATUSES = new Set(['DRAFT', 'PUBLISHED', 'ARCHIVED']);

export async function lockTenantSchedulingMutations(
    tx: TenantPrismaTransaction,
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

export async function lockActiveSchedulableUser(
    tx: TenantPrismaTransaction,
    tenantId: string,
    userId: string,
): Promise<LockedSchedulableUser | null> {
    const rows = await tx.$queryRaw<LockedSchedulableUser[]>`
        SELECT "id"
        FROM "User"
        WHERE "id" = ${userId}
          AND "tenantId" = ${tenantId}
          AND "role" IN (${UserRole.MANAGER}::"UserRole", ${UserRole.STAFF}::"UserRole")
          AND "deletedAt" IS NULL
          AND "suspendedAt" IS NULL
        FOR UPDATE
    `;
    return rows[0] ?? null;
}

export async function unassignEditableShiftsForIneligibleUser(
    tx: TenantPrismaTransaction,
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
