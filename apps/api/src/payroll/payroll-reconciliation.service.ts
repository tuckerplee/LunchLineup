import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { AuthService } from '../auth/auth.service';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    normalizeReconciliation,
    reconciliationCounts,
    reconciliationPayloadSha256,
} from './payroll-reconciliation';
import { serializePayrollReceipt } from './payroll-records';
import {
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_REPLAY_CONFLICT,
    runCurrentPayrollMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import { requiredId } from './payroll-validation';

@Injectable()
export class PayrollReconciliationService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbac: RbacService,
        private readonly authService: AuthService,
    ) {}

    async reconcile(actor: PayrollActor, batchIdRaw: unknown, body: unknown) {
        actor = Object.freeze({ ...actor });
        const batchId = requiredId(batchIdRaw, 'exportId');
        const payload = normalizeReconciliation(body);
        const payloadSha256 = reconciliationPayloadSha256({
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            batchId,
            payload,
        });
        return runCurrentPayrollMutation(this.rbac, this.authService, actor, 'payroll:reconcile',
            async (tx, assertCurrent, actor) => {
                assertCurrent();
                const replay = await this.findReplayInTransaction(tx, actor, batchId, payload.provider, payload.providerEventId, payloadSha256);
                assertCurrent();
                if (replay) return replay;

                assertCurrent();
                await lockPayrollTenant(tx, actor.tenantId);
                assertCurrent();
                await this.lockBatchRow(tx, actor.tenantId, batchId);
                assertCurrent();
                const batch = await tx.payrollExportBatch.findFirst({
                    where: { id: batchId, tenantId: actor.tenantId },
                });
                assertCurrent();
                if (!batch) throw new NotFoundException('Payroll export not found.');
                assertCurrent();
                await lockPayrollPeriod(tx, actor.tenantId, batch.periodId);
                assertCurrent();
                const insideReplay = await this.findReplayInTransaction(
                    tx,
                    actor,
                    batchId,
                    payload.provider,
                    payload.providerEventId,
                    payloadSha256,
                );
                assertCurrent();
                if (insideReplay) return insideReplay;
                if (batch.status === 'GENERATED') {
                    throw new ConflictException('Payroll export must be downloaded before reconciliation.');
                }
                if (batch.status === 'RECONCILED') {
                    throw new ConflictException('Payroll export reconciliation is already terminal.');
                }

                assertCurrent();
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
                assertCurrent();
                if (lines.length !== payload.outcomes.length) {
                    throw new BadReconciliationLineException();
                }
                const counts = reconciliationCounts(payload);
                assertCurrent();
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
                assertCurrent();
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
                assertCurrent();
                for (const outcome of payload.outcomes) {
                    assertCurrent();
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
                    assertCurrent();
                }
                if (batch.status === 'DOWNLOADED') {
                    assertCurrent();
                    const changed = await tx.payrollExportBatch.updateMany({
                        where: { id: batch.id, tenantId: actor.tenantId, status: 'DOWNLOADED' },
                        data: { status: 'RECONCILING' },
                    });
                    assertCurrent();
                    if (changed.count !== 1) throw new ConflictException('Payroll reconciliation state changed. Retry.');
                }
                assertCurrent();
                const accepted = await tx.payrollReconciliationLineState.count({
                    where: { tenantId: actor.tenantId, batchId: batch.id, status: 'ACCEPTED' },
                });
                assertCurrent();
                const complete = accepted === batch.rowCount
                    && payload.providerTotalMinutes === batch.totalPayableMinutes;
                if (complete) {
                    assertCurrent();
                    const changed = await tx.payrollExportBatch.updateMany({
                        where: { id: batch.id, tenantId: actor.tenantId, status: 'RECONCILING' },
                        data: { status: 'RECONCILED', reconciledAt: new Date() },
                    });
                    assertCurrent();
                    if (changed.count !== 1) throw new ConflictException('Payroll reconciliation state changed. Retry.');
                }
                const response = serializePayrollReceipt(receipt);
                assertCurrent();
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_RECONCILIATION_RECEIVED',
                    resource: 'PayrollReconciliationReceipt',
                    resourceId: receipt.id,
                    newValue: response,
                }, assertCurrent);
                assertCurrent();
                return response;
            }, {
            isRecoverable: isPrismaUniqueConflict,
            operation: async (tx, assertCurrent, actor, error) => {
                assertCurrent();
                const replay = await this.findReplayInTransaction(tx, actor, batchId, payload.provider, payload.providerEventId, payloadSha256);
                assertCurrent();
                if (replay) return replay;
                throw new ConflictException(PAYROLL_REPLAY_CONFLICT);
            },
        });
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
