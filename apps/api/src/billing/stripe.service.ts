import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@lunchlineup/db';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
    private stripe: Stripe;
    private readonly logger = new Logger(StripeService.name);
    private readonly prisma = new PrismaClient();

    constructor(private configService: ConfigService) {
        this.stripe = new Stripe(this.configService.get<string>('STRIPE_SECRET_KEY')!, {
            apiVersion: '2024-04-10' as any,
        });
    }

    async createCustomer(tenantId: string, email: string, name: string) {
        const customer = await this.stripe.customers.create({ email, name, metadata: { tenantId } });

        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: { stripeCustomerId: customer.id }
        });

        return customer;
    }

    async createSubscription(tenantId: string, customerId: string, priceId: string) {
        // Core thesis check - does the tenant have usage credits? If so, map subscription securely
        const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) throw new Error('Tenant not found');

        const subscription = await this.stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            payment_behavior: tenant.usageCredits > 0 ? 'allow_incomplete' : 'default_incomplete',
            expand: ['latest_invoice.payment_intent'],
            metadata: { tenantId }
        });

        await this.prisma.tenant.update({
            where: { id: tenantId },
            data: {
                stripeSubscriptionId: subscription.id,
                status: 'ACTIVE' // Mark as active regardless if credits are shielding the invoice
            }
        });

        return subscription;
    }

    async handleWebhook(payload: Buffer, signature: string) {
        const endpointSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET')!;
        let event: Stripe.Event;

        try {
            event = this.stripe.webhooks.constructEvent(payload, signature, endpointSecret);
        } catch (err) {
            this.logger.error(`Webhook signature verification failed: ${(err as Error).message}`);
            throw new Error(`Webhook Error: ${(err as Error).message}`);
        }

        const data = event.data.object as any;
        const tenantId = data.metadata?.tenantId || data.customer_details?.metadata?.tenantId;

        if (tenantId) {
            await this.prisma.billingEvent.create({
                data: {
                    tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    amount: data.amount_paid || data.amount_total || null,
                    currency: data.currency || 'usd',
                    metadata: JSON.parse(JSON.stringify(data))
                }
            });
        }

        switch (event.type) {
            case 'invoice.paid':
                if (tenantId) {
                    await this.prisma.tenant.update({
                        where: { id: tenantId },
                        data: { status: 'ACTIVE' }
                    });
                    this.logger.log(`Invoice paid for tenant ${tenantId}, marked ACTIVE`);
                }
                break;
            case 'customer.subscription.deleted':
            case 'customer.subscription.paused':
                if (tenantId) {
                    await this.prisma.tenant.update({
                        where: { id: tenantId },
                        data: { status: 'SUSPENDED' }
                    });
                    this.logger.log(`Subscription ${event.type} for tenant ${tenantId}, marked SUSPENDED`);
                }
                break;
            default:
                this.logger.debug(`Unhandled webhook event type: ${event.type}`);
        }
    }
}
