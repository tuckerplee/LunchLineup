import {
    Body,
    Controller,
    Get,
    Headers,
    Param,
    Post,
    Put,
    Query,
    Req,
    Res,
} from '@nestjs/common';

import { RequirePermission } from '../auth/require-permission.decorator';
import { PayrollAmendmentService } from './payroll-amendment.service';
import { PayrollCardService } from './payroll-card.service';
import { PayrollExportService } from './payroll-export.service';
import { PayrollLockService } from './payroll-lock.service';
import { PayrollPeriodService } from './payroll-period.service';
import { PayrollPolicyService } from './payroll-policy.service';
import { PayrollReadService } from './payroll-read.service';
import { PayrollReconciliationService } from './payroll-reconciliation.service';
import type { PayrollActor } from './payroll-transaction';

type AuthenticatedRequest = {
    user: { sub: string; tenantId: string };
};

@Controller({ path: 'payroll', version: '1' })
export class PayrollController {
    constructor(
        private readonly policies: PayrollPolicyService,
        private readonly periods: PayrollPeriodService,
        private readonly cards: PayrollCardService,
        private readonly amendments: PayrollAmendmentService,
        private readonly reads: PayrollReadService,
        private readonly locks: PayrollLockService,
        private readonly exports: PayrollExportService,
        private readonly reconciliation: PayrollReconciliationService,
    ) {}

    @Get('export-entitlement')
    @RequirePermission('payroll:export')
    exportEntitlement(@Req() req: AuthenticatedRequest) {
        return this.exports.entitlement(this.actor(req));
    }

    @Get('policies')
    @RequirePermission('payroll:read')
    listPolicies(
        @Req() req: AuthenticatedRequest,
        @Query('limit') limit?: string,
        @Query('cursor') cursor?: string,
    ) {
        return this.policies.list(this.actor(req), limit, cursor);
    }

    @Get('policy')
    @RequirePermission('payroll:read')
    getPolicy(@Req() req: AuthenticatedRequest) {
        return this.policies.latest(this.actor(req));
    }

    @Put('policy')
    @RequirePermission('payroll:policy_write')
    createPolicy(
        @Req() req: AuthenticatedRequest,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.policies.create(this.actor(req), body, idempotencyKey);
    }

    @Get('periods')
    @RequirePermission('payroll:read')
    listPeriods(
        @Req() req: AuthenticatedRequest,
        @Query('limit') limit?: string,
        @Query('cursor') cursor?: string,
    ) {
        return this.periods.list(this.actor(req), limit, cursor);
    }

    @Post('periods')
    @RequirePermission('payroll:policy_write')
    createPeriod(
        @Req() req: AuthenticatedRequest,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.periods.create(this.actor(req), body, idempotencyKey);
    }

    @Get('periods/:id')
    @RequirePermission('payroll:read')
    getPeriod(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Query('cardLimit') cardLimit?: string,
        @Query('cardCursor') cardCursor?: string,
        @Query('lineLimit') lineLimit?: string,
        @Query('lineCursor') lineCursor?: string,
    ) {
        return this.reads.getPeriod(this.actor(req), id, cardLimit, cardCursor, lineLimit, lineCursor);
    }

    @Post('periods/:id/adopt')
    @RequirePermission('payroll:policy_write')
    adoptCards(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.cards.adopt(this.actor(req), id, body, idempotencyKey);
    }

    @Post('periods/:id/review')
    @RequirePermission('payroll:lock')
    startReview(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.periods.startReview(this.actor(req), id, body, idempotencyKey);
    }

    @Post('periods/:id/decisions')
    @RequirePermission('time_cards:approve')
    decideCards(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.cards.decide(this.actor(req), id, body, idempotencyKey);
    }

    @Post('periods/:id/lock')
    @RequirePermission('payroll:lock')
    lockPeriod(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.locks.lock(this.actor(req), id, body, idempotencyKey);
    }

    @Post('entries/:id/amendments')
    @RequirePermission('payroll:reconcile')
    createAmendment(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.amendments.create(this.actor(req), id, body, idempotencyKey);
    }

    @Post('amendments/:id/decision')
    @RequirePermission('time_cards:approve')
    decideAmendment(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.amendments.decide(this.actor(req), id, body, idempotencyKey);
    }

    @Post('periods/:id/exports')
    @RequirePermission('payroll:export')
    createExport(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.exports.create(this.actor(req), id, body, idempotencyKey);
    }

    @Get('exports/:id/download')
    @RequirePermission('payroll:export')
    async downloadExport(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Res() response: any,
    ): Promise<void> {
        const artifact = await this.exports.download(this.actor(req), id);
        response.setHeader('Content-Type', 'text/csv; charset=utf-8');
        response.setHeader('Content-Length', String(artifact.content.length));
        response.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.send(artifact.content);
    }

    @Get('exports/:id')
    @RequirePermission('payroll:read')
    getExport(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Query('lineLimit') lineLimit?: string,
        @Query('lineCursor') lineCursor?: string,
    ) {
        return this.reads.getExport(this.actor(req), id, lineLimit, lineCursor);
    }

    @Post('exports/:id/reconciliation')
    @RequirePermission('payroll:reconcile')
    reconcileExport(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.reconciliation.reconcile(this.actor(req), id, body);
    }

    private actor(req: AuthenticatedRequest): PayrollActor {
        return { tenantId: req.user.tenantId, userId: req.user.sub };
    }
}
