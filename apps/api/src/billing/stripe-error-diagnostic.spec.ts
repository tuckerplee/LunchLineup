import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripeErrorDiagnostic, stripeErrorLog } from './stripe-error-diagnostic';

describe('Stripe operational error diagnostics', () => {
    it('retains safe provider context without serializing secret-bearing exception data', () => {
        const secret = 'sk_live_super_secret';
        const error = Object.assign(new Error(`POST https://api.stripe.com secret=${secret} tenant-42 user@example.com`), {
            type: 'StripeConnectionError',
            code: 'api_connection_error',
            requestId: 'req_123456ABCDEF',
            raw: { message: secret, headers: { authorization: `Bearer ${secret}` } },
        });

        const serialized = stripeErrorLog('stripe.subscription_verification_failed', error);

        expect(JSON.parse(serialized)).toEqual({
            event: 'stripe.subscription_verification_failed',
            errorClass: 'StripeConnectionError',
            category: 'connectivity',
            code: 'api_connection_error',
            requestRef: 'req_123456ABCDEF',
        });
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('api.stripe.com');
        expect(serialized).not.toContain('tenant-42');
        expect(serialized).not.toContain('user@example.com');
        expect(serialized).not.toContain('authorization');
    });

    it('drops attacker-controlled codes and request references', () => {
        expect(stripeErrorDiagnostic('invalid event with spaces', Object.assign(new Error('private'), {
            type: 'UnexpectedSecretError',
            code: 'sk_live_secret',
            requestId: 'request contains secret=abc',
        }))).toEqual({
            event: 'stripe.operational_error',
            errorClass: 'Error',
            category: 'unknown',
        });
    });

    it('classifies wrapped signature failures without reading their messages', () => {
        const cause = Object.assign(new Error('whsec_secret payload=private'), {
            type: 'StripeSignatureVerificationError',
            code: 'signature_verification_error',
        });
        const serialized = stripeErrorLog('stripe.webhook_signature_verification_failed', new Error('wrapper', { cause }));

        expect(JSON.parse(serialized)).toMatchObject({
            errorClass: 'StripeSignatureVerificationError',
            category: 'signature',
            code: 'signature_verification_error',
        });
        expect(serialized).not.toContain('whsec_secret');
        expect(serialized).not.toContain('payload');
    });
    it('routes every audited Stripe service failure through the bounded diagnostic', () => {
        const source = readFileSync(resolve(process.cwd(), 'src/billing/stripe.service.ts'), 'utf8');
        for (const event of [
            'stripe.invoice_retrieval_fallback',
            'stripe.billing_return_origin_invalid',
            'stripe.webhook_signature_verification_failed',
            'stripe.subscription_verification_failed',
        ]) {
            expect(source).toContain(`stripeErrorLog('${event}', err)`);
        }
        expect(source).not.toContain('(err as Error).message');
    });
});
