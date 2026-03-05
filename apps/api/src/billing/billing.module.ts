import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { StripeService } from './stripe.service';
import { MeteringService } from './metering.service';

@Module({
    controllers: [BillingController],
    providers: [StripeService, MeteringService],
    exports: [MeteringService],
})
export class BillingModule { }

