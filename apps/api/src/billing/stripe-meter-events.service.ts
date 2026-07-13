import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

type MeterEventInput = {
    eventName: string;
    stripeCustomerId: string;
    value: number;
    identifier: string;
    timestamp: Date;
    idempotencyKey: string;
};

type MeterEventResult = {
    id: string | null;
    requestId: string | null;
};

@Injectable()
export class StripeMeterEventsService {
    private readonly stripe: Stripe | null;

    constructor(@Optional() private readonly configService?: ConfigService) {
        const apiKey = this.configService?.get<string>('STRIPE_SECRET_KEY')?.trim() || process.env.STRIPE_SECRET_KEY?.trim();
        this.stripe = apiKey
            ? new Stripe(apiKey, { apiVersion: '2024-04-10' as any, maxNetworkRetries: 2 })
            : null;
    }

    async createMeterEvent(input: MeterEventInput): Promise<MeterEventResult> {
        const event = await (this.getStripe().billing.meterEvents as any).create(
            {
                event_name: input.eventName,
                payload: {
                    stripe_customer_id: input.stripeCustomerId,
                    value: String(input.value),
                },
                identifier: input.identifier,
                timestamp: Math.floor(input.timestamp.getTime() / 1000),
            },
            { idempotencyKey: input.idempotencyKey },
        );

        return {
            id: typeof event?.id === 'string' ? event.id : null,
            requestId: typeof event?.lastResponse?.requestId === 'string' ? event.lastResponse.requestId : null,
        };
    }

    private getStripe(): Stripe {
        if (!this.stripe) {
            throw new ServiceUnavailableException('Stripe metered usage is not configured');
        }
        return this.stripe;
    }
}
