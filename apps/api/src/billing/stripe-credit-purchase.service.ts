import {
    BadRequestException,
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient, TenantStatus } from '@lunchlineup/db';
import { createHash } from 'crypto';
import Stripe from 'stripe';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    buildCreditPackMetadata,
    configuredCreditPackPriceIds,
    CREDIT_PACK_PURCHASE_TYPE,
    CREDIT_PACKS,
    creditPackMetadataMatches,
    CreditPackConfig,
    CreditPackMetadata,
    findCreditPack,
} from './credit-packs.config';
import { MeteringService } from './metering.service';
import { resolveEffectiveTenantEntitlement } from './plan-definitions';
import { stripeErrorLog } from './stripe-error-diagnostic';

type StripeObject = Record<string, any>;
type AuthoritativePrice = { priceId: string; amount: number; currency: string };
type CheckoutResolution = {
    reusable: CreditPackCheckoutSessionResponse | null;
    generation: string;
};
type CreditPurchaseDisposition =
    | 'applied'
    | 'skipped_deleted'
    | 'skipped_inactive_subscription'
    | 'skipped_mismatch'
    | 'skipped_not_complete'
    | 'skipped_suspended'
    | 'skipped_tenant_mismatch'
    | 'skipped_unpaid';
type TenantState = {
    id: string;
    planTier: string;
    status: TenantStatus;
    deletedAt: Date | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionCurrentPeriodEnd: Date | null;
};
type LineItems = { data: StripeObject[]; has_more?: boolean };
type PurchaseContext = {
    sessionId: string;
    tenantId: string;
    session: StripeObject;
    lineItems: LineItems;
};
type PurchaseVerification = {
    pack: CreditPackConfig | null;
    price: AuthoritativePrice | null;
    disposition: CreditPurchaseDisposition;
};
type PurchaseRefund = {
    id: string;
    status: string;
    amount: number;
    currency: string;
    paymentIntentId: string;
};
export type CreditPackSettlementResult = {
    transactionId: string;
    newBalance: number;
    replayed: boolean;
};
type PurchasePreparation = {
    state: 'complete' | 'recoverable' | 'refund_required';
    settlement: CreditPackSettlementResult | null;
};
type BillingEventRecord = {
    id: string;
    type: string;
    metadata: unknown;
    createdAt?: Date;
};

export type CreditPackCheckoutSessionResponse = {
    sessionId: string;
    checkoutUrl: string;
};

const PURCHASE_TRANSACTION_PREFIX = 'stripe-credit-purchase-';
const PURCHASE_EVENT_PREFIX = 'stripe-credit-purchase-event-';
const PURCHASE_RECOVERABLE_EVENT_PREFIX = 'stripe-credit-purchase-recoverable-';
const REFUND_EVENT_PREFIX = 'stripe-credit-refund-state-';
const REFUND_TERMINAL_PREFIX = 'stripe-credit-refund-terminal-';
const MAX_REFUND_ATTEMPTS = 5;
const SUBSCRIPTION_PRICE_KEYS = [
    'STRIPE_PRICE_STARTER',
    'STRIPE_PRICE_GROWTH',
    'STRIPE_PRICE_ENTERPRISE',
] as const;

@Injectable()
export class StripeCreditPurchaseService {
    private readonly logger = new Logger(StripeCreditPurchaseService.name);
    private readonly tenantDb: TenantPrismaService;
    private readonly metering: MeteringService;
    private stripe: Stripe | null;

    constructor(
        private readonly configService: ConfigService,
        @Optional() tenantDb?: TenantPrismaService,
        @Optional() metering?: MeteringService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService(new PrismaClient());
        this.metering = metering ?? new MeteringService(this.tenantDb);
        const apiKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
        this.stripe = apiKey
            ? new Stripe(apiKey, { apiVersion: '2024-04-10' as any })
            : null;
    }

    async getOptions() {
        this.assertUniquePackPrices();
        return Promise.all(CREDIT_PACKS.map(async (pack) => {
            const priceId = this.configService.get<string>(pack.envKey)?.trim();
            if (!priceId) {
                return {
                    code: pack.code,
                    credits: pack.credits,
                    configured: false,
                    amount: null,
                    currency: null,
                };
            }
            const price = await this.retrieveAuthoritativePrice(pack, priceId);
            return {
                code: pack.code,
                credits: pack.credits,
                configured: true,
                amount: price.amount,
                currency: price.currency,
            };
        }));
    }

    async createCheckoutSession(
        tenantId: string,
        code: string,
        returnOrigin: string,
    ): Promise<CreditPackCheckoutSessionResponse> {
        const pack = findCreditPack(code);
        if (!pack) throw new BadRequestException('Unsupported credit pack');
        const priceId = this.requireConfiguredPriceId(pack);
        const price = await this.retrieveAuthoritativePrice(pack, priceId);
        const metadata = buildCreditPackMetadata(
            tenantId,
            pack,
            price.priceId,
            price.amount,
            price.currency,
        );

        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantBilling(tx, tenantId);
            const customerId = await this.assertTenantCanPurchase(tx, tenantId);
            const openSessions = await this.resolveOpenCheckoutSessions(customerId, metadata);
            if (openSessions.reusable) return openSessions.reusable;

            const session = await this.getStripe().checkout.sessions.create({
                mode: 'payment',
                customer: customerId,
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${returnOrigin}/dashboard/settings?billing=credit-purchase-success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${returnOrigin}/dashboard/settings?billing=credit-purchase-cancelled`,
                client_reference_id: tenantId,
                metadata,
                payment_intent_data: { metadata },
            }, {
                idempotencyKey: this.checkoutIdempotencyKey(
                    tenantId,
                    pack.code,
                    priceId,
                    openSessions.generation,
                ),
            });
            const sessionId = this.asString(session.id);
            const checkoutUrl = this.asString(session.url);
            if (!sessionId || !checkoutUrl) {
                throw new ServiceUnavailableException('Stripe Checkout did not return a session URL');
            }
            return { sessionId, checkoutUrl };
        });
    }
    async handleCheckoutSessionCompleted(
        event: Stripe.Event,
    ): Promise<CreditPackSettlementResult | undefined> {
        const context = await this.retrievePurchaseContext(event);
        if (!context) return undefined;

        const preparation = await this.tenantDb.withTenant(context.tenantId, (tx) =>
            this.preparePurchaseTransaction(tx, event, context));
        if (preparation.state !== 'refund_required') {
            return preparation.settlement ?? undefined;
        }

        const recoverable = await this.tenantDb.withTenant(context.tenantId, (tx) =>
            this.reconcileRefundTransaction(tx, context));
        if (recoverable) {
            throw new ServiceUnavailableException('Stripe credit purchase refund is not terminal');
        }
        return undefined;
    }

    async handleRefundLifecycleEvent(event: Stripe.Event): Promise<void> {
        const refundObject = event.data.object as StripeObject;
        const sessionId = this.asString(refundObject.metadata?.checkoutSessionId);
        const tenantId = this.asString(refundObject.metadata?.tenantId);
        const refundId = this.asString(refundObject.id);
        if (
            refundObject.metadata?.purchaseType !== CREDIT_PACK_PURCHASE_TYPE
            || !sessionId
            || !tenantId
            || !refundId
        ) {
            return;
        }
        const context = await this.retrievePurchaseContextBySessionId(sessionId, event.id);
        if (!context || context.tenantId !== tenantId) {
            throw new ServiceUnavailableException('Stripe credit purchase refund identity is not authoritative');
        }
        const recoverable = await this.tenantDb.withTenant(tenantId, (tx) =>
            this.reconcileRefundTransaction(tx, context, refundId));
        if (recoverable) {
            throw new ServiceUnavailableException('Stripe credit purchase refund is not terminal');
        }
    }

    private async retrievePurchaseContext(event: Stripe.Event): Promise<PurchaseContext | null> {
        const webhookObject = event.data.object as StripeObject;
        const sessionId = this.asString(webhookObject.id);
        if (!sessionId) {
            this.logger.warn(`Stripe credit purchase event ${event.id} has no Checkout Session ID.`);
            return null;
        }
        return this.retrievePurchaseContextBySessionId(sessionId, event.id);
    }

    private async retrievePurchaseContextBySessionId(
        sessionId: string,
        sourceEventId: string,
    ): Promise<PurchaseContext | null> {
        const session = await this.getStripe().checkout.sessions.retrieve(sessionId, {
            expand: ['line_items.data.price'],
        }) as StripeObject;
        if (this.asString(session.id) !== sessionId) {
            throw new ServiceUnavailableException('Stripe Checkout Session could not be verified');
        }
        const tenantId = this.asString(session.metadata?.tenantId);
        if (!tenantId) {
            this.logger.warn(`Stripe credit purchase event ${sourceEventId} has no authoritative tenant metadata.`);
            return null;
        }
        const lineItems = await this.getStripe().checkout.sessions.listLineItems(sessionId, {
            limit: 2,
            expand: ['data.price'],
        }) as unknown as LineItems;
        if (!Array.isArray(lineItems.data)) {
            throw new ServiceUnavailableException('Stripe Checkout line items could not be verified');
        }
        return { sessionId, tenantId, session, lineItems };
    }

    private async preparePurchaseTransaction(
        tx: Prisma.TransactionClient,
        event: Stripe.Event,
        context: PurchaseContext,
    ): Promise<PurchasePreparation> {
        await this.lockTenantBilling(tx, context.tenantId);
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${context.tenantId} FOR UPDATE`;

        const hasRefundTerminal = await this.hasRefundTerminal(tx, context.sessionId);
        const existingTransaction = await tx.creditTransaction.findUnique({
            where: { id: this.purchaseTransactionId(context.sessionId) },
            select: {
                id: true,
                tenantId: true,
                amount: true,
                debtAmount: true,
                reason: true,
                balanceAfter: true,
                debtAfter: true,
            },
        });
        const recorded = await tx.billingEvent.findUnique({
            where: { id: this.purchaseEventId(context.sessionId) },
            select: { id: true, metadata: true },
        }) as BillingEventRecord | null;
        if (hasRefundTerminal && existingTransaction) {
            throw new ServiceUnavailableException(
                'Stripe credit purchase has conflicting terminal outcomes',
            );
        }
        if (hasRefundTerminal) {
            return { state: 'complete', settlement: null };
        }
        if (existingTransaction) {
            return {
                state: 'complete',
                settlement: this.resolveExistingPurchaseSettlement(
                    context,
                    existingTransaction,
                    recorded,
                ),
            };
        }

        if (this.metadataString(recorded?.metadata, 'outcomeState') === 'refund_required') {
            return { state: 'refund_required', settlement: null };
        }
        if (this.metadataString(recorded?.metadata, 'outcomeState') === 'complete') {
            throw new ServiceUnavailableException(
                'Stripe credit purchase completion is missing its immutable settlement',
            );
        }
        if (!recorded) {
            const legacy = await this.findLegacyPurchaseEvent(tx, context);
            const legacyRefundId = this.metadataString(legacy?.metadata, 'refundId');
            if (legacy && legacyRefundId) {
                await this.recordLegacyRefundRecoveryState(tx, context, legacy, legacyRefundId);
                return { state: 'refund_required', settlement: null };
            }
        }

        const tenant = await tx.tenant.findUnique({
            where: { id: context.tenantId },
            select: {
                id: true,
                planTier: true,
                status: true,
                deletedAt: true,
                stripeCustomerId: true,
                stripeSubscriptionId: true,
                stripeSubscriptionCurrentPeriodEnd: true,
            },
        }) as TenantState | null;
        if (!tenant) {
            this.logger.warn(`Stripe credit purchase event ${event.id} references an unknown tenant.`);
            return { state: 'complete', settlement: null };
        }

        const verification = await this.verifyPurchase(context, tenant);
        if (verification.disposition === 'skipped_unpaid') {
            const recoverableEventId = this.purchaseRecoverableEventId(event.id);
            if (!await tx.billingEvent.findUnique({
                where: { id: recoverableEventId },
                select: { id: true },
            })) {
                await this.recordPurchaseEvent(
                    tx,
                    event,
                    context.session,
                    verification,
                    'recoverable',
                    recoverableEventId,
                    null,
                );
            }
            return { state: 'recoverable', settlement: null };
        }
        const refundRequired = this.requiresRefund(context, verification.disposition);
        await this.recordPurchaseEvent(
            tx,
            event,
            context.session,
            verification,
            refundRequired ? 'refund_required' : 'complete',
        );
        if (refundRequired) return { state: 'refund_required', settlement: null };
        if (
            verification.disposition !== 'applied'
            || !verification.pack
            || !verification.price
        ) {
            this.logger.warn(
                `Stripe credit purchase audited without grant: event=${event.id}; disposition=${verification.disposition}`,
            );
            return { state: 'complete', settlement: null };
        }

        const settlement = await this.grantPurchase(tx, context, tenant, verification.pack);
        this.logger.log(
            `Stripe credit purchase granted for event ${event.id}; credits=${verification.pack.credits}`,
        );
        return { state: 'complete', settlement };
    }

    private async verifyPurchase(
        context: PurchaseContext,
        tenant: TenantState,
    ): Promise<PurchaseVerification> {
        const pack = findCreditPack(context.session.metadata?.creditPackCode);
        const sessionDisposition = this.resolveSessionDisposition(context.session);
        if (sessionDisposition) return { pack, price: null, disposition: sessionDisposition };
        if (!pack) return { pack: null, price: null, disposition: 'skipped_mismatch' };

        const price = this.resolveMetadataPrice(context, pack);
        if (!price) {
            return { pack, price: null, disposition: 'skipped_mismatch' };
        }
        if (!this.isExactLineItem(context, price)) {
            return { pack, price, disposition: 'skipped_mismatch' };
        }
        if (
            !this.resolveCustomerId(context.session)
            || (
                tenant.stripeCustomerId
                && this.resolveCustomerId(context.session) !== tenant.stripeCustomerId
            )
            || (
                !tenant.stripeCustomerId
                && !tenant.deletedAt
                && tenant.status !== TenantStatus.PURGED
                && tenant.status !== TenantStatus.SUSPENDED
            )
            || this.asString(context.session.client_reference_id) !== context.tenantId
        ) {
            return { pack, price, disposition: 'skipped_tenant_mismatch' };
        }

        const tenantDisposition = this.resolveTenantDisposition(tenant);
        if (tenantDisposition) return { pack, price, disposition: tenantDisposition };

        const subscription = await this.getStripe().subscriptions.retrieve(
            tenant.stripeSubscriptionId!,
            { expand: ['items.data.price'] } as any,
        ) as StripeObject;
        const subscriptionDisposition = this.resolveSubscriptionDisposition(tenant, subscription);
        return {
            pack,
            price,
            disposition: subscriptionDisposition ?? 'applied',
        };
    }


    private async grantPurchase(
        tx: Prisma.TransactionClient,
        context: PurchaseContext,
        _tenant: TenantState,
        pack: CreditPackConfig,
    ): Promise<CreditPackSettlementResult> {
        const settlement = await this.metering.recordPositiveCreditSettlementInTransaction(tx, {
            tenantId: context.tenantId,
            amount: pack.credits,
            reason: `Stripe credit pack purchase ${pack.code}`,
            transactionId: this.purchaseTransactionId(context.sessionId),
        });
        return {
            transactionId: settlement.transactionId,
            newBalance: settlement.newBalance,
            replayed: settlement.replayed,
        };
    }

    private resolveExistingPurchaseSettlement(
        context: PurchaseContext,
        existing: {
            id: string;
            tenantId: string;
            amount: number;
            debtAmount: number;
            reason: string;
            balanceAfter: number | null;
            debtAfter: number | null;
        },
        recorded: BillingEventRecord | null,
    ): CreditPackSettlementResult {
        const pack = findCreditPack(context.session.metadata?.creditPackCode);
        const expectedReason = pack
            ? `Stripe credit pack purchase ${pack.code}`
            : null;
        if (
            !pack
            || context.session.metadata?.purchaseType !== CREDIT_PACK_PURCHASE_TYPE
            || this.asString(context.session.metadata?.tenantId) !== context.tenantId
            || this.asString(context.session.metadata?.creditAmount) !== String(pack.credits)
            || existing.id !== this.purchaseTransactionId(context.sessionId)
            || existing.tenantId !== context.tenantId
            || !Number.isSafeInteger(existing.amount)
            || existing.amount < 0
            || !Number.isSafeInteger(existing.debtAmount)
            || existing.debtAmount > 0
            || existing.amount - existing.debtAmount !== pack.credits
            || existing.reason !== expectedReason
            || !Number.isSafeInteger(existing.balanceAfter)
            || existing.balanceAfter! < 0
            || !Number.isSafeInteger(existing.debtAfter)
            || existing.debtAfter! < 0
            || this.metadataString(recorded?.metadata, 'source') !== 'stripe_credit_purchase'
            || this.metadataString(recorded?.metadata, 'outcomeState') !== 'complete'
            || this.metadataString(recorded?.metadata, 'disposition') !== 'applied'
            || this.metadataString(recorded?.metadata, 'checkoutSessionId') !== context.sessionId
            || this.metadataString(recorded?.metadata, 'creditPackCode') !== pack.code
            || this.metadataNumber(recorded?.metadata, 'creditAmount') !== pack.credits
        ) {
            throw new ServiceUnavailableException(
                'Existing Stripe credit purchase settlement is malformed or mismatched',
            );
        }
        return {
            transactionId: existing.id,
            newBalance: existing.balanceAfter!,
            replayed: true,
        };
    }

    private async recordPurchaseEvent(
        tx: Prisma.TransactionClient,
        event: Stripe.Event,
        session: StripeObject,
        verification: PurchaseVerification,
        outcomeState: 'complete' | 'recoverable' | 'refund_required',
        recordId = this.purchaseEventId(this.asString(session.id)!),
        stripeEventId: string | null = event.id,
    ): Promise<void> {
        await tx.billingEvent.create({
            data: {
                id: recordId,
                tenantId: this.asString(session.metadata?.tenantId)!,
                type: event.type,
                stripeEventId,
                amount: this.asNumber(session.amount_total),
                currency: this.asString(session.currency)?.toLowerCase() ?? 'usd',
                metadata: {
                    source: 'stripe_credit_purchase',
                    outcomeState,
                    disposition: verification.disposition,
                    checkoutSessionId: this.asString(session.id),
                    customerRef: this.safeIdentifierRef(this.resolveCustomerId(session)),
                    creditPackCode: verification.pack?.code
                        ?? this.asString(session.metadata?.creditPackCode),
                    creditAmount: verification.pack?.credits
                        ?? this.asString(session.metadata?.creditAmount),
                    priceId: this.asString(session.metadata?.priceId),
                    paymentStatus: this.asString(session.payment_status),
                    sessionStatus: this.asString(session.status),
                },
            },
        });
    }

    private resolveSessionDisposition(session: StripeObject): CreditPurchaseDisposition | null {
        if (this.asString(session.mode)?.toLowerCase() !== 'payment') return 'skipped_mismatch';
        if (this.asString(session.status)?.toLowerCase() !== 'complete') return 'skipped_not_complete';
        if (this.asString(session.payment_status)?.toLowerCase() !== 'paid') return 'skipped_unpaid';
        return null;
    }

    private resolveTenantDisposition(tenant: TenantState): CreditPurchaseDisposition | null {
        if (tenant.deletedAt || tenant.status === TenantStatus.PURGED) return 'skipped_deleted';
        if (tenant.status === TenantStatus.SUSPENDED) return 'skipped_suspended';
        if (resolveEffectiveTenantEntitlement({
            planTier: tenant.planTier,
            status: tenant.status,
            stripeSubscriptionId: tenant.stripeSubscriptionId,
            stripeSubscriptionCurrentPeriodEnd: tenant.stripeSubscriptionCurrentPeriodEnd,
            trialEndsAt: null,
        }).source !== 'paid_subscription') {
            return 'skipped_inactive_subscription';
        }
        return null;
    }

    private requiresRefund(
        context: PurchaseContext,
        disposition: CreditPurchaseDisposition,
    ): boolean {
        return disposition !== 'applied'
            && this.asString(context.session.mode)?.toLowerCase() === 'payment'
            && this.asString(context.session.status)?.toLowerCase() === 'complete'
            && this.asString(context.session.payment_status)?.toLowerCase() === 'paid';
    }

    private async createRefund(context: PurchaseContext, attempt: number): Promise<PurchaseRefund> {
        const paymentIntentId = this.resolveObjectId(context.session.payment_intent);
        const amount = this.asNumber(context.session.amount_total);
        const currency = this.asString(context.session.currency)?.toLowerCase();
        if (!paymentIntentId) {
            throw new ServiceUnavailableException('Stripe payment identity is not authoritative for refund');
        }
        if (!Number.isSafeInteger(amount) || (amount ?? 0) <= 0 || !currency) {
            throw new ServiceUnavailableException('Stripe payment amount is not authoritative for refund');
        }
        let refund: StripeObject;
        try {
            refund = await this.getStripe().refunds.create({
                payment_intent: paymentIntentId,
                amount: amount!,
                metadata: {
                    purchaseType: CREDIT_PACK_PURCHASE_TYPE,
                    tenantId: context.tenantId,
                    checkoutSessionId: context.sessionId,
                },
            }, {
                idempotencyKey: this.refundIdempotencyKey(context.sessionId, attempt),
            }) as StripeObject;
        } catch (error) {
            this.logger.warn(stripeErrorLog('stripe.credit_purchase_refund_create_failed', error));
            throw new ServiceUnavailableException('Stripe credit purchase refund request failed');
        }
        return this.validateRefund(context, refund);
    }

    private async reconcileRefundTransaction(
        tx: Prisma.TransactionClient,
        context: PurchaseContext,
        webhookRefundId?: string,
    ): Promise<boolean> {
        await this.lockTenantBilling(tx, context.tenantId);
        const hasRefundTerminal = await this.hasRefundTerminal(tx, context.sessionId);
        const existingTransaction = await tx.creditTransaction.findUnique({
            where: { id: this.purchaseTransactionId(context.sessionId) },
            select: { id: true },
        });
        if (existingTransaction) {
            throw new ServiceUnavailableException('Stripe credit purchase has conflicting terminal outcomes');
        }
        if (hasRefundTerminal) return false;

        const purchaseEvent = await tx.billingEvent.findUnique({
            where: { id: this.purchaseEventId(context.sessionId) },
            select: { id: true, metadata: true },
        }) as BillingEventRecord | null;
        if (this.metadataString(purchaseEvent?.metadata, 'outcomeState') !== 'refund_required') {
            throw new ServiceUnavailableException('Stripe credit purchase refund has no durable purchase state');
        }

        const records = await tx.billingEvent.findMany({
            where: {
                tenantId: context.tenantId,
                metadata: { path: ['checkoutSessionId'], equals: context.sessionId },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, type: true, metadata: true, createdAt: true },
        }) as BillingEventRecord[];
        const refundRecords = records.filter((record) =>
            this.metadataString(record.metadata, 'source') === 'stripe_credit_purchase_refund');
        let attempt = refundRecords.reduce(
            (maximum, record) => Math.max(maximum, this.metadataNumber(record.metadata, 'attempt') ?? -1),
            -1,
        );
        const latest = [...refundRecords]
            .sort((left, right) =>
                (this.metadataNumber(left.metadata, 'attempt') ?? -1)
                - (this.metadataNumber(right.metadata, 'attempt') ?? -1))
            .at(-1);
        const refundId = webhookRefundId
            ?? this.metadataString(latest?.metadata, 'refundId')
            ?? this.metadataString(purchaseEvent?.metadata, 'legacyRefundId');

        if (refundId) {
            const refund = await this.retrieveRefund(context, refundId);
            const knownAttempt = refundRecords
                .filter((record) => this.metadataString(record.metadata, 'refundId') === refund.id)
                .reduce(
                    (maximum, record) => Math.max(
                        maximum,
                        this.metadataNumber(record.metadata, 'attempt') ?? -1,
                    ),
                    -1,
                );
            if (knownAttempt < 0) attempt += 1;
            else attempt = knownAttempt;
            await this.recordRefundState(tx, context, refund, attempt);
            if (refund.status === 'succeeded') {
                await this.recordRefundTerminal(tx, context, refund, attempt);
                return false;
            }
            if (refund.status === 'pending' || refund.status === 'requires_action') return true;
            if (attempt + 1 >= MAX_REFUND_ATTEMPTS) return true;
            attempt += 1;
        } else {
            attempt = 0;
        }

        const refund = await this.createRefund(context, attempt);
        await this.recordRefundState(tx, context, refund, attempt);
        if (refund.status === 'succeeded') {
            await this.recordRefundTerminal(tx, context, refund, attempt);
            return false;
        }
        return true;
    }

    private async retrieveRefund(
        context: PurchaseContext,
        refundId: string,
    ): Promise<PurchaseRefund> {
        try {
            const refund = await this.getStripe().refunds.retrieve(refundId) as StripeObject;
            return this.validateRefund(context, refund);
        } catch (error) {
            if (error instanceof ServiceUnavailableException) throw error;
            this.logger.warn(stripeErrorLog('stripe.credit_purchase_refund_retrieve_failed', error));
            throw new ServiceUnavailableException('Stripe credit purchase refund lookup failed');
        }
    }

    private validateRefund(context: PurchaseContext, refund: StripeObject): PurchaseRefund {
        const id = this.asString(refund.id);
        const status = this.asString(refund.status)?.toLowerCase();
        const amount = this.asNumber(refund.amount);
        const currency = this.asString(refund.currency)?.toLowerCase();
        const paymentIntentId = this.resolveObjectId(refund.payment_intent);
        const expectedAmount = this.asNumber(context.session.amount_total);
        const expectedCurrency = this.asString(context.session.currency)?.toLowerCase();
        const expectedPaymentIntentId = this.resolveObjectId(context.session.payment_intent);
        if (
            !id
            || !status
            || !['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(status)
            || amount !== expectedAmount
            || currency !== expectedCurrency
            || paymentIntentId !== expectedPaymentIntentId
            || refund.metadata?.purchaseType !== CREDIT_PACK_PURCHASE_TYPE
            || this.asString(refund.metadata?.tenantId) !== context.tenantId
            || this.asString(refund.metadata?.checkoutSessionId) !== context.sessionId
        ) {
            throw new ServiceUnavailableException('Stripe credit purchase refund could not be verified');
        }
        return { id, status, amount: amount!, currency: currency!, paymentIntentId: paymentIntentId! };
    }

    private async recordRefundState(
        tx: Prisma.TransactionClient,
        context: PurchaseContext,
        refund: PurchaseRefund,
        attempt: number,
    ): Promise<void> {
        const id = this.refundStateEventId(context.sessionId, refund.id, refund.status);
        if (await tx.billingEvent.findUnique({ where: { id }, select: { id: true } })) return;
        await tx.billingEvent.create({
            data: {
                id,
                tenantId: context.tenantId,
                type: `credit_purchase.refund.${refund.status}`,
                amount: refund.amount,
                currency: refund.currency,
                metadata: {
                    source: 'stripe_credit_purchase_refund',
                    outcomeState: refund.status === 'succeeded' ? 'refund_observed' : 'recoverable',
                    checkoutSessionId: context.sessionId,
                    refundId: refund.id,
                    refundStatus: refund.status,
                    attempt,
                    paymentIntentRef: this.safeIdentifierRef(refund.paymentIntentId),
                },
            },
        });
    }

    private async recordRefundTerminal(
        tx: Prisma.TransactionClient,
        context: PurchaseContext,
        refund: PurchaseRefund,
        attempt: number,
    ): Promise<void> {
        const id = this.refundTerminalEventId(context.sessionId);
        if (await tx.billingEvent.findUnique({ where: { id }, select: { id: true } })) return;
        await tx.billingEvent.create({
            data: {
                id,
                tenantId: context.tenantId,
                type: 'credit_purchase.refund.succeeded',
                amount: refund.amount,
                currency: refund.currency,
                metadata: {
                    source: 'stripe_credit_purchase_terminal',
                    outcomeState: 'refund_confirmed',
                    checkoutSessionId: context.sessionId,
                    refundId: refund.id,
                    attempt,
                },
            },
        });
        this.logger.log(`Stripe credit purchase refund confirmed: session=${context.sessionId}`);
    }

    private async hasRefundTerminal(
        tx: Prisma.TransactionClient,
        sessionId: string,
    ): Promise<boolean> {
        return Boolean(await tx.billingEvent.findUnique({
            where: { id: this.refundTerminalEventId(sessionId) },
            select: { id: true },
        }));
    }

    private async findLegacyPurchaseEvent(
        tx: Prisma.TransactionClient,
        context: PurchaseContext,
    ): Promise<BillingEventRecord | null> {
        return tx.billingEvent.findFirst({
            where: {
                tenantId: context.tenantId,
                metadata: { path: ['checkoutSessionId'], equals: context.sessionId },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, type: true, metadata: true, createdAt: true },
        }) as Promise<BillingEventRecord | null>;
    }

    private async recordLegacyRefundRecoveryState(
        tx: Prisma.TransactionClient,
        context: PurchaseContext,
        legacy: BillingEventRecord,
        refundId: string,
    ): Promise<void> {
        await tx.billingEvent.create({
            data: {
                id: this.purchaseEventId(context.sessionId),
                tenantId: context.tenantId,
                type: 'credit_purchase.recovery_required',
                amount: this.asNumber(context.session.amount_total),
                currency: this.asString(context.session.currency)?.toLowerCase() ?? 'usd',
                metadata: {
                    source: 'stripe_credit_purchase',
                    outcomeState: 'refund_required',
                    disposition: 'legacy_refund_recovery',
                    checkoutSessionId: context.sessionId,
                    legacyEventRef: this.safeIdentifierRef(legacy.id),
                    legacyRefundId: refundId,
                },
            },
        });
    }

    private resolveMetadataPrice(
        context: PurchaseContext,
        pack: CreditPackConfig,
    ): AuthoritativePrice | null {
        const priceId = this.asString(context.session.metadata?.priceId);
        const amount = this.parsePositiveInteger(context.session.metadata?.unitAmount);
        const currency = this.asString(context.session.metadata?.currency)?.toLowerCase();
        const hasSnapshotField = context.session.metadata
            && typeof context.session.metadata === 'object'
            && ['unitAmount', 'currency', 'quantity'].some((key) =>
                Object.hasOwn(context.session.metadata, key));
        if (hasSnapshotField) {
            if (!priceId || !amount || !currency || !/^[a-z]{3}$/.test(currency)) return null;
            const expectedMetadata = buildCreditPackMetadata(
                context.tenantId,
                pack,
                priceId,
                amount,
                currency,
            );
            if (!creditPackMetadataMatches(context.session.metadata, expectedMetadata)) return null;
            return { priceId, amount, currency };
        }

        const metadata = context.session.metadata;
        const linePrice = context.lineItems.data[0]?.price;
        const legacyAmount = this.asNumber(linePrice?.unit_amount);
        const legacyCurrency = this.asString(linePrice?.currency)?.toLowerCase();
        if (
            !priceId
            || metadata?.purchaseType !== CREDIT_PACK_PURCHASE_TYPE
            || this.asString(metadata?.tenantId) !== context.tenantId
            || this.asString(metadata?.creditPackCode) !== pack.code
            || this.asString(metadata?.creditAmount) !== String(pack.credits)
            || this.resolveObjectId(linePrice) !== priceId
            || this.asString(linePrice?.type)?.toLowerCase() !== 'one_time'
            || !Number.isSafeInteger(legacyAmount)
            || (legacyAmount ?? 0) <= 0
            || !legacyCurrency
            || !/^[a-z]{3}$/.test(legacyCurrency)
        ) {
            return null;
        }
        return { priceId, amount: legacyAmount!, currency: legacyCurrency };
    }

    private resolveSubscriptionDisposition(
        tenant: TenantState,
        subscription: StripeObject,
    ): CreditPurchaseDisposition | null {
        const status = this.asString(subscription.status)?.toLowerCase();
        if (
            subscription.deleted === true
            || this.asString(subscription.id) !== tenant.stripeSubscriptionId
            || status !== 'active'
            || !this.hasManagedSubscriptionPrice(subscription)
        ) {
            return 'skipped_inactive_subscription';
        }
        const metadataTenantId = this.asString(subscription.metadata?.tenantId);
        if (
            this.resolveCustomerId(subscription) !== tenant.stripeCustomerId
            || (metadataTenantId !== null && metadataTenantId !== tenant.id)
        ) {
            return 'skipped_tenant_mismatch';
        }
        return null;
    }

    private isExactLineItem(context: PurchaseContext, price: AuthoritativePrice): boolean {
        if (context.lineItems.has_more === true || context.lineItems.data.length !== 1) return false;
        const lineItem = context.lineItems.data[0];
        return this.resolveObjectId(lineItem.price) === price.priceId
            && this.asNumber(lineItem.quantity) === 1
            && this.asNumber(lineItem.amount_subtotal) === price.amount
            && this.asNumber(lineItem.amount_total) === price.amount
            && this.asString(lineItem.currency)?.toLowerCase() === price.currency
            && this.asNumber(context.session.amount_subtotal) === price.amount
            && this.asNumber(context.session.amount_total) === price.amount
            && this.asString(context.session.currency)?.toLowerCase() === price.currency;
    }

    private assertUniquePackPrices(): void {
        const priceIds = configuredCreditPackPriceIds(
            (key) => this.configService.get<string>(key),
        );
        if (new Set(priceIds).size !== priceIds.length) {
            throw new ServiceUnavailableException('Credit pack Stripe prices must be unique');
        }
    }

    private requireConfiguredPriceId(pack: CreditPackConfig): string {
        this.assertUniquePackPrices();
        const priceId = this.configService.get<string>(pack.envKey)?.trim();
        if (!priceId) {
            throw new ServiceUnavailableException('Selected credit pack is not configured');
        }
        return priceId;
    }

    private async retrieveAuthoritativePrice(
        pack: CreditPackConfig,
        priceId: string,
    ): Promise<AuthoritativePrice> {
        const price = await this.getStripe().prices.retrieve(priceId);
        if (
            price.id !== priceId
            || price.active !== true
            || price.type !== 'one_time'
            || !Number.isSafeInteger(price.unit_amount)
            || (price.unit_amount ?? 0) <= 0
            || !this.asString(price.currency)
        ) {
            this.logger.error(`Stripe price for ${pack.code} is not an active fixed one-time price.`);
            throw new ServiceUnavailableException('Credit pack price is not safely configured');
        }
        return {
            priceId,
            amount: price.unit_amount!,
            currency: price.currency.toLowerCase(),
        };
    }

    private async assertTenantCanPurchase(
        tx: Prisma.TransactionClient,
        tenantId: string,
    ): Promise<string> {
        const tenant = await tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                planTier: true,
                status: true,
                deletedAt: true,
                stripeCustomerId: true,
                stripeSubscriptionId: true,
                stripeSubscriptionCurrentPeriodEnd: true,
            },
        }) as TenantState | null;
        const subscriptionId = tenant?.stripeSubscriptionId?.trim() || null;
        if (
            !tenant
            || !tenant.stripeCustomerId
            || !subscriptionId
            || this.resolveTenantDisposition(tenant) !== null
        ) {
            throw new BadRequestException('An active paid subscription is required to purchase credits.');
        }
        const subscription = await this.getStripe().subscriptions.retrieve(
            subscriptionId,
            { expand: ['items.data.price'] } as any,
        ) as StripeObject;
        if (this.resolveSubscriptionDisposition(tenant, subscription)) {
            throw new BadRequestException('An active paid subscription is required to purchase credits.');
        }
        return tenant.stripeCustomerId;
    }

    private async resolveOpenCheckoutSessions(
        customerId: string,
        expectedMetadata: CreditPackMetadata,
    ): Promise<CheckoutResolution> {
        const sessions = await this.getStripe().checkout.sessions.list({
            customer: customerId,
            status: 'open',
            limit: 100,
        });
        let reusable: CreditPackCheckoutSessionResponse | null = null;
        const tenantSessionIds: string[] = [];
        for (const session of sessions.data) {
            if (
                session.metadata?.purchaseType !== CREDIT_PACK_PURCHASE_TYPE
                || session.metadata?.tenantId !== expectedMetadata.tenantId
                || !session.id
            ) {
                continue;
            }
            tenantSessionIds.push(session.id);
            const exactPack = session.mode === 'payment'
                && session.client_reference_id === expectedMetadata.tenantId
                && creditPackMetadataMatches(session.metadata, expectedMetadata);
            if (!reusable && exactPack && session.url) {
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

    private hasManagedSubscriptionPrice(subscription: StripeObject): boolean {
        const configured = new Set(
            SUBSCRIPTION_PRICE_KEYS
                .map((key) => this.configService.get<string>(key)?.trim())
                .filter((priceId): priceId is string => Boolean(priceId)),
        );
        const items = Array.isArray(subscription.items?.data) ? subscription.items.data : [];
        const matched = new Set(
            items
                .map((item: StripeObject) => this.resolveObjectId(item.price))
                .filter((priceId: string | null): priceId is string => Boolean(priceId && configured.has(priceId))),
        );
        return matched.size === 1;
    }

    private checkoutIdempotencyKey(
        tenantId: string,
        code: string,
        priceId: string,
        sessionGeneration: string,
    ): string {
        const minuteBucket = Math.floor(Date.now() / 60_000);
        return createHash('sha256')
            .update(`credit-checkout:${tenantId}:${code}:${priceId}:${sessionGeneration}:${minuteBucket}`)
            .digest('hex');
    }

    private refundIdempotencyKey(sessionId: string, attempt: number): string {
        return createHash('sha256')
            .update(`credit-purchase-refund:${sessionId}:${attempt}`)
            .digest('hex');
    }

    private purchaseTransactionId(sessionId: string): string {
        return `${PURCHASE_TRANSACTION_PREFIX}${sessionId}`;
    }

    private purchaseEventId(sessionId: string): string {
        return `${PURCHASE_EVENT_PREFIX}${this.stableRef(sessionId)}`;
    }

    private purchaseRecoverableEventId(eventId: string): string {
        return `${PURCHASE_RECOVERABLE_EVENT_PREFIX}${this.stableRef(eventId)}`;
    }

    private refundStateEventId(sessionId: string, refundId: string, status: string): string {
        return `${REFUND_EVENT_PREFIX}${this.stableRef(`${sessionId}:${refundId}:${status}`)}`;
    }

    private refundTerminalEventId(sessionId: string): string {
        return `${REFUND_TERMINAL_PREFIX}${this.stableRef(sessionId)}`;
    }

    private stableRef(value: string): string {
        return createHash('sha256').update(value).digest('hex');
    }

    private async lockTenantBilling(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-checkout:${tenantId}`}, 0))`;
    }

    private resolveCustomerId(value: StripeObject): string | null {
        return this.asString(value.customer) ?? this.asString(value.customer?.id);
    }

    private resolveObjectId(value: unknown): string | null {
        if (typeof value === 'string') return this.asString(value);
        if (value && typeof value === 'object') {
            return this.asString((value as StripeObject).id);
        }
        return null;
    }

    private safeIdentifierRef(value: string | null): string {
        return value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : 'missing';
    }

    private metadataString(metadata: unknown, key: string): string | null {
        return metadata && typeof metadata === 'object'
            ? this.asString((metadata as StripeObject)[key])
            : null;
    }

    private metadataNumber(metadata: unknown, key: string): number | null {
        return metadata && typeof metadata === 'object'
            ? this.asNumber((metadata as StripeObject)[key])
            : null;
    }

    private parsePositiveInteger(value: unknown): number | null {
        if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    private asString(value: unknown): string | null {
        return typeof value === 'string' && value.trim() ? value : null;
    }

    private asNumber(value: unknown): number | null {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    private getStripe(): Stripe {
        if (!this.stripe) {
            throw new ServiceUnavailableException('Stripe billing is not configured');
        }
        return this.stripe;
    }

}
