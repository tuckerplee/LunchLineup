import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    normalizeReconciliation,
    reconciliationCounts,
    reconciliationPayloadSha256,
} from './payroll-reconciliation';
import { serializePayrollReceipt } from './payroll-records';
import {
    applyPayrollTransactionTimeouts,
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_REPLAY_CONFLICT,
    PAYROLL_TRANSACTION_OPTIONS,
    retryPayrollSerializableMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import { requiredId } from './payroll-validation';

@Injectable()
export class PayrollReconciliationService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async reconcile(actor: PayrollActor, batchIdRaw: unknown, body: unknown) {
        const batchId = requiredId(batchIdRaw, 'exportId');
        const payload = normalizeReconciliation(body);
        const payloadSha256 = reconciliationPayloadSha256({
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            batchId,
            payload,
        });
        const replay = await this.findReplay(actor, batchId, payload.provider, payload.providerEventId, payloadSha256);
        if (replay) return replay;

        try {
            return await retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
                await applyPayrollTransactionTimeouts(tx);
                await lockPayrollTenant(tx, actor.tenantId);
                await this.lockBatchRow(tx, actor.tenantId, batchId);
                const batch = await tx.payrollExportBatch.findFirst({
                    where: { id: batchId, tenantId: actor.tenantId },
                });
                if (!batch) throw new NotFoundException('Payroll export not found.');
                await lockPayrollPeriod(tx, actor.tenantId, batch.periodId);
                const insideReplay = await this.findReplayInTransaction(
                    tx,
                    actor,
                    batchId,
                    payload.provider,
                    payload.providerEventId,
                    payloadSha256,
                );
                if (insideReplay) return insideReplay;
                if (batch.status === 'GENERATED') {
                    throw new ConflictException('Payroll export must be downloaded before reconciliation.');
                }
                if (batch.status === 'RECONCILED') {
                    throw new ConflictException('Payroll export reconciliation is already terminal.');
                }

                const lines = await tx.payrollExportLine.findMany({
                    where: {
                        tenantId: actor.tenantId,
                        batchId: batch.id,
                        id: { in: payload.outcomes.map((outcome) => outcome.lineId) },
                    },
                    orderBy: { id: 'asc' },
                    take: payload.outcomes.length,
                    select: { id: true },
                });
                if (lines.length !== payload.outcomes.length) {
                    throw new BadReconciliationLineException();
                }
                const counts = reconciliationCounts(payload);
                const receipt = await tx.payrollReconciliationReceipt.create({
                    data: {
                        tenantId: actor.tenantId,
                        batchId: batch.id,
                        provider: payload.provider,
                        providerEventId: payload.providerEventId,
                        payloadSha256,
                        providerTotalMinutes: payload.providerTotalMinutes,
                        ...counts,
                        receivedByUserId: actor.userId,
                    },
                });
                await tx.payrollReconciliationLineEvent.createMany({
                    data: payload.outcomes.map((outcome) => ({
                        tenantId: actor.tenantId,
                        receiptId: receipt.id,
                        batchId: batch.id,
                        lineId: outcome.lineId,
                        status: outcome.status,
                        reason: outcome.reason,
                    })),
                });
                for (const outcome of payload.outcomes) {
                    await tx.payrollReconciliationLineState.upsert({
                        where: { batchId_lineId: { batchId: batch.id, lineId: outcome.lineId } },
                        create: {
                            tenantId: actor.tenantId,
                            batchId: batch.id,
                            lineId: outcome.lineId,
                            status: outcome.status,
                            latestReceiptId: receipt.id,
                            reason: outcome.reason,
                        },
                        update: {
                            status: outcome.status,
                            latestReceiptId: receipt.id,
                            reason: outcome.reason,
                        },
                    });
                }
                if (batch.status === 'DOWNLOADED') {
                    const changed = await tx.payrollExportBatch.updateMany({
                        where: { id: batch.id, tenantId: actor.tenantId, status: 'DOWNLOADED' },
                        data: { status: 'RECONCILING' },
                    });
                    if (changed.count !== 1) throw new ConflictException('Payroll reconciliation state changed. Retry.');
                }
                const accepted = await tx.payrollReconciliationLineState.count({
                    where: { tenantId: actor.tenantId, batchId: batch.id, status: 'ACCEPTED' },
                });
                const complete = accepted === batch.rowCount
                    && payload.providerTotalMinutes === batch.totalPayableMinutes;
                if (complete) {
                    const changed = await tx.payrollExportBatch.updateMany({
                        where: { id: batch.id, tenantId: actor.tenantId, status: 'RECONCILING' },
                        data: { status: 'RECONCILED', reconciledAt: new Date() },
                    });
                    if (changed.count !== 1) throw new ConflictException('Payroll reconciliation state changed. Retry.');
                }
                const response = serializePayrollReceipt(receipt);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_RECONCILIATION_RECEIVED',
                    resource: 'PayrollReconciliationReceipt',
                    resourceId: receipt.id,
                    newValue: response,
                });
                return response;
            }, PAYROLL_TRANSACTION_OPTIONS));
        } catch (error) {
            if (isPrismaUniqueConflict(error)) {
                const racedReplay = await this.findReplay(
                    actor,
                    batchId,
                    payload.provider,
                    payload.providerEventId,
                    payloadSha256,
                );
                if (racedReplay) return racedReplay;
                throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
            }
            throw error;
        }
    }

    private async findReplay(
        actor: PayrollActor,
        batchId: string,
        provider: string,
        providerEventId: string,
        payloadSha256: string,
    ) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) => this.findReplayInTransaction(
            tx,
            actor,
            batchId,
            provider,
            providerEventId,
            payloadSha256,
        ));
    }

    private async findReplayInTransaction(
        tx: TenantPrismaTransaction,
        actor: PayrollActor,
        batchId: string,
        provider: string,
        providerEventId: string,
        payloadSha256: string,
    ) {
        const receipt = await tx.payrollReconciliationReceipt.findUnique({
            where: {
                tenantId_provider_providerEventId: {
                    tenantId: actor.tenantId,
                    provider,
                    providerEventId,
                },
            },
        });
        if (!receipt) return null;
        if (receipt.batchId !== batchId || receipt.payloadSha256 !== payloadSha256) {
            throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
        }
        return serializePayrollReceipt(receipt);
    }

    private async lockBatchRow(tx: TenantPrismaTransaction, tenantId: string, batchId: string): Promise<void> {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "PayrollExportBatch"
            WHERE "tenantId" = ${tenantId} AND "id" = ${batchId}
            FOR UPDATE
        `;
        if (rows.length !== 1) throw new NotFoundException('Payroll export not found.');
    }
}

class BadReconciliationLineException extends ConflictException {
    constructor() {
        super('Reconciliation outcomes contain an unknown or cross-batch payroll line.');
    }
}
