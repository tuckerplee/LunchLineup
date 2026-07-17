import { BadRequestException } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';

export type TenantRetentionSubject = {
    id: string;
    slug?: string | null;
    status: TenantStatus | string;
    deletedAt: Date | null;
    applicationDataPurgedAt?: Date | null;
    retentionLegalHoldAt?: Date | null;
    retentionLegalHoldReason?: string | null;
    retentionLegalHoldByUserId?: string | null;
};

export const TENANT_CUSTOMER_CANCELLATION_INTENT_SETTING_KEY =
    'internal:tenant-lifecycle-intent:customer_cancellation';

type ScheduledTenantCancellationProjection = {
    lifecycleStatus: 'CANCELLATION_SCHEDULED';
    cancellationEffectiveAt: string;
};

export const TENANT_RETENTION_POLICY = {
    archivedTenantApplicationDataDays: 30,
    databaseBackupDays: 35,
    securityLogDays: 90,
    retainedDatabaseRecordYears: 7,
    retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'payrollRecords', 'auditLogs', 'databaseBackups', 'securityLogs'],
} as const;

export const DORMANT_SESSION_RETENTION_POLICY = {
    expiredGraceHours: 24,
    revokedRetentionDays: 30,
    batchLimit: 5_000,
} as const;

export const PASSWORD_RESET_TOKEN_RETENTION_POLICY = {
    terminalGraceHours: 24,
    batchLimit: 5_000,
} as const;

function retentionCount(value: bigint | number | string | undefined, label: string): number {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`${label} returned an invalid count.`);
    }
    return count;
}

export async function applyDormantSessionRetention(
    tx: Prisma.TransactionClient,
    asOf: Date,
    dryRun: boolean,
) {
    const expiredBefore = new Date(
        asOf.getTime() - DORMANT_SESSION_RETENTION_POLICY.expiredGraceHours * 60 * 60 * 1_000,
    );
    const revokedBefore = new Date(
        asOf.getTime() - DORMANT_SESSION_RETENTION_POLICY.revokedRetentionDays * 24 * 60 * 60 * 1_000,
    );
    const eligibleRows = await tx.$queryRaw<Array<{ eligibleCount: bigint | number | string }>>(
        Prisma.sql`
            SELECT COUNT(*) AS "eligibleCount"
            FROM "Session"
            WHERE "expiresAt" <= ${expiredBefore}
               OR ("revokedAt" IS NOT NULL AND "revokedAt" <= ${revokedBefore})
        `,
    );
    const eligibleCount = retentionCount(eligibleRows[0]?.eligibleCount, 'Dormant session retention count');
    const batchLimit = DORMANT_SESSION_RETENTION_POLICY.batchLimit;
    let purgedCount = 0;
    if (!dryRun && eligibleCount > 0) {
        const purgedRows = await tx.$queryRaw<Array<{ purgedCount: bigint | number | string }>>(
            Prisma.sql`SELECT public.purge_dormant_sessions(${asOf}, ${batchLimit}) AS "purgedCount"`,
        );
        purgedCount = retentionCount(purgedRows[0]?.purgedCount, 'Dormant session retention purge');
    }

    return {
        ...DORMANT_SESSION_RETENTION_POLICY,
        expiredBefore: expiredBefore.toISOString(),
        revokedBefore: revokedBefore.toISOString(),
        eligibleCount,
        purgedCount,
    };
}

export async function applyPasswordResetTokenRetention(
    tx: Prisma.TransactionClient,
    asOf: Date,
    dryRun: boolean,
) {
    const terminalBefore = new Date(
        asOf.getTime() - PASSWORD_RESET_TOKEN_RETENTION_POLICY.terminalGraceHours * 60 * 60 * 1_000,
    );
    const eligibleRows = await tx.$queryRaw<Array<{ eligibleCount: bigint | number | string }>>(
        Prisma.sql`
            SELECT COUNT(*) AS "eligibleCount"
            FROM "PasswordResetToken"
            WHERE COALESCE("consumedAt", "expiresAt") <= ${terminalBefore}
        `,
    );
    const eligibleCount = retentionCount(
        eligibleRows[0]?.eligibleCount,
        'Password reset token retention count',
    );
    const batchLimit = PASSWORD_RESET_TOKEN_RETENTION_POLICY.batchLimit;
    let purgedCount = 0;
    if (!dryRun && eligibleCount > 0) {
        const purgedRows = await tx.$queryRaw<Array<{ purgedCount: bigint | number | string }>>(
            Prisma.sql`SELECT public.purge_expired_password_reset_tokens(${asOf}, ${batchLimit}) AS "purgedCount"`,
        );
        purgedCount = retentionCount(
            purgedRows[0]?.purgedCount,
            'Password reset token retention purge',
        );
    }

    return {
        ...PASSWORD_RESET_TOKEN_RETENTION_POLICY,
        terminalBefore: terminalBefore.toISOString(),
        eligibleCount,
        purgedCount,
    };
}

type DeleteManyResult = {
    count: number;
};

type JsonRecord = Record<string, unknown>;
type BillingMetadataValue = string | number | boolean | string[];

export function normalizeTenantConfirmation(value: unknown): string {
    if (typeof value !== 'string') {
        throw new BadRequestException('confirmation must match the tenant slug.');
    }

    const confirmation = value.trim().toLowerCase();
    if (!confirmation) {
        throw new BadRequestException('confirmation must match the tenant slug.');
    }

    return confirmation;
}

export function assertTenantSlugConfirmation(confirmation: string, slug: string): void {
    if (confirmation !== slug.toLowerCase()) {
        throw new BadRequestException('confirmation must match the tenant slug.');
    }
}

function addUtcDays(date: Date, days: number): Date {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

function addUtcYears(date: Date, years: number): Date {
    const result = new Date(date.getTime());
    result.setUTCFullYear(result.getUTCFullYear() + years);
    return result;
}

export function buildTenantRetentionSchedule(deletionRequestedAt: Date) {
    const applicationDataEligibleAt = addUtcDays(
        deletionRequestedAt,
        TENANT_RETENTION_POLICY.archivedTenantApplicationDataDays,
    );
    const databaseBackupEligibleAt = addUtcDays(
        deletionRequestedAt,
        TENANT_RETENTION_POLICY.databaseBackupDays,
    );
    const securityLogEligibleAt = addUtcDays(
        deletionRequestedAt,
        TENANT_RETENTION_POLICY.securityLogDays,
    );
    const retainedDatabaseRecordsEligibleAt = addUtcYears(
        deletionRequestedAt,
        TENANT_RETENTION_POLICY.retainedDatabaseRecordYears,
    );

    return {
        deletionRequestedAt: deletionRequestedAt.toISOString(),
        applicationDataEligibleAt: applicationDataEligibleAt.toISOString(),
        databaseBackupEligibleAt: databaseBackupEligibleAt.toISOString(),
        securityLogEligibleAt: securityLogEligibleAt.toISOString(),
        retainedDatabaseRecordsEligibleAt: retainedDatabaseRecordsEligibleAt.toISOString(),
        fullDatabasePurgeEligibleAt: retainedDatabaseRecordsEligibleAt.toISOString(),
        retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
    };
}

export function getExpiredTenantRetentionCutoff(asOf: Date): Date {
    return addUtcYears(asOf, -TENANT_RETENTION_POLICY.retainedDatabaseRecordYears);
}

export function getExpiredTenantApplicationDataCutoff(asOf: Date): Date {
    return addUtcDays(asOf, -TENANT_RETENTION_POLICY.archivedTenantApplicationDataDays);
}

export function isTenantRetentionLegalHoldActive(tenant: TenantRetentionSubject): boolean {
    return tenant.retentionLegalHoldAt instanceof Date;
}

export function isTenantReadyForApplicationDataPurge(tenant: TenantRetentionSubject, asOf: Date): boolean {
    if (isTenantRetentionLegalHoldActive(tenant)) return false;
    if (tenant.status !== TenantStatus.PURGED || !tenant.deletedAt || tenant.applicationDataPurgedAt) return false;
    return tenant.deletedAt.getTime() <= getExpiredTenantApplicationDataCutoff(asOf).getTime();
}

export function buildExpiredTenantApplicationDataWhere(asOf: Date): Prisma.TenantWhereInput {
    return {
        status: TenantStatus.PURGED,
        deletedAt: { lte: getExpiredTenantApplicationDataCutoff(asOf) },
        applicationDataPurgedAt: null,
        retentionLegalHoldAt: null,
    };
}

export function isTenantReadyForRetentionPurge(tenant: TenantRetentionSubject, asOf: Date): boolean {
    if (isTenantRetentionLegalHoldActive(tenant)) return false;
    if (tenant.status !== TenantStatus.PURGED) return false;
    if (!tenant.deletedAt) return false;
    return tenant.deletedAt.getTime() <= getExpiredTenantRetentionCutoff(asOf).getTime();
}

export function buildExpiredTenantRetentionWhere(asOf: Date): Prisma.TenantWhereInput {
    return {
        status: TenantStatus.PURGED,
        deletedAt: { lte: getExpiredTenantRetentionCutoff(asOf) },
        retentionLegalHoldAt: null,
    };
}

export function serializeTenantRetentionCandidate(tenant: TenantRetentionSubject, asOf: Date) {
    return {
        id: tenant.id,
        slug: tenant.slug ?? null,
        status: tenant.status,
        eligibleForDatabasePurge: isTenantReadyForRetentionPurge(tenant, asOf),
        eligibleForApplicationDataPurge: isTenantReadyForApplicationDataPurge(tenant, asOf),
        applicationDataPurgedAt: tenant.applicationDataPurgedAt?.toISOString() ?? null,
        legalHold: tenant.retentionLegalHoldAt ? {
            placedAt: tenant.retentionLegalHoldAt.toISOString(),
            reason: tenant.retentionLegalHoldReason ?? null,
            placedByUserId: tenant.retentionLegalHoldByUserId ?? null,
        } : null,
        retention: tenant.deletedAt ? buildTenantRetentionSchedule(tenant.deletedAt) : null,
    };
}

export function projectScheduledTenantCancellation(
    tenantId: string,
    intentValue: unknown,
): ScheduledTenantCancellationProjection | null {
    if (!intentValue || typeof intentValue !== 'object' || Array.isArray(intentValue)) return null;
    const intent = intentValue as Record<string, unknown>;
    if (
        intent.tenantId !== tenantId
        || intent.kind !== 'CUSTOMER_CANCELLATION'
        || !['PROVIDER_APPLIED', 'FINALIZED'].includes(String(intent.state))
    ) return null;

    const providerResult = intent.providerResult;
    if (!providerResult || typeof providerResult !== 'object' || Array.isArray(providerResult)) return null;
    const outcome = providerResult as Record<string, unknown>;
    if (
        !['scheduled', 'already_scheduled'].includes(String(outcome.action))
        || outcome.cancelAtPeriodEnd !== true
        || typeof outcome.currentPeriodEnd !== 'string'
    ) return null;

    const effectiveAt = new Date(outcome.currentPeriodEnd);
    if (Number.isNaN(effectiveAt.getTime())) return null;
    return {
        lifecycleStatus: 'CANCELLATION_SCHEDULED',
        cancellationEffectiveAt: effectiveAt.toISOString(),
    };
}

export function serializeTenantLifecycleStatus(
    tenant: TenantRetentionSubject,
    customerCancellationIntent?: unknown,
) {
    const deletionRequestedAt = tenant.status === TenantStatus.PURGED ? tenant.deletedAt : null;
    const scheduledCancellation = tenant.status === TenantStatus.SUSPENDED
        || tenant.status === TenantStatus.CANCELLED
        || tenant.status === TenantStatus.PURGED
        ? null
        : projectScheduledTenantCancellation(tenant.id, customerCancellationIntent);

    return {
        id: tenant.id,
        slug: tenant.slug ?? null,
        status: tenant.status,
        lifecycleStatus: tenant.status === TenantStatus.PURGED
            ? tenant.applicationDataPurgedAt ? 'APPLICATION_DATA_PURGED' : 'DELETION_REQUESTED'
            : tenant.status === TenantStatus.CANCELLED
                ? 'CANCELLED'
                : scheduledCancellation?.lifecycleStatus ?? 'OPEN',
        cancelledAt: tenant.status === TenantStatus.CANCELLED ? tenant.deletedAt : null,
        cancellationEffectiveAt: scheduledCancellation?.cancellationEffectiveAt ?? null,
        deletionRequestedAt,
        applicationDataPurgedAt: tenant.applicationDataPurgedAt ?? null,
        legalHold: tenant.retentionLegalHoldAt ? {
            placedAt: tenant.retentionLegalHoldAt,
        } : null,
        retention: deletionRequestedAt ? buildTenantRetentionSchedule(deletionRequestedAt) : null,
        retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
    };
}

async function redactRetainedTenantAuditLogs(
    tx: Prisma.TransactionClient,
    tenantId: string,
): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ redactedCount: bigint | number | string }>>
        `SELECT public.redact_retained_tenant_audit_logs(${tenantId}) AS "redactedCount"`;
    const redactedCount = Number(rows[0]?.redactedCount);
    if (!Number.isSafeInteger(redactedCount) || redactedCount < 0) {
        throw new Error('Audit retention redaction returned an invalid count.');
    }
    return redactedCount;
}

async function purgePayrollOperationalTimeCards(
    tx: Prisma.TransactionClient,
    tenantId: string,
): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ purgedCount: bigint | number | string }>>(
        Prisma.sql`SELECT public.purge_payroll_operational_time_cards(${tenantId}) AS "purgedCount"`,
    );
    return retentionCount(rows[0]?.purgedCount, 'Payroll operational time-card purge');
}

async function purgeExpiredPayrollRecords(
    tx: Prisma.TransactionClient,
    tenantId: string,
): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ purgedCount: bigint | number | string }>>(
        Prisma.sql`SELECT public.purge_expired_payroll_records(${tenantId}) AS "purgedCount"`,
    );
    return retentionCount(rows[0]?.purgedCount, 'Payroll retained-record purge');
}

export async function purgeTenantApplicationData(
    tx: Prisma.TransactionClient,
    tenant: TenantRetentionSubject,
    options: { asOf: Date },
) {
    if (isTenantRetentionLegalHoldActive(tenant)) {
        throw new BadRequestException('Tenant application data is under retention legal hold.');
    }
    if (!isTenantReadyForApplicationDataPurge(tenant, options.asOf)) {
        throw new BadRequestException('Tenant application data is not eligible for purge.');
    }

    const payrollOperationalTimeCards = await purgePayrollOperationalTimeCards(tx, tenant.id);
    const auditRecordsRedacted = await redactRetainedTenantAuditLogs(tx, tenant.id);
    const billingEventPayloadsRedacted = count(await tx.billingEvent.updateMany({
        where: { tenantId: tenant.id },
        data: { metadata: Prisma.DbNull },
    }));
    const stripeUsagePayloadsRedacted = count(await tx.stripeUsageEvent.updateMany({
        where: { tenantId: tenant.id },
        data: { metadata: Prisma.DbNull, lastError: null },
    }));

    const deletedRecordCounts = {
        auditRecordsRedacted,
        billingEventPayloadsRedacted,
        stripeUsagePayloadsRedacted,
        sessions: count(await tx.session.deleteMany({ where: { user: { tenantId: tenant.id } } })),
        passwordResetTokens: count(await tx.passwordResetToken.deleteMany({ where: { tenantId: tenant.id } })),
        onboardingSignupAttempts: count(await tx.onboardingSignupAttempt.deleteMany({ where: { tenantId: tenant.id } })),
        tenantExportJobs: count(await tx.tenantExportJob.deleteMany({ where: { tenantId: tenant.id } })),
        availabilityImportJobs: count(await tx.availabilityImportJob.deleteMany({ where: { tenantId: tenant.id } })),
        staffInvitationOutbox: count(await tx.staffInvitationOutbox.deleteMany({ where: { tenantId: tenant.id } })),
        notificationOutbox: count(await tx.notificationOutbox.deleteMany({ where: { tenantId: tenant.id } })),
        notifications: count(await tx.notification.deleteMany({ where: { tenantId: tenant.id } })),
        breaks: count(await tx.break.deleteMany({ where: { shift: { tenantId: tenant.id } } })),
        timeCards: payrollOperationalTimeCards,
        lunchBreakGenerationRequests: count(await tx.lunchBreakGenerationRequest.deleteMany({ where: { tenantId: tenant.id } })),
        scheduleSolveJobs: count(await tx.scheduleSolveJob.deleteMany({ where: { tenantId: tenant.id } })),
        scheduleDemandWindows: count(await tx.scheduleDemandWindow.deleteMany({ where: { tenantId: tenant.id } })),
        shifts: count(await tx.shift.deleteMany({ where: { tenantId: tenant.id } })),
        staffAvailabilities: count(await tx.staffAvailability.deleteMany({ where: { tenantId: tenant.id } })),
        staffSkills: count(await tx.staffSkill.deleteMany({ where: { tenantId: tenant.id } })),
        schedules: count(await tx.schedule.deleteMany({ where: { tenantId: tenant.id } })),
        locations: count(await tx.location.deleteMany({ where: { tenantId: tenant.id } })),
        tenantSettings: count(await tx.tenantSetting.deleteMany({ where: { tenantId: tenant.id } })),
        webhookDeliveries: count(await tx.webhookDelivery.deleteMany({ where: { tenantId: tenant.id } })),
        webhookEndpoints: count(await tx.webhookEndpoint.deleteMany({ where: { tenantId: tenant.id } })),
        roleAssignments: count(await tx.roleAssignment.deleteMany({ where: { tenantId: tenant.id } })),
        rolePermissions: count(await tx.rolePermission.deleteMany({ where: { role: { tenantId: tenant.id } } })),
        roles: count(await tx.role.deleteMany({ where: { tenantId: tenant.id } })),
        users: count(await tx.user.deleteMany({ where: { tenantId: tenant.id } })),
    };

    const applicationDataPurgedAt = options.asOf;
    await tx.tenant.update({
        where: { id: tenant.id },
        data: {
            name: `Deleted tenant ${tenant.id}`,
            slug: `deleted-${tenant.id}`,
            applicationDataPurgedAt,
        },
    });

    return {
        id: tenant.id,
        stage: 'application_data' as const,
        applicationDataPurgedAt: applicationDataPurgedAt.toISOString(),
        retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
        deletedRecordCounts,
    };
}

function count(result: DeleteManyResult): number {
    return result.count;
}

async function deleteExpiredAuditLogs(tx: Prisma.TransactionClient, tenantId: string): Promise<DeleteManyResult> {
    const rows = await tx.$queryRaw<Array<{ purge_expired_audit_logs: bigint | number | string }>>
        `SELECT public.purge_expired_audit_logs(${tenantId})`;
    const count = Number(rows[0]?.purge_expired_audit_logs);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Audit retention purge returned an invalid deletion count.');
    }
    return { count };
}

export async function purgeTenantOwnedRecords(tx: Prisma.TransactionClient, tenantId: string) {
    const deletedRecordCounts = {
        payrollRecords: await purgeExpiredPayrollRecords(tx, tenantId),
        sessions: count(await tx.session.deleteMany({
            where: { user: { tenantId } },
        })),
        onboardingSignupAttempts: count(await tx.onboardingSignupAttempt.deleteMany({
            where: { tenantId },
        })),
        tenantExportJobs: count(await tx.tenantExportJob.deleteMany({
            where: { tenantId },
        })),
        availabilityImportJobs: count(await tx.availabilityImportJob.deleteMany({
            where: { tenantId },
        })),
        staffInvitationOutbox: count(await tx.staffInvitationOutbox.deleteMany({
            where: { tenantId },
        })),
        notificationOutbox: count(await tx.notificationOutbox.deleteMany({
            where: { tenantId },
        })),
        notifications: count(await tx.notification.deleteMany({
            where: { tenantId },
        })),
        breaks: count(await tx.break.deleteMany({
            where: { shift: { tenantId } },
        })),
        timeCards: count(await tx.timeCard.deleteMany({
            where: { tenantId },
        })),
        lunchBreakGenerationRequests: count(await tx.lunchBreakGenerationRequest.deleteMany({
            where: { tenantId },
        })),
        scheduleSolveJobs: count(await tx.scheduleSolveJob.deleteMany({
            where: { tenantId },
        })),
        scheduleDemandWindows: count(await tx.scheduleDemandWindow.deleteMany({
            where: { tenantId },
        })),
        shifts: count(await tx.shift.deleteMany({
            where: { tenantId },
        })),
        staffAvailabilities: count(await tx.staffAvailability.deleteMany({
            where: { tenantId },
        })),
        staffSkills: count(await tx.staffSkill.deleteMany({
            where: { tenantId },
        })),
        schedules: count(await tx.schedule.deleteMany({
            where: { tenantId },
        })),
        locations: count(await tx.location.deleteMany({
            where: { tenantId },
        })),
        tenantSettings: count(await tx.tenantSetting.deleteMany({
            where: { tenantId },
        })),
        billingEvents: count(await tx.billingEvent.deleteMany({
            where: { tenantId },
        })),
        stripeUsageEvents: count(await tx.stripeUsageEvent.deleteMany({
            where: { tenantId },
        })),
        webhookDeliveries: count(await tx.webhookDelivery.deleteMany({
            where: { tenantId },
        })),
        webhookEndpoints: count(await tx.webhookEndpoint.deleteMany({
            where: { tenantId },
        })),
        creditTransactions: count(await tx.creditTransaction.deleteMany({
            where: { tenantId },
        })),
        auditLogs: count(await deleteExpiredAuditLogs(tx, tenantId)),
        roleAssignments: count(await tx.roleAssignment.deleteMany({
            where: { tenantId },
        })),
        rolePermissions: count(await tx.rolePermission.deleteMany({
            where: { role: { tenantId } },
        })),
        roles: count(await tx.role.deleteMany({
            where: { tenantId },
        })),
        users: count(await tx.user.deleteMany({
            where: { tenantId },
        })),
    };

    await tx.tenant.delete({
        where: { id: tenantId },
    });

    return {
        id: tenantId,
        deleted: true,
        deletedRecordCounts,
    };
}

export async function purgeExpiredTenantRecords(
    tx: Prisma.TransactionClient,
    tenant: TenantRetentionSubject,
    options: { asOf: Date },
) {
    if (isTenantRetentionLegalHoldActive(tenant)) {
        throw new BadRequestException('Tenant retained records are under retention legal hold.');
    }
    if (!isTenantReadyForRetentionPurge(tenant, options.asOf)) {
        throw new BadRequestException('Tenant retained records are not expired.');
    }

    return purgeTenantOwnedRecords(tx, tenant.id);
}

function isJsonRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function pathValue(source: JsonRecord, path: string[]): unknown {
    let current: unknown = source;
    for (const segment of path) {
        if (!isJsonRecord(current)) return null;
        current = current[segment];
    }
    return current;
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        const resolved = stringValue(value);
        if (resolved) return resolved;
    }
    return null;
}

function firstNumber(...values: unknown[]): number | null {
    for (const value of values) {
        const resolved = numberValue(value);
        if (resolved !== null) return resolved;
    }
    return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
    for (const value of values) {
        const resolved = booleanValue(value);
        if (resolved !== null) return resolved;
    }
    return null;
}

function objectId(value: unknown): string | null {
    if (typeof value === 'string') {
        return stringValue(value);
    }
    if (isJsonRecord(value)) {
        return stringValue(value.id);
    }
    return null;
}

function epochSecondsToIso(value: unknown): string | null {
    const seconds = numberValue(value);
    if (seconds === null) return null;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstIsoString(...values: unknown[]): string | null {
    for (const value of values) {
        const direct = stringValue(value);
        if (direct) return direct;
        const fromEpoch = epochSecondsToIso(value);
        if (fromEpoch) return fromEpoch;
    }
    return null;
}

function collectPriceIdsFromBillingMetadata(metadata: JsonRecord): string[] {
    const priceIds = new Set<string>();
    const add = (value: unknown) => {
        const priceId = objectId(value);
        if (priceId) priceIds.add(priceId);
    };
    const addFromItem = (item: unknown) => {
        if (!isJsonRecord(item)) return;
        add(item.price);
        add(pathValue(item, ['price', 'id']));
        add(item.plan);
        add(pathValue(item, ['plan', 'id']));
        add(pathValue(item, ['pricing', 'price_details', 'price']));
        add(pathValue(item, ['price_details', 'price']));
    };

    const existingPriceIds = metadata.priceIds;
    if (Array.isArray(existingPriceIds)) {
        for (const priceId of existingPriceIds) add(priceId);
    }
    add(metadata.price);
    add(pathValue(metadata, ['price', 'id']));
    add(metadata.plan);
    add(pathValue(metadata, ['plan', 'id']));

    for (const collection of [
        pathValue(metadata, ['lines', 'data']),
        pathValue(metadata, ['items', 'data']),
        pathValue(metadata, ['line_items', 'data']),
    ]) {
        if (!Array.isArray(collection)) continue;
        for (const item of collection) addFromItem(item);
    }

    return Array.from(priceIds);
}

function compactBillingMetadata(input: Record<string, unknown>): Record<string, BillingMetadataValue> {
    const output: Record<string, BillingMetadataValue> = {};

    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string' && value.trim()) {
            output[key] = value.trim();
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            output[key] = value;
            continue;
        }
        if (typeof value === 'boolean') {
            output[key] = value;
            continue;
        }
        if (Array.isArray(value)) {
            const values = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
            if (values.length > 0) {
                output[key] = Array.from(new Set(values));
            }
        }
    }

    return output;
}

export function minimizeRetainedBillingMetadata(metadata: Prisma.JsonValue | null): Prisma.JsonObject | null {
    if (!isJsonRecord(metadata)) return null;

    const minimized = compactBillingMetadata({
        stripeEventLivemode: firstBoolean(metadata.stripeEventLivemode),
        stripeObjectType: firstString(metadata.stripeObjectType, metadata.object),
        stripeObjectId: firstString(metadata.stripeObjectId, metadata.id),
        tenantId: firstString(
            metadata.tenantId,
            pathValue(metadata, ['metadata', 'tenantId']),
            pathValue(metadata, ['subscription_details', 'metadata', 'tenantId']),
            pathValue(metadata, ['customer_details', 'metadata', 'tenantId']),
            pathValue(metadata, ['customer', 'metadata', 'tenantId']),
        ),
        subscriptionId: firstString(
            metadata.subscriptionId,
            objectId(metadata.subscription),
            pathValue(metadata, ['subscription_details', 'subscription']),
        ),
        customerId: firstString(metadata.customerId, objectId(metadata.customer)),
        invoiceId: firstString(
            metadata.invoiceId,
            metadata.object === 'invoice' ? stringValue(metadata.id) : null,
            objectId(metadata.invoice),
        ),
        checkoutSessionId: firstString(
            metadata.checkoutSessionId,
            metadata.object === 'checkout.session' ? stringValue(metadata.id) : null,
        ),
        paymentIntentId: firstString(metadata.paymentIntentId, objectId(metadata.payment_intent)),
        chargeId: firstString(metadata.chargeId, objectId(metadata.charge), objectId(metadata.latest_charge)),
        status: firstString(metadata.status),
        paymentStatus: firstString(metadata.paymentStatus, metadata.payment_status),
        mode: firstString(metadata.mode),
        billingReason: firstString(metadata.billingReason, metadata.billing_reason),
        collectionMethod: firstString(metadata.collectionMethod, metadata.collection_method),
        cancelAtPeriodEnd: firstBoolean(metadata.cancelAtPeriodEnd, metadata.cancel_at_period_end),
        currentPeriodEnd: firstIsoString(metadata.currentPeriodEnd, metadata.current_period_end),
        cancelAt: firstIsoString(metadata.cancelAt, metadata.cancel_at),
        canceledAt: firstIsoString(metadata.canceledAt, metadata.canceled_at),
        amountSubtotal: firstNumber(metadata.amountSubtotal, metadata.amount_subtotal),
        amountTotal: firstNumber(metadata.amountTotal, metadata.amount_total),
        amountPaid: firstNumber(metadata.amountPaid, metadata.amount_paid),
        amountDue: firstNumber(metadata.amountDue, metadata.amount_due),
        currency: firstString(metadata.currency),
        planCode: firstString(
            metadata.planCode,
            pathValue(metadata, ['metadata', 'planCode']),
            pathValue(metadata, ['subscription_details', 'metadata', 'planCode']),
            pathValue(metadata, ['customer_details', 'metadata', 'planCode']),
            pathValue(metadata, ['customer', 'metadata', 'planCode']),
        ),
        priceIds: collectPriceIdsFromBillingMetadata(metadata),
    });

    return Object.keys(minimized).length > 0 ? minimized as Prisma.JsonObject : null;
}

export function serializeBillingEventForExport<T extends { metadata: Prisma.JsonValue | null }>(event: T) {
    return {
        ...event,
        metadata: minimizeRetainedBillingMetadata(event.metadata),
    };
}
