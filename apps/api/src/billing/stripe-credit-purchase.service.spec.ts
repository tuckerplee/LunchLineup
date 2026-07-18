import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TenantStatus } from '@lunchlineup/db';
import { describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { StripeCreditPurchaseService } from './stripe-credit-purchase.service';

const PACK_PRICES = {
    price_credit_100: 1200,
    price_credit_500: 5000,
    price_credit_2000: 16000,
} as const;

const defaultConfig: Record<string, string | undefined> = {
    STRIPE_SECRET_KEY: 'sk_test_credit_purchase',
    STRIPE_PRICE_STARTER: 'price_plan_starter',
    STRIPE_PRICE_CREDIT_PACK_100: 'price_credit_100',
    STRIPE_PRICE_CREDIT_PACK_500: 'price_credit_500',
    STRIPE_PRICE_CREDIT_PACK_2000: 'price_credit_2000',
};

function checkoutEvent(id = 'evt_credit_1', sessionId = 'cs_credit_1') {
    return {
        id,
        type: 'checkout.session.completed',
        data: { object: { id: sessionId } },
    } as any;
}

function buildHarness(options: {
    config?: Record<string, string | undefined>;
    tenant?: Record<string, unknown>;
    session?: Record<string, unknown>;
    subscription?: Record<string, unknown>;
    lineItems?: Record<string, unknown>;
} = {}) {
    const values = { ...defaultConfig, ...options.config };
    const config = {
        get: vi.fn((key: string) => values[key]),
    };
    const tenant = {
        id: 'tenant-1',
        planTier: 'GROWTH',
        status: TenantStatus.ACTIVE,
        deletedAt: null,
        usageCredits: 0,
        creditDebt: 0,
        stripeCustomerId: 'cus_tenant_1',
        stripeSubscriptionId: 'sub_tenant_1',
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        ...options.tenant,
    };
    const session = {
        id: 'cs_credit_1',
        mode: 'payment',
        status: 'complete',
        payment_status: 'paid',
        payment_intent: 'pi_credit_1',
        customer: 'cus_tenant_1',
        client_reference_id: 'tenant-1',
        amount_subtotal: 1200,
        amount_total: 1200,
        currency: 'usd',
        metadata: {
            purchaseType: 'credit_pack',
            tenantId: 'tenant-1',
            creditPackCode: 'CREDITS_100',
            creditAmount: '100',
            priceId: 'price_credit_100',
            unitAmount: '1200',
            currency: 'usd',
            quantity: '1',
        },
        ...options.session,
    } as any;
    const lineItems = {
        data: [{
            id: 'li_credit_1',
            price: { id: 'price_credit_100' },
            quantity: 1,
            amount_subtotal: 1200,
            amount_total: 1200,
            currency: 'usd',
        }],
        has_more: false,
        ...options.lineItems,
    } as any;
    const subscription = {
        id: 'sub_tenant_1',
        status: 'active',
        customer: 'cus_tenant_1',
        metadata: { tenantId: 'tenant-1' },
        items: { data: [{ price: { id: 'price_plan_starter' } }] },
        ...options.subscription,
    } as any;
    const billingEvents: any[] = [];
    const creditTransactions: any[] = [];
    const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        tenant: {
            findUnique: vi.fn(async (args: any) => (
                args.where?.id === tenant.id ? tenant : null
            )),
            findUniqueOrThrow: vi.fn(async (args: any) => {
                if (args.where?.id !== tenant.id) throw new Error('Tenant not found');
                return tenant;
            }),
            update: vi.fn(async (args: any) => {
                tenant.usageCredits += args.data?.usageCredits?.increment ?? 0;
                tenant.creditDebt -= args.data?.creditDebt?.decrement ?? 0;
                return tenant;
            }),
        },
        billingEvent: {
            findUnique: vi.fn(async (args: any) =>
                billingEvents.find((record) => record.id === args.where?.id) ?? null),
            findMany: vi.fn(async (args: any) => billingEvents.filter((record) =>
                record.tenantId === args.where?.tenantId
                && record.metadata?.checkoutSessionId === args.where?.metadata?.equals)),
            findFirst: vi.fn(async (args: any) => billingEvents.find((record) =>
                record.tenantId === args.where?.tenantId
                && record.metadata?.checkoutSessionId === args.where?.metadata?.equals) ?? null),
            create: vi.fn(async (args: any) => {
                if (billingEvents.some((record) => record.id === args.data.id)) throw { code: 'P2002' };
                const record = { ...args.data, createdAt: new Date() };
                billingEvents.push(record);
                return record;
            }),
        },
        creditTransaction: {
            findUnique: vi.fn(async (args: any) =>
                creditTransactions.find((record) => record.id === args.where?.id) ?? null),
            create: vi.fn(async (args: any) => {
                if (creditTransactions.some((record) => record.id === args.data.id)) throw { code: 'P2002' };
                creditTransactions.push(args.data);
                return args.data;
            }),
        },
    };
    let transactionTail = Promise.resolve();
    const prisma = {
        $transaction: vi.fn((operation: any) => {
            const result = transactionTail.then(() => operation(tx));
            transactionTail = result.then(() => undefined, () => undefined);
            return result;
        }),
    };
    const service = new StripeCreditPurchaseService(
        config as any,
        new TenantPrismaService(prisma as any),
    );
    const stripe = {
        prices: {
            retrieve: vi.fn(async (priceId: keyof typeof PACK_PRICES): Promise<any> => ({
                id: priceId,
                active: true,
                type: 'one_time',
                unit_amount: PACK_PRICES[priceId],
                currency: 'usd',
            })),
        },
        subscriptions: {
            retrieve: vi.fn().mockResolvedValue(subscription),
        },
        refunds: {
            create: vi.fn().mockImplementation(async (params: any) => ({
                id: 're_credit_1',
                status: 'succeeded',
                amount: params.amount,
                currency: session.currency,
                payment_intent: params.payment_intent,
                metadata: params.metadata,
            })),
            retrieve: vi.fn().mockImplementation(async (refundId: string) => ({
                id: refundId,
                status: 'succeeded',
                amount: 1200,
                currency: 'usd',
                payment_intent: 'pi_credit_1',
                metadata: {
                    purchaseType: 'credit_pack',
                    tenantId: 'tenant-1',
                    checkoutSessionId: 'cs_credit_1',
                },
            })),
        },
        checkout: {
            sessions: {
                list: vi.fn().mockResolvedValue({ data: [] }),
                create: vi.fn().mockResolvedValue({
                    id: 'cs_credit_created',
                    url: 'https://checkout.stripe.test/cs_credit_created',
                }),
                retrieve: vi.fn().mockResolvedValue(session),
                listLineItems: vi.fn().mockResolvedValue(lineItems),
                expire: vi.fn().mockResolvedValue({ status: 'expired' }),
            },
        },
    };
    const logger = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };
    (service as any).stripe = stripe;
    (service as any).logger = logger;

    return {
        billingEvents,
        config,
        creditTransactions,
        lineItems,
        logger,
        prisma,
        service,
        session,
        stripe,
        subscription,
        tenant,
        tx,
    };
}

function expectNoGrant(harness: ReturnType<typeof buildHarness>) {
    expect(harness.tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(harness.tx.tenant.update).not.toHaveBeenCalled();
}

function refundFor(
    harness: ReturnType<typeof buildHarness>,
    status: string,
    id = 're_credit_1',
    overrides: Record<string, unknown> = {},
) {
    return {
        id,
        status,
        amount: harness.session.amount_total,
        currency: harness.session.currency,
        payment_intent: harness.session.payment_intent,
        metadata: {
            purchaseType: 'credit_pack',
            tenantId: harness.session.metadata.tenantId,
            checkoutSessionId: harness.session.id,
        },
        ...overrides,
    };
}

describe('StripeCreditPurchaseService catalog and Checkout', () => {
    it('publishes only the authoritative fixed packs without leaking Stripe Price IDs', async () => {
        const { service, stripe } = buildHarness();

        const options = await service.getOptions();

        expect(options).toEqual([
            { code: 'CREDITS_100', credits: 100, configured: true, amount: 1200, currency: 'usd' },
            { code: 'CREDITS_500', credits: 500, configured: true, amount: 5000, currency: 'usd' },
            { code: 'CREDITS_2000', credits: 2000, configured: true, amount: 16000, currency: 'usd' },
        ]);
        expect(stripe.prices.retrieve.mock.calls.map(([priceId]) => priceId)).toEqual([
            'price_credit_100',
            'price_credit_500',
            'price_credit_2000',
        ]);
        expect(options.every((option) => !Object.hasOwn(option, 'priceId'))).toBe(true);
        expect(JSON.stringify(options)).not.toContain('price_credit_');
    });

    it('marks an unconfigured fixed pack unavailable without consulting Stripe or exposing config', async () => {
        const harness = buildHarness({
            config: { STRIPE_PRICE_CREDIT_PACK_500: undefined },
        });

        const options = await harness.service.getOptions();

        expect(options[1]).toEqual({
            code: 'CREDITS_500',
            credits: 500,
            configured: false,
            amount: null,
            currency: null,
        });
        expect(harness.stripe.prices.retrieve).not.toHaveBeenCalledWith('price_credit_500');
        expect(JSON.stringify(options)).not.toContain('price_credit_');
    });

    it.each([
        ['inactive', { active: false }],
        ['recurring', { type: 'recurring' }],
        ['zero amount', { unit_amount: 0 }],
        ['fractional amount', { unit_amount: 12.5 }],
        ['missing currency', { currency: '' }],
        ['mismatched identity', { id: 'price_attacker' }],
    ])('fails closed for an %s configured pack Price', async (_label, priceOverride) => {
        const harness = buildHarness();
        harness.stripe.prices.retrieve.mockImplementation(async (priceId: keyof typeof PACK_PRICES) => ({
            id: priceId,
            active: true,
            type: 'one_time',
            unit_amount: PACK_PRICES[priceId],
            currency: 'usd',
            ...(priceId === 'price_credit_100' ? priceOverride : {}),
        }));

        await expect(harness.service.getOptions()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('rejects duplicate configured Price IDs before publishing or creating a Checkout Session', async () => {
        const harness = buildHarness({
            config: { STRIPE_PRICE_CREDIT_PACK_500: 'price_credit_100' },
        });

        await expect(harness.service.getOptions()).rejects.toThrow('must be unique');
        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        )).rejects.toThrow('must be unique');
        expect(harness.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('creates a one-time pack Checkout only for the tenant active paid subscription', async () => {
        const harness = buildHarness();

        const result = await harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        );

        expect(result).toEqual({
            sessionId: 'cs_credit_created',
            checkoutUrl: 'https://checkout.stripe.test/cs_credit_created',
        });
        expect(result).not.toHaveProperty('priceId');
        expect(harness.stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_tenant_1', {
            expand: ['items.data.price'],
        });
        expect(harness.stripe.checkout.sessions.create).toHaveBeenCalledWith({
            mode: 'payment',
            customer: 'cus_tenant_1',
            line_items: [{ price: 'price_credit_100', quantity: 1 }],
            success_url: 'https://app.example.test/dashboard/settings?billing=credit-purchase-success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'https://app.example.test/dashboard/settings?billing=credit-purchase-cancelled',
            client_reference_id: 'tenant-1',
            metadata: {
                purchaseType: 'credit_pack',
                tenantId: 'tenant-1',
                creditPackCode: 'CREDITS_100',
                creditAmount: '100',
                priceId: 'price_credit_100',
                unitAmount: '1200',
                currency: 'usd',
                quantity: '1',
            },
            payment_intent_data: {
                metadata: {
                    purchaseType: 'credit_pack',
                    tenantId: 'tenant-1',
                    creditPackCode: 'CREDITS_100',
                    creditAmount: '100',
                    priceId: 'price_credit_100',
                    unitAmount: '1200',
                    currency: 'usd',
                    quantity: '1',
                },
            },
        }, {
            idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
    });

    it.each([
        [TenantStatus.TRIAL, 'sub_tenant_1'],
        [TenantStatus.PAST_DUE, 'sub_tenant_1'],
        [TenantStatus.SUSPENDED, 'sub_tenant_1'],
        [TenantStatus.CANCELLED, 'sub_tenant_1'],
        [TenantStatus.ACTIVE, null],
    ])('rejects tenant status %s with subscription %s', async (status, stripeSubscriptionId) => {
        const harness = buildHarness({ tenant: { status, stripeSubscriptionId } });

        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        )).rejects.toBeInstanceOf(BadRequestException);
        expect(harness.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it.each([
        ['FREE plan', { planTier: 'FREE' }],
        ['expired paid-through', {
            stripeSubscriptionCurrentPeriodEnd: new Date('2000-01-01T00:00:00.000Z'),
        }],
        ['missing paid-through', { stripeSubscriptionCurrentPeriodEnd: null }],
        ['blank subscription ID', { stripeSubscriptionId: '   ' }],
    ])('rejects Checkout for canonical paid-state failure: %s', async (_label, tenant) => {
        const harness = buildHarness({ tenant });

        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        )).rejects.toBeInstanceOf(BadRequestException);
        expect(harness.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(harness.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it.each([
        ['trialing subscription', { status: 'trialing' }],
        ['past-due subscription', { status: 'past_due' }],
        ['wrong plan Price', { items: { data: [{ price: { id: 'price_other' } }] } }],
        ['wrong customer', { customer: 'cus_other' }],
        ['wrong tenant metadata', { metadata: { tenantId: 'tenant-other' } }],
    ])('rejects an active tenant with a %s', async (_label, subscription) => {
        const harness = buildHarness({ subscription });

        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        )).rejects.toBeInstanceOf(BadRequestException);
        expect(harness.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('rejects caller-invented pack codes before tenant or Checkout work', async () => {
        const harness = buildHarness();

        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_999999',
            'https://app.example.test',
        )).rejects.toBeInstanceOf(BadRequestException);
        expect(harness.prisma.$transaction).not.toHaveBeenCalled();
        expect(harness.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('reuses only an exact open tenant pack Session', async () => {
        const harness = buildHarness();
        harness.stripe.checkout.sessions.list.mockResolvedValue({
            data: [{
                id: 'cs_existing',
                url: 'https://checkout.stripe.test/cs_existing',
                mode: 'payment',
                client_reference_id: 'tenant-1',
                metadata: harness.session.metadata,
            }],
        });

        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        )).resolves.toEqual({
            sessionId: 'cs_existing',
            checkoutUrl: 'https://checkout.stripe.test/cs_existing',
        });
        expect(harness.stripe.checkout.sessions.create).not.toHaveBeenCalled();
        expect(harness.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    });

    it('expires a mismatched tenant pack Session before creating the selected fixed pack', async () => {
        const harness = buildHarness();
        harness.stripe.checkout.sessions.list.mockResolvedValue({
            data: [{
                id: 'cs_wrong_pack',
                url: 'https://checkout.stripe.test/cs_wrong_pack',
                mode: 'payment',
                client_reference_id: 'tenant-1',
                metadata: { ...harness.session.metadata, creditPackCode: 'CREDITS_500' },
            }],
        });

        await harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        );

        expect(harness.stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_wrong_pack');
        expect(harness.stripe.checkout.sessions.create).toHaveBeenCalledOnce();
    });
});

describe('StripeCreditPurchaseService fulfillment verification', () => {
    it('grants the authoritative fixed pack exactly once in the tenant transaction', async () => {
        const harness = buildHarness();
        const event = checkoutEvent();
        event.data.object = {
            id: 'cs_credit_1',
            customer: 'cus_attacker',
            amount_total: 1,
            metadata: { tenantId: 'tenant-attacker', creditAmount: '999999' },
        };

        await harness.service.handleCheckoutSessionCompleted(event);

        expect(harness.stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_credit_1', {
            expand: ['line_items.data.price'],
        });
        expect(harness.stripe.checkout.sessions.listLineItems).toHaveBeenCalledWith('cs_credit_1', {
            limit: 2,
            expand: ['data.price'],
        });
        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                stripeEventId: 'evt_credit_1',
                amount: 1200,
                currency: 'usd',
                metadata: expect.objectContaining({
                    disposition: 'applied',
                    checkoutSessionId: 'cs_credit_1',
                    creditPackCode: 'CREDITS_100',
                    creditAmount: 100,
                }),
            }),
        });
        expect(harness.tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: 'stripe-credit-purchase-cs_credit_1',
                tenantId: 'tenant-1',
                amount: 100,
                debtAmount: 0,
                reason: 'Stripe credit pack purchase CREDITS_100',
                balanceAfter: 100,
                debtAfter: 0,
            },
            select: { id: true },
        });
        expect(harness.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                usageCredits: { increment: 100 },
                creditDebt: { decrement: 0 },
            },
            select: { usageCredits: true, creditDebt: true },
        });
    });

    it('repays outstanding credit debt before exposing purchased credits', async () => {
        const harness = buildHarness({
            tenant: { usageCredits: 10, creditDebt: 40 },
        });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .resolves.toEqual({
                transactionId: 'stripe-credit-purchase-cs_credit_1',
                newBalance: 70,
                replayed: false,
            });

        expect(harness.tenant).toEqual(expect.objectContaining({
            usageCredits: 70,
            creditDebt: 0,
        }));
        expect(harness.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                usageCredits: { increment: 60 },
                creditDebt: { decrement: 40 },
            },
            select: { usageCredits: true, creditDebt: true },
        });
        expect(harness.tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: 'stripe-credit-purchase-cs_credit_1',
                tenantId: 'tenant-1',
                amount: 60,
                debtAmount: -40,
                reason: 'Stripe credit pack purchase CREDITS_100',
                balanceAfter: 70,
                debtAfter: 0,
            },
            select: { id: true },
        });
    });

    it('grants an already-open legacy Checkout after its configured Price rotates', async () => {
        const harness = buildHarness({
            config: { STRIPE_PRICE_CREDIT_PACK_100: 'price_credit_100_rotated' },
        });
        delete harness.session.metadata.unitAmount;
        delete harness.session.metadata.currency;
        delete harness.session.metadata.quantity;
        harness.lineItems.data[0].price = {
            id: 'price_credit_100',
            active: false,
            type: 'one_time',
            unit_amount: 1200,
            currency: 'usd',
        };

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_legacy_price'));

        expect(harness.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(harness.tx.tenant.update).toHaveBeenCalledOnce();
        expect(harness.stripe.refunds.create).not.toHaveBeenCalled();
        expect(harness.stripe.prices.retrieve).not.toHaveBeenCalled();
    });

    it.each([
        ['purchase type', { purchaseType: 'plan_credit' }],
        ['pack code', { creditPackCode: 'CREDITS_2000' }],
        ['credit amount', { creditAmount: '2000' }],
        ['Price ID', { priceId: 'price_attacker' }],
    ])('audits but does not grant tampered %s metadata', async (_label, metadata) => {
        const harness = buildHarness();
        harness.session.metadata = { ...harness.session.metadata, ...metadata };

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ disposition: 'skipped_mismatch' }),
            }),
        });
        expectNoGrant(harness);
    });

    it.each([
        ['additional item', (h: ReturnType<typeof buildHarness>) => h.lineItems.data.push({ ...h.lineItems.data[0] })],
        ['truncated item list', (h: ReturnType<typeof buildHarness>) => { h.lineItems.has_more = true; }],
        ['wrong Price', (h: ReturnType<typeof buildHarness>) => { h.lineItems.data[0].price.id = 'price_attacker'; }],
        ['quantity above one', (h: ReturnType<typeof buildHarness>) => { h.lineItems.data[0].quantity = 2; }],
        ['discounted line total', (h: ReturnType<typeof buildHarness>) => { h.lineItems.data[0].amount_total = 1000; }],
        ['wrong line currency', (h: ReturnType<typeof buildHarness>) => { h.lineItems.data[0].currency = 'eur'; }],
        ['wrong Session total', (h: ReturnType<typeof buildHarness>) => { h.session.amount_total = 1; }],
    ])('audits but does not grant a payment with %s', async (_label, mutate) => {
        const harness = buildHarness();
        mutate(harness);

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ disposition: 'skipped_mismatch' }),
            }),
        });
        expectNoGrant(harness);
    });

    it.each([
        ['subscription-mode Session', { session: { mode: 'subscription' }, tenant: {} }, 'skipped_mismatch'],
        ['open Session', { session: { status: 'open' }, tenant: {} }, 'skipped_not_complete'],
        ['unpaid Session', { session: { payment_status: 'unpaid' }, tenant: {} }, 'skipped_unpaid'],
        ['deleted tenant', { session: {}, tenant: { deletedAt: new Date() } }, 'skipped_deleted'],
        ['suspended tenant', { session: {}, tenant: { status: TenantStatus.SUSPENDED } }, 'skipped_suspended'],
        ['cancelled tenant', { session: {}, tenant: { status: TenantStatus.CANCELLED } }, 'skipped_inactive_subscription'],
        ['FREE tenant', { session: {}, tenant: { planTier: 'FREE' } }, 'skipped_inactive_subscription'],
        ['expired paid-through tenant', {
            session: {},
            tenant: { stripeSubscriptionCurrentPeriodEnd: new Date('2000-01-01T00:00:00.000Z') },
        }, 'skipped_inactive_subscription'],
        ['missing paid-through tenant', {
            session: {},
            tenant: { stripeSubscriptionCurrentPeriodEnd: null },
        }, 'skipped_inactive_subscription'],
    ])('audits but does not grant a %s', async (_label, overrides, disposition) => {
        const harness = buildHarness(overrides);

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ disposition }),
            }),
        });
        expect(harness.stripe.refunds.create).toHaveBeenCalledTimes(
            ['skipped_deleted', 'skipped_suspended', 'skipped_inactive_subscription'].includes(disposition)
                ? 1
                : 0,
        );
        expectNoGrant(harness);
    });

    it('refunds a verified delayed payment behind the deletion barrier before acknowledging it', async () => {
        const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
        const event = checkoutEvent('evt_credit_delayed');
        event.type = 'checkout.session.async_payment_succeeded';

        await harness.service.handleCheckoutSessionCompleted(event);

        expect(harness.stripe.refunds.create).toHaveBeenCalledWith({
            payment_intent: 'pi_credit_1',
            amount: 1200,
            metadata: {
                purchaseType: 'credit_pack',
                tenantId: 'tenant-1',
                checkoutSessionId: 'cs_credit_1',
            },
        }, {
            idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                stripeEventId: 'evt_credit_delayed',
                metadata: expect.objectContaining({ disposition: 'skipped_suspended' }),
            }),
        });
        expectNoGrant(harness);
    });

    it('refunds a verified late payment after purge cleared the deleted tenant Customer binding', async () => {
        const harness = buildHarness({
            tenant: {
                status: TenantStatus.PURGED,
                deletedAt: new Date(),
                stripeCustomerId: null,
                stripeSubscriptionId: null,
            },
        });

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_credit_after_customer_delete'));

        expect(harness.stripe.refunds.create).toHaveBeenCalledOnce();
        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                stripeEventId: 'evt_credit_after_customer_delete',
                metadata: expect.objectContaining({ disposition: 'skipped_deleted' }),
            }),
        });
        expectNoGrant(harness);
    });

    it.each([
        ['Session customer', { session: { customer: 'cus_other' }, subscription: {} }],
        ['Session tenant reference', { session: { client_reference_id: 'tenant-other' }, subscription: {} }],
        ['subscription customer', { session: {}, subscription: { customer: 'cus_other' } }],
        ['subscription tenant metadata', { session: {}, subscription: { metadata: { tenantId: 'tenant-other' } } }],
    ])('rejects mismatched %s ownership without granting credits', async (_label, overrides) => {
        const harness = buildHarness(overrides);

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ disposition: 'skipped_tenant_mismatch' }),
            }),
        });
        expectNoGrant(harness);
    });

    it('does not audit or grant authoritative Session metadata for an unknown tenant', async () => {
        const harness = buildHarness();
        harness.session.metadata = { ...harness.session.metadata, tenantId: 'tenant-unknown' };

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.tenant.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'tenant-unknown' },
        }));
        expect(harness.tx.billingEvent.create).not.toHaveBeenCalled();
        expectNoGrant(harness);
    });

    it('audits but does not grant when the paid subscription is no longer active at fulfillment', async () => {
        const harness = buildHarness({ subscription: { status: 'past_due' } });

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                metadata: expect.objectContaining({ disposition: 'skipped_inactive_subscription' }),
            }),
        });
        expect(harness.stripe.refunds.create).toHaveBeenCalledOnce();
        expectNoGrant(harness);
    });

    it('acknowledges a duplicate Stripe event without applying a second credit side effect', async () => {
        const harness = buildHarness();

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());
        await harness.service.handleCheckoutSessionCompleted(checkoutEvent());

        expect(harness.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(harness.tx.tenant.update).toHaveBeenCalledOnce();
    });

    it('uses the Checkout Session ledger identity to resist replay under another event ID', async () => {
        const harness = buildHarness();
        await harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_credit_first'));
        harness.tenant.usageCredits += 37;
        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_credit_replay')))
            .resolves.toEqual({
                transactionId: 'stripe-credit-purchase-cs_credit_1',
                newBalance: 100,
                replayed: true,
            });

        expect(harness.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(harness.tx.tenant.update).toHaveBeenCalledOnce();
        expect(harness.tenant.usageCredits).toBe(137);
        expect(harness.tx.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: {
                usageCredits: { increment: 100 },
                creditDebt: { decrement: 0 },
            },
        }));
    });

    it.each([
        ['missing balance', { balanceAfter: null }],
        ['negative balance', { balanceAfter: -1 }],
        ['fractional balance', { balanceAfter: 1.5 }],
        ['wrong tenant', { tenantId: 'tenant-other', balanceAfter: 100 }],
        ['wrong amount', { amount: 500, balanceAfter: 100 }],
        ['positive debt amount', { debtAmount: 1 }],
        ['missing debt balance', { debtAfter: null }],
        ['wrong reason', { reason: 'Unattributed credit', balanceAfter: 100 }],
    ])('rejects a malformed legacy purchase settlement with %s', async (_label, override) => {
        const harness = buildHarness();
        harness.creditTransactions.push({
            id: 'stripe-credit-purchase-cs_credit_1',
            tenantId: 'tenant-1',
            amount: 100,
            debtAmount: 0,
            reason: 'Stripe credit pack purchase CREDITS_100',
            balanceAfter: 100,
            debtAfter: 0,
            ...override,
        });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_legacy_replay')))
            .rejects.toThrow('settlement is malformed or mismatched');
        expect(harness.tx.tenant.update).not.toHaveBeenCalled();
        expect(harness.tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects conflicting terminal grant and provider-refund outcomes', async () => {
        const harness = buildHarness();
        harness.creditTransactions.push({
            id: 'stripe-credit-purchase-cs_credit_1',
            tenantId: 'tenant-1',
            amount: 100,
            debtAmount: 0,
            reason: 'Stripe credit pack purchase CREDITS_100',
            balanceAfter: 100,
            debtAfter: 0,
        });
        harness.billingEvents.push({
            id: (harness.service as any).refundTerminalEventId('cs_credit_1'),
            tenantId: 'tenant-1',
            type: 'credit_purchase.refund.succeeded',
            metadata: {
                source: 'stripe_credit_purchase_refund',
                outcomeState: 'refund_confirmed',
                checkoutSessionId: 'cs_credit_1',
            },
            createdAt: new Date(),
        });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_conflict')))
            .rejects.toThrow('conflicting terminal outcomes');
        expect(harness.tx.tenant.update).not.toHaveBeenCalled();
        expect(harness.tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('uses one provider refund identity for concurrent replay under different event IDs', async () => {
        const harness = buildHarness({ tenant: { deletedAt: new Date() } });
        const refundsByKey = new Map<string, Record<string, unknown>>();
        let providerRefundCreations = 0;
        harness.stripe.refunds.create.mockImplementation(async (_params: any, options: any) => {
            let refund = refundsByKey.get(options.idempotencyKey);
            if (!refund) {
                providerRefundCreations += 1;
                refund = {
                    id: 're_credit_concurrent',
                    status: 'succeeded',
                    amount: 1200,
                    currency: 'usd',
                    payment_intent: 'pi_credit_1',
                    metadata: {
                        purchaseType: 'credit_pack',
                        tenantId: 'tenant-1',
                        checkoutSessionId: 'cs_credit_1',
                    },
                };
                refundsByKey.set(options.idempotencyKey, refund);
            }
            return refund;
        });
        const completed = checkoutEvent('evt_credit_completed');
        const delayed = checkoutEvent('evt_credit_delayed');
        delayed.type = 'checkout.session.async_payment_succeeded';

        await Promise.all([
            harness.service.handleCheckoutSessionCompleted(completed),
            harness.service.handleCheckoutSessionCompleted(delayed),
        ]);

        expect(providerRefundCreations).toBe(1);
        expect(harness.stripe.refunds.create).toHaveBeenCalledOnce();
        expect(new Set(harness.stripe.refunds.create.mock.calls.map(([, options]) =>
            options.idempotencyKey))).toHaveLength(1);
        expect(harness.billingEvents.filter((event) =>
            event.metadata?.outcomeState === 'refund_confirmed')).toHaveLength(1);
        expectNoGrant(harness);
    });

    it('keeps completed/unpaid recoverable, then grants a later paid async event exactly once', async () => {
        const harness = buildHarness({ session: { payment_status: 'unpaid' } });

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_credit_unpaid'));

        expect(harness.billingEvents).toHaveLength(1);
        expect(harness.billingEvents[0]).toEqual(expect.objectContaining({
            stripeEventId: null,
            metadata: expect.objectContaining({
                outcomeState: 'recoverable',
                disposition: 'skipped_unpaid',
                checkoutSessionId: 'cs_credit_1',
            }),
        }));
        expect(harness.billingEvents.some((event) =>
            ['complete', 'refund_required', 'refund_confirmed'].includes(
                event.metadata?.outcomeState,
            ))).toBe(false);
        expectNoGrant(harness);
        expect(harness.stripe.refunds.create).not.toHaveBeenCalled();

        harness.session.payment_status = 'paid';
        const paid = checkoutEvent('evt_credit_async_paid');
        paid.type = 'checkout.session.async_payment_succeeded';
        await harness.service.handleCheckoutSessionCompleted(paid);
        await harness.service.handleCheckoutSessionCompleted(paid);

        expect(harness.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(harness.tx.tenant.update).toHaveBeenCalledOnce();
        expect(harness.stripe.refunds.create).not.toHaveBeenCalled();
        expect(harness.billingEvents.filter((event) =>
            event.metadata?.outcomeState === 'complete'
            && event.metadata?.disposition === 'applied')).toHaveLength(1);
    });

    it.each(['pending', 'requires_action'])(
        'persists a %s refund as recoverable and refuses safe acknowledgement until succeeded',
        async (status) => {
            const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
            harness.stripe.refunds.create.mockResolvedValue(refundFor(harness, status));

            await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
                .rejects.toThrow('refund is not terminal');

            expect(harness.billingEvents.some((event) =>
                event.metadata?.outcomeState === 'recoverable'
                && event.metadata?.refundStatus === status)).toBe(true);
            expect(harness.billingEvents.some((event) =>
                event.metadata?.outcomeState === 'refund_confirmed')).toBe(false);
            expectNoGrant(harness);

            harness.stripe.refunds.retrieve.mockResolvedValue(refundFor(harness, 'succeeded'));
            await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_retry')))
                .resolves.toBeUndefined();

            expect(harness.billingEvents.filter((event) =>
                event.metadata?.outcomeState === 'refund_confirmed')).toHaveLength(1);
            expectNoGrant(harness);
        },
    );

    it.each(['failed', 'canceled'])(
        'persists a %s refund, then creates one bounded deterministic retry without stranding funds',
        async (status) => {
            const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
            harness.stripe.refunds.create
                .mockResolvedValueOnce(refundFor(harness, status, `re_${status}`))
                .mockResolvedValueOnce(refundFor(harness, 'succeeded', `re_${status}_retry`));
            harness.stripe.refunds.retrieve.mockResolvedValue(
                refundFor(harness, status, `re_${status}`),
            );

            await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
                .rejects.toThrow('refund is not terminal');
            await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_retry')))
                .resolves.toBeUndefined();

            expect(harness.stripe.refunds.create).toHaveBeenCalledTimes(2);
            const keys = harness.stripe.refunds.create.mock.calls.map(([, options]) =>
                options.idempotencyKey);
            expect(keys[0]).not.toBe(keys[1]);
            expect(harness.stripe.refunds.create.mock.calls[1][0].amount).toBe(1200);
            expect(harness.billingEvents.filter((event) =>
                event.metadata?.outcomeState === 'refund_confirmed')).toHaveLength(1);
            expectNoGrant(harness);
        },
    );

    it('reconciles duplicated and out-of-order refund webhooks from authoritative refund state', async () => {
        const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
        harness.stripe.refunds.create.mockResolvedValue(refundFor(harness, 'pending'));
        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('refund is not terminal');

        harness.stripe.refunds.retrieve.mockResolvedValue(refundFor(harness, 'succeeded'));
        const succeeded = {
            id: 'evt_refund_succeeded',
            type: 'refund.updated',
            data: { object: refundFor(harness, 'succeeded') },
        } as any;
        await harness.service.handleRefundLifecycleEvent(succeeded);

        const staleFailure = {
            id: 'evt_refund_stale_failure',
            type: 'refund.failed',
            data: { object: refundFor(harness, 'failed') },
        } as any;
        await harness.service.handleRefundLifecycleEvent(staleFailure);
        await harness.service.handleRefundLifecycleEvent(succeeded);

        expect(harness.billingEvents.filter((event) =>
            event.metadata?.outcomeState === 'refund_confirmed')).toHaveLength(1);
        expect(harness.stripe.refunds.create).toHaveBeenCalledOnce();
        expectNoGrant(harness);
    });

    it('prefers an authoritative replacement-refund webhook over a stale stored failed refund', async () => {
        const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
        harness.stripe.refunds.create.mockResolvedValue(
            refundFor(harness, 'failed', 're_failed_stored'),
        );
        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('refund is not terminal');

        harness.stripe.refunds.retrieve.mockImplementation(async (refundId: string) => {
            if (refundId === 're_replacement_succeeded') {
                return refundFor(harness, 'succeeded', refundId);
            }
            return refundFor(harness, 'failed', refundId);
        });
        const replacement = {
            id: 'evt_refund_replacement_succeeded',
            type: 'refund.updated',
            data: { object: refundFor(harness, 'succeeded', 're_replacement_succeeded') },
        } as any;

        await harness.service.handleRefundLifecycleEvent(replacement);
        await harness.service.handleRefundLifecycleEvent(replacement);

        expect(harness.stripe.refunds.retrieve).toHaveBeenCalledTimes(1);
        expect(harness.stripe.refunds.retrieve).toHaveBeenCalledWith('re_replacement_succeeded');
        expect(harness.stripe.refunds.create).toHaveBeenCalledOnce();
        expect(harness.billingEvents.filter((event) =>
            event.metadata?.outcomeState === 'refund_confirmed')).toEqual([
            expect.objectContaining({
                metadata: expect.objectContaining({
                    refundId: 're_replacement_succeeded',
                    attempt: 1,
                }),
            }),
        ]);
        expectNoGrant(harness);
    });

    it('adopts and terminalizes a pending refund written by the previous handler', async () => {
        const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
        harness.billingEvents.push({
            id: 'legacy-billing-event',
            tenantId: 'tenant-1',
            type: 'checkout.session.completed',
            stripeEventId: 'evt_legacy_pending',
            createdAt: new Date('2026-07-15T00:00:00.000Z'),
            metadata: {
                source: 'stripe_credit_purchase',
                disposition: 'refunded_suspended',
                checkoutSessionId: 'cs_credit_1',
                refundId: 're_legacy_pending',
                refundStatus: 'pending',
            },
        });
        harness.stripe.refunds.retrieve.mockResolvedValue(
            refundFor(harness, 'succeeded', 're_legacy_pending'),
        );

        await harness.service.handleCheckoutSessionCompleted(checkoutEvent('evt_legacy_retry'));

        expect(harness.stripe.refunds.create).not.toHaveBeenCalled();
        expect(harness.billingEvents.filter((event) =>
            event.metadata?.outcomeState === 'refund_confirmed')).toHaveLength(1);
        expect(harness.billingEvents.some((event) =>
            event.metadata?.legacyRefundId === 're_legacy_pending')).toBe(true);
        expectNoGrant(harness);
    });

    it('rejects a partial or wrong-currency refund response and leaves only recoverable durable state', async () => {
        const harness = buildHarness({ tenant: { deletedAt: new Date() } });
        harness.stripe.refunds.create.mockResolvedValue(refundFor(harness, 'succeeded', 're_partial', {
            amount: 600,
            currency: 'eur',
        }));

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('refund could not be verified');

        expect(harness.billingEvents).toHaveLength(1);
        expect(harness.billingEvents[0].metadata.outcomeState).toBe('refund_required');
        expect(harness.billingEvents.some((event) =>
            event.metadata?.outcomeState === 'refund_confirmed')).toBe(false);
        expectNoGrant(harness);
    });

    it('bounds automatic failed-refund replacement while keeping the operator gate failed', async () => {
        const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
        harness.stripe.refunds.create.mockImplementation(async () =>
            refundFor(
                harness,
                'failed',
                `re_failed_${harness.stripe.refunds.create.mock.calls.length}`,
            ));
        harness.stripe.refunds.retrieve.mockImplementation(async (refundId: string) =>
            refundFor(harness, 'failed', refundId));

        for (let delivery = 0; delivery < 7; delivery += 1) {
            await expect(harness.service.handleCheckoutSessionCompleted(
                checkoutEvent(`evt_failed_${delivery}`),
            )).rejects.toThrow('refund is not terminal');
        }

        expect(harness.stripe.refunds.create).toHaveBeenCalledTimes(5);
        expect(harness.billingEvents.some((event) =>
            event.metadata?.outcomeState === 'refund_confirmed')).toBe(false);
        expectNoGrant(harness);
    });
});

describe('StripeCreditPurchaseService failure behavior', () => {
    it('ignores an event without a Checkout Session ID before Stripe or database work', async () => {
        const harness = buildHarness();

        await harness.service.handleCheckoutSessionCompleted({
            id: 'evt_missing_session',
            type: 'checkout.session.completed',
            data: { object: {} },
        } as any);

        expect(harness.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
        expect(harness.prisma.$transaction).not.toHaveBeenCalled();
        expectNoGrant(harness);
    });

    it('fails before tenant work when Stripe returns a different Session identity', async () => {
        const harness = buildHarness();
        harness.session.id = 'cs_different';

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(harness.prisma.$transaction).not.toHaveBeenCalled();
        expectNoGrant(harness);
    });

    it.each([
        ['Session retrieval', (h: ReturnType<typeof buildHarness>) => h.stripe.checkout.sessions.retrieve.mockRejectedValue(new Error('Stripe unavailable'))],
        ['line-item retrieval', (h: ReturnType<typeof buildHarness>) => h.stripe.checkout.sessions.listLineItems.mockRejectedValue(new Error('Stripe unavailable'))],
        ['subscription retrieval', (h: ReturnType<typeof buildHarness>) => h.stripe.subscriptions.retrieve.mockRejectedValue(new Error('Stripe unavailable'))],
    ])('propagates %s failure so Stripe can retry and does not grant', async (_label, fail) => {
        const harness = buildHarness();
        fail(harness);

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('Stripe unavailable');

        expectNoGrant(harness);
    });

    it('propagates billing-event persistence failure before creating the credit ledger entry', async () => {
        const harness = buildHarness();
        harness.tx.billingEvent.create.mockRejectedValue(new Error('database unavailable'));

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('database unavailable');

        expectNoGrant(harness);
    });

    it('surfaces a retryable refund failure without acknowledging or granting, then compensates on retry', async () => {
        const harness = buildHarness({ tenant: { status: TenantStatus.SUSPENDED } });
        harness.stripe.refunds.create
            .mockRejectedValueOnce(new Error('Stripe refund unavailable'))
            .mockResolvedValueOnce({
                id: 're_credit_retry',
                status: 'succeeded',
                amount: 1200,
                currency: 'usd',
                payment_intent: 'pi_credit_1',
                metadata: {
                    purchaseType: 'credit_pack',
                    tenantId: 'tenant-1',
                    checkoutSessionId: 'cs_credit_1',
                },
            });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('Stripe credit purchase refund request failed');
        expect(harness.billingEvents).toHaveLength(1);
        expect(harness.billingEvents[0].metadata.outcomeState).toBe('refund_required');
        expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain('Stripe refund unavailable');
        expectNoGrant(harness);

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .resolves.toBeUndefined();

        expect(harness.stripe.refunds.create).toHaveBeenCalledTimes(2);
        expect(harness.stripe.refunds.create.mock.calls[0][1].idempotencyKey)
            .toBe(harness.stripe.refunds.create.mock.calls[1][1].idempotencyKey);
        expect(harness.billingEvents.some((event) =>
            event.metadata?.outcomeState === 'refund_confirmed'
            && event.metadata?.refundId === 're_credit_retry')).toBe(true);
        expectNoGrant(harness);
    });

    it('fails closed when a paid purchase lacks an authoritative PaymentIntent for refund', async () => {
        const harness = buildHarness({
            tenant: { deletedAt: new Date() },
            session: { payment_intent: null },
        });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('payment identity is not authoritative');

        expect(harness.stripe.refunds.create).not.toHaveBeenCalled();
        expect(harness.billingEvents).toHaveLength(1);
        expect(harness.billingEvents[0].metadata.outcomeState).toBe('refund_required');
        expectNoGrant(harness);
    });

    it('fails the transaction before mutation when the tenant debt state is invalid', async () => {
        const harness = buildHarness({ tenant: { creditDebt: -1 } });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .rejects.toThrow('invalid debt balance');

        expect(harness.tx.tenant.update).not.toHaveBeenCalled();
        expect(harness.tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(harness.logger.log).not.toHaveBeenCalledWith(expect.stringContaining('granted'));
    });

    it('fulfills from the immutable Checkout snapshot after configured Price rotation', async () => {
        const harness = buildHarness({
            config: { STRIPE_PRICE_CREDIT_PACK_100: 'price_credit_100_rotated' },
        });

        await expect(harness.service.handleCheckoutSessionCompleted(checkoutEvent()))
            .resolves.toEqual({
                transactionId: 'stripe-credit-purchase-cs_credit_1',
                newBalance: 100,
                replayed: false,
            });

        expect(harness.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(harness.stripe.prices.retrieve).not.toHaveBeenCalledWith('price_credit_100_rotated');
    });

    it('fails Checkout when Stripe omits the hosted URL rather than returning a partial response', async () => {
        const harness = buildHarness();
        harness.stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_without_url', url: null });

        await expect(harness.service.createCheckoutSession(
            'tenant-1',
            'CREDITS_100',
            'https://app.example.test',
        )).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});
