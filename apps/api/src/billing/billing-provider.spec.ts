import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import {
    BILLING_DISABLED_CODE,
    BillingDisabledException,
    assertBillingEnabled,
    billingProviderErrors,
    isBillingDisabled,
    parseBillingProvider,
} from './billing-provider';
import { BillingController } from './billing.controller';
import { StripeMeterEventsService } from './stripe-meter-events.service';
import { StripeService } from './stripe.service';
import { StripeCreditPurchaseService } from './stripe-credit-purchase.service';
import { StripeMeterErrorService } from './stripe-meter-error.service';
import { MeteringService } from './metering.service';
import { ProductionExceptionFilter } from '../common/production-exception.filter';

describe('billing provider selection', () => {
    it('parses stripe (default) and disabled exactly, and rejects everything else', () => {
        expect(parseBillingProvider(undefined)).toBe('stripe');
        expect(parseBillingProvider('')).toBe('stripe');
        expect(parseBillingProvider(' stripe ')).toBe('stripe');
        expect(parseBillingProvider('disabled')).toBe('disabled');
        expect(parseBillingProvider('Disabled')).toBeNull();
        expect(parseBillingProvider('off')).toBeNull();
        expect(isBillingDisabled('disabled')).toBe(true);
        expect(isBillingDisabled('Disabled')).toBe(false);
        expect(isBillingDisabled(undefined)).toBe(false);
    });

    it('allows disabled only on non-production data targets', () => {
        expect(billingProviderErrors({ BILLING_PROVIDER: 'disabled', DATA_TARGET_ENV: 'staging' })).toEqual([]);
        expect(billingProviderErrors({ BILLING_PROVIDER: 'disabled', DATA_TARGET_ENV: 'production' })).toHaveLength(1);
        expect(billingProviderErrors({ BILLING_PROVIDER: 'disabled' })).toHaveLength(1);
        expect(billingProviderErrors({ BILLING_PROVIDER: 'bogus', DATA_TARGET_ENV: 'staging' })).toHaveLength(1);
        expect(billingProviderErrors({ DATA_TARGET_ENV: 'production' })).toEqual([]);
    });
});

describe('billing disabled mode', () => {
    beforeEach(() => { vi.stubEnv('BILLING_PROVIDER', 'disabled'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    const controller = () => {
        const stripe = {
            handleWebhook: vi.fn(), getPriceOptions: vi.fn(), getCreditPackOptions: vi.fn(),
            createCreditPackCheckoutSession: vi.fn(), createSubscriptionCheckoutSession: vi.fn(),
            createBillingPortalSession: vi.fn(), changeTenantSubscriptionPlan: vi.fn(),
            resumeTenantSubscription: vi.fn(), getTenantSubscriptionRecoveryAction: vi.fn(),
        };
        const features = { getFeatureMatrix: vi.fn().mockResolvedValue({ status: 'ACTIVE', features: {} }) };
        const meterErrors = { handleWebhook: vi.fn() };
        return { stripe, features, meterErrors, instance: new BillingController(stripe as any, features as any, meterErrors as any) };
    };

    it('answers 503 billing_disabled on every billing, checkout, portal, credit-pack and webhook endpoint without touching Stripe', async () => {
        const { stripe, meterErrors, instance } = controller();
        const req = { user: { tenantId: 't1', email: 'a@b.co', name: 'A' } } as any;
        const hook = { rawBody: Buffer.from('{}') } as any;
        const calls: Array<[string, () => Promise<unknown>]> = [
            ['subscription-recovery-action', () => instance.subscriptionRecoveryAction(req)],
            ['price-options', () => instance.priceOptions()],
            ['credit-packs', () => instance.creditPackOptions()],
            ['credit-packs/checkout', () => instance.purchaseCreditPack(req, { code: 'CREDITS_100' })],
            ['subscribe', () => instance.subscribe(req, { priceId: 'price_x' })],
            ['portal', () => instance.portal(req)],
            ['change-plan', () => instance.changePlan(req, { priceId: 'price_x' })],
            ['resume', () => instance.resume(req)],
            ['webhook', () => instance.handleStripeWebhook(hook, 'sig')],
            ['meter-errors/webhook', () => instance.handleStripeMeterErrorWebhook(hook, 'sig')],
        ];
        for (const [name, call] of calls) {
            const error = await call().then(() => null, (e: unknown) => e);
            expect(error, name).toBeInstanceOf(HttpException);
            expect((error as HttpException).getStatus(), name).toBe(503);
            expect((error as HttpException).getResponse(), name).toMatchObject({ code: BILLING_DISABLED_CODE, statusCode: 503 });
        }
        for (const fn of Object.values(stripe)) expect(fn).not.toHaveBeenCalled();
        expect(meterErrors.handleWebhook).not.toHaveBeenCalled();
    });

    it('still serves the read-only feature matrix and tells the web UI billing is disabled', async () => {
        const { instance, features } = controller();
        await expect(instance.features({ user: { tenantId: 't1' } } as any)).resolves.toMatchObject({
            status: 'ACTIVE', billingProvider: 'disabled', subscriptionRecoveryAction: null,
        });
        expect(features.getFeatureMatrix).toHaveBeenCalledWith('t1');
    });

    it('exposes the code to clients through the production exception filter', () => {
        const json = vi.fn();
        const res = { status: vi.fn().mockReturnValue({ json }) };
        const host = { switchToHttp: () => ({ getRequest: () => ({ method: 'POST', originalUrl: '/billing/portal' }), getResponse: () => res }) };
        new ProductionExceptionFilter().catch(new BillingDisabledException(), host as any);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({
            statusCode: 503, error: 'Service Unavailable', code: 'billing_disabled',
            message: 'Billing is disabled for this environment.',
        }));
    });

    it('never constructs a Stripe client, even when a key is present', async () => {
        const config = { get: (key: string) => ({ BILLING_PROVIDER: 'disabled', STRIPE_SECRET_KEY: 'sk_test_should_be_ignored_123456' } as Record<string, string>)[key] };
        const tenantDb = { client: {}, withTenant: vi.fn() } as any;
        const service = new StripeService(config as any, tenantDb, {} as any);
        expect((service as any).stripe).toBeNull();
        await expect(service.createCustomer('t1', 'a@b.co', 'A')).rejects.toMatchObject({ status: 503 });
        expect((new StripeCreditPurchaseService(config as any, tenantDb, {} as any) as any).stripe).toBeNull();
        expect((new StripeMeterErrorService(config as any, tenantDb) as any).stripe).toBeNull();
        expect((new StripeMeterEventsService(config as any) as any).stripe).toBeNull();
    });

    it('does not throw at construction without STRIPE_SECRET_KEY when disabled (unlike stripe mode outside development)', () => {
        const config = { get: (key: string) => (key === 'BILLING_PROVIDER' ? 'disabled' : undefined) };
        vi.stubEnv('NODE_ENV', 'production');
        expect(() => new StripeService(config as any, { client: {} } as any, {} as any)).not.toThrow();
        vi.stubEnv('BILLING_PROVIDER', 'stripe');
        expect(() => new StripeService({ get: () => undefined } as any, { client: {} } as any, {} as any)).toThrow(/STRIPE_SECRET_KEY/);
    });

    it('meter-event reporting is a no-op: nothing is created, sent, or queued', async () => {
        const meterEvents = new StripeMeterEventsService({ get: () => undefined } as any);
        await expect(meterEvents.createMeterEvent({
            eventName: 'usage', stripeCustomerId: 'cus_1', value: 1, identifier: 'id', timestamp: new Date(), idempotencyKey: 'k',
        })).resolves.toEqual({ id: null, requestId: null });

        const tenantDb = { withTenant: vi.fn() } as any;
        const createMeterEvent = vi.fn();
        const metering = new MeteringService(tenantDb, { createMeterEvent } as any);
        await expect(metering.reportUsageToStripe('tenant-1')).resolves.toEqual({ skipped: true, reason: 'billing_disabled' });
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(createMeterEvent).not.toHaveBeenCalled();
    });

    it('assertBillingEnabled passes when billing is not disabled', () => {
        vi.stubEnv('BILLING_PROVIDER', 'stripe');
        expect(() => assertBillingEnabled()).not.toThrow();
        vi.stubEnv('BILLING_PROVIDER', '');
        expect(() => assertBillingEnabled()).not.toThrow();
    });
});
