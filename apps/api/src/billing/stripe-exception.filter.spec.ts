import { Logger, UnauthorizedException } from '@nestjs/common';
import { FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { StripeExceptionFilter } from './stripe-exception.filter';

describe('Stripe exception boundary', () => {
    it.each([
        new Stripe.errors.StripeAuthenticationError({ message: 'private provider credential', statusCode: 401 }),
        new Stripe.errors.StripePermissionError({ message: 'private provider permission', statusCode: 403 }),
        new Stripe.errors.StripeConnectionError({ message: 'private provider connection' }),
    ])('returns a sanitized service failure instead of an application authentication failure', exception => {
        const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        new StripeExceptionFilter().catch(exception, { switchToHttp: () => ({ getResponse: () => response }) } as never);
        expect(response.status).toHaveBeenCalledWith(503);
        expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BILLING_PROVIDER_UNAVAILABLE' }));
        expect(JSON.stringify(response.json.mock.calls)).not.toContain('private provider');
        log.mockRestore();
    });

    it('only catches provider errors, leaving expired application sessions to authentication handling', () => {
        const types = Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, StripeExceptionFilter);
        expect(types).toEqual([Stripe.errors.StripeError]);
        expect(types.some((type: any) => new UnauthorizedException() instanceof type)).toBe(false);
    });
});
