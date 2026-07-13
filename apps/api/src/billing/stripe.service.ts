import { BadRequestException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanTier, Prisma, PrismaClient, TenantStatus } from '@lunchlineup/db';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { resolveTenantPlanDefinition } from './plan-definitions';
import {
    assertTenantActiveLocationCountWithinPlan,
    assertTenantActiveUserCountWithinPlan,
} from './user-capacity';
import Stripe from 'stripe';
import { createHash } from 'crypto';

type StripeWebhookObject = Record<string, any>;
type CheckoutActor = {
    email?: string | null;
    name?: string | null;
};

type CheckoutSessionResponse = {
    sessionId: string;
    checkoutUrl: string;
};
type CheckoutSessionResolution = {
    reusable: CheckoutSessionResponse | null;
    generation: string;
};

type BillingPortalSessionResponse = {
    portalUrl: string;
};

export type TenantSubscriptionPlanChangeResult = {
    action: 'unchanged' | 'updated';
    stripeSubscriptionId: string;
    stripeStatus: string | null;
    planTier: PlanTier;
};

export type TenantSubscriptionResumeResult = {
    action: 'resumed' | 'payment_required';
    stripeSubscriptionId: string;
    stripeStatus: string | null;
    paymentUrl: string | null;
    paymentFlow: 'hosted_invoice' | 'billing_portal' | null;
};

export type TenantSubscriptionRecoveryAction = 'resume' | 'portal' | null;

type StripeBillingMetadataValue = string | number | boolean | string[];
type StripeCancellationAction = 'none' | 'already_canceled' | 'already_scheduled' | 'scheduled';
type StripeEntitlementEventOrder = {
    created: number;
    terminalPriority: number;
    id: string;
};
type StripeSideEffectDisposition =
    | 'applied'
    | 'post_purge_cancelled'
    | 'skipped_stale'
    | 'skipped_suspended'
    | 'skipped_unverified_subscription';
type StripeWebhookSubscriptionResolution = {
    subscription: StripeWebhookObject | null;
    verified: boolean;
};
type StripeWebhookTenantContext = {
    tenantId: string | null;
    subscriptionId: string | null;
    subscription: StripeWebhookObject | null;
    purgedTenant?: boolean;
};

const AUTHORITATIVE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
    'active',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'past_due',
    'paused',
    'trialing',
    'unpaid',
]);

const STRIPE_ENTITLEMENT_EVENT_TYPES = new Set<string>([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'customer.subscription.paused',
    'customer.subscription.resumed',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.finalization_failed',
]);

const SAFE_BILLING_PORTAL_POLICY = 'server_controlled_plan_changes_v1';

export type TenantSubscriptionCancellationResult = {
    action: StripeCancellationAction;
    stripeSubscriptionId: string | null;
    stripeStatus: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
    cancelAt: string | null;
    canceledAt: string | null;
    cancellationBehavior: 'cancel_at_period_end';
};

export type TenantBillingPurgeResult = {
    expiredCheckoutSessionIds: string[];
    canceledSubscriptionIds: string[];
    alreadyTerminalSubscriptionIds: string[];
};

const STRIPE_PRICE_CONFIG_KEYS = [
    { code: 'STARTER', label: 'Starter', key: 'STRIPE_PRICE_STARTER' },
    { code: 'GROWTH', label: 'Growth', key: 'STRIPE_PRICE_GROWTH' },
    { code: 'ENTERPRISE', label: 'Enterprise', key: 'STRIPE_PRICE_ENTERPRISE' },
] as const;
const CHECKOUT_BLOCKED_TENANT_STATUSES = new Set<TenantStatus>([
    TenantStatus.SUSPENDED,
    TenantStatus.PURGED,
]);
const INVOICE_BINDING_BLOCKED_TENANT_STATUSES = new Set<TenantStatus>([
    TenantStatus.CANCELLED,
    TenantStatus.PURGED,
    TenantStatus.SUSPENDED,
]);

@Injectable()
export class StripeService {
    private stripe: Stripe | null;
    private safeBillingPortalConfigurationPromise: Promise<string> | null = null;
    private readonly logger = new Logger(StripeService.name);
    private readonly prisma: PrismaClient;
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private configService: ConfigService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.prisma = tenantDb?.client ?? new PrismaClient();
        this.tenantDb = tenantDb ?? new TenantPrismaService(this.prisma);
        const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY');
        if (!apiKey && process.env.NODE_ENV !== 'development') {
            throw new Error('STRIPE_SECRET_KEY must be configured outside local development.');
        }
        this.stripe = apiKey
            ? new Stripe(apiKey, { apiVersion: '2024-04-10' as any })
            : null;
    }

    async createCustomer(tenantId: string, email: string, name: string) {
        this.getStripe();
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            const customer = await this.ensureCustomer(tx, tenantId, { email, name });
            return customer.created ?? this.getStripe().customers.retrieve(customer.id);
        });
    }

    getPriceOptions() {
        return STRIPE_PRICE_CONFIG_KEYS.map((option) => {
            const priceId = this.configService.get<string>(option.key)?.trim() || null;
            return {
                code: option.code,
                label: option.label,
                priceId,
                configured: Boolean(priceId),
            };
        });
    }

    async createSubscriptionCheckoutSession(
        tenantId: string,
        actor: CheckoutActor,
        priceId: string,
    ): Promise<CheckoutSessionResponse> {
        const allowedPriceId = this.resolveAllowedPriceId(priceId);
        const planCode = this.resolvePlanCodeForPriceId(allowedPriceId);
        if (!planCode) {
            throw new BadRequestException('Price is not mapped to a supported plan');
        }
        const metadata = { tenantId, planCode, priceId: allowedPriceId };
        const returnOrigin = this.resolveBillingReturnOrigin();
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            await this.assertTenantCanStartCheckout(tx, tenantId, planCode);
            const customer = await this.ensureCustomer(tx, tenantId, actor);
            await this.assertCustomerHasNoBlockingSubscription(customer.id);

            const openSessions = await this.resolveOpenCheckoutSessions(
                customer.id,
                tenantId,
                allowedPriceId,
                planCode,
            );
            if (openSessions.reusable) {
                return openSessions.reusable;
            }

            const session = await this.getStripe().checkout.sessions.create({
                mode: 'subscription',
                customer: customer.id,
                line_items: [{ price: allowedPriceId }],
                success_url: `${returnOrigin}/dashboard/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${returnOrigin}/dashboard/settings?billing=cancelled`,
                client_reference_id: tenantId,
                metadata,
                subscription_data: { metadata },
                allow_promotion_codes: true,
            } as any, {
                idempotencyKey: this.checkoutIdempotencyKey(tenantId, allowedPriceId, openSessions.generation),
            });

            const sessionId = this.asString(session.id);
            const checkoutUrl = this.asString(session.url);
            if (!sessionId || !checkoutUrl) {
                this.logger.error('Stripe Checkout did not return a session URL.');
                throw new ServiceUnavailableException('Stripe Checkout did not return a session URL');
            }

            return { sessionId, checkoutUrl };
        });
    }

    private async assertTenantCanStartCheckout(
        tx: Prisma.TransactionClient,
        tenantId: string,
        planCode: PlanTier,
    ): Promise<void> {
        const plan = await resolveTenantPlanDefinition(tx as any, planCode);
        if (!plan?.active) {
            throw new BadRequestException('Selected subscription plan is not available.');
        }
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { id: true, status: true, stripeSubscriptionId: true, deletedAt: true },
        });
        if (!tenant) throw new BadRequestException('Tenant not found');
        if (tenant.deletedAt || CHECKOUT_BLOCKED_TENANT_STATUSES.has(tenant.status)) {
            throw new BadRequestException('This tenant cannot start a new subscription checkout.');
        }
        if (tenant.stripeSubscriptionId) {
            throw new BadRequestException('Use the billing portal to manage an existing subscription.');
        }
        await this.assertTenantFitsPlan(tx, tenantId, planCode);
    }

    private async resolveOpenCheckoutSessions(
        customerId: string,
        tenantId: string,
        priceId: string,
        planCode: PlanTier,
    ): Promise<CheckoutSessionResolution> {
        const sessions = await this.getStripe().checkout.sessions.list({
            customer: customerId,
            status: 'open',
            limit: 10,
        });
        let reusable: CheckoutSessionResponse | null = null;
        const tenantSessionIds: string[] = [];
        for (const session of sessions.data) {
            if (session.metadata?.tenantId !== tenantId || !session.id) continue;
            tenantSessionIds.push(session.id);
            const exactPrice = session.metadata?.priceId === priceId;
            const exactPlan = session.metadata?.planCode === planCode;
            if (!reusable && exactPrice && exactPlan && session.url) {
                reusable = { sessionId: session.id, checkoutUrl: session.url };
                continue;
            }
            await this.getStripe().checkout.sessions.expire(session.id);
        }
        return {
            reusable,
            generation: tenantSessionIds.sort().join(',') || 'none',
        };
    }

    private async assertCustomerHasNoBlockingSubscription(customerId: string): Promise<void> {
        const subscriptions = await this.getStripe().subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 100,
        });
        const blockingStatuses = new Set([
            'active',
            'trialing',
            'past_due',
            'unpaid',
            'incomplete',
            'paused',
        ]);
        if (subscriptions.data.some((subscription) => blockingStatuses.has(subscription.status))) {
            throw new BadRequestException('Use the billing portal to manage an existing subscription.');
        }
    }

    private checkoutIdempotencyKey(tenantId: string, priceId: string, sessionGeneration: string): string {
        const minuteBucket = Math.floor(Date.now() / 60_000);
        return createHash('sha256')
            .update(`subscription-checkout:${tenantId}:${priceId}:${sessionGeneration}:${minuteBucket}`)
            .digest('hex');
    }

    async createBillingPortalSession(tenantId: string): Promise<BillingPortalSessionResponse> {
        const tenant = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            return tx.tenant.findUnique({
                where: { id: tenantId },
                select: { stripeCustomerId: true, stripeSubscriptionId: true, deletedAt: true },
            });
        });
        if (!tenant || tenant.deletedAt) {
            throw new BadRequestException('Tenant not found');
        }
        if (!tenant.stripeCustomerId || !tenant.stripeSubscriptionId) {
            throw new BadRequestException('Start a new subscription checkout for this tenant.');
        }

        return this.createBillingPortalSessionForCustomer(tenant.stripeCustomerId);
    }

    private async createBillingPortalSessionForCustomer(customerId: string): Promise<BillingPortalSessionResponse> {
        const returnOrigin = this.resolveBillingReturnOrigin();
        const configuration = await this.getSafeBillingPortalConfigurationId();
        const session = await this.getStripe().billingPortal.sessions.create({
            configuration,
            customer: customerId,
            return_url: `${returnOrigin}/dashboard/settings?billing=portal-return`,
        });
        const portalUrl = this.asString(session.url);
        if (!portalUrl) {
            throw new ServiceUnavailableException('Stripe billing portal did not return a URL');
        }
        return { portalUrl };
    }

    async getTenantSubscriptionRecoveryAction(tenantId: string): Promise<TenantSubscriptionRecoveryAction> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            const tenant = await tx.tenant.findUnique({
                where: { id: tenantId },
                select: { deletedAt: true, stripeCustomerId: true, stripeSubscriptionId: true },
            });
            if (!tenant || tenant.deletedAt || !tenant.stripeCustomerId || !tenant.stripeSubscriptionId) {
                return null;
            }

            const subscription = await this.getStripe().subscriptions.retrieve(tenant.stripeSubscriptionId) as StripeWebhookObject;
            this.assertManagedSubscription(tenantId, tenant.stripeCustomerId, subscription, [
                'active',
                'trialing',
                'past_due',
                'unpaid',
                'incomplete',
                'incomplete_expired',
                'paused',
                'canceled',
            ]);
            const status = this.asString(subscription.status)?.toLowerCase();
            if (status === 'paused') return 'resume';
            if (['past_due', 'unpaid', 'incomplete'].includes(status ?? '')) return 'portal';
            return null;
        });
    }

    async changeTenantSubscriptionPlan(
        tenantId: string,
        priceId: string,
    ): Promise<TenantSubscriptionPlanChangeResult> {
        const allowedPriceId = this.resolveAllowedPriceId(priceId);
        const planCode = this.resolvePlanCodeForPriceId(allowedPriceId);
        if (!planCode) {
            throw new BadRequestException('Price is not mapped to a supported plan');
        }

        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            const targetPlan = await resolveTenantPlanDefinition(tx as any, planCode);
            if (!targetPlan?.active) {
                throw new BadRequestException('Selected subscription plan is not available.');
            }
            const { stripeSubscriptionId, subscription } = await this.retrieveManagedTenantSubscription(
                tx,
                tenantId,
                ['active', 'trialing'],
            );
            await this.assertTenantFitsPlan(tx, tenantId, planCode);

            const managedItems = (Array.isArray(subscription.items?.data) ? subscription.items.data : [])
                .filter((item: StripeWebhookObject) => this.resolvePlanCodeFromPriceIds(this.collectPriceIds(item)));
            if (managedItems.length !== 1 || !this.asString(managedItems[0].id)) {
                throw new BadRequestException('The Stripe subscription plan item is not safely manageable.');
            }
            const currentPriceId = this.collectPriceIds(managedItems[0])[0] ?? null;
            if (currentPriceId === allowedPriceId) {
                return {
                    action: 'unchanged',
                    stripeSubscriptionId,
                    stripeStatus: this.asString(subscription.status),
                    planTier: planCode,
                };
            }

            const updated = await this.getStripe().subscriptions.update(stripeSubscriptionId, {
                items: [{ id: managedItems[0].id, price: allowedPriceId }],
                payment_behavior: 'pending_if_incomplete',
                proration_behavior: 'create_prorations',
            });
            return {
                action: 'updated',
                stripeSubscriptionId,
                stripeStatus: this.asString((updated as StripeWebhookObject).status),
                planTier: planCode,
            };
        });
    }

    async resumeTenantSubscription(tenantId: string): Promise<TenantSubscriptionResumeResult> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            const { stripeSubscriptionId, subscription } = await this.retrieveManagedTenantSubscription(
                tx,
                tenantId,
                ['paused'],
            );
            const planCode = this.resolvePlanCodeFromPriceIds(this.collectPriceIds(subscription));
            if (!planCode) {
                throw new BadRequestException('The paused subscription price is not mapped to a supported plan.');
            }
            await this.assertTenantFitsPlan(tx, tenantId, planCode);

            const resumed = await this.getStripe().subscriptions.resume(stripeSubscriptionId, {
                billing_cycle_anchor: 'now',
                proration_behavior: 'none',
                expand: ['latest_invoice'],
            }) as StripeWebhookObject;
            const stripeStatus = this.asString(resumed.status)?.toLowerCase() ?? null;
            const resumedPlanCode = this.resolveCurrentSubscriptionPlanCode(resumed) ?? planCode;
            await this.applySubscriptionStatusUpdate(tx, tenantId, stripeSubscriptionId, resumed, resumedPlanCode);

            if (stripeStatus === 'active' || stripeStatus === 'trialing') {
                return {
                    action: 'resumed',
                    stripeSubscriptionId,
                    stripeStatus,
                    paymentUrl: null,
                    paymentFlow: null,
                };
            }

            const hostedInvoiceUrl = await this.resolveHostedInvoiceUrl(resumed.latest_invoice);
            if (hostedInvoiceUrl) {
                return {
                    action: 'payment_required',
                    stripeSubscriptionId,
                    stripeStatus,
                    paymentUrl: hostedInvoiceUrl,
                    paymentFlow: 'hosted_invoice',
                };
            }

            const portal = await this.createBillingPortalSessionForCustomer(this.resolveCustomerId(resumed) ?? this.resolveCustomerId(subscription)!);
            return {
                action: 'payment_required',
                stripeSubscriptionId,
                stripeStatus,
                paymentUrl: portal.portalUrl,
                paymentFlow: 'billing_portal',
            };
        });
    }

    private async resolveHostedInvoiceUrl(value: unknown): Promise<string | null> {
        if (value && typeof value === 'object') {
            return this.asString((value as StripeWebhookObject).hosted_invoice_url);
        }
        const invoiceId = this.asString(value);
        if (!invoiceId) return null;

        try {
            const invoice = await this.getStripe().invoices.retrieve(invoiceId) as StripeWebhookObject;
            return this.asString(invoice.hosted_invoice_url);
        } catch (err) {
            this.logger.warn(`Unable to retrieve Stripe resumption invoice; using billing portal recovery: ${(err as Error).message}`);
            return null;
        }
    }

    async createSubscription(tenantId: string, customerId: string, priceId: string) {
        const allowedPriceId = this.resolveAllowedPriceId(priceId);
        const planCode = this.resolvePlanCodeForPriceId(allowedPriceId);
        const tenant = await this.tenantDb.withTenant(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId } }));
        if (!tenant) throw new Error('Tenant not found');

        const subscription = await this.getStripe().subscriptions.create({
            customer: customerId,
            items: [{ price: allowedPriceId }],
            payment_behavior: tenant.usageCredits > 0 ? 'allow_incomplete' : 'default_incomplete',
            expand: ['latest_invoice.payment_intent'],
            metadata: planCode ? { tenantId, planCode } : { tenantId },
        });

        await this.tenantDb.withTenant(tenantId, (tx) => tx.tenant.update({
            where: { id: tenantId },
            data: {
                stripeSubscriptionId: subscription.id,
                ...(planCode ? { planTier: planCode } : {}),
            }
        }));

        return subscription;
    }

    async cancelTenantSubscriptionAtPeriodEnd(
        tenantId: string,
        stripeSubscriptionId?: string | null,
    ): Promise<TenantSubscriptionCancellationResult> {
        const subscriptionId = this.asString(stripeSubscriptionId) ?? await this.findTenantSubscriptionId(tenantId);

        if (!subscriptionId) {
            return this.buildSubscriptionCancellationResult('none', null, null);
        }

        const stripe = this.getStripe();
        const currentSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        const currentStatus = this.asString((currentSubscription as StripeWebhookObject).status);
        const currentCancelAtPeriodEnd = Boolean((currentSubscription as StripeWebhookObject).cancel_at_period_end);

        if (currentStatus === 'canceled' || (currentSubscription as StripeWebhookObject).deleted === true) {
            return this.buildSubscriptionCancellationResult('already_canceled', subscriptionId, currentSubscription as StripeWebhookObject);
        }

        if (currentCancelAtPeriodEnd) {
            return this.buildSubscriptionCancellationResult('already_scheduled', subscriptionId, currentSubscription as StripeWebhookObject);
        }

        const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        });
        const updatedStatus = this.asString((updatedSubscription as StripeWebhookObject).status);
        const updatedCancelAtPeriodEnd = Boolean((updatedSubscription as StripeWebhookObject).cancel_at_period_end);
        if (!updatedCancelAtPeriodEnd && updatedStatus !== 'canceled') {
            throw new ServiceUnavailableException('Stripe subscription cancellation was not confirmed');
        }

        return this.buildSubscriptionCancellationResult('scheduled', subscriptionId, updatedSubscription as StripeWebhookObject);
    }

    async finalizeTenantBillingForPurge(tenantId: string): Promise<TenantBillingPurgeResult> {
        const tenant = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            const tenantSnapshot = await tx.tenant.findUnique({
                where: { id: tenantId },
                select: {
                    id: true,
                    status: true,
                    deletedAt: true,
                    stripeCustomerId: true,
                    stripeSubscriptionId: true,
                },
            });
            if (!tenantSnapshot) throw new BadRequestException('Tenant not found');
            if (tenantSnapshot.status !== TenantStatus.SUSPENDED
                && tenantSnapshot.status !== TenantStatus.PURGED) {
                throw new BadRequestException('Tenant billing cleanup requires a suspended deletion barrier.');
            }
            return tenantSnapshot;
        });

        const result: TenantBillingPurgeResult = {
            expiredCheckoutSessionIds: [],
            canceledSubscriptionIds: [],
            alreadyTerminalSubscriptionIds: [],
        };
        if (!tenant.stripeCustomerId && !tenant.stripeSubscriptionId) return result;
        if (!tenant.stripeCustomerId) {
            throw new ServiceUnavailableException('Stripe customer ownership is not authoritative for tenant purge');
        }

        const stripe = this.getStripe();
        const openSessions = await this.collectStripePages((startingAfter) =>
            stripe.checkout.sessions.list({
                customer: tenant.stripeCustomerId!,
                status: 'open',
                limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {}),
            } as any));
        for (const session of openSessions) {
            if (this.asString(session.mode) !== 'subscription') continue;
            this.assertPurgeCheckoutSessionOwnership(tenantId, tenant.stripeCustomerId, session);
            const sessionId = this.asString(session.id)!;
            await this.expirePurgeCheckoutSession(tenantId, tenant.stripeCustomerId, sessionId);
            result.expiredCheckoutSessionIds.push(sessionId);
        }

        const candidates = new Map<string, { subscription: StripeWebhookObject; requireMetadata: boolean }>();
        const listedSubscriptions = await this.collectStripePages((startingAfter) =>
            stripe.subscriptions.list({
                customer: tenant.stripeCustomerId!,
                status: 'all',
                limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {}),
            } as any));
        for (const subscription of listedSubscriptions) {
            const subscriptionId = this.asString(subscription.id);
            if (!subscriptionId) {
                throw new ServiceUnavailableException('Stripe subscription identity is not authoritative for tenant purge');
            }
            const requireMetadata = subscriptionId !== tenant.stripeSubscriptionId;
            this.assertPurgeSubscriptionOwnership(
                tenantId,
                tenant.stripeCustomerId,
                subscription,
                requireMetadata,
            );
            candidates.set(subscriptionId, { subscription, requireMetadata });
        }

        if (tenant.stripeSubscriptionId && !candidates.has(tenant.stripeSubscriptionId)) {
            const subscription = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId, {
                expand: ['items.data.price'],
            } as any) as StripeWebhookObject;
            this.assertPurgeSubscriptionOwnership(tenantId, tenant.stripeCustomerId, subscription, false);
            candidates.set(tenant.stripeSubscriptionId, { subscription, requireMetadata: false });
        }

        for (const [subscriptionId, candidate] of candidates) {
            if (this.isTerminalSubscriptionState(candidate.subscription)) {
                result.alreadyTerminalSubscriptionIds.push(subscriptionId);
                continue;
            }

            let canceled: StripeWebhookObject;
            try {
                canceled = await stripe.subscriptions.cancel(subscriptionId) as StripeWebhookObject;
            } catch (error) {
                const current = await stripe.subscriptions.retrieve(subscriptionId, {
                    expand: ['items.data.price'],
                } as any) as StripeWebhookObject;
                this.assertPurgeSubscriptionOwnership(
                    tenantId,
                    tenant.stripeCustomerId,
                    current,
                    candidate.requireMetadata,
                );
                if (this.isTerminalSubscriptionState(current)) {
                    result.alreadyTerminalSubscriptionIds.push(subscriptionId);
                    continue;
                }
                throw error;
            }

            this.assertPurgeSubscriptionOwnership(
                tenantId,
                tenant.stripeCustomerId,
                canceled,
                candidate.requireMetadata,
            );
            if (!this.isTerminalSubscriptionState(canceled)) {
                throw new ServiceUnavailableException('Stripe subscription cancellation was not confirmed');
            }
            result.canceledSubscriptionIds.push(subscriptionId);
        }
        return result;
    }

    private async expirePurgeCheckoutSession(
        tenantId: string,
        customerId: string,
        sessionId: string,
    ): Promise<void> {
        const stripe = this.getStripe();
        try {
            const expired = await stripe.checkout.sessions.expire(sessionId) as StripeWebhookObject;
            if (this.asString(expired.status)?.toLowerCase() === 'expired') return;
            throw new ServiceUnavailableException('Stripe Checkout expiration was not confirmed');
        } catch (error) {
            const current = await stripe.checkout.sessions.retrieve(sessionId) as StripeWebhookObject;
            this.assertPurgeCheckoutSessionOwnership(tenantId, customerId, current);
            if (this.asString(current.status)?.toLowerCase() === 'expired') return;
            throw error;
        }
    }
    async assertTenantSubscriptionActive(tenantId: string, stripeSubscriptionId: string): Promise<void> {
        const subscription = await this.getStripe().subscriptions.retrieve(stripeSubscriptionId) as StripeWebhookObject;
        const status = this.asString(subscription.status)?.toLowerCase();
        if (subscription.deleted === true || !['active', 'trialing'].includes(status ?? '')) {
            throw new BadRequestException('The stored Stripe subscription is not active.');
        }
        if (subscription.cancel_at_period_end === true) {
            throw new BadRequestException('The stored Stripe subscription is scheduled for cancellation.');
        }
        const metadataTenantId = this.resolveTenantIdFromMetadata(subscription);
        if (metadataTenantId && metadataTenantId !== tenantId) {
            throw new BadRequestException('The stored Stripe subscription belongs to another tenant.');
        }
    }

    private async ensureCustomer(
        tx: Prisma.TransactionClient,
        tenantId: string,
        actor: CheckoutActor,
    ): Promise<{ id: string; created: Stripe.Customer | null }> {
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { id: true, stripeCustomerId: true },
        });
        if (!tenant) throw new Error('Tenant not found');
        if (tenant.stripeCustomerId) return { id: tenant.stripeCustomerId, created: null };

        const customer = await this.getStripe().customers.create({
            email: actor.email ?? undefined,
            name: actor.name ?? undefined,
            metadata: { tenantId },
        } as any, {
            idempotencyKey: this.stripeCustomerIdempotencyKey(tenantId),
        });

        const claimed = await tx.tenant.updateMany({
            where: { id: tenantId, stripeCustomerId: null },
            data: { stripeCustomerId: customer.id }
        });
        if (claimed.count === 0) {
            const current = await tx.tenant.findUnique({
                where: { id: tenantId },
                select: { stripeCustomerId: true },
            });
            if (current?.stripeCustomerId) {
                return { id: current.stripeCustomerId, created: null };
            }
            throw new ServiceUnavailableException('Stripe customer could not be attached to the tenant');
        }

        return { id: customer.id, created: customer };
    }

    private stripeCustomerIdempotencyKey(tenantId: string): string {
        return createHash('sha256')
            .update(`stripe-customer:${tenantId}`)
            .digest('hex');
    }

    private async getSafeBillingPortalConfigurationId(): Promise<string> {
        if (!this.safeBillingPortalConfigurationPromise) {
            this.safeBillingPortalConfigurationPromise = this.resolveSafeBillingPortalConfigurationId();
        }

        try {
            return await this.safeBillingPortalConfigurationPromise;
        } catch (err) {
            this.safeBillingPortalConfigurationPromise = null;
            throw err;
        }
    }

    private async resolveSafeBillingPortalConfigurationId(): Promise<string> {
        const stripe = this.getStripe();
        const configuredId = this.configService.get<string>('STRIPE_BILLING_PORTAL_CONFIGURATION_ID')?.trim();
        if (configuredId) {
            const configuration = await stripe.billingPortal.configurations.retrieve(configuredId);
            this.assertSafeBillingPortalConfiguration(configuration);
            return configuration.id;
        }

        const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
        const reusable = configurations.data.find((configuration) =>
            configuration.metadata?.lunchlineupPolicy === SAFE_BILLING_PORTAL_POLICY
            && configuration.features.subscription_update.enabled === false,
        );
        if (reusable) return reusable.id;

        const configuration = await stripe.billingPortal.configurations.create({
            name: 'LunchLineup safe self-service billing',
            metadata: { lunchlineupPolicy: SAFE_BILLING_PORTAL_POLICY },
            features: {
                invoice_history: { enabled: true },
                payment_method_update: { enabled: true },
                subscription_cancel: {
                    enabled: true,
                    mode: 'at_period_end',
                    proration_behavior: 'none',
                },
                subscription_update: { enabled: false },
            },
        }, {
            idempotencyKey: createHash('sha256').update(SAFE_BILLING_PORTAL_POLICY).digest('hex'),
        });
        this.assertSafeBillingPortalConfiguration(configuration);
        return configuration.id;
    }

    private assertSafeBillingPortalConfiguration(configuration: Stripe.BillingPortal.Configuration): void {
        if (!configuration.active || configuration.features.subscription_update.enabled !== false) {
            this.logger.error('Stripe billing portal configuration allows unsafe subscription plan changes.');
            throw new ServiceUnavailableException('Stripe billing portal safety policy is not configured');
        }
    }

    private assertManagedSubscription(
        tenantId: string,
        customerId: string,
        subscription: StripeWebhookObject,
        allowedStatuses: string[],
    ): void {
        const status = this.asString(subscription.status)?.toLowerCase();
        if (subscription.deleted === true || !allowedStatuses.includes(status ?? '')) {
            throw new BadRequestException(`The Stripe subscription is not ${allowedStatuses.join(' or ')}.`);
        }
        if (this.resolveCustomerId(subscription) !== customerId) {
            throw new BadRequestException('The Stripe subscription belongs to another customer.');
        }
        const metadataTenantId = this.resolveTenantIdFromMetadata(subscription);
        if (metadataTenantId && metadataTenantId !== tenantId) {
            throw new BadRequestException('The Stripe subscription belongs to another tenant.');
        }
    }

    private async retrieveManagedTenantSubscription(
        tx: Prisma.TransactionClient,
        tenantId: string,
        allowedStatuses: string[],
    ): Promise<{ stripeSubscriptionId: string; subscription: StripeWebhookObject }> {
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                deletedAt: true,
                stripeCustomerId: true,
                stripeSubscriptionId: true,
            },
        });
        if (!tenant || tenant.deletedAt || !tenant.stripeCustomerId || !tenant.stripeSubscriptionId) {
            throw new BadRequestException('Start a new subscription checkout for this tenant.');
        }

        const subscription = await this.getStripe().subscriptions.retrieve(tenant.stripeSubscriptionId, {
            expand: ['items.data.price'],
        } as any) as StripeWebhookObject;
        this.assertManagedSubscription(tenantId, tenant.stripeCustomerId, subscription, allowedStatuses);
        return { stripeSubscriptionId: tenant.stripeSubscriptionId, subscription };
    }

    private async lockTenantBilling(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-checkout:${tenantId}`}, 0))`;
    }

    private async collectStripePages(
        loadPage: (startingAfter?: string) => Promise<{ data: unknown[]; has_more?: boolean }>,
    ): Promise<StripeWebhookObject[]> {
        const records: StripeWebhookObject[] = [];
        let startingAfter: string | undefined;
        const seenCursors = new Set<string>();
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
            const page = await loadPage(startingAfter);
            if (!Array.isArray(page.data)) {
                throw new ServiceUnavailableException('Stripe list response is not authoritative');
            }
            const pageRecords = page.data.filter(
                (record): record is StripeWebhookObject => Boolean(record && typeof record === 'object'),
            );
            records.push(...pageRecords);
            if (page.has_more !== true) return records;

            const cursor = this.asString(pageRecords.at(-1)?.id);
            if (!cursor || seenCursors.has(cursor)) {
                throw new ServiceUnavailableException('Stripe pagination did not make progress');
            }
            seenCursors.add(cursor);
            startingAfter = cursor;
        }
        throw new ServiceUnavailableException('Stripe pagination exceeded the tenant purge safety bound');
    }

    private assertPurgeCheckoutSessionOwnership(
        tenantId: string,
        customerId: string,
        session: StripeWebhookObject,
    ): void {
        const sessionId = this.asString(session.id);
        const sessionCustomerId = this.resolveCustomerId(session);
        const sessionTenantId = this.resolveTenantIdFromMetadata(session)
            ?? this.asString(session.client_reference_id);
        if (!sessionId || sessionCustomerId !== customerId || sessionTenantId !== tenantId) {
            throw new ServiceUnavailableException('Stripe Checkout ownership is not authoritative for tenant purge');
        }
    }

    private assertPurgeSubscriptionOwnership(
        tenantId: string,
        customerId: string,
        subscription: StripeWebhookObject,
        requireMetadata: boolean,
    ): void {
        const subscriptionId = this.asString(subscription.id);
        const subscriptionCustomerId = this.resolveCustomerId(subscription);
        const metadataTenantId = this.resolveTenantIdFromMetadata(subscription);
        if (
            !subscriptionId
            || subscriptionCustomerId !== customerId
            || (metadataTenantId !== null && metadataTenantId !== tenantId)
            || (requireMetadata && metadataTenantId !== tenantId)
        ) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative for tenant purge');
        }
    }

    private resolveBillingReturnOrigin(): string {
        const configuredOrigin = [
            'APP_ORIGIN',
            'PUBLIC_APP_URL',
            'FRONTEND_URL',
            'NEXT_PUBLIC_APP_ORIGIN',
            'NEXT_PUBLIC_APP_URL',
        ]
            .map((key) => this.configService.get<string>(key)?.trim())
            .find((value): value is string => Boolean(value));
        const domain = this.configService.get<string>('DOMAIN')?.trim();
        const rawOrigin = configuredOrigin ?? (domain ? this.originFromDomain(domain) : null);

        if (!rawOrigin) {
            if (process.env.NODE_ENV === 'production') {
                this.logger.error('Billing return origin is not configured.');
                throw new ServiceUnavailableException('Billing return URL is not configured');
            }
            return 'http://localhost:3000';
        }

        try {
            const parsed = new URL(rawOrigin);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                throw new Error('Unsupported protocol');
            }
            if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
                throw new Error('Production billing return origin must use HTTPS');
            }
            return parsed.origin;
        } catch (err) {
            this.logger.error(`Invalid billing return origin: ${(err as Error).message}`);
            throw new ServiceUnavailableException('Billing return URL is not valid');
        }
    }

    private originFromDomain(domain: string): string {
        if (/^https?:\/\//i.test(domain)) {
            return domain;
        }
        return domain === 'localhost' || domain.startsWith('localhost:')
            ? `http://${domain}`
            : `https://${domain}`;
    }

    private resolveAllowedPriceId(priceId: string): string {
        const normalized = typeof priceId === 'string' ? priceId.trim() : '';
        if (!normalized) {
            throw new BadRequestException('priceId is required');
        }

        const allowedPriceIds = new Set(
            STRIPE_PRICE_CONFIG_KEYS
                .map((option) => this.configService.get<string>(option.key)?.trim())
                .filter((value): value is string => Boolean(value)),
        );

        if (allowedPriceIds.size === 0) {
            if (process.env.NODE_ENV === 'production') {
                this.logger.error('Stripe price catalog is not configured.');
                throw new ServiceUnavailableException('Stripe price catalog is not configured');
            }
            return normalized;
        }

        if (!allowedPriceIds.has(normalized)) {
            throw new BadRequestException('Unsupported Stripe priceId');
        }

        return normalized;
    }

    private resolvePlanCodeForPriceId(priceId: string | null): PlanTier | null {
        if (!priceId) return null;

        for (const option of STRIPE_PRICE_CONFIG_KEYS) {
            const configuredPriceId = this.configService.get<string>(option.key)?.trim();
            if (configuredPriceId && configuredPriceId === priceId) {
                return option.code as PlanTier;
            }
        }

        return null;
    }

    private resolvePlanCodeFromPriceIds(priceIds: string[]): PlanTier | null {
        for (const priceId of priceIds) {
            const planCode = this.resolvePlanCodeForPriceId(priceId);
            if (planCode) return planCode;
        }
        return null;
    }

    private resolveCurrentSubscriptionPlanCode(subscription: StripeWebhookObject): PlanTier | null {
        const planCodes = new Set(
            this.collectPriceIds(subscription)
                .map((priceId) => this.resolvePlanCodeForPriceId(priceId))
                .filter((planCode): planCode is PlanTier => Boolean(planCode)),
        );
        return planCodes.size === 1 ? Array.from(planCodes)[0] : null;
    }

    private resolvePlanCodeFromMetadata(data: StripeWebhookObject): PlanTier | null {
        const rawPlanCode = this.asString(data.metadata?.planCode)
            ?? this.asString(data.subscription_details?.metadata?.planCode)
            ?? this.asString(data.customer_details?.metadata?.planCode)
            ?? this.asString(data.customer?.metadata?.planCode);
        const normalized = rawPlanCode?.toUpperCase();
        return normalized && STRIPE_PRICE_CONFIG_KEYS.some((option) => option.code === normalized)
            ? normalized as PlanTier
            : null;
    }

    private collectPriceIds(data: StripeWebhookObject): string[] {
        const priceIds = new Set<string>();
        const add = (value: unknown) => {
            const priceId = this.asString(value);
            if (priceId) priceIds.add(priceId);
        };
        const addFromItem = (item: StripeWebhookObject) => {
            add(item.price);
            add(item.price?.id);
            add(item.plan);
            add(item.plan?.id);
            add(item.pricing?.price_details?.price);
            add(item.price_details?.price);
        };

        add(data.price);
        add(data.price?.id);
        add(data.plan);
        add(data.plan?.id);
        for (const collection of [data.lines?.data, data.items?.data, data.line_items?.data]) {
            if (!Array.isArray(collection)) continue;
            for (const item of collection) {
                if (item && typeof item === 'object') addFromItem(item);
            }
        }

        return Array.from(priceIds);
    }

    private resolvePurchasedPlanCode(
        data: StripeWebhookObject,
        verifiedSubscription: StripeWebhookObject | null,
    ): PlanTier | null {
        if (verifiedSubscription) {
            return this.resolveCurrentSubscriptionPlanCode(verifiedSubscription);
        }

        return this.resolvePlanCodeFromPriceIds(this.collectPriceIds(data))
            ?? this.resolvePlanCodeFromMetadata(data);
    }

    async handleWebhook(payload: Buffer, signature?: string) {
        if (!signature) {
            throw new BadRequestException('Missing stripe-signature header');
        }

        if (!Buffer.isBuffer(payload)) {
            throw new BadRequestException('Missing raw Stripe webhook body');
        }

        const endpointSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
        if (!endpointSecret) {
            this.logger.error('Stripe webhook secret is not configured.');
            throw new ServiceUnavailableException('Stripe webhook is not configured');
        }

        let event: Stripe.Event;

        try {
            event = this.getStripe().webhooks.constructEvent(payload, signature, endpointSecret);
        } catch (err) {
            this.logger.warn(`Stripe webhook signature verification failed: ${(err as Error).message}`);
            throw new BadRequestException('Invalid Stripe webhook signature');
        }

        const data = event.data.object as StripeWebhookObject;
        const {
            tenantId,
            subscriptionId,
            subscription: resolvedSubscription,
            purgedTenant = false,
        } = await this.resolveTenantContext(event.type, data);

        if (!tenantId) {
            this.logger.warn(`Stripe webhook ${event.id} has no resolvable tenant; type=${event.type}`);
            return;
        }

        const canonicalSubscriptionSync = this.isCanonicalSubscriptionSyncEvent(event.type);
        const authoritativeSubscriptionSync = canonicalSubscriptionSync
            || event.type === 'invoice.finalization_failed';
        let subscriptionResolution = purgedTenant
            ? { subscription: resolvedSubscription, verified: Boolean(resolvedSubscription) }
            : authoritativeSubscriptionSync
                ? { subscription: null, verified: false }
            : await this.resolveWebhookSubscription(
                event.type,
                tenantId,
                subscriptionId,
                data,
                resolvedSubscription,
            );
        let currentSubscription = subscriptionResolution.subscription;
        let purchasedPlanCode = this.resolvePurchasedPlanCode(data, currentSubscription);

        try {
            await this.tenantDb.withTenant(tenantId, async (tx) => {
                await this.lockTenantBilling(tx, tenantId);
                await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
                const tenantState = await tx.tenant.findUnique({
                    where: { id: tenantId },
                    select: { status: true, deletedAt: true },
                });
                if (tenantState?.status === TenantStatus.SUSPENDED) {
                    const suspendedEventOrder = this.resolveEntitlementEventOrder(
                        event,
                        subscriptionId,
                        this.asString(currentSubscription?.status) ?? this.asString(data.status),
                    );
                    await this.recordBillingEvent(
                        tx,
                        event,
                        data,
                        tenantId,
                        subscriptionId,
                        purchasedPlanCode,
                        'skipped_suspended',
                        suspendedEventOrder,
                        currentSubscription,
                    );
                    this.logger.warn('Stripe entitlement event audited behind tenant suspension barrier: ' + event.id);
                    return;
                }
                if (tenantState?.status === TenantStatus.PURGED || tenantState?.deletedAt) {
                    const disposition: StripeSideEffectDisposition = subscriptionId
                        ? 'post_purge_cancelled'
                        : 'skipped_unverified_subscription';
                    if (subscriptionId) {
                        currentSubscription = await this.cancelVerifiedPostPurgeSubscription(
                            tx,
                            tenantId,
                            subscriptionId,
                            data,
                        );
                        purchasedPlanCode = this.resolvePurchasedPlanCode(data, currentSubscription);
                    }
                    const purgeEventOrder = this.resolveEntitlementEventOrder(
                        event,
                        subscriptionId,
                        this.asString(currentSubscription?.status) ?? this.asString(data.status),
                    );
                    await this.recordBillingEvent(
                        tx,
                        event,
                        data,
                        tenantId,
                        subscriptionId,
                        purchasedPlanCode,
                        disposition,
                        purgeEventOrder,
                        currentSubscription,
                    );
                    return;
                }
                const entitlementStatus = this.asString(currentSubscription?.status) ?? this.asString(data.status);
                let eventOrder = this.resolveEntitlementEventOrder(event, subscriptionId, entitlementStatus);
                let sideEffectDisposition: StripeSideEffectDisposition | null = null;
                let locallyOwnedSubscription = subscriptionResolution.verified;

                if (eventOrder && subscriptionId) {
                    await this.lockSubscriptionEventCursor(tx, subscriptionId);
                    const highWaterMark = await this.findSubscriptionEventHighWaterMark(tx, tenantId, subscriptionId);
                    const distinctSameSecondCanonicalEvent = canonicalSubscriptionSync
                        && highWaterMark
                        && eventOrder.created === highWaterMark.created
                        && eventOrder.id !== highWaterMark.id;
                    sideEffectDisposition = highWaterMark
                        && this.compareEventOrder(eventOrder, highWaterMark) <= 0
                        && !distinctSameSecondCanonicalEvent
                            ? 'skipped_stale'
                            : 'applied';

                    if (authoritativeSubscriptionSync && sideEffectDisposition === 'applied') {
                        subscriptionResolution = await this.resolveWebhookSubscription(
                            event.type,
                            tenantId,
                            subscriptionId,
                            data,
                            resolvedSubscription,
                        );
                        currentSubscription = subscriptionResolution.subscription;
                        locallyOwnedSubscription = subscriptionResolution.verified;
                        purchasedPlanCode = this.resolvePurchasedPlanCode(data, currentSubscription);

                        const authoritativeStatus = this.asString(currentSubscription?.status)
                            ?? this.asString(data.status);
                        eventOrder = this.resolveEntitlementEventOrder(
                            event,
                            subscriptionId,
                            authoritativeStatus,
                        );
                        const equalPrioritySameSecondCanonicalEvent = canonicalSubscriptionSync
                            && eventOrder
                            && highWaterMark
                            && eventOrder.created === highWaterMark.created
                            && eventOrder.terminalPriority === highWaterMark.terminalPriority
                            && eventOrder.id !== highWaterMark.id;
                        if (eventOrder
                            && highWaterMark
                            && this.compareEventOrder(eventOrder, highWaterMark) <= 0
                            && !equalPrioritySameSecondCanonicalEvent) {
                            sideEffectDisposition = 'skipped_stale';
                        }
                    }

                    if (currentSubscription && this.isInvoiceSubscriptionEvent(event.type)) {
                        locallyOwnedSubscription = await this.ensureInvoiceSubscriptionBinding(
                            tx,
                            event.type,
                            tenantId,
                            subscriptionId,
                            currentSubscription,
                        );
                    }
                }
                if (this.webhookRequiresVerifiedSubscription(event.type, data)
                    && sideEffectDisposition !== 'skipped_stale'
                    && (!locallyOwnedSubscription
                        || (event.type === 'invoice.paid' && !this.isPaidSubscriptionState(currentSubscription))
                        || (event.type === 'invoice.paid'
                            && !await this.isCurrentPaidSubscription(tx, tenantId, subscriptionId)))) {
                    sideEffectDisposition = 'skipped_unverified_subscription';
                }

                await this.recordBillingEvent(
                    tx,
                    event,
                    data,
                    tenantId,
                    subscriptionId,
                    purchasedPlanCode,
                    sideEffectDisposition,
                    eventOrder,
                    currentSubscription,
                );

                if (sideEffectDisposition?.startsWith('skipped_')) {
                    this.logger.warn(`Stripe entitlement event audited without side effects: ${event.id}; disposition=${sideEffectDisposition}`);
                    return;
                }

                await this.applyWebhookSideEffect(
                    tx,
                    event.type,
                    data,
                    tenantId,
                    subscriptionId,
                    purchasedPlanCode,
                    currentSubscription,
                );
            });
        } catch (err) {
            if (this.isDuplicateStripeEvent(err)) {
                this.logger.log(`Duplicate Stripe webhook event skipped: ${event.id}`);
                return;
            }
            throw err;
        }
    }

    private async recordBillingEvent(
        tx: Prisma.TransactionClient,
        event: Stripe.Event,
        data: StripeWebhookObject,
        tenantId: string,
        subscriptionId: string | null,
        purchasedPlanCode: PlanTier | null,
        sideEffectDisposition: StripeSideEffectDisposition | null,
        eventOrder: StripeEntitlementEventOrder | null,
        currentSubscription: StripeWebhookObject | null,
    ): Promise<void> {
        await tx.billingEvent.create({
            data: {
                tenantId,
                type: event.type,
                stripeEventId: event.id,
                amount: this.resolveAmount(data),
                currency: this.asString(data.currency) ?? 'usd',
                metadata: this.buildBillingEventMetadata(
                    event,
                    data,
                    tenantId,
                    subscriptionId,
                    purchasedPlanCode,
                    sideEffectDisposition,
                    eventOrder,
                    currentSubscription,
                ),
            },
        });
    }

    private async cancelVerifiedPostPurgeSubscription(
        tx: Prisma.TransactionClient,
        tenantId: string,
        subscriptionId: string,
        eventData: StripeWebhookObject,
    ): Promise<StripeWebhookObject> {
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                status: true,
                deletedAt: true,
                stripeCustomerId: true,
            },
        });
        if (
            !tenant
            || tenant.status !== TenantStatus.PURGED
            || !tenant.deletedAt
            || !tenant.stripeCustomerId
        ) {
            throw new ServiceUnavailableException('Purged tenant billing ownership is not authoritative');
        }

        const subscription = await this.retrievePostPurgeSubscription(subscriptionId, eventData);
        this.assertPurgeSubscriptionOwnership(
            tenantId,
            tenant.stripeCustomerId,
            subscription,
            true,
        );
        let terminalSubscription = subscription;
        if (!this.isTerminalSubscriptionState(subscription)) {
            terminalSubscription = await this.getStripe().subscriptions.cancel(subscriptionId) as StripeWebhookObject;
            this.assertPurgeSubscriptionOwnership(
                tenantId,
                tenant.stripeCustomerId,
                terminalSubscription,
                true,
            );
            if (!this.isTerminalSubscriptionState(terminalSubscription)) {
                throw new ServiceUnavailableException('Post-purge Stripe subscription cancellation was not confirmed');
            }
        }
        await tx.tenant.updateMany({
            where: {
                id: tenantId,
                status: TenantStatus.PURGED,
            },
            data: { stripeSubscriptionId: null },
        });
        this.logger.warn(
            `Canceled verified post-purge Stripe subscription for tenant_ref=${this.safeIdentifierRef(tenantId)}`,
        );
        return terminalSubscription;
    }

    private async applyWebhookSideEffect(
        tx: Prisma.TransactionClient,
        eventType: string,
        data: StripeWebhookObject,
        tenantId: string,
        subscriptionId: string | null,
        purchasedPlanCode: PlanTier | null,
        currentSubscription: StripeWebhookObject | null,
    ) {
        switch (eventType) {
            case 'invoice.paid':
                if (!subscriptionId) {
                    this.logger.warn(`Invoice paid event for tenant ${tenantId} has no subscription; side effect skipped`);
                    break;
                }
                await this.markTenantActive(tx, tenantId, subscriptionId, purchasedPlanCode);
                this.logger.log(`Invoice paid for tenant ${tenantId}, marked ACTIVE`);
                break;
            case 'checkout.session.completed':
                if (data.mode === 'subscription' && subscriptionId && currentSubscription) {
                    await this.applySubscriptionStatusUpdate(
                        tx,
                        tenantId,
                        subscriptionId,
                        currentSubscription,
                        purchasedPlanCode,
                    );
                    this.logger.log(`Checkout completed for tenant ${tenantId}, synchronized current subscription`);
                }
                break;
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.paused':
            case 'customer.subscription.resumed':
                await this.applySubscriptionStatusUpdate(
                    tx,
                    tenantId,
                    subscriptionId,
                    currentSubscription ?? data,
                    purchasedPlanCode,
                );
                this.logger.log(`Subscription ${eventType} for tenant ${tenantId}, synchronized`);
                break;
            case 'invoice.payment_failed':
                if (!subscriptionId || !currentSubscription) {
                    this.logger.warn(`Invoice payment failure for tenant ${tenantId} has no verified subscription; side effect skipped`);
                    break;
                }
                await this.applySubscriptionStatusUpdate(
                    tx,
                    tenantId,
                    subscriptionId,
                    currentSubscription,
                    purchasedPlanCode,
                );
                this.logger.log(`Invoice payment failure for tenant ${tenantId}, synchronized current subscription state`);
                break;
            case 'invoice.finalization_failed':
                if (!subscriptionId || !currentSubscription) {
                    this.logger.warn(`Invoice finalization failure for tenant ${tenantId} has no verified subscription; side effect skipped`);
                    break;
                }
                await this.applySubscriptionStatusUpdate(
                    tx,
                    tenantId,
                    subscriptionId,
                    currentSubscription,
                    purchasedPlanCode,
                );
                this.logger.log(`Invoice ${eventType} for tenant ${tenantId}, synchronized current subscription state`);
                break;
            case 'customer.subscription.deleted':
                await tx.tenant.update({
                    where: { id: tenantId },
                    data: {
                        status: TenantStatus.CANCELLED,
                        stripeSubscriptionId: null,
                    }
                });
                this.logger.log(`Subscription ${eventType} for tenant ${tenantId}, marked CANCELLED`);
                break;
            default:
                this.logger.debug(`Unhandled webhook event type: ${eventType}`);
        }
    }

    private async applySubscriptionStatusUpdate(
        tx: Prisma.TransactionClient,
        tenantId: string,
        subscriptionId: string | null,
        data: StripeWebhookObject,
        purchasedPlanCode: PlanTier | null,
    ) {
        const mappedStatus = this.resolveTenantStatusFromSubscription(data);
        const update: Prisma.TenantUpdateInput = {};
        if (mappedStatus) {
            update.status = mappedStatus;
        }
        if (this.isTerminalSubscriptionState(data)) {
            update.stripeSubscriptionId = null;
        } else if (subscriptionId) {
            update.stripeSubscriptionId = subscriptionId;
        }
        if (purchasedPlanCode) {
            update.planTier = purchasedPlanCode;
        }

        if (purchasedPlanCode
            && mappedStatus === TenantStatus.ACTIVE
            && !await this.tenantFitsPlan(tx, tenantId, purchasedPlanCode)) {
            update.status = TenantStatus.PAST_DUE;
            this.logger.warn(`Stripe plan update exceeds tenant capacity; tenant ${tenantId} restricted to free entitlements`);
        }

        if (Object.keys(update).length === 0) {
            return;
        }

        await tx.tenant.update({
            where: { id: tenantId },
            data: update,
        });
    }

    private resolveTenantStatusFromSubscription(data: StripeWebhookObject): TenantStatus | null {
        const status = this.asString(data.status)?.toLowerCase();
        switch (status) {
            case 'active':
            case 'trialing':
                return TenantStatus.ACTIVE;
            case 'past_due':
            case 'unpaid':
            case 'incomplete':
                return TenantStatus.PAST_DUE;
            case 'canceled':
                return TenantStatus.CANCELLED;
            case 'incomplete_expired':
                return TenantStatus.CANCELLED;
            case 'paused':
                return TenantStatus.PAST_DUE;
            default:
                return null;
        }
    }

    private isTerminalSubscriptionState(data: StripeWebhookObject): boolean {
        const status = this.asString(data.status)?.toLowerCase();
        return data.deleted === true || status === 'canceled' || status === 'incomplete_expired';
    }

    private async resolveWebhookSubscription(
        eventType: string,
        tenantId: string,
        subscriptionId: string | null,
        data: StripeWebhookObject,
        resolvedSubscription: StripeWebhookObject | null = null,
    ): Promise<StripeWebhookSubscriptionResolution> {
        if (!this.webhookRequiresVerifiedSubscription(eventType, data)) {
            return { subscription: null, verified: true };
        }
        if (!subscriptionId) {
            return { subscription: null, verified: false };
        }

        try {
            const subscription = resolvedSubscription
                ?? await this.retrieveWebhookSubscription(subscriptionId, data);
            const metadataTenantId = this.resolveTenantIdFromMetadata(subscription);
            if (metadataTenantId && metadataTenantId !== tenantId) {
                return { subscription: null, verified: false };
            }
            return { subscription, verified: true };
        } catch (err) {
            this.logger.warn(`Unable to verify current Stripe subscription; webhook will be retried: ${(err as Error).message}`);
            throw err;
        }
    }

    private async retrieveWebhookSubscription(
        subscriptionId: string,
        data: StripeWebhookObject,
    ): Promise<StripeWebhookObject> {
        const subscription = await this.getStripe().subscriptions.retrieve(subscriptionId, {
            expand: ['items.data.price'],
        } as any) as StripeWebhookObject;
        if (subscription.deleted === true || this.asString(subscription.id) !== subscriptionId) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        const subscriptionCustomerId = this.resolveCustomerId(subscription);
        const eventCustomerId = this.resolveCustomerId(data);
        if (!subscriptionCustomerId || (eventCustomerId && subscriptionCustomerId !== eventCustomerId)) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        return subscription;
    }

    private async retrievePostPurgeSubscription(
        subscriptionId: string,
        data: StripeWebhookObject,
    ): Promise<StripeWebhookObject> {
        const subscription = await this.getStripe().subscriptions.retrieve(subscriptionId, {
            expand: ['items.data.price'],
        } as any) as StripeWebhookObject;
        if (this.asString(subscription.id) !== subscriptionId) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        const subscriptionCustomerId = this.resolveCustomerId(subscription);
        const eventCustomerId = this.resolveCustomerId(data);
        if (!subscriptionCustomerId || (eventCustomerId && subscriptionCustomerId !== eventCustomerId)) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        return subscription;
    }

    private webhookRequiresVerifiedSubscription(eventType: string, data: StripeWebhookObject): boolean {
        return eventType === 'invoice.paid'
            || eventType === 'invoice.payment_failed'
            || eventType === 'invoice.finalization_failed'
            || this.isCanonicalSubscriptionSyncEvent(eventType)
            || (eventType === 'checkout.session.completed' && data.mode === 'subscription');
    }

    private isCanonicalSubscriptionSyncEvent(eventType: string): boolean {
        return eventType === 'customer.subscription.created'
            || eventType === 'customer.subscription.updated'
            || eventType === 'customer.subscription.paused'
            || eventType === 'customer.subscription.resumed';
    }

    private isPaidSubscriptionState(subscription: StripeWebhookObject | null): boolean {
        const status = this.asString(subscription?.status)?.toLowerCase();
        return Boolean(subscription && subscription.deleted !== true && ['active', 'trialing'].includes(status ?? ''));
    }

    private async isCurrentPaidSubscription(
        tx: Prisma.TransactionClient,
        tenantId: string,
        subscriptionId: string | null,
    ): Promise<boolean> {
        if (!subscriptionId) return false;
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { status: true, stripeSubscriptionId: true },
        });
        return Boolean(tenant
            && tenant.stripeSubscriptionId === subscriptionId
            && tenant.status !== TenantStatus.CANCELLED
            && tenant.status !== TenantStatus.PURGED
            && tenant.status !== TenantStatus.SUSPENDED);
    }

    private async markTenantActive(
        tx: Prisma.TransactionClient,
        tenantId: string,
        subscriptionId: string | null,
        purchasedPlanCode: PlanTier | null,
    ) {
        const data: Prisma.TenantUpdateInput = { status: TenantStatus.ACTIVE };
        if (subscriptionId) {
            data.stripeSubscriptionId = subscriptionId;
        }
        if (purchasedPlanCode) {
            data.planTier = purchasedPlanCode;
        }

        if (purchasedPlanCode && !await this.tenantFitsPlan(tx, tenantId, purchasedPlanCode)) {
            data.status = TenantStatus.PAST_DUE;
            this.logger.warn(`Stripe activation exceeds tenant capacity; tenant ${tenantId} restricted to free entitlements`);
        }

        await tx.tenant.update({
            where: { id: tenantId },
            data,
        });
    }

    private async tenantFitsPlan(
        tx: Prisma.TransactionClient,
        tenantId: string,
        planCode: PlanTier,
    ): Promise<boolean> {
        try {
            await this.assertTenantFitsPlan(tx, tenantId, planCode);
            return true;
        } catch (err) {
            if (err instanceof BadRequestException) return false;
            throw err;
        }
    }

    private async assertTenantFitsPlan(
        tx: Prisma.TransactionClient,
        tenantId: string,
        planCode: PlanTier,
    ): Promise<void> {
        await assertTenantActiveUserCountWithinPlan(tx as any, tenantId, planCode);
        await assertTenantActiveLocationCountWithinPlan(tx as any, tenantId, planCode);
    }

    private async resolveTenantContext(eventType: string, data: StripeWebhookObject): Promise<StripeWebhookTenantContext> {
        const subscriptionId = this.resolveSubscriptionId(data);
        const tenantIdFromMetadata = this.resolveTenantIdFromMetadata(data);
        const customerId = this.resolveCustomerId(data);
        const stripeTenant = await this.findTenantByStripeIdentifiers(subscriptionId, customerId);

        if (!stripeTenant && tenantIdFromMetadata && subscriptionId) {
            const purgedTenant = await this.resolveVerifiedPostPurgeTenantContext(
                eventType,
                data,
                tenantIdFromMetadata,
                subscriptionId,
            );
            if (purgedTenant) return purgedTenant;
        }

        if (!stripeTenant
            && subscriptionId
            && this.isInvoiceSubscriptionEvent(eventType)
            && await this.isStripeSubscriptionUnbound(subscriptionId)) {
            return this.resolveInvoiceFirstTenantContext(eventType, data, subscriptionId);
        }

        if (tenantIdFromMetadata) {
            if (!stripeTenant) {
                const initialBindingTenant = await this.findTenantForInitialSubscriptionBinding(
                    eventType,
                    tenantIdFromMetadata,
                    subscriptionId,
                    customerId,
                );
                if (initialBindingTenant) {
                    return { tenantId: initialBindingTenant.id, subscriptionId, subscription: null };
                }
                this.logger.warn(
                    `Stripe webhook tenant metadata has no stored Stripe owner: metadata_ref=${this.safeIdentifierRef(tenantIdFromMetadata)}`,
                );
                return { tenantId: null, subscriptionId, subscription: null };
            }

            if (stripeTenant && stripeTenant.id !== tenantIdFromMetadata) {
                this.logger.warn(
                    `Stripe webhook tenant metadata mismatch: metadata_ref=${this.safeIdentifierRef(tenantIdFromMetadata)} stored_ref=${this.safeIdentifierRef(stripeTenant.id)}`,
                );
                return { tenantId: null, subscriptionId, subscription: null };
            }

            return { tenantId: stripeTenant.id, subscriptionId, subscription: null };
        }

        return { tenantId: stripeTenant?.id ?? null, subscriptionId, subscription: null };
    }

    private async resolveVerifiedPostPurgeTenantContext(
        eventType: string,
        data: StripeWebhookObject,
        tenantId: string,
        subscriptionId: string,
    ): Promise<StripeWebhookTenantContext | null> {
        if (!this.webhookRequiresVerifiedSubscription(eventType, data)) return null;
        const tenant = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                status: true,
                deletedAt: true,
                stripeCustomerId: true,
            },
        }));
        if (
            !tenant
            || tenant.status !== TenantStatus.PURGED
            || !tenant.deletedAt
            || !tenant.stripeCustomerId
        ) {
            return null;
        }

        const subscription = await this.retrievePostPurgeSubscription(subscriptionId, data);
        if (
            this.resolveCustomerId(subscription) !== tenant.stripeCustomerId
            || this.resolveTenantIdFromMetadata(subscription) !== tenantId
        ) {
            this.logger.warn(
                `Stripe post-purge ownership mismatch: metadata_ref=${this.safeIdentifierRef(tenantId)}`,
            );
            return null;
        }
        return {
            tenantId,
            subscriptionId,
            subscription,
            purgedTenant: true,
        };
    }

    private isInvoiceSubscriptionEvent(eventType: string): boolean {
        return eventType === 'invoice.paid'
            || eventType === 'invoice.payment_failed'
            || eventType === 'invoice.finalization_failed';
    }

    private async isStripeSubscriptionUnbound(subscriptionId: string): Promise<boolean> {
        const matches = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findMany({
            where: { stripeSubscriptionId: subscriptionId },
            select: { id: true },
            take: 2,
        }));
        return matches.length === 0;
    }

    private async resolveInvoiceFirstTenantContext(
        eventType: string,
        data: StripeWebhookObject,
        subscriptionId: string,
    ): Promise<StripeWebhookTenantContext> {
        const subscription = await this.retrieveWebhookSubscription(subscriptionId, data);
        const status = this.asString(subscription.status)?.toLowerCase();
        if (!status || !AUTHORITATIVE_STRIPE_SUBSCRIPTION_STATUSES.has(status)) {
            throw new ServiceUnavailableException('Stripe subscription state is not authoritative yet');
        }

        const customerId = this.resolveCustomerId(subscription);
        if (!customerId) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        const eventTenantId = this.resolveTenantIdFromMetadata(data);
        const subscriptionTenantId = this.resolveTenantIdFromMetadata(subscription);
        if (eventTenantId && subscriptionTenantId && eventTenantId !== subscriptionTenantId) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        const metadataTenantId = subscriptionTenantId ?? eventTenantId;

        const [customerMatches, metadataTenant] = await this.tenantDb.withPlatformAdmin((tx) => Promise.all([
            tx.tenant.findMany({
                where: { stripeCustomerId: customerId },
                select: {
                    id: true,
                    deletedAt: true,
                    stripeCustomerId: true,
                    stripeSubscriptionId: true,
                },
                take: 2,
            }),
            metadataTenantId
                ? tx.tenant.findUnique({
                    where: { id: metadataTenantId },
                    select: {
                        id: true,
                        deletedAt: true,
                        stripeCustomerId: true,
                        stripeSubscriptionId: true,
                    },
                })
                : Promise.resolve(null),
        ]));
        const customerTenantRef = this.resolveUniqueStripeTenant('customer', customerId, customerMatches);
        const customerTenant = customerTenantRef
            ? customerMatches.find((candidate) => candidate.id === customerTenantRef.id) ?? null
            : null;
        const tenant = metadataTenantId ? metadataTenant : customerTenant;
        if (!customerTenant
            || !tenant
            || tenant.id !== customerTenant.id
            || tenant.deletedAt
            || tenant.stripeCustomerId !== customerId
            || (tenant.stripeSubscriptionId && tenant.stripeSubscriptionId !== subscriptionId)) {
            this.logger.warn(`Stripe ${eventType} ownership is not yet resolvable; webhook will be retried`);
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }

        return { tenantId: tenant.id, subscriptionId, subscription };
    }

    private async ensureInvoiceSubscriptionBinding(
        tx: Prisma.TransactionClient,
        eventType: string,
        tenantId: string,
        subscriptionId: string,
        subscription: StripeWebhookObject,
    ): Promise<boolean> {
        const customerId = this.resolveCustomerId(subscription);
        const metadataTenantId = this.resolveTenantIdFromMetadata(subscription);
        const status = this.asString(subscription.status)?.toLowerCase();
        if (!customerId
            || (metadataTenantId && metadataTenantId !== tenantId)
            || !status
            || !AUTHORITATIVE_STRIPE_SUBSCRIPTION_STATUSES.has(status)) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }

        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                status: true,
                deletedAt: true,
                stripeCustomerId: true,
                stripeSubscriptionId: true,
            },
        });
        if (!tenant
            || tenant.deletedAt
            || tenant.stripeCustomerId !== customerId
            || (tenant.stripeSubscriptionId && tenant.stripeSubscriptionId !== subscriptionId)) {
            throw new ServiceUnavailableException('Stripe subscription ownership is not authoritative yet');
        }
        if (tenant.stripeSubscriptionId === subscriptionId) return true;
        if (INVOICE_BINDING_BLOCKED_TENANT_STATUSES.has(tenant.status)) {
            return false;
        }
        if (this.isTerminalSubscriptionState(subscription)) {
            return true;
        }

        try {
            const claimed = await tx.tenant.updateMany({
                where: {
                    id: tenantId,
                    deletedAt: null,
                    stripeCustomerId: customerId,
                    stripeSubscriptionId: null,
                },
                data: { stripeSubscriptionId: subscriptionId },
            });
            if (claimed.count === 1) return true;
        } catch (err) {
            if (this.isDuplicateStripeEvent(err)) {
                throw new ServiceUnavailableException('Stripe subscription ownership could not be claimed');
            }
            throw err;
        }

        const current = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { stripeCustomerId: true, stripeSubscriptionId: true },
        });
        if (current?.stripeCustomerId === customerId && current.stripeSubscriptionId === subscriptionId) {
            return true;
        }
        this.logger.warn(`Stripe ${eventType} subscription binding lost a concurrent claim; webhook will be retried`);
        throw new ServiceUnavailableException('Stripe subscription ownership could not be claimed');
    }

    private async findTenantByStripeIdentifiers(subscriptionId: string | null, customerId: string | null): Promise<{ id: string } | null> {
        if (!subscriptionId && !customerId) {
            return null;
        }

        const [subscriptionMatches, customerMatches] = await this.tenantDb.withPlatformAdmin((tx) => Promise.all([
            subscriptionId
                ? tx.tenant.findMany({
                    where: {
                        stripeSubscriptionId: subscriptionId,
                        deletedAt: null,
                        status: { not: TenantStatus.PURGED },
                    },
                    select: { id: true },
                    take: 2,
                })
                : Promise.resolve([]),
            customerId
                ? tx.tenant.findMany({
                    where: {
                        stripeCustomerId: customerId,
                        deletedAt: null,
                        status: { not: TenantStatus.PURGED },
                    },
                    select: { id: true },
                    take: 2,
                })
                : Promise.resolve([]),
        ]));

        const subscriptionTenant = this.resolveUniqueStripeTenant('subscription', subscriptionId, subscriptionMatches);
        const customerTenant = this.resolveUniqueStripeTenant('customer', customerId, customerMatches);

        if (subscriptionTenant && customerTenant && subscriptionTenant.id !== customerTenant.id) {
            this.logger.warn(
                `Stripe webhook identifier mismatch: subscription_tenant_ref=${this.safeIdentifierRef(subscriptionTenant.id)} customer_tenant_ref=${this.safeIdentifierRef(customerTenant.id)}`,
            );
            return null;
        }

        if (subscriptionId) {
            return subscriptionTenant;
        }
        return customerTenant;
    }

    private async findTenantForInitialSubscriptionBinding(
        eventType: string,
        tenantId: string,
        subscriptionId: string | null,
        customerId: string | null,
    ): Promise<{ id: string } | null> {
        if (!subscriptionId
            || !customerId
            || !['checkout.session.completed', 'customer.subscription.created'].includes(eventType)) {
            return null;
        }

        const tenant = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                status: true,
                deletedAt: true,
                stripeCustomerId: true,
                stripeSubscriptionId: true,
            },
        }));
        if (!tenant
            || tenant.deletedAt
            || tenant.status === TenantStatus.PURGED
            || tenant.stripeCustomerId !== customerId) return null;
        if (tenant.stripeSubscriptionId && tenant.stripeSubscriptionId !== subscriptionId) return null;
        return { id: tenant.id };
    }

    private async findTenantSubscriptionId(tenantId: string): Promise<string | null> {
        const tenant = await this.tenantDb.withTenant(tenantId, (tx) => tx.tenant.findUnique({
            where: { id: tenantId },
            select: { id: true, stripeSubscriptionId: true },
        }));
        if (!tenant) throw new Error('Tenant not found');
        return this.asString(tenant.stripeSubscriptionId);
    }

    private buildSubscriptionCancellationResult(
        action: StripeCancellationAction,
        stripeSubscriptionId: string | null,
        subscription: StripeWebhookObject | null,
    ): TenantSubscriptionCancellationResult {
        return {
            action,
            stripeSubscriptionId,
            stripeStatus: this.asString(subscription?.status),
            cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
            currentPeriodEnd: this.epochSecondsToIso(subscription?.current_period_end),
            cancelAt: this.epochSecondsToIso(subscription?.cancel_at),
            canceledAt: this.epochSecondsToIso(subscription?.canceled_at),
            cancellationBehavior: 'cancel_at_period_end',
        };
    }

    private buildBillingEventMetadata(
        event: Stripe.Event,
        data: StripeWebhookObject,
        tenantId: string,
        subscriptionId: string | null,
        purchasedPlanCode: PlanTier | null,
        sideEffectDisposition: StripeSideEffectDisposition | null,
        eventOrder: StripeEntitlementEventOrder | null,
        currentSubscription: StripeWebhookObject | null,
    ): Record<string, StripeBillingMetadataValue> {
        return this.compactBillingMetadata({
            stripeEventLivemode: typeof event.livemode === 'boolean' ? event.livemode : null,
            stripeEventCreated: this.asNumber(event.created),
            sideEffectDisposition,
            entitlementTerminalPriority: eventOrder?.terminalPriority,
            stripeObjectType: this.asString(data.object),
            stripeObjectId: this.asString(data.id),
            tenantId,
            subscriptionId: subscriptionId ?? this.resolveSubscriptionId(data),
            customerId: this.resolveCustomerId(data),
            invoiceId: data.object === 'invoice' ? this.asString(data.id) : this.resolveObjectId(data.invoice),
            checkoutSessionId: data.object === 'checkout.session' ? this.asString(data.id) : null,
            paymentIntentId: this.resolveObjectId(data.payment_intent),
            chargeId: this.resolveObjectId(data.charge) ?? this.resolveObjectId(data.latest_charge),
            status: this.asString(data.status),
            stripeSubscriptionStatus: this.asString(currentSubscription?.status)
                ?? (data.object === 'subscription' ? this.asString(data.status) : null),
            paymentStatus: this.asString(data.payment_status),
            mode: this.asString(data.mode),
            billingReason: this.asString(data.billing_reason),
            collectionMethod: this.asString(data.collection_method),
            cancelAtPeriodEnd: typeof data.cancel_at_period_end === 'boolean' ? data.cancel_at_period_end : null,
            currentPeriodEnd: this.epochSecondsToIso(data.current_period_end),
            cancelAt: this.epochSecondsToIso(data.cancel_at),
            canceledAt: this.epochSecondsToIso(data.canceled_at),
            amountSubtotal: this.asNumber(data.amount_subtotal),
            amountTotal: this.asNumber(data.amount_total),
            amountPaid: this.asNumber(data.amount_paid),
            amountDue: this.asNumber(data.amount_due),
            currency: this.asString(data.currency),
            planCode: purchasedPlanCode ?? this.resolvePlanCodeFromMetadata(data),
            priceIds: this.collectPriceIds(data),
        });
    }

    private resolveEntitlementEventOrder(
        event: Stripe.Event,
        subscriptionId: string | null,
        entitlementStatus: string | null,
    ): StripeEntitlementEventOrder | null {
        if (!subscriptionId || !STRIPE_ENTITLEMENT_EVENT_TYPES.has(event.type)) {
            return null;
        }

        return {
            created: this.asNumber(event.created) ?? 0,
            terminalPriority: this.resolveEntitlementTerminalPriority(event.type, entitlementStatus),
            id: event.id,
        };
    }

    private async lockSubscriptionEventCursor(tx: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscriptionId}, 0))`;
    }

    private async findSubscriptionEventHighWaterMark(
        tx: Prisma.TransactionClient,
        tenantId: string,
        subscriptionId: string,
    ): Promise<StripeEntitlementEventOrder | null> {
        const events = await tx.billingEvent.findMany({
            where: {
                tenantId,
                type: { in: Array.from(STRIPE_ENTITLEMENT_EVENT_TYPES) },
                stripeEventId: { not: null },
                metadata: {
                    path: ['subscriptionId'],
                    equals: subscriptionId,
                },
            },
            select: {
                type: true,
                stripeEventId: true,
                metadata: true,
            },
        });

        return events.reduce<StripeEntitlementEventOrder | null>((highWaterMark, storedEvent) => {
            if (!storedEvent.stripeEventId) return highWaterMark;
            const metadata = storedEvent.metadata;
            const disposition = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                ? this.asString((metadata as Record<string, unknown>).sideEffectDisposition)
                : null;
            if (disposition?.startsWith('skipped_')) return highWaterMark;
            const created = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                ? this.asNumber((metadata as Record<string, unknown>).stripeEventCreated) ?? 0
                : 0;
            const status = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                ? this.asString((metadata as Record<string, unknown>).stripeSubscriptionStatus)
                    ?? this.asString((metadata as Record<string, unknown>).status)
                : null;
            const storedTerminalPriority = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                ? this.asNumber((metadata as Record<string, unknown>).entitlementTerminalPriority)
                : null;
            const order = {
                created,
                terminalPriority: storedTerminalPriority
                    ?? this.resolveEntitlementTerminalPriority(storedEvent.type, status),
                id: storedEvent.stripeEventId,
            };
            return !highWaterMark || this.compareEventOrder(order, highWaterMark) > 0 ? order : highWaterMark;
        }, null);
    }

    private compareEventOrder(left: StripeEntitlementEventOrder, right: StripeEntitlementEventOrder): number {
        if (left.created !== right.created) {
            return left.created < right.created ? -1 : 1;
        }
        if (left.terminalPriority !== right.terminalPriority) {
            return left.terminalPriority < right.terminalPriority ? -1 : 1;
        }
        if (left.id === right.id) return 0;
        return left.id < right.id ? -1 : 1;
    }

    private resolveEntitlementTerminalPriority(eventType: string, status: string | null): number {
        const normalizedStatus = status?.toLowerCase() ?? '';
        if (eventType === 'customer.subscription.deleted'
            || eventType === 'customer.subscription.paused'
            || ['canceled', 'incomplete_expired', 'paused'].includes(normalizedStatus)) {
            return 1;
        }
        if (eventType === 'invoice.finalization_failed') {
            return -2;
        }
        if (eventType === 'invoice.payment_failed') {
            return ['past_due', 'unpaid', 'incomplete'].includes(normalizedStatus) ? -1 : 0;
        }
        return 0;
    }

    private compactBillingMetadata(input: Record<string, unknown>): Record<string, StripeBillingMetadataValue> {
        const output: Record<string, StripeBillingMetadataValue> = {};

        for (const [key, value] of Object.entries(input)) {
            if (typeof value === 'string' && value.trim()) {
                output[key] = value;
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

    private resolveUniqueStripeTenant(
        identifierType: 'subscription' | 'customer',
        identifier: string | null,
        matches: Array<{ id: string }>,
    ): { id: string } | null {
        if (matches.length === 0) {
            return null;
        }

        if (matches.length > 1) {
            this.logger.warn(
                `Stripe webhook ${identifierType} identifier is linked to multiple tenants: ${this.safeIdentifierRef(identifier)}`,
            );
            return null;
        }

        return matches[0];
    }

    private safeIdentifierRef(identifier: string | null): string {
        return identifier ? createHash('sha256').update(identifier).digest('hex').slice(0, 12) : 'missing';
    }

    private resolveTenantIdFromMetadata(data: StripeWebhookObject): string | null {
        return this.asString(data.metadata?.tenantId)
            ?? this.asString(data.subscription_details?.metadata?.tenantId)
            ?? this.asString(data.customer_details?.metadata?.tenantId)
            ?? this.asString(data.customer?.metadata?.tenantId);
    }

    private resolveSubscriptionId(data: StripeWebhookObject): string | null {
        if (data.object === 'subscription') {
            return this.asString(data.id);
        }

        return this.asString(data.subscription)
            ?? this.asString(data.subscription?.id)
            ?? this.asString(data.parent?.subscription_details?.subscription)
            ?? this.asString(data.parent?.subscription_details?.subscription?.id)
            ?? this.asString(data.subscription_details?.subscription)
            ?? this.asString(data.subscription_details?.subscription?.id)
            ?? null;
    }

    private resolveCustomerId(data: StripeWebhookObject): string | null {
        return this.asString(data.customer)
            ?? this.asString(data.customer?.id)
            ?? null;
    }

    private resolveObjectId(value: unknown): string | null {
        if (typeof value === 'string') {
            return this.asString(value);
        }
        if (value && typeof value === 'object') {
            return this.asString((value as StripeWebhookObject).id);
        }
        return null;
    }

    private resolveAmount(data: StripeWebhookObject): number | null {
        return this.asNumber(data.amount_paid)
            ?? this.asNumber(data.amount_total)
            ?? this.asNumber(data.amount_due)
            ?? null;
    }

    private asString(value: unknown): string | null {
        return typeof value === 'string' && value.trim() ? value : null;
    }

    private asNumber(value: unknown): number | null {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    private epochSecondsToIso(value: unknown): string | null {
        const seconds = this.asNumber(value);
        if (seconds === null) return null;
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    private getStripe(): Stripe {
        if (!this.stripe) {
            throw new ServiceUnavailableException('Stripe billing is not configured');
        }
        return this.stripe;
    }

    private isDuplicateStripeEvent(err: unknown): boolean {
        if (err instanceof Prisma.PrismaClientKnownRequestError) {
            return err.code === 'P2002';
        }

        return typeof err === 'object'
            && err !== null
            && 'code' in err
            && (err as { code?: unknown }).code === 'P2002';
    }
}
