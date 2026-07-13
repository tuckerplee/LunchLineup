import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingController } from './billing.controller';

describe('BillingController - Stripe webhook', () => {
    let stripeService: {
        handleWebhook: ReturnType<typeof vi.fn>;
        getPriceOptions: ReturnType<typeof vi.fn>;
        createSubscriptionCheckoutSession: ReturnType<typeof vi.fn>;
        createBillingPortalSession: ReturnType<typeof vi.fn>;
        changeTenantSubscriptionPlan: ReturnType<typeof vi.fn>;
        resumeTenantSubscription: ReturnType<typeof vi.fn>;
        getTenantSubscriptionRecoveryAction: ReturnType<typeof vi.fn>;
    };
    let featureAccessService: { getFeatureMatrix: ReturnType<typeof vi.fn> };
    let meteringService: { grantCredits: ReturnType<typeof vi.fn> };
    let stripeMeterErrorService: { handleWebhook: ReturnType<typeof vi.fn> };
    let controller: BillingController;

    beforeEach(() => {
        stripeService = {
            handleWebhook: vi.fn().mockResolvedValue(undefined),
            getPriceOptions: vi.fn().mockReturnValue([
                { code: 'STARTER', label: 'Starter', priceId: 'price_starter', configured: true },
            ]),
            createSubscriptionCheckoutSession: vi.fn().mockResolvedValue({
                sessionId: 'cs_test_123',
                checkoutUrl: 'https://checkout.stripe.com/cs_test_123',
            }),
            createBillingPortalSession: vi.fn().mockResolvedValue({
                portalUrl: 'https://billing.stripe.com/p/session_123',
            }),
            changeTenantSubscriptionPlan: vi.fn().mockResolvedValue({
                action: 'updated',
                stripeSubscriptionId: 'sub_123',
                stripeStatus: 'active',
                planTier: 'GROWTH',
            }),
            resumeTenantSubscription: vi.fn().mockResolvedValue({
                action: 'resumed',
                stripeSubscriptionId: 'sub_123',
                stripeStatus: 'active',
                paymentUrl: null,
                paymentFlow: null,
            }),
            getTenantSubscriptionRecoveryAction: vi.fn().mockResolvedValue('resume'),
        };
        featureAccessService = {
            getFeatureMatrix: vi.fn().mockResolvedValue({
                status: 'PAST_DUE',
                stripeSubscriptionPresent: true,
            }),
        };
        meteringService = {
            grantCredits: vi.fn().mockResolvedValue(125),
        };
        stripeMeterErrorService = {
            handleWebhook: vi.fn().mockResolvedValue({ matched: 1, transitioned: 1 }),
        };

        controller = new BillingController(
            stripeService as any,
            meteringService as any,
            featureAccessService as any,
            stripeMeterErrorService as any,
        );
    });

    it('marks the Stripe webhook as public so global app auth does not block Stripe', () => {
        expect(Reflect.getMetadata('isPublic', controller.handleStripeWebhook)).toBe(true);
        expect(Reflect.getMetadata('isPublic', controller.handleStripeMeterErrorWebhook)).toBe(true);
    });

    it('requires billing read permission for the feature matrix route', () => {
        expect(Reflect.getMetadata('permission', controller.features)).toBe('billing:read');
    });

    it('adds the live Stripe recovery action to the billing feature contract', async () => {
        await expect(controller.features({ user: { tenantId: 'tenant-1' } } as any)).resolves.toEqual({
            status: 'PAST_DUE',
            stripeSubscriptionPresent: true,
            subscriptionRecoveryAction: 'resume',
        });
        expect(stripeService.getTenantSubscriptionRecoveryAction).toHaveBeenCalledWith('tenant-1');
    });

    it('requires billing write permission for tenant subscription setup', () => {
        expect(Reflect.getMetadata('permission', controller.subscribe)).toBe('billing:write');
    });

    it('creates a hosted Stripe Checkout session for subscription setup', async () => {
        await expect(controller.subscribe({
            user: {
                tenantId: 'tenant-1',
                email: 'owner@example.com',
                name: 'Owner Example',
            },
        } as any, { priceId: 'price_starter' })).resolves.toEqual({
            sessionId: 'cs_test_123',
            checkoutUrl: 'https://checkout.stripe.com/cs_test_123',
        });

        expect(stripeService.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
            'tenant-1',
            { email: 'owner@example.com', name: 'Owner Example' },
            'price_starter',
        );
    });

    it('requires billing write permission and opens the Stripe portal for paid customers', async () => {
        expect(Reflect.getMetadata('permission', controller.portal)).toBe('billing:write');

        await expect(controller.portal({ user: { tenantId: 'tenant-1' } } as any)).resolves.toEqual({
            portalUrl: 'https://billing.stripe.com/p/session_123',
        });
        expect(stripeService.createBillingPortalSession).toHaveBeenCalledWith('tenant-1');
    });

    it('keeps credit grants behind platform admin access', () => {
        expect(Reflect.getMetadata('permission', controller.grantCredits)).toBe('admin_portal:access');
    });

    it('requires a valid Idempotency-Key before granting credits', async () => {
        await expect(controller.grantCredits({
            tenantId: 'tenant-1',
            amount: 25,
            reason: 'Correction',
        }, undefined)).rejects.toBeInstanceOf(BadRequestException);
        await expect(controller.grantCredits({
            tenantId: 'tenant-1',
            amount: 25,
            reason: 'Correction',
        }, '   ')).rejects.toBeInstanceOf(BadRequestException);

        expect(meteringService.grantCredits).not.toHaveBeenCalled();
    });

    it('forwards the normalized idempotency key and reuses the metering result', async () => {
        await expect(controller.grantCredits({
            tenantId: 'tenant-1',
            amount: 25,
            reason: 'Correction',
        }, ' grant-20260709 ')).resolves.toEqual({
            success: true,
            newBalance: 125,
        });

        expect(meteringService.grantCredits).toHaveBeenCalledWith(
            'tenant-1',
            25,
            'Correction',
            'grant-20260709',
        );
    });

    it('keeps plan changes and paused recovery behind billing write permission', async () => {
        expect(Reflect.getMetadata('permission', controller.changePlan)).toBe('billing:write');
        expect(Reflect.getMetadata('permission', controller.resume)).toBe('billing:write');

        await controller.changePlan({ user: { tenantId: 'tenant-1' } } as any, { priceId: 'price_growth' });
        await controller.resume({ user: { tenantId: 'tenant-1' } } as any);

        expect(stripeService.changeTenantSubscriptionPlan).toHaveBeenCalledWith('tenant-1', 'price_growth');
        expect(stripeService.resumeTenantSubscription).toHaveBeenCalledWith('tenant-1');
    });

    it('requires billing read permission for price options and returns configured catalog', async () => {
        expect(Reflect.getMetadata('permission', controller.priceOptions)).toBe('billing:read');

        await expect(controller.priceOptions()).resolves.toEqual({
            data: [{ code: 'STARTER', label: 'Starter', priceId: 'price_starter', configured: true }],
        });
    });

    it('passes the preserved raw request body to Stripe signature verification', async () => {
        const rawBody = Buffer.from('{"id":"evt_123"}');

        await controller.handleStripeWebhook({ rawBody, body: { id: 'evt_123' } } as any, 'sig_123');

        expect(stripeService.handleWebhook).toHaveBeenCalledWith(rawBody, 'sig_123');
    });

    it('supports express.raw-style Buffer bodies as a fallback', async () => {
        const rawBody = Buffer.from('{"id":"evt_456"}');

        await controller.handleStripeWebhook({ body: rawBody } as any, 'sig_456');

        expect(stripeService.handleWebhook).toHaveBeenCalledWith(rawBody, 'sig_456');
    });

    it('passes raw thin-event bytes to meter error reconciliation', async () => {
        const rawBody = Buffer.from('{"id":"evt_meter_error"}');

        await expect(controller.handleStripeMeterErrorWebhook(
            { rawBody } as any,
            'sig_meter_error',
        )).resolves.toEqual({ received: true, matched: 1, transitioned: 1 });

        expect(stripeMeterErrorService.handleWebhook).toHaveBeenCalledWith(rawBody, 'sig_meter_error');
    });

    it('propagates Stripe processing failures instead of acknowledging the webhook', async () => {
        const processingFailure = new Error('transient Stripe lookup failure');
        stripeService.handleWebhook.mockRejectedValueOnce(processingFailure);

        await expect(controller.handleStripeWebhook({
            rawBody: Buffer.from('{"id":"evt_retry"}'),
        } as any, 'sig_retry')).rejects.toBe(processingFailure);
    });

    it('rejects webhook requests when raw bytes are not available', async () => {
        await expect(
            controller.handleStripeWebhook({ body: { id: 'evt_123' } } as any, 'sig_123'),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(stripeService.handleWebhook).not.toHaveBeenCalled();
    });
});
