import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TenantStatus } from '@lunchlineup/db';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    type PreparedTenantCancellationIntent,
    TenantCancellationLifecycleService,
    type TenantCancellationOutcome,
} from '../admin/tenant-cancellation-lifecycle.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { StripeService } from './stripe.service';

const originalNodeEnv = process.env.NODE_ENV;
const purgeOperationId = 'tenant-deletion-audit-1';

function buildPurgeOptions(operationId = purgeOperationId) {
    return {
        operationId,
        signal: new AbortController().signal,
        providerDeadlineAtMs: Date.now() + 60_000,
    };
}

function expectedPurgeIdempotencyKey(mutation: string, resourceId: string): string {
    return createHash('sha256')
        .update(`tenant-deletion-${mutation}:${resourceId}:${purgeOperationId}`)
        .digest('hex');
}

function buildConfig(values: Record<string, string | undefined> = {}) {
    const defaults = {
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
        STRIPE_PRICE_STARTER: 'price_123',
        STRIPE_PRICE_CREDIT_PACK_100: 'price_credit_100',
    };

    return {
        get: vi.fn((key: string) => ({ ...defaults, ...values })[key]),
    };
}

function buildPrismaMock() {
    const tenantFindUnique = vi.fn().mockResolvedValue({
        id: 'tenant-1',
        status: TenantStatus.ACTIVE,
        deletedAt: null,
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
    });
    const tenantFindFirst = vi.fn();
    const tenantFindMany = vi.fn((args: any) => {
        if (args.where?.stripeSubscriptionId === 'sub_123' || args.where?.stripeCustomerId === 'cus_123') {
            return Promise.resolve([{ id: 'tenant-1' }]);
        }
        return Promise.resolve([]);
    });
    const tenantUpdate = vi.fn();
    const tenantUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([{
            set_current_tenant: null,
            acquired: true,
        }]),
        billingEvent: {
            create: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
        },
        creditTransaction: {
            create: vi.fn().mockResolvedValue({}),
        },
        tenant: {
            findUnique: tenantFindUnique,
            findFirst: tenantFindFirst,
            findMany: tenantFindMany,
            update: tenantUpdate,
            updateMany: tenantUpdateMany,
        },
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
        user: {
            count: vi.fn().mockResolvedValue(0),
        },
        location: {
            count: vi.fn().mockResolvedValue(0),
        },
        planDefinition: {
            findUnique: vi.fn().mockResolvedValue({
                code: 'STARTER',
                name: 'Starter',
                active: true,
                monthlyPriceCents: 2900,
                locationLimit: 3,
                userLimit: 25,
                creditQuotaLimit: 100,
                metadata: null,
            }),
        },
    };

    return {
        tx,
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([{
            set_current_tenant: null,
            acquired: true,
        }]),
        tenant: {
            findUnique: tenantFindUnique,
            findFirst: tenantFindFirst,
            findMany: tenantFindMany,
            update: tenantUpdate,
            updateMany: tenantUpdateMany,
        },
        $transaction: vi.fn(async (fn: any) => fn(tx)),
    };
}

function buildService(options: {
    configValues?: Record<string, string | undefined>;
    prisma?: ReturnType<typeof buildPrismaMock>;
    event?: any;
    constructEvent?: ReturnType<typeof vi.fn>;
} = {}) {
    const config = buildConfig(options.configValues);
    const prisma = options.prisma ?? buildPrismaMock();
    const service = new StripeService(config as any, new TenantPrismaService(prisma as any));
    const constructEvent = options.constructEvent ?? vi.fn().mockReturnValue(options.event);
    const stripe = {
        customers: {
            create: vi.fn(),
            del: vi.fn().mockResolvedValue({
                id: 'cus_123',
                deleted: true,
            }),
            retrieve: vi.fn().mockResolvedValue({
                id: 'cus_123',
                deleted: false,
                metadata: { tenantId: 'tenant-1' },
            }),
        },
        checkout: {
            sessions: {
                create: vi.fn(),
                list: vi.fn().mockResolvedValue({ data: [] }),
                expire: vi.fn().mockResolvedValue({ status: 'expired' }),
                listLineItems: vi.fn().mockResolvedValue({
                    data: [{
                        id: 'li_credit_100',
                        price: { id: 'price_credit_100' },
                        quantity: 1,
                        amount_subtotal: 1200,
                        amount_total: 1200,
                        currency: 'usd',
                    }],
                    has_more: false,
                }),
                retrieve: vi.fn(),
            },
        },
        prices: {
            retrieve: vi.fn().mockImplementation(async (priceId: string) => ({
                id: priceId,
                active: true,
                type: 'one_time',
                unit_amount: priceId === 'price_credit_100' ? 1200 : 5000,
                currency: 'usd',
            })),
        },
        billingPortal: {
            configurations: {
                create: vi.fn().mockResolvedValue({
                    id: 'bpc_safe',
                    active: true,
                    features: { subscription_update: { enabled: false } },
                    metadata: { lunchlineupPolicy: 'server_controlled_plan_changes_v1' },
                }),
                list: vi.fn().mockResolvedValue({ data: [] }),
                retrieve: vi.fn().mockResolvedValue({
                    id: 'bpc_safe',
                    active: true,
                    features: { subscription_update: { enabled: false } },
                }),
            },
            sessions: {
                create: vi.fn(),
            },
        },
        subscriptions: {
            cancel: vi.fn(),
            create: vi.fn(),
            list: vi.fn().mockResolvedValue({ data: [] }),
            resume: vi.fn(),
            update: vi.fn(),
            retrieve: vi.fn().mockImplementation(async (subscriptionId: string) => {
                const eventObject = options.event?.data?.object;
                if (eventObject?.object === 'subscription' && eventObject.id === subscriptionId) {
                    return eventObject;
                }
                return {
                    id: 'sub_123',
                    status: 'active',
                    customer: 'cus_123',
                    items: {
                        data: [
                            { id: 'si_123', price: { id: 'price_123' } },
                        ],
                    },
                    metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
                };
            }),
        },
        invoices: {
            retrieve: vi.fn(),
        },
        webhooks: {
            constructEvent,
        },
    };

    (service as any).stripe = stripe;
    (service as any).logger = {
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    return { service, prisma, stripe, config };
}

describe('StripeService - subscription creation', () => {
    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it('returns the configured Stripe price catalog with unconfigured plans marked unavailable', () => {
        const { service } = buildService({
            configValues: {
                STRIPE_PRICE_STARTER: ' price_starter ',
                STRIPE_PRICE_GROWTH: 'price_growth',
            },
        });

        expect(service.getPriceOptions()).toEqual([
            { code: 'STARTER', label: 'Starter', priceId: 'price_starter', configured: true },
            { code: 'GROWTH', label: 'Growth', priceId: 'price_growth', configured: true },
            { code: 'ENTERPRISE', label: 'Enterprise', priceId: null, configured: false },
        ]);
    });

    it('fails startup outside development when Stripe is not configured', () => {
        process.env.NODE_ENV = 'production';

        expect(() => buildService({ configValues: { STRIPE_SECRET_KEY: undefined } })).toThrow('STRIPE_SECRET_KEY');
    });

    it('returns service-unavailable for local billing calls without Stripe config', async () => {
        process.env.NODE_ENV = 'development';
        const service = new StripeService(
            buildConfig({ STRIPE_SECRET_KEY: undefined }) as any,
            new TenantPrismaService(buildPrismaMock() as any),
        );

        await expect(service.createCustomer('tenant-1', 'owner@example.com', 'Owner'))
            .rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('creates a hosted Checkout Session for subscription signup without activating the tenant', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_existing' });
        const { service, stripe } = buildService({
            prisma,
            configValues: {
                APP_ORIGIN: 'https://app.example.com',
                STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_safe',
            },
        });
        stripe.checkout.sessions.create.mockResolvedValue({
            id: 'cs_test_123',
            url: 'https://checkout.stripe.com/cs_test_123',
        });

        const session = await service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com', name: 'Owner Example' },
            'price_123',
        );

        expect(session).toEqual({
            sessionId: 'cs_test_123',
            checkoutUrl: 'https://checkout.stripe.com/cs_test_123',
        });
        expect(stripe.customers.create).not.toHaveBeenCalled();
        expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
            mode: 'subscription',
            customer: 'cus_existing',
            line_items: [{ price: 'price_123' }],
            success_url: 'https://app.example.com/dashboard/settings?billing=success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'https://app.example.com/dashboard/settings?billing=cancelled',
            client_reference_id: 'tenant-1',
            metadata: { tenantId: 'tenant-1', planCode: 'STARTER', priceId: 'price_123' },
            subscription_data: { metadata: { tenantId: 'tenant-1', planCode: 'STARTER', priceId: 'price_123' } },
            allow_promotion_codes: true,
        }, {
            idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('rejects checkout when the mapped database plan is inactive', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.planDefinition.findUnique.mockResolvedValue({ code: 'STARTER', active: false });
        const { service, stripe } = buildService({ prisma });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com', name: 'Owner Example' },
            'price_123',
        )).rejects.toThrow('Selected subscription plan is not available.');

        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('creates and stores a Stripe customer before opening Checkout when the tenant has none', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', stripeCustomerId: null });
        const { service, stripe } = buildService({
            prisma,
            configValues: { APP_ORIGIN: 'https://app.example.com' },
        });
        stripe.customers.create.mockResolvedValue({ id: 'cus_new' });
        stripe.checkout.sessions.create.mockResolvedValue({
            id: 'cs_test_456',
            url: 'https://checkout.stripe.com/cs_test_456',
        });

        await service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com', name: 'Owner Example' },
            'price_123',
        );

        expect(stripe.customers.create).toHaveBeenCalledWith({
            email: 'owner@example.com',
            name: 'Owner Example',
            metadata: { tenantId: 'tenant-1' },
        }, {
            idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledWith({
            where: { id: 'tenant-1', stripeCustomerId: null },
            data: { stripeCustomerId: 'cus_new' },
        });
        expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
            customer: 'cus_new',
        }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
    });

    it('reuses an open Checkout Session for the same tenant and plan', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            stripeCustomerId: 'cus_existing',
            stripeSubscriptionId: null,
            stripeSubscriptionCurrentPeriodEnd: null,
        });
        const { service, stripe } = buildService({
            prisma,
            configValues: { APP_ORIGIN: 'https://app.example.com' },
        });
        stripe.checkout.sessions.list.mockResolvedValue({
            data: [{
                id: 'cs_open',
                url: 'https://checkout.stripe.com/cs_open',
                metadata: { tenantId: 'tenant-1', planCode: 'STARTER', priceId: 'price_123' },
            }],
        });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com' },
            'price_123',
        )).resolves.toEqual({
            sessionId: 'cs_open',
            checkoutUrl: 'https://checkout.stripe.com/cs_open',
        });

        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('expires an open Checkout Session for another plan before creating the selected plan', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            stripeCustomerId: 'cus_existing',
            stripeSubscriptionId: null,
        });
        const { service, stripe } = buildService({
            prisma,
            configValues: {
                APP_ORIGIN: 'https://app.example.com',
                STRIPE_PRICE_GROWTH: 'price_growth',
            },
        });
        stripe.checkout.sessions.list.mockResolvedValue({
            data: [{
                id: 'cs_starter_open',
                url: 'https://checkout.stripe.com/cs_starter_open',
                metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
            }],
        });
        stripe.checkout.sessions.create.mockResolvedValue({
            id: 'cs_growth_open',
            url: 'https://checkout.stripe.com/cs_growth_open',
        });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com' },
            'price_growth',
        )).resolves.toEqual({
            sessionId: 'cs_growth_open',
            checkoutUrl: 'https://checkout.stripe.com/cs_growth_open',
        });

        expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_starter_open');
        expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
            expect.objectContaining({
                    line_items: [{ price: 'price_growth' }],
                metadata: expect.objectContaining({ priceId: 'price_growth', planCode: 'GROWTH' }),
            }),
            expect.objectContaining({ idempotencyKey: expect.any(String) }),
        );
        const billingLockIndex = prisma.tx.$executeRaw.mock.calls.findIndex(([query, lockKey]: any[]) => {
            const sql = Array.isArray(query) ? query.join(' ') : String(query);
            return sql.includes('SELECT pg_advisory_xact_lock')
                && lockKey === 'billing-checkout:tenant-1';
        });
        expect(billingLockIndex).toBeGreaterThanOrEqual(0);
        expect(prisma.tx.$executeRaw.mock.invocationCallOrder[billingLockIndex])
            .toBeLessThan(stripe.checkout.sessions.list.mock.invocationCallOrder[0]);
    });

    it('serializes concurrent cross-plan Checkout and first-customer creation', async () => {
        const prisma = buildPrismaMock();
        let stripeCustomerId: string | null = null;
        let openSession: any = null;
        let lockTail = Promise.resolve();

        prisma.tx.tenant.findUnique.mockImplementation(async () => ({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            stripeCustomerId,
            stripeSubscriptionId: null,
        }));
        prisma.tx.tenant.updateMany.mockImplementation(async () => {
            stripeCustomerId = 'cus_once';
            return { count: 1 };
        });
        prisma.$transaction.mockImplementation(async (operation: any) => {
            const previousLock = lockTail;
            let releaseLock!: () => void;
            lockTail = new Promise<void>((resolve) => {
                releaseLock = resolve;
            });
            const tx = {
                ...prisma.tx,
                $executeRaw: vi.fn(async (query: unknown, ...values: unknown[]) => {
                    const sql = Array.isArray(query) ? query.join(' ') : String(query);
                    if (
                        sql.includes('SELECT pg_advisory_xact_lock')
                        && values.includes('billing-checkout:tenant-1')
                    ) {
                        await previousLock;
                    }
                    return 1;
                }),
                $queryRaw: vi.fn().mockResolvedValue([]),
            };

            try {
                return await operation(tx);
            } finally {
                releaseLock();
            }
        });

        const { service, stripe } = buildService({
            prisma,
            configValues: {
                APP_ORIGIN: 'https://app.example.com',
                STRIPE_PRICE_GROWTH: 'price_growth',
            },
        });
        stripe.customers.create.mockResolvedValue({ id: 'cus_once' });
        stripe.checkout.sessions.list.mockImplementation(async () => ({
            data: openSession ? [openSession] : [],
        }));
        stripe.checkout.sessions.create.mockImplementation(async (input: any) => {
            openSession = {
                id: `cs_${input.metadata.planCode.toLowerCase()}`,
                url: `https://checkout.stripe.com/cs_${input.metadata.planCode.toLowerCase()}`,
                metadata: input.metadata,
            };
            return openSession;
        });
        stripe.checkout.sessions.expire.mockImplementation(async (sessionId: string) => {
            if (openSession?.id === sessionId) openSession = null;
            return { id: sessionId, status: 'expired' };
        });

        const [starter, growth] = await Promise.all([
            service.createSubscriptionCheckoutSession('tenant-1', { email: 'owner@example.com' }, 'price_123'),
            service.createSubscriptionCheckoutSession('tenant-1', { email: 'owner@example.com' }, 'price_growth'),
        ]);

        expect(starter.checkoutUrl).toContain('starter');
        expect(growth.checkoutUrl).toContain('growth');
        expect(stripe.customers.create).toHaveBeenCalledOnce();
        expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
        expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith(starter.sessionId);
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledOnce();
    });

    it('creates a fresh correct-price session when a customer switches A to B to A in one minute', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            deletedAt: null,
            stripeCustomerId: 'cus_existing',
            stripeSubscriptionId: null,
        });
        const { service, stripe } = buildService({
            prisma,
            configValues: {
                APP_ORIGIN: 'https://app.example.com',
                STRIPE_PRICE_GROWTH: 'price_growth',
            },
        });
        let openSession: any = null;
        let sequence = 0;
        stripe.checkout.sessions.list.mockImplementation(async () => ({
            data: openSession ? [openSession] : [],
        }));
        stripe.checkout.sessions.create.mockImplementation(async (input: any) => {
            sequence += 1;
            openSession = {
                id: `cs_${sequence}`,
                url: `https://checkout.stripe.com/cs_${sequence}`,
                metadata: input.metadata,
            };
            return openSession;
        });
        stripe.checkout.sessions.expire.mockImplementation(async (sessionId: string) => {
            if (openSession?.id === sessionId) openSession = null;
            return { id: sessionId, status: 'expired' };
        });

        const firstStarter = await service.createSubscriptionCheckoutSession('tenant-1', {}, 'price_123');
        await service.createSubscriptionCheckoutSession('tenant-1', {}, 'price_growth');
        const secondStarter = await service.createSubscriptionCheckoutSession('tenant-1', {}, 'price_123');

        expect(secondStarter.sessionId).not.toBe(firstStarter.sessionId);
        expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(3);
        expect(stripe.checkout.sessions.create.mock.calls[2][0].line_items)
              .toEqual([{ price: 'price_123' }]);
        expect(stripe.checkout.sessions.create.mock.calls[2][1].idempotencyKey)
            .not.toBe(stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey);
    });

    it('opens the Stripe billing portal for an existing paid subscription', async () => {
        const prisma = buildPrismaMock();
        const { service, stripe } = buildService({
            prisma,
            configValues: { APP_ORIGIN: 'https://app.example.com' },
        });
        stripe.billingPortal.sessions.create.mockResolvedValue({
            url: 'https://billing.stripe.com/p/session_123',
        });

        await expect(service.createBillingPortalSession('tenant-1')).resolves.toEqual({
            portalUrl: 'https://billing.stripe.com/p/session_123',
        });
        expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
            configuration: 'bpc_safe',
            customer: 'cus_123',
            return_url: 'https://app.example.com/dashboard/settings?billing=portal-return',
        });
    });

    it('refuses a portal configuration that allows unmanaged plan changes', async () => {
        const { service, stripe } = buildService({
            configValues: {
                APP_ORIGIN: 'https://app.example.com',
                STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_unsafe',
            },
        });
        stripe.billingPortal.configurations.retrieve.mockResolvedValue({
            id: 'bpc_unsafe',
            active: true,
            features: { subscription_update: { enabled: true } },
        });

        await expect(service.createBillingPortalSession('tenant-1'))
            .rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    });

    it('changes plans only through the capacity-checked server path', async () => {
        const { service, stripe } = buildService({
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });
        stripe.subscriptions.update.mockResolvedValue({ id: 'sub_123', status: 'active' });

        await expect(service.changeTenantSubscriptionPlan('tenant-1', 'price_growth')).resolves.toEqual({
            action: 'updated',
            stripeSubscriptionId: 'sub_123',
            stripeStatus: 'active',
            planTier: 'GROWTH',
        });
        expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
            items: [{ id: 'si_123', price: 'price_growth' }],
            payment_behavior: 'pending_if_incomplete',
            proration_behavior: 'create_prorations',
        });
    });

    it('rejects an inactive target plan before reading or mutating Stripe', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.planDefinition.findUnique.mockImplementation(async ({ where }: any) => ({
            code: where.code,
            name: 'Unavailable plan',
            active: false,
            monthlyPriceCents: 0,
            locationLimit: null,
            userLimit: null,
            creditQuotaLimit: null,
            metadata: null,
        }));
        const { service, stripe } = buildService({
            prisma,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });

        await expect(service.changeTenantSubscriptionPlan('tenant-1', 'price_growth'))
            .rejects.toThrow('Selected subscription plan is not available');
        expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('rejects an over-capacity downgrade before mutating Stripe', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.user.count.mockResolvedValue(51);
        const { service, stripe } = buildService({
            prisma,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });

        await expect(service.changeTenantSubscriptionPlan('tenant-1', 'price_123'))
            .rejects.toThrow('exceeds');
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('rejects a location over-capacity downgrade before mutating Stripe', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.location.count.mockResolvedValue(6);
        const { service, stripe } = buildService({
            prisma,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_growth' } }] },
            metadata: { tenantId: 'tenant-1', planCode: 'GROWTH' },
        });

        await expect(service.changeTenantSubscriptionPlan('tenant-1', 'price_123'))
            .rejects.toThrow('6 active locations');
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('resumes a paused subscription through the capacity-checked server path', async () => {
        const { service, stripe, prisma } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'paused',
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
        });
        stripe.subscriptions.resume.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
            latest_invoice: null,
        });

        await expect(service.resumeTenantSubscription('tenant-1')).resolves.toEqual({
            action: 'resumed',
            stripeSubscriptionId: 'sub_123',
            stripeStatus: 'active',
            paymentUrl: null,
            paymentFlow: null,
        });
        expect(stripe.subscriptions.resume).toHaveBeenCalledWith('sub_123', {
            billing_cycle_anchor: 'now',
            proration_behavior: 'none',
            expand: ['latest_invoice'],
        });
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('returns the hosted resumption invoice when Stripe still requires payment', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'paused',
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
        });
        stripe.subscriptions.resume.mockResolvedValue({
            id: 'sub_123',
            status: 'paused',
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
            latest_invoice: {
                id: 'in_resume',
                hosted_invoice_url: 'https://invoice.stripe.com/i/in_resume',
            },
        });

        await expect(service.resumeTenantSubscription('tenant-1')).resolves.toEqual({
            action: 'payment_required',
            stripeSubscriptionId: 'sub_123',
            stripeStatus: 'paused',
            paymentUrl: 'https://invoice.stripe.com/i/in_resume',
            paymentFlow: 'hosted_invoice',
        });
        expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    });

    it('exposes resume only for a currently paused Stripe subscription', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'paused',
            customer: 'cus_123',
            metadata: { tenantId: 'tenant-1' },
        });

        await expect(service.getTenantSubscriptionRecoveryAction('tenant-1')).resolves.toBe('resume');

        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'past_due',
            customer: 'cus_123',
            metadata: { tenantId: 'tenant-1' },
        });
        await expect(service.getTenantSubscriptionRecoveryAction('tenant-1')).resolves.toBe('portal');
    });

    it('blocks Checkout when the tenant already owns a subscription', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.ACTIVE,
            stripeCustomerId: 'cus_existing',
            stripeSubscriptionId: 'sub_existing',
        });
        const { service, stripe } = buildService({ prisma });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com' },
            'price_123',
        )).rejects.toThrow('billing portal');

        expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('blocks Checkout when Stripe has a subscription that local webhook state has not stored yet', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            stripeCustomerId: 'cus_existing',
            stripeSubscriptionId: null,
        });
        const { service, stripe } = buildService({ prisma });
        stripe.subscriptions.list.mockResolvedValue({
            data: [{ id: 'sub_pending_webhook', status: 'active' }],
        });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com' },
            'price_123',
        )).rejects.toThrow('billing portal');

        expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('blocks an over-capacity plan before creating a Checkout Session', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            stripeCustomerId: 'cus_existing',
            stripeSubscriptionId: null,
        });
        prisma.tx.user.count.mockResolvedValue(51);
        const { service, stripe } = buildService({ prisma });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com' },
            'price_123',
        )).rejects.toThrow('exceeds');

        expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('fails closed in production when no billing return origin is configured', async () => {
        process.env.NODE_ENV = 'production';
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_existing' });
        const { service, stripe } = buildService({
            prisma,
            configValues: {
                APP_ORIGIN: undefined,
                PUBLIC_APP_URL: undefined,
                FRONTEND_URL: undefined,
                NEXT_PUBLIC_APP_ORIGIN: undefined,
                NEXT_PUBLIC_APP_URL: undefined,
                DOMAIN: undefined,
            },
        });

        await expect(service.createSubscriptionCheckoutSession(
            'tenant-1',
            { email: 'owner@example.com', name: 'Owner Example' },
            'price_123',
        )).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(stripe.customers.create).not.toHaveBeenCalled();
        expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('records the Stripe subscription without activating the tenant before payment confirmation', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', usageCredits: 0 });
        const { service, stripe } = buildService({ prisma });
        stripe.subscriptions.create.mockResolvedValue({ id: 'sub_123' });

        const subscription = await service.createSubscription('tenant-1', 'cus_123', 'price_123');

        expect(subscription.id).toBe('sub_123');
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
        expect(prisma.tx.tenant.update.mock.calls[0][0].data).not.toHaveProperty('status');
    });

    it('rejects subscription prices outside the configured Stripe catalog', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', usageCredits: 0 });
        const { service, stripe } = buildService({ prisma });

        await expect(service.createSubscription('tenant-1', 'cus_123', 'price_internal'))
            .rejects.toBeInstanceOf(BadRequestException);

        expect(stripe.subscriptions.create).not.toHaveBeenCalled();
    });

    it('schedules tenant subscription cancellation at the current period end', async () => {
        const { service, stripe, prisma } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1800000000,
        });
        stripe.subscriptions.update.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            current_period_end: 1800000000,
        });

        const result = await service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'operation-123',
        );

        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
        expect(stripe.subscriptions.update).toHaveBeenCalledWith(
            'sub_123',
            {
                cancel_at_period_end: true,
                metadata: {
                    lunchlineupCancellationOperationId: 'operation-123',
                },
            },
            { idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) },
        );
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'tenant-1',
                stripeSubscriptionId: 'sub_123',
            },
            data: {
                stripeSubscriptionCurrentPeriodEnd:
                    new Date('2027-01-15T08:00:00.000Z'),
            },
        });
        expect(result).toEqual({
            action: 'scheduled',
            stripeSubscriptionId: 'sub_123',
            stripeStatus: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: '2027-01-15T08:00:00.000Z',
            cancelAt: null,
            canceledAt: null,
            cancellationBehavior: 'cancel_at_period_end',
            providerMutationOwned: true,
        });
    });

    it('recovers operation ownership from provider metadata after post-provider persistence loss', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'operation-123',
            },
        });

        const result = await service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'operation-123',
        );

        expect(result).toMatchObject({
            action: 'already_scheduled',
            providerMutationOwned: true,
        });
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('makes a later explicit customer cancellation authoritative over a platform marker', async () => {
        const { service, stripe } = buildService();
        let providerSubscription = {
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            current_period_end: 1_800_000_000,
            metadata: {
                lunchlineupCancellationOperationId: 'platform-operation-a',
            },
        };
        stripe.subscriptions.retrieve.mockImplementation(async () => ({
            ...providerSubscription,
            metadata: { ...providerSubscription.metadata },
        }));
        stripe.subscriptions.update.mockImplementation(async (
            _subscriptionId: string,
            update: {
                cancel_at_period_end: boolean;
                metadata?: Record<string, string>;
            },
        ) => {
            providerSubscription = {
                ...providerSubscription,
                cancel_at_period_end: update.cancel_at_period_end,
                metadata: {
                    ...providerSubscription.metadata,
                    ...update.metadata,
                },
            };
            return {
                ...providerSubscription,
                metadata: { ...providerSubscription.metadata },
            };
        });

        const customer = await service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'customer-operation-b',
            { authoritativeCustomerCancellation: true },
        );
        const replay = await service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'customer-operation-b',
            { authoritativeCustomerCancellation: true },
        );
        const stalePlatformCompensation =
            await service.compensateTenantSubscriptionCancellation(
                'tenant-1',
                'sub_123',
                'platform-operation-a',
            );

        expect(customer).toMatchObject({
            action: 'already_scheduled',
            cancelAtPeriodEnd: true,
            providerMutationOwned: true,
        });
        expect(replay).toMatchObject({
            action: 'already_scheduled',
            cancelAtPeriodEnd: true,
            providerMutationOwned: true,
        });
        expect(stalePlatformCompensation).toEqual({
            action: 'not_owned',
            cancelAtPeriodEnd: true,
        });
        expect(stripe.subscriptions.update).toHaveBeenCalledOnce();
        expect(stripe.subscriptions.update).toHaveBeenCalledWith(
            'sub_123',
            {
                cancel_at_period_end: true,
                metadata: {
                    lunchlineupCancellationOperationId: 'customer-operation-b',
                },
            },
            {
                idempotencyKey: createHash('sha256')
                    .update('tenant-cancellation:customer-operation-b')
                    .digest('hex'),
            },
        );
        expect(providerSubscription).toMatchObject({
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'customer-operation-b',
            },
        });
    });

    it('repairs a stale platform compensation that races customer marker adoption and response-loss retry', async () => {
        const prisma = buildPrismaMock();
        const customerIntent = {
            kind: 'CUSTOMER_CANCELLATION',
            state: 'PENDING_PROVIDER',
            operationId: 'customer-operation-b',
            providerSubscriptionId: 'sub_123',
        };
        prisma.tx.tenantSetting.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValue({ value: customerIntent });
        const { service, stripe } = buildService({ prisma });
        let providerSubscription = {
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'platform-operation-a',
            },
        };
        let releaseStaleCompensation!: () => void;
        let markStaleCompensationEntered!: () => void;
        const staleCompensationRelease = new Promise<void>((resolve) => {
            releaseStaleCompensation = resolve;
        });
        const staleCompensationEntered = new Promise<void>((resolve) => {
            markStaleCompensationEntered = resolve;
        });
        let loseCustomerResponse = true;
        const providerUpdates: Array<{
            cancelAtPeriodEnd: boolean;
            idempotencyKey: string;
            marker: string | undefined;
        }> = [];
        stripe.subscriptions.retrieve.mockImplementation(async () => ({
            ...providerSubscription,
            metadata: { ...providerSubscription.metadata },
        }));
        stripe.subscriptions.update.mockImplementation(async (
            _subscriptionId: string,
            update: {
                cancel_at_period_end: boolean;
                metadata?: Record<string, string>;
            },
            options: { idempotencyKey: string },
        ) => {
            providerUpdates.push({
                cancelAtPeriodEnd: update.cancel_at_period_end,
                idempotencyKey: options.idempotencyKey,
                marker: update.metadata?.lunchlineupCancellationOperationId,
            });
            if (update.cancel_at_period_end === false) {
                markStaleCompensationEntered();
                await staleCompensationRelease;
            }
            providerSubscription = {
                ...providerSubscription,
                cancel_at_period_end: update.cancel_at_period_end,
                metadata: {
                    ...providerSubscription.metadata,
                    ...update.metadata,
                },
            };
            if (
                update.metadata?.lunchlineupCancellationOperationId
                    === 'customer-operation-b'
                && loseCustomerResponse
            ) {
                loseCustomerResponse = false;
                throw new Error('injected customer response loss');
            }
            return {
                ...providerSubscription,
                metadata: { ...providerSubscription.metadata },
            };
        });

        const staleCompensation = service.compensateTenantSubscriptionCancellation(
            'tenant-1',
            'sub_123',
            'platform-operation-a',
        );
        await staleCompensationEntered;
        await expect(service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'customer-operation-b',
            { authoritativeCustomerCancellation: true },
        )).rejects.toThrow('injected customer response loss');
        await expect(service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'customer-operation-b',
            { authoritativeCustomerCancellation: true },
        )).resolves.toMatchObject({
            action: 'already_scheduled',
            providerMutationOwned: true,
        });
        releaseStaleCompensation();

        await expect(staleCompensation).resolves.toEqual({
            action: 'not_owned',
            cancelAtPeriodEnd: true,
        });
        expect(providerSubscription).toMatchObject({
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'customer-operation-b',
            },
        });
        expect(providerUpdates.map((update) => ({
            cancelAtPeriodEnd: update.cancelAtPeriodEnd,
            marker: update.marker,
        }))).toEqual([
            { cancelAtPeriodEnd: false, marker: '' },
            { cancelAtPeriodEnd: true, marker: 'customer-operation-b' },
            { cancelAtPeriodEnd: true, marker: 'customer-operation-b' },
        ]);
        expect(new Set(
            providerUpdates.map(({ idempotencyKey }) => idempotencyKey),
        ).size).toBe(3);
    });

    it('fences stale compensation while customer provider success is pending local persistence', async () => {
        const prisma = buildPrismaMock();
        let customerPrepared: PreparedTenantCancellationIntent = {
            tenant: {
                id: 'tenant-1',
                slug: 'acme-dining',
                status: TenantStatus.ACTIVE,
                deletedAt: null,
                retentionLegalHoldAt: null,
                stripeSubscriptionId: 'sub_123',
            },
            intent: {
                tenantId: 'tenant-1',
                kind: 'CUSTOMER_CANCELLATION',
                operationId: 'customer-operation-b',
                state: 'PENDING_PROVIDER',
                actorUserId: 'user-1',
                actorTenantId: 'tenant-1',
                ipAddress: null,
                userAgent: null,
                reason: null,
                providerSubscriptionId: 'sub_123',
                subscriptionFingerprint: 'fingerprint-b',
                providerLeaseOwner: 'customer-owner-b',
                providerLeaseExpiresAt: new Date(Date.now() + 60_000),
                providerAttempts: 1,
                providerMutationOwned: null,
                providerResult: null,
                compensationResult: null,
                terminalReason: null,
                terminalizedAt: null,
            },
            providerLeaseOwner: 'customer-owner-b',
        };
        prisma.tx.tenantSetting.findUnique
            .mockResolvedValueOnce(null)
            .mockImplementation(async () => ({
                value: {
                    ...customerPrepared.intent,
                    providerLeaseExpiresAt:
                        customerPrepared.intent.providerLeaseExpiresAt?.toISOString() ?? null,
                },
            }));
        const { service, stripe } = buildService({ prisma });
        let providerSubscription = {
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            current_period_end: 1_800_000_000,
            metadata: {
                lunchlineupCancellationOperationId: 'platform-operation-a',
            },
        };
        let markStaleCompensationEntered!: () => void;
        let releaseStaleCompensation!: () => void;
        const staleCompensationEntered = new Promise<void>((resolve) => {
            markStaleCompensationEntered = resolve;
        });
        const staleCompensationRelease = new Promise<void>((resolve) => {
            releaseStaleCompensation = resolve;
        });
        let markCustomerPersistenceEntered!: () => void;
        let releaseCustomerPersistence!: () => void;
        const customerPersistenceEntered = new Promise<void>((resolve) => {
            markCustomerPersistenceEntered = resolve;
        });
        const customerPersistenceRelease = new Promise<void>((resolve) => {
            releaseCustomerPersistence = resolve;
        });
        stripe.subscriptions.retrieve.mockImplementation(async () => ({
            ...providerSubscription,
            metadata: { ...providerSubscription.metadata },
        }));
        stripe.subscriptions.update.mockImplementation(async (
            _subscriptionId: string,
            update: {
                cancel_at_period_end: boolean;
                metadata?: Record<string, string>;
            },
        ) => {
            if (update.cancel_at_period_end === false) {
                markStaleCompensationEntered();
                await staleCompensationRelease;
            }
            providerSubscription = {
                ...providerSubscription,
                cancel_at_period_end: update.cancel_at_period_end,
                metadata: {
                    ...providerSubscription.metadata,
                    ...update.metadata,
                },
            };
            return {
                ...providerSubscription,
                metadata: { ...providerSubscription.metadata },
            };
        });
        const customerStore = {
            prepare: vi.fn(async () => customerPrepared),
            renewProviderClaim: vi.fn(async () => customerPrepared),
            providerLeaseRenewalIntervalMs: () => 60_000,
            markProviderApplied: vi.fn(async (
                prepared: typeof customerPrepared,
                outcome: TenantCancellationOutcome,
                providerMutationOwned: boolean,
            ) => {
                markCustomerPersistenceEntered();
                await customerPersistenceRelease;
                customerPrepared = {
                    ...prepared,
                    intent: {
                        ...prepared.intent,
                        state: 'PROVIDER_APPLIED',
                        providerMutationOwned,
                        providerResult: outcome,
                    },
                };
                return customerPrepared;
            }),
            finalize: vi.fn(async (prepared: typeof customerPrepared) => {
                customerPrepared = {
                    ...prepared,
                    intent: {
                        ...prepared.intent,
                        state: 'FINALIZED',
                        providerLeaseOwner: null,
                        providerLeaseExpiresAt: null,
                    },
                    providerLeaseOwner: null,
                };
                return customerPrepared;
            }),
            markCompensated: vi.fn(),
            releaseProviderClaim: vi.fn(),
        };
        const customerLifecycle = new TenantCancellationLifecycleService(
            {} as any,
            () => service,
            customerStore as any,
        );

        const staleCompensation = service.compensateTenantSubscriptionCancellation(
            'tenant-1',
            'sub_123',
            'platform-operation-a',
        );
        await staleCompensationEntered;
        const customerCancellation = customerLifecycle.cancelCustomer({
            tenantId: 'tenant-1',
            userId: 'user-1',
            ipAddress: null,
            userAgent: null,
        }, { confirmation: 'acme-dining' });
        await customerPersistenceEntered;

        expect(customerPrepared.intent.state).toBe('PENDING_PROVIDER');
        expect(providerSubscription).toMatchObject({
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'customer-operation-b',
            },
        });
        releaseStaleCompensation();
        await expect(staleCompensation).resolves.toEqual({
            action: 'not_owned',
            cancelAtPeriodEnd: true,
        });
        expect(providerSubscription).toMatchObject({
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'customer-operation-b',
            },
        });

        releaseCustomerPersistence();
        await expect(customerCancellation).resolves.toMatchObject({
            status: TenantStatus.ACTIVE,
            billingCancellation: {
                action: 'already_scheduled',
                cancelAtPeriodEnd: true,
            },
        });
        expect(customerPrepared.intent).toMatchObject({
            state: 'FINALIZED',
            operationId: 'customer-operation-b',
            providerMutationOwned: true,
            providerResult: { action: 'already_scheduled' },
        });
    });

    it('treats a terminal subscription carrying a customer marker as not owned before terminal compensation', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'canceled',
            cancel_at_period_end: false,
            metadata: {
                lunchlineupCancellationOperationId: 'customer-operation-b',
            },
        });

        await expect(service.compensateTenantSubscriptionCancellation(
            'tenant-1',
            'sub_123',
            'platform-operation-a',
        )).resolves.toEqual({
            action: 'not_owned',
            cancelAtPeriodEnd: false,
        });
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('performs an unscheduled provider readback without creating a cancellation', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: false,
            current_period_end: 1_800_000_000,
        });

        const result = await service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'operation-123',
            { providerReadbackOnly: true },
        );

        expect(result).toMatchObject({
            action: 'none',
            cancelAtPeriodEnd: false,
            providerMutationOwned: false,
        });
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('does not claim or compensate a cancellation marked for another operation', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            metadata: {
                lunchlineupCancellationOperationId: 'customer-operation',
            },
        });

        await expect(service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'platform-operation',
        )).resolves.toMatchObject({
            action: 'already_scheduled',
            providerMutationOwned: false,
        });
        await expect(service.compensateTenantSubscriptionCancellation(
            'tenant-1',
            'sub_123',
            'platform-operation',
        )).resolves.toEqual({
            action: 'not_owned',
            cancelAtPeriodEnd: true,
        });
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('uses stable distinct Stripe keys for cancellation and legal-hold compensation', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve
            .mockResolvedValueOnce({
                id: 'sub_123',
                status: 'active',
                cancel_at_period_end: false,
            })
            .mockResolvedValue({
                id: 'sub_123',
                status: 'active',
                cancel_at_period_end: true,
            });
        stripe.subscriptions.update
            .mockResolvedValueOnce({
                id: 'sub_123',
                status: 'active',
                cancel_at_period_end: true,
            })
            .mockResolvedValue({
                id: 'sub_123',
                status: 'active',
                cancel_at_period_end: false,
            });

        await service.cancelTenantSubscriptionAtPeriodEnd(
            'tenant-1',
            'sub_123',
            'operation-123',
        );

        await service.compensateTenantSubscriptionCancellation(
            'tenant-1',
            'sub_123',
            'operation-123',
        );
        await service.compensateTenantSubscriptionCancellation(
            'tenant-1',
            'sub_123',
            'operation-123',
        );

        const cancellationKey = stripe.subscriptions.update.mock.calls[0][2].idempotencyKey;
        const firstCompensationKey = stripe.subscriptions.update.mock.calls[1][2].idempotencyKey;
        const secondCompensationKey = stripe.subscriptions.update.mock.calls[2][2].idempotencyKey;
        expect(firstCompensationKey).toMatch(/^[a-f0-9]{64}$/);
        expect(secondCompensationKey).toBe(firstCompensationKey);
        expect(firstCompensationKey).not.toBe(cancellationKey);
    });

    it('accepts restore only when the stored Stripe subscription is active and owned', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            metadata: { tenantId: 'tenant-1' },
        });

        await expect(service.assertTenantSubscriptionActive('tenant-1', 'sub_123')).resolves.toBeUndefined();
    });

    it('rejects restore when the stored Stripe subscription is trialing', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'trialing',
            metadata: { tenantId: 'tenant-1' },
        });

        await expect(service.assertTenantSubscriptionActive('tenant-1', 'sub_123'))
            .rejects.toBeInstanceOf(BadRequestException);
    });
    it('rejects restore for a terminal or cross-tenant Stripe subscription', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'canceled',
            metadata: { tenantId: 'tenant-2' },
        });

        await expect(service.assertTenantSubscriptionActive('tenant-1', 'sub_123'))
            .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects restore when an active subscription is scheduled for cancellation', async () => {
        const { service, stripe } = buildService();
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            cancel_at_period_end: true,
            metadata: { tenantId: 'tenant-1' },
        });

        await expect(service.assertTenantSubscriptionActive('tenant-1', 'sub_123'))
            .rejects.toThrow('scheduled for cancellation');
    });

    it('does not call Stripe when a tenant has no stored subscription', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', stripeSubscriptionId: null });
        const { service, stripe } = buildService({ prisma });

        const result = await service.cancelTenantSubscriptionAtPeriodEnd('tenant-1');

        expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
        expect(result.action).toBe('none');
    });

    it.each(['checkout_expire', 'subscription_cancel', 'customer_delete'] as const)(
        'keeps purge active until blocked %s transport is terminated by the SDK timeout',
        async (blockedMutation) => {
            const prisma = buildPrismaMock();
            prisma.tx.tenant.findUnique.mockResolvedValue({
                id: 'tenant-1',
                status: TenantStatus.SUSPENDED,
                deletedAt: null,
                stripeCustomerId: 'cus_123',
                stripeSubscriptionId: blockedMutation === 'subscription_cancel'
                    ? 'sub_123'
                    : null,
            });
            const { service } = buildService({
                prisma,
                configValues: { STRIPE_PURGE_REQUEST_TIMEOUT_MS: '100' },
            });
            let mutationEnteredResolve!: () => void;
            const mutationEntered = new Promise<void>((resolve) => {
                mutationEnteredResolve = resolve;
            });
            let transportTerminatedResolve!: () => void;
            const transportTerminated = new Promise<void>((resolve) => {
                transportTerminatedResolve = resolve;
            });
            const mutationRequests: Array<{
                idempotencyKey: string | undefined;
                method: string | undefined;
                path: string;
            }> = [];
            const server = createServer((request, response) => {
                const url = new URL(request.url ?? '/', 'http://127.0.0.1');
                const mutation = (
                    blockedMutation === 'checkout_expire'
                    && request.method === 'POST'
                    && url.pathname === '/v1/checkout/sessions/cs_blocked/expire'
                ) || (
                    blockedMutation === 'subscription_cancel'
                    && request.method === 'DELETE'
                    && url.pathname === '/v1/subscriptions/sub_123'
                ) || (
                    blockedMutation === 'customer_delete'
                    && request.method === 'DELETE'
                    && url.pathname === '/v1/customers/cus_123'
                );
                if (mutation) {
                    mutationRequests.push({
                        idempotencyKey: request.headers['idempotency-key'] as string | undefined,
                        method: request.method,
                        path: url.pathname,
                    });
                    response.once('close', transportTerminatedResolve);
                    mutationEnteredResolve();
                    return;
                }

                let body: Record<string, unknown>;
                if (request.method === 'GET' && url.pathname === '/v1/customers/cus_123') {
                    body = {
                        id: 'cus_123',
                        object: 'customer',
                        metadata: { tenantId: 'tenant-1' },
                    };
                } else if (
                    request.method === 'GET'
                    && url.pathname === '/v1/checkout/sessions'
                ) {
                    body = {
                        object: 'list',
                        data: blockedMutation === 'checkout_expire'
                            ? [{
                                id: 'cs_blocked',
                                object: 'checkout.session',
                                status: 'open',
                                mode: 'subscription',
                                customer: 'cus_123',
                                client_reference_id: 'tenant-1',
                                metadata: { tenantId: 'tenant-1' },
                            }]
                            : [],
                        has_more: false,
                        url: '/v1/checkout/sessions',
                    };
                } else if (
                    request.method === 'GET'
                    && url.pathname === '/v1/subscriptions'
                ) {
                    body = {
                        object: 'list',
                        data: blockedMutation === 'subscription_cancel'
                            ? [{
                                id: 'sub_123',
                                object: 'subscription',
                                status: 'active',
                                customer: 'cus_123',
                                metadata: { tenantId: 'tenant-1' },
                            }]
                            : [],
                        has_more: false,
                        url: '/v1/subscriptions',
                    };
                } else {
                    response.writeHead(404, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ error: { message: 'unexpected probe route' } }));
                    return;
                }
                response.writeHead(200, {
                    'content-type': 'application/json',
                    'request-id': `req_${blockedMutation}`,
                });
                response.end(JSON.stringify(body));
            });
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const address = server.address() as AddressInfo;
            (service as any).stripe = new Stripe('sk_test_transport_probe', {
                apiVersion: '2024-04-10' as any,
                host: '127.0.0.1',
                httpClient: Stripe.createNodeHttpClient(),
                maxNetworkRetries: 0,
                port: address.port,
                protocol: 'http',
            });
            const controller = new AbortController();
            const abortReason = new Error(`stop-${blockedMutation}`);
            let purgeSettled = false;
            const purgeOutcome = service.finalizeTenantBillingForPurge(
                'tenant-1',
                {
                    operationId: purgeOperationId,
                    signal: controller.signal,
                    providerDeadlineAtMs: Date.now() + 5_000,
                },
            ).then(
                (value) => ({ value, error: null }),
                (error) => ({ value: null, error }),
            ).finally(() => { purgeSettled = true; });

            try {
                await mutationEntered;
                controller.abort(abortReason);
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(purgeSettled).toBe(false);
                await transportTerminated;
                const outcome = await purgeOutcome;

                expect(outcome.error).toBe(abortReason);
                expect(outcome.value).toBeNull();
                expect(mutationRequests).toEqual([expect.objectContaining({
                    idempotencyKey: expectedPurgeIdempotencyKey(
                        blockedMutation === 'checkout_expire'
                            ? 'checkout-expire'
                            : blockedMutation === 'subscription_cancel'
                                ? 'subscription-cancel'
                                : 'customer-delete',
                        blockedMutation === 'checkout_expire'
                            ? 'cs_blocked'
                            : blockedMutation === 'subscription_cancel'
                                ? 'sub_123'
                                : 'cus_123',
                    ),
                })]);
                expect(prisma.tx.tenant.updateMany).not.toHaveBeenCalled();
            } finally {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        },
    );

    it('snapshots a suspended tenant before expiring Checkout sessions and canceling subscriptions', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.SUSPENDED,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        let transactionActive = false;
        prisma.$transaction.mockImplementation(async (operation: any) => {
            transactionActive = true;
            try {
                return await operation(prisma.tx);
            } finally {
                transactionActive = false;
            }
        });
        const { service, stripe } = buildService({ prisma });
        stripe.checkout.sessions.list.mockImplementation(async () => {
            expect(transactionActive).toBe(false);
            return {
                data: [{
                    id: 'cs_open',
                    mode: 'subscription',
                    customer: 'cus_123',
                    client_reference_id: 'tenant-1',
                    metadata: { tenantId: 'tenant-1' },
                }, {
                    id: 'cs_credit_open',
                    mode: 'payment',
                    customer: 'cus_123',
                    client_reference_id: 'tenant-1',
                    metadata: { tenantId: 'tenant-1', purchaseType: 'credit_pack' },
                }, {
                    id: 'cs_unrelated_payment',
                    mode: 'payment',
                    customer: 'cus_123',
                    client_reference_id: 'tenant-1',
                    metadata: { tenantId: 'tenant-1', purchaseType: 'external_payment' },
                }],
            };
        });
        stripe.subscriptions.list.mockResolvedValue({
            data: [{
                id: 'sub_123',
                status: 'active',
                customer: 'cus_123',
                metadata: { tenantId: 'tenant-1' },
            }],
        });
        stripe.subscriptions.cancel.mockResolvedValue({
            id: 'sub_123',
            status: 'canceled',
            customer: 'cus_123',
            metadata: { tenantId: 'tenant-1' },
        });

        const result = await service.finalizeTenantBillingForPurge(
            'tenant-1',
            buildPurgeOptions(),
        );

        expect(stripe.checkout.sessions.expire.mock.calls).toEqual([
            ['cs_open', expect.objectContaining({
                idempotencyKey: expectedPurgeIdempotencyKey('checkout-expire', 'cs_open'),
                maxNetworkRetries: 0,
                timeout: expect.any(Number),
            })],
            ['cs_credit_open', expect.objectContaining({
                idempotencyKey: expectedPurgeIdempotencyKey('checkout-expire', 'cs_credit_open'),
                maxNetworkRetries: 0,
                timeout: expect.any(Number),
            })],
        ]);
        expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_123', expect.objectContaining({
            idempotencyKey: expectedPurgeIdempotencyKey('subscription-cancel', 'sub_123'),
            maxNetworkRetries: 0,
            timeout: expect.any(Number),
        }));
        expect(stripe.customers.del).toHaveBeenCalledWith('cus_123', expect.objectContaining({
            idempotencyKey: expectedPurgeIdempotencyKey('customer-delete', 'cus_123'),
            maxNetworkRetries: 0,
            timeout: expect.any(Number),
        }));
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'tenant-1',
                status: { in: [TenantStatus.SUSPENDED, TenantStatus.PURGED] },
                stripeCustomerId: 'cus_123',
            },
            data: {
                stripeCustomerId: null,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });
        expect(result).toEqual({
            expiredCheckoutSessionIds: ['cs_open', 'cs_credit_open'],
            canceledSubscriptionIds: ['sub_123'],
            alreadyTerminalSubscriptionIds: [],
        });
        const billingLockIndex = prisma.tx.$executeRaw.mock.calls.findIndex(([query, lockKey]: any[]) => {
            const sql = Array.isArray(query) ? query.join(' ') : String(query);
            return sql.includes('SELECT pg_advisory_xact_lock')
                && lockKey === 'billing-checkout:tenant-1';
        });
        expect(billingLockIndex).toBeGreaterThanOrEqual(0);
        expect(prisma.tx.$executeRaw.mock.invocationCallOrder[billingLockIndex])
            .toBeLessThan(stripe.checkout.sessions.list.mock.invocationCallOrder[0]);
    });

    it('honors an aborted deletion fence before database or Stripe work starts', async () => {
        const controller = new AbortController();
        const abortReason = new Error('deletion attempt fence expired');
        controller.abort(abortReason);
        const { service, prisma, stripe } = buildService();

        await expect(service.finalizeTenantBillingForPurge('tenant-1', {
            operationId: purgeOperationId,
            signal: controller.signal,
            providerDeadlineAtMs: Date.now() + 60_000,
        })).rejects.toBe(abortReason);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(stripe.customers.retrieve).not.toHaveBeenCalled();
        expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
        expect(stripe.customers.del).not.toHaveBeenCalled();
    });

    it('rejects billing cleanup before the durable suspension barrier is committed', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.ACTIVE,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        const { service, stripe } = buildService({ prisma });

        await expect(service.finalizeTenantBillingForPurge('tenant-1', buildPurgeOptions()))
            .rejects.toThrow('requires a suspended deletion barrier');

        expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
        expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    });

    it('fails closed before provider mutation when Stripe Customer ownership is not authoritative', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.SUSPENDED,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        const { service, stripe } = buildService({ prisma });
        stripe.customers.retrieve.mockResolvedValue({
            id: 'cus_123',
            deleted: false,
            metadata: { tenantId: 'tenant-other' },
        });

        await expect(service.finalizeTenantBillingForPurge('tenant-1', buildPurgeOptions()))
            .rejects.toThrow('customer ownership is not authoritative');

        expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
        expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
        expect(stripe.customers.del).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.updateMany).not.toHaveBeenCalled();
    });

    it('does not clear local billing bindings when Stripe Customer deletion fails', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.SUSPENDED,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
        });
        const { service, stripe } = buildService({ prisma });
        stripe.customers.del.mockRejectedValue(new Error('Stripe unavailable'));

        await expect(service.finalizeTenantBillingForPurge('tenant-1', buildPurgeOptions()))
            .rejects.toThrow('Stripe unavailable');

        expect(prisma.tx.tenant.updateMany).not.toHaveBeenCalled();
    });

    it('retries local binding cleanup without deleting an already-deleted Stripe Customer twice', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.SUSPENDED,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
        });
        prisma.tx.tenant.updateMany
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce({ count: 1 });
        const { service, stripe } = buildService({ prisma });
        let customerDeleted = false;
        stripe.customers.retrieve.mockImplementation(async () => customerDeleted
            ? { id: 'cus_123', deleted: true }
            : { id: 'cus_123', deleted: false, metadata: { tenantId: 'tenant-1' } });
        stripe.customers.del.mockImplementation(async () => {
            customerDeleted = true;
            return { id: 'cus_123', deleted: true };
        });

        await expect(service.finalizeTenantBillingForPurge('tenant-1', buildPurgeOptions()))
            .rejects.toThrow('database unavailable');
        await expect(service.finalizeTenantBillingForPurge('tenant-1', buildPurgeOptions()))
            .resolves.toEqual({
                expiredCheckoutSessionIds: [],
                canceledSubscriptionIds: [],
                alreadyTerminalSubscriptionIds: [],
            });

        expect(stripe.customers.del).toHaveBeenCalledOnce();
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledTimes(2);
    });

    it('accepts already-terminal Stripe state after concurrent cleanup errors', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.PURGED,
            deletedAt: new Date('2026-07-12T12:00:00.000Z'),
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        const { service, stripe } = buildService({ prisma });
        stripe.checkout.sessions.list.mockResolvedValue({
            data: [{
                id: 'cs_race',
                mode: 'subscription',
                customer: 'cus_123',
                client_reference_id: 'tenant-1',
                metadata: { tenantId: 'tenant-1' },
            }],
        });
        stripe.checkout.sessions.expire.mockRejectedValue(new Error('already expired'));
        stripe.checkout.sessions.retrieve.mockResolvedValue({
            id: 'cs_race',
            status: 'expired',
            mode: 'subscription',
            customer: 'cus_123',
            client_reference_id: 'tenant-1',
            metadata: { tenantId: 'tenant-1' },
        });
        stripe.subscriptions.list.mockResolvedValue({
            data: [{
                id: 'sub_123',
                status: 'active',
                customer: 'cus_123',
                metadata: { tenantId: 'tenant-1' },
            }],
        });
        stripe.subscriptions.cancel.mockRejectedValue(new Error('already canceled'));
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'canceled',
            customer: 'cus_123',
            metadata: { tenantId: 'tenant-1' },
        });

        const result = await service.finalizeTenantBillingForPurge(
            'tenant-1',
            buildPurgeOptions(),
        );

        expect(result).toEqual({
            expiredCheckoutSessionIds: ['cs_race'],
            canceledSubscriptionIds: [],
            alreadyTerminalSubscriptionIds: ['sub_123'],
        });
    });
});


describe('StripeService - webhook safety', () => {
    const invoicePaidEvent = {
        id: 'evt_paid',
        type: 'invoice.paid',
        data: {
            object: {
                object: 'invoice',
                subscription: 'sub_123',
                subscription_details: {
                    metadata: { tenantId: 'tenant-1' },
                },
                amount_paid: 9900,
                currency: 'usd',
            },
        },
    };

    afterEach(() => vi.unstubAllEnvs());

    it('audits Stripe events without lifting a suspended deletion barrier', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.SUSPENDED,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        const { service } = buildService({ prisma, event: invoicePaidEvent });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                stripeEventId: 'evt_paid',
                metadata: expect.objectContaining({ sideEffectDisposition: 'skipped_suspended' }),
            }),
        });
        const rowLockCall = prisma.tx.$queryRaw.mock.calls.find((call: any[]) =>
            String(call[0]).includes('FOR UPDATE'));
        expect(rowLockCall).toBeDefined();
        expect(prisma.tx.$queryRaw.mock.invocationCallOrder.at(-1))
            .toBeLessThan(prisma.tx.tenant.findUnique.mock.invocationCallOrder[0]);
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.updateMany).not.toHaveBeenCalled();
    });

    it('dispatches delayed payment-mode Checkout success to credit-purchase compensation', async () => {
        const event = {
            id: 'evt_credit_delayed',
            type: 'checkout.session.async_payment_succeeded',
            data: {
                object: {
                    object: 'checkout.session',
                    id: 'cs_credit_delayed',
                    mode: 'payment',
                },
            },
        };
        const { service } = buildService({ event });
        const handleCheckoutSessionCompleted = vi.fn().mockResolvedValue(undefined);
        (service as any).creditPurchases = { handleCheckoutSessionCompleted };

        await service.handleWebhook(Buffer.from('{\"id\":\"evt_credit_delayed\"}'), 'sig_123');

        expect(handleCheckoutSessionCompleted).toHaveBeenCalledWith(event);
    });

    it.each(['refund.created', 'refund.updated', 'refund.failed'])(
        'dispatches %s for a credit purchase to durable refund reconciliation',
        async (type) => {
            const event = {
                id: `evt_${type}`,
                type,
                data: {
                    object: {
                        id: 're_credit_1',
                        metadata: {
                            purchaseType: 'credit_pack',
                            tenantId: 'tenant-1',
                            checkoutSessionId: 'cs_credit_1',
                        },
                    },
                },
            };
            const { service } = buildService({ event });
            const handleRefundLifecycleEvent = vi.fn().mockResolvedValue(undefined);
            (service as any).creditPurchases = { handleRefundLifecycleEvent };

            await service.handleWebhook(Buffer.from(`{"id":"evt_${type}"}`), 'sig_123');

            expect(handleRefundLifecycleEvent).toHaveBeenCalledWith(event);
        },
    );

    it('cancels a verified subscription created after tenant purge without restoring entitlement', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const prisma = buildPrismaMock();
        const deletedAt = new Date('2026-07-09T12:00:00.000Z');
        prisma.tenant.findMany.mockResolvedValue([]);
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.PURGED,
            deletedAt,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
        });
        const event = {
            id: 'evt_post_purge_subscription',
            created: 1_783_603_200,
            type: 'customer.subscription.created',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_post_purge',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });
        stripe.subscriptions.cancel.mockResolvedValue({
            ...event.data.object,
            status: 'canceled',
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_post_purge_subscription"}'), 'sig_123');

        expect(stripe.webhooks.constructEvent).toHaveBeenCalled();
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_post_purge', {
            expand: ['items.data.price'],
        });
        expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_post_purge');
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledWith({
            where: { id: 'tenant-1', status: TenantStatus.PURGED },
            data: {
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });
        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                stripeEventId: 'evt_post_purge_subscription',
                metadata: expect.objectContaining({ sideEffectDisposition: 'post_purge_cancelled' }),
            }),
        });
    });

    it('resolves modern invoice parent subscription details', () => {
        const { service } = buildService();

        expect((service as any).resolveSubscriptionId({
            object: 'invoice',
            parent: { subscription_details: { subscription: 'sub_modern' } },
        })).toBe('sub_modern');
        expect((service as any).resolveSubscriptionId({
            object: 'invoice',
            parent: { subscription_details: { subscription: { id: 'sub_expanded' } } },
        })).toBe('sub_expanded');
    });

    it('excludes deleted and purged tenants from Stripe identifier ownership', async () => {
        const prisma = buildPrismaMock();
        const { service } = buildService({ prisma });

        await (service as any).findTenantByStripeIdentifiers('sub_123', 'cus_123');

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                deletedAt: null,
                status: { not: TenantStatus.PURGED },
            }),
        }));
    });

    it('rejects webhook requests without a Stripe signature', async () => {
        const { service, stripe } = buildService({ event: invoicePaidEvent });

        await expect(service.handleWebhook(Buffer.from('{}'))).rejects.toBeInstanceOf(BadRequestException);

        expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
    });

    it('fails closed when the webhook signing secret is missing', async () => {
        const { service, stripe } = buildService({
            configValues: { STRIPE_WEBHOOK_SECRET: undefined },
            event: invoicePaidEvent,
        });

        await expect(service.handleWebhook(Buffer.from('{}'), 'sig_123')).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(stripe.webhooks.constructEvent).not.toHaveBeenCalled();
    });

    it('rejects invalid Stripe webhook signatures', async () => {
        const constructEvent = vi.fn(() => {
            throw new Error('bad signature');
        });
        const { service } = buildService({ constructEvent });

        await expect(service.handleWebhook(Buffer.from('{}'), 'sig_123')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('activates a tenant only after a verified invoice.paid event', async () => {
        const prisma = buildPrismaMock();
        const { service } = buildService({ prisma, event: invoicePaidEvent });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                type: 'invoice.paid',
                stripeEventId: 'evt_paid',
                amount: 9900,
                currency: 'usd',
                metadata: {
                    sideEffectDisposition: 'applied',
                    entitlementTerminalPriority: 0,
                    stripeObjectType: 'invoice',
                    tenantId: 'tenant-1',
                    subscriptionId: 'sub_123',
                    stripeSubscriptionStatus: 'active',
                    amountPaid: 9900,
                    currency: 'usd',
                    planCode: 'STARTER',
                },
            },
        });
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it.each([
        ['invoice.paid', 'active', TenantStatus.ACTIVE],
        ['invoice.payment_failed', 'past_due', TenantStatus.PAST_DUE],
    ])('binds an invoice-first %s subscription and rejects its later stale subscription event', async (
        invoiceType,
        subscriptionStatus,
        expectedTenantStatus,
    ) => {
        const prisma = buildPrismaMock();
        const tenantState = {
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null as string | null,
        };
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_123') {
                return Promise.resolve(tenantState.stripeSubscriptionId ? [{ id: tenantState.id }] : []);
            }
            if (args.where?.stripeCustomerId === 'cus_123') {
                return Promise.resolve([{ ...tenantState }]);
            }
            return Promise.resolve([]);
        });
        prisma.tenant.findUnique.mockImplementation(() => Promise.resolve({ ...tenantState }));
        prisma.tx.tenant.updateMany.mockImplementation(async (args: any) => {
            if (args.where?.stripeSubscriptionId === null && tenantState.stripeSubscriptionId === null) {
                tenantState.stripeSubscriptionId = args.data.stripeSubscriptionId;
                return { count: 1 };
            }
            return { count: 0 };
        });
        prisma.tx.tenant.update.mockImplementation(async (args: any) => {
            if (args.data.status) tenantState.status = args.data.status;
            if (Object.prototype.hasOwnProperty.call(args.data, 'stripeSubscriptionId')) {
                tenantState.stripeSubscriptionId = args.data.stripeSubscriptionId;
            }
            return { ...tenantState };
        });
        const invoiceEvent = {
            id: `evt_invoice_first_${invoiceType.replaceAll('.', '_')}`,
            created: 200,
            type: invoiceType,
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    subscription_details: { metadata: { tenantId: 'tenant-1' } },
                    amount_paid: invoiceType === 'invoice.paid' ? 9900 : 0,
                    amount_due: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event: invoiceEvent });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: subscriptionStatus,
            customer: 'cus_123',
            items: { data: [{ price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1' },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(tenantState.stripeSubscriptionId).toBe('sub_123');
        expect(tenantState.status).toBe(expectedTenantStatus);
        expect(prisma.tx.tenant.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'tenant-1',
                deletedAt: null,
                stripeCustomerId: 'cus_123',
                stripeSubscriptionId: null,
            },
            data: {
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });

        const storedInvoice = prisma.tx.billingEvent.create.mock.calls[0][0].data;
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: storedInvoice.type,
            stripeEventId: storedInvoice.stripeEventId,
            metadata: storedInvoice.metadata,
        }]);
        stripe.webhooks.constructEvent.mockReturnValue({
            id: `evt_subscription_created_after_${invoiceType.replaceAll('.', '_')}`,
            created: 100,
            type: 'customer.subscription.created',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: invoiceType === 'invoice.paid' ? 'past_due' : 'active',
                    items: { data: [{ price: { id: 'price_123' } }] },
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledTimes(1);
        expect(prisma.tx.billingEvent.create.mock.calls[1][0].data.metadata.sideEffectDisposition)
            .toBe('skipped_stale');
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    });

    it('retries an invoice-first event instead of binding conflicting subscription metadata', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_123') return Promise.resolve([]);
            if (args.where?.stripeCustomerId === 'cus_123') {
                return Promise.resolve([{
                    id: 'tenant-1',
                    deletedAt: null,
                    stripeCustomerId: 'cus_123',
                    stripeSubscriptionId: null,
                }]);
            }
            return Promise.resolve([]);
        });
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
        });
        const { service, stripe } = buildService({ prisma, event: {
            ...invoicePaidEvent,
            data: {
                object: {
                    ...invoicePaidEvent.data.object,
                    customer: 'cus_123',
                },
            },
        } });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            customer: 'cus_123',
            metadata: { tenantId: 'tenant-2' },
        });

        await expect(service.handleWebhook(Buffer.from('{}'), 'sig_123'))
            .rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(prisma.tx.tenant.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
    });

    it('retries the same invoice.paid event after a transient subscription lookup failure', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.PAST_DUE,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'invoice.payment_failed',
            stripeEventId: 'evt_payment_failed',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 100,
            },
        }]);
        const event = {
            ...invoicePaidEvent,
            id: 'evt_paid_retry',
            created: 200,
            data: {
                object: {
                    ...invoicePaidEvent.data.object,
                    lines: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });
        const transientLookupFailure = new Error('Stripe subscription lookup timed out');
        stripe.subscriptions.retrieve.mockRejectedValueOnce(transientLookupFailure);

        await expect(service.handleWebhook(Buffer.from('{"id":"evt_paid_retry"}'), 'sig_123'))
            .rejects.toBe(transientLookupFailure);
        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();

        await expect(service.handleWebhook(Buffer.from('{"id":"evt_paid_retry"}'), 'sig_123'))
            .resolves.toBeUndefined();

        expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2);
        expect(prisma.tx.billingEvent.create).toHaveBeenCalledTimes(1);
        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                stripeEventId: 'evt_paid_retry',
                metadata: expect.objectContaining({
                    stripeEventCreated: 200,
                    sideEffectDisposition: 'applied',
                }),
            }),
        }));
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('stores only minimized operational metadata for verified Stripe webhooks', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_checkout',
            type: 'checkout.session.completed',
            livemode: true,
            data: {
                object: {
                    object: 'checkout.session',
                    id: 'cs_123',
                    mode: 'subscription',
                    payment_status: 'paid',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    customer_details: {
                        email: 'owner@example.com',
                        name: 'Owner Example',
                    },
                    metadata: {
                        tenantId: 'tenant-1',
                        planCode: 'STARTER',
                        internalNote: 'do-not-retain',
                    },
                    line_items: {
                        data: [
                            { price: { id: 'price_123', nickname: 'Starter monthly' } },
                        ],
                    },
                    amount_total: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            customer: 'cus_123',
            items: { data: [{ price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_checkout"}'), 'sig_123');

        const metadata = prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata;
        expect(metadata).toEqual({
            stripeEventLivemode: true,
            sideEffectDisposition: 'applied',
            entitlementTerminalPriority: 0,
            stripeObjectType: 'checkout.session',
            stripeObjectId: 'cs_123',
            tenantId: 'tenant-1',
            subscriptionId: 'sub_123',
            customerId: 'cus_123',
            checkoutSessionId: 'cs_123',
            paymentStatus: 'paid',
            mode: 'subscription',
            stripeSubscriptionStatus: 'active',
            amountTotal: 9900,
            currency: 'usd',
            planCode: 'STARTER',
            priceIds: ['price_123'],
        });
        expect(JSON.stringify(metadata)).not.toContain('owner@example.com');
        expect(metadata).not.toHaveProperty('customer_details');
        expect(metadata).not.toHaveProperty('line_items');
        expect(metadata).not.toHaveProperty('metadata');
    });

    it.each([
        ['no_payment_required', 'active', TenantStatus.ACTIVE],
        ['unpaid', 'incomplete', TenantStatus.PAST_DUE],
    ])('binds a %s Checkout subscription before discarding an older subscription.created event', async (
        paymentStatus,
        subscriptionStatus,
        expectedTenantStatus,
    ) => {
        const prisma = buildPrismaMock();
        let subscriptionBound = false;
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_123') {
                return Promise.resolve(subscriptionBound ? [{ id: 'tenant-1' }] : []);
            }
            if (args.where?.stripeCustomerId === 'cus_123') {
                return Promise.resolve([{ id: 'tenant-1' }]);
            }
            return Promise.resolve([]);
        });
        prisma.tenant.findUnique.mockImplementation(() => Promise.resolve({
            id: 'tenant-1',
            status: TenantStatus.TRIAL,
            deletedAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: subscriptionBound ? 'sub_123' : null,
        }));
        prisma.tx.tenant.update.mockImplementation(async (args: any) => {
            if (args.data?.stripeSubscriptionId === 'sub_123') subscriptionBound = true;
            return args.data;
        });
        const checkoutEvent = {
            id: `evt_checkout_${paymentStatus}`,
            created: 200,
            type: 'checkout.session.completed',
            data: {
                object: {
                    object: 'checkout.session',
                    id: 'cs_123',
                    mode: 'subscription',
                    payment_status: paymentStatus,
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event: checkoutEvent });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: subscriptionStatus,
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1' },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(subscriptionBound).toBe(true);
        expect(prisma.tx.tenant.update).toHaveBeenLastCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: expectedTenantStatus,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });

        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: checkoutEvent.type,
            stripeEventId: checkoutEvent.id,
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: checkoutEvent.created,
                sideEffectDisposition: 'applied',
                entitlementTerminalPriority: 0,
                stripeSubscriptionStatus: subscriptionStatus,
            },
        }]);
        stripe.webhooks.constructEvent.mockReturnValue({
            id: 'evt_subscription_created_older',
            created: 100,
            type: 'customer.subscription.created',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: subscriptionStatus === 'active' ? 'incomplete' : 'active',
                    items: { data: [{ price: { id: 'price_123' } }] },
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledTimes(1);
        expect(prisma.tx.billingEvent.create.mock.calls[1][0].data.metadata.sideEffectDisposition)
            .toBe('skipped_stale');
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1);
    });

    it('uses the verified current subscription price instead of an old-plan proration credit line', async () => {
        const prisma = buildPrismaMock();
        const event = {
            ...invoicePaidEvent,
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    subscription_details: {
                        metadata: { tenantId: 'tenant-1' },
                    },
                    lines: {
                        data: [
                            { amount: -2000, price: { id: 'price_123' }, proration: true },
                            { amount: 7900, price: { id: 'price_growth' }, proration: true },
                        ],
                    },
                    amount_paid: 7900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({
            prisma,
            event,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'active',
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_growth' } }] },
            metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123', {
            expand: ['items.data.price'],
        });
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'GROWTH',
            },
        });
    });

    it('uses authoritative state for a lexically older same-second canonical event', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'customer.subscription.updated',
            stripeEventId: 'evt_z',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
                stripeSubscriptionStatus: 'active',
            },
        }]);
        const event = {
            id: 'evt_a',
            created: 200,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({
            prisma,
            event,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            customer: 'cus_123',
            status: 'active',
            metadata: { tenantId: 'tenant-1', planCode: 'GROWTH' },
            items: { data: [{ price: { id: 'price_growth' } }] },
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_a"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('applied');
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123', {
            expand: ['items.data.price'],
        });
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'GROWTH',
            },
        });
    });

    it.each([
        ['active', true, TenantStatus.ACTIVE, 0],
        ['past_due', false, TenantStatus.PAST_DUE, -1],
        ['paused', false, TenantStatus.PAST_DUE, 1],
    ])('classifies invoice.payment_failed from current subscription state %s', async (
        stripeStatus,
        hasPendingUpdate,
        expectedTenantStatus,
        expectedPriority,
    ) => {
        const prisma = buildPrismaMock();
        const event = {
            id: `evt_payment_failed_${stripeStatus}`,
            created: 300,
            type: 'invoice.payment_failed',
            data: {
                object: {
                    object: 'invoice',
                    id: 'in_failed',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    billing_reason: hasPendingUpdate ? 'subscription_update' : 'subscription_cycle',
                    lines: { data: [{ price: { id: 'price_growth' } }] },
                    amount_due: 7900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({
            prisma,
            event,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: stripeStatus,
            customer: 'cus_123',
            items: { data: [{ id: 'si_123', price: { id: 'price_123' } }] },
            pending_update: hasPendingUpdate ? { expires_at: 1800000000 } : null,
            metadata: { tenantId: 'tenant-1' },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: expectedTenantStatus,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                metadata: expect.objectContaining({
                    sideEffectDisposition: 'applied',
                    entitlementTerminalPriority: expectedPriority,
                    stripeSubscriptionStatus: stripeStatus,
                    planCode: 'STARTER',
                }),
            }),
        }));
    });

    it.each([
        ['invoice.paid', {
            object: 'invoice',
            subscription: 'sub_123',
            customer: 'cus_123',
            subscription_details: { metadata: { tenantId: 'tenant-1' } },
            amount_paid: 2900,
            currency: 'usd',
        }],
        ['customer.subscription.updated', {
            object: 'subscription',
            id: 'sub_123',
            customer: 'cus_123',
            status: 'active',
            metadata: { tenantId: 'tenant-1' },
            items: { data: [{ price: { id: 'price_123' } }] },
        }],
    ])('applies same-second authoritative %s recovery after recoverable payment failure', async (
        recoveryType,
        object,
    ) => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'invoice.payment_failed',
            stripeEventId: 'evt_z_failed',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 400,
                entitlementTerminalPriority: -1,
                stripeSubscriptionStatus: 'past_due',
            },
        }]);
        const event = {
            id: 'evt_a_recovery',
            created: 400,
            type: recoveryType,
            data: { object },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('applied');
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: TenantStatus.ACTIVE }),
        }));
    });

    it.each([
        ['invoice.paid'],
        ['customer.subscription.updated'],
    ])('does not let same-second recoverable payment failure override prior authoritative %s recovery', async (
        recoveryType,
    ) => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: recoveryType,
            stripeEventId: 'evt_a_recovery',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 400,
                entitlementTerminalPriority: 0,
                stripeSubscriptionStatus: 'active',
            },
        }]);
        const event = {
            id: 'evt_z_failed',
            created: 400,
            type: 'invoice.payment_failed',
            data: {
                object: {
                    object: 'invoice',
                    id: 'in_failed',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    amount_due: 2900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'past_due',
            customer: 'cus_123',
            items: { data: [{ price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1' },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('skipped_stale');
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('synchronizes plan and active entitlement state from subscription.updated', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_sub_update',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: {
                        data: [
                            { price: { id: 'price_growth' } },
                        ],
                    },
                },
            },
        };
        const { service } = buildService({
            prisma,
            event,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_sub_update"}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'GROWTH',
            },
        });
    });

    it('synchronizes Stripe trialing to a distinct non-paid local trial state', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_sub_trialing',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'trialing',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_growth' } }] },
                },
            },
        };
        const { service } = buildService({
            prisma,
            event,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.TRIAL,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'GROWTH',
            },
        });
    });
    it('clears incomplete_expired subscription IDs and leaves checkout recovery available', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_incomplete_expired',
            created: 100,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'incomplete_expired',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.CANCELLED,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('restricts paused subscriptions without blocking authenticated recovery and restores resumed state', async () => {
        const prisma = buildPrismaMock();
        const pausedEvent = {
            id: 'evt_paused',
            created: 100,
            type: 'customer.subscription.paused',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'paused',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event: pausedEvent });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');
        expect(prisma.tx.tenant.update).toHaveBeenLastCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.PAST_DUE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });

        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: pausedEvent.type,
            stripeEventId: pausedEvent.id,
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: pausedEvent.created,
                status: 'paused',
            },
        }]);
        stripe.webhooks.constructEvent.mockReturnValue({
            ...pausedEvent,
            id: 'evt_resumed',
            created: 101,
            type: 'customer.subscription.resumed',
            data: {
                object: {
                    ...pausedEvent.data.object,
                    status: 'active',
                },
            },
        });
        stripe.subscriptions.retrieve.mockResolvedValue({
            ...pausedEvent.data.object,
            status: 'active',
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');
        expect(prisma.tx.tenant.update).toHaveBeenLastCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('converges an over-capacity remote downgrade to restricted local entitlements', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.user.count.mockResolvedValue(51);
        const event = {
            id: 'evt_remote_downgrade',
            created: 100,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await expect(service.handleWebhook(Buffer.from('{}'), 'sig_123')).resolves.toBeUndefined();
        expect(prisma.tx.billingEvent.create).toHaveBeenCalled();
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.PAST_DUE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('holds an active remote downgrade when existing locations exceed the new plan', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.location.count.mockResolvedValue(6);
        const event = {
            id: 'evt_remote_location_downgrade',
            created: 100,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await expect(service.handleWebhook(Buffer.from('{}'), 'sig_123')).resolves.toBeUndefined();
        expect(prisma.tx.billingEvent.create).toHaveBeenCalled();
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.PAST_DUE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('keeps paid entitlement active when invoice finalization fails for an active subscription', async () => {
        const prisma = buildPrismaMock();
        const failedEvent = {
            id: 'evt_finalization_failed',
            created: 200,
            type: 'invoice.finalization_failed',
            data: {
                object: {
                    object: 'invoice',
                    id: 'in_123',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    subscription_details: { metadata: { tenantId: 'tenant-1' } },
                    status: 'open',
                    amount_due: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event: failedEvent });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');
        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123', {
            expand: ['items.data.price'],
        });
        expect(prisma.tx.tenant.update).toHaveBeenLastCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('synchronizes genuine delinquency when invoice finalization fails', async () => {
        const prisma = buildPrismaMock();
        const failedEvent = {
            id: 'evt_finalization_failed_past_due',
            created: 201,
            type: 'invoice.finalization_failed',
            data: {
                object: {
                    object: 'invoice',
                    id: 'in_past_due',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    subscription_details: { metadata: { tenantId: 'tenant-1' } },
                    status: 'open',
                    amount_due: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event: failedEvent });
        stripe.subscriptions.retrieve.mockResolvedValue({
            id: 'sub_123',
            status: 'past_due',
            customer: 'cus_123',
            items: { data: [{ price: { id: 'price_123' } }] },
            metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
        });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');
        expect(prisma.tx.tenant.update).toHaveBeenLastCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.PAST_DUE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('does not let a stale canonical subscription event overwrite a newer cancellation', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            stripeEventId: 'evt_newer',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
            },
        }]);
        const event = {
            id: 'evt_older',
            created: 100,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_older"}'), 'sig_123');

        expect(prisma.tx.billingEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                metadata: { path: ['subscriptionId'], equals: 'sub_123' },
            }),
        }));
        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                stripeEventId: 'evt_older',
                metadata: expect.objectContaining({
                    stripeEventCreated: 100,
                    sideEffectDisposition: 'skipped_stale',
                }),
            }),
        }));
        expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('retrieves canonical subscription state only after billing locks and chronology checks', async () => {
        const prisma = buildPrismaMock();
        const calls: string[] = [];
        prisma.tx.$executeRaw.mockImplementation(async (query: unknown) => {
            const sql = Array.isArray(query) ? query.join(' ') : String(query);
            if (sql.includes('SELECT pg_advisory_xact_lock')) {
                calls.push('lock');
            }
            return 1;
        });
        prisma.tx.billingEvent.findMany.mockImplementation(async () => {
            calls.push('high-water');
            return [];
        });
        const event = {
            id: 'evt_newer_recovery',
            created: 300,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });
        stripe.subscriptions.retrieve.mockImplementation(async () => {
            calls.push('retrieve');
            return event.data.object;
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_newer_recovery"}'), 'sig_123');

        const highWaterIndex = calls.indexOf('high-water');
        const retrieveIndex = calls.indexOf('retrieve');
        expect(calls.slice(0, highWaterIndex).filter((call) => call === 'lock').length)
            .toBeGreaterThanOrEqual(2);
        expect(highWaterIndex).toBeGreaterThanOrEqual(0);
        expect(retrieveIndex).toBeGreaterThan(highWaterIndex);
        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('applied');
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: TenantStatus.ACTIVE }),
        }));
    });

    it('does not advance the subscription high-water mark for an unverified event', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'checkout.session.completed',
            stripeEventId: 'evt_unverified_newer',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
                sideEffectDisposition: 'skipped_unverified_subscription',
                entitlementTerminalPriority: 0,
            },
        }]);
        const event = {
            id: 'evt_verified_older',
            created: 100,
            type: 'customer.subscription.created',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('applied');
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('does not let equal-second invoice activation override subscription deletion', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'customer.subscription.deleted',
            stripeEventId: 'evt_a',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
                status: 'canceled',
            },
        }]);
        const event = {
            id: 'evt_z',
            created: 200,
            type: 'invoice.paid',
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    subscription_details: { metadata: { tenantId: 'tenant-1' } },
                    amount_paid: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_z"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('skipped_stale');
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('applies equal-second cancellation before a lexically greater activation event', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'invoice.paid',
            stripeEventId: 'evt_z',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
            },
        }]);
        const event = {
            id: 'evt_a',
            created: 200,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'canceled',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_a"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('applied');
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.CANCELLED,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('applies the greater Stripe event ID when equal timestamps tie', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            stripeEventId: 'evt_a',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
            },
        }]);
        const event = {
            id: 'evt_z',
            created: 200,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_z"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('applied');
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: TenantStatus.ACTIVE }),
        }));
    });

    it('retrieves but does not override equal-second terminal state with active canonical state', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.findMany.mockResolvedValue([{
            type: 'customer.subscription.deleted',
            stripeEventId: 'evt_terminal',
            metadata: {
                subscriptionId: 'sub_123',
                stripeEventCreated: 200,
                stripeSubscriptionStatus: 'canceled',
            },
        }]);
        const event = {
            id: 'evt_active_same_second',
            created: 200,
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    metadata: { tenantId: 'tenant-1' },
                    items: { data: [{ price: { id: 'price_123' } }] },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_active_same_second"}'), 'sig_123');

        expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123', {
            expand: ['items.data.price'],
        });
        expect(prisma.tx.billingEvent.create.mock.calls[0][0].data.metadata.sideEffectDisposition)
            .toBe('skipped_stale');
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('keeps access active while a subscription cancellation is only scheduled', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_sub_cancel_scheduled',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'active',
                    cancel_at_period_end: true,
                    current_period_end: 1800000000,
                    metadata: { tenantId: 'tenant-1' },
                    items: {
                        data: [
                            { price: { id: 'price_123' } },
                        ],
                    },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_sub_cancel_scheduled"}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: new Date('2027-01-15T08:00:00.000Z'),
                planTier: 'STARTER',
            },
        });
    });

    it('ignores a stale subscription event that only matches the current customer', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_old') return Promise.resolve([]);
            if (args.where?.stripeCustomerId === 'cus_123') return Promise.resolve([{ id: 'tenant-1' }]);
            return Promise.resolve([]);
        });
        const event = {
            id: 'evt_stale',
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_old',
                    customer: 'cus_123',
                    status: 'canceled',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_stale"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('marks access cancelled only after the current subscription terminates', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_deleted',
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'canceled',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_deleted"}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.CANCELLED,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });
    });

    it('accepts a late deleted replay only through an exact finalized customer cancellation binding', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_123') return Promise.resolve([]);
            if (args.where?.stripeCustomerId === 'cus_123') return Promise.resolve([{ id: 'tenant-1' }]);
            return Promise.resolve([]);
        });
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.CANCELLED,
            deletedAt: null,
            retentionLegalHoldAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
            stripeSubscriptionCurrentPeriodEnd: null,
        });
        prisma.tx.tenantSetting.findUnique.mockResolvedValue({
            value: {
                tenantId: 'tenant-1',
                kind: 'CUSTOMER_CANCELLATION',
                state: 'FINALIZED',
                providerSubscriptionId: 'sub_123',
                providerResult: { action: 'already_canceled' },
            },
        });
        const event = {
            id: 'evt_deleted_after_reconciliation',
            created: 200,
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'canceled',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                stripeEventId: 'evt_deleted_after_reconciliation',
                tenantId: 'tenant-1',
            }),
        }));
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.CANCELLED,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });
    });

    it('revalidates a finalized subscription binding inside the billing transaction', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_old') return Promise.resolve([]);
            if (args.where?.stripeCustomerId === 'cus_123') return Promise.resolve([]);
            return Promise.resolve([]);
        });
        const finalizedTenant = {
            id: 'tenant-1',
            status: TenantStatus.CANCELLED,
            deletedAt: null,
            retentionLegalHoldAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
            stripeSubscriptionCurrentPeriodEnd: null,
        };
        prisma.tx.tenant.findUnique
            .mockResolvedValueOnce(finalizedTenant)
            .mockResolvedValueOnce(finalizedTenant)
            .mockResolvedValueOnce({
                ...finalizedTenant,
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_replacement',
            });
        prisma.tx.tenantSetting.findUnique.mockResolvedValue({
            value: {
                tenantId: 'tenant-1',
                kind: 'CUSTOMER_CANCELLATION',
                state: 'FINALIZED',
                providerSubscriptionId: 'sub_old',
                providerResult: { action: 'already_canceled' },
            },
        });
        const event = {
            id: 'evt_paused_old_after_replacement',
            created: 201,
            type: 'customer.subscription.paused',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_old',
                    customer: 'cus_123',
                    status: 'paused',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                stripeEventId: 'evt_paused_old_after_replacement',
                metadata: expect.objectContaining({
                    sideEffectDisposition: 'skipped_unverified_subscription',
                }),
            }),
        }));
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
        expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    it('revalidates a resolved deleted subscription even without a pre-transaction finalized marker', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.ACTIVE,
            deletedAt: null,
            retentionLegalHoldAt: null,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_replacement',
        });
        const event = {
            id: 'evt_deleted_resolved_before_replacement',
            created: 202,
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'canceled',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service, stripe } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                stripeEventId: 'evt_deleted_resolved_before_replacement',
                metadata: expect.objectContaining({
                    sideEffectDisposition: 'skipped_unverified_subscription',
                }),
            }),
        }));
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
        expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
        expect(prisma.tx.tenantSetting.findUnique).not.toHaveBeenCalled();
    });

    it('fences a terminal subscription webhook behind a committed winning legal hold', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.ACTIVE,
            deletedAt: null,
            retentionLegalHoldAt: new Date('2026-07-16T20:00:00.000Z'),
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        prisma.tx.tenantSetting.findUnique.mockResolvedValue({
            value: {
                kind: 'PLATFORM_ARCHIVE',
                state: 'COMPENSATION_PENDING',
                providerAttempts: 1,
                providerMutationOwned: true,
                providerResult: { action: 'scheduled' },
            },
        });
        const event = {
            id: 'evt_deleted_during_archive_hold',
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'canceled',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(
            Buffer.from('{"id":"evt_deleted_during_archive_hold"}'),
            'sig_123',
        );

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.PAST_DUE,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });
        expect(prisma.tx.tenant.update).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: TenantStatus.CANCELLED }),
        }));
    });

    it('does not treat a crash-before-provider attempt as compensation ownership', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.ACTIVE,
            deletedAt: null,
            retentionLegalHoldAt: new Date('2026-07-16T20:00:00.000Z'),
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        });
        prisma.tx.tenantSetting.findUnique.mockResolvedValue({
            value: {
                kind: 'PLATFORM_ARCHIVE',
                state: 'PENDING_PROVIDER',
                providerAttempts: 1,
                providerMutationOwned: null,
                providerResult: null,
            },
        });
        const event = {
            id: 'evt_customer_deleted_after_archive_crash',
            type: 'customer.subscription.deleted',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'canceled',
                    metadata: { tenantId: 'tenant-1' },
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.CANCELLED,
                stripeSubscriptionId: null,
                stripeSubscriptionCurrentPeriodEnd: null,
            },
        });
    });

    it('does not reactivate a cancelled tenant from a late invoice.paid event', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: TenantStatus.CANCELLED,
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: null,
            stripeSubscriptionCurrentPeriodEnd: null,
        });
        const { service } = buildService({ prisma, event: invoicePaidEvent });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                metadata: expect.objectContaining({
                    sideEffectDisposition: 'skipped_unverified_subscription',
                    subscriptionId: 'sub_123',
                }),
            }),
        }));
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('does not change entitlement state for a customer-only failed invoice', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_invoice_customer_only',
            type: 'invoice.payment_failed',
            data: {
                object: {
                    object: 'invoice',
                    customer: 'cus_123',
                    amount_due: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_invoice_customer_only"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('marks subscription.updated past_due tenants without keeping paid entitlement state active', async () => {
        const prisma = buildPrismaMock();
        const event = {
            id: 'evt_sub_past_due',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    object: 'subscription',
                    id: 'sub_123',
                    customer: 'cus_123',
                    status: 'past_due',
                    metadata: { tenantId: 'tenant-1' },
                    items: {
                        data: [
                            { price: { id: 'price_growth' } },
                        ],
                    },
                },
            },
        };
        const { service } = buildService({
            prisma,
            event,
            configValues: { STRIPE_PRICE_GROWTH: 'price_growth' },
        });

        await service.handleWebhook(Buffer.from('{"id":"evt_sub_past_due"}'), 'sig_123');

        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.PAST_DUE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'GROWTH',
            },
        });
    });

    it('resolves tenant ownership from a stored Stripe subscription when invoice metadata is absent', async () => {
        const prisma = buildPrismaMock();
        const event = {
            ...invoicePaidEvent,
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    amount_paid: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tenant.findMany).toHaveBeenCalledWith({
            where: {
                stripeSubscriptionId: 'sub_123',
                deletedAt: null,
                status: { not: TenantStatus.PURGED },
            },
            select: { id: true },
            take: 2,
        });
        expect(prisma.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                status: TenantStatus.ACTIVE,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: null,
                planTier: 'STARTER',
            },
        });
    });

    it('skips webhook side effects when tenant metadata conflicts with stored Stripe ownership', async () => {
        const prisma = buildPrismaMock();
        const event = {
            ...invoicePaidEvent,
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    subscription_details: {
                        metadata: { tenantId: 'tenant-evil' },
                    },
                    amount_paid: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tenant.findMany).toHaveBeenCalledWith({
            where: {
                stripeSubscriptionId: 'sub_123',
                deletedAt: null,
                status: { not: TenantStatus.PURGED },
            },
            select: { id: true },
            take: 2,
        });
        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('skips webhook side effects when tenant metadata has no stored Stripe owner', async () => {
        const prisma = buildPrismaMock();
        const event = {
            ...invoicePaidEvent,
            data: {
                object: {
                    object: 'invoice',
                    metadata: { tenantId: 'tenant-1' },
                    amount_paid: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('skips webhook side effects when subscription and customer identifiers resolve to different tenants', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_123') {
                return Promise.resolve([{ id: 'tenant-1' }]);
            }
            if (args.where?.stripeCustomerId === 'cus_456') {
                return Promise.resolve([{ id: 'tenant-2' }]);
            }
            return Promise.resolve([]);
        });
        const event = {
            ...invoicePaidEvent,
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    customer: 'cus_456',
                    amount_paid: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        const warned = JSON.stringify((service as any).logger.warn.mock.calls);
        expect(warned).not.toContain('sub_123');
        expect(warned).toMatch(/[a-f0-9]{12}/);
        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('skips webhook side effects when a Stripe identifier is linked to multiple tenants', async () => {
        const prisma = buildPrismaMock();
        prisma.tenant.findMany.mockImplementation((args: any) => {
            if (args.where?.stripeSubscriptionId === 'sub_123') {
                return Promise.resolve([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
            }
            return Promise.resolve([]);
        });
        const event = {
            ...invoicePaidEvent,
            data: {
                object: {
                    object: 'invoice',
                    subscription: 'sub_123',
                    amount_paid: 9900,
                    currency: 'usd',
                },
            },
        };
        const { service } = buildService({ prisma, event });

        await service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123');

        expect(prisma.tx.billingEvent.create).not.toHaveBeenCalled();
        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('skips duplicate Stripe events before applying tenant side effects', async () => {
        const prisma = buildPrismaMock();
        prisma.tx.billingEvent.create.mockRejectedValue({ code: 'P2002' });
        const { service } = buildService({ prisma, event: invoicePaidEvent });

        await expect(service.handleWebhook(Buffer.from('{"id":"evt_paid"}'), 'sig_123')).resolves.toBeUndefined();

        expect(prisma.tx.tenant.update).not.toHaveBeenCalled();
    });
});
