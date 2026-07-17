import { BadRequestException, Controller, Post, Body, Req, Headers, HttpCode, Get, SetMetadata } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { FeatureAccessService } from './feature-access.service';
import { StripeMeterErrorService } from './stripe-meter-error.service';

const Public = () => SetMetadata('isPublic', true);

type StripeWebhookRequest = Request & {
    rawBody?: Buffer;
};

@Controller('billing')
export class BillingController {
    constructor(
        private readonly stripeService: StripeService,
        private readonly featureAccessService: FeatureAccessService,
        private readonly stripeMeterErrorService: StripeMeterErrorService,
    ) { }

    @Get('features')
    @RequirePermission('billing:read')
    async features(@Req() req: any) {
        const matrix = await this.featureAccessService.getFeatureMatrix(req.user.tenantId);
        const subscriptionRecoveryAction = matrix.stripeSubscriptionPresent
            ? await this.stripeService.getTenantSubscriptionRecoveryAction(req.user.tenantId)
            : null;
        return { ...matrix, subscriptionRecoveryAction };
    }

    @Get('price-options')
    @RequirePermission('billing:read')
    async priceOptions() {
        return { data: this.stripeService.getPriceOptions() };
    }

    @Get('credit-packs')
    @RequirePermission('billing:read')
    async creditPackOptions() {
        return { data: await this.stripeService.getCreditPackOptions() };
    }

    @Post('credit-packs/checkout')
    @RequirePermission('billing:write')
    async purchaseCreditPack(
        @Req() req: any,
        @Body() body: { code: string },
    ) {
        return this.stripeService.createCreditPackCheckoutSession(req.user.tenantId, body.code);
    }

    @Post('subscribe')
    @RequirePermission('billing:write')
    async subscribe(
        @Req() req: any,
        @Body() body: { priceId: string }
    ) {
        const tenantId = req.user.tenantId;

        return this.stripeService.createSubscriptionCheckoutSession(tenantId, {
            email: req.user.email,
            name: req.user.name,
        }, body.priceId);
    }

    @Post('portal')
    @RequirePermission('billing:write')
    async portal(@Req() req: any) {
        return this.stripeService.createBillingPortalSession(req.user.tenantId);
    }

    @Post('change-plan')
    @RequirePermission('billing:write')
    async changePlan(
        @Req() req: any,
        @Body() body: { priceId: string },
    ) {
        return this.stripeService.changeTenantSubscriptionPlan(req.user.tenantId, body.priceId);
    }

    @Post('resume')
    @RequirePermission('billing:write')
    async resume(@Req() req: any) {
        return this.stripeService.resumeTenantSubscription(req.user.tenantId);
    }

    @Post('webhook')
    @Public()
    @HttpCode(200)
    async handleStripeWebhook(
        @Req() req: StripeWebhookRequest,
        @Headers('stripe-signature') signature?: string
    ) {
        const payload = Buffer.isBuffer(req.rawBody)
            ? req.rawBody
            : Buffer.isBuffer(req.body)
                ? req.body
                : null;

        if (!payload) {
            throw new BadRequestException('Missing raw Stripe webhook body');
        }

        await this.stripeService.handleWebhook(payload, signature);

        return { received: true };
    }

    @Post('meter-errors/webhook')
    @Public()
    @HttpCode(200)
    async handleStripeMeterErrorWebhook(
        @Req() req: StripeWebhookRequest,
        @Headers('stripe-signature') signature?: string,
    ) {
        const payload = Buffer.isBuffer(req.rawBody)
            ? req.rawBody
            : Buffer.isBuffer(req.body)
                ? req.body
                : null;
        if (!payload) {
            throw new BadRequestException('Missing raw Stripe meter error webhook body');
        }
        const reconciliation = await this.stripeMeterErrorService.handleWebhook(payload, signature);
        return { received: true, ...reconciliation };
    }
}
