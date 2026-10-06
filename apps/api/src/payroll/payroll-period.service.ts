import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuthService } from '../auth/auth.service';
import { RbacService } from '../auth/rbac.service';
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
    isPrismaUniqueConflict,
    lockPayrollPeriod,
    lockPayrollTenant,
    PAYROLL_CONCURRENT_CHANGE,
    runCurrentPayrollMutation,
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
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbac: RbacService,
        private readonly authService: AuthService,
    ) {}

    async list(actor: PayrollActor, limitRaw?: unknown, cursorRaw?: unknown) {
        actor = Object.freeze({ ...actor });
        const limit = parseBoundedLimit(limitRaw, {
            field: 'limit', defaultValue: 25, maximum: MAX_PAYROLL_HISTORY_PAGE_SIZE,
        });
        const cursor = parseOpaqueCursor(cursorRaw, 'cursor');
        return runCurrentPayrollMutation(this.rbac, this.authService, actor, 'payroll:read', async (tx, assertCurrent, actor) => {
            const rows = await tx.payrollPeriod.findMany({
                where: { tenantId: actor.tenantId },
                orderBy: [{ localStartDate: 'desc' }, { id: 'desc' }],
                take: limit + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            assertCurrent();
            const page = rows.slice(0, limit);
            const summaries = await loadPayrollPeriodSummaries(
                tx, actor.tenantId, page.map((period) => period.id), assertCurrent,
            );
            assertCurrent();
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
        actor = Object.freeze({ ...actor });
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
        return runCurrentPayrollMutation(this.rbac, this.authService, actor, 'payroll:policy_write',
            async (tx, assertCurrent, actor) => {
                assertCurrent();
                const replay = await readPayrollPeriodCreateReplay(tx, actor, identity);
                assertCurrent();
                if (replay) return replay;

                assertCurrent();
                await lockPayrollTenant(tx, actor.tenantId);
                assertCurrent();
                const insideReplay = await readPayrollPeriodCreateReplay(tx, actor, identity);
                assertCurrent();
                if (insideReplay) return insideReplay;
                assertCurrent();
                const policy = await tx.payrollPolicyVersion.findFirst({
                    where: {
                        tenantId: actor.tenantId,
                        effectiveFrom: { lte: dateOnlyForPrisma(localStartDate) },
                    },
                    orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
                });
                assertCurrent();
                if (!policy) throw new BadRequestException('No payroll policy is effective for localStartDate.');
                const boundaries = payrollPeriodBoundaries(localStartDate, {
                    timeZone: policy.timeZone,
                    cadence: policy.cadence,
                    anchorDate: serializeDateOnly(policy.anchorDate),
                });
                assertCurrent();
                const overlap = await tx.payrollPeriod.findFirst({
                    where: {
                        tenantId: actor.tenantId,
                        startsAt: { lt: boundaries.endsAt },
                        endsAt: { gt: boundaries.startsAt },
                    },
                    select: { id: true },
                });
                assertCurrent();
                if (overlap) throw new ConflictException('Payroll period overlaps an existing period.');
                assertCurrent();
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
                assertCurrent();
                const response = serializePayrollPeriod(created);
                assertCurrent();
                await writePayrollOperation(tx, actor, identity, 'PERIOD_CREATE', created.id, response, assertCurrent);
                assertCurrent();
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_PERIOD_CREATED', resource: 'PayrollPeriod',
                    resourceId: created.id, newValue: response,
                }, assertCurrent);
                assertCurrent();
                return response;
            }, {
            isRecoverable: isPrismaUniqueConflict,
            operation: async (tx, assertCurrent, actor, error) => {
                assertCurrent();
                const replay = await readPayrollPeriodCreateReplay(tx, actor, identity);
                assertCurrent();
                if (replay) return replay;
                throw new ConflictException('Payroll period conflicts with an existing period.');
            },
        });
    }

    async startReview(actor: PayrollActor, periodIdRaw: unknown, body: unknown, idempotencyKeyRaw: unknown) {
        actor = Object.freeze({ ...actor });
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
        return runCurrentPayrollMutation(this.rbac, this.authService, actor, 'payroll:lock',
            async (tx, assertCurrent, actor) => {
                assertCurrent();
                const replay = await readPayrollOperationReplay(tx, actor, identity, 'REVIEW', periodId);
                assertCurrent();
                if (replay) return replay;

                assertCurrent();
                await lockPayrollTenant(tx, actor.tenantId);
                assertCurrent();
                await lockPayrollPeriod(tx, actor.tenantId, periodId);
                assertCurrent();
                const insideReplay = await readPayrollOperationReplay(tx, actor, identity, 'REVIEW', periodId);
                assertCurrent();
                if (insideReplay) return insideReplay;
                assertCurrent();
                const period = await this.requirePeriod(tx, actor.tenantId, periodId);
                assertCurrent();
                if (period.status !== 'OPEN') throw new ConflictException('Only an open payroll period can enter review.');
                if (period.revision !== expectedRevision) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
                if (period.endsAt.getTime() > Date.now()) {
                    throw new BadRequestException('Payroll review cannot begin before the period ends.');
                }
                assertCurrent();
                const candidates = await lockPayrollCandidateCards(tx, actor.tenantId, period);
                assertCurrent();
                validatePayrollCandidateCards(candidates, period);
                assertCurrent();
                const changed = await tx.payrollPeriod.updateMany({
                    where: { id: period.id, tenantId: actor.tenantId, status: 'OPEN', revision: expectedRevision },
                    data: {
                        status: 'REVIEW', revision: { increment: 1 },
                        reviewStartedAt: new Date(), reviewStartedByUserId: actor.userId,
                    },
                });
                assertCurrent();
                if (changed.count !== 1) throw new ConflictException(PAYROLL_CONCURRENT_CHANGE);
                assertCurrent();
                const updated = await this.requirePeriod(tx, actor.tenantId, period.id);
                assertCurrent();
                const response = serializePayrollPeriod(updated);
                assertCurrent();
                await writePayrollOperation(tx, actor, identity, 'REVIEW', period.id, response, assertCurrent);
                assertCurrent();
                await writePayrollAudit(tx, actor, {
                    action: 'PAYROLL_PERIOD_REVIEW_STARTED', resource: 'PayrollPeriod', resourceId: period.id,
                    oldValue: serializePayrollPeriod(period), newValue: response,
                }, assertCurrent);
                assertCurrent();
                return response;
            });
    }


    private async requirePeriod(tx: TenantPrismaTransaction, tenantId: string, periodId: string) {
        const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId } });
        if (!period) throw new NotFoundException('Payroll period not found.');
        return period;
    }
}
