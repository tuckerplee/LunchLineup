import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { normalizePayrollIdempotencyKey, payrollRequestIdentity } from './payroll-idempotency';
import {
    readPayrollOperationReplay,
    readPayrollPeriodCreateReplay,
    writePayrollOperation,
} from './payroll-operation';
import { dateOnlyForPrisma, normalizeLocalDate, payrollPeriodBoundaries, serializeDateOnly } from './payroll-policy';
import { lockPayrollCandidateCards, validatePayrollCandidateCards } from './payroll-period-cards';
import { loadPayrollPeriodSummaries } from './payroll-period-summary';
import { serializePayrollPeriod } from './payroll-records';
import {
    applyPayrollTransactionTimeouts,
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_CONCURRENT_CHANGE,
    PAYROLL_TRANSACTION_OPTIONS,
    retryPayrollSerializableMutation,
    type PayrollActor,
    writePayrollAudit,
} from './payroll-transaction';
import {
    MAX_PAYROLL_HISTORY_PAGE_SIZE,
    parseBoundedLimit,
    parseExpectedRevision,
    parseOpaqueCursor,
    requiredId,
} from './payroll-validation';

@Injectable()
export class PayrollPeriodService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async list(actor: PayrollActor, limitRaw?: unknown, cursorRaw?: unknown) {
        const limit = parseBoundedLimit(limitRaw, {
            field: 'limit', defaultValue: 25, maximum: MAX_PAYROLL_HISTORY_PAGE_SIZE,
        });
        const cursor = parseOpaqueCursor(cursorRaw, 'cursor');
        return this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            const rows = await tx.payrollPeriod.findMany({
                where: { tenantId: actor.tenantId },
                orderBy: [{ localStartDate: 'desc' }, { id: 'desc' }],
                take: limit + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            const page = rows.slice(0, limit);
            const summaries = await loadPayrollPeriodSummaries(
                tx, actor.tenantId, page.map((period) => period.id),
            );
            return {
                data: page.map((period) => ({
                    ...serializePayrollPeriod(period),
                    summary: summaries.get(period.id)!,
                })),
                nextCursor: rows.length > limit && page.length > 0 ? page[page.length - 1].id : null,
            };
        });
    }

    async create(actor: PayrollActor, body: unknown, idempotencyKeyRaw: unknown) {
        const request = body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {};
        const localStartDate = normalizeLocalDate(request.localStartDate);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'PERIOD_CREATE',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { localStartDate },
        });
        const replay = await this.findCreateReplay(actor, identity);
        if (replay) return replay;

        try {
            return await retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
                await applyPayrollTransactionTimeouts(tx);
                await lockPayrollTenant(tx, actor.tenantId);
                const insideReplay = await readPayrollPeriodCreateReplay(tx, actor, identity);
                if (insideReplay) return insideReplay;
                const policy = await tx.payrollPolicyVersion.findFirst({
                    where: {
                        tenantId: actor.tenantId,
                        effectiveFrom: { lte: dateOnlyForPrisma(localStartDate) },
                    },
                    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
                });
                if (!policy) throw new BadRequestException('No payroll policy is effective for localStartDate.');
                const boundaries = payrollPeriodBoundaries(localStartDate, {
                    timeZone: policy.timeZone,
                    cadence: policy.cadence,
                    anchorDate: serializeDateOnly(policy.anchorDate),
                });
                const overlap = await tx.payrollPeriod.findFirst({
                    where: {
                        tenantId: actor.tenantId,
                        startsAt: { lt: boundaries.endsAt },
                        endsAt: { gt: boundaries.startsAt },
                    },
                    select: { id: true },
                });
                if (overlap) throw new ConflictException('Payroll period overlaps an existing period.');
                const created = await tx.payrollPeriod.create({
                    data: {
                        tenantId: actor.tenantId,
                        policyVersionId: policy.id,
                        localStartDate: dateOnlyForPrisma(boundaries.localStartDate),
                        localEndDateExclusive: dateOnlyForPrisma(boundaries.localEndDateExclusive),
                        startsAt: boundaries.startsAt,
                        endsAt: boundaries.endsAt,
                        timeZone: policy.timeZone,
                        cadence: policy.cadence,
                    },
                });
                const response = serializePayrollPeriod(created);
                await writePayrollOperation(tx, actor, identity, 'PERIOD_CREATE', created.id, response);
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_PERIOD_CREATED', resource: 'PayrollPeriod',
                    resourceId: created.id, newValue: response,
                });
                return response;
            }, PAYROLL_TRANSACTION_OPTIONS));
        } catch (error) {
            if (isPrismaUniqueConflict(error)) {
                const racedReplay = await this.findCreateReplay(actor, identity);
                if (racedReplay) return racedReplay;
                throw new ConflictException('Payroll period conflicts with an existing period.');
            }
            throw error;
        }
    }

    async startReview(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        const periodId = requiredId(periodIdRaw, 'periodId');
        const request = body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : {};
        const expectedRevision = parseExpectedRevision(request.expectedRevision);
        const identity = payrollRequestIdentity({
            ...actor,
            actorUserId: actor.userId,
            operation: 'REVIEW',
            idempotencyKey: normalizePayrollIdempotencyKey(idempotencyKeyRaw),
            body: { periodId, expectedRevision },
        });
        const replay = await this.findReplay(actor, identity, periodId);
        if (replay) return replay;

        return retryPayrollSerializableMutation(() => this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            await applyPayrollTransactionTimeouts(tx);
            await lockPayrollTenant(tx, actor.tenantId);
            await lockPayrollPeriod(tx, actor.tenantId, periodId);
            const insideReplay = await readPayrollOperationReplay(tx, actor, identity, 'REVIEW', periodId);
            if (insideReplay) return insideReplay;
            const period = await this.requirePeriod(tx, actor.tenantId, periodId);
            if (period.status !== 'OPEN') throw new ConflictException('Only an open payroll period can enter review.');
            if (period.revision !== expectedRevision) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
            if (period.endsAt.getTime() > Date.now()) {
                throw new BadRequestException('Payroll review cannot begin before the period ends.');
            }
            const candidates = await lockPayrollCandidateCards(tx, actor.tenantId, period);
            validatePayrollCandidateCards(candidates, period);
            const changed = await tx.payrollPeriod.updateMany({
                where: { id: period.id, tenantId: actor.tenantId, status: 'OPEN', revision: expectedRevision },
                data: {
                    status: 'REVIEW', revision: { increment: 1 },
                    reviewStartedAt: new Date(), reviewStartedByUserId: actor.userId,
                },
            });
            if (changed.count !== 1) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
            const updated = await this.requirePeriod(tx, actor.tenantId, period.id);
            const response = serializePayrollPeriod(updated);
            await writePayrollOperation(tx, actor, identity, 'REVIEW', period.id, response);
            await writePayrollAudit(tx, actor, {
                action: 'PAYROLL_PERIOD_REVIEW_STARTED', resource: 'PayrollPeriod', resourceId: period.id,
                oldValue: serializePayrollPeriod(period), newValue: response,
            });
            return response;
        }, PAYROLL_TRANSACTION_OPTIONS));
    }

    private async findCreateReplay(actor: PayrollActor, identity: { operationId: string; requestHash: string }) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            readPayrollPeriodCreateReplay(tx, actor, identity));
    }

    private async findReplay(
        actor: PayrollActor,
        identity: { operationId: string; requestHash: string },
        periodId: string,
    ) {
        return this.tenantDb.withTenant(actor.tenantId, (tx) =>
            readPayrollOperationReplay(tx, actor, identity, 'REVIEW', periodId));
    }

    private async requirePeriod(tx: TenantPrismaTransaction, tenantId: string, periodId: string) {
        const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId } });
        if (!period) throw new NotFoundException('Payroll period not found.');
        return period;
    }
}
