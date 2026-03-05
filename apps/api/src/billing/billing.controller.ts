import { Controller, Post, Body, Req, Headers, UseGuards, Param, HttpCode } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { MeteringService } from './metering.service';
import { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';

@Controller('billing')
export class BillingController {
    constructor(
        private readonly stripeService: StripeService,
        private readonly meteringService: MeteringService
    ) { }

    @Post('subscribe')
    @RequirePermission('billing:write')
    async subscribe(
        @Req() req: any,
        @Body() body: { priceId: string }
    ) {
        const tenantId = req.user.tenantId;

        // Ensure customer exists
        const customer = await this.stripeService.createCustomer(tenantId, req.user.email, req.user.name);

        // Attempt to create a subscription, which inherently honors usage credits if available
        const subscription = await this.stripeService.createSubscription(tenantId, customer.id, body.priceId);

        return { subscriptionId: subscription.id };
    }

    @Post('credits/grant')
    @RequirePermission('admin:write') // Only system admins should grant credits ad-hoc
    async grantCredits(
        @Body() body: { tenantId: string, amount: number, reason: string }
    ) {
        const { tenantId, amount, reason } = body;
        const newBalance = await this.meteringService.grantCredits(tenantId, amount, reason);
        return { success: true, newBalance };
    }

    @Post('webhook')
    @HttpCode(200)
    // We intentionally bypass standard JSON body parsing to capture raw Buffer for Stripe signature validation.
    // In a real app, ensure `app.use('/billing/webhook', express.raw({type: 'application/json'}))` is deployed.
    async handleStripeWebhook(
        @Req() req: Request,
        @Headers('stripe-signature') signature: string
    ) {
        if (!signature) {
            throw new Error('Missing stripe-signature header');
        }

        // The req.body here needs to be the raw Buffer. 
        // This requires configuring NestJS global middleware to not JSON-parse this explicit route.
        await this.stripeService.handleWebhook(req.body as any, signature);

        return { received: true };
    }
}
