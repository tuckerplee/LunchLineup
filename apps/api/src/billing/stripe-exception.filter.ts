import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { stripeErrorLog } from './stripe-error-diagnostic';

// A provider's authentication status describes our Stripe connection, not the user's session.
@Catch(Stripe.errors.StripeError)
export class StripeExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(StripeExceptionFilter.name);

    catch(exception: Stripe.errors.StripeError, host: ArgumentsHost): void {
        this.logger.error(stripeErrorLog('stripe.request_failed', exception));
        host.switchToHttp().getResponse().status(503).json({
            statusCode: 503,
            error: 'Service Unavailable',
            code: 'BILLING_PROVIDER_UNAVAILABLE',
            message: 'Billing is temporarily unavailable. Your sign-in is still active. Please try again later.',
        });
    }
}
