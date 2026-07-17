import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { FeatureAccessService } from '../billing/feature-access.service';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    buildPayrollCsv,
    payrollContentSha256,
    payrollExportLineSha256,
    type PayrollCsvLine,
} from './payroll-csv';
import {
    deterministicPayrollId,
    normalizePayrollIdempotencyKey,
    payrollRequestIdentity,
} from './payroll-idempotency';
import { serializeDateOnly } from './payroll-policy';
import { serializePayrollExport } from './payroll-records';
import { payrollLockAggregateSha256 } from './payroll-lock-snapshot';
import {
    applyPayrollTransactionTimeouts,
    isPayrollLockTimeout,
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_CONCURRENT_CHANGE,
    PAYROLL_INTEGRITY_FAILURE,
    PAYROLL_REPLAY_CONFLICT,
    PAYROLL_TRANSACTION_OPTIONS,
    retryPayrollSerializableMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import { MAX_PAYROLL_LOCK_ENTRIES, requiredId } from './payroll-validation';

@Injectable()
export class PayrollExportService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly featureAccess: FeatureAccessService,
    ) {}

    async entitlement(actor: PayrollActor) {
        const matrix = await this.featureAccess.getFeatureMatrix(actor.tenantId);
        const resolution = matrix.features.time_cards;
        const creditCost = Number.isSafeInteger(resolution.creditCost)
            && Number(resolution.creditCost) > 0
            ? Number(resolution.creditCost)
            : null;
        return {
            creditCost,
            eligible: resolution.enabled && resolution.source === 'credits' && creditCost !== null,
            reason: resolution.reason,
        };
    }

    async create(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const periodId = requiredId(periodIdRaw, 'periodId');
        const request = body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {};
        const expectedCreditCost = this.expectedCreditCost(request.expectedCreditCost);
        const identity = payrollRequestIdentity({
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            operation: 'EXPORT',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, expectedCreditCost },
        });
        const replay = await this.findReplay(actor, periodId, identity);
        if (replay) return replay;

        return retryPayrollSerializableMutation(async () => {
            try {
                return await this.tenantDb.withTenant(actor.tenantId, async (tx) => {
                await applyPayrollTransactionTimeouts(tx);
                await this.featureAccess.lockTenantInTransaction(tx, actor.tenantId);
                await lockPayrollTenant(tx, actor.tenantId);
                await lockPayrollPeriod(tx, actor.tenantId, periodId);
                const insideReplay = await this.findReplayInTransaction(tx, actor, periodId, identity);
                if (insideReplay) return insideReplay;

                const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId: actor.tenantId } });
                if (!period) throw new NotFoundException('Payroll period not found.');
                if (period.status !== 'LOCKED') throw new ConflictException('Only a locked payroll period can be exported.');
                const existing = await tx.payrollExportBatch.findFirst({
                    where: { tenantId: actor.tenantId, periodId: period.id },
                    select: { id: true },
                });
                if (existing) throw new ConflictException('Payroll period already has its canonical export batch.');
                const entitlement = await this.featureAccess.assertFeatureEnabledInTransaction(
                    tx,
                    actor.tenantId,
                    'time_cards',
                );
                if (
                    entitlement.source !== 'credits'
                    || !Number.isSafeInteger(entitlement.creditCost)
                    || Number(entitlement.creditCost) <= 0
                ) {
                    throw new ForbiddenException(
                        'Payroll export requires an active paid time-cards entitlement with a positive credit cost.',
                    );
                }
                if (Number(entitlement.creditCost) !== expectedCreditCost) {
                    throw new ConflictException('Payroll export credit cost changed; refresh and confirm the current cost.');
                }
                const entries = await tx.payrollLockedEntry.findMany({
                    where: { tenantId: actor.tenantId, periodId: period.id },
                    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
                    take: MAX_PAYROLL_LOCK_ENTRIES + 1,
                });
                if (
                    entries.length === 0
                    || entries.length > MAX_PAYROLL_LOCK_ENTRIES
                    || entries.length !== period.lockedEntryCount
                ) {
                    throw new ConflictException('Locked payroll entry count is invalid for export.');
                }
                const totalPayableMinutes = entries.reduce((total, entry) => total + entry.payableMinutes, 0);
                if (!Number.isSafeInteger(totalPayableMinutes) || totalPayableMinutes !== period.totalPayableMinutes) {
                    throw new ConflictException('Locked payroll totals are invalid for export.');
                }
                let aggregateSha256: string;
                try {
                    aggregateSha256 = payrollLockAggregateSha256({
                        tenantId: actor.tenantId,
                        periodId: period.id,
                        entryHashes: entries.map((entry) => entry.canonicalSha256),
                        totalPayableMinutes,
                    });
                } catch {
                    throw new ConflictException('Locked payroll integrity evidence is invalid for export.');
                }
                if (aggregateSha256 !== period.lockedEntrySha256) {
                    throw new ConflictException('Locked payroll integrity evidence does not match the period.');
                }

                const batchId = deterministicPayrollId('batch', identity.operationId);
                const lines = entries.map((entry, index) => {
                    const line: PayrollCsvLine = {
                        id: deterministicPayrollId('line', {
                            batchId,
                            lineNumber: index + 1,
                            lockedEntryId: entry.id,
                        }),
                        lineNumber: index + 1,
                        sourceType: entry.sourceType,
                        sourceId: entry.sourceId,
                        employeeId: entry.employeeId,
                        locationId: entry.locationId,
                        workTimeZone: entry.workTimeZone,
                        clockInAt: entry.clockInAt,
                        clockOutAt: entry.clockOutAt,
                        breakMinutes: entry.breakMinutes,
                        payableMinutes: entry.payableMinutes,
                    };
                    return {
                        lockedEntryId: entry.id,
                        line,
                        canonicalSha256: payrollExportLineSha256({
                            tenantId: actor.tenantId,
                            batchId,
                            lockedEntryId: entry.id,
                            line,
                        }),
                    };
                });
                let csv: Buffer;
                try {
                    csv = buildPayrollCsv(lines.map((entry) => entry.line));
                } catch {
                    throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
                }
                const contentSha256 = payrollContentSha256(csv);
                const creditTransactionId = `feature-usage-payroll-export:${identity.operationId}`;
                const settlement = await this.featureAccess.recordFeatureUsageInTransaction(
                    tx,
                    actor.tenantId,
                    entitlement,
                    `Payroll export (${period.id})`,
                    `payroll-export:${identity.operationId}`,
                );
                if (
                    settlement.consumedCredits !== entitlement.creditCost
                    || !Number.isSafeInteger(settlement.newBalance)
                    || Number(settlement.newBalance) < 0
                ) {
                    throw new ServiceUnavailableException('Payroll export settlement is unavailable.');
                }
                const batch = await tx.payrollExportBatch.create({
                    data: {
                        id: batchId,
                        tenantId: actor.tenantId,
                        periodId: period.id,
                        operationId: identity.operationId,
                        requestHash: identity.requestHash,
                        creditTransactionId,
                        formatVersion: 1,
                        contentSha256,
                        rowCount: lines.length,
                        totalPayableMinutes,
                        consumedCredits: settlement.consumedCredits,
                        newBalance: Number(settlement.newBalance),
                    },
                });
                await tx.payrollExportLine.createMany({
                    data: lines.map(({ line, lockedEntryId, canonicalSha256 }) => ({
                        id: line.id,
                        tenantId: actor.tenantId,
                        batchId: batch.id,
                        lineNumber: line.lineNumber,
                        lockedEntryId,
                        sourceType: line.sourceType,
                        sourceId: line.sourceId,
                        employeeId: line.employeeId,
                        locationId: line.locationId,
                        workTimeZone: line.workTimeZone,
                        clockInAt: new Date(line.clockInAt),
                        clockOutAt: new Date(line.clockOutAt),
                        breakMinutes: line.breakMinutes,
                        payableMinutes: line.payableMinutes,
                        canonicalSha256,
                    })),
                });
                const response = serializePayrollExport(batch);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_EXPORT_GENERATED',
                    resource: 'PayrollExportBatch',
                    resourceId: batch.id,
                    newValue: response,
                });
                return response;
                }, PAYROLL_TRANSACTION_OPTIONS);
            } catch (error) {
                if (isPrismaUniqueConflict(error)) {
                    const racedReplay = await this.findReplay(actor, periodId, identity);
                    if (racedReplay) return racedReplay;
                    throw new ConflictException('Payroll period already has its canonical export batch.');
                }
                if (isPayrollLockTimeout(error)) {
                    const racedReplay = await this.findReplay(actor, periodId, identity);
                    if (racedReplay) return racedReplay;
                    throw new ServiceUnavailableException(PAYROLL_CONCURRENT_CHANGE);
                }
                throw error;
            }
        });
    }

    private expectedCreditCost(value: unknown): number {
        if (!Number.isSafeInteger(value) || Number(value) <= 0) {
            throw new BadRequestException('expectedCreditCost must be a positive integer.');
        }
        return Number(value);
    }

    async download(actor: PayrollActor, batchIdRaw: unknown): Promise<{
        filename: string;
        content: Buffer;
    }> {
        const batchId = requiredId(batchIdRaw, 'exportId');
        return retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            await applyPayrollTransactionTimeouts(tx);
            await lockPayrollTenant(tx, actor.tenantId);
            await this.lockBatchRow(tx, actor.tenantId, batchId);
            const batch = await tx.payrollExportBatch.findFirst({ where: { id: batchId, tenantId: actor.tenantId } });
            if (!batch) throw new NotFoundException('Payroll export not found.');
            await this.verifyCreditProvenance(tx, batch);
            const period = await tx.payrollPeriod.findFirst({
                where: { id: batch.periodId, tenantId: actor.tenantId },
                select: { localStartDate: true },
            });
            if (!period) throw new NotFoundException('Payroll period not found.');
            const lines = await this.loadAndVerifyLines(tx, actor.tenantId, batch);
            let content: Buffer;
            try {
                content = buildPayrollCsv(lines);
            } catch {
                throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
            }
            if (payrollContentSha256(content) !== batch.contentSha256) {
                throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
            }
            if (batch.status === 'GENERATED') {
                const downloadedAt = new Date();
                const changed = await tx.payrollExportBatch.updateMany({
                    where: { id: batch.id, tenantId: actor.tenantId, status: 'GENERATED' },
                    data: { status: 'DOWNLOADED', downloadedAt },
                });
                if (changed.count !== 1) throw new ConflictException('Payroll export download state changed. Retry.');
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_EXPORT_DOWNLOADED',
                    resource: 'PayrollExportBatch',
                    resourceId: batch.id,
                    newValue: { downloadedAt: downloadedAt.toISOString() },
                });
            }
            return {
                filename: `payroll-${serializeDateOnly(period.localStartDate)}-${batch.id}.csv`,
                content,
            };
        }, PAYROLL_TRANSACTION_OPTIONS));
    }

    private async findReplay(
        actor: PayrollActor,
        periodId: string,
        identity: { operationId: string; requestHash: string },
    ) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            this.findReplayInTransaction(tx, actor, periodId, identity));
    }

    private async findReplayInTransaction(
        tx: TenantPrismaTransaction,
        actor: PayrollActor,
        periodId: string,
        identity: { operationId: string; requestHash: string },
    ) {
        const batch = await tx.payrollExportBatch.findUnique({ where: { operationId: identity.operationId } });
        if (!batch) return null;
        if (
            batch.tenantId !== actor.tenantId
            || batch.periodId !== periodId
            || batch.requestHash !== identity.requestHash
        ) {
            throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
        }
        await this.verifyCreditProvenance(tx, batch);
        return serializePayrollExport(batch);
    }

    private async verifyCreditProvenance(
        tx: TenantPrismaTransaction,
        batch: {
            tenantId: string;
            periodId: string;
            operationId: string;
            creditTransactionId: string;
            consumedCredits: number;
            newBalance: number;
        },
    ): Promise<void> {
        const expectedId = `feature-usage-payroll-export:${batch.operationId}`;
        const ledger = await tx.creditTransaction.findUnique({
            where: { id: batch.creditTransactionId },
            select: { id: true, tenantId: true, amount: true, reason: true, balanceAfter: true },
        });
        if (
            batch.creditTransactionId !== expectedId
            || !ledger
            || ledger.id !== expectedId
            || ledger.tenantId !== batch.tenantId
            || ledger.amount !== -batch.consumedCredits
            || ledger.reason !== `Payroll export (${batch.periodId})`
            || ledger.balanceAfter !== batch.newBalance
        ) {
            throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
        }
    }

    private async lockBatchRow(tx: TenantPrismaTransaction, tenantId: string, batchId: string): Promise<void> {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "PayrollExportBatch"
            WHERE "tenantId" = ${tenantId} AND "id" = ${batchId}
            FOR UPDATE
        `;
        if (rows.length !== 1) throw new NotFoundException('Payroll export not found.');
    }

    private async loadAndVerifyLines(
        tx: TenantPrismaTransaction,
        tenantId: string,
        batch: any,
    ): Promise<PayrollCsvLine[]> {
        if (batch.rowCount < 1 || batch.rowCount > MAX_PAYROLL_LOCK_ENTRIES) {
            throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
        }
        const rows = await tx.payrollExportLine.findMany({
            where: { tenantId, batchId: batch.id },
            orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
            take: MAX_PAYROLL_LOCK_ENTRIES + 1,
        });
        if (rows.length !== batch.rowCount) throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
        let total = 0;
        const lines = rows.map((row) => {
            const line: PayrollCsvLine = {
                id: row.id,
                lineNumber: row.lineNumber,
                sourceType: row.sourceType,
                sourceId: row.sourceId,
                employeeId: row.employeeId,
                locationId: row.locationId,
                workTimeZone: row.workTimeZone,
                clockInAt: row.clockInAt,
                clockOutAt: row.clockOutAt,
                breakMinutes: row.breakMinutes,
                payableMinutes: row.payableMinutes,
            };
            if (payrollExportLineSha256({
                tenantId,
                batchId: batch.id,
                lockedEntryId: row.lockedEntryId,
                line,
            }) !== row.canonicalSha256) {
                throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
            }
            total += row.payableMinutes;
            return line;
        });
        if (!Number.isSafeInteger(total) || total !== batch.totalPayableMinutes) {
            throw new ServiceUnavailableException(PAYROLL_INTEGRITY_FAILURE);
        }
        return lines;
    }
}
